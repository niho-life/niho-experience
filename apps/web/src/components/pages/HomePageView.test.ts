import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined }) }));

import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import type { CardModel } from "@/lib/card-model";
import { localJapaneseCopy } from "@/lib/ja-static-copy";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { HomePageView, type HomeRest } from "./HomePageView";

const rest: HomeRest = {
  hero: { src: "/synthetic/hero.svg", alt: "" }, strips: [], stripsEyebrow: "", banner: { src: "/synthetic/banner.mp4", poster: "/synthetic/banner.svg" }, figures: [], postcards: [], hostBand: { src: "/synthetic/host.mp4", poster: "/synthetic/host.svg" },
};
const card = (slug: string, title: string): CardModel => ({
  slug, title, lead: "lead", cover: { url: `/synthetic/${slug}.svg`, alt: "" }, withLabel: "with X", face: { name: "X", initial: "X", image: null }, groupLabel: "Up to 4 guests",
  durationLabel: "2 hr", language: null, scheduleLabel: "Sat · 10:00 AM", priceLabel: "¥3,000", priceIsFrom: false, offers: [],
});
const marker = (id: string) => createElement("section", { id }, id);
const search = { windowStart: "2026-11-28", windowEnd: "2027-01-26", preview: false, bookingSources: { nihoWebOrigin: "https://niho.example.test", siteOrigin: null, siteSlugs: [], closedSlugs: [] } };

function en(cards: CardModel[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(HomePageView, { locale: "en", copy: EN_STATIC_COPY_V1, cards, search, rest, ...extra }));
}
function ja(cards: CardModel[], extra: Record<string, unknown> = {}) {
  const copy = localJapaneseCopy();
  const { values } = copy;
  return renderToStaticMarkup(createElement(SiteLocaleProvider, { locale: "ja", values } as never, createElement(HomePageView, { locale: "ja", copy, cards, search, rest, ...extra })));
}

const ORDER = ["<h1", 'id="home-cards-v1"', "home-booking-steps", 'id="home-living-room"', 'id="people-x"', 'id="journal-x"', 'id="host-band-heading-v1"'];
const positions = (html: string) => ORDER.map((needle) => needle === "home-booking-steps" ? html.indexOf("<ol") : html.indexOf(needle));
const slots = { people: marker("people-x"), journal: marker("journal-x") };

