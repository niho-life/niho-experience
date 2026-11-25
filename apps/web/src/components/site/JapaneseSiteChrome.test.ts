import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";
import { SiteLocaleProvider } from "../SiteLocale";
import { CodeSiteChrome, JAPANESE_SITE_DESCRIPTION, SiteHeader } from "../SiteChrome";
import { siteNav } from "@/lib/site-nav";
import { EXPERIENCE_CATEGORIES } from "@niho-experience/experience-domain";
import { categoryLabel } from "@/lib/experience-categories";
import { LanguageButton } from "./LanguageButton";

const render = (props: { hostSignedIn?: boolean; inquiryOpen?: boolean; guidesOpen?: boolean }) => {
  const hostSignedIn = props.hostSignedIn ?? false;
  const inquiryOpen = props.inquiryOpen ?? true;
  const guidesOpen = props.guidesOpen ?? false;
  const counterparts = { "/": "/ja" };
  const header = createElement(SiteHeader, {
    navLabel: "メイン", menuLabel: "メニュー", entries: siteNav("ja", { guides: guidesOpen, inquiry: inquiryOpen }),
    languageSwitch: createElement(LanguageButton, { counterparts }), menuLanguage: createElement(LanguageButton, { counterparts, variant: "text" }),
    foot: hostSignedIn ? { href: "/host/home", label: "ホスト画面" } : { href: "/ja/host", label: "ホストになる" },
    rowEnd: hostSignedIn ? createElement("a", { href: "/host/home", className: "max-lg:hidden" }, "ホスト画面") : null,
  } as never);
  const footerLinks = [
    { href: "/ja/about", label: "NIHOについて" },
    ...(guidesOpen ? [{ href: "/ja/guides", label: "読みもの" }] : []),
    ...(inquiryOpen ? [{ href: "/ja/inquiry", label: "ご相談" }, { href: "/ja/business", label: "企業・学校の方へ" }] : []),
    { href: "/host/auth/sign-in", label: "ホストログイン" },
  ];
  return renderToStaticMarkup(createElement(
    SiteLocaleProvider,
    { locale: "ja", releaseId: "r", values: defaultStaticCopyValuesV1() } as never,
    createElement(CodeSiteChrome, {
      locale: "ja", header, footerBrandLabel: "NIHO Travel 鎌倉", footerDescription: JAPANESE_SITE_DESCRIPTION, footerLinks,
      footerFixedLinks: [{ href: "/ja/experiences", label: "すべての体験" }, { href: "/ja/host", label: "ホストになる" }, { href: "/ja/help", label: "予約のヘルプ" }],
      footerCategoryLinks: EXPERIENCE_CATEGORIES.map(({ id }) => ({ href: `/ja/experiences?category=${id}`, label: categoryLabel(id, "ja") })),
      categoryNavigationLabel: "カテゴリー", footerNavigationLabel: "フッター",
      footerExtras: [createElement(LanguageButton, { key: "language", counterparts, variant: "text" }), createElement("a", { key: "privacy", href: "/privacy" }, "プライバシー")],
    } as never, "BODY"),
  ));
};

