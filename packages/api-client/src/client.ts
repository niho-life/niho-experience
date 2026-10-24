/**
 * NIHO 公開 API のクライアント（docs/api-contract.md）。認証・cookie を使わず、旅行者の入力をログ・URL に載せない。
 *
 * - 一覧・詳細は SSR から読んでよい。残席と checkout はブラウザから読む（checkout はサーバーから代理送信しない）。
 * - 応答の形は信頼境界の外なので、遷移先 URL など危険な値は使う前に確かめる。
 */
import type {
  ExperienceAvailabilityResponse,
  ExperienceCatalogResponse,
  ExperienceCatalogResponseV11,
  ExperienceCatalogResponseV12,
  ExperienceCheckoutError,
  ExperienceCheckoutRequest,
  ExperienceDetailResponse,
  ExperienceDetailResponseV11,
  CheckoutErrorCode,
  OfferId,
  RegionKey,
  ExperienceSiteTheme,
  ExperienceInterfaceCopyResponse,
  SelectedExperienceCatalogResponse,
  SelectedExperienceDetailResponse,
  SelectedExperienceAvailabilityResponse,
  LocalizedCheckoutOutdatedError,
} from "./types.ts";
import { REVIEW_LIMITS, type AskHostError, type AskHostErrorCode, type AskHostRequest, type AskHostResult, type ExperienceCheckoutJourneyFields, type ExperienceReviewsResponse } from "./journey.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ExperienceApiClientOptions = {
  /** NIHO の公開 Web origin（例: https://niho.life）。末尾の `/` は不要。 */
  nihoWebOrigin: string;
  /** 既定は globalThis.fetch。mock は `@niho-experience/api-client/mock` の createMockExperienceFetch。 */
  fetch?: FetchLike;
  /** 1 回の要求の待ち時間の上限（既定 10 秒）。 */
  timeoutMs?: number;
  /**
   * 一覧・詳細（共有キャッシュしてよい公開投影）を読むときだけ fetch に足す設定（例: Next.js の `{ next: { revalidate: 60 } }`）。
   * 省略時は `cache: "no-store"`。残席・checkout には使わない。応答の `Cache-Control` より長く保持しない。
   */
  cacheableReadInit?: RequestInit;
};

export type ReadFailure =
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid_request"; message: string }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ReadResult<T> = { ok: true; data: T } | ReadFailure;

export type CheckoutResult =
  | { ok: true; checkoutUrl: string }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "rejected"; status: number; error: ExperienceCheckoutError; retryAfterSeconds: number | null }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type LocalizedCheckoutResult = CheckoutResult | {
  ok: false;
  kind: "localization_outdated";
  status: 409;
  error: LocalizedCheckoutOutdatedError;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

/** NIHO の Web origin を確かめて正規化する（https・path なし。開発の localhost だけ http を許す）。ホスト API のクライアントも同じ規則。 */
export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("nihoWebOrigin must be https");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("nihoWebOrigin must be an origin without path");
  }
  return url.origin;
}

/**
 * checkout の応答の遷移先として受け付ける URL か。Stripe の Checkout か、NIHO の origin の予約確認ページだけ。
 * 想定外の URL（別ドメイン・javascript: 等）には遷移しない。
 */
export function isAllowedCheckoutRedirect(candidate: string, nihoWebOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.origin === STRIPE_CHECKOUT_ORIGIN) return true;
  return url.origin === normalizeOrigin(nihoWebOrigin) && /^\/living\/[^/]+\/pages\/[^/]+\/bookings\/[^/]+$|^\/experiences\/bookings\/[^/]+$/.test(url.pathname);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CHECKOUT_ERROR_STATUS: Record<CheckoutErrorCode, number> = {
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

const CHECKOUT_ERROR_FIELDS = ["code", "message", "retryable", "field", "questionId", "seatsLeft", "occurrenceReason", "currentTotalYen"];

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isCheckoutError(value: unknown, status: number): value is ExperienceCheckoutError {
  if (!isObject(value) || typeof value.code !== "string" || !Object.prototype.hasOwnProperty.call(CHECKOUT_ERROR_STATUS, value.code)) return false;
  const code = value.code as CheckoutErrorCode;
  return (
    CHECKOUT_ERROR_STATUS[code] === status &&
    Object.keys(value).every((field) => CHECKOUT_ERROR_FIELDS.includes(field)) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    isNullableString(value.field) &&
    isNullableString(value.questionId) &&
    isNullableNonNegativeInteger(value.seatsLeft) &&
    (value.occurrenceReason === null || ["NOT_SCHEDULED", "CUTOFF", "UNAVAILABLE"].includes(String(value.occurrenceReason))) &&
    isNullableNonNegativeInteger(value.currentTotalYen)
  );
}

const ASK_HOST_ERROR_STATUS: Record<AskHostErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INPUT_INVALID: 422,
  UNAVAILABLE: 409,
  RATE_LIMITED: 429,
  SEND_FAILED: 503,
};

