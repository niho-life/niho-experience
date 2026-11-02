/**
 * NIHO のホスト API（体験の提供者の本人向け API と `GET /api/auth/me`）のクライアント。**サーバー専用**。
 *
 * - ホスト本人の ID token を `Authorization: Bearer` で送る。ブラウザから import しない（トークンを持つのはこのサイトのサーバーだけ。
 *   ブラウザは `/host/api/*` の中継を呼ぶ）。cookie は送らず、リダイレクトに従わず、キャッシュしない。
 * - 応答の形は信頼境界の外なので、契約の項目だけを確かめて取り出す（知らない項目は渡さない）。
 * - 失敗は契約の `ExperienceHostErrorResponse` から `{ status, code, reason }`（`reason` は `error.details.reason`）を返し、
 *   体験ページの入力の場所（`field`）・今の slug（`slug`）・公開の前提（`blockers`）・問い合わせ用の ID（`supportId`）があれば足す。
 * - 体験ページの保存（`updateExperienceProviderPage`）と公開（`publishExperienceProviderPage`）は、読んだときの `updatedAt` を
 *   `x-niho-page-updated-at` に載せる（違えば 409 `PAGE_UPDATED`）。
 * - 写真はブラウザが GCS へ直接上げる。サーバーは `createExperienceProviderUploadPolicy` の応答を
 *   `toExperienceProviderPhotoUploadForm` でブラウザへ渡す形にする（ブラウザで送る処理はこのパッケージに無い）。
 */
import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  readMeetingPointResponse,
  readPageDeleteResponse,
  readPageDetail,
  readPageListingResponse,
  readPageListResponse,
  readPageMeetingPointResponse,
  readPageMeetingPointUpdateResponse,
  readPagePreview,
  readUploadPolicy,
  readUploadSignedUrl,
} from "./page-readers.ts";
import {
  EXPERIENCE_PROVIDER_KINDS,
  EXPERIENCE_PROVIDER_MEMBER_ROLES,
  EXPERIENCE_PROVIDER_PAGE_PUBLISH_BLOCKERS,
  EXPERIENCE_PROVIDER_PAGE_UPDATED_AT_HEADER,
  EXPERIENCE_PROVIDER_PAYMENT_READINESS_REASONS,
  EXPERIENCE_PROVIDER_REVIEW_STATUSES,
  type ExperienceHostAuthMe,
  type ExperienceHostErrorCode,
  type ExperienceHostErrorReason,
  type ExperienceProvider,
  type ExperienceProviderConsent,
  type ExperienceProviderDetailResponse,
  type ExperienceProviderListResponse,
  type ExperienceProviderMeetingPoint,
  type ExperienceProviderMeetingPointResponse,
  type ExperienceProviderPageCreateRequest,
  type ExperienceProviderPageDeleteResponse,
  type ExperienceProviderPageDetail,
  type ExperienceProviderPageListingRequest,
  type ExperienceProviderPageListingResponse,
  type ExperienceProviderPageListResponse,
  type ExperienceProviderPageMeetingPointResponse,
  type ExperienceProviderPageMeetingPointUpdateRequest,
  type ExperienceProviderPageMeetingPointUpdateResponse,
  type ExperienceProviderPagePatchRequest,
  type ExperienceProviderPagePreviewResponse,
  type ExperienceProviderPagePublishBlocker,
  type ExperienceProviderPaymentConnectResponse,
  type ExperienceProviderPaymentReadinessReason,
  type ExperienceProviderPaymentReadinessResponse,
  type ExperienceProviderPaymentReuseCandidate,
  type ExperienceProviderPaymentReuseCandidatesResponse,
  type ExperienceProviderPaymentReuseRequest,
  type ExperienceProviderRegisterRequest,
  type ExperienceProviderRegisterResponse,
  type ExperienceProviderResponse,
  type ExperienceProviderPhotoUploadForm,
  type ExperienceProviderSubmitResponse,
  type ExperienceProviderUpdateRequest,
  type ExperienceProviderUploadPolicyRequest,
  type ExperienceProviderUploadPolicyResponse,
  type ExperienceProviderUploadSignedUrlRequest,
  type ExperienceProviderUploadSignedUrlResponse,
  type ExperienceProviderWithMemberRole,
} from "./types.ts";

