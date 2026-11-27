import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./site-publications";
import { sitePublicationCard } from "./site-card-model";
import { localJapaneseCopy } from "@/lib/ja-static-copy";

const photo = { src: "/api/public/synthetic-photo", alt: "Synthetic photo", altJa: "合成の写真", publicCredit: null };
const providerPhoto = { src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000001", alt: "p", altJa: "提供者", publicCredit: null };
const offer = (id: string, over: Record<string, unknown> = {}) => ({ id, minimumParticipants: 1, maxPartySize: 4, capacity: 4, durationMinutes: 120, weekdays: [6], startTime: "10:00", pricing: { adultPriceYen: 3000 }, ...over });

function item(over: { japanese?: unknown; offers?: unknown[]; providerKind?: "PERSON" | "BUSINESS" | null } = {}): SitePublicExperience {
  return {
    publication: {
      slug: "synthetic", publicTitle: "Synthetic English", sellerDisplayName: "合成販売者", providerPublicName: "合成ホスト", providerKind: over.providerKind === undefined ? "PERSON" : over.providerKind,
      content: { lead: "English lead", facts: { language: "English" } }, photos: [photo], unitAmount: 3000, providerPhoto, businessLogo: null,
      japanese: over.japanese === undefined ? { title: "合成の体験", lead: "合成のひとこと", language: "日本語と英語", description: "" } : over.japanese,
    },
    saleTerms: { offers: over.offers ?? [offer("o1"), offer("o2", { durationMinutes: 180, weekdays: [2, 6], startTime: "18:00", pricing: { adultPriceYen: 5000 } })] },
    sellerDisclosure: null,
  } as unknown as SitePublicExperience;
}

describe("sitePublicationCard in Japanese (#658)", () => {
  const copy = localJapaneseCopy();

  it("builds the card from the Japanese manuscript, in Japanese", () => {
    const card = sitePublicationCard(item(), "ja", { copy })!;
    expect(card).toMatchObject({
      slug: "synthetic", title: "合成の体験", lead: "合成のひとこと", withLabel: "合成ホストさんと",
      cover: { url: photo.src, alt: "合成の写真" }, face: { name: "合成ホスト", initial: "合", image: { url: providerPhoto.src, alt: "" } },
      groupLabel: "最大4名", durationLabel: "2時間–3時間", language: { short: "日本語と英語", full: "日本語と英語" },
      scheduleLabel: "火曜 · 土曜 · 10:00 / 18:00", priceLabel: "¥3,000", priceIsFrom: true,
      offers: [{ id: "o1", minimumParticipants: 1, maxPartySize: 4 }, { id: "o2", minimumParticipants: 1, maxPartySize: 4 }],
    });
  });

  it("says the linked people guide it, and shows their face", () => {
    const card = sitePublicationCard(item(), "ja", { copy, people: [{ name: "鎌倉 一郎", photo: { src: "/people/a" } }, { name: "鎌倉 二郎" }] })!;
    expect(card.withLabel).toBe("鎌倉 一郎・鎌倉 二郎が案内");
    expect(card.face).toMatchObject({ name: "鎌倉 一郎", initial: "鎌", image: { url: "/people/a" } });
  });

  it("names a business as 「が案内」, and falls back to the seller's display name", () => {
    expect(sitePublicationCard(item({ providerKind: "BUSINESS" }), "ja", { copy })!.withLabel).toBe("合成ホストが案内");
    const noName = item();
    // The legal seller name is never the host's name (#691): without any host name the label is left out.
    expect(sitePublicationCard({ ...noName, publication: { ...noName.publication, providerPublicName: null } }, "ja", { copy })).toMatchObject({ withLabel: "", face: { name: "" } });
    // Without a public profile, the registered name is used; the kind comes from the seller disclosure, else it is unknown.
    const registered = { ...noName.publication, providerPublicName: null, providerKind: null, providerRegisteredName: "合成登録名" };
    expect(sitePublicationCard({ ...noName, publication: registered, sellerDisclosure: { sellerKind: "BUSINESS" } as never }, "ja", { copy })!.withLabel).toBe("合成登録名が案内");
    expect(sitePublicationCard({ ...noName, publication: registered, sellerDisclosure: null }, "ja", { copy })).toMatchObject({ withLabel: "ホスト：合成登録名", face: { name: "合成登録名", initial: "合" } });
  });

  it("is null without a Japanese manuscript or without a sale", () => {
    expect(sitePublicationCard(item({ japanese: null }), "ja")).toBeNull();
    expect(sitePublicationCard(item({ offers: [] }), "ja")).toBeNull();
  });

  it("makes a card for a page whose bookings are not open yet only when asked (#706): the price is the page's, no dates, not bookable", () => {
    const preparing = { ...item({ offers: [] }), saleTerms: null } as SitePublicExperience;
    expect(sitePublicationCard(preparing, "ja", { copy })).toBeNull();
    const card = sitePublicationCard(preparing, "ja", { copy, includePageOnly: true })!;
    expect(card).toMatchObject({ slug: "synthetic", title: "合成の体験", priceLabel: "¥3,000", priceIsFrom: false, bookingAvailable: false, offers: [], scheduleLabel: null, groupLabel: null });
    // English: always a card, with the same flag.
    expect(sitePublicationCard(preparing)).toMatchObject({ priceLabel: "¥3,000", bookingAvailable: false, offers: [], scheduleLabel: null });
    // Open and sellable: bookable.
    const open = item(); (open.publication as { bookingAvailable?: boolean }).bookingAvailable = true;
    expect(sitePublicationCard(open, "ja", { copy })?.bookingAvailable).toBe(true);
    expect(sitePublicationCard(open)?.bookingAvailable).toBe(true);
  });

  it("leaves the English card as it was", () => {
    const card = sitePublicationCard(item());
    expect(card).toMatchObject({ title: "Synthetic English", withLabel: "with 合成ホスト", groupLabel: "Up to 4 guests", durationLabel: "2 hr–3 hr", priceLabel: "¥3,000" });
    expect(sitePublicationCard(item(), "en")).toEqual(card);
  });
});
