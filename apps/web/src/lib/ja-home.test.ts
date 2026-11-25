import { describe, expect, it } from "vitest";
import { JA_HOME_SEO_DESCRIPTION, JA_HOME_SEO_TITLE, pickFeaturedPerson, pickHomeExperiences } from "./ja-home";
import { localJapaneseCopy } from "./ja-static-copy";

describe("日本語トップの編集内容（#563）", () => {
  it("検索結果の題と説明が、日本語のトップの題・説明と同じ", () => {
    const { values } = localJapaneseCopy();
    expect(values["meta.siteTitle"]).toBe("鎌倉の人に、会いにいく。 | NIHO Travel");
    expect(values["meta.description"]).toBe("書家と筆をとる。寺で坐る。地元の台所で一緒につくって食べる。鎌倉の街の人と、その人の時間を予約できます。");
    expect(JA_HOME_SEO_TITLE).toBe(values["meta.siteTitle"]);
    expect(JA_HOME_SEO_DESCRIPTION).toBe(values["meta.description"]);
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
});
