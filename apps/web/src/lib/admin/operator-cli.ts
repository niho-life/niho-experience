import "server-only";
import { createHash } from "node:crypto";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { OPERATOR_AI_KINDS, OPERATOR_WRITE_METHODS, adminActorIdForGoogleSubject, type OperatorAiKind } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { operatorCliRequests } from "@/lib/experience/store-server";
import { isVerificationOutage } from "@/lib/google-service-identity";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { ADMIN_GOOGLE_HOSTED_DOMAIN } from "@/lib/resolve-config";
import { adminEmailAllowed, nowUtc } from "./google-login";

/*
 * 運営の CLI (#576, docs/operator-cli.md): /admin/api also takes a signed-in admin's own Google ID token as a Bearer token,
 * from a command line (`gcloud auth print-identity-token`). `src/proxy.ts` checks it (below), records every request that
 * changes something in operator_cli_requests, and hands the route handlers a short-lived sealed assertion in a header it
 * sets itself; `loadAdminHttpSession` then treats it as the admin's session. Nothing from Google is kept, no fixed key
 * exists, and the same allowlist as the Admin login decides on every request. Tokens, addresses and bodies are never logged.
 */

/** Set by the proxy only (it deletes any value a client sends); sealed with ADMIN_SESSION_SECRET. */
export const OPERATOR_ASSERTION_HEADER = "x-niho-operator-assertion";
/** Who the caller says it is working for: one of OPERATOR_AI_KINDS. A claim, not proof. */
export const OPERATOR_AI_HEADER = "x-niho-operator-ai";
/** The caller's ID for one operation; a write needs it, and a repeat of the same ID is refused. */
export const OPERATOR_OPERATION_HEADER = "x-niho-operation-id";

const API_PREFIX = "/admin/api/";
/**
 * The /admin/api areas open to the CLI (the first path segment after /admin/api/). Everything else answers 403, so a
 * refund, a payout or a payout account (#576: never from a CLI) cannot be reached by adding a route. A stage adds its own area here.
 */
export const OPERATOR_API_AREAS: readonly string[] = Object.freeze(["product-classifications", "people"]);

export const operatorApiPath = (pathname: string): boolean => pathname.startsWith(API_PREFIX);
export const operatorApiAllowed = (pathname: string): boolean => operatorApiPath(pathname) && OPERATOR_API_AREAS.includes(pathname.slice(API_PREFIX.length).split("/", 1)[0]!);

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_SUBJECT = /^[\x21-\x7E]{1,255}$/;
const ADMIN_EMAIL = /^[a-z0-9._%+-]{1,64}@niho\.life$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096})$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,64}$/;
/** The largest body the CLI sends through the proxy (the BFFs' own limits are smaller or equal). */
export const OPERATOR_BODY_LIMIT = 1024 * 1024;
/** How long the sealed assertion the proxy hands to a route handler is good for. */
export const OPERATOR_ASSERTION_TTL_MS = 60_000;

export const isWriteMethod = (method: string): boolean => (OPERATOR_WRITE_METHODS as readonly string[]).includes(method);

export interface OperatorIdentity {
  readonly sub: string;
  /** Lower case, in @niho.life. */
  readonly email: string;
}

/**
 * The claims a CLI token must carry, checked on a payload whose signature, audience, issuer and expiry
 * google-auth-library has already verified (checked again here, like adminGoogleIdentity; there is no nonce in a token
 * `gcloud` prints): Google as issuer, one of the accepted clients as audience, unexpired, a verified address, the
 * Workspace domain as `hd` and in the address, and a subject. null for anything else.
 */
export function operatorIdentity(payload: TokenPayload | undefined, expected: { readonly audiences: readonly string[]; readonly now: number }): OperatorIdentity | null {
  if (!payload) return null;
  if (!GOOGLE_ISSUERS.has(payload.iss) || typeof payload.aud !== "string" || !expected.audiences.includes(payload.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= expected.now) return null;
  if (payload.email_verified !== true || payload.hd !== ADMIN_GOOGLE_HOSTED_DOMAIN) return null;
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!ADMIN_EMAIL.test(email)) return null;
  if (typeof payload.sub !== "string" || !GOOGLE_SUBJECT.test(payload.sub)) return null;
  return { sub: payload.sub, email };
}

const googleClient = new OAuth2Client();

export type OperatorTokenCheck =
  | { readonly ok: true; readonly actorId: string; readonly email: string }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly error: "unauthenticated" | "forbidden" | "unavailable" };

/** Verifies a Bearer ID token against Google's keys and the Admin allowlist. A Google outage is 503, never a sign-in. */
export async function checkOperatorToken(authorization: string | null, now = Date.now()): Promise<OperatorTokenCheck> {
  const token = authorization ? BEARER.exec(authorization)?.[1] : undefined;
  if (!token) return { ok: false, status: 401, error: "unauthenticated" };
  let payload: TokenPayload | undefined;
  try {
    payload = (await googleClient.verifyIdToken({ idToken: token, audience: [...config.operatorCliAudiences] })).getPayload();
  } catch (error) {
    return isVerificationOutage(error) ? { ok: false, status: 503, error: "unavailable" } : { ok: false, status: 401, error: "unauthenticated" };
  }
  const identity = operatorIdentity(payload, { audiences: config.operatorCliAudiences, now });
  if (!identity) return { ok: false, status: 401, error: "unauthenticated" };
  if (!adminEmailAllowed(identity.email)) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true, actorId: adminActorIdForGoogleSubject(identity.sub), email: identity.email };
}

