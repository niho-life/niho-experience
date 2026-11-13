import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import type { HostAccounts } from "@niho-experience/experience-store";
import { hostAccounts } from "@/lib/experience/store-server";
import { usableProviders, type HostProvider } from "./providers";
import { hostReturnPathOrNull } from "./routes";
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_COOKIE_PATH,
  hostCookieOptions,
  INVITE_BINDING_COOKIE,
  INVITE_BINDING_COOKIE_PATH,
  INVITE_BINDING_MAX_AGE_SECONDS,
  LINK_BINDING_COOKIE,
  LINK_BINDING_COOKIE_PATH,
  LINK_BINDING_MAX_AGE_SECONDS,
  RETURN_PATH_COOKIE,
  type ExperienceHostSession,
} from "./session";

/*
 * ホストのアカウント (ADR 0003 slice 2, EXPERIENCE_HOST_ACCOUNTS_ENABLED, docs/host-accounts.md): the web side of the store's
 * HostAccounts. A session token, a link token and a binding value are 32 random bytes in base64url; none of them, nor an
 * address, is ever logged, put in a URL or sent to the browser's JavaScript.
 */

const OPAQUE_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes in base64url, as the store makes its tokens: the shape of every secret of this flow. */
export const isOpaqueSecret = (value: unknown): value is string => typeof value === "string" && OPAQUE_SECRET.test(value);

/** A new value for the link cookie: 32 random bytes, base64url. */
export function newLinkBinding(): string {
  return randomBytes(32).toString("base64url");
}

/** What the store keeps and compares for the requesting browser: the SHA-256 of the link cookie's value. */
export function linkBindingHash(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The canonical UTC instant the store takes for "now". */
export const nowUtc = (now = Date.now()): string => new Date(now).toISOString();

/**
 * The Experience session a cookie stands for, or null (no cookie, a malformed one, signed out, expired, the account
 * suspended). A store failure throws: the request fails instead of reading as signed out.
 */
export async function readExperienceHostSession(token: string | undefined, store: Pick<HostAccounts, "readSession"> | null = hostAccounts()): Promise<ExperienceHostSession | null> {
  if (!isOpaqueSecret(token) || !store) return null;
  const session = await store.readSession({ sessionToken: token, nowUtc: nowUtc() });
  if (!session) return null;
  return {
    kind: "experience",
    sessionToken: token,
    hostAccountId: session.hostAccountId,
    email: session.email,
    sessionRef: session.sessionRef,
    authenticatedAtUtc: session.authenticatedAtUtc,
    idleExpiresAtUtc: session.idleExpiresAtUtc,
    absoluteExpiresAtUtc: session.absoluteExpiresAtUtc,
    displayName: session.email,
    iconUrl: null,
  };
}

/**
 * The providers an Experience session may open, from the experience DB alone (its OWNER and EDITOR memberships). Each
 * carries the host account ID where the NIHO login carries the NIHO user ID. A provider without a NIHO seller profile
 * has no legacy Connect lookup key (""); nothing that uses one runs for an Experience session.
 */
export async function listExperienceHostProviders(session: ExperienceHostSession, store: Pick<HostAccounts, "listProviderMemberships"> | null = hostAccounts()): Promise<HostProvider[] | null> {
  if (!store) return null;
  const memberships = await store.listProviderMemberships({ hostAccountId: session.hostAccountId });
  return usableProviders(memberships.map((membership) => ({
    id: membership.providerId,
    legacyProviderId: membership.legacyProviderId ?? "",
    displayName: membership.displayName,
    memberRole: membership.memberRole,
    nihoUserId: session.hostAccountId,
  })));
}

const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;|$)/i;

export type SingleFieldForm = { ok: true; value: string } | { ok: false; status: 400 | 413 | 415 };
export type SmallForm = { ok: true; values: ReadonlyMap<string, string> } | { ok: false; status: 400 | 413 | 415 };

/**
 * One field of a small urlencoded form, reading the actual request stream (a missing or false Content-Length cannot
 * get past the cap). Anything else in the form, the field twice, or invalid UTF-8 is a 400.
 */
