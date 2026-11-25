import { expect, it } from "vitest";
import { withoutNativeSlugs } from "./dedupe-slugs";

it("同じ slug は native を残し、legacy 側から除く（#643）", () => {
  const legacy = [{ slug: "dinner", from: "legacy" }, { slug: "walk", from: "legacy" }];
  expect(withoutNativeSlugs(legacy, ["dinner"])).toEqual([{ slug: "walk", from: "legacy" }]);
  expect(withoutNativeSlugs(legacy, new Set<string>())).toHaveLength(2);
});
