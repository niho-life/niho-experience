import { describe, expect, it } from "vitest";
import { qrSymbol } from "./qr";

describe("qrSymbol", () => {
  it("draws a version-1-or-larger symbol with the quiet zone and the three finder patterns", () => {
    const symbol = qrSymbol("https://app-stg.niho.test/i/synthetic-code");
    expect(symbol.size).toBeGreaterThanOrEqual(21 + 8);
    expect((symbol.size - 8) % 4).toBe(1);
    // The top-left finder pattern's first row: seven dark modules starting after the quiet zone.
    expect(symbol.path.startsWith("M4 4h7v1h-7z")).toBe(true);
    // The top-right finder's first row ends at the symbol's right edge (before the quiet zone).
    expect(symbol.path).toContain(`M${symbol.size - 4 - 7} 4h7v1h-7z`);
    // The bottom-left finder's first row.
    expect(symbol.path).toContain(`M4 ${symbol.size - 4 - 7}h7v1h-7z`);
  });

  it("is deterministic for the same value and differs between values", () => {
    expect(qrSymbol("https://app-stg.niho.test/i/a")).toEqual(qrSymbol("https://app-stg.niho.test/i/a"));
    expect(qrSymbol("https://app-stg.niho.test/i/a").path).not.toBe(qrSymbol("https://app-stg.niho.test/i/b").path);
  });
});
