import type { NextRequest, NextResponse } from "next/server";
import { HOST_PROVIDER_OWNER_LIMIT, ProviderPublicNameError, StoreRateLimitedError, StoreValidationError, isHostEmail } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccountIdentities, hostAccounts } from "@/lib/experience/store-server";
import { nowUtc } from "@/lib/host/accounts";
import { readBoundedJson } from "@/lib/host/bounded-json";
import { HOST_TERMS_VERSION } from "@/lib/host/host-terms";
import { endPreviousSession, setSignedInCookies } from "@/lib/host/niho-login";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_HOME_PATH, HOST_MOCK_LOGIN_PATH, withProvider } from "@/lib/host/routes";
import { REGISTRATION_EMAIL_MAX, REGISTRATION_NAME_MAX, type RegistrationErrorCode, type RegistrationErrorField } from "@/lib/host/self-registration-form";
import { readRegistrationSource } from "@/lib/host/self-registration-server";
import { clearRegistrationCookie, hostNotFound, isHostMock, noStoreJson, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, REGISTRATION_COOKIE } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Two names, an address and a few flags. */
const MAX_BODY_BYTES = 4 * 1024;
const BODY_KEYS = ["providerKind", "publicDisplayName", "publicDisplayNameEn", "notificationEmail", "hostTermsVersion", "termsAccepted"] as const;

function failure(code: RegistrationErrorCode, status: number, extra: { field?: RegistrationErrorField; limit?: number; retryAfterSeconds?: number } = {}): NextResponse {
  const response = noStoreJson({ error: { code, ...(extra.field ? { field: extra.field } : {}), ...(extra.limit ? { limit: extra.limit } : {}) } }, status);
  if (extra.retryAfterSeconds) response.headers.set("retry-after", String(extra.retryAfterSeconds));
  return response;
}

type Parsed =
  | { ok: true; value: { providerKind: "PERSON" | "BUSINESS"; publicDisplayName: string; publicDisplayNameEn: string | null; notificationEmail: string; hostTermsVersion: string } }
  | { ok: false; response: NextResponse };

/** The body, checked before anything is read from the store: the shape, the lengths, the address, the agreement. */
function parse(body: unknown): Parsed {
  const bad = (response: NextResponse): Parsed => ({ ok: false, response });
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad(failure("INVALID_INPUT", 400));
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== BODY_KEYS.length || !BODY_KEYS.every((key) => Object.hasOwn(record, key))) return bad(failure("INVALID_INPUT", 400));
  const { providerKind, publicDisplayName, publicDisplayNameEn, notificationEmail, hostTermsVersion, termsAccepted } = record;
  if (providerKind !== "PERSON" && providerKind !== "BUSINESS") return bad(failure("INVALID_INPUT", 400));
  if (typeof publicDisplayName !== "string" || (publicDisplayNameEn !== null && typeof publicDisplayNameEn !== "string") || typeof notificationEmail !== "string"
    || typeof hostTermsVersion !== "string" || typeof termsAccepted !== "boolean") return bad(failure("INVALID_INPUT", 400));
  const name = publicDisplayName.trim();
  if (name === "" || name.length > REGISTRATION_NAME_MAX) return bad(failure("PUBLIC_NAME_INVALID", 422, { field: "name" }));
  const english = publicDisplayNameEn === null ? null : publicDisplayNameEn.trim() || null;
  if (english !== null && english.length > REGISTRATION_NAME_MAX) return bad(failure("PUBLIC_NAME_INVALID", 422, { field: "nameEn" }));
  const email = notificationEmail.trim();
  if (email.length > REGISTRATION_EMAIL_MAX || !isHostEmail(email)) return bad(failure("EMAIL_INVALID", 422, { field: "email" }));
  if (termsAccepted !== true) return bad(failure("TERMS_REQUIRED", 422, { field: "terms" }));
  // The terms page the person read is not the current one (it was opened before the wording changed): read it again.
  if (hostTermsVersion !== HOST_TERMS_VERSION) return bad(failure("INVALID_INPUT", 409));
  return { ok: true, value: { providerKind, publicDisplayName: name, publicDisplayNameEn: english, notificationEmail: email, hostTermsVersion } };
}

/** What the store refused, in the codes the form speaks. A store failure is never described: the input stays and the form says so. */
function storeFailure(error: unknown): NextResponse {
  if (error instanceof ProviderPublicNameError) return failure(error.code, 422, { field: error.field === "publicDisplayNameEn" ? "nameEn" : "name" });
  if (error instanceof StoreRateLimitedError) return failure("RATE_LIMITED", 429, { retryAfterSeconds: error.retryAfterSeconds });
  if (error instanceof StoreValidationError) return /^email\b/.test(error.message) ? failure("EMAIL_INVALID", 422, { field: "email" }) : failure("INVALID_INPUT", 422);
  console.error(`[host-registration] not registered: ${error instanceof Error ? error.name : "unknown error"}`);
  return failure("UNAVAILABLE", 503);
}

