import { describe, expect, it } from "vitest";
import { buildFixtureExperiences, buildPilotExperiences, toExperienceSummary } from "@niho-experience/api-client/mock";
import { buildCardModel, buildCardModels, cardFaceOf, faceOf, groupSizeLabel, initialOf, shortLanguageNote } from "./card-model";
import { formatClock, scheduleLine, scheduleSummary } from "./schedule";

const pilot = buildPilotExperiences();
const synthetic = buildFixtureExperiences();
const bySlug = (slug: string) => [...pilot, ...synthetic].find((experience) => experience.slug === slug)!;

describe("card display model", () => {
  it("merges the summary with the detail: hosts, group size, schedule (JST) and price", () => {
    const dinner = bySlug("kamakura-community-dinner");
    const card = buildCardModel(toExperienceSummary(dinner), dinner, true);
    // The editor's words replace the host names on the card (lib/themes.ts); the detail page still names every host.
    expect(card.withLabel).toBe("with Takuya & neighbors");
    expect(card.groupLabel).toBe("Up to 8 guests");
    expect(card.scheduleLabel).toBe("Every day · 1:00 PM / 6:00 PM");
    expect(card.priceLabel).toBe("¥15,000");
    expect(card.priceIsFrom).toBe(true);
    expect(card.language).toEqual({ short: "EN · JA", full: "English & Japanese" });
    expect(card.offers).toEqual(
      dinner.offers.map((offer) => ({ id: offer.id, minimumParticipants: offer.minimumParticipants, maxPartySize: offer.maxPartySize })),
    );
  });

  it("keeps pilot-only faces out of live cards, and uses the preview face only without hosts", () => {
    const dinner = bySlug("kamakura-community-dinner");
    expect(buildCardModel(toExperienceSummary(dinner), dinner, true).face).toEqual({ name: "Takuya", initial: "T", image: { url: "/sample/photos/host-takuya.jpg" } });
    const zen = bySlug("engakuji-zen-meditation");
    const liveZenCard = buildCardModel(toExperienceSummary(zen), zen);
    expect(liveZenCard.withLabel).toBe(`with ${zen.provider.name}`);
    expect(liveZenCard.face).toEqual(faceOf(zen));
    const zenCard = buildCardModel(toExperienceSummary(zen), zen, true);
    expect(zenCard.withLabel).toBe("with a Zen priest & guide");
    expect(zenCard.face).toEqual({ name: zen.provider.name, initial: "S", image: { url: "/sample/photos/host-guide.jpg" } });
    expect(faceOf(zen).image).toBeNull();
    expect(zenCard.groupLabel).toBe("Private · 2–4 guests");
    // Hosts in the data win over the editor's face.
    expect(cardFaceOf({ ...zen, hosts: [{ displayName: "Ken", avatar: null }] }, true)).toEqual({ name: "Ken", initial: "K", image: null });
  });

  it("keeps pilot card copy out of live summary fallbacks", () => {
    const dinner = bySlug("kamakura-community-dinner");
    const summary = toExperienceSummary(dinner);
    expect(buildCardModel(summary, null).withLabel).toBe(`with ${summary.provider.name}`);
    expect(buildCardModel(summary, null, true).withLabel).toBe("with Takuya & neighbors");
  });

  it("falls back to the summary when the detail could not be read", () => {
    const summary = toExperienceSummary(bySlug("kamakura-coffee-roasting"));
    const card = buildCardModel(summary, null);
    expect(card).toMatchObject({ slug: summary.slug, title: summary.title, withLabel: `with ${summary.provider.name}`, groupLabel: null, scheduleLabel: null, language: null, offers: [] });
    expect(card.priceLabel).toBe("¥4,500");
  });

  it("keeps catalog order and leaves out nothing when some details are missing", () => {
    const summaries = pilot.map(toExperienceSummary);
    const details = new Map(pilot.slice(0, 2).map((experience) => [experience.slug, experience]));
    const cards = buildCardModels(summaries, details);
    expect(cards.map((card) => card.slug)).toEqual(summaries.map((summary) => summary.slug));
    expect(cards.filter((card) => card.groupLabel === null)).toHaveLength(summaries.length - 2);
  });

  it("marks a price as 'from' when options have different adult prices", () => {
    const cycling = bySlug("seaside-cycling-and-market-breakfast");
    expect(buildCardModel(toExperienceSummary(cycling), cycling).priceIsFrom).toBe(true);
  });
});

describe("display helpers", () => {
  it("shortens the language note for cards", () => {
    expect(shortLanguageNote("English & Japanese")).toBe("EN · JA");
    expect(shortLanguageNote("Japanese & basic English")).toBe("JA · basic EN");
    expect(shortLanguageNote("English (basic) & Japanese")).toBe("basic EN · JA");
    expect(shortLanguageNote("Japanese with English support")).toBe("JA · EN support");
    expect(shortLanguageNote("English, with an English-speaking guide")).toBe("English guide");
    expect(shortLanguageNote("English")).toBe("English");
  });

  it("describes group size from the per-party limit, or as private when every option needs two or more", () => {
    expect(groupSizeLabel([{ capacity: 6, maxPartySize: 2, minimumParticipants: 1 }])).toBe("Up to 2 guests");
    expect(groupSizeLabel([{ capacity: 4, maxPartySize: 4, minimumParticipants: 2 }])).toBe("Private · 2–4 guests");
    expect(groupSizeLabel([])).toBeNull();
  });

  it("summarizes weekdays from Monday and times in 12-hour JST", () => {
    expect(formatClock("18:00")).toBe("6:00 PM");
    expect(formatClock("07:30")).toBe("7:30 AM");
    expect(formatClock("12:05")).toBe("12:05 PM");
    expect(formatClock("00:15")).toBe("12:15 AM");
    expect(scheduleSummary([{ weekdays: [0, 6], startTime: "13:00" }])).toBe("Sat · Sun · 1:00 PM");
    expect(scheduleLine([{ weekdays: [2, 4, 6], startTime: "18:00" }])).toBe("Tue, Thu & Sat · 6:00 PM");
    expect(scheduleLine([{ weekdays: [2, 4, 6], startTime: "18:00" }], { compact: true })).toBe("Tue, Thu & Sat · 6 PM");
    expect(scheduleLine([{ weekdays: [0], startTime: "15:30" }], { compact: true })).toBe("Sun · 3:30 PM");
    expect(scheduleSummary([{ weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: "09:00" }])).toBe("Every day · 9:00 AM");
    expect(scheduleSummary([{ weekdays: [], startTime: "09:00" }])).toBeNull();
    expect(formatClock("18:00", "ja")).toBe("18:00");
    expect(scheduleLine([{ weekdays: [2, 4, 6], startTime: "18:00" }], { locale: "ja" })).toBe("火曜・木曜・土曜 · 18:00");
    expect(scheduleSummary([{ weekdays: [0, 6], startTime: "13:00" }], "ja")).toBe("土曜 · 日曜 · 13:00");
  });

  it("takes the first character of any script as the initial", () => {
    expect(initialOf("takuya")).toBe("T");
    expect(initialOf("わか")).toBe("わ");
    expect(initialOf("  Yukino ")).toBe("Y");
  });
});
