import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sessionBookingRef } from "./booking-access.ts";
import { cancellationTermsOf, freeCancellationDeadlineUtc } from "./cancellation-terms.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { publicBookingIdOf, requireBookingsOwner, sessionKeyOf, type HostGuestSessionKey } from "./host-guest-bookings.ts";
import { enqueueCancellationNotification } from "./host-notification-outbox.ts";
import { lockProviderInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { GuestCancellationPolicy, HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 取消と返金 (#285 slice 7, migration 0030, docs/guest-booking.md「取消と返金（第7段）」) of the guest bookings made on
 * this site. Three people may cancel:
 *  - the guest, on their booking page (slice 6's session): before free cancellation ends, cancelled with a full
 *    refund; after it, "Ask to cancel" opens a request for NIHO support and the booking stays confirmed;
 *  - the provider's OWNER, one booking or a whole session: always a full refund (the host's decision);
 *  - NIHO support (Admin): a full or partial refund, the guests' requests, and payments under review.
 * Every action is one command (a UUID): the same command returns what it did the first time, another command on a
 * booking already cancelled changes nothing and says so. The booking row is locked under the provider inventory
 * lock, as every status change is. A refund is a row of its own (REQUESTED until Stripe answers); this module never
 * calls Stripe: the caller sends the returned refunds (on the seller's account, the refund's id as Stripe's
 * idempotency key) and records Stripe's answer, and the webhook confirms the end. A refund is never marked done
 * before Stripe says it is, and a booking never gets a second full refund.
 */

export const CANCELLATION_ACTORS = ["GUEST", "HOST", "SUPPORT"] as const;
export type CancellationActor = (typeof CANCELLATION_ACTORS)[number];

/** Why a booking was cancelled: a fixed list, so the guest's email words it in English and nothing free-form leaks. */
export const CANCELLATION_REASONS = ["GUEST_REQUEST", "HOST_UNAVAILABLE", "WEATHER", "ILLNESS", "LATE_PAYMENT", "OTHER"] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];
/** What a host picks from for one booking. */
export const HOST_CANCELLATION_REASONS = ["HOST_UNAVAILABLE", "WEATHER", "ILLNESS", "GUEST_REQUEST", "OTHER"] as const satisfies readonly CancellationReason[];
/** For a whole session: the guest did not ask. */
export const SESSION_CANCELLATION_REASONS = ["WEATHER", "ILLNESS", "HOST_UNAVAILABLE", "OTHER"] as const satisfies readonly CancellationReason[];
/** Support's own cancellations; LATE_PAYMENT belongs to resolving a payment under review. */
export const SUPPORT_CANCELLATION_REASONS = ["GUEST_REQUEST", "HOST_UNAVAILABLE", "WEATHER", "ILLNESS", "OTHER"] as const satisfies readonly CancellationReason[];

export const BOOKING_CANCELLATION_LIMITS = {
  /** The host's or support's own note (never shown to the guest). */
  noteMax: 1000,
  /** Support's words to a guest whose request it declines. */
  declineMessageMax: 2000,
  /** A refund Stripe has not answered for this long shows in support's list. */
  unansweredRefundMinutes: 10,
  /** A refund Stripe accepted but has not finished for this long shows there too (to look at in Stripe). */
  unfinishedRefundDays: 7,
  queueLimitMax: 200,
  /** サポートONの予約の一覧 (#121/#128): one page's default and maximum. */
  supportBookingsLimitDefault: 50,
  supportBookingsLimitMax: 100,
  /** Bookings one session's cancellation may take. */
  sessionBookingsMax: 500,
  /**
   * 返金の自動再送 (#285 slice 7b, migration 0031): the job sends a refund Stripe has not accepted again at most this many
   * times, waiting 2, 4, 8 … minutes between tries (refundResendBackoffMaxSeconds at most); after that the refund stays
   * requested for support (the queue shows it as before).
   */
  refundAutoSendAttempts: 8,
  /** The wait after the n-th try is this times 2^n seconds (2, 4, 8 … minutes), at most refundResendBackoffMaxSeconds. */
  refundResendBackoffBaseSeconds: 60,
  refundResendBackoffMaxSeconds: 3600,
  /** Refunds one claim may take. */
  refundClaimLimitMax: 50,
  refundLeaseSecondsMin: 30,
  refundLeaseSecondsMax: 3600,
  /**
   * How long support's 「もう一度送る」 holds a refund, so that the job (or a second click) does not send it at the same
   * time. The same as the job's lease (EXPERIENCE_JOB_LIMITS.refundLeaseSeconds: a test keeps them equal).
   */
  refundSendLeaseSeconds: 120,
} as const;

/** The guest's emails about a cancellation; the mail job sends them (GuestMailOutbox.claimBookingNotices). */
export const GUEST_NOTICE_TOPICS = {
  cancelled: "booking.cancelled",
  refunded: "booking.refunded",
  requestDeclined: "booking.cancellation_declined",
} as const;
export type GuestNoticeTopic = (typeof GUEST_NOTICE_TOPICS)[keyof typeof GUEST_NOTICE_TOPICS];

export type RefundStatus = "REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
/** A Stripe Refund's status. */
export type StripeRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

/** One refund for the caller to send to Stripe. Every field comes from the stored booking and refund. */
export interface RefundSubmission {
  /** Ours: Stripe's idempotency key and the refund's metadata carry it. */
  readonly refundId: string;
  readonly publicBookingId: string;
  /** The seller's account (Direct charge): the refund is made there. */
  readonly connectedAccountId: string;
  readonly stripePaymentRef: string;
  readonly kind: "FULL" | "PARTIAL";
  readonly amount: number;
  readonly currency: string;
  /** NIHO's fee goes back with every refund, in proportion to the refunded amount (docs: 返金と手数料). */
  readonly refundApplicationFee: boolean;
}

export type CancellationOutcome =
  /** The booking is cancelled (and its refund requested). */
  | "CANCELLED"
  /** The guest's request is open for support. */
  | "REQUESTED"
  /** Support declined the guest's request; the booking stays confirmed. */
  | "DECLINED"
  /** What the page showed is no longer so (free cancellation ended); nothing changed. */
  | "CHANGED"
  /** Nothing to do: already cancelled, not in a state this action takes, or the experience is over. */
  | "NOT_CANCELLABLE"
  /** A failed refund was tried again, or a refund Stripe never answered is sent again. */
  | "REFUND_RETRIED"
  /** A failed refund support settled by hand. */
  | "REFUND_CLOSED";

export interface CancellationResult {
  readonly outcome: CancellationOutcome;
  /** The same command again: what it did the first time. */
  readonly repeated: boolean;
  /** The bookings it changed (public IDs); a session's cancellation lists each. */
  readonly bookingIds: readonly string[];
  /** Refunds to send to Stripe now: this command's, while Stripe has not accepted them. Record the answer with recordRefundSubmission. */
  readonly refunds: readonly RefundSubmission[];
}

export interface GuestCancellationInput {
  readonly commandId: string;
  /** FULL_REFUND is the legacy 100% choice; POLICY_CANCEL accepts the snapshotted configured refund rate. */
  readonly choice: "FULL_REFUND" | "POLICY_CANCEL" | "REQUEST";
  /** The free cancellation deadline the page showed (GuestBookingView.freeCancellationUntilUtc); null when none. */
  readonly shownDeadlineUtc: string | null;
}

export interface HostCancellationInput {
  readonly commandId: string;
  readonly reason: CancellationReason;
  readonly note?: string | null;
}

/** An Admin NIHO verified (current ADMIN role); the store records who acted. */
export interface SupportActor {
  readonly nihoUserId: string;
}

/** Full: the whole payment. Partial: the amount support enters. NIHO's fee is returned in proportion to either refund. */
export type SupportRefundChoice = { readonly kind: "FULL" } | { readonly kind: "PARTIAL"; readonly amount: number };

export interface SupportCancellationInput {
  readonly commandId: string;
  readonly expectedSnapshot?: string;
  readonly reason: CancellationReason;
  readonly note?: string | null;
  readonly refund: SupportRefundChoice;
}

export type CancellationRequestDecision =
  | { readonly commandId: string; readonly expectedSnapshot?: string; readonly decision: "APPROVE"; readonly refund: SupportRefundChoice; readonly note?: string | null }
  | { readonly commandId: string; readonly expectedSnapshot?: string; readonly decision: "DECLINE"; readonly message: string };

export const SUPPORT_OPERATION_ACTIONS = ["CANCEL", "APPROVE_REQUEST", "DECLINE_REQUEST", "RESOLVE_PAYMENT_REVIEW", "RETRY_REFUND", "CLOSE_REFUND"] as const;
export type SupportOperationAction = (typeof SUPPORT_OPERATION_ACTIONS)[number];

export type SupportOperationPreviewInput =
  | { readonly action: "CANCEL" | "APPROVE_REQUEST"; readonly publicBookingId: string; readonly refund: SupportRefundChoice }
  | { readonly action: "DECLINE_REQUEST" | "RESOLVE_PAYMENT_REVIEW"; readonly publicBookingId: string }
  | { readonly action: "RETRY_REFUND" | "CLOSE_REFUND"; readonly refundId: string };

export interface SupportOperationPreview {
  readonly action: SupportOperationAction;
  readonly expectedSnapshot: string;
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly experienceTitle: string;
  readonly startUtc: string;
  readonly bookingStatus: string;
  readonly bookingStatusAfter: string;
  readonly refundAmount: number;
  readonly currency: string;
  readonly cancellationRequestStatus: string | null;
}

/** What Stripe answered to creating (or finding) a refund. */
export type StripeRefundAnswer =
  | { readonly kind: "accepted"; readonly stripeRefundRef: string; readonly status: StripeRefundStatus; readonly failureCode?: string | null }
  /** Stripe refused it for good (an invalid request, the charge already refunded, …): the refund failed. */
  | { readonly kind: "rejected"; readonly failureCode: string };

/** A verified refund event of this service (experience-payments). */
export interface RefundEventInput {
  readonly publicBookingId: string;
  readonly refundId: string;
  readonly stripeRefundRef: string;
  readonly connectedAccountId: string;
  readonly stripePaymentRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: StripeRefundStatus;
  readonly failureCode: string | null;
  readonly stripeEventId: string;
  readonly stripeEventType: string;
  readonly eventOccurredAtUtc: string;
}

export interface RefundEventResult {
  readonly status: RefundStatus;
  readonly duplicateEvent: boolean;
}

/** One booking in support's list. The guest's name only: support writes from the booking's email thread. */
export interface SupportQueueBooking {
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly experienceTitle: string;
  readonly status: string;
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
  readonly startUtc: string;
  /** null once erased. */
  readonly guestName: string | null;
  readonly totalAmount: number;
  readonly currency: string;
  readonly cancellationPolicy: GuestCancellationPolicy | null;
  readonly cancellationRefundBasisPoints: number;
  readonly freeCancellationUntilUtc: string | null;
  /** True only when this booking itself records current-version ON consent. */
  readonly supportEligible: boolean;
  /** The guest's mail server refused the address (#375), so the booking's emails are not sent. Only the kind; absent while mail is delivered. */
  readonly mailUndeliverable?: "NO_SUCH_ADDRESS" | "NO_SUCH_DOMAIN";
}

export interface SupportQueueRequest extends SupportQueueBooking {
  readonly requestId: string;
  readonly requestedAtUtc: string;
}

export interface SupportQueueReview extends SupportQueueBooking {
  /** What Stripe captured (the ledger), which a payment under review may not equal the total. */
  readonly paidAmount: number;
  readonly paidAtUtc: string | null;
}

export interface SupportQueueRefund extends SupportQueueBooking {
  readonly refundId: string;
  readonly kind: "FULL" | "PARTIAL";
  readonly amount: number;
  readonly refundStatus: "REQUESTED" | "PENDING" | "FAILED";
  readonly failureCode: string | null;
  readonly createdAtUtc: string;
}

export interface SupportQueue {
  readonly cancellationRequests: readonly SupportQueueRequest[];
  readonly paymentReviews: readonly SupportQueueReview[];
  /** Refunds Stripe has not answered for unansweredRefundMinutes or finished for unfinishedRefundDays, and failed ones nobody closed. */
  readonly refunds: readonly SupportQueueRefund[];
}

/** One page of the bookings accepted with current-version support ON consent, newest first. */
export interface SupportEnabledBookingsPage {
  readonly bookings: readonly SupportQueueBooking[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

export interface SupportEnabledBookingsOptions {
  /** 1 to supportBookingsLimitMax (default supportBookingsLimitDefault). */
  readonly limit?: number;
  /** The `nextCursor` of the page before (a booking's public ID). */
  readonly cursor?: string | null;
  /** Exactly this booking (0 or 1 rows); the cursor is then not allowed. */
  readonly publicBookingId?: string;
}

/* ---------- validation ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const STRIPE_REF = /^[A-Za-z0-9_]{1,256}$/;
const FAILURE_CODE = /^[a-z0-9_]{1,80}$/;
const HASH64 = /^[0-9a-f]{64}$/;
const POLICIES: ReadonlySet<string> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"]);
const STRIPE_STATUSES: ReadonlySet<string> = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const LOCK_COMMAND = 47;

function commandIdOf(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("commandId must be a UUID.");
  return value.toLowerCase();
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function reasonOf(value: unknown, allowed: readonly CancellationReason[]): CancellationReason {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new StoreValidationError("reason is not one of the fixed reasons.");
  return value as CancellationReason;
}

/** Optional words, trimmed: null when empty. */
function optionalText(value: unknown, path: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || NOTE_CONTROL.test(value)) throw new StoreValidationError(`${path} must be plain text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new StoreValidationError(`${path} must be at most ${max} characters.`);
  return trimmed.length === 0 ? null : trimmed;
}

function requiredText(value: unknown, path: string, max: number): string {
  const text = optionalText(value, path, max);
  if (text === null) throw new StoreValidationError(`${path} is required.`);
  return text;
}

function refundChoiceOf(value: unknown): SupportRefundChoice {
  const choice = value as SupportRefundChoice | null | undefined;
  if (choice?.kind === "FULL") return { kind: "FULL" };
  if (choice?.kind === "PARTIAL" && Number.isSafeInteger(choice.amount) && choice.amount > 0) return { kind: "PARTIAL", amount: choice.amount };
  throw new StoreValidationError("refund must be FULL, or PARTIAL with a positive amount.");
}

function expectedSnapshotOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !HASH64.test(value)) throw new StoreValidationError("expectedSnapshot must be a lowercase sha256 hash.");
  return value;
}

function supportActorOf(actor: SupportActor): string {
  assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
  return actor.nihoUserId;
}

const fingerprint = (parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

/* ---------- rows ---------- */

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function amount(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

/** The booking as this module locks it: always a guest booking (a booking_guests row). */
const BOOKING = `
  SELECT b.id::text AS id, b.provider_id, b.public_booking_id::text AS public_booking_id, b.product_id, b.occurrence_id, b.status,
         b.occurrence_snapshot, b.pricing_snapshot, b.seller_snapshot, b.stripe_payment_ref,
         (g.adult_count + g.child_count) AS party, p.public_title,
         clock_timestamp() AS db_now
    FROM bookings b
    JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
    JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id`;

interface LockedBooking {
  readonly rowId: string;
  readonly providerId: string;
  readonly publicBookingId: string;
  readonly occurrenceId: string;
  readonly status: string;
  readonly ruleId: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly policy: GuestCancellationPolicy | null;
  readonly deadlineUtc: string | null;
  readonly refundBasisPoints: number;
  readonly totalAmount: number;
  readonly currency: string;
  readonly connectedAccountId: string;
  readonly stripePaymentRef: string | null;
  readonly party: number;
  readonly title: string;
  readonly nowUtc: string;
  readonly supportEligible: boolean;
  readonly supportConsent: {
    readonly enabled: boolean;
    readonly basisPoints: number | null;
    readonly consentVersion: string | null;
    readonly agreementRevision: number | null;
  };
}

function lockedFromRow(row: DbRow): LockedBooking {
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const seller = record(row.seller_snapshot);
  const startUtc = text(occurrence.startUtc, "occurrence_snapshot.startUtc");
  const policy = typeof pricing.cancellationPolicy === "string" && POLICIES.has(pricing.cancellationPolicy) ? pricing.cancellationPolicy as GuestCancellationPolicy : null;
  const cancellation = cancellationTermsOf(pricing);
  const fee = record(pricing.platformFee);
  const supportConsent = {
    enabled: fee.supportEnabled === true,
    basisPoints: Number.isSafeInteger(fee.basisPoints) ? Number(fee.basisPoints) : null,
    consentVersion: typeof fee.supportConsentVersion === "string" ? fee.supportConsentVersion : null,
    agreementRevision: Number.isSafeInteger(fee.supportAgreementRevision) ? Number(fee.supportAgreementRevision) : null,
  };
  return {
    rowId: text(row.id, "id"),
    providerId: text(row.provider_id, "provider_id"),
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    occurrenceId: text(row.occurrence_id, "occurrence_id"),
    status: text(row.status, "status"),
    ruleId: text(occurrence.ruleId, "occurrence_snapshot.ruleId"),
    startUtc,
    endUtc: text(occurrence.endUtc, "occurrence_snapshot.endUtc"),
    policy,
    deadlineUtc: freeCancellationDeadlineUtc(startUtc, cancellation.cancellationWindowMinutesBeforeStart),
    refundBasisPoints: cancellation.refundBasisPoints,
    totalAmount: amount(pricing.totalAmount, "pricing_snapshot.totalAmount"),
    currency: text(pricing.currency, "pricing_snapshot.currency"),
    connectedAccountId: text(seller.stripeConnectAccountRef, "seller_snapshot.stripeConnectAccountRef"),
    stripePaymentRef: typeof row.stripe_payment_ref === "string" ? row.stripe_payment_ref : null,
    party: amount(row.party, "party"),
    title: text(row.public_title, "public_title"),
    nowUtc: isoValue(row, "db_now"),
    supportEligible: supportConsent.enabled
      && supportConsent.basisPoints === 1500
      && supportConsent.consentVersion !== null
      && supportConsent.consentVersion.length > 0
      && supportConsent.agreementRevision !== null
      && supportConsent.agreementRevision > 0,
    supportConsent,
  };
}

function requireBookingSupportConsent(booking: LockedBooking): void {
  if (!booking.supportEligible) throw new StoreAccessDeniedError();
}

async function lockBooking(client: PoolClient, where: string, params: readonly unknown[]): Promise<LockedBooking | null> {
  const result = await client.query<DbRow>(`${BOOKING} WHERE ${where} FOR UPDATE OF b`, params as unknown[]);
  return result.rows[0] ? lockedFromRow(result.rows[0]) : null;
}

/** Where the public ID points, without a lock: the provider whose inventory lock comes first. */
async function providerOf(pool: Pool, publicBookingId: string): Promise<string> {
  const found = await pool.query<DbRow>(
    `SELECT b.provider_id FROM bookings b JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
      WHERE b.public_booking_id = $1::uuid`,
    [publicBookingId],
  );
  if (!found.rows[0]) throw new StoreNotFoundError("guest booking");
  return text(found.rows[0].provider_id, "provider_id");
}

/* ---------- commands ---------- */

interface CommandKey {
  readonly commandId: string;
  readonly providerId: string;
  readonly actorKind: CancellationActor;
  readonly actorRef: string | null;
  readonly action: string;
  readonly fingerprint: string;
}

interface StoredResult {
  readonly outcome: CancellationOutcome;
  readonly bookingIds: readonly string[];
}

async function previousResult(client: PoolClient, key: CommandKey): Promise<StoredResult | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`booking-cancellation-command:${key.commandId}`, LOCK_COMMAND]);
  const found = await client.query<DbRow>(
    "SELECT provider_id, actor_kind, actor_ref, action, request_fingerprint, result FROM booking_cancellation_commands WHERE command_id = $1::uuid",
    [key.commandId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.provider_id !== key.providerId || row.actor_kind !== key.actorKind || (row.actor_ref ?? null) !== key.actorRef
    || row.action !== key.action || row.request_fingerprint !== key.fingerprint) {
    throw new StoreConflictError("The command ID was already used with different input.");
  }
  const result = record(row.result);
  if (typeof result.outcome !== "string" || !Array.isArray(result.bookingIds)) throw new StoreError("Database returned an invalid command result.");
  return { outcome: result.outcome as CancellationOutcome, bookingIds: result.bookingIds.map(String) };
}

async function recordResult(client: PoolClient, key: CommandKey, result: StoredResult): Promise<void> {
  await client.query(
    `INSERT INTO booking_cancellation_commands (command_id, provider_id, actor_kind, actor_ref, action, request_fingerprint, result)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
    [key.commandId, key.providerId, key.actorKind, key.actorRef, key.action, key.fingerprint, JSON.stringify(result)],
  );
}

/** This command's refunds Stripe has not accepted yet: sent (again) by the caller. */
async function unsubmittedRefunds(client: PoolClient, commandId: string): Promise<RefundSubmission[]> {
  const found = await client.query<DbRow>(
    `SELECT r.id::text AS id, r.kind, r.amount, r.currency, r.refund_application_fee, r.stripe_payment_ref,
            b.public_booking_id::text AS public_booking_id, b.seller_snapshot
       FROM booking_refunds r JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id
      WHERE r.command_id = $1::uuid AND r.status = 'REQUESTED'
      ORDER BY r.created_at, r.id`,
    [commandId],
  );
  return found.rows.map(submissionFromRow);
}

function submissionFromRow(row: DbRow): RefundSubmission {
  return {
    refundId: text(row.id, "booking_refunds.id"),
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    connectedAccountId: text(record(row.seller_snapshot).stripeConnectAccountRef, "seller_snapshot.stripeConnectAccountRef"),
    stripePaymentRef: text(row.stripe_payment_ref, "booking_refunds.stripe_payment_ref"),
    kind: row.kind === "FULL" ? "FULL" : "PARTIAL",
    amount: amount(row.amount, "booking_refunds.amount"),
    currency: text(row.currency, "booking_refunds.currency"),
    refundApplicationFee: row.refund_application_fee === true,
  };
}

/* ---------- cancelling ---------- */

interface CancelSpec {
  readonly by: CancellationActor;
  readonly reason: CancellationReason;
  readonly note: string | null;
  readonly refund: SupportRefundChoice | null;
  readonly commandId: string;
  /** The host's push (CANCELLATION): when the guest or support cancels a confirmed booking. */
  readonly notifyHost: boolean;
  /** An open request the cancellation answers (APPROVED), or closes because it went another way (CLOSED). */
  readonly requestStatus: "APPROVED" | "CLOSED";
  readonly resolvedBy: string | null;
}

/** What the guest paid (the ledger's capture of the booking's payment) and what is refunded or on its way. */
async function moneyOf(client: PoolClient, booking: LockedBooking): Promise<{ paid: number; currency: string; committed: number }> {
  if (booking.stripePaymentRef === null) throw new StoreConflictError("The booking has no payment to refund.");
  const captured = await client.query<DbRow>(
    `SELECT amount, currency FROM payment_ledger_entries
      WHERE provider_id = $1 AND booking_id = $2 AND kind = 'PAYMENT_CAPTURED' AND stripe_payment_ref = $3`,
    [booking.providerId, booking.rowId, booking.stripePaymentRef],
  );
  const row = captured.rows[0];
  if (!row) throw new StoreConflictError("The booking's payment is not in the ledger.");
  const refunds = await client.query<DbRow>(
    "SELECT COALESCE(sum(amount), 0)::text AS committed FROM booking_refunds WHERE provider_id = $1 AND booking_id = $2 AND status <> 'FAILED'",
    [booking.providerId, booking.rowId],
  );
  return { paid: amount(row.amount, "payment_ledger_entries.amount"), currency: text(row.currency, "currency"), committed: amount(refunds.rows[0]?.committed, "committed") };
}

function refundAmountFor(choice: SupportRefundChoice, money: { readonly paid: number; readonly committed: number }): { readonly kind: "FULL" | "PARTIAL"; readonly amount: number } {
  const left = money.paid - money.committed;
  if (choice.kind === "FULL") {
    if (money.committed > 0) throw new StoreConflictError("Part of this payment was refunded already; refund the rest as a partial refund.");
    if (money.paid <= 0) throw new StoreConflictError("Nothing is left to refund.");
    return { kind: "FULL", amount: money.paid };
  }
  if (choice.amount > left) throw new StoreValidationError("The refund is more than what is left of the payment.");
  if (choice.amount === money.paid) throw new StoreValidationError("A refund of the whole payment is a full refund.");
  if (choice.amount <= 0 || left <= 0) throw new StoreConflictError("Nothing is left to refund.");
  return { kind: "PARTIAL", amount: choice.amount };
}

interface SupportSnapshotState {
  readonly hash: string;
  readonly paid: number;
  readonly committed: number;
  readonly currency: string;
  readonly openRequest: boolean;
  readonly cancellationRequestStatus: string | null;
  readonly targetRefund: {
    readonly id: string;
    readonly kind: "FULL" | "PARTIAL";
    readonly amount: number;
    readonly status: RefundStatus;
    readonly closed: boolean;
  } | null;
}

async function supportSnapshot(
  client: PoolClient,
  booking: LockedBooking,
  input: { readonly action: SupportOperationAction; readonly refund?: SupportRefundChoice; readonly refundId?: string },
): Promise<SupportSnapshotState> {
  const captured = await client.query<DbRow>(
    `SELECT entry_id, amount, currency, stripe_payment_ref, stripe_event_id, occurred_at
       FROM payment_ledger_entries
      WHERE provider_id = $1 AND booking_id = $2 AND kind = 'PAYMENT_CAPTURED' AND stripe_payment_ref = $3`,
    [booking.providerId, booking.rowId, booking.stripePaymentRef],
  );
  const refundRows = await client.query<DbRow>(
    `SELECT id::text AS id, kind, amount, currency, refund_application_fee, requested_by, stripe_payment_ref, status,
            stripe_refund_ref, failure_code, submitted_at, settled_at, closed_at, superseded_by::text AS superseded_by,
            send_attempts, send_claimed_at
       FROM booking_refunds
      WHERE provider_id = $1 AND booking_id = $2
      ORDER BY created_at, id
      FOR UPDATE`,
    [booking.providerId, booking.rowId],
  );
  const requestRows = await client.query<DbRow>(
    `SELECT id::text AS id, status, resolved_at, resolved_by
       FROM booking_cancellation_requests
      WHERE provider_id = $1 AND booking_id = $2
      ORDER BY created_at, id
      FOR UPDATE`,
    [booking.providerId, booking.rowId],
  );
  const capture = captured.rows[0];
  const refunds = refundRows.rows.map((row) => ({
    id: text(row.id, "booking_refunds.id"),
    kind: row.kind === "FULL" ? "FULL" as const : "PARTIAL" as const,
    amount: amount(row.amount, "booking_refunds.amount"),
    currency: text(row.currency, "booking_refunds.currency"),
    refundApplicationFee: row.refund_application_fee === true,
    requestedBy: text(row.requested_by, "booking_refunds.requested_by"),
    stripePaymentRef: text(row.stripe_payment_ref, "booking_refunds.stripe_payment_ref"),
    status: text(row.status, "booking_refunds.status") as RefundStatus,
    stripeRefundRef: typeof row.stripe_refund_ref === "string" ? row.stripe_refund_ref : null,
    failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
    submittedAt: row.submitted_at == null ? null : isoValue(row, "submitted_at"),
    settledAt: row.settled_at == null ? null : isoValue(row, "settled_at"),
    closedAt: row.closed_at == null ? null : isoValue(row, "closed_at"),
    supersededBy: typeof row.superseded_by === "string" ? row.superseded_by : null,
    sendAttempts: amount(row.send_attempts, "booking_refunds.send_attempts"),
    sendClaimedAt: row.send_claimed_at == null ? null : isoValue(row, "send_claimed_at"),
  }));
  const requests = requestRows.rows.map((row) => ({
    id: text(row.id, "booking_cancellation_requests.id"),
    status: text(row.status, "booking_cancellation_requests.status"),
    resolvedAt: row.resolved_at == null ? null : isoValue(row, "resolved_at"),
    resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : null,
  }));
  const paid = capture ? amount(capture.amount, "payment_ledger_entries.amount") : 0;
  const currency = capture ? text(capture.currency, "payment_ledger_entries.currency") : booking.currency;
  const committed = refunds.filter((refund) => refund.status !== "FAILED").reduce((sum, refund) => sum + refund.amount, 0);
  const target = input.refundId ? refunds.find((refund) => refund.id === input.refundId) ?? null : null;
  const material = {
    version: 1,
    operation: { action: input.action, refund: input.refund ?? null, refundId: input.refundId ?? null },
    booking: {
      providerId: booking.providerId,
      publicBookingId: booking.publicBookingId,
      status: booking.status,
      occurrenceId: booking.occurrenceId,
      ruleId: booking.ruleId,
      startUtc: booking.startUtc,
      endUtc: booking.endUtc,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
      refundBasisPoints: booking.refundBasisPoints,
      supportConsent: booking.supportConsent,
      stripePaymentRef: booking.stripePaymentRef,
      connectedAccountId: booking.connectedAccountId,
    },
    capture: capture ? {
      entryId: text(capture.entry_id, "payment_ledger_entries.entry_id"),
      amount: paid,
      currency,
      stripePaymentRef: text(capture.stripe_payment_ref, "payment_ledger_entries.stripe_payment_ref"),
      stripeEventId: typeof capture.stripe_event_id === "string" ? capture.stripe_event_id : null,
      occurredAt: isoValue(capture, "occurred_at"),
    } : null,
    refunds,
    cancellationRequests: requests,
  };
  return {
    hash: fingerprint([material]),
    paid,
    committed,
    currency,
    openRequest: requests.some((request) => request.status === "OPEN"),
    cancellationRequestStatus: requests.find((request) => request.status === "OPEN")?.status ?? requests.at(-1)?.status ?? null,
    targetRefund: target ? { id: target.id, kind: target.kind, amount: target.amount, status: target.status, closed: target.closedAt !== null } : null,
  };
}

function assertExpectedSnapshot(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual) throw new StoreConflictError("The booking or refund changed after support previewed it.");
}

const fingerprintWithSnapshot = (parts: readonly unknown[], expected: string | null): string => fingerprint(expected === null ? parts : [...parts, expected]);

async function insertRefund(
  client: PoolClient,
  booking: LockedBooking,
  input: { readonly commandId: string; readonly choice: SupportRefundChoice; readonly requestedBy: CancellationActor },
): Promise<RefundSubmission> {
  const money = await moneyOf(client, booking);
  const calculated = refundAmountFor(input.choice, money);
  const { kind, amount: refundAmount } = calculated;
  const id = randomUUID();
  await client.query(
    `INSERT INTO booking_refunds
       (id, provider_id, booking_id, command_id, kind, amount, currency, refund_application_fee, requested_by, stripe_payment_ref, status)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, 'REQUESTED')`,
    [id, booking.providerId, booking.rowId, input.commandId, kind, refundAmount, money.currency, true, input.requestedBy, booking.stripePaymentRef],
  );
  return {
    refundId: id,
    publicBookingId: booking.publicBookingId,
    connectedAccountId: booking.connectedAccountId,
    stripePaymentRef: booking.stripePaymentRef!,
    kind,
    amount: refundAmount,
    currency: money.currency,
    // NIHO's fee goes back with every refund, in proportion to it (owner decision 2026-10-31, #285).
    refundApplicationFee: true,
  };
}

async function enqueueGuestNotice(client: PoolClient, booking: LockedBooking, topic: GuestNoticeTopic, key: string, payload: Record<string, string>): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
     VALUES ($1, 'booking', $2, $3, $4, $5::jsonb)
     ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
    [booking.providerId, booking.publicBookingId, topic, key, JSON.stringify({ publicBookingId: booking.publicBookingId, ...payload })],
  );
}

