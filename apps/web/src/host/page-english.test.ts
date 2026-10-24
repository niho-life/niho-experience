import { describe, expect, it } from "vitest";
import { experienceContent } from "./editor";
import { MOCK_KITCHEN_EXPERIENCES, MOCK_STUDIO_EXPERIENCES, mockPageEnglishDraft, PREVIEW_PAGE_ENGLISH } from "./mock/experiences";
import {
  applyEnglishDraft,
  changeInTab,
  confirmEnglish,
  contentInTab,
  editsToReplace,
  EMPTY_PAGE_TEXT,
  englishText,
  PAGE_TEXT_FIELDS,
  pageEnglishState,
  publicEnglishBehind,
  textHasWords,
  writeInEnglish,
  writeInJapanese,
} from "./page-english";
import type { HostExperienceContent, HostPageText } from "./types";

const content = (id: string): HostExperienceContent => experienceContent([...MOCK_KITCHEN_EXPERIENCES, ...MOCK_STUDIO_EXPERIENCES].find((experience) => experience.id === id)!);
const DINNER = content("community-dinner");
const CALLIGRAPHY = content("calligraphy");
const KINTSUGI = content("kintsugi");
const status = (page: HostExperienceContent) => pageEnglishState(page)?.status ?? null;

describe("the page's words", () => {
  it("lists every field of a page's words, in the public order", () => {
    expect(Object.keys(englishText(DINNER))).toEqual([...PAGE_TEXT_FIELDS]);
    expect(Object.keys(EMPTY_PAGE_TEXT)).toEqual([...PAGE_TEXT_FIELDS]);
  });

  it("knows Japanese with nothing in it", () => {
    expect(textHasWords(EMPTY_PAGE_TEXT)).toBe(false);
    expect(textHasWords({ ...EMPTY_PAGE_TEXT, highlights: ["", "  "], offers: { a: { name: " ", questions: [""] } } })).toBe(false);
    expect(textHasWords({ ...EMPTY_PAGE_TEXT, offers: { a: { name: "", questions: ["何人ですか"] } } })).toBe(true);
    expect(textHasWords(CALLIGRAPHY.japanese!)).toBe(true);
  });
});

