import { describe, expect, it } from "vitest";
import type { ExperienceProviderPagePreviewResponse } from "@niho-experience/api-client/host";
import { buildPreviewView, previewNextDates } from "./preview-model";

const offer = (id: string, patch: Partial<ExperienceProviderPagePreviewResponse["offers"][number]> = {}): ExperienceProviderPagePreviewResponse["offers"][number] => ({
  id, name: `(sample) ${id}`, shortDescription: null, sortOrder: 0, priceYen: 6800, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: false, currency: "JPY",
  capacity: 8, maxPartySize: 4, minimumParticipants: 1, durationMinutes: 120, startTime: "10:00", cancellationPolicy: "FREE_UNTIL_24H", acceptanceMode: "APPROVAL", bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64),
  // Mon 2026-11-02 (two times), Tue 11-03 (full, still a day it runs) and Wed 11-04, JST.
  occurrences: [
    { date: "2026-11-02", startAt: "2026-11-02T01:00:00.000Z", endAt: "2026-11-02T03:00:00.000Z", seatsLeft: 3, bookable: true },
    { date: "2026-11-02", startAt: "2026-11-02T05:00:00.000Z", endAt: "2026-11-02T07:00:00.000Z", seatsLeft: 8, bookable: true },
    { date: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", seatsLeft: 0, bookable: false, reason: "full" },
    { date: "2026-11-04", startAt: "2026-11-04T01:00:00.000Z", endAt: "2026-11-04T03:00:00.000Z", seatsLeft: 8, bookable: true },
  ],
  ...patch,
});

const preview = (patch: Partial<ExperienceProviderPagePreviewResponse["page"]> = {}, offers = [offer("offer_1")]): ExperienceProviderPagePreviewResponse => ({
  page: {
    slug: "sample-walk", kind: "EXPERIENCE", language: "EN", title: "(sample) Morning walk", titleEn: null,
    content: {
      lead: "A slow walk with a local guide.", leadEn: null, facts: { language: "English, with an English-speaking guide", languageEn: null },
      highlights: ["Tea at a quiet temple"], highlightsEn: [null],
      timeline: [{ time: "10:00", title: "Meet", titleEn: null, text: "At the gate.", textEn: null, photoIndex: 1 }],
      description: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", descriptionEn: null,
      included: ["Tea"], includedEn: [null], notIncluded: ["Lunch"], notIncludedEn: [null], notSuitableFor: [], notSuitableForEn: [], knowBeforeYouGo: ["Wear comfortable shoes"], knowBeforeYouGoEn: [null],
    },
    photos: [{ url: "https://images.example.test/cover.jpg" }, { url: "https://images.example.test/second.jpg" }], coverUrl: "https://images.example.test/cover.jpg",
    ...patch,
  },
  spot: { slug: "sample-provider", name: "(sample) Garden House", logoUrl: null, tagline: "Slow days", taglineEn: null, landingGround: "LIGHT", landingAccent: "LEAF", landingFont: "MARU", meetingPoint: null },
  hosts: [{ displayName: "(sample) Yuki", avatarUrl: "/api/media/avatar/yuki" }],
  offers, offer: offers[0]!, occurrences: offers[0]!.occurrences,
} as ExperienceProviderPagePreviewResponse);

