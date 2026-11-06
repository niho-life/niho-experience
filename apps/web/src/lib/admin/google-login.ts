import "server-only";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import type { NextResponse } from "next/server";
import type { AdminSessions } from "@niho-experience/experience-store";
import type { GoogleSignInClient } from "@niho-experience/google-calendar";
import { config } from "@/lib/config";
import { adminSessions } from "@/lib/experience/store-server";
import { isVerificationOutage } from "@/lib/google-service-identity";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { loginStatesMatch } from "@/lib/host/pkce";
import { ADMIN_GOOGLE_HOSTED_DOMAIN } from "@/lib/resolve-config";
import type { AdminActor } from "./actor";
import { adminHttpCookieOptions } from "./http-session";
import { ADMIN_GOOGLE_CALLBACK_PATH } from "./routes";

/*
 * Admin のログイン (ADR 0003 decision 4, EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED, docs/admin-auth.md): /admin signs staff in
 * with Google (OpenID Connect, authorization code + PKCE, `openid email` only) and Experience decides who is an admin
 * from EXPERIENCE_ADMIN_ALLOWED_EMAILS, at sign-in and on every request. NIHO is not called. Nothing from Google is
 * kept after sign-in: the session is Experience's own (admin_sessions, only the SHA-256 of its token), the cookie holds
 * the opaque token. Session tokens, codes, ID tokens and addresses are never logged or put in a URL.
 */

/** The opaque session token, on every path (`__Host-`: Secure, no Domain, Path=/), HttpOnly, SameSite=Lax. */
export const ADMIN_GOOGLE_SESSION_COOKIE = "__Host-niho_admin_session";
/** The sign-in's verifier, state, nonce and return path, sealed, on the Google auth paths only, for 10 minutes. */
export const ADMIN_GOOGLE_LOGIN_COOKIE = "__Secure-niho_admin_google_login";
export const ADMIN_GOOGLE_LOGIN_COOKIE_PATH = "/admin/auth/google";
export const ADMIN_GOOGLE_LOGIN_MAX_AGE_SECONDS = 10 * 60;

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const GOOGLE_SUBJECT = /^[\x21-\x7E]{1,255}$/;
const ADMIN_EMAIL = /^[a-z0-9._%+-]{1,64}@niho\.life$/;
const LOGIN_TEXT = /^[A-Za-z0-9_-]{22,128}$/;

/** A session token's shape (32 random bytes, base64url). */
export const isAdminSessionToken = (value: unknown): value is string => typeof value === "string" && OPAQUE_TOKEN.test(value);

/** The canonical UTC instant the store takes for "now". */
export const nowUtc = (now = Date.now()): string => new Date(now).toISOString();

/** Whether an address may sign in: it is on EXPERIENCE_ADMIN_ALLOWED_EMAILS (compared in lower case). */
export function adminEmailAllowed(email: string): boolean {
  return config.adminAllowedEmails.includes(email.toLowerCase());
}

/** The Google OAuth client (the host console's Calendar client) with the Admin redirect URI; null without its settings. */
export function adminGoogleClient(): GoogleSignInClient | null {
  const clientId = process.env.EXPERIENCE_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !config.adminOrigin) return null;
  return { clientId, clientSecret, redirectUri: `${config.adminOrigin}${ADMIN_GOOGLE_CALLBACK_PATH}` };
}

export interface AdminGoogleLoginState {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}

interface LoginWire extends AdminGoogleLoginState {
  readonly v: 1;
  readonly mode: "google";
}

const loginSealer = () => cookieSealer(config.adminSessionSecret, "admin-google-login");

export function encodeAdminGoogleLogin(login: AdminGoogleLoginState): string {
  return loginSealer().seal({ v: 1, mode: "google", ...login } satisfies LoginWire);
}

export function decodeAdminGoogleLogin(raw: string | null | undefined, now: number): AdminGoogleLoginState | null {
  const wire = loginSealer().open(raw) as Partial<LoginWire> | null;
  if (!wire || wire.v !== 1 || wire.mode !== "google") return null;
  if (typeof wire.verifier !== "string" || !LOGIN_TEXT.test(wire.verifier)) return null;
  if (typeof wire.state !== "string" || !LOGIN_TEXT.test(wire.state)) return null;
  if (typeof wire.nonce !== "string" || !LOGIN_TEXT.test(wire.nonce)) return null;
  if (typeof wire.returnTo !== "string" || wire.returnTo.length > 128) return null;
  if (typeof wire.expiresAt !== "number" || !Number.isFinite(wire.expiresAt) || now >= wire.expiresAt) return null;
  return { verifier: wire.verifier, state: wire.state, nonce: wire.nonce, returnTo: wire.returnTo, expiresAt: wire.expiresAt };
}

/** What a verified Google ID token says about the person signing in. */
export interface AdminGoogleIdentity {
  readonly sub: string;
  /** Lower case, in @niho.life. */
  readonly email: string;
}

