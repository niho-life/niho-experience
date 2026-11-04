import type { SitePublicOffer } from "./site-publications";

/** Mirrors GuestBookingRepository.guestTotalYen for traveler display; the transaction recalculates it. */
export function expectedSiteBookingTotalYen(offer: SitePublicOffer, adults: number, children: number): number | null {
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 0 || children < 0) return null;
  const partySize = adults + children;
  if (partySize < offer.minimumParticipants || partySize > offer.maxPartySize) return null;
  if (children > 0 && offer.pricing.child === null) return null;
  if (offer.pricing.child?.adultRequired && children > 0 && adults === 0) return null;
  const ordinaryTotal = adults * offer.pricing.adultPriceYen + children * (offer.pricing.child?.priceYen ?? 0);
  const minimumTotal = offer.minimumChargeableParticipants * offer.pricing.adultPriceYen;
  const total = Math.max(ordinaryTotal, minimumTotal);
  return Number.isSafeInteger(total) ? total : null;
}
