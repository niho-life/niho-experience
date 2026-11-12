import type { SitePublicExperience } from "./site-publications";

export function siteSellerDisplayName(item: SitePublicExperience, locale: "en" | "ja"): string {
  const { publication, saleTerms, sellerDisclosure } = item;
  const name = saleTerms?.sellerDisplayName ?? sellerDisclosure?.sellerDisplayName ?? publication.sellerDisplayName;
  // Official English name: https://holdings.panasonic/jp/corporate/phd/profile.html
  if (locale === "en" && name.replace(/\s/g, "") === "パナソニックホールディングス株式会社") {
    return "Panasonic Holdings Corporation";
  }
  return name;
}

export function siteSellerInformationHref(item: SitePublicExperience, locale: "en" | "ja"): string | null {
  const { publication, saleTerms, sellerDisclosure } = item;
  if (saleTerms?.sellerDisclosureUrl) return saleTerms.sellerDisclosureUrl;
  if (!sellerDisclosure) return null;
  if (sellerDisclosure.method === "EXTERNAL") return sellerDisclosure.externalUrl;
  return `${locale === "ja" ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}/seller`;
}