export type ExperienceHostApiClientOptions = {
  /** NIHO の Web origin（例: https://niho.life）。公開クライアントと同じ規則で確かめる。 */
  nihoWebOrigin: string;
  /** NIHO がscopeと期限を検証する app-connect Web access token。ログ・URL・ブラウザへ出さない。 */
  accessToken: string;
  /** 既定は globalThis.fetch。mock は `@niho-experience/api-client/host/mock` の createMockExperienceHostFetch。 */
  fetch?: FetchLike;
  /** 1 回の要求（応答の本文を読み終えるまで）の待ち時間の上限（既定 10 秒）。 */
  timeoutMs?: number;
};

/** 契約に書かれた理由はその型で、書かれていない理由も文字列のまま渡す。 */
export type ExperienceHostApiErrorReason = ExperienceHostErrorReason | (string & {});
/** 契約に書かれたコードはその型で、書かれていないコードも文字列のまま渡す。 */
export type ExperienceHostApiErrorCode = ExperienceHostErrorCode | (string & {});

/** NIHO が `ExperienceHostErrorResponse` で断った（400 / 401 / 403 / 404 / 409 / 422 / 503）。 */
export type ExperienceHostApiError = {
  ok: false;
  kind: "error";
  status: number;
  /** `error.code`（`VALIDATION_ERROR`・`UNAUTHORIZED`・`FORBIDDEN`・`ACCOUNT_DELETED`・`NOT_FOUND`・`CONFLICT`・`UNPROCESSABLE_ENTITY`・`SERVICE_UNAVAILABLE`）。 */
  code: ExperienceHostApiErrorCode;
  /** `error.details.reason`。無ければ null。 */
  reason: ExperienceHostApiErrorReason | null;
  /** NIHO の文言。画面には出さず、画面の文言は `reason` と `status` から決める。 */
  message: string;
  /** 違反した項目の場所（`details.field`。例 `title`・`offers.0.priceYen`・`photoObjectKeys.2`）。無ければ省く。 */
  field?: string;
  /** 今の slug（409 `PAGE_SLUG_LOCKED` の `details.slug`）。無ければ省く。 */
  slug?: string;
  /** 公開の前提を満たしていない理由（422 `PAGE_PUBLISH_BLOCKED` の `details.blockers` のうち契約にあるもの）。無ければ省く。 */
  blockers?: ExperienceProviderPagePublishBlocker[];
  /** 問い合わせ用の ID（400 には無い）。画面に出すならこれだけ。無ければ省く。 */
  supportId?: string;
};

export type ExperienceHostApiFailure =
  | ExperienceHostApiError
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceHostApiResult<T> = { ok: true; data: T } | ExperienceHostApiFailure;

const DEFAULT_TIMEOUT_MS = 10_000;
const STRIPE_CONNECT_ORIGIN = "https://connect.stripe.com";
/** NIHO の ID（cuid など）。path に入れる前に確かめる（`..` などで別の API を指さない）。提供者・体験ページで共通。 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
/** `x-niho-page-updated-at` に載せてよい値（応答の `updatedAt` の ISO 8601。改行などで header を壊さない）。 */
const UPDATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Authorization に入れられる文字だけ（改行・空白でヘッダーを壊さない）。 */
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;

/** Stripe の口座の登録の画面（アカウントリンク）として遷移してよい URL か。 */
export function isStripeConnectUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && url.origin === STRIPE_CONNECT_ORIGIN;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readConsent(value: unknown): ExperienceProviderConsent | null {
  return isObject(value) && isString(value.version) && isString(value.text) ? { version: value.version, text: value.text } : null;
}

