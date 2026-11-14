import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";
import { SiteLocaleProvider } from "../SiteLocale";
import { JAPANESE_SITE_DESCRIPTION, JapaneseSiteChrome } from "./JapaneseSiteChrome";

const render = (props: { hostSignedIn?: boolean; inquiryOpen?: boolean; guidesOpen?: boolean }) => renderToStaticMarkup(createElement(
  SiteLocaleProvider,
  { locale: "ja", releaseId: "r", values: defaultStaticCopyValuesV1() } as never,
  createElement(JapaneseSiteChrome, { counterparts: { "/": "/ja" }, hostSignedIn: props.hostSignedIn ?? false, inquiryOpen: props.inquiryOpen ?? true, guidesOpen: props.guidesOpen ?? false } as never, "BODY"),
));

/** ヘッダーのナビの項目（li）：class と中身。 */
const navItems = (html: string) => [...html.slice(html.indexOf('<nav aria-label="メイン"'), html.indexOf("</nav>")).matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((match) => ({ cls: (match[1] ?? "").match(/class="([^"]*)"/)?.[1] ?? "", html: match[2] ?? "" }));
const hrefOf = (html: string) => html.match(/href="([^"]*)"/)?.[1] ?? null;

describe("日本語サイトのヘッダーとフッター（#562、#612）", () => {
  it("ヘッダーは1行：ロゴ・ナビ・言語のボタン。上に言語だけの行は無い", () => {
    const html = render({});
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toContain("bg-sand\"><div class=\"container-page flex justify-end");
    for (const text of ["体験を", "さがす", "企業・学校", "相談", "ホストになる"]) expect(html).toContain(text);
    expect(html).toContain('href="/ja/experiences"');
    expect(html).toContain('href="/ja/business"');
    expect(html).toContain('href="/ja/inquiry"');
    expect(html).toContain('href="/ja/host"');
    expect(html).toContain(">EN<");
    // 古い言い方は残さない
    for (const old of ["法人・学校", "ホストの方", "相談する"]) expect(html).not.toContain(old);
    // 右端は押せないものではなく、言語を切り替えるボタン
    expect(html).not.toContain("日本語 · ¥");
  });

  it("PC 幅：左に体験をさがす（と読みもの）、右端に企業・学校とホストになる（文字だけ）と EN。相談は PC 幅のナビに無い", () => {
    const items = navItems(render({ guidesOpen: true }));
    // 左：さがす、読みもの。つぎに相談（スマホ幅だけ）、右へ寄せる空き、企業・学校、ホストになる、EN
    expect(items.slice(0, 6).map((item) => hrefOf(item.html))).toEqual(["/ja/experiences", "/ja/guides", "/ja/inquiry", null, "/ja/business", "/ja/host"]);
    const [search, guides, consult, spacer, business, host, language] = items;
    expect(search!.cls).toBe("");
    expect(guides!.cls).toBe("hidden sm:block");
    // 相談はスマホ幅だけ
    expect(consult!.cls).toBe("sm:hidden");
    expect(spacer!.html).toBe("");
    expect(spacer!.cls).toBe("hidden sm:block sm:flex-1");
    expect(business!.cls).toBe("hidden sm:block");
    expect(host!.cls).toBe("hidden sm:block");
    expect(business!.html).toContain("企業・学校");
    expect(host!.html).toContain("ホストになる");
    // 右端の2つは文字だけの控えめなリンク（背景の丸は付けない）
    for (const quiet of [business!, host!]) expect(quiet.html).toContain("text-ink-soft");
    expect(language!.html).toContain("EN");
  });

  it("スマホ幅では「さがす」「相談」と言語のボタンだけ（ほかは sm 以上）", () => {
    const items = navItems(render({ guidesOpen: true }));
    const visibleOnPhone = items.filter((item) => !/(^| )hidden( |$)/.test(item.cls)).map((item) => item.html);
    expect(visibleOnPhone).toHaveLength(3);
    expect(visibleOnPhone[0]).toContain("さがす");
    expect(visibleOnPhone[1]).toContain("相談");
    expect(visibleOnPhone[2]).toContain("EN");
    expect(render({}).includes("max-sm:hidden")).toBe(true);
  });

  it("街の人は、ヘッダーにもフッターにも出さない（人物ページを止めている、#612）。まだ無いページ（カテゴリー）へのリンクも出さない", () => {
    const html = render({});
    expect(html).not.toContain("/ja/people");
    expect(html).not.toContain("街の人");
    for (const path of ["/ja/promise", "/ja/guide"]) expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain("読みもの");
  });

  it("読みものは、公開中の記事があるときだけ、ヘッダー（スマホ幅では出さない）とフッターに出る", () => {
    const html = render({ guidesOpen: true });
    expect(html).toMatch(/<li class="hidden sm:block"><a[^>]*href="\/ja\/guides"[^>]*>読みもの<\/a><\/li>/);
    expect(html.match(/href="\/ja\/guides"/g)).toHaveLength(2);
    expect(render({ guidesOpen: false })).not.toContain("/ja/guides");
  });

  it("相談の flag が閉じているときは相談・企業・学校を出さない", () => {
    const html = render({ inquiryOpen: false });
    expect(html).not.toContain('href="/ja/inquiry"');
    expect(html).not.toContain('href="/ja/business"');
    expect(html).not.toContain('href="/ja/schools"');
    expect(html).toContain('href="/ja/host"');
  });

  it("ホストとしてログインしている人には「ホストになる」の代わりに「ホスト画面」", () => {
    const html = render({ hostSignedIn: true });
    expect(html).toContain('href="/host/home"');
    expect(html).toContain("ホスト画面");
    expect(navItems(html).some((item) => item.html.includes("ホストになる"))).toBe(false);
  });

  it("フッターは運営の一文と、2列のリンク（企業・学校の方へ・ホストになる・ホストログイン・English・プライバシー）", () => {
    const html = render({});
    expect(JAPANESE_SITE_DESCRIPTION).toBe("運営：NIHO kamakura（鎌倉駅西口から歩いて2分）");
    expect(html).toContain("NIHO Experience 鎌倉");
    expect(html).toContain(JAPANESE_SITE_DESCRIPTION);
    // 以前の説明文は残さない
    expect(html).not.toContain("会いにいくための予約窓口です");
    expect(html).toContain("grid grid-cols-2");
    for (const text of ["ご相談", "企業・学校の方へ", "ホストになる", "ホストログイン", "English", "プライバシー"]) expect(html).toContain(text);
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
