import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  applyGoogleManagedBlock,
  GoogleCalendarError,
  managedGoogleBlockEventId,
  type GoogleConfig,
  type GoogleManagedBlockTarget,
} from "../src/index.ts";
import { sha256Base32Hex } from "../src/ids.ts";

const base = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  redirectUri: "https://experience.example.test/google/callback",
};
const calendarId = "synthetic-output-calendar";
const accessToken = "synthetic-access-token";

function target(overrides: Partial<GoogleManagedBlockTarget> = {}): GoogleManagedBlockTarget {
  return {
    providerOpaqueId: "provider_opaque_1",
    listingOpaqueId: "listing_opaque_1",
    occurrenceOpaqueId: "occurrence_opaque_1",
    mappingVersion: 3,
    desiredVersion: 7,
    sourceStartAtUtc: "2026-11-01T01:00:00.000Z",
    sourceEndAtUtc: "2026-11-01T02:00:00.000Z",
    desiredState: "CLOSED",
    ...overrides,
  };
}

function binding(value: GoogleManagedBlockTarget): string {
  return sha256Base32Hex(`niho-managed-google-binding-v1\0${JSON.stringify([
    value.providerOpaqueId,
    value.listingOpaqueId,
    value.occurrenceOpaqueId,
    value.sourceStartAtUtc,
    value.sourceEndAtUtc,
    value.mappingVersion,
  ])}`);
}

function ownedEvent(
  value: GoogleManagedBlockTarget,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: managedGoogleBlockEventId(value),
    etag: '"etag-current"',
    status: "confirmed",
    start: { dateTime: value.sourceStartAtUtc },
    end: { dateTime: value.sourceEndAtUtc },
    transparency: value.desiredState === "CLOSED" ? "opaque" : "transparent",
    visibility: "private",
    extendedProperties: {
      private: {
        nihoManagedKind: "niho-managed-block-v1",
        nihoManagedBinding: binding(value),
        nihoManagedMappingVersion: String(value.mappingVersion),
        nihoManagedDesiredVersion: String(value.desiredVersion),
      },
    },
    ...overrides,
  };
}

type SyntheticFetch = (url: string, init: RequestInit) => Response | Promise<Response>;

