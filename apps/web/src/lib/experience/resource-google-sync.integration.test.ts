import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SCOPES } from "@niho-experience/google-calendar";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./google-connection", () => ({ googleRuntimeConfig: () => ({
  google: { clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://experience.example/callback", fetch: mocks.fetch }, key: Buffer.alloc(32),
}) }));
vi.mock("./google-token-crypto", () => ({
  openGoogleRefreshToken: (_key: Buffer, _providerId: string, value: string) => value,
  sealGoogleRefreshToken: () => "z".repeat(40),
}));

import { refreshResourceGoogleOwnerSnapshot, syncOneDueResourceGoogle } from "./resource-google";

const databaseUrl = process.env.TEST_DATABASE_URL;
const originalEnabled = process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED;
const originalWatchEnabled = process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED;
const originalWebhookUrl = process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL;
beforeAll(() => { process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED = "true"; });
afterAll(() => {
  if (originalEnabled === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED; else process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED = originalEnabled;
  if (originalWatchEnabled === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED; else process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED = originalWatchEnabled;
  if (originalWebhookUrl === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL; else process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL = originalWebhookUrl;
});

describe.skipIf(!databaseUrl)("resource Google sync epochs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("rejects old settings and reconnect ABA responses after external freebusy", async () => {
    const { Pool } = await import("pg");
    const schema = `resource_google_sync_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
      for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      await pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-a','room-a','VENUE','Room A')");
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,$2,'legacy','booking-output')`, ["r".repeat(40), [...GOOGLE_SCOPES]],
      );
      const generation = Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      await pool.query(
        `INSERT INTO resource_google_calendars
          (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation,next_sync_due_at)
         VALUES ('provider-a','room-a','old-calendar',true,$1,clock_timestamp()-interval '1 minute')`, [generation],
      );
      await pool.query(
        `INSERT INTO channel_external_accounts (id,provider_id,site,external_account_id,display_name,operating_model,active)
         VALUES ('account-a','provider-a','GETYOURGUIDE','external-a','Synthetic',1,true)`,
      );
      await pool.query(
        `INSERT INTO channel_workers (id,display_name,credential_digest,credential_expires_at)
         VALUES ('studio-1','Studio',$1,clock_timestamp()+interval '1 day')`, ["a".repeat(64)],
      );
      await pool.query("INSERT INTO channel_worker_accounts (worker_id,account_id) VALUES ('studio-1','account-a')");
      const worker = { workerId: "studio-1", credentialVersion: 1 } as const;

      let release = () => {};
      let started = () => {};
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", expires_in: 3600 });
        started(); await releasePromise;
        return Response.json({ calendars: { "old-calendar": { busy: [{ start: "2099-01-01T01:00:00Z", end: "2099-01-01T02:00:00Z" }] } } });
      });
      const oldSettings = syncOneDueResourceGoogle(pool, worker);
      await startedPromise;
      await pool.query(
        `UPDATE resource_google_calendars SET opaque_calendar_id='new-calendar',settings_version=settings_version+1,
          sync_status='STALE',fresh_until=NULL,sync_dirty=true,sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL
         WHERE provider_id='provider-a' AND resource_id='room-a'`,
      );
      release();
      expect(await oldSettings).toEqual({ processed: true, applied: false });
      const afterSettings = (await pool.query("SELECT opaque_calendar_id,settings_version,sync_status FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0];
      expect(afterSettings).toMatchObject({ opaque_calendar_id: "new-calendar", sync_status: "STALE" });
      expect((await pool.query("SELECT 1 FROM resource_google_busy_intervals WHERE provider_id='provider-a'")).rowCount).toBe(0);

      await pool.query("UPDATE resource_google_calendars SET opaque_calendar_id='old-calendar',next_sync_due_at=clock_timestamp()-interval '1 minute' WHERE provider_id='provider-a' AND resource_id='room-a'");
      let releaseReconnect = () => {};
      let reconnectStarted = () => {};
      const reconnectStartedPromise = new Promise<void>((resolve) => { reconnectStarted = resolve; });
      const releaseReconnectPromise = new Promise<void>((resolve) => { releaseReconnect = resolve; });
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", expires_in: 3600 });
        reconnectStarted(); await releaseReconnectPromise;
        return Response.json({ calendars: { "old-calendar": { busy: [] } } });
      });
      const oldConnection = syncOneDueResourceGoogle(pool, worker);
      await reconnectStartedPromise;
      await pool.query("DELETE FROM provider_google_connections WHERE provider_id='provider-a'");
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,$2,'legacy','booking-output')`, ["n".repeat(40), [...GOOGLE_SCOPES]],
      );
      const reconnectGeneration = Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      expect(reconnectGeneration).toBeGreaterThan(generation);
      await pool.query(
        `UPDATE resource_google_calendars SET connection_generation=$1,sync_status='STALE',fresh_until=NULL,
          sync_dirty=true,sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL WHERE provider_id='provider-a' AND resource_id='room-a'`,
        [reconnectGeneration],
      );
      releaseReconnect();
      expect(await oldConnection).toEqual({ processed: true, applied: false });
      expect((await pool.query("SELECT sync_status FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0].sync_status).toBe("STALE");
      expect((await pool.query("SELECT outcome FROM resource_google_sync_receipts ORDER BY created_at")).rows.map((row) => row.outcome)).toEqual(["SUPERSEDED", "SUPERSEDED"]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });

  it("keeps prior busy data when leases or worker authority change, backs off failures, and commits outbox with receipts", async () => {
    const { Pool } = await import("pg");
    const schema = `resource_google_authority_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
    const worker = { workerId: "studio-1", credentialVersion: 1 } as const;
    const resetDue = async () => {
      await pool.query(
        `UPDATE resource_google_calendars SET sync_status='FRESH',fresh_until=clock_timestamp()+interval '20 minutes',
          coverage_start='2099-01-01T00:00:00Z',coverage_end='2099-01-03T00:00:00Z',sync_dirty=true,
          next_sync_due_at=clock_timestamp()-interval '1 minute',sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL
         WHERE provider_id='provider-a' AND resource_id='room-a'`,
      );
    };
    const gateFreebusy = () => {
      let started = () => {};
      let release = () => {};
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", expires_in: 3600 });
        if (url.includes("/freeBusy")) {
          started();
          await releasePromise;
          return Response.json({ calendars: { "room-calendar": { busy: [{ start: "2099-01-01T03:00:00Z", end: "2099-01-01T04:00:00Z" }] } } });
        }
        throw new Error(`Unexpected Google request: ${url}`);
      });
      return { startedPromise, release };
    };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
      for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      await pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-a','room-a','VENUE','Room A')");
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,$2,'legacy','booking-output')`, ["r".repeat(40), [...GOOGLE_SCOPES]],
      );
      const generation = Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      await pool.query(
        `INSERT INTO resource_google_calendars
          (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation,sync_status,fresh_until,coverage_start,coverage_end,next_sync_due_at)
         VALUES ('provider-a','room-a','room-calendar',true,$1,'FRESH',clock_timestamp()+interval '20 minutes',
           '2099-01-01T00:00:00Z','2099-01-03T00:00:00Z',clock_timestamp()-interval '1 minute')`, [generation],
      );
      await pool.query(
        `INSERT INTO resource_google_busy_intervals
          (provider_id,resource_id,settings_version,connection_generation,start_at,end_at)
         VALUES ('provider-a','room-a',1,$1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`, [generation],
      );
      await pool.query(
        `INSERT INTO channel_external_accounts (id,provider_id,site,external_account_id,display_name,operating_model,active)
         VALUES ('account-a','provider-a','GETYOURGUIDE','external-a','Synthetic',1,true)`,
      );
      await pool.query(
        `INSERT INTO channel_workers (id,display_name,credential_digest,credential_expires_at)
         VALUES ('studio-1','Studio',$1,clock_timestamp()+interval '1 day')`, ["a".repeat(64)],
      );
      await pool.query("INSERT INTO channel_worker_accounts (worker_id,account_id) VALUES ('studio-1','account-a')");

      let gate = gateFreebusy();
      let syncing = syncOneDueResourceGoogle(pool, worker);
      await gate.startedPromise;
      await pool.query("UPDATE channel_workers SET revoked_at=clock_timestamp() WHERE id='studio-1'");
      gate.release();
      expect(await syncing).toEqual({ processed: true, applied: false });
      expect((await pool.query("SELECT sync_status FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0].sync_status).toBe("FRESH");
      expect((await pool.query("SELECT start_at FROM resource_google_busy_intervals WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0].start_at.toISOString()).toBe("2099-01-01T01:00:00.000Z");

      await pool.query("UPDATE channel_workers SET revoked_at=NULL WHERE id='studio-1'");
      await resetDue();
      gate = gateFreebusy();
      syncing = syncOneDueResourceGoogle(pool, worker);
      await gate.startedPromise;
      await pool.query("UPDATE channel_worker_accounts SET revoked_at=clock_timestamp(),version=version+1 WHERE worker_id='studio-1' AND account_id='account-a'");
      gate.release();
      expect(await syncing).toEqual({ processed: true, applied: false });

      await pool.query("UPDATE channel_worker_accounts SET revoked_at=NULL WHERE worker_id='studio-1' AND account_id='account-a'");
      await resetDue();
      gate = gateFreebusy();
      syncing = syncOneDueResourceGoogle(pool, worker);
      await gate.startedPromise;
      await pool.query("UPDATE resource_google_calendars SET sync_lease_expires_at=clock_timestamp()-interval '1 second' WHERE provider_id='provider-a' AND resource_id='room-a'");
      gate.release();
      expect(await syncing).toEqual({ processed: true, applied: false });
      expect((await pool.query("SELECT outcome FROM resource_google_sync_receipts ORDER BY created_at")).rows.map((row) => row.outcome)).toEqual(["SUPERSEDED", "SUPERSEDED", "SUPERSEDED"]);

      await resetDue();
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("oauth2.googleapis.com/token")
        ? Response.json({ access_token: "access", expires_in: 3600 }) : new Response(null, { status: 503 }));
      expect(await syncOneDueResourceGoogle(pool, worker)).toEqual({ processed: true, applied: false });
      const failed = (await pool.query(
        `SELECT sync_status,next_sync_due_at>clock_timestamp()+interval '4 minutes' AS backed_off
           FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'`,
      )).rows[0];
      expect(failed).toMatchObject({ sync_status: "FAILED", backed_off: true });
      expect(await syncOneDueResourceGoogle(pool, worker)).toEqual({ processed: false, applied: false });
      expect((await pool.query("SELECT count(*)::int AS count FROM resource_google_busy_intervals WHERE provider_id='provider-a'")).rows[0].count).toBe(1);
      const cached = await refreshResourceGoogleOwnerSnapshot(pool, { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" });
      expect(cached.resources.find((resource) => resource.resourceId === "room-a")).toMatchObject({ enabled: true, syncStatus: "STALE" });

      process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED = "true";
      process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL = "https://experience.example.test/api/google/calendar/watch";
      await resetDue();
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", expires_in: 3600 });
        if (url.includes("/events/watch")) return new Response(null, { status: 503 });
        return Response.json({ calendars: { "room-calendar": { busy: [{ start: "2099-01-01T03:00:00Z", end: "2099-01-01T04:00:00Z" }] } } });
      });
      expect(await syncOneDueResourceGoogle(pool, worker)).toEqual({ processed: true, applied: true });
      expect((await pool.query("SELECT sync_status FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0].sync_status).toBe("FRESH");
      expect((await pool.query("SELECT count(*)::int AS count FROM resource_google_watch_channels")).rows[0].count).toBe(0);

      await resetDue();
      // A registered Google channel is only trusted after its metadata commits. A superseded
      // response leaves the external channel to expire by TTL and cannot alter stored busy data.
      let freebusyStarted = () => {};
      let freebusyRelease = () => {};
      const freebusyStartedPromise = new Promise<void>((resolve) => { freebusyStarted = resolve; });
      const freebusyReleasePromise = new Promise<void>((resolve) => { freebusyRelease = resolve; });
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", expires_in: 3600 });
        if (url.includes("/events/watch")) {
          const body = JSON.parse(String(init?.body)) as { id: string; expiration: string };
          return Response.json({ id: body.id, resourceId: "unpersisted-google-channel", expiration: body.expiration });
        }
        freebusyStarted();
        await freebusyReleasePromise;
        return Response.json({ calendars: { "room-calendar": { busy: [] } } });
      });
      syncing = syncOneDueResourceGoogle(pool, worker);
      await freebusyStartedPromise;
      await pool.query("UPDATE channel_external_accounts SET active=false WHERE id='account-a'");
      freebusyRelease();
      expect(await syncing).toEqual({ processed: true, applied: false });
      expect((await pool.query("SELECT count(*)::int AS count FROM resource_google_watch_channels")).rows[0].count).toBe(0);
      expect(await syncOneDueResourceGoogle(pool, worker)).toEqual({ processed: false, applied: false });

      await pool.query("UPDATE channel_external_accounts SET active=true WHERE id='account-a'");
      await resetDue();
      await pool.query(
        `CREATE FUNCTION reject_resource_busy_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN IF NEW.payload->>'cause'='resource_google_busy_changed' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query("CREATE TRIGGER reject_resource_busy_outbox BEFORE INSERT ON calendar_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_resource_busy_outbox()");
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("oauth2.googleapis.com/token")
        ? Response.json({ access_token: "access", expires_in: 3600 })
        : Response.json({ calendars: { "room-calendar": { busy: [] } } }));
      expect(await syncOneDueResourceGoogle(pool, worker)).toEqual({ processed: true, applied: false });
      expect((await pool.query("SELECT sync_status FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-a'")).rows[0].sync_status).toBe("FAILED");
      expect((await pool.query("SELECT outcome FROM resource_google_sync_receipts ORDER BY created_at DESC LIMIT 1")).rows[0].outcome).toBe("FAILED");
      expect((await pool.query("SELECT payload->>'cause' AS cause FROM calendar_outbox_events ORDER BY id DESC LIMIT 1")).rows[0].cause).toBe("resource_google_sync_failed");
      expect((await pool.query("SELECT count(*)::int AS count FROM resource_google_busy_intervals WHERE start_at='2099-01-01T03:00:00Z'")).rows[0].count).toBe(1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });
});