/** Cancels a locked CONFIRMED or PAYMENT_REVIEW booking: its seats go back, any payment refund is requested, the guest is told. */
async function cancelLocked(client: PoolClient, booking: LockedBooking, spec: CancelSpec): Promise<RefundSubmission | null> {
  const wasConfirmed = booking.status === "CONFIRMED";
  await client.query(
    `UPDATE bookings
        SET status = 'CANCELLED', confirmed_at = NULL, cancelled_at = clock_timestamp(), cancelled_by = $3,
            cancellation_reason = $4, cancellation_note = $5, updated_at = clock_timestamp()
      WHERE provider_id = $1 AND id = $2`,
    [booking.providerId, booking.rowId, spec.by, spec.reason, spec.note],
  );
  await client.query(
    `UPDATE booking_cancellation_requests SET status = $3, resolved_at = clock_timestamp(), resolved_by = $4
      WHERE provider_id = $1 AND booking_id = $2 AND status = 'OPEN'`,
    [booking.providerId, booking.rowId, spec.requestStatus, spec.resolvedBy],
  );
  const refund = spec.refund === null || booking.totalAmount === 0
    ? null
    : await insertRefund(client, booking, { commandId: spec.commandId, choice: spec.refund, requestedBy: spec.by });
  // Seats return: stored inventory counts CONFIRMED only; the calendar and channels recalculate the occurrence.
  await enqueueCalendarRecalculation(client, {
    providerId: booking.providerId, aggregateType: "schedule_occurrence", aggregateId: booking.occurrenceId, cause: "booking_cancelled",
  });
  await enqueueGuestNotice(client, booking, GUEST_NOTICE_TOPICS.cancelled, `guest-mail:cancelled:${booking.publicBookingId}`, {});
  if (spec.notifyHost && wasConfirmed) {
    await enqueueCancellationNotification(client, {
      providerId: booking.providerId, bookingId: booking.publicBookingId, experienceTitle: booking.title, startsAt: booking.startUtc, seats: Math.max(1, booking.party),
    });
  }
  return refund;
}