/** 予約前の質問（仮契約・journey.ts）の失敗。checkout と同じく閉じた形だけを受ける。 */
function isAskHostError(value: unknown, status: number): value is AskHostError {
  if (!isObject(value) || typeof value.code !== "string" || !Object.prototype.hasOwnProperty.call(ASK_HOST_ERROR_STATUS, value.code)) return false;
  return (
    ASK_HOST_ERROR_STATUS[value.code as AskHostErrorCode] === status &&
    Object.keys(value).every((field) => ["code", "message", "retryable", "field"].includes(field)) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    isNullableString(value.field)
  );
}

function isNonEmptyText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** レビュー 1 件（仮契約・journey.ts）。閉じた形だけを受ける。 */
function isReview(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).length !== 9) return false;
  const reply = value.reply;
  return (
    isNonEmptyText(value.id, 64) &&
    Number.isInteger(value.rating) && (value.rating as number) >= 1 && (value.rating as number) <= 5 &&
    isNonEmptyText(value.body, REVIEW_LIMITS.bodyMaxLength) &&
    Array.isArray(value.tags) && value.tags.length <= 8 && value.tags.every((tag) => isNonEmptyText(tag, REVIEW_LIMITS.tagMaxLength)) &&
    isNonEmptyText(value.displayName, REVIEW_LIMITS.displayNameMaxLength) &&
    (value.originLabel === null || isNonEmptyText(value.originLabel, REVIEW_LIMITS.displayNameMaxLength)) &&
    typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt)) &&
    typeof value.fromBooking === "boolean" &&
    (reply === null || (isObject(reply) && Object.keys(reply).length === 2 && isNonEmptyText(reply.hostName, REVIEW_LIMITS.displayNameMaxLength) && isNonEmptyText(reply.body, REVIEW_LIMITS.bodyMaxLength)))
  );
}

function hasReviewsShape(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).length !== 2) return false;
  const summary = value.summary;
  if (!isObject(summary) || Object.keys(summary).length !== 3 || !Number.isInteger(summary.count) || (summary.count as number) < 0) return false;
  const average = summary.average;
  const validAverage = summary.count === 0 ? average === null : typeof average === "number" && average >= 1 && average <= 5;
  const validTags = Array.isArray(summary.tags) && summary.tags.every((tag) => isObject(tag) && Object.keys(tag).length === 2 && isNonEmptyText(tag.label, REVIEW_LIMITS.tagMaxLength) && Number.isInteger(tag.count) && (tag.count as number) > 0);
  return validAverage && validTags && Array.isArray(value.reviews) && value.reviews.length <= REVIEW_LIMITS.listMaxItems && value.reviews.every(isReview);
}

function hasExperienceCatalogShape(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.experiences) && value.experiences.every((experience) =>
    isObject(experience) && typeof experience.slug === "string" && typeof experience.title === "string" && isObject(experience.provider),
  );
}

function hasExperienceDetailShape(value: unknown): boolean {
  return isObject(value) && isObject(value.experience) &&
    typeof value.experience.slug === "string" && typeof value.experience.title === "string" &&
    isObject(value.experience.provider) && Array.isArray(value.experience.offers) &&
    value.experience.offers.every(isObject);
}

function hasV11ImageObject(value: unknown): boolean {
  return isObject(value) && typeof value.url === "string" && isNullableString(value.alt);
}

function hasV11Image(value: unknown): boolean {
  return value === null || hasV11ImageObject(value);
}

