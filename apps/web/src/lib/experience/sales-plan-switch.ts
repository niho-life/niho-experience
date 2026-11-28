import type { ExperienceStore, GuestBookingRepository, HostActor, ManagedExperienceSalesRepository, SalesPlanState, SalesPlanTransition } from "@niho-experience/experience-store";
import { expireDirectCheckout, expirePlatformCheckout } from "@niho-experience/experience-payments";

/*
 * 販売プランの切り替えの後半 (sales-plan の route と 独立 10% の route が共有する): `beginOwnerSwitch` が返した、開いている Checkout を 1 つずつ
 * 失効させ（予約の snapshot が PLATFORM なら NIHO の Checkout、そうでなければ Direct の Checkout）、結果を記録し、全部そろったら `finalizeSwitch` で確定する。
 * 受けた予約は、その時の snapshot のまま残る（ここでは触らない）。
 */

type SwitchRepository = Pick<ManagedExperienceSalesRepository, "recordCheckoutOutcome" | "finalizeSwitch">;
type SwitchBookings = Pick<ExperienceStore, "getBooking">;
type SwitchReleases = Pick<GuestBookingRepository, "expireGuestHoldForSalesPlanSwitch">;

export async function completeSalesPlanSwitch(
  deps: { readonly repository: SwitchRepository; readonly bookings: SwitchBookings; readonly releases: SwitchReleases },
  actor: HostActor,
  productId: string,
  commandId: string,
  begun: SalesPlanTransition,
): Promise<{ readonly state: SalesPlanState; readonly switched: boolean }> {
  let transition = begun;
  for (const checkout of transition.openCheckouts) {
    const booking = await deps.bookings.getBooking(actor, checkout.publicBookingId);
    const expireCheckout = booking.sellerSnapshot.chargeMode === "PLATFORM" ? expirePlatformCheckout : expireDirectCheckout;
    const outcome = await expireCheckout({
      booking, checkoutSessionId: checkout.checkoutSessionRef,
      platformStripeKey: process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY,
    });
    if (outcome === "expired") await deps.releases.expireGuestHoldForSalesPlanSwitch(actor, checkout.publicBookingId, checkout.checkoutSessionRef);
    transition = {
      state: await deps.repository.recordCheckoutOutcome(actor, productId, commandId, checkout.checkoutSessionRef,
        outcome === "paid" ? "PAID" : outcome === "expired" ? "EXPIRED" : "UNKNOWN"),
      openCheckouts: [],
    };
  }
  if (transition.state.phase !== "ACTIVE") {
    return { state: await deps.repository.finalizeSwitch(actor, productId, commandId, transition.state.version), switched: true };
  }
  return { state: transition.state, switched: false };
}
