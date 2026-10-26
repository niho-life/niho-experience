import type { CookieSealer } from "./cookie-seal";
import { ID_TOKEN_MIN_REMAINING_MS, REFRESH_WINDOW_MS } from "./timing";

/**
 * The host console session (#86): NIHO's app-connect refresh token and the
 * current Firebase ID token, sealed in an HttpOnly cookie. The browser never
 * sees either token; client code only learns when the ID token expires.
 */
export const SESSION_COOKIE = "__Secure-niho_host_session";
export const LOGIN_COOKIE = "__Secure-niho_host_login";
export const SESSION_COOKIE_PATH = "/host";
export const LOGIN_COOKIE_PATH = "/host/auth";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_MAX_AGE_SECONDS = 10 * 60;
/** Browsers drop cookies whose name and value exceed 4096 bytes. */
export const COOKIE_BYTES_LIMIT = 4096;

const DISPLAY_NAME_MAX = 80;
const ICON_URL_MAX = 1024;

/**
 * Mock sessions only (`?mock=` on /host/auth/mock-login); mock-niho.ts maps them to the api-client mock's scenarios.
 * `calendar-revoked` is the default providers with the kitchen's Google Calendar access taken away in Google (#109).
 */
export type HostMockScenario = "default" | "empty" | "payments-pending" | "calendar-revoked";
export const HOST_MOCK_SCENARIOS: readonly HostMockScenario[] = ["default", "empty", "payments-pending", "calendar-revoked"];

export interface HostSession {
  refreshToken: string;
  idToken: string;
  /** Epoch ms. */
  idTokenExpiresAt: number;
  connectionId: string;
  /** Epoch ms. NIHO ends the connection here regardless of refreshes. */
  connectionExpiresAt: number;
  /** Epoch ms. Sliding: 30 days after the last sign-in or refresh, never past the connection. */
  expiresAt: number;
  displayName: string;
  iconUrl: string | null;
  /** Synthetic sessions only (mock mode): which provider list the mock API returns. */
  mockScenario?: HostMockScenario;
}

export interface HostLoginState {
  verifier: string;
  state: string;
  providerId: string | null;
  preparationCaseId: string | null;
  /** Epoch ms; the login cookie lives 10 minutes. */
  expiresAt: number;
}

interface SessionWire {
  v: 1;
  r: string;
  t: string;
  te: number;
  c: string;
  ce: number;
  x: number;
  n: string;
  p?: string;
  m?: HostMockScenario;
}

interface LoginWire {
  v: 1;
  pv: string;
  s: string;
  pid?: string;
  pc?: string;
  x: number;
}

export class HostSessionTooLargeError extends Error {
  constructor() {
    super("The host session does not fit in one cookie");
  }
}

const isString = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function cleanDisplayName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX) : "";
}

/** Only plain https image URLs are kept; anything else falls back to the initial. */
export function cleanIconUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > ICON_URL_MAX) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Builds a session after sign-in or refresh; the 30-day window starts again. */
export function startSession(fields: Omit<HostSession, "expiresAt">, now: number): HostSession {
  return { ...fields, expiresAt: Math.min(now + SESSION_MAX_AGE_SECONDS * 1000, fields.connectionExpiresAt) };
}

export function sessionMaxAgeSeconds(session: HostSession, now: number): number {
  return Math.max(0, Math.floor((session.expiresAt - now) / 1000));
}

/** True while NIHO can still be called with the stored ID token. */
export function idTokenUsable(session: HostSession, now: number): boolean {
  return session.idTokenExpiresAt - now > ID_TOKEN_MIN_REMAINING_MS;
}

/** True when /host/auth/refresh should exchange the refresh token for a new ID token. */
export function shouldRefresh(session: HostSession, now: number): boolean {
  return session.idTokenExpiresAt - now < REFRESH_WINDOW_MS;
}

export function cookieFits(name: string, value: string): boolean {
  return Buffer.byteLength(name) + Buffer.byteLength(value) <= COOKIE_BYTES_LIMIT;
}

export function encodeSession(sealer: CookieSealer, session: HostSession): string {
  const wire: SessionWire = {
    v: 1,
    r: session.refreshToken,
    t: session.idToken,
    te: session.idTokenExpiresAt,
    c: session.connectionId,
    ce: session.connectionExpiresAt,
    x: session.expiresAt,
    n: session.displayName,
    ...(session.iconUrl ? { p: session.iconUrl } : {}),
    ...(session.mockScenario ? { m: session.mockScenario } : {}),
  };
  let value = sealer.seal(wire);
  if (!cookieFits(SESSION_COOKIE, value) && wire.p) {
    // The face is optional; the tokens are not.
    delete wire.p;
    value = sealer.seal(wire);
  }
  if (!cookieFits(SESSION_COOKIE, value)) throw new HostSessionTooLargeError();
  return value;
}

/** A session that opens, has a connection and has not expired; otherwise null. */
export function decodeSession(sealer: CookieSealer, raw: string | undefined | null, now: number): HostSession | null {
  const wire = sealer.open(raw) as Partial<SessionWire> | null;
  if (!wire || typeof wire !== "object" || wire.v !== 1) return null;
  if (!isString(wire.r) || !isString(wire.t) || !isString(wire.c, 256) || !isTime(wire.te) || !isTime(wire.ce) || !isTime(wire.x)) return null;
  if (now >= wire.x || now >= wire.ce) return null;
  const scenario = HOST_MOCK_SCENARIOS.find((candidate) => candidate === wire.m);
  return {
    refreshToken: wire.r,
    idToken: wire.t,
    idTokenExpiresAt: wire.te,
    connectionId: wire.c,
    connectionExpiresAt: wire.ce,
    expiresAt: wire.x,
    displayName: cleanDisplayName(wire.n),
    iconUrl: cleanIconUrl(wire.p),
    ...(scenario ? { mockScenario: scenario } : {}),
  };
}

export function encodeLoginState(sealer: CookieSealer, login: HostLoginState): string {
  const wire: LoginWire = { v: 1, pv: login.verifier, s: login.state, x: login.expiresAt, ...(login.providerId ? { pid: login.providerId } : {}), ...(login.preparationCaseId ? { pc: login.preparationCaseId } : {}) };
  return sealer.seal(wire);
}

export function decodeLoginState(sealer: CookieSealer, raw: string | undefined | null, now: number): HostLoginState | null {
  const wire = sealer.open(raw) as Partial<LoginWire> | null;
  if (!wire || typeof wire !== "object" || wire.v !== 1) return null;
  if (!isString(wire.pv, 128) || !isString(wire.s, 128) || !isTime(wire.x) || now >= wire.x) return null;
  const preparationCaseId = typeof wire.pc === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(wire.pc) ? wire.pc : null;
  return { verifier: wire.pv, state: wire.s, providerId: isString(wire.pid, 64) ? wire.pid : null, preparationCaseId, expiresAt: wire.x };
}

/** HttpOnly, Secure, SameSite=Lax; scoped to the host console path. */
export function hostCookieOptions(path: string, maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path, maxAge };
}
