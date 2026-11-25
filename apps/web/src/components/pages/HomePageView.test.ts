import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

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
const cardDates = { kind: "read" as const, preview: false, sources: { nihoWebOrigin: "https://niho.example.test", siteOrigin: null, siteSlugs: [], closedSlugs: [] } };

function en(cards: CardModel[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(HomePageView, { locale: "en", copy: EN_STATIC_COPY_V1, cards, cardDates, rest, ...extra }));
}
function ja(cards: CardModel[], extra: Record<string, unknown> = {}) {
  const copy = localJapaneseCopy();
  const { values } = copy;
  return renderToStaticMarkup(createElement(SiteLocaleProvider, { locale: "ja", values } as never, createElement(HomePageView, { locale: "ja", copy, cards, cardDates, rest, ...extra })));
}

const ORDER = ["<h1", 'id="home-cards-v1"', "home-booking-steps", 'id="home-living-room"', 'id="people-x"', 'id="consult-x"', 'id="journal-x"', 'id="host-band-heading-v1"'];
const positions = (html: string) => ORDER.map((needle) => needle === "home-booking-steps" ? html.indexOf("<ol") : html.indexOf(needle));
const slots = { people: marker("people-x"), consult: marker("consult-x"), journal: marker("journal-x") };

describe("HomePageView（#658）：日英で1つの部品", () => {
  const cards = [card("a", "Synthetic A"), card("b", "Synthetic B")];

  it.each([["en", () => en(cards, slots)], ["ja", () => ja(cards, slots)]] as const)("%s：同じ節の順番（ヒーロー → カード → 予約の手順 → 街のリビング → 街の人 → 相談 → 読みもの → ホスト募集）", (_name, render) => {
    const at = positions(render());
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("日本語：見出し・ボタン・帯が日本語。カードは ExperienceCardV1 で、次の開催日の枠がある", () => {
    const html = ja(cards, slots);
    expect(html).toMatch(/<h1 class="text-\[2\.375rem\][^"]*">鎌倉の人に、<br\/>会いにいく。<span class="hand mt-1 block[^"]*text-leaf[^"]*">meet the town<\/span><\/h1>/);
    expect(html).toContain("書家と筆をとる。寺で坐る。");
    expect(html).toContain('href="/ja/experiences"');
    expect(html).toContain("体験をさがす");
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
    expect(html.match(/data-next-dates|class="mt-3 h-7 overflow-hidden"/g)).toHaveLength(2);
    for (const gone of ["See the experiences", "Spend a few hours", "NIHO, the town", "role=\"search\"", "なにをする", "シーンからさがす", "aria-label=\"カテゴリー\"", "take a walk", "pick your day"]) expect(html).not.toContain(gone);
  });

  it("相談の節は渡したときだけ（日本語のページだけが渡す）。無ければ出ない", () => {
    expect(en(cards)).not.toContain("consult-x");
    expect(ja(cards)).not.toContain("consult-x");
    expect(ja(cards, { consult: marker("consult-x") })).toContain("consult-x");
    expect(en(cards, slots)).not.toContain("企業");
  });

  it("英語：いままでの文言のまま", () => {
    const html = en(cards);
    expect(html).toContain("after the Great Buddha");
    expect(html).toContain('Spend a few hours with a <span class="squig">neighbor</span>');
    expect(html).toContain("Small experiences with people who live here, one hour from Tokyo.");
    expect(html).toContain("See the experiences");
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
