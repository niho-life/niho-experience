import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ExperienceStore,
  GoogleChannelSetupRepository,
  ResourceGoogleRepository,
  lockGoogleCalendarUsage,
  StoreAccessDeniedError,
  StoreConflictError,
  type HostActor,
} from "@niho-experience/experience-store";
import { GOOGLE_SCOPES, type GoogleConfig } from "@niho-experience/google-calendar";

vi.mock("server-only", () => ({}));

import { executeGoogleChannelSetup } from "./google-channel-setup";
import { saveGoogleConnection } from "./google-connection";
import { sealGoogleRefreshToken } from "./google-token-crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const actorA: HostActor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" };
const actorB: HostActor = { providerId: "provider-b", nihoUserId: "owner-b", calendarRoleCeiling: "OWNER" };
const tokenKey = Buffer.alloc(32, 7);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const { Pool } = await import("pg");
  const schema = `google_setup_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 10, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
  for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
  await pool.query(`INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES
    ('provider-a','owner-a','OWNER'),('provider-a','other-owner','OWNER'),('provider-b','owner-b','OWNER')`);
  await pool.query(`INSERT INTO experience_products
    (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
    VALUES
    ('provider-a','tea','tea','DRAFT','Synthetic\nTea','{}','JPY',1000,'terms','seller-a','acct-a','Seller A'),
    ('provider-b','walk','walk','DRAFT','Synthetic Walk','{}','JPY',1000,'terms','seller-b','acct-b','Seller B')`);
  await pool.query(`INSERT INTO channel_external_accounts
    (id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until)
    VALUES ('account-a','provider-a','Airbnb','12345','Synthetic A',2,true,'2099-01-01T00:00:00Z')`);
  await pool.query(`INSERT INTO channel_listings
    (id,provider_id,account_id,product_id,external_product_id,adapter,adapter_version,connection_mode,active)
    VALUES ('listing-a','provider-a','account-a','tea','67890','airbnb-google-busy','1','GOOGLE',true)`);
  await pool.query(`INSERT INTO provider_google_connections
    (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
    VALUES ('provider-a','owner-a',$1,$3,'busy-a','booking-a'),('provider-b','owner-b',$2,$3,'busy-b','booking-b')`,
  [sealGoogleRefreshToken(tokenKey, "provider-a", "synthetic-refresh-a"), sealGoogleRefreshToken(tokenKey, "provider-b", "synthetic-refresh-b"), [...GOOGLE_SCOPES]]);
  return { pool, schema };
}

async function cleanup(value: Fixture): Promise<void> {
  await value.pool.query(`DROP SCHEMA IF EXISTS "${value.schema}" CASCADE`).catch(() => undefined);
  await value.pool.end();
}

function injected(fetchImpl: typeof fetch) {
  const google: GoogleConfig = {
    clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://experience.example.test/callback", fetch: fetchImpl,
  };
  return {
    runtimeConfig: () => ({ google, key: tokenKey }),
    refreshToken: async () => ({
      accessToken: "synthetic-access", expiresAtUtc: "2099-01-01T01:00:00.000Z", scopes: [...GOOGLE_SCOPES],
    }),
  };
}

const setupInput = (commandId = command(1)) => ({ listingId: "listing-a", expectedMappingVersion: 1, commandId });

describe.skipIf(!databaseUrl)("Google output setup runtime/repository/create integration", () => {
  it("creates one calendar, saves one inactive binding, and ACKs GET/same-command replay without another create", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        creates += 1;
        expect(String(input)).toBe("https://www.googleapis.com/calendar/v3/calendars");
        expect(init?.redirect).toBe("manual");
        expect(JSON.parse(String(init?.body))).toEqual({ summary: "NIHO Airbnb | Synthetic Tea", timeZone: "Asia/Tokyo" });
        return Response.json({ id: "airbnb-output-a", summary: "ignored-secret" });
      };
      const first = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl));
      expect(first.state).toBe("READY_FOR_CONNECTION");
      expect(creates).toBe(1);
      const binding = (await value.pool.query(
        "SELECT opaque_calendar_id,active FROM google_channel_output_bindings WHERE provider_id='provider-a' AND listing_id='listing-a'",
      )).rows[0];
      expect(binding).toEqual({ opaque_calendar_id: "airbnb-output-a", active: false });
      expect(await new GoogleChannelSetupRepository(value.pool).get(actorA, "listing-a")).toMatchObject({ state: "READY_FOR_CONNECTION" });
      expect((await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl))).state).toBe("READY_FOR_CONNECTION");
      expect(creates).toBe(1);
      await expect(executeGoogleChannelSetup(value.pool, actorA, setupInput(command(2)), injected(fetchImpl))).rejects.toBeInstanceOf(StoreConflictError);
      expect(creates).toBe(1);
    } finally { await cleanup(value); }
  });

  it("allows only the first concurrent same-command request to call calendars.insert", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      const fetchImpl: typeof fetch = async () => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return Response.json({ id: "airbnb-concurrent-a" });
      };
      const results = await Promise.all([
        executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl)),
        executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl)),
      ]);
      expect(creates).toBe(1);
      expect(results.some((item) => item.state === "READY_FOR_CONNECTION")).toBe(true);
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_output_bindings")).rows[0].count).toBe(1);
    } finally { await cleanup(value); }
  });

  it("does not let a different concurrent command step around the first unresolved create", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      const fetchImpl: typeof fetch = async () => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return Response.json({ id: "airbnb-one-command" });
      };
      const results = await Promise.allSettled([
        executeGoogleChannelSetup(value.pool, actorA, setupInput(command(1)), injected(fetchImpl)),
        executeGoogleChannelSetup(value.pool, actorA, setupInput(command(2)), injected(fetchImpl)),
      ]);
      expect(creates).toBe(1);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    } finally { await cleanup(value); }
  });

  it("keeps ACK loss/500 uncertain and makes GET/replay perform zero additional creates", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      const fetchImpl: typeof fetch = async () => {
        creates += 1;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"possibly-created"')); controller.error(new Error("synthetic ACK loss")); },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const result = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl));
      expect(result.state).toBe("UNCERTAIN");
      expect(creates).toBe(1);
      expect((await new GoogleChannelSetupRepository(value.pool).get(actorA, "listing-a"))?.state).toBe("UNCERTAIN");
      expect((await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl))).state).toBe("UNCERTAIN");
      expect(creates).toBe(1);
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_output_bindings")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it("fails config/token refresh before create without calling calendars.insert", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      const base = injected(async () => { creates += 1; return Response.json({ id: "must-not-create" }); });
      const result = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), {
        ...base,
        refreshToken: async () => { throw new Error("synthetic refresh failure"); },
      });
      expect(result.state).toBe("FAILED_BEFORE_CREATE");
      expect(creates).toBe(0);
    } finally { await cleanup(value); }
  });

  it("requires the current Google consenting OWNER rather than another Experience OWNER", async () => {
    const value = await fixture();
    let creates = 0;
    try {
      await expect(executeGoogleChannelSetup(value.pool, {
        providerId: "provider-a", nihoUserId: "other-owner", calendarRoleCeiling: "OWNER",
      }, setupInput(), injected(async () => { creates += 1; return Response.json({ id: "must-not-create" }); }))).rejects.toThrow();
      expect(creates).toBe(0);
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_setup_journals")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it.each(["account", "product", "option"] as const)("rejects an unsupported external %s before creating a calendar", async (kind) => {
    const value = await fixture();
    let creates = 0;
    try {
      if (kind === "account") await value.pool.query("UPDATE channel_external_accounts SET external_account_id='unsupported' WHERE id='account-a'");
      if (kind === "product") await value.pool.query("UPDATE channel_listings SET external_product_id='unsupported' WHERE id='listing-a'");
      if (kind === "option") await value.pool.query("UPDATE channel_listings SET external_option_id='unsupported' WHERE id='listing-a'");
      await expect(executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(async () => {
        creates += 1; return Response.json({ id: "must-not-create" });
      }))).rejects.toBeInstanceOf(StoreConflictError);
      expect(creates).toBe(0);
    } finally { await cleanup(value); }
  });

  it("keeps long Unicode calendar names within the helper's bound without splitting a character", async () => {
    const value = await fixture();
    try {
      await value.pool.query("UPDATE experience_products SET public_title=$1 WHERE provider_id='provider-a' AND id='tea'", ["🎨".repeat(180)]);
      const result = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(async (_input, init) => {
        const { summary } = JSON.parse(String(init?.body));
        expect(summary.length).toBeLessThanOrEqual(200);
        expect(Buffer.from(summary).toString("utf8")).toBe(summary);
        return Response.json({ id: "unicode-output" });
      }));
      expect(result.state).toBe("READY_FOR_CONNECTION");
    } finally { await cleanup(value); }
  });

  it("does not report a replaced binding as the original setup's current success", async () => {
    const value = await fixture();
    let creates = 0;
    const dependencies = injected(async () => { creates += 1; return Response.json({ id: "original-output" }); });
    try {
      await executeGoogleChannelSetup(value.pool, actorA, setupInput(), dependencies);
      await value.pool.query("UPDATE google_channel_output_bindings SET opaque_calendar_id='replacement-output',binding_version=binding_version+1 WHERE provider_id='provider-a' AND listing_id='listing-a'");
      expect((await new GoogleChannelSetupRepository(value.pool).get(actorA, "listing-a"))?.state).toBe("UNCERTAIN");
      expect((await executeGoogleChannelSetup(value.pool, actorA, setupInput(), dependencies)).state).toBe("UNCERTAIN");
      expect(creates).toBe(1);
    } finally { await cleanup(value); }
  });

  it.each(["owner", "mapping", "generation", "scope"] as const)("does not bind a calendar after a post-create %s change", async (kind) => {
    const value = await fixture();
    try {
      const fetchImpl: typeof fetch = async () => {
        if (kind === "owner") await value.pool.query("UPDATE provider_memberships SET role='EDITOR' WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
        if (kind === "mapping") await value.pool.query("UPDATE channel_listings SET mapping_version=mapping_version+1 WHERE id='listing-a'");
        if (kind === "generation") await value.pool.query("UPDATE provider_google_connections SET connection_generation=nextval('provider_google_connection_generation_seq') WHERE provider_id='provider-a'");
        if (kind === "scope") await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY['https://www.googleapis.com/auth/calendar.app.created'] WHERE provider_id='provider-a'");
        return Response.json({ id: `stale-${kind}` });
      };
      const pending = executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(fetchImpl));
      if (kind === "owner") await expect(pending).rejects.toBeInstanceOf(StoreAccessDeniedError);
      else expect((await pending).state).toBe("UNCERTAIN");
      expect((await value.pool.query("SELECT phase FROM google_channel_setup_journals")).rows[0].phase).toBe("UNCERTAIN");
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_output_bindings")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it("marks a post-create storage collision uncertain and never adopts an existing calendar by name or ID", async () => {
    const value = await fixture();
    try {
      const result = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(async () => Response.json({ id: "busy-b" })));
      expect(result.state).toBe("UNCERTAIN");
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_output_bindings")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it("rejects a calendar still referenced by a disabled resource, matching delivery's exclusion", async () => {
    const value = await fixture();
    try {
      await value.pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-b','room-b','VENUE','Room B')");
      await value.pool.query(`INSERT INTO resource_google_calendars (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation)
        SELECT 'provider-b','room-b','disabled-resource-calendar',false,connection_generation FROM provider_google_connections WHERE provider_id='provider-b'`);
      const result = await executeGoogleChannelSetup(value.pool, actorA, setupInput(), injected(async () => Response.json({ id: "disabled-resource-calendar" })));
      expect(result.state).toBe("UNCERTAIN");
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_output_bindings")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it("rejects provider, actor, and nonce capability changes and refuses to replace an existing binding", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelSetupRepository(value.pool);
      const snapshot = await repository.prepare(actorA, setupInput());
      await expect(repository.markCreating({ ...snapshot, providerId: "provider-b" })).rejects.toThrow();
      await expect(repository.markCreating({ ...snapshot, createdByNihoUserId: "other-owner" })).rejects.toThrow();
      await expect(repository.markCreating({ ...snapshot, operationNonce: randomUUID() })).rejects.toBeInstanceOf(StoreConflictError);
      expect((await value.pool.query("SELECT phase FROM google_channel_setup_journals WHERE provider_id='provider-a'")).rows[0].phase).toBe("PREPARING");
      await repository.failBeforeCreate(snapshot, "AUTHORITY_CHANGED");
      await value.pool.query(`INSERT INTO google_channel_output_bindings
        (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id,active)
        SELECT 'provider-a','listing-a',1,connection_generation,'existing-output',false
          FROM provider_google_connections WHERE provider_id='provider-a'`);
      let creates = 0;
      await expect(executeGoogleChannelSetup(value.pool, actorA, setupInput(command(2)), injected(async () => {
        creates += 1; return Response.json({ id: "replacement" });
      }))).rejects.toBeInstanceOf(StoreConflictError);
      expect(creates).toBe(0);
      expect((await value.pool.query("SELECT opaque_calendar_id FROM google_channel_output_bindings")).rows[0].opaque_calendar_id).toBe("existing-output");
    } finally { await cleanup(value); }
  });

  it.each(["provider", "resource", "connection"] as const)("serializes cross-provider %s input/output adoption and permits only one final role", async (kind) => {
    const value = await fixture();
    const locker = await value.pool.connect();
    try {
      const repository = new GoogleChannelSetupRepository(value.pool);
      const snapshot = await repository.prepare(actorA, setupInput());
      await repository.markCreating(snapshot);
      let configureInput: () => Promise<unknown>;
      if (kind === "resource") {
        await value.pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-b','room-b','VENUE','Room B')");
        const generation = Number((await value.pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-b'")).rows[0].connection_generation);
        const resources = new ResourceGoogleRepository(value.pool);
        await resources.replaceCalendarInventory(actorB, { connectionGeneration: generation, fetchedAtUtc: new Date().toISOString(), calendars: [{ id: "cross-provider-calendar", name: "Synthetic candidate", primary: false }] });
        configureInput = () => resources.save(actorB, { resourceId: "room-b", calendarId: "cross-provider-calendar", enabled: true }, null, command(2));
      } else if (kind === "connection") {
        vi.stubEnv("EXPERIENCE_GOOGLE_CLIENT_ID", "synthetic");
        vi.stubEnv("EXPERIENCE_GOOGLE_CLIENT_SECRET", "synthetic");
        vi.stubEnv("EXPERIENCE_GOOGLE_TOKEN_KEY", tokenKey.toString("base64"));
        configureInput = () => saveGoogleConnection(value.pool, actorB, { accessToken: "synthetic", refreshToken: "synthetic-refresh", expiresAtUtc: "2099-01-01T01:00:00.000Z", scopes: [...GOOGLE_SCOPES] }, "cross-provider-calendar", "new-booking-b");
      } else {
        configureInput = () => new ExperienceStore(value.pool).configureGoogleCalendar(actorB, { opaqueCalendarId: "cross-provider-calendar", blockingEnabled: true }, null);
      }
      await locker.query("BEGIN");
      await lockGoogleCalendarUsage(locker, ["cross-provider-calendar"]);
      let inputSettled = false;
      let outputSettled = false;
      const input = configureInput().finally(() => { inputSettled = true; });
      const output = repository.finish(snapshot, "cross-provider-calendar").finally(() => { outputSettled = true; });
      const pending = Promise.allSettled([input, output]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(inputSettled).toBe(false);
      expect(outputSettled).toBe(false);
      await locker.query("COMMIT");
      const results = await pending;
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
      const inputUsed = (await value.pool.query(`SELECT EXISTS (SELECT 1 FROM provider_google_calendars WHERE opaque_calendar_id='cross-provider-calendar')
        OR EXISTS (SELECT 1 FROM resource_google_calendars WHERE enabled=true AND opaque_calendar_id='cross-provider-calendar')
        OR EXISTS (SELECT 1 FROM provider_google_connections WHERE busy_calendar_id='cross-provider-calendar' OR booking_calendar_id='cross-provider-calendar') AS used`)).rows[0].used;
      const outputCount = (await value.pool.query(
        "SELECT count(*)::int AS count FROM google_channel_output_bindings WHERE opaque_calendar_id='cross-provider-calendar'",
      )).rows[0].count;
      expect(Number(inputUsed) + outputCount).toBe(1);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      await cleanup(value);
      if (kind === "connection") vi.unstubAllEnvs();
    }
  });
});