function readProvider(value: unknown): ExperienceProvider | null {
  if (!isObject(value)) return null;
  const v = value;
  if (
    !isString(v.id) || v.id.length === 0 || !isString(v.ownerUserId) || !isString(v.vesselSpotId) ||
    !isOneOf(EXPERIENCE_PROVIDER_KINDS, v.kind) || !isString(v.displayName) || !isString(v.bio) ||
    !isNullableString(v.sellerDisclosureUrl) || !isOneOf(EXPERIENCE_PROVIDER_REVIEW_STATUSES, v.reviewStatus) ||
    !isString(v.consentVersion) || !isString(v.consentedAt) || !isNullableString(v.submittedAt) || !isNullableString(v.approvedAt) ||
    !isNullableString(v.paymentReuseConsentVersion) || !isNullableString(v.paymentReuseConsentedAt) ||
    !isNullableString(v.paymentReuseSourceSpotId) || !isString(v.createdAt) || !isString(v.updatedAt)
  ) {
    return null;
  }
  return {
    id: v.id,
    ownerUserId: v.ownerUserId,
    vesselSpotId: v.vesselSpotId,
    kind: v.kind,
    displayName: v.displayName,
    bio: v.bio,
    sellerDisclosureUrl: v.sellerDisclosureUrl,
    reviewStatus: v.reviewStatus,
    consentVersion: v.consentVersion,
    consentedAt: v.consentedAt,
    submittedAt: v.submittedAt,
    approvedAt: v.approvedAt,
    paymentReuseConsentVersion: v.paymentReuseConsentVersion,
    paymentReuseConsentedAt: v.paymentReuseConsentedAt,
    paymentReuseSourceSpotId: v.paymentReuseSourceSpotId,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function readProviderWithRole(value: unknown): ExperienceProviderWithMemberRole | null {
  const provider = readProvider(value);
  if (!provider || !isObject(value)) return null;
  const memberRole = value.memberRole;
  if (memberRole !== null && !isOneOf(EXPERIENCE_PROVIDER_MEMBER_ROLES, memberRole)) return null;
  return { ...provider, memberRole };
}

function readAll<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed === null) return null;
    items.push(parsed);
  }
  return items;
}

function readReadinessReason(value: unknown): ExperienceProviderPaymentReadinessReason | null {
  return isOneOf(EXPERIENCE_PROVIDER_PAYMENT_READINESS_REASONS, value) ? value : null;
}

/** `/api/auth/me` は閉じていない応答なので、契約に書いた項目（表示名と顔写真）だけを取り出す。 */
function readAuthMe(body: unknown): ExperienceHostAuthMe | null {
  if (!isObject(body) || !isObject(body.user) || !isNullableString(body.user.displayName)) return null;
  const icon = body.userIconImage;
  let userIconImage: ExperienceHostAuthMe["userIconImage"] = null;
  if (icon !== null) {
    if (!isObject(icon) || !isHttpsUrl(icon.signedUrl) || !isString(icon.expiresAt)) return null;
    userIconImage = { signedUrl: icon.signedUrl, expiresAt: icon.expiresAt };
  }
  return { user: { displayName: body.user.displayName }, userIconImage };
}

function readList(body: unknown): ExperienceProviderListResponse | null {
  if (!isObject(body) || typeof body.platformAdmin !== "boolean") return null;
  const providers = readAll(body.providers, readProviderWithRole);
  const consent = readConsent(body.consent);
  const paymentReuseConsent = readConsent(body.paymentReuseConsent);
  return providers && consent && paymentReuseConsent ? { providers, platformAdmin: body.platformAdmin, consent, paymentReuseConsent } : null;
}

function readDetail(body: unknown): ExperienceProviderDetailResponse | null {
  if (!isObject(body) || typeof body.platformAdmin !== "boolean") return null;
  const provider = body.provider === null ? null : readProviderWithRole(body.provider);
  const consent = readConsent(body.consent);
  const paymentReuseConsent = readConsent(body.paymentReuseConsent);
  if ((body.provider !== null && !provider) || !consent || !paymentReuseConsent) return null;
  return { provider, platformAdmin: body.platformAdmin, consent, paymentReuseConsent };
}

function readRegistered(body: unknown): ExperienceProviderRegisterResponse | null {
  if (!isObject(body)) return null;
  const provider = readProvider(body.provider);
  const consent = readConsent(body.consent);
  const paymentReuseConsent = readConsent(body.paymentReuseConsent);
  return provider && consent && paymentReuseConsent ? { provider, consent, paymentReuseConsent } : null;
}

function readProviderResponse(body: unknown): ExperienceProviderResponse | null {
  const provider = isObject(body) ? readProvider(body.provider) : null;
  return provider ? { provider } : null;
}

function readSubmitted(body: unknown): ExperienceProviderSubmitResponse | null {
  return isObject(body) && body.submitted === true ? { submitted: true } : null;
}

