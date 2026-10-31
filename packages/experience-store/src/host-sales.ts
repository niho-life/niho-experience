import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { HOST_GUEST_BOOKING_STATUSES, platformFeeOf, type HostGuestBookingStatus } from "./host-guest-bookings.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * 売上 for bookings travelers made on this site (#91, ADR 0002): what the provider's OWNER reads of the payment
 * ledger (payment_ledger_entries). One entry per movement of money on the seller's Connect account: the guest's
 * payment, a refund Stripe accepted, and the reversal of a refund Stripe failed after accepting it. Each comes with
 * NIHO's fee it moved and what it moved for the provider. Read only: the payment webhook and the refunds write the
 * ledger (repository.ts, booking-cancellations.ts). Payouts to the bank are the Connect account's, kept by Stripe
 * and not here. Never the guest's email address; their name only while it is kept. No Stripe IDs leave the store.
 */

export const HOST_SALES_LIMITS = {
  /** The widest window one read takes: a month and then some. */
  windowDays: 92,
  /** More entries than this in one window is not a page the screen reads: the read fails instead of cutting it. */
  entries: 5000,
} as const;

export type HostSaleEntryKind = "PAYMENT" | "REFUND" | "REFUND_REVERSAL" | "ADJUSTMENT";

export interface HostSaleRefund {
  readonly kind: "FULL" | "PARTIAL";
  /** Where Stripe has the refund now (a reversal's refund is FAILED). */
  readonly status: "REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
}

export interface HostSaleEntry {
  /**
   * Stable and free of Stripe's IDs: `payment:{publicBookingId}` (a booking has one payment), `refund:{refundId}`,
   * `refund-reversal:{refundId}`, `adjustment:{digest}`.
   */
  readonly key: string;
  /**
   * PAYMENT: the guest paid (also a payment under review). REFUND: Stripe accepted a refund (pending or done).
   * REFUND_REVERSAL: Stripe failed a refund it had accepted, and the money came back. ADJUSTMENT: anything else
   * the ledger has (a dispute), kept as it is.
   */
  readonly kind: HostSaleEntryKind;
  /** Signed as the ledger has it, in the currency's minor unit: a payment and a reversal add, a refund takes away. */
  readonly amount: number;
  readonly currency: string;
  readonly occurredAtUtc: string;
  readonly publicBookingId: string;
  readonly productTitle: string;
  readonly bookingStatus: HostGuestBookingStatus;
  /** The session as booked (the occurrence snapshot), in its own time zone. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly adultCount: number;
  readonly childCount: number;
  /** null once the guest's details were erased (a year after the experience). */
  readonly guestName: string | null;
  /**
   * NIHO's fee this entry moved: kept with a payment (+), given back with a refund (−), taken again with a reversal
   * (+); 0 for an adjustment. null when it cannot be known: no fee in the booking's snapshot, or the payment is not
   * in the snapshot's currency.
   */
  readonly platformFeeAmount: number | null;
  /** What the entry moved on the provider's balance (amount − platformFeeAmount); null with the fee. */
  readonly providerAmount: number | null;
  /**
   * The fee given back is worked out here as Stripe's proportion of a partial refund (refund_application_fee) and may
   * differ from Stripe's own by one unit. A full refund gives back the whole fee: exact.
   */
  readonly feeEstimated: boolean;
  /** The refund a REFUND or REFUND_REVERSAL entry belongs to; null for the others. */
  readonly refund: HostSaleRefund | null;
}

export interface HostSalesWindow {
  /** The entries in the window, the latest first. */
  readonly entries: readonly HostSaleEntry[];
  /** The provider's first entry at any time (where 売上's months begin); null without any. */
  readonly firstEntryAtUtc: string | null;
}

export interface HostSalesWindowOptions {
  /** Canonical UTC instants: entries at `from` or later and before `to`. */
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;
const REVERSAL_PREFIX = "refund-reversal:";
const REFUND_PREFIX = "refund:";

export function salesWindowOf(value: unknown): HostSalesWindowOptions {
  const { from, to } = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  if (typeof from !== "string" || typeof to !== "string") throw new StoreValidationError("from and to must be canonical UTC instants.");
  assertCanonicalInstant(from, "from");
  assertCanonicalInstant(to, "to");
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) throw new StoreValidationError("to must be after from.");
  if (span > HOST_SALES_LIMITS.windowDays * DAY_MS) throw new StoreValidationError(`The window must be at most ${HOST_SALES_LIMITS.windowDays} days.`);
  return { from, to };
}

