import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicPerson } from "@niho-experience/experience-store";
import type { SitePublicExperience } from "@/lib/experience/site-publications";

const state = vi.hoisted(() => ({ config: { groupInquiryEnabled: true } as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import { PeopleListPage, PersonPage } from "./PeoplePages";

/** 街の人 (#564): the list and a person's page, from synthetic people. */
const person = (slug: string, over: Partial<PublicPerson> = {}): PublicPerson => ({
  slug, name: `合成 ${slug}`, roleJa: "合成の職人", areaJa: "合成の町", quoteJa: "合成のひとこと", introJa: "一行目\n二行目",
  photo: { src: `/api/public/experience-provider-media/00000000-0000-4000-8000-00000000000${slug.length}`, altJa: `${slug}の写真`, credit: "合成の撮影者" },
  experienceSlugs: [], sortOrder: 100, ...over,
});
const experience = (slug: string, title: string): SitePublicExperience => ({
  publication: { slug, publicTitle: title, unitAmount: 3000, japanese: { title }, photos: [{ src: `/p/${slug}.jpg`, alt: "alt", altJa: `${title}の写真`, publicCredit: null }] },
  saleTerms: { offers: [{ pricing: { adultPriceYen: 4000 }, durationMinutes: 90 }] },
  sellerDisclosure: null, hostBio: null,
} as unknown as SitePublicExperience);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => { state.config = { groupInquiryEnabled: true }; });

describe("街の人 list", () => {
  it("shows each person with a photo, name, role and area, links to their page, and offers a way in for someone who is not here", () => {
    const html = renderToStaticMarkup(createElement(PeopleListPage, { people: [person("a-san"), person("b-san")] }));
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/ja/people/a-san", "/ja/people/b-san"]));
    expect(text(html)).toContain("合成 a-san 合成の職人 合成の町");
    expect(html).toContain("会いたい人が、ここにいないときは");
    expect(hrefs(html)).toContain("/ja/inquiry");
    expect(html).not.toMatch(/貸切|英語ガイド/);
  });

  it("says so when nobody is listed, and offers no inquiry link while the inquiry feature is off", () => {
    state.config = { groupInquiryEnabled: false };
    const html = renderToStaticMarkup(createElement(PeopleListPage, { people: [] }));
    expect(text(html)).toContain("いま紹介できる人を準備しています");
    expect(hrefs(html).some((href) => href.startsWith("/ja/inquiry"))).toBe(false);
  });
});

describe("a person's page", () => {
  it("shows who they are, the inquiry button with the person chosen, and their experiences", () => {
    const html = renderToStaticMarkup(createElement(PersonPage, { person: person("a-san", { experienceSlugs: ["tea"] }), experiences: [experience("tea", "合成のお茶の体験")] }));
    const words = text(html);
    expect(words).toContain("街の人 / 合成 a-san");
    expect(words).toContain("合成の職人・合成の町");
    expect(words).toContain("「合成のひとこと」");
    expect(words).toContain("一行目 二行目");
    expect(words).toContain("写真：合成の撮影者");
    expect(words).toContain("合成 a-sanさんに相談する");
    const links = hrefs(html);
    expect(links.some((href) => href.startsWith("/ja/inquiry?") && href.includes("from=provider") && decodeURIComponent(href.replaceAll("+", " ")).includes("host=合成 a-san"))).toBe(true);
    expect(links).toContain("/ja/experiences/tea");
    expect(words).toContain("合成のお茶の体験");
    expect(words).toContain("1時間30分・1名 4,000円");
  });

  it("leaves out what is not there: no experiences section, no quote, no introduction, no inquiry button while the feature is off", () => {
    state.config = { groupInquiryEnabled: false };
    const html = renderToStaticMarkup(createElement(PersonPage, { person: person("c-san", { quoteJa: null, introJa: null, photo: { src: "/x", altJa: "写真", credit: null } }), experiences: [] }));
    const words = text(html);
    expect(words).not.toContain("と過ごす");
    expect(words).not.toContain("「");
    expect(words).not.toContain("写真：");
    expect(words).not.toContain("に相談する");
  });
});