describe("英語の状態 (#110)", () => {
  it("has none for a page written in English", () => {
    expect(pageEnglishState(KINTSUGI)).toBeNull();
  });

  it("reads the samples: Community Dinner confirmed, the calligraphy draft not made yet", () => {
    expect(pageEnglishState(DINNER)).toEqual({ status: "confirmed", changed: [], edited: [] });
    expect(pageEnglishState(CALLIGRAPHY)).toEqual({ status: "none", changed: [], edited: [] });
  });

  it("goes stale when the Japanese of a field changes, and says which", () => {
    const changed = changeInTab(DINNER, "ja", { description: "季節の料理を、地元の人といっしょに。" });
    expect(pageEnglishState(changed)).toEqual({ status: "stale", changed: ["description"], edited: [] });
    // The English stays as it was confirmed: the draft never overwrites it by itself.
    expect(changed.description).toBe(DINNER.description);
    expect(publicEnglishBehind(changed, "live")).toBe(true);
    expect(publicEnglishBehind(changed, "draft")).toBe(false);
    expect(publicEnglishBehind(DINNER, "live")).toBe(false);
  });

  it("is not stale for a row just added, spaces, or Japanese taken away (that field's English stays)", () => {
    const ja = DINNER.japanese!;
    expect(status(changeInTab(DINNER, "ja", { highlights: [...ja.highlights, ""] }))).toBe("confirmed");
    expect(status(changeInTab(DINNER, "ja", { lead: ` ${ja.lead}  ` }))).toBe("confirmed");
    expect(status(changeInTab(DINNER, "ja", { description: "" }))).toBe("confirmed");
    expect(status(changeInTab(DINNER, "ja", { notIncluded: [] }))).toBe("confirmed");
  });

  it("goes back to a draft when the host corrects the English, and is confirmed again with 英語を確定", () => {
    const corrected = changeInTab(DINNER, "en", { lead: "Spend an evening with Kamakura locals." });
    expect(pageEnglishState(corrected)).toEqual({ status: "draft", changed: [], edited: ["lead"] });
    expect(publicEnglishBehind(corrected, "live")).toBe(true);
    const confirmed = confirmEnglish(corrected);
    expect(pageEnglishState(confirmed)).toEqual({ status: "confirmed", changed: [], edited: [] });
    expect(confirmed.lead).toBe("Spend an evening with Kamakura locals.");
  });

  it("lets stale English be corrected and confirmed: it is the English the host checked", () => {
    const stale = changeInTab(DINNER, "ja", { description: "季節の料理を、地元の人といっしょに。" });
    const corrected = changeInTab(stale, "en", { description: "Seasonal food, cooked with locals." });
    expect(pageEnglishState(corrected)).toEqual({ status: "stale", changed: ["description"], edited: ["description"] });
    expect(pageEnglishState(confirmEnglish(corrected))).toEqual({ status: "confirmed", changed: [], edited: [] });
  });

  it("counts adding a step or an offer on the English tab as no correction, and its words as one", () => {
    const step = { id: "local-step-1", time: "20:30", title: "", text: "" };
    const added = changeInTab(DINNER, "en", { timeline: [...DINNER.timeline, step] });
    expect(status(added)).toBe("confirmed");
    const written = changeInTab(added, "en", { timeline: [...DINNER.timeline, { ...step, title: "Dessert" }] });
    expect(pageEnglishState(written)?.edited).toEqual(["timeline"]);
    // Taking a step away is no correction either; the Japanese of that step goes with it.
    const removed = changeInTab(DINNER, "en", { timeline: DINNER.timeline.slice(1) });
    expect(status(removed)).toBe("confirmed");
    expect(Object.keys(removed.japanese!.timeline)).toEqual(["cd-step-2", "cd-step-3", "cd-step-4"]);
  });

  it("leaves the English of a page written in English alone", () => {
    expect(changeInTab(KINTSUGI, "en", { lead: "New." })).toEqual({ ...KINTSUGI, lead: "New." });
    expect(changeInTab(KINTSUGI, "ja", { lead: "New." })).toEqual({ ...KINTSUGI, lead: "New." });
  });
});

