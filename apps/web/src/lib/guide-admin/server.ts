import "server-only";
import { StoreValidationError, type GuideAdminRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { guideAdminRepository } from "@/lib/experience/store-server";
import {
  googleIdTokenVerifier,
  internalServiceJson,
  serviceIdentityFailure,
  verifyGoogleServiceIdentity,
  type GoogleIdentityClaims,
  type GoogleServiceIdentitySettings,
  type GoogleTokenVerification,
  type GoogleTokenVerifier,
} from "@/lib/google-service-identity";
import { readBoundedJson } from "@/lib/read-bounded-json";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CATEGORY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JSON_LIMIT_BYTES = 16 * 1024;

// The Google service identity check is shared with other internal routes (lib/google-service-identity.ts).
export type GuideAdminIdentityClaims = GoogleIdentityClaims;
export type GuideAdminTokenVerification = GoogleTokenVerification;
export type GuideAdminTokenVerifier = GoogleTokenVerifier;
export type GuideAdminAuthSettings = GoogleServiceIdentitySettings;

export const googleGuideAdminTokenVerifier: GuideAdminTokenVerifier = googleIdTokenVerifier;

export function guideAdminJson(body: unknown, status = 200): Response {
  return internalServiceJson(body, status);
}

export async function verifyGuideAdminServiceIdentity(
  request: Pick<Request, "headers">,
  settings: GuideAdminAuthSettings,
  verifier: GuideAdminTokenVerifier = googleGuideAdminTokenVerifier,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  const identity = await verifyGoogleServiceIdentity(request, settings, verifier);
  return identity.ok ? { ok: true } : { ok: false, response: serviceIdentityFailure(identity.kind) };
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
