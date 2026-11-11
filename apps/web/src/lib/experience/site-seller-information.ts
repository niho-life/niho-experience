import type { SitePublicExperience } from "./site-publications";

export function siteSellerInformationHref(item: SitePublicExperience, locale: "en" | "ja"): string | null {
  const { publication, sellerDisclosure } = item;
  if (!sellerDisclosure) return null;
  if (sellerDisclosure.method === "EXTERNAL") return sellerDisclosure.externalUrl;
  return `${locale === "ja" ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}/seller`;
}
