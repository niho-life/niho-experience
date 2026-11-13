import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";
import { SiteLocaleProvider } from "../SiteLocale";
import { JAPANESE_SITE_DESCRIPTION, JapaneseSiteChrome } from "./JapaneseSiteChrome";

const render = (props: { hostSignedIn?: boolean; inquiryOpen?: boolean }) => renderToStaticMarkup(createElement(
  SiteLocaleProvider,
  { locale: "ja", releaseId: "r", values: defaultStaticCopyValuesV1() } as never,
  createElement(JapaneseSiteChrome, { counterparts: { "/": "/ja" }, hostSignedIn: props.hostSignedIn ?? false, inquiryOpen: props.inquiryOpen ?? true } as never, "BODY"),
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
    // 法人・学校とホストの方が sm 以上、ほか（さがす・相談・言語）は常に見える
    expect(items).toHaveLength(2);
    expect(html).toContain("max-sm:hidden");
  });

  it("まだ無いページ（街の人・読みもの・ご利用の案内・カテゴリー）へのリンクを出さない", () => {
    const html = render({});
    for (const path of ["/ja/people", "/ja/guides", "/ja/promise", "/ja/guide"]) expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain("街の人");
    expect(html).not.toContain("読みもの");
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
});
