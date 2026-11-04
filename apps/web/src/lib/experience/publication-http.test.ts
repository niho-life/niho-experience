import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" },
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  repository: {
    ensureOwnerWorkspace: vi.fn(),
    refreshReadiness: vi.fn(),
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    getState: vi.fn(),
    getSaleTerms: vi.fn(),
    listMedia: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    saveSaleTerms: vi.fn(),
    publish: vi.fn(),
    stop: vi.fn(),
    addMedia: vi.fn(),
  },
  state: {} as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: {
    "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
  } }),
}));
vi.mock("./publication-host-boundary", () => ({
  publicationHostBoundary: mocks.boundary,
  publicationHostMutationAllowed: mocks.mutationAllowed,
}));
vi.mock("./store-server", () => ({ experiencePublicationRepository: () => mocks.repository }));
vi.mock("./public-media-storage", () => ({ experiencePublicMediaStorage: () => null }));
vi.mock("@/lib/editor/guide-cover-image", () => ({
  GuideCoverImageError: class extends Error { code = "invalid_image"; },
  processGuideCoverImage: vi.fn(),
  readGuideCoverInput: vi.fn(),
}));

import { GET as listProducts, POST as createProduct } from "@/app/(host)/host/api/products/route";
import { GET as readProduct, PATCH as saveProduct } from "@/app/(host)/host/api/products/[productId]/route";
import { PUT as saveTerms } from "@/app/(host)/host/api/products/[productId]/sale-terms/route";
import { POST as publishProduct } from "@/app/(host)/host/api/products/[productId]/publish/route";
import { POST as stopProduct } from "@/app/(host)/host/api/products/[productId]/stop/route";

