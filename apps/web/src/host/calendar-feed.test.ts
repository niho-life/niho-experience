import { describe, expect, it } from "vitest";
import type { HostCalendarFeedBooking } from "@niho-experience/experience-store";
import { bookingEventUid, bookingsIcs, icsText } from "./calendar-feed";

/** 設定 › カレンダー's bookings feed as an iCalendar file (#109), on synthetic bookings. */
const BOOKING: HostCalendarFeedBooking = {
  bookingId: "41", productId: "sample-walk", offerId: "sample-walk-am", productTitle: "Synthetic walk",
  startUtc: "2026-11-05T01:00:00.000Z", endUtc: "2026-11-05T02:30:00.000Z", localDate: "2026-11-05", localStartTime: "10:00", seats: 3,
};
const OPTIONS = { origin: "https://experience.example", providerId: "sample-provider", now: Date.UTC(2026, 10, 1, 3, 4, 5), besideNiho: false };

/** The unfolded lines (RFC 5545 §3.1). */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

describe("the bookings feed", () => {
  it("is a calendar with one confirmed event per booking, its lines ending in CRLF", () => {
    const ics = bookingsIcs([BOOKING], OPTIONS);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(unfold(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//NIHO//Experience host bookings//JA",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:NIHO 体験の予約",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
      "BEGIN:VEVENT",
      `UID:${bookingEventUid("sample-provider", "41", OPTIONS.origin)}`,
      "DTSTAMP:20261101T030405Z",
      "DTSTART:20261105T010000Z",
      "DTEND:20261105T023000Z",
      "SUMMARY:Synthetic walk（3名）",
      "DESCRIPTION:このサイトで受けた予約 · 3名\\n参加者を見る: https://experience.example/host/bookings/session?providerId=sample-provider&date=2026-11-05&start=10%3A00&experience=sample-walk&offer=sample-walk-am",
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
    expect(bookingsIcs([], OPTIONS)).toContain("X-PUBLISHED-TTL:PT1H\r\nEND:VCALENDAR\r\n");
  });

  it("links この回 as this site's session beside NIHO's bookings", () => {
    expect(unfold(bookingsIcs([BOOKING], { ...OPTIONS, besideNiho: true })).find((line) => line.startsWith("DESCRIPTION:"))).toContain("?providerId=sample-provider&source=site&date=2026-11-05");
  });

  it("keeps a booking's UID across reads, different per booking and provider, and saying nothing about either", () => {
    const uid = bookingEventUid("sample-provider", "41", OPTIONS.origin);
    expect(uid).toMatch(/^[0-9a-f]{32}@experience\.example$/);
    expect(bookingEventUid("sample-provider", "41", OPTIONS.origin)).toBe(uid);
    expect(bookingEventUid("sample-provider", "42", OPTIONS.origin)).not.toBe(uid);
    expect(bookingEventUid("other-provider", "41", OPTIONS.origin)).not.toBe(uid);
    expect(uid).not.toContain("41");
  });

  it("escapes TEXT values", () => {
    expect(icsText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    const summary = unfold(bookingsIcs([{ ...BOOKING, productTitle: "Tea; sweets, and\\more" }], OPTIONS)).find((line) => line.startsWith("SUMMARY:"));
    expect(summary).toBe("SUMMARY:Tea\\; sweets\\, and\\\\more（3名）");
  });

  it("folds every line at 75 octets without splitting a character", () => {
    const title = `${"鎌倉の朝の散歩と和菓子づくり".repeat(4)} 🍵 ${"x".repeat(50)}`;
    const ics = bookingsIcs([{ ...BOOKING, productTitle: title }], OPTIONS);
    const physical = ics.split("\r\n").slice(0, -1);
    const encoder = new TextEncoder();
    for (const line of physical) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(75);
      // A line never starts or ends inside a character (no replacement characters once decoded).
      expect(new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(line))).toBe(line);
    }
    expect(physical.some((line) => line.startsWith(" "))).toBe(true);
    expect(unfold(ics).find((line) => line.startsWith("SUMMARY:"))).toBe(`SUMMARY:${title}（3名）`);
  });

  it("carries nothing about the guest", () => {
    const keys = Object.keys(BOOKING).sort();
    expect(keys).toEqual(["bookingId", "endUtc", "localDate", "localStartTime", "offerId", "productId", "productTitle", "seats", "startUtc"]);
    const ics = bookingsIcs([BOOKING], OPTIONS);
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER|CONTACT|@example\.com|LOCATION/);
  });
});
