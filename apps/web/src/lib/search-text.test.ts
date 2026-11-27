import { describe, expect, it } from "vitest";
import { chosenDayLabel, guestsLabel, searchSummary, showCountLabel } from "./search-text";

describe("search bar words（#698）", () => {
  it("phone summary: any / chosen", () => {
    expect(searchSummary(null, null, "ja")).toBe("いつでも · 人数指定なし");
    expect(searchSummary(null, null, "en")).toBe("Any day · Any group");
    expect(searchSummary("2026-12-05", 2, "ja")).toBe("12月5日（土） · 2名");
    expect(searchSummary("2026-12-05", 1, "en")).toBe("Sat 5 Dec · 1 guest");
  });
  it("labels", () => {
    expect(chosenDayLabel("2026-12-05", "ja")).toBe("12月5日（土）");
    expect(guestsLabel(3, "en")).toBe("3 guests");
    expect(showCountLabel(4, "ja")).toBe("4件の体験を見る");
    expect(showCountLabel(1, "en")).toBe("Show 1 experience");
  });
});
