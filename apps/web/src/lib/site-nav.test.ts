import { describe, expect, it } from "vitest";
import { siteNav } from "./site-nav";

describe("ヘッダーのタブ（日英で1つの定義、#658）", () => {
  it("英語：Experiences、Journal（ページがあるとき）、About、Help。日本語だけの項目は無い", () => {
    expect(siteNav("en", { guides: true, inquiry: true }).map((entry) => [entry.href, entry.label, entry.where])).toEqual([
      ["/experiences", "Experiences", "row"], ["/guides", "Journal", "tabs"], ["/about", "About", "tabs"], ["/help", "Help", "tabs"],
    ]);
    expect(siteNav("en", { guides: false, inquiry: false }).map((entry) => entry.href)).toEqual(["/experiences", "/about", "/help"]);
  });

  it("日本語：同じ並びに、日本語だけの「企業・学校」（タブ）と「ご相談」（メニューだけ）が入る", () => {
    expect(siteNav("ja", { guides: true, inquiry: true }).map((entry) => [entry.href, entry.label, entry.where])).toEqual([
      ["/ja/experiences", "体験をさがす", "row"], ["/ja/guides", "読みもの", "tabs"], ["/ja/about", "NIHOについて", "tabs"],
      ["/ja/business", "企業・学校", "tabs"], ["/ja/inquiry", "ご相談", "menu"], ["/ja/help", "ヘルプ", "tabs"],
    ]);
    expect(siteNav("ja", { guides: false, inquiry: false }).map((entry) => entry.href)).toEqual(["/ja/experiences", "/ja/about", "/ja/help"]);
  });

  it("日英とも、行に常に残るのは1つ目だけ。日本語と英語で同じページは同じ順番に並ぶ", () => {
    for (const locale of ["en", "ja"] as const) expect(siteNav(locale, { guides: true, inquiry: true }).filter((entry) => entry.where === "row")).toHaveLength(1);
    const strip = (href: string) => href.replace(/^\/ja/, "");
    const shared = siteNav("ja", { guides: true, inquiry: true }).map((entry) => strip(entry.href)).filter((href) => !["/business", "/inquiry"].includes(href));
    expect(shared).toEqual(siteNav("en", { guides: true, inquiry: true }).map((entry) => entry.href));
  });
});