/**
 * The ledger entries of the provider's guest bookings (those a host sees) in [from, to). `refunded_before` is what
 * the booking had refunded, net of reversals, before the entry: the fee Stripe gives back follows it.
 */
const SELECT_SALES = `
  SELECT l.entry_id, l.kind, l.amount::text AS amount, l.currency, l.occurred_at,
         b.public_booking_id::text AS public_booking_id, b.status, p.public_title,
         b.occurrence_snapshot->>'localDate' AS local_date, b.occurrence_snapshot->>'localStartTime' AS local_start_time,
         g.adult_count, g.child_count, g.guest_name, g.pii_erased_at IS NOT NULL AS erased,
         b.pricing_snapshot->'platformFee' AS platform_fee, b.pricing_snapshot->>'currency' AS pricing_currency,
         c.amount::text AS paid_amount, c.currency AS paid_currency,
         r.kind AS refund_kind, r.status AS refund_status,
         (SELECT COALESCE(-sum(x.amount), 0)::text FROM payment_ledger_entries x
           WHERE x.provider_id = l.provider_id AND x.booking_id = l.booking_id
             AND (x.kind = 'REFUND' OR (x.kind = 'ADJUSTMENT' AND x.entry_id LIKE '${REVERSAL_PREFIX}%'))
             AND (x.occurred_at, x.entry_id) < (l.occurred_at, l.entry_id)) AS refunded_before
    FROM payment_ledger_entries l
    JOIN bookings b ON b.provider_id = l.provider_id AND b.id = l.booking_id
    JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
    JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
    LEFT JOIN payment_ledger_entries c
      ON c.provider_id = b.provider_id AND c.booking_id = b.id AND c.kind = 'PAYMENT_CAPTURED' AND c.stripe_payment_ref = b.stripe_payment_ref
    LEFT JOIN booking_refunds r
      ON r.provider_id = l.provider_id AND r.booking_id = l.booking_id
     AND l.entry_id IN ('${REFUND_PREFIX}' || r.id::text, '${REVERSAL_PREFIX}' || r.id::text)
   WHERE l.provider_id = $1 AND b.status = ANY($2::text[])
     AND l.occurred_at >= $3::timestamptz AND l.occurred_at < $4::timestamptz
   ORDER BY l.occurred_at DESC, l.entry_id DESC
   LIMIT $5`;

export async function selectSales(client: PoolClient, providerId: string, window: HostSalesWindowOptions): Promise<HostSalesWindow> {
  const rows = await client.query<DbRow>(SELECT_SALES, [providerId, HOST_GUEST_BOOKING_STATUSES, window.from, window.to, HOST_SALES_LIMITS.entries + 1]);
  if (rows.rows.length > HOST_SALES_LIMITS.entries) throw new StoreError("The sales window has more ledger entries than one read takes.");
  const first = await client.query<DbRow>(
    `SELECT min(l.occurred_at) AS first_at
       FROM payment_ledger_entries l
       JOIN bookings b ON b.provider_id = l.provider_id AND b.id = l.booking_id
       JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
      WHERE l.provider_id = $1 AND b.status = ANY($2::text[])`,
    [providerId, HOST_GUEST_BOOKING_STATUSES],
  );
  const firstRow = first.rows[0];
  return { entries: rows.rows.map(saleEntryFromRow), firstEntryAtUtc: firstRow?.first_at === null || firstRow?.first_at === undefined ? null : isoValue(firstRow, "first_at") };
}

/* ---------- NIHO's fee ---------- */

/** round(fee × refunded ÷ paid), half up, without losing digits: the part of the fee a refund of `refunded` gives back. */
export function refundedFeeShare(fee: number, refunded: number, paid: number): number {
  const scaled = 2n * BigInt(fee) * BigInt(refunded) + BigInt(paid);
  return Number(scaled / (2n * BigInt(paid)));
}

/**
 * NIHO's fee a refund (or its reversal) moves, as Stripe gives back the fee in proportion to the refund
 * (refund_application_fee; owner decision 2026-10-31): the share of what was refunded after the entry less the share
 * before it, so a booking refunded in full has given back its whole fee, however many refunds it took. `refundedBefore`
 * and the entry's own amount are clamped to what was paid.
 */
