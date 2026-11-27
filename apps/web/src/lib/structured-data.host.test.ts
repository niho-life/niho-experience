import { describe, expect, it } from "vitest";
import { sitePublicationJsonLd } from "./structured-data";
import type { SitePublicExperience } from "./experience/site-publications";

/** The host in structured data (#691): the resolved host name, never the legal seller name when a registered name exists. Synthetic data only. */
const item = (over: Record<string, unknown>, sellerKind: "PERSON" | "BUSINESS" | null) => ({
  sellerDisclosure: sellerKind ? { sellerKind } : null,
  saleTerms: null,
  publication: {
    slug: "s", publicTitle: "Synthetic", sellerDisplayName: "NIHO kamakura (Panasonic Holdings Corporation)",
    providerPublicName: null, providerPublicNameEn: null, providerKind: null,
    content: { lead: "Lead" }, japanese: null, photos: [], ...over,
  },
}) as unknown as SitePublicExperience;

describe("sitePublicationJsonLd host", () => {
  it("uses the registered name and the seller's kind when there is no public profile", () => {
    const { touristTrip, product } = sitePublicationJsonLd(item({ providerRegisteredName: "NIHO kamakura" }, "BUSINESS"), "https://example.test", false, null);
    expect(touristTrip.provider).toEqual({ "@type": "Organization", name: "NIHO kamakura" });
    expect(product.brand).toEqual({ "@type": "Organization", name: "NIHO kamakura" });
    expect(JSON.stringify({ touristTrip, product })).not.toContain("Panasonic");
    expect(sitePublicationJsonLd(item({ providerRegisteredName: "Sample" }, "PERSON"), "https://example.test", false, null).touristTrip.provider).toEqual({ "@type": "Person", name: "Sample" });
  });

  it("keeps a public profile's name and kind", () => {
    const { touristTrip, product } = sitePublicationJsonLd(item({ providerPublicName: "志龍", providerKind: "PERSON", providerRegisteredName: "Other" }, "BUSINESS"), "https://example.test", false, null, "ja");
    expect(touristTrip.provider).toEqual({ "@type": "Person", name: "志龍" });
    expect(product.brand).toBeUndefined();
  });
});
