import { describe, expect, it } from "vitest";
import {
  emptyOffer,
  experienceContent,
  listingRequirements,
  listingSummary,
  makeCover,
  moveItem,
  offerChildPriceLabel,
  offerDraft,
  offerFromDraft,
  offerPriceLabel,
  offerScheduleLabel,
  pageTextFromInput,
  pauseListing,
  sameContent,
  submitListing,
  weekdayLabels,
  withdrawListing,
  writtenTitle,
} from "./editor";
import { MOCK_KITCHEN_EXPERIENCES, MOCK_STUDIO_EXPERIENCES } from "./mock/experiences";
import { EMPTY_PAGE_TEXT } from "./page-english";
import type { HostExperience, HostExperienceContent, HostExperiencePhoto, HostOffer, Weekday } from "./types";

const byId = (id: string): HostExperience => [...MOCK_KITCHEN_EXPERIENCES, ...MOCK_STUDIO_EXPERIENCES].find((experience) => experience.id === id)!;
const DINNER: HostOffer = byId("community-dinner").offers[0]!;
const COMPLETE: HostOffer = { ...emptyOffer("offer-x"), name: "Workshop", adultPriceYen: 8800, capacity: 4, startTime: "10:00", durationMinutes: 120, weekdays: [6] };
const PHOTO: HostExperiencePhoto = { id: "p1", url: "/sample/photos/coffee-pour.jpg", alt: "" };
/** A page written in English (the coffee draft's) with the given parts. */
const page = (patch: Partial<HostExperienceContent>): HostExperienceContent => ({ ...experienceContent(byId("coffee")), ...patch });

describe("掲載までに必要", () => {
  it("asks a page with no photo and no offer for the cover and a price", () => {
    expect(listingRequirements(byId("coffee"))).toEqual(["表紙写真", "料金"]);
  });

  it("lists what each offer lacks, once, in the rail's order", () => {
    const offers = [emptyOffer("a"), { ...emptyOffer("b"), adultPriceYen: 5000 }];
    expect(listingRequirements(page({ title: "", photos: [], offers }))).toEqual(["題名", "表紙写真", "料金", "定員", "開催曜日", "開始時刻", "所要時間"]);
    expect(listingRequirements(page({ title: "Roast", photos: [PHOTO], offers: [{ ...COMPLETE, weekdays: [], durationMinutes: null }] }))).toEqual(["開催曜日", "所要時間"]);
  });

  it("is empty once the title, a cover and complete offers are there", () => {
    expect(listingRequirements(page({ title: "Roast", photos: [PHOTO], offers: [COMPLETE] }))).toEqual([]);
    expect(listingRequirements(byId("community-dinner"))).toEqual([]);
    // A blank title counts as none; a price of zero is not a price.
    expect(listingRequirements(page({ title: "   ", photos: [PHOTO], offers: [{ ...COMPLETE, adultPriceYen: 0 }] }))).toEqual(["題名", "料金"]);
  });

  it("asks a page written in Japanese for its Japanese title and its English confirmed (#110)", () => {
    const calligraphy = byId("calligraphy");
    expect(listingRequirements(calligraphy)).toEqual(["表紙写真", "料金", "英語の確定"]);
    expect(writtenTitle(calligraphy)).toBe("鎌倉の書家と、自分の漢字を書く");
    // The English title alone does not name it: the host writes the title in Japanese.
    const untitled = { ...calligraphy, japanese: { ...calligraphy.japanese!, title: " " } };
    expect(listingRequirements(untitled)).toEqual(["題名", "表紙写真", "料金", "英語の確定"]);
    expect(listingRequirements({ ...calligraphy, photos: [PHOTO], offers: [COMPLETE], englishSource: { draftedFrom: null, confirmedFrom: calligraphy.japanese, edited: [] } })).toEqual([]);
    // Written in English, the English is the page's own: nothing to confirm.
    expect(listingRequirements({ ...calligraphy, writingLanguage: "en" })).toEqual(["表紙写真", "料金"]);
  });
});

