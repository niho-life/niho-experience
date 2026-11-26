import { describe, expect, it } from "vitest";
import { siteNavigation } from "./site-nav";

describe("日英のサイトナビ（#672）", () => {
  it("共通のヘッダーを使い、企業・学校と体験のご相談は日本語の公開中だけ出す", () => {
    const en = siteNavigation("en", { guides: true, inquiry: true });
    const ja = siteNavigation("ja", { guides: true, inquiry: true });
    expect(en.header.map(({ href, label }) => [href, label])).toEqual([
      ["/experiences", "Experiences"], ["/guides", "Journal"], ["/about", "About"], ["/help", "Help"],
    ]);
    expect(ja.header.map(({ href, label }) => [href, label])).toEqual([
      ["/ja/experiences", "体験をさがす"], ["/ja/guides", "読みもの"], ["/ja/about", "はじめての方へ"],
      ["/ja/business", "企業・学校"], ["/ja/help", "ヘルプ"],
    ]);
    expect(ja.mobile.groups?.links.map(({ href }) => href)).toEqual(["/ja/business", "/ja/inquiry"]);
    expect(ja.footer).toContainEqual(ja.mobile.groups);
    expect(en.mobile.groups).toBeNull();
    expect(siteNavigation("ja").mobile.groups).toBeNull();
  });

  it("掲載中のカテゴリと公開中の読みものに入口を出す", () => {
    const nav = siteNavigation("ja", { categories: ["walk"] });
    expect(nav.mobile.explore.links.map(({ href }) => href)).toEqual(["/ja/experiences", "/ja/experiences?category=walk"]);
    expect(nav.mobile.visit.links.map(({ href }) => href)).toEqual(["/ja/about", "/ja/help", "/ja/help#find-booking"]);
    expect(nav.footer.slice(0, 2)).toEqual([nav.mobile.explore, nav.mobile.visit]);
    expect(siteNavigation("en", { guides: true }).mobile.visit.links.at(-1)).toEqual({ href: "/guides", label: "Kamakura Journal" });
  });

  it("ログイン中はヘッダーとメニューからホスト画面へ進める", () => {
    const nav = siteNavigation("ja", { signedIn: true });
    expect(nav.headerHost).toEqual({ href: "/host/home", label: "ホスト画面" });
    expect(nav.mobile.hosts.links).toEqual([nav.headerHost]);
  });
});
