import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { requireBookingsOwner, publicBookingIdOf } from "./host-guest-bookings.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";

const ADMIN_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const ISSUE = /^[a-z0-9_]{1,80}$/;

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
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function adminId(value: unknown): string {
  if (typeof value !== "string" || !ADMIN_ID.test(value)) throw new StoreValidationError("adminUserId is invalid.");
  return value;
}

export interface ExperienceSupportCase {
  readonly publicBookingId: string;
  readonly assignedAdminUserId: string | null;
  readonly internalMemo: string | null;
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly updatedAtUtc: string;
  readonly events: readonly {
    readonly type: "ASSIGNEE_CHANGED" | "INTERNAL_MEMO_CHANGED" | "GUEST_CONTACT_SENT" | "SUPPORT_ACTION";
    readonly revision: number;
    readonly actorAdminUserId: string;
    readonly occurredAtUtc: string;
    readonly action: string | null;
    readonly outcome: string | null;
  }[];
}

export interface ExperienceSupportNotification {
  readonly id: string;
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly topic: "BOOKING_RECEIVED" | "PAYMENT_REVIEW" | "CANCELLATION_REQUEST" | "BOOKING_CANCELLED" | "REFUND_UPDATED" | "GUEST_MESSAGE";
  readonly createdAtUtc: string;
  readonly read: boolean;
}

export type SettlementStatus = "PREPARING" | "PROCESSING_COST_PENDING" | "PROCESSING" | "RESULT_UNKNOWN" | "REVIEW_REQUIRED" | "SETTLED";
export type SettlementCompensationStatus = "NOT_REQUIRED" | "PREPARED" | "SUBMITTING" | "TRANSFERRED" | "RESULT_UNKNOWN" | "RETRYABLE_FAILED" | "REVIEW_REQUIRED";

/** Read model shared by Admin and the provider OWNER. No Stripe account, charge, or personal fields leave this repository. */
export interface ExperienceSettlementSummary {
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly currency: string;
  readonly grossAmount: number;
  readonly feeRateBasisPoints: 1000 | 1500;
  readonly supportEnabled: boolean;
  readonly estimatedPlatformFee: number;
  readonly successfulRefundAmount: number | null;
  readonly pendingRefundAmount: number | null;
  readonly failedRefundCount: number | null;
  readonly actualProcessingFee: number | null;
  readonly actualProcessingFeeCurrency: string | null;
  readonly processingFeePayer: "ACCOUNT" | "APPLICATION" | null;
  readonly actualApplicationFee: number | null;
  readonly applicationFeeRefunded: number | null;
  readonly hostNetAfterRefunds: number | null;
  readonly nihoNetAfterProcessing: number | null;
  readonly compensationAmount: number | null;
  readonly compensationStatus: SettlementCompensationStatus;
  readonly status: SettlementStatus;
  readonly issueCode: string | null;
  readonly lastReconciledAtUtc: string | null;
  readonly final: boolean;
}

export interface StripeSettlementEvidence {
  readonly connectedAccountId: string;
  readonly currency: string;
  readonly grossAmount: number;
  readonly chargeRef: string | null;
  readonly balanceTransactionRef: string | null;
  readonly applicationFeeRef: string | null;
  readonly feePayer: "ACCOUNT" | "APPLICATION" | null;
  readonly processingFeeAmount: number | null;
  readonly processingFeeCurrency: string | null;
  readonly applicationFeeAmount: number | null;
  readonly applicationFeeRefunded: number | null;
  readonly successfulRefundAmount: number | null;
  readonly pendingRefundAmount: number | null;
  readonly refunds: readonly {
    readonly stripeRefundRef: string;
    readonly internalRefundId: string | null;
    readonly amount: number;
    readonly currency: string;
    readonly status: "succeeded" | "pending" | "requires_action" | "failed" | "canceled" | "unknown";
  }[];
  readonly refundHistoryTruncated: boolean;
  readonly issueCode?: string | null;
}

export interface SettlementTransferCommand {
  readonly commandId: string;
  readonly publicBookingId: string;
  readonly amount: number;
  readonly currency: string;
  readonly destinationAccountId: string;
  readonly transferGroup: string;
  readonly status: "PREPARED" | "SUBMITTING" | "TRANSFERRED" | "RESULT_UNKNOWN" | "RETRYABLE_FAILED" | "REVIEW_REQUIRED";
  readonly stripeTransferRef: string | null;
  readonly attempts: number;
  readonly createdAtUtc: string;
}

export interface SettlementSource {
  readonly publicBookingId: string;
  readonly connectedAccountId: string;
  readonly paymentIntentId: string;
  readonly currency: string;
  readonly grossAmount: number;
}

export interface SettlementInitializationResult {
  readonly initialized: number;
  readonly failed: number;
}

const SUMMARY_COLUMNS = `s.provider_id, b.public_booking_id::text AS public_booking_id, s.snapshot_hash, s.currency, s.gross_amount,
  s.fee_rate_basis_points, s.support_enabled, s.application_fee_amount, s.application_fee_refunded,
  s.processing_fee_amount, s.processing_fee_currency, s.stripe_fee_payer, s.successful_refund_amount, s.pending_refund_amount, s.failed_refund_count,
  s.compensation_amount, s.compensation_status, s.status, s.issue_code, s.last_reconciled_at`;