describe("掲載の状態", () => {
  const TODAY = "2026-10-21";

  it("掲載を申請: a draft or a paused listing goes to review, dated today", () => {
    expect(submitListing({ status: "draft" }, TODAY)).toEqual({ status: "review", requestedOn: TODAY });
    expect(submitListing({ status: "paused", liveSince: "2026-10-12" }, TODAY)).toEqual({ status: "review", liveSince: "2026-10-12", requestedOn: TODAY });
  });

  it("掲載を止める: only a live listing stops", () => {
    expect(pauseListing({ status: "live", liveSince: "2026-10-12" })).toEqual({ status: "paused", liveSince: "2026-10-12" });
    for (const status of ["draft", "review", "paused"] as const) expect(pauseListing({ status })).toEqual({ status });
  });

  it("申請を取り下げる: a listing under review goes back to draft", () => {
    expect(withdrawListing({ status: "review", requestedOn: "2026-10-19" })).toEqual({ status: "draft" });
    expect(withdrawListing({ status: "live", liveSince: "2026-10-12" })).toEqual({ status: "live", liveSince: "2026-10-12" });
  });

  it("leaves listings it does not apply to as they are", () => {
    const live = { status: "live" as const, liveSince: "2026-10-12" };
    expect(submitListing(live, TODAY)).toBe(live);
    const review = { status: "review" as const, requestedOn: "2026-10-19" };
    expect(submitListing(review, TODAY)).toBe(review);
  });
});

