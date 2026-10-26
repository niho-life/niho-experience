import { describe, expect, it } from "vitest";
import { GuideMarkdownError, guideFigureSources, guideInlineText, guideLinkHref, parseGuideAnswer, parseGuideInline, parseGuideMarkdown } from "./guide-markdown";

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
    ["| a | b |", /separator row/],
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
    ["An ![image](/a.png)", /A photo goes on a line of its own/],
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

describe("guide photos", () => {
  it("parses a photo alone on its line, with or without a caption, and closes the block before it", () => {
    expect(parseGuideMarkdown('Intro\n![A gate in the rain](/guides/gate.jpg "The gate, *early* in the day")\n\n![Steps](https://images.example.com/s.jpg)')).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "Intro" }] },
      {
        type: "figure", src: "/guides/gate.jpg", external: false, alt: "A gate in the rain",
        caption: [{ type: "text", value: "The gate, " }, { type: "em", children: [{ type: "text", value: "early" }] }, { type: "text", value: " in the day" }],
      },
      { type: "figure", src: "https://images.example.com/s.jpg", external: true, alt: "Steps", caption: null },
    ]);
    expect(parseGuideMarkdown("![Snake\\_case \\[sic\\]](/a.jpg)")).toEqual([{ type: "figure", src: "/a.jpg", external: false, alt: "Snake_case [sic]", caption: null }]);
    expect(guideFigureSources(parseGuideMarkdown("![A](/a.jpg)\n\nText\n\n![B](/sample/b.jpg)"))).toEqual(["/a.jpg", "/sample/b.jpg"]);
  });

  it.each([
    ["![](/a.jpg)", /needs alt text/],
    ["![  ](/a.jpg)", /needs alt text/],
    ["![**Bold** alt](/a.jpg)", /Alt text is plain text/],
    ["![Alt](/a.jpg) and more", /alone on its line/],
    ["![Alt]", /alone on its line/],
    ["![Alt](/a.jpg 'single quotes')", /alone on its line/],
    ['![Alt](/a.jpg "")', /empty caption/],
    ["![Alt](javascript:alert(1))", /Unsafe or unsupported photo/],
    ["![Alt](JavaScript:alert)", /Unsafe or unsupported photo/],
    ["![Alt](http://example.com/a.jpg)", /Unsafe or unsupported photo/],
    ["![Alt](//evil.example/a.jpg)", /Unsafe or unsupported photo/],
    ["![Alt](data:image/png;base64,AAAA)", /Unsafe or unsupported photo/],
    ["![Alt](photos/a.jpg)", /Unsafe or unsupported photo/],
    ["![Alt](https://user:pass@example.com/a.jpg)", /Unsafe or unsupported photo/],
    ["![Alt [x]](/a.jpg)", /another \[/],
  ])("refuses the photo %j", (source, message) => {
    expect(() => parseGuideMarkdown(source)).toThrow(GuideMarkdownError);
    expect(() => parseGuideMarkdown(source)).toThrow(message);
  });
});

describe("guide tables", () => {
  const text = (value: string) => [{ type: "text", value }];

  it("parses the header, ignores alignment colons, pads short rows and formats cells; the nearest heading labels it", () => {
    const blocks = parseGuideMarkdown([
      "## Compare the mornings",
      "",
      "| What | Public session | Guided morning |",
      "| :--- | :---: | ---: |",
      "| Language | Mostly **Japanese** | [English](/experiences/x) |",
      "| Price | Free \\| donation |",
      "|Booking|None|Ahead",
    ].join("\n"));
    expect(blocks[1]).toEqual({
      type: "table",
      label: "Compare the mornings",
      head: [text("What"), text("Public session"), text("Guided morning")],
      rows: [
        [text("Language"), [{ type: "text", value: "Mostly " }, { type: "strong", children: text("Japanese") }], [{ type: "link", href: "/experiences/x", external: false, children: text("English") }]],
        [text("Price"), text("Free | donation"), []],
        [text("Booking"), text("None"), text("Ahead")],
      ],
    });
  });

  it('labels a table with no heading above it "Table", and numbers repeated labels', () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const labels = (source: string) => parseGuideMarkdown(source).flatMap((block) => (block.type === "table" ? [block.label] : []));
    expect(labels(table)).toEqual(["Table"]);
    expect(labels(`${table}\n\n${table}\n\n## Prices [CONFIRM: check]\n\n${table}\n\n${table}`)).toEqual(["Table", "Table (2)", "Prices", "Prices (2)"]);
  });

  it("allows an empty top-left corner in a comparison table", () => {
    const [table] = parseGuideMarkdown("|  | Public | Guided |\n| --- | --- | --- |\n| Language | Japanese | English |");
    expect(table).toMatchObject({ type: "table", head: [[], [{ type: "text", value: "Public" }], [{ type: "text", value: "Guided" }]] });
  });

  it.each([
    ["| a | b |", /separator row/],
    ["| a | b |\n| 1 | 2 |", /separator row/],
    ["| --- | --- |\n| 1 | 2 |", /starts with its header row/],
    ["| a | b |\n| --- |\n| 1 | 2 |", /separator row has 1 cells; the header row has 2/],
    ["| a | b |\n| --- | --- |", /at least one row/],
    ["| a | b |\n| --- | --- |\n| 1 | 2 | 3 |", /This row has 3 cells; the header row has 2/],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |\n| --- | --- |", /one separator row/],
    ["| a |  |\n| --- | --- |\n| 1 | 2 |", /Every column header cell needs text/],
    ["|  |  |\n| --- | --- |\n| 1 | 2 |", /Every column header cell needs text/],
    ["| a | b |\n| --- | --- |\n|  | 2 |", /row's heading and needs text/],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |\nMore text", /blank line after a table/],
    ["| a | b |\n| --- | --- |\n| 1 | `code` |", /Inline code/],
    ["| a | b |\n| -x- | --- |\n| 1 | 2 |", /separator row/],
  ])("refuses the table %j", (source, message) => {
    expect(() => parseGuideMarkdown(source)).toThrow(GuideMarkdownError);
    expect(() => parseGuideMarkdown(source)).toThrow(message);
  });

  it("reports the line of the bad row", () => {
    try {
      parseGuideMarkdown("Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 1 | 2 | 3 |");
      expect.unreachable();
    } catch (error) {
      expect((error as GuideMarkdownError).line).toBe(6);
    }
  });
});

