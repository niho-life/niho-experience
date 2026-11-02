import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildMockOccurrences, MOCK_AVAILABILITY_WINDOW_DAYS } from "../src/fixtures/availability.ts";
import { toExperienceSummary } from "../src/fixtures/catalog.ts";
import { buildFixtureExperiences, FIXTURE_EXPERIENCE_SITE_ORIGIN } from "../src/fixtures/experiences.ts";
import { buildPilotExperiences, PILOT_CONTENT_STATUS, PILOT_HOST_PHOTOS, PILOT_IMAGE_SPECS, PILOT_SAMPLE_PHOTO_PATH } from "../src/fixtures/pilot-experiences.ts";
import { createExperienceApiClient } from "../src/client.ts";
import { createMockExperienceFetch, isMockCheckoutUrl, type MockCatalog } from "../src/mock/mock-fetch.ts";
import { createContractValidator, findSensitiveValues } from "../src/testing/index.ts";
import type { BookingQuestion } from "../src/types.ts";

const validator = createContractValidator();
const experiences = buildPilotExperiences();

function fingerprint(questions: BookingQuestion[]): string {
  const canonical = questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    description: question.description,
    inputType: question.inputType,
    required: question.required,
    options: question.options.map((option) => ({ id: option.id, label: option.label })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

describe("pilot fixture（テストサイト用・推奨値）", () => {
  it("推奨値であることを示す状態を持つ", () => {
    expect(PILOT_CONTENT_STATUS).toBe("provisional");
  });

  it("詳細と一覧が契約の schema を満たす", () => {
    for (const experience of experiences) {
      expect(validator.validateSchema("PublicExperienceDetailResponse", { experience })).toEqual({ ok: true });
    }
    expect(validator.validateSchema("PublicExperienceCatalogResponse", { experiences: experiences.map(toExperienceSummary) })).toEqual({ ok: true });
  });

  it("開催回の mock が契約の schema を満たす", () => {
    const now = new Date("2026-10-19T00:00:00.000Z");
    for (const experience of experiences) {
      const occurrences = buildMockOccurrences({ experience, now });
      expect(occurrences.length).toBeGreaterThan(0);
      const response = { generatedAt: now.toISOString(), timeZone: "Asia/Tokyo", windowDays: MOCK_AVAILABILITY_WINDOW_DAYS, occurrences };
      expect(validator.validateSchema("PublicExperienceAvailabilityResponse", response)).toEqual({ ok: true });
    }
  });

  it("個人情報・秘密・内部の保存先らしい値を含まない", () => {
    expect(findSensitiveValues(experiences)).toEqual([]);
  });

  it("slug が一意で、合成 fixture と重ならず、canonical がサイトの体験 URL になっている", () => {
    const slugs = experiences.map((experience) => experience.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const syntheticSlugs = new Set(buildFixtureExperiences().map((experience) => experience.slug));
    for (const experience of experiences) {
      expect(syntheticSlugs.has(experience.slug)).toBe(false);
      expect(experience.canonicalUrl).toBe(`${FIXTURE_EXPERIENCE_SITE_ORIGIN}/experiences/${experience.slug}`);
    }
  });

  it("質問の fingerprint が NIHO と同じ算出で一致する", () => {
    for (const experience of experiences) {
      for (const offer of experience.offers) {
        expect(offer.bookingQuestionsFingerprint).toBe(fingerprint(offer.bookingQuestions));
      }
    }
  });

  it("写真の位置の参照が photos[] の中にある", () => {
    for (const experience of experiences) {
      for (const item of experience.timeline) {
        if (item.photoIndex !== null) expect(item.photoIndex).toBeLessThan(experience.photos.length);
      }
      const exterior = experience.meetingPoint?.exteriorPhotoIndex;
      if (exterior !== undefined && exterior !== null) expect(exterior).toBeLessThan(experience.photos.length);
    }
  });

  it("写真はサイト内の素材だけ（外部 URL を入れていない）", () => {
    const samplePhoto = new RegExp(`^${PILOT_SAMPLE_PHOTO_PATH}/[a-z0-9-]+\\.jpg$`);
    const declared = new Set(
      [
        ...Object.values(PILOT_IMAGE_SPECS)
          .flat()
          .flatMap((spec) => ("samplePhoto" in spec && spec.samplePhoto ? [spec.samplePhoto] : [])),
        ...Object.values(PILOT_HOST_PHOTOS),
      ].map((file) => `${PILOT_SAMPLE_PHOTO_PATH}/${file}`),
    );
    for (const experience of experiences) {
      const urls = [experience.cover, ...experience.photos, ...experience.hosts.map((host) => host.avatar), experience.provider.logo]
        .filter((image) => image !== null)
        .map((image) => image.url);
      for (const url of urls) {
        if (url.startsWith("data:image/svg+xml")) continue;
        expect(url).toMatch(samplePhoto);
        expect(declared.has(url)).toBe(true);
      }
    }
  });

  it("ホストの顔はオーナーが決めた写真だけ（2026-10-20。写真の無いホストは null で、画面は頭文字）", () => {
    const faces = Object.fromEntries(
      experiences.flatMap((experience) => experience.hosts).map((host) => [host.displayName, host.avatar?.url ?? null]),
    );
    expect(faces).toEqual({
      Takuya: `${PILOT_SAMPLE_PHOTO_PATH}/host-takuya.jpg`,
      Hasami: null,
      わか: null,
      Yukino: `${PILOT_SAMPLE_PHOTO_PATH}/host-yukino.jpg`,
      Shiryu: `${PILOT_SAMPLE_PHOTO_PATH}/host-shiryu.jpg`,
    });
  });

  it("集合場所の外観：NIHO は実物の建物の写真、円覚寺は参道の写真（オーナー判断 2026-10-20）", () => {
    for (const experience of experiences) {
      const index = experience.meetingPoint?.exteriorPhotoIndex;
      if (index === undefined || index === null) continue;
      const expected = experience.meetingPoint?.name === "NIHO kamakura" ? "niho-exterior.jpg" : "temple-path.jpg";
      expect(experience.photos[index]?.url).toBe(`${PILOT_SAMPLE_PHOTO_PATH}/${expected}`);
    }
  });

  it("コミュニティディナーは掲載元の写真8枚をすべて使い、集合場所の外観を公開しない", () => {
    const dinner = experiences.find((experience) => experience.slug === "kamakura-community-dinner");
    expect(dinner?.photos.map((photo) => photo.url.replace(`${PILOT_SAMPLE_PHOTO_PATH}/`, ""))).toEqual([
      "niho-cd-table-02.jpg",
      "niho-cd-kitchen-together.jpg",
      "niho-cd-food-trays.jpg",
      "niho-cd-hands-salad.jpg",
      "niho-cd-strawberry-daifuku.jpg",
      "niho-cd-table-01.jpg",
      "niho-dinner-1.jpg",
      "niho-dinner-5.jpg",
    ]);
    expect(dinner?.meetingPointDisclosure).toBe("AFTER_BOOKING");
    expect(dinner?.meetingPoint).toBeNull();
    expect(JSON.stringify(dinner)).not.toContain("niho-exterior.jpg");
  });

  it("Community Dinner reflects the approved offer schedule and terms", async () => {
    const dinner = experiences.find((experience) => experience.slug === "kamakura-community-dinner");
    expect(dinner?.title).toBe("Kamakura Community Dinner with Locals");
    expect(dinner?.offers.map((offer) => ({
      id: offer.id,
      price: offer.pricing.adultPriceYen,
      child: offer.pricing.child,
      startTime: offer.startTime,
      durationMinutes: offer.durationMinutes,
      weekdays: offer.weekdays,
      capacity: offer.capacity,
      maxPartySize: offer.maxPartySize,
      acceptanceMode: offer.acceptanceMode,
      cancellationPolicy: offer.cancellationPolicy,
    }))).toEqual([
      {
        id: "offer_community_dinner",
        price: 30000,
        child: { priceYen: 12000, minAge: 0, maxAge: 17, adultRequired: true },
        startTime: "18:00",
        durationMinutes: 120,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        capacity: 8,
        maxPartySize: 8,
        acceptanceMode: "APPROVAL",
        cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
      },
      {
        id: "offer_community_tea_time",
        price: 15000,
        child: null,
        startTime: "13:00",
        durationMinutes: 120,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        capacity: 8,
        maxPartySize: 8,
        acceptanceMode: "APPROVAL",
        cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
      },
    ]);
    expect(dinner?.offers.every((offer) => offer.bookingQuestions.map((question) => question.prompt).join() === "Notes (allergies, questions)")).toBe(true);
  });

  it("Community Dinnerの公開集合概要に正確な住所・入口・地図を含めない", async () => {
    const client = createExperienceApiClient({
      nihoWebOrigin: "https://niho.life",
      fetch: createMockExperienceFetch({ catalog: "pilot", now: () => new Date("2026-10-19T00:00:00.000Z") }),
    });
    const result = await client.getExperienceV11("kamakura-community-dinner");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.experience).toMatchObject({
      meetingOverview: "In Kamakura's Onarimachi neighborhood, near Kamakura Station.",
      meetingPointDisclosure: "AFTER_BOOKING",
      meetingPoint: null,
    });
    expect(JSON.stringify(result.data.experience)).not.toMatch(/11-12|side entrance|maps\.google/i);
  });

  it("原稿の約束：伝統的な金継ぎと書かず、特定の人に会えると約束しない", () => {
    for (const experience of experiences) {
      const text = [experience.title, experience.lead, experience.description, ...experience.highlights, ...experience.knowBeforeYouGo].join("\n");
      expect(text).not.toMatch(/traditional kintsugi/i);
      expect(text).not.toMatch(/guaranteed to meet|you will meet the head priest/i);
    }
  });
});

describe("mock の catalog（pilot をテストサイトに出す）", () => {
  const now = () => new Date("2026-10-19T00:00:00.000Z");
  const origin = "https://niho.life";

  async function listSlugs(catalog: MockCatalog): Promise<string[]> {
    const client = createExperienceApiClient({ nihoWebOrigin: origin, fetch: createMockExperienceFetch({ catalog, now }) });
    const result = await client.listExperiences({ region: "kamakura" });
    if (!result.ok) throw new Error("list failed");
    return result.data.experiences.map((experience) => experience.slug);
  }

  it("既定は合成 fixture だけ、pilot は pilot だけ、all は両方を返す", async () => {
    const pilotSlugs = experiences.map((experience) => experience.slug).sort();
    const syntheticSlugs = buildFixtureExperiences().map((experience) => experience.slug).sort();
    expect((await listSlugs("synthetic")).sort()).toEqual(syntheticSlugs);
    expect((await listSlugs("pilot")).sort()).toEqual(pilotSlugs);
    expect((await listSlugs("all")).sort()).toEqual([...pilotSlugs, ...syntheticSlugs].sort());
  });

  it("商品 ID が合成 fixture と重ならない（mock の席の仮押さえが混ざらない）", () => {
    const syntheticIds = new Set(buildFixtureExperiences().flatMap((experience) => experience.offers.map((offer) => offer.id)));
    for (const offer of experiences.flatMap((experience) => experience.offers)) expect(syntheticIds.has(offer.id)).toBe(false);
  });

  it("all の mock で pilot の体験の詳細・残席・checkout が動く", async () => {
    const client = createExperienceApiClient({ nihoWebOrigin: origin, fetch: createMockExperienceFetch({ catalog: "all", now }) });
    const detail = await client.getExperience("kamakura-community-dinner");
    if (!detail.ok) throw new Error("detail failed");
    const offer = detail.data.experience.offers[0];
    if (!offer) throw new Error("offer missing");
    const availability = await client.getAvailability("kamakura-community-dinner", { offerId: offer.id });
    if (!availability.ok) throw new Error("availability failed");
    const occurrence = availability.data.occurrences.find((candidate) => candidate.bookable && candidate.seatsLeft >= 2);
    if (!occurrence) throw new Error("no bookable occurrence");
    const result = await client.startCheckout("kamakura-community-dinner", {
      offerId: offer.id,
      occurrenceDate: occurrence.date,
      adultCount: 2,
      childCount: 0,
      expectedTotalYen: offer.pricing.adultPriceYen * 2,
      guestName: "Sample Guest",
      guestEmail: "guest@example.com",
      bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
      consent: { agreedVersion: detail.data.experience.booking.consentVersion },
      clientRequestKey: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isMockCheckoutUrl(result.checkoutUrl)).toBe(true);
  });
});

describe("pilot の開催回（作り物の残席を見せない）", () => {
  it("pilot の体験は満席・残りわずかを作らず、定員どおりの空席にする", async () => {
    const client = createExperienceApiClient({
      nihoWebOrigin: "https://niho.life",
      fetch: createMockExperienceFetch({ catalog: "pilot", now: () => new Date("2026-10-19T00:00:00.000Z") }),
    });
    for (const experience of experiences) {
      for (const offer of experience.offers) {
        const result = await client.getAvailability(experience.slug, { offerId: offer.id });
        if (!result.ok) throw new Error("availability failed");
        for (const occurrence of result.data.occurrences.filter((candidate) => candidate.reason !== "CUTOFF")) {
          expect(occurrence.seatsLeft).toBe(offer.capacity);
          expect(occurrence.bookable).toBe(true);
        }
      }
    }
  });
});
