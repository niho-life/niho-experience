import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureExperiences } from "@niho-experience/api-client/mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGuideMarkdown } from "./guide-markdown";
import { guidePublishProblems } from "./guides";

vi.mock("server-only", () => ({}));

const { GUIDE_DRAFTS_FOLDER, parseGuideDraft, readGuideDrafts } = await import("./guide-drafts");

// Synthetic drafts only: invented text that points at the synthetic fixture experiences.
const FIELDS = [
  "title: Test draft: an invented guide",
  "description: Invented text for the draft loader tests.",
  "author: Test Writer (sample)",
  "authorRole: Invented editor",
  "publishedAt: 2026-10-26",
  "updatedAt: 2026-10-26",
  "relatedExperiences: indigo-dyeing-with-an-artisan, evening-pottery-session",
  "relatedGuides: sample-rainy-day-in-kamakura",
];
const BODY = ["Intro with [CONFIRM: an invented fact].", "", "## Compare", "", "| What | When |", "| --- | --- |", "| Open | 9:00 |"];
const draft = (fields: readonly string[] = FIELDS, body: readonly string[] = BODY) => ["---", ...fields, "---", "", ...body, ""].join("\n");
const without = (key: string) => FIELDS.filter((line) => !line.startsWith(`${key}:`));
const reasonsOf = (source: string, file = "test-draft.md") => {
  const result = parseGuideDraft(file, source);
  return result.ok ? [] : result.reasons;
};

describe("a draft file", () => {
  it("becomes a Guide: slug from the file name, fields split at the first \": \", lists, hero and the :::faq block", () => {
    const result = parseGuideDraft("test-draft.md", draft(
      [...FIELDS, "hero: /placeholders/dinner.svg", "heroAlt: An invented illustration", "heroWidth: 1200", "heroHeight: 900"],
      [...BODY, "", ":::faq", "### Is this real?", "No, it is **invented**", "for tests [CONFIRM: twice].", "", "### Second?", "Yes.", ":::", "", "Closing line."],
    ));
    expect(result).toEqual({
      ok: true,
      guide: {
        slug: "test-draft",
        title: "Test draft: an invented guide",
        description: "Invented text for the draft loader tests.",
        author: { name: "Test Writer (sample)", role: "Invented editor" },
        publishedAt: "2026-10-26",
        updatedAt: "2026-10-26",
        hero: { src: "/placeholders/dinner.svg", alt: "An invented illustration", width: 1200, height: 900, licensed: false },
        relatedExperienceSlugs: ["indigo-dyeing-with-an-artisan", "evening-pottery-session"],
        relatedGuideSlugs: ["sample-rainy-day-in-kamakura"],
        faq: [
          { question: "Is this real?", answer: "No, it is **invented** for tests [CONFIRM: twice]." },
          { question: "Second?", answer: "Yes." },
        ],
        body: expect.stringMatching(/^Intro with \[CONFIRM: an invented fact\]\.\n[\s\S]*\| Open \| 9:00 \|\n+Closing line\.$/),
      },
    });
    if (result.ok) expect(result.guide.body).not.toMatch(/:::|Is this real/);
  });

  it("accepts a draft without a hero or related guides, and heroLicensed: true", () => {
    expect(reasonsOf(draft(without("relatedGuides")))).toEqual([]);
    const licensed = parseGuideDraft("test-draft.md", draft([...FIELDS, "hero: https://images.example.com/a.jpg", "heroAlt: A", "heroWidth: 10", "heroHeight: 10", "heroLicensed: true"]));
    expect(licensed.ok && licensed.guide.hero?.licensed).toBe(true);
  });

  it.each([
    ["no front matter", "Just a body.", /start the file with the fields/],
    ["an unclosed front matter", "---\ntitle: T\n\nBody", /start the file with the fields/],
    ["an unknown field", draft([...FIELDS, "pillar: culture"]), /line 10: unknown field "pillar"/],
    ["a misspelt field", draft([...without("authorRole"), "authorrole: Editor"]), /unknown field "authorrole"/],
    ["a repeated field", draft([...FIELDS, "title: Again"]), /line 10: "title" is written twice/],
    ["a line that is not key: value", draft([...FIELDS, "just words"]), /line 10: write each field as "key: value"/],
    ["a missing field", draft(without("authorRole")), /^missing field "authorRole"$/],
    ["an empty required field", draft([...without("title"), "title:"]), /^title is empty$/],
    ["a bad date", draft([...without("updatedAt"), "updatedAt: 26 Oct 2026"]), /updatedAt must be a YYYY-MM-DD date/],
    ["too few experiences", draft([...without("relatedExperiences"), "relatedExperiences: indigo-dyeing-with-an-artisan"]), /relatedExperienceSlugs needs 2–3 slugs/],
    ["an incomplete hero", draft([...FIELDS, "hero: /a.jpg", "heroAlt: A"]), /a hero needs "heroWidth", "heroHeight" too/],
    ["heroLicensed without a hero", draft([...FIELDS, "heroLicensed: true"]), /"heroLicensed" goes with a hero/],
    ["a bad heroLicensed", draft([...FIELDS, "hero: /a.jpg", "heroAlt: A", "heroWidth: 10", "heroHeight: 10", "heroLicensed: yes"]), /"heroLicensed" must be true or false/],
    ["a non-numeric hero size", draft([...FIELDS, "hero: /a.jpg", "heroAlt: A", "heroWidth: 10px", "heroHeight: 10"]), /hero.width and hero.height must be positive integers/],
    ["an unsafe hero", draft([...FIELDS, "hero: javascript:alert(1)", "heroAlt: A", "heroWidth: 10", "heroHeight: 10"]), /hero.src must be a site path or an https URL/],
    // Body errors carry the file's line numbers: 8 fields + 2 fences + 1 blank line, so the body starts on line 12.
    ["an invalid body", draft(FIELDS, ["Fine.", "", "# Not allowed"]), /^body: line 14: The guide title is the page's only h1/],
    ["an empty body", draft(FIELDS, []), /^body is empty$/],
    ["an unclosed :::faq", draft(FIELDS, [...BODY, "", ":::faq", "### Q?", "A."]), /line 20: ":::faq" is never closed/],
    ["two :::faq blocks", draft(FIELDS, [...BODY, "", ":::faq", "### Q?", "A.", ":::", "", ":::faq", "### R?", "B.", ":::"]), /line 25: write only one ":::faq" block/],
    ["a :::faq without questions", draft(FIELDS, [...BODY, "", ":::faq", ":::"]), /":::faq" has no "### " questions/],
    ["text before the first question", draft(FIELDS, [...BODY, "", ":::faq", "Stray text", "### Q?", "A.", ":::"]), /line 21: in ":::faq", start each question with "### "/],
    ["a question without an answer", draft(FIELDS, [...BODY, "", ":::faq", "### Q?", "", "### R?", "B.", ":::"]), /the question "Q\?" has no answer/],
    ["an answer of two paragraphs", draft(FIELDS, [...BODY, "", ":::faq", "### Q?", "One.", "", "Two.", ":::"]), /the answer to "Q\?" must be one paragraph/],
    ["an invalid answer", draft(FIELDS, [...BODY, "", ":::faq", "### Q?", "An **unclosed answer", ":::"]), /faq\[0\]\.answer: line 1: Unclosed \*\*/],
  ])("is refused with %s", (_name, source, reason) => {
    const reasons = reasonsOf(source);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((line) => reason.test(line)), reasons.join("\n")).toBe(true);
  });

  it("reports a missing field once, not again as an empty value", () => {
    expect(reasonsOf(draft(without("authorRole")))).toEqual(['missing field "authorRole"']);
    expect(reasonsOf(draft(without("publishedAt")))).toEqual(['missing field "publishedAt"']);
  });

  it("checks the slug the file name gives", () => {
    expect(reasonsOf(draft(), "Test Draft.md")).toEqual(["slug must be lower-case letters, digits and single hyphens"]);
  });
});

