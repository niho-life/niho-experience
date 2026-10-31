import "server-only";
import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import { publicEmpty, publicJson, readPublicJsonObject } from "@/lib/experience/public-http";

/*
 * 予約者の予約ページ (#285 slice 6, docs/guest-booking.md): what its routes and pages share. The email's link
 * carries a one-time grant in the URL fragment; opening it sets an HttpOnly cookie holding a session for that one
 * booking. The link and the cookie are bearer credentials for one booking, not an account. Nothing here is
 * cached, indexed, sent with a Referer or logged (the shared headers and same-site check: public-http.ts).
 */

/** The pages open only with both flags: booking on this site, and the mail job that sends the links. */
export function bookingPagesEnabled(): boolean {
  return config.guestBookingEnabled && config.guestMailEnabled;
}

/** Every body these routes take fits in this many bytes. */
export const BOOKING_ACCESS_BODY_LIMIT = 4 * 1024;

const PRIVATE = { "cache-control": "private, no-store" } as const;

/** A status with no body (404, 403, 503), never stored by any cache. */
export function bookingEmpty(status: number, headers: Record<string, string> = {}): Response {
  const response = publicEmpty(status);
  for (const [name, value] of Object.entries({ ...PRIVATE, ...headers })) response.headers.set(name, value);
  return response;
}

export function bookingJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return publicJson(status, body, { ...PRIVATE, ...headers });
}

export type BookingAccessBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** The JSON object the page sent: 400 for anything else, 413 past BOOKING_ACCESS_BODY_LIMIT. */
export async function readBookingAccessBody(request: Request): Promise<BookingAccessBody> {
  const body = await readPublicJsonObject(request, BOOKING_ACCESS_BODY_LIMIT);
  if (!body.ok) return { ok: false, response: bookingEmpty(body.tooLarge ? 413 : 400) };
  return body;
}

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A grant token or a session id as the page or the cookie carries it; anything else is none at all. */
export function accessSecret(value: unknown): string | null {
  return typeof value === "string" && SECRET.test(value) ? value : null;
}

/** A public booking ID (a UUID), lower case; anything else is no booking. */
export function publicBookingIdOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The booking's session cookie: one per booking, so a device can hold several. The name carries a short hash of
 * the booking ID rather than the ID; `__Host-` keeps it on this host, on `/`, Secure and without a Domain.
 */
export function bookingSessionCookieName(publicBookingId: string): string {
  return `__Host-nb_${createHash("sha256").update(publicBookingId.toLowerCase(), "utf8").digest("hex").slice(0, 8)}`;
}

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

/** Set-Cookie for a session: never readable by JavaScript, gone by the session's absolute end. */
export function bookingSessionCookie(publicBookingId: string, sessionId: string, expiresAtUtc: string, now: Date = new Date()): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAtUtc) - now.getTime()) / 1000));
  return `${bookingSessionCookieName(publicBookingId)}=${sessionId}; Max-Age=${maxAge}; ${ATTRIBUTES}`;
}

/** Set-Cookie that removes the booking's session cookie. */
export function clearedBookingSessionCookie(publicBookingId: string): string {
  return `${bookingSessionCookieName(publicBookingId)}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** One cookie's value from the request's Cookie header; null when it is absent. */
export function requestCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
