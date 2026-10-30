import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initializeGoogleManagedBlock,
  managedGoogleBlockEventId,
  type GoogleConfig,
  type GoogleManagedBlockTarget,
} from "../src/index.ts";
import { sha256Base32Hex } from "../src/ids.ts";

const calendarId = "synthetic-output-calendar";
const accessToken = "synthetic-access-token";
const target = (desiredState: "OPEN" | "CLOSED" = "OPEN", desiredVersion = 7): GoogleManagedBlockTarget => ({
  providerOpaqueId: "provider-a", listingOpaqueId: "listing-a", occurrenceOpaqueId: "rule-a@2030-01-01",
  mappingVersion: 3, desiredVersion, sourceStartAtUtc: "2030-01-01T01:00:00.000Z",
  sourceEndAtUtc: "2030-01-01T02:00:00.000Z", desiredState,
});
const binding = (value: GoogleManagedBlockTarget) => sha256Base32Hex(`niho-managed-google-binding-v1\0${JSON.stringify([
  value.providerOpaqueId, value.listingOpaqueId, value.occurrenceOpaqueId,
  value.sourceStartAtUtc, value.sourceEndAtUtc, value.mappingVersion,
])}`);
const event = (value: GoogleManagedBlockTarget, overrides: Record<string, unknown> = {}) => ({
  id: managedGoogleBlockEventId(value), etag: '"etag-current"', status: "confirmed",
  start: { dateTime: value.sourceStartAtUtc }, end: { dateTime: value.sourceEndAtUtc },
  transparency: value.desiredState === "OPEN" ? "transparent" : "opaque", visibility: "private",
  extendedProperties: { private: {
    nihoManagedKind: "niho-managed-block-v1", nihoManagedBinding: binding(value),
    nihoManagedMappingVersion: String(value.mappingVersion), nihoManagedDesiredVersion: String(value.desiredVersion),
  } },
  ...overrides,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const config = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): GoogleConfig => ({
  clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback",
  fetch: async (input, init) => handler(String(input), init ?? {}),
});

describe("insert-only managed Google anchor initialization", () => {
  it("inserts one deterministic private OPEN or CLOSED anchor and independently verifies it", async () => {
    for (const state of ["OPEN", "CLOSED"] as const) {
      const value = target(state);
      const methods: string[] = [];
      let inserted: Record<string, unknown> | undefined;
      const result = await initializeGoogleManagedBlock(config((_url, init) => {
        methods.push(init.method ?? "GET");
        if (methods.length === 1) return new Response(null, { status: 404 });
        if (methods.length === 2) {
          inserted = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
        }
        return json({ ...inserted, status: "confirmed", etag: '"etag-readback"' });
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "GOOGLE_VERIFIED");
      assert.deepEqual(methods, ["GET", "POST", "GET"]);
      assert.equal(inserted?.id, managedGoogleBlockEventId(value));
      assert.equal(inserted?.summary, "NIHO availability");
      assert.equal(inserted?.visibility, "private");
      assert.equal(inserted?.transparency, state === "OPEN" ? "transparent" : "opaque");
      assert.deepEqual(Object.keys(inserted ?? {}).sort(), ["end", "extendedProperties", "id", "start", "summary", "transparency", "visibility"]);
    }
  });

  it("accepts an exact existing anchor without a write", async () => {
    const value = target();
    const methods: string[] = [];
    const result = await initializeGoogleManagedBlock(config((_url, init) => {
      methods.push(init.method ?? "GET");
      return json(event(value));
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, false);
    assert.deepEqual(methods, ["GET"]);
  });

  it("never patches or deletes an older, foreign, or mismatched existing event", async (context) => {
    const value = target("OPEN", 8);
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ["older desired", event(target("OPEN", 7)), "ANCHOR_CONFLICT"],
      ["foreign", event(value, { extendedProperties: { private: {} } }), "FOREIGN_EVENT"],
      ["wrong state", event(value, { transparency: "opaque" }), "ANCHOR_CONFLICT"],
    ];
    for (const [name, existing, code] of cases) await context.test(name, async () => {
      const methods: string[] = [];
      const result = await initializeGoogleManagedBlock(config((_url, init) => {
        methods.push(init.method ?? "GET");
        return json(existing);
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, code);
      assert.deepEqual(methods, ["GET"]);
    });
  });

  it("resolves a 409 or lost ACK only by one independent GET and never inserts twice", async (context) => {
    for (const [name, write] of [
      ["409", () => new Response(null, { status: 409 })],
      ["lost ACK", () => { throw new Error("synthetic ack loss"); }],
    ] as const) await context.test(name, async () => {
      const value = target("CLOSED");
      const methods: string[] = [];
      const result = await initializeGoogleManagedBlock(config((_url, init) => {
        methods.push(init.method ?? "GET");
        if (methods.length === 1) return new Response(null, { status: 404 });
        if (methods.length === 2) return write();
        return json(event(value, { etag: '"etag-after"' }));
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "GOOGLE_VERIFIED");
      assert.deepEqual(methods, ["GET", "POST", "GET"]);
      assert.equal(methods.filter((method) => method === "POST").length, 1);
    });
  });

  it("returns conflict for a 409 collision and uncertainty after an ambiguous dispatch", async () => {
    const value = target();
    let request = 0;
    const collision = await initializeGoogleManagedBlock(config(() => {
      request += 1;
      if (request === 1) return new Response(null, { status: 404 });
      if (request === 2) return new Response(null, { status: 409 });
      return json(event(value, { extendedProperties: { private: {} } }));
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(collision.code, "ANCHOR_CONFLICT");

    request = 0;
    const uncertain = await initializeGoogleManagedBlock(config(() => {
      request += 1;
      if (request === 1) return new Response(null, { status: 404 });
      if (request === 2) return new Response(null, { status: 503 });
      return new Response(null, { status: 404 });
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(uncertain.code, "WRITE_UNCERTAIN");
    assert.equal(request, 3);
  });
});