/**
 * The claims this login needs, checked on a payload whose signature, audience, issuer and expiry google-auth-library has
 * already verified (checked again here): the issuer is Google, the audience our client, unexpired, the nonce the one
 * this browser's sign-in sent (constant time), a verified address, the Workspace domain both as `hd` and in the address,
 * and a subject. null for anything else.
 */
export function adminGoogleIdentity(payload: TokenPayload | undefined, expected: { readonly clientId: string; readonly nonce: string; readonly now: number }): AdminGoogleIdentity | null {
  if (!payload) return null;
  if (!GOOGLE_ISSUERS.has(payload.iss) || payload.aud !== expected.clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= expected.now) return null;
  if (typeof payload.nonce !== "string" || !loginStatesMatch(expected.nonce, payload.nonce)) return null;
  if (payload.email_verified !== true || payload.hd !== ADMIN_GOOGLE_HOSTED_DOMAIN) return null;
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!ADMIN_EMAIL.test(email)) return null;
  if (typeof payload.sub !== "string" || !GOOGLE_SUBJECT.test(payload.sub)) return null;
  return { sub: payload.sub, email };
}

export type AdminGoogleVerification =
  | { readonly ok: true; readonly identity: AdminGoogleIdentity }
  | { readonly ok: false; readonly kind: "invalid" | "outage" };

const googleClient = new OAuth2Client();

/** Verifies an ID token's signature against Google's keys (google-auth-library), then adminGoogleIdentity. */
export async function verifyAdminGoogleIdToken(idToken: string, expected: { readonly clientId: string; readonly nonce: string; readonly now: number }): Promise<AdminGoogleVerification> {
  let payload: TokenPayload | undefined;
  try {
    payload = (await googleClient.verifyIdToken({ idToken, audience: expected.clientId })).getPayload();
  } catch (error) {
    return { ok: false, kind: isVerificationOutage(error) ? "outage" : "invalid" };
  }
  const identity = adminGoogleIdentity(payload, expected);
  return identity ? { ok: true, identity } : { ok: false, kind: "invalid" };
}

/** An Admin signed in with Google: an Experience session, which carries no NIHO admin token. */
export interface ExperienceAdminSession {
  readonly kind: "experience";
  readonly sessionRef: string;
  readonly email: string;
  readonly authenticatedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export type ExperienceAdminSessionLoad =
  | { readonly status: "ok"; readonly kind: "experience"; readonly actor: AdminActor; readonly session: ExperienceAdminSession }
  | { readonly status: "signed-out" }
  | { readonly status: "rejected" }
  | { readonly status: "error" };

/**
 * The admin a session cookie stands for, checked on every request: no cookie is signed-out; a session that ended, or
 * whose address is no longer on the allowlist (its sessions are then signed out), is rejected; a store failure is an
 * error, never a sign-in.
 */
export async function loadExperienceAdminSession(
  token: string | undefined,
  store: Pick<AdminSessions, "readSession" | "revokeActorSessions"> | null = adminSessions(),
): Promise<ExperienceAdminSessionLoad> {
  if (!isAdminSessionToken(token)) return { status: "signed-out" };
  if (!store) return { status: "error" };
  try {
    const session = await store.readSession({ sessionToken: token, nowUtc: nowUtc() });
    if (!session) return { status: "rejected" };
    if (!adminEmailAllowed(session.email)) {
      await store.revokeActorSessions({ adminActorId: session.adminActorId, nowUtc: nowUtc() });
      return { status: "rejected" };
    }
    return {
      status: "ok",
      kind: "experience",
      actor: { id: session.adminActorId, displayName: session.email },
      session: {
        kind: "experience",
        sessionRef: session.sessionRef,
        email: session.email,
        authenticatedAt: Date.parse(session.authenticatedAtUtc),
        idleExpiresAt: Date.parse(session.idleExpiresAtUtc),
        absoluteExpiresAt: Date.parse(session.absoluteExpiresAtUtc),
      },
    };
  } catch {
    return { status: "error" };
  }
}

export function setAdminGoogleSessionCookie(response: NextResponse, sessionToken: string, absoluteExpiresAtUtc: string, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((Date.parse(absoluteExpiresAtUtc) - now) / 1000));
  response.cookies.set(ADMIN_GOOGLE_SESSION_COOKIE, sessionToken, adminHttpCookieOptions("/", maxAge));
}

export function clearAdminGoogleSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_GOOGLE_SESSION_COOKIE, "", adminHttpCookieOptions("/", 0));
}

export function setAdminGoogleLoginCookie(response: NextResponse, login: AdminGoogleLoginState) {
  response.cookies.set(ADMIN_GOOGLE_LOGIN_COOKIE, encodeAdminGoogleLogin(login), adminHttpCookieOptions(ADMIN_GOOGLE_LOGIN_COOKIE_PATH, ADMIN_GOOGLE_LOGIN_MAX_AGE_SECONDS));
}

export function clearAdminGoogleLoginCookie(response: NextResponse) {
  response.cookies.set(ADMIN_GOOGLE_LOGIN_COOKIE, "", adminHttpCookieOptions(ADMIN_GOOGLE_LOGIN_COOKIE_PATH, 0));
}
