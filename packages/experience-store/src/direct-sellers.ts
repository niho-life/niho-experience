import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { nativeDisclosureName } from "./agent-consent.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { lockProviderInventory } from "./inventory.ts";
import { readSalesPlanState, type SalesPlanState } from "./managed-sales.ts";
import { recordPayoutConsentIn, validPayoutConsentInstant, validPayoutConsentVersion, type PayoutAccountConsentRecord } from "./payout-account-consents.ts";
import type { DbRow } from "./rows.ts";
import { attachSellerToSellerlessProducts } from "./seller-attachment.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { ownStripeSellerSql } from "./sales-kind.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * 自分の Stripe アカウントで売る販売者の登録 (Epic #700 stage 3c-1, #726, migration 0099, docs/host-payouts.md「3c」): the host's OWN
 * Stripe account (a DIRECT row of experience_connect_accounts) becomes the provider's Direct charge seller. One transaction:
 * the provider's inventory lock, the OWNER, no seller yet, the DIRECT row's account READY in a read of the last 5 minutes, the
 * public seller disclosure (NATIVE) whose name the seller keeps, the profile, the payout-account consent, and the products that had no seller.
 * Nothing is left behind when a step fails. The profile is written by the runtime only through this method (a trigger refuses any
 * other insert from a role that is not the table's owner).
 */

/** How recent Stripe's read of the account must be. */
export const DIRECT_ACCOUNT_READ_MAX_AGE_MS = 5 * 60 * 1000;
const ACCOUNT_REF = /^acct_[A-Za-z0-9]{8,250}$/;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTTPS = /^https:\/\/[^\s]{1,2040}$/;
const VERSION = /^[\x21-\x7e]{1,160}$/;

export interface IndependentSalesChoiceInput {
  readonly commandId: string;
  /** The sales-plan state's version the host read; null when the product has no sales plan yet. */
  readonly expectedStateVersion: number | null;
  readonly agreementVersion: string;
  /** The host's own `/experiences/{slug}/seller` page. */
  readonly sellerDisclosureUrl: string;
  readonly nowUtc: string;
}

export interface IndependentSalesChoice {
  readonly state: SalesPlanState;
  readonly sellerRef: string;
  readonly productVersion: number;
  /** True when this command had already been applied. */
  readonly replayed: boolean;
}

export interface DirectSellerRegistration {
  readonly sellerRef: string;
  readonly sellerDisplayName: string;
  readonly consent: PayoutAccountConsentRecord;
  /** Products that had no seller and now have this one. */
  readonly attachedProducts: number;
}

function validActor(actor: HostActor): void {
  if (typeof actor?.providerId !== "string") throw new StoreValidationError("actor.providerId must be a stable 1-256 character identifier.");
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  if (!isHostAccountId(actor.nihoUserId)) throw new StoreAccessDeniedError();
}

async function requireHostAccountOwner(client: PoolClient, actor: HostActor): Promise<void> {
  const owner = await client.query(
    `SELECT 1 FROM provider_memberships membership
       JOIN host_accounts account ON account.id=membership.niho_user_id AND account.status='ACTIVE'
      WHERE membership.provider_id=$1 AND membership.niho_user_id=$2 AND membership.active=true AND membership.role='OWNER'
      FOR SHARE OF membership,account`,
    [actor.providerId, actor.nihoUserId],
  );
  if ((owner.rowCount ?? 0) === 0) throw new StoreAccessDeniedError();
}

export class ProviderDirectSellers {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** The seller name of the provider's seller profile when that profile is its own Stripe account (a DIRECT row), else null. */
  async ownStripeSellerName(providerId: string): Promise<string | null> {
    assertStoreIdentifier(providerId, "providerId");
    const found = await this.#pool.query<DbRow>(
      `SELECT seller_display_name FROM experience_host_seller_profiles WHERE provider_id=$1 AND ${ownStripeSellerSql("$1")}`, [providerId],
    );
    return found.rows[0] ? String(found.rows[0].seller_display_name) : null;
  }

  /**
   * Registers the provider's seller profile from its READY own account and records the OWNER's consent to be paid there.
   * StoreConflictError messages: "SELLER_EXISTS" (the provider has a seller already), "DIRECT_ACCOUNT_NOT_READY" (no valid
   * account row of this ID, or Stripe's read of it is not READY or older than 5 minutes), "SELLER_DISCLOSURE_REQUIRED" (no
   * public NATIVE seller disclosure), "PUBLIC_PROFILE_MISSING".
   */
  async register(
    actor: HostActor,
    input: { readonly stripeConnectAccountRef: string; readonly consentVersion: string; readonly nowUtc: string },
  ): Promise<DirectSellerRegistration> {
    validActor(actor);
    if (typeof input?.stripeConnectAccountRef !== "string" || !ACCOUNT_REF.test(input.stripeConnectAccountRef)) {
      throw new StoreValidationError("stripeConnectAccountRef must be a Stripe connected account ID.");
    }
    const version = validPayoutConsentVersion(input.consentVersion);
    const at = validPayoutConsentInstant(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const existing = await client.query("SELECT 1 FROM experience_host_seller_profiles WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      if ((existing.rowCount ?? 0) > 0) throw new StoreConflictError("SELLER_EXISTS");

      const account = await client.query<DbRow>(
        `SELECT account.id,snapshot.state,snapshot.read_at
           FROM experience_connect_accounts account
           LEFT JOIN experience_connect_account_snapshots snapshot ON snapshot.connect_account_id=account.id
          WHERE account.provider_id=$1 AND account.purpose='DIRECT' AND account.retired_at IS NULL AND account.stripe_account_ref=$2
          FOR SHARE OF account`,
        [actor.providerId, input.stripeConnectAccountRef],
      );
      const row = account.rows[0];
      const readAt = row?.read_at instanceof Date ? row.read_at.getTime() : Number.NaN;
      const asked = Date.parse(at);
      if (!row || row.state !== "READY" || !Number.isFinite(readAt) || readAt < asked - DIRECT_ACCOUNT_READ_MAX_AGE_MS || readAt > asked + DIRECT_ACCOUNT_READ_MAX_AGE_MS) {
        throw new StoreConflictError("DIRECT_ACCOUNT_NOT_READY");
      }

      const sellerName = await nativeDisclosureName(client, actor.providerId, true);
      if (sellerName === null) throw new StoreConflictError("SELLER_DISCLOSURE_REQUIRED");
      const publicProfile = await client.query<DbRow>(
        "SELECT public_display_name FROM experience_provider_public_profiles WHERE provider_id=$1 FOR SHARE",
        [actor.providerId],
      );
      if (!publicProfile.rows[0]) throw new StoreConflictError("PUBLIC_PROFILE_MISSING");

      const sellerRef = `sel_${randomBytes(16).toString("hex")}`;
      await client.query(
        `INSERT INTO experience_host_seller_profiles
           (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id,connect_account_purpose)
         VALUES ($1,NULL,$2,$3,$4,$5,$6::uuid,'DIRECT')`,
        [actor.providerId, String(publicProfile.rows[0].public_display_name), sellerRef, input.stripeConnectAccountRef, sellerName, String(row.id)],
      );
      const consent = await recordPayoutConsentIn(client, actor, { stripeConnectAccountRef: input.stripeConnectAccountRef, consentVersion: version, nowUtc: at });
      const attachedProducts = await attachSellerToSellerlessProducts(client, actor.providerId);
      return { sellerRef, sellerDisplayName: sellerName, consent, attachedProducts };
    });
  }

  /**
   * 独立 10% で売る (3c-2, #726): a product that has no sales plan yet gets revision 1 (INDEPENDENT_10, CONNECT_DIRECT, 1000, OWNER_WEB)
   * under the host's own Stripe seller profile, its state, and the product's three seller columns. A product that is sold with 代理受領
   * moves through beginOwnerSwitch / finalizeSwitch instead (managed-sales.ts), not here. The same command ID again returns the same result.
   * StoreConflictError messages: "DIRECT_SELLER_REQUIRED" (the provider's seller profile is not its own Stripe account), "PAYOUT_CONSENT_REQUIRED",
   * "SELLER_DISCLOSURE_REQUIRED" (no public NATIVE disclosure, or not the profile's name), "SELLER_MISMATCH" (the product has another seller),
   * "PUBLIC_PROFILE_MISSING", "VERSION_CONFLICT".
   */
  async chooseIndependent(actor: HostActor, productId: string, input: IndependentSalesChoiceInput): Promise<IndependentSalesChoice> {
    validActor(actor);
    assertStoreIdentifier(productId, "productId");
    if (!UUID_V4.test(input?.commandId ?? "")) throw new StoreValidationError("commandId must be a UUID v4.");
    if (input.expectedStateVersion !== null && (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 1)) {
      throw new StoreValidationError("expectedStateVersion is invalid.");
    }
    if (typeof input.agreementVersion !== "string" || !VERSION.test(input.agreementVersion)) throw new StoreValidationError("agreementVersion is invalid.");
    if (typeof input.sellerDisclosureUrl !== "string" || !HTTPS.test(input.sellerDisclosureUrl)) throw new StoreValidationError("sellerDisclosureUrl is invalid.");
    const at = validPayoutConsentInstant(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const product = await client.query<DbRow>(
        `SELECT version,seller_niho_account_ref,stripe_connect_account_ref FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE`,
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");

      const prior = await client.query<DbRow>(
        `SELECT revision,plan,charge_mode,agreement_version,agreement_confirmed_by FROM experience_product_sales_plan_versions
          WHERE provider_id=$1 AND product_id=$2 AND owner_switch_command_id=$3::uuid`,
        [actor.providerId, productId, input.commandId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].plan !== "INDEPENDENT_10" || prior.rows[0].charge_mode !== "CONNECT_DIRECT"
          || prior.rows[0].agreement_version !== input.agreementVersion || prior.rows[0].agreement_confirmed_by !== actor.nihoUserId) {
          throw new StoreConflictError("The command was already used.");
        }
        const state = await readSalesPlanState(client, actor.providerId, productId);
        if (!state || state.current.revision !== Number(prior.rows[0].revision)) throw new StoreConflictError("The command was superseded; read the product again.");
        return { state, sellerRef: state.current.sellerNihoAccountRef, productVersion: Number(product.rows[0].version), replayed: true };
      }

      const profile = await client.query<DbRow>(
        `SELECT seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id
           FROM experience_host_seller_profiles WHERE provider_id=$1 FOR SHARE`, [actor.providerId],
      );
      const seller = profile.rows[0];
      if (!seller || seller.connect_account_id === null || seller.connect_account_id === undefined) throw new StoreConflictError("DIRECT_SELLER_REQUIRED");
      const sellerRef = String(seller.seller_niho_account_ref);
      const accountRef = String(seller.stripe_connect_account_ref);
      const account = await client.query(
        `SELECT 1 FROM experience_connect_accounts WHERE id=$1::uuid AND provider_id=$2 AND purpose='DIRECT' AND retired_at IS NULL
            AND stripe_account_ref=$3 FOR SHARE`,
        [String(seller.connect_account_id), actor.providerId, accountRef],
      );
      if ((account.rowCount ?? 0) === 0) throw new StoreConflictError("DIRECT_SELLER_REQUIRED");
      const consent = await client.query(
        `SELECT 1 FROM provider_payout_account_consents
          WHERE provider_id=$1 AND stripe_connect_account_ref=$2 AND consented_by_niho_user_id=$3 AND revoked_at IS NULL LIMIT 1 FOR SHARE`,
        [actor.providerId, accountRef, actor.nihoUserId],
      );
      if ((consent.rowCount ?? 0) === 0) throw new StoreConflictError("PAYOUT_CONSENT_REQUIRED");
      const disclosureName = await nativeDisclosureName(client, actor.providerId, true);
      if (disclosureName === null || disclosureName !== String(seller.seller_display_name)) throw new StoreConflictError("SELLER_DISCLOSURE_REQUIRED");

      const state = await readSalesPlanState(client, actor.providerId, productId, true);
      // A product that has a sales plan already is switched (beginOwnerSwitch), not chosen: the state must be none, and so must the version read.
      if (state !== null || input.expectedStateVersion !== null) throw new StoreConflictError("VERSION_CONFLICT");
      const productSeller = product.rows[0].seller_niho_account_ref;
      if (productSeller !== null && (productSeller !== sellerRef || product.rows[0].stripe_connect_account_ref !== accountRef)) {
        throw new StoreConflictError("SELLER_MISMATCH");
      }
      const publicProfile = await client.query<DbRow>("SELECT version FROM experience_provider_public_profiles WHERE provider_id=$1 FOR SHARE", [actor.providerId]);
      if (!publicProfile.rows[0]) throw new StoreConflictError("PUBLIC_PROFILE_MISSING");

      await client.query(
        `INSERT INTO experience_product_sales_plan_versions
           (provider_id,product_id,revision,plan,charge_mode,provider_public_profile_version,seller_display_name,seller_disclosure_url,
            seller_niho_account_ref,stripe_account_ref,fee_basis_points,agreement_version,agreement_confirmed_by,agreement_confirmed_at,
            agreement_confirmation_method,owner_switch_command_id)
         VALUES ($1,$2,1,'INDEPENDENT_10','CONNECT_DIRECT',$3,$4,$5,$6,$7,1000,$8,$9,$10,'OWNER_WEB',$11::uuid)`,
        [actor.providerId, productId, publicProfile.rows[0].version, disclosureName, input.sellerDisclosureUrl, sellerRef, accountRef,
          input.agreementVersion, actor.nihoUserId, at, input.commandId],
      );
      await client.query(
        "INSERT INTO experience_product_sales_plan_states (provider_id,product_id,current_revision) VALUES ($1,$2,1)", [actor.providerId, productId],
      );
      const updated = await client.query<DbRow>(
        `UPDATE experience_products SET seller_niho_account_ref=$3,stripe_connect_account_ref=$4,seller_display_name=$5,
            version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND id=$2 RETURNING version`,
        [actor.providerId, productId, sellerRef, accountRef, disclosureName],
      );
      return {
        state: (await readSalesPlanState(client, actor.providerId, productId))!,
        sellerRef, productVersion: Number(updated.rows[0]!.version), replayed: false,
      };
    });
  }
}
