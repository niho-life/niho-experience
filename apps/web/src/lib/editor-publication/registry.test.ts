import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLISHED_GUIDES, SAMPLE_GUIDES } from "@/content/guides";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN, FIXTURE_BASE_URL, fakeEditorApi } from "./fixtures/fake-editor-api";

const editorConfig = {
  guideDraftsDir: "/drafts" as string | null,
  guidePublicSource: "editor" as "static" | "database" | "editor",
  guideEditorApiBaseUrl: FIXTURE_BASE_URL,
  guideEditorApiHandle: EDITOR_FIXTURE.handle,
  guideEditorApiToken: EDITOR_FIXTURE.token,
  guideEditorAssetOrigins: [FIXTURE_ASSET_ORIGIN],
};

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  readDrafts: vi.fn(),
  repository: { listPublicArticles: vi.fn(), getPublicArticleBySlug: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("../config", () => ({
  get config() {
    return state.config;
  },
  // The mock preview flag is on, to show that the editor source still never adds samples or drafts.
  isPreview: true,
}));
vi.mock("../guide-drafts", () => ({ GUIDE_DRAFTS_FOLDER: "GUIDE_DRAFTS_DIR", readGuideDrafts: state.readDrafts }));
vi.mock("../experience/store-server", () => ({ guideRepository: () => state.repository }));

const errors = vi.spyOn(console, "error").mockImplementation(() => {});
const logged = () => errors.mock.calls.map((call) => call.join(" ")).join("\n");

/** Fresh modules per test: the API client keeps a per-instance cache across requests. */
async function load() {
  vi.resetModules();
  const api = fakeEditorApi();
  vi.stubGlobal("fetch", api.fetch);
  return { api, ...(await import("../guide-registry")) };
}

const LIVE = ["sample-evening-walk", "sample-rainy-afternoon", "sample-market-morning"];

beforeEach(() => {
  state.config = { ...editorConfig };
  state.readDrafts.mockReset();
  state.repository.listPublicArticles.mockReset();
  errors.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => errors.mockRestore());

describe("the editor guide source (#252)", () => {
  it("lists live publications only, newest first, without static guides, samples or drafts", async () => {
    const { guideCatalog, indexableGuides, guidesAboutExperience, hasGuidesPage } = await load();
    const catalog = await guideCatalog();
    expect(catalog).toMatchObject({ source: "editor", draftSlugs: [], draftProblems: [] });
    expect(catalog.guides.map((guide) => guide.slug)).toEqual(LIVE);
    expect(hasGuidesPage(catalog)).toBe(true);
    const staticSlugs = [...PUBLISHED_GUIDES, ...SAMPLE_GUIDES].map((guide) => guide.slug);
    expect(catalog.guides.some((guide) => staticSlugs.includes(guide.slug))).toBe(false);
    expect(state.readDrafts).not.toHaveBeenCalled();
    // The sitemap and the experience pages read the same live set; never the unlisted one.
    expect((await indexableGuides()).map((guide) => guide.slug)).toEqual(LIVE);
    expect((await guidesAboutExperience("evening-pottery-session")).guides.map((guide) => guide.slug)).toEqual(["sample-evening-walk"]);
  });

  it("logs each left-out publication by ID, slug and reason only", async () => {
    const { guideCatalog } = await load();
    await guideCatalog();
    const lines = logged();
    for (const id of ["ed-bad-range", "ed-bad-slug", "ed-reserved-slug", "ed-japanese", "ed-gone-1", "ed-http-cover", "ed-script-link", "ed-duplicate-slug", "ed-foreign-figure", "ed-internal-asset"]) {
      expect(lines).toContain(`"id":"${id}"`);
    }
    expect(lines).not.toContain("ed-other-dest");
    expect(lines).not.toContain(EDITOR_FIXTURE.token);
    expect(lines).not.toMatch(/Never shown|javascript|elsewhere\.example|https?:\/\//);
  });

  it("finds a live guide, an unlisted one by its direct URL (noindex), and nothing else", async () => {
    const { findGuide, api } = await load();
    expect(await findGuide("sample-evening-walk")).toMatchObject({ draft: false, guide: { slug: "sample-evening-walk", hero: { licensed: true } } });
    expect(await findGuide("sample-evening-walk")).not.toHaveProperty("unlisted");
    expect(await findGuide("sample-direct-link-only")).toMatchObject({ draft: false, unlisted: true, guide: { unlisted: true } });
    expect(await findGuide("sample-direct-link-only")).not.toHaveProperty("editorialPreview");
    expect(await findGuide("sample-http-cover")).toBeNull();
    expect(await findGuide("sample-for-another-site")).toBeNull();
    // No static editorial preview fallback with the editor source.
    expect(await findGuide("kamakura-after-4-pm")).toBeNull();
    const before = api.calls.length;
    expect(await findGuide("Not_A_Slug")).toBeNull();
    expect(await findGuide("preview")).toBeNull();
    expect(api.calls.length).toBe(before);
  });

  it("reflects publishing, updating and unpublishing on the next read after 30 seconds, without a rebuild", async () => {
    const { guideCatalog, findGuide, missingGuideRedirect, api } = await load();
    expect((await guideCatalog()).guides.map((guide) => guide.slug)).toEqual(LIVE);
    const walk = api.state.articles.find((article) => article.id === "ed-live-1")!;
    walk.title = "An updated evening walk (sample guide)";
    walk.updatedAt = "2026-10-31T00:00:00.000Z";
    walk.markdown = "## Updated\n\nNew text.";
    api.state.articles = api.state.articles.filter((article) => article.id !== "ed-live-2");
    vi.setSystemTime(new Date("2026-10-31T00:00:31Z"));
    const catalog = await guideCatalog();
    expect(catalog.guides.map((guide) => guide.slug)).toEqual(["sample-evening-walk", "sample-market-morning"]);
    expect(catalog.guides[0]).toMatchObject({ title: "An updated evening walk (sample guide)", body: "## Updated\n\nNew text.", updatedAt: "2026-10-31" });
    expect(await findGuide("sample-rainy-afternoon")).toBeNull();
    // An unpublished URL goes back to /guides (a temporary redirect: republishing keeps the URL).
    expect(await missingGuideRedirect("sample-rainy-afternoon")).toBe("/guides");
  });

  it("shows an outage copy of an updated guide's body without keeping it, then the new body once the API answers", async () => {
    const { guideCatalog, api } = await load();
    let bodiesDown = false;
    // Only the updated article's body fails: the list still reports its new updatedAt.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      bodiesDown && String(input).includes("/published/ed-live-1.json") ? Promise.resolve(new Response("{}", { status: 503 })) : api.fetch(input, init));
    const bySlug = async () => new Map((await guideCatalog()).guides.map((guide) => [guide.slug, guide]));
    const oldBody = (await bySlug()).get("sample-evening-walk")!.body;
    const walk = api.state.articles.find((article) => article.id === "ed-live-1")!;
    walk.updatedAt = "2026-10-31T00:00:20.000Z";
    walk.markdown = "## Updated\n\nNew text.";
    bodiesDown = true;
    vi.setSystemTime(new Date("2026-10-31T00:00:31Z"));
    expect((await bySlug()).get("sample-evening-walk")).toMatchObject({ updatedAt: "2026-10-31", body: oldBody });
    bodiesDown = false;
    // Past the 30 s back-off: the same (unchanged) list entry is converted again from the new body.
    vi.setSystemTime(new Date("2026-10-31T00:01:02Z"));
    expect((await bySlug()).get("sample-evening-walk")).toMatchObject({ body: "## Updated\n\nNew text." });
  });

  it("redirects a missing guide only with the editor source, a valid slug and a non-empty /guides", async () => {
    const { missingGuideRedirect, api } = await load();
    expect(await missingGuideRedirect("never-published")).toBe("/guides");
    expect(await missingGuideRedirect("Not_A_Slug")).toBeNull();
    api.state.articles = [];
    vi.setSystemTime(new Date("2026-10-31T00:01:00Z"));
    expect(await missingGuideRedirect("never-published")).toBeNull();
    state.config = { ...editorConfig, guidePublicSource: "static" };
    expect(await missingGuideRedirect("never-published")).toBeNull();
  });

  it("fails the guide pages on an outage without a copy, while the rest of the site only hides its guides", async () => {
    const { guideCatalog, guideCatalogForSite, findGuide, api } = await load();
    api.state.forcedStatus = 503;
    await expect(guideCatalog()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(findGuide("sample-evening-walk")).rejects.toMatchObject({ kind: "unavailable" });
    expect(await guideCatalogForSite()).toEqual({ source: "editor", guides: [], draftSlugs: [], draftProblems: [] });
    api.state.forcedStatus = 401;
    expect(await guideCatalogForSite()).toEqual({ source: "editor", guides: [], draftSlugs: [], draftProblems: [] });
    expect(logged()).not.toContain(EDITOR_FIXTURE.token);
  });

  it("leaves the database source's failures as they were", async () => {
    state.config = { ...editorConfig, guidePublicSource: "database" };
    const { guideCatalogForSite } = await load();
    state.repository.listPublicArticles.mockRejectedValue(new Error("database unavailable"));
    await expect(guideCatalogForSite()).rejects.toThrow("database unavailable");
  });
});