describe("the tabs: 日本語で書く and 英語（公開）", () => {
  it("shows the Japanese words with the page's shared parts on 日本語で書く", () => {
    const ja = contentInTab(DINNER, "ja");
    expect(ja.title).toBe("鎌倉の地元の人と囲むコミュニティディナー");
    expect(ja.timeline.map((step) => [step.id, step.time, step.title])).toEqual([
      ["cd-step-1", "18:00", "ウェルカムドリンクとあいさつ"],
      ["cd-step-2", "18:20", "いっしょに作る"],
      ["cd-step-3", "19:15", "座って食べる"],
      ["cd-step-4", "20:00", "おやすみなさい、またはもう一杯のお茶"],
    ]);
    expect(ja.offers.map((offer) => [offer.name, offer.adultPriceYen, offer.questions])).toEqual([
      ["ディナー", 30000, ["食べものの希望があれば教えてください"]],
      ["ティータイム", 15000, []],
    ]);
    expect(ja.meeting).toEqual({ area: "鎌倉駅から歩いて 2 分", entrance: DINNER.japanese!.meeting.entrance, exteriorPhotoUrl: "/sample/photos/niho-exterior.jpg" });
    expect(ja.conditions.ACCESS).toEqual({ access: "STEPS", note: "会場は 2 階で、階段で上がります。" });
    expect(ja.conditions.WEATHER).toEqual({ rain: "INDOOR", note: "" });
    expect(ja.photos).toBe(DINNER.photos);
    expect(contentInTab(DINNER, "en")).toBe(DINNER);
    expect(contentInTab(KINTSUGI, "ja")).toBe(KINTSUGI);
  });

  it("keeps a change of the shared parts on 日本語で書く for both languages, and the words for the Japanese", () => {
    const view = contentInTab(DINNER, "ja");
    // A step added: the English gets the step without words.
    const added = changeInTab(DINNER, "ja", { timeline: [...view.timeline, { id: "local-step-1", time: "20:30", title: "デザート", text: "" }] });
    expect(added.timeline.at(-1)).toEqual({ id: "local-step-1", time: "20:30", title: "", text: "" });
    expect(added.japanese!.timeline["local-step-1"]).toEqual({ title: "デザート", text: "" });
    expect(pageEnglishState(added)?.changed).toEqual(["timeline"]);
    // A time changed on 日本語で書く is the English page's time too.
    const retimed = changeInTab(DINNER, "ja", { timeline: view.timeline.map((step, index) => (index === 0 ? { ...step, time: "17:45" } : step)) });
    expect(retimed.timeline[0]).toEqual({ ...DINNER.timeline[0]!, time: "17:45" });
    expect(status(retimed)).toBe("confirmed");
    // An offer: its price is shared, its name is the tab's.
    const offers = changeInTab(DINNER, "ja", { offers: [{ ...view.offers[0]!, adultPriceYen: 28000, name: "夕食" }, view.offers[1]!, { ...view.offers[1]!, id: "offer-new-1", name: "朝ごはん" }] });
    expect(offers.offers.map((offer) => [offer.id, offer.name, offer.adultPriceYen])).toEqual([
      ["offer-dinner", "Dinner", 28000],
      ["offer-tea", "tea time", 15000],
      ["offer-new-1", "", 15000],
    ]);
    expect(offers.japanese!.offers["offer-dinner"]?.name).toBe("夕食");
    expect(offers.japanese!.offers["offer-new-1"]).toEqual({ name: "朝ごはん", questions: [] });
    // A condition's choice is shared, its note is the tab's; a condition taken away takes its note.
    const conditions = changeInTab(DINNER, "ja", { conditions: { ...view.conditions, AGE: { minimumAge: 10, withAdult: true, note: "10 歳から" }, WEATHER: null } });
    expect(conditions.conditions.AGE).toEqual({ minimumAge: 10, withAdult: true, note: "" });
    expect(conditions.conditions.WEATHER).toBeNull();
    expect(conditions.japanese!.conditions).toMatchObject({ AGE: "10 歳から" });
    expect(conditions.japanese!.conditions).not.toHaveProperty("WEATHER");
    // The meeting: its photo is shared.
    const meeting = changeInTab(DINNER, "ja", { meeting: { ...view.meeting, area: "鎌倉駅すぐ", exteriorPhotoUrl: null } });
    expect(meeting.meeting).toEqual({ ...DINNER.meeting, exteriorPhotoUrl: null });
    expect(meeting.japanese!.meeting.area).toBe("鎌倉駅すぐ");
  });
});

