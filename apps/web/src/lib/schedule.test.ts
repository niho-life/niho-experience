import { describe, expect, it } from "vitest";
import { japanClock, occurrenceTiming } from "./schedule";

describe("occurrenceTiming", () => {
  const offer = { startTime: "10:00", durationMinutes: 90 };

  it("takes the chosen occurrence's own time once it is read: a host may move one occurrence (#285)", () => {
    // The 10:00 offer, moved to 14:00 and two hours on this date.
    expect(occurrenceTiming(offer, { startAt: "2026-11-02T05:00:00.000Z", endAt: "2026-11-02T07:00:00.000Z" })).toEqual({ startTime: "14:00", durationMinutes: 120 });
    // Not moved: the same as the offer's.
    expect(occurrenceTiming(offer, { startAt: "2026-11-02T01:00:00.000Z", endAt: "2026-11-02T02:30:00.000Z" })).toEqual(offer);
  });

  it("keeps the offer's time until the occurrence is read, or when its times are unusable", () => {
    expect(occurrenceTiming(offer, null)).toEqual(offer);
    expect(occurrenceTiming(offer, { startAt: "not a time", endAt: "2026-11-02T02:30:00.000Z" })).toEqual(offer);
    expect(occurrenceTiming(offer, { startAt: "2026-11-02T02:30:00.000Z", endAt: "2026-11-02T01:00:00.000Z" })).toEqual(offer);
  });
});

describe("japanClock", () => {
  it("writes an instant's time in Japan as HH:MM on a 24-hour clock", () => {
    expect(japanClock("2026-11-01T15:05:00.000Z")).toBe("00:05");
    expect(japanClock("2026-11-02T09:30:00.000Z")).toBe("18:30");
  });
});
