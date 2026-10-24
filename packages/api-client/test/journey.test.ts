import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeExpectedTotalYen } from "../src/booking-rules.ts";
import { createExperienceApiClient } from "../src/client.ts";
import { ADDED_CONDITIONS, changedConditions, journeyExtrasFor, reviewsResponseFor } from "../src/fixtures/journey.ts";
import {
  ASK_HOST_INPUT_LIMITS,
  ASK_HOST_TOPICS,
  CONDITIONS_VERSION_PATTERN,
  EXPERIENCE_CONDITION_KINDS,
  EXPERIENCE_CONDITION_LIMITS,
  NO_JOURNEY_EXTRAS,
  REVIEW_AVERAGE_MIN_COUNT,
  REVIEW_LIMITS,
  askHostInputProblem,
  conditionConsentTexts,
  isValidGuestPhone,
  normalizeGuestPhone,
  usableConditions,
  type AskHostRequest,
  type ExperienceCheckoutJourneyFields,
} from "../src/journey.ts";
import { buildFixtureExperiences } from "../src/fixtures/experiences.ts";
import { buildPilotExperiences } from "../src/fixtures/pilot-experiences.ts";
import { createMockExperienceFetch, type MockScenario } from "../src/mock/index.ts";
import { findSensitiveValues } from "../src/testing/index.ts";
import type { ExperienceCheckoutRequest, ExperienceDetail, Occurrence } from "../src/types.ts";

// 2026-10-19（月）10:00 JST
const NOW = new Date("2026-10-19T01:00:00.000Z");
const ORIGIN = "https://niho.life";

function mockClient(scenario: MockScenario = "default") {
  return createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: createMockExperienceFetch({ scenario, catalog: "all", now: () => NOW }) });
}

const INDIGO = "indigo-dyeing-with-an-artisan";
const CYCLING = "seaside-cycling-and-market-breakfast";
const DINNER = "home-cooked-dinner-with-locals";
const POTTERY = "evening-pottery-session";
const ZEN = "engakuji-zen-meditation";

const ask: AskHostRequest = {
  topic: "CHILDREN",
  message: "Can I join with my 9-year-old daughter? She can sit still for about 20 minutes.",
  guestName: "Sample Guest",
  guestEmail: "guest@example.com",
  clientRequestKey: "11111111-2222-4333-8444-555555555555",
};

