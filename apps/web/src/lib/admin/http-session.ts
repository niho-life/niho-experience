import type { CookieSealer } from "@/lib/host/cookie-seal";
import { cookieFits } from "@/lib/host/session";
import { EXPERIENCE_ADMIN_CLIENT_ID } from "@niho-experience/api-client/admin-auth";

export const ADMIN_HTTP_SESSION_COOKIE = "__Secure-niho_admin_http_session";
export const ADMIN_HTTP_LOGIN_COOKIE = "__Secure-niho_admin_http_login";
export const ADMIN_HTTP_SESSION_PATH = "/admin";
export const ADMIN_HTTP_LOGIN_PATH = "/admin/auth";
export const ADMIN_HTTP_LOGIN_MAX_AGE_SECONDS = 10 * 60;
export const ADMIN_HTTP_ABSOLUTE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface AdminHttpSession {
  refreshToken: string;
  idToken: string;
  idTokenExpiresAt: number;
  connectionId: string;
  connectionExpiresAt: number;
  actorId: string;
  actorName: string | null;
}

export interface AdminHttpLoginState {
  verifier: string;
  state: string;
  returnTo: string;
  expiresAt: number;
}

interface SessionWire {
  v: 1;
  mode: "http";
  client: typeof EXPERIENCE_ADMIN_CLIENT_ID;
  r: string;
  t: string;
  te: number;
  c: string;
  ce: number;
  a: string;
  n: string | null;
}

interface LoginWire {
  v: 1;
  mode: "http";
  client: typeof EXPERIENCE_ADMIN_CLIENT_ID;
  verifier: string;
  state: string;
  returnTo: string;
  expiresAt: number;
}

const isText = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function cleanActorName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, 80) || null;
}

export function startAdminHttpSession(
  fields: Omit<AdminHttpSession, "connectionExpiresAt"> & { exchangedConnectionExpiresAt: number; verifiedConnectionExpiresAt: number },
  now: number,
): AdminHttpSession | null {
  const connectionExpiresAt = Math.min(fields.exchangedConnectionExpiresAt, fields.verifiedConnectionExpiresAt, now + ADMIN_HTTP_ABSOLUTE_MAX_AGE_MS);
  if (!isTime(connectionExpiresAt) || connectionExpiresAt <= now || fields.idTokenExpiresAt <= now) return null;
  return {
    refreshToken: fields.refreshToken,
    idToken: fields.idToken,
    idTokenExpiresAt: fields.idTokenExpiresAt,
    connectionId: fields.connectionId,
    connectionExpiresAt,
    actorId: fields.actorId,
    actorName: cleanActorName(fields.actorName),
  };
}

export function encodeAdminHttpSession(sealer: CookieSealer, session: AdminHttpSession): string {
  const value = sealer.seal({
    v: 1,
    mode: "http",
    client: EXPERIENCE_ADMIN_CLIENT_ID,
    r: session.refreshToken,
    t: session.idToken,
    te: session.idTokenExpiresAt,
    c: session.connectionId,
    ce: session.connectionExpiresAt,
    a: session.actorId,
    n: session.actorName,
  } satisfies SessionWire);
  if (!cookieFits(ADMIN_HTTP_SESSION_COOKIE, value)) throw new Error("The Admin session does not fit in one cookie");
  return value;
}

export function decodeAdminHttpSession(sealer: CookieSealer, raw: string | null | undefined, now: number): AdminHttpSession | null {
  const wire = sealer.open(raw) as Partial<SessionWire> | null;
  if (!wire || wire.v !== 1 || wire.mode !== "http" || wire.client !== EXPERIENCE_ADMIN_CLIENT_ID) return null;
  if (!isText(wire.r) || !isText(wire.t) || !isText(wire.c, 256) || !isText(wire.a, 256)) return null;
  if (!isTime(wire.te) || !isTime(wire.ce) || now >= wire.ce) return null;
  if (!(wire.n === null || typeof wire.n === "string")) return null;
  return {
    refreshToken: wire.r,
    idToken: wire.t,
    idTokenExpiresAt: wire.te,
    connectionId: wire.c,
    connectionExpiresAt: wire.ce,
    actorId: wire.a,
    actorName: cleanActorName(wire.n),
  };
}

export function encodeAdminHttpLogin(sealer: CookieSealer, login: AdminHttpLoginState): string {
  return sealer.seal({ v: 1, mode: "http", client: EXPERIENCE_ADMIN_CLIENT_ID, ...login } satisfies LoginWire);
}

export function decodeAdminHttpLogin(sealer: CookieSealer, raw: string | null | undefined, now: number): AdminHttpLoginState | null {
  const wire = sealer.open(raw) as Partial<LoginWire> | null;
  if (!wire || wire.v !== 1 || wire.mode !== "http" || wire.client !== EXPERIENCE_ADMIN_CLIENT_ID) return null;
  if (!isText(wire.verifier, 128) || !isText(wire.state, 128) || !isText(wire.returnTo, 128) || !isTime(wire.expiresAt) || now >= wire.expiresAt) return null;
  return { verifier: wire.verifier, state: wire.state, returnTo: wire.returnTo, expiresAt: wire.expiresAt };
}

export function adminHttpCookieOptions(path: string, maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path, maxAge };
}

export function adminHttpSessionMaxAgeSeconds(session: AdminHttpSession, now: number): number {
  return Math.max(0, Math.floor((session.connectionExpiresAt - now) / 1000));
}
