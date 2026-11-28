import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { nativeDisclosureName } from "./agent-consent.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { lockProviderInventory } from "./inventory.ts";
import { recordPayoutConsentIn, validPayoutConsentInstant, validPayoutConsentVersion, type PayoutAccountConsentRecord } from "./payout-account-consents.ts";
import type { DbRow } from "./rows.ts";
import { attachSellerToSellerlessProducts } from "./seller-attachment.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
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
}
