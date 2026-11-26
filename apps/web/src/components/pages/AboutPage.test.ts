import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/about", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { JA_ABOUT_CONTENT, JA_ABOUT_TITLE } from "@/lib/ja-about";
import { AboutPage } from "./AboutPage";

describe("About page (#645)", () => {
  const html = renderToStaticMarkup(AboutPage());

  it("has one h1 and h2 headings after it", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("It starts in the town");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<h2"));
  });

  it("shows the three captions and the booking steps", () => {
    for (const line of ["Each one hosted by people who live here.", "Everyday life and culture, not sightseeing.", "Small enough for one table and real conversation."]) expect(html).toContain(line);
    expect(html.match(/<li class="flex items-start gap-4 rounded-\[22px\]/g)).toHaveLength(3);
  });

  it("links to the experiences, the help page and hosting", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(["/experiences", "/help", "/host"]));
    expect(html).toContain("See the experiences");
    expect(html).toContain("Live in Kamakura?");
  });
});

describe("日本語の About（#658）", () => {
  const html = renderToStaticMarkup(AboutPage({ content: JA_ABOUT_CONTENT }));

  it("h1 でこの予約サイトの役割を伝える", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("NIHO Travel は、鎌倉の人に会いにいく体験の予約サイトです。");
    expect(html).toContain('aria-label="NIHO Travel について"');
    for (const text of ["どの体験も、鎌倉に暮らす人が開きます。", "観光名所ではなく、暮らしと文化のなかへ。", "ひとつの食卓を囲んで話せる人数で。", "予約のしくみ", "日にちを選ぶ", "安全に支払う", "ホストに会う", "鎌倉にお住まいの方へ"]) expect(html).toContain(text);
    expect(html.match(/<li class="flex items-start gap-4 rounded-\[22px\]/g)).toHaveLength(3);
    expect(html).not.toContain("max-w-[18ch]");
    expect(html).not.toContain("font-display");
  });

  it("リンクは /ja/... のまま", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(["/ja/experiences", "/ja/help", "/ja/host"]));
    expect(hrefs.every((href) => !href!.startsWith("/ja/ja"))).toBe(true);
    expect(JA_ABOUT_TITLE).toBe("はじめての方へ");
  });
});
