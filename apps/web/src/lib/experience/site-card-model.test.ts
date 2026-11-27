import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import { cancellationLines, sitePublicationCard } from "./site-card-model";

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
      method: "NATIVE", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Legal Seller", representativeName: "Rep", publicAddress: "Addr", publicPhone: "0300000000", publicEmail: "a@example.test",
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

describe("cancellationLines", () => {
  const offer = (over: Record<string, unknown>) => ({ ...SAMPLE_TERMS.offers[0]!, ...over }) as unknown as SitePublicExperience["saleTerms"] extends infer T ? T extends { offers: readonly (infer O)[] } ? O : never : never;
  const a = offer({ name: "午前", cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 } });
  const b = offer({ id: "b", name: "夜", cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 } });

  it("says one line when every offer agrees and each offer's own when they differ, in both languages", () => {
    expect(cancellationLines([a, a], "ja")).toEqual([{ label: null, text: "開始24時間前までキャンセル無料" }]);
    expect(cancellationLines([a, b], "ja")).toEqual([{ label: "午前", text: "開始24時間前までキャンセル無料" }, { label: "夜", text: "開始48時間前までキャンセル無料" }]);
    expect(cancellationLines([a, a])).toEqual([{ label: null, text: "Free cancellation until 24 hours before the start" }]);
    expect(cancellationLines([a, b], "en").map((line) => line.label)).toEqual(["午前", "夜"]);
    expect(cancellationLines([], "en")).toEqual([]);
  });
});
