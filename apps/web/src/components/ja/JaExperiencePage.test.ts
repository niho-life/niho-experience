import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JA_STATIC_COPY_V1 } from "@/lib/ja-static-copy";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import type { PublicPerson } from "@niho-experience/experience-store";
import type { JaCard } from "@/lib/ja-catalog";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => null) }));
vi.mock("@/lib/guest-booking-source", () => ({ siteNextDates: vi.fn(async () => []) }));
const settings = vi.hoisted(() => ({ peoplePagesEnabled: true }));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true, groupInquiryEnabled: true, nihoWebOrigin: "https://niho.example.test", get peoplePagesEnabled() { return settings.peoplePagesEnabled; } } }));
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
const render = async (value = item(), related: JaCard[] = [], people: PublicPerson[] = []) => renderToStaticMarkup(createElement(SiteLocaleProvider as unknown as FunctionComponent<Record<string, unknown>>, { locale: "ja", values: JA_STATIC_COPY_V1 }, await JaExperiencePage({ item: value, card, related, people })));
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

  const guide = (slug: string, name: string, over: Partial<PublicPerson> = {}): PublicPerson => ({
    slug, name, roleJa: "空手指導者", areaJa: "鎌倉", quoteJa: "うまく書こうとしなくて大丈夫。", introJa: "円覚寺で教えています。", photo: { src: `/p/${slug}.jpg`, altJa: `${name}の写真`, credit: null }, experienceSlugs: ["synthetic-walk"], sortOrder: 10, ...over,
  });

  it("shows the people it is met through (#585) with a link to each page, one as 「会いにいく人」 and several as 「案内する人」", async () => {
    const one = await render(item(), [], [guide("suga", "菅 倫明")]);
    expect(one).toContain("会いにいく人");
    expect(one).toContain('href="/ja/people/suga"');
    expect(one).toContain("菅 倫明さんのページ");
    expect(one).toContain("空手指導者・鎌倉");
    expect(one).toContain("うまく書こうとしなくて大丈夫。");
    // The listed person stands in for the provider's own bio here.
    expect(one).not.toContain("鎌倉で山を案内しています。");
    const many = await render(item(), [], [guide("suga", "菅 倫明"), guide("takuya", "高浜 拓也")]);
    expect(many).toContain("案内する人");
    expect(many).not.toContain("会いにいく人");
    expect(many).toContain('href="/ja/people/takuya"');
    // Nobody linked: the provider's own section as before, and no link to 街の人.
    const none = await render();
    expect(none).toContain("会いにいく人");
    expect(none).toContain("鎌倉で山を案内しています。");
    expect(none).not.toContain("/ja/people/");
  });

  it("keeps a person's name and face but links no page while the people pages are off (#612)", async () => {
    settings.peoplePagesEnabled = false;
    try {
      const html = await render(item(), [], [guide("suga", "菅 倫明")]);
      expect(html).toContain("会いにいく人");
      expect(html).toContain("菅 倫明");
      expect(html).toContain("空手指導者・鎌倉");
      expect(html).toContain("菅 倫明の写真");
      expect(html).not.toContain("/ja/people/");
      expect(html).not.toContain("さんのページ");
    } finally {
      settings.peoplePagesEnabled = true;
    }
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

  it("keeps the seller information link in the booking column, with or without a sale", async () => {
    const withDisclosure = (value: SitePublicExperience) => ({ ...value, sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Seller", externalUrl: "https://seller.example.test/legal" } }) as unknown as SitePublicExperience;
    for (const value of [withDisclosure(item()), withDisclosure(item([]))]) {
      const html = await render(value);
      const aside = html.slice(html.indexOf('<aside id="book"'), html.indexOf("</aside>"));
      expect(aside).toContain("販売者情報");
      expect(aside).toContain("https://seller.example.test/legal");
      // Not under the facts at the top.
      expect(html.slice(0, html.indexOf('<aside id="book"')).includes("販売者情報")).toBe(false);
    }
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
