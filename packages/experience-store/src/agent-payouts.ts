import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { requireBookingsOwner, publicBookingIdOf } from "./host-guest-bookings.ts";
import { HOST_MAIL_TOPICS, enqueueHostBookingMails } from "./host-mail-shared.ts";
import { lockProviderInventory } from "./inventory.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";

/*
 * 代理受領の送金 (#725, Epic #700 stage 3b-2, docs/host-payouts.md「3b-2 送金」): the ledger of what NIHO sends a host for each
 * agent-sales booking after the experience. One row per booking (experience_agent_payouts, migration 0097). The job's calls:
 * initializeMissing → claimDue → prepare → (the Stripe reads, outside any transaction) → begin → (the Transfer) → recordTransfer.
 *
 * Lock order of every transaction: the provider's inventory lock, then the booking row, then the payout row, then adjustments
 * (as a host's cancellation takes them). No Stripe call is made while a lock is held.
 */

const AGENT_FEE_BASIS_POINTS = 1500;
const ADMIN_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const ISSUE = /^[a-z0-9_]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_REF = /^acct_[A-Za-z0-9]{8,250}$/;
const CHARGE_REF = /^(ch|py)_[A-Za-z0-9_]{8,250}$/;
const TRANSFER_REF = /^tr_[A-Za-z0-9_]{8,250}$/;
const REVERSAL_REF = /^trr_[A-Za-z0-9_]{8,250}$/;
const DAY_MS = 86_400_000;

export const AGENT_PAYOUT_LIMITS = Object.freeze({
  /** A claim of a row lasts this long; a crashed run's rows are picked up again after it. */
  leaseSeconds: 300,
  holdRecheckMinutes: 60,
  awaitingRecheckHours: 6,
  unknownRecheckMinutes: 6,
  /** From the due date: no payout account for this long and the office is asked (the right to be paid is not lost). */
  accountEscalationDays: 90,
  /** An amount waiting to be taken from later payouts for this long goes to the office. */
  offsetEscalationDays: 90,
  /** Attention list: an unknown transfer older than this (Stripe's key lasts 24 hours), a registration wait older than the last reminder, a taking-back that stays. */
  unknownAttentionHours: 23,
  awaitingAttentionDays: 30,
  adjustmentAttentionDays: 30,
});

export type AgentPayoutStatus = "SCHEDULED" | "AWAITING_ACCOUNT" | "SUBMITTING" | "RESULT_UNKNOWN" | "TRANSFERRED" | "REVIEW_REQUIRED" | "CANCELLED";
export type AgentPayoutHold = "REFUND_PENDING" | "REFUND_FAILED" | "DISPUTE_OPEN" | "PROVIDER_SUSPENDED";
export type AgentAdjustmentStatus = "REVERSAL_PENDING" | "RESULT_UNKNOWN" | "REVERSED" | "OFFSET_PENDING" | "OFFSET_APPLIED" | "LOSS_RECORDED" | "REVIEW_REQUIRED";
export type AgentAdjustmentReason = "REFUND" | "DISPUTE";

/** A claim's identity: the lease's end, to the microsecond, as UTC text. */
const TOKEN_SQL = `to_char(claimed_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`;
const WORKING_STATUSES = "'SCHEDULED','AWAITING_ACCOUNT','SUBMITTING','RESULT_UNKNOWN','TRANSFERRED'";

/** Pure: the host's share. The fee is 15% of what is left after refunds and lost disputes, rounded down. */
export function agentPayoutAmounts(captured: number, refunded: number, disputed: number): { readonly net: number; readonly fee: number; readonly payout: number } {
  for (const value of [captured, refunded, disputed]) if (!Number.isSafeInteger(value) || value < 0) throw new StoreValidationError("Amounts must be whole non-negative yen.");
  if (refunded + disputed > captured) throw new StoreValidationError("Refunds and disputes exceed the captured amount.");
  const net = captured - refunded - disputed;
  const fee = Math.floor(net * AGENT_FEE_BASIS_POINTS / 10_000);
  return { net, fee, payout: net - fee };
}

/** The Transfer the job sends, fixed before Stripe is asked. */
export interface AgentPayoutCommand {
  readonly commandId: string;
  readonly payoutId: string;
  readonly publicBookingId: string;
  readonly amount: number;
  readonly currency: "JPY";
  readonly destinationAccountId: string;
  readonly chargeRef: string;
  readonly transferGroup: string;
  readonly createdAtUtc: string;
}

export interface AgentPayoutRecord {
  readonly id: string;
  readonly providerId: string;
  readonly publicBookingId: string;
  readonly currency: "JPY";
  readonly capturedAmount: number;
  readonly refundedAmount: number;
  readonly disputedAmount: number;
  readonly nihoFeeAmount: number;
  readonly payoutAmount: number;
  readonly status: AgentPayoutStatus;
  readonly holdReason: AgentPayoutHold | null;
  readonly issueCode: string | null;
  readonly experienceEndAtUtc: string;
  readonly dueAtUtc: string;
  readonly payoutDelayDays: number;
  readonly submittedAmount: number | null;
  readonly offsetAmount: number;
  readonly reversedAmount: number;
  readonly stripeTransferRef: string | null;
  readonly transferredAtUtc: string | null;
  readonly commandCreatedAtUtc: string | null;
  readonly attempts: number;
  readonly version: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface AgentPayoutAdjustmentRecord {
  readonly id: string;
  readonly payoutId: string;
  readonly reason: AgentAdjustmentReason;
  readonly status: AgentAdjustmentStatus;
  readonly amount: number;
  readonly reversalAmount: number;
  readonly remainingAmount: number;
  readonly stripeReversalRef: string | null;
  readonly issueCode: string | null;
  readonly version: number;
  readonly createdAtUtc: string;
}

export interface AgentPayoutEventRecord {
  readonly eventType: string;
  readonly actor: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly amount: number | null;
  readonly issueCode: string | null;
  readonly note: string | null;
  readonly occurredAtUtc: string;
}

export interface AgentPayoutDetail {
  readonly payout: AgentPayoutRecord;
  readonly adjustments: readonly AgentPayoutAdjustmentRecord[];
  readonly events: readonly AgentPayoutEventRecord[];
}

export interface AgentPayoutAttentionItem {
  readonly kind: "PAYOUT" | "ADJUSTMENT";
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly status: string;
  readonly issueCode: string | null;
  readonly amount: number;
  readonly sinceUtc: string;
}

/** What the host's 売上 screen shows of one payout (no Stripe reference, no internal state). */
export interface HostAgentPayoutRow {
  readonly publicBookingId: string;
  /** The experience's date in Japan (YYYY-MM-DD). */
  readonly experienceDate: string;
  readonly capturedAmount: number;
  /** Refunds and lost disputes. */
  readonly refundedAmount: number;
  readonly nihoFeeAmount: number;
  readonly payoutAmount: number;
  readonly dueAtUtc: string;
  readonly state: "SCHEDULED" | "AWAITING_ACCOUNT" | "TRANSFERRED" | "REVIEWING" | "CANCELLED";
  readonly transferredAtUtc: string | null;
  /** What was actually sent (after the amounts kept for earlier takings-back); null until a transfer was begun. */
  readonly sentAmount: number | null;
  /** Taken back after the payout was sent, and what was kept from this payout for earlier amounts. */
  readonly takenBackAmount: number;
  readonly offsetAmount: number;
}

export type AgentPayoutPrepared =
  | { readonly kind: "idle" }
  /** Due and unheld: read the payout account and the Charge, then `begin`. */
  | { readonly kind: "destination"; readonly payoutId: string; readonly providerId: string; readonly publicBookingId: string; readonly paymentRef: string; readonly capturedAmount: number; readonly refundedAmount: number; readonly disputeCount: number }
  /** A transfer was begun and its result is not known: look it up, never send it blindly. */
  | { readonly kind: "reconcile"; readonly command: AgentPayoutCommand };

export type AgentPayoutTransferAnswer =
  | { readonly kind: "transferred"; readonly stripeTransferRef: string }
  | { readonly kind: "already_transferred"; readonly stripeTransferRef: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "account_not_ready"; readonly issueCode: string }
  | { readonly kind: "review_required"; readonly issueCode: string };

export interface ClaimedAgentReversal {
  readonly adjustmentId: string;
  readonly payoutId: string;
  readonly publicBookingId: string;
  readonly stripeTransferRef: string;
  readonly amount: number;
  /** This claim's identity, for `extendReversalLease`. */
  readonly leaseToken: string;
}

export type AgentReversalAnswer =
  | { readonly kind: "reversed"; readonly stripeReversalRef: string }
  | { readonly kind: "insufficient_balance" }
  | { readonly kind: "unknown" }
  | { readonly kind: "review_required"; readonly issueCode: string };

export const AGENT_PAYOUT_ADMIN_ACTIONS = ["RECALCULATE", "RECREATE", "CLOSE", "RESUME_ADJUSTMENT", "OFFSET", "LOSS"] as const;
export type AgentPayoutAdminAction = (typeof AGENT_PAYOUT_ADMIN_ACTIONS)[number];

export interface AgentPayoutAdminInput {
  readonly action: AgentPayoutAdminAction;
  /** The payout's version for RECALCULATE, RECREATE and CLOSE; the adjustment's for the others. */
  readonly expectedVersion: number;
  readonly adjustmentId?: string;
  /** The office looked in Stripe: the transfer (or reversal) was never made. */
  readonly confirmedNotSent?: boolean;
  readonly note?: string;
}

function text(row: DbRow, key: string): string {
  if (typeof row[key] !== "string") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return row[key] as string;
}
function nullableText(row: DbRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}
function integer(row: DbRow, key: string): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}
function nullableInteger(row: DbRow, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : integer(row, key);
}
function nullableIso(row: DbRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : isoValue(row, key);
}
function adminId(value: unknown): string {
  if (typeof value !== "string" || !ADMIN_ID.test(value)) throw new StoreValidationError("adminUserId is invalid.");
  return value;
}
function validNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new StoreValidationError("now is invalid.");
  return now;
}

