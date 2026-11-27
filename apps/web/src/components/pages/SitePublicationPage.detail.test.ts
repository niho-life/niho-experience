import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyReviews, Occurrence } from "@niho-experience/api-client";
import type { PublicMemberProfile } from "@niho-experience/experience-store";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  classification: null as { category: string | null; area: string | null } | null,
  nextDates: [] as unknown[],
  related: [] as unknown[],
  reviews: null as JourneyReviews | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => state.reviews) }));
vi.mock("@/lib/guest-booking-source", () => ({ siteNextDates: vi.fn(async () => state.nextDates) }));
vi.mock("@/lib/guide-registry", () => ({ guidesAboutExperience: vi.fn(async () => ({ guides: [], draftSlugs: [] })) }));
vi.mock("@/lib/experience/site-related", () => ({ relatedSiteExperienceCards: vi.fn(async () => state.related) }));
vi.mock("@/lib/experience-categories-server", () => ({ loadClassificationOf: vi.fn(async () => state.classification) }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => createElement("span", { "data-track": "experience_view" }) }));
vi.mock("@/components/DetailGallery", () => ({ DesktopGallery: () => null, MobileGallery: () => null }));
vi.mock("@/components/MapboxLocationMap", () => ({ MapboxLocationMap: () => createElement("div") }));
vi.mock("@/components/Photo", () => ({ Photo: () => createElement("img", { alt: "" }) }));

import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { SitePublicationPage } from "./SitePublicationPage";

const japanese = { title: "合成の体験", lead: "紹介", description: "説明", language: "日本語", highlights: [], included: ["材料"], notIncluded: ["交通費"], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] };
const offer = (over: Record<string, unknown> = {}) => ({ ...SAMPLE_TERMS.offers[0]!, ...over });
const item = (over: { offers?: unknown[]; english?: Record<string, unknown>; ja?: Record<string, unknown>; publication?: Record<string, unknown>; members?: PublicMemberProfile[]; seller?: boolean } = {}): SitePublicExperience => ({
  sellerDisclosure: over.seller ? { method: "NATIVE", sellerKind: "BUSINESS", sellerDisplayName: "Seller", representativeName: "Rep", publicAddress: "Addr", publicPhone: "0300000000", publicEmail: "a@example.test" } : null, hostBio: null, memberProfiles: over.members ?? [],
  publication: {
    slug: "detail-sample", publicTitle: "Detail sample", sellerDisplayName: "Seller", providerPublicName: "Sample Host", providerKind: "PERSON",
    content: { lead: "Lead", description: "Description", facts: { language: "English" }, highlights: [], included: ["Materials"], notIncluded: ["Transport"], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [], ...over.english },
    japanese: { ...japanese, ...over.ja },
    photos: [], providerPhoto: null, businessLogo: null, meetingOverview: "Meet at the gate.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
    japaneseOnly: false, publishedAtUtc: "2026-11-01T00:00:00.000Z", currency: "JPY", unitAmount: 4000, ...over.publication,
  },
  saleTerms: { title: SAMPLE_TERMS.title, currency: SAMPLE_TERMS.currency, sellerDisplayName: "Seller", offers: over.offers ?? [offer()], conditionsVersion: SAMPLE_TERMS.conditionsVersion },
}) as unknown as SitePublicExperience;
const render = async (locale: "en" | "ja", value = item()) => renderToStaticMarkup(await SitePublicationPage({ item: value, locale }));
const next: Occurrence = { offerId: "offer-a", date: "2026-11-20", startAt: "2026-11-20T01:00:00.000Z", endAt: "2026-11-20T02:30:00.000Z", bookingClosesAt: "2026-11-19T09:00:00.000Z", seatsLeft: 4, bookable: true, reason: null };
const person = (over: Partial<PublicMemberProfile> = {}): PublicMemberProfile => ({
  slug: "suga", name: "菅 倫明",
  text: { role: "空手指導者", area: "鎌倉", quote: "大丈夫。", intro: "円覚寺で教えています。" },
  photo: { src: "/p/suga.jpg", alt: "菅の写真", credit: null }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true, groupInquiryEnabled: true, peoplePagesEnabled: true, nihoWebOrigin: "https://niho.example.test" };
  state.classification = { category: "food", area: "kita" };
  state.nextDates = [];
  state.related = [];
  state.reviews = null;
});