describe("参加の条件の fixture", () => {
  const slugs = [INDIGO, CYCLING, POTTERY, ZEN];

  it.each(slugs)("%s: 版と項目が上限に収まり、種類は重ならない", (slug) => {
    const conditions = journeyExtrasFor(slug).conditions!;
    expect(conditions.version).toMatch(CONDITIONS_VERSION_PATTERN);
    expect(conditions.version.length).toBeLessThanOrEqual(EXPERIENCE_CONDITION_LIMITS.versionMaxLength);
    expect(conditions.items.length).toBeGreaterThanOrEqual(1);
    expect(conditions.items.length).toBeLessThanOrEqual(EXPERIENCE_CONDITION_LIMITS.maxItems);
    const kinds = conditions.items.map((item) => item.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const item of conditions.items) {
      expect(EXPERIENCE_CONDITION_KINDS).toContain(item.kind);
      expect(item.headline.length).toBeLessThanOrEqual(EXPERIENCE_CONDITION_LIMITS.headlineMaxLength);
      expect((item.detail ?? "").length).toBeLessThanOrEqual(EXPERIENCE_CONDITION_LIMITS.detailMaxLength);
      expect((item.consentText ?? "").length).toBeLessThanOrEqual(EXPERIENCE_CONDITION_LIMITS.consentTextMaxLength);
    }
  });

  it.each([...slugs, "added"])("%s: 版は NIHO と同じ算出（項目の JSON の SHA-256）で、文を変えると版も変わる", (slug) => {
    const conditions = slug === "added" ? ADDED_CONDITIONS : journeyExtrasFor(slug).conditions!;
    const canonical = conditions.items.map((item) => ({ kind: item.kind, headline: item.headline, detail: item.detail, consentText: item.consentText }));
    expect(conditions.version).toBe(createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"));
  });

  it("scenario の「条件が変わった」は、同意の文と版だけを変える", () => {
    const base = journeyExtrasFor(INDIGO).conditions!;
    const changed = changedConditions(base);
    expect(changed.version).not.toBe(base.version);
    expect(changed.version).toMatch(CONDITIONS_VERSION_PATTERN);
    expect(changed.items.map((item) => item.headline)).toEqual(base.items.map((item) => item.headline));
    expect(conditionConsentTexts(changed)[0]).toBe(`${conditionConsentTexts(base)[0]} · Updated by the host`);
    expect(conditionConsentTexts(changed).slice(1)).toEqual(conditionConsentTexts(base).slice(1));
  });

  it("条件の無い体験・予約を受けていない体験・同意の対象が無い体験が揃っている", () => {
    expect(journeyExtrasFor(DINNER).conditions).toBeNull();
    expect(journeyExtrasFor(DINNER).questionsOpen).toBe(true);
    expect(journeyExtrasFor(POTTERY).questionsOpen).toBe(false);
    expect(conditionConsentTexts(journeyExtrasFor(POTTERY).conditions)).toEqual([]);
    expect(usableConditions(journeyExtrasFor(POTTERY).conditions)).not.toBeNull();
    expect(conditionConsentTexts(journeyExtrasFor(INDIGO).conditions)).toEqual([
      "Ages 10 and up · Children must join with an adult",
      "Standing for a long time (Working with your hands · about 2 hours, with short breaks)",
      "Steps up to the studio",
    ]);
  });

  it("個人情報・連絡先・価格を含まない", () => {
    for (const slug of slugs) expect(findSensitiveValues(journeyExtrasFor(slug))).toEqual([]);
  });

  it("mock の体験すべてで参照でき、実在しない slug でも壊れない", () => {
    const all = [...buildFixtureExperiences(), ...buildPilotExperiences()];
    for (const experience of all) expect(() => journeyExtrasFor(experience.slug)).not.toThrow();
    expect(journeyExtrasFor("no-such-slug")).toEqual({ enabled: true, conditions: null, questionsOpen: true, reviews: { status: "ok", summary: { count: 0, average: null, tags: [] }, items: [] } });
  });

  it("条件が空・版が空なら使えない条件として扱う", () => {
    expect(usableConditions(null)).toBeNull();
    expect(usableConditions({ version: "", items: [{ kind: "AGE", headline: "x", detail: null, consentText: null }] })).toBeNull();
    expect(usableConditions({ version: "v1", items: [] })).toBeNull();
    expect(usableConditions(journeyExtrasFor(ZEN).conditions)).not.toBeNull();
    expect(NO_JOURNEY_EXTRAS).toEqual({ enabled: false, conditions: null, questionsOpen: false, reviews: null });
  });
});

describe("電話番号と質問の入力規則", () => {
  it.each(["+44 7700 900123", "090-1234-5678", "(03) 1234 5678", "0312345678", "+819012345678"])("%s は受ける", (phone) => {
    expect(isValidGuestPhone(phone)).toBe(true);
  });

  it.each(["", "   ", "abc", "12345", "123456", "+44 7700 900123 ext 5", "07700-900-123-456-789-0123", "070+0090", "1".repeat(16), "1234567890123456789012345"])("%j は受けない", (phone) => {
    expect(isValidGuestPhone(phone)).toBe(false);
  });

  it("前後の空白を落とし、続く空白は 1 つにまとめてから見る（24 字・7〜15 桁）", () => {
    expect(normalizeGuestPhone("  +44   7700  900123 ")).toBe("+44 7700 900123");
    expect(isValidGuestPhone("+44      7700      900123")).toBe(true);
    expect(isValidGuestPhone("1234567")).toBe(true);
    expect(isValidGuestPhone("123456789012345")).toBe(true);
    expect(isValidGuestPhone("+81 90 1234 5678 0000 0")).toBe(false);
  });

  it("質問は話題・本文・名前・メールの順に直す項目を返す", () => {
    expect(askHostInputProblem(ask)).toBeNull();
    expect(askHostInputProblem({ ...ask, topic: "SPAM" as never })).toBe("topic");
    expect(askHostInputProblem({ ...ask, message: "  hi " })).toBe("message");
    expect(askHostInputProblem({ ...ask, message: "x".repeat(ASK_HOST_INPUT_LIMITS.messageMaxLength + 1) })).toBe("message");
    expect(askHostInputProblem({ ...ask, guestName: "   " })).toBe("guestName");
    expect(askHostInputProblem({ ...ask, guestEmail: "guest@" })).toBe("guestEmail");
    expect(ASK_HOST_TOPICS).toEqual(["CHILDREN", "FOOD", "ACCESS", "LANGUAGE", "OTHER"]);
  });
});

describe("askHost（仮契約の mock）", () => {
  it("受け付けると ok", async () => {
    expect(await mockClient().askHost(DINNER, ask)).toEqual({ ok: true });
  });

  it("入力の誤りは直す項目つきで返る", async () => {
    const result = await mockClient().askHost(DINNER, { ...ask, guestEmail: "not-an-email" });
    expect(result).toMatchObject({ ok: false, kind: "rejected", status: 422, error: { code: "INPUT_INVALID", field: "guestEmail" } });
  });

  it("clientRequestKey が短いと受けない", async () => {
    const result = await mockClient().askHost(DINNER, { ...ask, clientRequestKey: "short" });
    expect(result).toMatchObject({ ok: false, kind: "rejected", error: { code: "INPUT_INVALID", field: "clientRequestKey" } });
  });

  it("回数の上限は待ち秒数つき、受付停止・送信失敗は理由の code で返る", async () => {
    expect(await mockClient("ask-rate-limited").askHost(DINNER, ask)).toMatchObject({ ok: false, kind: "rejected", status: 429, retryAfterSeconds: 90, error: { code: "RATE_LIMITED", retryable: true } });
    expect(await mockClient("ask-unavailable").askHost(DINNER, ask)).toMatchObject({ ok: false, kind: "rejected", status: 409, error: { code: "UNAVAILABLE" } });
    expect(await mockClient("ask-send-failed").askHost(DINNER, ask)).toMatchObject({ ok: false, kind: "rejected", status: 503, error: { code: "SEND_FAILED", retryable: true } });
  });

  it("質問を受けていない体験・存在しない体験・通信失敗を区別する", async () => {
    expect(await mockClient().askHost(POTTERY, ask)).toMatchObject({ ok: false, kind: "rejected", error: { code: "UNAVAILABLE" } });
    expect(await mockClient().askHost("no-such-experience", ask)).toEqual({ ok: false, kind: "not_found" });
    expect(await mockClient("network-error").askHost(DINNER, ask)).toEqual({ ok: false, kind: "network_error" });
  });

  it("契約に無い形の応答は想定外として扱う", async () => {
    const wrong = (body: unknown, status = 201) => createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: async () => new Response(JSON.stringify(body), { status }) });
    expect(await wrong({ accepted: true, id: "x" }).askHost(DINNER, ask)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    expect(await wrong({ accepted: false }).askHost(DINNER, ask)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    expect(await wrong({ error: { code: "RATE_LIMITED", message: "x", retryable: true, field: null, extra: 1 } }, 429).askHost(DINNER, ask)).toEqual({ ok: false, kind: "unexpected_response", status: 429 });
    expect(await wrong({ error: { code: "RATE_LIMITED", message: "x", retryable: true, field: null } }, 500).askHost(DINNER, ask)).toEqual({ ok: false, kind: "unexpected_response", status: 500 });
  });

  it("旅行者の入力は NIHO 公開 API の path へ cookie なしで POST する", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ accepted: true }), { status: 201 }); } });
    await client.askHost(DINNER, ask);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/public/experiences/${DINNER}/questions`);
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  });
});

describe("checkout の追加項目（仮契約の mock）", () => {
  async function bodyFor(slug: string, extra: ExperienceCheckoutJourneyFields = {}, overrides: Partial<ExperienceCheckoutRequest> = {}): Promise<ExperienceCheckoutRequest & ExperienceCheckoutJourneyFields> {
    const fetchMock = createMockExperienceFetch({ catalog: "all", now: () => NOW });
    const experience = ((await (await fetchMock(`${ORIGIN}/api/public/experiences/${slug}`)).json()) as { experience: ExperienceDetail }).experience;
    const offer = experience.offers[0]!;
    const availability = (await (await fetchMock(`${ORIGIN}/api/public/experiences/${slug}/availability?offerId=${offer.id}`)).json()) as { occurrences: Occurrence[] };
    const occurrence = availability.occurrences.find((candidate) => candidate.bookable && candidate.seatsLeft >= 2)!;
    return {
      offerId: offer.id,
      occurrenceDate: occurrence.date,
      adultCount: 2,
      childCount: 0,
      expectedTotalYen: computeExpectedTotalYen(offer.pricing, 2, 0)!,
      guestName: "Sample Guest",
      guestEmail: "guest@example.com",
      note: null,
      answers: offer.bookingQuestions.filter((question) => question.required).map((question) => ({ questionId: question.id, optionIds: [question.options[0]!.id] })),
      bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
      consent: { agreedVersion: experience.booking.consentVersion },
      clientRequestKey: "11111111-2222-4333-8444-555555555555",
      ...extra,
      ...overrides,
    };
  }

  const version = (slug: string) => journeyExtrasFor(slug).conditions!.version;

  it.each([INDIGO, CYCLING, ZEN])("%s: 同意の対象がある条件は、同意の版つきで予約を始められる", async (slug) => {
    const result = await mockClient().startCheckout(slug, await bodyFor(slug, { conditionsConsent: { version: version(slug) } }));
    expect(result.ok).toBe(true);
  });

  it.each([INDIGO, CYCLING, ZEN])("%s: 同意が無い・版が古いときは予約を始められない", async (slug) => {
    const missing = await mockClient().startCheckout(slug, await bodyFor(slug));
    expect(missing).toMatchObject({ ok: false, kind: "rejected", error: { code: "INPUT_INVALID", field: "conditionsConsent" } });
    const outdated = await mockClient().startCheckout(slug, await bodyFor(slug, { conditionsConsent: { version: "0".repeat(64) } }));
    expect(outdated).toMatchObject({ ok: false, kind: "rejected", error: { code: "CONSENT_OUTDATED", field: "conditionsConsent.version" } });
  });

  it("条件の無い体験に同意の版を付けて送ると、今の版と違うものとして受けない（条件が無くなった体験と同じ）", async () => {
    const result = await mockClient().startCheckout(DINNER, await bodyFor(DINNER, { conditionsConsent: { version: "0".repeat(64) } }));
    expect(result).toMatchObject({ ok: false, kind: "rejected", error: { code: "CONSENT_OUTDATED", field: "conditionsConsent.version" } });
    expect((await mockClient().startCheckout(DINNER, await bodyFor(DINNER))).ok).toBe(true);
  });

  it("形の合わない同意は INPUT_INVALID", async () => {
    const result = await mockClient().startCheckout(INDIGO, await bodyFor(INDIGO, { conditionsConsent: { version: 7 as unknown as string } }));
    expect(result).toMatchObject({ ok: false, kind: "rejected", error: { code: "INPUT_INVALID", field: "conditionsConsent" } });
  });

  it("電話番号は任意で、形が正しいものだけ受ける", async () => {
    expect((await mockClient().startCheckout(DINNER, await bodyFor(DINNER, { guestPhone: "+44 7700 900123" }))).ok).toBe(true);
    const bad = await mockClient().startCheckout(DINNER, await bodyFor(DINNER, { guestPhone: "call me" }));
    expect(bad).toMatchObject({ ok: false, kind: "rejected", error: { code: "INPUT_INVALID", field: "guestPhone" } });
  });

  it("同じ key で電話番号だけ変えた再送は、別の内容として止める", async () => {
    const fetchMock = createMockExperienceFetch({ catalog: "all", now: () => NOW });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    const first = await bodyFor(DINNER, { guestPhone: "+44 7700 900123" });
    expect((await client.startCheckout(DINNER, first)).ok).toBe(true);
    expect((await client.startCheckout(DINNER, first)).ok).toBe(true);
    const changed = await client.startCheckout(DINNER, { ...first, guestPhone: "+44 7700 900999" });
    expect(changed).toMatchObject({ ok: false, kind: "rejected", error: { code: "REQUEST_MISMATCH" } });
  });
});

describe("詳細 v1.4（下書きの契約 1.4.0）の読み取りと、条件が変わる scenario", () => {
  async function checkoutBody(slug: string, fetchMock = createMockExperienceFetch({ catalog: "all", now: () => NOW })): Promise<ExperienceCheckoutRequest & ExperienceCheckoutJourneyFields> {
    const experience = ((await (await fetchMock(`${ORIGIN}/api/public/experiences/${slug}`)).json()) as { experience: ExperienceDetail }).experience;
    const offer = experience.offers[0]!;
    const availability = (await (await fetchMock(`${ORIGIN}/api/public/experiences/${slug}/availability?offerId=${offer.id}`)).json()) as { occurrences: Occurrence[] };
    const occurrence = availability.occurrences.find((candidate) => candidate.bookable && candidate.seatsLeft >= 2)!;
    return {
      offerId: offer.id,
      occurrenceDate: occurrence.date,
      adultCount: 2,
      childCount: 0,
      expectedTotalYen: computeExpectedTotalYen(offer.pricing, 2, 0)!,
      guestName: "Sample Guest",
      guestEmail: "guest@example.com",
      note: null,
      answers: offer.bookingQuestions.filter((question) => question.required).map((question) => ({ questionId: question.id, optionIds: [question.options[0]!.id] })),
      bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
      consent: { agreedVersion: experience.booking.consentVersion },
      clientRequestKey: "11111111-2222-4333-8444-555555555555",
    };
  }

  it("v1.1 の詳細に conditions を足して返す（条件の無い体験は null）", async () => {
    const client = mockClient();
    const v14 = await client.getExperienceV14(INDIGO);
    const v11 = await client.getExperienceV11(INDIGO);
    expect(v14.ok && v11.ok).toBe(true);
    if (!v14.ok || !v11.ok) return;
    expect(v14.data.experience.conditions).toEqual(journeyExtrasFor(INDIGO).conditions);
    const { conditions: _conditions, ...rest } = v14.data.experience;
    expect(rest).toEqual(v11.data.experience);
    const dinner = await client.getExperienceV14(DINNER);
    expect(dinner.ok && dinner.data.experience.conditions).toBeNull();
  });

  it("存在しない体験・不正な slug・通信失敗を区別する", async () => {
    expect(await mockClient().getExperienceV14("no-such-experience")).toEqual({ ok: false, kind: "not_found" });
    expect(await mockClient().getExperienceV14("x")).toMatchObject({ ok: false, kind: "invalid_request" });
    expect(await mockClient("network-error").getExperienceV14(INDIGO)).toEqual({ ok: false, kind: "network_error" });
  });

  it.each([
    ["項目に余分な名前がある", (c: Record<string, unknown>) => { (c.items as Record<string, unknown>[])[0]!.extra = "x"; }],
    ["版が 16 進 64 字でない", (c: Record<string, unknown>) => { c.version = "2026-10-22"; }],
    ["項目が空", (c: Record<string, unknown>) => { c.items = []; }],
    ["項目の種類が重なる", (c: Record<string, unknown>) => { const items = c.items as Record<string, unknown>[]; items[1] = { ...items[1]!, kind: items[0]!.kind }; }],
    ["知らない種類", (c: Record<string, unknown>) => { (c.items as Record<string, unknown>[])[0]!.kind = "PETS"; }],
    ["見出しが空", (c: Record<string, unknown>) => { (c.items as Record<string, unknown>[])[0]!.headline = ""; }],
    ["見出しが 120 字を超える", (c: Record<string, unknown>) => { (c.items as Record<string, unknown>[])[0]!.headline = "x".repeat(EXPERIENCE_CONDITION_LIMITS.headlineMaxLength + 1); }],
    ["conditions の外に余分な名前がある", (c: Record<string, unknown>) => { c.note = "x"; }],
  ])("契約に無い形の conditions は想定外の応答として扱う：%s", async (_name, mutate) => {
    const inner = createMockExperienceFetch({ catalog: "all", now: () => NOW });
    const patched = async (input: string, init?: RequestInit) => {
      const response = await inner(input, init);
      if (!input.includes("/v1.4/")) return response;
      const body = (await response.json()) as { experience: { conditions: Record<string, unknown> } };
      mutate(body.experience.conditions);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: patched });
    expect(await client.getExperienceV14(INDIGO)).toMatchObject({ ok: false, kind: "unexpected_response" });
  });

  it("checkout-conditions-outdated：最初の checkout は断られ、そのあとの詳細は新しい版と文を返す", async () => {
    const fetchMock = createMockExperienceFetch({ scenario: "checkout-conditions-outdated", catalog: "all", now: () => NOW });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    const before = journeyExtrasFor(INDIGO).conditions!;
    const initial = await client.getExperienceV14(INDIGO);
    expect(initial.ok && initial.data.experience.conditions).toEqual(before);

    const body = await checkoutBody(INDIGO, fetchMock);
    const rejected = await client.startCheckout(INDIGO, { ...body, conditionsConsent: { version: before.version } } as ExperienceCheckoutRequest);
    expect(rejected).toMatchObject({ ok: false, kind: "rejected", error: { code: "CONSENT_OUTDATED", field: "conditionsConsent.version" } });

    const after = await client.getExperienceV14(INDIGO);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.experience.conditions).toEqual(changedConditions(before));
    expect(conditionConsentTexts(after.data.experience.conditions)[0]).toContain("Updated by the host");
    // 古い版では何度でも断られ、新しい版なら受ける。
    expect(await client.startCheckout(INDIGO, { ...body, conditionsConsent: { version: before.version } } as ExperienceCheckoutRequest)).toMatchObject({ ok: false, error: { code: "CONSENT_OUTDATED" } });
    const accepted = await client.startCheckout(INDIGO, { ...body, conditionsConsent: { version: after.data.experience.conditions!.version } } as ExperienceCheckoutRequest);
    expect(accepted.ok).toBe(true);
  });

  it("checkout-conditions-added：条件の無い体験で最初の checkout が断られ、そのあとの詳細に同意が要る条件が足される", async () => {
    const fetchMock = createMockExperienceFetch({ scenario: "checkout-conditions-added", catalog: "all", now: () => NOW });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    const first = await client.getExperienceV14(DINNER);
    expect(first.ok && first.data.experience.conditions).toBeNull();

    const body = await checkoutBody(DINNER, fetchMock);
    const rejected = await client.startCheckout(DINNER, body);
    expect(rejected).toMatchObject({ ok: false, kind: "rejected", error: { code: "INPUT_INVALID", field: "conditionsConsent" } });

    const after = await client.getExperienceV14(DINNER);
    expect(after.ok && after.data.experience.conditions).toEqual(ADDED_CONDITIONS);
    expect(await client.startCheckout(DINNER, body)).toMatchObject({ ok: false, error: { code: "INPUT_INVALID", field: "conditionsConsent" } });
    expect((await client.startCheckout(DINNER, { ...body, conditionsConsent: { version: ADDED_CONDITIONS.version } } as ExperienceCheckoutRequest)).ok).toBe(true);
  });

  it("scenario が無ければ、断られても条件は変わらない", async () => {
    const fetchMock = createMockExperienceFetch({ catalog: "all", now: () => NOW });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    const body = await checkoutBody(INDIGO, fetchMock);
    expect(await client.startCheckout(INDIGO, body as ExperienceCheckoutRequest)).toMatchObject({ ok: false, error: { code: "INPUT_INVALID", field: "conditionsConsent" } });
    const after = await client.getExperienceV14(INDIGO);
    expect(after.ok && after.data.experience.conditions).toEqual(journeyExtrasFor(INDIGO).conditions);
  });
});

describe("レビューの fixture と一覧の mock", () => {
  it("12 件（平均を出す）・2 件・1 件・0 件が揃い、新しい順に集計する", () => {
    const indigo = reviewsResponseFor(INDIGO, 50);
    expect(indigo.summary.count).toBe(12);
    expect(indigo.summary.count).toBeGreaterThanOrEqual(REVIEW_AVERAGE_MIN_COUNT);
    expect(indigo.summary.average).toBe(4.9);
    expect(indigo.reviews).toHaveLength(12);
    const dates = indigo.reviews.map((item) => item.publishedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(indigo.summary.tags[0]).toEqual({ label: "Beautiful results", count: 5 });
    expect(reviewsResponseFor(POTTERY, 50).summary).toMatchObject({ count: 2 });
    expect(reviewsResponseFor(CYCLING, 50).summary).toMatchObject({ count: 1, average: 5 });
    expect(reviewsResponseFor(DINNER, 50)).toEqual({ summary: { count: 0, average: null, tags: [] }, reviews: [] });
    // pilot の体験は実在のホストなので、レビューを入れない。
    expect(reviewsResponseFor(ZEN, 50).summary.count).toBe(0);
  });

  it("詳細の SSR は新しい順に 3 件だけ読み、集計は全件", () => {
    const extras = journeyExtrasFor(INDIGO);
    expect(extras.reviews).toMatchObject({ status: "ok", summary: { count: 12 } });
    expect(extras.reviews?.status === "ok" ? extras.reviews.items.map((item) => item.id) : []).toEqual(["rv-indigo-01", "rv-indigo-02", "rv-indigo-03"]);
  });

  it("名前に (sample) が付き、姓・メール・予約の識別子を含まず、上限に収まる", () => {
    for (const slug of [INDIGO, CYCLING, POTTERY]) {
      const { reviews } = reviewsResponseFor(slug, 50);
      for (const item of reviews) {
        expect(item.displayName).toMatch(/\(sample\)$/);
        expect(item.body.length).toBeLessThanOrEqual(REVIEW_LIMITS.bodyMaxLength);
        expect(item.fromBooking).toBe(true);
      }
      expect(findSensitiveValues(reviews)).toEqual([]);
    }
  });

  it("listReviews は集計と一覧を返し、limit を守る", async () => {
    const result = await mockClient().listReviews(INDIGO, { limit: 5 });
    expect(result.ok && result.data.reviews).toHaveLength(5);
    expect(result.ok && result.data.summary.count).toBe(12);
    const all = await mockClient().listReviews(INDIGO);
    expect(all.ok && all.data.reviews).toHaveLength(12);
    const none = await mockClient().listReviews(DINNER);
    expect(none).toEqual({ ok: true, data: { summary: { count: 0, average: null, tags: [] }, reviews: [] } });
  });

  it("不正な limit・存在しない体験・読めない scenario・通信失敗を区別する", async () => {
    expect(await mockClient().listReviews(INDIGO, { limit: 51 })).toMatchObject({ ok: false, kind: "invalid_request" });
    expect(await mockClient().listReviews("no-such-experience")).toEqual({ ok: false, kind: "not_found" });
    expect(await mockClient("reviews-error").listReviews(INDIGO)).toEqual({ ok: false, kind: "unexpected_response", status: 503 });
    expect(await mockClient("network-error").listReviews(INDIGO)).toEqual({ ok: false, kind: "network_error" });
  });

  it("契約に無い形の応答は想定外として扱う", async () => {
    const good = reviewsResponseFor(INDIGO, 2);
    const wrong = (body: unknown) => createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
    expect(await wrong(good).listReviews(INDIGO)).toMatchObject({ ok: true });
    const unexpected = { ok: false, kind: "unexpected_response", status: 200 };
    expect(await wrong({ ...good, extra: 1 }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, summary: { ...good.summary, average: 7 } }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, summary: { count: 0, average: 4, tags: [] }, reviews: [] }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, reviews: [{ ...good.reviews[0], rating: 6 }] }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, reviews: [{ ...good.reviews[0], email: "x@example.com" }] }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, reviews: [{ ...good.reviews[0], publishedAt: "yesterday" }] }).listReviews(INDIGO)).toEqual(unexpected);
    expect(await wrong({ ...good, reviews: [{ ...good.reviews[0], reply: { hostName: "A" } }] }).listReviews(INDIGO)).toEqual(unexpected);
  });
});
