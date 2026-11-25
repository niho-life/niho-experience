import { expect, it } from "vitest";
import { languageSwitchTarget } from "./locale-links";

it("一覧の言語切り替えで category を保つ（秘密の値は保たない）", () => {
  const counterparts = { "/experiences": "/ja/experiences" };
  expect(languageSwitchTarget("/experiences", "category=sea&q=tea&token=x", counterparts)).toBe("/ja/experiences?category=sea&q=tea");
  expect(languageSwitchTarget("/ja/experiences", "category=zen&date=2026-11-30", counterparts)).toBe("/experiences?category=zen&date=2026-11-30");
});