/**
 * 登録する (Epic #700, #708, EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED): the registration screen's form posts here. Same-origin only.
 * Who is registering is decided by the server from the two cookies (self-registration-server.ts), never by the body:
 *
 * - the sealed registration cookie NIHO's return left → HostAccountIdentities.registerHostSelf makes the host account, its NIHO binding,
 *   the host (provider), its OWNER, the agreed name, the terms acceptance, the contact address (waiting for its confirmation email)
 *   and the session in one transaction; this answer sets the session cookie as a NIHO sign-in does and clears the registration cookie;
 * - else the signed-in account (a writer, a member, or someone who already owns hosts) → registerHostSelfForAccount adds the host to that
 *   account; the store refuses past HOST_PROVIDER_OWNER_LIMIT (409 OWNER_LIMIT_REACHED). The answer's redirect opens the new host (`?providerId=`).
 *
 * 200 `{ ok: true, redirect }` (the console's home, for the new host). Failures are `{ error: { code, field?, limit? } }`: the codes of
 * RegistrationErrorCode (self-registration-form.ts) and the status that goes with each. No NIHO user ID, address or name is logged.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostSelfRegistrationEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return failure("FORBIDDEN", 403);
  const read = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!read.ok) return failure("INVALID_INPUT", read.reason === "too_large" ? 413 : read.reason === "media_type" ? 415 : 400);
  const parsed = parse(read.value);
  if (!parsed.ok) return parsed.response;
  const form = parsed.value;

  let source: Awaited<ReturnType<typeof readRegistrationSource>>;
  try { source = await readRegistrationSource({ registration: request.cookies.get(REGISTRATION_COOKIE)?.value, session: request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value }); }
  catch { return failure("UNAVAILABLE", 503); }
  if (!source) return failure("REGISTRATION_EXPIRED", 401);

  // The preview keeps nothing: it only walks the screen to a synthetic signed-in host.
  if (isHostMock()) {
    const response = noStoreJson({ ok: true, redirect: HOST_MOCK_LOGIN_PATH });
    clearRegistrationCookie(response);
    return response;
  }

  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!identities || !accounts) return failure("UNAVAILABLE", 503);
  const now = Date.now();
  const details = { providerKind: form.providerKind, publicDisplayName: form.publicDisplayName, publicDisplayNameEn: form.publicDisplayNameEn, hostTermsVersion: form.hostTermsVersion, notificationEmail: form.notificationEmail };

  if (source.kind === "account") {
    let result;
    try { result = await identities.registerHostSelfForAccount({ hostAccountId: source.session.hostAccountId, nowUtc: nowUtc(now), ...details }); }
    catch (error) { return storeFailure(error); }
    if (result.kind === "owner-limit-reached") return failure("OWNER_LIMIT_REACHED", 409, { limit: HOST_PROVIDER_OWNER_LIMIT });
    if (result.kind === "account-suspended") return failure("ACCOUNT_SUSPENDED", 403);
    const response = noStoreJson({ ok: true, redirect: withProvider(HOST_HOME_PATH, result.providerId) });
    clearRegistrationCookie(response);
    return response;
  }

  const { registration } = source;
  let result;
  try {
    // `authTime` is when the person signed in at NIHO, never later than now (clock skew): the store reads its age.
    result = await identities.registerHostSelf({ nihoUserId: registration.nihoUserId, authenticatedAtUtc: nowUtc(Math.min(now, registration.authTimeMs)), nowUtc: nowUtc(now), ...details });
  } catch (error) { return storeFailure(error); }
  if (result.kind === "already-linked") {
    // A host account is bound to this NIHO account already (another tab registered, or the person had one): nothing was written; they sign in as usual.
    const response = failure("ALREADY_REGISTERED", 409);
    clearRegistrationCookie(response);
    return response;
  }
  if (result.kind === "owner-limit-reached") return failure("OWNER_LIMIT_REACHED", 409, { limit: HOST_PROVIDER_OWNER_LIMIT });
  if (result.kind === "account-suspended") return failure("ACCOUNT_SUSPENDED", 403);
  await endPreviousSession(request, accounts, result, now);
  const response = noStoreJson({ ok: true, redirect: withProvider(HOST_HOME_PATH, result.providerId) });
  clearRegistrationCookie(response);
  setSignedInCookies(response, result, now);
  return response;
}
