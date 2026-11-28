import type { Pool } from "pg";
import { StoreConflictError, StoreValidationError } from "./errors.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * Retiring a provider's payout account (#710, docs/host-operations.md「オーナーが代わったときの受取口座」): the office's act, run with
 * the migration identity by scripts/experience/retire-connect-account.mjs, never by the runtime (which has no UPDATE on retired_at).
 * The row stays (a trigger refuses DELETE); the provider's next OWNER then registers a new account, since the unique index
 * covers only rows that are not retired. The Stripe account itself is not touched here: the office closes or keeps it in Stripe.
 */

export interface RetiredConnectAccount {
  readonly id: string;
  readonly stripeAccountRef: string | null;
}

/**
 * Retires the provider's valid row of `purpose` (the Express payout account by default); null when there is none. A host's own
 * Stripe account (DIRECT, 3c) that its seller profile is bound to is never retired here (StoreConflictError): the office changes
 * the seller by its seller-change procedure first.
 */
export async function retireConnectAccount(
  pool: Pool,
  input: { readonly providerId: string; readonly retiredBy: string; readonly purpose?: "PAYOUT" | "DIRECT" },
): Promise<RetiredConnectAccount | null> {
  const purpose = input.purpose ?? "PAYOUT";
  if (purpose !== "PAYOUT" && purpose !== "DIRECT") throw new StoreValidationError("purpose must be PAYOUT or DIRECT.");
  assertStoreIdentifier(input.providerId, "providerId");
  if (typeof input.retiredBy !== "string" || input.retiredBy.length < 1 || input.retiredBy.length > 256) {
    throw new StoreValidationError("retiredBy must be 1-256 characters.");
  }
  let updated;
  try {
    updated = await pool.query<{ id: string; stripe_account_ref: string | null }>(
      // A row a seller profile is bound to stays (the profile's foreign key does not stop an UPDATE, so it is said here).
      `UPDATE experience_connect_accounts SET retired_at=clock_timestamp(),retired_by=$2
        WHERE provider_id=$1 AND purpose=$3 AND retired_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM experience_host_seller_profiles profile WHERE profile.connect_account_id=experience_connect_accounts.id)
        RETURNING id,stripe_account_ref`,
      [input.providerId, input.retiredBy, purpose],
    );
  } catch (error) {
    // The database refuses it too (0099), for a registration that committed between the check above and this update.
    if ((error as { code?: string }).code === "23514" && purpose === "DIRECT") throw new StoreConflictError("The account is the provider's seller; change the seller first.");
    throw error;
  }
  const row = updated.rows[0];
  if (!row && purpose === "DIRECT") {
    const bound = await pool.query(
      `SELECT 1 FROM experience_connect_accounts account JOIN experience_host_seller_profiles profile ON profile.connect_account_id=account.id
        WHERE account.provider_id=$1 AND account.purpose='DIRECT' AND account.retired_at IS NULL`,
      [input.providerId],
    );
    if ((bound.rowCount ?? 0) > 0) throw new StoreConflictError("The account is the provider's seller; change the seller first.");
  }
  return row ? { id: row.id, stripeAccountRef: row.stripe_account_ref } : null;
}
