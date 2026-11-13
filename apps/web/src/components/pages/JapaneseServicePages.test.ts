import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { groupInquiryEnabled: true, groupInquiryPreviewEnabled: false, hostPilotContactUrl: "" } as Record<string, unknown>,
  entry: null as null | { loginHref: string },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/Analytics", () => ({ TrackedLink: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never), TrackView: () => null }));
vi.mock("@/components/pages/HostPageContent", () => ({ hostConsoleEntry: async () => state.entry, japaneseHostMetadata: async () => ({}) }));

import { InquiryPage } from "./InquiryPage";
import { JapaneseHostPage } from "./JapaneseHostPage";
import { UsagePage } from "./UsagePage";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

beforeEach(() => { state.config = { groupInquiryEnabled: true, groupInquiryPreviewEnabled: false, hostPilotContactUrl: "" }; state.entry = null; });

describe("ご利用の案内", () => {
  it("has a column for guests and one for hosts, with the four points each", () => {
    const words = text(renderToStaticMarkup(createElement(UsagePage)));
    expect(words).toContain("参加する方へ");
    expect(words).toContain("体験を提供する方へ");
    for (const title of ["取消について", "実施できないとき", "天気について", "連絡とお支払い", "申込みは断れます", "手取りは、一緒に決めます"]) expect(words).toContain(title);
    expect(words).toContain("無料で取消できる期限は、体験ごとに違います");
  });
});

describe("体験を載せる (/ja/host)", () => {
  const render = async () => renderToStaticMarkup(await JapaneseHostPage({ searchParams: Promise.resolve({}) }));

  it("opens the inquiry form as 体験を載せたい from 「まず話してみる」, shows the three plans with their rates and what each side does", async () => {
    const html = await render();
    const words = text(html);
    expect(words).toContain("あなたの体験を、街の外の人へ。");
    expect(hrefs(html)).toContain("/ja/inquiry?type=listing&from=listing");
    for (const plan of ["おまかせ 20%", "サポート 15%", "自分で販売 10%"]) expect(words.replace(/\s+/g, " ")).toContain(plan.replace(" ", " "));
    expect(words).toContain("あなた");
    expect(words).toContain("事務局");
    expect(words).toContain("載せるまで");
    expect(words).toContain("申込みを断ることはできますか");
    expect(words).toContain("入金はいつですか");
  });

  it("shows the host login only when the console has a login to offer, and falls back to the pilot contact link without the inquiry feature", async () => {
    expect(text(await render())).not.toContain("ホスト画面にログイン");
    state.entry = { loginHref: "/host/login" };
    const withLogin = await render();
    expect(hrefs(withLogin)).toContain("/host/login");
    expect(text(withLogin)).toContain("ホスト画面にログイン");
    state.config = { groupInquiryEnabled: false, hostPilotContactUrl: "https://contact.example/host" };
    expect(hrefs(await render())).toContain("https://contact.example/host");
    state.config = { groupInquiryEnabled: false, hostPilotContactUrl: "" };
    expect(text(await render())).not.toContain("まず話してみる");
  });
});

describe("相談のページ (/ja/inquiry)", () => {
  const page = (search: Record<string, string>, locale: "ja" | "en" = "ja") => renderToStaticMarkup(createElement(InquiryPage, { locale, search }));

  it("explains what can be asked, how it goes and what it costs before the form, when opened without any entry context", () => {
    const words = text(page({}));
    expect(words).toContain("載っていないことも、相談できます。");
    expect(words).toContain("たとえば、こんな相談");
    expect(words).toContain("進め方");
    expect(words).toContain("料金の考え方");
    expect(words).toContain("企画と調整");
    expect(words).toContain("相談を送る");
    expect(page({})).toContain('id="ask"');
  });

  it("goes straight to the form when it was opened from a school, company, person or experience, and in English", () => {
    for (const search of [{ type: "school", from: "school" }, { from: "provider", host: "合成 花子" }, { from: "experience", experience: "synthetic-tea" }] as Record<string, string>[]) {
      expect(text(page(search)), JSON.stringify(search)).not.toContain("たとえば、こんな相談");
    }
    expect(text(page({}, "en"))).not.toContain("たとえば、こんな相談");
  });
});
