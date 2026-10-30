import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";
import { assertSameJapaneseRelease, JapaneseReleaseUnavailable, japaneseBookingAllowed } from "./localized-release";

const state = vi.hoisted(() => ({
  releaseId: "release-1",
  responses: new Map<string, unknown | null>(),
  catalog: null as { releaseId: string; slugs: string[] } | null,
  catalogReads: 0,
  config: { japaneseSiteEnabled: true, nihoWebOrigin: "https://niho.example", siteUrl: "https://experience.example.com", indexingAllowed: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({ config: state.config }));
vi.mock("./api", () => ({
  getApi: async () => ({
    getJapaneseSiteCopy: async () => ({ ok: true as const, data: { schemaVersion: 2, releaseId: state.releaseId, locale: "ja", values: defaultStaticCopyValuesV1() } }),
    listJapaneseExperiences: async () => (state.catalogReads += 1, state.catalog)
      ? { ok: true as const, data: { releaseId: state.catalog.releaseId, locale: "ja", displayLocale: "ja", copySchemaVersion: 2, experiences: state.catalog.slugs.map((slug) => ({ slug })) } }
      : { ok: false as const, kind: "not_found" as const },
  }),
}));

const authored = { schemaVersion: 1, renderingMode: "authored", presentation: null } as const;
const sourcePaths = { home: "/", experiences: "/experiences", host: "/host", help: "/help" } as const;

function pageFixture(pageId: keyof typeof sourcePaths, releaseId = state.releaseId) {
  const sourcePath = sourcePaths[pageId];
  return {
    releaseId,
    locale: "ja",
    document: { ignoredVisualDocument: pageId },
    route: { pageId, sourcePath, path: sourcePath === "/" ? "/ja/" : `/ja${sourcePath}`, indexable: pageId !== "help" },
    seo: { pageId, title: `Japanese ${pageId}`, indexable: pageId !== "help" },
    display: { navigation: [], supportedBlocks: [], chrome: { ignoredVisualChrome: true } },
    presentation: authored,
  };
}

function installValidRelease() {
  for (const pageId of Object.keys(sourcePaths) as (keyof typeof sourcePaths)[]) {
    state.responses.set(`/api/public/experiences/pages/localized/${pageId}/ja`, pageFixture(pageId));
  }
}

beforeEach(() => {
  vi.resetModules();
  state.releaseId = "release-1";
  state.responses.clear();
  state.catalog = null;
  state.catalogReads = 0;
  state.config.japaneseSiteEnabled = true;
  installValidRelease();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    const value = state.responses.get(new URL(String(input)).pathname);
    return value === null || value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
  }));
});

