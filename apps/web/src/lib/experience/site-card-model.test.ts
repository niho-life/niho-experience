import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./site-publications";
import { sitePublicationCard } from "./site-card-model";

const providerPhoto = { src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000001", alt: "Synthetic provider", altJa: "合成提供者", publicCredit: null };
const businessLogo = { src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000002", alt: "Synthetic business", altJa: "合成事業者", publicCredit: null };

function item(sellerKind: "PERSON" | "BUSINESS" | null, media: { providerPhoto?: typeof providerPhoto | null; businessLogo?: typeof businessLogo | null } = {}): SitePublicExperience {
  return {
    publication: {
      slug: "synthetic-card", publicTitle: "Synthetic card", sellerDisplayName: "Synthetic Legal Seller",
      content: { lead: "Synthetic lead", facts: { language: "English" } }, photos: [], unitAmount: 3000,
      providerPhoto: media.providerPhoto === undefined ? providerPhoto : media.providerPhoto,
      businessLogo: media.businessLogo === undefined ? businessLogo : media.businessLogo,
    },
    saleTerms: null,
    sellerDisclosure: sellerKind === null ? null : {
      method: "EXTERNAL", sellerKind, sellerDisplayName: "Synthetic Legal Seller", externalUrl: "https://seller.example.test/legal",
    },
  } as unknown as SitePublicExperience;
}

describe("sitePublicationCard provider face", () => {
  it("uses only the provider photo for a known person seller", () => {
    expect(sitePublicationCard(item("PERSON")).face).toMatchObject({ name: "Synthetic Legal Seller", image: { url: providerPhoto.src } });
    expect(sitePublicationCard(item("PERSON", { providerPhoto: null })).face.image).toBeNull();
  });

  it("uses only the business logo for a known business seller", () => {
    expect(sitePublicationCard(item("BUSINESS")).face.image).toMatchObject({ url: businessLogo.src });
    expect(sitePublicationCard(item("BUSINESS", { businessLogo: null })).face.image).toBeNull();
  });

  it("prefers the provider photo for an unconfirmed kind and falls back to the logo, then the initial", () => {
    expect(sitePublicationCard(item(null)).face.image).toMatchObject({ url: providerPhoto.src });
    expect(sitePublicationCard(item(null, { providerPhoto: null })).face.image).toMatchObject({ url: businessLogo.src });
    expect(sitePublicationCard(item(null, { providerPhoto: null, businessLogo: null })).face).toMatchObject({ initial: "S", image: null });
  });
});