describe("英語の下書きを作る / 作り直す", () => {
  it("takes NIHO's English for each field with Japanese; a field without keeps its English", () => {
    const sent: HostPageText = { ...CALLIGRAPHY.japanese! };
    const english = mockPageEnglishDraft("calligraphy", sent);
    const drafted = applyEnglishDraft(CALLIGRAPHY, sent, english);
    expect([drafted.title, drafted.lead, drafted.dayLanguage, drafted.highlights]).toEqual([
      "Write Your Own Kanji with a Kamakura Calligrapher",
      "Grind your own ink, learn the basic strokes and write the kanji of your choice in a quiet studio near Kamakura Station.",
      "Japanese and English",
      ["Practice the eight basic strokes with a real brush.", "Take home the kanji you wrote, mounted on card."],
    ]);
    expect(drafted.description).toBe("");
    expect(pageEnglishState(drafted)).toEqual({ status: "draft", changed: [], edited: [] });
    expect(pageEnglishState(confirmEnglish(drafted))?.status).toBe("confirmed");
  });

  it("asks about the corrected fields it would replace, and keeps those it would not", () => {
    const corrected = changeInTab(changeInTab(DINNER, "en", { lead: "My own lead." }), "en", { dayLanguage: "Mostly English" });
    const noJapaneseDay = changeInTab(corrected, "ja", { dayLanguage: "" });
    expect(editsToReplace(corrected)).toEqual(["lead", "dayLanguage"]);
    expect(editsToReplace(noJapaneseDay)).toEqual(["lead"]);
    const sent = noJapaneseDay.japanese!;
    const drafted = applyEnglishDraft(noJapaneseDay, sent, mockPageEnglishDraft("community-dinner", sent));
    expect(drafted.lead).toBe(DINNER.lead);
    expect(drafted.dayLanguage).toBe("Mostly English");
    expect(drafted.englishSource.edited).toEqual(["dayLanguage"]);
  });

  it("gives Community Dinner's English back from its Japanese, and one preview sentence for new Japanese", () => {
    const sent = DINNER.japanese!;
    expect(englishText(applyEnglishDraft(DINNER, sent, mockPageEnglishDraft("community-dinner", sent)))).toEqual(englishText(DINNER));
    const stale = changeInTab(DINNER, "ja", { description: "季節の料理を、地元の人といっしょに。", highlights: [...sent.highlights, ""] });
    const draft = mockPageEnglishDraft("community-dinner", stale.japanese!);
    expect(draft.description).toBe(PREVIEW_PAGE_ENGLISH);
    expect(draft.highlights.at(-1)).toBe("");
    // Another experience's Japanese is not this one's.
    expect(mockPageEnglishDraft("calligraphy", sent).title).toBe(PREVIEW_PAGE_ENGLISH);
  });

  it("shows Japanese changed while NIHO drafted as stale at once, and drafts into the page as it is now", () => {
    const sent = changeInTab(DINNER, "ja", { description: "季節の料理を、地元の人といっしょに。" });
    const meanwhile = changeInTab(sent, "ja", { lead: "地元の人と夕ごはん。", timeline: contentInTab(sent, "ja").timeline.slice(0, 2) });
    const drafted = applyEnglishDraft(meanwhile, sent.japanese!, mockPageEnglishDraft("community-dinner", sent.japanese!));
    expect(drafted.description).toBe(PREVIEW_PAGE_ENGLISH);
    expect(drafted.timeline.map((step) => step.id)).toEqual(["cd-step-1", "cd-step-2"]);
    expect(pageEnglishState(drafted)).toEqual({ status: "stale", changed: ["lead"], edited: [] });
  });
});

describe("書く言語", () => {
  it("日本語: the English as it is becomes the confirmed English, and the Japanese starts empty", () => {
    const japanese = writeInJapanese(KINTSUGI);
    expect(japanese.writingLanguage).toBe("ja");
    expect(japanese.japanese).toEqual(EMPTY_PAGE_TEXT);
    expect(pageEnglishState(japanese)).toEqual({ status: "confirmed", changed: [], edited: [] });
    expect(englishText(japanese)).toEqual(englishText(KINTSUGI));
    // Writing Japanese for a field makes its English stale; the others keep their English.
    expect(pageEnglishState(changeInTab(japanese, "ja", { description: "金継ぎの基本を学びます。" }))).toMatchObject({ status: "stale", changed: ["description"] });
  });

  it("English keeps the Japanese, which comes back with 日本語", () => {
    const stale = changeInTab(DINNER, "ja", { description: "季節の料理を、地元の人といっしょに。" });
    const english = writeInEnglish(stale);
    expect(english.writingLanguage).toBe("en");
    expect(pageEnglishState(english)).toBeNull();
    expect(english.japanese).toBe(stale.japanese);
    const back = writeInJapanese(english);
    expect(back.japanese?.description).toBe("季節の料理を、地元の人といっしょに。");
    // Written directly in English meanwhile, the English is the host's: confirmed against the Japanese as it is.
    expect(status(back)).toBe("confirmed");
    expect(writeInJapanese(DINNER)).toBe(DINNER);
    expect(writeInEnglish(KINTSUGI)).toBe(KINTSUGI);
  });
});
