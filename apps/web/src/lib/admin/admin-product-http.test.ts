import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true },
  http: vi.fn(() => true),
  mutation: vi.fn(() => true),
  load: vi.fn(),
  clear: vi.fn(),
  repository: {
    listAdminDraftSellers: vi.fn(),
    listAdminDraftProducts: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./server", () => ({
  isAdminHttp: mocks.http,
  adminMutationAllowed: mocks.mutation,
  loadAdminHttpSession: mocks.load,
  clearAdminHttpSessionCookie: mocks.clear,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => mocks.repository,
  experienceStore: () => null,
}));
vi.mock("@/lib/experience/public-media-storage", () => ({ experiencePublicMediaStorage: () => null }));
vi.mock("@/lib/editor/guide-cover-image", () => ({
  GuideCoverImageError: class extends Error {},
  processGuideCoverImage: vi.fn(),
  readGuideCoverInput: vi.fn(),
}));

import {
  adminDraftProductCollection,
  adminDraftProductRequest,
  adminDraftSellerCollection,
} from "./admin-product-http";

const SITE = "https://experience.example";
const verified = (id = "admin-current") => ({
  status: "ok",
  session: { actorId: id },
  verified: { actor: { id, displayName: "Current Admin" }, connection: { id: "connection", expiresAt: Date.now() + 60_000 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.experienceHostPublicationApiEnabled = true;
  mocks.http.mockReturnValue(true);
  mocks.mutation.mockReturnValue(true);
  mocks.load.mockResolvedValue(verified());
  mocks.repository.listAdminDraftSellers.mockResolvedValue([
    { providerId: "provider-readable", providerDisplayName: "鎌倉の工房", sellerDisplayName: "工房販売者" },
  ]);
  mocks.repository.listAdminDraftProducts.mockResolvedValue([]);
});

describe("Admin product draft BFF", () => {
  it("re-verifies the dedicated ADMIN and returns only the name-based seller DTO", async () => {
    const first = await adminDraftSellerCollection(new Request(`${SITE}/admin/api/product-workspaces`));
    const second = await adminDraftSellerCollection(new Request(`${SITE}/admin/api/product-workspaces`));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.repository.listAdminDraftSellers).toHaveBeenCalledWith({ nihoUserId: "admin-current" });
    const body = await first.json();
    expect(body).toEqual({ sellers: [{ providerId: "provider-readable", providerDisplayName: "鎌倉の工房", sellerDisplayName: "工房販売者" }] });
    expect(JSON.stringify(body)).not.toContain("stripe");
    expect(JSON.stringify(body)).not.toContain("nihoAccount");
  });

  it("derives the audit actor server-side and binds reads to the selected Experience workspace", async () => {
    const response = await adminDraftProductCollection(
      new Request(`${SITE}/admin/api/product-workspaces/provider-readable/products`),
      { params: Promise.resolve({ providerId: "provider-readable" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.repository.listAdminDraftProducts).toHaveBeenCalledWith({ nihoUserId: "admin-current" }, "provider-readable");
  });

  it("re-verifies the ADMIN before rejecting a cross-origin mutation", async () => {
    mocks.mutation.mockReturnValue(false);
    const response = await adminDraftProductCollection(
      new Request(`${SITE}/admin/api/product-workspaces/provider-readable/products`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ slug: "synthetic", publicTitle: "Synthetic", content: {}, currency: "JPY", unitAmount: 1000 }),
      }),
      { params: Promise.resolve({ providerId: "provider-readable" }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("has no Admin publish or stop action", async () => {
    const response = await adminDraftProductRequest(
      new Request(`${SITE}/admin/api/product-workspaces/provider-readable/products/product-one`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }),
      }),
      { params: Promise.resolve({ providerId: "provider-readable", productId: "product-one" }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("fails closed and clears a rejected Admin session", async () => {
    mocks.load.mockResolvedValue({ status: "rejected" });
    const response = await adminDraftSellerCollection(new Request(`${SITE}/admin/api/product-workspaces`));
    expect(response.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.repository.listAdminDraftSellers).not.toHaveBeenCalled();
  });
});
