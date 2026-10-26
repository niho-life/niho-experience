/** Google Calendar boundary: OAuth tokens remain server-side, busy results contain no event details. */
import { createHash } from "node:crypto";
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface GoogleTokenSet {
  accessToken: string;
  expiresAtUtc: string;
  refreshToken?: string;
  scopes: readonly string[];
}

export interface GoogleBusyInterval { startUtc: string; endUtc: string }

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

export class GoogleCalendarError extends Error {
  readonly reason: "REVOKED" | "UNAVAILABLE" | "INVALID_RESPONSE";
  constructor(reason: "REVOKED" | "UNAVAILABLE" | "INVALID_RESPONSE") {
    super(`Google Calendar ${reason}`);
    this.reason = reason;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleCalendarError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

async function request(config: GoogleConfig, url: string, init: RequestInit): Promise<Response> {
  try {
    return await (config.fetch ?? fetch)(url, { ...init, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new GoogleCalendarError("UNAVAILABLE");
  }
}

/** The caller stores state and verifier in a short-lived, signed HttpOnly cookie. */
export function googleAuthorizationUrl(config: GoogleConfig, state: string, codeChallenge: string): string {
  if (!state || !codeChallenge) throw new TypeError("OAuth state and PKCE challenge are required");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
    scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent",
    state, code_challenge: codeChallenge, code_challenge_method: "S256",
  }).toString();
  return url.href;
}

function parseToken(body: unknown, existingScopes?: readonly string[]): GoogleTokenSet {
  const value = asRecord(body);
  if (!nonEmpty(value.access_token) || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new GoogleCalendarError("INVALID_RESPONSE");
  const scopes = typeof value.scope === "string" ? value.scope.split(" ").filter(Boolean) : (existingScopes ?? []);
  if (!GOOGLE_SCOPES.every((scope) => scopes.includes(scope))) throw new GoogleCalendarError("INVALID_RESPONSE");
  return { accessToken: value.access_token, expiresAtUtc: new Date(Date.now() + value.expires_in * 1000).toISOString(), scopes, ...(nonEmpty(value.refresh_token) ? { refreshToken: value.refresh_token } : {}) };
}

async function tokenRequest(config: GoogleConfig, fields: Record<string, string>, existingScopes?: readonly string[]): Promise<GoogleTokenSet> {
  const response = await request(config, GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }) });
  if (!response.ok) throw new GoogleCalendarError(response.status >= 400 && response.status < 500 ? "REVOKED" : "UNAVAILABLE");
  try { return parseToken(await response.json(), existingScopes); } catch (error) { if (error instanceof GoogleCalendarError) throw error; throw new GoogleCalendarError("INVALID_RESPONSE"); }
}

export async function exchangeGoogleCode(config: GoogleConfig, code: string, verifier: string): Promise<GoogleTokenSet> {
  return tokenRequest(config, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: config.redirectUri });
}

export async function refreshGoogleToken(config: GoogleConfig, refreshToken: string, grantedScopes: readonly string[]): Promise<GoogleTokenSet> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, grantedScopes);
}

