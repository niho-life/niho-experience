import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  providers: { status: "signed-out" } as unknown,
  repository: {
    listActiveCategories: vi.fn(), createArticle: vi.fn(), listArticles: vi.fn(), getArticle: vi.fn(), saveDraft: vi.fn(),
    commitPublication: vi.fn(), stopPublication: vi.fn(), createMediaAsset: vi.fn(), markMediaAssetReady: vi.fn(),
    getReadyMediaAsset: vi.fn(), listReadyMediaAssets: vi.fn(), confirmMediaAssetWebRights: vi.fn(), revokeMediaAsset: vi.fn(),
  },
  products: { listProducts: vi.fn() },
  storage: null as null | { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.test" } }));
vi.mock("@/lib/host/server", () => ({
  loadHostProvidersFresh: () => state.providers,
  siteOrigin: () => "https://experience.example.test",
  clearSessionCookie: vi.fn(),
}));
vi.mock("@/lib/experience/store-server", () => ({
  guideRepository: () => state.repository,
  experiencePublicationRepository: () => state.products,
}));
vi.mock("@/lib/guide-cover-storage", () => ({ guideCoverStorage: () => state.storage }));
vi.mock("@/lib/guide-cover-image", () => ({
  GuideCoverImageError: class extends Error { readonly code = "invalid_image"; },
  readGuideCoverInput: vi.fn().mockResolvedValue(Buffer.from("source")),
  processGuideCoverImage: vi.fn().mockResolvedValue({ bytes: Buffer.from("jpeg"), width: 800, height: 600 }),
}));

import { POST as createGuide } from "@/app/(write)/write/api/guides/route";
import { PATCH as saveGuide } from "@/app/(write)/write/api/guides/[articleId]/route";
import { POST as uploadPhoto } from "@/app/(write)/write/api/guides/[articleId]/media/route";
import { DELETE as stopGuide, POST as publishGuide } from "@/app/(write)/write/api/guides/[articleId]/publication/route";
import { parseWriteCreate } from "./server";

const ID = "00000000-0000-4000-8000-000000000001";
const ARTICLE = {
  id: ID,
  slug: "morning-guide",
  subject: { kind: "PROVIDER" as const, providerId: "provider-a" },
  title: "Morning guide",
  description: "",
  content: { markdown: "", language: "en" as const },
  draftProductLinks: [] as readonly { providerId: string; productId: string }[],
  status: "DRAFT" as const,
  revision: 1,
  createdAtUtc: "2026-11-08T00:00:00.000Z",
  updatedAtUtc: "2026-11-08T00:00:00.000Z",
};

function owner(providerId = "provider-a") {
  state.providers = {
    status: "ok",
    nihoUserId: "niho-user-a",
    providers: [{ id: providerId, displayName: "Owner", memberRole: "OWNER", nihoUserId: "niho-user-a", legacyProviderId: providerId }],
  };
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const createBody = { id: ID, providerId: "provider-a", slug: "morning-guide", title: "Morning guide" };
const routeContext = { params: Promise.resolve({ articleId: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  state.providers = { status: "signed-out" };
  state.storage = { write: vi.fn().mockResolvedValue(undefined), read: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) };
  state.repository.createArticle.mockResolvedValue(ARTICLE);
  state.repository.getArticle.mockResolvedValue(ARTICLE);
  state.repository.saveDraft.mockImplementation(async (_actor, _id, draft) => ({ ...ARTICLE, ...draft, draftProductLinks: draft.draftProductLinks ?? [], revision: 2 }));
  state.repository.createMediaAsset.mockResolvedValue({ id: ID, objectKey: `guide-media/${ID}.jpg`, state: "UPLOADING" });
  state.repository.markMediaAssetReady.mockResolvedValue({ id: ID, width: 800, height: 600, byteSize: 4, state: "READY" });
  state.repository.revokeMediaAsset.mockResolvedValue(ARTICLE);
  state.repository.commitPublication.mockResolvedValue({ slug: ARTICLE.slug, visibility: "PUBLIC" });
  state.repository.stopPublication.mockResolvedValue({ ...ARTICLE, status: "STOPPED", revision: 3 });
  state.products.listProducts.mockResolvedValue([]);
});

describe("/write API authority and optimistic writes", () => {
  it("accepts the bounded client create contract", () => {
    expect(parseWriteCreate(createBody)).not.toBeNull();
  });
  it("answers 401 before parsing a signed-out mutation", async () => {
    const response = await createGuide(jsonRequest("https://experience.example.test/write/api/guides", createBody));
    expect(response.status).toBe(401);
    expect(state.repository.createArticle).not.toHaveBeenCalled();
  });

  it("requires the selected provider to be a current OWNER", async () => {
    owner("provider-b");
    const response = await createGuide(jsonRequest("https://experience.example.test/write/api/guides", createBody));
    expect(response.status, await response.clone().text()).toBe(403);
    expect(state.repository.createArticle).not.toHaveBeenCalled();
  });

  it("rejects query fields outside the experience allowlist", async () => {
    owner();
    const response = await createGuide(jsonRequest("https://experience.example.test/write/api/guides?returnTo=https://evil.example", createBody));
    expect(response.status).toBe(400);
    expect(state.repository.createArticle).not.toHaveBeenCalled();
  });

  it("maps an optimistic draft revision failure to 409 without overwriting", async () => {
    owner();
    state.repository.saveDraft.mockRejectedValueOnce(new StoreConflictError("revision mismatch"));
    const response = await saveGuide(jsonRequest(`https://experience.example.test/write/api/guides/${ID}`, {
      slug: "morning-guide", title: "Changed", description: "", content: { markdown: "table stays verbatim", language: "en" }, expectedRevision: 4,
    }, "PATCH"), routeContext);
    expect(response.status).toBe(409);
    expect(state.repository.saveDraft).toHaveBeenCalledWith("niho-user-a", ID, expect.objectContaining({ content: { markdown: "table stays verbatim", language: "en" } }), 4);
  });

  it("replays the same client UUID idempotently and links only a same-provider published experience", async () => {
    owner();
    state.products.listProducts.mockResolvedValue([{ id: "product-a", slug: "tea", status: "PUBLISHED" }]);
    const linked = { ...ARTICLE, draftProductLinks: [{ providerId: "provider-a", productId: "product-a" }], revision: 2 };
    state.repository.saveDraft.mockResolvedValue(linked);
    const first = await createGuide(jsonRequest("https://experience.example.test/write/api/guides?experience=tea", createBody));
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toMatchObject({ created: true, experienceLinked: true, guide: { revision: 2 } });

    state.repository.createArticle.mockRejectedValueOnce(new StoreConflictError("already exists"));
    state.repository.getArticle.mockResolvedValueOnce(linked);
    const retry = await createGuide(jsonRequest("https://experience.example.test/write/api/guides?experience=tea", createBody));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ created: false, experienceLinked: true, guide: { id: ID } });
    expect(state.repository.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("does not adopt an unpublished or other-provider experience slug", async () => {
    owner();
    state.products.listProducts.mockResolvedValue([{ id: "other", slug: "tea", status: "DRAFT" }]);
    const response = await createGuide(jsonRequest("https://experience.example.test/write/api/guides?experience=tea", createBody));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ experienceLinked: false, guide: { draftProductLinks: [] } });
    expect(state.repository.saveDraft).not.toHaveBeenCalled();
  });

  it("returns the actual public URL and Store status for publish and stop", async () => {
    owner();
    const publishedArticle = { ...ARTICLE, status: "PUBLISHED" as const, revision: 2 };
    state.repository.getArticle.mockResolvedValueOnce(publishedArticle);
    const published = await publishGuide(jsonRequest(`https://experience.example.test/write/api/guides/${ID}/publication`, { expectedRevision: 1, visibility: "PUBLIC" }), routeContext);
    expect(await published.json()).toMatchObject({ publication: { status: "PUBLISHED", visibility: "PUBLIC", url: "https://experience.example.test/guides/morning-guide" } });

    const stopped = await stopGuide(jsonRequest(`https://experience.example.test/write/api/guides/${ID}/publication`, { expectedRevision: 2 }, "DELETE"), routeContext);
    expect(await stopped.json()).toMatchObject({ publication: { status: "STOPPED", url: "https://experience.example.test/guides/morning-guide" } });
  });
});

describe("/write photo route", () => {
  it("returns 503 with no private bucket and never reports mock success", async () => {
    owner();
    state.storage = null;
    const response = await uploadPhoto(new Request(`https://experience.example.test/write/api/guides/${ID}/media`, {
      method: "POST", headers: { "content-type": "image/jpeg", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" }, body: "bytes",
    }), routeContext);
    expect(response.status).toBe(503);
    expect(state.repository.createMediaAsset).not.toHaveBeenCalled();
  });

  it("keeps object details private and requires a separate rights confirmation", async () => {
    owner();
    const response = await uploadPhoto(new Request(`https://experience.example.test/write/api/guides/${ID}/media`, {
      method: "POST", headers: { "content-type": "image/jpeg", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" }, body: "bytes",
    }), routeContext);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ asset: { id: ID, width: 800, height: 600, webConfirmed: false } });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("guide-media/");
    expect(state.repository.confirmMediaAssetWebRights).not.toHaveBeenCalled();
  });

  it("removes only the fresh private object and revokes its row when upload fails", async () => {
    owner();
    state.storage!.write.mockRejectedValueOnce(new Error("bucket unavailable"));
    const response = await uploadPhoto(new Request(`https://experience.example.test/write/api/guides/${ID}/media`, {
      method: "POST", headers: { "content-type": "image/jpeg", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" }, body: "bytes",
    }), routeContext);
    expect(response.status).toBe(503);
    expect(state.storage!.remove).toHaveBeenCalledTimes(1);
    expect(state.repository.revokeMediaAsset).toHaveBeenCalledWith("niho-user-a", ID, expect.any(String));
  });
});
