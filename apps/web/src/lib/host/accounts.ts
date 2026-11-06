import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import type { HostAccounts } from "@niho-experience/experience-store";
import { hostAccounts } from "@/lib/experience/store-server";
import { usableProviders, type HostProvider } from "./providers";
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_COOKIE_PATH,
  hostCookieOptions,
  LINK_BINDING_COOKIE,
  LINK_BINDING_COOKIE_PATH,
  LINK_BINDING_MAX_AGE_SECONDS,
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

/**
 * One field of a small urlencoded form, reading the actual request stream (a missing or false Content-Length cannot
 * get past the cap). Anything else in the form, the field twice, or invalid UTF-8 is a 400.
 */
export async function readSingleFieldForm(request: Request, field: string, maxBytes: number): Promise<SingleFieldForm> {
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
  const entries = [...new URLSearchParams(text).entries()];
  return entries.length === 1 && entries[0]![0] === field ? { ok: true, value: entries[0]![1] } : { ok: false, status: 400 };
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
