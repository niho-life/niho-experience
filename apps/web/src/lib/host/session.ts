import type { CookieSealer } from "./cookie-seal";
import { ACCESS_TOKEN_MIN_REMAINING_MS, REFRESH_WINDOW_MS } from "./timing";

/**
 * The host console session: NIHO's scoped app-connect access token and rotating
 * refresh token, sealed in an HttpOnly cookie. The browser only sees expiry time.
 */
export const SESSION_COOKIE = "__Secure-niho_host_session";
export const LOGIN_COOKIE = "__Secure-niho_host_login";
export const SESSION_COOKIE_PATH = "/host";
export const LOGIN_COOKIE_PATH = "/host/auth";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_MAX_AGE_SECONDS = 10 * 60;

/**
 * Experience host accounts (ADR 0003, EXPERIENCE_HOST_ACCOUNTS_ENABLED, docs/host-accounts.md). The session cookie holds
 * the store's opaque session token as is (only its SHA-256 is stored server-side); `__Host-` pins it to this origin and
 * Path=/. The link cookie holds the random value whose SHA-256 binds an emailed link to the browser that asked for it,
 * only on the auth path and for the link's 15 minutes.
 */
export const ACCOUNT_SESSION_COOKIE = "__Host-niho_host_account_session";
export const ACCOUNT_SESSION_COOKIE_PATH = "/";
export const LINK_BINDING_COOKIE = "__Secure-niho_host_link";
export const LINK_BINDING_COOKIE_PATH = "/host/auth";
export const LINK_BINDING_MAX_AGE_SECONDS = 15 * 60;
/**
 * Where a sign-in asked for by a sensitive change returns (設定 › 受取口座, ADR 0003 slice 3): the allowlisted path in
 * base64url, beside the link cookie on the auth path for the link's 15 minutes. Read again only through
 * hostReturnPathOrNull, so a forged value can only lead to the console's home.
 */
export const RETURN_PATH_COOKIE = "__Secure-niho_host_return";
/** Browsers drop cookies whose name and value exceed 4096 bytes. */
export const COOKIE_BYTES_LIMIT = 4096;

const DISPLAY_NAME_MAX = 80;
const ICON_URL_MAX = 1024;

/**
 * Mock sessions only (`?mock=` on /host/auth/mock-login); mock-niho.ts maps them to the api-client mock's scenarios.
 * `calendar-revoked` is the default providers with the kitchen's Google Calendar access taken away in Google (#109);
 * `site-sales` the same providers, with 売上 read from a synthetic ledger of bookings made on this site (#91);
 * `site-bookings` the same providers, with 予約 showing synthetic bookings made on this site (#285, #84).
 */
export type HostMockScenario = "default" | "empty" | "payments-pending" | "calendar-revoked" | "cohost" | "site-sales" | "site-bookings" | "ota-bookings";
export const HOST_MOCK_SCENARIOS: readonly HostMockScenario[] = ["default", "empty", "payments-pending", "calendar-revoked", "cohost", "site-sales", "site-bookings", "ota-bookings"];

/**
 * Where the sign-in started (#177). iOS and macOS Safari copy the browser's cookies into a home-screen
 * or Dock app when it is added, and NIHO ends the whole connection when an old refresh token is reused,
 * so inside the app only a session signed in there (`"app"`) is ever refreshed.
 */
export type HostSessionSurface = "app";

/**
 * A /host session: NIHO's app-connect tokens sealed in the cookie (the NIHO login), or an Experience host account's
 * server-side session (EXPERIENCE_HOST_ACCOUNTS_ENABLED, ADR 0003). Code that calls NIHO with the host's access token
 * takes `NihoHostSession` only, so an Experience session can never reach it.
 */
export type HostSession = NihoHostSession | ExperienceHostSession;

export interface NihoHostSession {
  kind: "niho";
  refreshToken: string;
  accessToken: string;
  /** Epoch ms. */
  accessTokenExpiresAt: number;
  connectionId: string;
  /** Epoch ms. NIHO ends the connection here regardless of refreshes. */
  connectionExpiresAt: number;
  /** Epoch ms. Sliding: 30 days after the last sign-in or refresh, never past the connection. */
  expiresAt: number;
  displayName: string;
  iconUrl: string | null;
  /** Synthetic sessions only (mock mode): which provider list the mock API returns. */
  mockScenario?: HostMockScenario;
  /** Signed in inside the installed app. Absent: a browser session, as every cookie from before #177. */
  surface?: HostSessionSurface;
}

