import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JA_STATIC_COPY_V1 } from "@/lib/ja-static-copy";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import type { JaCard } from "@/lib/ja-catalog";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => null) }));
vi.mock("@/lib/guest-booking-source", () => ({ siteNextDates: vi.fn(async () => []) }));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true, groupInquiryEnabled: true, nihoWebOrigin: "https://niho.example.test" } }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => createElement("span") }));

import { JaExperiencePage, jaCancellationLines } from "./JaExperiencePage";

/** 日本語の体験のページ (#530) as a visitor reads it. Synthetic data only. */
const offer = (over: Record<string, unknown> = {}) => ({ ...SAMPLE_TERMS.offers[0]!, ...over });
function item(offers = [offer()]): SitePublicExperience {
  return {
    sellerDisclosure: null, hostBio: { ja: "鎌倉で山を案内しています。", en: null },
    publication: {
      slug: "synthetic-walk", publicTitle: "English", sellerDisplayName: "NIHO 販売", providerPublicName: "まさと", providerKind: "PERSON",
      japanese: { title: "合成の山道を歩く", lead: "山道を歩きます。", description: "尾根を越えて歩きます。", language: "日本語", highlights: ["観光地図にない山道"], included: ["ガイド料"], notIncluded: ["交通費"], knowBeforeYouGo: ["歩きやすい靴で"], notSuitableFor: [], timeline: [{ time: "09:00", title: "集合", text: "駅前で。", photoIndex: null }], faq: [] },
      content: { lead: "", description: "", facts: { language: "" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
      photos: [{ src: "/synthetic.jpg", alt: "alt", altJa: "山道", publicCredit: null }], providerPhoto: { src: "/p.jpg", alt: "", altJa: "まさと", publicCredit: null }, businessLogo: null,
      meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, japaneseOnly: false, publishedAtUtc: "2026-11-01T00:00:00.000Z", unitAmount: 5500, currency: "JPY",
    },
    saleTerms: { ...SAMPLE_TERMS, offers },
  } as unknown as SitePublicExperience;
}
const card: JaCard = { slug: "synthetic-walk", title: "合成の山道を歩く", lead: "山道を歩きます。", cover: { url: "/synthetic.jpg", alt: "山道" }, withLine: "まさとさんと", face: null, durationMinutes: 180, capacity: { min: 2, max: 8 }, priceFromYen: 5500, offers: [], classification: { category: "walk", area: "kita", companions: [], occasions: [] } };
const render = async (value = item(), related: JaCard[] = [], person: { slug: string; name: string; roleJa: string } | null = null) => renderToStaticMarkup(createElement(SiteLocaleProvider, { locale: "ja", values: JA_STATIC_COPY_V1, children: await JaExperiencePage({ item: value, card, related, person }) }));
/** The words a visitor reads: tags, attributes and scripts removed. */
const visibleText = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");

describe("JaExperiencePage", () => {
  it("is in the order the owner described, from the title to what to know, with the person", async () => {
    const html = await render();
    const order = ["合成の山道を歩く", "まさとさんと", "所要時間", "人数", "エリア", "対応言語", "山道を歩きます。", "当日の流れ", "会いにいく人", "料金に含まれるもの", "集合場所", "知っておいてほしいこと", "取消について"];
    let last = -1;
    for (const text of order) { const at = html.indexOf(text, last + 1); expect(at, text).toBeGreaterThan(last); last = at; }
    expect(html).toContain("鎌倉で山を案内しています。");
    expect(html).toContain("集合場所は、予約が確定したあとにお伝えします。");
    expect(html).toContain("北鎌倉");
    expect(html).not.toContain("今日の担当");
  });

  it("keeps the language the experience is held in, so a guest is not led to expect Japanese when it is held in English", async () => {
    const value = item();
    (value.publication.japanese as { language: string }).language = "英語";
    const html = await render(value);
    expect(html).toContain("対応言語");
    expect(html).toContain("英語");
  });

  it("has no English in the page's own words: the gallery says it in Japanese, and there is no next-date band", async () => {
    const value = item();
    (value.publication as unknown as { photos: unknown[] }).photos = [...value.publication.photos, ...value.publication.photos];
    const html = await render(value, [{ ...card, slug: "other", title: "もうひとつの体験" }]);
    const english = visibleText(html).match(/[A-Za-z]{3,}/g) ?? [];
    // The category's handwritten accent ("take a walk") is the design's own English; nothing else is.
    expect(english.filter((word) => !["NIHO", "JST", "take", "walk"].includes(word))).toEqual([]);
    expect(html).toContain("枚の写真をすべて見る");
    expect(html).not.toContain("Show all");
    expect(html).not.toContain("data-next-date-band");
  });

  it("links the person's section to their page on 街の人 when they are listed, and not otherwise", async () => {
    const linked = await render(item(), [], { slug: "masato", name: "まさと", roleJa: "山のガイド" });
    expect(linked).toContain('href="/ja/people/masato"');
    expect(linked).toContain("まさとさんのページ");
    expect(linked).toContain("山のガイド");
    expect(await render()).not.toContain("/ja/people/");
  });

  it("puts the booking column's price, the way to book, the other-day inquiry and the product's own cancellation deadline in one place", async () => {
    const html = await render();
    expect(html).toContain("日にちを選んで予約へ");
    expect(html).toContain('href="/ja/experiences/synthetic-walk/book"');
    expect(html).toContain("ほかの日を相談する");
    expect(html).toContain("/ja/inquiry?");
    expect(html).toContain("キャンセル無料");
    for (const label of ["すぐ予約", "リクエスト制", "チームで案内", "NIHOが販売", "保証"]) expect(html).not.toContain(label);
  });

  it("is a request for an approval product: 「申込みを送る」, and that payment follows the confirmation", async () => {
    const html = await render(item([offer({ acceptanceMode: "APPROVAL" })]));
    expect(html).toContain("申込みを送る");
    expect(html).toContain("お支払いは、確認のあとにご案内します。");
    expect(html).not.toContain("日にちを選んで予約へ");
  });

  it("shows other experiences of the category and says nothing is bookable when there is no sale", async () => {
    expect(await render(item(), [{ ...card, slug: "other", title: "もうひとつの体験" }])).toContain("歩くの体験をもっと");
    const none = await render(item([]));
    expect(none).toContain("現在、予約を受け付けていません");
    expect(none).not.toContain("日にちを選んで予約へ");
  });
});

describe("jaCancellationLines", () => {
  it("says one line when every offer agrees and each offer's own when they differ", () => {
    const a = offer({ name: "午前", cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 } });
    const b = offer({ id: "b", name: "夜", cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 } });
    expect(jaCancellationLines([a, a])).toEqual([{ label: null, text: "開始24時間前までキャンセル無料" }]);
    expect(jaCancellationLines([a, b])).toEqual([{ label: "午前", text: "開始24時間前までキャンセル無料" }, { label: "夜", text: "開始48時間前までキャンセル無料" }]);
  });
});
