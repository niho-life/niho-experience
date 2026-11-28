import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { lockProviderInventory } from "./inventory.ts";
import { readSalesPlanState, type SalesPlanState } from "./managed-sales.ts";
import { requireMembership } from "./repository.ts";
import { isAgentSellerRef } from "./sales-kind.ts";
import { countingAgentConsent, nativeDisclosureName } from "./agent-consent.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 代理受領で売る (Epic #700 stage 3b-1, docs/host-payouts.md): a host that has no seller profile chooses "サポート 15%（NIHO が代金を
 * 受け取る）" for a product. One transaction takes the provider's inventory lock, checks the OWNER, the host's public seller
 * disclosure (NATIVE) and its consent, writes the immutable sales-plan revision and its state, and sets the product's three seller
 * columns (the platform account is the payment recipient, the provider's `agt_` reference the seller). The same command ID again
 * returns the same result. The seller profile (Direct charge) is never used or written here.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT = /^acct_[A-Za-z0-9]{8,}$/;
const HTTPS = /^https:\/\/[^\s]{1,2040}$/;
const VERSION = /^[\x21-\x7e]{1,160}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface AgentSalesChoiceInput {
  readonly commandId: string;
  /** The sales-plan state's version the host read; null when the product has no sales plan yet. */
  readonly expectedStateVersion: number | null;
  readonly agreementVersion: string;
  readonly accepted: true;
  /** From configuration, never from the browser. */
  readonly platformAccountId: string;
  readonly receivingAgentName: string;
  readonly payoutDelayDays: number;
  /** The host's own `/experiences/{slug}/seller` page. */
  readonly sellerDisclosureUrl: string;
}

export interface AgentSalesChoice {
  readonly state: SalesPlanState;
  readonly sellerRef: string;
  readonly productVersion: number;
  /** True when this command had already been applied. */
  readonly replayed: boolean;
}

export interface AgentSalesConsent {
  readonly sellerRef: string;
  readonly consentVersion: string;
  readonly consentedAtUtc: string;
  readonly consentedByHostAccountId: string;
}

function consentFromRow(row: DbRow): AgentSalesConsent {
  return {
    sellerRef: String(row.seller_ref),
    consentVersion: String(row.consent_version),
    consentedAtUtc: isoValue(row, "consented_at"),
    consentedByHostAccountId: String(row.consented_by_host_account_id),
  };
}

async function requireHostAccountOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor?.providerId, "providerId");
  if (!isHostAccountId(actor.nihoUserId)) throw new StoreAccessDeniedError();
  await requireMembership(client, actor, ["OWNER"]);
  const account = await client.query(
    "SELECT 1 FROM host_accounts WHERE id=$1 AND status='ACTIVE' FOR SHARE", [actor.nihoUserId],
  );
  if (account.rowCount === 0) throw new StoreAccessDeniedError();
}

function validateInput(input: AgentSalesChoiceInput): void {
  if (!UUID_V4.test(input?.commandId ?? "")) throw new StoreValidationError("commandId must be a UUID v4.");
  if (input.expectedStateVersion !== null && (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 1)) {
    throw new StoreValidationError("expectedStateVersion is invalid.");
  }
  if (typeof input.agreementVersion !== "string" || !VERSION.test(input.agreementVersion)) throw new StoreValidationError("agreementVersion is invalid.");
  if (input.accepted !== true) throw new StoreValidationError("The agent-sales consent must be accepted.");
  if (!ACCOUNT.test(input.platformAccountId)) throw new StoreValidationError("The platform account is invalid.");
  const name = input.receivingAgentName;
  if (typeof name !== "string" || name.trim() !== name || name.length < 1 || name.length > 300 || CONTROL.test(name)) {
    throw new StoreValidationError("receivingAgentName is invalid.");
  }
  if (!Number.isSafeInteger(input.payoutDelayDays) || input.payoutDelayDays < 1 || input.payoutDelayDays > 30) throw new StoreValidationError("payoutDelayDays is invalid.");
  if (!HTTPS.test(input.sellerDisclosureUrl)) throw new StoreValidationError("sellerDisclosureUrl is invalid.");
}

