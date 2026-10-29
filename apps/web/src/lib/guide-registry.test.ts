import { describe, expect, it, vi, beforeEach } from "vitest";
import { SAMPLE_GUIDES, type Guide } from "@/content/guides";

const state = vi.hoisted(() => ({
  config: { guideDraftsDir: "/drafts" as string | null, guidePublicSource: "static" as "static" | "database" },
  isPreview: true,
  read: vi.fn(),
  repository: { listPublicArticles: vi.fn(), getPublicArticleBySlug: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({
  get config() {
    return state.config;
  },
  get isPreview() {
    return state.isPreview;
  },
}));
vi.mock("./guide-drafts", () => ({ GUIDE_DRAFTS_FOLDER: "GUIDE_DRAFTS_DIR", readGuideDrafts: state.read }));
vi.mock("./experience/store-server", () => ({ guideRepository: () => state.repository }));

const { findGuide, guideCatalog, guidesAboutExperience, hasGuidesPage, indexableGuides } = await import("./guide-registry");

const [first, rainy, day] = SAMPLE_GUIDES as [Guide, Guide, Guide];
const edited: Guide = { ...rainy, title: "Edited in a draft (sample guide)", updatedAt: "2026-10-30" };
const fresh: Guide = { ...first, slug: "sample-new-draft", title: "A new draft (sample guide)", relatedGuideSlugs: [] };

describe("the guide catalog", () => {
  beforeEach(() => {
    state.config = { guideDraftsDir: "/drafts", guidePublicSource: "static" };
    state.isPreview = true;
    state.read.mockReset();
    state.repository.listPublicArticles.mockReset();
    state.repository.getPublicArticleBySlug.mockReset();
  });

  it("adds the preview's drafts, a draft replacing the guide with its slug, and exposes draft slugs and problems", async () => {
    state.read.mockResolvedValue({ guides: [edited, fresh], problems: [{ file: "broken.md", reasons: ['missing field "title"'] }] });
    const catalog = await guideCatalog();
    expect(state.read).toHaveBeenCalledWith("/drafts");
    expect(catalog.guides.map((guide) => guide.title)).toEqual([edited.title, first.title, fresh.title, day.title]);
    expect(catalog.draftSlugs).toEqual([rainy.slug, fresh.slug]);
    expect(catalog.draftProblems).toEqual([{ file: "broken.md", reasons: ['missing field "title"'] }]);
    expect(await findGuide(rainy.slug)).toEqual({ guide: edited, draft: true });
    expect(await findGuide(first.slug)).toEqual({ guide: first, draft: false });
    expect((await guidesAboutExperience("evening-pottery-session")).draftSlugs).toEqual([rainy.slug, fresh.slug]);
    // The sitemap's list never reads drafts.
    expect((await indexableGuides()).map((guide) => guide.title)).toEqual([first.title, day.title, rainy.title]);
  });

  it("keeps the page when reading drafts fails, and shows the failure as a problem", async () => {
    state.read.mockRejectedValue(new Error("boom"));
    const catalog = await guideCatalog();
    expect(catalog.guides.map((guide) => guide.slug)).toEqual([first.slug, day.slug, rainy.slug]);
    expect(catalog.draftProblems).toEqual([{ file: "GUIDE_DRAFTS_DIR", reasons: ["the drafts could not be read"] }]);
    expect(hasGuidesPage(catalog)).toBe(true);
  });

  it("reads no drafts without the setting or outside the preview", async () => {
    state.config = { guideDraftsDir: null, guidePublicSource: "static" };
    expect((await guideCatalog()).draftSlugs).toEqual([]);
    state.config = { guideDraftsDir: "/drafts", guidePublicSource: "static" };
    state.isPreview = false;
    expect(await guideCatalog()).toEqual({ source: "static", guides: [], draftSlugs: [], draftProblems: [] });
    expect(await indexableGuides()).toEqual([]);
    expect(await findGuide("kamakura-after-4-pm")).toMatchObject({ draft: false, unlisted: true, editorialPreview: true, guide: { slug: "kamakura-after-4-pm" } });
    expect(state.read).not.toHaveBeenCalled();
  });

  it("has a /guides page with guides or with draft problems only", () => {
    expect(hasGuidesPage({ source: "static", guides: [], draftSlugs: [], draftProblems: [] })).toBe(false);
    expect(hasGuidesPage({ source: "static", guides: [], draftSlugs: [], draftProblems: [{ file: "a.md", reasons: ["x"] }] })).toBe(true);
  });

  it("uses only current database publications and preserves Admin categories without a static fallback", async () => {
    state.config = { guideDraftsDir: null, guidePublicSource: "database" };
    state.isPreview = false;
    const article = {
      articleId: "article-db",
      publicationId: 9,
      publicationNumber: 2,
      sourceRevision: 4,
      slug: "database-guide",
      subject: { kind: "WRITER" as const },
      category: { slug: "local-food", labelEn: "Local food", labelJa: "地域の食", displayOrder: 20 },
      title: "A database guide",
      description: "A current sealed publication.",
      content: { markdown: "## Eat locally\n\nSynthetic body.", author: { name: "Writer", role: "Local editor", bio: "Synthetic biography." } },
      visibility: "PUBLIC" as const,
      indexable: true,
      productLinks: [{ providerId: "provider", productId: "product", productSlug: "current-experience" }],
      cover: { assetId: "00000000-0000-4000-8000-000000000101", alt: "A synthetic cover", credit: "Photo: Synthetic", width: 1200, height: 800 },
      figures: [{ slot: 1, assetId: "00000000-0000-4000-8000-000000000102", alt: "A synthetic figure", credit: "Photo: Figure" }],
      firstPublishedAtUtc: "2026-10-20T01:00:00.000Z",
      publishedAtUtc: "2026-10-29T01:00:00.000Z",
    };
    state.repository.listPublicArticles.mockResolvedValue([article]);
    state.repository.getPublicArticleBySlug.mockResolvedValue({ ...article, visibility: "UNLISTED", indexable: false });

    const catalog = await guideCatalog();
    expect(catalog).toMatchObject({ source: "database", draftSlugs: [], draftProblems: [] });
    expect(catalog.guides[0]).toMatchObject({
      slug: "database-guide",
      category: { slug: "local-food", label: "Local food", displayOrder: 20 },
      publishedAt: "2026-10-20",
      updatedAt: "2026-10-29",
      relatedExperienceSlugs: ["current-experience"],
      hero: {
        src: "/api/public/guides/media/00000000-0000-4000-8000-000000000101",
        licensed: false,
        width: 1200,
        height: 800,
      },
      publicFigures: [{
        assetId: "00000000-0000-4000-8000-000000000102",
        src: "/api/public/guides/media/00000000-0000-4000-8000-000000000102",
        credit: "Photo: Figure",
      }],
    });
    expect(catalog.guides[0]).not.toHaveProperty("pillar");
    expect(await findGuide("database-guide")).toMatchObject({ draft: false, unlisted: true });
    expect(await findGuide("database-guide")).not.toHaveProperty("editorialPreview");
    expect((await indexableGuides()).map((guide) => guide.slug)).toEqual(["database-guide"]);
    expect(state.read).not.toHaveBeenCalled();
  });

  it("surfaces database failures instead of unioning or falling back to static guides", async () => {
    state.config = { guideDraftsDir: null, guidePublicSource: "database" };
    state.isPreview = false;
    state.repository.listPublicArticles.mockRejectedValue(new Error("database unavailable"));
    await expect(guideCatalog()).rejects.toThrow("database unavailable");
    expect(state.read).not.toHaveBeenCalled();
  });
});
