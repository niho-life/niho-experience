import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guide } from "@/content/guides";
import type { SitePublicExperience } from "@/lib/experience/site-publications";

const state = vi.hoisted(() => ({ config: { groupInquiryEnabled: true } as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import { JapaneseGuideArticlePage, JapaneseGuidesListPage } from "./JapaneseGuidePages";

const guide = (slug: string, over: Partial<Guide> = {}): Guide => ({
  slug, language: "ja", title: "雨の日の鎌倉", description: "雨の日の過ごし方。", category: { slug: "walks", label: "Walks", labelJa: "歩く", displayOrder: 1 },
  author: { name: "合成 花子", role: "合成のホスト", bio: "使い捨ての紹介です。" }, publishedAt: "2026-11-14", updatedAt: "2026-11-15",
  relatedExperienceSlugs: ["tea"], relatedGuideSlugs: [], faq: [],
  body: "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。\n\n## 器を繕う\n\n欠けた器をひとつ持って行きます。", ...over,
});
const experience = { publication: { slug: "tea", publicTitle: "t", unitAmount: 4000, japanese: { title: "器を繕う二時間" }, photos: [] }, saleTerms: { offers: [{ durationMinutes: 120 }] }, sellerDisclosure: null, hostBio: null } as unknown as SitePublicExperience;
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

beforeEach(() => { state.config = { groupInquiryEnabled: true }; });

describe("読みもの list", () => {
  it("shows each article's category, title, lead and writer, linked to its page, or says it is being prepared", () => {
    const html = renderToStaticMarkup(createElement(JapaneseGuidesListPage, { guides: [guide("rainy-kamakura")] }));
    expect(hrefs(html)).toContain("/ja/guides/rainy-kamakura");
    expect(text(html)).toContain("歩く雨の日の鎌倉雨の日の過ごし方。合成 花子・2026年11月14日");
    expect(text(renderToStaticMarkup(createElement(JapaneseGuidesListPage, { guides: [] })))).toContain("読みものを準備しています");
  });
});

describe("読みもの article", () => {
  it("shows title, writer, dates, the contents list and body, the experiences it points to, an inquiry way in and the writer", () => {
    const html = renderToStaticMarkup(createElement(JapaneseGuideArticlePage, { guide: guide("rainy-kamakura"), experiences: [experience] }));
    const words = text(html);
    expect(words).toContain("読みもの / 歩く");
    expect(words).toContain("合成 花子（合成のホスト）・公開 2026年11月14日・更新 2026年11月15日");
    expect(words).toContain("この記事の内容1. 屋根の下で2. 器を繕う");
    expect(words).toContain("欠けた器をひとつ持って行きます。");
    expect(words).toContain("この記事に出てくる体験器を繕う二時間");
    expect(words).toContain("2時間・1名 4,000円");
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/ja/guides", "/ja/experiences/tea", "/ja/inquiry"]));
    expect(words).toContain("この記事を書いた人合成 花子・使い捨ての紹介です。");
  });

  it("leaves out what is not there: no experiences section, no update date when unchanged, no inquiry band while the feature is off", () => {
    state.config = { groupInquiryEnabled: false };
    const html = renderToStaticMarkup(createElement(JapaneseGuideArticlePage, { guide: guide("rainy-kamakura", { updatedAt: "2026-11-14" }), experiences: [] }));
    const words = text(html);
    expect(words).not.toContain("この記事に出てくる体験");
    expect(words).not.toContain("更新");
    expect(words).not.toContain("相談したいときは");
  });
});
