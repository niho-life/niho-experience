import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

import { siteNavigation } from "@/lib/site-nav";
import { SiteMenu } from "./SiteMenu";

describe("SiteMenu (#672)", () => {
  it("labels the native trigger and shows the navigation groups in order", () => {
    const html = renderToStaticMarkup(createElement(SiteMenu, {
      navigation: siteNavigation("en", { guides: true, categories: ["food"] }).mobile,
      language: createElement("a", { href: "/ja" }, "日本語"),
    }));
    expect(html).toContain('role="button" aria-label="Menu" aria-expanded="false" aria-controls="site-menu-panel"');
    expect([...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual(["Explore", "Plan your visit", "For hosts", "Language"]);
    expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "/experiences", "/experiences?category=food", "/about", "/help", "/help#find-booking", "/guides", "/host", "/host/auth/sign-in", "/ja",
    ]);
  });

  it("leaves the language group out when it has no choice to offer", () => {
    const html = renderToStaticMarkup(createElement(SiteMenu, { navigation: siteNavigation("en").mobile }));
    expect(html).not.toContain(">Language<");
  });
});
