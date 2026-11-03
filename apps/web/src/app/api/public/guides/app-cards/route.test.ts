import { beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN, FIXTURE_BASE_URL, fakeEditorApi, fixtureArticle } from "@/lib/editor-publication/fixtures/fake-editor-api";

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import { GET } from "./route";

const enabled = {
  guideAppCardsEnabled: true,
  guidePublicSource: "editor",
  guideEditorApiBaseUrl: FIXTURE_BASE_URL,
  guideEditorApiHandle: "exp",
  guideEditorApiToken: EDITOR_FIXTURE.token,
  guideEditorAssetOrigins: [FIXTURE_ASSET_ORIGIN],
  siteUrl: "https://experience.example",
};
const request = (query = "") => new Request(`https://experience.example/api/public/guides/app-cards${query}`);
const listed = (name: string, patch: Record<string, unknown> = {}) => {
  const item = structuredClone(fixtureArticle(name));
  const cover = item.cover as Record<string, unknown> | null | undefined;
  if (cover && typeof cover.sha256 === "string") cover.url = `${FIXTURE_ASSET_ORIGIN}/assets/${cover.sha256}.jpg`;
  return { ...item, ...patch };
};

beforeEach(() => {
  state.config = { ...enabled };
  vi.unstubAllGlobals();
});

describe("GET /api/public/guides/app-cards", () => {
  it("returns an empty no-store page while the flag is off without touching the dependency", async () => {
    state.config = { ...enabled, guideAppCardsEnabled: false };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await GET(request("?cursor=ignored-while-off"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 1, items: [], nextCursor: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("projects only live app opt-ins with optional cover and lead, without fetching bodies", async () => {
    const api = fakeEditorApi();
    api.state.articles = [
      listed("live-1", { extras: { app: true, news: false, xp: false } }),
      listed("no-lead", { extras: { app: true, news: false, xp: false } }),
      listed("unlisted-1", { extras: { app: true, news: false, xp: false } }),
      listed("live-2", { extras: { app: false, news: false, xp: false } }),
    ];
    vi.stubGlobal("fetch", api.fetch);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      items: [
        expect.objectContaining({ slug: "sample-evening-walk", lead: expect.any(String), cover: { url: `${FIXTURE_ASSET_ORIGIN}/assets/${"c0".repeat(32)}.jpg`, alt: "A quiet lane at dusk (sample photo)" }, author: { name: "Sample Writer", url: "https://writer.example/" }, canonicalUrl: "https://experience.example/guides/sample-evening-walk" }),
        expect.objectContaining({ slug: "sample-without-lead", lead: null, cover: null, author: { name: "Sample Writer", url: null }, canonicalUrl: "https://experience.example/guides/sample-without-lead" }),
      ],
      nextCursor: null,
    });
    expect(api.urls()).toEqual(["/exp/published.json?limit=100&include=unlisted"]);
  });

  it("paginates by a bounded public position and rejects malformed or repeated cursor input", async () => {
    const api = fakeEditorApi();
    const base = listed("no-lead", { extras: { app: true, news: false, xp: false } });
    api.state.articles = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(base),
      id: `0e100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      slug: `app-guide-${index}`,
      title: `App guide ${index}`,
      canonicalUrl: `https://experience.example/guides/app-guide-${index}`,
      updatedAt: new Date(Date.UTC(2026, 9, 31, 0, 0, index)).toISOString(),
    }));
    vi.stubGlobal("fetch", api.fetch);
    const first = await GET(request());
    const firstBody = await first.json() as { items: unknown[]; nextCursor: string };
    expect(firstBody.items).toHaveLength(100);
    expect(firstBody.nextCursor).toMatch(/^v1\./);
    const second = await GET(request(`?cursor=${encodeURIComponent(firstBody.nextCursor)}`));
    expect((await second.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await GET(request("?cursor=v1.bm90LWpzb24"))).status).toBe(400);
    expect((await GET(request(`?cursor=${firstBody.nextCursor}&cursor=${firstBody.nextCursor}`))).status).toBe(400);
  });

  it("fails closed for source canonical mismatch/missing/credentials, unsafe photos, duplicates, malformed metadata, outages and missing settings", async () => {
    for (const articles of [
      [listed("live-1", { extras: { app: true, news: false, xp: false }, cover: { ...(listed("live-1").cover as object), url: "https://evil.example/cover.jpg" } })],
      [listed("live-1", { extras: { app: true, news: false, xp: false }, canonicalUrl: "https://evil.example/guides/sample-evening-walk" })],
      [listed("live-1", { extras: { app: true, news: false, xp: false }, canonicalUrl: undefined })],
      [listed("live-1", { extras: { app: true, news: false, xp: false }, canonicalUrl: "https://user@experience.example/guides/sample-evening-walk" })],
      [listed("live-1", { extras: { app: true, news: false, xp: false } }), listed("live-1", { extras: { app: true, news: false, xp: false } })],
      [listed("live-1", { extras: { app: true, news: false, xp: false } }), listed("live-2", { slug: "sample-evening-walk", extras: { app: true, news: false, xp: false } })],
      [listed("live-1", { extras: { app: "yes", news: false, xp: false } })],
    ]) {
      const api = fakeEditorApi();
      api.state.articles = articles;
      vi.stubGlobal("fetch", api.fetch);
      expect((await GET(request())).status).toBe(503);
    }
    const outage = fakeEditorApi();
    outage.state.forcedStatus = 503;
    vi.stubGlobal("fetch", outage.fetch);
    expect((await GET(request())).status).toBe(503);
    state.config = { ...enabled, guideEditorApiToken: "" };
    expect((await GET(request())).status).toBe(503);
  });
});
