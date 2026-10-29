import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { guidePublicSource: "database" as "static" | "database" },
  repositoryFactory: vi.fn(),
  storageFactory: vi.fn(),
  repository: { getPublicMediaAsset: vi.fn() },
  storage: { read: vi.fn() },
}));

vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guideRepository: state.repositoryFactory }));
vi.mock("@/lib/editor/guide-cover-storage", () => ({ guideCoverStorage: state.storageFactory }));

import { GET } from "@/app/api/public/guides/media/[assetId]/route";

const ASSET_ID = "00000000-0000-4000-8000-000000000189";
const context = { params: Promise.resolve({ assetId: ASSET_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { guidePublicSource: "database" };
  state.repositoryFactory.mockReturnValue(state.repository);
  state.storageFactory.mockReturnValue(state.storage);
  state.repository.getPublicMediaAsset.mockResolvedValue({
    id: ASSET_ID,
    articleId: "article-synthetic",
    creatorNihoUserId: "writer-synthetic",
    objectKey: "private/never-expose-this-key.jpg",
    state: "READY",
    width: 1200,
    height: 800,
    byteSize: 4,
  });
  state.storage.read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

describe("public guide media route", () => {
  it("stays 404 while the database source flag is off", async () => {
    state.config = { guidePublicSource: "static" };
    const response = await GET(new Request(`https://example.test/api/public/guides/media/${ASSET_ID}`), context);
    expect(response.status).toBe(404);
    expect(state.repositoryFactory).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("relays only JPEG bytes with no-store security headers and no storage identifier", async () => {
    const response = await GET(new Request(`https://example.test/api/public/guides/media/${ASSET_ID}`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(state.storage.read).toHaveBeenCalledWith("private/never-expose-this-key.jpg");
  });

  it("returns 404 on the next read after current rights disappear", async () => {
    expect((await GET(new Request("https://example.test"), context)).status).toBe(200);
    state.repository.getPublicMediaAsset.mockResolvedValueOnce(null);
    const response = await GET(new Request("https://example.test"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("uses 503 for missing storage, read failures, or byte corruption", async () => {
    state.storageFactory.mockReturnValueOnce(null);
    expect((await GET(new Request("https://example.test"), context)).status).toBe(503);
    state.storageFactory.mockImplementationOnce(() => { throw new Error("storage init failed"); });
    expect((await GET(new Request("https://example.test"), context)).status).toBe(503);
    state.storage.read.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await GET(new Request("https://example.test"), context)).status).toBe(503);
    state.storage.read.mockResolvedValueOnce(Buffer.from([0xff, 0xd8]));
    expect((await GET(new Request("https://example.test"), context)).status).toBe(503);
  });

  it("does not query the repository for malformed opaque IDs", async () => {
    const response = await GET(new Request("https://example.test"), { params: Promise.resolve({ assetId: "not-a-uuid" }) });
    expect(response.status).toBe(404);
    expect(state.repository.getPublicMediaAsset).not.toHaveBeenCalled();
  });
});
