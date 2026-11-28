import type { Pool, PoolClient } from "pg";
import type { GuestCancellationPolicy, GuestChangeSnapshot } from "./types.ts";

/*
 * 予約の日時変更 (#720, docs/guest-booking.md「予約の日時変更（#720）」): what a booking fixes about its guest's changes when it is
 * made. Kept apart from booking-changes.ts so checkout (guest-bookings.ts) reads it without importing the change path.
 */

/** How many times the guest may move one booking (owner decision on #720). */
export const GUEST_CHANGE_MAX_CHANGES = 2;

/** Only bookings with free cancellation until 24 or 48 hours before the start may be moved by their guest. */
const CHANGEABLE_POLICIES: ReadonlySet<GuestCancellationPolicy> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H"]);

/**
 * The `guestChange` a new booking's pricing snapshot fixes, or undefined when the guest may not move it: the offer's
 * cancellation policy is free until 24 or 48 hours before (with a free-cancellation window) and the product's switch
 * (`product_guest_change_settings`, no row is ON) is on. Read in the checkout transaction.
 */
export async function guestChangeSnapshotFor(
  client: Pool | PoolClient,
  input: {
    readonly providerId: string;
    readonly productId: string;
    readonly cancellationPolicy: GuestCancellationPolicy;
    readonly cancellationWindowMinutesBeforeStart: number | null;
  },
): Promise<GuestChangeSnapshot | undefined> {
  if (!CHANGEABLE_POLICIES.has(input.cancellationPolicy) || input.cancellationWindowMinutesBeforeStart === null) return undefined;
  const found = await client.query<{ allowed: boolean }>(
    "SELECT allowed FROM product_guest_change_settings WHERE provider_id=$1 AND product_id=$2",
    [input.providerId, input.productId],
  );
  if (found.rows[0]?.allowed === false) return undefined;
  return { allowed: true, maxChanges: GUEST_CHANGE_MAX_CHANGES };
}
