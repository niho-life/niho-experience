import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { ChannelRuntime, type ExternalReservationObservation, type WorkerIdentity } from "../src/channels.ts";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExternalReservationGuests } from "../src/external-reservation-guests.ts";
import { HOST_NOTIFICATION_TOPICS, HostNotificationOutbox, parseOtaBookingPayload } from "../src/host-notification-outbox.ts";
import { HostOtaBookings } from "../src/host-ota-bookings.ts";
import { HostPushSubscriptions } from "../src/push-subscriptions.ts";
import { ExperienceStore } from "../src/repository.ts";

// 予約者の情報つきの OTA の予約 (#194, owner decision 2026-11-01). Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL;
const T0 = Date.parse("2099-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();
const admin = { nihoUserId: "admin-a" };
const owner = { providerId: "provider-a", nihoUserId: "owner-a" };
const editor = { providerId: "provider-a", nihoUserId: "editor-a" };
const teaOperator = { providerId: "provider-a", nihoUserId: "operator-tea", calendarScope: "OPERATOR" as const };
const soloOperator = { providerId: "provider-a", nihoUserId: "operator-solo", calendarScope: "OPERATOR" as const };
const otherOwner = { providerId: "provider-b", nihoUserId: "owner-b" };
const listings = {
  gyg: { externalProductId: "tea-gyg", externalOptionId: "morning" },
  air: { externalProductId: "tea-air", externalOptionId: "" },
} as const;
const guest = {
  name: "Synthetic Traveler", partyBreakdown: [{ band: "CHILD", count: 1 }, { band: "ADULT", count: 1 }],
  email: "traveler@example.test", language: "en-US", bookingReference: "GYG-SYNTH-0001", notes: "Synthetic note: one vegetarian.",
} as const;

const observation = (
  listing: keyof typeof listings, id: string, date: string, seats: number, sourceUpdatedAtUtc: string,
  extra: Partial<ExternalReservationObservation> = {},
): ExternalReservationObservation => ({
  externalReservationId: id, externalProductId: listings[listing].externalProductId,
  ...(listings[listing].externalOptionId ? { externalOptionId: listings[listing].externalOptionId } : {}),
  sourceStartAtUtc: `${date}T01:00:00.000Z`, sourceEndAtUtc: `${date}T02:00:00.000Z`,
  status: "CONFIRMED", seats, sourceUpdatedAtUtc, ...extra,
});

describe("PostgreSQL OTA reservation guests (#194)", { skip: databaseUrl === undefined }, () => {
  it("keeps the guest's details, tells the product's people, shows them to them only, and erases them after a year", { timeout: 180_000 }, async () => {
    const { Pool } = await import("pg");
    const schema = `ota_guests_${randomUUID().replaceAll("-", "")}`;
    const pool: Pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    let created = false;
    const clock = { now: new Date(T0) };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((file) => /^\d{4}.*\.sql$/.test(file)).sort();
      for (const file of migrations) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role)
         VALUES ('provider-a','owner-a','OWNER'),('provider-a','editor-a','EDITOR'),('provider-b','owner-b','OWNER')`,
      );
      for (const [provider, id] of [["provider-a", "tea"], ["provider-a", "solo"], ["provider-b", "other"]] as const) {
        await pool.query(
          `INSERT INTO experience_products
            (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$2,'PUBLISHED',$3,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
          [provider, id, `Synthetic ${id}`],
        );
      }
      // Operators: one for tea, one for solo (an accepted invitation, then the grant).
      for (const [userId, productId] of [["operator-tea", "tea"], ["operator-solo", "solo"]] as const) {
        const invitation = randomUUID();
        await pool.query(
          `INSERT INTO product_operator_invitations
            (id,provider_id,product_id,token_hash,assignment_label,invited_by_niho_user_id,expires_at,state,accepted_niho_user_id,accepted_at)
           VALUES ($1,'provider-a',$2,decode(repeat('ab',32),'hex'),'Synthetic instructor','owner-a',clock_timestamp()+interval '1 day',
                   'ACCEPTED',$3,clock_timestamp())`,
          [invitation, productId, userId],
        );
        await pool.query(
          `INSERT INTO product_operator_grants (provider_id,product_id,niho_user_id,invitation_id,assignment_label)
           VALUES ('provider-a',$1,$2,$3,'Synthetic instructor')`,
          [productId, userId, invitation],
        );
      }
      const store = new ExperienceStore(pool);
      const rule = (id: string): ScheduleRule => ({
        id, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-10", localStartTime: "10:00", durationMinutes: 60,
        capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      });
      await store.saveScheduleRule(owner, "tea", rule("tea-am"), null, randomUUID());
      const supportedAdapters = {
        "Airbnb/browser-v1@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true },
        "GetYourGuide/gyg-browser@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true },
      };
      const runtime = new ChannelRuntime(pool, { now: () => clock.now, supportedAdapters, otaGuestDetailsEnabled: true, otaBookingNotificationsEnabled: true });
      // The same deployment with both flags off.
      const plain = new ChannelRuntime(pool, { now: () => clock.now, supportedAdapters });
      const caps = { canObserve: true, canReadReservations: true, canClose: true, canOpen: true };
      await runtime.createExternalAccount(admin, {
        id: "account-gyg", providerId: "provider-a", site: "GetYourGuide", externalAccountId: "ext-gyg-account", displayName: "Synthetic GYG",
        operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await runtime.createExternalAccount(admin, {
        id: "account-air", providerId: "provider-a", site: "Airbnb", externalAccountId: "ext-air-account", displayName: "Synthetic Airbnb",
        operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-gyg", providerId: "provider-a", accountId: "account-gyg", productId: "tea", ...listings.gyg,
        adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER", capabilities: caps, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-air", providerId: "provider-a", accountId: "account-air", productId: "tea", externalProductId: listings.air.externalProductId,
        adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER", capabilities: caps, active: true,
      }, randomUUID());
      const credential = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic Studio", "2099-03-01T00:00:00.000Z", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-gyg", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-air", null, randomUUID());
      const worker: WorkerIdentity = await runtime.authenticateWorker(credential.bearerToken);

      const consumeAll = async () => { while ((await runtime.consumeCalendarOutbox(200)).events > 0) { /* drain */ } };
      const claimExactly = async (jobId: string) => {
        await pool.query("UPDATE channel_jobs SET priority=CASE WHEN id=$1::uuid THEN 100 ELSE 0 END WHERE status='QUEUED'", [jobId]);
        await pool.query("UPDATE channel_jobs SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=$1::uuid", [jobId]);
        const job = await runtime.claim(worker);
        assert.equal(job?.id, jobId);
        return job;
      };
      /** One complete window read of a listing, submitted through `through` (the flags on or off). */
      const windowRead = async (listingId: string, observations: ExternalReservationObservation[], through: ChannelRuntime = runtime) => {
        await pool.query(
          "UPDATE external_reservation_read_dispatch_states SET next_due_at=$2 WHERE listing_id=$1 AND pending_job_id IS NULL AND halted_at IS NULL",
          [listingId, clock.now],
        );
        await runtime.enqueueDueReservationReads(worker, 10);
        const queued = (await pool.query(
          "SELECT id::text FROM channel_jobs WHERE listing_id=$1 AND purpose='RESERVATION_WINDOW' AND status='QUEUED'", [listingId],
        )).rows[0]?.id as string | undefined;
        assert.ok(queued);
        const job = await claimExactly(queued);
        const cycle = await through.beginReservationWindowRead(worker, job.id, job.leaseToken);
        const receipt = await through.submitReservationWindowPage(worker, job.id, {
          receiptId: cycle.receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber: 0, observations,
          terminal: { status: "COMPLETE", completedAtUtc: clock.now.toISOString(), allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
        });
        await through.submitResult(worker, job.id, {
          resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "RESERVATION_VERIFIED", stopped: true, target: job.target,
          reservationReadId: cycle.readId, reservationReceiptId: receipt.receiptId,
        });
        lastPage = { jobId: job.id, page: {
          receiptId: cycle.receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber: 0, observations,
          terminal: { status: "COMPLETE", completedAtUtc: clock.now.toISOString(), allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
        } };
        return receipt;
      };
      let lastPage: { jobId: string; page: Parameters<ChannelRuntime["submitReservationWindowPage"]>[2] } | null = null;
      const guestRow = async (id: string) => (await pool.query(
        `SELECT guest_name,party_breakdown,guest_email,guest_phone,guest_language,booking_reference,source_notes,pii_erased_at
           FROM external_reservation_guests WHERE external_reservation_id=$1`, [id],
      )).rows[0];
      const notifications = async () => (await pool.query(
        "SELECT id::text,payload,processed_at FROM outbox_messages WHERE topic=$1 ORDER BY id", [HOST_NOTIFICATION_TOPICS.otaBooking],
      )).rows as { id: string; payload: Record<string, unknown>; processed_at: Date | null }[];
      const hostRef = async (id: string) => String((await pool.query(
        "SELECT host_ref::text FROM external_reservations WHERE external_reservation_id=$1", [id],
      )).rows[0]?.host_ref);

      for (const id of ["listing-gyg", "listing-air"]) await runtime.reconcileListing(admin, id, randomUUID());
      await consumeAll();

      // The first complete read of a listing is its baseline: what it finds is kept, but nobody is told.
      clock.now = new Date(at(60));
      await windowRead("listing-gyg", [observation("gyg", "R1", "2099-01-03", 2, at(30), { guest })]);
      await windowRead("listing-air", []);
      await consumeAll();
      assert.deepEqual(await notifications(), []);
      const r1 = await guestRow("R1");
      assert.deepEqual(
        [r1?.guest_name, r1?.party_breakdown, r1?.guest_email, r1?.guest_phone, r1?.guest_language, r1?.booking_reference, r1?.source_notes, r1?.pii_erased_at],
        ["Synthetic Traveler", [{ band: "ADULT", count: 1 }, { band: "CHILD", count: 1 }], "traveler@example.test", null, "en-US", "GYG-SYNTH-0001",
          "Synthetic note: one vegetarian.", null],
      );
      // The details never reach the 7-year audit: the revision's fingerprint is the inventory facts' alone.
      const { guest: _omit, ...r1Facts } = observation("gyg", "R1", "2099-01-03", 2, at(30), { guest });
      const plainFingerprint = (await pool.query(
        "SELECT observation_fingerprint FROM external_reservation_revisions WHERE external_reservation_id='R1'",
      )).rows[0]?.observation_fingerprint;
      const { externalReservationObservationFingerprint } = await import("../src/external-reservation-ledger.ts");
      assert.equal(plainFingerprint, externalReservationObservationFingerprint({ ...r1Facts, externalOptionId: "morning" }));

      // Next read: R1 again with a phone the site shows only now (no new revision), and a new R2.
      clock.now = new Date(at(1_000));
      const r1Again = observation("gyg", "R1", "2099-01-03", 2, at(30), { guest: { phone: "+81 90-0000-0000" } });
      const r2 = observation("gyg", "R2", "2099-01-04", 1, at(900), { guest: { name: "Synthetic Second" } });
      const second = await windowRead("listing-gyg", [r1Again, r2]);
      assert.deepEqual([second.applied, second.duplicates], [1, 1]);
      assert.equal((await guestRow("R1"))?.guest_phone, "+81 90-0000-0000");
      assert.equal((await guestRow("R1"))?.guest_name, "Synthetic Traveler");
      // The receipt's lasting fingerprint has no guest details: the same page with other details is the same page,
      // answered from the receipt, and keeps what the first one kept.
      const replay = lastPage!;
      const resent = await runtime.submitReservationWindowPage(worker, replay.jobId, {
        ...replay.page, observations: replay.page.observations.map((item) => ({ ...item, guest: { name: "Synthetic Changed" } })),
      });
      assert.equal(resent.repeated, true);
      assert.equal((await guestRow("R2"))?.guest_name, "Synthetic Second");
      const r2Ref = await hostRef("R2");
      let rows = await notifications();
      assert.equal(rows.length, 1);
      assert.deepEqual(parseOtaBookingPayload(rows[0]!.payload), {
        v: 1, change: "NEW", site: "GetYourGuide", ref: r2Ref, productId: "tea", experienceTitle: "Synthetic tea",
        startsAt: "2099-01-04T01:00:00.000Z", seats: 1, guestName: "Synthetic Second",
      });

      // R2 moves to another day and R1 is cancelled on the site.
      clock.now = new Date(at(2_000));
      await windowRead("listing-gyg", [
        observation("gyg", "R1", "2099-01-03", 2, at(1_900), { status: "CANCELLED" }),
        observation("gyg", "R2", "2099-01-06", 1, at(1_900)),
      ]);
      rows = await notifications();
      assert.deepEqual(rows.slice(1).map((row) => parseOtaBookingPayload(row.payload)), [
        { v: 1, change: "CANCELLED", site: "GetYourGuide", ref: await hostRef("R1"), productId: "tea", experienceTitle: "Synthetic tea",
          startsAt: "2099-01-03T01:00:00.000Z", seats: 2, guestName: "Synthetic Traveler" },
        { v: 1, change: "RESCHEDULED", site: "GetYourGuide", ref: r2Ref, productId: "tea", experienceTitle: "Synthetic tea",
          startsAt: "2099-01-06T01:00:00.000Z", previousStartsAt: "2099-01-04T01:00:00.000Z", seats: 1, guestName: "Synthetic Second" },
      ]);
      // The same facts again: no new revision, no new notification.
      clock.now = new Date(at(2_100));
      await windowRead("listing-gyg", [
        observation("gyg", "R1", "2099-01-03", 2, at(1_900), { status: "CANCELLED" }),
        observation("gyg", "R2", "2099-01-06", 1, at(1_900)),
      ]);
      assert.equal((await notifications()).length, 3);

      // A wrong value is refused before anything is written.
      const before = (await pool.query("SELECT count(*)::int AS n FROM external_reservation_revisions")).rows[0]?.n;
      for (const bad of [
        { email: "not-an-address" },
        { partyBreakdown: [{ band: "ADULT", count: 2 }] },
        { partyBreakdown: [{ band: "ADULT", count: 1 }, { band: "ADULT", count: 0 }] },
        { phone: "call me" },
        { name: " padded" },
        { amount: 12_000 },
        {},
      ]) {
        // Checked before any lookup: the page is refused whatever its job.
        await assert.rejects(() => runtime.submitReservationWindowPage(worker, randomUUID(), {
          receiptId: randomUUID(), readId: randomUUID(), leaseToken: "synthetic-lease", pageNumber: 0,
          observations: [observation("gyg", "R9", "2099-01-05", 1, at(2_200), { guest: bad as never })],
          terminal: { status: "COMPLETE", completedAtUtc: clock.now.toISOString(), allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
        }), StoreValidationError, JSON.stringify(bad));
      }
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM external_reservation_revisions")).rows[0]?.n, before);
      assert.equal(await guestRow("R9"), undefined);

      // With both flags off a reader's details are checked and dropped, and nobody is told.
      clock.now = new Date(at(3_000));
      await windowRead("listing-air", [observation("air", "R3", "2099-01-05", 1, at(2_900), { guest: { name: "Synthetic Dropped" } })], plain);
      assert.equal(await guestRow("R3"), undefined);
      assert.equal((await notifications()).length, 3);

      // Who reads them: the OWNER every product's, an operator the assigned product's only, nobody else.
      const bookings = new HostOtaBookings(pool);
      const window = { fromUtc: "2099-01-01T00:00:00.000Z", toUtc: "2099-02-01T00:00:00.000Z" };
      const ownerList = await bookings.listForHost(owner, window);
      assert.deepEqual(ownerList.map((item) => [item.site, item.status, item.seats, item.guest?.name ?? null]), [
        ["GetYourGuide", "CANCELLED", 2, "Synthetic Traveler"],
        ["Airbnb", "CONFIRMED", 1, null],
        ["GetYourGuide", "CONFIRMED", 1, "Synthetic Second"],
      ]);
      const cancelled = ownerList[0]!;
      assert.deepEqual(cancelled.guest, {
        name: "Synthetic Traveler", email: "traveler@example.test", phone: "+81 90-0000-0000", language: "en-US", notes: "Synthetic note: one vegetarian.",
      });
      assert.equal(cancelled.bookingReference, "GYG-SYNTH-0001");
      assert.deepEqual([cancelled.offerId, cancelled.timeZone, cancelled.occurrenceId], ["tea-am", "Asia/Tokyo", occurrenceIdFor("tea-am", "2099-01-03")]);
      // Never the site's account or reservation ID.
      const shown = JSON.stringify(ownerList);
      for (const hidden of ["ext-gyg-account", "ext-air-account", "\"R1\"", "\"R2\"", "listing-gyg", "account-gyg"]) assert.equal(shown.includes(hidden), false, hidden);
      assert.deepEqual((await bookings.listForHost(teaOperator, window)).map((item) => item.ref), ownerList.map((item) => item.ref));
      assert.equal((await bookings.getForHost(teaOperator, r2Ref)).guest?.name, "Synthetic Second");
      assert.deepEqual(await bookings.listForHost(soloOperator, window), []);
      await assert.rejects(() => bookings.listForHost(soloOperator, { ...window, productId: "tea" }), StoreAccessDeniedError);
      await assert.rejects(() => bookings.getForHost(soloOperator, r2Ref), StoreNotFoundError);
      await assert.rejects(() => bookings.listForHost(editor, window), StoreAccessDeniedError);
      await assert.rejects(() => bookings.getForHost(otherOwner, r2Ref), StoreNotFoundError);
      assert.deepEqual(await bookings.listForHost(otherOwner, window), []);
      // A NIHO-capped operator scope never reads as the OWNER, even with a stale local OWNER row.
      await assert.rejects(() => bookings.listForHost({ ...owner, calendarScope: "OPERATOR" }, window), StoreAccessDeniedError);
      assert.deepEqual((await bookings.listForHost(owner, { ...window, occurrenceId: occurrenceIdFor("tea-am", "2099-01-06") })).map((item) => item.ref), [r2Ref]);

      // Push: the product's OWNER and its operators, never an EDITOR, another product's operator or another provider.
      const subscriptions = new HostPushSubscriptions(pool);
      const endpointOf = (userId: string) => `https://fcm.googleapis.com/fcm/send/synthetic-${userId}`;
      for (const userId of ["owner-a", "editor-a", "operator-tea", "operator-solo", "owner-b"]) {
        await subscriptions.save({ nihoUserId: userId, connectionId: `conn-${userId}`, endpoint: endpointOf(userId), p256dh: "A".repeat(87), auth: "B".repeat(22), deviceLabel: "iphone" });
      }
      const since = new Date(Date.now() - 60_000);
      const endpoints = async () => (await subscriptions.productRecipients("provider-a", "tea", since)).map((item) => item.endpoint).sort();
      assert.deepEqual(await endpoints(), [endpointOf("operator-tea"), endpointOf("owner-a")].sort());
      await pool.query("UPDATE product_operator_grants SET active=false,revoked_at=clock_timestamp() WHERE niho_user_id='operator-tea'");
      assert.deepEqual(await endpoints(), [endpointOf("owner-a")]);
      await assert.rejects(() => bookings.listForHost(teaOperator, window), StoreAccessDeniedError);

      // The push job's completion drops the name from the row; a row never sent loses it after 48 hours.
      const outbox = new HostNotificationOutbox(pool);
      const [claimed] = await outbox.claimDue(1, 60_000);
      assert.ok(claimed);
      await outbox.complete(claimed.id, claimed.attempts);
      rows = await notifications();
      assert.equal("guestName" in rows[0]!.payload, false);
      assert.equal(parseOtaBookingPayload(rows[0]!.payload)?.change, "NEW");
      await pool.query("UPDATE outbox_messages SET created_at=clock_timestamp()-interval '3 days' WHERE id=$1::bigint", [rows[1]!.id]);

      // Erasure: a cancellation a year after it was read, a booking a year after its experience, never during an open case.
      const guests = new ExternalReservationGuests(pool);
      await assert.rejects(() => guests.eraseGuestDetails({ endedBefore: "2099-01-01T00:00:00+09:00" }), StoreValidationError);
      assert.equal(await guests.eraseGuestDetails({ endedBefore: "2000-01-01T00:00:00.000Z" }), 0);
      assert.equal(await guests.eraseGuestDetails({ endedBefore: "2100-01-01T00:00:00.000Z" }), 1);
      const erased = await guestRow("R1");
      assert.deepEqual([erased?.guest_name, erased?.guest_email, erased?.guest_phone, erased?.booking_reference, erased?.source_notes, erased?.party_breakdown],
        [null, null, null, null, null, null]);
      assert.ok(erased?.pii_erased_at);
      assert.equal((await guestRow("R2"))?.guest_name, "Synthetic Second");
      rows = await notifications();
      assert.equal("guestName" in rows[1]!.payload, false);
      assert.equal(rows[2]!.payload.guestName, "Synthetic Second");
      const erasedView = (await bookings.listForHost(owner, window))[0]!;
      assert.deepEqual([erasedView.guest, erasedView.erased, erasedView.bookingReference], [null, true, null]);
      // Erased stays erased, even when a site sends the details again.
      await assert.rejects(() => pool.query("UPDATE external_reservation_guests SET guest_name='Back' WHERE external_reservation_id='R1'"), /stays erased/);

      // R2 in an open conflict case keeps its details past the year; once the case is closed they go.
      await pool.query("UPDATE external_reservations SET source_start_at='2000-01-01T01:00:00Z',source_end_at='2000-01-01T02:00:00Z' WHERE external_reservation_id='R2'");
      const caseId = randomUUID();
      await pool.query(
        `INSERT INTO external_reservation_conflict_cases (id,provider_id,product_id,occurrence_id,status,opened_at,last_seen_at)
         VALUES ($1,'provider-a','tea',$2,'OPEN',clock_timestamp(),clock_timestamp())`,
        [caseId, occurrenceIdFor("tea-am", "2099-01-06")],
      );
      await pool.query(
        `INSERT INTO external_reservation_conflict_members
          (case_id,member_kind,source_site,source_external_account_id,external_reservation_id,local_revision,occurrence_id,seats,added_at)
         SELECT $1,'EXTERNAL',source_site,source_external_account_id,external_reservation_id,local_revision,occurrence_id,seats,clock_timestamp()
           FROM external_reservations WHERE external_reservation_id='R2'`,
        [caseId],
      );
      assert.equal(await guests.eraseGuestDetails({ endedBefore: "2100-01-01T00:00:00.000Z" }), 0);
      await pool.query(
        "UPDATE external_reservation_conflict_cases SET status='RESOLVED',resolved_at=clock_timestamp(),resolution='CONFLICT_CLEARED' WHERE id=$1",
        [caseId],
      );
      assert.equal(await guests.eraseGuestDetails({ endedBefore: "2100-01-01T00:00:00.000Z" }), 1);
      assert.equal((await guestRow("R2"))?.guest_name, null);
      assert.equal("guestName" in (await notifications())[2]!.payload, true, "a row younger than 48 hours waits for the push job");
    } finally {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
