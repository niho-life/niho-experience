import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HELP_QUESTIONS_JA, HelpFaq } from "./HelpFaq";

describe("Help common questions (#645)", () => {
  const html = renderToStaticMarkup(HelpFaq());
  it("lists the five questions as details with their answers", () => {
    expect(html).toContain("Common questions");
    expect(html.match(/<details/g)).toHaveLength(5);
    for (const q of ["Do I need an account?", "How do I pay?", "What language is an experience held in?", "Where do we meet?", "How far is Kamakura from Tokyo?"]) expect(html).toContain(q);
    expect(html).toContain("About one hour by train.");
  });
});

describe("日本語のよくある質問（#658）", () => {
  const html = renderToStaticMarkup(HelpFaq({ questions: HELP_QUESTIONS_JA, title: "よくある質問" }));
  it("5つの質問を details で出し、見出しは日本語、eyebrow は既定のまま", () => {
    expect(html).toContain("よくある質問");
    expect(html).toContain("good to know");
    expect(html.match(/<details/g)).toHaveLength(5);
    for (const q of ["アカウントは必要ですか？", "支払い方法は？", "体験は何語で行われますか？", "どこに集合しますか？", "東京から鎌倉まではどのくらいですか？"]) expect(html).toContain(q);
    expect(html).toContain("電車でおよそ1時間です。");
    expect(html).not.toContain("Common questions");
  });
});