function hasExperienceCatalogV11Shape(value: unknown): boolean {
  return hasExperienceCatalogShape(value) && isObject(value) && Array.isArray(value.experiences) &&
    value.experiences.every((experience) => isObject(experience) && hasV11Image(experience.cover));
}

const EXPERIENCE_SITE_THEMES: readonly ExperienceSiteTheme[] = ["FOOD", "CULTURE", "CRAFT", "OUTDOORS", "LOCAL_LIFE"];

function hasExperienceCatalogV12Shape(value: unknown): boolean {
  return hasExperienceCatalogShape(value) && isObject(value) && Array.isArray(value.experiences) &&
    value.experiences.every((experience) => isObject(experience) && hasV11Image(experience.cover) &&
      Array.isArray(experience.themes) && experience.themes.every((theme) => EXPERIENCE_SITE_THEMES.includes(theme as ExperienceSiteTheme)));
}

function hasExperienceDetailV11Shape(value: unknown): boolean {
  if (!hasExperienceDetailShape(value) || !isObject(value) || !isObject(value.experience)) return false;
  const experience = value.experience;
  return hasV11Image(experience.cover) && Array.isArray(experience.photos) && experience.photos.every(hasV11ImageObject) &&
    Array.isArray(experience.hosts) && experience.hosts.every((host) =>
      isObject(host) && typeof host.displayName === "string" && isNullableString(host.bio) && hasV11Image(host.avatar)) &&
    isObject(experience.provider) && hasV11Image(experience.provider.logo);
}

function hasAvailabilityShape(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.occurrences) && value.occurrences.every((occurrence) =>
    isObject(occurrence) && typeof occurrence.offerId === "string" && typeof occurrence.date === "string" &&
    typeof occurrence.bookable === "boolean" && Number.isInteger(occurrence.seatsLeft),
  );
}

const RELEASE_ID = /^.{1,200}$/s;
const TERMS_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

function hasSelectedIdentity(value: Record<string, unknown>): boolean {
  return typeof value.releaseId === "string" && RELEASE_ID.test(value.releaseId) && value.locale === "ja";
}

function hasInterfaceCopyShape(value: unknown): boolean {
  if (!isObject(value) || !hasSelectedIdentity(value) || value.schemaVersion !== 2 || !isObject(value.values)) return false;
  const entries = Object.entries(value.values);
  return entries.length === 342 && entries.every(([key, text]) => key.length > 0 && typeof text === "string" && text.length <= 2_000);
}

function hasSelectedCatalogShape(value: unknown): boolean {
  return isObject(value) && hasSelectedIdentity(value) && value.displayLocale === "ja" &&
    (value.copySchemaVersion === 1 || value.copySchemaVersion === 2) && hasExperienceCatalogV11Shape(value);
}

function hasSelectedDetailShape(value: unknown): boolean {
  if (!isObject(value) || !hasSelectedIdentity(value) || value.displayLocale !== "ja" ||
    (value.copySchemaVersion !== 1 && value.copySchemaVersion !== 2) || !hasExperienceDetailV11Shape(value) || !isObject(value.localization)) return false;
  const localization = value.localization;
  return typeof localization.termsFingerprint === "string" && TERMS_FINGERPRINT.test(localization.termsFingerprint) &&
    typeof localization.bookingReady === "boolean" &&
    (localization.unavailableCopyKey === null || localization.unavailableCopyKey === "booking.unavailableJa");
}

function hasSelectedAvailabilityShape(value: unknown): boolean {
  return isObject(value) && hasSelectedIdentity(value) && value.timeZone === "Asia/Tokyo" && value.windowDays === 90 &&
    typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)) && hasAvailabilityShape(value);
}