describe("guide notes", () => {
  it("holds paragraphs and lists between :::note and :::", () => {
    expect(parseGuideMarkdown("Before.\n:::note\n**Checked** 1 Oct.\nStill true.\n\n- One\n- Two\n:::\n\nAfter.")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "Before." }] },
      {
        type: "note",
        blocks: [
          { type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: "Checked" }] }, { type: "text", value: " 1 Oct. Still true." }] },
          { type: "list", ordered: false, items: [[{ type: "text", value: "One" }], [{ type: "text", value: "Two" }]] },
        ],
      },
      { type: "paragraph", children: [{ type: "text", value: "After." }] },
    ]);
  });

  it.each([
    [":::note\nText", /never closed/],
    [":::note\n\n:::", /box is empty/],
    [":::note\n## Heading\n:::", /holds only paragraphs and lists, not headings/],
    [":::note\n![Alt](/a.jpg)\n:::", /not photos/],
    [":::note\n| a |\n| --- |\n| 1 |\n:::", /not tables/],
    [":::note\n:::note\nText\n:::\n:::", /not another :::note/],
    [":::", /closes nothing/],
    [":::warning\nText\n:::", /Unknown block ":::warning"/],
    [":::note extra\nText\n:::", /Unknown block/],
    [":::faq\n### Q\nA\n:::", /faq, not in the body/],
    [":::note\n- item\ncontinued\n:::", /blank line after a list/],
  ])("refuses the note %j", (source, message) => {
    expect(() => parseGuideMarkdown(source)).toThrow(GuideMarkdownError);
    expect(() => parseGuideMarkdown(source)).toThrow(message);
  });
});

describe("facts to confirm", () => {
  it("parses [CONFIRM: …] as its own inline node, also inside bold, and leaves it out of the plain text", () => {
    expect(parseGuideInline("Open daily [CONFIRM: ask  the temple \\[office\\]] until 4.", 1)).toEqual([
      { type: "text", value: "Open daily " },
      { type: "confirm", value: "ask the temple [office]" },
      { type: "text", value: " until 4." },
    ]);
    expect(parseGuideInline("**Free [CONFIRM: price]**", 1)).toEqual([{ type: "strong", children: [{ type: "text", value: "Free " }, { type: "confirm", value: "price" }] }]);
    expect(guideInlineText(parseGuideInline("Open [CONFIRM: check] daily", 1))).toBe("Open  daily");
  });

  it.each([
    ["[CONFIRM: ]", /needs the fact to check/],
    ["[CONFIRM:]", /needs the fact to check/],
    ["[CONFIRM: *soon*]", /plain text/],
    ["[CONFIRM: see [this](/a)]", /another \[/],
    ["[CONFIRM: unclosed", /Unclosed \[/],
    ["[confirm: lower case]", /Write links as/],
    ["[link [CONFIRM: x]](/a)", /another \[/],
  ])("refuses %j", (source, message) => {
    expect(() => parseGuideInline(source, 1)).toThrow(message);
  });
});

describe("FAQ answers", () => {
  it("are one paragraph with bold, italic, links and [CONFIRM: …]", () => {
    expect(parseGuideAnswer("  Yes, **usually**.\n  See [the page](/experiences/x) [CONFIRM: dates].  ")).toEqual([
      { type: "text", value: "Yes, " },
      { type: "strong", children: [{ type: "text", value: "usually" }] },
      { type: "text", value: ". See " },
      { type: "link", href: "/experiences/x", external: false, children: [{ type: "text", value: "the page" }] },
      { type: "text", value: " " },
      { type: "confirm", value: "dates" },
      { type: "text", value: "." },
    ]);
    expect(parseGuideAnswer("")).toEqual([]);
  });

  it.each([
    ["One.\n\nTwo.", /one paragraph/],
    ["A <b>tag</b>", /Raw HTML/],
    ["An **unclosed bold", /Unclosed \*\*/],
    ["A [link](http://example.com)", /Unsafe or unsupported link/],
    ["Line one\nhas `code`", /^line 1: Inline code/],
  ])("refuses %j", (source, message) => {
    expect(() => parseGuideAnswer(source)).toThrow(message);
  });
});
