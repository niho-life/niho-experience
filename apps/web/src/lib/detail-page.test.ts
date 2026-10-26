import type { Occurrence } from "@niho-experience/api-client";
import { describe, expect, it } from "vitest";
import { detailFromTokyoLine, detailNextDates, publicStationAccess } from "./detail-page";

const occurrence = (date: string, startAt: string, bookable = true): Occurrence => ({
  offerId: `offer-${date}-${startAt}`,
  date,
  startAt,
  endAt: new Date(Date.parse(startAt) + 60 * 60_000).toISOString(),
  seatsLeft: bookable ? 4 : 0,
  bookable,
  reason: bookable ? null : "FULL",
});

describe("detail page facts", () => {
  it("uses only explicit public station and walking facts", () => {
    expect(publicStationAccess("2-minute walk from Kamakura Station West Exit.", "en")).toEqual({ station: "Kamakura Station", walkMinutes: 2 });
    expect(publicStationAccess("1-minute walk from Kita-Kamakura Station.", "en")).toEqual({ station: "Kita-Kamakura Station", walkMinutes: 1 });
    expect(publicStationAccess("About 10 minutes on foot from the nearest station (sample).", "en")).toBeNull();
    expect(publicStationAccess("鎌倉駅西口から徒歩2分です。", "ja")).toEqual({ station: "鎌倉駅", walkMinutes: 2 });
  });

  it("keeps detail.fromTokyoLine as page-owned localized copy and never substitutes another station", () => {
    const engakuji = detailFromTokyoLine("Kamakura", "1-minute walk from Kita-Kamakura Station.", "en");
    expect(engakuji).toBe("Kamakura · 1 hour from Tokyo · 1-minute walk from Kita-Kamakura Station");
    expect(engakuji).not.toContain("2-minute walk from Kamakura Station");
    expect(detailFromTokyoLine("鎌倉", "北鎌倉駅から徒歩1分です。", "ja")).toBe("鎌倉・東京から1時間・北鎌倉駅から徒歩1分");
    expect(detailFromTokyoLine("Kamakura", "Directions are shared later.", "en")).toBe("Kamakura · 1 hour from Tokyo");
  });

  it("selects the earliest bookable occurrence on four distinct JST dates", () => {
    const dates = detailNextDates([
      occurrence("2026-11-03", "2026-11-03T09:00:00.000Z"),
      occurrence("2026-11-01", "2026-11-01T10:00:00.000Z"),
      occurrence("2026-11-01", "2026-11-01T09:00:00.000Z"),
      occurrence("2026-11-02", "2026-11-02T09:00:00.000Z", false),
      occurrence("2026-11-04", "2026-11-04T09:00:00.000Z"),
      occurrence("2026-11-05", "2026-11-05T09:00:00.000Z"),
      occurrence("2026-11-06", "2026-11-06T09:00:00.000Z"),
    ]);
    expect(dates.map((item) => [item.date, item.startAt])).toEqual([
      ["2026-11-01", "2026-11-01T09:00:00.000Z"],
      ["2026-11-03", "2026-11-03T09:00:00.000Z"],
      ["2026-11-04", "2026-11-04T09:00:00.000Z"],
      ["2026-11-05", "2026-11-05T09:00:00.000Z"],
    ]);
  });
});
