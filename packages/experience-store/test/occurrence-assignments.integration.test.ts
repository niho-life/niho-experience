import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { HostMailOutbox } from "../src/host-mail-outbox.ts";
import { enqueueAssignmentRequestNotification } from "../src/host-notification-outbox.ts";
import { OccurrenceAssignmentRepository } from "../src/occurrence-assignments.ts";
import { HostPushSubscriptions as PushSubscriptionsForTest } from "../src/push-subscriptions.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "admin-assignment-synthetic" } as const;
const PROVIDER = "provider-assignment";
const OTHER_PROVIDER = "provider-assignment-other";
const OWNER = "user-owner-synthetic";
const COHOST = "user-cohost-synthetic";
const EDITOR = "user-editor-synthetic";
const OPERATOR = "user-operator-synthetic";
const STRANGER = "user-stranger-synthetic";

const actor = (nihoUserId: string, providerId = PROVIDER) => ({ providerId, nihoUserId });
const cmd = () => randomUUID();

async function seedProvider(pool: Pool, providerId: string, productId: string): Promise<void> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
  await pool.query(
    `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,
       seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
     VALUES ($1,$2,$2,'PUBLISHED','Synthetic managed experience','JPY',10000,'terms','seller','acct_x','Synthetic Seller')`,
    [providerId, productId],
  );
  await pool.query(
    `INSERT INTO schedule_rules (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,
       booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
     VALUES ($1,$2,$3,'Asia/Tokyo',current_date,'10:00',90,6,60,0,0,'{"kind":"DAILY"}')`,
    [providerId, `rule-${productId}`, productId],
  );
}

async function seedOccurrence(pool: Pool, providerId: string, productId: string, occurrenceId: string, daysAhead: number): Promise<void> {
  await pool.query(
    `INSERT INTO schedule_occurrences (provider_id,occurrence_id,product_id,rule_id,source_local_date,local_date,local_start_time,time_zone,
       start_at,end_at,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,status,rescheduled,schedule_rule_version)
     VALUES ($1,$2,$3,$4,current_date+$5::int,current_date+$5::int,'10:00','Asia/Tokyo',
       (current_date+$5::int+time '10:00') AT TIME ZONE 'Asia/Tokyo',(current_date+$5::int+time '11:30') AT TIME ZONE 'Asia/Tokyo',90,6,60,0,0,'OPEN',false,1)`,
    [providerId, occurrenceId, productId, `rule-${productId}`, daysAhead],
  );
}

type Kind = "request" | "approved" | "confirmed" | "expired" | "instant";

