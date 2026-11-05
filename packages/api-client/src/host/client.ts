import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import type {
  ExperienceHostApiFailure, ExperienceHostApiResult, ExperienceHostIdentity, ExperienceHostLegacyConnectAccount,
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
};

const DEFAULT_TIMEOUT_MS = 10_000;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{8,250}$/;
const READINESS_REASONS = ["NOT_CONNECTED", "VERIFICATION_REQUIRED", "CHARGES_DISABLED", "PAYOUTS_DISABLED", "RESTRICTED", "READY"] as const;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function parseIdentity(value: unknown): ExperienceHostIdentity | null {
  if (!isObject(value) || !exact(value, ["nihoUserId", "accountStatus"])
    || typeof value.nihoUserId !== "string" || value.nihoUserId.length < 1 || value.nihoUserId.length > 128
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

  const pathId = (value: string) => PROVIDER_ID_PATTERN.test(value) ? encodeURIComponent(value) : null;

  return {
    getIdentity: () => get("/api/experience-host/identity", parseIdentity),
    getLegacyConnectAccount(legacyProviderId) {
      if (!PROVIDER_ID_PATTERN.test(legacyProviderId)) return Promise.resolve({ ok: false, kind: "error", status: 404 } satisfies ExperienceHostApiFailure);
      return get(`/api/experience-host/legacy-providers/${encodeURIComponent(legacyProviderId)}/connect-account`, (value) => parseConnectAccount(value, legacyProviderId));
    },
  };
}