export interface OperatorAssertion {
  readonly actorId: string;
  readonly email: string;
  readonly aiKind: OperatorAiKind;
  readonly operationId: string | null;
  readonly method: string;
  readonly path: string;
  readonly expiresAt: number;
}

interface AssertionWire { v: 1; a: string; e: string; ai: string; op: string | null; m: string; p: string; x: number }

const sealer = () => cookieSealer(config.adminSessionSecret, "operator-cli-assertion");

export function sealOperatorAssertion(assertion: OperatorAssertion): string {
  return sealer().seal({ v: 1, a: assertion.actorId, e: assertion.email, ai: assertion.aiKind, op: assertion.operationId, m: assertion.method, p: assertion.path, x: assertion.expiresAt } satisfies AssertionWire);
}

/** The assertion a proxy sealed, or null for anything missing, tampered with, expired or malformed. */
export function openOperatorAssertion(raw: string | null | undefined, now: number): OperatorAssertion | null {
  const wire = sealer().open(raw) as Partial<AssertionWire> | null;
  if (!wire || wire.v !== 1 || typeof wire.x !== "number" || wire.x <= now || wire.x > now + OPERATOR_ASSERTION_TTL_MS) return null;
  if (typeof wire.a !== "string" || typeof wire.e !== "string" || typeof wire.m !== "string" || typeof wire.p !== "string") return null;
  if (!(OPERATOR_AI_KINDS as readonly string[]).includes(wire.ai as string)) return null;
  if (!(wire.op === null || (typeof wire.op === "string" && OPERATION_ID.test(wire.op)))) return null;
  return { actorId: wire.a, email: wire.e, aiKind: wire.ai as OperatorAiKind, operationId: wire.op, method: wire.m, path: wire.p, expiresAt: wire.x };
}

export type OperatorGate =
  | { readonly kind: "refuse"; readonly status: number; readonly error: string }
  | { readonly kind: "forward"; readonly assertion: string };

/**
 * What the proxy does with one /admin/api request that carries a Bearer token (the CLI flag is on): refuse it, or
 * authenticate it, record it when it changes something, and give back the sealed assertion for the route handlers.
 */
export async function gateOperatorRequest(request: Request, now = Date.now()): Promise<OperatorGate> {
  const { pathname } = new URL(request.url);
  if (!operatorApiAllowed(pathname)) return { kind: "refuse", status: 403, error: "not_available_from_cli" };
  const method = request.method.toUpperCase();
  const write = isWriteMethod(method);
  if (!write && method !== "GET" && method !== "HEAD") return { kind: "refuse", status: 405, error: "method_not_allowed" };
  const aiHeader = request.headers.get(OPERATOR_AI_HEADER);
  const aiKind = aiHeader === null && !write ? "other" : (OPERATOR_AI_KINDS as readonly string[]).includes(aiHeader ?? "") ? aiHeader as OperatorAiKind : null;
  if (!aiKind) return { kind: "refuse", status: 400, error: "invalid_input" };
  const operationId = request.headers.get(OPERATOR_OPERATION_HEADER);
  if (write && (!operationId || !OPERATION_ID.test(operationId))) return { kind: "refuse", status: 400, error: "invalid_input" };
  const checked = await checkOperatorToken(request.headers.get("authorization"), now);
  if (!checked.ok) return { kind: "refuse", status: checked.status, error: checked.error };
  if (write) {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > OPERATOR_BODY_LIMIT) return { kind: "refuse", status: 413, error: "invalid_input" };
    const body = Buffer.from(await request.clone().arrayBuffer());
    if (body.length > OPERATOR_BODY_LIMIT) return { kind: "refuse", status: 413, error: "invalid_input" };
    const requests = operatorCliRequests();
    if (!requests) return { kind: "refuse", status: 503, error: "unavailable" };
    try {
      const recorded = await requests.record({
        adminActorId: checked.actorId, operationId: operationId!, aiKind, method: method as never, path: pathname,
        bodySha256: createHash("sha256").update(body).digest("hex"), nowUtc: nowUtc(now),
      });
      if (recorded.status === "duplicate") return { kind: "refuse", status: 409, error: "operation_already_recorded" };
    } catch {
      return { kind: "refuse", status: 503, error: "unavailable" };
    }
  }
  return {
    kind: "forward",
    assertion: sealOperatorAssertion({ actorId: checked.actorId, email: checked.email, aiKind, operationId: write ? operationId : null, method, path: pathname, expiresAt: now + OPERATOR_ASSERTION_TTL_MS }),
  };
}