async function seedBooking(pool: Pool, providerId: string, productId: string, occurrenceId: string, kind: Kind): Promise<string> {
  const publicId = randomUUID();
  const seller = kind === "instant"
    ? { salesPlan: "DIRECT", acceptanceMode: "INSTANT", chargeMode: "DIRECT" }
    : { salesPlan: "MANAGED_20", acceptanceMode: "APPROVAL", chargeMode: "PLATFORM" };
  const status = kind === "confirmed" ? "CONFIRMED" : kind === "expired" ? "EXPIRED" : kind === "instant" ? "CONFIRMED" : "HOLD";
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO bookings (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,
       occurrence_snapshot,pricing_snapshot,seller_snapshot,confirmed_at,created_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,clock_timestamp()+interval '23 hours',
       (SELECT jsonb_build_object('startUtc', to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM schedule_occurrences WHERE provider_id=$2 AND occurrence_id=$4),'{}',$7::jsonb,
       CASE WHEN $5='CONFIRMED' THEN clock_timestamp() END,clock_timestamp()-interval '1 minute') RETURNING id::text AS id`,
    [publicId, providerId, productId, occurrenceId, status, `key-${publicId}`, JSON.stringify(seller)],
  );
  await pool.query(
    `INSERT INTO booking_guests (provider_id,booking_id,guest_name,guest_email,guest_email_key,guest_language,answers,adult_count,child_count,
       terms_consent_version,client_request_key,request_fingerprint,utm,approval_status)
     VALUES ($1,$2,'Synthetic Guest','guest@example.test','guest@example.test','JA','[]',1,0,'v1',$3,$4,'{}',$5)`,
    [providerId, inserted.rows[0]?.id, `request-key-${publicId}`, "a".repeat(64), kind === "instant" ? null : "PENDING"],
  );
  return publicId;
}

describe("occurrence assignee (#535 v0)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("lets exactly one eligible person take an occurrence, keeps an append-only history and never touches the booking", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "occurrence_assignments", { max: 8 });
    try {
      const pool = db.pool;
      await seedProvider(pool, PROVIDER, "product-a");
      await seedProvider(pool, OTHER_PROVIDER, "product-z");
      await pool.query("INSERT INTO schedule_rules (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence) SELECT provider_id,'rule-product-b','product-a',time_zone,starts_on,'14:00',duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence FROM schedule_rules WHERE provider_id=$1", [PROVIDER]);
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
           ($1,$2,'OWNER',true),($1,$3,'COHOST',true),($1,$4,'EDITOR',true),($1,'user-inactive','COHOST',false),($5,$6,'OWNER',true)`,
        [PROVIDER, OWNER, COHOST, EDITOR, OTHER_PROVIDER, STRANGER],
      );
      const repository = new OccurrenceAssignmentRepository(pool);

      await seedOccurrence(pool, PROVIDER, "product-a", "occ-open", 5);
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-quiet", 6);
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-expired", 7);
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-instant", 8);
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-past", -3);
      await seedOccurrence(pool, OTHER_PROVIDER, "product-z", "occ-other", 5);
      const requested = await seedBooking(pool, PROVIDER, "product-a", "occ-open", "request");
      await seedBooking(pool, PROVIDER, "product-a", "occ-expired", "expired");
      await seedBooking(pool, PROVIDER, "product-a", "occ-instant", "instant");
      await seedBooking(pool, PROVIDER, "product-a", "occ-past", "confirmed");
      await seedBooking(pool, OTHER_PROVIDER, "product-z", "occ-other", "request");
      const before = await pool.query("SELECT status,hold_expires_at FROM bookings WHERE public_booking_id=$1", [requested]);
      const guestBefore = await pool.query("SELECT approval_status,approval_decided_at FROM booking_guests WHERE booking_id=(SELECT id FROM bookings WHERE public_booking_id=$1)", [requested]);

      // Only a current OWNER/COHOST can see and take the open occurrences; only live NIHO-managed requests make one open.
      assert.deepEqual((await repository.list(actor(OWNER))).open.map((item) => item.occurrenceId), ["occ-open"]);
      assert.deepEqual((await repository.list(actor(COHOST))).open.map((item) => item.occurrenceId), ["occ-open"]);
      assert.deepEqual((await repository.list(actor(EDITOR))).open, []);
      assert.deepEqual((await repository.list(actor(STRANGER))).open, []);
      for (const person of [EDITOR, STRANGER, "user-inactive"]) {
        await assert.rejects(repository.claim(actor(person), { occurrenceId: "occ-open", commandId: cmd() }), StoreAccessDeniedError);
      }
      // Another provider's occurrence is not reachable through this provider.
      await assert.rejects(repository.claim(actor(OWNER), { occurrenceId: "occ-other", commandId: cmd() }), StoreAccessDeniedError);
      // Nothing to take: no live request, an expired request, an instant booking, or a past occurrence.
      for (const occurrenceId of ["occ-quiet", "occ-expired", "occ-instant", "occ-past"]) {
        await assert.rejects(repository.claim(actor(OWNER), { occurrenceId, commandId: cmd() }), StoreConflictError);
      }

      // 行けません is optional input: it records, repeats harmlessly, and assigns and cancels nothing.
      const decline = cmd();
      assert.deepEqual(await repository.decline(actor(COHOST), { occurrenceId: "occ-open", commandId: decline, reason: "  その日は不在  " }), { outcome: "DECLINED", repeated: false });
      assert.deepEqual(await repository.decline(actor(COHOST), { occurrenceId: "occ-open", commandId: decline }), { outcome: "DECLINED", repeated: true });
      assert.equal((await repository.decline(actor(COHOST), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "ALREADY_DECLINED");
      assert.equal((await repository.list(actor(COHOST))).open[0]?.declinedByMe, true);
      assert.equal((await repository.list(actor(OWNER))).open[0]?.declinedByMe, false);
      await assert.rejects(repository.decline(actor(COHOST), { occurrenceId: "occ-open", commandId: cmd(), reason: "x".repeat(301) }), StoreValidationError);
      let rows = (await repository.adminList(ADMIN)).filter((row) => row.occurrenceId === "occ-open");
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.declined.map((item) => [item.nihoUserId, item.reason]), [[COHOST, "その日は不在"]]);
      assert.equal(rows[0]?.status, "OPEN");

      // The same command ID cannot be reused for another request.
      await assert.rejects(repository.claim(actor(OWNER), { occurrenceId: "occ-open", commandId: decline }), StoreConflictError);

      // Simultaneous 「対応する」: exactly one wins, everyone else learns it is taken, and there is one term and one event.
      const results = await Promise.all([OWNER, COHOST, OWNER, COHOST, OWNER, COHOST].map((person) => repository.claim(actor(person), { occurrenceId: "occ-open", commandId: cmd() })));
      const winners = results.filter((result) => result.outcome === "ASSIGNED");
      assert.equal(winners.length, 1);
      assert.ok(results.every((result) => ["ASSIGNED", "ALREADY_YOURS", "TAKEN"].includes(result.outcome)));
      const open = await pool.query<{ assignee: string }>("SELECT assignee_niho_user_id AS assignee FROM occurrence_assignments WHERE occurrence_id='occ-open' AND released_at IS NULL");
      assert.equal(open.rows.length, 1);
      const winner = open.rows[0]!.assignee;
      const loser = winner === OWNER ? COHOST : OWNER;
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM occurrence_assignment_events WHERE occurrence_id='occ-open' AND action='CLAIM'")).rows[0]?.n, 1);
      // A double click or a resend by the winner adds nothing; the loser gets TAKEN and the winner is not displaced.
      assert.equal((await repository.claim(actor(winner), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "ALREADY_YOURS");
      assert.equal((await repository.claim(actor(loser), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "TAKEN");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM occurrence_assignment_events WHERE occurrence_id='occ-open' AND action='CLAIM'")).rows[0]?.n, 1);
      assert.deepEqual((await repository.list(actor(winner))).mine.map((item) => item.occurrenceId), ["occ-open"]);
      assert.deepEqual((await repository.list(actor(loser))).mine, []);
      assert.deepEqual((await repository.list(actor(loser))).open, []);

      // A later booking in the same occurrence is received by the same assignee; nobody is asked again.
      await seedBooking(pool, PROVIDER, "product-a", "occ-open", "request");
      assert.equal((await repository.list(actor(winner))).mine[0]?.bookingCount, 2);
      assert.deepEqual((await repository.list(actor(loser))).open, []);

      // Only the assignee steps down; the loser cannot, and nothing changes for the guests.
      assert.equal((await repository.release(actor(loser), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "TAKEN");
      // The fee is typed by the office for the current assignee; others never see it.
      // The amount names the term the office saw (adminList), so a hand-over after the screen was read cannot receive it.
      const seen = (await repository.adminList(ADMIN)).find((row) => row.occurrenceId === "occ-open")?.assignee?.assignmentId;
      assert.ok(seen);
      assert.deepEqual(await repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open", commandId: cmd(), assignmentId: seen, agreedFeeYen: 5000 }), { outcome: "FEE_SET", repeated: false });
      await assert.rejects(repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open", commandId: cmd(), assignmentId: seen, agreedFeeYen: -1 }), StoreValidationError);
      await assert.rejects(repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open", commandId: cmd(), assignmentId: seen, agreedFeeYen: 1.5 }), StoreValidationError);
      await assert.rejects(repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open", commandId: cmd(), assignmentId: "not-a-uuid", agreedFeeYen: 100 }), StoreValidationError);
      // Another term (the screen was of someone who has since left): refused, and the current assignee's amount stays.
      await assert.rejects(repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open", commandId: cmd(), assignmentId: randomUUID(), agreedFeeYen: 9999 }), StoreConflictError);
      assert.equal((await repository.list(actor(winner))).mine[0]?.agreedFeeYen, 5000);
      assert.equal((await repository.adminList(ADMIN)).find((row) => row.occurrenceId === "occ-open")?.assignee?.agreedFeeYen, 5000);
      await assert.rejects(repository.adminSetAgreedFee(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-quiet", commandId: cmd(), assignmentId: seen, agreedFeeYen: 100 }), StoreConflictError);

      const release = cmd();
      assert.deepEqual(await repository.release(actor(winner), { occurrenceId: "occ-open", commandId: release, reason: "体調不良" }), { outcome: "RELEASED", repeated: false });
      assert.deepEqual(await repository.release(actor(winner), { occurrenceId: "occ-open", commandId: release }), { outcome: "RELEASED", repeated: true });
      assert.equal((await repository.release(actor(winner), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "ALREADY_OPEN");
      // The booking and its approval are exactly as before: assigning is not approving, charging or confirming.
      assert.deepEqual((await pool.query("SELECT status,hold_expires_at FROM bookings WHERE public_booking_id=$1", [requested])).rows, before.rows);
      assert.deepEqual((await pool.query("SELECT approval_status,approval_decided_at FROM booking_guests WHERE booking_id=(SELECT id FROM bookings WHERE public_booking_id=$1)", [requested])).rows, guestBefore.rows);
      // Open again: the next person starts a new term with no fee; the earlier term keeps its fee.
      assert.deepEqual((await repository.list(actor(OWNER))).open.map((item) => item.occurrenceId), ["occ-open"]);
      assert.equal((await repository.claim(actor(loser), { occurrenceId: "occ-open", commandId: cmd() })).outcome, "ASSIGNED");
      assert.equal((await repository.list(actor(loser))).mine[0]?.agreedFeeYen, null);
      assert.deepEqual((await pool.query("SELECT agreed_fee_yen,released_at IS NOT NULL AS released FROM occurrence_assignments WHERE occurrence_id='occ-open' ORDER BY claimed_at")).rows, [
        { agreed_fee_yen: 5000, released: true }, { agreed_fee_yen: null, released: false },
      ]);

      // The history: when / who / what / why. Host callers see no names, no one else's reason and no one else's fee.
      const history = await repository.history(actor(loser), { occurrenceId: "occ-open" });
      assert.ok(history.every((item) => item.subject.label === null));
      assert.ok(history.filter((item) => item.subject.kind === "OTHER").every((item) => item.reason === null && item.feeYen === null));
      assert.ok(!history.some((item) => item.action === "SET_FEE" && item.subject.kind === "OTHER"));
      const office = await repository.adminHistory(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-open" });
      assert.deepEqual(office.map((item) => `${item.action}:${item.recordedBy}`), ["DECLINE:SELF", "CLAIM:SELF", "SET_FEE:ADMIN", "RELEASE:SELF", "CLAIM:SELF"]);
      assert.equal(office.find((item) => item.action === "RELEASE")?.reason, "体調不良");
      assert.equal(office.find((item) => item.action === "SET_FEE")?.feeYen, 5000);
      await assert.rejects(repository.history(actor(EDITOR), { occurrenceId: "occ-open" }), StoreAccessDeniedError);

      // History and terms are never rewritten or deleted.
      await assert.rejects(pool.query("UPDATE occurrence_assignment_events SET reason='x'"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM occurrence_assignment_events"), /append-only/);
      await assert.rejects(pool.query("TRUNCATE occurrence_assignment_events"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM occurrence_assignments"), /never deleted/);
      await assert.rejects(pool.query("UPDATE occurrence_assignments SET assignee_niho_user_id='someone-else'"), /only changes by release or fee/);
      await assert.rejects(pool.query("UPDATE occurrence_assignments SET agreed_fee_yen=1 WHERE released_at IS NOT NULL"), /immutable/);
    } finally {
      await db.dispose();
    }
  });

  it("lets the office record for someone, limits who can be recorded, and includes product operators", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "occurrence_assignments_office", { max: 4 });
    try {
      const pool = db.pool;
      await seedProvider(pool, PROVIDER, "product-a");
      await pool.query("INSERT INTO schedule_rules (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence) SELECT provider_id,'rule-other','product-a',time_zone,starts_on,'14:00',duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence FROM schedule_rules WHERE provider_id=$1", [PROVIDER]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true),($1,$3,'EDITOR',true)", [PROVIDER, OWNER, EDITOR]);
      await seedOperatorGrant(pool, randomUUID(), PROVIDER, "product-a", OPERATOR);
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-office", 4);
      await seedBooking(pool, PROVIDER, "product-a", "occ-office", "confirmed");
      const repository = new OccurrenceAssignmentRepository(pool);

      // The operator of this product can serve it (an existing authority, no new team model).
      assert.deepEqual((await repository.list(actor(OPERATOR))).open.map((item) => item.occurrenceId), ["occ-office"]);
      assert.deepEqual((await repository.adminCandidates(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office" })).map((item) => [item.nihoUserId, item.kind]), [[OWNER, "MEMBER"], [OPERATOR, "OPERATOR"]]);

      // The office records for someone who can serve; an editor or a stranger cannot be recorded.
      await assert.rejects(repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "CLAIM", subjectNihoUserId: EDITOR }), StoreValidationError);
      await assert.rejects(repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "CLAIM", subjectNihoUserId: STRANGER }), StoreValidationError);
      assert.equal((await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "DECLINE", subjectNihoUserId: OPERATOR, reason: "LINEで辞退" })).outcome, "DECLINED");
      const claim = cmd();
      assert.deepEqual(await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: claim, action: "CLAIM", subjectNihoUserId: OWNER, reason: "LINEで返事" }), { outcome: "ASSIGNED", repeated: false });
      assert.deepEqual(await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: claim, action: "CLAIM", subjectNihoUserId: OWNER }), { outcome: "ASSIGNED", repeated: true });
      assert.equal((await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "CLAIM", subjectNihoUserId: OPERATOR })).outcome, "TAKEN");
      const row = (await repository.adminList(ADMIN)).find((item) => item.occurrenceId === "occ-office");
      assert.deepEqual([row?.status, row?.assignee?.nihoUserId, row?.assignee?.recordedByAdmin], ["ASSIGNED", OWNER, true]);
      assert.deepEqual(row?.declined.map((item) => item.nihoUserId), [OPERATOR]);
      // The office can free the occurrence again on behalf of the assignee.
      assert.equal((await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "RELEASE", reason: "連絡が取れない" })).outcome, "RELEASED");
      assert.equal((await repository.adminList(ADMIN)).find((item) => item.occurrenceId === "occ-office")?.status, "OPEN");
      assert.deepEqual((await repository.adminHistory(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office" })).map((item) => `${item.action}:${item.recordedBy}`), ["DECLINE:ADMIN", "CLAIM:ADMIN", "RELEASE:ADMIN"]);

      // A command that changed nothing keeps its first result: sent again after the state moved on, it is answered the same
      // and acts on nothing (a release for an open occurrence must not release whoever claimed it in between).
      const release = (commandId: string) => repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId, action: "RELEASE" });
      const stale = cmd();
      assert.deepEqual(await release(stale), { outcome: "ALREADY_OPEN", repeated: false });
      assert.equal((await repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: cmd(), action: "CLAIM", subjectNihoUserId: OWNER })).outcome, "ASSIGNED");
      assert.deepEqual(await release(stale), { outcome: "ALREADY_OPEN", repeated: true });
      assert.equal((await repository.adminList(ADMIN)).find((item) => item.occurrenceId === "occ-office")?.assignee?.nihoUserId, OWNER);
      // The same holds for a claim that lost: TAKEN stays TAKEN after the assignee stepped down, and nobody is assigned by the resend.
      const lost = cmd();
      const claimAsOperator = (commandId: string) => repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId, action: "CLAIM", subjectNihoUserId: OPERATOR });
      assert.deepEqual(await claimAsOperator(lost), { outcome: "TAKEN", repeated: false });
      assert.equal((await release(cmd())).outcome, "RELEASED");
      assert.deepEqual(await claimAsOperator(lost), { outcome: "TAKEN", repeated: true });
      assert.equal((await repository.adminList(ADMIN)).find((item) => item.occurrenceId === "occ-office")?.status, "OPEN");
      // The command ID still belongs to one request only, and results that changed nothing are not history.
      await assert.rejects(repository.adminRecord(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office", commandId: stale, action: "CLAIM", subjectNihoUserId: OWNER }), StoreConflictError);
      assert.deepEqual((await repository.adminHistory(ADMIN, { providerId: PROVIDER, occurrenceId: "occ-office" })).map((item) => `${item.action}:${item.recordedBy}`), ["DECLINE:ADMIN", "CLAIM:ADMIN", "RELEASE:ADMIN", "CLAIM:ADMIN", "RELEASE:ADMIN"]);
      // The record of commands is append-only too.
      await assert.rejects(pool.query("UPDATE occurrence_assignment_commands SET outcome='TAKEN' WHERE command_id=$1::uuid", [stale]), /append-only/);
      await assert.rejects(pool.query("DELETE FROM occurrence_assignment_commands WHERE command_id=$1::uuid", [stale]), /append-only/);

      // A revoked operator grant no longer serves the occurrence.
      await pool.query("UPDATE product_operator_grants SET active=false,revoked_at=clock_timestamp() WHERE niho_user_id=$1", [OPERATOR]);
      assert.deepEqual((await repository.list(actor(OPERATOR))).open, []);
      await assert.rejects(repository.claim(actor(OPERATOR), { occurrenceId: "occ-office", commandId: cmd() }), StoreAccessDeniedError);
    } finally {
      await db.dispose();
    }
  });
});

async function seedOperatorGrant(pool: Pool, invitationId: string, providerId: string, productId: string, userId: string): Promise<void> {
  // A grant needs its accepted invitation; insert the minimum a real acceptance leaves.
  await pool.query(
    `INSERT INTO product_operator_invitations (id,provider_id,product_id,token_hash,assignment_label,invited_by_niho_user_id,expires_at,state,accepted_niho_user_id,accepted_at)
     VALUES ($1,$2,$3,decode(repeat('ab',32),'hex'),'運営担当','admin-assignment-synthetic',clock_timestamp()+interval '3 days','ACCEPTED',$4,clock_timestamp())`,
    [invitationId, providerId, productId, userId],
  );
  await pool.query(
    `INSERT INTO product_operator_grants (provider_id,product_id,niho_user_id,invitation_id,assignment_label) VALUES ($1,$2,$3,$4,'運営担当')`,
    [providerId, productId, userId, invitationId],
  );
}

describe("occurrence assignee notifications (#535 v0 ②)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("tells the people who can take the occurrence, narrows to the assignee once there is one, and tells them again when it is open again", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "occurrence_assignment_notifications", { max: 4 });
    try {
      const pool = db.pool;
      await seedProvider(pool, PROVIDER, "product-a");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true),($1,$3,'COHOST',true),($1,$4,'EDITOR',true)`,
        [PROVIDER, OWNER, COHOST, EDITOR],
      );
      await seedOperatorGrant(pool, randomUUID(), PROVIDER, "product-a", OPERATOR);
      for (const [index, person] of [OWNER, COHOST, EDITOR, OPERATOR, STRANGER].entries()) {
        await pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,$2,clock_timestamp())", [person, `person${index}@example.test`]);
        await pool.query(
          `INSERT INTO host_push_subscriptions (niho_user_id,connection_id,endpoint,p256dh,auth,device_label) VALUES ($1,'conn',$2,$3,$4,'iphone')`,
          [person, `https://push.example.test/${index}`, "A".repeat(87), "B".repeat(22)],
        );
      }
      await seedOccurrence(pool, PROVIDER, "product-a", "occ-notify", 6);
      const first = await seedBooking(pool, PROVIDER, "product-a", "occ-notify", "request");
      const repository = new OccurrenceAssignmentRepository(pool, { notifications: true });
      const mails = new HostMailOutbox(pool);
      const pushes = new PushSubscriptionsForTest(pool);

      // The request is told once (push and one email per person who can take it, with an address): OWNER, COHOST and the
      // operator, not an editor or a stranger. A repeat adds nothing.
      assert.equal(await inTransaction(pool, (client) => enqueueAssignmentRequestNotification(client, { providerId: PROVIDER, publicBookingId: first })), 1);
      assert.equal(await inTransaction(pool, (client) => enqueueAssignmentRequestNotification(client, { providerId: PROVIDER, publicBookingId: first })), 0);
      const rows = await pool.query("SELECT topic,payload FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'host.%' ORDER BY topic,payload->>'to'", [first]);
      assert.deepEqual(rows.rows.map((row) => [row.topic, row.payload.to ?? null]), [
        ["host.mail.assignment_request", COHOST], ["host.mail.assignment_request", OPERATOR], ["host.mail.assignment_request", OWNER], ["host.notify.assignment_request", null],
      ]);
      const payload = rows.rows.find((row) => row.topic === "host.notify.assignment_request")!.payload;
      assert.deepEqual(Object.keys(payload).sort(), ["bookingId", "experienceTitle", "occurrenceId", "productId", "seats", "startsAt", "v"]);
      assert.ok(!JSON.stringify(rows.rows).includes("Synthetic Guest") && !JSON.stringify(rows.rows).includes("guest@example.test"));
      const claimed = async () => (await mails.claimBookingMails({ limit: 20, leaseSeconds: 60 })).mails;
      const sendable = (await claimed()).filter((mail) => mail.to !== null);
      assert.equal(sendable.length, 3);
      assert.ok(sendable.every((mail) => mail.notificationTopic === "host.notify.assignment_request"));
      for (const mail of sendable) await mails.completeBookingMail(mail.id);
      assert.deepEqual((await pushes.assignmentRecipients(PROVIDER, "product-a", "occ-notify", new Date(Date.now() - 60_000))).length, 3);

      // Once someone is the assignee, only that person is told: the other people's emails are not sent and their devices
      // get nothing, for the first request that is still waiting and for a request that comes later.
      await pool.query("UPDATE outbox_messages SET available_at=clock_timestamp(),processed_at=NULL WHERE aggregate_id=$1 AND topic='host.mail.assignment_request'", [first]);
      assert.equal((await repository.claim(actor(COHOST), { occurrenceId: "occ-notify", commandId: cmd() })).outcome, "ASSIGNED");
      const afterClaim = await claimed();
      assert.deepEqual(afterClaim.filter((mail) => mail.to !== null).map((mail) => mail.to), ["person1@example.test"]);
      assert.equal((await pushes.assignmentRecipients(PROVIDER, "product-a", "occ-notify", new Date(Date.now() - 60_000))).length, 1);
      const second = await seedBooking(pool, PROVIDER, "product-a", "occ-notify", "request");
      await inTransaction(pool, (client) => enqueueAssignmentRequestNotification(client, { providerId: PROVIDER, publicBookingId: second }));
      assert.deepEqual((await claimed()).filter((mail) => mail.to !== null).map((mail) => mail.to), ["person1@example.test"]);

      // Stepping down makes it open again and tells the people who can take it once more, exactly once per ended term.
      const before = Number((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE topic='host.notify.assignment_request'")).rows[0]?.n);
      const release = cmd();
      assert.equal((await repository.release(actor(COHOST), { occurrenceId: "occ-notify", commandId: release })).outcome, "RELEASED");
      assert.equal((await repository.release(actor(COHOST), { occurrenceId: "occ-notify", commandId: release })).repeated, true);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE topic='host.notify.assignment_request'")).rows[0]?.n), before + 1);
      assert.equal((await pushes.assignmentRecipients(PROVIDER, "product-a", "occ-notify", new Date(Date.now() - 60_000))).length, 3);
      // Without the flag a release tells nobody.
      await repository.claim(actor(OWNER), { occurrenceId: "occ-notify", commandId: cmd() });
      const quiet = new OccurrenceAssignmentRepository(pool);
      const count = async () => Number((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE topic LIKE 'host.%assignment_request'")).rows[0]?.n);
      const beforeQuiet = await count();
      await quiet.release(actor(OWNER), { occurrenceId: "occ-notify", commandId: cmd() });
      assert.equal(await count(), beforeQuiet);
    } finally {
      await db.dispose();
    }
  });
});

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