async function apiJson(config: GoogleConfig, accessToken: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await request(config, `${GOOGLE_API}${path}`, { ...init, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (!response.ok) throw new GoogleCalendarError(response.status === 401 || response.status === 403 ? "REVOKED" : "UNAVAILABLE");
  try { return asRecord(await response.json()); } catch (error) { if (error instanceof GoogleCalendarError) throw error; throw new GoogleCalendarError("INVALID_RESPONSE"); }
}

export async function listGoogleCalendars(config: GoogleConfig, accessToken: string): Promise<readonly { id: string; name: string; primary: boolean }[]> {
  const calendars: { id: string; name: string; primary: boolean }[] = [];
  let nextPageToken: string | undefined;
  do {
    const query = new URLSearchParams({ maxResults: "250", fields: "items(id,summary,primary),nextPageToken" });
    if (nextPageToken) query.set("pageToken", nextPageToken);
    const result = await apiJson(config, accessToken, `/users/me/calendarList?${query}`);
    if (!Array.isArray(result.items)) throw new GoogleCalendarError("INVALID_RESPONSE");
    for (const item of result.items) {
      const record = asRecord(item);
      if (nonEmpty(record.id) && nonEmpty(record.summary)) calendars.push({ id: record.id, name: record.summary, primary: record.primary === true });
    }
    nextPageToken = nonEmpty(result.nextPageToken) ? result.nextPageToken : undefined;
    if (calendars.length > 1000) throw new GoogleCalendarError("INVALID_RESPONSE");
  } while (nextPageToken);
  return calendars;
}

/** Reject partial per-calendar errors; a missing calendar must close booking availability. */
export async function queryGoogleBusy(config: GoogleConfig, accessToken: string, calendarIds: readonly string[], fromUtc: string, toUtc: string): Promise<readonly GoogleBusyInterval[]> {
  if (!calendarIds.length || calendarIds.length > 50 || !Number.isFinite(Date.parse(fromUtc)) || !Number.isFinite(Date.parse(toUtc)) || Date.parse(fromUtc) >= Date.parse(toUtc)) throw new TypeError("Invalid busy query range");
  const result = await apiJson(config, accessToken, "/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: fromUtc, timeMax: toUtc, timeZone: "UTC", items: calendarIds.map((id) => ({ id })) }) });
  const calendars = asRecord(result.calendars);
  const intervals: GoogleBusyInterval[] = [];
  for (const id of calendarIds) {
    const calendar = asRecord(calendars[id]);
    if (Array.isArray(calendar.errors) && calendar.errors.length > 0) throw new GoogleCalendarError("UNAVAILABLE");
    if (!Array.isArray(calendar.busy)) throw new GoogleCalendarError("INVALID_RESPONSE");
    for (const busy of calendar.busy) {
      const slot = asRecord(busy);
      if (!nonEmpty(slot.start) || !nonEmpty(slot.end) || !Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end))) throw new GoogleCalendarError("INVALID_RESPONSE");
      intervals.push({ startUtc: new Date(slot.start).toISOString(), endUtc: new Date(slot.end).toISOString() });
    }
  }
  return intervals.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** App-created calendar avoids write access to the host's personal events. */
export async function createBookingCalendar(config: GoogleConfig, accessToken: string): Promise<string> {
  const result = await apiJson(config, accessToken, "/calendars", { method: "POST", body: JSON.stringify({ summary: "NIHO Experience 予約", timeZone: "Asia/Tokyo" }) });
  if (!nonEmpty(result.id)) throw new GoogleCalendarError("INVALID_RESPONSE");
  return result.id;
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Calendar event IDs accept base32hex, not arbitrary SHA-256 hex characters. */
function bookingEventId(bookingId: string): string {
  const digest = createHash("sha256").update(bookingId).digest();
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32HEX[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32HEX[(value << (5 - bits)) & 31];
  return encoded;
}

/** Deterministic Google event ID makes a retried outbox job safe. No guest contact fields. */
export async function writeConfirmedBooking(config: GoogleConfig, accessToken: string, calendarId: string, booking: { id: string; title: string; startUtc: string; endUtc: string }): Promise<string> {
  if (!booking.id || !Number.isFinite(Date.parse(booking.startUtc)) || !Number.isFinite(Date.parse(booking.endUtc))) throw new TypeError("Invalid booking event");
  const eventId = bookingEventId(booking.id);
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const response = await request(config, `${GOOGLE_API}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ id: eventId, summary: booking.title, start: { dateTime: booking.startUtc }, end: { dateTime: booking.endUtc }, visibility: "private", transparency: "opaque" }),
  });
  // Google returns conflict when a retried outbox job has already written the event.
  if (response.status === 409) return eventId;
  if (!response.ok) throw new GoogleCalendarError(response.status === 401 || response.status === 403 ? "REVOKED" : "UNAVAILABLE");
  const result = asRecord(await response.json());
  if (result.id !== eventId) throw new GoogleCalendarError("INVALID_RESPONSE");
  return eventId;
}
