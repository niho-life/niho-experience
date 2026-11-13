import "server-only";
import { cache } from "react";
import { listSitePublicExperiences } from "./experience/site-publications";
import { guestBookingRepository, productClassificationRepository } from "./experience/store-server";
import { jaCardOf, type JaCard } from "./ja-catalog";

/** The Japanese list's cards: published, saleable products with Japanese text, each with its classification (read apart from the publication). */
export const loadJaCards = cache(async (): Promise<readonly JaCard[]> => {
  const [catalog, classifications] = await Promise.all([
    listSitePublicExperiences("ja"),
    // A failed read of the classification leaves the list without categories, never without experiences.
    productClassificationRepository()?.listPublic().catch(() => new Map()) ?? new Map(),
  ]);
  return catalog.experiences.flatMap((item) => {
    const card = jaCardOf(item, classifications.get(item.publication.slug));
    return card ? [card] : [];
  });
});

/**
 * The cards that can be booked on `date` (YYYY-MM-DD, Japan) for `guests` (or one person): read from the booking store's own
 * availability, as the booking page does, never from the weekday alone. A card whose availability cannot be read is left out.
 */
export async function cardsBookableOn(cards: readonly JaCard[], date: string, guests: number | null): Promise<JaCard[]> {
  const bookings = guestBookingRepository();
  if (!bookings) return [];
  const results = await Promise.all(cards.map(async (card) => {
    try {
      const availability = await bookings.listPublicAvailability(card.slug, {});
      return availability?.occurrences.some((occurrence) => occurrence.date === date && occurrence.bookable && occurrence.seatsLeft >= (guests ?? 1)) === true;
    } catch { return false; }
  }));
  return cards.filter((_, index) => results[index]);
}
