import { describe, expect, it } from "vitest";
import { parseGuideMarkdown } from "../guide-markdown";
import { parseEditorArticleBody, parseEditorPublishedList } from "./contract";
import { editorArticleToGuide } from "./convert";

/**
 * editor.niho.life projects its AST into the Markdown subset this site renders (contract v1: quote → paragraph, divider
 * left out, strike and code → plain text, every punctuation character escaped). The published document below is a copy
 * of the editor's own synthetic example (niho-life/niho-editor packages/editor-publish-contract/fixtures/
 * published-doc.json, `example.com` hosts only); its `markdown` is kept byte for byte, so a change on either side that
 * breaks the projection fails here. `blocks` is left out: this site never reads the AST.
 */
const EDITOR_EXAMPLE_MARKDOWN =
  "Meet at the **station** at 7\\:00 \\(sharp\\)\\. See the [harbor map](/maps/harbor?view=full#start)\\.\n\n## Route\n\n1. Walk to the pier\n2. Turn left at the *red* gate\n3. Follow [**the coastal path**](https://maps.example.com/route_%28coast%29)\n\n- Water\n- Hat \\& sunscreen\n\n![Fishing boats in the harbor \\[morning\\]](https://assets.example.com/a/harbor_%28morning%29.jpg \"The harbor at 7\\:30 \\\"golden hour\\\"\")\n\nThe sea is calm before nine\\.\n\n### Tea break\n\nTry the *matcha* at [**Example Tea**](https://tea.example.com/menu?item=matcha_1)\\. Old menu uses code\\_name\\.\n\n:::note\nBring cash for the tea house\\.\n\n- Coins\n- **Small bills**\n:::\n\n[CONFIRM: opening hours] may change in winter\\.\n\n***Bold and italic*** then **bold** ***with italic***\n";

const EDITOR_EXAMPLE_DOC = {
  contractVersion: "1",
  id: "4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f607",
  slug: "morning-walk-along-the-coast",
  dest: "exp",
  lang: "en",
  title: "A morning walk along the coast",
  lead: "Start early, follow the shoreline, and stop for tea.",
  cover: { id: "asset-cover-01", url: "https://assets.example.com/a/cover-01.jpg", contentType: "image/jpeg", bytes: 182044, sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", alt: "Shoreline at sunrise", credit: "Example Photo Studio" },
  category: "walks",
  author: { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" },
  range: "live",
  version: 3,
  publishedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-15T08:30:00.000Z",
  canonicalUrl: "https://exp.example.com/guides/morning-walk-along-the-coast",
  extras: { app: true, news: false, xp: true },
  related: ["coastal-tea-ceremony", "sunrise-yoga"],
  blocks: [],
  markdown: EDITOR_EXAMPLE_MARKDOWN,
  assets: [{ id: "asset-figure-01", url: "https://assets.example.com/a/harbor_(morning).jpg", contentType: "image/webp", bytes: 96512, sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", alt: "Fishing boats in the harbor [morning]", credit: null }],
};

const text = (value: string) => ({ type: "text", value });
const strong = (...children: unknown[]) => ({ type: "strong", children });
const em = (...children: unknown[]) => ({ type: "em", children });

describe("the editor's Markdown projection (contract v1)", () => {
  it("parses whole, with the callout as a note of a paragraph and a list", () => {
    const blocks = parseGuideMarkdown(EDITOR_EXAMPLE_MARKDOWN);
    // The quote became a paragraph and the divider was left out by the editor.
    expect(blocks.map((block) => (block.type === "heading" ? `h${block.level}` : block.type))).toEqual([
      "paragraph", "h2", "list", "list", "figure", "paragraph", "h3", "paragraph", "note", "paragraph", "paragraph",
    ]);
    expect(blocks[8]).toEqual({
      type: "note",
      blocks: [
        { type: "paragraph", children: [text("Bring cash for the tea house.")] },
        { type: "list", ordered: false, items: [[text("Coins")], [strong(text("Small bills"))]] },
      ],
    });
  });

  it("keeps escaped punctuation literal, and links with percent-encoded parentheses", () => {
    const blocks = parseGuideMarkdown(EDITOR_EXAMPLE_MARKDOWN);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [
        text("Meet at the "), strong(text("station")), text(" at 7:00 (sharp). See the "),
        { type: "link", href: "/maps/harbor?view=full#start", external: false, children: [text("harbor map")] }, text("."),
      ],
    });
    expect(blocks[2]).toMatchObject({ type: "list", ordered: true, items: [[text("Walk to the pier")], [text("Turn left at the "), em(text("red")), text(" gate")], [text("Follow "), { type: "link", href: "https://maps.example.com/route_%28coast%29", external: true, children: [strong(text("the coastal path"))] }]] });
    expect(blocks[3]).toEqual({ type: "list", ordered: false, items: [[text("Water")], [text("Hat & sunscreen")]] });
    expect(blocks[4]).toMatchObject({ type: "figure", src: "https://assets.example.com/a/harbor_%28morning%29.jpg", external: true, alt: "Fishing boats in the harbor [morning]", caption: [text("The harbor at 7:30 \"golden hour\"")] });
    expect(blocks[7]).toMatchObject({ type: "paragraph", children: [text("Try the "), em(text("matcha")), text(" at "), { type: "link", href: "https://tea.example.com/menu?item=matcha_1" }, text(". Old menu uses code_name.")] });
  });

  it("keeps [CONFIRM: …] as a marker, and reads text that is both bold and italic", () => {
    const blocks = parseGuideMarkdown(EDITOR_EXAMPLE_MARKDOWN);
    expect(blocks[9]).toEqual({ type: "paragraph", children: [{ type: "confirm", value: "opening hours" }, text(" may change in winter.")] });
    expect(blocks[10]).toEqual({ type: "paragraph", children: [strong(em(text("Bold and italic"))), text(" then "), strong(text("bold")), text(" "), strong(em(text("with italic")))] });
  });

  it("becomes a guide through the contract: name-only author, a derived category label, an unshared cover", () => {
    const page = parseEditorPublishedList({ contractVersion: "1", items: [EDITOR_EXAMPLE_DOC], nextCursor: null });
    expect(page.skipped).toEqual([]);
    const body = parseEditorArticleBody(EDITOR_EXAMPLE_DOC, EDITOR_EXAMPLE_DOC.id);
    if (!body.ok) throw new Error(body.reason);
    const result = editorArticleToGuide({ ...page.items[0]!, ...body.body }, { assetOrigins: ["https://assets.example.com"] });
    expect(result).toMatchObject({
      ok: true,
      guide: {
        slug: "morning-walk-along-the-coast",
        category: { slug: "walks", label: "Walks", displayOrder: 1000 },
        author: { name: "Example Writer" },
        hero: { src: "https://assets.example.com/a/cover-01.jpg", alt: "Shoreline at sunrise", width: 1600, height: 900, licensed: false, caption: "Example Photo Studio" },
        relatedExperienceSlugs: ["coastal-tea-ceremony", "sunrise-yoga"],
        body: EDITOR_EXAMPLE_MARKDOWN,
      },
    });
    expect(result.ok && result.guide.author).toEqual({ name: "Example Writer" });
  });
});
