import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { HOST_SELLER_REF_SQL } from "./host-sellers.ts";
import { lockProviderInventory } from "./inventory.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 受取口座の利用同意 (ADR 0003 slice 3, migration 0065): the OWNER's versioned consent that the provider's registered
 * payout account (the Stripe connected account Admin/ops registered on its seller profile, never one from a browser)
 * receives the proceeds of the provider's Experience sales. It replaces NIHO's payment-reuse consent for sellers
 * registered for Experience host accounts; the NIHO login's sellers never reach this module.
 *
 * - Only an active OWNER membership held by an ACTIVE host account (`hst_`) records, reads or withdraws it, and only for
 *   a provider whose seller is registered for host accounts. A NIHO user, an EDITOR, a suspended account: access denied.
 * - A consent counts while it is not withdrawn, names the profile's current account, and the host account that gave it
 *   is still an active OWNER. After an OWNER change (the old OWNER's membership ended) or an account change by Admin/ops,
 *   the current OWNER consents again. Whether its version is the one asked for now is the caller's comparison.
 * - Rows are never deleted. A new consent (another version, account or OWNER) revokes the active one in the same
 *   transaction; at most one is active per provider (a partial unique index, and a per-provider lock).
 * - Withdrawing stops the provider's listings (as 「公開を止める」 on each) and clears the payment consent of its
 *   short-lived readiness snapshot, so neither the OWNER nor an Admin proxy publishes on the withdrawn consent.
 */

export interface PayoutAccountConsent {
  readonly stripeConnectAccountRef: string;
  readonly consentVersion: string;
  readonly consentedAtUtc: string;
  /** The host account (`hst_`) that consented. */
  readonly consentedByHostAccountId: string;
}

export interface PayoutAccountConsentRecord {
  /** UNCHANGED: the same OWNER already consented to this account at this version. */
  readonly outcome: "RECORDED" | "UNCHANGED";
  readonly consent: PayoutAccountConsent;
}

export interface PayoutAccountConsentWithdrawal {
  /** NONE: there was no active consent (nothing is stopped then). */
  readonly outcome: "REVOKED" | "NONE";
  /** Listings stopped by the withdrawal. */
  readonly stoppedPublications: number;
}

const CONNECT_ACCOUNT = /^acct_[A-Za-z0-9]{8,250}$/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const CONSENT_LOCK_SEED = 73;
const CONSENT_COLUMNS = "stripe_connect_account_ref,consent_version,consented_at,consented_by_niho_user_id";

function consentFromRow(row: DbRow): PayoutAccountConsent {
  return {
    stripeConnectAccountRef: String(row.stripe_connect_account_ref),
    consentVersion: String(row.consent_version),
    consentedAtUtc: isoValue(row, "consented_at"),
    consentedByHostAccountId: String(row.consented_by_niho_user_id),
  };
}

function validActor(actor: HostActor): void {
  if (typeof actor?.providerId !== "string") throw new StoreValidationError("actor.providerId must be a stable 1-256 character identifier.");
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  // A NIHO user is never this consent's actor.
  if (!isHostAccountId(actor.nihoUserId)) throw new StoreAccessDeniedError();
}

function now(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function consentVersion(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || value.trim() !== value || CONTROL.test(value)) {
    throw new StoreValidationError("consentVersion must be one line of 1-160 characters without surrounding spaces.");
  }
  return value;
}

/** Takes turns with the provider's other consent changes. */
async function lockConsents(client: PoolClient, providerId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${CONSENT_LOCK_SEED}))`, [`provider-payout-consent:${providerId}`]);
}

/** The actor is an active OWNER of the provider and an ACTIVE host account; StoreAccessDeniedError otherwise. */
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

/** The payout account of the provider's seller registered for host accounts; null without one. */
async function hostAccountSellerAccount(client: PoolClient, providerId: string): Promise<string | null> {
  const profile = await client.query<DbRow>(
    `SELECT stripe_connect_account_ref FROM experience_host_seller_profiles
      WHERE provider_id=$1 AND legacy_provider_id IS NULL AND seller_niho_account_ref ~ '${HOST_SELLER_REF_SQL}'
      FOR SHARE`,
    [providerId],
  );
  const row = profile.rows[0];
  return row ? String(row.stripe_connect_account_ref) : null;
}

/**
 * The consent that counts now for `account` (the provider's registered payout account), read in the caller's
 * transaction: active, for that account, given by a host account that is still an active ACTIVE OWNER. null otherwise.
 */
async function countingConsent(client: PoolClient, providerId: string, account: string): Promise<DbRow | null> {
  const found = await client.query<DbRow>(
    `SELECT ${CONSENT_COLUMNS} FROM provider_payout_account_consents consent
      WHERE consent.provider_id=$1 AND consent.revoked_at IS NULL AND consent.stripe_connect_account_ref=$2
        AND EXISTS (
          SELECT 1 FROM provider_memberships owner
            JOIN host_accounts owner_account ON owner_account.id=owner.niho_user_id AND owner_account.status='ACTIVE'
           WHERE owner.provider_id=consent.provider_id AND owner.niho_user_id=consent.consented_by_niho_user_id
             AND owner.active=true AND owner.role='OWNER'
        )`,
    [providerId, account],
  );
  return found.rows[0] ?? null;
}

/**
 * For the readiness snapshot's write (ExperiencePublicationRepository.refreshReadiness), inside its transaction, which
 * holds the provider's inventory lock that `revoke` takes first: whether the consent a snapshot claims still counts, for
 * this account and version. A consent read before a withdrawal can then never be written back after it.
 */
export async function payoutConsentStillCounts(
  client: PoolClient,
  input: { readonly providerId: string; readonly stripeConnectAccountRef: string; readonly consentVersion: string; readonly consentedAtUtc: string },
): Promise<boolean> {
  const row = await countingConsent(client, input.providerId, input.stripeConnectAccountRef);
  if (!row) return false;
  const consent = consentFromRow(row);
  return consent.consentVersion === input.consentVersion && consent.consentedAtUtc === input.consentedAtUtc;
}

export class ProviderPayoutAccountConsents {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The consent that counts now: active, for the profile's current account, given by a host account that is still an
   * active OWNER. null otherwise (none, withdrawn, another account, the consenting OWNER gone, or no host-account seller).
   */
  async current(actor: HostActor): Promise<PayoutAccountConsent | null> {
    validActor(actor);
    return withTransaction(this.#pool, async (client) => {
      await requireHostAccountOwner(client, actor);
      const account = await hostAccountSellerAccount(client, actor.providerId);
      if (account === null) return null;
      const row = await countingConsent(client, actor.providerId, account);
      return row ? consentFromRow(row) : null;
    });
  }

  /**
   * Records the actor's consent to receive the provider's Experience sales in `stripeConnectAccountRef`, which must be
   * the account registered on the provider's seller profile now (StoreConflictError otherwise, as for a provider without
   * a seller registered for host accounts). The same OWNER, account and version again is UNCHANGED; anything else
   * replaces the active consent.
   */
  async record(actor: HostActor, input: { readonly stripeConnectAccountRef: string; readonly consentVersion: string; readonly nowUtc: string }): Promise<PayoutAccountConsentRecord> {
    validActor(actor);
    if (typeof input?.stripeConnectAccountRef !== "string" || !CONNECT_ACCOUNT.test(input.stripeConnectAccountRef)) {
      throw new StoreValidationError("stripeConnectAccountRef must be a Stripe connected account ID.");
    }
    const version = consentVersion(input.consentVersion);
    const at = now(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await lockConsents(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const account = await hostAccountSellerAccount(client, actor.providerId);
      if (account === null) throw new StoreConflictError("The provider has no seller registered for Experience host accounts.");
      if (account !== input.stripeConnectAccountRef) throw new StoreConflictError("The provider's payout account changed; read it again.");
      const active = await client.query<DbRow>(
        `SELECT id,${CONSENT_COLUMNS} FROM provider_payout_account_consents
          WHERE provider_id=$1 AND revoked_at IS NULL FOR UPDATE`,
        [actor.providerId],
      );
      const row = active.rows[0];
      if (row && row.stripe_connect_account_ref === account && row.consent_version === version && row.consented_by_niho_user_id === actor.nihoUserId) {
        return { outcome: "UNCHANGED", consent: consentFromRow(row) };
      }
      if (row) {
        await client.query(
          `UPDATE provider_payout_account_consents
              SET revoked_at=GREATEST($2::timestamptz,consented_at),revoked_by_niho_user_id=$3
            WHERE id=$1 AND revoked_at IS NULL`,
          [row.id, at, actor.nihoUserId],
        );
      }
      const inserted = await client.query<DbRow>(
        `INSERT INTO provider_payout_account_consents
           (id,provider_id,stripe_connect_account_ref,consent_version,consented_by_niho_user_id,consented_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz)
         RETURNING ${CONSENT_COLUMNS}`,
        [randomUUID(), actor.providerId, account, version, actor.nihoUserId, at],
      );
      return { outcome: "RECORDED", consent: consentFromRow(inserted.rows[0]!) };
    });
  }

  /**
   * Withdraws the provider's active consent (whoever gave it). In the same transaction the provider's listings stop, as
   * 「公開を止める」 does on each (resuming needs a consent again), and its readiness snapshot loses the payment consent.
   * NONE (nothing stopped) when there was no active consent.
   */
  async revoke(actor: HostActor, input: { readonly nowUtc: string }): Promise<PayoutAccountConsentWithdrawal> {
    validActor(actor);
    const at = now(input?.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await lockConsents(client, actor.providerId);
      await requireHostAccountOwner(client, actor);
      const revoked = await client.query(
        `UPDATE provider_payout_account_consents
            SET revoked_at=GREATEST($2::timestamptz,consented_at),revoked_by_niho_user_id=$3
          WHERE provider_id=$1 AND revoked_at IS NULL`,
        [actor.providerId, at, actor.nihoUserId],
      );
      if ((revoked.rowCount ?? 0) === 0) return { outcome: "NONE", stoppedPublications: 0 };
      const stopped = await client.query(
        `UPDATE experience_product_publication_states
            SET self_stopped_at=COALESCE(self_stopped_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND current_publication_id IS NOT NULL AND self_stopped_at IS NULL`,
        [actor.providerId],
      );
      await client.query(
        `UPDATE provider_publication_readiness
            SET payment_reuse_consent_accepted=false,payment_reuse_consent_version=NULL,payment_reuse_consented_at=NULL,
                version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND payment_reuse_consent_accepted`,
        [actor.providerId],
      );
      return { outcome: "REVOKED", stoppedPublications: stopped.rowCount ?? 0 };
    });
  }
}
