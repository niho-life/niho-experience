import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ChannelRuntime } from "../src/channels.ts";
import { ExperienceStore } from "../src/repository.ts";
import { enqueueCalendarRecalculation } from "../src/inventory-outbox.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("PostgreSQL channel runtime", { skip: databaseUrl === undefined }, () => {
  it("scopes registry writes and keeps claims, preflight, results, outbox, and expiry fail-closed", async () => {
    const { Pool } = await import("pg");
    const schema = `channel_runtime_test_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    let now = new Date("2099-01-01T00:00:00.000Z");
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of names) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER'),('provider-b','owner-b','OWNER')");
      for (const providerId of ["provider-a", "provider-b"]) {
        await pool.query(
          `INSERT INTO experience_products
            (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,'tea',$2,'PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
          [providerId, `tea-${providerId}`],
        );
      }
      const store = new ExperienceStore(pool);
      const rule: ScheduleRule = {
        id: "tea-am", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
        capacity: 1, bookingCutoffMinutes: 30, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule, null, command("1"));
      const runtime = new ChannelRuntime(pool, {
        now: () => now,
        supportedAdapters: { "Airbnb/browser-v1@1": { canObserve: true, canClose: true, canOpen: true } },
      });
      const admin = { nihoUserId: "admin-a" };
      const account = await runtime.createExternalAccount(admin, {
        id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a", displayName: "Synthetic account",
        operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z", privateProfileRef: "profile-ref-synthetic",
      }, command("2"));
      assert.equal("privateProfileRef" in account, false);
      await assert.rejects(() => runtime.createExternalAccount(admin, {
        id: "account-b", providerId: "provider-b", site: "Airbnb", externalAccountId: "external-a", displayName: "Other tenant",
        operatingModel: 1,
      }, command("3")));
      let listing = await runtime.createListing(admin, {
        id: "listing-a", providerId: "provider-a", accountId: "account-a", productId: "tea", externalProductId: "external-tea",
        externalOptionId: "morning", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
      }, command("4"));
      const movedAccount = await runtime.updateExternalAccount(admin, account.id, {
        site: account.site, externalAccountId: "external-a-moved", displayName: account.displayName,
        operatingModel: account.operatingModel, active: account.active,
        ...(account.delegatedUntilUtc === undefined ? {} : { delegatedUntilUtc: account.delegatedUntilUtc }),
      }, account.version, command("40"));
      assert.equal(movedAccount.externalAccountId, "external-a-moved");
      assert.equal("privateProfileRef" in movedAccount, false);
      assert.equal((await pool.query("SELECT private_profile_ref FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.private_profile_ref, "profile-ref-synthetic");
      const unverifiedListing = (await runtime.listListings(admin, "provider-a"))[0]!;
      assert.equal(unverifiedListing.active, false);
      assert.deepEqual(unverifiedListing.capabilities, { canObserve: false, canReadReservations: false, canClose: false, canOpen: false, canCreate: false });
      listing = await runtime.updateListing(admin, unverifiedListing.id, {
        externalProductId: unverifiedListing.externalProductId,
        ...(unverifiedListing.externalOptionId === undefined ? {} : { externalOptionId: unverifiedListing.externalOptionId }),
        adapter: unverifiedListing.adapter, adapterVersion: unverifiedListing.adapterVersion,
        connectionMode: unverifiedListing.connectionMode,
        capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
      }, unverifiedListing.mappingVersion, command("41"));
      await assert.rejects(() => runtime.createListing(admin, {
        id: "cross-tenant", providerId: "provider-b", accountId: "account-a", productId: "tea", externalProductId: "bad",
        adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
      }, command("5")), StoreNotFoundError);
      await assert.rejects(() => runtime.createListing(admin, {
        id: "duplicate", providerId: "provider-a", accountId: "account-a", productId: "tea", externalProductId: "external-tea",
        externalOptionId: "morning", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
      }, command("6")));
      await assert.rejects(() => runtime.updateListing(admin, listing.id, {
        externalProductId: listing.externalProductId, ...(listing.externalOptionId === undefined ? {} : { externalOptionId: listing.externalOptionId }), adapter: listing.adapter,
        adapterVersion: listing.adapterVersion, connectionMode: listing.connectionMode, capabilities: listing.capabilities, active: true,
      }, 999, command("7")), StoreConflictError);

      const reconciled = await runtime.reconcileListing(admin, listing.id, command("8"));
      assert.equal(reconciled.occurrences, 56);
      assert.equal(reconciled.jobs, 56);
      assert.equal((await runtime.reconcileListing(admin, listing.id, command("9"))).jobs, 0);
      const outbox = await Promise.all([runtime.consumeCalendarOutbox(), runtime.consumeCalendarOutbox()]);
      assert.equal(outbox.reduce((sum, item) => sum + item.events, 0), 1);
      assert.equal(outbox.reduce((sum, item) => sum + item.jobs, 0), 0);
      assert.equal((await runtime.consumeCalendarOutbox()).events, 0);

      const credential = await runtime.mintWorkerCredential(admin, "studio-1", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, command("10"));
      await assert.rejects(() => runtime.authenticateWorker(`${credential.bearerToken}wrong`), StoreAccessDeniedError);
      const worker = await runtime.authenticateWorker(credential.bearerToken);
      assert.equal(await runtime.claim(worker), null);
      await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, command("11"));
      const claims = await Promise.all([runtime.claim(worker), runtime.claim(worker)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claimed = claims.find((item) => item !== null)!;
      assert.equal((await runtime.preflight(worker, claimed.id, claimed.leaseToken)).ready, true);
      const renewals = await Promise.all([
        runtime.renew(worker, claimed.id, claimed.leaseToken),
        runtime.renew(worker, claimed.id, claimed.leaseToken),
        runtime.preflight(worker, claimed.id, claimed.leaseToken),
      ]);
      assert.equal(renewals.length, 3);
      const remapped = await runtime.updateListing(admin, listing.id, {
        externalProductId: listing.externalProductId, ...(listing.externalOptionId === undefined ? {} : { externalOptionId: listing.externalOptionId }),
        adapter: listing.adapter, adapterVersion: listing.adapterVersion, connectionMode: listing.connectionMode,
        capabilities: listing.capabilities, active: true,
      }, listing.mappingVersion, command("18"));
      await assert.rejects(() => runtime.preflight(worker, claimed.id, claimed.leaseToken), StoreConflictError);
      assert.equal((await runtime.submitResult(worker, claimed.id, {
        resultId: command("12"), leaseToken: claimed.leaseToken, outcome: "SUPERSEDED", stopped: true, target: claimed.target,
      })).acceptedAsCurrent, false);
      assert.equal((await runtime.reconcileListing(admin, remapped.id, command("19"))).jobs, 56);
      const reservationClaim = await runtime.claim(worker);
      assert.ok(reservationClaim);
      assert.equal((await runtime.preflight(worker, reservationClaim.id, reservationClaim.leaseToken)).ready, true);
      const hold = await store.createBookingHold({ providerId: "provider-a" }, {
        productId: "tea", occurrenceId: reservationClaim.occurrenceId, seats: 1, idempotencyKey: "channel-preflight-hold", holdSeconds: 3600,
      });
      // Booking snapshots (including hold expiry) are immutable. Confirm the synthetic
      // booking so this injected future clock still exercises occupied inventory.
      await pool.query("UPDATE bookings SET status='CONFIRMED', confirmed_at=clock_timestamp() WHERE public_booking_id=$1::uuid", [hold.publicBookingId]);
      await assert.rejects(() => runtime.preflight(worker, reservationClaim.id, reservationClaim.leaseToken), StoreConflictError);
      const resultId = command("20");
      const staleResultInput = {
        resultId, leaseToken: reservationClaim.leaseToken, outcome: "SUPERSEDED", stopped: true, target: reservationClaim.target,
      } as const;
      const repeatedResults = await Promise.all([
        runtime.submitResult(worker, reservationClaim.id, staleResultInput),
        runtime.submitResult(worker, reservationClaim.id, staleResultInput),
      ]);
      assert.equal(repeatedResults.every((item) => !item.acceptedAsCurrent), true);
      assert.equal(repeatedResults.filter((item) => item.repeated).length, 1);
      await assert.rejects(() => runtime.submitResult(worker, reservationClaim.id, {
        ...staleResultInput, leaseToken: `${reservationClaim.leaseToken}altered`,
      }), StoreAccessDeniedError);
      const desired = await pool.query<{ observed_state: string | null }>(
        "SELECT observed_state FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1", [reservationClaim.occurrenceId],
      );
      assert.equal(desired.rows[0]?.observed_state, null);
      await runtime.revokeWorkerAccount(admin, credential.workerId, account.id, 1, command("13"));
      await runtime.revokeWorker(admin, credential.workerId, 1, command("17"));
      await assert.rejects(() => runtime.authenticateWorker(credential.bearerToken), StoreAccessDeniedError);

      const secondCredential = await runtime.mintWorkerCredential(admin, "studio-2", "Synthetic Studio 2", "2099-02-01T00:00:00.000Z", null, command("14"));
      await runtime.assignWorkerAccount(admin, secondCredential.workerId, account.id, null, command("15"));
      const secondWorker = await runtime.authenticateWorker(secondCredential.bearerToken);
      const secondClaim = await runtime.claim(secondWorker);
      assert.ok(secondClaim);
      now = new Date(now.getTime() + 61_000);
      await assert.rejects(() => runtime.renew(secondWorker, secondClaim.id, secondClaim.leaseToken), StoreConflictError);
      assert.equal((await pool.query<{ quarantine_reason: string }>("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.quarantine_reason, "LEASE_RENEWAL_LATE");
      now = new Date(now.getTime() + 60_000);
      await assert.rejects(() => runtime.preflight(secondWorker, secondClaim.id, secondClaim.leaseToken), StoreConflictError);
      assert.equal(await runtime.claim(secondWorker), null);
      const quarantined = await pool.query<{ quarantine_reason: string }>("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account-a'");
      assert.equal(quarantined.rows[0]?.quarantine_reason, "LEASE_EXPIRED");
      const recovery = await runtime.recoverQuarantinedLease(admin, account.id, true, command("21"));
      const observe = await runtime.claim(secondWorker);
      assert.equal(observe?.id, recovery.observeJobId);
      assert.equal(observe?.action, "OBSERVE");
      assert.equal((await pool.query<{ quarantined: boolean }>("SELECT quarantined_at IS NOT NULL AS quarantined FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.quarantined, true);
      assert.ok(observe);
      assert.equal((await runtime.submitResult(secondWorker, observe.id, {
        resultId: command("22"), leaseToken: observe.leaseToken, outcome: "VERIFIED", stopped: true, target: observe.target,
        occurrenceId: observe.occurrenceId, sourceStartAtUtc: observe.sourceStartAtUtc, sourceEndAtUtc: observe.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
      })).acceptedAsCurrent, true);
      assert.equal((await pool.query<{ quarantined: boolean }>("SELECT quarantined_at IS NOT NULL AS quarantined FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.quarantined, false);

      const failedJob = await runtime.claim(secondWorker);
      assert.ok(failedJob);
      assert.equal((await runtime.submitResult(secondWorker, failedJob.id, {
        resultId: command("23"), leaseToken: failedJob.leaseToken, outcome: "AUTH_REQUIRED", stopped: true, target: failedJob.target,
      })).acceptedAsCurrent, false);
      assert.equal((await pool.query<{ quarantined: boolean }>("SELECT quarantined_at IS NOT NULL AS quarantined FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.quarantined, true);
      assert.equal((await runtime.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.error, "ACCOUNT_QUARANTINED");
      const terminalRecovery = await runtime.recoverQuarantinedLease(admin, account.id, true, command("24"));
      const terminalObserve = await runtime.claim(secondWorker);
      assert.equal(terminalObserve?.id, terminalRecovery.observeJobId);
      assert.ok(terminalObserve);
      assert.equal((await runtime.submitResult(secondWorker, terminalObserve.id, {
        resultId: command("25"), leaseToken: terminalObserve.leaseToken, outcome: "VERIFIED", stopped: true, target: terminalObserve.target,
        occurrenceId: terminalObserve.occurrenceId, sourceStartAtUtc: terminalObserve.sourceStartAtUtc, sourceEndAtUtc: terminalObserve.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: false, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
      })).acceptedAsCurrent, true);
      const runtimeWithoutAdapters = new ChannelRuntime(pool, { now: () => now });
      assert.equal((await runtimeWithoutAdapters.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.error, "ADAPTER_UNAVAILABLE");
      await pool.query("UPDATE experience_products SET status='ARCHIVED' WHERE provider_id='provider-a' AND id='tea'");
      assert.equal((await runtime.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.error, "PRODUCT_UNPUBLISHED");
      await pool.query("UPDATE experience_products SET status='PUBLISHED' WHERE provider_id='provider-a' AND id='tea'");
      const staleTimingJob = await runtime.claim(secondWorker);
      assert.ok(staleTimingJob);
      const sourceDate = staleTimingJob.occurrenceId.slice(staleTimingJob.occurrenceId.lastIndexOf("@") + 1);
      await store.saveOccurrenceOverride({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", "tea-am", {
        kind: "RESCHEDULE", occurrenceId: staleTimingJob.occurrenceId, localDate: sourceDate, localStartTime: "11:30",
      }, null, command("26"));
      assert.equal((await runtime.submitResult(secondWorker, staleTimingJob.id, {
        resultId: command("27"), leaseToken: staleTimingJob.leaseToken, outcome: "VERIFIED", stopped: true, target: staleTimingJob.target,
        occurrenceId: staleTimingJob.occurrenceId, sourceStartAtUtc: staleTimingJob.sourceStartAtUtc, sourceEndAtUtc: staleTimingJob.sourceEndAtUtc,
        observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true, observedAtUtc: now.toISOString(),
      })).acceptedAsCurrent, false);

      await pool.query(
        `INSERT INTO schedule_rules
          (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ('provider-a','invalid-weekdays','tea','Asia/Tokyo','2099-01-01','12:00',60,1,30,0,0,'{"kind":"SELECTED_WEEKDAYS"}')`,
      );
      await pool.query(
        `INSERT INTO calendar_commands (provider_id,command_id,action,request_fingerprint,result)
         VALUES ('provider-a',$1::uuid,'test.invalid',$2,'{"aggregateId":"invalid-weekdays","version":1}')`, [command("16"), "0".repeat(64)],
      );
      await pool.query(
        `INSERT INTO calendar_outbox_events (provider_id,command_id,aggregate_type,aggregate_id,topic,payload)
         VALUES ('provider-a',$1::uuid,'schedule_rule','invalid-weekdays','calendar.changed','{}')`, [command("16")],
      );
      await assert.rejects(() => runtime.consumeCalendarOutbox());
      const cursor = await pool.query<{ processed_at: Date | null }>("SELECT processed_at FROM calendar_outbox_events WHERE command_id=$1::uuid", [command("16")]);
      assert.equal(cursor.rows[0]?.processed_at, null);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
  it("rejects assignment ABA and stale CLOSE, and resumes fan-out beyond 2,000 occurrences", async () => {
    const { Pool } = await import("pg");
    const schema = `channel_regression_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const admin = { nihoUserId: "synthetic-admin" };
    const actor = { providerId: "provider", nihoUserId: "owner" };
    const now = new Date("2099-01-01T00:00:00.000Z");
    const runtime = new ChannelRuntime(pool, { now: () => now,
      supportedAdapters: { "GetYourGuide/gyg-browser@1": { canObserve: true, canClose: true, canOpen: true } } });
    const store = new ExperienceStore(pool);
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of names) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider','owner','OWNER')");
      await pool.query(`INSERT INTO experience_products
        (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
        VALUES ('provider','tea','synthetic-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic')`);
      await store.saveScheduleRule(actor, "tea", {
        id: "morning", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
        capacity: 1, bookingCutoffMinutes: 30, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      }, null, command("101"));
      await runtime.createExternalAccount(admin, { id: "account", providerId: "provider", site: "GetYourGuide",
        externalAccountId: "synthetic-account", displayName: "Synthetic account", operatingModel: 4, active: true }, command("102"));
      await runtime.createListing(admin, { id: "listing-00", providerId: "provider", accountId: "account", productId: "tea",
        externalProductId: "synthetic-product-0", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true }, command("103"));
      const credential = await runtime.mintWorkerCredential(admin, "studio", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, command("104"));
      await runtime.assignWorkerAccount(admin, "studio", "account", null, command("105"));
      const worker = await runtime.authenticateWorker(credential.bearerToken);
      await runtime.consumeCalendarOutbox();
      const oldLease = await runtime.claim(worker);
      assert.ok(oldLease);
      await runtime.revokeWorkerAccount(admin, "studio", "account", 1, command("106"));
      await runtime.assignWorkerAccount(admin, "studio", "account", 2, command("107"));
      await assert.rejects(() => runtime.renew(worker, oldLease.id, oldLease.leaseToken), StoreAccessDeniedError);
      await assert.rejects(() => runtime.preflight(worker, oldLease.id, oldLease.leaseToken), StoreAccessDeniedError);
      assert.equal((await runtime.submitResult(worker, oldLease.id, { resultId: command("108"), leaseToken: oldLease.leaseToken,
        outcome: "VERIFIED", stopped: true, target: oldLease.target, occurrenceId: oldLease.occurrenceId,
        sourceStartAtUtc: oldLease.sourceStartAtUtc, sourceEndAtUtc: oldLease.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
      })).acceptedAsCurrent, false);
      // The stale result quarantines the account. Use the supported recovery path.
      const recovery = await runtime.recoverQuarantinedLease(admin, "account", true, command("109"));
      const observed = await runtime.claim(worker);
      assert.equal(observed?.id, recovery.observeJobId); assert.ok(observed);
      await runtime.submitResult(worker, observed.id, { resultId: command("110"), leaseToken: observed.leaseToken,
        outcome: "VERIFIED", stopped: true, target: observed.target, occurrenceId: observed.occurrenceId,
        sourceStartAtUtc: observed.sourceStartAtUtc, sourceEndAtUtc: observed.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString() });
      const occurrenceId = "morning@2099-01-02";
      await store.setOccurrenceSalesState(actor, "tea", "morning", { occurrenceId, desiredState: "CLOSED" }, null, command("111"));
      await runtime.consumeCalendarOutbox();
      const close = await runtime.claim(worker);
      assert.equal(close?.action, "SET_CLOSED"); assert.equal(close?.occurrenceId, occurrenceId); assert.ok(close);
      await store.setOccurrenceSalesState(actor, "tea", "morning", { occurrenceId, desiredState: "OPEN" }, 1, command("112"));
      // Deliberately do not consume the reopening outbox before either check.
      await assert.rejects(() => runtime.preflight(worker, close.id, close.leaseToken), StoreConflictError);
      assert.equal((await runtime.submitResult(worker, close.id, { resultId: command("113"), leaseToken: close.leaseToken,
        outcome: "VERIFIED", stopped: true, target: close.target, occurrenceId,
        sourceStartAtUtc: close.sourceStartAtUtc, sourceEndAtUtc: close.sourceEndAtUtc,
        observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true, observedAtUtc: now.toISOString(),
      })).acceptedAsCurrent, false);
      await runtime.consumeCalendarOutbox();
      const stopRecovery = await runtime.recoverQuarantinedLease(admin, "account", true, command("115"));
      const recoveryRead = await runtime.claim(worker);
      assert.equal(recoveryRead?.id, stopRecovery.observeJobId); assert.ok(recoveryRead);
      await runtime.submitResult(worker, recoveryRead.id, { resultId: command("116"), leaseToken: recoveryRead.leaseToken,
        outcome: "VERIFIED", stopped: true, target: recoveryRead.target, occurrenceId: recoveryRead.occurrenceId,
        sourceStartAtUtc: recoveryRead.sourceStartAtUtc, sourceEndAtUtc: recoveryRead.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString() });
      const synced = await runtime.claim(worker); assert.ok(synced);
      await runtime.submitResult(worker, synced.id, { resultId: command("117"), leaseToken: synced.leaseToken,
        outcome: "VERIFIED", stopped: true, target: synced.target, occurrenceId: synced.occurrenceId,
        sourceStartAtUtc: synced.sourceStartAtUtc, sourceEndAtUtc: synced.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString() });
      assert.equal((await runtime.hostStatuses(actor)).find((item) => item.occurrenceId === synced.occurrenceId)?.label, "SYNCED");
      const futureTimers = await pool.connect();
      const futureCommands: string[] = [];
      try {
        for (const cause of ["hold_expired", "google_freshness_expired"]) {
          futureCommands.push(await enqueueCalendarRecalculation(futureTimers, {
            providerId: actor.providerId, aggregateType: "inventory", aggregateId: "tea", cause,
            availableAtUtc: new Date(now.getTime() + 60_000).toISOString(),
          }));
        }
      } finally { futureTimers.release(); }
      // A future timer is not a change awaiting delivery now. It becomes pending exactly when due.
      assert.equal((await runtime.hostStatuses(actor)).find((item) => item.occurrenceId === synced.occurrenceId)?.label, "SYNCED");
      now.setTime(now.getTime() + 60_000);
      assert.equal((await runtime.hostStatuses(actor)).find((item) => item.occurrenceId === synced.occurrenceId)?.label, "PENDING");
      await pool.query("UPDATE calendar_outbox_events SET processed_at=$1 WHERE command_id=ANY($2::uuid[])", [now, futureCommands]);
      assert.equal((await runtime.hostStatuses(actor)).find((item) => item.occurrenceId === synced.occurrenceId)?.label, "SYNCED");
      await runtime.updateListing(admin, "listing-00", { externalProductId: "synthetic-remapped-product", adapter: "gyg-browser", adapterVersion: "1",
        connectionMode: "BROWSER", capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true }, 1, command("118"));
      assert.equal((await runtime.hostStatuses(actor)).find((item) => item.occurrenceId === synced.occurrenceId)?.label, "PENDING");

      const extended = new ChannelRuntime(pool, { now: () => now, supportedAdapters: {
        "GetYourGuide/gyg-browser@1": { canObserve: true, canClose: true, canOpen: true },
        "GetYourGuide/retired-browser@1": { canObserve: true, canClose: true, canOpen: true },
      } });
      for (const [id, adapter, suffix] of [["retired-first", "retired-browser", "119"], ["supported-later", "gyg-browser", "120"]]) {
        await extended.createListing(admin, { id: id!, providerId: "provider", accountId: "account", productId: "tea",
          externalProductId: `synthetic-${id}`, adapter: adapter!, adapterVersion: "1", connectionMode: "BROWSER",
          capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true }, command(suffix!));
      }
      await extended.reconcileListing(admin, "retired-first", command("121"));
      await pool.query("UPDATE channel_jobs SET priority=100 WHERE listing_id='retired-first'");
      await extended.reconcileListing(admin, "supported-later", command("122"));
      const supported = await runtime.claim(worker); assert.ok(supported);
      assert.equal(supported.target.adapter, "gyg-browser");
      assert.equal(Number((await pool.query("SELECT count(*) FROM channel_jobs WHERE listing_id='retired-first' AND status='QUEUED'")).rows[0]?.count), 56);
      now.setTime(now.getTime() + 121_000);
      await runtime.submitResult(worker, supported.id, { resultId: command("123"), leaseToken: supported.leaseToken,
        outcome: "SUPERSEDED", stopped: false, target: supported.target });
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1", [supported.id])).rows[0]?.status, "LEASED");
      await runtime.submitResult(worker, supported.id, { resultId: command("124"), leaseToken: supported.leaseToken,
        outcome: "SUPERSEDED", stopped: true, target: supported.target });
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1", [supported.id])).rows[0]?.status, "FINISHED");
      assert.equal((await pool.query("SELECT quarantined_at IS NOT NULL AS quarantined FROM channel_external_accounts WHERE id='account'")).rows[0]?.quarantined, true);
      for (const [id, adapter, suffix] of [["retired-first", "retired-browser", "125"], ["supported-later", "gyg-browser", "126"]]) {
        await extended.updateListing(admin, id!, { externalProductId: `synthetic-${id}`, adapter: adapter!, adapterVersion: "1", connectionMode: "BROWSER",
          capabilities: { canObserve: true, canClose: true, canOpen: true }, active: false }, 1, command(suffix!));
      }
      await pool.query(`INSERT INTO channel_listings
        (id,provider_id,account_id,product_id,external_product_id,adapter,adapter_version,connection_mode,can_observe,can_close,can_open,active)
        SELECT 'listing-'||lpad(n::text,2,'0'),'provider','account','tea','synthetic-product-'||n,'gyg-browser','1','BROWSER',true,true,true,true
        FROM generate_series(1,35) n`);
      await store.setOccurrenceSalesState(actor, "tea", "morning", { occurrenceId, desiredState: "CLOSED" }, 2, command("114"));
      const first = await runtime.consumeCalendarOutbox(1);
      assert.equal(first.occurrences, 2_000); assert.equal(first.events, 0);
      const cursor = await pool.query("SELECT channel_dispatch_cursor,processed_at FROM calendar_outbox_events WHERE command_id=$1::uuid", [command("114")]);
      assert.ok(cursor.rows[0]?.channel_dispatch_cursor); assert.equal(cursor.rows[0]?.processed_at, null);
      const second = await runtime.consumeCalendarOutbox(1);
      assert.equal(second.occurrences, 16); assert.equal(second.events, 1);
      assert.equal(Number((await pool.query("SELECT count(*) FROM channel_desired_states d JOIN channel_listings l ON l.id=d.listing_id WHERE l.active")).rows[0]?.count), 2_016);
      assert.equal((await runtime.consumeCalendarOutbox()).events, 0);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

});
