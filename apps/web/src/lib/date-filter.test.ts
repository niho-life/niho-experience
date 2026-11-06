import { describe, expect, it } from "vitest";
import type { Occurrence } from "@niho-experience/api-client";
import { dayOption, fitsPartySize, jstToday, matchingOccurrence, nextBookable, parseDateParam, parseGuestsParam, upcomingDays } from "./date-filter";

const occurrence = (overrides: Partial<Occurrence>): Occurrence => ({
  offerId: "offer_a",
  date: "2026-10-24",
  startAt: "2026-10-24T09:00:00.000Z",
  endAt: "2026-10-24T11:00:00.000Z",
  bookingClosesAt: null,
  seatsLeft: 4,
  bookable: true,
  reason: null,
  ...overrides,
});

describe("date chips (JST)", () => {
  it("counts days in Japan time, not the server's time zone", () => {
    // 23:30 UTC on the 20th is already the 21st in Japan.
    expect(jstToday(new Date("2026-10-20T23:30:00Z"))).toBe("2026-10-21");
    const days = upcomingDays(new Date("2026-10-20T23:30:00Z"), 3);
    expect(days.map((day) => day.key)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(days[0]).toEqual({ key: "2026-10-21", weekday: "Wed", day: "21", label: "Wed 21 Oct" });
  });

  it("crosses month ends", () => {
    expect(upcomingDays(new Date("2026-10-30T03:00:00Z"), 3).map((day) => day.label)).toEqual(["Fri 30 Oct", "Sat 31 Oct", "Sun 1 Nov"]);
    expect(dayOption("2026-12-31").label).toBe("Thu 31 Dec");
  });

  it("formats Japanese dates as Japanese while keeping the same JST date key", () => {
    expect(upcomingDays(new Date("2026-10-23T15:30:00Z"), 1, "ja")[0]).toEqual({ key: "2026-10-24", weekday: "土曜", day: "24", label: "10月24日（土曜）" });
  });

  it("accepts an offered date and only an explicit 1–8 party size from the URL", () => {
    const days = upcomingDays(new Date("2026-10-20T03:00:00Z"), 14);
    expect(parseDateParam("2026-10-24", days)).toBe("2026-10-24");
    expect(parseDateParam("2026-12-24", days)).toBeNull();
    expect(parseDateParam("", days)).toBeNull();
    expect(parseDateParam(["2026-10-24"], days)).toBeNull();
    expect(parseGuestsParam("2")).toBe(2);
    expect(parseGuestsParam("1")).toBe(1);
    expect(parseGuestsParam("9")).toBeNull();
    expect(parseGuestsParam("0")).toBeNull();
    expect(parseGuestsParam("two")).toBeNull();
    expect(parseGuestsParam(undefined)).toBeNull();
  });
});

describe("matching a party to a day", () => {
  const offers = [{ id: "offer_a", minimumParticipants: 1, maxPartySize: 4 }];

  it("needs a bookable session that day with enough seats and a large enough party limit", () => {
    expect(matchingOccurrence([occurrence({})], offers, "2026-10-24", 2)).not.toBeNull();
    expect(matchingOccurrence([occurrence({})], offers, "2026-10-25", 2)).toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 1 })], offers, "2026-10-24", 2)).toBeNull();
    expect(matchingOccurrence([occurrence({ bookable: false, reason: "FULL", seatsLeft: 0 })], offers, "2026-10-24", 1)).toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 10 })], offers, "2026-10-24", 5)).toBeNull();
  });

  it("enforces minimum and maximum group size only when a group is selected", () => {
    const privateOffer = [{ id: "offer_a", minimumParticipants: 2, maxPartySize: 4 }];
    expect(fitsPartySize(privateOffer, 1)).toBe(false);
    expect(fitsPartySize(privateOffer, 2)).toBe(true);
    expect(fitsPartySize(privateOffer, 4)).toBe(true);
    expect(fitsPartySize(privateOffer, 5)).toBe(false);
    expect(fitsPartySize(privateOffer, null)).toBe(true);
    expect(matchingOccurrence([occurrence({ seatsLeft: 1 })], privateOffer, "2026-10-24", null)).toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 2 })], privateOffer, "2026-10-24", null)).not.toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 4 })], privateOffer, "2026-10-24", 1)).toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 3 })], privateOffer, "2026-10-24", 3)).not.toBeNull();
    expect(matchingOccurrence([occurrence({ seatsLeft: 4 })], privateOffer, "2026-10-24", 5)).toBeNull();
  });

  it("judges by seats alone when the card has no option data", () => {
    expect(matchingOccurrence([occurrence({ seatsLeft: 10 })], [], "2026-10-24", 5)).not.toBeNull();
  });

  it("narrows by party size alone when no date is chosen", () => {
    expect(fitsPartySize(offers, 4)).toBe(true);
    expect(fitsPartySize(offers, 5)).toBe(false);
    expect(fitsPartySize([], 8)).toBe(true);
    expect(fitsPartySize(offers, null)).toBe(true);
  });

  it("lists the next bookable sessions soonest first", () => {
    const list = [
      occurrence({ date: "2026-10-27", startAt: "2026-10-27T09:00:00.000Z" }),
      occurrence({ date: "2026-10-22", startAt: "2026-10-22T09:00:00.000Z", bookable: false, reason: "CUTOFF" }),
      occurrence({ date: "2026-10-24", startAt: "2026-10-24T09:00:00.000Z" }),
    ];
    expect(nextBookable(list, 3).map((item) => item.date)).toEqual(["2026-10-24", "2026-10-27"]);
  });
});