function payoutFromRow(row: DbRow): AgentPayoutRecord {
  return {
    id: text(row, "id"), providerId: text(row, "provider_id"), publicBookingId: text(row, "public_booking_id"), currency: "JPY",
    capturedAmount: integer(row, "captured_amount"), refundedAmount: integer(row, "refunded_amount"), disputedAmount: integer(row, "disputed_amount"),
    nihoFeeAmount: integer(row, "niho_fee_amount"), payoutAmount: integer(row, "payout_amount"),
    status: text(row, "status") as AgentPayoutStatus, holdReason: nullableText(row, "hold_reason") as AgentPayoutHold | null, issueCode: nullableText(row, "issue_code"),
    experienceEndAtUtc: isoValue(row, "experience_end_at"), dueAtUtc: isoValue(row, "due_at"), payoutDelayDays: integer(row, "payout_delay_days"),
    submittedAmount: nullableInteger(row, "submitted_amount"), offsetAmount: integer(row, "offset_amount"), reversedAmount: integer(row, "reversed_amount"),
    stripeTransferRef: nullableText(row, "stripe_transfer_ref"), transferredAtUtc: nullableIso(row, "transferred_at"), commandCreatedAtUtc: nullableIso(row, "command_created_at"),
    attempts: integer(row, "attempts"), version: integer(row, "version"), createdAtUtc: isoValue(row, "created_at"), updatedAtUtc: isoValue(row, "updated_at"),
  };
}

function adjustmentFromRow(row: DbRow): AgentPayoutAdjustmentRecord {
  return {
    id: text(row, "id"), payoutId: text(row, "payout_id"), reason: text(row, "reason") as AgentAdjustmentReason, status: text(row, "status") as AgentAdjustmentStatus,
    amount: integer(row, "amount"), reversalAmount: integer(row, "reversal_amount"), remainingAmount: integer(row, "remaining_amount"),
    stripeReversalRef: nullableText(row, "stripe_reversal_ref"), issueCode: nullableText(row, "issue_code"), version: integer(row, "version"), createdAtUtc: isoValue(row, "created_at"),
  };
}

function commandFromRow(row: DbRow): AgentPayoutCommand {
  const publicBookingId = text(row, "public_booking_id");
  return {
    commandId: text(row, "command_id"), payoutId: text(row, "id"), publicBookingId, amount: integer(row, "submitted_amount"), currency: "JPY",
    destinationAccountId: text(row, "destination_account_ref"), chargeRef: text(row, "stripe_charge_ref"),
    transferGroup: `niho-experience-agent-payout:${publicBookingId}`, createdAtUtc: isoValue(row, "command_created_at"),
  };
}

const SELECT_PAYOUT = `SELECT p.*, p.id::text AS id, p.command_id::text AS command_id, b.public_booking_id::text AS public_booking_id
  FROM experience_agent_payouts p JOIN bookings b ON b.provider_id=p.provider_id AND b.id=p.booking_id`;

/** Locks in the order every transaction here takes: inventory, booking, payout. Null when there is no such payout. */
async function lockPayout(client: PoolClient, payoutId: string): Promise<DbRow | null> {
  if (typeof payoutId !== "string" || !UUID.test(payoutId)) throw new StoreValidationError("payoutId must be a UUID.");
  const head = await client.query<DbRow>("SELECT provider_id, booking_id FROM experience_agent_payouts WHERE id=$1::uuid", [payoutId]);
  const key = head.rows[0];
  if (!key) return null;
  await lockProviderInventory(client, text(key, "provider_id"));
  await client.query("SELECT id FROM bookings WHERE provider_id=$1 AND id=$2::bigint FOR UPDATE", [key.provider_id, key.booking_id]);
  const found = await client.query<DbRow>(`${SELECT_PAYOUT} WHERE p.id=$1::uuid FOR UPDATE OF p`, [payoutId]);
  return found.rows[0] ?? null;
}

interface Calculation {
  readonly refunded: number;
  readonly disputed: number;
  readonly overlap: boolean;
  readonly hold: AgentPayoutHold | null;
  /** The disputes this ledger knows of for the booking, whatever their state. */
  readonly disputeCount: number;
}

/** What the booking's refunds, disputes and the host's suspension say now. The caller holds the booking's lock. */
async function calculate(client: PoolClient, providerId: string, bookingId: string, captured: number): Promise<Calculation> {
  const found = await client.query<DbRow>(
    `SELECT COALESCE((SELECT sum(r.amount) FROM booking_refunds r WHERE r.provider_id=$1 AND r.booking_id=$2::bigint AND r.status='SUCCEEDED'),0)::bigint AS refunded,
            COALESCE((SELECT sum(d.amount) FROM managed_booking_disputes d WHERE d.provider_id=$1 AND d.booking_id=$2::bigint AND d.status='LOST'),0)::bigint AS disputed,
            EXISTS(SELECT 1 FROM booking_refunds r WHERE r.provider_id=$1 AND r.booking_id=$2::bigint AND r.status IN ('REQUESTED','PENDING')) AS refund_pending,
            EXISTS(SELECT 1 FROM booking_refunds r WHERE r.provider_id=$1 AND r.booking_id=$2::bigint AND r.status='FAILED' AND r.closed_at IS NULL AND r.superseded_by IS NULL) AS refund_failed,
            EXISTS(SELECT 1 FROM managed_booking_disputes d WHERE d.provider_id=$1 AND d.booking_id=$2::bigint AND d.status IN ('NEEDS_RESPONSE','UNDER_REVIEW')) AS dispute_open,
            COALESCE((SELECT operations_suspended_at IS NOT NULL FROM experience_providers WHERE id=$1),false) AS suspended,
            (SELECT count(*) FROM managed_booking_disputes d WHERE d.provider_id=$1 AND d.booking_id=$2::bigint)::int AS dispute_count`,
    [providerId, bookingId],
  );
  const row = found.rows[0]!;
  const refunded = integer(row, "refunded");
  const disputed = integer(row, "disputed");
  const hold: AgentPayoutHold | null = row.refund_pending === true ? "REFUND_PENDING"
    : row.refund_failed === true ? "REFUND_FAILED"
      : row.dispute_open === true ? "DISPUTE_OPEN"
        : row.suspended === true ? "PROVIDER_SUSPENDED" : null;
  return { refunded, disputed, overlap: refunded + disputed > captured, hold, disputeCount: integer(row, "dispute_count") };
}

async function logEvent(client: PoolClient, payoutId: string, input: {
  readonly type: string; readonly actor: string; readonly from?: string | null; readonly to?: string | null; readonly amount?: number | null;
  readonly issue?: string | null; readonly note?: string | null; readonly adjustmentId?: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO experience_agent_payout_events (payout_id,adjustment_id,event_type,actor,from_status,to_status,amount,issue_code,note)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
    [payoutId, input.adjustmentId ?? null, input.type, input.actor, input.from ?? null, input.to ?? null, input.amount ?? null, input.issue ?? null, input.note ?? null],
  );
}

