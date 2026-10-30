import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { ChannelRuntime } from "../src/channels.ts";
import { GoogleChannelDeliveryRepository } from "../src/google-channel-delivery.ts";
import { ExperienceStore } from "../src/repository.ts";
import { StoreConflictError, StoreValidationError } from "../src/errors.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("PostgreSQL Google channel delivery journal", { skip: databaseUrl === undefined }, () => {
  it("fences duplicate intents across lease epochs and keeps Google separate from Airbnb verification", async () => {
    const { Pool } = await import("pg");
    const schema = `google_delivery_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    let now = new Date("2099-01-01T00:00:00.000Z");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      await pool.query(`INSERT INTO experience_products
        (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
        VALUES ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`);
      const store = new ExperienceStore(pool);
      const rule: ScheduleRule = {
        id: "tea-am", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
        capacity: 1, bookingCutoffMinutes: 30, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule, null, command("1"));
      const runtime = new ChannelRuntime(pool, {
        now: () => now,
        supportedAdapters: { "Airbnb/airbnb-google-busy@1": { canOpen: true, canClose: true } },
      });
      const admin = { nihoUserId: "admin-a" };
      const account = await runtime.createExternalAccount(admin, {
        id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a",
        displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z",
      }, command("2"));
      const listing = await runtime.createListing(admin, {
        id: "listing-a", providerId: "provider-a", accountId: account.id, productId: "tea", externalProductId: "external-tea",
        adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE",
        capabilities: { canOpen: true, canClose: true }, active: true,
      }, command("3"));
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,$2,'provider-busy','booking-output')`,
        ["synthetic-ciphertext-".padEnd(48, "x"), ["https://www.googleapis.com/auth/calendar.app.created"]],
      );
      const generation = (await pool.query<{ connection_generation: string }>(
        "SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'",
      )).rows[0]!.connection_generation;
      await pool.query(
        `INSERT INTO google_channel_output_bindings
          (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id)
         VALUES ('provider-a','listing-a',$1,$2,'airbnb-output')`, [listing.mappingVersion, generation],
      );
      await runtime.reconcileListing(admin, listing.id, command("4"));
      const credential = await runtime.mintWorkerCredential(admin, "studio-1", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, command("5"));
      await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, command("6"));
      const worker = await runtime.authenticateWorker(credential.bearerToken);
      const claimed = await runtime.claim(worker); assert.ok(claimed);
      const repository = new GoogleChannelDeliveryRepository(pool, runtime);

      const concurrent = await Promise.all([
        repository.prepareDispatch(worker, claimed.id, claimed.leaseToken),
        repository.prepareDispatch(worker, claimed.id, claimed.leaseToken),
      ]);
      assert.equal(concurrent.filter((item) => item.canDispatch).length, 1);
      assert.equal(new Set(concurrent.map((item) => item.record.deliveryId)).size, 1);
      assert.equal(concurrent[0]!.record.phase, "DISPATCHING");
      assert.equal(concurrent[0]!.record.airbnb, "UNVERIFIED");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM google_channel_deliveries")).rows[0].count, 1);

      await assert.rejects(() => runtime.submitResult(worker, claimed.id, {
        resultId: command("7"), leaseToken: claimed.leaseToken, outcome: "VERIFIED", stopped: true, target: claimed.target,
        occurrenceId: claimed.occurrenceId, sourceStartAtUtc: claimed.sourceStartAtUtc, sourceEndAtUtc: claimed.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
      }), StoreValidationError);

      const googleVerified = await repository.saveResult(
        worker, claimed.id, claimed.leaseToken, concurrent[0]!.record.deliveryId,
        concurrent[0]!.operationNonce, "dispatch", {
          phase: "GOOGLE_VERIFIED", changed: false, writeAcknowledged: false,
          metadata: {
            eventId: "synthetic-event", etag: '"synthetic-etag"', bindingHash: "synthetic-binding",
            mappingVersion: claimed.mappingVersion, desiredVersion: claimed.desiredVersion,
            startAtUtc: claimed.sourceStartAtUtc, endAtUtc: claimed.sourceEndAtUtc,
            desiredState: claimed.action === "SET_OPEN" ? "OPEN" : "CLOSED",
            transparency: claimed.action === "SET_OPEN" ? "transparent" : "opaque",
          },
        },
      );
      assert.equal(googleVerified.phase, "GOOGLE_VERIFIED");

      await runtime.submitResult(worker, claimed.id, {
        resultId: command("8"), leaseToken: claimed.leaseToken, outcome: "RETRY_WAIT", stopped: true, target: claimed.target,
      });
      now = new Date(now.getTime() + 11_000);
      const reclaimed = await runtime.claim(worker); assert.ok(reclaimed);
      assert.equal(reclaimed.id, claimed.id);
      const repeated = await repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken);
      assert.equal(repeated.canDispatch, false);
      assert.equal(repeated.record.deliveryId, concurrent[0]!.record.deliveryId);

      assert.deepEqual(repeated.record, { deliveryId: repeated.record.deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
      const desired = await pool.query("SELECT observed_state,last_verified_at FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1", [reclaimed.occurrenceId]);
      assert.equal(desired.rows[0].observed_state, null);
      assert.equal(desired.rows[0].last_verified_at, null);

      await pool.query("INSERT INTO provider_google_calendars (provider_id,opaque_calendar_id) VALUES ('provider-a','airbnb-output')");
      await assert.rejects(
        () => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken),
        StoreConflictError,
      );
      await pool.query("DELETE FROM provider_google_calendars WHERE provider_id='provider-a'");

      await pool.query("UPDATE google_channel_output_bindings SET mapping_version=mapping_version+1 WHERE provider_id='provider-a' AND listing_id='listing-a'");
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken), StoreConflictError);
      await pool.query("UPDATE google_channel_output_bindings SET mapping_version=mapping_version-1 WHERE provider_id='provider-a' AND listing_id='listing-a'");

      await pool.query("UPDATE channel_desired_states SET desired_version=desired_version+1 WHERE listing_id='listing-a' AND occurrence_id=$1", [reclaimed.occurrenceId]);
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken), StoreConflictError);
      await pool.query("UPDATE channel_desired_states SET desired_version=desired_version-1 WHERE listing_id='listing-a' AND occurrence_id=$1", [reclaimed.occurrenceId]);

      await pool.query("UPDATE channel_desired_states SET source_start_at=source_start_at+interval '1 minute' WHERE listing_id='listing-a' AND occurrence_id=$1", [reclaimed.occurrenceId]);
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken), StoreConflictError);
      await pool.query("UPDATE channel_desired_states SET source_start_at=source_start_at-interval '1 minute' WHERE listing_id='listing-a' AND occurrence_id=$1", [reclaimed.occurrenceId]);

      await pool.query("UPDATE channel_jobs SET target_adapter='browser-v1',target_connection_mode='BROWSER' WHERE id=$1::uuid", [reclaimed.id]);
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken));
      await pool.query("UPDATE channel_jobs SET target_adapter='airbnb-google-busy',target_connection_mode='GOOGLE' WHERE id=$1::uuid", [reclaimed.id]);

      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken), StoreConflictError);
      await pool.query("UPDATE provider_memberships SET active=true WHERE provider_id='provider-a' AND niho_user_id='owner-a'");

      await pool.query("UPDATE channel_worker_accounts SET revoked_at=clock_timestamp() WHERE worker_id='studio-1' AND account_id='account-a'");
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken));
      await pool.query("UPDATE channel_worker_accounts SET revoked_at=NULL WHERE worker_id='studio-1' AND account_id='account-a'");

      now = new Date(now.getTime() + 200_000);
      await assert.rejects(() => repository.prepareDispatch(worker, reclaimed.id, reclaimed.leaseToken), StoreConflictError);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