describe.each([["en"], ["ja"]] as const)("the detail page in %s: the same sections", (locale) => {
  const prefix = locale === "ja" ? "/ja" : "";

  it("puts the category in the breadcrumb and above the title, and the area among the facts", async () => {
    const html = await render(locale);
    expect(html).toContain(`href="${prefix}/experiences?category=food"`);
    expect(html).toContain(locale === "ja" ? "つくる・食べる" : "Cook &amp; eat");
    // The hand-written line above the title is the category's English word in both languages.
    expect(html).toContain("cook &amp; eat");
    expect(html.indexOf("cook &amp; eat")).toBeLessThan(html.indexOf("<h1"));
    expect(html).toContain(locale === "ja" ? "北鎌倉" : "Kita-Kamakura");
    expect(html).toContain(locale === "ja" ? "開催日時" : "When");
  });

  it("leaves out the category and the area when the product has none", async () => {
    state.classification = null;
    const html = await render(locale);
    expect(html).not.toContain("?category=");
    expect(html).not.toContain(locale === "ja" ? "エリア" : "Area");
  });

  it("shows what is included with check and cross icons, a column only when it has something, and no section when both are empty", async () => {
    const both = await render(locale);
    expect(both).toContain(locale === "ja" ? "含まれないもの" : "Not included");
    const onlyIncluded = await render(locale, item({ english: { notIncluded: [] }, ja: { notIncluded: [] } }));
    expect(onlyIncluded).toContain(locale === "ja" ? "含まれるもの" : "Included");
    expect(onlyIncluded).not.toContain(locale === "ja" ? "含まれないもの" : "Not included");
    const none = await render(locale, item({ english: { included: [], notIncluded: [] }, ja: { included: [], notIncluded: [] } }));
    expect(none).not.toContain(locale === "ja" ? "料金に含まれるもの" : "What’s included");
  });

  it("groups cancellation terms with the participation notes: one line when the offers agree, each offer's own when they differ", async () => {
    const same = await render(locale);
    expect(same).toContain(locale === "ja" ? "キャンセル" : ">Cancellation<");
    const section = same.slice(same.indexOf('id="know-before-you-go"'), same.indexOf("</section>", same.indexOf('id="know-before-you-go"')));
    expect(section.match(/<li/g)).toHaveLength(1);
    const a = offer({ id: "a", name: "Morning", cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 } });
    const b = offer({ id: "b", name: "Evening", cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 } });
    const differ = await render(locale, item({ offers: [a, b] }));
    const parts = differ.slice(differ.indexOf('id="know-before-you-go"'), differ.indexOf("</section>", differ.indexOf('id="know-before-you-go"')));
    expect(parts.match(/<li/g)).toHaveLength(2);
    expect(parts).toContain("Morning");
    expect(parts).toContain("Evening");
  });

  it("keeps the booking links and the request flow: the button goes to the booking page, and an approval product says request", async () => {
    const html = await render(locale);
    expect(html).toContain(`href="${prefix}/experiences/detail-sample/book"`);
    expect(html).toContain('id="book"');
    expect(html).toContain(locale === "ja" ? "日にちを選ぶ" : "Choose a date");
    expect(html.match(new RegExp(`href="${prefix}/inquiry\\?`, "g")) ?? []).toHaveLength(1);
    const approval = await render(locale, item({ offers: [offer({ acceptanceMode: "APPROVAL" })] }));
    expect(approval).toContain(locale === "ja" ? "申込みへ進む" : "Request to book");
    expect(approval).not.toContain(locale === "ja" ? "日にちを選ぶ" : ">Choose a date</a>");
  });

  it("shows next date choices in the booking card and keeps the localized inquiry entry", async () => {
    state.nextDates = [next];
    const html = await render(locale);
    const card = html.slice(html.indexOf('id="book"'), html.indexOf("</section>", html.indexOf('id="book"')));
    expect(card).toContain(locale === "ja" ? "近い開催日" : "Upcoming dates");
    expect(card).not.toContain(locale === "ja" ? "予約締切：" : "Book by ");
    expect(card).not.toMatch(/seller information|Stripe Checkout|Sold by/i);
    expect(html).toContain(`href="${prefix}/inquiry?`);
    expect(html).toContain(locale === "ja" ? "ほかの日・グループの相談" : "Ask about other dates or a group");
    state.nextDates = [];
    expect(await render(locale)).not.toContain(locale === "ja" ? "予約締切：" : "Book by ");
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect((await render(locale)).match(new RegExp(`href="${prefix}/inquiry\\?`, "g")) ?? []).toHaveLength(0);
  });

  it("shows the public pin link and never exposes a precise point for an after-booking area", async () => {
    const point = { lat: 35.123456, lng: 139.654321 };
    const publicHtml = await render(locale, item({ publication: {
      meetingPointDisclosure: "PUBLIC", meetingPoint: { name: "Public studio", exteriorPhotoIndex: null }, publicMapPoint: point,
    } }));
    expect(publicHtml).toContain(`https://maps.google.com/?q=${point.lat},${point.lng}`);
    expect(publicHtml).toContain(locale === "ja" ? "Google マップで開く" : "Open in Google Maps");
    const afterBookingHtml = await render(locale, item({ publication: {
      meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, publicMapPoint: point, publicMapArea: { lat: 35.319, lng: 139.551, radiusMeters: 500 },
    } }));
    expect(afterBookingHtml).toContain(locale === "ja" ? "地図は公開しているおおよそのエリアです。" : "The map shows an approximate public area.");
    expect(afterBookingHtml).not.toContain("35.123456");
    expect(afterBookingHtml).not.toContain("139.654321");
    expect(afterBookingHtml).not.toContain("maps.google.com/?q=");
  });

  it("keeps the body sections in the requested reading order", async () => {
    state.reviews = { status: "ok", summary: { count: 1, average: 5, tags: [] }, items: [] };
    const html = await render(locale, item({
      english: { timeline: [{ time: "10:00", title: "Welcome", text: "Start here.", photoIndex: null }], faq: [{ question: "Question?", answer: "Answer." }] },
      ja: { timeline: [{ time: "10:00", title: "集合", text: "ここから始めます。", photoIndex: null }], faq: [{ question: "質問？", answer: "回答。" }] },
    }));
    const order = locale === "ja"
      ? ["体験内容", "当日の流れ", "料金に含まれるもの", 'id="host"', 'id="place"', 'id="reviews"', 'id="know-before-you-go"', 'id="faq"']
      : ["What you’ll do", "How the time flows", "What’s included", 'id="host"', 'id="place"', 'id="reviews"', 'id="know-before-you-go"', 'id="faq"'];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("shows only the seller disclosure link at the end of the host section, with no seller name and no group-inquiry row", async () => {
    const html = await render(locale, item({ seller: true }));
    const host = html.slice(html.indexOf('id="host"'), html.indexOf("</section>", html.indexOf('id="host"')));
    const link = locale === "ja" ? "特定商取引法に基づく表記" : "Seller information";
    expect(host).toContain(`<a href="${prefix}/experiences/detail-sample/seller"`);
    expect(host).toContain(link);
    expect(host.indexOf('id="seller"')).toBeGreaterThan(host.indexOf("Sample Host"));
    expect(html.match(/id="seller"/g)).toHaveLength(1);
    expect(html).not.toMatch(/Sold by|販売者：/);
    expect(html).not.toContain('id="inquiry"');
    expect(html).not.toContain("予約の前に相談できます。");
    expect(html).not.toContain("Ask us before booking");
  });

  it("puts the link alone at the end of the main column when there is no host section, and nothing without a disclosure", async () => {
    const noHost = item({ seller: true, publication: { providerPublicName: null, providerKind: null } });
    const html = await render(locale, noHost);
    if (!html.includes('id="host"')) {
      expect(html.match(/id="seller"/g)).toHaveLength(1);
      expect(html).toContain(`href="${prefix}/experiences/detail-sample/seller"`);
    }
    expect(await render(locale)).not.toContain('id="seller"');
  });

  it("suggests other experiences with the shared card, and the bar under the phone layout carries the price and the button", async () => {
    const other = item({ publication: { slug: "other-one", publicTitle: "Other one" } });
    state.related = [locale === "ja" ? sitePublicationCard(other, "ja")! : sitePublicationCard(other)];
    const html = await render(locale);
    // The card is the shared one: its link takes the language from the site's locale context, which this render has none of.
    expect(html).toContain('/experiences/other-one"');
    expect(html).toContain(locale === "ja" ? "ほかの体験" : "More experiences in Kamakura");
    const bar = html.slice(html.indexOf("fixed inset-x-0 bottom-0"));
    expect(bar).toContain("lg:hidden");
    expect(bar).toContain(locale === "ja" ? "日にちを選ぶ" : "Choose a date");
    expect(html).toContain(`href="${prefix}/experiences/detail-sample/book"`);
    expect(html).toContain("pb-24 lg:pb-0");
    state.config = { ...state.config, bookingsEnabled: false };
    expect(await render(locale)).not.toContain("fixed inset-x-0 bottom-0");
  });

  it("tracks the view", async () => {
    expect(await render(locale)).toContain('data-track="experience_view"');
  });
});

