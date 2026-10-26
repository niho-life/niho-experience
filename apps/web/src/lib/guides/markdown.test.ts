import { describe, expect, it } from "vitest";
import { headingId, isTableSeparator, parseGuideBody, parseInlines, plainText, splitTableRow } from "./markdown";

const text = (value: string) => ({ type: "text", text: value });
const body = (source: string) => parseGuideBody(source.replace(/^\n/, ""));

describe("guide body blocks", () => {
  it("reads headings, paragraphs and lists", () => {
    const parsed = body(`
Kamakura empties out
after the temples close.

## Watch the sun go down

### From the beach

- First item
- Second item
  continued here

- After a blank line

1. Step one
2. Step two
`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.blocks).toEqual([
      { type: "paragraph", children: [text("Kamakura empties out after the temples close.")] },
      { type: "h2", id: "watch-the-sun-go-down", text: "Watch the sun go down", children: [text("Watch the sun go down")] },
      { type: "h3", text: "From the beach", children: [text("From the beach")] },
      { type: "ul", items: [[text("First item")], [text("Second item continued here")], [text("After a blank line")]] },
      { type: "ol", items: [[text("Step one")], [text("Step two")]] },
    ]);
    expect(parsed.headings).toEqual([{ id: "watch-the-sun-go-down", text: "Watch the sun go down" }]);
  });

  it("gives h2 headings stable, unique ids that avoid the page's own ids", () => {
    const parsed = body("## Dinner\n\n## Dinner\n\n## Café & Bar\n\n## 夕方\n\n## FAQ\n");
    expect(parsed.headings.map((heading) => heading.id)).toEqual(["dinner", "dinner-2", "cafe-bar", "section", "faq-2"]);
    expect(headingId("  The last train: 11:04 pm  ")).toBe("the-last-train-11-04-pm");
  });

  it("reads a quote with its speaker", () => {
    const parsed = body("> We start when the sun goes down.\n> Then we eat.\n>\n> Everyone helps.\n> — Sample Host\n");
    expect(parsed.blocks).toEqual([
      { type: "quote", paragraphs: [[text("We start when the sun goes down. Then we eat.")], [text("Everyone helps.")]], cite: [text("Sample Host")] },
    ]);
    expect(body("> Just words.").blocks).toEqual([{ type: "quote", paragraphs: [[text("Just words.")]], cite: null }]);
    expect(body("> — Only a name").problems).toEqual(["line 1: the quote has no text"]);
  });

  it("reads photos on their own line, with an optional caption", () => {
    const parsed = body('![A lantern](/guides/media/lantern.jpg "Lanterns on *the* lane")\n\n![A gate](https://images.example/gate.jpg)\n');
    expect(parsed.blocks).toEqual([
      { type: "figure", src: "/guides/media/lantern.jpg", alt: "A lantern", caption: [text("Lanterns on "), { type: "em", children: [text("the")] }, text(" lane")] },
      { type: "figure", src: "https://images.example/gate.jpg", alt: "A gate", caption: null },
    ]);
    expect(parsed.images).toEqual(["/guides/media/lantern.jpg", "https://images.example/gate.jpg"]);
    expect(body("![](/a.jpg)").problems).toEqual(["line 1: the photo needs alt text: ![what the photo shows](/a.jpg)"]);
    expect(body("![A gate](//images.example/gate.jpg)").problems).toEqual(['line 1: photo "//images.example/gate.jpg" must be a site path starting with "/" or an https:// URL']);
    expect(body("![A gate](javascript:alert(1))").blocks).toEqual([{ type: "paragraph", children: [text("![A gate](javascript:alert(1))")] }]);
  });

  it("reads experience cards, notes and the FAQ", () => {
    const parsed = body(`
:::experience home-cooked-dinner-with-locals

:::note
Checked on 8 Nov.

- Bring cash
:::

:::faq
### Is it safe at night?
Yes. **Very.**

### What should I wear?
Comfortable shoes.
:::
`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.blocks).toEqual([
      { type: "experience", slug: "home-cooked-dinner-with-locals" },
      { type: "note", blocks: [{ type: "paragraph", children: [text("Checked on 8 Nov.")] }, { type: "ul", items: [[text("Bring cash")]] }] },
      {
        type: "faq",
        items: [
          { question: "Is it safe at night?", questionInlines: [text("Is it safe at night?")], answer: [{ type: "paragraph", children: [text("Yes. "), { type: "strong", children: [text("Very.")] }] }] },
          { question: "What should I wear?", questionInlines: [text("What should I wear?")], answer: [{ type: "paragraph", children: [text("Comfortable shoes.")] }] },
        ],
      },
    ]);
    // The FAQ is never added to the article's own headings (the page adds its heading).
    expect(parsed.headings).toEqual([]);
  });

  it("reports what keeps a manuscript from being shown", () => {
    const problems = (source: string) => body(source).problems;
    expect(problems("# Title")).toEqual(['line 1: "#" (h1) is not used in the body; the title is the page heading']);
    expect(problems("#### Deep")).toEqual(['line 1: only "##" and "###" headings are supported']);
    expect(problems(":::note\nNever closed")).toEqual(['line 1: ":::note" is never closed with ":::"']);
    expect(problems(":::note\n:::")).toEqual(['line 1: ":::note" is empty']);
    expect(problems(":::note\n## Heading\n:::")).toEqual(["line 2: headings cannot be inside :::note", 'line 1: ":::note" is empty']);
    expect(problems(":::faq\nNo question\n:::")).toEqual(['line 2: in ":::faq", start each question with "### "', 'line 1: ":::faq" has no "### " questions']);
    expect(problems(":::faq\n### Silent?\n:::")).toEqual(['line 2: the question "Silent?" has no answer']);
    expect(problems(":::faq\n### A?\nA.\n:::\n\n:::faq\n### B?\nB.\n:::")).toEqual(['line 6: only one ":::faq" per article']);
    expect(problems(":::experience")).toEqual(['line 1: ":::experience" needs one experience slug']);
    expect(problems(":::experience Not A Slug")).toEqual(['line 1: ":::experience" needs one experience slug']);
    expect(problems(":::map kamakura")).toEqual(['line 1: unknown block ":::map"']);
    expect(problems("Text\n:::")).toEqual(['line 2: ":::" closes nothing']);
    expect(problems(":::note\n:::experience home-cooked-dinner-with-locals\n:::")).toEqual(['line 2: ":::experience" cannot be inside :::note or :::faq', 'line 1: ":::note" is empty']);
    expect(problems("")).toEqual(["the article has no body text"]);
  });

  it("numbers problem lines from the start of the file", () => {
    expect(parseGuideBody("Intro\n\n# Title", 18).problems).toEqual(['line 20: "#" (h1) is not used in the body; the title is the page heading']);
  });

  it("keeps raw HTML as text", () => {
    expect(body('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>').blocks).toEqual([
      { type: "paragraph", children: [text('<script>alert("x")</script>')] },
      { type: "paragraph", children: [text("<img src=x onerror=alert(1)>")] },
    ]);
  });
});

