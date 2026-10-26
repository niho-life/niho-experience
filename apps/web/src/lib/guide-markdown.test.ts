import { describe, expect, it } from "vitest";
import { GuideMarkdownError, guideInlineText, guideLinkHref, parseGuideInline, parseGuideMarkdown } from "./guide-markdown";

describe("guide Markdown subset", () => {
  it("parses headings, paragraphs, both list kinds and inline bold, italic and links", () => {
    const blocks = parseGuideMarkdown([
      "First line",
      "joins the second.",
      "",
      "## How it works",
      "",
      "### What to bring",
      "- Socks",
      "- A **little** cash",
      "",
      "1. Check the time.",
      "2. Read the [terms](/experiences/sample?offer=a#top).",
      "",
      "Go *slowly* and see [the town](https://example.com/page).",
    ].join("\r\n"));
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "First line joins the second." }] },
      { type: "heading", level: 2, children: [{ type: "text", value: "How it works" }] },
      { type: "heading", level: 3, children: [{ type: "text", value: "What to bring" }] },
      { type: "list", ordered: false, items: [[{ type: "text", value: "Socks" }], [{ type: "text", value: "A " }, { type: "strong", children: [{ type: "text", value: "little" }] }, { type: "text", value: " cash" }]] },
      { type: "list", ordered: true, items: [[{ type: "text", value: "Check the time." }], [{ type: "text", value: "Read the " }, { type: "link", href: "/experiences/sample?offer=a#top", external: false, children: [{ type: "text", value: "terms" }] }, { type: "text", value: "." }]] },
      { type: "paragraph", children: [{ type: "text", value: "Go " }, { type: "em", children: [{ type: "text", value: "slowly" }] }, { type: "text", value: " and see " }, { type: "link", href: "https://example.com/page", external: true, children: [{ type: "text", value: "the town" }] }, { type: "text", value: "." }] },
    ]);
  });

  it("nests italic in bold and bold in link text, and keeps escaped punctuation literal", () => {
    expect(parseGuideInline("**bold *and italic* inside**", 1)).toEqual([
      { type: "strong", children: [{ type: "text", value: "bold " }, { type: "em", children: [{ type: "text", value: "and italic" }] }, { type: "text", value: " inside" }] },
    ]);
    expect(parseGuideInline("[**bold** link](/a)", 1)).toEqual([
      { type: "link", href: "/a", external: false, children: [{ type: "strong", children: [{ type: "text", value: "bold" }] }, { type: "text", value: " link" }] },
    ]);
    expect(parseGuideInline("\\*not italic\\* and \\[not a link\\] and snake\\_case", 1)).toEqual([{ type: "text", value: "*not italic* and [not a link] and snake_case" }]);
  });

  it("lets a heading or a list follow a paragraph line directly", () => {
    expect(parseGuideMarkdown("Intro:\n- one\n- two").map((block) => block.type)).toEqual(["paragraph", "list"]);
    expect(parseGuideMarkdown("Intro\n## Next").map((block) => block.type)).toEqual(["paragraph", "heading"]);
  });

  it.each([
    ["# Title", /only h1/],
    ["#### Deep", /Only ## and ###/],
    ["##Heading", /space after the #/],
    ["## Heading ##", /Closing #/],
    ["##  ", /Write headings/],
    ["> quote", /Block quotes/],
    ["```\ncode\n```", /Code blocks/],
    ["~~~", /Code blocks/],
    ["| a | b |", /Tables/],
    ["<div>hi</div>", /Raw HTML/],
    ["* item", /Start list items/],
    ["+ item", /Start list items/],
    ["1) item", /Number list items/],
    ["---", /Horizontal rules/],
    ["***", /Horizontal rules/],
    ["Title\n===", /underlined headings/],
    ["[ref]: https://example.com", /Reference links/],
    ["    indented code", /Indented lines/],
    ["- item\n  - nested", /Indented lines/],
    ["- item\ncontinued", /blank line after a list/],
    ["- one\n1. two", /blank line between/],
    ["2. starts at two", /Number this item 1\./],
    ["1. one\n3. three", /Number this item 2\./],
    ["- ", /needs text/],
    ["1.", /needs text/],
    ["Some `code` here", /Inline code/],
    ["A <span>tag</span>", /Raw HTML/],
    ["An <https://example.com> autolink", /Raw HTML/],
    ["An &amp; entity", /HTML entities/],
    ["An ![image](/a.png)", /Images are not supported/],
    ["Some _underscore_ emphasis", /\\_ for a literal underscore/],
    ["Some ~~struck~~ text", /Strikethrough/],
    ["A ***strong em*** run", /\*\*\* is not supported/],
    ["An **unclosed bold", /Unclosed \*\*/],
    ["An *unclosed italic", /Unclosed \*/],
    ["A ** spaced** opener", /must touch the text/],
    ["A **spaced ** closer", /must follow text/],
    ["A **bold *crossing** italic*", /close in the order/],
    ["A [ref][1] link", /reference links/],
    ["A [stray bracket", /Unclosed \[/],
    ["A stray ] bracket", /Unmatched \]/],
    ["A [nested [link](/a)](/b)", /another \[/],
    ["A [](/empty) link", /needs text/],
    ["A [titled](/a \"Title\") link", /spaces or titles/],
    ["A [paren](/a(b)) link", /parentheses/],
    ["A [broken](/a link", /Unclosed \(/],
    ["Ends with a backslash\\", /backslash must escape/],
    ["A \\n escape", /backslash must escape/],
  ])("refuses %j", (source, message) => {
    expect(() => parseGuideMarkdown(source)).toThrow(GuideMarkdownError);
    expect(() => parseGuideMarkdown(source)).toThrow(message);
  });

  it("reports the line of the problem", () => {
    try {
      parseGuideMarkdown("Fine.\n\n## Fine\n\nNot `fine`.");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GuideMarkdownError);
      expect((error as GuideMarkdownError).line).toBe(5);
      expect((error as Error).message).toMatch(/^line 5: /);
    }
  });

  it("allows plain prose punctuation that is not syntax", () => {
    expect(guideInlineText(parseGuideInline("3 < 5 & 7 > 2, ~10 minutes (roughly) - fine!", 1))).toBe("3 < 5 & 7 > 2, ~10 minutes (roughly) - fine!");
  });
});

describe("guide links", () => {
  it.each([
    ["/experiences/home-cooked-dinner-with-locals", { href: "/experiences/home-cooked-dinner-with-locals", external: false }],
    ["/guides?a=1#faq", { href: "/guides?a=1#faq", external: false }],
    ["https://example.com/a?b=c", { href: "https://example.com/a?b=c", external: true }],
  ])("accepts %s", (href, expected) => {
    expect(guideLinkHref(href)).toEqual(expected);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "http://example.com",
    "mailto:someone@example.com",
    "//evil.example/path",
    "/\\evil.example",
    "experiences/relative",
    "#top",
    "https://user:pass@example.com",
    "https://exa mple.com",
    "",
  ])("refuses %j", (href) => {
    expect(guideLinkHref(href)).toBeNull();
  });

  it("refuses an unsafe link inside the body", () => {
    expect(() => parseGuideMarkdown("Click [here](javascript:alert(1)).")).toThrow(/parentheses|Unsafe/);
    expect(() => parseGuideMarkdown("Click [here](javascript:void).")).toThrow(/Unsafe or unsupported link/);
    expect(() => parseGuideMarkdown("Click [here](http://example.com).")).toThrow(/Unsafe or unsupported link/);
    expect(() => parseGuideMarkdown("Click [here](//evil.example).")).toThrow(/Unsafe or unsupported link/);
  });
});
