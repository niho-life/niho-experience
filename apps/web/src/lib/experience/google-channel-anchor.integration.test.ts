import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GoogleChannelAnchorRepository,
  StoreAccessDeniedError,
  StoreConflictError,
  type HostActor,
} from "@niho-experience/experience-store";
import { GOOGLE_SCOPES, type GoogleConfig } from "@niho-experience/google-calendar";

vi.mock("server-only", () => ({}));

import { executeGoogleChannelAnchor } from "./google-channel-anchor";
import { sealGoogleRefreshToken } from "./google-token-crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;
const actor: HostActor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" };
const occurrenceId = "rule-a@2099-01-01";
const tokenKey = Buffer.alloc(32, 11);
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(desiredState: "OPEN" | "CLOSED" = "OPEN") {
  const { Pool } = await import("pg");
  const schema = `google_anchor_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 10, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
  for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
  await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
  await pool.query(`INSERT INTO experience_products
    (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
    VALUES ('provider-a','tea','tea','DRAFT','Synthetic Tea','{}','JPY',1000,'terms','seller','acct','Seller')`);
  await pool.query(`INSERT INTO schedule_rules
    (provider_id,id,product_id,time_zone,starts_on,ends_on,local_start_time,duration_minutes,capacity,
     booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
    VALUES ('provider-a','rule-a','tea','Asia/Tokyo','2099-01-01','2099-01-01','10:00',60,4,0,0,0,'{"kind":"DAILY"}')`);
  if (desiredState === "CLOSED") {
    await pool.query(`INSERT INTO schedule_occurrence_sales_states
      (provider_id,rule_id,occurrence_id,desired_state) VALUES ('provider-a','rule-a',$1,'CLOSED')`, [occurrenceId]);
  }
  await pool.query(`INSERT INTO channel_external_accounts
    (id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until)
    VALUES ('account-a','provider-a','Airbnb','12345','Synthetic',2,true,'2099-02-01T00:00:00Z')`);
  await pool.query(`INSERT INTO channel_listings
    (id,provider_id,account_id,product_id,external_product_id,external_option_id,adapter,adapter_version,connection_mode,active)
    VALUES ('listing-a','provider-a','account-a','tea','67890','','airbnb-google-busy','1','GOOGLE',true)`);
  await pool.query(`INSERT INTO channel_desired_states
    (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
    VALUES ('listing-a','provider-a',$1,$2,'SYNTHETIC',7,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`,
  [occurrenceId, desiredState]);
  await pool.query(`INSERT INTO provider_google_connections
    (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
    VALUES ('provider-a','owner-a',$1,$2,'busy-a','booking-a')`,
  [sealGoogleRefreshToken(tokenKey, "provider-a", "synthetic-refresh"), [...GOOGLE_SCOPES]]);
  const generation = (await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation;
  await pool.query(`INSERT INTO google_channel_output_bindings
    (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id,active)
    VALUES ('provider-a','listing-a',1,$1,'output-a',false)`, [generation]);
  await pool.query(`INSERT INTO google_channel_setup_journals
    (provider_id,command_id,listing_id,account_id,request_fingerprint,created_by_niho_user_id,operation_nonce,
     expected_mapping_version,account_version,connection_generation,granted_scopes_digest,calendar_summary,phase,created_calendar_id)
    SELECT 'provider-a',$1::uuid,'listing-a','account-a',$2,'owner-a',$3::uuid,1,a.version,$4,$5,
           'NIHO Airbnb | Synthetic','READY_FOR_CONNECTION','output-a'
      FROM channel_external_accounts a WHERE a.id='account-a'`,
  [command(900), "a".repeat(64), randomUUID(), generation, "b".repeat(64)]);
  return { pool, schema };
}

async function cleanup(value: Fixture) {
  await value.pool.query(`DROP SCHEMA IF EXISTS "${value.schema}" CASCADE`).catch(() => undefined);
  await value.pool.end();
}

function dependencies(fetchImpl: typeof fetch) {
  const google: GoogleConfig = {
    clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://example.test/callback", fetch: fetchImpl,
  };
  return {
    runtimeConfig: () => ({ google, key: tokenKey }),
    refreshToken: async () => ({
      accessToken: "synthetic-access", expiresAtUtc: "2099-01-01T00:00:00.000Z", scopes: [...GOOGLE_SCOPES],
    }),
  };
}

const input = (commandId = command(1), operation: "initialize" | "inspect" = "initialize") => ({
  listingId: "listing-a", occurrenceId, expectedMappingVersion: 1, expectedDesiredVersion: 7, commandId, operation,
});

describe.skipIf(!databaseUrl)("Google anchor real store/executor/helper integration", () => {
  it.each(["OPEN", "CLOSED"] as const)("initializes one %s anchor and same-command replay never inserts", async (desiredState) => {
    const value = await fixture(desiredState);
    let event: Record<string, unknown> | undefined;
    let writes = 0;
    let gets = 0;
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method === "POST") {
          writes += 1;
          event = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ id: event.id, etag: '"ack"' });
        }
        gets += 1;
        return event ? Response.json({ ...event, status: "confirmed", etag: '"verified"' }) : new Response(null, { status: 404 });
      };
      const first = await executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl));
      expect(first.state).toBe("GOOGLE_VERIFIED");
      expect(writes).toBe(1);
      expect(gets).toBe(2);
      expect(event?.transparency).toBe(desiredState === "OPEN" ? "transparent" : "opaque");
      expect((await executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl))).state).toBe("GOOGLE_VERIFIED");
      expect(writes).toBe(1);
      expect(JSON.stringify(first)).not.toContain("output-a");
      expect(JSON.stringify(first)).not.toContain("etag");
    } finally { await cleanup(value); }
  });

  it("keeps ambiguous dispatch uncertain, blocks new commands, and explicit inspect is GET-only", async () => {
    const value = await fixture();
    let writes = 0;
    let gets = 0;
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method === "POST") { writes += 1; throw new Error("synthetic ACK loss"); }
        gets += 1;
        return new Response(null, { status: 404 });
      };
      const uncertain = await executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl));
      expect(uncertain).toMatchObject({ state: "UNCERTAIN", reason: "WRITE_UNCERTAIN" });
      expect(writes).toBe(1);
      expect((await executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl))).state).toBe("UNCERTAIN");
      expect(writes).toBe(1);
      await expect(executeGoogleChannelAnchor(value.pool, actor, input(command(2)), dependencies(fetchImpl))).rejects.toBeInstanceOf(StoreConflictError);
      const inspected = await executeGoogleChannelAnchor(value.pool, actor, input(command(1), "inspect"), dependencies(fetchImpl));
      expect(inspected).toMatchObject({ state: "UNCERTAIN", reason: "ANCHOR_MISSING" });
      expect(writes).toBe(1);
      expect(gets).toBe(3);
    } finally { await cleanup(value); }
  });

  it("fences a crashed PREPARING command without Google I/O and allows a fresh command", async () => {
    const value = await fixture();
    let event: Record<string, unknown> | undefined;
    let writes = 0;
    try {
      const repository = new GoogleChannelAnchorRepository(value.pool);
      const abandoned = await repository.prepare(actor, input());
      const neverCallGoogle = dependencies(async () => { throw new Error("must not call Google"); });
      const inspected = await executeGoogleChannelAnchor(value.pool, actor, input(command(1), "inspect"), {
        ...neverCallGoogle, refreshToken: async () => { throw new Error("must not refresh token"); },
      });
      expect(inspected).toMatchObject({ state: "FAILED_BEFORE_INITIALIZE", reason: "PREPARATION_CANCELLED" });
      expect((await executeGoogleChannelAnchor(value.pool, actor, input(command(1), "inspect"), neverCallGoogle)).state).toBe("FAILED_BEFORE_INITIALIZE");
      await expect(repository.markInitializing(abandoned)).rejects.toBeInstanceOf(StoreConflictError);
      await expect(repository.failBeforeInitialize(abandoned, "GOOGLE_UNAVAILABLE")).rejects.toBeInstanceOf(StoreConflictError);
      const stored = (await value.pool.query("SELECT operation_nonce,operation_epoch FROM google_channel_anchor_journals")).rows[0];
      expect(stored.operation_nonce).not.toBe(abandoned.operationNonce);
      expect(stored.operation_epoch).toBe("2");
      const next = await executeGoogleChannelAnchor(value.pool, actor, input(command(2)), dependencies(async (_url, init) => {
        if (init?.method === "POST") {
          writes += 1;
          event = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ id: event.id, etag: '"ack"' });
        }
        return event ? Response.json({ ...event, status: "confirmed", etag: '"verified"' }) : new Response(null, { status: 404 });
      }));
      expect(next.state).toBe("GOOGLE_VERIFIED");
      expect(writes).toBe(1);
    } finally { await cleanup(value); }
  });

  it("prevents a suspended token-refresh execution from sending after PREPARING recovery", async () => {
    const value = await fixture();
    let writes = 0;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const deps = dependencies(async () => { writes += 1; throw new Error("must not send event I/O"); });
      const original = executeGoogleChannelAnchor(value.pool, actor, input(), {
        ...deps, refreshToken: async () => { entered(); await blocked; return deps.refreshToken(); },
      });
      const stopped = expect(original).rejects.toBeInstanceOf(StoreConflictError);
      await started;
      const recovered = await executeGoogleChannelAnchor(value.pool, actor, input(command(1), "inspect"), deps);
      expect(recovered.reason).toBe("PREPARATION_CANCELLED");
      release();
      await stopped;
      expect(writes).toBe(0);
      expect((await value.pool.query("SELECT phase FROM google_channel_anchor_journals")).rows[0].phase).toBe("FAILED_BEFORE_INITIALIZE");
    } finally { release(); await cleanup(value); }
  });

  it("can end an unsubmitted command after the desired version and live rule change", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelAnchorRepository(value.pool);
      const abandoned = await repository.prepare(actor, input());
      await value.pool.query("UPDATE channel_desired_states SET desired_version=desired_version+1 WHERE listing_id='listing-a'");
      await value.pool.query("UPDATE schedule_rules SET local_start_time='11:00' WHERE id='rule-a'");
      const recovered = await executeGoogleChannelAnchor(value.pool, actor, input(command(1), "inspect"), {
        ...dependencies(async () => { throw new Error("must not call Google"); }),
        refreshToken: async () => { throw new Error("must not refresh token"); },
      });
      expect(recovered.reason).toBe("PREPARATION_CANCELLED");
      await expect(repository.markInitializing(abandoned)).rejects.toThrow();
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_anchor_journals WHERE phase IN ('PREPARING','INITIALIZING','UNCERTAIN')")).rows[0].count).toBe(0);
    } finally { await cleanup(value); }
  });

  it("fences the original nonce when explicit inspection claims a new operation epoch", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelAnchorRepository(value.pool);
      const original = await repository.prepare(actor, input());
      await repository.markInitializing(original);
      const inspection = await repository.prepare(actor, input(command(1), "inspect"));
      expect(inspection.operationEpoch).toBe(original.operationEpoch + 1);
      expect(inspection.operationNonce).not.toBe(original.operationNonce);
      await expect(repository.saveUncertain(original, "WRITE_UNCERTAIN")).rejects.toBeInstanceOf(StoreConflictError);
      expect((await value.pool.query("SELECT operation,phase FROM google_channel_anchor_journals")).rows[0])
        .toEqual({ operation: "INSPECT", phase: "UNCERTAIN" });
    } finally { await cleanup(value); }
  });

  it("allows only one concurrent command to dispatch and never issues a second insert", async () => {
    const value = await fixture();
    let event: Record<string, unknown> | undefined;
    let writes = 0;
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method === "POST") {
          writes += 1;
          event = JSON.parse(String(init.body)) as Record<string, unknown>;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return Response.json({ id: event.id, etag: '"ack"' });
        }
        return event ? Response.json({ ...event, status: "confirmed", etag: '"verified"' }) : new Response(null, { status: 404 });
      };
      const results = await Promise.allSettled([
        executeGoogleChannelAnchor(value.pool, actor, input(command(1)), dependencies(fetchImpl)),
        executeGoogleChannelAnchor(value.pool, actor, input(command(2)), dependencies(fetchImpl)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(writes).toBe(1);
    } finally { await cleanup(value); }
  });

  it.each(["owner", "account", "listing", "mapping", "binding", "generation", "scope", "desired", "time", "live"] as const)(
    "rechecks %s authority before Google I/O",
    async (kind) => {
      const value = await fixture();
      try {
        const repository = new GoogleChannelAnchorRepository(value.pool);
        const prepared = await repository.prepare(actor, input());
        if (kind === "owner") await value.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
        if (kind === "account") await value.pool.query("UPDATE channel_external_accounts SET version=version+1 WHERE id='account-a'");
        if (kind === "listing") await value.pool.query("UPDATE channel_listings SET active=false WHERE id='listing-a'");
        if (kind === "mapping") await value.pool.query("UPDATE channel_listings SET mapping_version=2 WHERE id='listing-a'");
        if (kind === "binding") await value.pool.query("UPDATE google_channel_output_bindings SET binding_version=2 WHERE listing_id='listing-a'");
        if (kind === "generation") await value.pool.query("UPDATE google_channel_output_bindings SET connection_generation=connection_generation+100 WHERE listing_id='listing-a'");
        if (kind === "scope") await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY['https://www.googleapis.com/auth/calendar.app.created'] WHERE provider_id='provider-a'");
        if (kind === "desired") await value.pool.query("UPDATE channel_desired_states SET desired_version=8 WHERE listing_id='listing-a' AND occurrence_id=$1", [occurrenceId]);
        if (kind === "time") await value.pool.query("UPDATE schedule_rules SET local_start_time='10:01' WHERE provider_id='provider-a' AND id='rule-a'");
        if (kind === "live") await value.pool.query("INSERT INTO schedule_occurrence_sales_states (provider_id,rule_id,occurrence_id,desired_state) VALUES ('provider-a','rule-a',$1,'CLOSED')", [occurrenceId]);
        await expect(repository.markInitializing(prepared)).rejects.toThrow();
      } finally { await cleanup(value); }
    },
  );

  it.each(["owner", "account", "listing", "mapping", "binding", "generation", "scope", "desired", "time", "live"] as const)(
    "keeps a dispatched insert uncertain when %s changes during Google I/O",
    async (kind) => {
      const value = await fixture();
      let event: Record<string, unknown> | undefined;
      let writes = 0;
      try {
        const fetchImpl: typeof fetch = async (_url, init) => {
          if (init?.method !== "POST") {
            return event ? Response.json({ ...event, status: "confirmed", etag: '"readback"' }) : new Response(null, { status: 404 });
          }
          writes += 1;
          event = JSON.parse(String(init.body)) as Record<string, unknown>;
          if (kind === "owner") await value.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
          if (kind === "account") await value.pool.query("UPDATE channel_external_accounts SET version=version+1 WHERE id='account-a'");
          if (kind === "listing") await value.pool.query("UPDATE channel_listings SET active=false WHERE id='listing-a'");
          if (kind === "mapping") await value.pool.query("UPDATE channel_listings SET mapping_version=2 WHERE id='listing-a'");
          if (kind === "binding") await value.pool.query("UPDATE google_channel_output_bindings SET binding_version=2 WHERE listing_id='listing-a'");
          if (kind === "generation") await value.pool.query("UPDATE provider_google_connections SET connection_generation=connection_generation+1 WHERE provider_id='provider-a'");
          if (kind === "scope") await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY['https://www.googleapis.com/auth/calendar.app.created'] WHERE provider_id='provider-a'");
          if (kind === "desired") await value.pool.query("UPDATE channel_desired_states SET desired_version=8 WHERE listing_id='listing-a' AND occurrence_id=$1", [occurrenceId]);
          if (kind === "time") await value.pool.query("UPDATE schedule_rules SET local_start_time='11:00' WHERE provider_id='provider-a' AND id='rule-a'");
          if (kind === "live") await value.pool.query("INSERT INTO schedule_occurrence_sales_states (provider_id,rule_id,occurrence_id,desired_state) VALUES ('provider-a','rule-a',$1,'CLOSED')", [occurrenceId]);
          return Response.json({ id: event.id, etag: '"ack"' });
        };
        const pending = executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl));
        if (kind === "owner") await expect(pending).rejects.toBeInstanceOf(StoreAccessDeniedError);
        else expect((await pending).state).toBe("UNCERTAIN");
        expect(writes).toBe(1);
        expect((await value.pool.query("SELECT phase FROM google_channel_anchor_journals")).rows[0].phase).toBe("UNCERTAIN");
        expect((await value.pool.query("SELECT active FROM google_channel_output_bindings")).rows[0].active).toBe(false);
      } finally { await cleanup(value); }
    },
  );

  it("recovers a lost readback using GET only after a temporary token error", async () => {
    const value = await fixture();
    let event: Record<string, unknown> | undefined;
    let writes = 0;
    let readable = false;
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method === "POST") {
          writes += 1;
          event = JSON.parse(String(init.body)) as Record<string, unknown>;
          throw new Error("synthetic ACK loss");
        }
        if (!event) return new Response(null, { status: 404 });
        return readable ? Response.json({ ...event, status: "confirmed", etag: '"recovered"' }) : new Response(null, { status: 503 });
      };
      expect((await executeGoogleChannelAnchor(value.pool, actor, input(), dependencies(fetchImpl))).state).toBe("UNCERTAIN");
      readable = true;
      const inspection = input(command(1), "inspect");
      const failed = await executeGoogleChannelAnchor(value.pool, actor, inspection, {
        ...dependencies(fetchImpl), refreshToken: async () => { throw new Error("synthetic refresh error"); },
      });
      expect(failed.state).toBe("UNCERTAIN");
      expect((await executeGoogleChannelAnchor(value.pool, actor, inspection, dependencies(fetchImpl))).state).toBe("GOOGLE_VERIFIED");
      expect(writes).toBe(1);
      const stored = (await value.pool.query("SELECT operation,operation_epoch,phase FROM google_channel_anchor_journals")).rows[0];
      expect(stored).toEqual({ operation: "INSPECT", operation_epoch: "3", phase: "GOOGLE_VERIFIED" });
    } finally { await cleanup(value); }
  });

  it("rejects missing/cross-listing occurrences, active or non-ready bindings, and disabled input collisions", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelAnchorRepository(value.pool);
      await value.pool.query("DELETE FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1", [occurrenceId]);
      await expect(repository.prepare(actor, input())).rejects.toBeInstanceOf(StoreConflictError);
      await value.pool.query(`INSERT INTO channel_desired_states
        (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
        VALUES ('listing-a','provider-a','other-rule@2099-01-01','OPEN','SYNTHETIC',7,1,
                '2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`);
      await expect(repository.prepare(actor, { ...input(), occurrenceId: "other-rule@2099-01-01" })).rejects.toBeInstanceOf(StoreConflictError);
      await value.pool.query("DELETE FROM channel_desired_states WHERE occurrence_id='other-rule@2099-01-01'");
      await value.pool.query(`INSERT INTO channel_desired_states
        (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
        VALUES ('listing-a','provider-a',$1,'OPEN','SYNTHETIC',7,1,
                '2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`, [occurrenceId]);

      await value.pool.query("UPDATE google_channel_output_bindings SET active=true WHERE listing_id='listing-a'");
      await expect(repository.prepare(actor, input(command(2)))).rejects.toBeInstanceOf(StoreConflictError);
      await value.pool.query("UPDATE google_channel_output_bindings SET active=false WHERE listing_id='listing-a'");
      await value.pool.query("UPDATE google_channel_setup_journals SET phase='UNCERTAIN',created_calendar_id=NULL,failure_reason='STORE_FAILED' WHERE listing_id='listing-a'");
      await expect(repository.prepare(actor, input(command(3)))).rejects.toBeInstanceOf(StoreConflictError);
      await value.pool.query("UPDATE google_channel_setup_journals SET phase='READY_FOR_CONNECTION',created_calendar_id='output-a',failure_reason=NULL WHERE listing_id='listing-a'");

      await value.pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-a','room-a','VENUE','Room')");
      await value.pool.query(`INSERT INTO resource_google_calendars
        (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation)
        SELECT 'provider-a','room-a','output-a',false,connection_generation
          FROM provider_google_connections WHERE provider_id='provider-a'`);
      await expect(repository.prepare(actor, input(command(4)))).rejects.toBeInstanceOf(StoreConflictError);
    } finally { await cleanup(value); }
  });
});