describe("guide tables", () => {
  it("reads a header, a separator and body rows under the nearest heading", () => {
    const parsed = body(`
## Last trains

| Station | Last train | Note |
| --- | :---: | ---: |
| Kamakura | 11:04 pm | **JR** line |
| Hase | 10:51 pm |
| Enoshima | 10:40 pm | [Map](/guides/map) | extra |
`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.blocks[1]).toEqual({
      type: "table",
      label: "Last trains",
      head: [[text("Station")], [text("Last train")], [text("Note")]],
      rows: [
        [[text("Kamakura")], [text("11:04 pm")], [{ type: "strong", children: [text("JR")] }, text(" line")]],
        [[text("Hase")], [text("10:51 pm")], []],
        [[text("Enoshima")], [text("10:40 pm")], [{ type: "link", href: "/guides/map", children: [text("Map")] }]],
      ],
    });
  });

  it("labels tables without a heading \"Table\", keeps labels unique and allows empty cells and outer pipes to be left out", () => {
    const parsed = body("| a | b |\n|---|---|\n| | 2 |\n\n| c | d\n| - | -\n| 3 | [CONFIRM: price]\n");
    expect(parsed.blocks).toEqual([
      { type: "table", label: "Table", head: [[text("a")], [text("b")]], rows: [[[], [text("2")]]] },
      { type: "table", label: "Table (2)", head: [[text("c")], [text("d")]], rows: [[[text("3")], [{ type: "confirm", text: "price" }]]] },
    ]);
  });

  it("takes a FAQ question as the label of a table in its answer", () => {
    const parsed = body(":::faq\n### How much?\n| Item | Price |\n| --- | --- |\n| Tea | ¥500 |\n:::");
    const faq = parsed.blocks[0];
    expect(faq?.type === "faq" && faq.items[0]?.answer[0]).toMatchObject({ type: "table", label: "How much?" });
  });

  it("reads pipe lines without a separator row as a paragraph", () => {
    expect(body("| not | a table |\n| still | not |").blocks).toEqual([{ type: "paragraph", children: [text("| not | a table | | still | not |")] }]);
  });

  it("splits rows on unescaped pipes and recognizes separators", () => {
    expect(splitTableRow("| a | b \\| c |")).toEqual(["a", "b \\| c"]);
    expect(parseInlines("b \\| c")).toEqual([text("b | c")]);
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
    expect(isTableSeparator("| --- | :--: |")).toBe(true);
    expect(isTableSeparator("| --- | text |")).toBe(false);
    expect(isTableSeparator("--- | ---")).toBe(false);
  });
});

