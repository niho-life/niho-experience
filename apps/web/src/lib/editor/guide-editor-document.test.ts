import { describe, expect, it } from "vitest";
import { parseGuideMarkdown } from "@/lib/guide-markdown";
import {
  createGuideSlugFallback,
  guideEditorDocumentToMarkdown,
  guideEditorLinkHref,
  guideSlugFromTitle,
  markdownToGuideEditorDocument,
  UnsupportedGuideEditorContentError,
} from "./guide-editor-document";

describe("guide editor document", () => {
  it("round trips the editable Markdown subset without HTML", () => {
    const source = [
      "## A safe heading",
      "",
      "A **bold** paragraph with *emphasis* and [a link](/guides/example).",
      "",
      "- first",
      "- second",
      "",
      "1. one",
      "2. two",
    ].join("\n");
    const markdown = guideEditorDocumentToMarkdown(markdownToGuideEditorDocument(source));
    expect(parseGuideMarkdown(markdown)).toEqual(parseGuideMarkdown(source));
    expect(markdown).not.toContain("<");
  });

  it("escapes Markdown punctuation typed as plain text", () => {
    const markdown = guideEditorDocumentToMarkdown({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Use [brackets], a_b, and `ticks`." }] }],
    });
    expect(parseGuideMarkdown(markdown)[0]).toMatchObject({ type: "paragraph" });
    expect(markdown).toContain("\\[");
    expect(markdown).toContain("\\_");
    expect(markdown).toContain("\\`");
  });

  it("round trips adjacent bold and italic text in both orders", () => {
    for (const [first, second, markdown] of [
      ["bold", "italic", "**太字***斜体*"],
      ["italic", "bold", "*斜体***太字**"],
    ] as const) {
      const document = {
        type: "doc",
        content: [{ type: "paragraph", content: [
          { type: "text", text: first === "bold" ? "太字" : "斜体", marks: [{ type: first }] },
          { type: "text", text: second === "bold" ? "太字" : "斜体", marks: [{ type: second }] },
        ] }],
      };
      expect(guideEditorDocumentToMarkdown(document)).toBe(markdown);
      expect(markdownToGuideEditorDocument(markdown)).toEqual(document);
    }
  });

  it("preserves paragraph-leading ASCII and Japanese spaces", () => {
    for (const leading of [" ", "  ", "　"]) {
      const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${leading}鎌倉の朝` }] }] };
      expect(guideEditorDocumentToMarkdown(document)).toBe(`${leading}鎌倉の朝`);
      expect(markdownToGuideEditorDocument(`${leading}鎌倉の朝`)).toEqual(document);
    }
  });

  it("refuses legacy blocks instead of dropping them", () => {
    expect(() => markdownToGuideEditorDocument("| Place | Time |\n| --- | --- |\n| Beach | 10:00 |"))
      .toThrow(UnsupportedGuideEditorContentError);
    expect(() => markdownToGuideEditorDocument(":::note\nKeep this.\n:::"))
      .toThrow(UnsupportedGuideEditorContentError);
  });

  it("refuses parser-supported overlapping marks before editing", () => {
    expect(() => markdownToGuideEditorDocument("This is **bold *and italic* text**."))
      .toThrow("太字と斜体");
  });

  it("refuses unsafe links and nested lists", () => {
    expect(guideEditorLinkHref("https://example.com/a_(b)")).toBeNull();
    expect(() => guideEditorDocumentToMarkdown({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
    })).toThrow("安全でないリンク");
    expect(() => guideEditorDocumentToMarkdown({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "bulletList" }] }] }],
    })).toThrow("入れ子のリスト");
  });

  it("uses title ASCII and a stable ASCII fallback for Japanese titles", () => {
    expect(guideSlugFromTitle("A Walk in Kamakura", "20261029-abcd")).toBe("a-walk-in-kamakura");
    expect(guideSlugFromTitle("鎌倉の夕方", "20261029-abcd")).toBe("draft-20261029-abcd");
  });

  it("creates a unique UUID-based fallback that can stay fixed for one editor", () => {
    const now = new Date("2026-10-29T00:00:00.000Z");
    const first = createGuideSlugFallback(() => "11111111-1111-4111-8111-111111111111", now);
    const second = createGuideSlugFallback(() => "22222222-2222-4222-8222-222222222222", now);
    expect(first).toBe("20261029-111111111111");
    expect(second).toBe("20261029-222222222222");
    expect(guideSlugFromTitle("鎌倉の夕方", first)).not.toBe(guideSlugFromTitle("鎌倉の夕方", second));
  });
});
