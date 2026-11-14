import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));

import { JA_HOME_HAND, JA_HOME_HERO_PHOTOS, JA_HOME_LEAD, JA_HOME_TITLE } from "@/lib/ja-home";
import { JapaneseHero } from "./JapaneseHero";
import { JA_HOME_OCCASIONS, pickHomeFeature } from "@/lib/ja-home";
import { CategoryNav, ConsultBand, FeatureBand, GuidesBand, HomeFinder, HostBand, JapaneseHeroCopy, OccasionStrips, PeopleBand, PicksHeading } from "./JapaneseHomeSections";

describe("日本語トップ（#563）", () => {
  it("題・手書き風の英語・説明が指定どおりで、写真の点がある", () => {
    const html = renderToStaticMarkup(createElement(JapaneseHero, { photos: JA_HOME_HERO_PHOTOS } as never, createElement(JapaneseHeroCopy, { title: JA_HOME_TITLE, hand: JA_HOME_HAND, lead: JA_HOME_LEAD })));
    expect(JA_HOME_TITLE).toBe("鎌倉の人に、会いにいく。");
    expect(html).toContain("鎌倉の人に、");
    expect(html).toContain("会いにいく。");
    expect(html).toContain("meet the town");
    expect(html).toContain("書家と筆をとる。寺で坐る。地元の台所で一緒につくって食べる。鎌倉の街の人と、その人の時間を予約できます。");
    // 架空の人の文は残さない
    expect(html).not.toContain("五十年彫りつづける");
    expect(html).toContain('href="/ja/experiences"');
    for (let n = 1; n <= JA_HOME_HERO_PHOTOS.length; n += 1) expect(html).toContain(`aria-label="写真 ${n}"`);
    // 文字が読めるよう、写真の上に暗い覆いがある
    expect(html).toContain("bg-gradient-to-t");
  });

  it("おすすめの見出しは日付の条件を言わず、件数と一覧への入口を出す", () => {
    const html = renderToStaticMarkup(createElement(PicksHeading, { total: 7 }));
    expect(html).toContain("おすすめの体験");
    expect(html).toContain("7件の体験をすべて見る");
    expect(html).not.toContain("今週末");
  });

  it("相談と体験を載せるの節。「あいだに立ちます」のような約束は押し出さない", () => {
    const consult = renderToStaticMarkup(createElement(ConsultBand));
    expect(consult).toContain("企業・学校・グループのご相談");
    expect(consult).not.toContain("載っていないことも");
    expect(consult).toContain('href="/ja/inquiry"');
    expect(consult).toContain("企業・学校の方へ");
    expect(consult).toContain('href="/ja/business"');
    expect(consult).not.toContain("法人・団体の方へ");
    const host = renderToStaticMarkup(createElement(HostBand));
    expect(host).toContain("ホストになる");
    expect(host).toContain("教えていること、案内していることを、体験として載せられます。予約の受付と支払いはこのサイトが引き受けます。");
    expect(host).toContain('href="/ja/host"');
    // ホストに直接届く今の作りと食い違う言い方は残さない
    for (const old of ["あなたの体験を、", "街の外の人へ", "事務局が引き受けます", "お客さんとのやりとり"]) expect(host).not.toContain(old);
    expect(`${consult}${host}`).not.toContain("あいだに立ち");
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

  it("さがす欄（なにをする／だれと）は JS なしの GET フォームで、一覧の category・with に渡す", () => {
    const html = renderToStaticMarkup(createElement(HomeFinder, { categories: [{ id: "walk", label: "歩く" }, { id: "sea", label: "海" }] }));
    expect(html).toContain('action="/ja/experiences"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="category"');
    expect(html).toContain('name="with"');
    expect(html).toContain("なにをする");
    expect(html).toContain("だれと");
    expect(html).toContain('<option value="walk">歩く</option>');
    expect(html).toContain('<option value="solo">ひとりで</option>');
    expect(html).toContain("さがす");
  });

  it("カテゴリーの並び（アイコンつき）、特集、シーンからさがす", () => {
    const nav = renderToStaticMarkup(createElement(CategoryNav, { categories: [{ id: "walk", label: "歩く" }, { id: "sea", label: "海" }] }));
    expect(nav).toContain('href="/ja/experiences?category=walk"');
    expect(nav).toContain("<svg");
    expect(nav).toContain("海");
    const feature = renderToStaticMarkup(createElement(FeatureBand, { feature: pickHomeFeature([{ classification: { category: "zen" } }])! }));
    expect(feature).toContain("静かな時間を、");
    // 言葉：つくる・食べる（市場の言い回しは今の体験に無い）と、歩く（「ガイドと」を付けない）
    const food = renderToStaticMarkup(createElement(FeatureBand, { feature: pickHomeFeature([{ classification: { category: "food" } }])! }));
    expect(food).toContain("鎌倉の台所でつくって食べる");
    expect(food).not.toContain("市場で食材を選び");
    expect(food).not.toContain("台所に立って、");
    const walk = renderToStaticMarkup(createElement(FeatureBand, { feature: pickHomeFeature([{ classification: { category: "walk" } }])! }));
    expect(walk).toContain("鎌倉の山と切通しを歩く");
    expect(walk).not.toContain("ガイドと歩く");
    expect(feature).toContain('href="/ja/experiences?category=zen"');
    expect(feature).toContain("禅と寺の体験を見る");
    const strips = renderToStaticMarkup(createElement(OccasionStrips, { items: JA_HOME_OCCASIONS.slice(0, 2) } as never));
    expect(strips).toContain("シーンからさがす");
    expect(strips).not.toContain("どんな日に行きますか");
    expect(strips).toContain('href="/ja/experiences?with=solo"');
    expect(strips).toContain("ふたりで");
    expect(strips).not.toContain("雨の日に");
  });
});
