import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  allowed: vi.fn(() => true),
  storageFactory: vi.fn(),
  storage: { write: vi.fn(), read: vi.fn(), remove: vi.fn() },
  repository: {
    createMediaAsset: vi.fn(),
    markMediaAssetReady: vi.fn(),
    getReadyMediaAsset: vi.fn(),
    revokeMediaAsset: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/editor/guide-api-server", () => ({
  loadGuideApiContext: mocks.load,
  guideApiMutationAllowed: mocks.allowed,
  readGuideApiJson: async (request: Request) => ({ ok: true, value: await request.json() }),
  guideApiJson: (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  }),
  guideApiError: () => Response.json({ error: "unavailable" }, { status: 503 }),
}));
vi.mock("@/lib/editor/guide-cover-storage", () => ({ guideCoverStorage: mocks.storageFactory }));

import { POST as uploadCover } from "@/app/(editor)/editor/api/guides/[articleId]/cover/route";
import {
  DELETE as revokeCover,
  GET as readCover,
} from "@/app/(editor)/editor/api/guides/[articleId]/cover/assets/[assetId]/route";
import { GET as readPublicCover } from "@/app/api/public/guides/media/[assetId]/route";

const SITE = "https://experience.example.test";
const articleContext = { params: Promise.resolve({ articleId: "article-synthetic" }) };
const assetContext = {
  params: Promise.resolve({
    articleId: "article-synthetic",
    assetId: "00000000-0000-4000-8000-000000000215",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed.mockReturnValue(true);
  mocks.storageFactory.mockReturnValue(mocks.storage);
  mocks.load.mockResolvedValue({
    ok: true,
    value: { actor: { nihoUserId: "writer-synthetic" }, repository: mocks.repository },
  });
  mocks.repository.getReadyMediaAsset.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000215",
    articleId: "article-synthetic",
    creatorNihoUserId: "writer-synthetic",
    objectKey: "private-object-key",
    state: "READY",
    width: 80,
    height: 120,
    byteSize: 4,
  });
  mocks.repository.revokeMediaAsset.mockResolvedValue({
    id: "article-synthetic",
    slug: "synthetic-guide",
    creatorNihoUserId: "writer-synthetic",
    subject: { kind: "WRITER" },
    title: "Synthetic guide",
    description: "Synthetic guide description",
    content: { markdown: "Synthetic guide body" },
    status: "PUBLISHED",
    revision: 4,
  });
  mocks.repository.createMediaAsset.mockImplementation(async (_actor, articleId, input) => ({
    id: input.id,
    articleId,
    creatorNihoUserId: "writer-synthetic",
    objectKey: input.objectKey,
    state: "UPLOADING",
  }));
  mocks.repository.markMediaAssetReady.mockImplementation(async (_actor, articleId, assetId, input) => ({
    id: assetId,
    articleId,
    creatorNihoUserId: "writer-synthetic",
    objectKey: `guide-covers/${assetId}.jpg`,
    state: "READY",
    width: input.width,
    height: input.height,
    byteSize: input.byteSize,
  }));
  mocks.storage.read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

describe("private guide cover routes", () => {
  it("checks editor authentication before upload, read, and revoke", async () => {
    mocks.load.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "signed_out" }, { status: 401, headers: { "cache-control": "private, no-store" } }),
    });
    const responses = await Promise.all([
      uploadCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }), articleContext),
      readCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover/assets/x`), assetContext),
      revokeCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover/assets/x`, { method: "DELETE" }), assetContext),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(mocks.load).toHaveBeenCalledTimes(3);
    expect(mocks.repository.getReadyMediaAsset).not.toHaveBeenCalled();
  });

  it("returns an explicit unavailable response when the private bucket is not configured", async () => {
    mocks.storageFactory.mockReturnValue(null);
    const response = await uploadCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover`, {
      method: "POST",
      headers: {
        origin: SITE,
        "sec-fetch-site": "same-origin",
        "content-type": "image/jpeg",
      },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    }), articleContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "media_storage_unavailable" });
    expect(mocks.repository.createMediaAsset).not.toHaveBeenCalled();
  });

  it("stores a processed JPEG and returns only opaque display-safe asset fields", async () => {
    const input = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 60, b: 100 } },
    }).png().toBuffer();
    const response = await uploadCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover`, {
      method: "POST",
      headers: {
        origin: SITE,
        "sec-fetch-site": "same-origin",
        "content-type": "image/png",
      },
      body: input,
    }), articleContext);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ asset: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), width: 64, height: 48 } });
    expect(JSON.stringify(body)).not.toMatch(/object|bucket|gcs|url/i);
    expect(mocks.storage.write).toHaveBeenCalledOnce();
    expect(await sharp(mocks.storage.write.mock.calls[0]![1]).metadata()).toMatchObject({ format: "jpeg" });
  });

  it("cleans a private object when storage reports failure after a possible write", async () => {
    const input = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "blue" },
    }).png().toBuffer();
    mocks.storage.write.mockRejectedValueOnce(new Error("timed out after write"));
    const response = await uploadCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover`, {
      method: "POST", headers: { "content-type": "image/png" }, body: input,
    }), articleContext);
    expect(response.status).toBe(503);
    const objectKey = mocks.storage.write.mock.calls[0]![0];
    expect(mocks.storage.remove).toHaveBeenCalledWith(objectKey);
    expect(mocks.repository.revokeMediaAsset).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" }, "article-synthetic", expect.any(String),
    );
  });

  it("relays only the processed image with no-store and never returns storage identifiers", async () => {
    const response = await readCover(
      new Request(`${SITE}/editor/api/guides/article-synthetic/cover/assets/00000000-0000-4000-8000-000000000215`),
      assetContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
    expect(mocks.storage.read).toHaveBeenCalledWith("private-object-key");
  });

  it("keeps the future public media route closed", async () => {
    const response = readPublicCover();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("revokes rights without deleting the retained private object", async () => {
    const response = await revokeCover(new Request(`${SITE}/editor/api/guides/article-synthetic/cover/assets/00000000-0000-4000-8000-000000000215`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3 }),
    }), assetContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ guide: { revision: 4 } });
    expect(mocks.repository.revokeMediaAsset).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" }, "article-synthetic", "00000000-0000-4000-8000-000000000215", 3,
    );
    expect(mocks.storage.remove).not.toHaveBeenCalled();
  });
});
