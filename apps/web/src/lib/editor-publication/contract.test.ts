import { describe, expect, it } from "vitest";
import { GUIDE_LIMITS } from "../guides";
import {
  EditorContractError,
  editorCategoryLabel,
  editorPublicationPaths,
  GUIDE_PREVIEW_TOKEN,
  isEditorGuideSlug,
  parseEditorArticleBody,
  parseEditorPreview,
  parseEditorPublishedList,
} from "./contract";
import { EDITOR_FIXTURE, fixtureId } from "./fixtures/fake-editor-api";

const ID = "0e000000-0000-4000-8000-0000000000aa";
const cover = (overrides: Record<string, unknown> = {}) => ({
  id: "c", url: "https://assets.editor.example/a.jpg", contentType: "image/jpeg", bytes: 10, sha256: "ab".repeat(32), alt: "x", credit: null, ...overrides,
});
const listItem = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  slug: "a-sample-guide",
  dest: "exp",
  lang: "en",
  title: "A sample guide",
  lead: "A synthetic lead.",
  cover: null,
  category: "planning",
  author: { name: "Sample Writer", handle: "sample-writer", url: "https://writer.example/" },
  range: "live",
  version: 1,
  publishedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  canonicalUrl: "https://elsewhere.example/ignored",
  extras: { app: false, news: false, xp: true },
  related: [],
  ...overrides,
});
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ contractVersion: "1", items, nextCursor: null, ...extra });
/** The fixture's list as one page: list fields and body fields alike (the body fields are not read). */
const fixturePage = () => page(EDITOR_FIXTURE.articles.map((article) => Object.fromEntries(Object.entries(article).filter(([key]) => !key.startsWith("$")))));
const parseOne = (overrides: Record<string, unknown>) => parseEditorPublishedList(page([listItem(overrides)]));