describe("申込の設定 rows", () => {
  it("reads an offer as its start, length and capacity, and its adult price", () => {
    expect(offerScheduleLabel(DINNER)).toBe("18:00 · 120分 · 定員8");
    expect(offerPriceLabel(DINNER)).toBe("¥30,000〜");
    expect(offerScheduleLabel(byId("community-dinner").offers[1]!)).toBe("13:00 · 120分 · 定員8");
    expect(offerPriceLabel(byId("community-dinner").offers[1]!)).toBe("¥15,000〜");
  });

  it("adds the child price under the adult one when there is one", () => {
    expect(offerChildPriceLabel(DINNER)).toBe("子ども ¥12,000");
    expect(offerChildPriceLabel({ ...DINNER, childPriceYen: 0 })).toBe("子ども ¥0");
    expect(offerChildPriceLabel({ ...DINNER, childPriceYen: null })).toBeNull();
  });

  it("leaves out what is not set yet", () => {
    expect(offerScheduleLabel({ ...emptyOffer("n"), durationMinutes: 90 })).toBe("90分");
    expect(offerScheduleLabel(emptyOffer("n"))).toBe("日程が未入力");
    expect(offerPriceLabel(emptyOffer("n"))).toBe("料金が未入力");
  });

  it("lists the days from Monday", () => {
    expect(weekdayLabels([2, 4, 6])).toEqual(["火", "木", "土"]);
    expect(weekdayLabels([0, 6])).toEqual(["土", "日"]);
  });

  it("moves an offer up or down, and not past either end", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("takes the dialog's typed values back as an offer", () => {
    expect(offerFromDraft(DINNER.id, offerDraft(DINNER))).toEqual(DINNER);
    const draft = { ...offerDraft(emptyOffer("new")), name: "  Roasting  ", adultPrice: "9800", childPrice: "", capacity: "6", duration: "90", startTime: "14:00", weekdays: [0, 6, 0] as Weekday[], closedDates: ["2026-12-31", "2026-11-03"], questions: [" How strong do you like it? ", ""] };
    expect(offerFromDraft("new", draft)).toEqual({ id: "new", name: "Roasting", adultPriceYen: 9800, childPriceYen: null, capacity: 6, startTime: "14:00", durationMinutes: 90, weekdays: [0, 6], closedDates: ["2026-11-03", "2026-12-31"], questions: ["How strong do you like it?"] });
  });
});

describe("写真", () => {
  const photos = ["a", "b", "c", "d"];

  it("表紙にする moves the photo to the front and keeps the others in order", () => {
    expect(makeCover(photos, 2)).toEqual(["c", "a", "b", "d"]);
    expect(makeCover(photos, 3)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the order alone for the cover itself or a photo that is not there", () => {
    expect(makeCover(photos, 0)).toEqual(photos);
    expect(makeCover(photos, 7)).toEqual(photos);
    expect(makeCover(photos, 0)).not.toBe(photos);
  });
});

describe("the list row's summary", () => {
  it("takes the cover and the first offer's schedule from the page", () => {
    expect(listingSummary(byId("community-dinner"))).toEqual({
      cover: "/sample/photos/niho-cd-table-01.jpg",
      schedule: { weekdays: ["火", "木", "土"], start: "18:00", durationMinutes: 120, capacity: 8, priceFromYen: 30000 },
      missing: [],
    });
    expect(listingSummary(byId("kintsugi"))).toEqual({ cover: null, schedule: { weekdays: ["土", "日"], start: "10:00", durationMinutes: 120, capacity: 4, priceFromYen: 8800 }, missing: [] });
  });

  it("says what a draft still needs, and has no schedule until its first offer is complete", () => {
    expect(listingSummary(byId("coffee"))).toEqual({ cover: null, schedule: null, missing: ["表紙写真", "料金"] });
    expect(listingSummary({ ...page({ title: "Roast", photos: [PHOTO], offers: [{ ...COMPLETE, startTime: "" }] }), status: "draft" })).toEqual({ cover: PHOTO.url, schedule: null, missing: ["開始時刻"] });
    expect(listingSummary(byId("calligraphy")).missing).toEqual(["表紙写真", "料金", "英語の確定"]);
  });
});

describe("保存 shows only when something changed", () => {
  it("compares the content, not the order its fields were written in", () => {
    const page = experienceContent(byId("community-dinner"));
    const rebuilt = { ...page, offers: page.offers.map((offer) => offerFromDraft(offer.id, offerDraft(offer))) };
    expect(sameContent(page, rebuilt)).toBe(true);
    expect(sameContent(page, { ...page, highlights: [...page.highlights, ""] })).toBe(false);
    expect(sameContent(page, { ...page, meeting: { ...page.meeting, exteriorPhotoUrl: null } })).toBe(false);
    expect(sameContent(page, { ...page, photos: makeCover(page.photos, 1) })).toBe(false);
  });

  it("shows for a change of the Japanese, the English's state or a condition alone (#110)", () => {
    const page = experienceContent(byId("community-dinner"));
    expect(sameContent(page, { ...page, japanese: { ...page.japanese!, description: "季節の料理を。" } })).toBe(false);
    expect(sameContent(page, { ...page, englishSource: { ...page.englishSource, edited: ["lead"] } })).toBe(false);
    expect(sameContent(page, { ...page, conditions: { ...page.conditions, WEATHER: null } })).toBe(false);
    expect(sameContent(page, { ...page, writingLanguage: "en" })).toBe(false);
    expect(sameContent(page, { ...page, japanese: { ...page.japanese!, offers: { ...page.japanese!.offers } } })).toBe(true);
  });

  it("keeps only what 保存 sends: no id, slug or listing state", () => {
    expect(Object.keys(experienceContent(byId("kintsugi"))).sort()).toEqual(
      ["conditions", "dayLanguage", "description", "englishSource", "highlights", "included", "japanese", "knowBeforeYouGo", "lead", "meeting", "notIncluded", "notSuitableFor", "offers", "photos", "timeline", "title", "writingLanguage"].sort(),
    );
  });
});

describe("the Japanese a page's English is drafted from, as the browser sends it (#110)", () => {
  const japanese = byId("community-dinner").japanese!;

  it("takes the editor's Japanese as it is", () => {
    expect(pageTextFromInput(japanese)).toEqual(japanese);
    expect(pageTextFromInput(EMPTY_PAGE_TEXT)).toEqual(EMPTY_PAGE_TEXT);
    expect(pageTextFromInput({ ...japanese, description: "あ".repeat(4000), highlights: Array(6).fill("い".repeat(120)) })).not.toBeNull();
  });

  it("refuses anything longer, more, of another shape or keyed by what is not an id or a kind", () => {
    for (const input of [
      null,
      "text",
      { ...japanese, title: "あ".repeat(96) },
      { ...japanese, lead: 42 },
      { ...japanese, highlights: Array(7).fill("い") },
      { ...japanese, knowBeforeYouGo: ["う".repeat(201)] },
      { ...japanese, meeting: { area: "駅前" } },
      { ...japanese, conditions: { RAIN: "雨" } },
      { ...japanese, conditions: { FOOD: "え".repeat(161) } },
      { ...japanese, timeline: { "../x": { title: "", text: "" } } },
      { ...japanese, timeline: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`s${index}`, { title: "", text: "" }])) },
      { ...japanese, timeline: { s1: { title: "お".repeat(61), text: "" } } },
      { ...japanese, offers: { "offer-dinner": { name: "ディナー" } } },
      { ...japanese, offers: { "offer-dinner": { name: "ディナー", questions: Array(6).fill("か") } } },
      { ...japanese, offers: [] },
    ]) {
      expect(pageTextFromInput(input)).toBeNull();
    }
  });

  it("never lets a key reach the prototype", () => {
    const sent = JSON.parse(`{"__proto__": {"name": "x", "questions": []}}`) as unknown;
    const read = pageTextFromInput({ ...japanese, offers: sent });
    expect(Object.getPrototypeOf(read!.offers)).toBe(Object.prototype);
    expect(Object.keys(read!.offers)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });
});
