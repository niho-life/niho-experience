import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Occurrence } from "@niho-experience/api-client";
import type { PublicPerson } from "@niho-experience/experience-store";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  classification: null as { category: string | null; area: string | null } | null,
  nextDates: [] as unknown[],
  related: [] as unknown[],
  people: [] as unknown[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => null) }));
vi.mock("@/lib/guest-booking-source", () => ({ siteNextDates: vi.fn(async () => state.nextDates) }));
vi.mock("@/lib/guide-registry", () => ({ guidesAboutExperience: vi.fn(async () => ({ guides: [], draftSlugs: [] })) }));
vi.mock("@/lib/experience/site-related", () => ({ relatedSiteExperienceCards: vi.fn(async () => state.related) }));
vi.mock("@/lib/experience-categories-server", () => ({ loadClassificationOf: vi.fn(async () => state.classification) }));
vi.mock("@/lib/ja-people", () => ({ loadPeople: vi.fn(async () => state.people) }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => createElement("span", { "data-track": "experience_view" }) }));
vi.mock("@/components/DetailGallery", () => ({ DesktopGallery: () => null, MobileGallery: () => null }));
vi.mock("@/components/Photo", () => ({ Photo: () => createElement("img", { alt: "" }) }));

import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { SitePublicationPage } from "./SitePublicationPage";

const japanese = { title: "合成の体験", lead: "紹介", description: "説明", language: "日本語", highlights: [], included: ["材料"], notIncluded: ["交通費"], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] };
const offer = (over: Record<string, unknown> = {}) => ({ ...SAMPLE_TERMS.offers[0]!, ...over });
const item = (over: { offers?: unknown[]; english?: Record<string, unknown>; ja?: Record<string, unknown>; publication?: Record<string, unknown> } = {}): SitePublicExperience => ({
  sellerDisclosure: null, hostBio: null,
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
const person = (over: Partial<PublicPerson> = {}): PublicPerson => ({ slug: "suga", name: "菅 倫明", roleJa: "空手指導者", areaJa: "鎌倉", quoteJa: "大丈夫。", introJa: "円覚寺で教えています。", photo: { src: "/p/suga.jpg", altJa: "菅の写真", credit: null }, experienceSlugs: ["detail-sample"], sortOrder: 1, ...over }) as PublicPerson;

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true, groupInquiryEnabled: true, peoplePagesEnabled: true, nihoWebOrigin: "https://niho.example.test" };
  state.classification = { category: "food", area: "kita" };
  state.nextDates = [];
  state.related = [];
  state.people = [];
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
    expect(html).toContain(locale === "ja" ? "エリア" : "Area");
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

  it("says the cancellation terms in their own section before the reviews: one line when the offers agree, each offer's own when they differ", async () => {
    const same = await render(locale);
    const heading = locale === "ja" ? "取消について" : ">Cancellation<";
    expect(same).toContain(heading);
    const section = same.slice(same.indexOf('id="cancellation-heading"'), same.indexOf("</section>", same.indexOf('id="cancellation-heading"')));
    expect(section.match(/<li/g)).toHaveLength(1);
    const a = offer({ id: "a", name: "Morning", cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 } });
    const b = offer({ id: "b", name: "Evening", cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 } });
    const differ = await render(locale, item({ offers: [a, b] }));
    const parts = differ.slice(differ.indexOf('id="cancellation-heading"'), differ.indexOf("</section>", differ.indexOf('id="cancellation-heading"')));
    expect(parts.match(/<li/g)).toHaveLength(2);
    expect(parts).toContain("Morning");
    expect(parts).toContain("Evening");
  });

  it("keeps the booking links and the request flow: the button goes to the booking page, and an approval product says request", async () => {
    const html = await render(locale);
    expect(html).toContain(`href="${prefix}/experiences/detail-sample/book"`);
    expect(html).toContain('id="book"');
    expect(html).toContain(locale === "ja" ? "日にちを選んで予約へ" : "Choose a date");
    const approval = await render(locale, item({ offers: [offer({ acceptanceMode: "APPROVAL" })] }));
    expect(approval).toContain(locale === "ja" ? "申込みを送る" : "Request to book");
    expect(approval).not.toContain(locale === "ja" ? "日にちを選んで予約へ" : "Choose a date");
  });

  it("shows when booking closes and the way to ask about other days in the booking column", async () => {
    state.nextDates = [next];
    const html = await render(locale);
    const aside = html.slice(html.indexOf('<aside id="book"'), html.indexOf("</aside>"));
    expect(aside).toContain(locale === "ja" ? "予約締切：" : "Book by ");
    expect(aside).toContain("6:00 PM JST".replace("6:00 PM", locale === "ja" ? "18:00" : "6:00 PM"));
    expect(aside).toContain(locale === "ja" ? "ほかの日を相談する" : "Ask about other dates");
    expect(aside).toContain(`href="${prefix}/inquiry?`);
    state.nextDates = [];
    expect(await render(locale)).not.toContain(locale === "ja" ? "予約締切：" : "Book by ");
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect(await render(locale)).not.toContain("ほかの日を相談する");
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
    expect(bar).toContain(`href="${prefix}/experiences/detail-sample/book"`);
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
    state.people = [person(), person({ slug: "other", name: "別の人", experienceSlugs: ["elsewhere"] })];
    const one = await render("ja");
    expect(one).toContain("ホストについて");
    expect(one).toContain("Sample Host");
    expect(one).toContain("会いにいく人");
    expect(one).toContain('href="/ja/people/suga"');
    expect(one).toContain("空手指導者・鎌倉");
    expect(one).not.toContain("別の人");
    expect(one.indexOf("Sample Host")).toBeLessThan(one.indexOf("会いにいく人"));
    expect(one.match(/id="host"/g)).toHaveLength(1);
    expect(one).not.toContain("Sample Hostさんに相談する");
    state.people = [person(), person({ slug: "takuya", name: "高浜 拓也" })];
    expect(await render("ja")).toContain("案内する人");
    state.config = { ...state.config, peoplePagesEnabled: false };
    const off = await render("ja");
    expect(off).toContain("菅 倫明");
    expect(off).not.toContain("/ja/people/");
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
