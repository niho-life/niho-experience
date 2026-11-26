import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { siteNavigation } from "@/lib/site-nav";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import { LanguageButton } from "./site/LanguageButton";

describe("English site chrome (#672)", () => {
  it("puts the desktop host entrance before the language switch", () => {
    const html = renderToStaticMarkup(SiteHeader({ languageSwitch: createElement(LanguageButton, { counterparts: { "/": "/ja" } }) }));
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="max-md:hidden"><a[^>]*href="\/host"[^>]*>For hosts<\/a><\/li>/);
    expect(html.indexOf('href="/host"')).toBeLessThan(html.indexOf('href="/ja"'));
    expect(html).toContain(">日本語<");
    expect(html).not.toContain("EN · ¥");
  });

  it("keeps the EN · ¥ pill where there is no Japanese site", () => {
    const html = renderToStaticMarkup(SiteHeader());
    expect(html).toContain("EN · ¥");
    expect(html).not.toContain("日本語");
  });

  it("adds the journal tab while a journal exists", () => {
    const nav = (html: string) => /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const without = nav(renderToStaticMarkup(SiteHeader()));
    expect([...without.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/experiences", "/about", "/help", "/host"]);
    const withJournal = nav(renderToStaticMarkup(SiteHeader({ navigation: siteNavigation("en", { guides: true }) })));
    expect([...withJournal.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/experiences", "/guides", "/about", "/help", "/host"]);
    expect(withJournal).toContain(">Journal<");
  });

  it("uses the same resource groups in the footer with normal weight links", () => {
    const html = renderToStaticMarkup(SiteFooter({ groups: siteNavigation("en", { categories: ["food"], guides: true }).footer, preview: "synthetic" }));
    expect(html).toContain("two minutes from Kamakura Station");
    expect(html).toContain('role="note"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("font-normal");
    expect([...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual(["Explore", "Plan your visit", "For hosts"]);
    expect([...html.matchAll(/href="(\/experiences[^"]*)"/g)].map((m) => m[1])).toEqual(["/experiences", "/experiences?category=food"]);
    expect(html).toContain(">For writers<");
    expect(html).toContain(">Kamakura Journal<");
  });
});