/**
 * An Experience host account's session as the store read it for this request (HostAccounts.readSession): valid,
 * unexpired and the account ACTIVE. There is no NIHO token, nothing to refresh and no app surface: the cookie holds no
 * rotating secret, so a copy the OS made into the installed app is as good as the browser's.
 */
export interface ExperienceHostSession {
  readonly kind: "experience";
  /** The cookie's value: only to sign this session out. Never logged, never sent to the browser. */
  readonly sessionToken: string;
  /** `hst_` + 32 hex. It goes where a NIHO user ID went (`*_niho_user_id` columns) until they are renamed. */
  readonly hostAccountId: string;
  readonly email: string;
  /** Not a secret: names this session for push subscriptions and "sign out that device". */
  readonly sessionRef: string;
  /** When the host last proved the address with a link (sensitive changes ask for a recent one). */
  readonly authenticatedAtUtc: string;
  readonly idleExpiresAtUtc: string;
  readonly absoluteExpiresAtUtc: string;
  /** What the console shows as the account: the address. */
  readonly displayName: string;
  readonly iconUrl: null;
  readonly mockScenario?: undefined;
  readonly surface?: undefined;
}

export interface HostLoginState {
  verifier: string;
  state: string;
  providerId: string | null;
  preparationCaseId: string | null;
  invitationId?: string | null;
  /** `/host/auth/login?surface=app`: the sign-in was started inside the installed app. */
  surface?: HostSessionSurface;
  /** Epoch ms; the login cookie lives 10 minutes. */
  expiresAt: number;
}

interface SessionWire {
  v: 3;
  r: string;
  at: string;
  ate: number;
  c: string;
  ce: number;
  x: number;
  n: string;
  p?: string;
  m?: HostMockScenario;
  /** surface "app"; absent for browser sessions. */
  a?: 1;
}

