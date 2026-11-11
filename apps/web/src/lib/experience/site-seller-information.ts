import type { SitePublicExperience } from "./site-publications";

export function siteSellerInformationHref(item: SitePublicExperience, locale: "en" | "ja"): string | null {
  const { publication, saleTerms, sellerDisclosure } = item;
  if (saleTerms?.sellerDisclosureUrl) return saleTerms.sellerDisclosureUrl;
  if (!sellerDisclosure) return null;
  if (sellerDisclosure.method === "EXTERNAL") return sellerDisclosure.externalUrl;
  return `${locale === "ja" ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}/seller`;
}