async function configuredGuestRefund(
  client: PoolClient,
  booking: LockedBooking,
): Promise<SupportRefundChoice | null> {
  if (booking.refundBasisPoints === 0) return null;
  const money = await moneyOf(client, booking);
  const target = Math.floor((money.paid * booking.refundBasisPoints) / 10_000);
  const amountToReturn = Math.min(money.paid - money.committed, Math.max(0, target - money.committed));
  if (amountToReturn <= 0) return null;
  if (amountToReturn === money.paid && money.committed === 0) return { kind: "FULL" };
  return { kind: "PARTIAL", amount: amountToReturn };
}

/* ---------- Stripe's answers ---------- */

function refundStatusOf(status: StripeRefundStatus): RefundStatus {
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "failed" || status === "canceled") return "FAILED";
  return "PENDING";
}

/** Moves only forward: REQUESTED → PENDING → SUCCEEDED, and to FAILED from any but FAILED (a refund can fail after it succeeded). */
function nextStatus(current: RefundStatus, wanted: RefundStatus): RefundStatus {
  if (current === "FAILED") return "FAILED";
  if (wanted === "FAILED") return "FAILED";
  if (current === "SUCCEEDED") return "SUCCEEDED";
  if (wanted === "SUCCEEDED") return "SUCCEEDED";
  return "PENDING";
}