describe("guide inline text", () => {
  it("reads strong, emphasis and nesting", () => {
    expect(parseInlines("a **bold *and* more** and *it **is** here* end")).toEqual([
      text("a "),
      { type: "strong", children: [text("bold "), { type: "em", children: [text("and")] }, text(" more")] },
      text(" and "),
      { type: "em", children: [text("it "), { type: "strong", children: [text("is")] }, text(" here")] },
      text(" end"),
    ]);
  });

  it("leaves stray and spaced stars as text, and honours escapes", () => {
    expect(parseInlines("2 * 3 * 4 and **open")).toEqual([text("2 * 3 * 4 and **open")]);
    expect(parseInlines("\\*not em\\* and \\[not a link\\](/x)")).toEqual([text("*not em* and [not a link](/x)")]);
  });

  it("links only to site paths, in-page anchors and https URLs", () => {
    expect(parseInlines("[Dinner](/experiences/home-cooked-dinner-with-locals)")).toEqual([{ type: "link", href: "/experiences/home-cooked-dinner-with-locals", children: [text("Dinner")] }]);
    expect(parseInlines("[Up](#watch-the-sun-go-down)")).toEqual([{ type: "link", href: "#watch-the-sun-go-down", children: [text("Up")] }]);
    expect(parseInlines("[Wiki](https://en.wikipedia.org/wiki/Kamakura_(city))")).toEqual([{ type: "link", href: "https://en.wikipedia.org/wiki/Kamakura_(city)", children: [text("Wiki")] }]);
    expect(parseInlines("[**Bold** link](/x)")).toEqual([{ type: "link", href: "/x", children: [{ type: "strong", children: [text("Bold")] }, text(" link")] }]);
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,hi", "http://example.com", "//example.com", "/\\example.com", "mailto:a@example.com", "https://user:pass@example.com", "relative/path", "#", "/a b"]) {
      expect(parseInlines(`see [this](${href}) now`), href).toEqual([text("see this now")]);
    }
  });

  it("does not nest links or read inline images", () => {
    expect(parseInlines("[a [b](/b) c](/a)")).toEqual([{ type: "link", href: "/a", children: [text("a [b](/b) c")] }]);
    expect(parseInlines("see ![a cat](/cat.jpg) here")).toEqual([text("see ![a cat](/cat.jpg) here")]);
  });

  it("marks facts to confirm", () => {
    expect(parseInlines("Opens at [CONFIRM: 9 am on Sundays] daily")).toEqual([text("Opens at "), { type: "confirm", text: "9 am on Sundays" }, text(" daily")]);
    expect(parseInlines("**[confirm: lowercase too]**")).toEqual([{ type: "strong", children: [{ type: "confirm", text: "lowercase too" }] }]);
    expect(plainText(parseInlines("Last train [CONFIRM: time] **home**"))).toBe("Last train home");
  });

  it("keeps markup characters in headings as text, without links", () => {
    expect(body("## Read [this](/x) <b>first</b>").blocks[0]).toMatchObject({ type: "h2", id: "read-this-b-first-b", children: [text("Read this <b>first</b>")] });
  });
});
