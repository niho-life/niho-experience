import { describe, expect, it } from "vitest";
import { JA_HOME_HERO_PHOTOS, JA_HOME_SEO_DESCRIPTION, JA_HOME_SEO_TITLE, pickHomeExperiences } from "./ja-home";
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
});