function readReadiness(body: unknown): ExperienceProviderPaymentReadinessResponse | null {
  if (!isObject(body) || typeof body.ready !== "boolean") return null;
  const reason = readReadinessReason(body.reason);
  const paymentReuseConsent = readConsent(body.paymentReuseConsent);
  return reason && paymentReuseConsent ? { ready: body.ready, reason, paymentReuseConsent } : null;
}

function readReuseCandidate(value: unknown): ExperienceProviderPaymentReuseCandidate | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.name) || typeof value.ready !== "boolean") return null;
  const reason = readReadinessReason(value.reason);
  return reason ? { id: value.id, name: value.name, ready: value.ready, reason } : null;
}

function readReuseCandidates(body: unknown): ExperienceProviderPaymentReuseCandidatesResponse | null {
  if (!isObject(body)) return null;
  const spots = readAll(body.spots, readReuseCandidate);
  const paymentReuseConsent = readConsent(body.paymentReuseConsent);
  return spots && paymentReuseConsent ? { spots, paymentReuseConsent } : null;
}

/** `url` は https の URL だけを受け取る（遷移してよい先かは `isStripeConnectUrl` で画面が確かめる）。 */
function readConnect(body: unknown): ExperienceProviderPaymentConnectResponse | null {
  if (!isObject(body) || typeof body.ready !== "boolean") return null;
  const reason = readReadinessReason(body.reason);
  if (!reason || !(body.url === null || isHttpsUrl(body.url)) || !isNullableString(body.expiresAt)) return null;
  return { url: body.url, expiresAt: body.expiresAt, ready: body.ready, reason };
}

/**
 * 失敗の本文を読む。契約の外の層（429・500 など）が返す本文もあるので、`code`・`message`・`details` がそろえば受け取り、
 * 理由ごとの項目は契約に書かれたものだけを、あるときだけ足す。
 */
function readError(status: number, body: unknown): ExperienceHostApiError | null {
  if (!isObject(body) || !isObject(body.error)) return null;
  const { code, message, details, supportId } = body.error;
  if (!isString(code) || !isString(message) || !isObject(details)) return null;
  const reason = isString(details.reason) && details.reason.length > 0 ? details.reason : null;
  const error: ExperienceHostApiError = { ok: false, kind: "error", status, code, reason, message };
  if (isString(details.field)) error.field = details.field;
  if (isString(details.slug)) error.slug = details.slug;
  if (Array.isArray(details.blockers)) error.blockers = details.blockers.filter((blocker) => isOneOf(EXPERIENCE_PROVIDER_PAGE_PUBLISH_BLOCKERS, blocker));
  const support = isString(supportId) && supportId ? supportId : isString(details.supportId) && details.supportId ? details.supportId : null;
  if (support) error.supportId = support;
  return error;
}

/** 確かめていない provider ID では NIHO を呼ばず、NIHO の 404 と同じ扱いにする。 */
const INVALID_PROVIDER_ID: ExperienceHostApiError = { ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason: null, message: "" };

/** 確かめていない page ID では NIHO を呼ばず、その操作で NIHO が無いページに返す 404 と同じ扱いにする。 */
function invalidPageId(reason: ExperienceHostErrorReason): ExperienceHostApiError {
  return { ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason, message: "" };
}

/** 版の形でない `expectedUpdatedAt` は今の版と一致しようがないので、NIHO を呼ばず 409 `PAGE_UPDATED`（読み直す）と同じ扱いにする。 */
const STALE_PAGE_VERSION: ExperienceHostApiError = { ok: false, kind: "error", status: 409, code: "CONFLICT", reason: "PAGE_UPDATED", message: "" };

/**
 * 写真の署名つき POST の応答から、ブラウザへ渡す値を作る（`uploadId` は渡さない）。ブラウザは `fields` を全部 form に入れ、
 * 最後に `file` を足して `url` へ送る。
 */
export function toExperienceProviderPhotoUploadForm(policy: ExperienceProviderUploadPolicyResponse): ExperienceProviderPhotoUploadForm {
  return {
    url: policy.upload.url,
    fields: { ...policy.upload.fields },
    objectKey: policy.objectKey,
    expiresAt: policy.expiresAt,
    maxSizeBytes: policy.maxSizeBytes,
  };
}

