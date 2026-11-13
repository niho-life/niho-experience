import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { SiteHeader } from "./SiteChrome";
import { LanguageButton } from "./site/LanguageButton";

describe("English header (#562)", () => {
  it("puts the language button at the right end instead of the row above, and keeps the rest", () => {
    const html = renderToStaticMarkup(SiteHeader({ languageSwitch: createElement(LanguageButton, { counterparts: { "/": "/ja" } }) }));
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toContain("justify-end py-1.5");
    expect(html).toContain('href="/ja"');
    expect(html).toContain(">日本語<");
    expect(html).toContain("Experiences");
    expect(html).toContain('href="/host"');
    expect(html).toContain('href="/help"');
    expect(html).not.toContain("EN · ¥");
  });

  it("keeps the EN · ¥ pill where there is no Japanese site", () => {
    const html = renderToStaticMarkup(SiteHeader());
    expect(html).toContain("EN · ¥");
    expect(html).not.toContain("日本語");
  });
});