describe("the published list (contract v1)", () => {
  it("reads the fixture: listing fields only, violations skipped with field-name reasons", () => {
    const { items, skipped, nextCursor } = parseEditorPublishedList(fixturePage());
    expect(nextCursor).toBeNull();
    expect(items.map((item) => item.id)).toEqual(
      ["live-1", "live-2", "gone-1", "moved-1", "live-3", "unlisted-1", "http-cover", "script-link", "duplicate-slug", "foreign-figure", "internal-asset"].map(fixtureId),
    );
    expect(skipped).toEqual([
      { id: fixtureId("other-dest"), slug: "sample-for-another-site", reason: "dest is not exp" },
      { id: fixtureId("bad-range"), slug: "sample-without-range", reason: "range is missing or unknown" },
      { id: fixtureId("bad-slug"), reason: "slug is invalid or reserved" },
      { id: fixtureId("reserved-slug"), reason: "slug is invalid or reserved" },
      { id: fixtureId("japanese"), slug: "sample-in-japanese", reason: "lang is not en" },
      { id: fixtureId("no-category"), slug: "sample-without-category", reason: "category is missing" },
      { id: fixtureId("no-lead"), slug: "sample-without-lead", reason: "lead is missing" },
    ]);
    expect(items[0]).toEqual({
      id: fixtureId("live-1"),
      slug: "sample-evening-walk",
      range: "live",
      title: "A slow evening walk (sample guide)",
      lead: "A synthetic guide for checking the editor source: an evening route, two stops and where to sit down.",
      cover: { id: "asset-cover-1", url: "https://assets.editor.example/photos/cover-1.jpg", alt: "A quiet lane at dusk (sample photo)", credit: "Photo: Sample Studio" },
      category: { slug: "evenings", label: "Evenings" },
      author: { name: "Sample Writer" },
      related: ["evening-pottery-session", "home-cooked-dinner-with-locals"],
      publishedAt: "2026-10-20T01:00:00.000Z",
      updatedAt: "2026-10-30T03:00:00.000Z",
    });
    // Neither canonicalUrl, extras nor the author's handle and URL is carried: canonical URLs come from SITE_URL.
    expect(JSON.stringify(items)).not.toMatch(/canonicalUrl|extras|sample-writer|writer\.example/);
    // An empty alt stays empty; a null credit is no caption; a two-word category gets a readable label.
    expect(items[1]).toMatchObject({ cover: { alt: "" }, category: { slug: "day-trips", label: "Day trips" } });
    expect(items[1]!.cover).not.toHaveProperty("credit");
    expect(items[1]!.category).not.toHaveProperty("order");
    expect(items[4]).not.toHaveProperty("cover");
  });

  it("throws when the response is not a v1 page at all", () => {
    for (const body of [null, [], {}, { items: [] }, page([], { contractVersion: "2" }), page([], { contractVersion: 1 }), page([], { contractVersion: undefined }), page("x" as unknown as unknown[])]) {
      expect(() => parseEditorPublishedList(body), JSON.stringify(body)).toThrow(EditorContractError);
    }
    // A page holds 100 items at most.
    expect(() => parseEditorPublishedList(page(Array.from({ length: 101 }, () => listItem())))).toThrow(/more than 100 items/);
    expect(parseEditorPublishedList(page(Array.from({ length: 100 }, () => listItem()))).items).toHaveLength(100);
    // nextCursor is null or an opaque cursor; missing, empty or with other characters is not the contract.
    for (const nextCursor of [undefined, "", "a b", "a/b", "x".repeat(513), 5]) {
      expect(() => parseEditorPublishedList(page([], { nextCursor })), String(nextCursor)).toThrow(/nextCursor/);
    }
    expect(parseEditorPublishedList(page([], { nextCursor: "c1.1789722000000.2c3d4e5f-6071-4829-a3b4-c5d6e7f8091a" }))).toEqual({
      items: [], skipped: [], nextCursor: "c1.1789722000000.2c3d4e5f-6071-4829-a3b4-c5d6e7f8091a",
    });
  });

  it("refuses unknown ranges and destinations, other languages, missing listing fields and over-long text, never logging a value", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ dest: undefined }, "dest is missing"],
      [{ dest: "niho" }, "dest is not exp"],
      [{ dest: "site" }, "dest is not exp"],
      [{ range: "LIVE" }, "range is missing or unknown"],
      [{ range: undefined }, "range is missing or unknown"],
      [{ lang: undefined }, "lang is not en"],
      [{ lang: "ja" }, "lang is not en"],
      [{ slug: "preview" }, "slug is invalid or reserved"],
      [{ slug: "a".repeat(81) }, "slug is invalid or reserved"],
      [{ id: "ed-1" }, "id is invalid"],
      [{ id: ID.toUpperCase() }, "id is invalid"],
      [{ title: "x".repeat(GUIDE_LIMITS.titleMaxLength + 1) }, `title is longer than ${GUIDE_LIMITS.titleMaxLength} characters`],
      [{ lead: null }, "lead is missing"],
      [{ lead: "" }, "lead is missing"],
      [{ lead: "l".repeat(GUIDE_LIMITS.descriptionMaxLength + 1) }, `lead is longer than ${GUIDE_LIMITS.descriptionMaxLength} characters`],
      [{ category: null }, "category is missing"],
      [{ category: "Not A Slug" }, "category is not a slug"],
      [{ category: { slug: "planning", label: "Planning" } }, "category is not a slug"],
      [{ author: undefined }, "author is missing"],
      [{ author: { name: "", handle: null, url: null } }, "author.name is missing"],
      [{ author: { name: "x".repeat(GUIDE_LIMITS.authorMaxLength + 1), handle: null, url: null } }, `author.name is longer than ${GUIDE_LIMITS.authorMaxLength} characters`],
      [{ author: { name: "Sample", handle: 5, url: null } }, "author.handle is not text or null"],
      [{ author: { name: "Sample", url: null } }, "author.handle is not text or null"],
      [{ author: { name: "Sample", handle: null, url: {} } }, "author.url is not text or null"],
      [{ related: "x" }, "related is not a list"],
      [{ publishedAt: "2026-02-30T00:00:00Z" }, "publishedAt is not an ISO 8601 date-time"],
      [{ updatedAt: "yesterday" }, "updatedAt is not an ISO 8601 date-time"],
      [{ cover: "https://assets.editor.example/a.jpg" }, "cover is not an object"],
      [{ cover: cover({ id: "has space" }) }, "cover.id is invalid"],
      [{ cover: cover({ url: "" }) }, "cover.url is missing"],
      [{ cover: cover({ url: `https://assets.editor.example/${"a".repeat(2048)}` }) }, "cover.url is missing"],
      [{ cover: cover({ contentType: "image/svg+xml" }) }, "cover.contentType is not a supported image type"],
      [{ cover: cover({ contentType: "audio/mpeg" }) }, "cover.contentType is not a supported image type"],
      [{ cover: cover({ bytes: 0 }) }, "cover.bytes is not a positive integer"],
      [{ cover: cover({ bytes: 1.5 }) }, "cover.bytes is not a positive integer"],
      [{ cover: cover({ sha256: "AB".repeat(32) }) }, "cover.sha256 is invalid"],
      [{ cover: cover({ alt: null }) }, "cover.alt is not text"],
      [{ cover: cover({ credit: "" }) }, "cover.credit is missing"],
      [{ cover: cover({ credit: "c".repeat(GUIDE_LIMITS.captionMaxLength + 1) }) }, `cover.credit is longer than ${GUIDE_LIMITS.captionMaxLength} characters`],
    ];
    for (const [overrides, reason] of cases) expect(parseOne(overrides).skipped, reason).toEqual([expect.objectContaining({ reason })]);
    expect(parseOne({ dest: "niho" }).skipped).toEqual([{ id: ID, slug: "a-sample-guide", reason: "dest is not exp" }]);
    // A malformed slug or ID is not echoed into the log.
    expect(parseOne({ slug: "<script>" }).skipped).toEqual([{ id: ID, reason: "slug is invalid or reserved" }]);
    expect(parseOne({ id: "<script>" }).skipped).toEqual([{ slug: "a-sample-guide", reason: "id is invalid" }]);
    expect(parseEditorPublishedList(page(["x"])).skipped).toEqual([{ reason: "the item is not an object" }]);
  });

  it("accepts the limits exactly, trims text, de-duplicates related slugs and reads the author's name only", () => {
    const { items } = parseOne({
      title: ` ${"t".repeat(GUIDE_LIMITS.titleMaxLength)} `,
      lead: "l".repeat(GUIDE_LIMITS.descriptionMaxLength),
      cover: cover({ alt: "", credit: " Photo: Sample " }),
      category: "day-trips",
      author: { name: " Sample Writer ", handle: null, url: null },
      related: ["b-one", "b-one", "Not A Slug", 3, "c-two"],
    });
    expect(items[0]).toMatchObject({
      title: "t".repeat(GUIDE_LIMITS.titleMaxLength),
      cover: { alt: "", credit: "Photo: Sample" },
      category: { slug: "day-trips", label: "Day trips" },
      author: { name: "Sample Writer" },
      related: ["b-one", "c-two"],
    });
    expect(items[0]!.author).toEqual({ name: "Sample Writer" });
    expect(items[0]!.cover).toEqual({ id: "c", url: "https://assets.editor.example/a.jpg", alt: "", credit: "Photo: Sample" });
  });

  it("labels a category from its slug", () => {
    expect(editorCategoryLabel("walks")).toBe("Walks");
    expect(editorCategoryLabel("day-trips")).toBe("Day trips");
    expect(editorCategoryLabel("a-b-c")).toBe("A b c");
  });
});

