import { describe, expect, it } from "vitest";
import { calendarDayLabel, calendarMonths, dayState, initialCalendarMonth, monthOf, monthWeeks, occurrenceOn, occurrencesOn, type CalendarOccurrence } from "./booking-calendar";

const at = (date: string, bookable = true, seatsLeft = 4): CalendarOccurrence => ({ date, bookable, seatsLeft, startAt: `${date}T09:00:00Z` });

describe("booking calendar", () => {
  it("has no months, no first month and no states without occurrences", () => {
    expect(calendarMonths([])).toEqual([]);
    expect(initialCalendarMonth([])).toBeNull();
    expect(dayState([], "2026-12-05")).toBe("none");
  });

  it("lists every month from the first occurrence to the last, across a year end", () => {
    expect(calendarMonths([at("2027-02-03"), at("2026-11-30"), at("2026-12-01")])).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("opens the first bookable month, else the first month", () => {
    expect(initialCalendarMonth([at("2026-11-30", false), at("2026-12-05"), at("2027-01-02")])).toBe("2026-12");
    expect(initialCalendarMonth([at("2026-12-05", false), at("2026-11-30", false)])).toBe("2026-11");
  });

  it("tells bookable, unavailable and not offered days apart", () => {
    const occurrences = [at("2026-12-05"), at("2026-12-12", false)];
    expect(dayState(occurrences, "2026-12-05")).toBe("bookable");
    expect(dayState(occurrences, "2026-12-12")).toBe("unavailable");
    expect(dayState(occurrences, "2026-12-13")).toBe("none");
  });

  // 開催枠ごとに offer が分かれる (#638): a day holds one occurrence for each offer held then.
  it("puts the starts of a day in time order and lets the earliest bookable one stand for the day", () => {
    const start = (hour: string, bookable: boolean, seatsLeft: number): CalendarOccurrence => ({ date: "2026-12-05", bookable, seatsLeft, startAt: `2026-12-05T${hour}:00:00Z` });
    const evening = start("09", true, 2);
    const morningFull = start("01", false, 0);
    const noon = start("03", true, 5);
    const other = at("2026-12-06");
    expect(occurrencesOn([evening, other, morningFull, noon], "2026-12-05")).toEqual([morningFull, noon, evening]);
    expect(occurrenceOn([evening, other, morningFull, noon], "2026-12-05")).toBe(noon);
    expect(occurrenceOn([morningFull], "2026-12-05")).toBe(morningFull);
    expect(dayState([morningFull, evening], "2026-12-05")).toBe("bookable");
    expect(occurrencesOn([evening], "2026-12-07")).toEqual([]);
    expect(occurrenceOn([evening], "2026-12-07")).toBeNull();
  });

  it("lays a month out from Sunday with the last day of the month and blanks around it", () => {
    // 2026-12-01 is a Tuesday; December has 31 days and ends on a Thursday.
    const weeks = monthWeeks("2026-12", [at("2026-12-31"), at("2026-12-01", false)]);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]!.slice(0, 2)).toEqual([null, null]);
    expect(weeks[0]![2]).toMatchObject({ date: "2026-12-01", day: 1, state: "unavailable" });
    expect(weeks[4]![4]).toMatchObject({ date: "2026-12-31", day: 31, state: "bookable" });
    expect(weeks[4]!.slice(5)).toEqual([null, null]);
  });

  it("starts a month on Sunday without leading blanks", () => {
    // 2026-11-01 is a Sunday.
    expect(monthWeeks("2026-11", [])[0]![0]).toMatchObject({ date: "2026-11-01", state: "none" });
  });

  it("knows leap February", () => {
    const leap = monthWeeks("2028-02", []).flat().filter((day) => day !== null);
    const common = monthWeeks("2027-02", []).flat().filter((day) => day !== null);
    expect(leap.at(-1)?.date).toBe("2028-02-29");
    expect(common.at(-1)?.date).toBe("2027-02-28");
    expect(monthOf("2027-02-29")).toBeNull();
    expect(monthOf("2028-02-29")).toBe("2028-02");
  });

  it("labels English dates without locale-inserted punctuation", () => {
    expect(calendarDayLabel("2026-12-12")).toBe("Sat 12 Dec");
    expect(calendarDayLabel("2026-12-12", "ja")).toBe("12月12日(土)");
  });

  it("ignores dates that are not calendar days", () => {
    expect(calendarMonths([at("2026-13-01"), at("not a date")])).toEqual([]);
    expect(monthWeeks("2026-13", [])).toEqual([]);
  });

  it("does not depend on the browser's time zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(monthWeeks("2026-12", [])[0]![2]?.date).toBe("2026-12-01");
      process.env.TZ = "Pacific/Kiritimati";
      expect(monthWeeks("2026-12", [])[0]![2]?.date).toBe("2026-12-01");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
