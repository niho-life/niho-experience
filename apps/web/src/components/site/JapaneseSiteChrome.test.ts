import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/ja/experiences", useSearchParams: () => new URLSearchParams("category=walk&private=drop") }));
vi.mock("next/image", () => ({ default: () => null }));

import { localJapaneseCopy } from "@/lib/ja-static-copy";
import { siteNavigation } from "@/lib/site-nav";
import { SiteLocaleProvider } from "../SiteLocale";
import { CodeSiteChrome } from "../SiteChrome";
import { LanguageButton } from "./LanguageButton";

const counterparts = { "/experiences": "/ja/experiences" };
const render = ({ signedIn = false, inquiry = true, guides = false } = {}) => {
  const copy = localJapaneseCopy();
  return renderToStaticMarkup(createElement(
    SiteLocaleProvider,
    { locale: "ja", releaseId: "r", values: copy.values } as never,
    createElement(CodeSiteChrome, {
      locale: "ja", copy, signedIn,
      navigation: siteNavigation("ja", { signedIn, inquiry, guides, categories: ["walk", "food"] }),
      languageSwitch: createElement(LanguageButton, { counterparts }),
      languageChoices: createElement(LanguageButton, { counterparts, variant: "choices" }),
    }, "BODY"),
  ));
};
const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("<details"));
const menu = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>"));
const footer = (html: string) => html.slice(html.indexOf("<footer"));

describe("日本語サイトの共通ヘッダーとフッター（#672）", () => {
  it("デスクトップで「ホストの方」を言語切替の左に表示する", () => {
    const row = header(render());
    expect(row).toContain(">はじめての方へ<");
    expect(row).toContain('href="/ja/about"');
    expect(row).toMatch(/<li class="max-md:hidden"><a[^>]*href="\/ja\/host"[^>]*>ホストの方<\/a><\/li>/);
    const languageLink = row.indexOf('href="/experiences?category=walk');
    expect(languageLink).toBeGreaterThan(-1);
    expect(row.indexOf('href="/ja/host"')).toBeLessThan(languageLink);
  });

  it("メニューは5つの見出しと日英切替があり、ホスト登録とログインを並べる", () => {
    const html = menu(render({ guides: true }));
    expect(headings(html)).toEqual(["体験をさがす", "ご利用ガイド", "団体・ご相談", "ホストの方", "言語"]);
    for (const href of ["/ja/experiences", "/ja/experiences?category=walk", "/ja/help#find-booking", "/ja/guides", "/ja/business", "/ja/inquiry", "/ja/host", "/host/auth/login", "/experiences?category=walk"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("日本語");
    expect(html).toContain("English");
    expect(html).not.toContain("private=drop");
    expect(html).not.toContain("category=sea");
  });

  it("公開条件とホストのログイン状態を共有する", () => {
    const closed = render({ inquiry: false, signedIn: true });
    expect(closed).not.toMatch(/href="\/ja\/(business|inquiry|guides)"/);
    expect(header(closed)).toMatch(/<li class="max-lg:hidden"><a[^>]*href="\/host\/home"/);
    expect(menu(closed)).toContain('href="/host/home"');
    expect(menu(closed)).not.toContain('href="/ja/host"');
    expect(render({ guides: true }).match(/href="\/ja\/guides"/g)).toHaveLength(3);
  });

  it("フッターはロゴ、掲載中のカテゴリ、4つのリンク群と最下段を表示する", () => {
    const html = footer(render());
    expect(headings(html)).toEqual(["体験をさがす", "ご利用ガイド", "団体・ご相談", "ホストの方"]);
    expect(html).toContain("grid grid-cols-2");
    expect(html).toContain("NIHO Travel");
    expect(html).toContain("運営：NIHO kamakura");
    expect(html).toContain("© NIHO kamakura");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("日本語");
    expect(html).toContain("English");
    expect(html).toContain('href="/ja/experiences?category=food"');
    expect(html).not.toContain('href="/ja/experiences?category=sea"');
    expect(html).not.toContain('href="/write"');
    expect(html).not.toContain('role="note"');
  });
});
