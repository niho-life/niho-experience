import type { PoolClient } from "pg";
import { StoreConflictError } from "./errors.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";

/**
 * The direct writers of `experience_products.status` (the legacy `updateProduct`, the operator's `registerProduct`) must
 * not break "status PUBLISHED <=> bookings are open" for a product that has a publication state (#705): that status is
 * moved only by openBooking / publish / stopBooking. The database re-checks it at commit (a deferred constraint trigger);
 * this gives the caller a conflict instead of a failed commit.
 */
export async function assertStatusFollowsBooking(client: PoolClient, providerId: string, productId: string, status: string): Promise<void> {
  const state = await client.query<{ open: boolean; published: boolean }>(
    `SELECT booking_publication_id IS NOT NULL AS open, current_publication_id IS NOT NULL AS published
       FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2`,
    [providerId, productId],
  );
  const row = state.rows[0];
  if (row && row.published && status !== "ARCHIVED" && (status === "PUBLISHED") !== row.open) {
    throw new StoreConflictError("The product status follows its booking state: start or stop bookings instead of writing the status.");
  }
}

/** Appends to the booking event log (#705). The state row, moved by CAS on its version, is the truth. */
export async function recordBookingEvent(
  client: PoolClient,
  state: { readonly providerId: string; readonly productId: string; readonly version: number },
  publicationId: number,
  kind: "OPENED" | "STOPPED",
  reason: string,
  actorNihoUserId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO experience_product_booking_events
       (provider_id,product_id,publication_id,kind,reason,actor_niho_user_id,state_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [state.providerId, state.productId, publicationId, kind, reason, actorNihoUserId, state.version],
  );
}


/**
 * A product that stopped selling (stop of bookings, self-stop, operations suspension, payout consent withdrawal) must have
 * its external channel slots closed (#705). Channel reconciliation reads the product's sale state (`ChannelRepository`):
 * for a listing of a product that is not taking bookings it desires CLOSED for every slot it had desired OPEN, and the
 * close-only jobs run while an OPEN never does. This asks the outbox consumer to reconcile the provider now, in the
 * transaction that changed the state (a no-op when the provider has no active channel listing).
 */
export async function requestChannelReconciliation(client: PoolClient, providerId: string, cause: string): Promise<void> {
  const listings = await client.query("SELECT 1 FROM channel_listings WHERE provider_id=$1 AND active=true LIMIT 1", [providerId]);
  if (listings.rows[0] === undefined) return;
  await enqueueCalendarRecalculation(client, { providerId, aggregateType: "provider_inventory", aggregateId: providerId, cause });
}
