import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./site-publications";
import { sitePublicationCard } from "./site-card-model";

const providerPhoto = { src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000001", alt: "Synthetic provider", altJa: "合成提供者", publicCredit: null };
const businessLogo = { src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000002", alt: "Synthetic business", altJa: "合成事業者", publicCredit: null };

function item(providerKind: "PERSON" | "BUSINESS" | null, media: { providerPhoto?: typeof providerPhoto | null; businessLogo?: typeof businessLogo | null } = {}): SitePublicExperience {
  return {
    publication: {
      slug: "synthetic-card", publicTitle: "Synthetic card", sellerDisplayName: "Synthetic Legal Seller",
      providerPublicName: "Synthetic Actual Host", providerKind,
      content: { lead: "Synthetic lead", facts: { language: "English" } }, photos: [], unitAmount: 3000,
      providerPhoto: media.providerPhoto === undefined ? providerPhoto : media.providerPhoto,
      businessLogo: media.businessLogo === undefined ? businessLogo : media.businessLogo,
    },
    saleTerms: null,
    sellerDisclosure: {
      method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Legal Seller", externalUrl: "https://seller.example.test/legal",
    },
  } as unknown as SitePublicExperience;
}

describe("sitePublicationCard actual provider face", () => {
  it("preserves existing cards for a publication without a public profile", () => {
    const base = item("PERSON");
    const publication = { ...base.publication, providerPublicName: null, providerKind: null };
    expect(sitePublicationCard({ ...base, publication }).face).toMatchObject({
      name: "Synthetic Legal Seller", image: { url: businessLogo.src },
    });
    expect(sitePublicationCard({ ...base, publication, sellerDisclosure: null }).face.image).toMatchObject({ url: providerPhoto.src });
  });

  it("uses the provider public name and photo while leaving the legal seller separate", () => {
    expect(sitePublicationCard(item("PERSON"))).toMatchObject({
      withLabel: "with Synthetic Actual Host",
      face: { name: "Synthetic Actual Host", image: { url: providerPhoto.src } },
    });
    expect(sitePublicationCard(item("PERSON", { providerPhoto: null })).face.image).toBeNull();
  });

  it("prefers the actual provider photo and uses the business logo only as its fallback", () => {
    expect(sitePublicationCard(item("BUSINESS")).face.image).toMatchObject({ url: providerPhoto.src });
    expect(sitePublicationCard(item("BUSINESS", { providerPhoto: null })).face.image).toMatchObject({ url: businessLogo.src });
  });

  it("does not replace an actual person with the legal seller or business logo", () => {
    expect(sitePublicationCard(item(null)).face.image).toMatchObject({ url: providerPhoto.src });
    expect(sitePublicationCard(item(null, { providerPhoto: null })).face.image).toBeNull();
    expect(sitePublicationCard(item(null, { providerPhoto: null, businessLogo: null })).face).toMatchObject({ initial: "S", image: null });
  });
});