export function refundFeeMovement(fee: number, paid: number, refundedBefore: number, refundedByEntry: number): { amount: number; estimated: boolean } {
  const clamp = (value: number) => Math.min(Math.max(value, 0), paid);
  const before = clamp(refundedBefore);
  const after = clamp(before + refundedByEntry);
  const exact = (value: number) => value === 0 || value === paid;
  return { amount: refundedFeeShare(fee, before, paid) - refundedFeeShare(fee, after, paid), estimated: !(exact(before) && exact(after)) };
}

/* ---------- rows ---------- */

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function integer(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function kindOf(row: DbRow): HostSaleEntryKind {
  const entryId = text(row.entry_id, "entry_id");
  if (row.kind === "PAYMENT_CAPTURED") return "PAYMENT";
  if (row.kind === "REFUND") return "REFUND";
  if (row.kind === "ADJUSTMENT" && entryId.startsWith(REVERSAL_PREFIX)) return "REFUND_REVERSAL";
  return "ADJUSTMENT";
}

function keyOf(kind: HostSaleEntryKind, row: DbRow, publicBookingId: string): string {
  const entryId = text(row.entry_id, "entry_id");
  if (kind === "PAYMENT") return `payment:${publicBookingId}`;
  // The refunds' entry IDs are the store's own refund IDs (booking-cancellations.ts), not Stripe's.
  if ((kind === "REFUND" && entryId.startsWith(REFUND_PREFIX)) || kind === "REFUND_REVERSAL") return entryId;
  return `adjustment:${createHash("sha256").update(entryId, "utf8").digest("hex").slice(0, 24)}`;
}

function refundOf(row: DbRow): HostSaleRefund | null {
  const kind = row.refund_kind;
  const status = row.refund_status;
  if ((kind !== "FULL" && kind !== "PARTIAL") || (status !== "REQUESTED" && status !== "PENDING" && status !== "SUCCEEDED" && status !== "FAILED")) return null;
  return { kind, status };
}

/** NIHO's fee the entry moved, when the booking's fee and payment are known and in the entry's currency. */
function feeOf(kind: HostSaleEntryKind, row: DbRow, amount: number, currency: string): { amount: number; estimated: boolean } | null {
  if (kind === "ADJUSTMENT") return { amount: 0, estimated: false };
  const fee = platformFeeOf(row.platform_fee);
  if (fee === null || row.pricing_currency !== currency || row.paid_currency !== currency || row.paid_amount === null || row.paid_amount === undefined) return null;
  const paid = integer(row.paid_amount, "paid_amount");
  if (paid <= 0) return null;
  if (kind === "PAYMENT") return { amount: fee.amount, estimated: false };
  // A refund takes away (−amount refunded); its reversal brings it back (−amount, negative refunded).
  return refundFeeMovement(fee.amount, paid, integer(row.refunded_before, "refunded_before"), -amount);
}

export function saleEntryFromRow(row: DbRow): HostSaleEntry {
  const kind = kindOf(row);
  const amount = integer(row.amount, "amount");
  const currency = text(row.currency, "currency");
  const publicBookingId = text(row.public_booking_id, "public_booking_id");
  const fee = feeOf(kind, row, amount, currency);
  return {
    key: keyOf(kind, row, publicBookingId),
    kind,
    amount,
    currency,
    occurredAtUtc: isoValue(row, "occurred_at"),
    publicBookingId,
    productTitle: text(row.public_title, "public_title"),
    bookingStatus: text(row.status, "status") as HostGuestBookingStatus,
    localDate: text(row.local_date, "occurrence_snapshot.localDate"),
    localStartTime: text(row.local_start_time, "occurrence_snapshot.localStartTime"),
    adultCount: integer(row.adult_count, "adult_count"),
    childCount: integer(row.child_count, "child_count"),
    guestName: row.erased === true || typeof row.guest_name !== "string" ? null : row.guest_name,
    platformFeeAmount: fee?.amount ?? null,
    providerAmount: fee ? amount - fee.amount : null,
    feeEstimated: fee?.estimated ?? false,
    refund: kind === "REFUND" || kind === "REFUND_REVERSAL" ? refundOf(row) : null,
  };
}
