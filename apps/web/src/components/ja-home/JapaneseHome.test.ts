import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));

import { JA_HOME_HAND, JA_HOME_HERO_PHOTOS, JA_HOME_LEAD, JA_HOME_TITLE } from "@/lib/ja-home";
import { JapaneseHero } from "./JapaneseHero";
import { ConsultBand, HostBand, JapaneseHeroCopy, PicksHeading } from "./JapaneseHomeSections";

describe("日本語トップ（#563）", () => {
  it("題・手書き風の英語・説明が指定どおりで、写真の点がある", () => {
    const html = renderToStaticMarkup(createElement(JapaneseHero, { photos: JA_HOME_HERO_PHOTOS } as never, createElement(JapaneseHeroCopy, { title: JA_HOME_TITLE, hand: JA_HOME_HAND, lead: JA_HOME_LEAD })));
    expect(JA_HOME_TITLE).toBe("鎌倉の人に、会いにいく。");
    expect(html).toContain("鎌倉の人に、");
    expect(html).toContain("会いにいく。");
    expect(html).toContain("meet the town");
    expect(html).toContain("山を歩くガイド、台所に立つ料理家、五十年彫りつづける職人。鎌倉の街の人と、その人の時間を予約できます。");
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
    expect(consult).toContain("載っていないことも、");
    expect(consult).toContain("相談できます。");
    expect(consult).toContain('href="/ja/inquiry"');
    expect(consult).toContain('href="/ja/schools"');
    expect(consult).toContain('href="/ja/business"');
    const host = renderToStaticMarkup(createElement(HostBand));
    expect(host).toContain("あなたの体験を、");
    expect(host).toContain("街の外の人へ。");
    expect(host).toContain('href="/ja/host"');
    expect(`${consult}${host}`).not.toContain("あいだに立ち");
  });
});
