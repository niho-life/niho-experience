import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Occurrence } from "@niho-experience/api-client";
import { bookingCloseOf, NextDateBand } from "./NextDateBand";

// 2026-11-20 10:00 JST, closing 2026-11-19 18:00 JST.
const START = "2026-11-20T01:00:00.000Z";
const CLOSES = "2026-11-19T09:00:00.000Z";
const occurrence = (date: string, startAt: string, bookingClosesAt: string | null | undefined): Occurrence => ({
  offerId: "offer-a", date, startAt, endAt: new Date(Date.parse(startAt) + 90 * 60_000).toISOString(), bookingClosesAt, seatsLeft: 4, bookable: true, reason: null,
} as Occurrence);
const band = (dates: Occurrence[], locale: "en" | "ja" = "en", allDatesHref?: string) =>
  renderToStaticMarkup(createElement(NextDateBand, { dates, locale, bookingHref: "/experiences/tea/book", ...(allDatesHref ? { allDatesHref } : {}) }));

describe("when booking closes (#146)", () => {
  it("is the real cutoff of an occurrence, before its start, and nothing else", () => {
    expect(bookingCloseOf({ startAt: START, bookingClosesAt: CLOSES })).toBe(CLOSES);
    // No cutoff (the same instant as the start), no value, another type, an unreadable value or one after the start: nothing to show.
    for (const value of [START, null, undefined, "", "not a date", 42, "2026-11-20T02:00:00.000Z"]) {
      expect(bookingCloseOf({ startAt: START, bookingClosesAt: value as never }), String(value)).toBeNull();
    }
    expect(bookingCloseOf({ startAt: "also not a date", bookingClosesAt: CLOSES })).toBeNull();
  });
});

describe("the next dates band", () => {
  it("shows the next date, the few after it and, in Japan time, when the next one stops taking bookings", () => {
    const html = band([occurrence("2026-11-20", START, CLOSES), occurrence("2026-11-21", "2026-11-21T01:00:00.000Z", null), occurrence("2026-11-22", "2026-11-22T01:00:00.000Z", null)]);
    expect(html).toContain("data-next-date-band");
    expect(html).toContain("Next date");
    expect(html).toContain('dateTime="2026-11-20T01:00:00.000Z"');
    expect(html).toContain("10:00 AM JST");
    expect(html).toContain("More dates");
    expect(html).toContain("data-booking-closes");
    expect(html).toContain("Book by");
    expect(html).toContain(`dateTime="${CLOSES}"`);
    expect(html).toContain("6:00 PM JST");
    expect(html).toContain("All dates");
  });

  it("says it in Japanese on a Japanese page", () => {
    const html = band([occurrence("2026-11-20", START, CLOSES)], "ja");
    expect(html).toContain("次回");
    expect(html).toContain("予約締切");
    expect(html).toContain("すべての日程");
    expect(html).not.toContain("Book by");
  });

  it.each([[null], [undefined], [START]])("shows no deadline where the source has none (%s)", (closes) => {
    const html = band([occurrence("2026-11-20", START, closes)]);
    expect(html).toContain("Next date");
    expect(html).not.toContain("data-booking-closes");
    expect(html).not.toContain("Book by");
  });

  it("is only about the next date: a deadline of a later one is not shown", () => {
    const html = band([occurrence("2026-11-20", START, null), occurrence("2026-11-21", "2026-11-21T01:00:00.000Z", "2026-11-20T09:00:00.000Z")]);
    expect(html).not.toContain("Book by");
  });

  it("links 'all dates' to the booking section, or to the booking page where there is no section, and is empty without dates", () => {
    expect(band([occurrence("2026-11-20", START, CLOSES)])).toContain('href="#book"');
    const toPage = band([occurrence("2026-11-20", START, CLOSES)], "en", "/experiences/tea/book");
    expect(toPage).not.toContain('href="#book"');
    expect(toPage.match(/href="\/experiences\/tea\/book"/g)).toHaveLength(2);
    expect(band([])).toBe("");
  });
});
