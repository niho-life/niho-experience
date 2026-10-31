import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { BookingCancellations, type RefundSubmission } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreError, StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import type { HostSaleEntry } from "../src/host-sales.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 売上 (#91) against a real schema: the ledger of guest bookings as the OWNER reads it. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const editorA = { providerId: "provider-a", nihoUserId: "editor-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
const support = { nihoUserId: "support-admin-1" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const ACCOUNT = "acct_SampleA0001";
/** 日本時間の月の境界: 2026-11-01T00:00+09:00 and 2026-12-01T00:00+09:00. */
const OCTOBER = { from: "2026-09-30T15:00:00.000Z", to: "2026-10-31T15:00:00.000Z" };
const NOVEMBER = { from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" };

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 30,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly cancellations: BookingCancellations;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `host_sales_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
       VALUES ('provider-a','owner-a','OWNER',true), ('provider-a','editor-a','EDITOR',true), ('provider-b','owner-b','OWNER',true)`,
    );
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    // NIHO support off: 10 %.
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, cancellations: new BookingCancellations(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let events = 0;
/** A booking for 2 adults and a child (¥7,500; NIHO's 10 % is ¥750) paid at `paidAtUtc`, in `currency`. */
async function paid(context: Context, guestEmail: string, paidAtUtc: string, currency = "JPY", amount = 7500): Promise<GuestBookingStart> {
  const request: StartGuestBookingInput = {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(5), adultCount: 2, childCount: 1, expectedTotalYen: 7500,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: `Guest ${guestEmail.split("@")[0]}`, guestEmail, guestLanguage: "EN", clientRequestKey: randomUUID(),
  };
  const start = await context.guests.startGuestBooking(request);
  events += 1;
  await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_${events}`,
    stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: paidAtUtc, amount, currency,
  });
  return start;
}

/** Stripe's refund event for `submission`, dated `atUtc`. */
async function refundEvent(context: Context, submission: RefundSubmission, status: "pending" | "succeeded" | "failed", atUtc: string): Promise<void> {
  events += 1;
  await context.cancellations.applyRefundEvent({
    publicBookingId: submission.publicBookingId, refundId: submission.refundId, stripeRefundRef: `re_test_${submission.refundId.slice(0, 8)}`,
    connectedAccountId: submission.connectedAccountId, stripePaymentRef: submission.stripePaymentRef, amount: submission.amount,
    currency: submission.currency, status, failureCode: status === "failed" ? "expired_or_canceled_card" : null,
    stripeEventId: `evt_refund_${events}`, stripeEventType: status === "failed" ? "refund.failed" : "refund.updated", eventOccurredAtUtc: atUtc,
  });
}

/** What a test compares of an entry. */
function line(entry: HostSaleEntry) {
  return [entry.kind, entry.amount, entry.currency, entry.platformFeeAmount, entry.providerAmount, entry.feeEstimated, entry.refund?.kind ?? null, entry.refund?.status ?? null];
}

describe("売上: the ledger of guest bookings for the OWNER", { skip: !databaseUrl }, () => {
  it("reads each month in Japan's time with NIHO's fee, full and partial refunds, a reversed refund and another currency", async () => {
    await withSchema(async (context) => {
      // The last second of October in Japan, and the first of November.
      const october = await paid(context, "late-october@example.com", "2026-10-31T14:59:59.000Z");
      const november = await paid(context, "early-november@example.com", "2026-10-31T15:00:00.000Z");
      // The host cancels it: the whole ¥7,500 and NIHO's ¥750 go back.
      const full = await context.cancellations.cancelAsHost(ownerA, november.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      await refundEvent(context, full.refunds[0]!, "succeeded", "2026-11-02T01:00:00.000Z");
      // Support refunds part of one: ¥3,333 and its share of the fee (333.3 → ¥333), still on its way.
      const partial = await paid(context, "partial@example.com", "2026-11-03T01:00:00.000Z");
      const part = await context.cancellations.cancelAsSupport(support, partial.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "PARTIAL", amount: 3333 } });
      await refundEvent(context, part.refunds[0]!, "pending", "2026-11-04T01:00:00.000Z");
      // Stripe accepts a refund, then fails it: the money and NIHO's fee come back.
      const reversed = await paid(context, "reversed@example.com", "2026-11-05T01:00:00.000Z");
      const failing = await context.cancellations.cancelAsHost(ownerA, reversed.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" });
      await refundEvent(context, failing.refunds[0]!, "pending", "2026-11-06T01:00:00.000Z");
      await refundEvent(context, failing.refunds[0]!, "failed", "2026-11-07T01:00:00.000Z");
      // Paid in another currency than the booking's: under review, with no fee to tell.
      const dollars = await paid(context, "dollars@example.com", "2026-11-08T01:00:00.000Z", "USD", 5000);
      // A refund Stripe has not accepted yet is not in the ledger.
      const waiting = await paid(context, "waiting@example.com", "2026-11-09T01:00:00.000Z");
      await context.cancellations.cancelAsHost(ownerA, waiting.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });

      const first = await context.guests.listGuestSalesForHost(ownerA, OCTOBER);
      assert.equal(first.firstEntryAtUtc, "2026-10-31T14:59:59.000Z");
      assert.deepEqual(first.entries.map(line), [["PAYMENT", 7500, "JPY", 750, 6750, false, null, null]]);
      assert.deepEqual(first.entries.map((entry) => [entry.key, entry.publicBookingId, entry.productTitle, entry.bookingStatus, entry.adultCount, entry.childCount, entry.guestName]),
        [[`payment:${october.publicBookingId}`, october.publicBookingId, "Synthetic walk", "CONFIRMED", 2, 1, "Guest late-october"]]);
      assert.equal(first.entries[0]!.localDate, day(5));
      assert.equal(first.entries[0]!.localStartTime, "10:00");

      const second = await context.guests.listGuestSalesForHost(ownerA, NOVEMBER);
      assert.equal(second.firstEntryAtUtc, "2026-10-31T14:59:59.000Z");
      // The latest first.
      assert.deepEqual(second.entries.map((entry) => [entry.publicBookingId, ...line(entry)]), [
        [waiting.publicBookingId, "PAYMENT", 7500, "JPY", 750, 6750, false, null, null],
        [dollars.publicBookingId, "PAYMENT", 5000, "USD", null, null, false, null, null],
        [reversed.publicBookingId, "REFUND_REVERSAL", 7500, "JPY", 750, 6750, false, "FULL", "FAILED"],
        [reversed.publicBookingId, "REFUND", -7500, "JPY", -750, -6750, false, "FULL", "FAILED"],
        [reversed.publicBookingId, "PAYMENT", 7500, "JPY", 750, 6750, false, null, null],
        [partial.publicBookingId, "REFUND", -3333, "JPY", -333, -3000, true, "PARTIAL", "PENDING"],
        [partial.publicBookingId, "PAYMENT", 7500, "JPY", 750, 6750, false, null, null],
        [november.publicBookingId, "REFUND", -7500, "JPY", -750, -6750, false, "FULL", "SUCCEEDED"],
        [november.publicBookingId, "PAYMENT", 7500, "JPY", 750, 6750, false, null, null],
      ]);
      assert.equal(second.entries.find((entry) => entry.publicBookingId === dollars.publicBookingId)?.bookingStatus, "PAYMENT_REVIEW");
      assert.deepEqual(second.entries.filter((entry) => entry.kind !== "PAYMENT").map((entry) => entry.key), [
        `refund-reversal:${failing.refunds[0]!.refundId}`, `refund:${failing.refunds[0]!.refundId}`, `refund:${part.refunds[0]!.refundId}`, `refund:${full.refunds[0]!.refundId}`,
      ]);
      // Neither Stripe's IDs nor the guest's address leave the store.
      const json = JSON.stringify(second);
      assert.doesNotMatch(json, /pi_sample|evt_|re_test|acct_|@example\.com/);
    });
  });

  it("keeps a refund before its reversal when Stripe dates both the same second", async () => {
    await withSchema(async (context) => {
      const booking = await paid(context, "same-second@example.com", "2026-11-03T01:00:00.000Z");
      const cancelled = await context.cancellations.cancelAsHost(ownerA, booking.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" });
      await refundEvent(context, cancelled.refunds[0]!, "pending", "2026-11-04T01:00:00.000Z");
      await refundEvent(context, cancelled.refunds[0]!, "failed", "2026-11-04T01:00:00.000Z");
      const sales = await context.guests.listGuestSalesForHost(ownerA, NOVEMBER);
      // The fee goes back with the refund and comes back with its reversal: ¥750 kept in all, ¥6,750 to the host.
      assert.deepEqual(sales.entries.map(line), [
        ["REFUND_REVERSAL", 7500, "JPY", 750, 6750, false, "FULL", "FAILED"],
        ["REFUND", -7500, "JPY", -750, -6750, false, "FULL", "FAILED"],
        ["PAYMENT", 7500, "JPY", 750, 6750, false, null, null],
      ]);
      assert.equal(sales.entries.reduce((sum, entry) => sum + entry.platformFeeAmount!, 0), 750);
      assert.equal(sales.entries.reduce((sum, entry) => sum + entry.providerAmount!, 0), 6750);
    });
  });

  it("keeps amounts once the guest's details are erased, and reads an empty window and provider", async () => {
    await withSchema(async (context) => {
      const booking = await paid(context, "erased@example.com", "2026-11-10T01:00:00.000Z");
      await context.pool.query(
        `UPDATE booking_guests SET guest_name = NULL, guest_email = NULL, guest_email_key = NULL, guest_phone = NULL, note = NULL, answers = NULL, utm = NULL, pii_erased_at = clock_timestamp()
          WHERE booking_id = (SELECT id FROM bookings WHERE public_booking_id = $1::uuid)`,
        [booking.publicBookingId],
      );
      const read = await context.guests.listGuestSalesForHost(ownerA, NOVEMBER);
      assert.deepEqual(read.entries.map((entry) => [entry.guestName, ...line(entry)]), [[null, "PAYMENT", 7500, "JPY", 750, 6750, false, null, null]]);
      assert.deepEqual(await context.guests.listGuestSalesForHost(ownerA, OCTOBER), { entries: [], firstEntryAtUtc: "2026-11-10T01:00:00.000Z" });
      // Another provider's OWNER reads only their own (none).
      assert.deepEqual(await context.guests.listGuestSalesForHost(ownerB, NOVEMBER), { entries: [], firstEntryAtUtc: null });
    });
  });

  it("is the current OWNER's only, and takes a bounded window", async () => {
    await withSchema(async (context) => {
      await assert.rejects(context.guests.listGuestSalesForHost(editorA, NOVEMBER), StoreAccessDeniedError);
      await assert.rejects(context.guests.listGuestSalesForHost({ providerId: "provider-a", nihoUserId: "owner-b" }, NOVEMBER), StoreAccessDeniedError);
      await assert.rejects(context.guests.listGuestSalesForHost({ ...ownerA, calendarRoleCeiling: "EDITOR" }, NOVEMBER), StoreAccessDeniedError);
      await context.pool.query("UPDATE provider_memberships SET active = false WHERE niho_user_id = 'owner-a'");
      await assert.rejects(context.guests.listGuestSalesForHost(ownerA, NOVEMBER), StoreAccessDeniedError);
      await assert.rejects(context.guests.listGuestSalesForHost(ownerB, { from: NOVEMBER.to, to: NOVEMBER.from }), StoreValidationError);
      await assert.rejects(context.guests.listGuestSalesForHost(ownerB, { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" }), StoreValidationError);
    });
  });
});

describe("この口座への入金: the Stripe accounts of the OWNER's sales here", { skip: !databaseUrl }, () => {
  const product = (id: string, account: string) => context.pool.query(
    `INSERT INTO experience_products
       (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
     VALUES ('provider-a',$1,$1,'PUBLISHED','Synthetic product','{}','JPY',3000,'terms-v1','seller-provider-a',$2,'Sample Seller A')`,
    [id, account],
  );
  const terms = (id: string) => context.guests.setSaleTerms(ownerA, id, {
    childPricing: null, minimumParticipants: 1, maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
  });
  let context: Context;

  it("reads the accounts of products sold here and of the bookings' seller snapshots, and nothing else", async () => {
    await withSchema(async (current) => {
      context = current;
      assert.deepEqual(await context.guests.listPayoutAccountsForHost(ownerA), [ACCOUNT]);
      // The booking keeps the account it was paid on after the product moves to another.
      await paid(context, "moved@example.com", "2026-11-10T01:00:00.000Z");
      await context.pool.query("UPDATE experience_products SET stripe_connect_account_ref = 'acct_SampleA0002' WHERE id = 'walk'");
      // Not sold here (no sale terms), or not an account ID: not read.
      await product("not-here", "acct_SampleA0003");
      await product("synthetic", "seller-account-ref");
      await terms("synthetic");
      assert.deepEqual(await context.guests.listPayoutAccountsForHost(ownerA), [ACCOUNT, "acct_SampleA0002"]);
      assert.deepEqual(await context.guests.listPayoutAccountsForHost(ownerB), []);
    });
  });

  it("is the current OWNER's only, and refuses a provider with more accounts than one read takes", async () => {
    await withSchema(async (current) => {
      context = current;
      await assert.rejects(context.guests.listPayoutAccountsForHost(editorA), StoreAccessDeniedError);
      await assert.rejects(context.guests.listPayoutAccountsForHost({ providerId: "provider-a", nihoUserId: "owner-b" }), StoreAccessDeniedError);
      for (const n of [4, 5, 6, 7]) {
        await product(`more-${n}`, `acct_SampleA000${n}`);
        await terms(`more-${n}`);
      }
      assert.equal((await context.guests.listPayoutAccountsForHost(ownerA)).length, 5);
      await product("more-8", "acct_SampleA0008");
      await terms("more-8");
      await assert.rejects(context.guests.listPayoutAccountsForHost(ownerA), StoreError);
    });
  });
});
