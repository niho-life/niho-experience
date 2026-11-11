import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", experiencePayoutAccountConsentVersion: "payout-v1" },
  http: vi.fn(() => true),
  mutation: vi.fn(() => true),
  load: vi.fn(),
  clear: vi.fn(),
  retrieve: vi.fn(),
  repository: {
    listAdminDraftSellers: vi.fn(),
    listAdminDraftProducts: vi.fn(),
    getAdminDraftPublicationStatus: vi.fn(),
    publishAdminDraft: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/experience-payments", () => ({ retrieveConnectedAccount: mocks.retrieve }));
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
vi.mock("@/lib/guide-cover-image", () => ({
  GuideCoverImageError: class extends Error {},
  processGuideCoverImage: vi.fn(),
  readGuideCoverInput: vi.fn(),
}));

import {
  adminDraftProductCollection,
  adminDraftProductRequest,
  adminDraftPublishRequest,
  adminDraftSellerCollection,
} from "./admin-product-http";

const SITE = "https://experience.example";
const account = "acct_SyntheticPayout01";
const publication = { draftVersion: 1, stateVersion: null, saleTermsVersion: 2, payoutAccountRef: account, blockers: [] };
const publishContext = { params: Promise.resolve({ providerId: "provider-readable", productId: "product-one" }) };
function publishRequest() {
  return new Request(`${SITE}/admin/api/product-workspaces/provider-readable/products/product-one/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: Buffer.from("1:1:0:2").toString("base64url"),
      accepted: true, sellerConfirmationMethod: "WRITTEN", photoRightsConfirmed: true, consentVersion: "listing-v1",
    }),
  });
}
const verified = (id = "admin-current") => ({
  status: "ok",
  kind: "niho",
  actor: { id, displayName: "Current Admin" },
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
  mocks.repository.getAdminDraftPublicationStatus.mockResolvedValue(publication);
  mocks.repository.publishAdminDraft.mockResolvedValue({ version: 1 });
  mocks.retrieve.mockResolvedValue({ kind: "ready" });
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "synthetic-test-key");
});

afterEach(() => vi.unstubAllEnvs());

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

  it("requires the dedicated publish endpoint for an Admin publication", async () => {
    const response = await adminDraftProductRequest(
      new Request(`${SITE}/admin/api/product-workspaces/provider-readable/products/product-one`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }),
      }),
      { params: Promise.resolve({ providerId: "provider-readable", productId: "product-one" }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("checks the registered account during Admin publication and keeps it out of the response", async () => {
    const response = await adminDraftPublishRequest(publishRequest(), publishContext);
    expect(mocks.retrieve).toHaveBeenCalledWith({ accountId: account, platformStripeKey: "synthetic-test-key" });
    expect(mocks.repository.publishAdminDraft).toHaveBeenCalledWith(
      { nihoUserId: "admin-current" }, "provider-readable", "product-one",
      expect.objectContaining({ payoutConsentVersion: "payout-v1", accountCheck: { stripeConnectAccountRef: account, checkedAtUtc: expect.any(String) } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publication: { status: "PUBLISHED", version: 1 } });
  });

  it("stops before consulting Stripe when payout consent is missing", async () => {
    mocks.repository.getAdminDraftPublicationStatus.mockResolvedValue({ ...publication, blockers: ["PAYMENT_REUSE_CONSENT_REQUIRED"] });
    const response = await adminDraftPublishRequest(publishRequest(), publishContext);
    expect(response.status).toBe(422);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.repository.publishAdminDraft).not.toHaveBeenCalled();
  });

  it.each([["not_ready", 422], ["unreachable", 503]])("leaves the draft unpublished when Stripe answers %s", async (kind, status) => {
    mocks.retrieve.mockResolvedValue({ kind });
    const response = await adminDraftPublishRequest(publishRequest(), publishContext);
    expect(response.status).toBe(status);
    expect(mocks.repository.publishAdminDraft).not.toHaveBeenCalled();
  });

  it("fails closed and clears a rejected Admin session", async () => {
    mocks.load.mockResolvedValue({ status: "rejected" });
    const response = await adminDraftSellerCollection(new Request(`${SITE}/admin/api/product-workspaces`));
    expect(response.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.repository.listAdminDraftSellers).not.toHaveBeenCalled();
  });
});
