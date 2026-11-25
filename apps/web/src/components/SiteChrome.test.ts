import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { SITE_FOOTER_DESCRIPTION } from "@/lib/public-metadata";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import { LanguageButton } from "./site/LanguageButton";

describe("English header (#562)", () => {
  it("puts the language button at the right end instead of the row above, and keeps the rest", () => {
    const html = renderToStaticMarkup(SiteHeader({ languageSwitch: createElement(LanguageButton, { counterparts: { "/": "/ja" } }) }));
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toContain("justify-end py-1.5");
    expect(html).toContain('href="/ja"');
    expect(html).toContain(">日本語<");
    expect(html).toContain("Experiences");
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/help"');
    expect(html).not.toContain("EN · ¥");
  });

  it("keeps the EN · ¥ pill where there is no Japanese site", () => {
    const html = renderToStaticMarkup(SiteHeader());
    expect(html).toContain("EN · ¥");
    expect(html).not.toContain("日本語");
  });

  it("lists Experiences, About and Help in the row, and Journal only when the guides page exists (#645)", () => {
    const nav = (html: string) => /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const without = nav(renderToStaticMarkup(SiteHeader()));
    expect([...without.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/experiences", "/about", "/help"]);
    const withJournal = nav(renderToStaticMarkup(SiteHeader({ journalHref: "/guides" })));
    expect([...withJournal.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/experiences", "/guides", "/about", "/help"]);
    expect(withJournal).toContain(">Journal<");
  });

  it("has no host link in the row; the menu's last item is the quiet host link", () => {
    const html = renderToStaticMarkup(SiteHeader({ journalHref: "/guides", menuLanguage: createElement(LanguageButton, { counterparts: { "/": "/ja" }, variant: "text" }) }));
    const row = /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(row).not.toContain("/host");
    expect(row).not.toContain("Host with NIHO");
    const menu = /<details[\s\S]*<\/details>/.exec(html)?.[0] ?? "";
    expect(menu).toContain('aria-label="Menu"');
    expect(menu).toContain('role="button" aria-label="Menu" aria-expanded="false" aria-controls="site-menu-panel"');
    const hrefs = [...menu.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/experiences", "/guides", "/about", "/help", "/ja", "/host"]);
    expect(menu).toContain(">For hosts<");
  });

  it("uses the longer footer line made by NIHO", () => {
    expect(SITE_FOOTER_DESCRIPTION).toContain("Made by NIHO, the town's living room, two minutes from Kamakura Station.");
    expect(renderToStaticMarkup(SiteFooter())).toContain("two minutes from Kamakura Station");
  });
});
