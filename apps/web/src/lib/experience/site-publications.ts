import "server-only";
import type { PublicExperiencePublication, PublicSellerDisclosure } from "@niho-experience/experience-store";
import type { PublicBookingTerms } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { experiencePublicationRepository, guestBookingRepository, providerSellerDisclosureRepository } from "@/lib/experience/store-server";

/** Public checkout terms without the internal Experience provider/product keys. */
export type SitePublicSaleTerms = Omit<PublicBookingTerms, "providerId" | "productId">;
export type SitePublicOffer = SitePublicSaleTerms["offers"][number];
export type SitePublicExperience = {
  readonly publication: PublicExperiencePublication;
  readonly saleTerms: SitePublicSaleTerms | null;
  readonly sellerDisclosure: PublicSellerDisclosure | null;
};
export type SitePublicExperienceLookup =
  | { readonly kind: "published"; readonly item: SitePublicExperience }
  | { readonly kind: "reserved" }
  | null;
export type SitePublicCatalog = {
  readonly experiences: readonly SitePublicExperience[];
  /** Kept server-side to prevent a stopped/draft Experience slug from revealing a same-slug NIHO item. */
  readonly claimedSlugs: readonly string[];
};

export function projectSitePublicSaleTerms(terms: PublicBookingTerms | null): SitePublicSaleTerms | null {
  // The current publication checkout has no participation-conditions manuscript to show.
  // A versioned condition cannot be agreed to until its text is part of this read model.
  if (!terms || terms.conditionsVersion !== null) return null;
  return {
    title: terms.title,
    currency: terms.currency,
    sellerDisplayName: terms.sellerDisplayName,
    offers: terms.offers,
    conditionsVersion: terms.conditionsVersion,
  };
}
/** Read the Experience-owned published manuscript and, when enabled, its current sale terms. */
export async function getSitePublicExperience(slug: string): Promise<SitePublicExperienceLookup> {
  if (config.apiMode !== "http") return null;
  if (!config.experiencePublicationsEnabled) return { kind: "reserved" };
  const publications = experiencePublicationRepository();
  if (!publications) throw new Error("Experience public publication store is unavailable.");
  const publication = await publications.getPublicBySlug(slug);
  if (!publication) return { kind: "reserved" };
  const bookings = guestBookingRepository();
  const terms = bookings ? await bookings.publicBookingTerms(slug) : null;
  const disclosures = providerSellerDisclosureRepository();
  const disclosure = disclosures ? await disclosures.getPublicBySlug(slug) : null;
  const saleTerms = projectSitePublicSaleTerms(terms);
  return { kind: "published", item: {
    publication,
    saleTerms,
    sellerDisclosure: disclosure && (!saleTerms || saleTerms.sellerDisplayName === disclosure.sellerDisplayName) ? disclosure : null,
  } };
}

/** List public Experience products with a valid sale; products without sale terms stay out of the booking catalog. */
export async function listSitePublicExperiences(): Promise<SitePublicCatalog> {
  if (config.apiMode !== "http") return { experiences: [], claimedSlugs: [] };
  if (!config.experiencePublicationsEnabled) return { experiences: [], claimedSlugs: [] };
  const publications = experiencePublicationRepository();
  if (!publications) throw new Error("Experience public publication store is unavailable.");
  const claimedSlugs = await publications.listClaimedSlugs();
  const items = await publications.listPublic();
  const disclosures = providerSellerDisclosureRepository();
  if (!config.guestBookingEnabled) return {
    experiences: await Promise.all(items.map(async (publication) => ({ publication, saleTerms: null, sellerDisclosure: disclosures ? await disclosures.getPublicBySlug(publication.slug) : null }))),
    claimedSlugs,
  };
  const bookings = guestBookingRepository();
  if (!bookings) throw new Error("Experience public sales store is unavailable.");
  const sales = await Promise.all(items.map(async (publication) => {
    const [terms, disclosure] = await Promise.all([
      bookings.publicBookingTerms(publication.slug),
      disclosures ? disclosures.getPublicBySlug(publication.slug) : null,
    ]);
    const saleTerms = projectSitePublicSaleTerms(terms);
    return { publication, saleTerms, sellerDisclosure: disclosure && (!saleTerms || saleTerms.sellerDisplayName === disclosure.sellerDisplayName) ? disclosure : null };
  }));
  return { experiences: sales, claimedSlugs };
}

/** Every HTTP sale endpoint requires a currently active Experience publication. */
export async function publicExperienceRouteAllowedForSlug(slug: string): Promise<boolean> {
  if (config.apiMode !== "http") return true;
  if (!config.experiencePublicationsEnabled) return false;
  const publications = experiencePublicationRepository();
  if (!publications) throw new Error("Experience public publication store is unavailable.");
  if (!await publications.getPublicBySlug(slug)) return false;
  const bookings = guestBookingRepository();
  if (!bookings) throw new Error("Experience public sales store is unavailable.");
  return projectSitePublicSaleTerms(await bookings.publicBookingTerms(slug)) !== null;
}