describe("the drafts folder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guide-drafts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads every {slug}.md, skips dotfiles and other files, and reports invalid drafts by file", async () => {
    await writeFile(path.join(dir, "good-draft.md"), draft());
    await writeFile(path.join(dir, "broken-draft.md"), draft([...FIELDS, "pillar: x"]));
    await writeFile(path.join(dir, ".hidden-draft.md"), draft());
    await writeFile(path.join(dir, "README.txt"), "not a draft");
    await mkdir(path.join(dir, "folder.md"));
    const drafts = await readGuideDrafts(dir);
    expect(drafts.guides.map((guide) => guide.slug)).toEqual(["good-draft"]);
    expect(drafts.problems).toEqual([
      { file: "broken-draft.md", reasons: ['line 10: unknown field "pillar"'] },
      { file: "folder.md", reasons: [expect.stringMatching(/^the file could not be read/)] },
    ]);
  });

  it("reads the files again on every call, so a saved draft shows on the next reload", async () => {
    const file = path.join(dir, "live-draft.md");
    await writeFile(file, draft());
    expect((await readGuideDrafts(dir)).guides[0]?.title).toBe("Test draft: an invented guide");
    await writeFile(file, draft([...without("title"), "title: Edited title"]));
    expect((await readGuideDrafts(dir)).guides[0]?.title).toBe("Edited title");
  });

  it("reports an unreadable folder without its path, and never throws", async () => {
    const drafts = await readGuideDrafts(path.join(dir, "missing"));
    expect(drafts).toEqual({ guides: [], problems: [{ file: GUIDE_DRAFTS_FOLDER, reasons: ["the folder could not be read (ENOENT)"] }] });
    expect(JSON.stringify(drafts)).not.toContain(dir);
  });
});

describe("the Playwright draft fixture", () => {
  it("is a valid synthetic draft that uses every body block, and is held back from publishing", async () => {
    const file = fileURLToPath(new URL("../../e2e/fixtures/guide-drafts/sample-draft.md", import.meta.url));
    const result = parseGuideDraft("sample-draft.md", await readFile(file, "utf8"));
    if (!result.ok) throw new Error(result.reasons.join("\n"));
    const { guide } = result;
    const synthetic = new Set(buildFixtureExperiences().map((experience) => experience.slug));
    for (const slug of guide.relatedExperienceSlugs) expect(synthetic.has(slug), slug).toBe(true);
    expect(guide.title).toMatch(/\(sample draft\)$/);
    expect(new Set(parseGuideMarkdown(guide.body).map((block) => block.type))).toEqual(new Set(["paragraph", "figure", "heading", "table", "note"]));
    expect(guide.faq.some((item) => item.answer.includes("[CONFIRM:"))).toBe(true);
    expect(guidePublishProblems(guide).length).toBeGreaterThan(0);
  });
});
