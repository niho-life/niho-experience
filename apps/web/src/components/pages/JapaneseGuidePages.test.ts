import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guide } from "@/content/guides";
import type { CardModel } from "@/lib/card-model";

const state = vi.hoisted(() => ({ config: { groupInquiryEnabled: true, siteUrl: "https://experience.example" } as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/components/CardDates", () => ({ CardDates: () => null }));

import { GuideArticle } from "./GuideArticle";
import { GuidesListPage, japaneseGuideCatalog } from "./GuidesListPage";

const guide = (slug: string, over: Partial<Guide> = {}): Guide => ({
  slug, language: "ja", title: "雨の日の鎌倉", description: "雨の日の過ごし方。", category: { slug: "walks", label: "Walks", labelJa: "歩く", displayOrder: 1 },
  author: { name: "合成 花子", role: "合成のホスト", bio: "使い捨ての紹介です。" }, publishedAt: "2026-11-14", updatedAt: "2026-11-15",
  relatedExperienceSlugs: ["tea"], relatedGuideSlugs: ["other"], faq: [{ question: "雨の日でも歩けますか", answer: "天気に合わせて過ごし方を選べます。" }],
  body: "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。\n\n## 器を繕う\n\n欠けた器をひとつ持って行きます。", ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
const card = {
  slug: "tea", title: "器を繕う二時間", lead: "器を直します。", cover: null, withLabel: "合成ホストが案内", face: { name: "合成ホスト", initial: "合", image: null },
  groupLabel: "1名", durationLabel: "2時間", language: null, scheduleLabel: "土曜日", priceLabel: "¥4,000", priceIsFrom: false, offers: [],
} as unknown as CardModel;

beforeEach(() => { state.config = { groupInquiryEnabled: true, siteUrl: "https://experience.example" }; });

describe("shared guide listing", () => {
  it("shows Japanese category labels and Japanese article URLs", () => {
    const html = renderToStaticMarkup(createElement(GuidesListPage, { catalog: japaneseGuideCatalog([guide("rainy-kamakura")]), locale: "ja" }));
    expect(hrefs(html)).toContain("/ja/guides/rainy-kamakura");
    expect(text(html)).toContain("読みもの");
    expect(text(html)).toContain("歩く");
    expect(text(html)).toContain("雨の日の鎌倉");
    expect(text(html)).toContain("合成 花子");
  });
});

describe("shared Japanese guide article", () => {
  it("shows the outline, native experience CTA, FAQ, consultation, related guide and author in Japanese", async () => {
    const article = await GuideArticle({
      guide: guide("rainy-kamakura"), variant: "published", query: {}, locale: "ja", japaneseGuides: [guide("other", { title: "鎌倉の朝", relatedGuideSlugs: [], relatedExperienceSlugs: [] })],
      experienceCards: [card], experienceCardDates: { kind: "given", occurrences: null },
    });
    const html = renderToStaticMarkup(article);
    const words = text(html);
    expect(words).toContain("読みもの / 歩く");
    expect(words).toContain("この記事の内容1. 屋根の下で2. 器を繕う");
    expect(words).toContain("欠けた器をひとつ持って行きます。");
    expect(words).toContain("この記事に出てくる体験器を繕う二時間");
    expect(words).toContain("¥4,000 / 人 · 2時間");
    expect(words).toContain("よくある質問雨の日でも歩けますか");
    expect(words).toContain("この記事のことで、相談したいときは");
    expect(words).toContain("次に読む鎌倉の朝");
    expect(words).toContain("この記事を書いた人合成 花子・使い捨ての紹介です。");
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/ja/guides", "/ja/experiences/tea", "/ja/inquiry", "/ja/guides/other"]));
    expect(html).toContain("https://experience.example/ja/guides/rainy-kamakura");
  });

  it("omits absent experiences and inquiry, and omits a duplicate update date", async () => {
    state.config = { groupInquiryEnabled: false, siteUrl: "https://experience.example" };
    const article = await GuideArticle({
      guide: guide("rainy-kamakura", { updatedAt: "2026-11-14", relatedExperienceSlugs: [], faq: [] }),
      variant: "published", query: {}, locale: "ja", japaneseGuides: [], experienceCards: [], experienceCardDates: { kind: "given", occurrences: null },
    });
    const words = text(renderToStaticMarkup(article));
    expect(words).not.toContain("この記事に出てくる体験");
    expect(words).not.toContain("更新");
    expect(words).not.toContain("相談したいときは");
  });
});
