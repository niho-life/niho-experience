import { describe, expect, it } from "vitest";
import { addMonths, availabilityLabel, busyIntervalLabelForDay, dateInMonth, keyboardDate, monthGrid, todayInTokyo } from "./calendar-ui";

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
  });

  it("moves a focused date with calendar keys", () => {
    expect(keyboardDate("2026-03-01", "ArrowLeft")).toBe("2026-02-28");
    expect(keyboardDate("2026-03-01", "ArrowDown")).toBe("2026-03-08");
    expect(keyboardDate("2026-03-01", "Enter")).toBeNull();
  });

  it("translates internal availability reasons to host-facing states", () => {
    expect(availabilityLabel("AVAILABLE")).toBe("受付中");
    expect(availabilityLabel("INSUFFICIENT_CAPACITY")).toBe("満席");
    expect(availabilityLabel("GROUP_RESERVED")).toBe("満席");
    expect(availabilityLabel("RESOURCE_INACTIVE")).toBe("休止");
    expect(availabilityLabel("RESOURCE_BUSY")).toBe("予定あり");
    expect(availabilityLabel("GOOGLE_SYNC_UNAVAILABLE")).toBe("確認待ち");
  });
});
