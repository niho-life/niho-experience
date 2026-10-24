import { describe, expect, it } from "vitest";
import { SUPPORT_FEE_PERCENT, supportSnapshot } from "./types";

describe("support snapshot", () => {
  it("fixes the 10/15 percent condition at acceptance", () => {
    expect(SUPPORT_FEE_PERCENT).toEqual({ off: 10, on: 15 });
    const before = supportSnapshot(false, "2026-10-01T10:00");
    const after = supportSnapshot(true, "2026-10-02T10:00");
    expect(before).toMatchObject({ enabled: false, feePercent: 10, operationsAllowed: false });
    expect(after).toMatchObject({ enabled: true, feePercent: 15, operationsAllowed: true });
    expect(before.feePercent).toBe(10);
  });
});