function config(handler: SyntheticFetch): GoogleConfig {
  return { ...base, fetch: async (input, init) => handler(String(input), init ?? {}) };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("managed Google block protocol", () => {
  it("preserves canonical UTC millisecond precision", async () => {
    const value = target({ sourceStartAtUtc: "2026-11-01T01:00:00.123Z", sourceEndAtUtc: "2026-11-01T02:00:00.123Z" });
    const result = await applyGoogleManagedBlock(config(() => json(ownedEvent(value))), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "GOOGLE_VERIFIED");
  });

  it("refuses wildcard, weak, or unquoted ETags before any write", async () => {
    for (const etag of ["*", 'W/"weak"', "unquoted", '"bad\r\nvalue"']) {
      let requests = 0;
      await assert.rejects(() => applyGoogleManagedBlock(config(() => {
        requests += 1;
        return json(ownedEvent(target({ desiredVersion: 6 }), { etag }));
      }), accessToken, calendarId, target(), () => undefined), GoogleCalendarError);
      assert.equal(requests, 1);
    }
  });

  it("aborts a real zero-byte ACK body at the request deadline without a second write", { timeout: 15_000 }, async () => {
    const value = target({ desiredVersion: 8 });
    let requests = 0;
    let writes = 0;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      // Keep the body silent until the client's deadline cancels this request.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const started = Date.now();
    try {
      const result = await applyGoogleManagedBlock(config((_url, init) => {
        requests += 1;
        if (requests === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
        if (init.method === "PATCH") {
          writes += 1;
          return fetch(`http://127.0.0.1:${address.port}/synthetic-ack`, {
            method: "PATCH", body: "synthetic", signal: init.signal,
          });
        }
        return json(ownedEvent(value, { etag: '"etag-after-body-deadline"' }));
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "GOOGLE_VERIFIED");
      assert.equal(result.writeAcknowledged, false);
      assert.equal(writes, 1);
      assert.equal(requests, 3);
      assert.ok(Date.now() - started < 14_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("derives a stable base32hex event ID independent of mapping and desired versions", () => {
    const first = managedGoogleBlockEventId(target());
    const later = managedGoogleBlockEventId(target({ mappingVersion: 99, desiredVersion: 100, desiredState: "OPEN" }));
    assert.equal(first, later);
    assert.match(first, /^[0-9a-v]{5,1024}$/);
    assert.throws(() => managedGoogleBlockEventId({ ...target(), providerOpaqueId: "x".repeat(257) }));
  });

  it("inserts a private CLOSED anchor once and verifies it with an independent GET", async () => {
    const value = target();
    const requests: { url: URL; init: RequestInit; body?: Record<string, unknown> }[] = [];
    let inserted: Record<string, unknown> | undefined;
    let assertions = 0;
    const result = await applyGoogleManagedBlock(config((rawUrl, init) => {
      const url = new URL(rawUrl);
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, init, body });
      assert.equal(init.redirect, "manual");
      if (requests.length === 1) return new Response(null, { status: 404 });
      if (requests.length === 2) {
        inserted = body;
        return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
      }
      return json({ ...inserted, etag: '"etag-readback"', status: "confirmed", rawGuestEmail: "never-return@example.test" });
    }), accessToken, calendarId, value, () => { assertions += 1; });

    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, true);
    assert.equal(result.writeAcknowledged, true);
    assert.equal(assertions, 3);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(({ init }) => init.method), ["GET", "POST", "GET"]);
    assert.equal(requests[0]!.url.searchParams.get("fields"), "id,etag,status,start(date,dateTime),end(date,dateTime),recurrence,recurringEventId,originalStartTime(date,dateTime),transparency,visibility,extendedProperties/private");
    assert.equal(requests[1]!.url.searchParams.get("sendUpdates"), "none");
    assert.equal(requests[1]!.url.searchParams.get("fields"), "id,etag");
    assert.equal(requests[1]!.body?.summary, "NIHO availability");
    assert.equal(requests[1]!.body?.visibility, "private");
    assert.equal(requests[1]!.body?.transparency, "opaque");
    for (const prohibited of ["attendees", "description", "price", "email"]) assert.equal(prohibited in requests[1]!.body!, false);
    assert.equal("rawGuestEmail" in result.google, false);
  });

  it("changes the same OPEN anchor with If-Match and never deletes or recreates it", async () => {
    const value = target({ desiredState: "OPEN", desiredVersion: 8 });
    const previous = target({ desiredState: "CLOSED", desiredVersion: 7 });
    const requests: { url: URL; init: RequestInit; body?: Record<string, unknown> }[] = [];
    const result = await applyGoogleManagedBlock(config((rawUrl, init) => {
      const url = new URL(rawUrl);
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, init, body });
      if (requests.length === 1) return json(ownedEvent(value, {
        transparency: "opaque",
        extendedProperties: ownedEvent(previous).extendedProperties,
      }));
      if (requests.length === 2) return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
      return json(ownedEvent(value, { etag: '"etag-open"' }));
    }), accessToken, calendarId, value, () => undefined);

    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.deepEqual(requests.map(({ init }) => init.method), ["GET", "PATCH", "GET"]);
    assert.equal((requests[1]!.init.headers as Record<string, string>)["if-match"], '"etag-current"');
    assert.deepEqual(Object.keys(requests[1]!.body!).sort(), ["extendedProperties", "transparency"]);
    assert.equal(requests[1]!.body?.transparency, "transparent");
    assert.equal(requests[1]!.url.searchParams.get("sendUpdates"), "none");
  });

  it("does not write when the same version and content already match", async () => {
    const value = target();
    let requests = 0;
    let assertions = 0;
    const result = await applyGoogleManagedBlock(config(() => {
      requests += 1;
      return json(ownedEvent(value));
    }), accessToken, calendarId, value, () => { assertions += 1; });
    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, false);
    assert.equal(result.writeAcknowledged, false);
    assert.equal(requests, 1);
    assert.equal(assertions, 2);
  });

  it("normalizes Google's missing transparency to its opaque default", async () => {
    const value = target();
    const raw = ownedEvent(value);
    delete raw.transparency;
    const result = await applyGoogleManagedBlock(
      config(() => json(raw)),
      accessToken,
      calendarId,
      value,
      () => undefined,
    );
    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, false);
    assert.equal(result.google.transparency, "opaque");
  });

  it("normalizes an RFC3339 numeric offset before comparing the source UTC time", async () => {
    const value = target();
    const result = await applyGoogleManagedBlock(
      config(() => json(ownedEvent(value, {
        start: { dateTime: "2026-11-01T10:00:00+09:00" },
        end: { dateTime: "2026-11-01T11:00:00+09:00" },
      }))),
      accessToken,
      calendarId,
      value,
      () => undefined,
    );
    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, false);
    assert.equal(result.google.startAtUtc, value.sourceStartAtUtc);
    assert.equal(result.google.endAtUtc, value.sourceEndAtUtc);
  });

  it("updates the marker and ETag when the desired version advances without a state change", async () => {
    const value = target({ desiredVersion: 8 });
    const previous = target({ desiredVersion: 7 });
    let request = 0;
    let patchBody: Record<string, unknown> | undefined;
    const result = await applyGoogleManagedBlock(config((_url, init) => {
      request += 1;
      if (request === 1) return json(ownedEvent(previous));
      if (request === 2) {
        patchBody = JSON.parse(String(init.body));
        return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
      }
      return json(ownedEvent(value, { etag: '"etag-new-version"' }));
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "GOOGLE_VERIFIED");
    assert.equal(result.changed, true);
    const privateMarker = (patchBody?.extendedProperties as { private: Record<string, string> }).private;
    assert.equal(privateMarker.nihoManagedDesiredVersion, "8");
  });

  it("refuses foreign, mapping, invalid time, all-day, unconfirmed, tombstone, and newer-version anchors", async (context) => {
    const value = target();
    const missingStatus = ownedEvent(value);
    delete missingStatus.status;
    const cases: readonly [string, Response, string][] = [
      ["foreign marker", json(ownedEvent(value, { extendedProperties: { private: {} } })), "FOREIGN_EVENT"],
      ["mapping mismatch", json(ownedEvent(value, { extendedProperties: { private: {
        nihoManagedKind: "niho-managed-block-v1", nihoManagedBinding: binding(value), nihoManagedMappingVersion: "4", nihoManagedDesiredVersion: "7",
      } } })), "MAPPING_MISMATCH"],
      ["time mismatch", json(ownedEvent(value, { start: { dateTime: "2026-11-01T03:00:00Z" } })), "TIME_MISMATCH"],
      ["timezone missing", json(ownedEvent(value, { start: { dateTime: "2026-11-01T01:00:00" } })), "TIME_MISMATCH"],
      ["invalid offset", json(ownedEvent(value, { start: { dateTime: "2026-11-01T10:00:00+24:00" } })), "TIME_MISMATCH"],
      ["all day", json(ownedEvent(value, { start: { date: "2026-11-01" }, end: { date: "2026-11-02" } })), "ALL_DAY_EVENT"],
      ["cancelled", json(ownedEvent(value, { status: "cancelled" })), "CANCELLED_EVENT"],
      ["tentative", json(ownedEvent(value, { status: "tentative" })), "STATUS_MISMATCH"],
      ["unknown status", json(ownedEvent(value, { status: "synthetic-unknown" })), "STATUS_MISMATCH"],
      ["missing status", json(missingStatus), "STATUS_MISMATCH"],
      ["tombstone", new Response(null, { status: 410 }), "TOMBSTONE"],
      ["newer desired version", json(ownedEvent(target({ desiredVersion: 8 }))), "STALE_INTENT"],
    ];
    for (const [name, response, expected] of cases) {
      await context.test(name, async () => {
        let requests = 0;
        const result = await applyGoogleManagedBlock(config(() => {
          requests += 1;
          return response.clone();
        }), accessToken, calendarId, value, () => undefined);
        assert.equal(result.code, expected);
        assert.equal(requests, 1);
      });
    }
  });

  it("does not treat a missing OPEN anchor as resumed or create an event", async () => {
    const value = target({ desiredState: "OPEN" });
    let requests = 0;
    const result = await applyGoogleManagedBlock(config(() => {
      requests += 1;
      return new Response(null, { status: 404 });
    }), accessToken, calendarId, value, () => undefined);
    assert.deepEqual(result, {
      code: "ANCHOR_MISSING",
      eventId: managedGoogleBlockEventId(value),
      changed: false,
      writeAcknowledged: false,
    });
    assert.equal(requests, 1);
  });

  it("accepts a 409 only after a fresh owned exact read and rejects a foreign collision", async (context) => {
    for (const foreign of [false, true]) {
      await context.test(foreign ? "foreign collision" : "owned collision", async () => {
        const value = target();
        let request = 0;
        const result = await applyGoogleManagedBlock(config(() => {
          request += 1;
          if (request === 1) return new Response(null, { status: 404 });
          if (request === 2) return new Response(null, { status: 409 });
          return json(foreign ? ownedEvent(value, { extendedProperties: { private: {} } }) : ownedEvent(value));
        }), accessToken, calendarId, value, () => undefined);
        assert.equal(result.code, foreign ? "FOREIGN_EVENT" : "GOOGLE_VERIFIED");
        if (result.code === "GOOGLE_VERIFIED") {
          assert.equal(result.changed, false);
          assert.equal(result.writeAcknowledged, false);
        }
        assert.equal(request, 3);
      });
    }
  });

  it("stops on 412 without a readback or retry", async () => {
    const value = target({ desiredVersion: 8 });
    let request = 0;
    const result = await applyGoogleManagedBlock(config(() => {
      request += 1;
      if (request === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
      return new Response(null, { status: 412 });
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "PRECONDITION_FAILED");
    assert.equal(request, 2);
  });

  it("uses one fresh GET to converge a 500 or lost response, and otherwise returns WRITE_UNCERTAIN", async (context) => {
    for (const mode of ["500-converged", "throw-converged", "500-stale"] as const) {
      await context.test(mode, async () => {
        const value = target({ desiredVersion: 8 });
        const previous = target({ desiredVersion: 7 });
        let request = 0;
        let writes = 0;
        const result = await applyGoogleManagedBlock(config(() => {
          request += 1;
          if (request === 1) return json(ownedEvent(previous));
          if (request === 2) {
            writes += 1;
            if (mode === "throw-converged") throw new TypeError("synthetic response loss with private details");
            return new Response("private Google error body", { status: 500 });
          }
          return json(mode === "500-stale" ? ownedEvent(previous) : ownedEvent(value, { etag: '"etag-converged"' }));
        }), accessToken, calendarId, value, () => undefined);
        assert.equal(result.code, mode === "500-stale" ? "WRITE_UNCERTAIN" : "GOOGLE_VERIFIED");
        assert.equal(JSON.stringify(result).includes("Google error body"), false);
        assert.equal(JSON.stringify(result).includes("response loss"), false);
        assert.equal(writes, 1);
        assert.equal(request, 3);
      });
    }
  });

  it("rejects an unchanged or stale readback ETag after a write ACK", async () => {
    const value = target({ desiredVersion: 8 });
    const previous = target({ desiredVersion: 7 });
    let request = 0;
    const result = await applyGoogleManagedBlock(config(() => {
      request += 1;
      if (request === 1) return json(ownedEvent(previous));
      if (request === 2) return json({ id: managedGoogleBlockEventId(value), etag: '"etag-current"' });
      return json(ownedEvent(value, { etag: '"etag-current"' }));
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "WRITE_UNCERTAIN");
    assert.equal(result.writeAcknowledged, true);
  });

  it("refuses recurring parents and instances before writes and before no-op success", async () => {
    const recurrenceShapes = [
      { recurrence: ["RRULE:FREQ=DAILY;COUNT=30"] },
      { recurringEventId: "synthetic-parent" },
      { originalStartTime: { dateTime: "2026-11-01T01:00:00Z" } },
    ];
    for (const shape of recurrenceShapes) for (const desiredState of ["OPEN", "CLOSED"] as const) {
      const value = target({ desiredState, desiredVersion: 8 });
      let requests = 0;
      const result = await applyGoogleManagedBlock(config(() => {
        requests += 1;
        return json(ownedEvent(value, shape));
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "RECURRING_EVENT");
      assert.equal(result.changed, false);
      assert.equal(requests, 1);
    }
  });

  it("does not verify a saved anchor changed into a recurring series before readback", async () => {
    const value = target({ desiredVersion: 8 });
    let requests = 0;
    let writes = 0;
    const result = await applyGoogleManagedBlock(config((_url, init) => {
      requests += 1;
      if (requests === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
      if (init.method === "PATCH") {
        writes += 1;
        return json({ id: managedGoogleBlockEventId(value), etag: '"saved"' });
      }
      return json(ownedEvent(value, { etag: '"recurring"', recurrence: ["RRULE:FREQ=DAILY;COUNT=30"] }));
    }), accessToken, calendarId, value, () => undefined);
    assert.equal(result.code, "WRITE_UNCERTAIN");
    assert.equal(result.changed, null);
    assert.equal(result.writeAcknowledged, true);
    assert.equal(writes, 1);
    assert.equal(requests, 3);
  });

  it("keeps a 2xx write ACK but reports uncertain when the fresh event is foreign or mismatched", async (context) => {
    const value = target({ desiredVersion: 8 });
    const previous = target({ desiredVersion: 7 });
    const readbacks: readonly [string, Record<string, unknown>][] = [
      ["foreign", ownedEvent(value, { etag: '"etag-foreign"', extendedProperties: { private: {} } })],
      ["mapping mismatch", ownedEvent(value, { etag: '"etag-mapping"', extendedProperties: { private: {
        nihoManagedKind: "niho-managed-block-v1",
        nihoManagedBinding: binding(value),
        nihoManagedMappingVersion: "4",
        nihoManagedDesiredVersion: "8",
      } } })],
      ["time mismatch", ownedEvent(value, { etag: '"etag-time"', start: { dateTime: "2026-11-01T03:00:00Z" } })],
    ];
    for (const [name, readback] of readbacks) {
      await context.test(name, async () => {
        let requests = 0;
        let writes = 0;
        const result = await applyGoogleManagedBlock(config((_url, init) => {
          requests += 1;
          if (requests === 1) return json(ownedEvent(previous));
          if (requests === 2) {
            writes += 1;
            assert.equal(init.method, "PATCH");
            return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
          }
          return json(readback);
        }), accessToken, calendarId, value, () => undefined);
        assert.deepEqual(result, {
          code: "WRITE_UNCERTAIN",
          eventId: managedGoogleBlockEventId(value),
          changed: null,
          writeAcknowledged: true,
        });
        assert.equal(requests, 3);
        assert.equal(writes, 1);
      });
    }
  });

  it("requires current state before reading, before writing, and before returning success", async (context) => {
    await context.test("lease expires before write", async () => {
      const value = target({ desiredVersion: 8 });
      let request = 0;
      let assertion = 0;
      await assert.rejects(() => applyGoogleManagedBlock(config(() => {
        request += 1;
        return json(ownedEvent(target({ desiredVersion: 7 })));
      }), accessToken, calendarId, value, () => {
        assertion += 1;
        if (assertion === 2) throw new Error("SUPERSEDED");
      }), /SUPERSEDED/);
      assert.equal(request, 1);
    });

    await context.test("lease expires after save", async () => {
      const value = target({ desiredVersion: 8 });
      let request = 0;
      let assertion = 0;
      let writes = 0;
      await assert.rejects(() => applyGoogleManagedBlock(config((_url, init) => {
        request += 1;
        if (init.method === "PATCH") writes += 1;
        if (request === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
        if (request === 2) return json({ id: managedGoogleBlockEventId(value), etag: '"etag-ack"' });
        return json(ownedEvent(value, { etag: '"etag-after-save"' }));
      }), accessToken, calendarId, value, () => {
        assertion += 1;
        if (assertion === 3) throw new Error("SUPERSEDED");
      }), /SUPERSEDED/);
      assert.equal(request, 3);
      assert.equal(writes, 1);
    });
  });

  it("bounds JSON shape, refuses redirects, and converts body aborts without leaking raw PII", async (context) => {
    await context.test("too many JSON fields", async () => {
      const value = target();
      const response = { ...ownedEvent(value), extra: Array.from({ length: 50_001 }, () => null) };
      await assert.rejects(
        () => applyGoogleManagedBlock(config(() => json(response)), accessToken, calendarId, value, () => undefined),
        (error: unknown) => error instanceof GoogleCalendarError && error.reason === "INVALID_RESPONSE" && !error.message.includes("provider_opaque_1"),
      );
    });

    await context.test("manual redirect", async () => {
      const value = target();
      await assert.rejects(() => applyGoogleManagedBlock(config((_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: "https://attacker.example.test/" } });
      }), accessToken, calendarId, value, () => undefined), GoogleCalendarError);
    });

    await context.test("aborted ACK body converges with one readback", async () => {
      const value = target({ desiredVersion: 8 });
      let request = 0;
      const result = await applyGoogleManagedBlock(config((_url, init) => {
        request += 1;
        assert.ok(init.signal instanceof AbortSignal);
        if (request === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
        if (request === 2) {
          const body = new ReadableStream({ pull(controller) { controller.error(new DOMException("private body aborted", "AbortError")); } });
          return new Response(body, { status: 200 });
        }
        return json(ownedEvent(value, { etag: '"etag-after-abort"' }));
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "GOOGLE_VERIFIED");
      assert.equal(result.writeAcknowledged, false);
      assert.equal(request, 3);
    });

    await context.test("oversized never-ending body is cancelled at the byte bound", async () => {
      const value = target({ desiredVersion: 8 });
      let request = 0;
      let cancelled = false;
      const result = await applyGoogleManagedBlock(config(() => {
        request += 1;
        if (request === 1) return json(ownedEvent(target({ desiredVersion: 7 })));
        if (request === 2) {
          const body = new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array(300_000)); },
            cancel() { cancelled = true; },
          });
          return new Response(body, { status: 200 });
        }
        return json(ownedEvent(value, { etag: '"etag-after-oversize"' }));
      }), accessToken, calendarId, value, () => undefined);
      assert.equal(result.code, "GOOGLE_VERIFIED");
      assert.equal(result.writeAcknowledged, false);
      assert.equal(cancelled, true);
      assert.equal(request, 3);
    });
  });

  it("validates canonical UTC, bounded identities, positive versions, and duration", async () => {
    const unreachable = config(() => { throw new Error("must not fetch"); });
    const invalidTargets: GoogleManagedBlockTarget[] = [
      target({ sourceStartAtUtc: "2026-11-01T01:00:00Z" }),
      target({ sourceEndAtUtc: "2026-11-02T02:00:00.000Z" }),
      target({ desiredVersion: 0 }),
      target({ mappingVersion: Number.MAX_SAFE_INTEGER + 1 }),
      target({ occurrenceOpaqueId: `unsafe\nvalue` }),
    ];
    for (const value of invalidTargets) {
      await assert.rejects(() => applyGoogleManagedBlock(unreachable, accessToken, calendarId, value, () => undefined), TypeError);
    }
    await assert.rejects(() => applyGoogleManagedBlock(unreachable, accessToken, calendarId, target(), undefined as never), TypeError);
  });
});
