import "server-only";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { StoreValidationError, type GuideAdminRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { guideAdminRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CATEGORY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JSON_LIMIT_BYTES = 16 * 1024;

export interface GuideAdminIdentityClaims {
  readonly iss: string;
  readonly aud: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly exp: number;
}

export type GuideAdminTokenVerification =
  | { readonly ok: true; readonly claims: GuideAdminIdentityClaims }
  | { readonly ok: false; readonly kind: "invalid" | "outage" };

export interface GuideAdminTokenVerifier {
  verify(token: string, audience: string): Promise<GuideAdminTokenVerification>;
}

export interface GuideAdminAuthSettings {
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

const googleClient = new OAuth2Client();

function tokenPayloadClaims(payload: TokenPayload): GuideAdminIdentityClaims {
  return {
    iss: payload.iss,
    aud: payload.aud,
    ...(payload.email === undefined ? {} : { email: payload.email }),
    ...(payload.email_verified === undefined ? {} : { emailVerified: payload.email_verified }),
    exp: payload.exp,
  };
}

function isVerificationOutage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: { code?: unknown }; response?: { status?: unknown } };
  const networkCodes = [
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT",
  ];
  if (typeof record.code === "string" && networkCodes.includes(record.code)) return true;
  if (typeof record.cause?.code === "string" && networkCodes.includes(record.cause.code)) return true;
  const status = record.response?.status;
  // verifyIdToken validates malformed/expired/wrong-claim tokens locally. An HTTP
  // response here belongs to Google's signing-key retrieval and is an outage.
  return typeof status === "number";
}

export const googleGuideAdminTokenVerifier: GuideAdminTokenVerifier = {
  async verify(token, audience) {
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      return payload === undefined ? { ok: false, kind: "invalid" } : { ok: true, claims: tokenPayloadClaims(payload) };
    } catch (error) {
      return { ok: false, kind: isVerificationOutage(error) ? "outage" : "invalid" };
    }
  },
};

export function guideAdminJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function verifyGuideAdminServiceIdentity(
  request: Pick<Request, "headers">,
  settings: GuideAdminAuthSettings,
  verifier: GuideAdminTokenVerifier = googleGuideAdminTokenVerifier,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return { ok: false, response: guideAdminJson({ error: "invalid_identity" }, 401) };
  const verified = await verifier.verify(match[1]!, settings.audience);
  if (!verified.ok) {
    return {
      ok: false,
      response: guideAdminJson({ error: verified.kind === "outage" ? "identity_verification_unavailable" : "invalid_identity" }, verified.kind === "outage" ? 503 : 401),
    };
  }
  const claims = verified.claims;
  if (
    !GOOGLE_ISSUERS.has(claims.iss)
    || claims.aud !== settings.audience
    || claims.emailVerified !== true
    || claims.email !== settings.serviceAccountEmail
    || !Number.isSafeInteger(claims.exp)
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    return { ok: false, response: guideAdminJson({ error: "invalid_identity" }, 401) };
  }
  return { ok: true };
}

export async function loadGuideAdmin(
  request: Pick<Request, "headers">,
  dependencies: {
    readonly verifier?: GuideAdminTokenVerifier;
    readonly repository?: () => GuideAdminRepository | null;
    readonly settings?: {
      readonly enabled: boolean;
      readonly audience: string;
      readonly serviceAccountEmail: string;
    };
  } = {},
): Promise<{ readonly ok: true; readonly repository: GuideAdminRepository } | { readonly ok: false; readonly response: Response }> {
  const settings = dependencies.settings ?? {
    enabled: config.guideAdminApiEnabled,
    audience: config.guideAdminAudience,
    serviceAccountEmail: config.guideAdminServiceAccountEmail,
  };
  if (!settings.enabled) return { ok: false, response: guideAdminJson({ error: "not_found" }, 404) };
  const identity = await verifyGuideAdminServiceIdentity(request, settings, dependencies.verifier);
  if (!identity.ok) return identity;
  const repository = (dependencies.repository ?? guideAdminRepository)();
  return repository === null
    ? { ok: false, response: guideAdminJson({ error: "unavailable" }, 503) }
    : { ok: true, repository };
}

export async function readGuideAdminMutation(request: Request): Promise<unknown> {
  const url = new URL(request.url);
  if (url.search) throw new StoreValidationError("Mutation query strings are not allowed.");
  const contentType = request.headers.get("content-type")?.toLowerCase().replaceAll(" ", "") ?? "";
  if (contentType !== "application/json" && contentType !== "application/json;charset=utf-8") {
    throw new StoreValidationError("Content-Type must be application/json.");
  }
  try {
    return await readBoundedJson(request, JSON_LIMIT_BYTES, { fatalUtf8: true });
  } catch (error) {
    throw new StoreValidationError("Request body must be valid bounded JSON.", { cause: error });
  }
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreValidationError("Request body must be an object.");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new StoreValidationError("Request body fields do not match the contract.");
  }
  return record;
}

export function guideAdminCommandHeaders(request: Request): { readonly idempotencyKey: string; readonly actorNihoUserId: string } {
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  const actorNihoUserId = request.headers.get("x-niho-admin-actor-id") ?? "";
  if (!UUID_V4.test(idempotencyKey)) throw new StoreValidationError("Idempotency-Key must be a UUID v4.");
  if (!STABLE_ID.test(actorNihoUserId)) throw new StoreValidationError("X-NIHO-Admin-Actor-Id must be a stable NIHO user ID.");
  return { idempotencyKey, actorNihoUserId };
}

export function guideAdminTargetId(value: string): string {
  if (!STABLE_ID.test(value)) throw new StoreValidationError("nihoUserId must be a stable NIHO user ID.");
  return value;
}

export function guideAdminCategorySlug(value: string): string {
  if (!CATEGORY_SLUG.test(value) || value.length > 80) throw new StoreValidationError("Invalid category slug.");
  return value;
}

export function guideAdminRouteFailure(error: unknown): Response {
  return error instanceof StoreValidationError
    ? guideAdminJson({ error: "invalid_input" }, 400)
    : guideAdminJson({ error: "unavailable" }, 503);
}
