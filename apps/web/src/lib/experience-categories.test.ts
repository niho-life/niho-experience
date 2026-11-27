import { describe, expect, it } from "vitest";
import { EXPERIENCE_CATEGORIES, type ExperienceCategoryId } from "@niho-experience/experience-domain";
import { EXPERIENCE_AREAS } from "@niho-experience/experience-domain";
import { englishListCatalog, japaneseListPublication } from "./experience-list-catalog";
import type { SitePublicExperience } from "./experience/site-publications";
import { ALL_CATEGORIES_LABEL, areaLabel, categoryLabel, filterByCategory, parseCategoryParam, resolveCategories } from "./experience-categories";

describe("カテゴリーの名前（日英）", () => {
  it("すべての id に英語名と日本語名がある", () => {
    for (const { id, label } of EXPERIENCE_CATEGORIES) {
      expect(categoryLabel(id, "en").trim()).not.toBe("");
      expect(categoryLabel(id, "ja")).toBe(label);
    }
  });

  it("英語名は決めたとおり、『すべて』も日英で持つ", () => {
    expect(EXPERIENCE_CATEGORIES.map((item) => categoryLabel(item.id, "en"))).toEqual(["Walks", "Cook & eat", "Make by hand", "Zen & temples", "Dawn & dusk", "By the sea", "Meet people", "Groups & teams"]);
    expect(ALL_CATEGORIES_LABEL).toEqual({ en: "All", ja: "すべて" });
  });
});

describe("カテゴリーの絞り込み", () => {
  const bySlug = new Map<string, ExperienceCategoryId>([["a", "walk"], ["b", "sea"], ["c", "walk"]]);
  it("category の値は id だけ", () => {
    expect(parseCategoryParam("walk")).toBe("walk");
    expect(parseCategoryParam("cooking")).toBeNull();
    expect(parseCategoryParam(["walk"])).toBeNull();
    expect(parseCategoryParam(undefined)).toBeNull();
  });

  it("体験のあるカテゴリーだけを固定の順で出し、選択中は0件でも出す", () => {
    expect(resolveCategories(["a", "b"], bySlug, null).available).toEqual(["walk", "sea"]);
    expect(resolveCategories(["b"], bySlug, "zen").available).toEqual(["zen", "sea"]);
    expect(resolveCategories(["x"], bySlug, null).available).toEqual([]);
  });

  it("一覧の掲載条件と同じ判定で、その言語の原稿がない商品のカテゴリを除く（予約の受付が準備中の商品は入れる）", () => {
    const publication = (slug: string, offers: number, japanese: boolean) => ({
      publication: { slug, japanese: japanese ? { title: slug } : null },
      saleTerms: { offers: Array.from({ length: offers }, () => ({})) },
    }) as unknown as SitePublicExperience;
    const experiences = [publication("a", 1, true), publication("b", 0, true), publication("d", 1, false)];
    // 予約の受付が準備中のページ（販売なし）も、日本語の原稿があれば一覧に載せる（#706）。
    const classifications = new Map([...bySlug, ["d", "zen"] as const]);
    const en = englishListCatalog([{ slug: "b" }, { slug: "e" }], { experiences, claimedSlugs: ["b"] });
    const ja = experiences.filter(japaneseListPublication).map(({ publication }) => publication.slug);

    expect(en.slugs).toEqual(["e", "a", "b", "d"]);
    expect(resolveCategories(en.slugs, classifications, null).available).toEqual(["walk", "zen", "sea"]);
    expect(ja).toEqual(["a", "b"]);
    // b is a page with no sale (sea): it stays on the Japanese list; d has no Japanese text (zen) and does not.
    expect(resolveCategories(ja, classifications, null).available).toEqual(["walk", "sea"]);
  });

  it("分類を読めないときは並びを出さず、絞り込みもしない", () => {
    expect(resolveCategories(["a"], null, "walk")).toEqual({ available: [], selected: null });
    expect(filterByCategory([{ slug: "a" }, { slug: "b" }], null, "walk")).toHaveLength(2);
  });

  it("選んだカテゴリーの体験だけにする", () => {
    expect(filterByCategory([{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }], bySlug, "walk").map((card) => card.slug)).toEqual(["a", "c"]);
    expect(filterByCategory([{ slug: "a" }, { slug: "d" }], bySlug, null)).toHaveLength(2);
  });
});

describe("areaLabel (#658)", () => {
  it("has an English name for every area, and the Japanese one is the classification's label", () => {
    for (const { id, label } of EXPERIENCE_AREAS) {
      expect(areaLabel(id, "en").trim()).not.toBe("");
      expect(areaLabel(id, "ja")).toBe(label);
    }
    expect(areaLabel("kamakura", "en")).toBe("Around Kamakura Station");
    expect(areaLabel("ofuna", "en")).toBe("Ofuna & the hills");
  });
});