describe("host page preview model", () => {
  it("maps an English page onto the experience detail model", () => {
    const { model, booking, japanese, fullyTranslated } = buildPreviewView(preview());
    expect(japanese).toBe(false); expect(fullyTranslated).toBe(true);
    expect(model).toMatchObject({ title: "(sample) Morning walk", lead: "A slow walk with a local guide.", included: ["Tea"], notIncluded: ["Lunch"], know: ["Wear comfortable shoes"], notSuitable: [] });
    expect(model.paragraphs).toEqual(["First paragraph.", "Second paragraph.", "Third paragraph."]);
    expect(model.gallery.photos.map((photo) => photo.image.src)).toEqual(["https://images.example.test/cover.jpg", "https://images.example.test/second.jpg"]);
    expect(model.gallery.photos[1]!.alt).toBe("(sample) Morning walk, photo 2 of 2");
    expect(model.facts.map((fact) => [fact.main, fact.sub])).toEqual([["2 hr", "10:00 AM – 12:00 PM JST"], ["English", "with an English-speaking guide"], ["Up to 4 guests", "small group"]]);
    expect(model.timeline).toMatchObject([{ time: "10:00 AM", title: "Meet", photo: { src: "https://images.example.test/second.jpg" } }]);
    expect(model.schedule).toBe("Mon, Tue & Wed · 10:00 AM");
    expect(model.provider).toMatchObject({ name: "(sample) Garden House", tagline: "Slow days" });
    expect(model.cancellation).toMatchObject({ sellerName: "(sample) Garden House", policy: { title: "Free cancellation until 24 hours before the start" } });
    expect(booking).toMatchObject({ price: "¥6,800", priceIsFrom: false, canBook: true, schedule: "Mon · Tue · Wed · 10:00 AM" });
    expect(booking.assurances[0]).toEqual({ icon: "check", text: "Free cancellation until 24 hours before the start" });
  });
  it("never claims a meeting point: the traveler's line says it is shared after the booking", () => {
    expect(buildPreviewView(preview()).model.meeting).toEqual({ kind: "after-booking" });
  });
  it("shows the next three bookable days without seat counts", () => {
    const rows = previewNextDates(preview().offers[0]!.occurrences);
    expect(rows.map((row) => row.day)).toEqual(["Mon, Nov 2", "Wed, Nov 4"]);
    expect(rows[0]).toEqual({ key: "2026-11-02T01:00:00.000Z", day: "Mon, Nov 2", time: "10:00 AM – 12:00 PM JST" });
    expect(JSON.stringify(rows)).not.toMatch(/seat|left|full/i);
  });
  it("closes the booking card when nothing is bookable (no payout account, or no dates)", () => {
    const closed = offer("offer_1", { occurrences: offer("x").occurrences.map((item) => ({ date: item.date, startAt: item.startAt, endAt: item.endAt, seatsLeft: item.seatsLeft, bookable: false as const, reason: "unavailable" as const })) });
    expect(buildPreviewView(preview({}, [closed])).booking).toMatchObject({ canBook: false, dates: [] });
    expect(buildPreviewView(preview({}, [offer("offer_1", { occurrences: [] })])).model.schedule).toBeUndefined();
  });
  it("summarizes several offers: from-price, mixed policy, the shortest to the longest time", () => {
    const { model, booking } = buildPreviewView(preview({}, [offer("a"), offer("b", { priceYen: 9800, durationMinutes: 180, startTime: "14:00", cancellationPolicy: "NONE", acceptanceMode: "INSTANT", childPriceYen: 3000, childMinAge: 6, childMaxAge: 12 })]));
    expect(booking).toMatchObject({ price: "¥6,800", priceIsFrom: true, childNote: "Children's terms vary by option" });
    expect(model.facts[0]).toMatchObject({ main: "2 hr–3 hr", sub: "Choose a date" });
    expect(model.cancellation.policy).toBeUndefined();
  });
  it("describes children only when every option shares the terms", () => {
    const child = { childPriceYen: 3000, childMinAge: 6, childMaxAge: 12, adultRequiredForChild: true };
    const { booking, model } = buildPreviewView(preview({}, [offer("a", child), offer("b", child)]));
    expect(booking.childNote).toBe("Children 6–12 ¥3,000");
    expect(model.facts[2]).toMatchObject({ sub: "ages 6–12 with an adult" });
  });
  it("uses the English translation of a Japanese page, and says when an item has none", () => {
    const ja = buildPreviewView(preview({ language: "JA", title: "朝の散歩", titleEn: "Morning walk", content: { ...preview().page.content, lead: "ゆっくり歩きます。", leadEn: "A slow walk.", description: "説明", descriptionEn: null } }));
    expect(ja.japanese).toBe(true); expect(ja.fullyTranslated).toBe(false);
    expect(ja.model.title).toBe("Morning walk"); expect(ja.model.lead).toBe("A slow walk."); expect(ja.model.paragraphs).toEqual(["説明"]);
  });
  it("shows only an https avatar, else the initial, and the provider when the page has no host", () => {
    const withHost = buildPreviewView(preview());
    expect(withHost.model.hosts).toEqual([{ name: "(sample) Yuki", initial: "(", image: null }]);
    const https = buildPreviewView({ ...preview(), hosts: [{ displayName: "Yuki", avatarUrl: "https://images.example.test/yuki.jpg" }] });
    expect(https.model.hosts[0]!.image).toEqual({ src: "https://images.example.test/yuki.jpg", alt: "Yuki" });
    const none = buildPreviewView({ ...preview(), hosts: [] });
    expect(none.model.hosts).toEqual([{ name: "(sample) Garden House", initial: "(", image: null }]);
  });
  it("copes with a page that has no photos or timeline", () => {
    const { model } = buildPreviewView(preview({ photos: [], coverUrl: null, content: { ...preview().page.content, timeline: [] } }));
    expect(model.gallery.photos).toEqual([]); expect(model.timeline).toEqual([]); expect(model.provider.photo).toBeNull();
  });
});