describe("a published body", () => {
  const full = (overrides: Record<string, unknown> = {}) => ({ ...listItem(), contractVersion: "1", markdown: "## A\n\nText.", blocks: [{ type: "paragraph", content: [] }], assets: [cover({ id: "f" })], ...overrides });

  it("reads the body only: the Markdown and the assets", () => {
    expect(parseEditorArticleBody(full({ related: ["ignored-here"] }), ID)).toEqual({
      ok: true,
      body: { markdown: "## A\n\nText.", assets: [{ id: "f", url: "https://assets.editor.example/a.jpg", alt: "x" }] },
    });
  });

  it("refuses a body for another ID, destination or contract version, without Markdown, blocks or well-formed assets", () => {
    expect(parseEditorArticleBody(full(), "0e000000-0000-4000-8000-0000000000bb")).toEqual({ ok: false, reason: "id does not match the list" });
    expect(parseEditorArticleBody(full({ dest: "niho" }), ID)).toEqual({ ok: false, reason: "dest is not exp" });
    expect(parseEditorArticleBody(full({ contractVersion: "2" }), ID)).toEqual({ ok: false, reason: "contractVersion is not 1" });
    expect(parseEditorArticleBody(full({ contractVersion: undefined }), ID)).toEqual({ ok: false, reason: "contractVersion is not 1" });
    expect(parseEditorArticleBody(full({ markdown: undefined }), ID)).toEqual({ ok: false, reason: "markdown is missing" });
    expect(parseEditorArticleBody(full({ blocks: undefined }), ID)).toEqual({ ok: false, reason: "blocks is not a list" });
    expect(parseEditorArticleBody(full({ assets: undefined }), ID)).toEqual({ ok: false, reason: "assets is not a list" });
    expect(parseEditorArticleBody(full({ assets: [{ id: "a" }] }), ID)).toEqual({ ok: false, reason: "assets[0].url is missing" });
    expect(parseEditorArticleBody(full({ assets: [cover({ sha256: "x" })] }), ID)).toEqual({ ok: false, reason: "assets[0].sha256 is invalid" });
    expect(parseEditorArticleBody("<html>", ID)).toEqual({ ok: false, reason: "the article is not an object" });
  });
});

