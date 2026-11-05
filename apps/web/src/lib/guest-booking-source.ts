import "server-only";
import type { Occurrence, SelectedExperienceDetailResponse } from "@niho-experience/api-client";
import type { PublicBookingTerms } from "@niho-experience/experience-store";
import { nihoBookingSources, type BookingSource, type BookingSources } from "@/lib/booking-source";
import { config } from "@/lib/config";
import { detailNextDates } from "@/lib/detail-page";
import { experiencePublicationRepository, guestBookingRepository } from "@/lib/experience/store-server";
import { projectSitePublicSaleTerms } from "@/lib/experience/site-publications";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { siteSaleTerms, withSiteSaleTerms, type SiteSaleTerms } from "@/lib/guest-booking-terms";
import { japaneseBookingAllowed } from "@/lib/localized-release";

/*
 * HTTP pages sell only currently active Experience publications. An unpublished slug, missing sale terms,
 * unsupported participation conditions, or a store failure closes booking without a NIHO fallback.
 * Mock preview keeps its synthetic route selection.
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
  if (config.apiMode === "http") {
    if (!config.guestBookingEnabled || !config.experiencePublicationsEnabled) return UNKNOWN;
    const publications = experiencePublicationRepository();
    const bookings = guestBookingRepository();
    if (!publications || !bookings) return UNKNOWN;
    try {
      const publication = await publications.getPublicBySlug(slug);
      if (!publication) return UNKNOWN;
      const terms = await bookings.publicBookingTerms(slug);
      if (!terms || projectSitePublicSaleTerms(terms) === null) return UNKNOWN;
      siteSaleTerms(terms, config.guestBookingConsentVersion);
      return { kind: "site", terms };
    } catch (error) {
      logFailure("publication-terms", error);
      return UNKNOWN;
    }
  }
  if (!config.guestBookingEnabled) return NIHO;
  const bookings = guestBookingRepository();
  if (!bookings) return UNKNOWN;
  try {
    const terms = await bookings.publicBookingTerms(slug);
    if (terms === null) return NIHO;
    // Keep this legacy page closed until its client contract can display and
    // price every term that the Experience publication accepts.
    siteSaleTerms(terms, config.guestBookingConsentVersion);
    return { kind: "site", terms };
  } catch (error) {
    logFailure("terms", error);
    return UNKNOWN;
  }
}

/** Where a page of cards reads each card's availability, in one query. A failure closes every card on the page. */
export async function guestBookingSources(slugs: readonly string[]): Promise<BookingSources> {
  const niho = nihoBookingSources(config.nihoWebOrigin);
  if (config.apiMode === "http") {
    const unique = [...new Set(slugs)];
    if (!unique.length) return niho;
    const closed: BookingSources = { ...niho, closedSlugs: unique };
    if (!config.experiencePublicationsEnabled) return closed;
    if (!config.guestBookingEnabled) return closed;
    const publications = experiencePublicationRepository();
    const bookings = guestBookingRepository();
    if (!publications || !bookings) return closed;
    try {
      const [published, sellable] = await Promise.all([publications.listPublic(), bookings.sellableSlugs(unique)]);
      const publicSlugs = new Set(published.map((item) => item.slug));
      const candidates = sellable.filter((slug) => publicSlugs.has(slug));
      const siteSlugs = (await Promise.all(candidates.map(async (slug) => ({ slug, terms: await bookings.publicBookingTerms(slug) }))))
        .filter(({ terms }) => projectSitePublicSaleTerms(terms) !== null).map(({ slug }) => slug);
      return {
        nihoWebOrigin: niho.nihoWebOrigin,
        siteOrigin: siteSlugs.length ? siteOrigin() : null,
        siteSlugs,
        closedSlugs: unique.filter((slug) => !siteSlugs.includes(slug)),
      };
    } catch (error) {
      logFailure("publication-slugs", error);
      return closed;
    }
  }
  if (!config.guestBookingEnabled || slugs.length === 0) return niho;
  const closed: BookingSources = { ...niho, closedSlugs: [...new Set(slugs)] };
  const bookings = guestBookingRepository();
  if (!bookings) return closed;
  try {
    const siteSlugs = await bookings.sellableSlugs(slugs);
    return {
      ...niho,
      siteOrigin: siteSlugs.length ? siteOrigin() : null,
      siteSlugs,
      closedSlugs: [],
    };
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
 * Overlay sale terms on the preview detail. HTTP publication pages use their own manuscript.
 */
export function detailForSale<T extends ExperienceDetailForSite>(detail: T, sale: GuestBookingSale): T {
  if (sale.kind === "site") return withSiteSaleTerms(detail, saleTermsOf(sale.terms));
  if (sale.kind === "unknown") return { ...detail, booking: { ...detail.booking, checkoutAvailable: false } };
  return detail;
}

/** Japanese pages keep their selected-release booking terms, while the seller name follows the active sale contract. */
export function detailWithSiteSellerDisplayName<T extends ExperienceDetailForSite>(detail: T, sale: GuestBookingSale): T {
  if (sale.kind !== "site") return detail;
  return { ...detail, seller: { ...detail.seller, displayName: sale.terms.sellerDisplayName } };
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
