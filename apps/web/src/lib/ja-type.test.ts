import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* 日本語サイトの見出しの書体 (#612): 丸ゴシックは /ja だけ。英語のサイトの書体は変えない。 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("日本語サイトの見出しの書体", () => {
  const css = read("../app/(ja)/ja/ja-type.css");
  const jaLayout = read("../app/(ja)/ja/layout.tsx");

  it("見出しの書体は、英字が Nunito・日本語が Zen Maru Gothic で、/ja（html[lang=ja]）だけに効く", () => {
    expect(css).toMatch(/--font-display:\s*"Nunito Variable",\s*"Zen Maru Gothic"/);
    // 部品は自分のルートにトークンを置くので、そこにも
    expect(css).toContain('html[lang="ja"] .nexp-v1');
    expect(css).toContain('html[lang="ja"] h1');
    // 英語側の書体（Fraunces）をここで足したり戻したりしない
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("Fraunces");
    // utilities（leading-*・tracking-*）に勝たないよう base の層に置く
    expect(css).toContain("@layer base");
  });

  it("日本語の layout が Zen Maru Gothic の 700（unicode-range で分割）と上のスタイルを、部品のスタイルのあとに読む。500 は読まない", () => {
    expect(jaLayout).toContain('import "@fontsource/zen-maru-gothic/700.css"');
    expect(jaLayout).not.toContain("zen-maru-gothic/500.css");
    expect(jaLayout).toContain('import "./ja-type.css"');
    expect(jaLayout.indexOf('presentation/v1/styles.css')).toBeLessThan(jaLayout.indexOf("ja-type.css"));
    // 本文の書体・手書きの書体は触らない
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toContain("--font-sans");
    expect(rules).not.toContain("--font-hand");
  });

  it("英語のサイトの layout は丸ゴシックを読まない", () => {
    const siteLayout = read("../app/(site)/layout.tsx");
    expect(siteLayout).not.toContain("zen-maru-gothic");
    expect(siteLayout).not.toContain("ja-type.css");
  });

  it("700 の分割ファイル（unicode-range つきの数十個）がある", () => {
    const pkg = JSON.parse(read("../../package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@fontsource/zen-maru-gothic"]).toBeDefined();
    const slices = read("../../../../node_modules/@fontsource/zen-maru-gothic/700.css");
    expect(slices).toContain("unicode-range");
    expect((slices.match(/@font-face/g) ?? []).length).toBeGreaterThan(50);
  });
});
