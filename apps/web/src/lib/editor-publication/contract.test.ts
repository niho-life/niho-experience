import { describe, expect, it } from "vitest";
import { GUIDE_LIMITS } from "../guides";
import {
  EditorContractError,
  editorPublicationPaths,
  GUIDE_PREVIEW_TOKEN,
  isEditorGuideSlug,
  parseEditorArticleBody,
  parseEditorPreview,
  parseEditorPublishedList,
} from "./contract";
import { EDITOR_FIXTURE } from "./fixtures/fake-editor-api";

const listItem = (overrides: Record<string, unknown> = {}) => ({
  id: "ed-1",
  slug: "a-sample-guide",
  dest: "niho-experience",
  range: "live",
  lang: "en",
  title: "A sample guide",
  lead: "A synthetic lead.",
  category: { slug: "planning", label: "Planning", order: 5 },
  author: { name: "Sample Writer", role: "Writer" },
  publishedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00.000+09:00",
  canonicalUrl: "https://elsewhere.example/ignored",
  extras: { anything: true },
  ...overrides,
});

const parseOne = (overrides: Record<string, unknown>) => parseEditorPublishedList({ items: [listItem(overrides)] });

describe("the published list (provisional contract)", () => {
  it("reads the fixture: listing fields only, other destinations ignored, violations skipped with field-name reasons", () => {
    const { items, skipped } = parseEditorPublishedList({ items: EDITOR_FIXTURE.articles });
    expect(items.map((item) => item.id)).toEqual([
      "ed-live-1", "ed-live-2", "ed-gone-1", "ed-live-3", "ed-unlisted-1",
      "ed-http-cover", "ed-script-link", "ed-duplicate-slug", "ed-foreign-figure", "ed-internal-asset",
    ]);
    expect(skipped).toEqual([
      { id: "ed-bad-range", slug: "sample-without-range", reason: "range is missing or unknown" },
      { id: "ed-bad-slug", reason: "slug is invalid or reserved" },
      { id: "ed-reserved-slug", reason: "slug is invalid or reserved" },
      { id: "ed-japanese", slug: "sample-in-japanese", reason: "lang is not en" },
    ]);
    expect(items[0]).toEqual({
      id: "ed-live-1",
      slug: "sample-evening-walk",
      range: "live",
      title: "A slow evening walk (sample guide)",
      lead: "A synthetic guide for checking the editor source: an evening route, two stops and where to sit down.",
      cover: { id: "asset-cover-1", url: "https://assets.editor.example/photos/cover-1.jpg", width: 1600, height: 1067, alt: "A quiet lane at dusk (sample photo)", credit: "Photo: Sample Studio", licensed: true },
      category: { slug: "evenings", label: "Evenings", order: 10 },
      author: { name: "Sample Writer", role: "Contributing writer (sample)", bio: "A synthetic author used only in fixtures." },
      publishedAt: "2026-10-20T01:00:00.000Z",
      updatedAt: "2026-10-30T03:00:00.000Z",
    });
    // Neither canonicalUrl nor extras is carried: the canonical URL is always built from SITE_URL.
    expect(JSON.stringify(items)).not.toContain("canonicalUrl");
    expect(items[1]!.cover?.licensed).toBe(false);
    expect(items[1]!.category).toEqual({ slug: "planning", label: "Planning" });
  });

  it("throws only when the response has no items array", () => {
    for (const body of [null, [], {}, { items: "x" }]) expect(() => parseEditorPublishedList(body)).toThrow(EditorContractError);
    expect(parseEditorPublishedList({ items: [] })).toEqual({ items: [], skipped: [] });
  });

  it("refuses unknown ranges, other languages, reserved or long slugs and over-long text, never logging a value", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ range: "LIVE" }, "range is missing or unknown"],
      [{ range: undefined }, "range is missing or unknown"],
      [{ lang: undefined }, "lang is not en"],
      [{ slug: "preview" }, "slug is invalid or reserved"],
      [{ slug: "a".repeat(81) }, "slug is invalid or reserved"],
      [{ id: "has space" }, "id is invalid"],
      [{ title: "x".repeat(GUIDE_LIMITS.titleMaxLength + 1) }, `title is longer than ${GUIDE_LIMITS.titleMaxLength} characters`],
      [{ lead: "" }, "lead is missing"],
      [{ category: { slug: "Bad Slug", label: "x" } }, "category.slug is invalid"],
      [{ category: { slug: "ok", label: "x", order: 1.5 } }, "category.order is not an integer"],
      [{ author: { name: "Sample" } }, "author.role is missing"],
      [{ publishedAt: "2026-02-30T00:00:00Z" }, "publishedAt is not an ISO 8601 date-time"],
      [{ updatedAt: "yesterday" }, "updatedAt is not an ISO 8601 date-time"],
      [{ cover: { id: "c", url: "https://assets.editor.example/a.jpg", width: 0, height: 10, alt: "x" } }, "cover.width is not a positive integer"],
      [{ cover: { id: "c", url: "https://assets.editor.example/a.jpg", width: 10, height: 10 } }, "cover.alt is missing"],
    ];
    for (const [overrides, reason] of cases) expect(parseOne(overrides).skipped, reason).toEqual([expect.objectContaining({ reason })]);
    expect(parseOne({ dest: undefined }).skipped).toEqual([{ id: "ed-1", slug: "a-sample-guide", reason: "dest is missing" }]);
    expect(parseOne({ dest: "elsewhere" })).toEqual({ items: [], skipped: [] });
    // A malformed slug is not echoed into the log.
    expect(parseOne({ slug: "<script>" }).skipped).toEqual([{ id: "ed-1", reason: "slug is invalid or reserved" }]);
  });

  it("accepts the limits exactly, trims text and treats only licensed: true as licensed", () => {
    const { items } = parseOne({
      title: ` ${"t".repeat(GUIDE_LIMITS.titleMaxLength)} `,
      lead: "l".repeat(GUIDE_LIMITS.descriptionMaxLength),
      cover: { id: "c", url: "https://assets.editor.example/a.jpg", width: 10, height: 10, alt: "x", licensed: "yes" },
      category: { slug: "planning", label: "Planning", order: null },
    });
    expect(items[0]).toMatchObject({ title: "t".repeat(GUIDE_LIMITS.titleMaxLength), cover: { licensed: false }, category: { slug: "planning", label: "Planning" } });
    expect(items[0]!.category).not.toHaveProperty("order");
  });
});

