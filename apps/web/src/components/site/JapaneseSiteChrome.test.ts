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

describe("日本語サイトのヘッダーとフッター（#562）", () => {
  it("ヘッダーは1行：ロゴ・ナビ・言語のボタン。上に言語だけの行は無い", () => {
    const html = render({});
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toContain("bg-sand\"><div class=\"container-page flex justify-end");
    for (const text of ["体験を", "さがす", "法人・学校", "相談", "ホストの方"]) expect(html).toContain(text);
    expect(html).toContain('href="/ja/experiences"');
    expect(html).toContain('href="/ja/business"');
    expect(html).toContain('href="/ja/inquiry"');
    expect(html).toContain('href="/ja/host"');
    expect(html).toContain(">EN<");
    // 右端は押せないものではなく、言語を切り替えるボタン
    expect(html).not.toContain("日本語 · ¥");
  });

  it("スマホ幅では「さがす」「相談」と言語のボタンだけ（ほかは sm 以上）", () => {
    const html = render({});
    const items = [...html.matchAll(/<li class="hidden sm:block">/g)];
    // 街の人・法人・学校とホストの方が sm 以上、ほか（さがす・相談・言語）は常に見える
    expect(items).toHaveLength(3);
    expect([...render({ guidesOpen: true }).matchAll(/<li class="hidden sm:block">/g)]).toHaveLength(4);
    expect(html).toContain("max-sm:hidden");
  });

  it("街の人はヘッダーとフッターに出る（スマホ幅のヘッダーでは出さない）。まだ無いページ（読みもの・カテゴリー）へのリンクは出さない", () => {
    const html = render({});
    expect(html).toMatch(/<li class="hidden sm:block"><a[^>]*href="\/ja\/people"[^>]*>街の人<\/a><\/li>/);
    expect(html.match(/href="\/ja\/people"/g)).toHaveLength(2);
    for (const path of ["/ja/guides", "/ja/promise", "/ja/guide"]) expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain("読みもの");
  });

  it("読みものは、公開中の記事があるときだけ、ヘッダー（スマホ幅では出さない）とフッターに出る", () => {
    const html = render({ guidesOpen: true });
    expect(html).toMatch(/<li class="hidden sm:block"><a[^>]*href="\/ja\/guides"[^>]*>読みもの<\/a><\/li>/);
    expect(html.match(/href="\/ja\/guides"/g)).toHaveLength(2);
    expect(render({ guidesOpen: false })).not.toContain("/ja/guides");
  });

  it("相談の flag が閉じているときは相談・法人・学校を出さない", () => {
    const html = render({ inquiryOpen: false });
    expect(html).not.toContain('href="/ja/inquiry"');
    expect(html).not.toContain('href="/ja/business"');
    expect(html).not.toContain('href="/ja/schools"');
    expect(html).toContain('href="/ja/host"');
  });

  it("ホストとしてログインしている人には「ホストの方」の代わりに「ホスト画面」", () => {
    const html = render({ hostSignedIn: true });
    expect(html).toContain('href="/host/home"');
    expect(html).toContain("ホスト画面");
    expect(html).not.toContain("ホストの方");
  });

  it("フッターは決まった説明文と、2列のリンク（体験を載せる・ホストログイン・English・プライバシー）", () => {
    const html = render({});
    expect(JAPANESE_SITE_DESCRIPTION).toBe("鎌倉周辺の人や活動に、会いにいくための予約窓口です。街のリビングNIHO kamakuraが運営しています");
    expect(html).toContain("NIHO Experience 鎌倉");
    expect(html).toContain(JAPANESE_SITE_DESCRIPTION);
    expect(html).toContain("grid grid-cols-2");
    for (const text of ["個別の相談", "法人・団体の方へ", "学校の方へ", "体験を載せる", "ホストログイン", "English", "プライバシー"]) expect(html).toContain(text);
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