interface LockedRefund {
  readonly id: string;
  readonly providerId: string;
  readonly bookingRowId: string;
  readonly publicBookingId: string;
  readonly status: RefundStatus;
  readonly amount: number;
  readonly currency: string;
  readonly stripePaymentRef: string;
  readonly stripeRefundRef: string | null;
  readonly connectedAccountId: string;
}

async function lockRefund(client: PoolClient, refundId: string): Promise<LockedRefund | null> {
  const found = await client.query<DbRow>(
    `SELECT r.id::text AS id, r.provider_id, r.booking_id::text AS booking_id, r.status, r.amount, r.currency, r.stripe_payment_ref,
            r.stripe_refund_ref, b.public_booking_id::text AS public_booking_id, b.seller_snapshot
       FROM booking_refunds r JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id
      WHERE r.id = $1::uuid
      FOR UPDATE OF r`,
    [refundId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    id: text(row.id, "id"),
    providerId: text(row.provider_id, "provider_id"),
    bookingRowId: text(row.booking_id, "booking_id"),
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    status: text(row.status, "status") as RefundStatus,
    amount: amount(row.amount, "amount"),
    currency: text(row.currency, "currency"),
    stripePaymentRef: text(row.stripe_payment_ref, "stripe_payment_ref"),
    stripeRefundRef: typeof row.stripe_refund_ref === "string" ? row.stripe_refund_ref : null,
    connectedAccountId: text(record(row.seller_snapshot).stripeConnectAccountRef, "seller_snapshot.stripeConnectAccountRef"),
  };
}

/**
 * Applies Stripe's word on a refund: its reference, its status (never backwards), the ledger (a REFUND entry once
 * Stripe accepted it, reversed by an ADJUSTMENT if it fails afterwards) and the guest's email once it succeeded.
 */
async function settleRefund(
  client: PoolClient,
  refund: LockedRefund,
  input: { readonly stripeRefundRef: string | null; readonly wanted: RefundStatus; readonly failureCode: string | null; readonly stripeEventId: string | null; readonly occurredAtUtc: string | null },
): Promise<RefundStatus> {
  const status = nextStatus(refund.status, input.wanted);
  const accepted = input.stripeRefundRef !== null;
  await client.query(
    `UPDATE booking_refunds
        SET status = $2,
            stripe_refund_ref = COALESCE(stripe_refund_ref, $3),
            failure_code = CASE WHEN $2 = 'FAILED' THEN COALESCE($4, failure_code, 'refund_failed') ELSE failure_code END,
            submitted_at = COALESCE(submitted_at, clock_timestamp()),
            settled_at = CASE WHEN $2 IN ('SUCCEEDED', 'FAILED') THEN COALESCE(settled_at, clock_timestamp()) ELSE NULL END,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid`,
    [refund.id, status, input.stripeRefundRef, input.failureCode],
  );
  // The money left the seller's balance once Stripe accepted the refund (whatever it says next). A refund already
  // failed stays failed: an older "pending" answer arriving after the failure must not subtract what nothing reverses.
  if (accepted && input.wanted !== "FAILED" && refund.status !== "FAILED") {
    await client.query(
      `INSERT INTO payment_ledger_entries (provider_id, entry_id, booking_id, kind, amount, currency, stripe_payment_ref, stripe_event_id, occurred_at)
       VALUES ($1, $2, $3, 'REFUND', $4, $5, $6, $7, COALESCE($8::timestamptz, clock_timestamp()))
       ON CONFLICT (provider_id, entry_id) DO NOTHING`,
      [refund.providerId, `refund:${refund.id}`, refund.bookingRowId, -refund.amount, refund.currency, refund.stripePaymentRef, input.stripeEventId, input.occurredAtUtc],
    );
  }
  if (status === "FAILED" && refund.status !== "FAILED") {
    const recorded = await client.query("SELECT 1 FROM payment_ledger_entries WHERE provider_id = $1 AND entry_id = $2", [refund.providerId, `refund:${refund.id}`]);
    if (recorded.rows[0]) {
      await client.query(
        `INSERT INTO payment_ledger_entries (provider_id, entry_id, booking_id, kind, amount, currency, stripe_payment_ref, stripe_event_id, occurred_at)
         VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5, $6, $7, COALESCE($8::timestamptz, clock_timestamp()))
         ON CONFLICT (provider_id, entry_id) DO NOTHING`,
        [refund.providerId, `refund-reversal:${refund.id}`, refund.bookingRowId, refund.amount, refund.currency, refund.stripePaymentRef, input.stripeEventId, input.occurredAtUtc],
      );
    }
  }
  if (status === "SUCCEEDED" && refund.status !== "SUCCEEDED") {
    await client.query(
      `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
       VALUES ($1, 'booking', $2, $3, $4, $5::jsonb)
       ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
      [refund.providerId, refund.publicBookingId, GUEST_NOTICE_TOPICS.refunded, `guest-mail:refunded:${refund.id}`, JSON.stringify({ publicBookingId: refund.publicBookingId, refundId: refund.id })],
    );
  }
  return status;
}

/* ---------- the support queue ---------- */

const QUEUE_BOOKING = `
  b.public_booking_id::text AS public_booking_id, b.provider_id, b.status, b.occurrence_snapshot, b.pricing_snapshot,
  g.guest_name, g.mail_suppression_classification, p.public_title`;
const QUEUE_JOINS = `
  JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
  JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id`;

/*
 * The same test as queueBookingFromRow's (and lockedFromRow's) supportEligible, in SQL, on the booking's own snapshot
 * only: never the provider's current settings. Each cast sits behind a CASE on jsonb_typeof, so a malformed snapshot is
 * simply not eligible instead of failing the read (AND does not fix the order Postgres evaluates in).
 */
const FEE = "b.pricing_snapshot->'platformFee'";
const SUPPORT_ELIGIBLE_SQL = `(
  jsonb_typeof(${FEE}) = 'object'
  AND ${FEE}->'supportEnabled' = 'true'::jsonb
  AND CASE WHEN jsonb_typeof(${FEE}->'basisPoints') = 'number' THEN (${FEE}->>'basisPoints')::numeric = 1500 ELSE false END
  AND CASE WHEN jsonb_typeof(${FEE}->'supportConsentVersion') = 'string' THEN length(${FEE}->>'supportConsentVersion') > 0 ELSE false END
  AND CASE WHEN jsonb_typeof(${FEE}->'supportAgreementRevision') = 'number'
        THEN (${FEE}->>'supportAgreementRevision')::numeric BETWEEN 1 AND 9007199254740991
         AND (${FEE}->>'supportAgreementRevision')::numeric = trunc((${FEE}->>'supportAgreementRevision')::numeric)
        ELSE false END
)`;
/** Paid bookings support may act on or answer for; holds and expired holds never were paid. */
const SUPPORT_LIST_STATUSES = "b.status IN ('CONFIRMED', 'PAYMENT_REVIEW', 'CANCELLED')";

function queueBookingFromRow(row: DbRow): SupportQueueBooking {
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const fee = record(pricing.platformFee);
  const startUtc = text(occurrence.startUtc, "occurrence_snapshot.startUtc");
  const policy = typeof pricing.cancellationPolicy === "string" && POLICIES.has(pricing.cancellationPolicy) ? pricing.cancellationPolicy as GuestCancellationPolicy : null;
  const cancellation = cancellationTermsOf(pricing);
  return {
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    providerId: text(row.provider_id, "provider_id"),
    experienceTitle: text(row.public_title, "public_title"),
    status: text(row.status, "status"),
    localDate: text(occurrence.localDate, "occurrence_snapshot.localDate"),
    localStartTime: text(occurrence.localStartTime, "occurrence_snapshot.localStartTime"),
    timeZone: text(occurrence.timeZone, "occurrence_snapshot.timeZone"),
    startUtc,
    guestName: typeof row.guest_name === "string" ? row.guest_name : null,
    totalAmount: amount(pricing.totalAmount, "pricing_snapshot.totalAmount"),
    currency: text(pricing.currency, "pricing_snapshot.currency"),
    cancellationPolicy: policy,
    cancellationRefundBasisPoints: cancellation.refundBasisPoints,
    freeCancellationUntilUtc: freeCancellationDeadlineUtc(startUtc, cancellation.cancellationWindowMinutesBeforeStart),
    supportEligible: fee.supportEnabled === true
      && fee.basisPoints === 1500
      && typeof fee.supportConsentVersion === "string"
      && fee.supportConsentVersion.length > 0
      && Number.isSafeInteger(fee.supportAgreementRevision)
      && Number(fee.supportAgreementRevision) > 0,
    ...(row.mail_suppression_classification === "NO_SUCH_ADDRESS" || row.mail_suppression_classification === "NO_SUCH_DOMAIN"
      ? { mailUndeliverable: row.mail_suppression_classification } : {}),
  };
}

/* ---------- the repository ---------- */

export class BookingCancellations {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /* ---------- the guest (their booking page's session) ---------- */

  /**
   * The guest's "Cancel and get a full refund" or "Ask to cancel" from their booking page (slice 6's session). The
   * terms are the booking's snapshot: free cancellation until 24 or 48 hours before the start gives a full refund;
   * after that (or with NONE) the guest asks support and the booking stays confirmed. Inside the transaction the
   * booking, its terms and its deadline are read again: when the page showed something no longer so (the deadline
   * passed meanwhile), nothing changes and the outcome is CHANGED. null when the session cannot act on this booking
   * (the caller answers as for a booking it cannot open).
   */
  async cancelAsGuest(sessionId: string, publicBookingId: string, input: GuestCancellationInput): Promise<CancellationResult | null> {
    const commandId = commandIdOf(input?.commandId);
    if (input.choice !== "FULL_REFUND" && input.choice !== "POLICY_CANCEL" && input.choice !== "REQUEST") {
      throw new StoreValidationError("choice must be FULL_REFUND, POLICY_CANCEL, or REQUEST.");
    }
    if (input.shownDeadlineUtc !== null) assertCanonicalInstant(input.shownDeadlineUtc, "shownDeadlineUtc");
    const located = await withTransaction(this.#pool, (client) => sessionBookingRef(client, sessionId, publicBookingId));
    if (!located) return null;
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, located.providerId);
      // The session is checked again under the lock: signed out or revoked meanwhile is null as before.
      const session = await sessionBookingRef(client, sessionId, publicBookingId);
      if (!session || session.bookingId !== located.bookingId) return null;
      const key: CommandKey = {
        commandId, providerId: located.providerId, actorKind: "GUEST", actorRef: null, action: "GUEST_CANCEL",
        fingerprint: fingerprint(["GUEST_CANCEL", publicBookingId.toLowerCase(), input.choice, input.shownDeadlineUtc]),
      };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.id = $2", [located.providerId, located.bookingId]);
      if (!booking) return null;
      const done = async (outcome: CancellationOutcome, refunds: RefundSubmission[] = []): Promise<CancellationResult> => {
        const bookingIds = outcome === "CANCELLED" || outcome === "REQUESTED" ? [booking.publicBookingId] : [];
        await recordResult(client, key, { outcome, bookingIds });
        return { outcome, repeated: false, bookingIds, refunds };
      };
      if (booking.status !== "CONFIRMED") return done("NOT_CANCELLABLE");
      const free = booking.deadlineUtc !== null && booking.deadlineUtc > booking.nowUtc;
      if (input.shownDeadlineUtc !== booking.deadlineUtc) return done("CHANGED");
      if (booking.totalAmount === 0) {
        if (booking.endUtc <= booking.nowUtc) return done("NOT_CANCELLABLE");
        await cancelLocked(client, booking, {
          by: "GUEST", reason: "GUEST_REQUEST", note: null, refund: null, commandId, notifyHost: true,
          requestStatus: "CLOSED", resolvedBy: null,
        });
        return done("CANCELLED");
      }
      if (input.choice === "FULL_REFUND" || input.choice === "POLICY_CANCEL") {
        if (!free || (input.choice === "FULL_REFUND" && booking.refundBasisPoints !== 10_000)) return done("CHANGED");
        const refundChoice = await configuredGuestRefund(client, booking);
        if (refundChoice === null) {
          await cancelLocked(client, booking, {
            by: "GUEST", reason: "GUEST_REQUEST", note: null, refund: null, commandId, notifyHost: true,
            requestStatus: "CLOSED", resolvedBy: null,
          });
          return done("CANCELLED");
        }
        const refund = await cancelLocked(client, booking, {
          by: "GUEST", reason: "GUEST_REQUEST", note: null, refund: refundChoice, commandId, notifyHost: true,
          requestStatus: "CLOSED", resolvedBy: null,
        });
        return done("CANCELLED", refund ? [refund] : []);
      }
      if (free) return done("CHANGED");
      if (booking.endUtc <= booking.nowUtc) return done("NOT_CANCELLABLE");
      // One request per booking: an open one is the answer again, and one support declined is not asked again here.
      const existing = await client.query<DbRow>(
        "SELECT status FROM booking_cancellation_requests WHERE provider_id = $1 AND booking_id = $2 AND status IN ('OPEN', 'DECLINED') ORDER BY created_at DESC LIMIT 1",
        [booking.providerId, booking.rowId],
      );
      const last = existing.rows[0]?.status;
      if (last === "DECLINED") return done("NOT_CANCELLABLE");
      if (last !== "OPEN") {
        await client.query(
          "INSERT INTO booking_cancellation_requests (id, provider_id, booking_id, status) VALUES ($1::uuid, $2, $3, 'OPEN')",
          [commandId, booking.providerId, booking.rowId],
        );
      }
      return done("REQUESTED");
    });
  }

  /* ---------- the host console (OWNER) ---------- */

  /**
   * The provider's OWNER cancels one confirmed booking: a full refund to the guest, always (the host's decision), with
   * a reason from the fixed list and an optional note of their own. The guest gets the email; the host no push for
   * their own cancellation. A payment under review is support's (NOT_CANCELLABLE here), as is a booking already cancelled.
   */
  async cancelAsHost(actor: HostActor, publicBookingId: string, input: HostCancellationInput): Promise<CancellationResult> {
    const id = publicBookingIdOf(publicBookingId);
    const commandId = commandIdOf(input?.commandId);
    const reason = reasonOf(input.reason, HOST_CANCELLATION_REASONS);
    const note = optionalText(input.note, "note", BOOKING_CANCELLATION_LIMITS.noteMax);
    return withTransaction(this.#pool, async (client) => {
      // The inventory lock first, as every status change takes it, then the OWNER check (both role checks, slice 8).
      await lockProviderInventory(client, actor.providerId);
      await requireBookingsOwner(client, actor);
      const key: CommandKey = {
        commandId, providerId: actor.providerId, actorKind: "HOST", actorRef: actor.nihoUserId, action: "HOST_CANCEL",
        fingerprint: fingerprint(["HOST_CANCEL", id, reason, note]),
      };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.public_booking_id = $2::uuid", [actor.providerId, id]);
      if (!booking || booking.status === "HOLD" || booking.status === "EXPIRED") throw new StoreNotFoundError("guest booking");
      if (booking.status !== "CONFIRMED") {
        await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
        return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
      }
      const refund = await cancelLocked(client, booking, {
        by: "HOST", reason, note, refund: { kind: "FULL" }, commandId, notifyHost: false, requestStatus: "CLOSED", resolvedBy: null,
      });
      await recordResult(client, key, { outcome: "CANCELLED", bookingIds: [booking.publicBookingId] });
      return { outcome: "CANCELLED", repeated: false, bookingIds: [booking.publicBookingId], refunds: refund ? [refund] : [] };
    });
  }

  /**
   * The provider's OWNER calls off a whole session (この回を中止): every confirmed booking of it is cancelled with a
   * full refund, and the occurrence is closed to new bookings (its seats would otherwise be on sale again). Payments
   * under review stay for support. An empty session can also be called off while its occurrence is still on sale.
   */
  async cancelSessionAsHost(actor: HostActor, session: HostGuestSessionKey, input: HostCancellationInput): Promise<CancellationResult> {
    const sessionKey = sessionKeyOf(session);
    const commandId = commandIdOf(input?.commandId);
    const reason = reasonOf(input.reason, SESSION_CANCELLATION_REASONS);
    const note = optionalText(input.note, "note", BOOKING_CANCELLATION_LIMITS.noteMax);
    return withTransaction(this.#pool, async (client) => {
      // The inventory lock first, as every status change takes it, then the OWNER check (both role checks, slice 8).
      await lockProviderInventory(client, actor.providerId);
      await requireBookingsOwner(client, actor);
      const key: CommandKey = {
        commandId, providerId: actor.providerId, actorKind: "HOST", actorRef: actor.nihoUserId, action: "HOST_CANCEL_SESSION",
        fingerprint: fingerprint(["HOST_CANCEL_SESSION", sessionKey.productId, sessionKey.offerId, sessionKey.localDate, sessionKey.localStartTime, reason, note]),
      };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const found = await client.query<DbRow>(
        `${BOOKING}
          WHERE b.provider_id = $1 AND b.status = 'CONFIRMED' AND b.product_id = $2
            AND b.occurrence_snapshot->>'ruleId' = $3 AND b.occurrence_snapshot->>'localDate' = $4 AND b.occurrence_snapshot->>'localStartTime' = $5
          ORDER BY b.id
          LIMIT $6
          FOR UPDATE OF b`,
        [actor.providerId, sessionKey.productId, sessionKey.offerId, sessionKey.localDate, sessionKey.localStartTime, BOOKING_CANCELLATION_LIMITS.sessionBookingsMax + 1],
      );
      const bookings = found.rows.map(lockedFromRow);
      // Never report a whole-session cancellation after silently truncating the confirmed bookings.
      if (bookings.length > BOOKING_CANCELLATION_LIMITS.sessionBookingsMax) throw new StoreConflictError("Too many bookings to cancel in one command.");
      const emptyOccurrences = bookings.length === 0 ? await client.query<DbRow>(
        `SELECT o.occurrence_id, o.rule_id
           FROM schedule_occurrences o
           LEFT JOIN schedule_occurrence_sales_states s
             ON s.provider_id = o.provider_id AND s.rule_id = o.rule_id AND s.occurrence_id = o.occurrence_id
          WHERE o.provider_id = $1 AND o.product_id = $2 AND o.rule_id = $3
            AND o.local_date = $4::date AND o.local_start_time = $5::time
            AND o.status = 'OPEN' AND COALESCE(s.desired_state, 'OPEN') = 'OPEN'
          FOR UPDATE OF o`,
        [actor.providerId, sessionKey.productId, sessionKey.offerId, sessionKey.localDate, sessionKey.localStartTime],
      ) : null;
      if (bookings.length === 0) {
        if (!emptyOccurrences?.rows.length) {
          await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
          return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
        }
      }
      const refunds: RefundSubmission[] = [];
      for (const booking of bookings) {
        const refund = await cancelLocked(client, booking, {
          by: "HOST", reason, note, refund: { kind: "FULL" }, commandId, notifyHost: false, requestStatus: "CLOSED", resolvedBy: null,
        });
        if (refund) refunds.push(refund);
      }
      // No new bookings for the called-off occurrence(s): what この回を中止 promises.
      const occurrences = new Map(bookings.map((booking) => [booking.occurrenceId, booking.ruleId]));
      for (const row of emptyOccurrences?.rows ?? []) occurrences.set(String(row.occurrence_id), String(row.rule_id));
      for (const occurrence of occurrences) {
        // A hold still waiting for its payment goes too: a payment that arrives for an expired hold lands in
        // PAYMENT_REVIEW (confirmBookingPayment), for support, instead of confirming a booking for a session called off.
        await client.query(
          "UPDATE bookings SET status = 'EXPIRED', updated_at = clock_timestamp() WHERE provider_id = $1 AND occurrence_id = $2 AND status = 'HOLD'",
          [actor.providerId, occurrence[0]],
        );
        await client.query(
          `INSERT INTO schedule_occurrence_sales_states (provider_id, rule_id, occurrence_id, desired_state)
           VALUES ($1, $2, $3, 'CLOSED')
           ON CONFLICT (provider_id, rule_id, occurrence_id) DO UPDATE
             SET desired_state = 'CLOSED', version = schedule_occurrence_sales_states.version + 1, updated_at = clock_timestamp()
             WHERE schedule_occurrence_sales_states.desired_state <> 'CLOSED'`,
          [actor.providerId, occurrence[1], occurrence[0]],
        );
        await enqueueCalendarRecalculation(client, {
          providerId: actor.providerId, aggregateType: "schedule_occurrence", aggregateId: occurrence[0], cause: "occurrence_sales_state_changed",
        });
      }
      const bookingIds = bookings.map((booking) => booking.publicBookingId);
      await recordResult(client, key, { outcome: "CANCELLED", bookingIds });
      return { outcome: "CANCELLED", repeated: false, bookingIds, refunds };
    });
  }

  /* ---------- NIHO support (Admin) ---------- */

  /** Read-only confirmation of the exact booking/refund state a support command will compare inside its transaction. */
  async previewSupportOperation(actor: SupportActor, input: SupportOperationPreviewInput): Promise<SupportOperationPreview> {
    supportActorOf(actor);
    if (!input || !(SUPPORT_OPERATION_ACTIONS as readonly string[]).includes(input.action)) {
      throw new StoreValidationError("action is not a support operation.");
    }
    const bookingAction = input.action === "CANCEL" || input.action === "APPROVE_REQUEST" || input.action === "DECLINE_REQUEST" || input.action === "RESOLVE_PAYMENT_REVIEW";
    const publicBookingId = bookingAction ? publicBookingIdOf((input as { publicBookingId?: string }).publicBookingId ?? "") : null;
    const rawRefundId = bookingAction ? null : (input as { refundId?: string }).refundId;
    if (rawRefundId !== null && (typeof rawRefundId !== "string" || !UUID.test(rawRefundId))) throw new StoreValidationError("refundId must be a UUID.");
    const refundId = rawRefundId?.toLowerCase() ?? null;
    const refund = input.action === "CANCEL" || input.action === "APPROVE_REQUEST" ? refundChoiceOf(input.refund) : undefined;
    const located = publicBookingId !== null
      ? await this.#pool.query<DbRow>(
        `SELECT provider_id, id::text AS booking_id FROM bookings WHERE public_booking_id = $1::uuid`,
        [publicBookingId],
      )
      : await this.#pool.query<DbRow>(
        `SELECT r.provider_id, r.booking_id::text AS booking_id FROM booking_refunds r WHERE r.id = $1::uuid`,
        [refundId],
      );
    if (!located.rows[0]) throw new StoreNotFoundError(publicBookingId === null ? "refund" : "guest booking");
    const providerId = text(located.rows[0].provider_id, "provider_id");
    const bookingRowId = text(located.rows[0].booking_id, "booking_id");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      if (refundId !== null && !await lockRefund(client, refundId)) throw new StoreNotFoundError("refund");
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.id = $2", [providerId, bookingRowId]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      const snapshot = await supportSnapshot(client, booking, { action: input.action, ...(refund ? { refund } : {}), ...(refundId ? { refundId } : {}) });
      let refundAmount = 0;
      let bookingStatusAfter = booking.status;
      if (input.action === "CANCEL") {
        if (booking.status !== "CONFIRMED") throw new StoreConflictError("The booking is not cancellable by support.");
        refundAmount = booking.totalAmount === 0 ? 0 : refundAmountFor(refund!, snapshot).amount;
        bookingStatusAfter = "CANCELLED";
      } else if (input.action === "APPROVE_REQUEST") {
        if (booking.status !== "CONFIRMED" || !snapshot.openRequest) throw new StoreConflictError("The cancellation request is no longer open.");
        refundAmount = booking.totalAmount === 0 ? 0 : refundAmountFor(refund!, snapshot).amount;
        bookingStatusAfter = "CANCELLED";
      } else if (input.action === "DECLINE_REQUEST") {
        if (booking.status !== "CONFIRMED" || !snapshot.openRequest) throw new StoreConflictError("The cancellation request is no longer open.");
      } else if (input.action === "RESOLVE_PAYMENT_REVIEW") {
        if (booking.status !== "PAYMENT_REVIEW") throw new StoreConflictError("The payment is no longer under review.");
        refundAmount = refundAmountFor({ kind: "FULL" }, snapshot).amount;
        bookingStatusAfter = "CANCELLED";
      } else if (input.action === "RETRY_REFUND") {
        const target = snapshot.targetRefund;
        if (!target || (target.status !== "REQUESTED" && (target.status !== "FAILED" || target.closed))) {
          throw new StoreConflictError("The refund cannot be retried in its current state.");
        }
        if (target.status === "FAILED") {
          refundAmount = refundAmountFor(target.kind === "FULL" ? { kind: "FULL" } : { kind: "PARTIAL", amount: target.amount }, snapshot).amount;
        } else {
          refundAmount = target.amount;
        }
      } else {
        const target = snapshot.targetRefund;
        if (!target || target.status !== "FAILED" || target.closed) throw new StoreConflictError("The failed refund is no longer open.");
      }
      return {
        action: input.action,
        expectedSnapshot: snapshot.hash,
        publicBookingId: booking.publicBookingId,
        providerId: booking.providerId,
        experienceTitle: booking.title,
        startUtc: booking.startUtc,
        bookingStatus: booking.status,
        bookingStatusAfter,
        refundAmount,
        currency: snapshot.currency,
        cancellationRequestStatus: snapshot.cancellationRequestStatus,
      };
    });
  }

  /**
   * Support cancels a confirmed booking with a full refund (NIHO's fee given back) or a partial one of the amount it
   * enters (NIHO's fee is returned in proportion to either refund). The host gets a CANCELLATION push; the guest the email.
   */
  async cancelAsSupport(actor: SupportActor, publicBookingId: string, input: SupportCancellationInput): Promise<CancellationResult> {
    const actorRef = supportActorOf(actor);
    const id = publicBookingIdOf(publicBookingId);
    const commandId = commandIdOf(input?.commandId);
    const reason = reasonOf(input.reason, SUPPORT_CANCELLATION_REASONS);
    const note = optionalText(input.note, "note", BOOKING_CANCELLATION_LIMITS.noteMax);
    const refund = refundChoiceOf(input.refund);
    const expectedSnapshot = expectedSnapshotOf(input.expectedSnapshot);
    const providerId = await providerOf(this.#pool, id);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const key: CommandKey = {
        commandId, providerId, actorKind: "SUPPORT", actorRef, action: "SUPPORT_CANCEL",
        fingerprint: fingerprintWithSnapshot(["SUPPORT_CANCEL", id, reason, note, refund], expectedSnapshot),
      };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.public_booking_id = $2::uuid", [providerId, id]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      if (expectedSnapshot !== null) assertExpectedSnapshot(expectedSnapshot, (await supportSnapshot(client, booking, { action: "CANCEL", refund })).hash);
      if (booking.status !== "CONFIRMED") {
        await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
        return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
      }
      const submission = await cancelLocked(client, booking, {
        by: "SUPPORT", reason, note, refund, commandId, notifyHost: true, requestStatus: "CLOSED", resolvedBy: actorRef,
      });
      await recordResult(client, key, { outcome: "CANCELLED", bookingIds: [booking.publicBookingId] });
      return { outcome: "CANCELLED", repeated: false, bookingIds: [booking.publicBookingId], refunds: submission ? [submission] : [] };
    });
  }

  /**
   * Support answers a guest's "Ask to cancel": approve (the booking is cancelled with the refund support chooses) or
   * decline (the booking stays confirmed and the guest gets support's message by email). NOT_CANCELLABLE when the
   * booking has no open request any more.
   */
  async resolveCancellationRequest(actor: SupportActor, publicBookingId: string, input: CancellationRequestDecision): Promise<CancellationResult> {
    const actorRef = supportActorOf(actor);
    const id = publicBookingIdOf(publicBookingId);
    const commandId = commandIdOf(input?.commandId);
    const expectedSnapshot = expectedSnapshotOf(input?.expectedSnapshot);
    let parts: unknown[];
    let approve: { refund: SupportRefundChoice; note: string | null } | null = null;
    let message: string | null = null;
    if (input.decision === "APPROVE") {
      approve = { refund: refundChoiceOf(input.refund), note: optionalText(input.note, "note", BOOKING_CANCELLATION_LIMITS.noteMax) };
      parts = ["SUPPORT_APPROVE", id, approve.refund, approve.note];
    } else if (input.decision === "DECLINE") {
      message = requiredText(input.message, "message", BOOKING_CANCELLATION_LIMITS.declineMessageMax);
      parts = ["SUPPORT_DECLINE", id, message];
    } else {
      throw new StoreValidationError("decision must be APPROVE or DECLINE.");
    }
    const providerId = await providerOf(this.#pool, id);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const key: CommandKey = { commandId, providerId, actorKind: "SUPPORT", actorRef, action: String(parts[0]), fingerprint: fingerprintWithSnapshot(parts, expectedSnapshot) };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.public_booking_id = $2::uuid", [providerId, id]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      if (expectedSnapshot !== null) assertExpectedSnapshot(expectedSnapshot, (await supportSnapshot(client, booking, { action: approve ? "APPROVE_REQUEST" : "DECLINE_REQUEST", ...(approve ? { refund: approve.refund } : {}) })).hash);
      const open = await client.query<DbRow>(
        "SELECT id::text AS id FROM booking_cancellation_requests WHERE provider_id = $1 AND booking_id = $2 AND status = 'OPEN' FOR UPDATE",
        [providerId, booking.rowId],
      );
      const requestId = open.rows[0]?.id;
      if (booking.status !== "CONFIRMED" || typeof requestId !== "string") {
        await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
        return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
      }
      if (approve) {
        const submission = await cancelLocked(client, booking, {
          by: "SUPPORT", reason: "GUEST_REQUEST", note: approve.note, refund: approve.refund, commandId, notifyHost: true, requestStatus: "APPROVED", resolvedBy: actorRef,
        });
        await recordResult(client, key, { outcome: "CANCELLED", bookingIds: [booking.publicBookingId] });
        return { outcome: "CANCELLED", repeated: false, bookingIds: [booking.publicBookingId], refunds: submission ? [submission] : [] };
      }
      await client.query(
        `UPDATE booking_cancellation_requests SET status = 'DECLINED', resolved_at = clock_timestamp(), resolved_by = $2, decline_message = $3
          WHERE id = $1::uuid`,
        [requestId, actorRef, message],
      );
      await enqueueGuestNotice(client, booking, GUEST_NOTICE_TOPICS.requestDeclined, `guest-mail:request-declined:${requestId}`, { requestId });
      await recordResult(client, key, { outcome: "DECLINED", bookingIds: [booking.publicBookingId] });
      return { outcome: "DECLINED", repeated: false, bookingIds: [booking.publicBookingId], refunds: [] };
    });
  }

  /**
   * Support resolves a payment that arrived after the guest's hold was released (PAYMENT_REVIEW, slice 4): the booking
   * is cancelled (no seat was kept) and what Stripe captured goes back in full. The host was never told of it as a
   * booking, so no push; the guest gets the email.
   */
  async resolvePaymentReview(actor: SupportActor, publicBookingId: string, input: { readonly commandId: string; readonly expectedSnapshot?: string }): Promise<CancellationResult> {
    const actorRef = supportActorOf(actor);
    const id = publicBookingIdOf(publicBookingId);
    const commandId = commandIdOf(input?.commandId);
    const expectedSnapshot = expectedSnapshotOf(input?.expectedSnapshot);
    const providerId = await providerOf(this.#pool, id);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const key: CommandKey = { commandId, providerId, actorKind: "SUPPORT", actorRef, action: "SUPPORT_RESOLVE_REVIEW", fingerprint: fingerprintWithSnapshot(["SUPPORT_RESOLVE_REVIEW", id], expectedSnapshot) };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: await unsubmittedRefunds(client, commandId) };
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.public_booking_id = $2::uuid", [providerId, id]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      if (expectedSnapshot !== null) assertExpectedSnapshot(expectedSnapshot, (await supportSnapshot(client, booking, { action: "RESOLVE_PAYMENT_REVIEW" })).hash);
      if (booking.status !== "PAYMENT_REVIEW") {
        await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
        return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
      }
      const submission = await cancelLocked(client, booking, {
        by: "SUPPORT", reason: "LATE_PAYMENT", note: null, refund: { kind: "FULL" }, commandId, notifyHost: false, requestStatus: "CLOSED", resolvedBy: actorRef,
      });
      await recordResult(client, key, { outcome: "CANCELLED", bookingIds: [booking.publicBookingId] });
      return { outcome: "CANCELLED", repeated: false, bookingIds: [booking.publicBookingId], refunds: submission ? [submission] : [] };
    });
  }

  /**
   * Support tries a refund again: a failed one becomes a new refund of the same amount (a new Stripe idempotency key;
   * the failed one is closed and points to it); one Stripe never answered is sent again as it is (the same key, and
   * the caller looks for it at Stripe first). NOT_CANCELLABLE for a refund in any other state.
   */
  async retryRefund(actor: SupportActor, refundId: string, input: { readonly commandId: string; readonly expectedSnapshot?: string }): Promise<CancellationResult> {
    const actorRef = supportActorOf(actor);
    if (typeof refundId !== "string" || !UUID.test(refundId)) throw new StoreValidationError("refundId must be a UUID.");
    const commandId = commandIdOf(input?.commandId);
    const expectedSnapshot = expectedSnapshotOf(input?.expectedSnapshot);
    const located = await this.#pool.query<DbRow>("SELECT provider_id FROM booking_refunds WHERE id = $1::uuid", [refundId]);
    if (!located.rows[0]) throw new StoreNotFoundError("refund");
    const providerId = text(located.rows[0].provider_id, "provider_id");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const key: CommandKey = { commandId, providerId, actorKind: "SUPPORT", actorRef, action: "SUPPORT_RETRY_REFUND", fingerprint: fingerprintWithSnapshot(["SUPPORT_RETRY_REFUND", refundId.toLowerCase()], expectedSnapshot) };
      const previous = await previousResult(client, key);
      if (previous) {
        const again = await unsubmittedRefunds(client, commandId);
        return { ...previous, repeated: true, refunds: again.length > 0 ? again : await this.#leaseRequested(client, refundId) };
      }
      const found = await client.query<DbRow>(
        `SELECT r.id::text AS id, r.kind, r.amount, r.status, r.closed_at, r.requested_by, r.booking_id::text AS booking_id, b.public_booking_id::text AS public_booking_id
           FROM booking_refunds r JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id
          WHERE r.id = $1::uuid FOR UPDATE OF r`,
        [refundId],
      );
      const row = found.rows[0]!;
      const bookingIds = [text(row.public_booking_id, "public_booking_id")];
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.id = $2", [providerId, row.booking_id]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      if (expectedSnapshot !== null) assertExpectedSnapshot(expectedSnapshot, (await supportSnapshot(client, booking, { action: "RETRY_REFUND", refundId: refundId.toLowerCase() })).hash);
      if (row.status === "REQUESTED") {
        await recordResult(client, key, { outcome: "REFUND_RETRIED", bookingIds });
        return { outcome: "REFUND_RETRIED", repeated: false, bookingIds, refunds: await this.#leaseRequested(client, refundId) };
      }
      if (row.status !== "FAILED" || row.closed_at !== null) {
        await recordResult(client, key, { outcome: "NOT_CANCELLABLE", bookingIds: [] });
        return { outcome: "NOT_CANCELLABLE", repeated: false, bookingIds: [], refunds: [] };
      }
      const kind = row.kind === "FULL" ? "FULL" : "PARTIAL";
      const submission = await insertRefund(client, booking!, {
        commandId,
        choice: kind === "FULL" ? { kind: "FULL" } : { kind: "PARTIAL", amount: amount(row.amount, "amount") },
        requestedBy: row.requested_by as CancellationActor,
      });
      await client.query(
        "UPDATE booking_refunds SET closed_at = clock_timestamp(), superseded_by = $2::uuid, updated_at = clock_timestamp() WHERE id = $1::uuid",
        [refundId, submission.refundId],
      );
      await recordResult(client, key, { outcome: "REFUND_RETRIED", bookingIds });
      return { outcome: "REFUND_RETRIED", repeated: false, bookingIds, refunds: [submission] };
    });
  }

  /** Support settled a failed refund by hand (another way, or the guest agreed to none): it leaves the list. */
  async closeFailedRefund(actor: SupportActor, refundId: string, input: { readonly commandId: string; readonly expectedSnapshot?: string; readonly note: string }): Promise<CancellationResult> {
    const actorRef = supportActorOf(actor);
    if (typeof refundId !== "string" || !UUID.test(refundId)) throw new StoreValidationError("refundId must be a UUID.");
    const commandId = commandIdOf(input?.commandId);
    const expectedSnapshot = expectedSnapshotOf(input?.expectedSnapshot);
    const note = requiredText(input.note, "note", BOOKING_CANCELLATION_LIMITS.noteMax);
    const located = await this.#pool.query<DbRow>("SELECT provider_id FROM booking_refunds WHERE id = $1::uuid", [refundId]);
    if (!located.rows[0]) throw new StoreNotFoundError("refund");
    const providerId = text(located.rows[0].provider_id, "provider_id");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const key: CommandKey = { commandId, providerId, actorKind: "SUPPORT", actorRef, action: "SUPPORT_CLOSE_REFUND", fingerprint: fingerprintWithSnapshot(["SUPPORT_CLOSE_REFUND", refundId.toLowerCase(), note], expectedSnapshot) };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true, refunds: [] };
      const target = await client.query<DbRow>(
        `SELECT r.booking_id::text AS booking_id FROM booking_refunds r WHERE r.id=$1::uuid FOR UPDATE`,
        [refundId],
      );
      if (!target.rows[0]) throw new StoreNotFoundError("refund");
      const booking = await lockBooking(client, "b.provider_id = $1 AND b.id = $2", [providerId, target.rows[0].booking_id]);
      if (!booking) throw new StoreNotFoundError("guest booking");
      requireBookingSupportConsent(booking);
      if (expectedSnapshot !== null) assertExpectedSnapshot(expectedSnapshot, (await supportSnapshot(client, booking, { action: "CLOSE_REFUND", refundId: refundId.toLowerCase() })).hash);
      const closed = await client.query<DbRow>(
        `UPDATE booking_refunds r SET closed_at = clock_timestamp(), close_note = $2, updated_at = clock_timestamp()
           FROM bookings b
          WHERE r.id = $1::uuid AND r.status = 'FAILED' AND r.closed_at IS NULL AND b.provider_id = r.provider_id AND b.id = r.booking_id
          RETURNING b.public_booking_id::text AS public_booking_id`,
        [refundId, note],
      );
      const bookingId = closed.rows[0]?.public_booking_id;
      const result: StoredResult = typeof bookingId === "string" ? { outcome: "REFUND_CLOSED", bookingIds: [bookingId] } : { outcome: "NOT_CANCELLABLE", bookingIds: [] };
      await recordResult(client, key, result);
      return { ...result, repeated: false, refunds: [] };
    });
  }

  /**
   * What support has to look at: open "Ask to cancel" requests, payments under review, refunds Stripe has not
   * answered (or finished) for a while and failed ones nobody closed; the oldest first, at most `limit` of each.
   */
  async supportQueue(options: { readonly limit?: number } = {}): Promise<SupportQueue> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > BOOKING_CANCELLATION_LIMITS.queueLimitMax) {
      throw new StoreValidationError(`limit must be an integer from 1 to ${BOOKING_CANCELLATION_LIMITS.queueLimitMax}.`);
    }
    const [requests, reviews, refunds] = await Promise.all([
      this.#pool.query<DbRow>(
        `SELECT q.id::text AS request_id, q.created_at AS requested_at, ${QUEUE_BOOKING}
           FROM booking_cancellation_requests q
           JOIN bookings b ON b.provider_id = q.provider_id AND b.id = q.booking_id ${QUEUE_JOINS}
          WHERE q.status = 'OPEN'
          ORDER BY q.created_at, q.id LIMIT $1`,
        [limit],
      ),
      this.#pool.query<DbRow>(
        `SELECT ${QUEUE_BOOKING}, l.amount AS paid_amount,
                (SELECT min(e.occurred_at) FROM stripe_webhook_events e
                  WHERE e.provider_id = b.provider_id AND e.booking_id = b.id AND e.outcome = 'PAYMENT_REVIEW') AS paid_at
           FROM bookings b ${QUEUE_JOINS}
           JOIN payment_ledger_entries l ON l.provider_id = b.provider_id AND l.booking_id = b.id AND l.kind = 'PAYMENT_CAPTURED' AND l.stripe_payment_ref = b.stripe_payment_ref
          WHERE b.status = 'PAYMENT_REVIEW'
          ORDER BY b.created_at, b.id LIMIT $1`,
        [limit],
      ),
      this.#pool.query<DbRow>(
        `SELECT r.id::text AS refund_id, r.kind, r.amount AS refund_amount, r.status AS refund_status, r.failure_code, r.created_at AS refund_created_at, ${QUEUE_BOOKING}
           FROM booking_refunds r
           JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id ${QUEUE_JOINS}
          WHERE (r.status = 'REQUESTED' AND r.created_at <= clock_timestamp() - make_interval(mins => $2))
             OR (r.status = 'PENDING' AND r.created_at <= clock_timestamp() - make_interval(days => $3))
             OR (r.status = 'FAILED' AND r.closed_at IS NULL)
          ORDER BY r.created_at, r.id LIMIT $1`,
        [limit, BOOKING_CANCELLATION_LIMITS.unansweredRefundMinutes, BOOKING_CANCELLATION_LIMITS.unfinishedRefundDays],
      ),
    ]);
    return {
      cancellationRequests: requests.rows.map((row) => ({ ...queueBookingFromRow(row), requestId: text(row.request_id, "request_id"), requestedAtUtc: isoValue(row, "requested_at") })),
      paymentReviews: reviews.rows.map((row) => ({
        ...queueBookingFromRow(row),
        paidAmount: amount(row.paid_amount, "paid_amount"),
        paidAtUtc: row.paid_at === null || row.paid_at === undefined ? null : isoValue(row, "paid_at"),
      })),
      refunds: refunds.rows.map((row) => ({
        ...queueBookingFromRow(row),
        refundId: text(row.refund_id, "refund_id"),
        kind: row.kind === "FULL" ? "FULL" : "PARTIAL",
        amount: amount(row.refund_amount, "refund_amount"),
        refundStatus: row.refund_status === "FAILED" ? "FAILED" : row.refund_status === "PENDING" ? "PENDING" : "REQUESTED",
        failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
        createdAtUtc: isoValue(row, "refund_created_at"),
      })),
    };
  }

  /**
   * サポートONの予約 (#121/#128): the paid bookings whose own snapshot records current-version support ON consent,
   * newest first, so support can open one that is not in supportQueue (an ordinary confirmed booking). What a row
   * carries is the queue's (the guest's name only). The cursor is the last row's public booking ID: rows strictly
   * older than it, by (created_at, id). With `publicBookingId`, that booking alone if it qualifies.
   */
  async supportEnabledBookings(options: SupportEnabledBookingsOptions = {}): Promise<SupportEnabledBookingsPage> {
    const limit = options.limit ?? BOOKING_CANCELLATION_LIMITS.supportBookingsLimitDefault;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > BOOKING_CANCELLATION_LIMITS.supportBookingsLimitMax) {
      throw new StoreValidationError(`limit must be an integer from 1 to ${BOOKING_CANCELLATION_LIMITS.supportBookingsLimitMax}.`);
    }
    const cursor = options.cursor === undefined || options.cursor === null ? null : publicBookingIdOf(options.cursor);
    const exact = options.publicBookingId === undefined ? null : publicBookingIdOf(options.publicBookingId);
    if (exact !== null && cursor !== null) throw new StoreValidationError("publicBookingId and cursor cannot be combined.");
    if (cursor !== null) {
      const known = await this.#pool.query("SELECT 1 FROM bookings WHERE public_booking_id = $1::uuid", [cursor]);
      if (known.rowCount === 0) throw new StoreValidationError("cursor is not a known booking.");
    }
    const result = await this.#pool.query<DbRow>(
      `SELECT ${QUEUE_BOOKING}
         FROM bookings b ${QUEUE_JOINS}
        WHERE ${SUPPORT_LIST_STATUSES} AND ${SUPPORT_ELIGIBLE_SQL}
          AND ($1::uuid IS NULL OR b.public_booking_id = $1::uuid)
          AND ($2::uuid IS NULL OR (b.created_at, b.id) < (SELECT c.created_at, c.id FROM bookings c WHERE c.public_booking_id = $2::uuid))
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $3`,
      [exact, cursor, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    // The SQL already holds the rule; this keeps the invariant even if the two were ever to drift apart.
    const bookings = page.map(queueBookingFromRow).filter((booking) => booking.supportEligible);
    const last = page.at(-1);
    return { bookings, nextCursor: result.rows.length > limit && last ? text(last.public_booking_id, "public_booking_id") : null };
  }

  /* ---------- sending refunds again ---------- */

  /**
   * 返金の自動再送 (#285 slice 7b, migration 0031): for the job, up to `limit` refunds Stripe has not accepted (REQUESTED),
   * oldest first, to send now. A refund waits `olderThanSeconds` after it was asked for, so the request's own send
   * goes first; it is then taken for `leaseSeconds` (and a refund the job took before is not taken again until
   * 2, 4, 8 … minutes have passed, up to an hour), so two runs never hold the same refund, and support's 「もう一度送る」
   * (which takes the same lease) never sends it at the same time as the job. Each claim counts as an attempt; after
   * BOOKING_CANCELLATION_LIMITS.refundAutoSendAttempts the job leaves the refund to support, who still sees it in
   * supportQueue and can send it. Refunds Stripe accepted (PENDING and later) and failed ones are never returned.
   * The caller sends them (the refund's id is Stripe's idempotency key, so a send that ran twice still refunds once)
   * and records the answer with recordRefundSubmission.
   */
  async claimRefundsToSend(options: { readonly limit: number; readonly olderThanSeconds: number; readonly leaseSeconds: number }): Promise<RefundSubmission[]> {
    const limit = boundedInteger(options?.limit, "limit", 1, BOOKING_CANCELLATION_LIMITS.refundClaimLimitMax);
    const olderThanSeconds = boundedInteger(options?.olderThanSeconds, "olderThanSeconds", 0, 86_400);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", BOOKING_CANCELLATION_LIMITS.refundLeaseSecondsMin, BOOKING_CANCELLATION_LIMITS.refundLeaseSecondsMax);
    const claimed = await this.#pool.query<DbRow>(
      `WITH due AS (
         SELECT r.id FROM booking_refunds r
          WHERE r.status = 'REQUESTED'
            AND r.send_attempts < $4
            AND r.created_at <= clock_timestamp() - make_interval(secs => $2::double precision)
            AND (r.send_claimed_at IS NULL OR r.send_claimed_at <= clock_timestamp() - make_interval(
                  secs => GREATEST($3::double precision, LEAST($5::double precision * power(2, LEAST(r.send_attempts, 20)), $6::double precision))))
          ORDER BY r.created_at, r.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), taken AS (
         UPDATE booking_refunds r
            SET send_attempts = r.send_attempts + 1, send_claimed_at = clock_timestamp()
           FROM due WHERE r.id = due.id
         RETURNING r.id, r.provider_id, r.booking_id, r.kind, r.amount, r.currency, r.refund_application_fee, r.stripe_payment_ref, r.created_at
       )
       SELECT r.id::text AS id, r.kind, r.amount, r.currency, r.refund_application_fee, r.stripe_payment_ref,
              b.public_booking_id::text AS public_booking_id, b.seller_snapshot
         FROM taken r JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id
        ORDER BY r.created_at, r.id`,
      [
        limit,
        olderThanSeconds,
        leaseSeconds,
        BOOKING_CANCELLATION_LIMITS.refundAutoSendAttempts,
        BOOKING_CANCELLATION_LIMITS.refundResendBackoffBaseSeconds,
        BOOKING_CANCELLATION_LIMITS.refundResendBackoffMaxSeconds,
      ],
    );
    return claimed.rows.map(submissionFromRow);
  }

  /* ---------- Stripe ---------- */

  /**
   * Records what Stripe answered when the caller created (or found) a refund: accepted with its reference and status
   * (SUCCEEDED only when Stripe says succeeded; pending stays PENDING for the webhook), or refused for good (FAILED).
   * Never moves a refund backwards: the webhook may have been first. StoreNotFoundError for an unknown refund.
   */
  async recordRefundSubmission(refundId: string, answer: StripeRefundAnswer): Promise<RefundStatus> {
    if (typeof refundId !== "string" || !UUID.test(refundId)) throw new StoreValidationError("refundId must be a UUID.");
    let wanted: RefundStatus;
    let stripeRefundRef: string | null = null;
    let failureCode: string | null = null;
    if (answer?.kind === "accepted") {
      if (typeof answer.stripeRefundRef !== "string" || !STRIPE_REF.test(answer.stripeRefundRef)) throw new StoreValidationError("stripeRefundRef is invalid.");
      if (!STRIPE_STATUSES.has(answer.status)) throw new StoreValidationError("status is not a Stripe refund status.");
      stripeRefundRef = answer.stripeRefundRef;
      wanted = refundStatusOf(answer.status);
      failureCode = answer.failureCode && FAILURE_CODE.test(answer.failureCode) ? answer.failureCode : null;
    } else if (answer?.kind === "rejected") {
      wanted = "FAILED";
      failureCode = typeof answer.failureCode === "string" && FAILURE_CODE.test(answer.failureCode) ? answer.failureCode : "refund_rejected";
    } else {
      throw new StoreValidationError("answer must be accepted or rejected.");
    }
    return withTransaction(this.#pool, async (client) => {
      const refund = await lockRefund(client, refundId);
      if (!refund) throw new StoreNotFoundError("refund");
      if (stripeRefundRef !== null && refund.stripeRefundRef !== null && refund.stripeRefundRef !== stripeRefundRef) {
        throw new StoreConflictError("The refund already references another Stripe refund.");
      }
      // A refusal answers a refund Stripe never accepted; one it accepted is followed by its webhook instead.
      if (stripeRefundRef === null && refund.status !== "REQUESTED") return refund.status;
      return settleRefund(client, refund, { stripeRefundRef, wanted, failureCode, stripeEventId: null, occurredAtUtc: null });
    });
  }

  /**
   * A verified refund event of this service (refund.created / refund.updated / refund.failed): the account must be
   * the booking's seller, and the payment, amount and currency the refund's. Each event is recorded once in
   * stripe_webhook_events (REFUND_PENDING, REFUNDED, REFUND_FAILED, or IGNORED when it changes nothing); the
   * refund moves only forward. StoreNotFoundError when no such refund exists for the booking; StoreConflictError
   * for an account, payment or amount that does not match, or an event ID recorded for another booking.
   */
  async applyRefundEvent(input: RefundEventInput): Promise<RefundEventResult> {
    if (typeof input.refundId !== "string" || !UUID.test(input.refundId)) throw new StoreValidationError("refundId must be a UUID.");
    const publicBookingId = publicBookingIdOf(input.publicBookingId);
    if (typeof input.stripeRefundRef !== "string" || !STRIPE_REF.test(input.stripeRefundRef)) throw new StoreValidationError("stripeRefundRef is invalid.");
    if (!STRIPE_STATUSES.has(input.status)) throw new StoreValidationError("status is not a Stripe refund status.");
    if (typeof input.stripeEventId !== "string" || input.stripeEventId.length < 1 || input.stripeEventId.length > 256) throw new StoreValidationError("stripeEventId is invalid.");
    if (typeof input.stripeEventType !== "string" || !/^refund\.[a-z_]{1,40}$/.test(input.stripeEventType)) throw new StoreValidationError("stripeEventType must be a refund event.");
    assertCanonicalInstant(input.eventOccurredAtUtc, "eventOccurredAtUtc");
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [input.stripeEventId]);
      const refund = await lockRefund(client, input.refundId);
      if (!refund || refund.publicBookingId !== publicBookingId) throw new StoreNotFoundError("refund");
      if (refund.connectedAccountId !== input.connectedAccountId) throw new StoreConflictError("Stripe event account does not match the booking seller snapshot.");
      if (refund.stripePaymentRef !== input.stripePaymentRef || refund.amount !== input.amount || refund.currency !== input.currency.toUpperCase()) {
        throw new StoreConflictError("The refund event does not match the recorded refund.");
      }
      if (refund.stripeRefundRef !== null && refund.stripeRefundRef !== input.stripeRefundRef) throw new StoreConflictError("The refund already references another Stripe refund.");
      const recorded = await client.query<DbRow>(
        "SELECT event_id FROM stripe_webhook_events WHERE event_id = $1 AND provider_id = $2 AND booking_id = $3",
        [input.stripeEventId, refund.providerId, refund.bookingRowId],
      );
      if (recorded.rows[0]) return { status: refund.status, duplicateEvent: true };
      const wanted = refundStatusOf(input.status);
      const next = nextStatus(refund.status, wanted);
      const outcome = next === refund.status && refund.stripeRefundRef !== null ? "IGNORED" : next === "SUCCEEDED" ? "REFUNDED" : next === "FAILED" ? "REFUND_FAILED" : "REFUND_PENDING";
      const inserted = await client.query<DbRow>(
        `INSERT INTO stripe_webhook_events (event_id, provider_id, event_type, booking_id, occurred_at, outcome)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [input.stripeEventId, refund.providerId, input.stripeEventType, refund.bookingRowId, input.eventOccurredAtUtc, outcome],
      );
      if (!inserted.rows[0]) throw new StoreConflictError("Stripe event ID is already used outside this booking scope.");
      if (outcome === "IGNORED") return { status: refund.status, duplicateEvent: false };
      const failureCode = input.failureCode && FAILURE_CODE.test(input.failureCode) ? input.failureCode : null;
      const status = await settleRefund(client, refund, {
        stripeRefundRef: input.stripeRefundRef, wanted, failureCode, stripeEventId: input.stripeEventId, occurredAtUtc: input.eventOccurredAtUtc,
      });
      return { status, duplicateEvent: false };
    });
  }

  /**
   * A refund Stripe has not accepted, for support's 「もう一度送る」 to send: taken for BOOKING_CANCELLATION_LIMITS.refundSendLeaseSeconds
   * unless the job (or an earlier click) holds it, in which case there is nothing for this caller to send: whoever
   * holds it sends it. Taking it does not count as an automatic attempt.
   */
  async #leaseRequested(client: PoolClient, refundId: string): Promise<RefundSubmission[]> {
    const found = await client.query<DbRow>(
      `WITH taken AS (
         UPDATE booking_refunds SET send_claimed_at = clock_timestamp()
          WHERE id = $1::uuid AND status = 'REQUESTED'
            AND (send_claimed_at IS NULL OR send_claimed_at <= clock_timestamp() - make_interval(secs => $2::double precision))
          RETURNING id, provider_id, booking_id, kind, amount, currency, refund_application_fee, stripe_payment_ref
       )
       SELECT r.id::text AS id, r.kind, r.amount, r.currency, r.refund_application_fee, r.stripe_payment_ref,
              b.public_booking_id::text AS public_booking_id, b.seller_snapshot
         FROM taken r JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id`,
      [refundId, BOOKING_CANCELLATION_LIMITS.refundSendLeaseSeconds],
    );
    return found.rows.map(submissionFromRow);
  }
}
