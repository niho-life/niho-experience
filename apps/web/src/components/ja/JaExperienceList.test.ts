import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { upcomingDays } from "@/lib/date-filter";
import { parseJaListQuery, type JaCard } from "@/lib/ja-catalog";
import { JaExperienceList } from "./JaExperienceList";

/** 日本語の一覧とカード (#529) as a visitor reads them. Synthetic data only. */
const days = upcomingDays(new Date("2026-11-14T03:00:00Z"), 10, "ja");
const card = (over: Partial<JaCard> = {}): JaCard => ({
  slug: "synthetic-walk", title: "合成の山道を歩く", lead: "ガイドと歩く半日です。", cover: { url: "/media/1.jpg", alt: "山道" }, withLine: "まさとさんと", face: null,
  durationMinutes: 180, capacity: { min: 2, max: 8 }, priceFromYen: 5500, offers: [{ minimumParticipants: 2, maxPartySize: 8, weekdays: [0] }],
  classification: { category: "walk", area: "kita", companions: [], occasions: [] }, ...over,
});
const render = (cards: JaCard[], params: Record<string, string> = {}, total = cards.length) => renderToStaticMarkup(createElement(JaExperienceList, { cards, query: parseJaListQuery(params, days), days, total }));

describe("JaExperienceList", () => {
  it("shows the card as the owner described it, and no sales method, seller, guarantee or next-date label", () => {
    const html = render([card()]);
    expect(html).toContain("まさとさんと");
    expect(html).toContain("合成の山道を歩く");
    expect(html).toContain("ガイドと歩く半日です。");
    expect(html).toContain("3時間");
    expect(html).toContain("北鎌倉");
    expect(html).toContain("2〜8名");
    expect(html).toContain("¥5,500");
    expect(html).toContain('href="/ja/experiences/synthetic-walk"');
    for (const label of ["すぐ予約", "リクエスト制", "チームで案内", "NIHOが販売", "保証", "次の開催"]) expect(html).not.toContain(label);
  });

  it("offers すべて and the eight categories, marks the chosen one and heads the list with it", () => {
    const html = render([card()], { category: "zen" });
    for (const label of ["すべて", "歩く", "つくる・食べる", "手を動かす", "禅と寺", "朝と夜", "海", "人に会う", "団体・チームで"]) expect(html).toContain(label);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("坐る、点てる、写す。静かな時間の入口。");
    expect(html).toContain("<h1");
  });

  it("has the days (いつでも and ten), the four conditions and the count with a way back from a narrowed list", () => {
    const html = render([card()], { area: "kita" });
    expect(html).toContain("いつでも");
    expect(html.match(/href="\/ja\/experiences\?date=/g)?.length).toBe(10);
    for (const label of ["エリア", "だれと", "こんな日に", "人数"]) expect(html).toContain(label);
    expect(html).toContain("<b>1件</b>の体験");
    expect(html).toContain("条件をクリア");
  });

  it("narrows without scripts (a GET form with a button for them) and keeps the category and day as hidden fields", () => {
    const html = render([card()], { category: "zen", date: days[2]!.key });
    expect(html).toContain('method="get"');
    expect(html).toContain('<input type="hidden" name="category" value="zen"/>');
    expect(html).toContain(`name="date" value="${days[2]!.key}"`);
    expect(html).toContain("<noscript>");
    for (const name of ["area", "with", "occasion", "guests"]) expect(html).toContain(`name="${name}"`);
  });

  it("has no English in the list's own words (the handwritten accents are the design's)", () => {
    const text = render([card()], { area: "kita" }).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");
    const english = (text.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !["find", "your", "day"].includes(word));
    expect(english).toEqual([]);
  });

  it("offers the office when nothing matches, and the whole list stays a link away", () => {
    const html = render([], { category: "sea" }, 5);
    expect(html).toContain("<b>0件</b>の体験");
    expect(html).toContain("条件に合う体験がまだありません。");
    expect(html).toContain('href="/ja/inquiry"');
    expect(html).toContain("すべての体験を見る");
  });
});
