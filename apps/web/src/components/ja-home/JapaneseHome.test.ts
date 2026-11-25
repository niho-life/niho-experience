import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));

import { JA_HOME_TITLE } from "@/lib/ja-home";
import { HomeLivingRoom } from "../HomeLivingRoom";
import { ConsultBand, GuidesBand, PeopleBand } from "./JapaneseHomeSections";

describe("日本語トップ（#563）", () => {
  it("街のリビングの帯：日本語の見出し・説明・NIHOについてへのリンク。英語の既定の文は出ない", () => {
    const html = renderToStaticMarkup(createElement(HomeLivingRoom, { hand: "it starts here", title: "街のリビング、NIHO", body: "鎌倉駅から歩いて2分。街の人がふらりと寄って、一緒につくり、話し、手を動かす場所です。", action: { href: "/ja/about", label: "NIHOについて" }, alt: "NIHOの長いテーブルを囲む街の人たち", titleClassName: "mt-1 text-[2rem]" } as never));
    expect(html).toContain("街のリビング、NIHO");
    expect(html).toContain("it starts here");
    expect(html).toContain("鎌倉駅から歩いて2分。");
    expect(html).toContain('href="/ja/about"');
    expect(html).toContain("NIHOについて");
    expect(html).not.toContain("living room");
    expect(html).not.toContain("About NIHO Travel");
  });

  it("街のリビングの帯：props が無ければ英語のまま", () => {
    const html = renderToStaticMarkup(createElement(HomeLivingRoom));
    expect(html).toContain("NIHO, the town’s living room");
    expect(html).toContain('href="/about"');
  });

  it("相談の節。「あいだに立ちます」のような約束は押し出さない", () => {
    const consult = renderToStaticMarkup(createElement(ConsultBand));
    expect(consult).toContain("企業・学校・グループのご相談");
    expect(consult).not.toContain("載っていないことも");
    expect(consult).toContain('href="/ja/inquiry"');
    expect(consult).toContain("企業・学校の方へ");
    expect(consult).toContain('href="/ja/business"');
    expect(consult).not.toContain("法人・団体の方へ");
    expect(consult).not.toContain("あいだに立ち");
  });

  it("街の人：1人の紹介、顔の並び、「街の人 ◯人」への入口", () => {
    const person = (slug: string, name: string, quoteJa: string | null = null) => ({
      slug, name, roleJa: "料理家", areaJa: "鎌倉", quoteJa, introJa: "台所に立って四十年。", experienceSlugs: [], photo: { src: `/api/public/experience-provider-media/${slug}`, altJa: `${name}の写真`, credit: null },
    }) as never;
    const people = [person("a", "鎌倉 一郎", "毎日、鍋を洗う。"), person("b", "鎌倉 二郎"), person("c", "鎌倉 三郎")];
    const html = renderToStaticMarkup(createElement(PeopleBand, { featured: people[0], people, facesLimit: 2 } as never));
    expect(html).toContain("街の人");
    expect(html).toContain("鎌倉 一郎");
    expect(html).toContain("料理家・鎌倉");
    expect(html).toContain("「毎日、鍋を洗う。」");
    expect(html).toContain("この人に会いにいく");
    expect(html).toContain('href="/ja/people/a"');
    expect(html).toContain('href="/ja/people/b"');
    // 顔の並びは上限まで（3人目は並ばない）。入口は全員の数
    expect(html).not.toContain('href="/ja/people/c"');
    expect(html).toContain("街の人 3人");
    expect(html).toContain('href="/ja/people"');
  });

  it("読みもの：数本の記事と、一覧への入口", () => {
    const guide = (slug: string, title: string) => ({ slug, title, description: `${title}のはなし`, hero: null, category: { label: "Walk", labelJa: "歩く" } }) as never;
    const html = renderToStaticMarkup(createElement(GuidesBand, { guides: [guide("a", "切通しの歩き方"), guide("b", "雨の日の鎌倉")] } as never));
    expect(html).toContain("読みもの");
    expect(html).toContain("切通しの歩き方");
    expect(html).toContain("歩く");
    expect(html).toContain('href="/ja/guides/a"');
    expect(html).toContain('href="/ja/guides/b"');
    expect(html).toContain('href="/ja/guides"');
  });

  it("題は日本語のトップの題", () => {
    expect(JA_HOME_TITLE).toBe("鎌倉の人に、会いにいく。");
  });
});
