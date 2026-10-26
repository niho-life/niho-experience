import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareGuides, formatGuideDate, guidesByPillar, guidesForExperience, parseGuide, relatedGuides } from "./guide";
import { loadGuides, readGuideDirectory } from "./load";
import { resolveConfig } from "../resolve-config";
import type { Guide } from "./types";

const PUBLISHED_DIR = fileURLToPath(new URL("../../../content/guides", import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));

function manuscript(overrides: Record<string, string | undefined> = {}, body = "Kamakura empties out after the temples close.\n\n## The beach\n\nWalk west.\n") {
  const values: Record<string, string | undefined> = {
    title: "A sample evening",
    description: "A synthetic guide for tests.",
    pillar: "evening",
    author: "Sample Author",
    authorRole: "Sample role, NIHO kamakura",
    published: "2026-11-10",
    updated: "2026-11-10",
    hero: "/guides/media/sample-dusk.jpg",
    heroAlt: "A beach at dusk",
    experiences: "home-cooked-dinner-with-locals",
    ...overrides,
  };
  const front = Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${front}\n---\n${body}`;
}

const guide = (slug: string, overrides: Partial<Guide> = {}): Guide => ({
  slug, title: slug, description: "", pillar: "evening", type: "guide", author: "A", authorRole: "R", published: "2026-11-01", updated: "2026-11-01",
  factsChecked: null, hero: "/h.jpg", heroAlt: "h", heroCredit: null, experiences: [], related: [], body: [], headings: [], draft: false, ...overrides,
});

describe("parseGuide", () => {
  it("reads a manuscript into its metadata and body", () => {
    const result = parseGuide("sample-evening.md", manuscript(), { draft: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.guide).toMatchObject({ slug: "sample-evening", title: "A sample evening", type: "guide", draft: false, headings: [{ id: "the-beach", text: "The beach" }] });
    expect(result.guide.body).toHaveLength(3);
  });

  it("collects front matter and body problems together", () => {
    const result = parseGuide("sample.md", manuscript({ pillar: "food" }, "# Title\n"), { draft: true });
    expect(result).toEqual({ ok: false, reasons: ['"pillar" must be one of evening, zazen, crafts, planning, hosts', 'line 13: "#" (h1) is not used in the body; the title is the page heading'] });
    expect(parseGuide("sample.md", "No front matter", { draft: true })).toEqual({ ok: false, reasons: ['the file must start with front matter between two "---" lines'] });
  });

  it("lets drafts keep facts to confirm, stand-in photos and photos from other sites", () => {
    const draft = manuscript({ hero: "/sample/dusk.jpg", description: "Opens [CONFIRM: 9 am]" }, "Text [CONFIRM: price].\n\n![A gate](https://images.example/gate.jpg)\n");
    expect(parseGuide("sample.md", draft, { draft: true }).ok).toBe(true);
  });

  it("refuses to publish a manuscript that is not ready", () => {
    const reasons = (source: string) => {
      const result = parseGuide("sample.md", source, { draft: false });
      return result.ok ? [] : result.reasons;
    };
    expect(reasons(manuscript({}, "Opens at [CONFIRM: 9 am].\n"))).toEqual(["[CONFIRM: …] is still in the text: check the fact and remove the marker before publishing"]);
    expect(reasons(manuscript({ heroCredit: "[confirm: who took it]" }))).toHaveLength(1);
    expect(reasons(manuscript({ hero: "/sample/dusk.jpg" }))).toEqual(['photo "/sample/dusk.jpg" is a /sample/ stand-in: use the approved photo']);
    expect(reasons(manuscript({ hero: "/guides/../sample/dusk.jpg" }))).toEqual(['photo "/guides/../sample/dusk.jpg" is a /sample/ stand-in: use the approved photo']);
    expect(reasons(manuscript({ hero: "https://images.example/dusk.jpg" }))).toEqual(['photo "https://images.example/dusk.jpg" is on another site: put the approved photo in apps/web/public/guides/media/']);
    expect(reasons(manuscript({}, "Text.\n\n![A gate](/sample/gate.jpg)\n\n![A lane](https://images.example/lane.jpg)\n"))).toEqual([
      'photo "/sample/gate.jpg" is a /sample/ stand-in: use the approved photo',
      'photo "https://images.example/lane.jpg" is on another site: put the approved photo in apps/web/public/guides/media/',
    ]);
    expect(reasons(manuscript())).toEqual([]);
  });
});

describe("guide lists", () => {
  const pillarOld = guide("pillar-old", { type: "pillar", updated: "2026-10-01", experiences: ["dinner"] });
  const newest = guide("newest", { updated: "2026-11-20", experiences: ["dinner", "pottery"] });
  const older = guide("older", { updated: "2026-11-02", experiences: ["dinner"] });
  const crafts = guide("crafts", { pillar: "crafts", experiences: ["dinner"] });
  const all = [older, crafts, newest, pillarOld];

  it("puts pillar articles first, then the most recently updated", () => {
    expect([...all].sort(compareGuides).map((item) => item.slug)).toEqual(["pillar-old", "newest", "older", "crafts"]);
  });

  it("groups guides by pillar in the index order and leaves empty pillars out", () => {
    expect(guidesByPillar(all).map((section) => [section.pillar, section.guides.map((item) => item.slug)])).toEqual([
      ["evening", ["pillar-old", "newest", "older"]],
      ["crafts", ["crafts"]],
    ]);
  });

  it("finds at most three guides that recommend an experience", () => {
    expect(guidesForExperience(all, "dinner").map((item) => item.slug)).toEqual(["pillar-old", "newest", "older"]);
    expect(guidesForExperience(all, "pottery").map((item) => item.slug)).toEqual(["newest"]);
    expect(guidesForExperience(all, "cycling")).toEqual([]);
  });

  it("shows only the related guides that were read, in the author's order", () => {
    expect(relatedGuides(guide("x", { related: ["older", "missing", "newest"] }), all).map((item) => item.slug)).toEqual(["older", "newest"]);
  });

  it("writes dates as day, short month and year", () => {
    expect(formatGuideDate("2026-11-10")).toBe("10 Nov 2026");
    expect(formatGuideDate("2027-01-02")).toBe("2 Jan 2027");
  });
});

describe("guide folders", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "guides-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const folder = async (name: string, files: Record<string, string>) => {
    const dir = path.join(root, name);
    await mkdir(dir);
    for (const [file, source] of Object.entries(files)) await writeFile(path.join(dir, file), source);
    return dir;
  };

  it("throws on an invalid published file and ignores files that are not manuscripts", async () => {
    const dir = await folder("published", { ".gitkeep": "", "notes.txt": "x", "bad.md": manuscript({ title: undefined }) });
    await expect(readGuideDirectory(dir, false)).rejects.toThrow('Published guide bad.md is not valid: "title" is required');
    await expect(readGuideDirectory(path.join(root, "missing"), false)).rejects.toThrow(/could not be read/);
  });

  it("merges drafts over published guides and reports drafts that cannot be shown", async () => {
    const published = await folder("published", { "same-slug.md": manuscript({ title: "Published version" }), "only-published.md": manuscript() });
    const drafts = await folder("drafts", { "same-slug.md": manuscript({ title: "Draft version", hero: "/sample/dusk.jpg" }), "Bad_Name.md": manuscript(), "broken.md": manuscript({ pillar: "food" }) });
    const { guides, draftProblems } = await loadGuides({ publishedDir: published, draftsDir: drafts });
    expect(guides.map((item) => [item.slug, item.title, item.draft])).toEqual(expect.arrayContaining([["same-slug", "Draft version", true], ["only-published", "A sample evening", false]]));
    expect(guides).toHaveLength(2);
    expect(draftProblems).toEqual([
      { file: "Bad_Name.md", reasons: ['file name "Bad_Name.md" must be lowercase letters, digits and single hyphens'] },
      { file: "broken.md", reasons: ['"pillar" must be one of evening, zazen, crafts, planning, hosts'] },
    ]);
  });

  it("re-reads drafts on every call, so an edit shows on the next request", async () => {
    const published = await folder("published", {});
    const drafts = await folder("drafts", { "edit-me.md": manuscript({ title: "First" }) });
    expect((await loadGuides({ publishedDir: published, draftsDir: drafts })).guides[0]?.title).toBe("First");
    await writeFile(path.join(drafts, "edit-me.md"), manuscript({ title: "Second" }));
    expect((await loadGuides({ publishedDir: published, draftsDir: drafts })).guides[0]?.title).toBe("Second");
  });

  it("reads drafts only in the mock preview: http mode never gets a drafts folder", async () => {
    const published = await folder("published", {});
    const drafts = await folder("drafts", { "secret-draft.md": manuscript() });
    const http = resolveConfig({ EXPERIENCE_API_MODE: "http", GUIDE_DRAFTS_DIR: drafts });
    expect(await loadGuides({ publishedDir: published, draftsDir: http.guideDraftsDir })).toEqual({ guides: [], draftProblems: [] });
    const mock = resolveConfig({ EXPERIENCE_API_MODE: "mock", GUIDE_DRAFTS_DIR: drafts });
    expect((await loadGuides({ publishedDir: published, draftsDir: mock.guideDraftsDir })).guides.map((item) => item.slug)).toEqual(["secret-draft"]);
  });

  it("reports a drafts folder that cannot be read instead of failing the page", async () => {
    const published = await folder("published", {});
    expect(await loadGuides({ publishedDir: published, draftsDir: path.join(root, "missing") })).toEqual({ guides: [], draftProblems: [{ file: "GUIDE_DRAFTS_DIR", reasons: ["the drafts folder could not be read"] }] });
  });
});

describe("published guides in this repository", () => {
  it("are all valid and ready to publish (passes with no guides yet)", async () => {
    const { guides } = await readGuideDirectory(PUBLISHED_DIR, false);
    const files = (await readdir(PUBLISHED_DIR)).filter((name) => name.endsWith(".md"));
    expect(guides).toHaveLength(files.length);
  });

  it("use photos that exist in apps/web/public", async () => {
    const { guides } = await readGuideDirectory(PUBLISHED_DIR, false);
    const images = guides.flatMap((item) => [item.hero, ...collectImages(item.body)]);
    for (const src of images) {
      await expect(stat(path.join(PUBLIC_DIR, decodeURIComponent(src.split(/[?#]/)[0]!))).then((file) => file.isFile()), src).resolves.toBe(true);
    }
  });
});

function collectImages(blocks: Guide["body"]): string[] {
  return blocks.flatMap((block) => (block.type === "figure" ? [block.src] : block.type === "note" ? collectImages(block.blocks) : block.type === "faq" ? block.items.flatMap((item) => collectImages(item.answer)) : []));
}
