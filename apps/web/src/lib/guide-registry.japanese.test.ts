import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicGuideArticle } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  config: { guideDraftsDir: null as string | null, guidePublicSource: "database" as "static" | "database" },
  repository: { listPublicArticles: vi.fn(), getPublicArticleBySlug: vi.fn() } as { listPublicArticles: ReturnType<typeof vi.fn>; getPublicArticleBySlug: ReturnType<typeof vi.fn> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({ get config() { return state.config; }, isPreview: false }));
vi.mock("./guide-drafts", () => ({ GUIDE_DRAFTS_FOLDER: "GUIDE_DRAFTS_DIR", readGuideDrafts: vi.fn() }));
vi.mock("./experience/store-server", () => ({ guideRepository: () => state.repository }));

const { findGuide, findJapaneseGuide, guideCatalog, indexableGuides, japaneseGuides } = await import("./guide-registry");

/** 読みもの (#154): a guide written in Japanese belongs to the Japanese site; the English site never lists or opens it. */
const article = (slug: string, language: "en" | "ja", over: Partial<PublicGuideArticle> = {}): PublicGuideArticle => ({
  articleId: slug, publicationId: 1, publicationNumber: 1, sourceRevision: 1, slug, subject: { kind: "PROVIDER", providerId: "provider-a" },
  category: { slug: "walks", labelEn: "Walks", labelJa: "歩く", displayOrder: 1 },
  title: language === "ja" ? "雨の日の鎌倉" : "A rainy day", description: language === "ja" ? "雨の日の過ごし方。" : "How to spend a rainy day.",
  content: { language, markdown: language === "ja" ? "## 屋根の下で\n\n本文です。" : "## Under a roof\n\nBody.", author: { name: "合成 花子", role: "合成のホスト", bio: "紹介" } },
  visibility: "PUBLIC", indexable: true, productLinks: [{ providerId: "provider-a", productId: "tea", productSlug: "synthetic-tea" }], figures: [],
  firstPublishedAtUtc: "2026-11-14T00:00:00.000Z", publishedAtUtc: "2026-11-14T00:00:00.000Z", ...over,
});

describe("Japanese guides in the guide registry", () => {
  beforeEach(() => {
    state.config = { guideDraftsDir: null, guidePublicSource: "database" };
    state.repository = { listPublicArticles: vi.fn(async () => [article("en-guide", "en"), article("ja-guide", "ja"), article("ja-unlisted", "ja", { indexable: false })]), getPublicArticleBySlug: vi.fn(async (slug: string) => article(slug, slug.startsWith("ja") ? "ja" : "en")) };
  });

  it("keeps a Japanese guide out of the English catalog, the English reader and the sitemap list", async () => {
    expect((await guideCatalog()).guides.map((guide) => guide.slug)).toEqual(["en-guide"]);
    expect((await indexableGuides()).map((guide) => guide.slug)).toEqual(["en-guide"]);
    expect(await findGuide("ja-guide")).toBeNull();
    expect((await findGuide("en-guide"))?.guide.slug).toBe("en-guide");
  });

  it("lists the Japanese ones for the Japanese site, with the Japanese category label, and opens one by its slug", async () => {
    const guides = await japaneseGuides();
    expect(guides.map((guide) => guide.slug)).toEqual(["ja-guide"]);
    expect(guides[0]).toMatchObject({ language: "ja", title: "雨の日の鎌倉", category: { label: "Walks", labelJa: "歩く" }, relatedExperienceSlugs: ["synthetic-tea"] });
    expect((await findJapaneseGuide("ja-guide"))?.title).toBe("雨の日の鎌倉");
    expect(await findJapaneseGuide("en-guide")).toBeNull();
    expect(await findJapaneseGuide("Not A Slug!")).toBeNull();
  });

  it("is empty, not an error, without the database source, without a database, or when the read fails", async () => {
    state.config = { guideDraftsDir: null, guidePublicSource: "static" };
    expect(await japaneseGuides()).toEqual([]);
    expect(await findJapaneseGuide("ja-guide")).toBeNull();
    state.config = { guideDraftsDir: null, guidePublicSource: "database" };
    state.repository = null;
    expect(await japaneseGuides()).toEqual([]);
    state.repository = { listPublicArticles: vi.fn(async () => { throw new Error("down"); }), getPublicArticleBySlug: vi.fn(async () => { throw new Error("down"); }) };
    expect(await japaneseGuides()).toEqual([]);
    expect(await findJapaneseGuide("ja-guide")).toBeNull();
  });
});
