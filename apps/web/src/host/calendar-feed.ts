import { createHash } from "node:crypto";
import type { HostCalendarFeedBooking } from "@niho-experience/experience-store";
import { sessionHref } from "./bookings";

/*
 * 設定 › カレンダー's bookings feed (#109) as an iCalendar file (RFC 5545) that Apple, Outlook and the like subscribe
 * to: one event per confirmed booking made on this site, with the experience, the party size and a link to この回.
 * Never the guest's name, contact, note or booking link: the address is a secret, but a calendar it is added to may
 * be shared. Pure (the route reads the store and answers it).
 */

export interface BookingsIcsOptions {
  /** This site's origin: この回's link and the events' UID domain. */
  origin: string;
  providerId: string;
  /** Epoch milliseconds: DTSTAMP. */
  now: number;
  /** Beside NIHO's bookings (provider operations on): この回's link says the session is this site's (`?source=site`). */
  besideNiho: boolean;
}

/** One line folded at 75 octets (RFC 5545 §3.1), never inside a UTF-8 character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = encoder.encode(character).byteLength;
    // A continuation line starts with one space, which counts.
    if (octets + size > 75) {
      parts.push(current);
      current = " ";
      octets = 1;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n");
}

/** TEXT values (RFC 5545 §3.3.11): backslash, semicolon, comma and line breaks escaped. */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** 20261101T010000Z */
function icsUtc(at: string | number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Stable for a booking, and saying nothing about it: a digest of the provider and the internal booking id. */
export function bookingEventUid(providerId: string, bookingId: string, origin: string): string {
  return `${createHash("sha256").update(`${providerId}:${bookingId}`).digest("hex").slice(0, 32)}@${new URL(origin).host}`;
}

function event(booking: HostCalendarFeedBooking, options: BookingsIcsOptions, stamp: string): string[] {
  const session = sessionHref({
    providerId: options.providerId,
    source: options.besideNiho ? "site" : null,
    date: booking.localDate,
    start: booking.localStartTime,
    experience: booking.productId,
    offer: booking.offerId,
  });
  return [
    "BEGIN:VEVENT",
    `UID:${bookingEventUid(options.providerId, booking.bookingId, options.origin)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsUtc(booking.startUtc)}`,
    `DTEND:${icsUtc(booking.endUtc)}`,
    `SUMMARY:${icsText(`${booking.productTitle}（${booking.seats}名）`)}`,
    `DESCRIPTION:${icsText(`このサイトで受けた予約 · ${booking.seats}名\n参加者を見る: ${options.origin}${session}`)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ];
}

/** The whole feed: CRLF line ends, every line folded. */
export function bookingsIcs(bookings: readonly HostCalendarFeedBooking[], options: BookingsIcsOptions): string {
  const stamp = icsUtc(options.now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NIHO//Experience host bookings//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText("NIHO 体験の予約")}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...bookings.flatMap((booking) => event(booking, options, stamp)),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
