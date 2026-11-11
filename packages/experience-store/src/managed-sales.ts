import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { requireMembership } from "./repository.ts";
import { lockProviderInventory } from "./inventory.ts";
import { addLocalDays } from "@niho-experience/experience-domain";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { ExperienceChargeMode, ExperienceSalesPlan, HostActor, PublicationAdminDraftActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT = /^acct_[A-Za-z0-9]{8,}$/;
const HTTPS = /^https:\/\/[^\s]{1,2040}$/;
const VERSION = /^[\x21-\x7e]{1,160}$/;

export interface ManagedPlatformSellerConfig {
  readonly legalSellerName: string;
  readonly commercialTransactionsUrl: string;
  readonly sellerNihoAccountRef: string;
  readonly platformAccountId: string;
}

export interface SalesPlanRevision {
  readonly providerId: string;
  readonly productId: string;
  readonly revision: number;
  readonly plan: ExperienceSalesPlan;
  readonly chargeMode: ExperienceChargeMode;
  readonly providerPublicProfileVersion: number;
  readonly sellerDisplayName: string;
  readonly sellerDisclosureUrl: string;
  readonly sellerNihoAccountRef: string;
  readonly stripeAccountRef: string;
  readonly feeBasisPoints: 1000 | 1500 | 2000;
  readonly agreementVersion: string;
  readonly agreementConfirmedBy: string;
  readonly agreementConfirmedAtUtc: string;
  readonly agreementConfirmationMethod: "VERBAL" | "WRITTEN" | "OWNER_WEB";
  readonly paymentDueDays: number | null;
  readonly pilotApproved: boolean;
  readonly activatedAtUtc: string;
}

export interface SalesPlanState {
  readonly current: SalesPlanRevision;
  readonly phase: "ACTIVE" | "EXPIRING_OLD_CHECKOUTS" | "RECONCILING";
  readonly pending: SalesPlanRevision | null;
  readonly transitionCommandId: string | null;
  readonly version: number;
}

export interface SalesPlanTransition {
  readonly state: SalesPlanState;
  readonly openCheckouts: readonly { readonly publicBookingId: string; readonly checkoutSessionRef: string }[];
}

export type CheckoutTransitionOutcome = "EXPIRED" | "PAID" | "UNKNOWN";

export interface ManagedCompensation {
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
  readonly disputedAmount: number;
  readonly nihoFeeAmount: number;
  readonly providerAmount: number;
  readonly dueOn: string;
  readonly recipientVerified: boolean;
  readonly status: "REVIEW_REQUIRED" | "READY" | "PREPARED" | "RESULT_UNKNOWN" | "PAID" | "ADJUSTMENT_REQUIRED";
  readonly preparationId: string | null;
  readonly statementReference: string | null;
  readonly preparedAmount: number | null;
  readonly paidAmount: number | null;
  readonly adjustmentAmount: number | null;
  readonly version: number;
}

export interface HostManagedCompensation {
  readonly publicBookingId: string;
  readonly currency: string;
  readonly providerAmount: number;
  readonly dueOn: string;
  readonly status: ManagedCompensation["status"];
  readonly paidAtUtc: string | null;
}

function integer(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new StoreValidationError(`Database returned an invalid ${name}.`);
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new StoreValidationError(`Database returned an invalid ${name}.`);
  return value;
}

function validateAdmin(actor: PublicationAdminDraftActor): void {
  assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
}

export function validateManagedPlatformSellerConfig(value: ManagedPlatformSellerConfig): ManagedPlatformSellerConfig {
  const name = value?.legalSellerName?.trim();
  if (!name || name.length > 300 || /[\u0000-\u001f\u007f]/.test(name)) throw new StoreValidationError("The configured legal seller name is invalid.");
  if (!HTTPS.test(value.commercialTransactionsUrl)) throw new StoreValidationError("The configured commercial-transactions URL must be HTTPS.");
  assertStoreIdentifier(value.sellerNihoAccountRef, "sellerNihoAccountRef");
  if (!ACCOUNT.test(value.platformAccountId)) throw new StoreValidationError("The configured platform account ID is invalid.");
  return { legalSellerName: name, commercialTransactionsUrl: value.commercialTransactionsUrl,
    sellerNihoAccountRef: value.sellerNihoAccountRef, platformAccountId: value.platformAccountId };
}

function revisionFromRow(row: DbRow, prefix = ""): SalesPlanRevision {
  const key = (name: string) => `${prefix}${name}`;
  const plan = text(row[key("plan")], key("plan")) as ExperienceSalesPlan;
  const chargeMode = text(row[key("charge_mode")], key("charge_mode")) as ExperienceChargeMode;
  const feeBasisPoints = integer(row[key("fee_basis_points")], key("fee_basis_points"));
  if (![1000, 1500, 2000].includes(feeBasisPoints)) throw new StoreValidationError("Database returned an invalid fee rate.");
  return {
    providerId: text(row[key("provider_id")], key("provider_id")), productId: text(row[key("product_id")], key("product_id")),
    revision: integer(row[key("revision")], key("revision")), plan, chargeMode,
    providerPublicProfileVersion: integer(row[key("provider_public_profile_version")], key("provider_public_profile_version")),
    sellerDisplayName: text(row[key("seller_display_name")], key("seller_display_name")),
    sellerDisclosureUrl: text(row[key("seller_disclosure_url")], key("seller_disclosure_url")),
    sellerNihoAccountRef: text(row[key("seller_niho_account_ref")], key("seller_niho_account_ref")),
    stripeAccountRef: text(row[key("stripe_account_ref")], key("stripe_account_ref")),
    feeBasisPoints: feeBasisPoints as 1000 | 1500 | 2000,
    agreementVersion: text(row[key("agreement_version")], key("agreement_version")),
    agreementConfirmedBy: text(row[key("agreement_confirmed_by")], key("agreement_confirmed_by")),
    agreementConfirmedAtUtc: isoValue(row, key("agreement_confirmed_at")),
    agreementConfirmationMethod: text(row[key("agreement_confirmation_method")], key("agreement_confirmation_method")) as SalesPlanRevision["agreementConfirmationMethod"],
    paymentDueDays: row[key("payment_due_days")] === null ? null : integer(row[key("payment_due_days")], key("payment_due_days")),
    pilotApproved: row[key("pilot_approved")] === true,
    activatedAtUtc: isoValue(row, key("activated_at")),
  };
}

const REVISION_COLUMNS = `provider_id,product_id,revision,plan,charge_mode,provider_public_profile_version,
  seller_display_name,seller_disclosure_url,seller_niho_account_ref,stripe_account_ref,fee_basis_points,agreement_version,
  agreement_confirmed_by,agreement_confirmed_at,agreement_confirmation_method,payment_due_days,pilot_approved,activated_at`;

async function readState(client: Pick<PoolClient, "query">, providerId: string, productId: string, lock = false): Promise<SalesPlanState | null> {
  const state = await client.query<DbRow>(
    `SELECT phase,current_revision,pending_revision,transition_command_id::text AS transition_command_id,version
       FROM experience_product_sales_plan_states WHERE provider_id=$1 AND product_id=$2${lock ? " FOR UPDATE" : ""}`,
    [providerId, productId],
  );
  if (!state.rows[0]) return null;
  const revisions = await client.query<DbRow>(
    `SELECT ${REVISION_COLUMNS} FROM experience_product_sales_plan_versions
      WHERE provider_id=$1 AND product_id=$2 AND revision=ANY($3::bigint[]) ORDER BY revision`,
    [providerId, productId, [state.rows[0].current_revision, state.rows[0].pending_revision].filter((value) => value !== null)],
  );
  const current = revisions.rows.find((row) => integer(row.revision, "revision") === integer(state.rows[0]!.current_revision, "current_revision"));
  const pending = state.rows[0].pending_revision === null ? null
    : revisions.rows.find((row) => integer(row.revision, "revision") === integer(state.rows[0]!.pending_revision, "pending_revision"));
  if (!current || (state.rows[0].pending_revision !== null && !pending)) throw new StoreConflictError("The sales plan state is incomplete.");
  return {
    current: revisionFromRow(current), phase: text(state.rows[0].phase, "phase") as SalesPlanState["phase"],
    pending: pending ? revisionFromRow(pending) : null,
    transitionCommandId: state.rows[0].transition_command_id === null ? null : text(state.rows[0].transition_command_id, "transition_command_id"),
    version: integer(state.rows[0].version, "version"),
  };
}

function validateAgreement(version: string, confirmedAtUtc: string): void {
  if (!VERSION.test(version)) throw new StoreValidationError("agreementVersion is invalid.");
  assertCanonicalInstant(confirmedAtUtc, "agreementConfirmedAtUtc");
  if (Date.parse(confirmedAtUtc) > Date.now() + 1000) throw new StoreValidationError("The agreement confirmation cannot be in the future.");
}

export class ManagedExperienceSalesRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async get(providerId: string, productId: string): Promise<SalesPlanState | null> {
    assertStoreIdentifier(providerId, "providerId"); assertStoreIdentifier(productId, "productId");
    return readState(this.#pool, providerId, productId);
  }

  async recordDispute(input: {
    readonly stripeEventId: string; readonly eventOccurredAtUtc: string; readonly platformAccountId: string;
    readonly stripeDisputeRef: string; readonly paymentIntentRef: string; readonly amount: number; readonly currency: string;
    readonly status: "NEEDS_RESPONSE" | "UNDER_REVIEW" | "WON" | "LOST" | "WARNING_CLOSED";
  }): Promise<{ readonly publicBookingId: string; readonly duplicate: boolean }> {
    if (!/^evt_[A-Za-z0-9]{8,}$/.test(input.stripeEventId) || !/^dp_[A-Za-z0-9_]{1,250}$/.test(input.stripeDisputeRef)
      || !/^pi_[A-Za-z0-9]{8,}$/.test(input.paymentIntentRef) || !ACCOUNT.test(input.platformAccountId)
      || !Number.isSafeInteger(input.amount) || input.amount <= 0 || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new StoreValidationError("The dispute event is invalid.");
    }
    assertCanonicalInstant(input.eventOccurredAtUtc, "eventOccurredAtUtc");
    return withTransaction(this.#pool, async (client) => {
      const booking = await client.query<DbRow>(
        `SELECT id,provider_id,public_booking_id::text AS public_booking_id,pricing_snapshot,seller_snapshot
           FROM bookings WHERE stripe_payment_ref=$1 FOR UPDATE`, [input.paymentIntentRef],
      );
      const row = booking.rows[0]; if (!row) throw new StoreNotFoundError("platform booking");
      const seller = row.seller_snapshot as Record<string, unknown>;
      const pricing = row.pricing_snapshot as Record<string, unknown>;
      if (seller.chargeMode !== "PLATFORM" || seller.stripeConnectAccountRef !== input.platformAccountId
        || pricing.currency !== input.currency || input.amount > integer(pricing.totalAmount, "totalAmount")) {
        throw new StoreConflictError("The dispute does not match the booking snapshot.");
      }
      const event = await client.query<DbRow>(
        `INSERT INTO managed_booking_dispute_events
           (stripe_event_id,provider_id,booking_id,stripe_dispute_ref,amount,currency,status,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING stripe_event_id`,
        [input.stripeEventId, row.provider_id, row.id, input.stripeDisputeRef, input.amount, input.currency,
          input.status, input.eventOccurredAtUtc],
      );
      if (!event.rows[0]) return { publicBookingId: text(row.public_booking_id, "public_booking_id"), duplicate: true };
      await client.query(
        `INSERT INTO managed_booking_disputes
           (provider_id,booking_id,stripe_dispute_ref,amount,currency,status,stripe_event_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (provider_id,booking_id,stripe_dispute_ref) DO UPDATE SET
           amount=EXCLUDED.amount,currency=EXCLUDED.currency,status=EXCLUDED.status,
           stripe_event_id=EXCLUDED.stripe_event_id,occurred_at=EXCLUDED.occurred_at,updated_at=clock_timestamp()
         WHERE EXCLUDED.occurred_at >= managed_booking_disputes.occurred_at`,
        [row.provider_id, row.id, input.stripeDisputeRef, input.amount, input.currency, input.status,
          input.stripeEventId, input.eventOccurredAtUtc],
      );
      return { publicBookingId: text(row.public_booking_id, "public_booking_id"), duplicate: false };
    });
  }

  /** OWNER acceptance creates a pending Direct revision and durably closes new checkout creation. */
  async beginOwnerSwitch(
    actor: HostActor,
    productId: string,
    input: { readonly commandId: string; readonly expectedVersion: number; readonly plan: "SUPPORTED_15" | "INDEPENDENT_10"; readonly agreementVersion: string; readonly agreementConfirmedAtUtc: string; readonly sellerDisclosureUrl: string; readonly stripeReady: true },
  ): Promise<SalesPlanTransition> {
    assertStoreIdentifier(productId, "productId");
    if (!UUID_V4.test(input.commandId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.stripeReady !== true) throw new StoreValidationError("The switch command is invalid.");
    validateAgreement(input.agreementVersion, input.agreementConfirmedAtUtc);
    if (!HTTPS.test(input.sellerDisclosureUrl)) throw new StoreValidationError("sellerDisclosureUrl is invalid.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const state = await readState(client, actor.providerId, productId, true);
      if (!state) throw new StoreNotFoundError("sales plan");
      const prior = await client.query<DbRow>(
        `SELECT plan,agreement_version,agreement_confirmed_by FROM experience_product_sales_plan_versions
          WHERE provider_id=$1 AND product_id=$2 AND owner_switch_command_id=$3::uuid`,
        [actor.providerId, productId, input.commandId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].plan !== input.plan || prior.rows[0].agreement_version !== input.agreementVersion
          || prior.rows[0].agreement_confirmed_by !== actor.nihoUserId) throw new StoreConflictError("The switch command was already used.");
        if (state.transitionCommandId === input.commandId) {
          return { state, openCheckouts: await this.#openCheckouts(client, actor.providerId, productId, input.commandId) };
        }
        if (state.phase !== "ACTIVE") throw new StoreConflictError("Another plan switch is in progress.");
        return { state, openCheckouts: [] };
      }
      if (state.version !== input.expectedVersion || state.phase !== "ACTIVE") throw new StoreConflictError("Sales plan version mismatch.");
      if (state.current.plan === input.plan) throw new StoreConflictError("The product already uses this sales plan.");
      const seller = await client.query<DbRow>(
        `SELECT seller_niho_account_ref,stripe_connect_account_ref,seller_display_name
           FROM experience_host_seller_profiles WHERE provider_id=$1 FOR SHARE`, [actor.providerId],
      );
      const consent = await client.query<DbRow>(
        `SELECT 1 FROM provider_payout_account_consents
          WHERE provider_id=$1 AND stripe_connect_account_ref=$2 AND consented_by_niho_user_id=$3
            AND revoked_at IS NULL LIMIT 1 FOR SHARE`,
        [actor.providerId, seller.rows[0]?.stripe_connect_account_ref, actor.nihoUserId],
      );
      if (!seller.rows[0] || !consent.rows[0]) throw new StoreAccessDeniedError();
      const profile = await client.query<DbRow>("SELECT version FROM experience_provider_public_profiles WHERE provider_id=$1 FOR SHARE", [actor.providerId]);
      if (!profile.rows[0]) throw new StoreConflictError("The public provider profile is missing.");
      const next = state.current.revision + 1;
      const fee = input.plan === "SUPPORTED_15" ? 1500 : 1000;
      await client.query(
        `INSERT INTO experience_product_sales_plan_versions
           (provider_id,product_id,revision,plan,charge_mode,provider_public_profile_version,seller_display_name,
            seller_disclosure_url,seller_niho_account_ref,stripe_account_ref,fee_basis_points,agreement_version,
            agreement_confirmed_by,agreement_confirmed_at,agreement_confirmation_method,owner_switch_command_id)
         SELECT $1,$2,$3,$4,'CONNECT_DIRECT',$5,$6,$12,$13,$7,$8,$9,$10,$11,'OWNER_WEB',$14::uuid
           FROM provider_seller_disclosures d
          WHERE d.provider_id=$1 AND d.withdrawn_at IS NULL
            AND d.seller_display_name=$6
            AND (d.method='NATIVE' OR (d.method='EXTERNAL' AND d.external_url=$12))`,
        [actor.providerId, productId, next, input.plan, profile.rows[0].version, seller.rows[0].seller_display_name,
          seller.rows[0].stripe_connect_account_ref, fee, input.agreementVersion, actor.nihoUserId, input.agreementConfirmedAtUtc,
          input.sellerDisclosureUrl, seller.rows[0].seller_niho_account_ref, input.commandId],
      ).then((result) => { if (result.rowCount !== 1) throw new StoreConflictError("The seller disclosure is missing."); });
      await client.query(
        `UPDATE experience_product_sales_plan_states
            SET phase='EXPIRING_OLD_CHECKOUTS',pending_revision=$3,transition_command_id=$4::uuid,
                version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$5`,
        [actor.providerId, productId, next, input.commandId, input.expectedVersion],
      );
      await client.query(
        `INSERT INTO experience_sales_plan_transition_checkouts
           (provider_id,product_id,command_id,booking_id,checkout_session_ref,status)
         SELECT b.provider_id,b.product_id,$3::uuid,b.id,g.checkout_session_ref,'PENDING'
           FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
          WHERE b.provider_id=$1 AND b.product_id=$2 AND b.status='HOLD'
            AND g.checkout_session_ref IS NOT NULL AND b.seller_snapshot->>'salesPlanRevision'=$4`,
        [actor.providerId, productId, input.commandId, String(state.current.revision)],
      );
      const nextState = (await readState(client, actor.providerId, productId))!;
      return { state: nextState, openCheckouts: await this.#openCheckouts(client, actor.providerId, productId, input.commandId) };
    });
  }

  async #openCheckouts(client: Pick<PoolClient, "query">, providerId: string, productId: string, commandId: string) {
    const rows = await client.query<DbRow>(
      `SELECT b.public_booking_id::text AS public_booking_id,t.checkout_session_ref
         FROM experience_sales_plan_transition_checkouts t
         JOIN bookings b ON b.provider_id=t.provider_id AND b.id=t.booking_id
        WHERE t.provider_id=$1 AND t.product_id=$2 AND t.command_id=$3::uuid AND t.status IN ('PENDING','UNKNOWN')
        ORDER BY b.id`, [providerId, productId, commandId],
    );
    return rows.rows.map((row) => ({ publicBookingId: text(row.public_booking_id, "public_booking_id"), checkoutSessionRef: text(row.checkout_session_ref, "checkout_session_ref") }));
  }

  async recordCheckoutOutcome(actor: HostActor, productId: string, commandId: string, checkoutSessionRef: string, outcome: CheckoutTransitionOutcome): Promise<SalesPlanState> {
    if (!UUID_V4.test(commandId) || !/^cs_[A-Za-z0-9_]{1,250}$/.test(checkoutSessionRef) || !["EXPIRED", "PAID", "UNKNOWN"].includes(outcome)) throw new StoreValidationError("The checkout reconciliation is invalid.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const state = await readState(client, actor.providerId, productId, true);
      if (!state || state.transitionCommandId !== commandId || state.phase === "ACTIVE") throw new StoreConflictError("The sales-plan transition is not current.");
      const changed = await client.query(
        `UPDATE experience_sales_plan_transition_checkouts SET status=$5,checked_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND command_id=$3::uuid AND checkout_session_ref=$4
            AND status IN ('PENDING','UNKNOWN')`, [actor.providerId, productId, commandId, checkoutSessionRef, outcome],
      );
      if (changed.rowCount !== 1) throw new StoreConflictError("The checkout outcome was already finalized or is unknown.");
      await client.query(
        `UPDATE experience_product_sales_plan_states SET phase='RECONCILING',version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND transition_command_id=$3::uuid`, [actor.providerId, productId, commandId],
      );
      return (await readState(client, actor.providerId, productId))!;
    });
  }

  async finalizeSwitch(actor: HostActor, productId: string, commandId: string, expectedVersion: number): Promise<SalesPlanState> {
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const state = await readState(client, actor.providerId, productId, true);
      if (!state || state.transitionCommandId !== commandId || state.version !== expectedVersion || !state.pending) throw new StoreConflictError("Sales plan version mismatch.");
      if (state.pending.agreementConfirmedBy !== actor.nihoUserId) throw new StoreAccessDeniedError();
      const ready = await client.query(
        `SELECT 1 FROM experience_host_seller_profiles p
           JOIN provider_payout_account_consents c ON c.provider_id=p.provider_id
            AND c.stripe_connect_account_ref=p.stripe_connect_account_ref AND c.revoked_at IS NULL
           JOIN provider_seller_disclosures d ON d.provider_id=p.provider_id AND d.withdrawn_at IS NULL
            AND d.seller_display_name=p.seller_display_name AND (d.method='NATIVE' OR (d.method='EXTERNAL' AND d.external_url=$6))
          WHERE p.provider_id=$1 AND p.seller_niho_account_ref=$2 AND p.stripe_connect_account_ref=$3
            AND p.seller_display_name=$4 AND c.consented_by_niho_user_id=$5 FOR SHARE OF p,c,d`,
        [actor.providerId, state.pending.sellerNihoAccountRef, state.pending.stripeAccountRef,
          state.pending.sellerDisplayName, actor.nihoUserId, state.pending.sellerDisclosureUrl],
      );
      if (!ready.rows[0]) throw new StoreConflictError("The registered payout account, consent or seller disclosure changed during the switch.");
      const unresolved = await client.query<DbRow>(
        `SELECT count(*)::int AS n FROM experience_sales_plan_transition_checkouts
          WHERE provider_id=$1 AND product_id=$2 AND command_id=$3::uuid AND status IN ('PENDING','UNKNOWN')`,
        [actor.providerId, productId, commandId],
      );
      if (integer(unresolved.rows[0]?.n, "unresolved") !== 0) throw new StoreConflictError("Old Checkout Sessions are not reconciled.");
      await client.query(
        `UPDATE experience_products SET seller_niho_account_ref=$3,stripe_connect_account_ref=$4,seller_display_name=$5,
            version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND id=$2`,
        [actor.providerId, productId, state.pending.sellerNihoAccountRef, state.pending.stripeAccountRef, state.pending.sellerDisplayName],
      );
      await client.query(
        `UPDATE experience_product_sales_plan_states SET current_revision=pending_revision,phase='ACTIVE',pending_revision=NULL,
            transition_command_id=NULL,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3`, [actor.providerId, productId, expectedVersion],
      );
      return (await readState(client, actor.providerId, productId))!;
    });
  }

  /** Recalculates the manual compensation from immutable booking/refund/dispute facts. */
  async calculateCompensation(actor: PublicationAdminDraftActor, publicBookingId: string, commandId: string = randomUUID(), now: Date = new Date()): Promise<ManagedCompensation> {
    validateAdmin(actor);
    if (!UUID_V4.test(publicBookingId) || !UUID_V4.test(commandId)) throw new StoreValidationError("The compensation command is invalid.");
    return withTransaction(this.#pool, async (client) => {
      const booking = await client.query<DbRow>(
        `SELECT b.id,b.provider_id,b.occurrence_snapshot,b.pricing_snapshot,b.seller_snapshot,
                (SELECT l.amount FROM payment_ledger_entries l WHERE l.provider_id=b.provider_id AND l.booking_id=b.id
                  AND l.kind='PAYMENT_CAPTURED' AND l.stripe_payment_ref=b.stripe_payment_ref ORDER BY l.created_at DESC LIMIT 1) AS captured,
                (SELECT l.currency FROM payment_ledger_entries l WHERE l.provider_id=b.provider_id AND l.booking_id=b.id
                  AND l.kind='PAYMENT_CAPTURED' AND l.stripe_payment_ref=b.stripe_payment_ref ORDER BY l.created_at DESC LIMIT 1) AS captured_currency,
                COALESCE((SELECT sum(r.amount) FROM booking_refunds r WHERE r.provider_id=b.provider_id AND r.booking_id=b.id AND r.status='SUCCEEDED'),0)::bigint AS refunded,
                COALESCE((SELECT sum(d.amount) FROM managed_booking_disputes d WHERE d.provider_id=b.provider_id AND d.booking_id=b.id AND d.status='LOST'),0)::bigint AS disputed,
                EXISTS(SELECT 1 FROM booking_refunds r WHERE r.provider_id=b.provider_id AND r.booking_id=b.id AND r.status IN ('REQUESTED','PENDING')) AS refund_pending,
                EXISTS(SELECT 1 FROM managed_booking_disputes d WHERE d.provider_id=b.provider_id AND d.booking_id=b.id AND d.status IN ('NEEDS_RESPONSE','UNDER_REVIEW')) AS dispute_pending
           FROM bookings b WHERE b.public_booking_id=$1::uuid FOR UPDATE OF b`, [publicBookingId],
      );
      const row = booking.rows[0];
      if (!row) throw new StoreNotFoundError("booking");
      const seller = row.seller_snapshot as Record<string, unknown>;
      const pricing = row.pricing_snapshot as Record<string, unknown>;
      const occurrence = row.occurrence_snapshot as Record<string, unknown>;
      if (seller.chargeMode !== "PLATFORM" || seller.salesPlan !== "MANAGED_20" || seller.feeBasisPoints !== 2000
        || !Number.isInteger(seller.paymentDueDays) || (seller.paymentDueDays as number) < 0 || (seller.paymentDueDays as number) > 180
        || typeof occurrence.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(occurrence.localDate)) throw new StoreAccessDeniedError();
      if (typeof occurrence.endUtc !== "string" || !Number.isFinite(Date.parse(occurrence.endUtc)) || !Number.isFinite(now.getTime()) || Date.parse(occurrence.endUtc) > now.getTime()) {
        throw new StoreConflictError("Provider compensation cannot be prepared before the experience ends.");
      }
      if (row.captured === null || row.captured === undefined) throw new StoreConflictError("The booking has no confirmed captured payment.");
      const captured = integer(row.captured, "captured");
      if (captured !== integer(pricing.totalAmount, "totalAmount") || text(row.captured_currency, "captured_currency") !== text(pricing.currency, "currency")) {
        throw new StoreConflictError("The captured payment does not match the immutable pricing snapshot.");
      }
      const refunded = integer(row.refunded, "refunded");
      const disputed = integer(row.disputed, "disputed");
      if (refunded + disputed > captured) throw new StoreConflictError("Refund and dispute facts overlap or exceed the captured amount.");
      const net = captured - refunded - disputed;
      const fee = Math.floor(net * 2000 / 10_000);
      const status = row.refund_pending === true || row.dispute_pending === true ? "REVIEW_REQUIRED" : "READY";
      const dueOn = addLocalDays(occurrence.localDate, seller.paymentDueDays as number);
      const repeated = await client.query<DbRow>(
        `SELECT 1 FROM managed_provider_compensation_events
          WHERE provider_id=$1 AND booking_id=$2 AND command_id=$3::uuid AND action='CALCULATED'`,
        [row.provider_id, row.id, commandId],
      );
      if (repeated.rows[0]) return this.#compensation(client, publicBookingId);
      await client.query(
        `INSERT INTO managed_provider_compensations
           (provider_id,booking_id,currency,captured_amount,refunded_amount,disputed_amount,fee_basis_points,
            niho_fee_amount,provider_amount,due_on,status)
         VALUES ($1,$2,$3,$4,$5,$6,2000,$7,$8,$9,$10)
         ON CONFLICT (provider_id,booking_id) DO UPDATE SET
           refunded_amount=EXCLUDED.refunded_amount,disputed_amount=EXCLUDED.disputed_amount,
           niho_fee_amount=EXCLUDED.niho_fee_amount,provider_amount=EXCLUDED.provider_amount,due_on=EXCLUDED.due_on,
           status=CASE
             WHEN managed_provider_compensations.status IN ('PREPARED','RESULT_UNKNOWN') THEN managed_provider_compensations.status
             WHEN managed_provider_compensations.status IN ('PAID','ADJUSTMENT_REQUIRED')
               THEN CASE WHEN managed_provider_compensations.paid_amount=EXCLUDED.provider_amount THEN 'PAID' ELSE 'ADJUSTMENT_REQUIRED' END
             ELSE EXCLUDED.status END,
           version=managed_provider_compensations.version+1,updated_at=clock_timestamp()`,
        [row.provider_id, row.id, text(pricing.currency, "currency"), captured, refunded, disputed, fee, net - fee, dueOn, status],
      );
      await client.query(
        `INSERT INTO managed_provider_compensation_events (provider_id,booking_id,command_id,actor_admin_niho_user_id,action,amount)
         VALUES ($1,$2,$3::uuid,$4,'CALCULATED',$5) ON CONFLICT DO NOTHING`,
        [row.provider_id, row.id, commandId, actor.nihoUserId, net - fee],
      );
      return this.#compensation(client, publicBookingId);
    });
  }

  async prepareCompensation(actor: PublicationAdminDraftActor, publicBookingId: string, input: { readonly commandId: string; readonly expectedVersion: number; readonly recipientVerified: true }): Promise<ManagedCompensation> {
    validateAdmin(actor);
    if (!UUID_V4.test(input.commandId) || input.recipientVerified !== true) throw new StoreValidationError("The preparation command is invalid.");
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT id FROM bookings WHERE public_booking_id=$1::uuid FOR UPDATE", [publicBookingId]);
      const repeated = await this.#repeatedCompensationCommand(client, publicBookingId, input.commandId, "PREPARED");
      if (repeated) return repeated;
      const changed = await client.query<DbRow>(
        `UPDATE managed_provider_compensations c SET recipient_verified_at=COALESCE(recipient_verified_at,clock_timestamp()),
            status='PREPARED',preparation_id=$2::uuid,prepared_amount=provider_amount,
            prepared_by_admin_niho_user_id=$3,version=version+1,updated_at=clock_timestamp()
          FROM bookings b WHERE b.provider_id=c.provider_id AND b.id=c.booking_id AND b.public_booking_id=$1::uuid
            AND c.version=$4 AND c.status='READY' AND c.provider_amount>0
            AND c.refunded_amount=COALESCE((SELECT sum(r.amount) FROM booking_refunds r
              WHERE r.provider_id=b.provider_id AND r.booking_id=b.id AND r.status='SUCCEEDED'),0)
            AND c.disputed_amount=COALESCE((SELECT sum(d.amount) FROM managed_booking_disputes d
              WHERE d.provider_id=b.provider_id AND d.booking_id=b.id AND d.status='LOST'),0)
            AND NOT EXISTS (SELECT 1 FROM booking_refunds r
              WHERE r.provider_id=b.provider_id AND r.booking_id=b.id AND r.status IN ('REQUESTED','PENDING'))
            AND NOT EXISTS (SELECT 1 FROM managed_booking_disputes d
              WHERE d.provider_id=b.provider_id AND d.booking_id=b.id AND d.status IN ('NEEDS_RESPONSE','UNDER_REVIEW'))
          RETURNING c.provider_id,c.booking_id,c.provider_amount`,
        [publicBookingId, input.commandId, actor.nihoUserId, input.expectedVersion],
      );
      if (!changed.rows[0]) throw new StoreConflictError("The compensation is not ready or its version changed.");
      await client.query(
        `INSERT INTO managed_provider_compensation_events (provider_id,booking_id,command_id,actor_admin_niho_user_id,action,amount)
         VALUES ($1,$2,$3::uuid,$4,'PREPARED',$5)`,
        [changed.rows[0].provider_id, changed.rows[0].booking_id, input.commandId, actor.nihoUserId, changed.rows[0].provider_amount],
      );
      return this.#compensation(client, publicBookingId);
    });
  }

  async markCompensationResultUnknown(actor: PublicationAdminDraftActor, publicBookingId: string, input: { readonly commandId: string; readonly expectedVersion: number }): Promise<ManagedCompensation> {
    validateAdmin(actor);
    if (!UUID_V4.test(input.commandId)) throw new StoreValidationError("The result-unknown command is invalid.");
    return withTransaction(this.#pool, async (client) => {
      const repeated = await this.#repeatedCompensationCommand(client, publicBookingId, input.commandId, "RESULT_UNKNOWN");
      if (repeated) return repeated;
      const changed = await client.query<DbRow>(
        `UPDATE managed_provider_compensations c SET status='RESULT_UNKNOWN',version=version+1,updated_at=clock_timestamp()
          FROM bookings b WHERE b.provider_id=c.provider_id AND b.id=c.booking_id AND b.public_booking_id=$1::uuid
            AND c.version=$2 AND c.status='PREPARED'
          RETURNING c.provider_id,c.booking_id,c.provider_amount`,
        [publicBookingId, input.expectedVersion],
      );
      if (!changed.rows[0]) throw new StoreConflictError("The compensation preparation changed or is not awaiting a result.");
      await client.query(
        `INSERT INTO managed_provider_compensation_events (provider_id,booking_id,command_id,actor_admin_niho_user_id,action,amount)
         VALUES ($1,$2,$3::uuid,$4,'RESULT_UNKNOWN',$5)`,
        [changed.rows[0].provider_id, changed.rows[0].booking_id, input.commandId, actor.nihoUserId, changed.rows[0].provider_amount],
      );
      return this.#compensation(client, publicBookingId);
    });
  }

  async reconcileCompensation(actor: PublicationAdminDraftActor, publicBookingId: string, input: { readonly commandId: string; readonly expectedVersion: number; readonly statementReference: string; readonly paidAtUtc: string; readonly paidAmount: number }): Promise<ManagedCompensation> {
    validateAdmin(actor); assertCanonicalInstant(input.paidAtUtc, "paidAtUtc");
    if (!UUID_V4.test(input.commandId) || input.statementReference.trim().length < 1 || input.statementReference.length > 160
      || !Number.isSafeInteger(input.paidAmount) || input.paidAmount <= 0) throw new StoreValidationError("The reconciliation command is invalid.");
    return withTransaction(this.#pool, async (client) => {
      const repeated = await this.#repeatedCompensationCommand(client, publicBookingId, input.commandId, "RECONCILED_PAID");
      if (repeated) return repeated;
      const changed = await client.query<DbRow>(
        `UPDATE managed_provider_compensations c SET status=CASE WHEN provider_amount=$5 THEN 'PAID' ELSE 'ADJUSTMENT_REQUIRED' END,
            statement_reference=$2,paid_amount=$5,paid_by_admin_niho_user_id=$3,paid_at=$4,version=version+1,updated_at=clock_timestamp()
          FROM bookings b WHERE b.provider_id=c.provider_id AND b.id=c.booking_id AND b.public_booking_id=$1::uuid
            AND c.version=$6 AND c.status IN ('PREPARED','RESULT_UNKNOWN') AND c.recipient_verified_at IS NOT NULL
          RETURNING c.provider_id,c.booking_id,c.provider_amount`,
        [publicBookingId, input.statementReference.trim(), actor.nihoUserId, input.paidAtUtc, input.paidAmount, input.expectedVersion],
      );
      if (!changed.rows[0]) throw new StoreConflictError("The compensation result cannot be reconciled at this version.");
      await client.query(
        `INSERT INTO managed_provider_compensation_events (provider_id,booking_id,command_id,actor_admin_niho_user_id,action,amount)
         VALUES ($1,$2,$3::uuid,$4,'RECONCILED_PAID',$5)`,
        [changed.rows[0].provider_id, changed.rows[0].booking_id, input.commandId, actor.nihoUserId, input.paidAmount],
      );
      return this.#compensation(client, publicBookingId);
    });
  }

  async getCompensation(publicBookingId: string): Promise<ManagedCompensation> {
    if (!UUID_V4.test(publicBookingId)) throw new StoreValidationError("publicBookingId is invalid.");
    return this.#compensation(this.#pool, publicBookingId);
  }

  async reconcileCompensationNotPaid(actor: PublicationAdminDraftActor, publicBookingId: string, input: {
    readonly commandId: string; readonly expectedVersion: number; readonly statementReference: string;
  }): Promise<ManagedCompensation> {
    validateAdmin(actor);
    const reference = input.statementReference.trim();
    if (!UUID_V4.test(input.commandId) || reference.length < 1 || reference.length > 160) {
      throw new StoreValidationError("The unpaid reconciliation command is invalid.");
    }
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT id FROM bookings WHERE public_booking_id=$1::uuid FOR UPDATE", [publicBookingId]);
      const repeated = await this.#repeatedCompensationCommand(client, publicBookingId, input.commandId, "RECONCILED_NOT_PAID");
      if (repeated) return repeated;
      const changed = await client.query<DbRow>(
        `UPDATE managed_provider_compensations c SET status='REVIEW_REQUIRED',recipient_verified_at=NULL,
            preparation_id=NULL,prepared_amount=NULL,prepared_by_admin_niho_user_id=NULL,version=version+1,updated_at=clock_timestamp()
          FROM bookings b WHERE b.provider_id=c.provider_id AND b.id=c.booking_id AND b.public_booking_id=$1::uuid
            AND c.version=$2 AND c.status='RESULT_UNKNOWN' RETURNING c.provider_id,c.booking_id`,
        [publicBookingId, input.expectedVersion],
      );
      const booking = changed.rows[0];
      if (!booking) throw new StoreConflictError("Only an unknown result can be reconciled as unpaid.");
      await client.query(
        `INSERT INTO managed_provider_compensation_events
           (provider_id,booking_id,command_id,actor_admin_niho_user_id,action,amount,statement_reference)
         VALUES ($1,$2,$3::uuid,$4,'RECONCILED_NOT_PAID',0,$5)`,
        [booking.provider_id, booking.booking_id, input.commandId, actor.nihoUserId, reference],
      );
      return this.#compensation(client, publicBookingId);
    });
  }

  /** Host-safe projection: no platform account, bank detail, operator, statement or Stripe reference leaves the store. */
  async listHostCompensations(actor: HostActor, limit = 100): Promise<readonly HostManagedCompensation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be 1-200.");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      const result = await client.query<DbRow>(
        `SELECT b.public_booking_id::text,c.currency,c.provider_amount,to_char(c.due_on,'YYYY-MM-DD') AS due_on,c.status,c.paid_at
           FROM managed_provider_compensations c
           JOIN bookings b ON b.provider_id=c.provider_id AND b.id=c.booking_id
          WHERE c.provider_id=$1 ORDER BY c.due_on DESC,b.id DESC LIMIT $2`,
        [actor.providerId, limit],
      );
      return result.rows.map((row) => ({
        publicBookingId: text(row.public_booking_id, "public_booking_id"), currency: text(row.currency, "currency"),
        providerAmount: integer(row.provider_amount, "provider_amount"),
        dueOn: text(row.due_on, "due_on"),
        status: text(row.status, "status") as ManagedCompensation["status"],
        paidAtUtc: row.paid_at === null ? null : isoValue(row, "paid_at"),
      }));
    });
  }

  async #repeatedCompensationCommand(
    client: Pick<PoolClient, "query">,
    publicBookingId: string,
    commandId: string,
    action: "PREPARED" | "RESULT_UNKNOWN" | "RECONCILED_PAID" | "RECONCILED_NOT_PAID",
  ): Promise<ManagedCompensation | null> {
    const found = await client.query<DbRow>(
      `SELECT 1 FROM managed_provider_compensation_events e
        JOIN bookings b ON b.provider_id=e.provider_id AND b.id=e.booking_id
       WHERE b.public_booking_id=$1::uuid AND e.command_id=$2::uuid AND e.action=$3`,
      [publicBookingId, commandId, action],
    );
    return found.rows[0] ? this.#compensation(client, publicBookingId) : null;
  }

  async #compensation(client: Pick<PoolClient, "query">, publicBookingId: string): Promise<ManagedCompensation> {
    const result = await client.query<DbRow>(
      `SELECT b.public_booking_id::text,c.*,to_char(c.due_on,'YYYY-MM-DD') AS due_date FROM managed_provider_compensations c
        JOIN bookings b ON b.provider_id=c.provider_id AND b.id=c.booking_id WHERE b.public_booking_id=$1::uuid`, [publicBookingId],
    );
    const row = result.rows[0]; if (!row) throw new StoreNotFoundError("managed compensation");
    return {
      publicBookingId: text(row.public_booking_id, "public_booking_id"), providerId: text(row.provider_id, "provider_id"),
      currency: text(row.currency, "currency"), capturedAmount: integer(row.captured_amount, "captured_amount"),
      refundedAmount: integer(row.refunded_amount, "refunded_amount"), disputedAmount: integer(row.disputed_amount, "disputed_amount"),
      nihoFeeAmount: integer(row.niho_fee_amount, "niho_fee_amount"), providerAmount: integer(row.provider_amount, "provider_amount"),
      dueOn: text(row.due_date, "due_date"),
      recipientVerified: row.recipient_verified_at !== null, status: text(row.status, "status") as ManagedCompensation["status"],
      preparationId: row.preparation_id === null ? null : text(row.preparation_id, "preparation_id"),
      statementReference: row.statement_reference === null ? null : text(row.statement_reference, "statement_reference"),
      preparedAmount: row.prepared_amount === null ? null : integer(row.prepared_amount, "prepared_amount"),
      paidAmount: row.paid_amount === null ? null : integer(row.paid_amount, "paid_amount"),
      adjustmentAmount: row.paid_amount === null ? null : integer(row.provider_amount, "provider_amount") - integer(row.paid_amount, "paid_amount"),
      version: integer(row.version, "version"),
    };
  }
}