export async function readSingleFieldForm(request: Request, field: string, maxBytes: number): Promise<SingleFieldForm> {
  const form = await readSmallForm(request, [field], [field], maxBytes);
  return form.ok ? { ok: true, value: form.values.get(field)! } : form;
}

/**
 * A small urlencoded form of known fields, read as readSingleFieldForm reads one: each field at most once, every
 * `required` one present, nothing else (400), within `maxBytes` (413), urlencoded only (415).
 */
export async function readSmallForm(request: Request, fields: readonly string[], required: readonly string[], maxBytes: number): Promise<SmallForm> {
  if (!FORM_TYPE.test(request.headers.get("content-type") ?? "")) return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) return { ok: false, status: 413 };
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, status: 400 };
  } finally {
    try { await reader.cancel(); } catch { /* The size or decoding answer stays. */ }
    finally { reader.releaseLock(); }
  }
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(text).entries()) {
    if (!fields.includes(name) || values.has(name)) return { ok: false, status: 400 };
    values.set(name, value);
  }
  return required.every((name) => values.has(name)) ? { ok: true, values } : { ok: false, status: 400 };
}

/** The session cookie: the opaque token, HttpOnly, Secure, SameSite=Lax, Path=/, living no longer than the session. */
export function setAccountSessionCookie(response: NextResponse, sessionToken: string, absoluteExpiresAtUtc: string, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((Date.parse(absoluteExpiresAtUtc) - now) / 1000));
  response.cookies.set(ACCOUNT_SESSION_COOKIE, sessionToken, hostCookieOptions(ACCOUNT_SESSION_COOKIE_PATH, maxAge));
}

export function clearAccountSessionCookie(response: NextResponse) {
  response.cookies.set(ACCOUNT_SESSION_COOKIE, "", hostCookieOptions(ACCOUNT_SESSION_COOKIE_PATH, 0));
}

/** The link cookie: the binding value, on /host/auth only, for a link's 15 minutes. */
export function setLinkBindingCookie(response: NextResponse, value: string) {
  response.cookies.set(LINK_BINDING_COOKIE, value, hostCookieOptions(LINK_BINDING_COOKIE_PATH, LINK_BINDING_MAX_AGE_SECONDS));
}

export function clearLinkBindingCookie(response: NextResponse) {
  response.cookies.set(LINK_BINDING_COOKIE, "", hostCookieOptions(LINK_BINDING_COOKIE_PATH, 0));
}

/** The invitation link's cookie: the binding value of the browser that opened the link, on /host/auth only, for the invitation's days. */
export function setInviteBindingCookie(response: NextResponse, value: string) {
  response.cookies.set(INVITE_BINDING_COOKIE, value, hostCookieOptions(INVITE_BINDING_COOKIE_PATH, INVITE_BINDING_MAX_AGE_SECONDS));
}

export function clearInviteBindingCookie(response: NextResponse) {
  response.cookies.set(INVITE_BINDING_COOKIE, "", hostCookieOptions(INVITE_BINDING_COOKIE_PATH, 0));
}

/** Where the sign-in returns (an allowlisted path only), beside the link cookie for the link's 15 minutes. */
export function setReturnPathCookie(response: NextResponse, path: string) {
  const allowed = hostReturnPathOrNull(path);
  if (!allowed) return;
  response.cookies.set(RETURN_PATH_COOKIE, Buffer.from(allowed, "utf8").toString("base64url"), hostCookieOptions(LINK_BINDING_COOKIE_PATH, LINK_BINDING_MAX_AGE_SECONDS));
}

export function clearReturnPathCookie(response: NextResponse) {
  response.cookies.set(RETURN_PATH_COOKIE, "", hostCookieOptions(LINK_BINDING_COOKIE_PATH, 0));
}

/** The allowlisted path a return cookie holds, or null for none or anything else. */
export function returnPathFromCookie(value: string | undefined): string | null {
  if (!value || value.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return hostReturnPathOrNull(Buffer.from(value, "base64url").toString("utf8"));
}