describe("Japanese release selection", () => {
  it("requires every document, copy, and business projection to use one release", () => {
    expect(() => assertSameJapaneseRelease("r1", { releaseId: "r1" }, { releaseId: "r1" })).not.toThrow();
    expect(() => assertSameJapaneseRelease("r1", { releaseId: "r1" }, { releaseId: "r2" })).toThrow(JapaneseReleaseUnavailable);
  });

  it("keeps checkout closed when translated booking terms are not release-ready", () => {
    expect(japaneseBookingAllowed({ localization: { termsFingerprint: `sha256:${"a".repeat(64)}`, bookingReady: false, unavailableCopyKey: "booking.unavailableJa" } })).toBe(false);
    expect(japaneseBookingAllowed({ localization: { termsFingerprint: `sha256:${"a".repeat(64)}`, bookingReady: true, unavailableCopyKey: null } })).toBe(true);
  });

  it("loads a real localized-page response and normalizes the published root away from a redirect", async () => {
    const { getJapanesePage } = await import("./localized-content");
    await expect(getJapanesePage("home")).resolves.toMatchObject({ route: { pageId: "home", sourcePath: "/", path: "/ja" } });
    expect(fetch).toHaveBeenCalledWith(new URL("https://niho.example/api/public/experiences/pages/localized/home/ja"), expect.objectContaining({ method: "GET", cache: "no-store", credentials: "omit", redirect: "error" }));
  });

  it("builds canonical and hreflang metadata only from the prepared whole release", async () => {
    const { japaneseStaticMetadata } = await import("./locale-metadata");
    await expect(japaneseStaticMetadata("home")).resolves.toMatchObject({
      alternates: {
        canonical: "https://experience.example.com/ja",
        languages: {
          en: "https://experience.example.com/",
          ja: "https://experience.example.com/ja",
          "x-default": "https://experience.example.com/",
        },
      },
    });
  });

  it("rejects a pageId whose otherwise-consistent sourcePath belongs to a different page", async () => {
    state.responses.set("/api/public/experiences/pages/localized/experiences/ja", {
      ...pageFixture("experiences"),
      route: { pageId: "experiences", sourcePath: "/help", path: "/ja/help", indexable: true },
    });
    const { getJapanesePage } = await import("./localized-content");
    await expect(getJapanesePage("experiences")).rejects.toMatchObject({ reason: "invalid" });
  });

  it("prepares a release from copy and route/SEO projections without fetching visual chrome", async () => {
    const valid = await import("./localized-content");
    await expect(valid.getPreparedJapaneseStaticRelease()).resolves.toMatchObject({
      releaseId: "release-1",
      counterparts: { "/": "/ja", "/experiences": "/ja/experiences", "/host": "/ja/host", "/help": "/ja/help" },
    });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/sidecars/chrome/"), expect.anything());
  });

  it("rejects mismatched page releases through the actual whole-release loader", async () => {
    state.responses.set("/api/public/experiences/pages/localized/help/ja", pageFixture("help", "release-2"));
    const { getPreparedJapaneseStaticRelease } = await import("./localized-content");
    await expect(getPreparedJapaneseStaticRelease()).rejects.toMatchObject({ reason: "mismatch" });
  });

  it("ignores unknown visual metadata while keeping route release readiness", async () => {
    const { document: _document, display: _display, ...safeProjection } = pageFixture("home");
    void _document;
    void _display;
    state.responses.set("/api/public/experiences/pages/localized/home/ja", {
      ...safeProjection,
      presentation: { schemaVersion: 999, renderingMode: "future-editor", presentation: { unexpected: true } },
    });
    const { getPreparedJapaneseStaticRelease } = await import("./localized-content");
    await expect(getPreparedJapaneseStaticRelease()).resolves.toMatchObject({ releaseId: "release-1" });
  });
});

describe("experience pairs in the prepared release (#59)", () => {
  it("adds the language switch for experience pages paired in the same release's catalog", async () => {
    state.catalog = { releaseId: "release-1", slugs: ["tea-ceremony", "zen-walk"] };
    const { getJapaneseStaticCounterparts, getPreparedJapaneseStaticRelease } = await import("./localized-content");
    await expect(getJapaneseStaticCounterparts()).resolves.toEqual({
      "/": "/ja", "/experiences": "/ja/experiences", "/host": "/ja/host", "/help": "/ja/help",
      "/experiences/tea-ceremony": "/ja/experiences/tea-ceremony",
      "/experiences/zen-walk": "/ja/experiences/zen-walk",
    });
    // The catalog says nothing about Japanese booking, so no booking page is paired.
    expect((await getPreparedJapaneseStaticRelease()).experiences.get("tea-ceremony")).toMatchObject({ bookingReady: false });
  });

  it("keeps only the static pages when the catalog is missing or from another release", async () => {
    const statics = { "/": "/ja", "/experiences": "/ja/experiences", "/host": "/ja/host", "/help": "/ja/help" };
    const missing = await import("./localized-content");
    await expect(missing.getJapaneseStaticCounterparts()).resolves.toEqual(statics);
    vi.resetModules();
    state.catalog = { releaseId: "release-2", slugs: ["tea-ceremony"] };
    const other = await import("./localized-content");
    await expect(other.getJapaneseStaticCounterparts()).resolves.toEqual(statics);
    expect((await other.getPreparedJapaneseStaticRelease()).experiences.size).toBe(0);
  });

  it("stays off the network and exposes no switch while the Japanese site flag is off", async () => {
    state.config.japaneseSiteEnabled = false;
    state.catalog = { releaseId: "release-1", slugs: ["tea-ceremony"] };
    const { getJapaneseCatalog, getJapaneseDetail, getJapaneseStaticCounterparts } = await import("./localized-content");
    await expect(getJapaneseStaticCounterparts()).rejects.toMatchObject({ reason: "disabled" });
    await expect(getJapaneseCatalog()).rejects.toMatchObject({ reason: "disabled" });
    await expect(getJapaneseDetail("tea-ceremony")).rejects.toMatchObject({ reason: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.catalogReads).toBe(0);
  });
});