export function calculateSettlementNetAmounts(input: {
  readonly grossAmount: number | null;
  readonly successfulRefundAmount: number | null;
  readonly applicationFeeAmount: number | null;
  readonly applicationFeeRefunded: number | null;
  readonly processingFeeAmount: number | null;
  readonly feePayer: "ACCOUNT" | "APPLICATION" | null;
  readonly compensationAmount: number | null;
}): { readonly hostNet: number | null; readonly nihoNet: number | null } {
  const { grossAmount, successfulRefundAmount, applicationFeeAmount, applicationFeeRefunded, processingFeeAmount, feePayer, compensationAmount } = input;
  if ([grossAmount, successfulRefundAmount, applicationFeeAmount, applicationFeeRefunded, processingFeeAmount, compensationAmount].some((value) => value === null)
    || feePayer === null) return { hostNet: null, nihoNet: null };
  const netApplicationFee = applicationFeeAmount! - applicationFeeRefunded!;
  const hostNet = grossAmount! - successfulRefundAmount! - netApplicationFee
    - (feePayer === "ACCOUNT" ? processingFeeAmount! : 0) + compensationAmount!;
  return { hostNet, nihoNet: netApplicationFee - processingFeeAmount! };
}

function summaryFromRow(row: DbRow): ExperienceSettlementSummary {
  const bps = integer(row, "fee_rate_basis_points");
  if (bps !== 1000 && bps !== 1500) throw new StoreValidationError("Stored platform fee rate is invalid.");
  const gross = integer(row, "gross_amount");
  const fee = nullableInteger(row, "application_fee_amount");
  const status = text(row, "status") as SettlementStatus;
  const compStatus = text(row, "compensation_status") as SettlementCompensationStatus;
  const refunded = nullableInteger(row, "successful_refund_amount");
  const feeRefunded = nullableInteger(row, "application_fee_refunded");
  const processing = nullableInteger(row, "processing_fee_amount");
  const feePayer = nullableText(row, "stripe_fee_payer") as "ACCOUNT" | "APPLICATION" | null;
  const comp = nullableInteger(row, "compensation_amount");
  const netAmounts = calculateSettlementNetAmounts({
    grossAmount: gross, successfulRefundAmount: refunded, applicationFeeAmount: fee, applicationFeeRefunded: feeRefunded,
    processingFeeAmount: processing, feePayer, compensationAmount: comp,
  });
  const allFinal = status === "SETTLED" && refunded !== null && fee !== null && feeRefunded !== null && processing !== null && comp !== null
    && nullableText(row, "processing_fee_currency") === text(row, "currency") && feePayer !== null
    && nullableInteger(row, "pending_refund_amount") === 0 && nullableInteger(row, "failed_refund_count") === 0
    && (comp === 0 || compStatus === "TRANSFERRED") && netAmounts.hostNet !== null && netAmounts.nihoNet !== null;
  return {
    publicBookingId: text(row, "public_booking_id"),
    providerId: text(row, "provider_id"),
    currency: text(row, "currency"),
    grossAmount: gross,
    feeRateBasisPoints: bps,
    supportEnabled: row.support_enabled === true,
    estimatedPlatformFee: Math.floor(gross * bps / 10_000),
    successfulRefundAmount: refunded,
    pendingRefundAmount: nullableInteger(row, "pending_refund_amount"),
    failedRefundCount: nullableInteger(row, "failed_refund_count"),
    actualProcessingFee: processing,
    actualProcessingFeeCurrency: nullableText(row, "processing_fee_currency"),
    processingFeePayer: feePayer,
    actualApplicationFee: fee,
    applicationFeeRefunded: feeRefunded,
    hostNetAfterRefunds: allFinal ? netAmounts.hostNet : null,
    nihoNetAfterProcessing: allFinal ? netAmounts.nihoNet : null,
    compensationAmount: comp,
    compensationStatus: compStatus,
    status,
    issueCode: nullableText(row, "issue_code"),
    lastReconciledAtUtc: row.last_reconciled_at === null || row.last_reconciled_at === undefined ? null : isoValue(row, "last_reconciled_at"),
    final: allFinal,
  };
}

function transferFromRow(row: DbRow): SettlementTransferCommand {
  return {
    commandId: text(row, "command_id"),
    publicBookingId: text(row, "public_booking_id"),
    amount: integer(row, "amount"),
    currency: text(row, "currency"),
    destinationAccountId: text(row, "destination_account_ref"),
    transferGroup: text(row, "transfer_group"),
    status: text(row, "status") as SettlementTransferCommand["status"],
    stripeTransferRef: nullableText(row, "stripe_transfer_ref"),
    attempts: integer(row, "attempts"),
    createdAtUtc: isoValue(row, "created_at"),
  };
}

async function supportBookingConsent(client: Pick<PoolClient, "query">, providerId: string, bookingId: string): Promise<boolean> {
  const result = await client.query<DbRow>(
    `SELECT b.pricing_snapshot->'platformFee' AS platform_fee, (g.pii_erased_at IS NULL) AS pii_available
       FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
      WHERE b.provider_id=$1 AND b.id=$2::bigint`,
    [providerId, bookingId],
  );
  const fee = record(result.rows[0]?.platform_fee);
  return result.rows[0]?.pii_available === true && fee.supportEnabled === true && fee.basisPoints === 1500 && typeof fee.supportConsentVersion === "string" && fee.supportConsentVersion.length > 0
    && Number.isSafeInteger(fee.supportAgreementRevision) && Number(fee.supportAgreementRevision) > 0;
}

