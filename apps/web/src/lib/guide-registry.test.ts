import { describe, expect, it, vi, beforeEach } from "vitest";
import { SAMPLE_GUIDES, type Guide } from "@/content/guides";

const state = vi.hoisted(() => ({
  config: { guideDraftsDir: "/drafts" as string | null },
  isPreview: true,
  read: vi.fn(),
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

const { findGuide, guideCatalog, guidesAboutExperience, hasGuidesPage, indexableGuides } = await import("./guide-registry");

const [first, rainy] = SAMPLE_GUIDES as [Guide, Guide];
const edited: Guide = { ...rainy, title: "Edited in a draft (sample guide)", updatedAt: "2026-10-30" };
const fresh: Guide = { ...first, slug: "sample-new-draft", title: "A new draft (sample guide)", relatedGuideSlugs: [] };

describe("the guide catalog", () => {
  beforeEach(() => {
    state.config = { guideDraftsDir: "/drafts" };
    state.isPreview = true;
    state.read.mockReset();
  });

  it("adds the preview's drafts, a draft replacing the guide with its slug, and exposes draft slugs and problems", async () => {
    state.read.mockResolvedValue({ guides: [edited, fresh], problems: [{ file: "broken.md", reasons: ['missing field "title"'] }] });
    const catalog = await guideCatalog();
    expect(state.read).toHaveBeenCalledWith("/drafts");
    expect(catalog.guides.map((guide) => guide.title)).toEqual([edited.title, first.title, fresh.title]);
    expect(catalog.draftSlugs).toEqual([rainy.slug, fresh.slug]);
    expect(catalog.draftProblems).toEqual([{ file: "broken.md", reasons: ['missing field "title"'] }]);
    expect(await findGuide(rainy.slug)).toEqual({ guide: edited, draft: true });
    expect(await findGuide(first.slug)).toEqual({ guide: first, draft: false });
    expect((await guidesAboutExperience("evening-pottery-session")).draftSlugs).toEqual([rainy.slug, fresh.slug]);
    // The sitemap's list never reads drafts.
    expect(indexableGuides().map((guide) => guide.title)).toEqual([first.title, rainy.title]);
  });

  it("keeps the page when reading drafts fails, and shows the failure as a problem", async () => {
    state.read.mockRejectedValue(new Error("boom"));
    const catalog = await guideCatalog();
    expect(catalog.guides.map((guide) => guide.slug)).toEqual([first.slug, rainy.slug]);
    expect(catalog.draftProblems).toEqual([{ file: "GUIDE_DRAFTS_DIR", reasons: ["the drafts could not be read"] }]);
    expect(hasGuidesPage(catalog)).toBe(true);
  });

  it("reads no drafts without the setting or outside the preview", async () => {
    state.config = { guideDraftsDir: null };
    expect((await guideCatalog()).draftSlugs).toEqual([]);
    state.config = { guideDraftsDir: "/drafts" };
    state.isPreview = false;
    expect(await guideCatalog()).toEqual({ guides: [], draftSlugs: [], draftProblems: [] });
    expect(state.read).not.toHaveBeenCalled();
  });

  it("has a /guides page with guides or with draft problems only", () => {
    expect(hasGuidesPage({ guides: [], draftSlugs: [], draftProblems: [] })).toBe(false);
    expect(hasGuidesPage({ guides: [], draftSlugs: [], draftProblems: [{ file: "a.md", reasons: ["x"] }] })).toBe(true);
  });
});
