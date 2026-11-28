import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { ProviderAgentSales, type AgentSalesChoiceInput } from "../src/agent-sales.ts";
import { AgentPayoutRepository, agentPayoutAmounts } from "../src/agent-payouts.ts";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestBookingRepository, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { HostMailOutbox } from "../src/host-mail-outbox.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { ExperienceStore } from "../src/repository.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/*
 * #725 (host registration, stage 3b-2): the ledger of what NIHO sends a host for agent-sales bookings. Real schema, synthetic data; Stripe is never called
 * (the store only records what the job's Stripe calls answered).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-agent-sales";
const PLATFORM = "acct_PlatformSynthetic1";
const CONSENT = "publication-agent-synthetic-v1";
const AGENT_AGREEMENT = "agent-sales-synthetic-v1";
const RECEIVER = "Synthetic NIHO Receiver KK";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const ADMIN = { nihoUserId: "admin-agent-synthetic" } as const;
const emptyQuestions = createHash("sha256").update("[]").digest("hex");
const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;

const day = (offset: number) => addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "agent_sales", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

/** A provider with an ACTIVE host account as its OWNER and a public profile, and no seller profile. */
async function agentOwner(pool: Pool, providerId = PROVIDER, email = "agent-owner@example.test"): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  await pool.query("INSERT INTO experience_provider_media_state (provider_id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email, nowUtc: new Date().toISOString() });
  assert.equal((await accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: new Date().toISOString() })).kind, "granted");
  await seedNotificationAddresses(pool, hostAccountId);
  await pool.query(
    `INSERT INTO experience_provider_public_profiles
       (provider_id,public_display_name,public_display_name_en,provider_kind,consent_version,consented_at,consent_source,consented_by_host_account_id,consented_by_admin_niho_user_id)
     VALUES ($1,'合成の主催者','Synthetic Host','PERSON','host-terms-synthetic-v1',clock_timestamp(),'OWNER',$2,NULL) ON CONFLICT DO NOTHING`,
    [providerId, hostAccountId]);
  return { providerId, nihoUserId: hostAccountId };
}

const NAME = "合成 販売者";
async function saveDisclosure(pool: Pool, owner: HostActor, name = NAME, expectedVersion: number | null = null) {
  return new ProviderSellerDisclosureRepository(pool).save(owner, {
    commandId: randomUUID(), expectedVersion,
    disclosure: {
      method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: name, representativeName: null, publicAddress: "東京都 合成区 1-2-3",
      publicPhone: "+81 3 0000 0000", publicEmail: "seller@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true,
    },
  }, { agentSales: true });
}

const choice = (over: Partial<AgentSalesChoiceInput> = {}): AgentSalesChoiceInput => ({
  commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGENT_AGREEMENT, accepted: true, platformAccountId: PLATFORM,
  receivingAgentName: RECEIVER, payoutDelayDays: 3, sellerDisclosureUrl: "https://travel.example.test/experiences/agent-walk/seller", ...over,
});