export class ExperienceSupportRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /** Admin only. Internal notes are returned only here; the separate host interface never selects this table. */
  async getCase(actor: { readonly nihoUserId: string }, publicBookingId: string): Promise<ExperienceSupportCase | null> {
    adminId(actor?.nihoUserId);
    const bookingId = publicBookingIdOf(publicBookingId);
    const found = await this.#pool.query<DbRow>(
      `SELECT c.assigned_admin_user_id, c.internal_memo, c.revision, c.updated_by, c.updated_at,
              b.provider_id, b.id::text AS booking_row_id
         FROM bookings b LEFT JOIN experience_support_cases c ON c.provider_id=b.provider_id AND c.booking_id=b.id
        WHERE b.public_booking_id=$1::uuid`,
      [bookingId],
    );
    const row = found.rows[0];
    if (!row) throw new StoreNotFoundError("guest booking");
    if (!await supportBookingConsent(this.#pool, text(row, "provider_id"), text(row, "booking_row_id"))) return null;
    const events = await this.#pool.query<DbRow>(
      `SELECT event_type, revision, actor_admin_user_id, occurred_at, action, outcome FROM experience_support_case_events
        WHERE provider_id=$1 AND booking_id=$2::bigint ORDER BY revision DESC LIMIT 50`,
      [row.provider_id, row.booking_row_id],
    );
    return {
      publicBookingId: bookingId,
      assignedAdminUserId: nullableText(row, "assigned_admin_user_id"),
      internalMemo: nullableText(row, "internal_memo"),
      revision: row.revision === null || row.revision === undefined ? 0 : integer(row, "revision"),
      updatedBy: nullableText(row, "updated_by"),
      updatedAtUtc: row.updated_at === null || row.updated_at === undefined ? new Date(0).toISOString() : isoValue(row, "updated_at"),
      events: events.rows.map((event) => ({
        type: text(event, "event_type") as ExperienceSupportCase["events"][number]["type"],
        revision: integer(event, "revision"), actorAdminUserId: text(event, "actor_admin_user_id"), occurredAtUtc: isoValue(event, "occurred_at"),
        action: nullableText(event, "action"), outcome: nullableText(event, "outcome"),
      })),
    };
  }

  async updateCase(
    actor: { readonly nihoUserId: string },
    publicBookingId: string,
    input: { readonly commandId: string; readonly expectedRevision: number; readonly assignedAdminUserId: string | null; readonly internalMemo: string | null },
  ): Promise<ExperienceSupportCase> {
    const admin = adminId(actor?.nihoUserId);
    const bookingId = publicBookingIdOf(publicBookingId);
    if (typeof input.commandId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId)) throw new StoreValidationError("commandId must be a UUID v4.");
    if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) throw new StoreValidationError("expectedRevision must be a non-negative integer.");
    const assigned = input.assignedAdminUserId === null ? null : adminId(input.assignedAdminUserId);
    const memo = input.internalMemo === null ? null : typeof input.internalMemo === "string" ? input.internalMemo.trim() : "invalid";
    if (memo !== null && (memo.length < 1 || memo.length > 5000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(memo))) throw new StoreValidationError("internalMemo must contain 1-5000 printable characters or be null.");
    const fingerprint = createHash("sha256").update(JSON.stringify([bookingId, input.expectedRevision, assigned, memo])).digest("hex");
    return withTransaction(this.#pool, async (client) => {
      const booking = await client.query<DbRow>("SELECT provider_id, id::text AS id FROM bookings WHERE public_booking_id=$1::uuid FOR UPDATE", [bookingId]);
      const row = booking.rows[0];
      if (!row) throw new StoreNotFoundError("guest booking");
      const providerId = text(row, "provider_id");
      const bookingRowId = text(row, "id");
      if (!await supportBookingConsent(client, providerId, bookingRowId)) throw new StoreNotFoundError("support-enabled booking");
      await client.query("INSERT INTO experience_support_cases (provider_id,booking_id) VALUES ($1,$2::bigint) ON CONFLICT DO NOTHING", [providerId, bookingRowId]);
      const previous = await client.query<DbRow>("SELECT provider_id,booking_id::text AS booking_id,actor_admin_user_id,request_fingerprint FROM experience_support_case_commands WHERE command_id=$1::uuid FOR UPDATE", [input.commandId]);
      if (previous.rows[0]) {
        const prior = previous.rows[0];
        if (text(prior, "provider_id") !== providerId || text(prior, "booking_id") !== bookingRowId || text(prior, "actor_admin_user_id") !== admin || text(prior, "request_fingerprint") !== fingerprint) throw new StoreConflictError("The support case command was already used with another request.");
        return this.getCaseInside(client, bookingId, providerId, bookingRowId);
      }
      const current = await client.query<DbRow>("SELECT assigned_admin_user_id, internal_memo, revision FROM experience_support_cases WHERE provider_id=$1 AND booking_id=$2::bigint FOR UPDATE", [providerId, bookingRowId]);
      const old = current.rows[0];
      const revision = old ? integer(old, "revision") : 0;
      if (revision !== input.expectedRevision) throw new StoreConflictError("Support case revision changed.");
      const oldAssignee = old ? nullableText(old, "assigned_admin_user_id") : null;
      const oldMemo = old ? nullableText(old, "internal_memo") : null;
      const nextRevision = oldAssignee === assigned && oldMemo === memo ? revision : revision + 1;
      await client.query(
        `INSERT INTO experience_support_case_commands (command_id,provider_id,booking_id,actor_admin_user_id,request_fingerprint,result_revision)
         VALUES ($1::uuid,$2,$3::bigint,$4,$5,$6)`,
        [input.commandId, providerId, bookingRowId, admin, fingerprint, nextRevision],
      );
      if (oldAssignee === assigned && oldMemo === memo) {
        return this.getCaseInside(client, bookingId, providerId, bookingRowId);
      }
      await client.query(
        `INSERT INTO experience_support_cases (provider_id, booking_id, assigned_admin_user_id, internal_memo, revision, updated_by, updated_at)
         VALUES ($1,$2::bigint,$3,$4,$5,$6,clock_timestamp())
         ON CONFLICT (provider_id, booking_id) DO UPDATE SET assigned_admin_user_id=EXCLUDED.assigned_admin_user_id,
           internal_memo=EXCLUDED.internal_memo, revision=EXCLUDED.revision, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [providerId, bookingRowId, assigned, memo, nextRevision, admin],
      );
      if (oldAssignee !== assigned) await client.query(
        `INSERT INTO experience_support_case_events (id,provider_id,booking_id,actor_admin_user_id,event_type,revision,command_id)
         VALUES ($1::uuid,$2,$3::bigint,$4,'ASSIGNEE_CHANGED',$5,$6::uuid)`, [randomUUID(), providerId, bookingRowId, admin, nextRevision, input.commandId],
      );
      if (oldMemo !== memo) await client.query(
        `INSERT INTO experience_support_case_events (id,provider_id,booking_id,actor_admin_user_id,event_type,revision,command_id)
         VALUES ($1::uuid,$2,$3::bigint,$4,'INTERNAL_MEMO_CHANGED',$5,$6::uuid)`, [randomUUID(), providerId, bookingRowId, admin, nextRevision, input.commandId],
      );
      return this.getCaseInside(client, bookingId, providerId, bookingRowId);
    });
  }

  private async getCaseInside(client: PoolClient, publicBookingId: string, providerId: string, bookingRowId: string): Promise<ExperienceSupportCase> {
    const state = await client.query<DbRow>("SELECT assigned_admin_user_id,internal_memo,revision,updated_by,updated_at FROM experience_support_cases WHERE provider_id=$1 AND booking_id=$2::bigint", [providerId, bookingRowId]);
    const row = state.rows[0];
    if (!row) throw new StoreNotFoundError("support case");
    const events = await client.query<DbRow>("SELECT event_type,revision,actor_admin_user_id,occurred_at,action,outcome FROM experience_support_case_events WHERE provider_id=$1 AND booking_id=$2::bigint ORDER BY revision DESC LIMIT 50", [providerId, bookingRowId]);
    return {
      publicBookingId,
      assignedAdminUserId: nullableText(row, "assigned_admin_user_id"),
      internalMemo: nullableText(row, "internal_memo"),
      revision: integer(row, "revision"),
      updatedBy: nullableText(row, "updated_by"),
      updatedAtUtc: isoValue(row, "updated_at"),
      events: events.rows.map((event) => ({
        type: text(event, "event_type") as ExperienceSupportCase["events"][number]["type"],
        revision: integer(event, "revision"), actorAdminUserId: text(event, "actor_admin_user_id"), occurredAtUtc: isoValue(event, "occurred_at"),
        action: nullableText(event, "action"), outcome: nullableText(event, "outcome"),
      })),
    };
  }

  async listNotifications(actor: { readonly nihoUserId: string }, options: { readonly limit?: number; readonly unreadOnly?: boolean } = {}): Promise<ExperienceSupportNotification[]> {
    const admin = adminId(actor?.nihoUserId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StoreValidationError("limit must be 1-100.");
    const found = await this.#pool.query<DbRow>(
      `SELECT n.id::text AS id, b.public_booking_id::text AS public_booking_id, n.provider_id, n.topic, n.created_at,
              (r.notification_id IS NOT NULL) AS is_read
         FROM experience_support_admin_notifications n
         JOIN bookings b ON b.provider_id=n.provider_id AND b.id=n.booking_id
         LEFT JOIN experience_support_admin_notification_reads r ON r.notification_id=n.id AND r.admin_user_id=$1
        WHERE ($2::boolean = false OR r.notification_id IS NULL)
        ORDER BY n.created_at DESC, n.id DESC LIMIT $3`, [admin, options.unreadOnly === true, limit],
    );
    return found.rows.map((row) => ({ id: text(row, "id"), publicBookingId: text(row, "public_booking_id"), providerId: text(row, "provider_id"), topic: text(row, "topic") as ExperienceSupportNotification["topic"], createdAtUtc: isoValue(row, "created_at"), read: row.is_read === true }));
  }

  async markNotificationRead(actor: { readonly nihoUserId: string }, notificationId: string): Promise<void> {
    const admin = adminId(actor?.nihoUserId);
    if (typeof notificationId !== "string" || !/^[0-9a-f-]{36}$/i.test(notificationId)) throw new StoreValidationError("notificationId is invalid.");
    const result = await this.#pool.query(
      `INSERT INTO experience_support_admin_notification_reads (notification_id,admin_user_id)
       SELECT id,$2 FROM experience_support_admin_notifications WHERE id=$1::uuid
       ON CONFLICT (notification_id,admin_user_id) DO NOTHING`, [notificationId, admin],
    );
    if (result.rowCount === 0) {
      const found = await this.#pool.query("SELECT 1 FROM experience_support_admin_notifications WHERE id=$1::uuid", [notificationId]);
      if (!found.rows[0]) throw new StoreNotFoundError("notification");
    }
  }

  /** Called from the paid webhook and idempotently on retry before any external reconciliation. */
  async ensureSettlement(publicBookingId: string): Promise<ExperienceSettlementSummary> {
    const id = publicBookingIdOf(publicBookingId);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT b.provider_id,b.id::text AS booking_id,b.pricing_snapshot,b.seller_snapshot,b.stripe_payment_ref,
                l.amount AS gross_amount,l.currency
           FROM bookings b JOIN payment_ledger_entries l ON l.provider_id=b.provider_id AND l.booking_id=b.id
             AND l.kind='PAYMENT_CAPTURED' AND l.stripe_payment_ref=b.stripe_payment_ref
          WHERE b.public_booking_id=$1::uuid ORDER BY l.created_at DESC LIMIT 1 FOR UPDATE OF b`, [id],
      );
      const row = found.rows[0];
      if (!row) throw new StoreNotFoundError("captured Experience booking");
      const pricing = record(row.pricing_snapshot);
      const platformFee = record(pricing.platformFee);
      const seller = record(row.seller_snapshot);
      const providerId = text(row, "provider_id");
      const bookingRowId = text(row, "booking_id");
      const account = seller.stripeConnectAccountRef;
      const pi = row.stripe_payment_ref;
      const gross = integer(row, "gross_amount");
      const currency = text(row, "currency").toUpperCase();
      const bps = platformFee.basisPoints;
      const enabled = platformFee.supportEnabled;
      if (typeof account !== "string" || !/^acct_[A-Za-z0-9]{8,}$/.test(account) || typeof pi !== "string" || !/^pi_[A-Za-z0-9_]{8,}$/.test(pi) || !Number.isSafeInteger(gross) || gross <= 0 || !/^[A-Z]{3}$/.test(currency)
        || (bps !== 1000 && bps !== 1500) || typeof enabled !== "boolean" || (enabled ? bps !== 1500 : bps !== 1000)) {
        throw new StoreValidationError("Captured booking snapshots cannot be reconciled safely.");
      }
      if (platformFee.amount !== Math.floor(gross * Number(bps) / 10_000)) throw new StoreValidationError("Captured booking fee amount does not match its immutable snapshot.");
      const consentVersion = typeof platformFee.supportConsentVersion === "string" ? platformFee.supportConsentVersion : null;
      const agreementRevision = Number.isSafeInteger(platformFee.supportAgreementRevision) && Number(platformFee.supportAgreementRevision) > 0 ? Number(platformFee.supportAgreementRevision) : null;
      if ((consentVersion === null) !== (agreementRevision === null)) throw new StoreValidationError("Support consent snapshot is incomplete.");
      const snapshotHash = createHash("sha256").update(JSON.stringify({ providerId, bookingRowId, id, account, pi, gross, currency, bps, enabled, consentVersion, agreementRevision })).digest("hex");
      await client.query(
        `INSERT INTO experience_booking_settlements
           (provider_id,booking_id,snapshot_hash,stripe_account_ref,stripe_payment_ref,currency,gross_amount,fee_rate_basis_points,
            support_enabled,consent_version,agreement_revision)
         VALUES ($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (provider_id,booking_id) DO NOTHING`,
        [providerId, bookingRowId, snapshotHash, account, pi, currency, gross, bps, enabled, consentVersion, agreementRevision],
      );
      const current = await client.query<DbRow>(`SELECT ${SUMMARY_COLUMNS} FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id WHERE s.provider_id=$1 AND s.booking_id=$2::bigint`, [providerId, bookingRowId]);
      const settlement = current.rows[0];
      if (!settlement || text(settlement, "public_booking_id") !== id || text(settlement, "snapshot_hash") === "") throw new StoreConflictError("Settlement snapshot changed.");
      if (text(settlement, "snapshot_hash") !== snapshotHash) throw new StoreConflictError("Settlement already exists for another immutable booking snapshot.");
      return summaryFromRow(settlement);
    });
  }

  /** Existing captured rows are initialized only from their immutable booking snapshot, never current provider settings. */
  async initializeMissingSettlements(limit = 50): Promise<SettlementInitializationResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    const missing = await this.#pool.query<DbRow>(
      `SELECT b.public_booking_id::text AS public_booking_id
         FROM bookings b JOIN payment_ledger_entries l ON l.provider_id=b.provider_id AND l.booking_id=b.id
           AND l.kind='PAYMENT_CAPTURED' AND l.stripe_payment_ref=b.stripe_payment_ref
         LEFT JOIN experience_booking_settlements s ON s.provider_id=b.provider_id AND s.booking_id=b.id
        WHERE s.booking_id IS NULL AND b.pricing_snapshot->'platformFee'->>'basisPoints' IN ('1000','1500')
        ORDER BY l.created_at,b.id LIMIT $1`, [limit],
    );
    let initialized = 0;
    let failed = 0;
    for (const row of missing.rows) {
      try { await this.ensureSettlement(text(row, "public_booking_id")); initialized += 1; }
      catch { failed += 1; }
    }
    return { initialized, failed };
  }

  async claimDueSettlements(limit = 20): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StoreValidationError("limit must be 1-100.");
    const claimed = await this.#pool.query<DbRow>(
      `WITH due AS (
         SELECT provider_id,booking_id FROM experience_booking_settlements
          WHERE status IN ('PREPARING','PROCESSING_COST_PENDING','PROCESSING','RESULT_UNKNOWN','SETTLED') AND next_reconcile_at<=clock_timestamp()
          ORDER BY next_reconcile_at,updated_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE experience_booking_settlements s SET next_reconcile_at=clock_timestamp()+interval '5 minutes', updated_at=clock_timestamp()
         FROM due WHERE s.provider_id=due.provider_id AND s.booking_id=due.booking_id
       RETURNING s.provider_id,s.booking_id`, [limit],
    );
    if (!claimed.rows.length) return [];
    const refs = await this.#pool.query<DbRow>(
      `SELECT b.public_booking_id::text AS public_booking_id FROM bookings b JOIN unnest($1::text[],$2::text[]) AS x(provider_id,booking_id)
        ON x.provider_id=b.provider_id AND x.booking_id=b.id::text`,
      [claimed.rows.map((r) => text(r, "provider_id")), claimed.rows.map((r) => text(r, "booking_id"))],
    );
    return refs.rows.map((row) => text(row, "public_booking_id"));
  }

  async getSettlementSource(publicBookingId: string): Promise<SettlementSource> {
    const id = publicBookingIdOf(publicBookingId);
    const result = await this.#pool.query<DbRow>(
      `SELECT s.stripe_account_ref,s.stripe_payment_ref,s.currency,s.gross_amount,b.public_booking_id::text AS public_booking_id
         FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id
        WHERE b.public_booking_id=$1::uuid`, [id],
    );
    const row = result.rows[0];
    if (!row) throw new StoreNotFoundError("settlement");
    return { publicBookingId: id, connectedAccountId: text(row, "stripe_account_ref"), paymentIntentId: text(row, "stripe_payment_ref"), currency: text(row, "currency"), grossAmount: integer(row, "gross_amount") };
  }

  async recordStripeEvidence(publicBookingId: string, evidence: StripeSettlementEvidence): Promise<ExperienceSettlementSummary> {
    const id = publicBookingIdOf(publicBookingId);
    if (!/^acct_[A-Za-z0-9]{8,}$/.test(evidence.connectedAccountId) || !/^[A-Z]{3}$/.test(evidence.currency)
      || !Number.isSafeInteger(evidence.grossAmount) || evidence.grossAmount <= 0
      || (evidence.feePayer !== null && evidence.feePayer !== "ACCOUNT" && evidence.feePayer !== "APPLICATION")
      || !Array.isArray(evidence.refunds) || evidence.refunds.length > 10_000
      || typeof evidence.refundHistoryTruncated !== "boolean") throw new StoreValidationError("Stripe settlement evidence is malformed.");
    if (evidence.chargeRef !== null && !/^ch_[A-Za-z0-9_]{8,}$/.test(evidence.chargeRef)) throw new StoreValidationError("chargeRef is malformed.");
    if (evidence.balanceTransactionRef !== null && !/^txn_[A-Za-z0-9_]{8,}$/.test(evidence.balanceTransactionRef)) throw new StoreValidationError("balanceTransactionRef is malformed.");
    if (evidence.applicationFeeRef !== null && !/^fee_[A-Za-z0-9_]{8,}$/.test(evidence.applicationFeeRef)) throw new StoreValidationError("applicationFeeRef is malformed.");
    for (const [key, value] of Object.entries({ processingFeeAmount: evidence.processingFeeAmount, applicationFeeAmount: evidence.applicationFeeAmount, applicationFeeRefunded: evidence.applicationFeeRefunded })) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new StoreValidationError(`${key} is invalid.`);
    }
    if (evidence.processingFeeCurrency !== null && !/^[A-Z]{3}$/.test(evidence.processingFeeCurrency)) throw new StoreValidationError("processingFeeCurrency is invalid.");
    const refundRefs = new Set<string>();
    const refundIds = new Set<string>();
    for (const refund of evidence.refunds) {
      if (!/^re_[A-Za-z0-9_]{8,}$/.test(refund.stripeRefundRef) || refundRefs.has(refund.stripeRefundRef)
        || (refund.internalRefundId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(refund.internalRefundId))
        || (refund.internalRefundId !== null && refundIds.has(refund.internalRefundId.toLowerCase()))
        || !Number.isSafeInteger(refund.amount) || refund.amount < 0 || !/^[A-Z]{3}$/.test(refund.currency)
        || !["succeeded", "pending", "requires_action", "failed", "canceled", "unknown"].includes(refund.status)) {
        throw new StoreValidationError("Stripe refund evidence is malformed.");
      }
      refundRefs.add(refund.stripeRefundRef);
      if (refund.internalRefundId !== null) refundIds.add(refund.internalRefundId.toLowerCase());
    }
    for (const [key, value] of Object.entries({ successfulRefundAmount: evidence.successfulRefundAmount, pendingRefundAmount: evidence.pendingRefundAmount })) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new StoreValidationError(`${key} is invalid.`);
    }
    return withTransaction(this.#pool, async (client) => {
      const current = await client.query<DbRow>(
        `SELECT s.*,b.public_booking_id::text AS public_booking_id FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id
          WHERE b.public_booking_id=$1::uuid FOR UPDATE OF s`, [id],
      );
      const row = current.rows[0];
      if (!row) throw new StoreNotFoundError("settlement");
      let issue = evidence.issueCode ?? null;
      if (!issue && evidence.connectedAccountId !== text(row, "stripe_account_ref")) issue = "connected_account_mismatch";
      else if (!issue && evidence.currency !== text(row, "currency")) issue = "currency_mismatch";
      else if (!issue && evidence.grossAmount !== integer(row, "gross_amount")) issue = "gross_amount_mismatch";
      else if (!issue && evidence.feePayer === null) issue = "fee_payer_unknown";
      else if (!issue && evidence.applicationFeeAmount === null) issue = "application_fee_missing";
      else if (!issue && evidence.applicationFeeAmount !== Math.floor(integer(row, "gross_amount") * integer(row, "fee_rate_basis_points") / 10_000)) issue = "application_fee_mismatch";
      else if (!issue && (evidence.applicationFeeRefunded === null || evidence.applicationFeeRefunded > evidence.applicationFeeAmount!)) issue = "application_fee_refund_mismatch";
      else if (!issue && evidence.refundHistoryTruncated) issue = "refund_history_truncated";
      else if (!issue && evidence.processingFeeAmount !== null && evidence.processingFeeCurrency !== text(row, "currency")) issue = "processing_fee_currency_mismatch";

      const refundRows = await client.query<DbRow>(
        `SELECT id::text AS id,amount,status,closed_at FROM booking_refunds WHERE provider_id=$1 AND booking_id=$2::bigint`,
        [row.provider_id, row.booking_id],
      );
      const localRefunds = new Map(refundRows.rows.map((refund) => [text(refund, "id").toLowerCase(), {
        amount: integer(refund, "amount"),
        status: text(refund, "status"),
        closed: refund.closed_at !== null,
      }]));
      let successfulRefundAmount = 0;
      let pendingRefundAmount = 0;
      let stripeSuccessfulRefundAmount = 0;
      let stripePendingRefundAmount = 0;
      let failedRefundCount = 0;
      const matchedRefunds = new Set<string>();
      for (const refund of evidence.refunds) {
        const local = refund.internalRefundId === null ? undefined : localRefunds.get(refund.internalRefundId.toLowerCase());
        if (refund.internalRefundId !== null && !local) issue ??= "refund_reference_unmatched";
        if (local && refund.internalRefundId) matchedRefunds.add(refund.internalRefundId.toLowerCase());
        if (refund.currency !== text(row, "currency")) issue ??= "refund_currency_mismatch";
        if (refund.status === "succeeded") {
          stripeSuccessfulRefundAmount += refund.amount;
          successfulRefundAmount += refund.amount;
          if (local?.status === "FAILED" && !local.closed) issue ??= "refund_status_out_of_sync";
        } else if (refund.status === "pending" || refund.status === "requires_action") {
          stripePendingRefundAmount += refund.amount;
          pendingRefundAmount += refund.amount;
          if (local?.status === "FAILED" && !local.closed) issue ??= "refund_status_out_of_sync";
        } else if (refund.status === "failed" || refund.status === "canceled") {
          if (!local || !local.closed) failedRefundCount += 1;
          if (local && local.status !== "FAILED" && !local.closed) issue ??= "refund_status_out_of_sync";
        } else {
          issue ??= "refund_status_unknown";
        }
      }
      if (evidence.successfulRefundAmount === null || evidence.pendingRefundAmount === null) issue ??= "refund_totals_unknown";
      else if (evidence.successfulRefundAmount !== stripeSuccessfulRefundAmount || evidence.pendingRefundAmount !== stripePendingRefundAmount) issue ??= "refund_total_mismatch";
      for (const [refundId, local] of localRefunds) {
        if (local.status === "FAILED" && !local.closed && !matchedRefunds.has(refundId)) failedRefundCount += 1;
        else if ((local.status === "REQUESTED" || local.status === "PENDING") && !matchedRefunds.has(refundId)) {
          pendingRefundAmount += local.amount;
          if (local.status === "PENDING") issue ??= "stripe_refund_missing";
        } else if (local.status === "SUCCEEDED" && !matchedRefunds.has(refundId)) {
          issue ??= "stripe_refund_missing";
        }
      }
      if (successfulRefundAmount + pendingRefundAmount > integer(row, "gross_amount")) issue ??= "refund_total_exceeds_payment";
      if (issue !== null && !ISSUE.test(issue)) throw new StoreValidationError("issueCode is invalid.");
      const previousCompStatus = text(row, "compensation_status") as SettlementCompensationStatus;
      const previousProcessingFee = nullableInteger(row, "processing_fee_amount");
      const previousProcessingCurrency = nullableText(row, "processing_fee_currency");
      const compAmount = evidence.feePayer === "ACCOUNT" && evidence.processingFeeAmount !== null
        && evidence.processingFeeCurrency === text(row, "currency") ? evidence.processingFeeAmount
        : evidence.feePayer === "APPLICATION" && evidence.processingFeeAmount !== null ? 0 : null;
      if (previousCompStatus === "TRANSFERRED" && (previousProcessingFee !== evidence.processingFeeAmount || previousProcessingCurrency !== evidence.processingFeeCurrency)) {
        issue ??= "processing_fee_changed_after_transfer";
      }
      const compStatus = compAmount === 0 ? "NOT_REQUIRED" : previousCompStatus;
      let status: SettlementStatus;
      if (issue) status = "REVIEW_REQUIRED";
      else if (evidence.processingFeeAmount === null || evidence.processingFeeCurrency === null || evidence.applicationFeeAmount === null || evidence.applicationFeeRefunded === null) status = "PROCESSING_COST_PENDING";
      else if (compAmount === null) status = "PROCESSING_COST_PENDING";
      else if (compAmount > 0 && compStatus !== "TRANSFERRED") status = compStatus === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : "PROCESSING";
      else if (pendingRefundAmount > 0 || failedRefundCount > 0) status = "PROCESSING";
      else status = "SETTLED";
      await client.query(
        `UPDATE experience_booking_settlements SET stripe_charge_ref=$3,stripe_balance_transaction_ref=$4,stripe_application_fee_ref=$5,
           stripe_fee_payer=$6,processing_fee_amount=$7,processing_fee_currency=$8,application_fee_amount=$9,application_fee_refunded=$10,
           successful_refund_amount=$11,pending_refund_amount=$12,failed_refund_count=$13,compensation_amount=$14,
           compensation_status=$15,status=$16,issue_code=$17,last_reconciled_at=clock_timestamp(),
           next_reconcile_at=clock_timestamp()+CASE WHEN $16='SETTLED' THEN interval '30 days' ELSE interval '5 minutes' END,
           revision=revision+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND booking_id=$2::bigint`,
        [row.provider_id, row.booking_id, evidence.chargeRef, evidence.balanceTransactionRef, evidence.applicationFeeRef, evidence.feePayer,
          evidence.processingFeeAmount, evidence.processingFeeCurrency, evidence.applicationFeeAmount, evidence.applicationFeeRefunded,
          successfulRefundAmount, pendingRefundAmount, failedRefundCount, compAmount, compStatus, status, issue],
      );
      return summaryFromRow((await client.query<DbRow>(`SELECT ${SUMMARY_COLUMNS} FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id WHERE b.public_booking_id=$1::uuid`, [id])).rows[0]!);
    });
  }

  async prepareCompensation(publicBookingId: string): Promise<SettlementTransferCommand | null> {
    const id = publicBookingIdOf(publicBookingId);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT s.*,b.public_booking_id::text AS public_booking_id FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id
          WHERE b.public_booking_id=$1::uuid FOR UPDATE OF s`, [id],
      );
      const row = found.rows[0];
      if (!row) throw new StoreNotFoundError("settlement");
      if (text(row, "status") === "REVIEW_REQUIRED" || row.stripe_fee_payer !== "ACCOUNT"
        || nullableText(row, "processing_fee_currency") !== text(row, "currency")) return null;
      const amount = nullableInteger(row, "processing_fee_amount");
      if (amount === null) return null;
      if (amount === 0) return null;
      const currency = text(row, "currency");
      const destination = text(row, "stripe_account_ref");
      const group = `niho-experience-settlement:${id}`;
      const fp = createHash("sha256").update(JSON.stringify([id, amount, currency, destination, group])).digest("hex");
      const existing = await client.query<DbRow>(
        `SELECT c.command_id::text AS command_id,b.public_booking_id::text AS public_booking_id,c.amount,c.currency,c.destination_account_ref,c.transfer_group,
                c.status,c.stripe_transfer_ref,c.attempts,c.created_at,c.request_fingerprint,c.last_attempt_at
           FROM experience_settlement_commands c JOIN bookings b ON b.provider_id=c.provider_id AND b.id=c.booking_id
          WHERE c.provider_id=$1 AND c.booking_id=$2::bigint AND c.action='PROCESSING_COST_COMPENSATION'
          ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1 FOR UPDATE OF c`,
        [row.provider_id, row.booking_id],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (integer(previous, "amount") !== amount || text(previous, "request_fingerprint") !== fp) throw new StoreConflictError("A compensation command exists with different terms.");
        if (text(previous, "status") !== "RETRYABLE_FAILED") return transferFromRow(previous);
        const total = await client.query<DbRow>(
          `SELECT count(*)::int AS count FROM experience_settlement_commands WHERE provider_id=$1 AND booking_id=$2::bigint AND action='PROCESSING_COST_COMPENSATION'`,
          [row.provider_id, row.booking_id],
        );
        if (integer(total.rows[0]!, "count") >= 3) {
          await client.query(
            `UPDATE experience_booking_settlements SET compensation_status='REVIEW_REQUIRED',status='REVIEW_REQUIRED',
               issue_code='settlement_transfer_retries_exhausted',next_reconcile_at=clock_timestamp()+interval '30 days',
               revision=revision+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND booking_id=$2::bigint`,
            [row.provider_id, row.booking_id],
          );
          return null;
        }
      }
      const inserted = await client.query<DbRow>(
        `INSERT INTO experience_settlement_commands (command_id,provider_id,booking_id,action,request_fingerprint,amount,currency,destination_account_ref,transfer_group,status)
         VALUES ($1::uuid,$2,$3::bigint,'PROCESSING_COST_COMPENSATION',$4,$5,$6,$7,$8,'PREPARED')
         RETURNING command_id::text AS command_id`,
        [randomUUID(), row.provider_id, row.booking_id, fp, amount, currency, destination, group],
      );
      const commandResult = await client.query<DbRow>(
        `SELECT c.command_id::text AS command_id,b.public_booking_id::text AS public_booking_id,c.amount,c.currency,c.destination_account_ref,c.transfer_group,c.status,c.stripe_transfer_ref,c.attempts,c.created_at,c.request_fingerprint
           FROM experience_settlement_commands c JOIN bookings b ON b.provider_id=c.provider_id AND b.id=c.booking_id
          WHERE c.command_id=$1::uuid FOR UPDATE OF c`, [inserted.rows[0]?.command_id,],
      );
      const command = commandResult.rows[0];
      return command ? transferFromRow(command) : null;
    });
  }

  async markCompensation(
    commandId: string,
    update: { readonly status: SettlementTransferCommand["status"]; readonly stripeTransferRef?: string | null; readonly issueCode?: string | null },
  ): Promise<void> {
    if (typeof commandId !== "string" || !/^[0-9a-f-]{36}$/i.test(commandId)) throw new StoreValidationError("commandId is invalid.");
    if (update.issueCode !== undefined && update.issueCode !== null && !ISSUE.test(update.issueCode)) throw new StoreValidationError("issueCode is invalid.");
    await withTransaction(this.#pool, async (client) => {
      const changed = await client.query<DbRow>(
        `UPDATE experience_settlement_commands SET status=$2,stripe_transfer_ref=COALESCE($3,stripe_transfer_ref),issue_code=$4,
           attempts=attempts+CASE WHEN $2='SUBMITTING' THEN 1 ELSE 0 END,
           last_attempt_at=CASE WHEN $2='SUBMITTING' THEN clock_timestamp() ELSE last_attempt_at END,updated_at=clock_timestamp()
          WHERE command_id=$1::uuid RETURNING provider_id,booking_id,status`, [commandId, update.status, update.stripeTransferRef ?? null, update.issueCode ?? null],
      );
      const command = changed.rows[0];
      if (!command) throw new StoreNotFoundError("settlement command");
      const status: SettlementStatus = update.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : update.status === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : update.status === "TRANSFERRED" ? "PROCESSING" : "PROCESSING";
      await client.query(
        `UPDATE experience_booking_settlements SET compensation_status=$3,stripe_transfer_ref=COALESCE($4,stripe_transfer_ref),status=$5,issue_code=$6,
           next_reconcile_at=clock_timestamp()+CASE WHEN $5 IN ('SETTLED','REVIEW_REQUIRED') THEN interval '30 days' ELSE interval '5 minutes' END,
           revision=revision+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND booking_id=$2::bigint`,
        [command.provider_id, command.booking_id, update.status, update.stripeTransferRef ?? null, status, update.issueCode ?? null],
      );
    });
  }

  async listHostSummaries(actor: HostActor, limit = 100): Promise<ExperienceSettlementSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id
          WHERE s.provider_id=$1 ORDER BY b.created_at DESC LIMIT $2`, [actor.providerId, limit],
      );
      return result.rows.map(summaryFromRow);
    });
  }

  async listAdminSummaries(limit = 100): Promise<ExperienceSettlementSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    const result = await this.#pool.query<DbRow>(`SELECT ${SUMMARY_COLUMNS} FROM experience_booking_settlements s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id ORDER BY b.created_at DESC LIMIT $1`, [limit]);
    return result.rows.map(summaryFromRow);
  }
}
