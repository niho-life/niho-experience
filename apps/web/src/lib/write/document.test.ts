import { describe, expect, it } from "vitest";
import { parseGuideMarkdown } from "@/lib/guide-markdown";
import { markdownToWriteDocument, UnsupportedWriteContentError, writeDocumentToMarkdown } from "./document";

describe("write Markdown document", () => {
  it("round trips the safe TipTap subset", () => {
    const source = "## A morning walk\n\nA **bold** paragraph with *emphasis* and [a link](/guides/example).\n\n- one\n- two";
    const saved = writeDocumentToMarkdown(markdownToWriteDocument(source));
    expect(parseGuideMarkdown(saved)).toEqual(parseGuideMarkdown(source));
  });

  it("rejects unsupported table and note blocks before editing, leaving their bytes untouched for settings-only saves", () => {
    for (const source of [
      "| Place | Time |\n| --- | --- |\n| Beach | 10:00 |",
      ":::note\nKeep this byte-for-byte.\n:::",
    ]) {
      const preserved = source;
      expect(() => markdownToWriteDocument(source)).toThrow(UnsupportedWriteContentError);
      expect(source).toBe(preserved);
    }
  });

  it("keeps canonical private photo URIs and refuses overlapping bold/italic marks", () => {
    const id = "00000000-0000-4000-8000-000000000216";
    const source = `## Photo\n\n![A synthetic photo](niho-guide-asset:${id})`;
    expect(writeDocumentToMarkdown(markdownToWriteDocument(source))).toBe(source);
    expect(() => markdownToWriteDocument("This is **bold *and italic* text**.")).toThrow("太字と斜体");
  });
});
