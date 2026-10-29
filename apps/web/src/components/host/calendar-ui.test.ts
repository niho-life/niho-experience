import { describe, expect, it } from "vitest";
import { addMonths, availabilityLabel, busyIntervalLabelForDay, calendarTimeRange, dateInMonth, intervalForDay, keyboardDate, monthGrid, overlapLayout, todayInTokyo, weekDays, weekLabel, weekStart } from "./calendar-ui";

describe("host calendar date model", () => {
  it("keeps month boundaries and Tokyo's day independent from the browser zone", () => {
    expect(monthGrid("2026-03-15").slice(0, 8)).toEqual([
      "2026-02-23", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02",
    ]);
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(dateInMonth("2026-01-31", "2026-02-01")).toBe("2026-02-28");
    expect(todayInTokyo(new Date("2026-01-01T15:01:00.000Z"))).toBe("2026-01-02");
  });

  it("clips Google busy intervals to the selected JST day", () => {
    expect(busyIntervalLabelForDay("2026-03-01T14:00:00.000Z", "2026-03-02T02:00:00.000Z", "2026-03-02")).toBe("00:00–11:00");
    expect(busyIntervalLabelForDay("2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z", "2026-03-02")).toBe("終日");
    expect(busyIntervalLabelForDay("2026-03-02T15:00:00.000Z", "2026-03-02T16:00:00.000Z", "2026-03-02")).toBeNull();
    expect(intervalForDay("2026-03-01T14:00:00.000Z", "2026-03-02T02:00:00.000Z", "2026-03-02")).toEqual({ startMinutes: 0, endMinutes: 660 });
  });

  it("keeps a seven-day week correct across month and year boundaries", () => {
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
    expect(weekDays("2026-11-01")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(weekLabel("2026-11-01")).toBe("2026年10月26日–11月1日");
    expect(weekLabel("2027-01-01")).toBe("2026年12月28日–2027年1月3日");
  });

  it("extends the visible hours for real early and late data", () => {
    expect(calendarTimeRange([])).toEqual({ startMinutes: 540, endMinutes: 1200 });
    expect(calendarTimeRange([{ startMinutes: 435, endMinutes: 510 }, { startMinutes: 1190, endMinutes: 1275 }])).toEqual({ startMinutes: 420, endMinutes: 1320 });
  });

  it("places colliding events side by side and resets after a collision group", () => {
    const layout = overlapLayout([
      { id: "a", startMinutes: 600, endMinutes: 720 },
      { id: "b", startMinutes: 660, endMinutes: 690 },
      { id: "c", startMinutes: 720, endMinutes: 780 },
    ]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
    expect(layout.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("moves a focused date with calendar keys", () => {
    expect(keyboardDate("2026-03-01", "ArrowLeft")).toBe("2026-02-28");
    expect(keyboardDate("2026-03-01", "ArrowDown")).toBe("2026-03-08");
    expect(keyboardDate("2026-03-01", "Enter")).toBeNull();
  });

  it("translates internal availability reasons to host-facing states", () => {
    expect(availabilityLabel("AVAILABLE")).toBe("受付中");
    expect(availabilityLabel("INSUFFICIENT_CAPACITY")).toBe("満席");
    expect(availabilityLabel("GROUP_RESERVED")).toBe("予約あり");
    expect(availabilityLabel("RESOURCE_INACTIVE")).toBe("休止");
    expect(availabilityLabel("RESOURCE_BUSY")).toBe("予定あり");
    expect(availabilityLabel("GOOGLE_SYNC_UNAVAILABLE")).toBe("確認待ち");
    expect(availabilityLabel("RESOURCE_GOOGLE_UNAVAILABLE")).toBe("確認待ち");
    expect(availabilityLabel("RESOURCE_GOOGLE_BUSY")).toBe("予定あり");
  });
});
