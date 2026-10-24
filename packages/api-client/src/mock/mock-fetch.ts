/**
 * 合成データを返す fetch（仮契約の mock adapter）。本物の API と同じ path・status・本文の形を返し、同じ契約検証を通す。
 * 決済・DB・ログインは持たない（Stripe へは遷移しない URL を返す）。旅行者の入力はこの関数の中だけで扱い、記録しない。
 */
import { computeExpectedTotalYen } from "../booking-rules.ts";
import { buildMockOccurrences } from "../fixtures/availability.ts";
import { toExperienceSummary } from "../fixtures/catalog.ts";
import { buildFixtureExperiences, FIXTURE_CONSENT_VERSION } from "../fixtures/experiences.ts";
import { ADDED_CONDITIONS, changedConditions, journeyExtrasFor, reviewsResponseFor } from "../fixtures/journey.ts";
import { buildPilotExperiences } from "../fixtures/pilot-experiences.ts";
import { ASK_HOST_INPUT_LIMITS, REVIEW_LIMITS, askHostInputProblem, conditionConsentTexts, isValidGuestPhone, usableConditions, type AskHostErrorCode, type AskHostTopic, type ExperienceConditions } from "../journey.ts";
import type { FetchLike } from "../client.ts";
import type { CheckoutErrorCode, ExperienceCheckoutError, ExperienceDetail, ExperienceDetailV11, ExperienceSiteTheme, ExperienceSummaryV12, Occurrence } from "../types.ts";

export const MOCK_SCENARIOS = [
  "default",
  "gallery-single-photo",
  "gallery-no-photos",
  "empty-catalog",
  "sold-out",
  "slow",
  "network-error",
  "checkout-full",
  "checkout-hold-limit",
  "checkout-price-changed",
  "checkout-questions-changed",
  "checkout-consent-outdated",
  // 参加の条件（仮契約・src/journey.ts）：予約の途中で条件が変わった／足された。最初の checkout が断られ、そのあと詳細（v1.4）は新しい条件を返す。
  "checkout-conditions-outdated",
  "checkout-conditions-added",
  "checkout-rate-limited",
  "checkout-unavailable",
  // 予約前の質問（仮契約・src/journey.ts）。質問の送信だけを失敗させる。
  "ask-rate-limited",
  "ask-unavailable",
  "ask-send-failed",
  // レビュー（仮契約）：一覧の応答だけを失敗させる。
  "reviews-error",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * mock が返す体験の一覧。`synthetic` は架空の合成 fixture、`pilot` は掲載許可のある体験を推奨値で載せた pilot fixture
 * （fixtures/pilot-experiences.ts）、`all` は両方（slug は重ならない）。ブラウザ側は SSR がどちらを出しても動くよう `all` を使う。
 */
export const MOCK_CATALOGS = ["synthetic", "pilot", "all"] as const;
export type MockCatalog = (typeof MOCK_CATALOGS)[number];

export type MockExperienceFetchOptions = {
  scenario?: MockScenario;
  /** 既定は `synthetic`。 */
  catalog?: MockCatalog;
  /** 開催回の基準時刻（既定は呼び出し時の現在時刻）。test で固定する。 */
  now?: () => Date;
  /** `mock-assets/` を配信する URL（省略時は data URI の画像）。 */
  imageBaseUrl?: string;
  /** `slow` のときの遅延（既定 1500ms）。 */
  slowDelayMs?: number;
};

/** mock の checkout が返す遷移先。Stripe の origin だが実在しない。画面はこれを検出して自前の mock 決済画面へ切り替える。 */
const MOCK_CHECKOUT_PREFIX = "https://checkout.stripe.com/c/pay/cs_test_niho_experience_mock_";
const MOCK_CHECKOUT_FRAGMENT = "#niho-mock-checkout";

export function isMockCheckoutUrl(url: string): boolean {
  return url.startsWith(MOCK_CHECKOUT_PREFIX) && url.endsWith(MOCK_CHECKOUT_FRAGMENT);
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const OFFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UTM_PATTERN = /^[a-z0-9_-]{1,64}$/;
const SHARED_CACHE = "public, max-age=60, stale-while-revalidate=300";
const SITE_THEMES: readonly ExperienceSiteTheme[] = ["FOOD", "CULTURE", "CRAFT", "OUTDOORS", "LOCAL_LIFE"];
// Mock tags are explicit fixture data, never inferred from titles or descriptions.
const MOCK_THEMES: Readonly<Record<string, readonly ExperienceSiteTheme[]>> = {
  "home-cooked-dinner-with-locals": ["FOOD", "LOCAL_LIFE"],
  "indigo-dyeing-with-an-artisan": ["CRAFT", "CULTURE"],
  "seaside-cycling-and-market-breakfast": ["OUTDOORS", "FOOD"],
  "evening-pottery-session": ["CRAFT", "CULTURE"],
  "kamakura-community-dinner": ["FOOD", "LOCAL_LIFE"],
  "kamakura-coffee-roasting": ["FOOD", "CRAFT"],
  "engakuji-zen-meditation": ["CULTURE", "LOCAL_LIFE"],
  "kamakura-ceramic-mending": ["CRAFT", "CULTURE"],
  "kamakura-calligraphy": ["CRAFT", "CULTURE"],
};
// Synthetic public copy only; private address and directions stay out of the v1.1 DTO.
const MOCK_MEETING_OVERVIEWS: Readonly<Record<string, string>> = {
  "indigo-dyeing-with-an-artisan": "A small indigo studio in Kamakura.",
};

function json(status: number, body: unknown, cacheControl: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cacheControl, ...extraHeaders },
  });
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

