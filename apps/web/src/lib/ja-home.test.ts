import { describe, expect, it } from "vitest";
import { EXPERIENCE_CATEGORIES } from "@niho-experience/experience-domain";
import { JA_HOME_FEATURES, JA_HOME_FEATURE_MIN, JA_HOME_HERO_PHOTOS, JA_HOME_OCCASIONS, JA_HOME_SEO_DESCRIPTION, JA_HOME_SEO_TITLE, categoriesWithExperiences, occasionHref, occasionsWithExperiences, pickFeaturedPerson, pickHomeExperiences, pickHomeFeature } from "./ja-home";
import { localJapaneseCopy } from "./ja-static-copy";
import { existsSync } from "node:fs";

describe("日本語トップの編集内容（#563）", () => {
  it("検索結果の題と説明が、日本語のトップの題・説明と同じ", () => {
    const { values } = localJapaneseCopy();
    expect(values["meta.siteTitle"]).toBe("鎌倉の人に、会いにいく。 | NIHO Experience");
    expect(values["meta.description"]).toBe("山を歩くガイド、台所に立つ料理家、五十年彫りつづける職人。鎌倉の街の人と、その人の時間を予約できます。");
    expect(JA_HOME_SEO_TITLE).toBe(values["meta.siteTitle"]);
    expect(JA_HOME_SEO_DESCRIPTION).toBe(values["meta.description"]);
  });

  it("写真は、権利の確認できた既存の素材（niho-*）だけで、ファイルがある", () => {
    expect(JA_HOME_HERO_PHOTOS.length).toBeGreaterThanOrEqual(3);
    for (const photo of JA_HOME_HERO_PHOTOS) {
      expect(photo.src).toMatch(/^\/sample\/photos\/niho-[a-z0-9-]+\.jpg$/);
      expect(existsSync(`public${photo.src}`)).toBe(true);
    }
  });

  it("おすすめは、選んだ slug を上から順に、足りないぶんを公開中の体験で埋める（上限まで）", () => {
    const items = ["a", "b", "c", "d", "e"].map((slug) => ({ slug }));
    expect(pickHomeExperiences(items, ["c", "x", "a"], 4).map((item) => item.slug)).toEqual(["c", "a", "b", "d"]);
    expect(pickHomeExperiences(items, [], 3).map((item) => item.slug)).toEqual(["a", "b", "c"]);
    expect(pickHomeExperiences(items, ["c", "c"], 2).map((item) => item.slug)).toEqual(["c", "a"]);
    expect(pickHomeExperiences([], ["a"], 6)).toEqual([]);
  });

  it("紹介する街の人は、選んだスラッグ。載っていなければ先頭。0人なら無し（まとまりを出さない）", () => {
    const people = [{ slug: "a" }, { slug: "b" }];
    expect(pickFeaturedPerson(people, "b")?.slug).toBe("b");
    expect(pickFeaturedPerson(people, "zzz")?.slug).toBe("a");
    expect(pickFeaturedPerson(people, null)?.slug).toBe("a");
    expect(pickFeaturedPerson([], "a")).toBeNull();
  });

  const card = (category: string | null, companions: string[] = [], occasions: string[] = []) => ({ classification: { category, companions, occasions } });

  it("カテゴリーは、公開中の体験が1件以上あるものだけ（定義の順）", () => {
    expect(categoriesWithExperiences(EXPERIENCE_CATEGORIES, [card("sea"), card("walk"), card(null)]).map((item) => item.id)).toEqual(["walk", "sea"]);
    expect(categoriesWithExperiences(EXPERIENCE_CATEGORIES, [])).toEqual([]);
  });

  it("どんな日には、該当する体験があるものだけ。リンクは一覧の with / occasion へ", () => {
    const items = occasionsWithExperiences([card("walk", ["solo", "friends"], ["rain"]), card(null, ["family"])]);
    expect(items.map((item) => item.id)).toEqual(["solo", "friends", "family", "rain"]);
    expect(items.map(occasionHref)).toEqual(["/ja/experiences?with=solo", "/ja/experiences?with=friends", "/ja/experiences?with=family", "/ja/experiences?occasion=rain"]);
    expect(occasionsWithExperiences([])).toEqual([]);
  });

  it("特集と「どんな日に」の写真は、既存の素材のファイルがある。特集は8つのカテゴリーぶんあり、どれも定義にある", () => {
    for (const src of [...JA_HOME_FEATURES.flatMap((feature) => feature.photos.map((photo) => photo.src)), ...JA_HOME_OCCASIONS.map((item) => item.photo)]) expect(existsSync(`public${src}`)).toBe(true);
    expect(JA_HOME_FEATURES.map((feature) => feature.categoryId)).toEqual(EXPERIENCE_CATEGORIES.map((category) => category.id));
    for (const feature of JA_HOME_FEATURES) expect(feature.cta).toMatch(/を見る$/);
  });

  it("特集は、公開中の体験がいちばん多いカテゴリー（同数なら定義の順）で、1件から出す。無ければ出さない", () => {
    expect(JA_HOME_FEATURE_MIN).toBe(1);
    // 歩くの体験が無くても、いま体験のあるテーマ（禅と寺・つくる・食べる）が出る。
    expect(pickHomeFeature([card("zen"), card("food")])?.categoryId).toBe("food");
    expect(pickHomeFeature([card("zen")])?.categoryId).toBe("zen");
    expect(pickHomeFeature([card("zen"), card("walk"), card("walk")])?.categoryId).toBe("walk");
    expect(pickHomeFeature([card(null), card(null)])).toBeNull();
    expect(pickHomeFeature([])).toBeNull();
    // 件数の最少を上げれば、足りないときは出さない。
    expect(pickHomeFeature([card("zen"), card("food")], 2)).toBeNull();
    expect(pickHomeFeature([card("zen"), card("zen")], 2)?.categoryId).toBe("zen");
  });
});