const actor = { providerId: "provider-private", nihoUserId: "niho-user-private" };
const hostContext = {
  actor,
  provider: { id: "provider-private", displayName: "Panasonic", memberRole: "OWNER" },
  readiness: {
    accountUsable: true, connectReady: true, sellerDisplayReady: true,
    sellerNihoAccountRef: "niho-user-private", stripeConnectAccountRef: "acct_PRIVATE",
    sellerDisplayName: "Panasonic", requiredConsentVersion: "listing-v1",
    observedAtUtc: "2026-11-04T00:00:00.000Z", validUntilUtc: "2026-11-04T00:05:00.000Z",
  },
};
const product = {
  id: "product-synthetic",
  providerId: "provider-private",
  version: 4,
  status: "PUBLISHED",
  slug: "synthetic-dinner",
  publicTitle: "Synthetic dinner",
  content: { description: "Synthetic description" },
  currency: "JPY",
  unitAmount: 30000,
  cancellationTermsRef: "private-cancellation-ref",
  sellerNihoAccountRef: "private-niho-account",
  stripeConnectAccountRef: "acct_PRIVATE",
  sellerDisplayName: "Panasonic",
  createdAtUtc: "2026-11-04T00:00:00.000Z",
  updatedAtUtc: "2026-11-04T00:00:00.000Z",
};
const state = {
  providerId: "provider-private", productId: product.id, currentPublicationId: 33,
  selfStoppedAtUtc: null, operationsSuspendedAtUtc: null, operationsSuspensionCode: null,
  ownerResumeRequired: false, firstPublishedAtUtc: "2026-11-04T00:00:00.000Z", version: 3,
  updatedAtUtc: "2026-11-04T00:00:00.000Z",
};
const terms = {
  offerPrices: null,
  childPricing: null,
  minimumParticipants: 1,
  minimumChargeableParticipants: 1,
  maxPartySize: 6,
  cancellationPolicy: "FREE_UNTIL_24H",
  cancellationWindowMinutesBeforeStart: null,
  cancellationRefundBasisPoints: null,
  minimumAttendance: 1,
  bookingQuestions: [],
  conditionsVersion: null,
  version: 2,
  updatedAtUtc: "2026-11-04T00:00:00.000Z",
};
const media = [{ id: "00000000-0000-4000-8000-000000000401", position: 0, width: 640, height: 480, byteSize: 4096, altText: "Synthetic dinner", publicCredit: null }];
const draft = { slug: product.slug, publicTitle: product.publicTitle, content: product.content, currency: "JPY", unitAmount: product.unitAmount };
const saleTerms = {
  offerPrices: null, childPricing: null, minimumParticipants: 1, minimumChargeableParticipants: 1,
  maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_24H", minimumAttendance: 1, bookingQuestions: [], conditionsVersion: null,
};
const context = { params: Promise.resolve({ productId: product.id }) };

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://experience.example.test${path}`, {
    method,
    headers: {
      origin: "https://experience.example.test",
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Experience owner product API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" });
    mocks.boundary.mockResolvedValue({ ok: true, value: hostContext });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.repository.listProducts.mockResolvedValue([product]);
    mocks.repository.getProduct.mockResolvedValue(product);
    mocks.repository.getState.mockResolvedValue(state);
    mocks.repository.getSaleTerms.mockResolvedValue({ draftVersion: 4, stateVersion: 3, saleTerms: terms });
    mocks.repository.listMedia.mockResolvedValue(media);
    mocks.repository.createDraft.mockResolvedValue(product);
    mocks.repository.saveDraft.mockResolvedValue({ draft: product, publicationUpdated: true, blockers: [] });
    mocks.repository.saveSaleTerms.mockResolvedValue({ draftVersion: 4, stateVersion: 3, saleTerms: terms, publicationUpdated: true, blockers: [] });
    mocks.repository.publish.mockResolvedValue(state);
    mocks.repository.stop.mockResolvedValue({ ...state, selfStoppedAtUtc: "2026-11-04T01:00:00.000Z", version: 4 });
  });

  it("creates and lists a product without accepting or returning seller/provider/payment fields", async () => {
    const created = await createProduct(request("/host/api/products", "POST", draft));
    expect(created.status).toBe(201);
    expect(mocks.repository.createDraft).toHaveBeenCalledWith(actor, draft);
    const createdBody = await created.json();
    expect(createdBody.product).toMatchObject({ id: product.id, status: "PUBLISHED", sellerDisplayName: "Panasonic" });
    expect(createdBody.product.version).toEqual(expect.any(String));
    for (const key of ["providerId", "sellerNihoAccountRef", "stripeConnectAccountRef", "cancellationTermsRef"]) {
      expect(createdBody.product).not.toHaveProperty(key);
    }

    const listed = await listProducts(request("/host/api/products"));
    expect(listed.status).toBe(200);
    expect((await listed.json()).products).toHaveLength(1);
    expect(mocks.repository.ensureOwnerWorkspace).toHaveBeenCalled();
    expect(mocks.repository.refreshReadiness).toHaveBeenCalledWith(actor, hostContext.readiness);
  });

  it("uses one opaque version for edit, sale terms, publish, stop and restart", async () => {
    const read = await readProduct(request(`/host/api/products/${product.id}`), context);
    const dto = (await read.json()).product;
    const version = dto.version;
    expect(dto.version).toEqual(expect.any(String));
    expect(dto.media[0].previewUrl).toContain(media[0]!.id);

    const saved = await saveProduct(request(`/host/api/products/${product.id}`, "PATCH", { version, draft }), context);
    expect(saved.status).toBe(200);
    expect(mocks.repository.saveDraft).toHaveBeenCalledWith(actor, {
      ...draft, id: product.id, cancellationTermsRef: product.cancellationTermsRef,
    }, 4, 3, expect.objectContaining({ manuscriptReady: false, photosReady: true }));

    const termsSaved = await saveTerms(request(`/host/api/products/${product.id}/sale-terms`, "PUT", { version, saleTerms }), context);
    expect(termsSaved.status).toBe(200);
    expect(mocks.repository.saveSaleTerms).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({
      expectedDraftVersion: 4, expectedStateVersion: 3, expectedSaleTermsVersion: 2, saleTerms,
    }));

    const published = await publishProduct(request(`/host/api/products/${product.id}/publish`, "POST", {
      version, consentVersion: "listing-v1", accepted: true,
    }), context);
    expect(published.status).toBe(200);
    expect(mocks.repository.publish).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({
      expectedDraftVersion: 4, expectedStateVersion: 3, expectedSaleTermsVersion: 2, consentVersion: "listing-v1",
    }));

    const stopped = await stopProduct(request(`/host/api/products/${product.id}/stop`, "POST", { version }), context);
    expect(stopped.status).toBe(200);
    expect(mocks.repository.stop).toHaveBeenCalledWith(actor, product.id, 3);
  });

  it("rejects seller selection, old paths, stale versions and unaccepted consent", async () => {
    const selected = await createProduct(request("/host/api/products", "POST", { ...draft, providerId: "provider-other" }));
    expect(selected.status).toBe(400);
    expect(mocks.boundary).not.toHaveBeenCalled();

    expect((await listProducts(request("/host/api/products?providerId=provider-private"))).status).toBe(404);
    const legacyContext = { params: Promise.resolve({ productId: "provider-private/product-1" }) };
    expect((await readProduct(request("/host/api/products/provider-private/product-1"), legacyContext)).status).toBe(404);

    const declined = await publishProduct(request(`/host/api/products/${product.id}/publish`, "POST", {
      version: Buffer.from("1:4:3:2").toString("base64url"), consentVersion: "listing-v1", accepted: false,
    }), context);
    expect(declined.status).toBe(422);
    expect(await declined.json()).toEqual({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_REQUIRED"] } });
  });

  it("rejects unknown sale terms, retired private booking, and cross-origin writes", async () => {
    for (const addition of [{ sellerDisplayName: "fake" }, { privateBooking: true }]) {
      const response = await saveTerms(request(`/host/api/products/${product.id}/sale-terms`, "PUT", {
        version: "bad", saleTerms: { ...saleTerms, ...addition },
      }), context);
      expect(response.status).toBe(400);
    }
    mocks.mutationAllowed.mockReturnValue(false);
    const denied = await saveProduct(request(`/host/api/products/${product.id}`, "PATCH", { version: "x", draft }), context);
    expect(denied.status).toBe(403);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });
});