export function createExperienceHostApiClient(options: ExperienceHostApiClientOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!ACCESS_TOKEN_PATTERN.test(options.accessToken)) throw new Error("accessToken must be a non-empty token without spaces");
  const authorization = `Bearer ${options.accessToken}`;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    successStatus: number,
    read: (body: unknown) => T | null,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ExperienceHostApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: "application/json", authorization, ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch {
        return { ok: false, kind: "network_error" };
      }
      let parsed: unknown;
      try {
        const text = await response.text();
        parsed = text ? (JSON.parse(text) as unknown) : null;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, kind: "network_error" };
        parsed = undefined;
      }
      if (response.status === successStatus) {
        const data = read(parsed);
        return data === null ? { ok: false, kind: "unexpected_response", status: response.status } : { ok: true, data };
      }
      if (response.status >= 400) {
        const error = readError(response.status, parsed);
        if (error) return error;
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }

  const providerPath = (providerId: string, suffix = "") => `/api/experience-providers/${encodeURIComponent(providerId)}${suffix}`;
  const pagePath = (providerId: string, pageId: string, suffix = "") => providerPath(providerId, `/pages/${encodeURIComponent(pageId)}${suffix}`);
  const validProviderId = (providerId: string) => PROVIDER_ID_PATTERN.test(providerId);
  const validPageId = (pageId: string) => PROVIDER_ID_PATTERN.test(pageId);

  /** 提供者と体験ページの ID を確かめてから呼ぶ。`missingPage` は、その操作で NIHO が無いページに返す理由。 */
  async function onPage<T>(
    providerId: string,
    pageId: string,
    missingPage: ExperienceHostErrorReason,
    run: () => Promise<ExperienceHostApiResult<T>>,
  ): Promise<ExperienceHostApiResult<T>> {
    if (!validProviderId(providerId)) return INVALID_PROVIDER_ID;
    if (!validPageId(pageId)) return invalidPageId(missingPage);
    return run();
  }

  /** 版の header（null なら版を確かめない）。形の違う版は null を返し、呼ばずに 409 `PAGE_UPDATED` にする。 */
  function versionHeader(expectedUpdatedAt: string | null): Record<string, string> | null {
    if (expectedUpdatedAt === null) return {};
    return UPDATED_AT_PATTERN.test(expectedUpdatedAt) ? { [EXPERIENCE_PROVIDER_PAGE_UPDATED_AT_HEADER]: expectedUpdatedAt } : null;
  }

  return {
    /** 本人の表示名と顔写真（`GET /api/auth/me` のうち契約に書いた部分だけ）。 */
    getAuthMe(): Promise<ExperienceHostApiResult<ExperienceHostAuthMe>> {
      return call("GET", "/api/auth/me", 200, readAuthMe);
    },

    /** 本人が OWNER / EDITOR として所属する提供者の一覧と、登録・口座の再利用の同意。 */
    listExperienceProviders(): Promise<ExperienceHostApiResult<ExperienceProviderListResponse>> {
      return call("GET", "/api/experience-providers", 200, readList);
    },

    /** 提供者として自己登録する（201）。422 の reason: `PROVIDER_CONSENT_OUTDATED`・`PROVIDER_EMAIL_REQUIRED`。 */
    registerExperienceProvider(body: ExperienceProviderRegisterRequest): Promise<ExperienceHostApiResult<ExperienceProviderRegisterResponse>> {
      return call("POST", "/api/experience-providers", 201, readRegistered, body);
    },

    /** 提供者の紹介（所属していない・存在しない提供者は 404）。 */
    async getExperienceProvider(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderDetailResponse>> {
      return validProviderId(providerId) ? call("GET", providerPath(providerId), 200, readDetail) : INVALID_PROVIDER_ID;
    },

    /** 紹介を直す（送った項目だけ）。`sellerDisclosureUrl` は OWNER だけ（EDITOR は 403）。 */
    async updateExperienceProvider(providerId: string, body: ExperienceProviderUpdateRequest): Promise<ExperienceHostApiResult<ExperienceProviderResponse>> {
      return validProviderId(providerId) ? call("PATCH", providerPath(providerId), 200, readProviderResponse, body) : INVALID_PROVIDER_ID;
    },

    /** 審査を申請する（OWNER）。409 の reason: `PROVIDER_REVIEW_STATE_CONFLICT`。 */
    async submitExperienceProvider(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderSubmitResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/submit"), 200, readSubmitted) : INVALID_PROVIDER_ID;
    },

    /** 売上の受取口座の準備の状態（OWNER）。 */
    async getExperienceProviderPaymentReadiness(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPaymentReadinessResponse>> {
      return validProviderId(providerId) ? call("GET", providerPath(providerId, "/payments/readiness"), 200, readReadiness) : INVALID_PROVIDER_ID;
    },

    /** 売上の受取に再利用できる拠点の販売者口座の候補（OWNER）。 */
    async listExperienceProviderPaymentReuseCandidates(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPaymentReuseCandidatesResponse>> {
      return validProviderId(providerId) ? call("GET", providerPath(providerId, "/payments/reuse-candidates"), 200, readReuseCandidates) : INVALID_PROVIDER_ID;
    },

    /**
     * 拠点の販売者口座を再利用する（OWNER）。404 の reason: `PROVIDER_PAYMENT_SOURCE_FORBIDDEN`・409: `PROVIDER_PAYMENT_LOCKED`・
     * 422: `PROVIDER_PAYMENT_CONSENT_OUTDATED`・`PROVIDER_PAYMENT_SOURCE_NOT_READY`。
     */
    async reuseExperienceProviderPayment(providerId: string, body: ExperienceProviderPaymentReuseRequest): Promise<ExperienceHostApiResult<ExperienceProviderResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/payments/reuse"), 200, readProviderResponse, body) : INVALID_PROVIDER_ID;
    },

    /**
     * Stripe の口座の接続を始める（OWNER）。`url` は一度きりで `expiresAt` まで。遷移の前に `isStripeConnectUrl` で確かめる。
     * 409 の reason: `PROVIDER_CONNECT_UNAVAILABLE`・`PROVIDER_PAYMENT_SHARED_ACCOUNT`・`PROVIDER_PAYMENT_LOCKED`。
     */
    async startExperienceProviderPaymentConnect(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPaymentConnectResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/payments/connect/start"), 200, readConnect) : INVALID_PROVIDER_ID;
    },

    /** 接続を続ける（リンクの期限切れ・途中で離れたとき）。応答とエラーは start と同じ。 */
    async resumeExperienceProviderPaymentConnect(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPaymentConnectResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/payments/connect/resume"), 200, readConnect) : INVALID_PROVIDER_ID;
    },

    /** 口座の状態を Stripe から取り直す（`url` は null）。口座がまだ無ければ 409 `PROVIDER_PAYMENT_NOT_CONNECTED`。 */
    async syncExperienceProviderPaymentConnect(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPaymentConnectResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/payments/connect/sync"), 200, readConnect) : INVALID_PROVIDER_ID;
    },

    // 集合場所（提供者の既定）

    /** 集合場所の既定（体験ページで上書きしないときに使う。未設定の項目は空文字）。 */
    async getExperienceProviderMeetingPoint(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderMeetingPointResponse>> {
      return validProviderId(providerId) ? call("GET", providerPath(providerId, "/meeting-point"), 200, readMeetingPointResponse) : INVALID_PROVIDER_ID;
    },

    /** 集合場所の既定を全項目で置き換える（形が違えば 400）。掲載中の体験は止まる（`PAUSED`）。 */
    async updateExperienceProviderMeetingPoint(providerId: string, body: ExperienceProviderMeetingPoint): Promise<ExperienceHostApiResult<ExperienceProviderMeetingPointResponse>> {
      return validProviderId(providerId) ? call("PUT", providerPath(providerId, "/meeting-point"), 200, readMeetingPointResponse, body) : INVALID_PROVIDER_ID;
    },

    // 体験ページ（OWNER / EDITOR）

    /** 体験ページの一覧（更新の新しい順）。 */
    async listExperienceProviderPages(providerId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageListResponse>> {
      return validProviderId(providerId) ? call("GET", providerPath(providerId, "/pages"), 200, readPageListResponse) : INVALID_PROVIDER_ID;
    },

    /** 下書きを作る（201・商品も既定値で 1 件）。400 `PAGE_REQUEST_INVALID` / `PAGE_TITLE_INVALID` / `PAGE_SLUG_INVALID`（`field`）・409 `PAGE_SLUG_TAKEN`。 */
    async createExperienceProviderPage(providerId: string, body: ExperienceProviderPageCreateRequest): Promise<ExperienceHostApiResult<ExperienceProviderPageDetail>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/pages"), 201, readPageDetail, body) : INVALID_PROVIDER_ID;
    },

    /** 体験ページの詳細。保存・公開で送る版は `updatedAt`。無いページは 404 `PAGE_NOT_FOUND`。 */
    getExperienceProviderPage(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageDetail>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", () => call("GET", pagePath(providerId, pageId), 200, readPageDetail));
    },

    /**
     * 送った項目だけを直す。`expectedUpdatedAt` は読んだときの `updatedAt`（違えば 409 `PAGE_UPDATED`。null なら版を確かめない）。
     * 400（`field` つき）・404 `PAGE_NOT_FOUND`・409 `PAGE_SLUG_TAKEN` / `PAGE_SLUG_LOCKED`（`slug`）/ `PAGE_OFFER_HAS_BOOKINGS`・
     * 422 `PAGE_PHOTOS_INVALID` / `PAGE_PUBLISH_BLOCKED`（`blockers`）。保存すると掲載中の体験は止まる（`PAUSED`）。
     */
    updateExperienceProviderPage(
      providerId: string,
      pageId: string,
      body: ExperienceProviderPagePatchRequest,
      expectedUpdatedAt: string | null,
    ): Promise<ExperienceHostApiResult<ExperienceProviderPageDetail>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", async () => {
        const headers = versionHeader(expectedUpdatedAt);
        return headers ? call("PATCH", pagePath(providerId, pageId), 200, readPageDetail, body, headers) : STALE_PAGE_VERSION;
      });
    },

    /** 公開したことの無い下書きを消す。409 `PAGE_DELETE_PUBLISHED` / `PAGE_DELETE_HAS_BOOKINGS`（どちらも公開停止で足りる）。 */
    deleteExperienceProviderPage(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageDeleteResponse>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", () => call("DELETE", pagePath(providerId, pageId), 200, readPageDeleteResponse));
    },

    /**
     * 公開する（初回と再公開）。`expectedUpdatedAt` は `updateExperienceProviderPage` と同じ。409 `PAGE_UPDATED`・
     * 422 `PAGE_PUBLISH_BLOCKED`（`blockers`）/ `PAGE_PHOTOS_INVALID`。体験サイトへの掲載は別の操作。
     */
    publishExperienceProviderPage(providerId: string, pageId: string, expectedUpdatedAt: string | null): Promise<ExperienceHostApiResult<ExperienceProviderPageDetail>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", async () => {
        const headers = versionHeader(expectedUpdatedAt);
        return headers ? call("POST", pagePath(providerId, pageId, "/publish"), 200, readPageDetail, undefined, headers) : STALE_PAGE_VERSION;
      });
    },

    /** 公開を止める（止めてあればそのまま）。公開したことが無ければ 409 `PAGE_NOT_PUBLISHED`。掲載中の体験も止まる。 */
    unpublishExperienceProviderPage(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageDetail>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", () => call("POST", pagePath(providerId, pageId, "/unpublish"), 200, readPageDetail));
    },

    /** NIHO の公開ページと同じ組み立てのプレビュー（保存済みの内容・下書きでも読める）。有効な商品が無ければ 404 `PAGE_NOT_FOUND`。 */
    getExperienceProviderPagePreview(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPagePreviewResponse>> {
      return onPage(providerId, pageId, "PAGE_NOT_FOUND", () => call("GET", pagePath(providerId, pageId, "/preview"), 200, readPagePreview));
    },

    /** 体験ページで使う集合場所（`INHERIT` は提供者の既定・`OVERRIDE` はこのページの上書き）。無いページは 404 `PROVIDER_PAGE_NOT_FOUND`。 */
    getExperienceProviderPageMeetingPoint(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageMeetingPointResponse>> {
      return onPage(providerId, pageId, "PROVIDER_PAGE_NOT_FOUND", () => call("GET", pagePath(providerId, pageId, "/meeting-point"), 200, readPageMeetingPointResponse));
    },

    /**
     * 集合場所を上書きする（`OVERRIDE`）・既定に戻す（`INHERIT`）。版は本文の `expectedUpdatedAt`（違えば 409 `PROVIDER_PAGE_CONFLICT`）で、
     * 保存するとページの版が進む（続く保存には応答の `updatedAt` を使う）。
     */
    updateExperienceProviderPageMeetingPoint(
      providerId: string,
      pageId: string,
      body: ExperienceProviderPageMeetingPointUpdateRequest,
    ): Promise<ExperienceHostApiResult<ExperienceProviderPageMeetingPointUpdateResponse>> {
      return onPage(providerId, pageId, "PROVIDER_PAGE_NOT_FOUND", () => call("PUT", pagePath(providerId, pageId, "/meeting-point"), 200, readPageMeetingPointUpdateResponse, body));
    },

    // 体験サイトへの掲載（OWNER。EDITOR は 404）

    /** 掲載の状態と申請の同意（掲載が無ければ `listing: null`）。無いページは 404 `PROVIDER_PAGE_NOT_FOUND`。 */
    getExperienceProviderPageListing(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageListingResponse>> {
      return onPage(providerId, pageId, "PROVIDER_PAGE_NOT_FOUND", () => call("GET", pagePath(providerId, pageId, "/experience-site-listing"), 200, readPageListingResponse));
    },

    /**
     * 掲載を申請する（`consentVersion` は `consent.version`）。404 `EXPERIENCE_LISTING_NOT_FOUND`・409 `EXPERIENCE_LISTING_STATUS_CONFLICT`・
     * 422 `EXPERIENCE_LISTING_CONSENT_OUTDATED` / `EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE`（公開中で英語の体験ページだけ）。
     */
    requestExperienceProviderPageListing(
      providerId: string,
      pageId: string,
      body: ExperienceProviderPageListingRequest,
    ): Promise<ExperienceHostApiResult<ExperienceProviderPageListingResponse>> {
      return onPage(providerId, pageId, "EXPERIENCE_LISTING_NOT_FOUND", () => call("PUT", pagePath(providerId, pageId, "/experience-site-listing"), 200, readPageListingResponse, body));
    },

    /** 掲載を取り下げる（`WITHDRAWN`・取り下げ済みならそのまま）。掲載が無ければ 404 `EXPERIENCE_LISTING_NOT_FOUND`。 */
    withdrawExperienceProviderPageListing(providerId: string, pageId: string): Promise<ExperienceHostApiResult<ExperienceProviderPageListingResponse>> {
      return onPage(providerId, pageId, "EXPERIENCE_LISTING_NOT_FOUND", () => call("DELETE", pagePath(providerId, pageId, "/experience-site-listing"), 200, readPageListingResponse));
    },

    // 写真（OWNER / EDITOR）

    /**
     * 写真を GCS へ直接上げる署名つき POST（201・15 分）。ブラウザへは `toExperienceProviderPhotoUploadForm` で渡す。
     * 503 `uploads_disabled` / `signing_circuit_open` / `signing_transient_failure`。
     */
    async createExperienceProviderUploadPolicy(providerId: string, body: ExperienceProviderUploadPolicyRequest): Promise<ExperienceHostApiResult<ExperienceProviderUploadPolicyResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/uploads/policies"), 201, readUploadPolicy, body) : INVALID_PROVIDER_ID;
    },

    /**
     * 上げた写真（保存前）を見る短命の署名つき URL。別の提供者の写真・無い写真は 404（理由なし）・実体が無ければ 404 `object_missing`・
     * 403 `upload_expired`・503 `uploads_disabled` / `object_lookup_failed` / 署名の失敗。
     */
    async createExperienceProviderUploadSignedUrl(providerId: string, body: ExperienceProviderUploadSignedUrlRequest): Promise<ExperienceHostApiResult<ExperienceProviderUploadSignedUrlResponse>> {
      return validProviderId(providerId) ? call("POST", providerPath(providerId, "/uploads/signed-url"), 200, readUploadSignedUrl, body) : INVALID_PROVIDER_ID;
    },
  };
}

export type ExperienceHostApiClient = ReturnType<typeof createExperienceHostApiClient>;
