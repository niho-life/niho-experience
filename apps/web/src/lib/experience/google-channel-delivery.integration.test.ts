import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import {
  ChannelRuntime,
  ExperienceStore,
  GoogleChannelDeliveryRepository,
  ResourceGoogleRepository,
  StoreConflictError,
} from "@niho-experience/experience-store";
import { GOOGLE_SCOPES, type GoogleConfig } from "@niho-experience/google-calendar";

vi.mock("server-only", () => ({}));

import { saveGoogleConnection } from "./google-connection";
import { executeGoogleChannelDelivery } from "./google-channel-delivery";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const originalGoogleClientId = process.env.EXPERIENCE_GOOGLE_CLIENT_ID;
const originalGoogleClientSecret = process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET;
const originalGoogleTokenKey = process.env.EXPERIENCE_GOOGLE_TOKEN_KEY;

beforeAll(() => {
  process.env.EXPERIENCE_GOOGLE_CLIENT_ID = "synthetic-client";
  process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET = "synthetic-secret";
  process.env.EXPERIENCE_GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterAll(() => {
  if (originalGoogleClientId === undefined) delete process.env.EXPERIENCE_GOOGLE_CLIENT_ID;
  else process.env.EXPERIENCE_GOOGLE_CLIENT_ID = originalGoogleClientId;
  if (originalGoogleClientSecret === undefined) delete process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET;
  else process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
  if (originalGoogleTokenKey === undefined) delete process.env.EXPERIENCE_GOOGLE_TOKEN_KEY;
  else process.env.EXPERIENCE_GOOGLE_TOKEN_KEY = originalGoogleTokenKey;
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const { Pool } = await import("pg");
  const schema = `web_google_delivery_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
  for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
  await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
  await pool.query(`INSERT INTO experience_products
    (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
    VALUES ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`);
  const store = new ExperienceStore(pool);
  const rule: ScheduleRule = {
    id: "tea-once", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-01",
    localStartTime: "10:00", durationMinutes: 60, capacity: 1, bookingCutoffMinutes: 30,
    busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule, null, command(1));
  await store.setOccurrenceSalesState(
    { providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule.id,
    { occurrenceId: `${rule.id}@2099-01-01`, desiredState: "CLOSED" }, null, command(11),
  );
  const now = new Date("2099-01-01T00:00:00.000Z");
  const runtime = new ChannelRuntime(pool, {
    now: () => now,
    supportedAdapters: { "Airbnb/airbnb-google-busy@1": { canOpen: true, canClose: true, canObserve: true } },
  });
  const admin = { nihoUserId: "admin-a" };
  const account = await runtime.createExternalAccount(admin, {
    id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a",
    displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z",
  }, command(2));
  const listing = await runtime.createListing(admin, {
    id: "listing-a", providerId: "provider-a", accountId: account.id, productId: "tea", externalProductId: "external-tea",
    adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE",
    capabilities: { canOpen: true, canClose: true, canObserve: true }, active: true,
  }, command(3));
  await pool.query(
    `INSERT INTO provider_google_connections
      (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
     VALUES ('provider-a','owner-a',$1,$2,'provider-busy','booking-output')`,
    ["synthetic-ciphertext-".padEnd(48, "x"), [...GOOGLE_SCOPES]],
  );
  const generation = Number((await pool.query(
    "SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'",
  )).rows[0].connection_generation);
  await pool.query(
    `INSERT INTO google_channel_output_bindings
      (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id)
     VALUES ('provider-a','listing-a',$1,$2,'airbnb-output')`, [listing.mappingVersion, generation],
  );
  await runtime.reconcileListing(admin, listing.id, command(4));
  const credential = await runtime.mintWorkerCredential(
    admin, "studio-1", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, command(5),
  );
  await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, command(6));
  const worker = await runtime.authenticateWorker(credential.bearerToken);
  const claimed = await runtime.claim(worker);
  if (!claimed) throw new Error("Synthetic Google delivery job was not claimable");
  return { schema, pool, runtime, admin, account, listing, worker, claimed, generation };
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
    runtimeConfig: () => ({ google, key: Buffer.alloc(32) }),
    openRefreshToken: () => "synthetic-refresh",
    sealRefreshToken: () => "synthetic-rotated".padEnd(48, "x"),
    refreshToken: async () => ({
      accessToken: "synthetic-access", expiresAtUtc: "2099-01-01T01:00:00.000Z", scopes: [...GOOGLE_SCOPES],
    }),
  };
}

describe.skipIf(!databaseUrl)("Google delivery runtime/repository/helper integration", () => {
  it.each(["publication", "capability"] as const)("fences %s changes between preflight and the journal transaction", async (kind) => {
    const value = await fixture();
    let requests = 0;
    const originalContext = value.runtime.googleDeliveryContext.bind(value.runtime);
    const contextSpy = vi.spyOn(value.runtime, "googleDeliveryContext").mockImplementationOnce(async (...args) => {
      const context = await originalContext(...args);
      if (kind === "publication") {
        await value.pool.query("UPDATE experience_products SET status='DRAFT' WHERE provider_id='provider-a' AND id='tea'");
      } else {
        await value.pool.query("UPDATE channel_listings SET can_close=false WHERE id='listing-a'");
      }
      return context;
    });
    try {
      await expect(executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch",
        injected(async () => { requests += 1; return new Response(null, { status: 404 }); }),
      )).rejects.toBeInstanceOf(StoreConflictError);
      expect(requests).toBe(0);
      expect((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_deliveries")).rows[0].count).toBe(0);
    } finally {
      contextSpy.mockRestore();
      await cleanup(value);
    }
  });

  it("dispatches through the real helper once and stores Google VERIFIED without Airbnb verification", async () => {
    const value = await fixture();
    const methods: string[] = [];
    let writes = 0;
    let storedEvent: Record<string, unknown> | undefined;
    const syntheticFetch: typeof fetch = async (_input, init = {}) => {
      const method = init.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        writes += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        storedEvent = { ...body, status: "confirmed", etag: '"etag-written"' };
        return Response.json({ id: body.id, etag: '"etag-ack"' });
      }
      return storedEvent ? Response.json(storedEvent) : new Response(null, { status: 404 });
    };
    try {
      const result = await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(syntheticFetch),
      );
      expect(result).toMatchObject({ phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
      expect(methods).toEqual(["GET", "POST", "GET"]);
      expect(writes).toBe(1);
      const persisted = (await value.pool.query(
        "SELECT phase,event_etag,google_desired_version,write_acknowledged FROM google_channel_deliveries WHERE id=$1::uuid",
        [result.deliveryId],
      )).rows[0];
      expect(persisted).toMatchObject({
        phase: "GOOGLE_VERIFIED", event_etag: '"etag-written"', write_acknowledged: true,
      });
      expect(Number(persisted.google_desired_version)).toBe(value.claimed.desiredVersion);
      expect(await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(syntheticFetch),
      )).toEqual(result);
      expect(writes).toBe(1);
    } finally {
      await cleanup(value);
    }
  });

  it("writes once, fences a duplicate after lost ACK, and GET-only reconciles from a stop-confirmed OBSERVE lease", async () => {
    const value = await fixture();
    const methods: string[] = [];
    let writes = 0;
    let failReadback = true;
    let storedEvent: Record<string, unknown> | undefined;
    const syntheticFetch: typeof fetch = async (_input, init = {}) => {
      const method = init.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        writes += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        storedEvent = { ...body, status: "confirmed", etag: '"etag-after-lost-ack"' };
        return new Response(null, { status: 500 });
      }
      if (!storedEvent) return new Response(null, { status: 404 });
      if (failReadback) {
        failReadback = false;
        return new Response(null, { status: 503 });
      }
      return Response.json(storedEvent);
    };
    try {
      const first = await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(syntheticFetch),
      );
      expect(first).toMatchObject({ phase: "UNCERTAIN", reason: "WRITE_UNCERTAIN", airbnb: "UNVERIFIED" });
      expect(writes).toBe(1);
      const requestsAfterFirst = methods.length;
      expect(await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(syntheticFetch),
      )).toEqual(first);
      expect(methods).toHaveLength(requestsAfterFirst);
      await expect(executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "reconcile", injected(syntheticFetch),
      )).rejects.toBeTruthy();

      const oldOperation = (await value.pool.query(
        "SELECT id,operation_nonce FROM google_channel_deliveries WHERE id=$1::uuid", [first.deliveryId],
      )).rows[0];
      const recovery = await value.runtime.recoverQuarantinedLease(value.admin, value.account.id, true, command(7));
      const observe = await value.runtime.claim(value.worker);
      expect(observe?.id).toBe(recovery.observeJobId);
      expect(observe?.action).toBe("OBSERVE");
      if (!observe) throw new Error("Synthetic recovery OBSERVE job was not claimable");

      const repository = new GoogleChannelDeliveryRepository(value.pool, value.runtime);
      const reconcile = await repository.prepareReconcile(value.worker, observe.id, observe.leaseToken);
      expect(reconcile).toMatchObject({
        targetAuthority: "STORED_JOURNAL_ONLY", operation: "reconcile",
        context: { action: "OBSERVE", jobId: observe.id },
        storedTarget: { action: value.claimed.action, desiredVersion: value.claimed.desiredVersion },
      });
      if (!reconcile) throw new Error("Synthetic journal was not reconcilable");

      const secondCredential = await value.runtime.mintWorkerCredential(
        value.admin, "studio-2", "Synthetic Studio 2", "2099-02-01T00:00:00.000Z", null, command(8),
      );
      await value.runtime.assignWorkerAccount(value.admin, secondCredential.workerId, value.account.id, null, command(9));
      const secondWorker = await value.runtime.authenticateWorker(secondCredential.bearerToken);
      await expect(repository.saveResult(
        secondWorker, observe.id, observe.leaseToken, first.deliveryId, reconcile.operationNonce, "reconcile",
        { phase: "NOT_MATCHED", reason: "ANCHOR_MISSING" },
      )).rejects.toBeTruthy();
      await expect(repository.saveResult(
        value.worker, value.claimed.id, value.claimed.leaseToken, first.deliveryId, String(oldOperation.operation_nonce), "dispatch",
        { phase: "GOOGLE_VERIFIED" },
      )).rejects.toBeTruthy();

      const beforeReconcile = methods.length;
      for (const failedDependencies of [
        { ...injected(syntheticFetch), runtimeConfig: () => null },
        { ...injected(syntheticFetch), refreshToken: async () => { throw new Error("synthetic transient token failure"); } },
      ]) {
        const pending = await executeGoogleChannelDelivery(
          value.pool, value.runtime, value.worker, observe.id, observe.leaseToken, "reconcile", failedDependencies,
        );
        expect(pending.phase).toBe("UNCERTAIN");
        expect((await value.pool.query("SELECT phase FROM google_channel_deliveries WHERE id=$1::uuid", [first.deliveryId])).rows[0].phase).toBe("UNCERTAIN");
        expect(methods).toHaveLength(beforeReconcile);
      }
      const resolved = await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, observe.id, observe.leaseToken, "reconcile", injected(syntheticFetch),
      );
      expect(resolved).toMatchObject({ phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
      expect(methods.slice(beforeReconcile)).toEqual(["GET"]);
      expect(writes).toBe(1);
      const desired = (await value.pool.query(
        "SELECT observed_state,last_verified_at FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
        [value.claimed.occurrenceId],
      )).rows[0];
      expect(desired).toMatchObject({ observed_state: null, last_verified_at: null });
    } finally {
      await cleanup(value);
    }
  });

  it("blocks a different unresolved intent and rejects cross-provider output reuse", async () => {
    const value = await fixture();
    let requests = 0;
    const noIoFetch: typeof fetch = async () => { requests += 1; return new Response(null, { status: 404 }); };
    try {
      await value.pool.query(
        `INSERT INTO google_channel_deliveries
          (id,intent_fingerprint,job_id,provider_id,account_id,listing_id,occurrence_id,action,desired_state,desired_version,
           mapping_version,source_start_at,source_end_at,worker_id,lease_epoch,assignment_version,account_version,
           binding_version,connection_generation,binding_calendar_digest,granted_scopes_digest,operation_nonce,operation_kind,operation_job_id,
           operation_worker_id,operation_lease_epoch,operation_assignment_version,phase,reason)
         SELECT $1::uuid,$2,j.id,j.provider_id,j.account_id,j.listing_id,j.occurrence_id,j.action,d.desired_state,j.desired_version+1,
           j.mapping_version,j.source_start_at,j.source_end_at,j.leased_worker_id,j.lease_epoch,j.lease_assignment_version,j.account_version,
           b.binding_version,b.connection_generation,$5,$6,$3::uuid,'DISPATCH',j.id,
           j.leased_worker_id,j.lease_epoch,j.lease_assignment_version,'UNCERTAIN','WRITE_UNCERTAIN'
          FROM channel_jobs j JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
          JOIN google_channel_output_bindings b ON b.provider_id=j.provider_id AND b.listing_id=j.listing_id
         WHERE j.id=$4::uuid`,
        [randomUUID(), "a".repeat(64), randomUUID(), value.claimed.id,
          createHash("sha256").update("airbnb-output").digest("hex"),
          createHash("sha256").update(JSON.stringify([...GOOGLE_SCOPES].sort())).digest("hex")],
      );
      await expect(executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(noIoFetch),
      )).rejects.toBeInstanceOf(StoreConflictError);
      expect(requests).toBe(0);
      await value.pool.query("DELETE FROM google_channel_deliveries");

      await value.pool.query("INSERT INTO experience_providers (id) VALUES ('provider-b')");
      await value.pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-b','owner-b','OWNER')");
      await expect(saveGoogleConnection(value.pool, {
        providerId: "provider-b", nihoUserId: "owner-b", calendarRoleCeiling: "OWNER",
      }, {
        accessToken: "synthetic", expiresAtUtc: "2099-01-01T01:00:00.000Z", refreshToken: "synthetic-refresh", scopes: [...GOOGLE_SCOPES],
      }, "airbnb-output", "provider-b-booking")).rejects.toBeInstanceOf(StoreConflictError);

      await value.pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-b','owner-b',$1,$2,'provider-b-busy','provider-b-booking')`, ["b".repeat(48), [...GOOGLE_SCOPES]],
      );
      await value.pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-b','room-b','VENUE','Room B')");
      const generation = Number((await value.pool.query(
        "SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-b'",
      )).rows[0].connection_generation);
      const resources = new ResourceGoogleRepository(value.pool);
      const actor = { providerId: "provider-b", nihoUserId: "owner-b", calendarRoleCeiling: "OWNER" as const };
      await resources.replaceCalendarInventory(actor, {
        connectionGeneration: generation, fetchedAtUtc: new Date().toISOString(),
        calendars: [{ id: "airbnb-output", name: "Must be excluded", primary: false }],
      });
      expect((await resources.ownerSnapshot(actor)).calendars).toEqual([]);
      await value.pool.query(
        `INSERT INTO provider_google_calendar_inventory
          (provider_id,connection_generation,opaque_calendar_id,display_name,is_primary,fetched_at)
         VALUES ('provider-b',$1,'airbnb-output','Synthetic collision',false,clock_timestamp())`, [generation],
      );
      await expect(resources.save(actor, {
        resourceId: "room-b", calendarId: "airbnb-output", enabled: true,
      }, null, command(10))).rejects.toBeInstanceOf(StoreConflictError);

      await value.pool.query(
        "UPDATE provider_google_connections SET booking_calendar_id='airbnb-output' WHERE provider_id='provider-b'",
      );
      await expect(executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(noIoFetch),
      )).rejects.toBeInstanceOf(StoreConflictError);
      expect(requests).toBe(0);
    } finally {
      await cleanup(value);
    }
  });

  it.each(["binding", "desired", "scope"] as const)("does not return current success after mid-I/O %s invalidation", async (kind) => {
    const value = await fixture();
    let requests = 0;
    let writes = 0;
    const invalidatingFetch: typeof fetch = async (_input, init = {}) => {
      requests += 1;
      if ((init.method ?? "GET") !== "GET") {
        writes += 1;
        return Response.json({ id: "must-not-write", etag: '"must-not-write"' });
      }
      if (kind === "binding") {
        await value.pool.query(
          "UPDATE google_channel_output_bindings SET opaque_calendar_id='changed-output',binding_version=binding_version+1 WHERE provider_id='provider-a' AND listing_id='listing-a'",
        );
      } else if (kind === "desired") {
        await value.pool.query(
          "UPDATE channel_desired_states SET desired_version=desired_version+1 WHERE listing_id='listing-a' AND occurrence_id=$1",
          [value.claimed.occurrenceId],
        );
      } else {
        await value.pool.query(
          "UPDATE provider_google_connections SET granted_scopes=ARRAY['synthetic-revoked-scope'] WHERE provider_id='provider-a'",
        );
      }
      return new Response(null, { status: 404 });
    };
    try {
      await expect(executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch", injected(invalidatingFetch),
      )).rejects.toBeInstanceOf(StoreConflictError);
      expect(requests).toBe(1);
      expect(writes).toBe(0);
      expect((await value.pool.query("SELECT phase FROM google_channel_deliveries")).rows[0].phase).toBe("DISPATCHING");
    } finally {
      await cleanup(value);
    }
  });
});
