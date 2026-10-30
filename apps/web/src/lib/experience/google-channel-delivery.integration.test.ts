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
import { GOOGLE_SCOPES, initializeGoogleManagedBlock, type GoogleConfig } from "@niho-experience/google-calendar";

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

async function fixture(desiredState: "OPEN" | "CLOSED" = "CLOSED") {
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
  const now = new Date();
  let clockOffsetMs = 0;
  const occurrenceParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now.getTime() + 24 * 60 * 60 * 1_000));
  const occurrenceValues = Object.fromEntries(occurrenceParts.map((part) => [part.type, part.value]));
  const occurrenceDate = `${occurrenceValues.year}-${occurrenceValues.month}-${occurrenceValues.day}`;
  const authorityExpiresAtUtc = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  const rule: ScheduleRule = {
    id: "tea-once", timeZone: "Asia/Tokyo", startsOn: occurrenceDate, endsOn: occurrenceDate,
    localStartTime: "10:00", durationMinutes: 60, capacity: 1, bookingCutoffMinutes: 30,
    busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule, null, command(1));
  if (desiredState === "CLOSED") {
    await store.setOccurrenceSalesState(
      { providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule.id,
      { occurrenceId: `${rule.id}@${occurrenceDate}`, desiredState: "CLOSED" }, null, command(11),
    );
  }
  const runtime = new ChannelRuntime(pool, {
    now: () => new Date(Date.now() + clockOffsetMs),
    supportedAdapters: { "Airbnb/airbnb-google-busy@1": { canOpen: true, canClose: true, canObserve: true } },
    googleAirbnbObservationEnabled: true,
  });
  const admin = { nihoUserId: "admin-a" };
  const account = await runtime.createExternalAccount(admin, {
    id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a",
    displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: authorityExpiresAtUtc,
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
    admin, "studio-1", "Synthetic Studio", authorityExpiresAtUtc, null, command(5),
  );
  await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, command(6));
  const worker = await runtime.authenticateWorker(credential.bearerToken);
  const claimed = await runtime.claim(worker);
  if (!claimed) throw new Error("Synthetic Google delivery job was not claimable");
  return { schema, pool, runtime, admin, account, listing, worker, claimed, generation,
    setNow: (value: Date) => { clockOffsetMs = value.getTime() - Date.now(); } };
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
      accessToken: "synthetic-access", expiresAtUtc: new Date(Date.now() + 60 * 60_000).toISOString(), scopes: [...GOOGLE_SCOPES],
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
      const firstVerifiedAt = (await value.pool.query(
        "SELECT first_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [result.deliveryId],
      )).rows[0].first_verified_at;
      methods.length = 0;
      expect((await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "observe", injected(syntheticFetch),
      )).phase).toBe("GOOGLE_VERIFIED");
      expect(methods).toEqual(["GET"]);
      expect(writes).toBe(1);
      const refreshed = (await value.pool.query(
        "SELECT operation_kind,operation_verified_at,first_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [result.deliveryId],
      )).rows[0];
      expect(refreshed.operation_kind).toBe("OBSERVE");
      expect(refreshed.first_verified_at.toISOString()).toBe(firstVerifiedAt.toISOString());
      expect(refreshed.operation_verified_at.getTime()).toBeGreaterThanOrEqual(firstVerifiedAt.getTime());
    } finally {
      await cleanup(value);
    }
  });

  it.each(["OPEN", "CLOSED"] as const)("converges durable %s waits through the real Google helper without another write", async (desiredState) => {
    const value = await fixture(desiredState);
    const methods: string[] = [];
    let event: Record<string, unknown> | undefined;
    const google: GoogleConfig = {
      clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://experience.example.test/callback",
      fetch: async (_input, init = {}) => {
        const method = init.method ?? "GET";
        methods.push(method);
        if (method === "POST" || method === "PATCH") {
          const selected: Record<string, unknown> = { ...event, ...JSON.parse(String(init.body)), status: "confirmed", etag: `"etag-${method}"` };
          event = selected;
          return Response.json({ id: selected.id, etag: selected.etag });
        }
        return event ? Response.json(event) : new Response(null, { status: 404 });
      },
    };
    const opposite = desiredState === "OPEN" ? "CLOSED" : "OPEN";
    try {
      expect((await initializeGoogleManagedBlock(google, "synthetic-access", "airbnb-output", {
        providerOpaqueId: "provider-a", listingOpaqueId: value.listing.id,
        occurrenceOpaqueId: value.claimed.occurrenceId, mappingVersion: value.claimed.mappingVersion,
        desiredVersion: value.claimed.desiredVersion, sourceStartAtUtc: value.claimed.sourceStartAtUtc,
        sourceEndAtUtc: value.claimed.sourceEndAtUtc, desiredState: opposite,
      }, () => undefined)).code).toBe("GOOGLE_VERIFIED");
      methods.length = 0;
      const dispatched = await executeGoogleChannelDelivery(value.pool, value.runtime, value.worker,
        value.claimed.id, value.claimed.leaseToken, "dispatch", injected(google.fetch!));
      expect(dispatched.phase).toBe("GOOGLE_VERIFIED");
      expect(methods).toEqual(["GET", "PATCH", "GET"]);
      const proof = { deliveryId: dispatched.deliveryId, evidence: "EXACT_SLOT_V1" as const, partySize: 1 as const };
      expect(await value.runtime.submitResult(value.worker, value.claimed.id, {
        resultId: command(70), leaseToken: value.claimed.leaseToken, outcome: "RETRY_WAIT", stopped: true,
        target: value.claimed.target, occurrenceId: value.claimed.occurrenceId,
        sourceStartAtUtc: value.claimed.sourceStartAtUtc, sourceEndAtUtc: value.claimed.sourceEndAtUtc,
        observedState: opposite, observedBookable: opposite === "OPEN", observedAtUtc: new Date().toISOString(),
        googleAirbnbProof: proof,
      })).toEqual({ acceptedAsCurrent: false, repeated: false });
      const waiting = (await value.pool.query(
        "SELECT first_verified_at,deadline_at FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid", [dispatched.deliveryId],
      )).rows[0];
      await value.pool.query("UPDATE google_airbnb_propagation_waits SET next_due_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1::uuid",
        [dispatched.deliveryId]);
      expect(await value.runtime.enqueueDueGoogleAirbnbObservations(value.worker)).toEqual({ enqueued: 1 });
      const observedJob = await value.runtime.claim(value.worker);
      if (!observedJob) throw new Error("Synthetic propagation job was not claimed");
      expect(observedJob.googleDeliveryOperation).toBe("observe");
      methods.length = 0;
      const observed = await executeGoogleChannelDelivery(value.pool, value.runtime, value.worker,
        observedJob.id, observedJob.leaseToken, "observe", injected(google.fetch!));
      expect(observed.phase).toBe("GOOGLE_VERIFIED");
      expect(methods).toEqual(["GET"]);
      expect(await value.runtime.submitResult(value.worker, observedJob.id, {
        resultId: command(71), leaseToken: observedJob.leaseToken, outcome: "VERIFIED", stopped: true,
        target: observedJob.target, occurrenceId: observedJob.occurrenceId,
        sourceStartAtUtc: observedJob.sourceStartAtUtc, sourceEndAtUtc: observedJob.sourceEndAtUtc,
        observedState: desiredState, observedBookable: desiredState === "OPEN", observedAtUtc: new Date().toISOString(),
        googleAirbnbProof: proof,
      })).toEqual({ acceptedAsCurrent: true, repeated: false });
      const matched = (await value.pool.query(
        "SELECT status,pending_job_id,first_verified_at,deadline_at FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid", [dispatched.deliveryId],
      )).rows[0];
      expect(matched.status).toBe("MATCHED");
      expect(matched.pending_job_id).toBeNull();
      expect(matched.first_verified_at.toISOString()).toBe(waiting.first_verified_at.toISOString());
      expect(matched.deadline_at.toISOString()).toBe(waiting.deadline_at.toISOString());
    } finally { await cleanup(value); }
  });

  it.each(["OPEN", "CLOSED"] as const)("refreshes %s proof by GET in a new lease before accepting the typed receipt", async (desiredState) => {
    const value = await fixture(desiredState);
    const methods: string[] = [];
    let event: Record<string, unknown> | undefined;
    const google: GoogleConfig = {
      clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://experience.example.test/callback",
      fetch: async (_input, init = {}) => {
        const method = init.method ?? "GET";
        methods.push(method);
        if (method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          event = { ...body, status: "confirmed", etag: '"etag-current"' };
          return Response.json({ id: body.id, etag: '"etag-ack"' });
        }
        return event ? Response.json(event) : new Response(null, { status: 404 });
      },
    };
    const target = {
      providerOpaqueId: "provider-a", listingOpaqueId: value.listing.id,
      occurrenceOpaqueId: value.claimed.occurrenceId, mappingVersion: value.claimed.mappingVersion,
      desiredVersion: value.claimed.desiredVersion, sourceStartAtUtc: value.claimed.sourceStartAtUtc,
      sourceEndAtUtc: value.claimed.sourceEndAtUtc, desiredState,
    } as const;
    try {
      expect((await initializeGoogleManagedBlock(google, "synthetic-access", "airbnb-output", target, () => undefined)).code)
        .toBe("GOOGLE_VERIFIED");
      methods.length = 0;
      const dispatch = await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, value.claimed.id, value.claimed.leaseToken, "dispatch",
        injected(google.fetch!),
      );
      expect(dispatch.phase).toBe("GOOGLE_VERIFIED");
      expect(methods).toEqual(["GET"]);
      const firstVerifiedAt = (await value.pool.query(
        "SELECT first_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [dispatch.deliveryId],
      )).rows[0].first_verified_at;

      await value.runtime.submitResult(value.worker, value.claimed.id, {
        resultId: command(desiredState === "OPEN" ? 41 : 42), leaseToken: value.claimed.leaseToken,
        outcome: "RETRY_WAIT", stopped: true, target: value.claimed.target,
      });
      value.setNow(new Date());
      await value.pool.query(
        "UPDATE channel_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
        [value.claimed.id],
      );
      value.setNow(new Date());
      const released = await value.runtime.claim(value.worker);
      expect(released?.id).toBe(value.claimed.id);
      if (!released) throw new Error("Synthetic SET job was not re-leased");
      const releasedAuthority = (await value.pool.query(
        "SELECT lease_epoch,lease_started_at FROM channel_jobs WHERE id=$1::uuid", [released.id],
      )).rows[0];

      await value.pool.query(
        "UPDATE google_channel_deliveries SET updated_at=clock_timestamp()+interval '1 day' WHERE id=$1::uuid",
        [dispatch.deliveryId],
      );
      const receipt = (resultId: string) => ({
        resultId, leaseToken: released.leaseToken, outcome: "VERIFIED" as const, stopped: true, target: released.target,
        occurrenceId: released.occurrenceId, sourceStartAtUtc: released.sourceStartAtUtc, sourceEndAtUtc: released.sourceEndAtUtc,
        observedState: desiredState, observedBookable: desiredState === "OPEN", observedAtUtc: new Date().toISOString(),
        googleAirbnbProof: { deliveryId: dispatch.deliveryId, evidence: "EXACT_SLOT_V1" as const, partySize: 1 as const },
      });
      await expect(value.runtime.submitResult(
        value.worker, released.id, receipt(command(desiredState === "OPEN" ? 43 : 44)),
      )).rejects.toBeInstanceOf(StoreConflictError);
      const preparedOnly = await new GoogleChannelDeliveryRepository(value.pool, value.runtime)
        .prepareObservation(value.worker, released.id, released.leaseToken);
      expect(preparedOnly).toMatchObject({
        targetAuthority: "CURRENT_JOB", operation: "observe", canDispatch: false,
        storedTarget: { desiredState, desiredVersion: released.desiredVersion },
      });
      expect((await value.pool.query(
        "SELECT operation_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [dispatch.deliveryId],
      )).rows[0].operation_verified_at).toBeNull();
      await expect(value.runtime.submitResult(
        value.worker, released.id, receipt(command(desiredState === "OPEN" ? 49 : 50)),
      )).rejects.toBeInstanceOf(StoreConflictError);

      if (desiredState === "CLOSED") {
        const readCases = [
          { phase: "NOT_MATCHED", fetch: (async () => new Response(null, { status: 404 })) as typeof fetch },
          { phase: "NOT_MATCHED", fetch: (async () => Response.json({ ...event, visibility: "public" })) as typeof fetch },
          { phase: "STOPPED", fetch: (async () => { throw new Error("synthetic timeout"); }) as typeof fetch },
        ] as const;
        for (const readCase of readCases) {
          const readMethods: string[] = [];
          const readOnlyFetch: typeof fetch = async (input, init = {}) => {
            readMethods.push(init.method ?? "GET");
            return readCase.fetch(input, init);
          };
          const failedRead = await executeGoogleChannelDelivery(
            value.pool, value.runtime, value.worker, released.id, released.leaseToken, "observe", injected(readOnlyFetch),
          );
          expect(failedRead.phase).toBe(readCase.phase);
          expect(readMethods).toEqual(["GET"]);
        }
      }

      methods.length = 0;
      let releaseStalled: (() => void) | undefined;
      let stalledStarted: Promise<void> | undefined;
      let staleObservation: Promise<unknown> | undefined;
      if (desiredState === "CLOSED") {
        let markStarted: (() => void) | undefined;
        stalledStarted = new Promise<void>((resolve) => { markStarted = resolve; });
        const stalled = new Promise<void>((resolve) => { releaseStalled = resolve; });
        const stalledFetch: typeof fetch = async (...args) => {
          markStarted?.();
          await stalled;
          return google.fetch!(...args);
        };
        staleObservation = executeGoogleChannelDelivery(
          value.pool, value.runtime, value.worker, released.id, released.leaseToken, "observe", injected(stalledFetch),
        );
        await stalledStarted;
      }
      const observed = await executeGoogleChannelDelivery(
        value.pool, value.runtime, value.worker, released.id, released.leaseToken, "observe", injected(google.fetch!),
      );
      releaseStalled?.();
      if (staleObservation) await expect(staleObservation).rejects.toBeInstanceOf(StoreConflictError);
      expect(observed).toMatchObject({ phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
      expect(methods).toEqual(desiredState === "CLOSED" ? ["GET", "GET"] : ["GET"]);
      const proof = (await value.pool.query(
        `SELECT first_verified_at,operation_verified_at,operation_kind,operation_job_id,operation_lease_epoch,
                changed,write_acknowledged
           FROM google_channel_deliveries WHERE id=$1::uuid`, [dispatch.deliveryId],
      )).rows[0];
      expect(proof.operation_kind).toBe("OBSERVE");
      expect(proof.operation_job_id).toBe(released.id);
      expect(Number(proof.operation_lease_epoch)).toBe(Number(releasedAuthority.lease_epoch));
      expect(new Date(proof.first_verified_at).toISOString()).toBe(new Date(firstVerifiedAt).toISOString());
      expect(new Date(proof.operation_verified_at).getTime()).toBeGreaterThanOrEqual(new Date(releasedAuthority.lease_started_at).getTime());
      expect(proof).toMatchObject({ changed: false, write_acknowledged: false });

      await expect(value.runtime.submitResult(value.worker, released.id, {
        ...receipt(command(desiredState === "OPEN" ? 47 : 48)),
        observedAtUtc: new Date(new Date(proof.operation_verified_at).getTime() - 1).toISOString(),
      })).rejects.toBeInstanceOf(StoreConflictError);
      const acceptedInput = receipt(command(desiredState === "OPEN" ? 45 : 46));
      acceptedInput.observedAtUtc = new Date().toISOString();
      expect(await value.runtime.submitResult(value.worker, released.id, acceptedInput)).toEqual({
        acceptedAsCurrent: true, repeated: false,
      });
      expect(await value.runtime.submitResult(value.worker, released.id, acceptedInput)).toEqual({
        acceptedAsCurrent: true, repeated: true,
      });
      await expect(value.runtime.submitResult(value.worker, released.id, {
        ...acceptedInput, googleAirbnbProof: { ...acceptedInput.googleAirbnbProof, deliveryId: command(99) },
      })).rejects.toBeInstanceOf(StoreConflictError);
      if (desiredState === "CLOSED") {
        const futureObserveJobId = command(90);
        const beforeVersion = (await value.pool.query(
          "SELECT desired_version FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
          [released.occurrenceId],
        )).rows[0].desired_version;
        await value.pool.query(
          `INSERT INTO channel_jobs
            (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
             target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
             target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,priority,next_attempt_at,job_deadline_at)
           SELECT $2::uuid,provider_id,account_id,listing_id,occurrence_id,'OBSERVE',account_version,desired_version,mapping_version,
             target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
             target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,95,
             clock_timestamp()-interval '1 second',clock_timestamp()+interval '10 minutes'
             FROM channel_jobs WHERE id=$1::uuid`,
          [released.id, futureObserveJobId],
        );
        value.setNow(new Date());
        const futureObserve = await value.runtime.claim(value.worker);
        expect(futureObserve?.id).toBe(futureObserveJobId);
        if (!futureObserve) throw new Error("Synthetic future OBSERVE job was not claimable");
        methods.length = 0;
        expect((await executeGoogleChannelDelivery(
          value.pool, value.runtime, value.worker, futureObserve.id, futureObserve.leaseToken, "observe", injected(google.fetch!),
        )).phase).toBe("GOOGLE_VERIFIED");
        expect(methods).toEqual(["GET"]);
        const futureInput = {
          resultId: command(91), leaseToken: futureObserve.leaseToken, outcome: "VERIFIED" as const, stopped: true,
          target: futureObserve.target, occurrenceId: futureObserve.occurrenceId,
          sourceStartAtUtc: futureObserve.sourceStartAtUtc, sourceEndAtUtc: futureObserve.sourceEndAtUtc,
          observedState: "CLOSED" as const, observedBookable: false, observedAtUtc: new Date().toISOString(),
          googleAirbnbProof: { deliveryId: dispatch.deliveryId, evidence: "EXACT_SLOT_V1" as const, partySize: 1 as const },
        };
        await value.pool.query("UPDATE channel_external_accounts SET quarantined_at=clock_timestamp(),quarantine_reason='MANUAL_HANDLING' WHERE id='account-a'");
        methods.length = 0;
        await expect(executeGoogleChannelDelivery(
          value.pool, value.runtime, value.worker, futureObserve.id, futureObserve.leaseToken, "observe", injected(google.fetch!),
        )).rejects.toBeInstanceOf(StoreConflictError);
        expect(methods).toEqual([]);
        await expect(value.runtime.submitResult(value.worker, futureObserve.id, futureInput)).rejects.toBeInstanceOf(StoreConflictError);
        expect((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results WHERE result_id=$1::uuid", [futureInput.resultId])).rows[0].count).toBe(0);
        // Restore only this synthetic account, then establish a new proof rather
        // than reusing the observation collected before the manual hold.
        await value.pool.query("UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL WHERE id='account-a'");
        await executeGoogleChannelDelivery(
          value.pool, value.runtime, value.worker, futureObserve.id, futureObserve.leaseToken, "observe", injected(google.fetch!),
        );
        expect(methods).toEqual(["GET"]);
        futureInput.observedAtUtc = new Date().toISOString();
        expect(await value.runtime.submitResult(value.worker, futureObserve.id, futureInput)).toEqual({
          acceptedAsCurrent: true, repeated: false,
        });
        const afterVersion = (await value.pool.query(
          "SELECT desired_version FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
          [futureObserve.occurrenceId],
        )).rows[0].desired_version;
        expect(Number(afterVersion)).toBe(Number(beforeVersion));
      }
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
      await value.pool.query("UPDATE channel_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
        [recovery.observeJobId]);
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
