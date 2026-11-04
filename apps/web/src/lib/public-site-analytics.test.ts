import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    apiMode: "http" as "http" | "mock",
    siteUrl: "https://experience.niho.life",
    indexingAllowed: true,
    nihoWebOrigin: "https://niho.life",
  },
  headers: { host: "experience.niho.life", "x-forwarded-proto": "https", dnt: "" },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(state.headers) }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import { getPublicSiteAnalyticsSettings } from "./public-site-analytics";

const acceptedSettings = {
  siteId: "experience",
  siteOrigin: "https://experience.niho.life",
  analytics: {
    runtimeGate: {
      mode: "production-origin-only",
      approvedOrigin: "https://experience.niho.life",
      previewCollection: false,
    },
    ga4: { measurementId: "G-ABCD1234" },
    searchConsoleVerificationMeta: { name: "google-site-verification", content: "verify_123" },
  },
};

function apiResponse(body: unknown) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

describe("public site analytics settings", () => {
  beforeEach(() => {
    Object.assign(state.config, {
      apiMode: "http",
      siteUrl: "https://experience.niho.life",
      indexingAllowed: true,
      nihoWebOrigin: "https://niho.life",
    });
    Object.assign(state.headers, {
      host: "experience.niho.life",
      "x-forwarded-proto": "https",
      dnt: "",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse(acceptedSettings)));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses the approved production projection without caching the fetch", async () => {
    await expect(getPublicSiteAnalyticsSettings()).resolves.toEqual({
      ga4MeasurementId: "G-ABCD1234",
      searchConsoleVerification: "verify_123",
    });
    expect(fetch).toHaveBeenCalledWith(new URL("/api/public/experiences/site-settings", "https://niho.life"), expect.objectContaining({
      method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
    }));
  });

  it("fails closed outside the canonical production request", async () => {
    state.headers.host = "preview.example.test";
    await expect(getPublicSiteAnalyticsSettings()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    state.headers.host = "experience.niho.life";
    state.config.apiMode = "mock";
    await expect(getPublicSiteAnalyticsSettings()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps verification metadata but suppresses GA4 when request DNT is enabled", async () => {
    state.headers.dnt = "1";
    await expect(getPublicSiteAnalyticsSettings()).resolves.toEqual({
      ga4MeasurementId: null,
      searchConsoleVerification: "verify_123",
    });
  });

  it("fails closed when the settings contract changes or the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ ...acceptedSettings, unexpected: true })));
    await expect(getPublicSiteAnalyticsSettings()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic outage")));
    await expect(getPublicSiteAnalyticsSettings()).resolves.toBeNull();
  });
});
