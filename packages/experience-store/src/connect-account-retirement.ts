import type { Pool } from "pg";
import { StoreValidationError } from "./errors.ts";
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

/** Retires the provider's valid payout row; null when there is none. */
export async function retireConnectAccount(
  pool: Pool,
  input: { readonly providerId: string; readonly retiredBy: string },
): Promise<RetiredConnectAccount | null> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (typeof input.retiredBy !== "string" || input.retiredBy.length < 1 || input.retiredBy.length > 256) {
    throw new StoreValidationError("retiredBy must be 1-256 characters.");
  }
  const updated = await pool.query<{ id: string; stripe_account_ref: string | null }>(
    `UPDATE experience_connect_accounts SET retired_at=clock_timestamp(),retired_by=$2
      WHERE provider_id=$1 AND purpose='PAYOUT' AND retired_at IS NULL
      RETURNING id,stripe_account_ref`,
    [input.providerId, input.retiredBy],
  );
  const row = updated.rows[0];
  return row ? { id: row.id, stripeAccountRef: row.stripe_account_ref } : null;
}