describe("HomePageView（#658）：日英で1つの部品", () => {
  const cards = [card("a", "Synthetic A"), card("b", "Synthetic B")];

  it.each([["en", () => en(cards, slots)], ["ja", () => ja(cards, slots)]] as const)("%s：同じ節の順番（ヒーロー → カード → 予約の手順 → 街のリビング → 街の人 → 読みもの → ホスト募集）", (_name, render) => {
    const at = positions(render());
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("日本語：見出し・ボタン・帯が日本語。カードは ExperienceCardV1 で、次の開催日の枠がある", () => {
    const html = ja(cards, slots);
    expect(html).toMatch(/<h1 class="text-\[2\.375rem\][^"]*">鎌倉の人に、<br\/>会いにいく。<span class="hand mt-1 block[^"]*text-leaf[^"]*">meet the town<\/span><\/h1>/);
    expect(html).toContain("書家と筆をとる。寺で坐る。");
    // The hero button is gone: the search bar (a real GET form to the list) overlaps the hero instead (#698).
    expect(html).toContain('role="search"');
    expect(html).toContain('action="/ja/experiences"');
    expect(html).toContain("体験をさがす");
    expect(html).toContain("キーワード");
    expect(html).toContain("いつでも");
    expect(html).toContain("人数指定なし");
    expect(html).toContain("さがす</button>");
    expect(html).toContain("our picks");
    expect(html).toContain("おすすめの体験");
    expect(html).toContain("街のリビング、NIHO");
    expect(html).toContain('href="/ja/about"');
    expect(html).toContain("ホストになる");
    expect(html).toContain('href="/ja/host"');
    expect(html).toContain("日程を選ぶ");
    expect(html).toContain("/ja/experiences/a");
    // 料金の「/ 大人1名」は二重にならない
    expect(html.match(/大人1名/g)).toHaveLength(2);
    expect(html).toContain("<article");
    // No "next dates" and no weekday line on the card (#698); the card is the same one the list uses.
    expect(html).not.toMatch(/data-next-dates|class="mt-3 h-7 overflow-hidden"|Sat · 10:00 AM/);
    for (const gone of ["See the experiences", "Spend a few hours", "NIHO, the town", "なにをする", "シーンからさがす", "aria-label=\"カテゴリー\"", "take a walk", "pick your day"]) expect(html).not.toContain(gone);
  });

  it("相談のカードは日本語で相談受付中のときに街のリビングと並び、企業・学校と体験相談に進める", () => {
    for (const html of [en(cards, { inquiry: true }), ja(cards)]) expect(html).not.toContain("home-group-heading");
    const html = ja(cards, { inquiry: true });
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("企業・学校・グループで");
    expect(html).toContain('href="/ja/business"');
    expect(html).toContain('href="/ja/inquiry"');
    expect(html).toContain("はじめの相談は無料です");
  });

  it("両言語でヒーローの次に掲載中のカテゴリを並べ、ホスト募集は下段にまとめる", () => {
    for (const [render, prefix] of [[en, ""], [ja, "/ja"]] as const) {
      const html = render(cards, { categories: ["food"] });
      const category = `href="${prefix}/experiences?category=food"`;
      expect(html.indexOf(category)).toBeGreaterThan(html.indexOf("</h1>"));
      expect(html.indexOf(category)).toBeLessThan(html.indexOf('id="home-cards-v1"'));
      expect(html).not.toContain("category=sea");
      expect(html).not.toMatch(/Your experience here|あなたの体験も、ここに/);
      expect(html.slice(html.indexOf('id="host-band-heading-v1"'))).toContain('href="/host/auth/login"');
    }
  });

  it("検索バーはヒーローの下端に重なり、日英で同じ部品（言葉だけが違う）", () => {
    const e = en(cards);
    const j = ja(cards);
    for (const html of [e, j]) {
      expect(html.match(/role="search"/g)).toHaveLength(1);
      expect(html.indexOf('role="search"')).toBeGreaterThan(html.indexOf("</h1>"));
      expect(html.indexOf('role="search"')).toBeLessThan(html.indexOf('id="home-cards-v1"'));
      expect(html).toContain("lg:bottom-[-38px]");
      expect(html).toContain('name="q"');
      expect(html).not.toContain('name="date"');
    }
    expect(e).toContain(">What<");
    expect(e).toContain(">Guests<");
    expect(j).toContain(">日にち<");
    expect(j).toContain(">人数<");
  });

  it("カテゴリーの行は手描きアイコンの付いたリンク（すべて＋掲載中のカテゴリー）で、カテゴリーが無ければ出ない", () => {
    for (const [render, prefix, all] of [[en, "", "All"], [ja, "/ja", "すべて"]] as const) {
      const html = render(cards, { categories: ["food", "walk"] });
      expect(html).toContain(`href="${prefix}/experiences"`);
      expect(html).toMatch(new RegExp(`href="${prefix}/experiences\\?category=walk"[^>]*><span[^>]*><svg`));
      expect(html).toContain(`>${all}</a>`);
      expect(html).not.toContain("rounded-full border border-line-strong px-4");
      expect(render(cards, { categories: [] })).not.toContain("aria-label=\"Categories\"");
    }
  });

  it("英語：いままでの文言のまま", () => {
    const html = en(cards);
    expect(html).toContain("after the Great Buddha");
    expect(html).toContain('Spend a few hours with a <span class="squig">neighbor</span>');
    expect(html).toContain("Small experiences with people who live here, one hour from Tokyo.");
    expect(html).not.toContain("See the experiences");
    expect(html).toContain('role="search"');
    expect(html).toContain('action="/experiences"');
    expect(html).toContain("Find an experience");
    expect(html).toContain("Any day · Any group");
    expect(html).toContain('href="/experiences/a"');
    expect(html).toContain("NIHO, the town’s living room");
    expect(html).not.toContain("meet the town");
  });

  it("カードは選んだ順の最大6件", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((slug) => card(slug, `Synthetic ${slug}`));
    for (const html of [en(many), ja(many)]) {
      expect(html).toContain("Synthetic f");
      expect(html).not.toContain("Synthetic g");
    }
  });

  it("体験が0件なら見出しの eyebrow と予約の手順は出ず、空の表示になる", () => {
    expect(en([])).not.toContain("after the Great Buddha");
    expect(ja([])).not.toContain("our picks");
  });
});
