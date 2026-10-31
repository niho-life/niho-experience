import "server-only";
import type { Occurrence, SelectedExperienceDetailResponse } from "@niho-experience/api-client";
import type { PublicBookingTerms } from "@niho-experience/experience-store";
import { nihoBookingSources, type BookingSource, type BookingSources } from "@/lib/booking-source";
import { config } from "@/lib/config";
import { detailNextDates } from "@/lib/detail-page";
import { guestBookingRepository } from "@/lib/experience/store-server";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { siteSaleTerms, withSiteSaleTerms, type SiteSaleTerms } from "@/lib/guest-booking-terms";
import { japaneseBookingAllowed } from "@/lib/localized-release";

/*
 * Which experiences this site sells (#285, docs/guest-booking.md). Products switch one by one: with
 * EXPERIENCE_GUEST_BOOKING_ENABLED, a product the experience DB sells (publicBookingTerms) books through this
 * site's routes; every other product keeps NIHO's path unchanged, and the flag off or the preview changes nothing.
 * A switched product no longer sells on NIHO, so when the DB cannot answer the product is "unknown": that request
 * shows it as not bookable and never falls back to NIHO's availability or checkout.
 */

export type GuestBookingSale =
  | { readonly kind: "niho" }
  | { readonly kind: "site"; readonly terms: PublicBookingTerms }
  | { readonly kind: "unknown" };

const NIHO: GuestBookingSale = { kind: "niho" };
const UNKNOWN: GuestBookingSale = { kind: "unknown" };

/** The class name only, as the checkout route: the database's messages may repeat what was sent. */
function logFailure(stage: string, error: unknown): void {
  console.error("Experience guest booking source failed", { stage, error: error instanceof Error ? error.name : typeof error });
}

function siteOrigin(): string {
  return new URL(config.siteUrl).origin;
}

/** Where one experience is sold. Never throws: a failure is "unknown". */
export async function guestBookingSale(slug: string): Promise<GuestBookingSale> {
  if (!config.guestBookingEnabled) return NIHO;
  const bookings = guestBookingRepository();
  if (!bookings) return UNKNOWN;
  try {
    const terms = await bookings.publicBookingTerms(slug);
    return terms === null ? NIHO : { kind: "site", terms };
  } catch (error) {
    logFailure("terms", error);
    return UNKNOWN;
  }
}

/** Where a page of cards reads each card's availability, in one query. A failure closes every card on the page. */
export async function guestBookingSources(slugs: readonly string[]): Promise<BookingSources> {
  const niho = nihoBookingSources(config.nihoWebOrigin);
  if (!config.guestBookingEnabled || slugs.length === 0) return niho;
  const closed: BookingSources = { ...niho, closedSlugs: [...new Set(slugs)] };
  const bookings = guestBookingRepository();
  if (!bookings) return closed;
  try {
    const siteSlugs = await bookings.sellableSlugs(slugs);
    return siteSlugs.length ? { ...niho, siteOrigin: siteOrigin(), siteSlugs } : niho;
  } catch (error) {
    logFailure("slugs", error);
    return closed;
  }
}

/** The browser's source for one experience (detail and booking pages). */
export function bookingSourceOf(sale: GuestBookingSale): BookingSource {
  if (sale.kind === "site") return { kind: "site", origin: siteOrigin() };
  return sale.kind === "unknown" ? { kind: "closed" } : { kind: "niho", origin: config.nihoWebOrigin };
}

/** The sale terms of a product sold here, with the consent version the checkout route compares. */
export function saleTermsOf(terms: PublicBookingTerms): SiteSaleTerms {
  return siteSaleTerms(terms, config.guestBookingConsentVersion);
}

/**
 * The English detail as the page shows it: NIHO's content, and for a product sold here this site's sale
 * (guest-booking-terms.ts). An unknown product takes no bookings (its booking entrance is not shown).
 */
export function detailForSale<T extends ExperienceDetailForSite>(detail: T, sale: GuestBookingSale): T {
  if (sale.kind === "site") return withSiteSaleTerms(detail, saleTermsOf(sale.terms));
  if (sale.kind === "unknown") return { ...detail, booking: { ...detail.booking, checkoutAvailable: false } };
  return detail;
}

/** The next dates of a product sold here, read from the experience DB as the page reads NIHO's: a failure shows none. */
export async function siteNextDates(slug: string): Promise<Occurrence[]> {
  const bookings = guestBookingRepository();
  if (!bookings) return [];
  try {
    const availability = await bookings.listPublicAvailability(slug);
    return availability ? detailNextDates([...availability.occurrences]) : [];
  } catch (error) {
    logFailure("availability", error);
    return [];
  }
}

/**
 * Japanese booking is NIHO's (`v1.2/ja` checkout) and stays closed for a product sold here, or one that may be,
 * until this site takes Japanese bookings (#285 slice 10): the page shows `booking.unavailableJa`.
 */
export function japaneseBookingOpen(sale: GuestBookingSale, detail: Pick<SelectedExperienceDetailResponse, "localization">): boolean {
  return sale.kind === "niho" && japaneseBookingAllowed(detail);
}
