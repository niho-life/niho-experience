import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/experiences", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined }) }));

import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import type { CardModel } from "@/lib/card-model";
import { upcomingDays } from "@/lib/date-filter";
import { localJapaneseCopy } from "@/lib/ja-static-copy";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JaListConsult, JaListEmpty } from "@/components/ja/JaListConsult";
import { ExperiencesPageView } from "./ExperiencesPageView";

const card = (slug: string, title: string): CardModel => ({
  slug, title, lead: "lead", cover: { url: `/synthetic/${slug}.svg`, alt: "" }, withLabel: "with X", face: { name: "X", initial: "X", image: null }, groupLabel: "Up to 4 guests",
  durationLabel: "2 hr", language: null, scheduleLabel: "Sat · 10:00 AM", priceLabel: "¥3,000", priceIsFrom: false, offers: [{ id: "o", minimumParticipants: 1, maxPartySize: 4 }],
});
const sources = { nihoWebOrigin: "https://niho.example.test", siteOrigin: null, siteSlugs: [], closedSlugs: [] };
const cards = [card("a", "Synthetic A"), card("b", "Synthetic B")];
const marker = (id: string) => createElement("section", { id }, id);

type Extra = Record<string, unknown>;
const base = (locale: "en" | "ja", extra: Extra) => ({
  locale, cards, days: upcomingDays(new Date("2026-11-25T03:00:00Z"), 14, locale), initialDate: null, initialGuests: null, searchQuery: "", category: null, categories: ["walk", "sea"], bookingSources: sources, ...extra,
});
function en(extra: Extra = {}) {
  return renderToStaticMarkup(createElement(ExperiencesPageView, { ...base("en", extra), copy: EN_STATIC_COPY_V1 } as never));
}
function ja(extra: Extra = {}) {
  const copy = localJapaneseCopy();
  return renderToStaticMarkup(createElement(SiteLocaleProvider, { locale: "ja", values: copy.values } as never, createElement(ExperiencesPageView, { ...base("ja", extra), copy } as never)));
}

const ORDER = ["<h1", "<nav", 'id="experience-search"', "<ul class=\"grid", "How booking works", 'id="readings-x"'];
const JA_ORDER = ["<h1", "<nav", 'id="experience-search"', "<ul class=\"grid", "予約のしくみ", 'id="readings-x"', 'id="consult-x"'];
const inOrder = (html: string, needles: string[]) => {
  const at = needles.map((needle) => html.indexOf(needle));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
};

describe("ExperiencesPageView（#658）：日英で1つの部品", () => {
  it("en：見出し → カテゴリー → 一覧 → 予約の安心 → 読みもの", () => {
    inOrder(en({ readings: marker("readings-x") }), ORDER);
  });

  it("ja：同じ順番（最後に相談の案内）", () => {
    inOrder(ja({ readings: marker("readings-x"), consult: marker("consult-x") }), JA_ORDER);
  });

  it("見出しと説明：en は今のまま、ja は『すべての体験』", () => {
    const e = en();
    expect(e).toContain("Kamakura experiences with local hosts");
    expect(e).toContain("Hosted by people who live here, one hour from Tokyo.");
    const j = ja();
    expect(j).toContain(">すべての体験</h1>");
    expect(j).toContain("鎌倉・逗子・葉山の人と活動に、会いにいく。料金は日本円、時刻は日本時間です。");
  });

  it("カテゴリーの並び：All＋体験のあるものだけ、選択中は aria-current、日付などを保つ", () => {
    const html = en({ category: "sea", initialDate: "2026-11-27", initialGuests: 2, searchQuery: "tea" });
    expect(html).toContain('aria-label="Categories"');
    expect(html).toContain("Walks");
    expect(html).toContain("By the sea");
    expect(html).not.toContain("Cook &amp; eat");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?By the sea/);
    expect(html).toContain('href="/experiences?category=walk&amp;date=2026-11-27&amp;guests=2&amp;q=tea"');
    expect(html).toContain('href="/experiences?date=2026-11-27&amp;guests=2&amp;q=tea"');
    const j = ja({ category: "walk" });
    expect(j).toContain('aria-label="カテゴリー"');
    expect(j).toContain('href="/ja/experiences?category=sea"');
    expect(j).toContain("すべて");
  });

  it("選択中のカテゴリーは0件でも出し、出せるカテゴリーが無ければ並びごと出さない", () => {
    expect(en({ categories: ["zen"], category: "zen" })).toContain("Zen &amp; temples");
    expect(en({ categories: [] })).not.toContain("<nav");
    expect(ja({ categories: [] })).not.toContain('aria-label="カテゴリー"');
  });

  it("カテゴリー選択中の見出し：en は英語名・説明そのまま、ja は名前と説明", () => {
    const e = en({ category: "sea" });
    expect(e).toContain(">By the sea</h1>");
    expect(e).toContain("Hosted by people who live here, one hour from Tokyo.");
    const j = ja({ category: "sea" });
    expect(j).toContain(">海</h1>");
    expect(j).toContain("材木座、逗子、葉山。海のそばで過ごします。");
  });

  it("相談の案内は渡したときだけ（日本語）、日本語にはエリア・だれと・こんな日にの絞り込みが無い", () => {
    expect(ja()).not.toContain("探しているものが見つからないときは");
    const j = ja({ consult: createElement(JaListConsult) });
    expect(j).toContain("探しているものが見つからないときは");
    expect(j).toContain('href="/ja/inquiry"');
    for (const label of ["エリア", "だれと", "こんな日に"]) expect(j).not.toContain(label);
    expect(j).toContain("日付");
  });

  it("日本語：0件のときの相談の案内、予約の安心は日本語", () => {
    const j = ja({ cards: [], empty: createElement(JaListEmpty, { total: 3 }) });
    expect(j).toContain("条件に合う体験がまだありません。");
    expect(j).toContain("相談する");
    expect(ja()).toContain("日本円でカード払い");
    expect(ja()).toContain('href="/ja/help"');
    expect(en()).toContain("Pay by card in yen");
  });
});