/** A transfer whose result is unknown may be recreated or closed only once Stripe's idempotency window (23 hours from its command) has passed. */
async function requireUnknownWindowPassed(client: PoolClient, payoutId: string, status: AgentPayoutStatus): Promise<void> {
  if (status !== "RESULT_UNKNOWN") return;
  const found = await client.query(
    "SELECT 1 FROM experience_agent_payouts WHERE id=$1::uuid AND command_created_at < clock_timestamp() - make_interval(hours => $2::int)",
    [payoutId, AGENT_PAYOUT_LIMITS.unknownAttentionHours],
  );
  if ((found.rowCount ?? 0) === 0) throw new StoreConflictError("The transfer's result may still be looked up by the job; wait 23 hours from its command.");
}

function issueOf(value: string): string {
  if (!ISSUE.test(value)) throw new StoreValidationError("issueCode is invalid.");
  return value;
}

export class AgentPayoutRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Makes a ledger row for each agent-sales booking whose payment is captured and which is confirmed or cancelled (a payment under
   * review waits for its resolution). `failed` counts bookings that could not be made a row (a snapshot without its delay or end).
   */
  async initializeMissing(limit = 20): Promise<{ readonly initialized: number; readonly failed: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    const candidates = await this.#pool.query<DbRow>(
      `SELECT b.provider_id, b.id AS booking_id, b.stripe_payment_ref, b.occurrence_snapshot, b.pricing_snapshot, b.seller_snapshot,
              cap.amount AS captured, cap.currency AS captured_currency
         FROM bookings b
         JOIN LATERAL (SELECT l.amount, l.currency FROM payment_ledger_entries l
                        WHERE l.provider_id=b.provider_id AND l.booking_id=b.id AND l.kind='PAYMENT_CAPTURED' AND l.stripe_payment_ref=b.stripe_payment_ref
                        ORDER BY l.created_at DESC LIMIT 1) cap ON true
        WHERE b.status IN ('CONFIRMED','CANCELLED') AND b.stripe_payment_ref IS NOT NULL
          AND b.seller_snapshot->>'chargeMode'='PLATFORM' AND b.seller_snapshot->>'salesPlan'='SUPPORTED_15'
          AND b.seller_snapshot->>'sellerParty'='PROVIDER' AND b.seller_snapshot->>'feeBasisPoints'='1500'
          AND NOT EXISTS (SELECT 1 FROM experience_agent_payouts p WHERE p.provider_id=b.provider_id AND p.booking_id=b.id)
        ORDER BY b.id LIMIT $1`,
      [limit],
    );
    let initialized = 0;
    let failed = 0;
    for (const row of candidates.rows) {
      try {
        const seller = row.seller_snapshot as Record<string, unknown>;
        const occurrence = row.occurrence_snapshot as Record<string, unknown>;
        const pricing = row.pricing_snapshot as Record<string, unknown>;
        const delay = seller.payoutDelayDays;
        const revision = seller.salesPlanRevision;
        const endUtc = occurrence.endUtc;
        if (!Number.isSafeInteger(delay) || (delay as number) < 1 || (delay as number) > 30 || !Number.isSafeInteger(revision) || (revision as number) < 1
          || typeof endUtc !== "string" || !Number.isFinite(Date.parse(endUtc))) throw new StoreValidationError("The booking snapshot has no payout terms.");
        const captured = integer(row, "captured");
        const mismatch = row.captured_currency !== "JPY" || pricing.totalAmount !== captured || pricing.currency !== "JPY";
        const { fee, payout } = agentPayoutAmounts(captured, 0, 0);
        const inserted = await withTransaction(this.#pool, async (client) => {
          await lockProviderInventory(client, text(row, "provider_id"));
          await client.query("SELECT id FROM bookings WHERE provider_id=$1 AND id=$2::bigint FOR UPDATE", [row.provider_id, row.booking_id]);
          const id = randomUUID();
          const result = await client.query(
            `INSERT INTO experience_agent_payouts
               (provider_id,booking_id,id,currency,captured_amount,niho_fee_amount,payout_amount,stripe_payment_ref,sales_plan_revision,payout_delay_days,
                experience_end_at,due_at,status,issue_code,next_check_at)
             VALUES ($1,$2::bigint,$3::uuid,'JPY',$4,$5,$6,$7,$8,$9,$10::timestamptz,$10::timestamptz + make_interval(days => $9::int),$11,$12,clock_timestamp())
             ON CONFLICT (provider_id,booking_id) DO NOTHING`,
            [row.provider_id, row.booking_id, id, captured, fee, payout, row.stripe_payment_ref, revision, delay, endUtc,
              mismatch ? "REVIEW_REQUIRED" : "SCHEDULED", mismatch ? "captured_amount_mismatch" : null],
          );
          if ((result.rowCount ?? 0) === 0) return false;
          await logEvent(client, id, { type: "CREATED", actor: "system", to: mismatch ? "REVIEW_REQUIRED" : "SCHEDULED", amount: payout, issue: mismatch ? "captured_amount_mismatch" : null });
          return true;
        });
        if (inserted) initialized += 1;
      } catch {
        failed += 1;
      }
    }
    return { initialized, failed };
  }

  /** The IDs of due payouts (see `claimDueLeased`). */
  async claimDue(limit = 20, leaseSeconds: number = AGENT_PAYOUT_LIMITS.leaseSeconds): Promise<string[]> {
    return (await this.claimDueLeased(limit, leaseSeconds)).map((claim) => claim.id);
  }

  /**
   * Due payouts, locked with FOR UPDATE SKIP LOCKED and leased, so two runs never take the same row. `token` names this very claim: the lease can be
   * extended only with it (`extendLease`), so a row another run or the office has since taken is never extended by a run that lost it.
   */
  async claimDueLeased(limit = 20, leaseSeconds: number = AGENT_PAYOUT_LIMITS.leaseSeconds): Promise<{ readonly id: string; readonly token: string }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new StoreValidationError("leaseSeconds must be 30-3600.");
    const claimed = await this.#pool.query<DbRow>(
      `UPDATE experience_agent_payouts SET claimed_until=clock_timestamp()+make_interval(secs => $2::int)
        WHERE id IN (SELECT id FROM experience_agent_payouts
                      WHERE next_check_at<=clock_timestamp() AND status IN (${WORKING_STATUSES})
                        AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
                      ORDER BY next_check_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, next_check_at, ${TOKEN_SQL} AS token`,
      [limit, leaseSeconds],
    );
    return [...claimed.rows].sort((a, b) => Date.parse(isoValue(a, "next_check_at")) - Date.parse(isoValue(b, "next_check_at"))).map((row) => ({ id: text(row, "id"), token: text(row, "token") }));
  }

  /**
   * Just before the job calls Stripe for this row: the lease runs again from now, and the version moves (the office's older screen is refused, and
   * while the lease lives the office's operations are refused). Null when this claim is no longer the row's (expired and taken, or changed): then
   * the job does not call Stripe for it.
   */
  async extendLease(payoutId: string, token: string, leaseSeconds: number = AGENT_PAYOUT_LIMITS.leaseSeconds): Promise<string | null> {
    if (typeof payoutId !== "string" || !UUID.test(payoutId) || typeof token !== "string" || token.length < 10) throw new StoreValidationError("The claim is invalid.");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new StoreValidationError("leaseSeconds must be 30-3600.");
    const extended = await this.#pool.query<DbRow>(
      `UPDATE experience_agent_payouts SET claimed_until=clock_timestamp()+make_interval(secs => $3::int),version=version+1
        WHERE id=$1::uuid AND claimed_until>clock_timestamp() AND ${TOKEN_SQL}=$2 AND status IN (${WORKING_STATUSES})
        RETURNING ${TOKEN_SQL} AS token`,
      [payoutId, token, leaseSeconds],
    );
    return extended.rows[0] ? text(extended.rows[0], "token") : null;
  }

  /**
   * Recalculates a claimed payout from the booking's refunds, disputes and the host's standing, and says what the job does next. A held, early or
   * empty payout rests (its next check is set here); a sent payout is checked for what must be taken back.
   */
  async prepare(payoutId: string, now: Date = new Date()): Promise<AgentPayoutPrepared> {
    validNow(now);
    return withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      const providerId = text(row, "provider_id");
      const bookingId = String(row.booking_id);
      const captured = integer(row, "captured_amount");
      if (status === "SUBMITTING" || status === "RESULT_UNKNOWN") {
        await client.query(
          `UPDATE experience_agent_payouts SET next_check_at=clock_timestamp()+make_interval(mins => $2::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, AGENT_PAYOUT_LIMITS.unknownRecheckMinutes],
        );
        return { kind: "reconcile", command: commandFromRow(row) };
      }
      if (status === "CANCELLED" || status === "REVIEW_REQUIRED") {
        await client.query("UPDATE experience_agent_payouts SET claimed_until=NULL WHERE id=$1::uuid", [payoutId]);
        return { kind: "idle" };
      }
      const calc = await calculate(client, providerId, bookingId, captured);
      if (calc.overlap) {
        if (status === "TRANSFERRED") {
          await client.query(
            "UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at='infinity',updated_at=clock_timestamp() WHERE id=$1::uuid",
            [payoutId],
          );
          await logEvent(client, payoutId, { type: "AMOUNT_OVERLAP", actor: "system", issue: "refund_dispute_exceed_captured" });
          return { kind: "idle" };
        }
        await client.query(
          `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',hold_reason=NULL,issue_code='refund_dispute_exceed_captured',claimed_until=NULL,
             next_check_at=clock_timestamp()+interval '30 days',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId],
        );
        await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: "refund_dispute_exceed_captured" });
        return { kind: "idle" };
      }
      const amounts = agentPayoutAmounts(captured, calc.refunded, calc.disputed);
      if (status === "TRANSFERRED") {
        await this.#afterTransfer(client, row, calc, amounts);
        return { kind: "idle" };
      }
      // Not sent yet: SCHEDULED or AWAITING_ACCOUNT.
      const changed = calc.refunded !== integer(row, "refunded_amount") || calc.disputed !== integer(row, "disputed_amount");
      const set = `refunded_amount=$2,disputed_amount=$3,niho_fee_amount=$4,payout_amount=$5`;
      if (calc.hold !== null) {
        await client.query(
          `UPDATE experience_agent_payouts SET ${set},status='SCHEDULED',hold_reason=$6,issue_code=NULL,claimed_until=NULL,
             next_check_at=clock_timestamp()+make_interval(mins => $7::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout, calc.hold, AGENT_PAYOUT_LIMITS.holdRecheckMinutes],
        );
        if (row.hold_reason !== calc.hold || status !== "SCHEDULED" || changed) await logEvent(client, payoutId, { type: "HELD", actor: "system", from: status, to: "SCHEDULED", issue: calc.hold.toLowerCase(), amount: amounts.payout });
        return { kind: "idle" };
      }
      if (amounts.payout === 0 && integer(row, "offset_amount") > 0) {
        // Amounts were already kept from this payout for earlier takings-back: it is not closed quietly, the office decides.
        await client.query(
          `UPDATE experience_agent_payouts SET ${set},status='REVIEW_REQUIRED',hold_reason=NULL,issue_code='offset_spent_payout_empty',claimed_until=NULL,
             next_check_at=clock_timestamp()+interval '30 days',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout],
        );
        await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: "offset_spent_payout_empty", amount: 0 });
        return { kind: "idle" };
      }
      if (amounts.payout === 0) {
        await client.query(
          `UPDATE experience_agent_payouts SET ${set},status='CANCELLED',hold_reason=NULL,issue_code=NULL,claimed_until=NULL,
             next_check_at=clock_timestamp()+interval '30 days',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout],
        );
        await logEvent(client, payoutId, { type: "CANCELLED", actor: "system", from: status, to: "CANCELLED", amount: 0 });
        return { kind: "idle" };
      }
      if (now.getTime() < Date.parse(isoValue(row, "due_at"))) {
        await client.query(
          `UPDATE experience_agent_payouts SET ${set},status='SCHEDULED',hold_reason=NULL,claimed_until=NULL,next_check_at=due_at,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout],
        );
        if (row.hold_reason !== null || changed) await logEvent(client, payoutId, { type: "RECALCULATED", actor: "system", from: status, to: "SCHEDULED", amount: amounts.payout });
        return { kind: "idle" };
      }
      await client.query(
        `UPDATE experience_agent_payouts SET ${set},hold_reason=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
        [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout],
      );
      return { kind: "destination", payoutId, providerId, publicBookingId: text(row, "public_booking_id"), paymentRef: text(row, "stripe_payment_ref"), capturedAmount: captured, refundedAmount: calc.refunded, disputeCount: calc.disputeCount };
    });
  }

  /** After a payout was sent: what the refunds and lost disputes since have made too much, as a new adjustment. */
  async #afterTransfer(client: PoolClient, row: DbRow, calc: Calculation, amounts: { readonly fee: number; readonly payout: number }): Promise<void> {
    const payoutId = text(row, "id");
    const delivered = (nullableInteger(row, "submitted_amount") ?? 0) + integer(row, "offset_amount");
    const claimed = await client.query<DbRow>(
      `SELECT COALESCE(sum(amount),0)::bigint AS claimed,
              COALESCE(sum(reversal_amount) FILTER (WHERE status IN ('REVERSAL_PENDING','RESULT_UNKNOWN')),0)::bigint AS pending_reversal
         FROM experience_agent_payout_adjustments WHERE payout_id=$1::uuid`,
      [payoutId],
    );
    const excess = delivered - amounts.payout - integer(claimed.rows[0]!, "claimed");
    await client.query(
      // A sent payout is looked at again only when a refund, a dispute or the host's standing changes (the triggers of 0097 wake it).
      `UPDATE experience_agent_payouts SET refunded_amount=$2,disputed_amount=$3,niho_fee_amount=$4,payout_amount=$5,claimed_until=NULL,
         next_check_at='infinity',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
      [payoutId, calc.refunded, calc.disputed, amounts.fee, amounts.payout],
    );
    if (excess <= 0) return;
    const reason: AgentAdjustmentReason = calc.disputed > integer(row, "disputed_amount") ? "DISPUTE" : "REFUND";
    const reversible = Math.max(0, (nullableInteger(row, "submitted_amount") ?? 0) - integer(row, "reversed_amount") - integer(claimed.rows[0]!, "pending_reversal"));
    const reversal = Math.min(excess, reversible);
    const id = randomUUID();
    await client.query(
      `INSERT INTO experience_agent_payout_adjustments (id,payout_id,provider_id,booking_id,reason,status,amount,reversal_amount,remaining_amount,offset_pending_since)
       VALUES ($1::uuid,$2::uuid,$3,$4::bigint,$5,$6,$7,$8,$9,CASE WHEN $6='OFFSET_PENDING' THEN clock_timestamp() END)`,
      [id, payoutId, row.provider_id, row.booking_id, reason, reversal > 0 ? "REVERSAL_PENDING" : "OFFSET_PENDING", excess, reversal, excess - reversal],
    );
    await logEvent(client, payoutId, { type: "ADJUSTMENT_CREATED", actor: "system", to: reversal > 0 ? "REVERSAL_PENDING" : "OFFSET_PENDING", amount: excess, adjustmentId: id, issue: reason.toLowerCase() });
  }

  /**
   * The payout has no account that can receive it: it waits (and the host is mailed on the due date, 7 and 30 days later); after 90 days
   * from the due date the office is asked. The right to be paid is not lost.
   */
  async awaitAccount(payoutId: string, reason: string, now: Date = new Date()): Promise<{ readonly status: AgentPayoutStatus; readonly mailQueued: boolean }> {
    validNow(now);
    issueOf(reason);
    return withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      if (status !== "SCHEDULED" && status !== "AWAITING_ACCOUNT") return { status, mailQueued: false };
      const dueMs = Date.parse(isoValue(row, "due_at"));
      const days = Math.floor((now.getTime() - dueMs) / DAY_MS);
      if (days >= AGENT_PAYOUT_LIMITS.accountEscalationDays) {
        await client.query(
          `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',hold_reason=NULL,issue_code='payout_account_missing_90d',claimed_until=NULL,
             next_check_at=clock_timestamp()+interval '30 days',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId],
        );
        await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: "payout_account_missing_90d" });
        return { status: "REVIEW_REQUIRED", mailQueued: false };
      }
      await client.query(
        `UPDATE experience_agent_payouts SET status='AWAITING_ACCOUNT',hold_reason=NULL,issue_code=$2,claimed_until=NULL,
           next_check_at=clock_timestamp()+make_interval(hours => $3::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
        [payoutId, reason, AGENT_PAYOUT_LIMITS.awaitingRecheckHours],
      );
      if (status !== "AWAITING_ACCOUNT" || row.issue_code !== reason) await logEvent(client, payoutId, { type: "AWAITING_ACCOUNT", actor: "system", from: status, to: "AWAITING_ACCOUNT", issue: reason });
      const stage = days >= 30 ? "d30" : days >= 7 ? "d7" : "d0";
      const dueDate = text((await client.query<DbRow>("SELECT to_char(due_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS due_date FROM experience_agent_payouts WHERE id=$1::uuid", [payoutId])).rows[0]!, "due_date");
      const providerId = text(row, "provider_id");
      const queued = await enqueueHostBookingMails(client, {
        providerId, topic: HOST_MAIL_TOPICS.agentPayoutAccountNeeded, aggregateType: "experience_agent_payout", aggregateId: payoutId,
        deduplicationKey: `agent-payout-account-needed:${providerId}:${dueDate}:${stage}`, payload: { v: 1, stage },
      });
      return { status: "AWAITING_ACCOUNT", mailQueued: queued > 0 };
    });
  }

  /** Stops a payout for the office (a Charge that is not the payment, a transfer Stripe refused for good). */
  async markReview(payoutId: string, issueCode: string, actor = "system"): Promise<void> {
    issueOf(issueCode);
    await withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      if (status === "TRANSFERRED" || status === "CANCELLED" || status === "REVIEW_REQUIRED") return;
      await client.query(
        `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',hold_reason=NULL,issue_code=$2,claimed_until=NULL,
           next_check_at=clock_timestamp()+interval '30 days',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
        [payoutId, issueCode],
      );
      await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor, from: status, to: "REVIEW_REQUIRED", issue: issueCode });
    });
  }

  /**
   * Starts the transfer: recalculates once more (the amounts and the hold must still be what the job saw), spends the amounts waiting to be
   * taken from this host's payouts (oldest first), and fixes the command, the destination and the amount to send before Stripe is asked.
   * Null when nothing is to be sent now. A payout fully spent on those amounts is finished here with no transfer.
   */
  async begin(
    payoutId: string,
    input: { readonly destination: { readonly connectAccountId: string; readonly accountRef: string }; readonly charge: { readonly ref: string; readonly amount: number; readonly currency: string } },
    now: Date = new Date(),
  ): Promise<AgentPayoutCommand | null> {
    validNow(now);
    if (!UUID.test(input.destination.connectAccountId) || !ACCOUNT_REF.test(input.destination.accountRef) || !CHARGE_REF.test(input.charge.ref)) throw new StoreValidationError("The destination or the charge is invalid.");
    return withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      if (status !== "SCHEDULED" && status !== "AWAITING_ACCOUNT") return null;
      // The destination is checked again under the lock: it must still be this host's valid payout account, with the ID that was read.
      const stillValid = await client.query(
        `SELECT 1 FROM experience_connect_accounts WHERE id=$1::uuid AND provider_id=$2 AND purpose='PAYOUT' AND retired_at IS NULL AND stripe_account_ref=$3 FOR SHARE`,
        [input.destination.connectAccountId, row.provider_id, input.destination.accountRef],
      );
      if ((stillValid.rowCount ?? 0) === 0) {
        await client.query(
          `UPDATE experience_agent_payouts SET status='AWAITING_ACCOUNT',hold_reason=NULL,issue_code='payout_account_changed',claimed_until=NULL,
             next_check_at=clock_timestamp()+make_interval(hours => $2::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, AGENT_PAYOUT_LIMITS.awaitingRecheckHours],
        );
        await logEvent(client, payoutId, { type: "AWAITING_ACCOUNT", actor: "system", from: status, to: "AWAITING_ACCOUNT", issue: "payout_account_changed" });
        return null;
      }
      const captured = integer(row, "captured_amount");
      const calc = await calculate(client, text(row, "provider_id"), String(row.booking_id), captured);
      if (calc.overlap || calc.hold !== null || Date.parse(isoValue(row, "due_at")) > now.getTime()) {
        await client.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid", [payoutId]);
        return null;
      }
      const amounts = agentPayoutAmounts(captured, calc.refunded, calc.disputed);
      if (amounts.payout === 0 || calc.refunded !== integer(row, "refunded_amount") || calc.disputed !== integer(row, "disputed_amount")) {
        // The amounts moved since the job's calculation: back to a fresh one.
        await client.query("UPDATE experience_agent_payouts SET claimed_until=NULL,next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid", [payoutId]);
        return null;
      }
      if (input.charge.amount !== captured || input.charge.currency.toUpperCase() !== "JPY") {
        await client.query(
          `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',issue_code='charge_mismatch',claimed_until=NULL,next_check_at=clock_timestamp()+interval '30 days',
             version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId],
        );
        await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: "charge_mismatch" });
        return null;
      }
      let offset = integer(row, "offset_amount");
      if (offset > amounts.payout) {
        await client.query(
          `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',issue_code='offset_exceeds_payout',claimed_until=NULL,next_check_at=clock_timestamp()+interval '30 days',
             version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId],
        );
        await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: "offset_exceeds_payout" });
        return null;
      }
      let available = amounts.payout - offset;
      const waiting = await client.query<DbRow>(
        `SELECT id::text AS id, remaining_amount FROM experience_agent_payout_adjustments
          WHERE provider_id=$1 AND status='OFFSET_PENDING' AND remaining_amount>0 AND payout_id<>$2::uuid
          ORDER BY created_at, experience_agent_payout_adjustments.id FOR UPDATE`,
        [row.provider_id, payoutId],
      );
      for (const adjustment of waiting.rows) {
        if (available <= 0) break;
        const take = Math.min(available, integer(adjustment, "remaining_amount"));
        await client.query(
          "INSERT INTO experience_agent_payout_offsets (adjustment_id,from_payout_id,amount) VALUES ($1::uuid,$2::uuid,$3)",
          [adjustment.id, payoutId, take],
        );
        const left = integer(adjustment, "remaining_amount") - take;
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET remaining_amount=$2::bigint,status=CASE WHEN $2::bigint=0 THEN 'OFFSET_APPLIED' ELSE status END,version=version+1,updated_at=clock_timestamp()
            WHERE id=$1::uuid`,
          [adjustment.id, left],
        );
        await logEvent(client, payoutId, { type: "OFFSET_APPLIED", actor: "system", amount: take, adjustmentId: String(adjustment.id) });
        available -= take;
        offset += take;
      }
      const submitted = amounts.payout - offset;
      const commandId = randomUUID();
      if (submitted === 0) {
        // Everything is owed to earlier amounts: there is nothing to send.
        await client.query(
          `UPDATE experience_agent_payouts SET status='TRANSFERRED',hold_reason=NULL,issue_code=NULL,command_id=$2::uuid,command_created_at=clock_timestamp(),
             destination_connect_account_id=$3::uuid,destination_account_ref=$4,stripe_charge_ref=$5,submitted_amount=0,offset_amount=$6,transferred_at=clock_timestamp(),
             claimed_until=NULL,next_check_at='infinity',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, commandId, input.destination.connectAccountId, input.destination.accountRef, input.charge.ref, offset],
        );
        await logEvent(client, payoutId, { type: "OFFSET_ONLY", actor: "system", from: status, to: "TRANSFERRED", amount: 0 });
        return null;
      }
      const updated = await client.query<DbRow>(
        `UPDATE experience_agent_payouts SET status='SUBMITTING',hold_reason=NULL,issue_code=NULL,command_id=$2::uuid,command_created_at=clock_timestamp(),
           destination_connect_account_id=$3::uuid,destination_account_ref=$4,stripe_charge_ref=$5,submitted_amount=$6,offset_amount=$7,attempts=attempts+1,
           next_check_at=clock_timestamp()+make_interval(mins => $8::int),version=version+1,updated_at=clock_timestamp()
          WHERE id=$1::uuid RETURNING command_id::text AS command_id, command_created_at, destination_account_ref, stripe_charge_ref, submitted_amount, id::text AS id`,
        [payoutId, commandId, input.destination.connectAccountId, input.destination.accountRef, input.charge.ref, submitted, offset, AGENT_PAYOUT_LIMITS.unknownRecheckMinutes],
      );
      await logEvent(client, payoutId, { type: "SUBMITTING", actor: "system", from: status, to: "SUBMITTING", amount: submitted });
      return commandFromRow({ ...updated.rows[0]!, public_booking_id: row.public_booking_id });
    });
  }

  /** Writes what the transfer's lookup or creation answered. The row must still hold that command. */
  async recordTransfer(payoutId: string, commandId: string, answer: AgentPayoutTransferAnswer): Promise<AgentPayoutStatus> {
    if (typeof commandId !== "string" || !UUID.test(commandId)) throw new StoreValidationError("commandId is invalid.");
    if ((answer.kind === "transferred" || answer.kind === "already_transferred") && !TRANSFER_REF.test(answer.stripeTransferRef)) throw new StoreValidationError("stripeTransferRef is invalid.");
    if (answer.kind === "account_not_ready" || answer.kind === "review_required") issueOf(answer.issueCode);
    return withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      if (row.command_id !== commandId || (status !== "SUBMITTING" && status !== "RESULT_UNKNOWN")) {
        if (status === "TRANSFERRED" && (answer.kind === "transferred" || answer.kind === "already_transferred") && row.stripe_transfer_ref === answer.stripeTransferRef) return status;
        throw new StoreConflictError("The payout no longer holds this transfer command.");
      }
      if (answer.kind === "transferred" || answer.kind === "already_transferred") {
        await client.query(
          `UPDATE experience_agent_payouts SET status='TRANSFERRED',stripe_transfer_ref=$2,transferred_at=clock_timestamp(),issue_code=NULL,claimed_until=NULL,
             next_check_at=clock_timestamp()+interval '1 minute',version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, answer.stripeTransferRef],
        );
        await logEvent(client, payoutId, { type: answer.kind === "transferred" ? "TRANSFERRED" : "TRANSFER_ADOPTED", actor: "system", from: status, to: "TRANSFERRED", amount: nullableInteger(row, "submitted_amount") });
        return "TRANSFERRED";
      }
      if (answer.kind === "unknown") {
        await client.query(
          `UPDATE experience_agent_payouts SET status='RESULT_UNKNOWN',issue_code='agent_payout_transfer_result_unknown',claimed_until=NULL,
             next_check_at=clock_timestamp()+make_interval(mins => $2::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, AGENT_PAYOUT_LIMITS.unknownRecheckMinutes],
        );
        if (status !== "RESULT_UNKNOWN") await logEvent(client, payoutId, { type: "RESULT_UNKNOWN", actor: "system", from: status, to: "RESULT_UNKNOWN", issue: "agent_payout_transfer_result_unknown" });
        return "RESULT_UNKNOWN";
      }
      if (answer.kind === "account_not_ready") {
        // Stripe refused for want of the transfers capability: nothing was sent, so the payout waits for the account again (what was spent on offsets stays spent).
        await client.query(
          `UPDATE experience_agent_payouts SET status='AWAITING_ACCOUNT',issue_code=$2,submitted_amount=NULL,command_id=NULL,command_created_at=NULL,claimed_until=NULL,
             next_check_at=clock_timestamp()+make_interval(hours => $3::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [payoutId, answer.issueCode, AGENT_PAYOUT_LIMITS.awaitingRecheckHours],
        );
        await logEvent(client, payoutId, { type: "AWAITING_ACCOUNT", actor: "system", from: status, to: "AWAITING_ACCOUNT", issue: answer.issueCode });
        return "AWAITING_ACCOUNT";
      }
      await client.query(
        `UPDATE experience_agent_payouts SET status='REVIEW_REQUIRED',issue_code=$2,claimed_until=NULL,next_check_at=clock_timestamp()+interval '30 days',
           version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
        [payoutId, answer.issueCode],
      );
      await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", issue: answer.issueCode });
      return "REVIEW_REQUIRED";
    });
  }

  /* ---------- taking back after a payout was sent ---------- */

  /** Adjustments whose reversal is to be asked of Stripe (or looked up), leased. */
  async claimDueReversals(limit = 20, leaseSeconds: number = AGENT_PAYOUT_LIMITS.leaseSeconds): Promise<ClaimedAgentReversal[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    const claimed = await this.#pool.query<DbRow>(
      `UPDATE experience_agent_payout_adjustments a SET claimed_until=clock_timestamp()+make_interval(secs => $2::int),version=a.version+1
        FROM experience_agent_payouts p, bookings b
       WHERE a.id IN (SELECT id FROM experience_agent_payout_adjustments
                       WHERE status IN ('REVERSAL_PENDING','RESULT_UNKNOWN') AND next_attempt_at<=clock_timestamp()
                         AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
                       ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
         AND p.id=a.payout_id AND b.provider_id=p.provider_id AND b.id=p.booking_id
       RETURNING a.id::text AS id, a.payout_id::text AS payout_id, b.public_booking_id::text AS public_booking_id, p.stripe_transfer_ref, a.reversal_amount,
         to_char(a.claimed_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS token`,
      [limit, leaseSeconds],
    );
    return claimed.rows.flatMap((row) => (typeof row.stripe_transfer_ref === "string" && TRANSFER_REF.test(row.stripe_transfer_ref) && integer(row, "reversal_amount") > 0
      ? [{ adjustmentId: text(row, "id"), payoutId: text(row, "payout_id"), publicBookingId: text(row, "public_booking_id"), stripeTransferRef: row.stripe_transfer_ref, amount: integer(row, "reversal_amount"), leaseToken: text(row, "token") }]
      : []));
  }

  /** As `extendLease`, for a taking-back about to be asked of Stripe. Null when the claim is no longer this run's. */
  async extendReversalLease(adjustmentId: string, token: string, leaseSeconds: number = AGENT_PAYOUT_LIMITS.leaseSeconds): Promise<string | null> {
    if (typeof adjustmentId !== "string" || !UUID.test(adjustmentId) || typeof token !== "string" || token.length < 10) throw new StoreValidationError("The claim is invalid.");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new StoreValidationError("leaseSeconds must be 30-3600.");
    const extended = await this.#pool.query<DbRow>(
      `UPDATE experience_agent_payout_adjustments SET claimed_until=clock_timestamp()+make_interval(secs => $3::int),version=version+1
        WHERE id=$1::uuid AND claimed_until>clock_timestamp() AND ${TOKEN_SQL}=$2 AND status IN ('REVERSAL_PENDING','RESULT_UNKNOWN')
        RETURNING ${TOKEN_SQL} AS token`,
      [adjustmentId, token, leaseSeconds],
    );
    return extended.rows[0] ? text(extended.rows[0], "token") : null;
  }

  async recordReversal(adjustmentId: string, answer: AgentReversalAnswer): Promise<AgentAdjustmentStatus> {
    if (typeof adjustmentId !== "string" || !UUID.test(adjustmentId)) throw new StoreValidationError("adjustmentId is invalid.");
    if (answer.kind === "reversed" && !REVERSAL_REF.test(answer.stripeReversalRef)) throw new StoreValidationError("stripeReversalRef is invalid.");
    if (answer.kind === "review_required") issueOf(answer.issueCode);
    return withTransaction(this.#pool, async (client) => {
      const head = await client.query<DbRow>("SELECT payout_id::text AS payout_id FROM experience_agent_payout_adjustments WHERE id=$1::uuid", [adjustmentId]);
      if (!head.rows[0]) throw new StoreNotFoundError("agent payout adjustment");
      const payout = await lockPayout(client, text(head.rows[0], "payout_id"));
      if (!payout) throw new StoreNotFoundError("agent payout");
      const found = await client.query<DbRow>("SELECT * FROM experience_agent_payout_adjustments WHERE id=$1::uuid FOR UPDATE", [adjustmentId]);
      const adjustment = found.rows[0]!;
      const status = text(adjustment, "status") as AgentAdjustmentStatus;
      if (status !== "REVERSAL_PENDING" && status !== "RESULT_UNKNOWN") throw new StoreConflictError("The adjustment is not waiting for a reversal.");
      const payoutId = text(payout, "id");
      if (answer.kind === "reversed") {
        const reversal = integer(adjustment, "reversal_amount");
        const left = integer(adjustment, "amount") - reversal;
        await client.query("UPDATE experience_agent_payouts SET reversed_amount=reversed_amount+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid", [payoutId, reversal]);
        const next: AgentAdjustmentStatus = left === 0 ? "REVERSED" : "OFFSET_PENDING";
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status=$2,stripe_reversal_ref=$3,remaining_amount=$4,issue_code=NULL,claimed_until=NULL,
             offset_pending_since=CASE WHEN $2='OFFSET_PENDING' THEN clock_timestamp() END,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [adjustmentId, next, answer.stripeReversalRef, left],
        );
        await logEvent(client, payoutId, { type: "REVERSED", actor: "system", from: status, to: next, amount: reversal, adjustmentId });
        return next;
      }
      if (answer.kind === "insufficient_balance") {
        // Stripe cannot take it back now: the whole amount waits for the host's later payouts.
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status='OFFSET_PENDING',reversal_amount=0,remaining_amount=amount,issue_code='reversal_balance_insufficient',claimed_until=NULL,offset_pending_since=clock_timestamp(),
             version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [adjustmentId],
        );
        await logEvent(client, payoutId, { type: "OFFSET_PENDING", actor: "system", from: status, to: "OFFSET_PENDING", amount: integer(adjustment, "amount"), adjustmentId, issue: "reversal_balance_insufficient" });
        return "OFFSET_PENDING";
      }
      if (answer.kind === "unknown") {
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status='RESULT_UNKNOWN',issue_code='agent_reversal_result_unknown',attempts=attempts+1,claimed_until=NULL,
             next_attempt_at=clock_timestamp()+make_interval(mins => $2::int),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [adjustmentId, AGENT_PAYOUT_LIMITS.unknownRecheckMinutes],
        );
        return "RESULT_UNKNOWN";
      }
      await client.query(
        `UPDATE experience_agent_payout_adjustments SET status='REVIEW_REQUIRED',issue_code=$2,claimed_until=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
        [adjustmentId, answer.issueCode],
      );
      await logEvent(client, payoutId, { type: "REVIEW_REQUIRED", actor: "system", from: status, to: "REVIEW_REQUIRED", adjustmentId, issue: answer.issueCode });
      return "REVIEW_REQUIRED";
    });
  }

  /** Amounts that waited 90 days (from when they began to wait) to be taken from later payouts go to the office; each leaves an event. */
  async escalateStaleOffsets(now: Date = new Date()): Promise<number> {
    validNow(now);
    const moved = await this.#pool.query(
      `WITH moved AS (
         UPDATE experience_agent_payout_adjustments SET status='REVIEW_REQUIRED',issue_code='offset_pending_90d',version=version+1,updated_at=clock_timestamp()
          WHERE status='OFFSET_PENDING' AND claimed_until IS NULL AND offset_pending_since < $1::timestamptz - make_interval(days => $2::int)
          RETURNING id, payout_id, remaining_amount)
       INSERT INTO experience_agent_payout_events (payout_id,adjustment_id,event_type,actor,from_status,to_status,amount,issue_code)
       SELECT payout_id,id,'REVIEW_REQUIRED','system','OFFSET_PENDING','REVIEW_REQUIRED',remaining_amount,'offset_pending_90d' FROM moved`,
      [now.toISOString(), AGENT_PAYOUT_LIMITS.offsetEscalationDays],
    );
    return moved.rowCount ?? 0;
  }

  /* ---------- the office ---------- */

  async getForBooking(publicBookingId: string): Promise<AgentPayoutDetail | null> {
    const id = publicBookingIdOf(publicBookingId);
    const found = await this.#pool.query<DbRow>(`${SELECT_PAYOUT} WHERE b.public_booking_id=$1::uuid`, [id]);
    const row = found.rows[0];
    if (!row) return null;
    const payoutId = text(row, "id");
    const [adjustments, events] = await Promise.all([
      this.#pool.query<DbRow>("SELECT *, id::text AS id, payout_id::text AS payout_id FROM experience_agent_payout_adjustments WHERE payout_id=$1::uuid ORDER BY created_at, experience_agent_payout_adjustments.id", [payoutId]),
      this.#pool.query<DbRow>("SELECT * FROM experience_agent_payout_events WHERE payout_id=$1::uuid ORDER BY id DESC LIMIT 50", [payoutId]),
    ]);
    return {
      payout: payoutFromRow(row),
      adjustments: adjustments.rows.map(adjustmentFromRow),
      events: events.rows.map((event) => ({
        eventType: text(event, "event_type"), actor: text(event, "actor"), fromStatus: nullableText(event, "from_status"), toStatus: nullableText(event, "to_status"),
        amount: nullableInteger(event, "amount"), issueCode: nullableText(event, "issue_code"), note: nullableText(event, "note"), occurredAtUtc: isoValue(event, "occurred_at"),
      })),
    };
  }

  /** What needs a person: stopped payouts, a transfer unknown for over 23 hours, a registration waiting past the last reminder, a taking-back that stays. */
  async listAttention(now: Date = new Date(), limit = 100): Promise<AgentPayoutAttentionItem[]> {
    validNow(now);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    const iso = now.toISOString();
    const payouts = await this.#pool.query<DbRow>(
      `SELECT p.provider_id, p.status, p.issue_code, p.payout_amount, p.updated_at, b.public_booking_id::text AS public_booking_id
         FROM experience_agent_payouts p JOIN bookings b ON b.provider_id=p.provider_id AND b.id=p.booking_id
        WHERE p.status='REVIEW_REQUIRED'
           OR (p.status='RESULT_UNKNOWN' AND p.command_created_at < $1::timestamptz - make_interval(hours => $2::int))
           OR (p.status='SUBMITTING' AND p.command_created_at < $1::timestamptz - make_interval(hours => $2::int))
           OR (p.status='AWAITING_ACCOUNT' AND p.due_at < $1::timestamptz - make_interval(days => $3::int))
        ORDER BY p.updated_at LIMIT $4`,
      [iso, AGENT_PAYOUT_LIMITS.unknownAttentionHours, AGENT_PAYOUT_LIMITS.awaitingAttentionDays, limit],
    );
    const adjustments = await this.#pool.query<DbRow>(
      `SELECT a.provider_id, a.status, a.issue_code, a.amount, a.created_at, b.public_booking_id::text AS public_booking_id
         FROM experience_agent_payout_adjustments a JOIN bookings b ON b.provider_id=a.provider_id AND b.id=a.booking_id
        WHERE a.status='REVIEW_REQUIRED'
           OR (a.status IN ('OFFSET_PENDING','REVERSAL_PENDING','RESULT_UNKNOWN') AND COALESCE(a.offset_pending_since, a.created_at) < $1::timestamptz - make_interval(days => $2::int))
        ORDER BY a.created_at LIMIT $3`,
      [iso, AGENT_PAYOUT_LIMITS.adjustmentAttentionDays, limit],
    );
    return [
      ...payouts.rows.map((row): AgentPayoutAttentionItem => ({
        kind: "PAYOUT", publicBookingId: text(row, "public_booking_id"), providerId: text(row, "provider_id"), status: text(row, "status"),
        issueCode: nullableText(row, "issue_code"), amount: integer(row, "payout_amount"), sinceUtc: isoValue(row, "updated_at"),
      })),
      ...adjustments.rows.map((row): AgentPayoutAttentionItem => ({
        kind: "ADJUSTMENT", publicBookingId: text(row, "public_booking_id"), providerId: text(row, "provider_id"), status: text(row, "status"),
        issueCode: nullableText(row, "issue_code"), amount: integer(row, "amount"), sinceUtc: isoValue(row, "created_at"),
      })),
    ];
  }

  /** The office's operations. Each compares the version it was shown, and leaves the actor in the events. */
  async adminAct(actorId: string, publicBookingId: string, input: AgentPayoutAdminInput): Promise<AgentPayoutDetail> {
    const actor = adminId(actorId);
    const id = publicBookingIdOf(publicBookingId);
    if (!(AGENT_PAYOUT_ADMIN_ACTIONS as readonly string[]).includes(input?.action)) throw new StoreValidationError("action is not an agent payout operation.");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new StoreValidationError("expectedVersion is invalid.");
    const note = input.note === undefined ? null : input.note.trim();
    if (note !== null && (note.length < 1 || note.length > 1000)) throw new StoreValidationError("note must be 1-1000 characters.");
    if (input.adjustmentId !== undefined && !UUID.test(input.adjustmentId)) throw new StoreValidationError("adjustmentId is invalid.");
    const head = await this.#pool.query<DbRow>(`SELECT p.id::text AS id FROM experience_agent_payouts p JOIN bookings b ON b.provider_id=p.provider_id AND b.id=p.booking_id WHERE b.public_booking_id=$1::uuid`, [id]);
    if (!head.rows[0]) throw new StoreNotFoundError("agent payout");
    const payoutId = text(head.rows[0], "id");
    await withTransaction(this.#pool, async (client) => {
      const row = await lockPayout(client, payoutId);
      if (!row) throw new StoreNotFoundError("agent payout");
      const status = text(row, "status") as AgentPayoutStatus;
      const hasCommand = row.command_id !== null && row.command_id !== undefined;
      const confirmed = input.confirmedNotSent === true;
      // The job is working on it (its lease has not run out): wait, the answer would race the job's.
      const leased = await client.query("SELECT 1 FROM experience_agent_payouts WHERE id=$1::uuid AND claimed_until>clock_timestamp()", [payoutId]);
      if ((leased.rowCount ?? 0) > 0 && (input.action === "RECALCULATE" || input.action === "RECREATE" || input.action === "CLOSE")) throw new StoreConflictError("The payout is being worked on; try again in a few minutes.");
      if (input.action === "RECALCULATE" || input.action === "RECREATE" || input.action === "CLOSE") {
        if (integer(row, "version") !== input.expectedVersion) throw new StoreConflictError("The payout changed; read it again.");
        if (input.action === "RECALCULATE") {
          if (!["SCHEDULED", "AWAITING_ACCOUNT", "REVIEW_REQUIRED"].includes(status) || hasCommand) throw new StoreConflictError("This payout cannot be recalculated; it has a transfer command.");
          await client.query(
            `UPDATE experience_agent_payouts SET status='SCHEDULED',hold_reason=NULL,issue_code=NULL,attempts=0,claimed_until=NULL,next_check_at=clock_timestamp(),
               version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
            [payoutId],
          );
          await logEvent(client, payoutId, { type: "OFFICE_RECALCULATE", actor, from: status, to: "SCHEDULED", note });
        } else if (input.action === "RECREATE") {
          if (!["RESULT_UNKNOWN", "REVIEW_REQUIRED"].includes(status) || !hasCommand || row.stripe_transfer_ref !== null) throw new StoreConflictError("This payout has no unfinished transfer to make again.");
          if (!confirmed) throw new StoreValidationError("Confirm in Stripe that nothing was sent.");
          await requireUnknownWindowPassed(client, payoutId, status);
          await client.query(
            `UPDATE experience_agent_payouts SET status='SCHEDULED',hold_reason=NULL,issue_code=NULL,command_id=NULL,command_created_at=NULL,submitted_amount=NULL,
               attempts=0,claimed_until=NULL,next_check_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
            [payoutId],
          );
          await logEvent(client, payoutId, { type: "OFFICE_RECREATE", actor, from: status, to: "SCHEDULED", note: `${note ?? ""}${note ? " / " : ""}previous command ${String(row.command_id)}` });
        } else {
          if (!["SCHEDULED", "AWAITING_ACCOUNT", "REVIEW_REQUIRED", "RESULT_UNKNOWN"].includes(status) || row.stripe_transfer_ref !== null) throw new StoreConflictError("This payout cannot be closed without sending.");
          if (integer(row, "offset_amount") > 0) throw new StoreConflictError("Amounts were already kept from this payout; it cannot be closed without sending.");
          if (hasCommand && !confirmed) throw new StoreValidationError("Confirm in Stripe that nothing was sent.");
          await requireUnknownWindowPassed(client, payoutId, status);
          if (note === null) throw new StoreValidationError("A note is required to close a payout without sending.");
          await client.query(
            `UPDATE experience_agent_payouts SET status='CANCELLED',hold_reason=NULL,issue_code='closed_by_office',claimed_until=NULL,next_check_at=clock_timestamp()+interval '30 days',
               version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
            [payoutId],
          );
          await logEvent(client, payoutId, { type: "OFFICE_CLOSE", actor, from: status, to: "CANCELLED", note, issue: "closed_by_office" });
        }
        return;
      }
      if (input.adjustmentId === undefined) throw new StoreValidationError("adjustmentId is required.");
      const found = await client.query<DbRow>("SELECT * FROM experience_agent_payout_adjustments WHERE id=$1::uuid AND payout_id=$2::uuid FOR UPDATE", [input.adjustmentId, payoutId]);
      const adjustment = found.rows[0];
      if (!adjustment) throw new StoreNotFoundError("agent payout adjustment");
      if (integer(adjustment, "version") !== input.expectedVersion) throw new StoreConflictError("The adjustment changed; read it again.");
      const leasedAdjustment = await client.query("SELECT 1 FROM experience_agent_payout_adjustments WHERE id=$1::uuid AND claimed_until>clock_timestamp()", [input.adjustmentId]);
      if ((leasedAdjustment.rowCount ?? 0) > 0) throw new StoreConflictError("The adjustment is being worked on; try again in a few minutes.");
      // The job owns REVERSAL_PENDING; the office acts on what stopped (REVIEW_REQUIRED), what waits (OFFSET_PENDING, to write it off), and an unknown reversal only after checking.
      const allowed: readonly AgentAdjustmentStatus[] = input.action === "RESUME_ADJUSTMENT" ? ["REVIEW_REQUIRED"]
        : input.action === "OFFSET" ? ["REVIEW_REQUIRED", "RESULT_UNKNOWN"] : ["REVIEW_REQUIRED", "OFFSET_PENDING", "RESULT_UNKNOWN"];
      const adjStatus = text(adjustment, "status") as AgentAdjustmentStatus;
      if (!allowed.includes(adjStatus)) throw new StoreConflictError("The adjustment is in a state this operation cannot act on.");
      if (adjStatus === "RESULT_UNKNOWN" && !confirmed) throw new StoreValidationError("Confirm in Stripe that nothing was reversed.");
      const reversedRef = adjustment.stripe_reversal_ref !== null && adjustment.stripe_reversal_ref !== undefined;
      if (input.action === "RESUME_ADJUSTMENT") {
        // A reversal that was made (a partial one) is never asked for again.
        if (reversedRef || integer(adjustment, "reversal_amount") === 0) throw new StoreConflictError("Only a stopped reversal that was never made can be resumed.");
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status='REVERSAL_PENDING',issue_code=NULL,claimed_until=NULL,next_attempt_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [input.adjustmentId],
        );
        await logEvent(client, payoutId, { type: "OFFICE_RESUME_ADJUSTMENT", actor, from: adjStatus, to: "REVERSAL_PENDING", adjustmentId: input.adjustmentId, note });
      } else if (input.action === "OFFSET") {
        // What is left to take: the amount, less what Stripe already took back (a made reversal stays counted), less what later payouts already absorbed.
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status='OFFSET_PENDING',offset_pending_since=clock_timestamp(),
             reversal_amount=CASE WHEN stripe_reversal_ref IS NULL THEN 0 ELSE reversal_amount END,
             remaining_amount=GREATEST(0,amount-CASE WHEN stripe_reversal_ref IS NULL THEN 0 ELSE reversal_amount END-COALESCE((SELECT sum(o.amount) FROM experience_agent_payout_offsets o WHERE o.adjustment_id=$1::uuid),0)),
             issue_code=NULL,claimed_until=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [input.adjustmentId],
        );
        await logEvent(client, payoutId, { type: "OFFICE_OFFSET", actor, from: adjStatus, to: "OFFSET_PENDING", adjustmentId: input.adjustmentId, note, amount: integer(adjustment, "amount") });
      } else {
        if (note === null) throw new StoreValidationError("A note is required to record a loss.");
        await client.query(
          `UPDATE experience_agent_payout_adjustments SET status='LOSS_RECORDED',remaining_amount=0,claimed_until=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          [input.adjustmentId],
        );
        await logEvent(client, payoutId, { type: "OFFICE_LOSS", actor, from: adjStatus, to: "LOSS_RECORDED", adjustmentId: input.adjustmentId, note, amount: integer(adjustment, "remaining_amount") });
      }
    });
    return (await this.getForBooking(id))!;
  }

  /* ---------- the host (OWNER) ---------- */

  /** `month` (YYYY-MM, Japan): only payments captured in that month, as the sales screen's month is. */
  async listForHost(actor: HostActor, options: { readonly limit?: number; readonly month?: string } = {}): Promise<HostAgentPayoutRow[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    if (options.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month)) throw new StoreValidationError("month must be YYYY-MM.");
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const found = await client.query<DbRow>(
        `SELECT p.captured_amount,p.refunded_amount,p.disputed_amount,p.niho_fee_amount,p.payout_amount,p.due_at,p.status,p.transferred_at,p.offset_amount,p.submitted_amount,
                b.public_booking_id::text AS public_booking_id, COALESCE(b.occurrence_snapshot->>'localDate','') AS local_date,
                COALESCE((SELECT sum(a.amount) FROM experience_agent_payout_adjustments a WHERE a.payout_id=p.id AND a.status <> 'LOSS_RECORDED'),0)::bigint AS taken_back
           FROM experience_agent_payouts p JOIN bookings b ON b.provider_id=p.provider_id AND b.id=p.booking_id
          WHERE p.provider_id=$1
            AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM payment_ledger_entries l WHERE l.provider_id=p.provider_id AND l.booking_id=p.booking_id AND l.kind='PAYMENT_CAPTURED'
                  AND l.stripe_payment_ref=p.stripe_payment_ref AND to_char(l.occurred_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM')=$3))
          ORDER BY p.due_at DESC, p.id LIMIT $2`,
        [actor.providerId, limit, options.month ?? null],
      );
      return found.rows.map((row): HostAgentPayoutRow => {
        const status = text(row, "status") as AgentPayoutStatus;
        const state: HostAgentPayoutRow["state"] = status === "SCHEDULED" ? "SCHEDULED" : status === "AWAITING_ACCOUNT" ? "AWAITING_ACCOUNT"
          : status === "TRANSFERRED" ? "TRANSFERRED" : status === "CANCELLED" ? "CANCELLED" : "REVIEWING";
        return {
          publicBookingId: text(row, "public_booking_id"), experienceDate: text(row, "local_date"), capturedAmount: integer(row, "captured_amount"),
          refundedAmount: integer(row, "refunded_amount") + integer(row, "disputed_amount"), nihoFeeAmount: integer(row, "niho_fee_amount"), payoutAmount: integer(row, "payout_amount"),
          dueAtUtc: isoValue(row, "due_at"), state, transferredAtUtc: nullableIso(row, "transferred_at"), sentAmount: nullableInteger(row, "submitted_amount"), takenBackAmount: integer(row, "taken_back"), offsetAmount: integer(row, "offset_amount"),
        };
      });
    });
  }
}
