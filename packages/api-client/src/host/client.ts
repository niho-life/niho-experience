import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import { isExperienceHostApiSchema } from "./schema.ts";
import type {
  ExperienceHostApiFailure, ExperienceHostApiResult, ExperienceHostIdentity, ExperienceHostLegacyConnectAccount,
  ExperienceHostBookingCancelInput, ExperienceHostBookingCancelResponse, ExperienceHostBookingDetailResponse,
  ExperienceHostBookingListQuery, ExperienceHostBookingListResponse, ExperienceHostBookingMessageInput,
  ExperienceHostBookingMessageResponse, ExperienceHostBookingStatusResponse,
} from "./types.ts";

export type ExperienceHostApiClientOptions = {
  readonly nihoWebOrigin: string;
  /** Current NIHO AppConnection Web bearer. Never log, persist in browser storage, or expose to the browser. */
  readonly accessToken: string;
  /** Experience runtime service-account ID token, required by the v1.0 common contract. */
  readonly serviceIdToken: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
};

export type ExperienceHostApiClient = {
  getIdentity(): Promise<ExperienceHostApiResult<ExperienceHostIdentity>>;
  getLegacyConnectAccount(legacyProviderId: string): Promise<ExperienceHostApiResult<ExperienceHostLegacyConnectAccount>>;
  listLegacyProviderBookings(legacyProviderId: string, query?: ExperienceHostBookingListQuery): Promise<ExperienceHostApiResult<ExperienceHostBookingListResponse>>;
  getLegacyProviderBooking(legacyProviderId: string, requestId: string): Promise<ExperienceHostApiResult<ExperienceHostBookingDetailResponse>>;
  approveLegacyProviderBooking(legacyProviderId: string, pageId: string, requestId: string): Promise<ExperienceHostApiResult<ExperienceHostBookingStatusResponse>>;
  declineLegacyProviderBooking(legacyProviderId: string, pageId: string, requestId: string): Promise<ExperienceHostApiResult<ExperienceHostBookingStatusResponse>>;
  cancelLegacyProviderBooking(legacyProviderId: string, pageId: string, requestId: string, body: ExperienceHostBookingCancelInput): Promise<ExperienceHostApiResult<ExperienceHostBookingCancelResponse>>;
  messageLegacyProviderGuest(legacyProviderId: string, pageId: string, requestId: string, body: ExperienceHostBookingMessageInput): Promise<ExperienceHostApiResult<ExperienceHostBookingMessageResponse>>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{8,250}$/;
const READINESS_REASONS = ["NOT_CONNECTED", "VERIFICATION_REQUIRED", "CHARGES_DISABLED", "PAYOUTS_DISABLED", "RESTRICTED", "READY"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function parseIdentity(value: unknown): ExperienceHostIdentity | null {
  if (!isObject(value) || !exact(value, ["nihoUserId", "accountStatus"])
    || typeof value.nihoUserId !== "string" || !ID_PATTERN.test(value.nihoUserId)
    || value.accountStatus !== "ACTIVE") return null;
  return { nihoUserId: value.nihoUserId, accountStatus: "ACTIVE" };
}

function parseConnectAccount(value: unknown, expectedProviderId: string): ExperienceHostLegacyConnectAccount | null {
  if (!isObject(value) || !exact(value, ["legacyProviderId", "stripeAccountId", "readiness", "paymentReuseConsent"])
    || value.legacyProviderId !== expectedProviderId
    || !(value.stripeAccountId === null || (typeof value.stripeAccountId === "string" && ACCOUNT_ID_PATTERN.test(value.stripeAccountId)))
    || !isObject(value.readiness) || !exact(value.readiness, ["ready", "reason"])
    || typeof value.readiness.ready !== "boolean" || typeof value.readiness.reason !== "string"
    || !(READINESS_REASONS as readonly string[]).includes(value.readiness.reason)
    || value.readiness.ready !== (value.readiness.reason === "READY")
    || !isObject(value.paymentReuseConsent) || !exact(value.paymentReuseConsent, ["accepted", "version", "consentedAt"])
    || typeof value.paymentReuseConsent.accepted !== "boolean"
    || !(value.paymentReuseConsent.version === null || (typeof value.paymentReuseConsent.version === "string" && value.paymentReuseConsent.version.length <= 160))
    || !(value.paymentReuseConsent.consentedAt === null || (typeof value.paymentReuseConsent.consentedAt === "string" && Number.isFinite(Date.parse(value.paymentReuseConsent.consentedAt))))
    || value.paymentReuseConsent.accepted !== (value.paymentReuseConsent.version !== null && value.paymentReuseConsent.consentedAt !== null)) return null;
  return {
    legacyProviderId: expectedProviderId,
    stripeAccountId: value.stripeAccountId as string | null,
    readiness: { ready: value.readiness.ready, reason: value.readiness.reason as ExperienceHostLegacyConnectAccount["readiness"]["reason"] },
    paymentReuseConsent: {
      accepted: value.paymentReuseConsent.accepted,
      version: value.paymentReuseConsent.version as string | null,
      consentedAt: value.paymentReuseConsent.consentedAt as string | null,
    },
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) return null;
    return JSON.parse(text) as unknown;
  } catch { return null; }
}

export function createExperienceHostApiClient(options: ExperienceHostApiClientOptions): ExperienceHostApiClient {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!/^[\x21-\x7e]{1,8192}$/.test(options.accessToken) || !/^[\x21-\x7e]{1,8192}$/.test(options.serviceIdToken)) {
    throw new Error("NIHO host credentials are invalid");
  }

  async function get<T>(path: string, parse: (value: unknown) => T | null): Promise<ExperienceHostApiResult<T>> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin).href, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          "x-niho-experience-service-id-token": options.serviceIdToken,
          accept: "application/json",
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { ok: false, kind: "network_error" }; }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 400 && response.status < 500
        ? { ok: false, kind: "error", status: response.status }
        : { ok: false, kind: "unexpected_response", status: response.status };
    }
    const parsed = parse(await readJson(response));
    return parsed === null ? { ok: false, kind: "unexpected_response", status: 200 } : { ok: true, data: parsed };
  }

  async function send<T>(method: "GET" | "POST", path: string, schema: string, status = 200, body?: unknown): Promise<ExperienceHostApiResult<T>> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin).href, {
        method,
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          "x-niho-experience-service-id-token": options.serviceIdToken,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store", credentials: "omit", redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { ok: false, kind: "network_error" }; }
    if (response.status !== status) {
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 400 && response.status < 500
        ? { ok: false, kind: "error", status: response.status }
        : { ok: false, kind: "unexpected_response", status: response.status };
    }
    const value = await readJson(response);
    return isExperienceHostApiSchema<T>(schema, value)
      ? { ok: true, data: value }
      : { ok: false, kind: "unexpected_response", status };
  }

  const pathId = (value: string) => PROVIDER_ID_PATTERN.test(value) ? encodeURIComponent(value) : null;
  const queryString = (query: ExperienceHostBookingListQuery): string | null => {
    if (Object.keys(query).some((key) => !["cursor", "pageId", "fromDate", "toDate", "status"].includes(key))) return null;
    if (query.cursor !== undefined && (query.cursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(query.cursor))) return null;
    if (query.pageId !== undefined && pathId(query.pageId) === null) return null;
    if (query.fromDate !== undefined && !DATE.test(query.fromDate)) return null;
    if (query.toDate !== undefined && !DATE.test(query.toDate)) return null;
    if (query.status !== undefined && !["PENDING", "PAYMENT_PENDING", "PROVISIONAL", "CONFIRMED", "DECLINED", "EXPIRED", "CANCELLED", "REFUND_NEEDED"].includes(query.status)) return null;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
    const encoded = params.toString();
    return encoded ? `?${encoded}` : "";
  };
  const bookingRoot = (providerId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/bookings`;
  const actionPath = (providerId: string, pageId: string, requestId: string, action: string) =>
    `/api/experience-providers/${encodeURIComponent(providerId)}/pages/${encodeURIComponent(pageId)}/bookings/${encodeURIComponent(requestId)}/${action}`;
  const validIds = (...values: string[]) => values.every((value) => pathId(value) !== null);
  const invalid = <T>(): Promise<ExperienceHostApiResult<T>> => Promise.resolve({ ok: false, kind: "invalid_request" });

  return {
    getIdentity: () => get("/api/experience-host/identity", parseIdentity),
    getLegacyConnectAccount(legacyProviderId) {
      if (!PROVIDER_ID_PATTERN.test(legacyProviderId)) return Promise.resolve({ ok: false, kind: "error", status: 404 } satisfies ExperienceHostApiFailure);
      return get(`/api/experience-host/legacy-providers/${encodeURIComponent(legacyProviderId)}/connect-account`, (value) => parseConnectAccount(value, legacyProviderId));
    },
    listLegacyProviderBookings(legacyProviderId, query = {}) {
      const encodedId = pathId(legacyProviderId);
      const search = queryString(query);
      return encodedId !== null && search !== null
        ? send("GET", `${bookingRoot(encodedId)}${search}`, "ExperienceHostBookingBookingListResponse")
        : invalid();
    },
    getLegacyProviderBooking(legacyProviderId, requestId) {
      const provider = pathId(legacyProviderId); const request = pathId(requestId);
      return provider !== null && request !== null
        ? send("GET", `${bookingRoot(provider)}/${request}`, "ExperienceHostBookingBookingDetailResponse")
        : invalid();
    },
    approveLegacyProviderBooking(legacyProviderId, pageId, requestId) {
      return validIds(legacyProviderId, pageId, requestId)
        ? send("POST", actionPath(legacyProviderId, pageId, requestId, "approve"), "ExperienceHostBookingBookingStatusResponse")
        : invalid();
    },
    declineLegacyProviderBooking(legacyProviderId, pageId, requestId) {
      return validIds(legacyProviderId, pageId, requestId)
        ? send("POST", actionPath(legacyProviderId, pageId, requestId, "decline"), "ExperienceHostBookingBookingStatusResponse")
        : invalid();
    },
    cancelLegacyProviderBooking(legacyProviderId, pageId, requestId, body) {
      if (!validIds(legacyProviderId, pageId, requestId) || !isExperienceHostApiSchema<ExperienceHostBookingCancelInput>("ExperienceHostBookingCancelBookingInput", body)) return invalid();
      return send("POST", actionPath(legacyProviderId, pageId, requestId, "cancel"), "ExperienceHostBookingCancelBookingResponse", 200, body);
    },
    messageLegacyProviderGuest(legacyProviderId, pageId, requestId, body) {
      if (!validIds(legacyProviderId, pageId, requestId) || !isExperienceHostApiSchema<ExperienceHostBookingMessageInput>("ExperienceHostBookingMessageInput", body)) return invalid();
      return send("POST", actionPath(legacyProviderId, pageId, requestId, "message"), "ExperienceHostBookingMessageResponse", 201, body);
    },
  };
}