/** ヘッダーのナビの項目（li）：class と中身。 */
const navItems = (html: string) => [...html.slice(html.indexOf('<nav aria-label="メイン"'), html.indexOf("</nav>")).matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((match) => ({ cls: (match[1] ?? "").match(/class="([^"]*)"/)?.[1] ?? "", html: match[2] ?? "" }));
const hrefOf = (html: string) => html.match(/href="([^"]*)"/)?.[1] ?? null;

/** メニュー（<details>）の中の項目：href と文言。 */
const menuRows = (html: string) => {
  const menu = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
  return [...menu.slice(menu.indexOf('<nav aria-label="メニュー"')).matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((match) => ({ cls: (match[1] ?? "").match(/class="([^"]*)"/)?.[1] ?? "", html: match[2] ?? "", text: (match[2] ?? "").replace(/<[^>]*>/g, "") }));
};
/** ヘッダーのうち、メニューより前（ロゴ・ナビ・言語のボタン）。 */
const headerRow = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("<details"));

describe("日本語サイトのヘッダーとフッター（#562、#612、#658）", () => {
  it("ヘッダーは1行：ロゴ・ナビ・言語のボタン・メニュー。上に言語だけの行は無い", () => {
    const html = render({});
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toContain("bg-sand\"><div class=\"container-page flex justify-end");
    for (const text of ["体験を", "さがす", "企業・学校", "NIHOについて", "ヘルプ"]) expect(headerRow(html)).toContain(text);
    expect(html).toContain('href="/ja/experiences"');
    expect(html).toContain('href="/ja/business"');
    expect(html).toContain('href="/ja/about"');
    expect(html).toContain('href="/ja/help"');
    expect(html).toContain(">EN<");
    // 古い言い方は残さない
    for (const old of ["法人・学校", "ホストの方", "相談する"]) expect(html).not.toContain(old);
    expect(html).not.toContain("日本語 · ¥");
  });

  it("ナビの順番と class：体験をさがす、読みもの、NIHOについて、企業・学校、ヘルプ（2つ目以降は max-md:hidden）", () => {
    const items = navItems(render({ guidesOpen: true }));
    expect(items.map((item) => hrefOf(item.html))).toEqual(["/ja/experiences", "/ja/guides", "/ja/about", "/ja/business", "/ja/help"]);
    expect(items[0]!.cls).toBe("");
    for (const item of items.slice(1)) expect(item.cls).toBe("max-md:hidden");
    // 1つ目は、lg 未満では短い「さがす」、lg 以上では「体験をさがす」
    expect(items[0]!.html).toContain('<span class="lg:hidden">さがす</span><span class="max-lg:hidden">体験をさがす</span>');
    expect(items[0]!.html).toContain("rounded-full px-2.5 py-2 whitespace-nowrap hover:bg-sand md:px-3");
    expect(items.slice(1).map((item) => item.html.replace(/<[^>]*>/g, ""))).toEqual(["読みもの", "NIHOについて", "企業・学校", "ヘルプ"]);
  });

  it("スマホ幅の行に残るのは「さがす」だけ。言語のボタンは行の外（max-[359px]:hidden）", () => {
    const html = render({ guidesOpen: true, hostSignedIn: true });
    const items = navItems(html);
    const visibleOnPhone = items.filter((item) => !/(^| )max-(md|lg):hidden( |$)/.test(item.cls));
    expect(visibleOnPhone).toHaveLength(1);
    expect(visibleOnPhone[0]!.html).toContain("さがす");
    expect(html).toContain("max-[359px]:hidden");
  });

  it("ヘッダーの行に「ホストになる」と「相談」は無い（メニューとフッターにある）", () => {
    const row = headerRow(render({}));
    expect(row).not.toContain("ホストになる");
    expect(row).not.toContain("相談");
    expect(row).not.toContain('href="/ja/host"');
    expect(row).not.toContain('href="/ja/inquiry"');
  });

  it("メニュー（details、aria-label=メニュー）の中身と順番", () => {
    const html = render({ guidesOpen: true });
    expect(html).toContain('aria-label="メニュー"');
    expect(html).toContain('<details class="md:hidden"');
    const rows = menuRows(html);
    expect(rows.map((row) => row.text)).toEqual(["体験をさがす", "読みもの", "NIHOについて", "企業・学校の方へ", "ご相談", "ヘルプ", "English", "ホストになる"]);
    expect(rows.map((row) => hrefOf(row.html))).toEqual(["/ja/experiences", "/ja/guides", "/ja/about", "/ja/business", "/ja/inquiry", "/ja/help", "/", "/ja/host"]);
    expect(rows[6]!.cls).toContain("empty:hidden");
    expect(rows[7]!.html).toContain("text-ink-soft");
  });

  it("メニューの出し分け：読みものは記事があるときだけ、相談の flag が閉じていれば企業・学校・ご相談を出さない、ホストとしてログイン中は「ホスト画面」", () => {
    const closed = menuRows(render({ inquiryOpen: false })).map((row) => row.text);
    expect(closed).toEqual(["体験をさがす", "NIHOについて", "ヘルプ", "English", "ホストになる"]);
    const signedIn = menuRows(render({ hostSignedIn: true }));
    expect(signedIn.at(-1)!.text).toBe("ホスト画面");
    expect(hrefOf(signedIn.at(-1)!.html)).toBe("/host/home");
    expect(signedIn.some((row) => row.text === "ホストになる")).toBe(false);
  });

  it("街の人は、ヘッダー・メニュー・フッターのどこにも出さない（人物ページを止めている、#612）。まだ無いページへのリンクも出さない", () => {
    const html = render({});
    expect(html).not.toContain("/ja/people");
    expect(html).not.toContain("街の人");
    for (const path of ["/ja/promise", "/ja/guide"]) expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain("読みもの");
  });

  it("読みものは、公開中の記事があるときだけ、ヘッダー（md 未満では行に出さずメニューへ）とフッターに出る", () => {
    const html = render({ guidesOpen: true });
    expect(html).toMatch(/<li class="max-md:hidden"><a[^>]*href="\/ja\/guides"[^>]*>読みもの<\/a><\/li>/);
    expect(html.match(/href="\/ja\/guides"/g)).toHaveLength(3);
    expect(render({ guidesOpen: false })).not.toContain("/ja/guides");
  });

  it("相談の flag が閉じているときは相談・企業・学校を出さない", () => {
    const html = render({ inquiryOpen: false });
    expect(html).not.toContain('href="/ja/inquiry"');
    expect(html).not.toContain('href="/ja/business"');
    expect(html).not.toContain('href="/ja/schools"');
    expect(html).toContain('href="/ja/host"');
  });

  it("ホストとしてログインしている人には、ヘッダーの行に「ホスト画面」（lg 以上。md では5つのタブで幅がいっぱい）。「ホストになる」はどこにも出ない", () => {
    const html = render({ hostSignedIn: true });
    expect(html).toContain('href="/host/home"');
    const hostItem = navItems(html).find((item) => item.html.includes("ホスト画面"));
    expect(hostItem?.cls).toBe("max-lg:hidden");
    expect(hrefOf(hostItem!.html)).toBe("/host/home");
    expect(headerRow(html)).not.toContain("ホストになる");
    expect(html.slice(0, html.indexOf("<footer"))).not.toContain("ホストになる");
  });

  it("フッターは運営の一文と、2列のリンク（NIHOについて・企業・学校の方へ・ホストになる・ホストログイン・English・プライバシー）", () => {
    const html = render({});
    expect(JAPANESE_SITE_DESCRIPTION).toBe("運営：NIHO kamakura（鎌倉駅西口から歩いて2分）");
    expect(html).toContain("NIHO Travel 鎌倉");
    expect(html).toContain("Travel</span>");
    expect(html).not.toContain("Experience 鎌倉");
    expect(html).toContain(JAPANESE_SITE_DESCRIPTION);
    // 以前の説明文は残さない
    expect(html).not.toContain("会いにいくための予約窓口です");
    expect(html).toContain("grid grid-cols-2");
    const footer = html.slice(html.indexOf("<footer"));
    for (const text of ["NIHOについて", "ご相談", "企業・学校の方へ", "ホストになる", "ホストログイン", "English", "プライバシー"]) expect(footer).toContain(text);
    expect(footer).toContain('href="/ja/about"');
    for (const old of ["法人・団体の方へ", "体験を載せる", "個別の相談"]) expect(html).not.toContain(old);
    expect(html).not.toContain('href="/ja/schools"');
    expect(html).toContain('href="/host/auth/sign-in"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("<main");
    expect(html).toContain("BODY");
  });

  it("フッターにカテゴリーのまとまり（8つ、一覧の ?category= へ）がある", () => {
    const html = render({});
    for (const [id, label] of [["walk", "歩く"], ["food", "つくる・食べる"], ["craft", "手を動かす"], ["zen", "禅と寺"], ["time", "朝と夜"], ["sea", "海"], ["people", "人に会う"], ["group", "団体・チームで"]]) {
      expect(html).toContain(`href="/ja/experiences?category=${id}"`);
      expect(html).toContain(label);
    }
  });
});
