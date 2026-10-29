import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  allowed: vi.fn(() => true),
  storageFactory: vi.fn(),
  storage: { write: vi.fn(), read: vi.fn(), remove: vi.fn() },
  repository: {
    listReadyMediaAssets: vi.fn(),
    getReadyMediaAsset: vi.fn(),
    confirmMediaAssetWebRights: vi.fn(),
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
  guideApiError: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/editor/guide-cover-storage", () => ({ guideCoverStorage: mocks.storageFactory }));

import { GET as listMedia } from "@/app/(editor)/editor/api/guides/[articleId]/media/route";
import { DELETE as revokeRights, GET as readMedia, PUT as confirmRights } from "@/app/(editor)/editor/api/guides/[articleId]/media/assets/[assetId]/route";

const SITE = "https://experience.example.test";
const assetId = "00000000-0000-4000-8000-000000000216";
const articleContext = { params: Promise.resolve({ articleId: "article-synthetic" }) };
const assetContext = { params: Promise.resolve({ articleId: "article-synthetic", assetId }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed.mockReturnValue(true);
  mocks.storageFactory.mockReturnValue(mocks.storage);
  mocks.load.mockResolvedValue({
    ok: true,
    value: { actor: { nihoUserId: "writer-synthetic" }, repository: mocks.repository },
  });
  mocks.repository.listReadyMediaAssets.mockResolvedValue([
    { id: assetId, width: 1200, height: 800, publicCredit: "Photo: Synthetic", webConfirmed: true },
  ]);
  mocks.repository.getReadyMediaAsset.mockResolvedValue({
    id: assetId,
    articleId: "article-synthetic",
    creatorNihoUserId: "writer-synthetic",
    objectKey: "private-object-key",
    state: "READY",
    width: 1200,
    height: 800,
    byteSize: 4,
  });
  mocks.repository.confirmMediaAssetWebRights.mockResolvedValue({
    id: assetId,
    width: 1200,
    height: 800,
    publicCredit: "Photo: Synthetic",
    webConfirmed: true,
  });
  mocks.repository.revokeMediaAsset.mockResolvedValue({
    id: "article-synthetic", revision: 4, slug: "synthetic", title: "Synthetic", description: "Synthetic",
    content: { markdown: "" }, status: "DRAFT", categoryId: null, coverAssetId: null,
  });
  mocks.storage.read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

describe("private guide body media routes", () => {
  it("checks the current editor session before list, read, and rights confirmation", async () => {
    mocks.load.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "signed_out" }, { status: 401, headers: { "cache-control": "private, no-store" } }),
    });
    const responses = await Promise.all([
      listMedia(new Request(`${SITE}/editor/api/guides/article-synthetic/media`), articleContext),
      readMedia(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`), assetContext),
      confirmRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicCredit: "Photo: Synthetic", webConfirmed: true }),
      }), assetContext),
      revokeRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3 }),
      }), assetContext),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(mocks.load).toHaveBeenCalledTimes(4);
  });

  it("lists only display-safe fields and reads bytes with private no-store headers", async () => {
    const listed = await listMedia(new Request(`${SITE}/editor/api/guides/article-synthetic/media`), articleContext);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await listed.json())).not.toMatch(/objectKey|bucket|gcs/i);

    const read = await readMedia(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`), assetContext);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(read.headers.get("content-type")).toBe("image/jpeg");
    expect(mocks.storage.read).toHaveBeenCalledWith("private-object-key");
  });

  it("requires an explicit same-origin Web confirmation and sends no storage identifier", async () => {
    const malformed = await confirmRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicCredit: "Photo: Synthetic", webConfirmed: false }),
    }), assetContext);
    expect(malformed.status).toBe(400);

    const response = await confirmRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicCredit: "Photo: Synthetic", webConfirmed: true }),
    }), assetContext);
    expect(response.status).toBe(200);
    expect(mocks.repository.confirmMediaAssetWebRights).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" },
      "article-synthetic",
      assetId,
      "Photo: Synthetic",
    );
    expect(JSON.stringify(await response.json())).not.toMatch(/objectKey|bucket|gcs/i);
  });

  it("revokes rights with a draft revision and leaves private bytes untouched", async () => {
    const malformed = await revokeRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: "3" }),
    }), assetContext);
    expect(malformed.status).toBe(400);

    const response = await revokeRights(new Request(`${SITE}/editor/api/guides/article-synthetic/media/assets/${assetId}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3 }),
    }), assetContext);
    expect(response.status).toBe(200);
    expect(mocks.repository.revokeMediaAsset).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" }, "article-synthetic", assetId, 3,
    );
    expect(mocks.storage.remove).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.guide.revision).toBe(4);
    expect(JSON.stringify(body)).not.toMatch(/objectKey|bucket|gcs/i);
  });
});
