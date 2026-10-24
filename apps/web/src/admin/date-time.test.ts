import { describe, expect, it } from "vitest";
import { adminDateTime } from "./date-time";

describe("Admin API timestamps in Japan", () => {
  it("converts UTC instants and explicit offsets to the same Japan time", () => {
    expect(adminDateTime("2026-11-03T01:00:00.000Z")).toBe("2026/11/3 10:00 JST");
    expect(adminDateTime("2026-11-03T10:00:00+09:00")).toBe("2026/11/3 10:00 JST");
    expect(adminDateTime("2026-11-02T20:00:00-05:00")).toBe("2026/11/3 10:00 JST");
  });

  it("keeps the Japan date at year and midnight boundaries", () => {
    expect(adminDateTime("2026-12-31T15:00:00Z")).toBe("2027/1/1 00:00 JST");
    expect(adminDateTime("2026-11-03T14:59:00Z")).toBe("2026/11/3 23:59 JST");
    expect(adminDateTime("2026-11-03T15:00:00Z")).toBe("2026/11/4 00:00 JST");
  });

  it("does not interpret missing or invalid timezone data as local browser time", () => {
    for (const value of ["", "invalidZ", "2026-11-03", "2026-11-03T10:00:00"]) {
      expect(adminDateTime(value)).toBe("日時を確認できません");
    }
  });
});