interface LoginWire {
  v: 1;
  pv: string;
  s: string;
  pid?: string;
  pc?: string;
  ii?: string;
  sf?: 1;
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
export function startSession(fields: Omit<NihoHostSession, "expiresAt" | "kind">, now: number): NihoHostSession {
  return { ...fields, kind: "niho", expiresAt: Math.min(now + SESSION_MAX_AGE_SECONDS * 1000, fields.connectionExpiresAt) };
}

export function sessionMaxAgeSeconds(session: NihoHostSession, now: number): number {
  return Math.max(0, Math.floor((session.expiresAt - now) / 1000));
}

/**
 * True while the session may be used for this request: for the NIHO login, while NIHO can still be called with the
 * stored scoped Web access token; an Experience session was checked by the store when it was read, so always.
 */
export function accessTokenUsable(session: HostSession, now: number): boolean {
  if (session.kind === "experience") return true;
  return session.accessTokenExpiresAt - now > ACCESS_TOKEN_MIN_REMAINING_MS;
}

/** True when /host/auth/refresh should rotate the NIHO access and refresh tokens. */
export function shouldRefresh(session: NihoHostSession, now: number): boolean {
  return session.accessTokenExpiresAt - now < REFRESH_WINDOW_MS;
}

/** The NIHO login's session, or null: for the features that call NIHO with the host's own access token. */
export function nihoSessionOrNull(session: HostSession | null): NihoHostSession | null {
  return session && session.kind !== "experience" ? session : null;
}

/**
 * Whether the installed app may use this session (#177): a NIHO session signed in there, or any Experience session (no
 * refresh token rotates, so the copy the OS made at install time cannot end the browser's).
 */
export function sessionUsableInApp(session: HostSession): boolean {
  return session.kind === "experience" || session.surface === "app";
}

/**
 * When the browser's HostSessionKeeper asks /host/auth/refresh next (epoch ms): the NIHO access token's expiry, or an
 * Experience session's idle end (never later than its absolute end; within setTimeout's range, 14 days at most).
 */
export function sessionKeeperExpiresAt(session: HostSession): number {
  if (session.kind !== "experience") return session.accessTokenExpiresAt;
  return Math.min(Date.parse(session.idleExpiresAtUtc), Date.parse(session.absoluteExpiresAtUtc));
}

/** Whether an Experience session proved its address recently enough for a sensitive change (ADR 0003: 30 minutes). */
export function recentlyAuthenticated(session: ExperienceHostSession, now: number, minutes: number): boolean {
  const at = Date.parse(session.authenticatedAtUtc);
  return Number.isFinite(at) && now - at <= minutes * 60_000;
}

export function cookieFits(name: string, value: string): boolean {
  return Buffer.byteLength(name) + Buffer.byteLength(value) <= COOKIE_BYTES_LIMIT;
}

export function encodeSession(sealer: CookieSealer, session: NihoHostSession): string {
  const wire: SessionWire = {
    v: 3,
    r: session.refreshToken,
    at: session.accessToken,
    ate: session.accessTokenExpiresAt,
    c: session.connectionId,
    ce: session.connectionExpiresAt,
    x: session.expiresAt,
    n: session.displayName,
    ...(session.iconUrl ? { p: session.iconUrl } : {}),
    ...(session.mockScenario ? { m: session.mockScenario } : {}),
    ...(session.surface === "app" ? { a: 1 as const } : {}),
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
export function decodeSession(sealer: CookieSealer, raw: string | undefined | null, now: number): NihoHostSession | null {
  const wire = sealer.open(raw) as Partial<SessionWire> | null;
  if (!wire || typeof wire !== "object" || wire.v !== 3) return null;
  if (!isString(wire.r) || !isString(wire.at) || !isString(wire.c, 256) || !isTime(wire.ate) || !isTime(wire.ce) || !isTime(wire.x)) return null;
  if (now >= wire.x || now >= wire.ce) return null;
  const scenario = HOST_MOCK_SCENARIOS.find((candidate) => candidate === wire.m);
  return {
    kind: "niho",
    refreshToken: wire.r,
    accessToken: wire.at,
    accessTokenExpiresAt: wire.ate,
    connectionId: wire.c,
    connectionExpiresAt: wire.ce,
    expiresAt: wire.x,
    displayName: cleanDisplayName(wire.n),
    iconUrl: cleanIconUrl(wire.p),
    ...(scenario ? { mockScenario: scenario } : {}),
    ...(wire.a === 1 ? { surface: "app" as const } : {}),
  };
}

export function encodeLoginState(sealer: CookieSealer, login: HostLoginState): string {
  const wire: LoginWire = { v: 1, pv: login.verifier, s: login.state, x: login.expiresAt, ...(login.providerId ? { pid: login.providerId } : {}), ...(login.preparationCaseId ? { pc: login.preparationCaseId } : {}), ...(login.invitationId ? { ii: login.invitationId } : {}), ...(login.surface === "app" ? { sf: 1 as const } : {}) };
  return sealer.seal(wire);
}

export function decodeLoginState(sealer: CookieSealer, raw: string | undefined | null, now: number): HostLoginState | null {
  const wire = sealer.open(raw) as Partial<LoginWire> | null;
  if (!wire || typeof wire !== "object" || wire.v !== 1) return null;
  if (!isString(wire.pv, 128) || !isString(wire.s, 128) || !isTime(wire.x) || now >= wire.x) return null;
  const preparationCaseId = typeof wire.pc === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(wire.pc) ? wire.pc : null;
  const invitationId = typeof wire.ii === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wire.ii) ? wire.ii : null;
  if (preparationCaseId && invitationId) return null;
  return { verifier: wire.pv, state: wire.s, providerId: isString(wire.pid, 64) ? wire.pid : null, preparationCaseId, ...(invitationId ? { invitationId } : {}), ...(wire.sf === 1 ? { surface: "app" as const } : {}), expiresAt: wire.x };
}

/** HttpOnly, Secure, SameSite=Lax; scoped to the host console path. */
export function hostCookieOptions(path: string, maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path, maxAge };
}