describe("a preview draft", () => {
  const DRAFT = "pv_synthetic-preview-not-a-secret-draft-000001";
  const draft = (overrides: Record<string, unknown> = {}) => ({ ...EDITOR_FIXTURE.previews[DRAFT], ...overrides });

  it("needs only a title and Markdown; missing or malformed optional fields count as not written yet", () => {
    expect(parseEditorPreview(draft())).toEqual({
      ok: true,
      preview: {
        title: "An unfinished draft (sample)",
        markdown: "Opening paragraph without a heading\\. [CONFIRM: opening hours]\n",
        slug: "sample-unfinished-draft",
        author: { name: "Sample Writer" },
        assets: [],
        related: [],
        publishedAt: "2026-10-30T23:50:00.000Z",
      },
    });
    expect(parseEditorPreview(draft({
      title: "T", markdown: "", slug: "Bad", lead: null, cover: { url: 5 }, author: { name: "" }, category: "Not A Slug", related: ["ok-slug", "No"], assets: [cover({ id: "f" }), { id: "broken" }], publishedAt: "soon",
    }))).toEqual({
      ok: true,
      preview: { title: "T", markdown: "", assets: [{ id: "f", url: "https://assets.editor.example/a.jpg", alt: "x" }], related: ["ok-slug"] },
    });
    expect(parseEditorPreview(draft({ category: "walks", lead: "A lead.", related: "x" }))).toMatchObject({ ok: true, preview: { category: { slug: "walks", label: "Walks" }, lead: "A lead.", related: [] } });
  });

  it("refuses a draft without a title or body, or of another contract version; another destination's draft is foreign", () => {
    expect(parseEditorPreview(draft({ title: undefined }))).toEqual({ ok: false, reason: "The draft has no title yet." });
    expect(parseEditorPreview(draft({ markdown: undefined }))).toEqual({ ok: false, reason: "The draft has no body." });
    for (const contractVersion of ["2", undefined]) {
      expect(parseEditorPreview(draft({ contractVersion }))).toEqual({ ok: false, reason: "The preview is not contract version 1 (contractVersion)." });
    }
    expect(parseEditorPreview(EDITOR_FIXTURE.previews["pv_synthetic-preview-not-a-secret-draft-000003"])).toMatchObject({ ok: false, foreign: true });
    // Both the draft's dest and the token's dest must be this site.
    expect(parseEditorPreview(draft({ preview: { expiresAt: "2026-10-31T00:05:00.000Z", dest: "niho", noindex: true } }))).toMatchObject({ ok: false, foreign: true });
    expect(parseEditorPreview(draft({ preview: undefined }))).toMatchObject({ ok: false, foreign: true });
    expect(parseEditorPreview(draft({ dest: undefined }))).toMatchObject({ ok: false, foreign: true });
    expect(parseEditorPreview("<html>")).toEqual({ ok: false, reason: "The preview is not an object." });
  });
});

describe("paths and identifiers", () => {
  it("asks for the largest page with unlisted entries, encodes every path segment and the cursor, and reserves the preview slug", () => {
    expect(editorPublicationPaths.list("exp")).toBe("/exp/published.json?limit=100&include=unlisted");
    expect(editorPublicationPaths.list("exp", { cursor: "c1.17~x-y_z" })).toBe("/exp/published.json?limit=100&include=unlisted&cursor=c1.17~x-y_z");
    expect(editorPublicationPaths.list("exp", { cursor: "a&b=c" })).toBe("/exp/published.json?limit=100&include=unlisted&cursor=a%26b%3Dc");
    expect(editorPublicationPaths.article("exp", "a/b")).toBe("/exp/published/a%2Fb.json");
    expect(editorPublicationPaths.preview("pv_abc")).toBe("/preview/pv_abc.json");
    expect(isEditorGuideSlug("preview")).toBe(false);
    expect(isEditorGuideSlug("preview-of-autumn")).toBe(true);
  });

  it("accepts only pv_ preview tokens of 43 base64url characters", () => {
    expect(GUIDE_PREVIEW_TOKEN.test(`pv_${"a".repeat(43)}`)).toBe(true);
    expect(GUIDE_PREVIEW_TOKEN.test(`pv_${"A1_-".repeat(10)}abc`)).toBe(true);
    expect(GUIDE_PREVIEW_TOKEN.test(`pv_${"a".repeat(42)}`)).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test(`pv_${"a".repeat(44)}`)).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test("a".repeat(46))).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test(`ek_${"a".repeat(43)}`)).toBe(false);
    expect(GUIDE_PREVIEW_TOKEN.test(`pv_${"a".repeat(40)}/..`)).toBe(false);
    for (const token of [...Object.keys(EDITOR_FIXTURE.previews), ...EDITOR_FIXTURE.expiredPreviewTokens]) expect(GUIDE_PREVIEW_TOKEN.test(token), token).toBe(true);
  });
});
