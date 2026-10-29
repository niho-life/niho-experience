/** Google Calendar boundary: OAuth tokens remain server-side, busy results contain no event details. */
import { asRecord, boundedJson, GOOGLE_API, GoogleCalendarError, googleRequest as request, nonEmpty } from "./http.ts";
import { sha256Base32Hex } from "./ids.ts";
export { GoogleCalendarError } from "./http.ts";
export * from "./managed-block.ts";
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
export interface GoogleBusyCalendar { id: string; busyIntervals: readonly GoogleBusyInterval[] }
export interface GoogleWatchChannel {
  id: string;
  resourceId: string;
  expiresAtUtc: string;
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

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
  try { return parseToken(await boundedJson(response), existingScopes); } catch (error) { if (error instanceof GoogleCalendarError) throw error; throw new GoogleCalendarError("INVALID_RESPONSE"); }
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
  return boundedJson(response);
}

export async function listGoogleCalendars(config: GoogleConfig, accessToken: string): Promise<readonly { id: string; name: string; primary: boolean }[]> {
  const calendars: { id: string; name: string; primary: boolean }[] = [];
  let nextPageToken: string | undefined;
  const pageTokens = new Set<string>();
  let pages = 0;
  do {
    pages += 1;
    if (pages > 20 || (nextPageToken !== undefined && (nextPageToken.length > 2_048 || pageTokens.has(nextPageToken)))) throw new GoogleCalendarError("INVALID_RESPONSE");
    if (nextPageToken) pageTokens.add(nextPageToken);
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
  const calendars = await queryGoogleBusyByCalendar(config, accessToken, calendarIds, fromUtc, toUtc);
  return calendars.flatMap((calendar) => calendar.busyIntervals).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** Keeps the opaque calendar key so callers cannot accidentally apply one resource's busy time to another. */
export async function queryGoogleBusyByCalendar(config: GoogleConfig, accessToken: string, calendarIds: readonly string[], fromUtc: string, toUtc: string): Promise<readonly GoogleBusyCalendar[]> {
  if (!calendarIds.length || calendarIds.length > 50 || !Number.isFinite(Date.parse(fromUtc)) || !Number.isFinite(Date.parse(toUtc)) || Date.parse(fromUtc) >= Date.parse(toUtc)) throw new TypeError("Invalid busy query range");
  if (new Set(calendarIds).size !== calendarIds.length || calendarIds.some((id) => !id || id.length > 512)) throw new TypeError("Invalid busy calendar IDs");
  const result = await apiJson(config, accessToken, "/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: fromUtc, timeMax: toUtc, timeZone: "UTC", items: calendarIds.map((id) => ({ id })) }) });
  const calendars = asRecord(result.calendars);
  const keyed: GoogleBusyCalendar[] = [];
  let totalIntervals = 0;
  for (const id of calendarIds) {
    const calendar = asRecord(calendars[id]);
    if (Array.isArray(calendar.errors) && calendar.errors.length > 0) throw new GoogleCalendarError("UNAVAILABLE");
    if (!Array.isArray(calendar.busy)) throw new GoogleCalendarError("INVALID_RESPONSE");
    if (calendar.busy.length > 5_000) throw new GoogleCalendarError("INVALID_RESPONSE");
    const intervals: GoogleBusyInterval[] = [];
    for (const busy of calendar.busy) {
      const slot = asRecord(busy);
      if (!nonEmpty(slot.start) || !nonEmpty(slot.end) || !Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end)) || Date.parse(slot.start) >= Date.parse(slot.end)) throw new GoogleCalendarError("INVALID_RESPONSE");
      intervals.push({ startUtc: new Date(slot.start).toISOString(), endUtc: new Date(slot.end).toISOString() });
    }
    totalIntervals += intervals.length;
    if (totalIntervals > 10_000) throw new GoogleCalendarError("INVALID_RESPONSE");
    keyed.push({ id, busyIntervals: intervals.sort((a, b) => a.startUtc.localeCompare(b.startUtc)) });
  }
  return keyed;
}

/** Starts a notification channel. Notifications are only dirty hints; callers must re-query freebusy. */
export async function watchGoogleCalendar(
  config: GoogleConfig,
  accessToken: string,
  input: { id: string; calendarId: string; address: string; token: string; expiresAtUtc: string },
): Promise<GoogleWatchChannel> {
  if (!/^[0-9a-f-]{36}$/i.test(input.id) || !input.calendarId || input.calendarId.length > 512 || input.token.length < 32 || input.token.length > 256) throw new TypeError("Invalid watch channel");
  const address = new URL(input.address);
  if (address.protocol !== "https:" || address.username || address.password || address.hash) throw new TypeError("Invalid watch address");
  const expiration = Date.parse(input.expiresAtUtc);
  if (!Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + 7 * 86_400_000) throw new TypeError("Invalid watch expiration");
  const result = await apiJson(config, accessToken, `/calendars/${encodeURIComponent(input.calendarId)}/events/watch`, {
    method: "POST",
    body: JSON.stringify({ id: input.id, type: "web_hook", address: address.href, token: input.token, expiration: String(expiration) }),
  });
  if (result.id !== input.id || !nonEmpty(result.resourceId)) throw new GoogleCalendarError("INVALID_RESPONSE");
  const returnedExpiration = typeof result.expiration === "string" ? Number(result.expiration) : NaN;
  if (!Number.isFinite(returnedExpiration) || returnedExpiration <= Date.now() || returnedExpiration > expiration) throw new GoogleCalendarError("INVALID_RESPONSE");
  return { id: input.id, resourceId: result.resourceId, expiresAtUtc: new Date(returnedExpiration).toISOString() };
}

/** Stops only a channel whose id/resourceId were loaded from our own durable metadata. */
export async function stopGoogleWatchChannel(config: GoogleConfig, accessToken: string, channel: { id: string; resourceId: string }): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(channel.id) || !channel.resourceId || channel.resourceId.length > 512) throw new TypeError("Invalid watch channel");
  const response = await request(config, `${GOOGLE_API}/channels/stop`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(channel),
  });
  if (!response.ok) throw new GoogleCalendarError(response.status === 401 || response.status === 403 ? "REVOKED" : "UNAVAILABLE");
}

/** App-created calendar avoids write access to the host's personal events. */
export async function createBookingCalendar(config: GoogleConfig, accessToken: string): Promise<string> {
  const result = await apiJson(config, accessToken, "/calendars", { method: "POST", body: JSON.stringify({ summary: "NIHO Experience 予約", timeZone: "Asia/Tokyo" }) });
  if (!nonEmpty(result.id)) throw new GoogleCalendarError("INVALID_RESPONSE");
  return result.id;
}

function bookingEventId(bookingId: string): string {
  return sha256Base32Hex(bookingId);
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
  const result = await boundedJson(response);
  if (result.id !== eventId) throw new GoogleCalendarError("INVALID_RESPONSE");
  return eventId;
}
