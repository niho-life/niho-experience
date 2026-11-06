import { describe, expect, it } from "vitest";
import { assertStaticCopyValuesV1, defaultStaticCopyValuesV1, STATIC_COPY_REGISTRY_V1, type StaticCopyKeyV1 } from "@niho/experience-presentation/v1";
import { JA_STATIC_COPY_V1, LOCAL_JAPANESE_RELEASE_ID, localJapaneseCopy } from "./ja-static-copy";

const JAPANESE_CHARACTER = /[぀-ヿ㐀-鿿]/;
/** Values that are meant to stay as they are: the brand, a time-zone label, the host-side "NIHO" and number formats. */
const KEPT_AS_IS: readonly StaticCopyKeyV1[] = [
  "chrome.brand", "chrome.brandRich", "meta.titleTemplate", "common.jst", "host.niho", "booking.adultRow", "booking.childRow",
];

describe("the site's own Japanese interface copy (#59)", () => {
  it("is a complete, valid value for every key of the v1 registry (placeholders and markers included)", () => {
    expect(() => assertStaticCopyValuesV1(JA_STATIC_COPY_V1)).not.toThrow();
    expect(Object.keys(JA_STATIC_COPY_V1).sort()).toEqual(Object.keys(STATIC_COPY_REGISTRY_V1).sort());
    expect(Object.keys(JA_STATIC_COPY_V1)).toHaveLength(342);
  });

  it("is actually Japanese: no English default is left in, except the brand and a few formats", () => {
    const english = defaultStaticCopyValuesV1();
    const untranslated = (Object.keys(JA_STATIC_COPY_V1) as StaticCopyKeyV1[]).filter((key) => !KEPT_AS_IS.includes(key)
      && (JA_STATIC_COPY_V1[key] === english[key] || !JAPANESE_CHARACTER.test(JA_STATIC_COPY_V1[key])));
    expect(untranslated).toEqual([]);
  });

  it("is plain text: no markup, no stray spaces at the ends, within the length limit", () => {
    for (const [key, value] of Object.entries(JA_STATIC_COPY_V1)) {
      expect(value, key).not.toMatch(/[<>]/);
      expect(value, key).toBe(value.trim());
      expect(value.length, key).toBeLessThanOrEqual(2000);
    }
    expect(localJapaneseCopy().values["meta.titleTemplate"]).toBe("{title} | NIHO Experience");
  });

  it("fills placeholders and {em} markers like the English copy does", () => {
    const copy = localJapaneseCopy();
    expect(copy.text("card.fromPrice", { price: "¥8,000" })).toBe("¥8,000〜 / 大人1名");
    expect(copy.text("booking.guestRange", { minimum: 2, maximum: 6 })).toBe("1回のご予約で2〜6名。");
    expect(copy.text("booking.rateLimitedCount", { seconds: 30, noun: "秒" })).toBe("試行回数が多すぎます。30秒後にもう一度お試しください。");
    expect(copy.rich("home.heroHeadingRich")).toEqual([
      { text: "鎌倉を", emphasis: false }, { text: "わが家", emphasis: true }, { text: "にしている人たちと出会う", emphasis: false },
    ]);
    expect(copy.rich("booking.totalRich", { total: "¥12,000" }).map((segment) => segment.text).join("")).toBe("合計 ¥12,000");
  });

  it("never lets the presentation package's English nouns into a Japanese sentence", () => {
    const copy = localJapaneseCopy();
    expect(copy.text("booking.showMoreDates", { count: 1, noun: "date" })).toBe("さらに1件の日程を表示");
    expect(copy.text("booking.showMoreDates", { count: 3, noun: "dates" })).toBe("さらに3件の日程を表示");
    // Any other noun, or any other key, is passed through untouched.
    expect(copy.text("booking.showMoreDates", { count: 2, noun: "回" })).toBe("さらに2件の回を表示");
    expect(copy.text("booking.fewer", { noun: "大人" })).toBe("大人を減らす");
    expect(copy.text("booking.more", { noun: "子ども" })).toBe("子どもを増やす");
  });

  it("is built once and has a fixed release id", () => {
    expect(localJapaneseCopy()).toBe(localJapaneseCopy());
    expect(Object.isFrozen(localJapaneseCopy())).toBe(true);
    expect(LOCAL_JAPANESE_RELEASE_ID).toBe("experience-local-ja-v1");
  });
});