export function createExperienceApiClient(options: ExperienceApiClientOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit, cacheable = false): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cacheInit: RequestInit = cacheable && options.cacheableReadInit ? options.cacheableReadInit : { cache: "no-store" };
    try {
      return await fetchImpl(`${origin}${path}`, {
        ...cacheInit,
        ...init,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson<T>(path: string, cacheable: boolean, hasExpectedShape: (body: unknown) => boolean): Promise<ReadResult<T>> {
    const response = await request(path, { method: "GET", headers: { accept: "application/json" } }, cacheable);
    if (!response) return { ok: false, kind: "network_error" };
    if (response.status === 404) return { ok: false, kind: "not_found" };
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      const message = isObject(body) && isObject(body.error) && typeof body.error.message === "string" ? body.error.message : "invalid request";
      return { ok: false, kind: "invalid_request", message };
    }
    if (response.status !== 200) return { ok: false, kind: "unexpected_response", status: response.status };
    const body: unknown = await response.json().catch(() => undefined);
    if (!hasExpectedShape(body)) return { ok: false, kind: "unexpected_response", status: response.status };
    return { ok: true, data: body as T };
  }

  return {
    /** 選択済み日本語 release の全342 UI文言。共有cacheへ置かない。 */
    getJapaneseSiteCopy(): Promise<ReadResult<ExperienceInterfaceCopyResponse>> {
      return readJson("/api/public/experiences/v1.2/ja/site", false, hasInterfaceCopyShape);
    },

    /** 同一 release に参加している日本語の一覧だけを返す。 */
    listJapaneseExperiences(params: { region?: RegionKey } = {}): Promise<ReadResult<SelectedExperienceCatalogResponse>> {
      const query = params.region ? `?region=${encodeURIComponent(params.region)}` : "";
      return readJson(`/api/public/experiences/v1.2/ja/catalog${query}`, false, hasSelectedCatalogShape);
    },

    /** 現行の公開投影へ、選択済み release の日本語だけを重ねた詳細。 */
    getJapaneseExperience(slug: string): Promise<ReadResult<SelectedExperienceDetailResponse>> {
      return readJson(`/api/public/experiences/v1.2/ja/${encodeURIComponent(slug)}`, false, hasSelectedDetailShape);
    },

    /** 日本語 release 対象 offer の現行残席。 */
    getJapaneseAvailability(slug: string, params: { offerId?: OfferId } = {}): Promise<ReadResult<SelectedExperienceAvailabilityResponse>> {
      const query = params.offerId ? `?offerId=${encodeURIComponent(params.offerId)}` : "";
      return readJson(`/api/public/experiences/v1.2/ja/${encodeURIComponent(slug)}/availability${query}`, false, hasSelectedAvailabilityShape);
    },

    /** 掲載中の体験の一覧（SSR 可）。 */
    listExperiences(params: { region?: RegionKey } = {}): Promise<ReadResult<ExperienceCatalogResponse>> {
      const query = params.region ? `?region=${encodeURIComponent(params.region)}` : "";
      return readJson(`/api/public/experiences${query}`, true, hasExperienceCatalogShape);
    },

    /** 写真の説明を含む v1.1 の一覧。旧版の閉じた応答とは別 path。 */
    listExperiencesV11(params: { region?: RegionKey } = {}): Promise<ReadResult<ExperienceCatalogResponseV11>> {
      const query = params.region ? `?region=${encodeURIComponent(params.region)}` : "";
      return readJson(`/api/public/experiences/v1.1/catalog${query}`, true, hasExperienceCatalogV11Shape);
    },

    /** テーマ・日本時間の開催予定日で絞る v1.2 一覧。開催・残席を保証しない。 */
    listExperiencesV12(params: { region?: RegionKey; theme?: ExperienceSiteTheme; availableOn?: string } = {}): Promise<ReadResult<ExperienceCatalogResponseV12>> {
      const query = new URLSearchParams();
      if (params.region) query.set("region", params.region);
      if (params.theme) query.set("theme", params.theme);
      if (params.availableOn) query.set("availableOn", params.availableOn);
      const suffix = query.size ? `?${query.toString()}` : "";
      return readJson(`/api/public/experiences/v1.2/catalog${suffix}`, true, hasExperienceCatalogV12Shape);
    },

    /** 体験の詳細（SSR 可）。 */
    getExperience(slug: string): Promise<ReadResult<ExperienceDetailResponse>> {
      return readJson(`/api/public/experiences/${encodeURIComponent(slug)}`, true, hasExperienceDetailShape);
    },

    /** 提供者の紹介と写真の説明を含む v1.1 の詳細。 */
    getExperienceV11(slug: string): Promise<ReadResult<ExperienceDetailResponseV11>> {
      return readJson(`/api/public/experiences/v1.1/${encodeURIComponent(slug)}`, true, hasExperienceDetailV11Shape);
    },

    /** レビューの一覧（新しい順）と集計。SSR でもブラウザからでも読める（仮契約・journey.ts）。 */
    listReviews(slug: string, params: { limit?: number } = {}): Promise<ReadResult<ExperienceReviewsResponse>> {
      const query = params.limit ? `?limit=${encodeURIComponent(String(params.limit))}` : "";
      return readJson(`/api/public/experiences/${encodeURIComponent(slug)}/reviews${query}`, true, hasReviewsShape);
    },

    /** 開催回と残席（ブラウザから。キャッシュしない）。 */
    getAvailability(slug: string, params: { offerId?: OfferId } = {}): Promise<ReadResult<ExperienceAvailabilityResponse>> {
      const query = params.offerId ? `?offerId=${encodeURIComponent(params.offerId)}` : "";
      return readJson(`/api/public/experiences/${encodeURIComponent(slug)}/availability${query}`, false, hasAvailabilityShape);
    },

    /**
     * ゲスト予約の開始（ブラウザから）。成功したら `checkoutUrl` へ遷移する。
     * 通信失敗（`network_error`）は同じ body・同じ `clientRequestKey` で再送してよい。
     */
    async startCheckout(slug: string, body: ExperienceCheckoutRequest & ExperienceCheckoutJourneyFields): Promise<CheckoutResult> {
      const response = await request(`/api/public/experiences/${encodeURIComponent(slug)}/checkout`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response) return { ok: false, kind: "network_error" };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      const parsed: unknown = await response.json().catch(() => undefined);
      if (response.status === 201) {
        const checkoutUrl = isObject(parsed) ? parsed.checkoutUrl : undefined;
        if (typeof checkoutUrl === "string" && isAllowedCheckoutRedirect(checkoutUrl, origin)) {
          return { ok: true, checkoutUrl };
        }
        return { ok: false, kind: "unexpected_response", status: response.status };
      }
      const error = isObject(parsed) ? parsed.error : undefined;
      if (isCheckoutError(error, response.status)) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        return {
          ok: false,
          kind: "rejected",
          status: response.status,
          error,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    },

    /**
     * 予約前の質問（ブラウザから。仮契約・journey.ts）。受け付けたら返事は予約者のメールへ届く。
     * 通信失敗（`network_error`）は同じ body・同じ `clientRequestKey` で再送してよい。
     */
    async askHost(slug: string, body: AskHostRequest): Promise<AskHostResult> {
      const response = await request(`/api/public/experiences/${encodeURIComponent(slug)}/questions`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response) return { ok: false, kind: "network_error" };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      const parsed: unknown = await response.json().catch(() => undefined);
      if (response.status === 201) {
        return isObject(parsed) && parsed.accepted === true && Object.keys(parsed).length === 1 ? { ok: true } : { ok: false, kind: "unexpected_response", status: response.status };
      }
      const error = isObject(parsed) ? parsed.error : undefined;
      if (isAskHostError(error, response.status)) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        return { ok: false, kind: "rejected", status: response.status, error, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    },

    /** locale は path で固定し、backend が release・terms・consent を再照合する。 */
    async startJapaneseCheckout(slug: string, body: ExperienceCheckoutRequest): Promise<LocalizedCheckoutResult> {
      const response = await request(`/api/public/experiences/v1.2/ja/${encodeURIComponent(slug)}/checkout`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response) return { ok: false, kind: "network_error" };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      const parsed: unknown = await response.json().catch(() => undefined);
      if (response.status === 201) {
        const checkoutUrl = isObject(parsed) ? parsed.checkoutUrl : undefined;
        return typeof checkoutUrl === "string" && isAllowedCheckoutRedirect(checkoutUrl, origin)
          ? { ok: true, checkoutUrl }
          : { ok: false, kind: "unexpected_response", status: response.status };
      }
      const error = isObject(parsed) ? parsed.error : undefined;
      if (response.status === 409 && isObject(error) && Object.keys(error).length === 2 && error.code === "LOCALIZATION_OUTDATED" && typeof error.message === "string" && error.message.length <= 2_000) {
        return { ok: false, kind: "localization_outdated", status: 409, error: error as LocalizedCheckoutOutdatedError };
      }
      if (isCheckoutError(error, response.status)) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        return { ok: false, kind: "rejected", status: response.status, error, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    },
  };
}

export type ExperienceApiClient = ReturnType<typeof createExperienceApiClient>;