describe("a published body", () => {
  const full = (overrides: Record<string, unknown> = {}) => ({ ...listItem(), markdown: "## A\n\nText.", blocks: [{ any: "shape" }], assets: [], related: [], ...overrides });

  it("reads the body only, with related slugs de-duplicated and filtered", () => {
    expect(parseEditorArticleBody(full({ related: ["b-one", "b-one", "Not A Slug", 3, "c-two"], checkedOn: "2026-10-01" }), "ed-1")).toEqual({
      ok: true,
      body: { markdown: "## A\n\nText.", assets: [], related: ["b-one", "c-two"], checkedOn: "2026-10-01" },
    });
  });

  it("refuses a body for another ID or destination, without Markdown, or with malformed assets", () => {
    expect(parseEditorArticleBody(full(), "ed-2")).toEqual({ ok: false, reason: "id does not match the list" });
    expect(parseEditorArticleBody(full({ dest: "niho" }), "ed-1")).toEqual({ ok: false, reason: "dest is not this site" });
    expect(parseEditorArticleBody(full({ markdown: undefined }), "ed-1")).toEqual({ ok: false, reason: "markdown is missing" });
    expect(parseEditorArticleBody(full({ assets: [{ id: "a" }] }), "ed-1")).toEqual({ ok: false, reason: "assets[0].url is missing" });
    expect(parseEditorArticleBody(full({ related: "x" }), "ed-1")).toEqual({ ok: false, reason: "related is not a list" });
    expect(parseEditorArticleBody(full({ checkedOn: "2026-13-01" }), "ed-1")).toEqual({ ok: false, reason: "checkedOn is not a YYYY-MM-DD date" });
    expect(parseEditorArticleBody("<html>", "ed-1")).toEqual({ ok: false, reason: "the article is not an object" });
  });
});

describe("a preview draft", () => {
  it("needs only a title and Markdown; malformed optional fields count as missing", () => {
    expect(parseEditorPreview(EDITOR_FIXTURE.previews["synthetic-preview-token-0001"])).toEqual({
      ok: true,
      preview: { title: "An unfinished draft (sample)", markdown: "Opening paragraph without a heading. [CONFIRM: opening hours]\n", assets: [], related: [] },
    });
    expect(parseEditorPreview({ title: "T", markdown: "", slug: "Bad", cover: { url: 5 }, author: { name: "" }, category: "x", related: ["ok-slug", "No"] })).toEqual({
      ok: true,
      preview: { title: "T", markdown: "", assets: [], related: ["ok-slug"] },
    });
  });

  it("refuses a draft without a title or body, and marks another destination's draft as foreign", () => {
    expect(parseEditorPreview({ markdown: "x" })).toMatchObject({ ok: false });
    expect(parseEditorPreview({ title: "T" })).toMatchObject({ ok: false });
    expect(parseEditorPreview(EDITOR_FIXTURE.previews["synthetic-preview-token-0003"])).toMatchObject({ ok: false, foreign: true });
  });
});

describe("paths and identifiers", () => {
  it("encodes every path segment and reserves the preview slug", () => {
    expect(editorPublicationPaths.list("sample-site")).toBe("/sample-site/published.json");
    expect(editorPublicationPaths.article("sample-site", "a/b")).toBe("/sample-site/published/a%2Fb.json");
    expect(editorPublicationPaths.preview("abc_DEF-123")).toBe("/preview/abc_DEF-123.json");
    expect(isEditorGuideSlug("preview")).toBe(false);
    expect(isEditorGuideSlug("preview-of-autumn")).toBe(true);
  });

  it("accepts only well-formed preview tokens", () => {
    expect(GUIDE_PREVIEW_TOKEN.test("a".repeat(16))).toBe(true);
    expect(GUIDE_PREVIEW_TOKEN.test("a".repeat(15))).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test("a".repeat(257))).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test("abcdefghijklmnop/../x")).toBe(false);
  });
});
