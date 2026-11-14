import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NIHO_SANS_FAMILY, NIHO_SANS_FONT_FACES } from "./niho-sans";

/*
 * 日本語の画面の書体「NIHO Sans」(#615)。NIHO アプリ（niho-app docs/design/font-style-guide.md §3.1）と同じ組み方を、
 * html[lang="ja"] の画面（/ja・/host・/write・/admin）すべてに。英語のサイトの書体は変えない。
 * 描画の結果は e2e（host-screens・write-ui・english-type）が確かめる。
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../app/globals.css");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string) => text.replace(/\s+/g, "").replace(/;$/, "");
const block = (selector: string) => {
  const start = rules.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  return rules.slice(rules.indexOf("{", start) + 1, rules.indexOf("}", start));
};
const declaration = (body: string, name: string) => squash(new RegExp(`${name}:([^;]+)`).exec(body)?.[1] ?? "");
const faces = (text: string, family: string) => [...text.matchAll(/@font-face\s*\{([^}]*)\}/g)]
  .map((match) => match[1]!)
  .filter((body) => body.includes(`"${family}"`))
  .map((body) => ({ weight: declaration(body, "font-weight"), src: declaration(body, "src") }));

describe("日本語の画面の書体（NIHO Sans）", () => {
  it("NIHO Sans は端末の書体を名前で指すだけで、細字は丸ゴ W4、600–700 は角ゴ W6、800 は W7、900 は W8", () => {
    expect(faces(rules, "NIHO Sans")).toEqual([
      { weight: "100500", src: 'local("HiraginoMaruGothicProNW4"),local("HiraMaruProN-W4")' },
      { weight: "600700", src: 'local("HiraginoSansW6"),local("HiraginoSans-W6")' },
      { weight: "800", src: 'local("HiraginoSansW7"),local("HiraginoSans-W7")' },
      { weight: "900", src: 'local("HiraginoSansW8"),local("HiraginoSans-W8")' },
    ]);
    // 日本語の Web フォントを配信しない（globals.css の @font-face はどれも local() だけ）
    for (const [, body] of rules.matchAll(/@font-face\s*\{([^}]*)\}/g)) expect(body).not.toMatch(/url\(/);
  });

  it("日本語の画面は本文も見出しも NIHO Sans。手書きの中の日本語は縮めた丸ゴ。公開サイトの部品のルートにも置く", () => {
    const ja = block('html[lang="ja"] .nexp-v1 {');
    expect(rules).toMatch(/html\[lang="ja"\],\s*html\[lang="ja"\] \.nexp-v1 \{/);
    expect(declaration(ja, "--font-sans")).toMatch(/^"NunitoVariable","NIHOSans","HiraginoMaruGothicProN"/);
    expect(declaration(ja, "--font-display")).toBe("var(--font-sans)");
    expect(declaration(ja, "--font-hand")).toBe('"CaveatVariable","NIHOHandJA","BradleyHand",cursive');
    const hand = faces(rules, "NIHO Hand JA");
    expect(hand).toHaveLength(1);
    expect(hand[0]!.src.startsWith('local("HiraginoMaruGothicProNW4")')).toBe(true);
    expect(rules).toMatch(/size-adjust:\s*\d+%/);
  });

  it("lang=\"en\" の所（ホストのプレビュー、英語の記事を書く欄）は、英語のサイトと同じ書体（@theme の値）に戻す", () => {
    const theme = block("@theme {");
    const en = block('html[lang="ja"] [lang="en"] .nexp-v1 {');
    for (const name of ["--font-sans", "--font-display", "--font-hand"]) expect(declaration(en, name), name).toBe(declaration(theme, name));
    // 英語のサイトのトークン（@theme）は丸ゴにしない
    expect(declaration(theme, "--font-display")).toMatch(/^"FrauncesVariable"/);
    expect(declaration(theme, "--font-sans")).not.toContain("NIHO");
  });

  it("utilities（leading-*・tracking-*）に勝たないよう、トークンと見出しの字間・行間は base の層に置く", () => {
    const base = rules.slice(rules.indexOf("@layer base {"));
    expect(base).toContain('html[lang="ja"],');
    expect(base).toContain('html[lang="ja"] :is(h1, h2, h3):not(:lang(en))');
  });

  it("単独のページ（招待・ログインのリンク、オフライン）のインラインの書体は globals.css と同じ", () => {
    expect(faces(NIHO_SANS_FONT_FACES, "NIHO Sans")).toEqual(faces(rules, "NIHO Sans"));
    const ja = declaration(block('html[lang="ja"] .nexp-v1 {'), "--font-sans");
    expect(`"NunitoVariable",${squash(NIHO_SANS_FAMILY)}`).toBe(ja);
    for (const path of ["../app/(host)/host/auth/invite/route.ts", "../app/(host)/host/auth/open/route.ts", "./host/service-worker.ts"]) {
      const source = read(path);
      expect(source, path).toContain("${NIHO_SANS_FONT_FACES}");
      expect(source, path).toContain("font-family:${NIHO_SANS_FAMILY}");
    }
  });

  it("どの layout も Zen Maru Gothic（#612 の見出しの Web フォント）を読まない", () => {
    for (const path of ["../app/(ja)/ja/layout.tsx", "../app/(host)/host/layout.tsx", "../app/(write)/layout.tsx", "../app/(admin)/admin/layout.tsx", "../app/(site)/layout.tsx"]) {
      const layout = read(path);
      expect(layout, path).not.toContain("zen-maru-gothic");
      expect(layout, path).toContain("globals.css");
    }
    const pkg = JSON.parse(read("../../package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@fontsource/zen-maru-gothic"]).toBeUndefined();
  });

  it("英語のプレビューと英語の記事を書く欄は lang を持つ", () => {
    expect(read("../components/host/HostExperiencePreview.tsx")).toMatch(/<div lang="en"><PresentationRootV1/);
    const editor = read("../components/write/WriteEditor.tsx");
    expect(editor).toContain('id="write-title" lang={japanese ? "ja" : "en"}');
    expect(editor).toContain('language={japanese ? "ja" : "en"}');
    expect(read("../components/write/WriteRichTextEditor.tsx")).toContain("<EditorContent editor={editor} lang={language} />");
  });
});