export class ProviderAgentSales {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  /** The OWNER's active consent of the provider, if any (the screen shows it; selling re-checks it in the store). */
  async currentConsent(providerId: string): Promise<AgentSalesConsent | null> {
    assertStoreIdentifier(providerId, "providerId");
    const found = await this.#pool.query<DbRow>(
      `SELECT seller_ref,consent_version,consented_at,consented_by_host_account_id
         FROM provider_agent_sales_consents WHERE provider_id=$1 AND revoked_at IS NULL`, [providerId],
    );
    return found.rows[0] ? consentFromRow(found.rows[0]) : null;
  }

  /** Whether the OWNER's consent counts now for this seller reference (active, and given by a host account that is still an active OWNER). */
  async consentCounts(providerId: string, sellerRef: string): Promise<boolean> {
    assertStoreIdentifier(providerId, "providerId");
    return (await countingAgentConsent(this.#pool, providerId, sellerRef)) !== null;
  }

  /**
   * Withdraws the active consent. The consent row stays (history). Nothing sells under it after this: the sale paths read the
   * consent again, and a new booking start needs a fresh choose().
   */
  async revokeConsent(actor: HostActor, nowUtc: string = new Date().toISOString()): Promise<"REVOKED" | "NONE"> {
    assertCanonicalInstant(nowUtc, "nowUtc");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const revoked = await client.query(
        `UPDATE provider_agent_sales_consents SET revoked_at=GREATEST($2::timestamptz,consented_at),revoked_by_host_account_id=$3
          WHERE provider_id=$1 AND revoked_at IS NULL`, [actor.providerId, nowUtc, actor.nihoUserId],
      );
      return (revoked.rowCount ?? 0) > 0 ? "REVOKED" : "NONE";
    });
  }

  async choose(actor: HostActor, productId: string, input: AgentSalesChoiceInput): Promise<AgentSalesChoice> {
    assertStoreIdentifier(productId, "productId");
    validateInput(input);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const product = await client.query<DbRow>(
        `SELECT version,seller_niho_account_ref FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE`,
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");

      // The same command again: its revision is already there. The result is the current state, if that is still this revision.
      const prior = await client.query<DbRow>(
        `SELECT revision,agreement_version,agreement_confirmed_by,plan,charge_mode FROM experience_product_sales_plan_versions
          WHERE provider_id=$1 AND product_id=$2 AND owner_switch_command_id=$3::uuid`,
        [actor.providerId, productId, input.commandId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].plan !== "SUPPORTED_15" || prior.rows[0].charge_mode !== "PLATFORM"
          || prior.rows[0].agreement_version !== input.agreementVersion || prior.rows[0].agreement_confirmed_by !== actor.nihoUserId) {
          throw new StoreConflictError("The command was already used.");
        }
        const state = await readSalesPlanState(client, actor.providerId, productId);
        if (!state || state.current.revision !== Number(prior.rows[0].revision)) throw new StoreConflictError("The command was superseded; read the product again.");
        return { state, sellerRef: state.current.sellerNihoAccountRef, productVersion: Number(product.rows[0].version), replayed: true };
      }

      const profile = await client.query("SELECT 1 FROM experience_host_seller_profiles WHERE provider_id=$1 FOR SHARE", [actor.providerId]);
      if ((profile.rowCount ?? 0) > 0) throw new StoreConflictError("SELLER_EXISTS");
      const disclosureName = await nativeDisclosureName(client, actor.providerId, true);
      if (disclosureName === null) throw new StoreConflictError("SELLER_DISCLOSURE_REQUIRED");

      const state = await readSalesPlanState(client, actor.providerId, productId, true);
      if ((state?.version ?? null) !== input.expectedStateVersion) throw new StoreConflictError("Sales plan version mismatch.");
      if (state !== null) {
        const current = state.current;
        if (current.chargeMode !== "PLATFORM" || current.plan !== "SUPPORTED_15" || current.sellerParty !== "PROVIDER") {
          throw new StoreConflictError("This product is sold on another plan and cannot move to agent sales.");
        }
        if (state.phase !== "ACTIVE") throw new StoreConflictError("A sales plan switch is in progress.");
        const selling = await client.query(
          `SELECT 1 FROM experience_product_publication_states
            WHERE provider_id=$1 AND product_id=$2 AND booking_publication_id IS NOT NULL AND self_stopped_at IS NULL
              AND operations_suspended_at IS NULL AND owner_resume_required=false`, [actor.providerId, productId],
        );
        if ((selling.rowCount ?? 0) > 0) throw new StoreConflictError("Stop taking bookings before choosing agent sales again.");
      } else if (product.rows[0].seller_niho_account_ref !== null) {
        throw new StoreConflictError("This product already has a seller.");
      }

      const publicProfile = await client.query<DbRow>(
        "SELECT version FROM experience_provider_public_profiles WHERE provider_id=$1 FOR SHARE", [actor.providerId],
      );
      if (!publicProfile.rows[0]) throw new StoreConflictError("The public provider profile is missing.");

      // The consent: the provider's one active row. A new version or a new OWNER replaces it with the same seller reference.
      const nowUtc = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
      const lastRef = await client.query<DbRow>(
        "SELECT seller_ref FROM provider_agent_sales_consents WHERE provider_id=$1 ORDER BY consented_at DESC,id LIMIT 1", [actor.providerId],
      );
      const sellerRef = lastRef.rows[0] ? String(lastRef.rows[0].seller_ref) : `agt_${randomBytes(16).toString("hex")}`;
      if (!isAgentSellerRef(sellerRef)) throw new StoreConflictError("The agent seller reference is invalid.");
      const active = await client.query<DbRow>(
        `SELECT id,consent_version,consented_by_host_account_id FROM provider_agent_sales_consents
          WHERE provider_id=$1 AND revoked_at IS NULL FOR UPDATE`, [actor.providerId],
      );
      const same = active.rows[0] && active.rows[0].consent_version === input.agreementVersion
        && active.rows[0].consented_by_host_account_id === actor.nihoUserId;
      if (!same) {
        if (active.rows[0]) {
          await client.query(
            "UPDATE provider_agent_sales_consents SET revoked_at=GREATEST($2::timestamptz,consented_at),revoked_by_host_account_id=$3 WHERE id=$1",
            [active.rows[0].id, nowUtc, actor.nihoUserId],
          );
        }
        await client.query(
          `INSERT INTO provider_agent_sales_consents (id,provider_id,seller_ref,consent_version,consented_by_host_account_id,consented_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), actor.providerId, sellerRef, input.agreementVersion, actor.nihoUserId, nowUtc],
        );
      }

      const revision = state === null ? 1 : state.current.revision + 1;
      await client.query(
        `INSERT INTO experience_product_sales_plan_versions
           (provider_id,product_id,revision,plan,charge_mode,provider_public_profile_version,seller_display_name,seller_disclosure_url,
            seller_niho_account_ref,stripe_account_ref,fee_basis_points,agreement_version,agreement_confirmed_by,agreement_confirmed_at,
            agreement_confirmation_method,payout_delay_days,receiving_agent_name,owner_switch_command_id)
         VALUES ($1,$2,$3,'SUPPORTED_15','PLATFORM',$4,$5,$6,$7,$8,1500,$9,$10,$11,'OWNER_WEB',$12,$13,$14::uuid)`,
        [actor.providerId, productId, revision, publicProfile.rows[0].version, disclosureName, input.sellerDisclosureUrl, sellerRef,
          input.platformAccountId, input.agreementVersion, actor.nihoUserId, nowUtc, input.payoutDelayDays, input.receivingAgentName, input.commandId],
      );
      if (state === null) {
        await client.query(
          "INSERT INTO experience_product_sales_plan_states (provider_id,product_id,current_revision) VALUES ($1,$2,$3)",
          [actor.providerId, productId, revision],
        );
      } else {
        const moved = await client.query(
          `UPDATE experience_product_sales_plan_states SET current_revision=$3,version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND product_id=$2 AND version=$4`,
          [actor.providerId, productId, revision, state.version],
        );
        if (moved.rowCount !== 1) throw new StoreConflictError("Sales plan version mismatch.");
      }
      const updated = await client.query<DbRow>(
        `UPDATE experience_products SET seller_niho_account_ref=$3,stripe_connect_account_ref=$4,seller_display_name=$5,
            version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND id=$2 RETURNING version`,
        [actor.providerId, productId, sellerRef, input.platformAccountId, disclosureName],
      );
      return {
        state: (await readSalesPlanState(client, actor.providerId, productId))!,
        sellerRef, productVersion: Number(updated.rows[0]!.version), replayed: false,
      };
    });
  }
}