function validationError(message: string): Response {
  return json(400, { error: { code: "VALIDATION_ERROR", message } }, "no-store");
}

const RETRYABLE: ReadonlySet<CheckoutErrorCode> = new Set(["CHECKOUT_UNAVAILABLE", "RATE_LIMITED"]);
const ERROR_STATUS: Record<CheckoutErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INPUT_INVALID: 422,
  CONSENT_OUTDATED: 422,
  OCCURRENCE_INVALID: 422,
  ANSWERS_INVALID: 422,
  UNAVAILABLE: 409,
  FULL: 409,
  HOLD_LIMIT: 409,
  REQUEST_MISMATCH: 409,
  QUESTIONS_CHANGED: 409,
  PRICE_CHANGED: 409,
  RATE_LIMITED: 429,
  CHECKOUT_UNAVAILABLE: 503,
};

function checkoutError(code: CheckoutErrorCode, extra: Partial<Omit<ExperienceCheckoutError, "code" | "message" | "retryable">> = {}): Response {
  const error: ExperienceCheckoutError = {
    code,
    message: `mock: ${code}`,
    retryable: RETRYABLE.has(code),
    field: extra.field ?? null,
    questionId: extra.questionId ?? null,
    seatsLeft: extra.seatsLeft ?? null,
    occurrenceReason: extra.occurrenceReason ?? null,
    currentTotalYen: extra.currentTotalYen ?? null,
  };
  return json(ERROR_STATUS[code], { error }, "no-store", code === "RATE_LIMITED" ? { "retry-after": "120" } : {});
}

const ASK_ERROR_STATUS: Record<AskHostErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INPUT_INVALID: 422,
  UNAVAILABLE: 409,
  RATE_LIMITED: 429,
  SEND_FAILED: 503,
};

/** 予約前の質問の失敗（仮契約）。checkout と同じく `error` の閉じた本文。 */
function askError(code: AskHostErrorCode, field: string | null = null): Response {
  const error = { code, message: `mock: ${code}`, retryable: code === "RATE_LIMITED" || code === "SEND_FAILED", field };
  return json(ASK_ERROR_STATUS[code], { error }, "no-store", code === "RATE_LIMITED" ? { "retry-after": "90" } : {});
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 500;
}