/** A draft with a schedule, a photo and sale terms, ready to choose a plan and open. */
async function product(pool: Pool, owner: HostActor, slug = "agent-walk") {
  const publications = new ExperiencePublicationRepository(pool);
  const draft = await publications.createDraft(owner, { slug, publicTitle: "Synthetic agent walk", content: manuscript, currency: "JPY", unitAmount: 10_000 });
  const rule: ScheduleRule = {
    id: `${slug}-daily`, timeZone: "Asia/Tokyo", startsOn: day(-1), localStartTime: "10:00", durationMinutes: 90,
    capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await new ExperienceStore(pool).saveScheduleRule(owner, draft.id, rule, null, randomUUID());
  const photoId = randomUUID();
  await publications.addMedia(owner, draft.id, {
    id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: createHash("sha256").update(slug).digest("hex"),
    width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
  });
  await pool.query(
    `INSERT INTO experience_product_sale_terms (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,booking_questions,booking_questions_fingerprint,conditions_version)
     VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`, [owner.providerId, draft.id, emptyQuestions]);
  return { draft, rule };
}

const fresh = () => ({ stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() });
async function open(pool: Pool, owner: HostActor, productId: string, agentCheck: { agreementVersion: string; accountCheck: { stripeConnectAccountRef: string; checkedAtUtc: string } | null } = { agreementVersion: AGENT_AGREEMENT, accountCheck: fresh() }) {
  const publications = new ExperiencePublicationRepository(pool);
  const current = await publications.getProduct(owner, productId);
  const state = await publications.getState(owner, productId);
  return publications.openBooking(owner, productId, {
    expectedDraftVersion: current.version, expectedStateVersion: state?.version ?? null, consentVersion: CONSENT, checks: CHECKS, agentCheck,
  });
}

const request = (slug: string, offerId: string, email: string, over: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput => ({
  slug, offerId, occurrenceDate: day(3), adultCount: 1, childCount: 0, expectedTotalYen: 10_000, bookingQuestionsFingerprint: emptyQuestions,
  answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT, conditionsConsentVersion: null, salesPlanRevision: 1,
  guestName: "Synthetic Guest", guestEmail: email, guestLanguage: "JA", clientRequestKey: randomUUID(), ...over,
});


const CHARGE = "ch_AgentCharge0001";
const ACCOUNT = "acct_HostPayout0001";

interface World { readonly owner: HostActor; readonly repo: AgentPayoutRepository; readonly pool: Pool; readonly cancellations: BookingCancellations; paid(n: number): Promise<string>; ids(): Promise<string[]> }

/** A host with agent sales open, and a way to pay for bookings of 10,000 yen (the payout's rows are made by the repository). */
async function world(pool: Pool, providerId = PROVIDER): Promise<World> {
  const owner = await agentOwner(pool, providerId, `${providerId}@example.test`);
  const guests = new GuestBookingRepository(pool);
  const store = new ExperienceStore(pool);
  const { draft, rule } = await product(pool, owner, providerId === PROVIDER ? "agent-walk" : `agent-walk-${providerId}`);
  await saveDisclosure(pool, owner);
  await new ProviderAgentSales(pool).choose(owner, draft.id, choice());
  await open(pool, owner, draft.id);
  let counter = 0;
  return {
    owner, pool, repo: new AgentPayoutRepository(pool), cancellations: new BookingCancellations(pool),
    async paid(n: number): Promise<string> {
      const started = await guests.startGuestBooking({ ...request(draft.slug, rule.id, `g${n}-${counter}@example.test`), agentSalesEnabled: true });
      counter += 1;
      await guests.attachCheckoutSession(started.publicBookingId, `cs_test_agent_${providerId}_${n}_${counter}`);
      await store.confirmBookingPayment({ providerId }, {
        publicBookingId: started.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: `pi_Agent${counter}Paid${n}Test0001`,
        stripeEventId: `evt_Agent${providerId.replace(/\W/g, "")}${counter}Paid${n}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      });
      return started.publicBookingId;
    },
    async ids() { return (await pool.query("SELECT id::text FROM experience_agent_payouts ORDER BY booking_id")).rows.map((row) => String(row.id)); },
  };
}

/** Moves a payout's experience into the past so it is due now. */
const makeDue = (pool: Pool, publicBookingId: string) => pool.query(
  `UPDATE experience_agent_payouts p SET experience_end_at=clock_timestamp()-interval '10 days',due_at=clock_timestamp()-interval '7 days',next_check_at=clock_timestamp()
     FROM bookings b WHERE b.provider_id=p.provider_id AND b.id=p.booking_id AND b.public_booking_id=$1::uuid`, [publicBookingId]);
const payoutOf = async (pool: Pool, publicBookingId: string) => (await pool.query(
  `SELECT p.*,p.id::text AS id FROM experience_agent_payouts p JOIN bookings b ON b.provider_id=p.provider_id AND b.id=p.booking_id WHERE b.public_booking_id=$1::uuid`, [publicBookingId])).rows[0]!;
const refund = (pool: Pool, publicBookingId: string, amount: number, status: "SUCCEEDED" | "PENDING" | "FAILED") => pool.query(
  `INSERT INTO booking_refunds (id,provider_id,booking_id,command_id,kind,amount,currency,refund_application_fee,requested_by,stripe_payment_ref,status,stripe_refund_ref,settled_at)
   SELECT $2::uuid,b.provider_id,b.id,$3::uuid,'PARTIAL',$4,'JPY',false,'SUPPORT',b.stripe_payment_ref,$5,
          CASE WHEN $5='PENDING' OR $5='SUCCEEDED' THEN 're_'||replace($2::text,'-','') END,CASE WHEN $5 IN ('SUCCEEDED','FAILED') THEN clock_timestamp() END
     FROM bookings b WHERE b.public_booking_id=$1::uuid`, [publicBookingId, randomUUID(), randomUUID(), amount, status]);
const dispute = (pool: Pool, publicBookingId: string, amount: number, status: string) => pool.query(
  `INSERT INTO managed_booking_disputes (provider_id,booking_id,stripe_dispute_ref,amount,currency,status,stripe_event_id,occurred_at)
   SELECT b.provider_id,b.id,'dp_'||replace($2::text,'-',''),$3,'JPY',$4,'evt_'||replace($2::text,'-',''),clock_timestamp() FROM bookings b WHERE b.public_booking_id=$1::uuid`,
  [publicBookingId, randomUUID(), amount, status]);
const destination = async (pool: Pool) => {
  const owner = (await pool.query("SELECT niho_user_id FROM provider_memberships WHERE provider_id=$1 AND role='OWNER'", [PROVIDER])).rows[0]!.niho_user_id as string;
  const id = randomUUID();
  await pool.query("INSERT INTO experience_connect_accounts (id,provider_id,purpose,stripe_account_ref,creation_params,created_by_host_account_id) VALUES ($1,$2,'PAYOUT',$3,'{}'::jsonb,$4)", [id, PROVIDER, ACCOUNT, owner]);
  return { connectAccountId: id, accountRef: ACCOUNT };
};
const charge = { ref: CHARGE, amount: 10_000, currency: "JPY" };

describe("the host's share", () => {
  it("is 85% of what is left after refunds and lost disputes, the fee rounded down", () => {
    assert.deepEqual(agentPayoutAmounts(10_000, 2_000, 0), { net: 8_000, fee: 1_200, payout: 6_800 });
    assert.deepEqual(agentPayoutAmounts(10_000, 0, 0), { net: 10_000, fee: 1_500, payout: 8_500 });
    assert.deepEqual(agentPayoutAmounts(9_999, 0, 1_000), { net: 8_999, fee: 1_349, payout: 7_650 });
    assert.deepEqual(agentPayoutAmounts(10_000, 10_000, 0), { net: 0, fee: 0, payout: 0 });
    assert.throws(() => agentPayoutAmounts(10_000, 8_000, 3_000));
  });
});

describe("agent payouts: the ledger", { skip }, () => {
  it("makes a row for a confirmed agent-sales booking with a captured payment only, due at the end plus the delay", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const confirmed = await w.paid(1);
      // A held (unpaid) booking, and a payment under review, make no row.
      const guests = new GuestBookingRepository(pool);
      const held = await guests.startGuestBooking({ ...request("agent-walk", `agent-walk-daily`, "held@example.test"), agentSalesEnabled: true });
      const review = await w.paid(2);
      await pool.query("UPDATE bookings SET status='PAYMENT_REVIEW',confirmed_at=NULL WHERE public_booking_id=$1::uuid", [review]);
      assert.deepEqual(await w.repo.initializeMissing(), { initialized: 1, failed: 0 });
      assert.deepEqual(await w.repo.initializeMissing(), { initialized: 0, failed: 0 });
      const row = await payoutOf(pool, confirmed);
      assert.deepEqual([row.status, Number(row.captured_amount), Number(row.niho_fee_amount), Number(row.payout_amount), row.payout_delay_days], ["SCHEDULED", 10_000, 1_500, 8_500, 3]);
      assert.equal(new Date(row.due_at).getTime() - new Date(row.experience_end_at).getTime(), 3 * 86_400_000);
      assert.equal((await pool.query("SELECT 1 FROM experience_agent_payouts p JOIN bookings b ON b.id=p.booking_id WHERE b.public_booking_id=ANY($1::uuid[])", [[held.publicBookingId, review]])).rowCount, 0);
      // A booking that stops being an agent sale (a 20% or Direct snapshot) is not picked.
      const other = await w.paid(3);
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER USER");
      await pool.query("UPDATE bookings SET seller_snapshot=jsonb_set(seller_snapshot,'{salesPlan}','\"MANAGED_20\"') WHERE public_booking_id=$1::uuid", [other]);
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER USER");
      assert.equal((await w.repo.initializeMissing()).initialized, 0);
      const events = await pool.query("SELECT event_type,actor FROM experience_agent_payout_events");
      assert.deepEqual(events.rows, [{ event_type: "CREATED", actor: "system" }]);
    });
  });

  it("checks fees and the sum in the table, and the events cannot be changed", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await assert.rejects(pool.query("UPDATE experience_agent_payouts p SET niho_fee_amount=1 FROM bookings b WHERE b.id=p.booking_id AND b.public_booking_id=$1::uuid", [id]), /check/i);
      await assert.rejects(pool.query("UPDATE experience_agent_payouts p SET refunded_amount=11000 FROM bookings b WHERE b.id=p.booking_id AND b.public_booking_id=$1::uuid", [id]), /check/i);
      await assert.rejects(pool.query("UPDATE experience_agent_payouts p SET status='SUBMITTING' FROM bookings b WHERE b.id=p.booking_id AND b.public_booking_id=$1::uuid", [id]), /check/i);
      await assert.rejects(pool.query("UPDATE experience_agent_payouts p SET captured_amount=9000 FROM bookings b WHERE b.id=p.booking_id AND b.public_booking_id=$1::uuid", [id]), /immutable|check/i);
      await assert.rejects(pool.query("DELETE FROM experience_agent_payouts"), /never deleted/);
      await assert.rejects(pool.query("UPDATE experience_agent_payout_events SET actor='x'"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM experience_agent_payout_events"), /append-only/);
    });
  });

  it("rests until the due date, then asks for the destination; refunds, failures, disputes and a suspension hold it", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      const [payoutId] = await w.ids();
      assert.deepEqual(await w.repo.claimDue(), [payoutId!], "a new row is checked at once");
      assert.deepEqual(await w.repo.prepare(payoutId!, new Date()), { kind: "idle" });
      assert.deepEqual(await w.repo.claimDue(), [], "before its due date it rests");
      assert.equal(new Date((await payoutOf(pool, id)).next_check_at).getTime(), new Date((await payoutOf(pool, id)).due_at).getTime());

      await makeDue(pool, id);
      // A refund being made holds it (and the trigger wakes the row at once).
      await refund(pool, id, 2_000, "PENDING");
      await pool.query("UPDATE experience_agent_payouts SET next_check_at=clock_timestamp()+interval '1 day'");
      await refund(pool, id, 1, "PENDING");
      assert.deepEqual(await w.repo.claimDue(), [payoutId!], "the refund's change put it up for a check");
      await w.repo.prepare(payoutId!);
      assert.deepEqual([(await payoutOf(pool, id)).status, (await payoutOf(pool, id)).hold_reason], ["SCHEDULED", "REFUND_PENDING"]);
      await pool.query("UPDATE booking_refunds SET status='FAILED',stripe_refund_ref=NULL,settled_at=clock_timestamp()");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp()");
      await w.repo.prepare(payoutId!);
      assert.equal((await payoutOf(pool, id)).hold_reason, "REFUND_FAILED");
      await pool.query("UPDATE booking_refunds SET closed_at=clock_timestamp()");
      await dispute(pool, id, 500, "UNDER_REVIEW");
      await w.repo.prepare(payoutId!);
      assert.equal((await payoutOf(pool, id)).hold_reason, "DISPUTE_OPEN");
      await pool.query("UPDATE managed_booking_disputes SET status='WARNING_CLOSED'");
      await pool.query("UPDATE experience_providers SET operations_suspended_at=clock_timestamp(),operations_suspension_code='TEST',operations_suspended_by_niho_user_id='admin-x' WHERE id=$1", [PROVIDER]);
      await w.repo.prepare(payoutId!);
      assert.equal((await payoutOf(pool, id)).hold_reason, "PROVIDER_SUSPENDED");
      await pool.query("UPDATE experience_providers SET operations_suspended_at=NULL,operations_suspension_code=NULL,operations_suspended_by_niho_user_id=NULL WHERE id=$1", [PROVIDER]);
      const prepared = await w.repo.prepare(payoutId!);
      assert.equal(prepared.kind, "destination");
      assert.equal((await payoutOf(pool, id)).hold_reason, null);
    });
  });

  it("recalculates after refunds (10,000 less 2,000 gives 1,200 and 6,800), and a full refund cancels it", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      const full = await w.paid(2);
      await w.repo.initializeMissing();
      await makeDue(pool, id); await makeDue(pool, full);
      await refund(pool, id, 2_000, "SUCCEEDED");
      await refund(pool, full, 10_000, "SUCCEEDED");
      for (const payoutId of await w.repo.claimDue(10)) await w.repo.prepare(payoutId);
      const row = await payoutOf(pool, id);
      assert.deepEqual([Number(row.refunded_amount), Number(row.niho_fee_amount), Number(row.payout_amount)], [2_000, 1_200, 6_800]);
      assert.equal((await payoutOf(pool, full)).status, "CANCELLED");
      // A lost dispute counts like a refund.
      await dispute(pool, id, 1_000, "LOST");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp()");
      await w.repo.prepare(row.id);
      assert.deepEqual([Number((await payoutOf(pool, id)).disputed_amount), Number((await payoutOf(pool, id)).payout_amount)], [1_000, 5_950]);
    });
  });

  it("claims with SKIP LOCKED and a lease, so two runs never take the same row", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      await w.paid(1); await w.paid(2); await w.paid(3);
      await w.repo.initializeMissing();
      const [a, b] = await Promise.all([w.repo.claimDue(2), w.repo.claimDue(2)]);
      assert.equal(new Set([...a, ...b]).size, a.length + b.length);
      assert.equal(a.length + b.length, 3);
      assert.deepEqual(await w.repo.claimDue(5), []);
    });
  });

  it("begins one transfer: a command, the amount and the destination fixed; the answer is recorded once", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      await w.repo.claimDue();
      const prepared = await w.repo.prepare(payoutId!);
      assert.equal(prepared.kind, "destination");
      const dest = await destination(pool);
      assert.equal(await w.repo.begin(payoutId!, { destination: dest, charge: { ...charge, amount: 9_000 } }), null, "a Charge of another amount stops the payout");
      assert.deepEqual([(await payoutOf(pool, id)).status, (await payoutOf(pool, id)).issue_code], ["REVIEW_REQUIRED", "charge_mismatch"]);
      await w.repo.adminAct("admin-1", id, { action: "RECALCULATE", expectedVersion: Number((await payoutOf(pool, id)).version) });
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = await w.repo.begin(payoutId!, { destination: dest, charge });
      assert.ok(command);
      assert.deepEqual([command.amount, command.currency, command.destinationAccountId, command.chargeRef, command.transferGroup], [8_500, "JPY", ACCOUNT, CHARGE, `niho-experience-agent-payout:${id}`]);
      assert.equal((await payoutOf(pool, id)).status, "SUBMITTING");
      assert.equal((await w.repo.prepare(payoutId!)).kind, "reconcile");
      assert.equal(await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "unknown" }), "RESULT_UNKNOWN");
      assert.equal(await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" }), "TRANSFERRED");
      assert.equal(await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" }), "TRANSFERRED", "the same answer again is the same");
      await assert.rejects(w.repo.recordTransfer(payoutId!, randomUUID(), { kind: "unknown" }), StoreConflictError);
      assert.equal(Number((await payoutOf(pool, id)).submitted_amount), 8_500);
    });
  });

  it("takes back what a later refund makes too much: a reversal first, then later payouts' offsets, then the office", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const first = await w.paid(1);
      const second = await w.paid(2);
      await w.repo.initializeMissing();
      await makeDue(pool, first);
      const [firstId, secondId] = [(await payoutOf(pool, first)).id as string, (await payoutOf(pool, second)).id as string];
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(firstId);
      const command = (await w.repo.begin(firstId, { destination: dest, charge }))!;
      await w.repo.recordTransfer(firstId, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
      // 3,000 refunded after the payout: the share becomes 5,950, so 2,550 is too much.
      await refund(pool, first, 3_000, "SUCCEEDED");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL WHERE id=$1::uuid", [firstId]);
      assert.ok((await w.repo.claimDue(10)).includes(firstId));
      await w.repo.prepare(firstId);
      const detail = (await w.repo.getForBooking(first))!;
      assert.deepEqual(detail.adjustments.map((a) => [a.reason, a.amount, a.reversalAmount, a.status]), [["REFUND", 2_550, 2_550, "REVERSAL_PENDING"]]);
      await w.repo.prepare(firstId);
      assert.equal((await w.repo.getForBooking(first))!.adjustments.length, 1, "the same excess is not claimed twice");
      const claimed = await w.repo.claimDueReversals();
      assert.deepEqual(claimed.map((c) => [c.stripeTransferRef, c.amount]), [["tr_AgentTransfer0001", 2_550]]);
      // Stripe cannot take it back: the whole amount waits for later payouts.
      assert.equal(await w.repo.recordReversal(claimed[0]!.adjustmentId, { kind: "insufficient_balance" }), "OFFSET_PENDING");
      // The second booking's payout absorbs it (8,500 less 2,550).
      await makeDue(pool, second);
      await w.repo.claimDue(10); await w.repo.prepare(secondId);
      const next = (await w.repo.begin(secondId, { destination: dest, charge }))!;
      assert.equal(next.amount, 5_950);
      const after = (await w.repo.getForBooking(first))!;
      assert.deepEqual([after.adjustments[0]!.status, after.adjustments[0]!.remainingAmount], ["OFFSET_APPLIED", 0]);
      assert.deepEqual((await pool.query("SELECT amount::int AS amount FROM experience_agent_payout_offsets")).rows, [{ amount: 2_550 }]);
      assert.equal(Number((await payoutOf(pool, second)).offset_amount), 2_550);
      await assert.rejects(pool.query("UPDATE experience_agent_payout_offsets SET amount=1"), /append-only/);
    });
  });

  it("records a reversal, and escalates what waits 90 days to the office, who can record a loss", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
      await dispute(pool, id, 4_000, "LOST");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp()");
      await w.repo.prepare(payoutId!);
      const [reversal] = await w.repo.claimDueReversals();
      // 10,000 less 4,000 gives a share of 5,100, so 3,400 of the 8,500 is too much.
      assert.deepEqual([reversal!.amount], [3_400]);
      assert.equal(await w.repo.recordReversal(reversal!.adjustmentId, { kind: "reversed", stripeReversalRef: "trr_AgentReversal0001" }), "REVERSED");
      assert.equal(Number((await payoutOf(pool, id)).reversed_amount), 3_400);
      assert.equal((await w.repo.getForBooking(id))!.adjustments[0]!.reason, "DISPUTE");
      // A second, larger loss: 8,000 lost gives share 1,700; the rest of the transfer (5,100) is reversible.
      await dispute(pool, id, 4_000, "LOST");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp()");
      await w.repo.prepare(payoutId!);
      const second = (await w.repo.getForBooking(id))!.adjustments[1]!;
      assert.deepEqual([second.amount, second.status], [3_400, "REVERSAL_PENDING"]);
      const [again] = await w.repo.claimDueReversals();
      assert.equal(await w.repo.recordReversal(again!.adjustmentId, { kind: "review_required", issueCode: "agent_payout_reversal_amount_too_large" }), "REVIEW_REQUIRED");
      assert.equal((await w.repo.listAttention()).some((item) => item.kind === "ADJUSTMENT" && item.status === "REVIEW_REQUIRED"), true);
      const detail = (await w.repo.getForBooking(id))!;
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: detail.adjustments[1]!.version, adjustmentId: again!.adjustmentId }), /note/);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: 99, adjustmentId: again!.adjustmentId, note: "x" }), StoreConflictError);
      const done = await w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: detail.adjustments[1]!.version, adjustmentId: again!.adjustmentId, note: "NIHO が負担" });
      assert.equal(done.adjustments[1]!.status, "LOSS_RECORDED");
      assert.equal(done.events[0]!.actor, "admin-1");
      // An amount that waited 90 days goes to the office.
      await pool.query("INSERT INTO experience_agent_payout_adjustments (id,payout_id,provider_id,booking_id,reason,status,amount,remaining_amount,created_at,offset_pending_since) SELECT $1::uuid,id,provider_id,booking_id,'REFUND','OFFSET_PENDING',100,100,clock_timestamp(),clock_timestamp()-interval '91 days' FROM experience_agent_payouts", [randomUUID()]);
      assert.equal(await w.repo.escalateStaleOffsets(new Date()), 1);
    });
  });

  it("waits for a payout account, mails the host once per date and stage, and asks the office after 90 days", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const due = new Date((await payoutOf(pool, id)).due_at);
      const at = (days: number) => new Date(due.getTime() + days * 86_400_000 + 1_000);
      const first = await w.repo.awaitAccount(payoutId!, "payout_account_missing", at(0));
      assert.deepEqual(first, { status: "AWAITING_ACCOUNT", mailQueued: true });
      assert.equal((await w.repo.awaitAccount(payoutId!, "payout_account_missing", at(0))).mailQueued, false, "once per date and stage");
      assert.equal((await w.repo.awaitAccount(payoutId!, "payout_account_missing", at(7))).mailQueued, true);
      assert.equal((await w.repo.awaitAccount(payoutId!, "payout_account_missing", at(30))).mailQueued, true);
      assert.equal((await pool.query("SELECT 1 FROM outbox_messages WHERE topic='host.mail.agent_payout_account_needed'")).rowCount, 3);
      // The mail job reads them: to the OWNER while the payout waits, nothing once it no longer does.
      const outbox = new HostMailOutbox(pool);
      const claim = await outbox.claimAgentPayoutMails({ limit: 1, leaseSeconds: 60 });
      assert.equal(claim.mails.length, 1);
      assert.equal(claim.mails[0]!.providerId, PROVIDER);
      assert.match(claim.mails[0]!.to ?? "", /@example\.test$/);
      await outbox.completeAgentPayoutMail(claim.mails[0]!.id);
      assert.equal((await w.repo.awaitAccount(payoutId!, "payout_account_missing", at(91))).status, "REVIEW_REQUIRED");
      assert.equal((await payoutOf(pool, id)).issue_code, "payout_account_missing_90d");
      assert.equal((await w.repo.listAttention()).length, 1);
    });
  });

  it("lets the office recreate an unknown transfer only after it checked, and close one without sending", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "unknown" });
      const version = () => payoutOf(pool, id).then((row) => Number(row.version));
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RECREATE", expectedVersion: await version() }), /Confirm/);
      // The job may still find the transfer for 23 hours from its command: neither a new one nor a close is accepted before.
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RECREATE", expectedVersion: await version(), confirmedNotSent: true }), StoreConflictError);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "CLOSE", expectedVersion: await version(), confirmedNotSent: true, note: "x" }), StoreConflictError);
      await pool.query("UPDATE experience_agent_payouts SET command_created_at=clock_timestamp()-interval '24 hours',claimed_until=clock_timestamp()+interval '5 minutes'");
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RECREATE", expectedVersion: await version(), confirmedNotSent: true }), /being worked on/);
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL");
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RECALCULATE", expectedVersion: await version() }), StoreConflictError);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RECREATE", expectedVersion: 1, confirmedNotSent: true }), StoreConflictError);
      const done = await w.repo.adminAct("admin-1", id, { action: "RECREATE", expectedVersion: await version(), confirmedNotSent: true, note: "Stripe で確認" });
      assert.equal(done.payout.status, "SCHEDULED");
      assert.equal(done.events[0]!.eventType, "OFFICE_RECREATE");
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const next = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      assert.notEqual(next.commandId, command.commandId);
      await w.repo.recordTransfer(payoutId!, next.commandId, { kind: "review_required", issueCode: "agent_payout_transfer_mismatch" });
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "CLOSE", expectedVersion: await version(), confirmedNotSent: true }), /note/);
      const closed = await w.repo.adminAct("admin-1", id, { action: "CLOSE", expectedVersion: await version(), confirmedNotSent: true, note: "別の方法で支払い済み" });
      assert.equal(closed.payout.status, "CANCELLED");
    });
  });

  it("shows an OWNER only its own provider's payouts, and stops the host's own cancellation once the transfer began", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const other = await world(pool, "provider-agent-other");
      const id = await w.paid(1);
      const early = await w.paid(2);
      const theirs = await other.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const mine = await w.repo.listForHost(w.owner);
      assert.deepEqual(mine.map((row) => row.state), ["SCHEDULED", "SCHEDULED"]);
      assert.equal(mine.some((row) => row.publicBookingId === theirs), false);
      assert.deepEqual((await other.repo.listForHost(other.owner)).map((row) => row.publicBookingId), [theirs]);
      const cohost: HostActor = { providerId: PROVIDER, nihoUserId: "someone-else" };
      await assert.rejects(w.repo.listForHost(cohost), StoreAccessDeniedError);
      // Before the transfer begins the host may cancel; after it, only the office.
      const [payoutId] = (await pool.query("SELECT p.id::text AS id FROM experience_agent_payouts p JOIN bookings b ON b.id=p.booking_id WHERE b.public_booking_id=$1::uuid", [id])).rows.map((row) => String(row.id));
      await w.repo.claimDue(10); await w.repo.prepare(payoutId!);
      await w.repo.begin(payoutId!, { destination: await destination(pool), charge });
      const refused = await w.cancellations.cancelAsHost(w.owner, id, { commandId: randomUUID(), reason: "WEATHER" });
      assert.equal(refused.outcome, "NOT_CANCELLABLE");
      const allowed = await w.cancellations.cancelAsHost(w.owner, early, { commandId: randomUUID(), reason: "WEATHER" });
      assert.equal(allowed.outcome, "CANCELLED");
    });
  });

  it("never takes a partly reversed amount twice: no resume, and sending it to later payouts keeps the reversal", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      const payoutId = (await payoutOf(pool, id)).id as string;
      // 3,000 to take back; Stripe took 1,000 of it back (a reversal exists) and the rest was stopped for the office.
      const adjustmentId = randomUUID();
      await pool.query(
        `INSERT INTO experience_agent_payout_adjustments (id,payout_id,provider_id,booking_id,reason,status,amount,reversal_amount,remaining_amount,stripe_reversal_ref,issue_code)
         SELECT $1::uuid,id,provider_id,booking_id,'REFUND','REVIEW_REQUIRED',3000,1000,2000,'trr_PartialReversal0001','offset_pending_90d' FROM experience_agent_payouts WHERE id=$2::uuid`, [adjustmentId, payoutId]);
      await pool.query("INSERT INTO experience_agent_payout_offsets (adjustment_id,from_payout_id,amount) VALUES ($1::uuid,$2::uuid,500)", [adjustmentId, payoutId]);
      const version = async () => Number((await pool.query("SELECT version FROM experience_agent_payout_adjustments WHERE id=$1::uuid", [adjustmentId])).rows[0]!.version);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "RESUME_ADJUSTMENT", expectedVersion: await version(), adjustmentId }), StoreConflictError);
      const done = await w.repo.adminAct("admin-1", id, { action: "OFFSET", expectedVersion: await version(), adjustmentId });
      const adjustment = done.adjustments[0]!;
      // 3,000 less the 1,000 Stripe took back less the 500 a later payout took: 1,500 left, and the reversal stays counted.
      assert.deepEqual([adjustment.status, adjustment.reversalAmount, adjustment.remainingAmount], ["OFFSET_PENDING", 1_000, 1_500]);
    });
  });

  it("leaves a taking-back to the job while it is being reversed, and the office acts only on what stopped", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      const payoutId = (await payoutOf(pool, id)).id as string;
      const make = async (status: string) => {
        const adjustmentId = randomUUID();
        await pool.query(
          `INSERT INTO experience_agent_payout_adjustments (id,payout_id,provider_id,booking_id,reason,status,amount,reversal_amount,remaining_amount,issue_code,offset_pending_since)
           SELECT $1::uuid,id,provider_id,booking_id,'REFUND',$3,1000,CASE WHEN $3 IN ('REVERSAL_PENDING','RESULT_UNKNOWN') THEN 1000 ELSE 0 END,
                  CASE WHEN $3 IN ('REVERSAL_PENDING','RESULT_UNKNOWN') THEN 0 ELSE 1000 END,CASE WHEN $3='REVIEW_REQUIRED' THEN 'x' END,
                  CASE WHEN $3='OFFSET_PENDING' THEN clock_timestamp() END
             FROM experience_agent_payouts WHERE id=$2::uuid`, [adjustmentId, payoutId, status]);
        return adjustmentId;
      };
      const version = async (adjustmentId: string) => Number((await pool.query("SELECT version FROM experience_agent_payout_adjustments WHERE id=$1::uuid", [adjustmentId])).rows[0]!.version);
      const pending = await make("REVERSAL_PENDING");
      for (const action of ["OFFSET", "LOSS", "RESUME_ADJUSTMENT"] as const) {
        await assert.rejects(w.repo.adminAct("admin-1", id, { action, expectedVersion: await version(pending), adjustmentId: pending, note: "x" }), StoreConflictError, action);
      }
      // An unknown reversal: only after the office checked, and not while the job holds it.
      const unknown = await make("RESULT_UNKNOWN");
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "OFFSET", expectedVersion: await version(unknown), adjustmentId: unknown }), /Confirm/);
      await pool.query("UPDATE experience_agent_payout_adjustments SET claimed_until=clock_timestamp()+interval '5 minutes' WHERE id=$1::uuid", [unknown]);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "OFFSET", expectedVersion: await version(unknown), adjustmentId: unknown, confirmedNotSent: true }), /being worked on/);
      await pool.query("UPDATE experience_agent_payout_adjustments SET claimed_until=NULL WHERE id=$1::uuid", [unknown]);
      const moved = await w.repo.adminAct("admin-1", id, { action: "OFFSET", expectedVersion: await version(unknown), adjustmentId: unknown, confirmedNotSent: true });
      assert.equal(moved.adjustments.find((a) => a.id === unknown)!.status, "OFFSET_PENDING");
    });
  });

  it("claiming a reversal raises its version, so a screen opened before is refused", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
      await refund(pool, id, 3_000, "SUCCEEDED");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL");
      await w.repo.prepare(payoutId!);
      const before = (await w.repo.getForBooking(id))!.adjustments[0]!;
      assert.equal((await w.repo.claimDueReversals()).length, 1);
      assert.equal((await w.repo.getForBooking(id))!.adjustments[0]!.version, before.version + 1);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: before.version, adjustmentId: before.id, note: "x" }), StoreConflictError);
    });
  });

  it("does not look at a sent payout again until a refund or dispute changes", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
      await pool.query("UPDATE experience_agent_payouts SET next_check_at=clock_timestamp()");
      assert.deepEqual(await w.repo.claimDue(), [payoutId!]);
      await w.repo.prepare(payoutId!);
      assert.equal((await pool.query("SELECT next_check_at='infinity' AS never FROM experience_agent_payouts")).rows[0]!.never, true);
      assert.deepEqual(await w.repo.claimDue(), []);
      await dispute(pool, id, 500, "UNDER_REVIEW");
      assert.deepEqual(await w.repo.claimDue(), [payoutId!], "the dispute's trigger woke it");
    });
  });

  it("stops an emptied payout that already spent kept amounts, and a host cannot cancel a payout stopped for review", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const spent = await w.paid(1);
      const stopped = await w.paid(2);
      await w.repo.initializeMissing();
      await makeDue(pool, spent); await makeDue(pool, stopped);
      await pool.query("UPDATE experience_agent_payouts p SET offset_amount=100 FROM bookings b WHERE b.id=p.booking_id AND b.public_booking_id=$1::uuid", [spent]);
      await refund(pool, spent, 10_000, "SUCCEEDED");
      const spentId = (await payoutOf(pool, spent)).id as string;
      await w.repo.claimDue(10); await w.repo.prepare(spentId);
      assert.deepEqual([(await payoutOf(pool, spent)).status, (await payoutOf(pool, spent)).issue_code], ["REVIEW_REQUIRED", "offset_spent_payout_empty"]);
      // A payout with a command that stopped for review is still the office's, not the host's, to cancel.
      const stoppedId = (await payoutOf(pool, stopped)).id as string;
      await w.repo.prepare(stoppedId);
      const command = (await w.repo.begin(stoppedId, { destination: await destination(pool), charge }))!;
      await w.repo.recordTransfer(stoppedId, command.commandId, { kind: "review_required", issueCode: "agent_payout_transfer_mismatch" });
      assert.equal((await w.cancellations.cancelAsHost(w.owner, stopped, { commandId: randomUUID(), reason: "WEATHER" })).outcome, "NOT_CANCELLABLE");
    });
  });

  it("starts the 90 days when an amount began to wait, records the move, and starts again when the office sends it back to waiting", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      const payoutId = (await payoutOf(pool, id)).id as string;
      const insert = async (since: string) => {
        const adjustmentId = randomUUID();
        await pool.query(
          `INSERT INTO experience_agent_payout_adjustments (id,payout_id,provider_id,booking_id,reason,status,amount,remaining_amount,created_at,offset_pending_since)
           SELECT $1::uuid,id,provider_id,booking_id,'REFUND','OFFSET_PENDING',100,100,clock_timestamp()-interval '200 days',clock_timestamp()-$3::interval FROM experience_agent_payouts WHERE id=$2::uuid`, [adjustmentId, payoutId, since]);
        return adjustmentId;
      };
      await insert("10 days");
      assert.equal(await w.repo.escalateStaleOffsets(new Date()), 0, "an old adjustment that began waiting recently is not escalated");
      const old = await insert("91 days");
      assert.equal(await w.repo.escalateStaleOffsets(new Date()), 1);
      const events = (await w.repo.getForBooking(id))!.events.filter((event) => event.eventType === "REVIEW_REQUIRED");
      assert.deepEqual(events.map((event) => [event.actor, event.fromStatus, event.toStatus, event.issueCode, event.amount]), [["system", "OFFSET_PENDING", "REVIEW_REQUIRED", "offset_pending_90d", 100]]);
      const version = Number((await pool.query("SELECT version FROM experience_agent_payout_adjustments WHERE id=$1::uuid", [old])).rows[0]!.version);
      await w.repo.adminAct("admin-1", id, { action: "OFFSET", expectedVersion: version, adjustmentId: old });
      assert.equal(await w.repo.escalateStaleOffsets(new Date()), 0, "sent back to waiting, its 90 days start again");
    });
  });

  it("checks the destination under the lock: a payout account retired or changed after it was read sends nothing", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      await pool.query("UPDATE experience_connect_accounts SET retired_at=clock_timestamp(),retired_by='admin-1' WHERE id=$1::uuid", [dest.connectAccountId]);
      assert.equal(await w.repo.begin(payoutId!, { destination: dest, charge }), null);
      assert.deepEqual([(await payoutOf(pool, id)).status, (await payoutOf(pool, id)).issue_code, (await payoutOf(pool, id)).command_id], ["AWAITING_ACCOUNT", "payout_account_changed", null]);
      await pool.query("UPDATE experience_agent_payouts SET status='SCHEDULED',claimed_until=NULL");
      const owner = (await pool.query("SELECT niho_user_id FROM provider_memberships WHERE provider_id=$1 AND role='OWNER'", [PROVIDER])).rows[0]!.niho_user_id as string;
      const next = randomUUID();
      await pool.query("INSERT INTO experience_connect_accounts (id,provider_id,purpose,stripe_account_ref,creation_params,created_by_host_account_id) VALUES ($1,$2,'PAYOUT','acct_HostPayout0002','{}'::jsonb,$3)", [next, PROVIDER, owner]);
      assert.equal(await w.repo.begin(payoutId!, { destination: { connectAccountId: next, accountRef: ACCOUNT }, charge }), null);
      assert.equal((await payoutOf(pool, id)).status, "AWAITING_ACCOUNT");
    });
  });

  it("lists the host's payouts of one month (by the payment's month in Japan), with what was actually sent", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      const month = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
      const other = month === "2020-01" ? "2020-02" : "2020-01";
      assert.deepEqual((await w.repo.listForHost(w.owner, { month })).map((row) => [row.publicBookingId, row.sentAmount]), [[id, null]]);
      assert.deepEqual(await w.repo.listForHost(w.owner, { month: other }), []);
      await assert.rejects(w.repo.listForHost(w.owner, { month: "2026-13" }), /month/);
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      await w.repo.begin(payoutId!, { destination: await destination(pool), charge });
      assert.equal((await w.repo.listForHost(w.owner, { month }))[0]!.sentAmount, 8_500);
    });
  });

  it("extends a claim's lease only with its own token, raises the version, and keeps the office out while it lives", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [claim] = await w.repo.claimDueLeased(5, 30);
      assert.ok(claim);
      const before = await payoutOf(pool, id);
      assert.equal(await w.repo.extendLease(claim.id, "2000-01-01T00:00:00.000000"), null, "another claim's token does not extend it");
      const token = await w.repo.extendLease(claim.id, claim.token, 600);
      assert.ok(token && token !== claim.token);
      const after = await payoutOf(pool, id);
      assert.equal(Number(after.version), Number(before.version) + 1);
      assert.ok(new Date(after.claimed_until).getTime() - Date.now() > 500_000, "the lease runs again from now");
      assert.equal(await w.repo.extendLease(claim.id, claim.token, 600), null, "the old token no longer holds the claim");
      // While it lives the office is refused, and a screen opened before is refused by version.
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "CLOSE", expectedVersion: Number(after.version), note: "x" }), /being worked on/);
      // A lease that ran out and was taken by another run cannot be extended by the first.
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=clock_timestamp()-interval '1 second'");
      assert.equal(await w.repo.extendLease(claim.id, token!, 600), null, "expired");
      const [second] = await w.repo.claimDueLeased(5, 30);
      assert.equal(second!.id, claim.id);
      assert.equal(await w.repo.extendLease(claim.id, token!, 600), null, "the first run lost it");
      assert.ok(await w.repo.extendLease(claim.id, second!.token, 600));
    });
  });

  it("extends a taking-back's lease the same way", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const id = await w.paid(1);
      await w.repo.initializeMissing();
      await makeDue(pool, id);
      const [payoutId] = await w.ids();
      const dest = await destination(pool);
      await w.repo.claimDue(); await w.repo.prepare(payoutId!);
      const command = (await w.repo.begin(payoutId!, { destination: dest, charge }))!;
      await w.repo.recordTransfer(payoutId!, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
      await refund(pool, id, 3_000, "SUCCEEDED");
      await pool.query("UPDATE experience_agent_payouts SET claimed_until=NULL");
      await w.repo.prepare(payoutId!);
      const [reversal] = await w.repo.claimDueReversals(5, 30);
      assert.ok(reversal);
      assert.equal(await w.repo.extendReversalLease(reversal.adjustmentId, "2000-01-01T00:00:00.000000", 600), null);
      const token = await w.repo.extendReversalLease(reversal.adjustmentId, reversal.leaseToken, 600);
      assert.ok(token);
      const adjustment = (await w.repo.getForBooking(id))!.adjustments[0]!;
      // The office is refused while it lives (here: a stopped state would be needed, so the refusal is the lease's or the state's), and an older screen by version.
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: reversal.leaseToken ? adjustment.version - 1 : 0, adjustmentId: adjustment.id, note: "x" }), StoreConflictError);
      await assert.rejects(w.repo.adminAct("admin-1", id, { action: "LOSS", expectedVersion: adjustment.version, adjustmentId: adjustment.id, note: "x" }), StoreConflictError);
    });
  });

  it("sends a booking whose dispute was decided: the ledger's rows (won, closed) let it through to the destination", async () => {
    await withDb(async (pool) => {
      const w = await world(pool);
      const won = await w.paid(1);
      const open = await w.paid(2);
      await w.repo.initializeMissing();
      await makeDue(pool, won); await makeDue(pool, open);
      await dispute(pool, won, 1_000, "WON");
      await dispute(pool, open, 1_000, "UNDER_REVIEW");
      const preparedWon = await w.repo.prepare((await payoutOf(pool, won)).id as string);
      assert.equal(preparedWon.kind, "destination");
      assert.deepEqual(preparedWon.kind === "destination" ? [preparedWon.disputeCount, preparedWon.refundedAmount] : null, [1, 0]);
      assert.equal(Number((await payoutOf(pool, won)).payout_amount), 8_500, "a won dispute takes nothing off");
      // An open one still holds it.
      assert.equal((await w.repo.prepare((await payoutOf(pool, open)).id as string)).kind, "idle");
      assert.equal((await payoutOf(pool, open)).hold_reason, "DISPUTE_OPEN");
      // A partly lost one is taken off by its amount alone.
      await pool.query("UPDATE managed_booking_disputes SET status='LOST',amount=400 WHERE provider_id=$1 AND status='UNDER_REVIEW'", [PROVIDER]);
      const lost = await w.repo.prepare((await payoutOf(pool, open)).id as string);
      assert.equal(lost.kind, "destination");
      assert.equal(Number((await payoutOf(pool, open)).payout_amount), 8_160);
    });
  });
});
