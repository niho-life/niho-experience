import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { sanitizeUmamiPayload } from "../analytics";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN, FIXTURE_BASE_URL, fakeEditorApi } from "./fixtures/fake-editor-api";
import { guidePreviewToken } from "./requirements";

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock("server-only", () => ({}));
vi.mock("../config", () => ({
  get config() {
    return state.config;
  },
}));

const editorConfig = {
  guidePublicSource: "editor",
  guideEditorApiBaseUrl: FIXTURE_BASE_URL,
  guideEditorApiHandle: EDITOR_FIXTURE.handle,
  guideEditorApiToken: EDITOR_FIXTURE.token,
  guideEditorAssetOrigins: [FIXTURE_ASSET_ORIGIN],
};

const DRAFT = "pv_synthetic-preview-not-a-secret-draft-000001";
const errors = vi.spyOn(console, "error").mockImplementation(() => {});

async function load() {
  vi.resetModules();
  const api = fakeEditorApi();
  vi.stubGlobal("fetch", api.fetch);
  const { readGuidePreview } = await import("./source");
  return { api, readGuidePreview };
}

beforeEach(() => {
  state.config = { ...editorConfig };
  errors.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => errors.mockRestore());

describe("/guides/preview (#253)", () => {
  it("is a 404 without a well-formed token, or with any source but the editor, before anything is fetched", async () => {
    expect(guidePreviewToken({})).toBeNull();
    expect(guidePreviewToken({ token: "short" })).toBeNull();
    expect(guidePreviewToken({ token: "synthetic-preview-token-0001" })).toBeNull();
    expect(guidePreviewToken({ token: `${DRAFT}x` })).toBeNull();
    expect(guidePreviewToken({ token: [DRAFT, DRAFT] })).toBeNull();
    expect(guidePreviewToken({ token: `${DRAFT}/../x` })).toBeNull();
    expect(guidePreviewToken({ token: DRAFT })).toBe(DRAFT);
    const { api, readGuidePreview } = await load();
    expect(await readGuidePreview("short")).toEqual({ kind: "not-found" });
    expect(await readGuidePreview(DRAFT.replace("pv_", "ek_"))).toEqual({ kind: "not-found" });
    state.config = { ...editorConfig, guidePublicSource: "static" };
    expect(await readGuidePreview(DRAFT)).toEqual({ kind: "not-found" });
    state.config = { ...editorConfig, guidePublicSource: "database" };
    expect(await readGuidePreview(DRAFT)).toEqual({ kind: "not-found" });
    expect(api.calls).toHaveLength(0);
  });

  it("renders a draft that meets no publication condition yet", async () => {
    const { readGuidePreview } = await load();
    expect(await readGuidePreview(DRAFT)).toMatchObject({
      kind: "ok",
      guide: { title: "An unfinished draft (sample)", unlisted: true, description: "", relatedExperienceSlugs: [], author: { name: "Sample Writer" } },
    });
  });

  it("re-reads every time and answers 404 once the token is unknown or expired", async () => {
    const { api, readGuidePreview } = await load();
    await readGuidePreview(DRAFT);
    await readGuidePreview(DRAFT);
    expect(api.calls).toHaveLength(2);
    delete api.state.previews[DRAFT];
    expect(await readGuidePreview(DRAFT)).toEqual({ kind: "not-found" });
    expect(await readGuidePreview(EDITOR_FIXTURE.expiredPreviewTokens[0]!)).toEqual({ kind: "not-found" });
    expect(await readGuidePreview("pv_synthetic-preview-not-a-secret-draft-000003")).toEqual({ kind: "not-found" });
  });

  it("explains a draft of another contract version to its writer, naming the field only", async () => {
    const { api, readGuidePreview } = await load();
    api.state.previews[DRAFT]!.contractVersion = "2";
    expect(await readGuidePreview(DRAFT)).toEqual({ kind: "invalid", reason: "The preview is not contract version 1 (contractVersion)." });
  });

  it("explains a body outside the Markdown subset to its writer instead of rendering it", async () => {
    const { readGuidePreview } = await load();
    expect(await readGuidePreview("pv_synthetic-preview-not-a-secret-draft-000002")).toEqual({ kind: "invalid", reason: "line 3: Raw HTML is not supported" });
  });

  it("fails (a 500) on an outage or a refused credential, with no stale draft and no token in the error", async () => {
    const { api, readGuidePreview } = await load();
    await readGuidePreview(DRAFT);
    for (const status of [503, 401]) {
      api.state.forcedStatus = status;
      const error = await readGuidePreview(DRAFT).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(DRAFT);
      expect(String(error)).not.toContain(EDITOR_FIXTURE.token);
    }
    expect(errors.mock.calls.join("\n")).not.toContain(DRAFT);
  });

  it("is private: no-store, noindex, no Referer, kept from robots, sitemaps and analytics", async () => {
    const headers = await nextConfig.headers!();
    const rule = headers.find((candidate) => candidate.source === "/guides/preview");
    expect(rule?.headers).toEqual(expect.arrayContaining([
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ]));
    // Analytics never receives the page (and so never its query).
    expect(sanitizeUmamiPayload("pageview", { url: `https://experience.niho.life/guides/preview?token=${DRAFT}` }, "https://experience.niho.life")).toBe(false);
  });
});