function toV11(experience: ExperienceDetail): ExperienceDetailV11 {
  const withAlt = (image: { url: string } | null, alt: string | null) => image ? { url: image.url, alt } : null;
  return {
    ...experience,
    cover: withAlt(experience.cover, experience.title),
    photos: experience.photos.map((image, index) => ({ ...image, alt: `${experience.title} ${index + 1}` })),
    hosts: experience.hosts.map((host) => ({ ...host, avatar: withAlt(host.avatar, null), bio: null })),
    provider: { ...experience.provider, logo: withAlt(experience.provider.logo, null) },
    meetingOverview: MOCK_MEETING_OVERVIEWS[experience.slug] ?? null,
  };
}

function withGalleryScenario(experience: ExperienceDetail, scenario: MockScenario): ExperienceDetail {
  if (scenario === "gallery-no-photos") return { ...experience, cover: null, photos: [] };
  if (scenario === "gallery-single-photo") return { ...experience, photos: [] };
  return experience;
}

function toV12Summary(experience: ExperienceDetail): ExperienceSummaryV12 {
  const summary = toExperienceSummary(experience);
  return {
    ...summary,
    cover: toV11(experience).cover,
    themes: [...(MOCK_THEMES[experience.slug] ?? [])],
  };
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type HoldRecord = { contentKey: string; url: string; offerId: string; date: string; seats: number };

export function createMockExperienceFetch(options: MockExperienceFetchOptions = {}): FetchLike {
  const scenario = options.scenario ?? "default";
  const now = options.now ?? (() => new Date());
  const catalog = options.catalog ?? "synthetic";
  const synthetic = catalog === "pilot" ? [] : buildFixtureExperiences(options.imageBaseUrl ? { imageBaseUrl: options.imageBaseUrl } : {});
  const pilot = catalog === "synthetic" ? [] : buildPilotExperiences();
  const pilotSlugs = new Set(pilot.map((experience) => experience.slug));
  const experiences = [...pilot, ...synthetic];
  const holds = new Map<string, HoldRecord>();
  let checkoutCounter = 0;
  let priceChangeApplied = false;
  // 参加の条件が「予約の途中で変わった」状態に入ったか（scenario の checkout-conditions-*。最初の checkout を断ったあとに true）。
  let conditionsChanged = false;

  /** この体験の今の参加の条件（同意の文を含む）。scenario によっては、最初の checkout のあとに変わる。 */
  function currentConditions(slug: string): ExperienceConditions | null {
    const base = usableConditions(journeyExtrasFor(slug).conditions);
    if (!conditionsChanged) return base;
    if (scenario === "checkout-conditions-added") return base ? base : ADDED_CONDITIONS;
    if (scenario === "checkout-conditions-outdated" && base) return changedConditions(base);
    return base;
  }

  function heldSeats(): Map<string, number> {
    const seats = new Map<string, number>();
    for (const hold of holds.values()) {
      const key = `${hold.offerId}|${hold.date}`;
      seats.set(key, (seats.get(key) ?? 0) + hold.seats);
    }
    return seats;
  }

  function occurrencesFor(experience: ExperienceDetail): Occurrence[] {
    return buildMockOccurrences({
      experience,
      now: now(),
      seatPolicy: scenario === "sold-out" ? "sold-out" : pilotSlugs.has(experience.slug) ? "open" : "varied",
      heldSeats: heldSeats(),
    });
  }

  function handleCheckout(experience: ExperienceDetail, body: unknown, doNotTrack: boolean): Response {
    if (!isObject(body)) return checkoutError("VALIDATION_ERROR");
    switch (scenario) {
      case "checkout-rate-limited":
        return checkoutError("RATE_LIMITED");
      case "checkout-unavailable":
        return checkoutError("CHECKOUT_UNAVAILABLE");
      case "checkout-hold-limit":
        return checkoutError("HOLD_LIMIT");
      case "checkout-questions-changed":
        return checkoutError("QUESTIONS_CHANGED");
      case "checkout-consent-outdated":
        return checkoutError("CONSENT_OUTDATED", { field: "consent.agreedVersion" });
      default:
        break;
    }

    const offer = experience.offers.find((candidate) => candidate.id === body.offerId);
    if (!offer) return checkoutError("INPUT_INVALID", { field: "offerId" });
    if (!experience.booking.checkoutAvailable) return checkoutError("UNAVAILABLE");
    if (!isObject(body.consent) || body.consent.agreedVersion !== FIXTURE_CONSENT_VERSION) {
      return checkoutError("CONSENT_OUTDATED", { field: "consent.agreedVersion" });
    }
    // 仮契約（src/journey.ts・下書きの契約 1.4.0）：同意の文がある条件を持つ体験は、同意した版を確かめる。送られた版が今の版と違えば
    // （条件が無くなった体験も）CONSENT_OUTDATED、同意の文があるのに無ければ INPUT_INVALID。画面は詳細（v1.4）を読み直して同意し直す。
    const conditions = currentConditions(experience.slug);
    const consentTexts = conditionConsentTexts(conditions);
    const consented = isObject(body.conditionsConsent) && typeof body.conditionsConsent.version === "string" ? body.conditionsConsent.version : null;
    if (body.conditionsConsent !== undefined && consented === null) return checkoutError("INPUT_INVALID", { field: "conditionsConsent" });
    if (!conditionsChanged && scenario === "checkout-conditions-outdated" && consentTexts.length > 0) {
      conditionsChanged = true;
      return checkoutError("CONSENT_OUTDATED", { field: "conditionsConsent.version" });
    }
    if (!conditionsChanged && scenario === "checkout-conditions-added" && consentTexts.length === 0 && consented === null) {
      conditionsChanged = true;
      return checkoutError("INPUT_INVALID", { field: "conditionsConsent" });
    }
    if (consented !== null && consented !== (conditions?.version ?? null)) return checkoutError("CONSENT_OUTDATED", { field: "conditionsConsent.version" });
    if (consented === null && consentTexts.length > 0) return checkoutError("INPUT_INVALID", { field: "conditionsConsent" });
    if (body.guestPhone !== undefined && (typeof body.guestPhone !== "string" || !isValidGuestPhone(body.guestPhone))) {
      return checkoutError("INPUT_INVALID", { field: "guestPhone" });
    }
    if (typeof body.clientRequestKey !== "string" || body.clientRequestKey.length < 8 || body.clientRequestKey.length > 120) {
      return checkoutError("INPUT_INVALID", { field: "clientRequestKey" });
    }
    if (typeof body.guestName !== "string" || body.guestName.trim().length === 0 || body.guestName.length > 100) {
      return checkoutError("INPUT_INVALID", { field: "guestName" });
    }
    if (typeof body.guestEmail !== "string" || !EMAIL_PATTERN.test(body.guestEmail) || body.guestEmail.length > 254) {
      return checkoutError("INPUT_INVALID", { field: "guestEmail" });
    }
    if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > 500)) {
      return checkoutError("INPUT_INVALID", { field: "note" });
    }
    for (const field of ["utmSource", "utmMedium", "utmCampaign", "utmContent"] as const) {
      if (body[field] !== undefined && (typeof body[field] !== "string" || !UTM_PATTERN.test(body[field]))) {
        return checkoutError("INPUT_INVALID", { field });
      }
    }
    if (!isCount(body.adultCount)) return checkoutError("INPUT_INVALID", { field: "adultCount" });
    if (!isCount(body.childCount)) return checkoutError("INPUT_INVALID", { field: "childCount" });
    const headCount = body.adultCount + body.childCount;
    if (headCount < offer.minimumParticipants || headCount > offer.maxPartySize) return checkoutError("INPUT_INVALID", { field: "adultCount" });
    if (body.childCount > 0 && offer.pricing.child?.adultRequired && body.adultCount < 1) {
      return checkoutError("INPUT_INVALID", { field: "adultCount" });
    }
    const total = computeExpectedTotalYen(offer.pricing, body.adultCount, body.childCount);
    if (total === null) return checkoutError("INPUT_INVALID", { field: "childCount" });
    if (scenario === "checkout-price-changed" && !priceChangeApplied) {
      priceChangeApplied = true;
      const updatedOffer = { ...offer, pricing: { ...offer.pricing, adultPriceYen: offer.pricing.adultPriceYen + 500 } };
      const updatedExperience = { ...experience, offers: experience.offers.map((candidate) => candidate.id === offer.id ? updatedOffer : candidate) };
      const index = experiences.findIndex((candidate) => candidate.slug === experience.slug);
      if (index >= 0) experiences[index] = updatedExperience;
      const currentTotalYen = computeExpectedTotalYen(updatedOffer.pricing, body.adultCount, body.childCount);
      return checkoutError("PRICE_CHANGED", { currentTotalYen });
    }
    if (body.expectedTotalYen !== total) return checkoutError("PRICE_CHANGED", { currentTotalYen: total });
    if (body.bookingQuestionsFingerprint !== offer.bookingQuestionsFingerprint) return checkoutError("QUESTIONS_CHANGED");

    if (body.answers !== undefined && !Array.isArray(body.answers)) {
      return checkoutError("ANSWERS_INVALID", { field: "answers" });
    }
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const questionById = new Map(offer.bookingQuestions.map((question) => [question.id, question]));
    const seenQuestionIds = new Set<string>();
    for (const candidate of answers) {
      if (!isObject(candidate) || typeof candidate.questionId !== "string") {
        return checkoutError("ANSWERS_INVALID", { field: "questionId" });
      }
      const question = questionById.get(candidate.questionId);
      if (!question || seenQuestionIds.has(candidate.questionId)) {
        return checkoutError("ANSWERS_INVALID", { questionId: candidate.questionId, field: "questionId" });
      }
      seenQuestionIds.add(candidate.questionId);

      const hasText = Object.prototype.hasOwnProperty.call(candidate, "text");
      const hasOptionIds = Object.prototype.hasOwnProperty.call(candidate, "optionIds");
      if (hasText && hasOptionIds) {
        return checkoutError("ANSWERS_INVALID", { questionId: question.id, field: "answer" });
      }
      if (question.inputType === "SHORT_TEXT" || question.inputType === "LONG_TEXT") {
        if (hasOptionIds || (hasText && typeof candidate.text !== "string")) {
          return checkoutError("ANSWERS_INVALID", { questionId: question.id, field: hasOptionIds ? "optionIds" : "text" });
        }
        if (typeof candidate.text === "string" && candidate.text.length > (question.inputType === "SHORT_TEXT" ? 200 : 1000)) {
          return checkoutError("ANSWERS_INVALID", { questionId: question.id, field: "text" });
        }
      } else {
        if (hasText || (hasOptionIds && !Array.isArray(candidate.optionIds))) {
          return checkoutError("ANSWERS_INVALID", { questionId: question.id, field: hasText ? "text" : "optionIds" });
        }
        if (Array.isArray(candidate.optionIds)) {
          const optionIds = candidate.optionIds;
          const distinctOptionIds = new Set(optionIds);
          const expectedCount = question.inputType === "SINGLE_SELECT" ? 1 : optionIds.length;
          const validOptions = optionIds.every((optionId) =>
            typeof optionId === "string" && question.options.some((option) => option.id === optionId),
          );
          if (
            optionIds.length !== expectedCount || distinctOptionIds.size !== optionIds.length || !validOptions ||
            optionIds.length > question.options.length || optionIds.length > 8
          ) {
            return checkoutError("ANSWERS_INVALID", { questionId: question.id, field: "optionIds" });
          }
        }
      }
    }
    for (const question of offer.bookingQuestions) {
      const answer = answers.find((candidate) => isObject(candidate) && candidate.questionId === question.id);
      const answered = isObject(answer) &&
        ((typeof answer.text === "string" && answer.text.trim().length > 0) || (Array.isArray(answer.optionIds) && answer.optionIds.length > 0));
      if (question.required && !answered) return checkoutError("QUESTIONS_CHANGED", { questionId: question.id });
    }

    const contentKey = JSON.stringify([body.offerId, body.occurrenceDate, body.adultCount, body.childCount, body.guestName, body.guestEmail, body.note ?? null, answers, body.guestPhone ?? null,
      doNotTrack ? null : body.utmSource ?? null, doNotTrack ? null : body.utmMedium ?? null,
      doNotTrack ? null : body.utmCampaign ?? null, doNotTrack ? null : body.utmContent ?? null]);
    const existing = holds.get(body.clientRequestKey);
    if (existing) {
      return existing.contentKey === contentKey ? json(201, { checkoutUrl: existing.url }, "no-store") : checkoutError("REQUEST_MISMATCH");
    }

    const occurrence = occurrencesFor(experience).find(
      (candidate) => candidate.offerId === offer.id && candidate.date === body.occurrenceDate,
    );
    if (!occurrence) return checkoutError("OCCURRENCE_INVALID", { occurrenceReason: "NOT_SCHEDULED" });
    if (occurrence.reason === "CUTOFF") return checkoutError("OCCURRENCE_INVALID", { occurrenceReason: "CUTOFF" });
    if (occurrence.reason === "UNAVAILABLE") return checkoutError("OCCURRENCE_INVALID", { occurrenceReason: "UNAVAILABLE" });
    if (scenario === "checkout-full" || occurrence.seatsLeft < headCount) {
      return checkoutError("FULL", { seatsLeft: scenario === "checkout-full" ? Math.max(0, headCount - 1) : occurrence.seatsLeft });
    }

    checkoutCounter += 1;
    const url = `${MOCK_CHECKOUT_PREFIX}${checkoutCounter}${MOCK_CHECKOUT_FRAGMENT}`;
    holds.set(body.clientRequestKey, { contentKey, url, offerId: offer.id, date: occurrence.date, seats: headCount });
    return json(201, { checkoutUrl: url }, "no-store");
  }

  /** 予約前の質問（仮契約）。受け付けた内容は保持せず、送信先もない。実 API は質問をスレッドとして持ち、予約者へ受付メールを送る（#19319）。 */
  function handleAsk(experience: ExperienceDetail, body: unknown): Response {
    if (!isObject(body)) return askError("VALIDATION_ERROR");
    switch (scenario) {
      case "ask-rate-limited":
        return askError("RATE_LIMITED");
      case "ask-unavailable":
        return askError("UNAVAILABLE");
      case "ask-send-failed":
        return askError("SEND_FAILED");
      default:
        break;
    }
    if (!journeyExtrasFor(experience.slug).questionsOpen) return askError("UNAVAILABLE");
    const key = body.clientRequestKey;
    if (typeof key !== "string" || key.length < ASK_HOST_INPUT_LIMITS.clientRequestKeyMinLength || key.length > ASK_HOST_INPUT_LIMITS.clientRequestKeyMaxLength) {
      return askError("INPUT_INVALID", "clientRequestKey");
    }
    const { topic, message, guestName, guestEmail } = body;
    if (typeof topic !== "string") return askError("INPUT_INVALID", "topic");
    if (typeof message !== "string") return askError("INPUT_INVALID", "message");
    if (typeof guestName !== "string") return askError("INPUT_INVALID", "guestName");
    if (typeof guestEmail !== "string") return askError("INPUT_INVALID", "guestEmail");
    const problem = askHostInputProblem({ topic: topic as AskHostTopic, message, guestName, guestEmail });
    if (problem) return askError("INPUT_INVALID", problem);
    return json(201, { accepted: true }, "no-store");
  }

  async function route(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "api" || segments[1] !== "public" || segments[2] !== "experiences") return notFound();
    const slug = segments[3];
    const tail = segments.slice(4).join("/");

    if (slug === "v1.1" && method === "GET") {
      if (tail === "catalog") {
        const region = url.searchParams.get("region");
        if (region !== null && !REGION_PATTERN.test(region)) return validationError("region is invalid");
        const listed = scenario === "empty-catalog" ? [] : experiences.filter((experience) => region === null || experience.region.key === region);
        return json(200, { experiences: listed.map((experience) => toExperienceSummary(toV11(experience))) }, SHARED_CACHE);
      }
      if (!SLUG_PATTERN.test(tail)) return validationError("experienceSlug is invalid");
      const experience = scenario === "empty-catalog" ? undefined : experiences.find((candidate) => candidate.slug === tail);
      return experience ? json(200, { experience: toV11(withGalleryScenario(experience, scenario)) }, SHARED_CACHE) : notFound();
    }

    if (slug === "v1.4" && method === "GET") {
      if (!SLUG_PATTERN.test(tail)) return validationError("experienceSlug is invalid");
      const experience = scenario === "empty-catalog" ? undefined : experiences.find((candidate) => candidate.slug === tail);
      return experience ? json(200, { experience: { ...toV11(withGalleryScenario(experience, scenario)), conditions: currentConditions(experience.slug) } }, SHARED_CACHE) : notFound();
    }

    if (slug === "v1.2" && method === "GET") {
      if (tail !== "catalog") return notFound();
      const region = url.searchParams.get("region");
      const theme = url.searchParams.get("theme");
      const availableOn = url.searchParams.get("availableOn");
      if (region !== null && !REGION_PATTERN.test(region)) return validationError("region is invalid");
      if (theme !== null && !SITE_THEMES.includes(theme as ExperienceSiteTheme)) return validationError("theme is invalid");
      if (availableOn !== null && !isLocalDate(availableOn)) return validationError("availableOn is invalid");
      const listed = scenario === "empty-catalog" ? [] : experiences.filter((experience) =>
        (region === null || experience.region.key === region) &&
        (theme === null || (MOCK_THEMES[experience.slug] ?? []).includes(theme as ExperienceSiteTheme)) &&
        (availableOn === null || occurrencesFor(experience).some((occurrence) => occurrence.date === availableOn)),
      );
      return json(200, { experiences: listed.map(toV12Summary) }, SHARED_CACHE);
    }

    if (slug === undefined) {
      if (method !== "GET") return notFound();
      const region = url.searchParams.get("region");
      if (region !== null && !REGION_PATTERN.test(region)) return validationError("region is invalid");
      const listed = scenario === "empty-catalog" ? [] : experiences.filter((experience) => region === null || experience.region.key === region);
      return json(200, { experiences: listed.map(toExperienceSummary) }, SHARED_CACHE);
    }

    if (!SLUG_PATTERN.test(slug)) return validationError("experienceSlug is invalid");
    const experience = scenario === "empty-catalog" ? undefined : experiences.find((candidate) => candidate.slug === slug);

    if (tail === "" && method === "GET") {
      return experience ? json(200, { experience: withGalleryScenario(experience, scenario) }, SHARED_CACHE) : notFound();
    }
    if (tail === "availability" && method === "GET") {
      const offerId = url.searchParams.get("offerId");
      if (offerId !== null && !OFFER_ID_PATTERN.test(offerId)) return validationError("offerId is invalid");
      if (!experience) return notFound();
      const occurrences = occurrencesFor(experience).filter((occurrence) => offerId === null || occurrence.offerId === offerId);
      return json(200, { generatedAt: now().toISOString(), timeZone: "Asia/Tokyo", windowDays: 90, occurrences }, "no-store");
    }
    if (tail === "checkout" && method === "POST") {
      if (!experience) return notFound();
      let body: unknown;
      try {
        body = JSON.parse(typeof init?.body === "string" ? init.body : "");
      } catch {
        return checkoutError("VALIDATION_ERROR");
      }
      return handleCheckout(experience, body, new Headers(init?.headers).get("dnt") === "1");
    }
    if (tail === "reviews" && method === "GET") {
      if (!experience) return notFound();
      if (scenario === "reviews-error") return json(503, { error: { code: "UNAVAILABLE", message: "mock: reviews unavailable" } }, "no-store");
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === null ? REVIEW_LIMITS.listMaxItems : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_LIMITS.listMaxItems) return validationError("limit is invalid");
      return json(200, reviewsResponseFor(experience.slug, limit), SHARED_CACHE);
    }
    if (tail === "questions" && method === "POST") {
      if (!experience) return notFound();
      let body: unknown;
      try {
        body = JSON.parse(typeof init?.body === "string" ? init.body : "");
      } catch {
        return askError("VALIDATION_ERROR");
      }
      return handleAsk(experience, body);
    }
    return notFound();
  }

  return async (input, init) => {
    if (scenario === "network-error") throw new TypeError("mock network error");
    if (scenario === "slow") await new Promise((resolve) => setTimeout(resolve, options.slowDelayMs ?? 1500));
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return route(new URL(input), init);
  };
}