describe("the detail page in Japanese: the differences that stay", () => {
  it("says only that the meeting point is shared after booking: there is no Japanese manuscript for it", async () => {
    const html = await render("ja");
    expect(html).toContain("集合場所は、予約が確定したあとにお伝えします。");
    expect(html).not.toContain("Meet at the gate.");
    const publicMeeting = await render("ja", item({ publication: { meetingPointDisclosure: "PUBLIC", meetingPoint: { name: "Gate", exteriorPhotoIndex: null } } }));
    expect(publicMeeting).not.toContain("集合場所");
    expect(publicMeeting).not.toContain("Gate");
  });

  it("keeps the provider section and nests Japanese people details beneath it", async () => {
    const one = await render("ja", item({ members: [person(), person({ slug: "other", name: "別の人" })] }));
    expect(one).toContain("ホストについて");
    expect(one).toContain("Sample Host");
    expect(one).toContain("空手指導者");
    expect(one).toContain('href="/ja/people/suga"');
    expect(one).toContain("空手指導者・鎌倉");
    expect(one).toContain("別の人");
    expect(one.indexOf("Sample Host")).toBeLessThan(one.indexOf("案内する人"));
    expect(one.match(/id="host"/g)).toHaveLength(1);
    expect(one).not.toContain("Sample Hostさんに相談する");
    const multiple = item({ members: [person(), person({ slug: null, name: "合成の案内役" })] });
    expect(await render("ja", multiple)).toContain("案内する人");
    state.config = { ...state.config, peoplePagesEnabled: false };
    const off = await render("ja", multiple);
    expect(off).toContain("菅 倫明");
    expect(off).not.toContain("/ja/people/");
  });

  it("labels a business seller-name fallback as the host in both languages", async () => {
    const business = item({ publication: {
      providerPublicName: null,
      providerPublicNameEn: null,
      providerKind: "BUSINESS",
      sellerDisplayName: "NIHO kamakura (Panasonic Holdings Corporation)",
    } });
    const ja = await render("ja", { ...business, memberProfiles: [person({ name: "高浜拓也", text: { role: "コミュニティマネージャー", area: "鎌倉", quote: null, intro: "合成プロフィールです。" } })] });
    const en = await render("en", business);
    expect(ja).toContain("ホストについて");
    expect(en).toContain("About your host");
    for (const html of [ja, en]) {
      expect(html).toContain("NIHO kamakura (Panasonic Holdings Corporation)");
      expect(html.match(/id="host"/g)).toHaveLength(1);
    }
    expect(ja).toContain("高浜拓也");
    expect(en).not.toContain("高浜拓也");

    const translated = await render("en", { ...business, memberProfiles: [person({
      name: "合成の案内役", text: { role: "Guide", area: "Kamakura", quote: null, intro: "Synthetic introduction." },
    })] });
    expect(translated).toContain("Meet your guides");
    expect(translated).toContain("Guide · Kamakura");
    expect(translated).toContain("合成の案内役");
    expect(translated).toContain("Synthetic introduction.");
    expect(translated).not.toContain("/ja/people/");
  });

  it("falls back to the provider and the introduction when nobody is linked, with no question to the host (#589)", async () => {
    const html = await render("ja");
    expect(html).toContain("ホストについて");
    expect(html).not.toContain("Sample Hostさんに相談する");
    expect(html).not.toContain("/ja/people/");
  });

  it("does not show the English-only meeting overview or guides section, and the English page keeps its overview", async () => {
    expect(await render("en")).toContain("Meet at the gate.");
  });
});
