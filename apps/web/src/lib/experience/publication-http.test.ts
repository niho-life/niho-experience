import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" } as Record<string, unknown>,
  managedSalesGet: vi.fn(),
  disclosureRead: vi.fn(),
  platformAccount: vi.fn(),
  consentCounts: vi.fn(),
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  mediaStorage: null as null | { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
  coverInput: vi.fn(),
  coverImage: vi.fn(),
  repository: {
    refreshReadiness: vi.fn(),
    providerHasSellerProfile: vi.fn(),
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    getState: vi.fn(),
    getSaleTerms: vi.fn(),
    listMedia: vi.fn(),
    hasPendingPublicationChanges: vi.fn(),
    listActiveSaleOffers: vi.fn(),
    getPublicationBlockers: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    saveSaleTerms: vi.fn(),
    publish: vi.fn(),
    publishPage: vi.fn(),
    openBooking: vi.fn(),
    stopBooking: vi.fn(),
    stop: vi.fn(),
    addMedia: vi.fn(),
    getProviderMedia: vi.fn(),
    addProviderMedia: vi.fn(),
    saveProviderMediaSelection: vi.fn(),
    revokeProviderMedia: vi.fn(),
  },
  meetingGuides: { readForProduct: vi.fn(), saveForProduct: vi.fn() },
  translator: vi.fn(),
  ownStripe: vi.fn(),
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
vi.mock("./store-server", () => ({
  experiencePublicationRepository: () => mocks.repository,
  guestMeetingGuideRepository: () => mocks.meetingGuides,
  managedExperienceSalesRepository: () => (mocks.config.hostAgentSalesEnabled === true ? { get: mocks.managedSalesGet } : null),
  providerSellerDisclosureRepository: () => ({ getForOwner: mocks.disclosureRead }),
  providerAgentSales: () => ({ consentCounts: mocks.consentCounts }),
  directSellers: () => ({ ownStripeSellerName: mocks.ownStripe }),
}));
vi.mock("@niho-experience/experience-payments", () => ({ retrievePlatformAccount: mocks.platformAccount }));
vi.mock("@/lib/translation/anthropic", () => ({ anthropicTranslator: () => mocks.translator }));
vi.mock("./public-media-storage", () => ({ experiencePublicMediaStorage: () => mocks.mediaStorage }));
vi.mock("@/lib/guide-cover-image", () => ({
  GuideCoverImageError: class extends Error { code = "invalid_image"; },
  processGuideCoverImage: mocks.coverImage,
  readGuideCoverInput: mocks.coverInput,
}));

import { GET as listProducts, POST as createProduct } from "@/app/(host)/host/api/products/route";
import { GET as readProduct, PATCH as saveProduct } from "@/app/(host)/host/api/products/[productId]/route";
import { PUT as saveTerms } from "@/app/(host)/host/api/products/[productId]/sale-terms/route";
import { POST as publishProduct } from "@/app/(host)/host/api/products/[productId]/publish/route";
import { POST as stopProduct } from "@/app/(host)/host/api/products/[productId]/stop/route";
import { POST as publishPage } from "@/app/(host)/host/api/products/[productId]/publish-page/route";
import { POST as openBooking } from "@/app/(host)/host/api/products/[productId]/open-booking/route";
import { POST as stopBooking } from "@/app/(host)/host/api/products/[productId]/stop-booking/route";
import { POST as uploadProductMedia } from "@/app/(host)/host/api/products/[productId]/media/route";
import { GET as readProviderMedia, PUT as saveProviderMedia } from "@/app/(host)/host/api/provider-media/route";
import { POST as uploadProviderMedia } from "@/app/(host)/host/api/provider-media/upload/route";
import { GET as readBookingGuide, PUT as saveBookingGuide } from "@/app/(host)/host/api/products/[productId]/booking-guide/route";
import { POST as translateProduct } from "@/app/(host)/host/api/products/[productId]/translation/route";
import { publicationManuscriptFingerprint } from "@niho-experience/experience-store";

const actor = { providerId: "provider-private", nihoUserId: "niho-user-private" };
const hostContext = {
  actor,
  provider: { providerId: "provider-private", legacyProviderId: "legacy-provider-private", providerDisplayName: "Panasonic", sellerNihoAccountRef: "niho-user-private", stripeConnectAccountRef: "acct_PRIVATE", sellerDisplayName: "Panasonic" },
  readiness: {
    accountUsable: true, connectReady: true, sellerDisplayReady: true,
    paymentReuseConsentAccepted: true, paymentReuseConsentVersion: "synthetic-consent-v1", paymentReuseConsentedAtUtc: "2026-11-04T00:00:00.000Z",
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
  seller: { sellerNihoAccountRef: "private-niho-account", stripeConnectAccountRef: "acct_PRIVATE", sellerDisplayName: "Panasonic" },
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
const media = [{ id: "00000000-0000-4000-8000-000000000401", position: 0, sourcePosition: 0, placement: "GALLERY", width: 640, height: 480, byteSize: 4096, altText: "Synthetic dinner", altTextJa: "合成ディナー", publicCredit: null }];
const providerMedia = { version: 5, assets: [{ id: "00000000-0000-4000-8000-000000000402", placement: "PROVIDER_PHOTO", width: 640, height: 480, byteSize: 2048, altText: "Synthetic provider", altTextJa: "合成提供者", publicCredit: null }] };
const draft = {
  slug: product.slug,
  publicTitle: product.publicTitle,
  content: {
    lead: "A synthetic lead.", description: "A complete synthetic description.",
    facts: { language: "English" }, highlights: ["A synthetic highlight."], included: ["Synthetic materials"],
    notIncluded: [], knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
    meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
  },
  currency: "JPY",
  unitAmount: product.unitAmount,
};
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
    mocks.mediaStorage = null;
    Object.assign(mocks.config, { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test",
      hostAgentSalesEnabled: false, hostAccountsEnabled: false });
    mocks.boundary.mockResolvedValue({ ok: true, value: hostContext });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.repository.listProducts.mockResolvedValue([product]);
    mocks.repository.getProduct.mockResolvedValue(product);
    mocks.repository.getState.mockResolvedValue(state);
    mocks.repository.getSaleTerms.mockResolvedValue({ draftVersion: 4, stateVersion: 3, saleTerms: terms });
    mocks.repository.listMedia.mockResolvedValue(media);
    mocks.repository.hasPendingPublicationChanges.mockResolvedValue(false);
    mocks.repository.listActiveSaleOffers.mockResolvedValue([{ id: "dinner-evening", localStartTime: "18:00", durationMinutes: 90, capacity: 6, recurrence: { kind: "WEEKLY" } }]);
    mocks.repository.getPublicationBlockers.mockResolvedValue([]);
    mocks.repository.createDraft.mockResolvedValue(product);
    mocks.repository.saveDraft.mockResolvedValue({ draft: product, publicationUpdated: true, blockers: [] });
    mocks.repository.saveSaleTerms.mockResolvedValue({ draftVersion: 4, stateVersion: 3, saleTerms: terms, publicationUpdated: true, blockers: [] });
    mocks.repository.publish.mockResolvedValue(state);
    mocks.repository.publishPage.mockResolvedValue(state);
    mocks.repository.openBooking.mockResolvedValue(state);
    mocks.repository.stopBooking.mockResolvedValue({ ...state, version: 4 });
    mocks.repository.stop.mockResolvedValue({ ...state, selfStoppedAtUtc: "2026-11-04T01:00:00.000Z", version: 4 });
    mocks.repository.getProviderMedia.mockResolvedValue(providerMedia);
    mocks.repository.addProviderMedia.mockResolvedValue(providerMedia);
    mocks.repository.saveProviderMediaSelection.mockResolvedValue(providerMedia);
    mocks.repository.revokeProviderMedia.mockResolvedValue({ version: 6, assets: [] });
    mocks.meetingGuides.readForProduct.mockResolvedValue({ version: null, guide: null, updatedAtUtc: null });
    mocks.meetingGuides.saveForProduct.mockResolvedValue({ version: 1, guide: null, updatedAtUtc: "2026-11-04T01:00:00.000Z" });
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
    expect(mocks.repository.refreshReadiness).toHaveBeenCalledWith(actor, hostContext.readiness);
    expect(mocks.repository.refreshReadiness).toHaveBeenCalledWith(actor, hostContext.readiness);
  });

  it("asks for the sale side (readiness) only where the screens show or check it, and passes ?providerId= as a hint", async () => {
    const withoutSales = { actor, role: "OWNER", provider: null, readiness: null };
    const membershipOnly = { providerId: null, sales: "none" } as const;
    const cases: Array<[string, () => Promise<Response>, unknown[]]> = [
      ["provider media read", () => readProviderMedia(request("/host/api/provider-media")), ["OWNER", membershipOnly]],
      ["provider media save", () => saveProviderMedia(request("/host/api/provider-media", "PUT", { version: 5, media: [] })), ["OWNER", membershipOnly]],
      ["booking guide", () => readBookingGuide(request(`/host/api/products/${product.id}/booking-guide`), context), ["OWNER", membershipOnly]],
      // Product screens return the publication blockers the store reads from the snapshot, so they keep the sale side.
      // They ask for it "optionally": resolved when the provider has a seller, absent (no Stripe) when it has none (#704).
      ["product list", () => listProducts(request("/host/api/products")), ["READ", { providerId: null, sales: "optional" }]],
      ["product read", () => readProduct(request(`/host/api/products/${product.id}`), context), ["READ", { providerId: null, sales: "optional" }]],
      ["product list with hint", () => listProducts(request("/host/api/products?providerId=provider-private")), ["READ", { providerId: "provider-private", sales: "optional" }]],
    ];
    for (const [name, call, args] of cases) {
      mocks.boundary.mockClear();
      mocks.repository.refreshReadiness.mockClear();
      const sales = args.length === 2 && ((args[1] as { sales?: string }).sales === undefined || (args[1] as { sales?: string }).sales === "optional");
      mocks.boundary.mockResolvedValue({ ok: true, value: sales ? hostContext : withoutSales });
      await call();
      expect(mocks.boundary, name).toHaveBeenCalledWith(...args);
      // The snapshot is written only when the boundary resolved one: a membership-only request writes nothing.
      expect(mocks.repository.refreshReadiness.mock.calls.length > 0, name).toBe(sales);
    }
  });

  describe("a provider with no seller (#704)", () => {
    const sellerless = { ...product, status: "DRAFT", seller: null };
    const sellerlessContext = { actor, role: "OWNER", provider: null, readiness: null };

    it("lists, reads, creates and edits drafts with no seller or readiness, and reports SELLER_REQUIRED", async () => {
      mocks.boundary.mockResolvedValue({ ok: true, value: sellerlessContext });
      mocks.repository.listProducts.mockResolvedValue([sellerless]);
      mocks.repository.getProduct.mockResolvedValue(sellerless);
      mocks.repository.getState.mockResolvedValue(null);
      mocks.repository.createDraft.mockResolvedValue(sellerless);
      mocks.repository.getPublicationBlockers.mockResolvedValue(["SELLER_REQUIRED"]);
      mocks.repository.saveDraft.mockResolvedValue({ draft: sellerless, publicationUpdated: false, blockers: ["SELLER_REQUIRED"] });

      const listed = await listProducts(request("/host/api/products"));
      expect(listed.status).toBe(200);
      const listedBody = await listed.json();
      expect(listedBody.products).toHaveLength(1);
      expect(listedBody.products[0]).toMatchObject({ status: "DRAFT", sellerDisplayName: null, publicationBlockers: ["SELLER_REQUIRED"] });

      const created = await createProduct(request("/host/api/products", "POST", draft));
      expect(created.status).toBe(201);
      // The seller is never taken from the request: createDraft gets the actor and the draft only.
      expect(mocks.repository.createDraft).toHaveBeenCalledWith(actor, draft);
      const createdBody = await created.json();
      expect(createdBody.product).toMatchObject({ status: "DRAFT", sellerDisplayName: null });
      for (const key of ["providerId", "sellerNihoAccountRef", "stripeConnectAccountRef", "cancellationTermsRef", "seller"]) {
        expect(createdBody.product).not.toHaveProperty(key);
      }

      const read = await readProduct(request(`/host/api/products/${product.id}`), context);
      expect(read.status).toBe(200);
      const version = (await read.json()).product.version;
      const saved = await saveProduct(request(`/host/api/products/${product.id}`, "PATCH", { version, draft }), context);
      expect(saved.status).toBe(200);
      expect((await saved.json()).blockers).toEqual(["SELLER_REQUIRED"]);
      const terms = await saveTerms(request(`/host/api/products/${product.id}/sale-terms`, "PUT", { version, saleTerms }), context);
      expect(terms.status).toBe(200);

      // No Stripe-derived snapshot is written for a provider with no seller.
      expect(mocks.repository.refreshReadiness).not.toHaveBeenCalled();
      for (const call of mocks.boundary.mock.calls) {
        expect(call[1], String(call[0])).toMatchObject({ sales: "optional" });
      }
    });

    it("still needs the seller (SELLER_SETUP_REQUIRED) to publish or stop", async () => {
      const body = { consentVersion: "listing-v1", accepted: true };
      mocks.boundary.mockResolvedValueOnce({ ok: true, value: sellerlessContext });
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      mocks.boundary.mockImplementation(async () => ({ ok: false, response: Response.json({ error: { code: "SELLER_SETUP_REQUIRED" } }, { status: 409 }) }));
      mocks.boundary.mockClear();
      for (const [name, call] of [
        ["publish", () => publishProduct(request(`/host/api/products/${product.id}/publish`, "POST", { ...body, version }), context)],
        ["stop", () => stopProduct(request(`/host/api/products/${product.id}/stop`, "POST", { version }), context)],
      ] as const) {
        const response = await call();
        expect(response.status, name).toBe(409);
        expect(await response.json(), name).toEqual({ error: { code: "SELLER_SETUP_REQUIRED" } });
      }
      // Both ask for the whole sale side (no `sales` option means readiness).
      for (const call of mocks.boundary.mock.calls) expect(call[1]).not.toHaveProperty("sales");
      expect(mocks.repository.publish).not.toHaveBeenCalled();
      expect(mocks.repository.stop).not.toHaveBeenCalled();
    });
  });

  it("uses one opaque version for edit, sale terms, publish, stop and restart", async () => {
    const read = await readProduct(request(`/host/api/products/${product.id}`), context);
    const dto = (await read.json()).product;
    const version = dto.version;
    expect(dto.version).toEqual(expect.any(String));
    // The image URL names the provider: an owner of two hosts would otherwise get 409 PROVIDER_REQUIRED for every image (#709).
    expect(dto.media[0].previewUrl).toBe(`/host/api/products/${product.id}/media/${media[0]!.id}?providerId=${actor.providerId}`);
    expect(dto.offers).toEqual([expect.objectContaining({ id: "dinner-evening", localStartTime: "18:00" })]);
    expect(dto.publicationBlockers).toEqual([]);

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

  it.each([false, true])("returns the product version and removes only the unused upload when reusing=%s", async (reuse) => {
    const addedMedia = {
      id: "00000000-0000-4000-8000-000000000402", position: 1, sourcePosition: 1, placement: "GALLERY", width: 640, height: 480,
      byteSize: 2048, altText: "Second synthetic photo", altTextJa: "2枚目の合成写真", publicCredit: null,
    };
    mocks.mediaStorage = { write: vi.fn().mockResolvedValue(undefined), read: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) };
    mocks.coverInput.mockResolvedValue(Buffer.from("synthetic-original"));
    mocks.coverImage.mockResolvedValue({ bytes: Buffer.from("synthetic-jpeg"), width: 640, height: 480 });
    let selectedId = addedMedia.id;
    mocks.repository.addMedia.mockImplementation((_actor: unknown, _productId: unknown, input: { id: string }) => {
      selectedId = reuse ? addedMedia.id : input.id;
      return { ...addedMedia, id: selectedId };
    });
    mocks.repository.getProduct.mockResolvedValue({ ...product, version: 5 });
    mocks.repository.getSaleTerms.mockResolvedValue({ draftVersion: 5, stateVersion: 3, saleTerms: terms });
    mocks.repository.listMedia.mockImplementation(() => [...media, { ...addedMedia, id: selectedId }]);
    const response = await uploadProductMedia(new Request(`https://experience.example.test/host/api/products/${product.id}/media`, {
      method: "POST",
      headers: {
        origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "image/jpeg",
        "x-experience-photo-rights-confirmed": "true",
        "x-experience-photo-alt-text-utf8-base64url": Buffer.from("Second synthetic photo").toString("base64url"),
        "x-experience-photo-alt-text-ja-utf8-base64url": Buffer.from("2枚目の合成写真").toString("base64url"),
        "x-experience-media-placement": "GALLERY",
      },
      body: Buffer.from("request-body"),
    }), context);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.asset.id).toBe(selectedId);
    if (reuse) expect(mocks.mediaStorage.remove).toHaveBeenCalledWith(mocks.mediaStorage.write.mock.calls[0]![0]);
    else expect(mocks.mediaStorage.remove).not.toHaveBeenCalled();
    expect(body.product.version).toBe(Buffer.from("1:5:3:2").toString("base64url"));
    expect(body.product.media).toHaveLength(2);
    expect(mocks.repository.addMedia).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({
      altText: "Second synthetic photo", altTextJa: "2枚目の合成写真",
    }));
  });

  it("uses seller-level profile media with explicit rights, localized alts, and version CAS", async () => {
    const read = await readProviderMedia(request("/host/api/provider-media"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ providerMedia: { version: 5, assets: [{ previewUrl: `/host/api/provider-media/${providerMedia.assets[0]!.id}?providerId=${actor.providerId}` }] } });

    const updated = await saveProviderMedia(request("/host/api/provider-media", "PUT", {
      version: 5,
      media: [{ id: providerMedia.assets[0]!.id, placement: "PROVIDER_PHOTO", altText: "Reviewed provider", altTextJa: "確認済み提供者", publicCredit: null }],
    }));
    expect(updated.status).toBe(200);
    expect(mocks.repository.saveProviderMediaSelection).toHaveBeenCalledWith(actor, 5, [{
      id: providerMedia.assets[0]!.id, placement: "PROVIDER_PHOTO", altText: "Reviewed provider", altTextJa: "確認済み提供者", publicCredit: null,
    }]);

    mocks.mediaStorage = { write: vi.fn().mockResolvedValue(undefined), read: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) };
    mocks.coverInput.mockResolvedValue(Buffer.from("synthetic-provider-original"));
    mocks.coverImage.mockResolvedValue({ bytes: Buffer.from("synthetic-provider-jpeg"), width: 640, height: 480 });
    const uploaded = await uploadProviderMedia(new Request("https://experience.example.test/host/api/provider-media/upload", {
      method: "POST",
      headers: {
        origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "image/jpeg",
        "x-experience-photo-rights-confirmed": "true",
        "x-experience-photo-alt-text-utf8-base64url": Buffer.from("Synthetic provider replacement").toString("base64url"),
        "x-experience-photo-alt-text-ja-utf8-base64url": Buffer.from("合成提供者の差替え").toString("base64url"),
        "x-experience-media-placement": "PROVIDER_PHOTO", "x-experience-provider-media-version": "5",
      }, body: Buffer.from("synthetic-request"),
    }));
    expect(uploaded.status).toBe(201);
    expect(mocks.repository.addProviderMedia).toHaveBeenCalledWith(actor, 5, expect.objectContaining({
      placement: "PROVIDER_PHOTO", altText: "Synthetic provider replacement", altTextJa: "合成提供者の差替え",
    }));
  });

  it("requires the current profile version before replacing a public profile image", async () => {
    mocks.mediaStorage = { write: vi.fn(), read: vi.fn(), remove: vi.fn() };
    const response = await uploadProviderMedia(new Request("https://experience.example.test/host/api/provider-media/upload", {
      method: "POST",
      headers: {
        origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "image/jpeg",
        "x-experience-photo-rights-confirmed": "true",
        "x-experience-photo-alt-text-utf8-base64url": Buffer.from("Synthetic provider").toString("base64url"),
        "x-experience-photo-alt-text-ja-utf8-base64url": Buffer.from("合成提供者").toString("base64url"),
        "x-experience-media-placement": "PROVIDER_PHOTO",
      }, body: Buffer.from("synthetic-request"),
    }));
    expect(response.status).toBe(400);
    expect(mocks.coverInput).not.toHaveBeenCalled();
    expect(mocks.mediaStorage.write).not.toHaveBeenCalled();
  });

  it("keeps booking logistics in the owner-only private guide contract, separate from sale terms", async () => {
    const guide = {
      collectionOverview: "Blue flag", address: "1-2-3 Synthetic, Kamakura", accessInstructions: "Walk east.",
      entranceInstructions: "Use the garden gate.", mapUrl: "https://maps.example.test/synthetic",
      photoAssetId: "00000000-0000-4000-8000-000000000401", itemsToBring: ["Water bottle"], weatherPlan: "Move indoors.",
    };
    const read = await readBookingGuide(request(`/host/api/products/${product.id}/booking-guide`), context);
    expect(read.status).toBe(200);
    expect((await read.json()).bookingGuide).toEqual({ version: null, guide: null, updatedAtUtc: null });
    // Classification and the guide are membership-only: no seller, no Stripe, no readiness snapshot.
    expect(mocks.boundary).toHaveBeenCalledWith("OWNER", { providerId: null, sales: "none" });

    const saved = await saveBookingGuide(request(`/host/api/products/${product.id}/booking-guide`, "PUT", { expectedVersion: null, guide }), context);
    expect(saved.status).toBe(200);
    expect(mocks.meetingGuides.saveForProduct).toHaveBeenCalledWith(actor, product.id, null, guide);
    expect(mocks.repository.saveSaleTerms).not.toHaveBeenCalled();
    expect(mocks.repository.saveDraft).not.toHaveBeenCalled();

    const withPhone = await saveBookingGuide(request(`/host/api/products/${product.id}/booking-guide`, "PUT", {
      expectedVersion: null, guide: { ...guide, dayOfContactPhone: "+81 90 0000 0000" },
    }), context);
    expect(withPhone.status).toBe(400);
    mocks.config.experienceHostPublicationApiEnabled = false;
    expect((await readBookingGuide(request(`/host/api/products/${product.id}/booking-guide`), context)).status).toBe(404);
  });

  it("rejects seller selection, old paths, stale versions and unaccepted consent", async () => {
    const selected = await createProduct(request("/host/api/products", "POST", { ...draft, providerId: "provider-other" }));
    expect(selected.status).toBe(400);
    expect(mocks.boundary).not.toHaveBeenCalled();

    // Only ?providerId= is a query these APIs take (a hint the boundary checks); any other query, or a malformed id, is refused.
    expect((await listProducts(request("/host/api/products?seller=provider-private"))).status).toBe(404);
    expect((await listProducts(request("/host/api/products?providerId=a&providerId=b"))).status).toBe(404);
    expect((await listProducts(request("/host/api/products?providerId=bad%20id"))).status).toBe(422);
    expect(mocks.boundary).not.toHaveBeenCalled();
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

  describe("optional FAQ (#146)", () => {
    const faq = [{ question: "Can children join?", answer: "Yes, from age 6." }];
    const japanese = {
      title: "合成の夕食", lead: "合成の紹介", description: "合成の説明", language: "英語",
      highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
    };

    it("accepts a complete FAQ in either manuscript on create and save and passes it to the store unchanged", async () => {
      const withFaq = { ...draft, content: { ...draft.content, faq, ja: { ...japanese, faq: [{ question: "子どもも参加できますか？", answer: "6歳から参加できます。" }] } } };
      const created = await createProduct(request("/host/api/products", "POST", withFaq));
      expect(created.status).toBe(201);
      expect(mocks.repository.createDraft).toHaveBeenCalledWith(actor, withFaq);
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      const saved = await saveProduct(request(`/host/api/products/${product.id}`, "PATCH", { version, draft: withFaq }), context);
      expect(saved.status).toBe(200);
      expect(mocks.repository.saveDraft).toHaveBeenCalledWith(actor, expect.objectContaining({ content: withFaq.content }), 4, 3, expect.any(Object));
    });

    // 日本語のみで公開する商品（#59）は、日本語サイトの flag が ON の環境でだけ保存できる。
    it("saves a Japanese-only draft only while the Japanese site flag is on", async () => {
      const japaneseOnlyDraft = { ...draft, publicTitle: japanese.title, content: { ...draft.content, japaneseOnly: true, ja: japanese } };
      (mocks.config as Record<string, unknown>).japaneseSiteEnabled = false;
      const off = await createProduct(request("/host/api/products", "POST", japaneseOnlyDraft));
      expect(off.status).toBe(400);
      expect(mocks.repository.createDraft).not.toHaveBeenCalled();
      (mocks.config as Record<string, unknown>).japaneseSiteEnabled = true;
      const on = await createProduct(request("/host/api/products", "POST", japaneseOnlyDraft));
      expect(on.status).toBe(201);
      expect(mocks.repository.createDraft).toHaveBeenCalledWith(actor, japaneseOnlyDraft);
      (mocks.config as Record<string, unknown>).japaneseSiteEnabled = false;
    });

    it.each([
      ["a blank answer", { faq: [{ question: "Q", answer: " " }] }],
      ["a repeated question", { faq: [...faq, { question: " can children JOIN? ", answer: "Again." }] }],
      ["an unknown row key", { faq: [{ ...faq[0], private: "x" }] }],
      ["a non-list", { faq: "Q: A" }],
      ["an over-long question", { faq: [{ question: "q".repeat(201), answer: "A" }] }],
      ["31 rows", { faq: Array.from({ length: 31 }, (_, index) => ({ question: `Q${index}`, answer: "A" })) }],
      ["an invalid Japanese FAQ", { ja: { ...japanese, faq: [{ question: "", answer: "答え" }] } }],
    ])("rejects %s with INVALID_INPUT before the store", async (_name, patch) => {
      const invalid = { ...draft, content: { ...draft.content, ...patch } };
      const created = await createProduct(request("/host/api/products", "POST", invalid));
      expect(created.status).toBe(400);
      expect((await created.json()).error.code).toBe("INVALID_INPUT");
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      expect((await saveProduct(request(`/host/api/products/${product.id}`, "PATCH", { version, draft: invalid }), context)).status).toBe(400);
      expect(mocks.repository.createDraft).not.toHaveBeenCalled();
      expect(mocks.repository.saveDraft).not.toHaveBeenCalled();
    });

    it("translates the Japanese FAQ with the same row count and fingerprints an empty FAQ like an absent one", async () => {
      const english = { ...japanese, title: "Synthetic dinner", lead: "Lead", description: "Description", language: "English", faq };
      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify(english) });
      const source = { ...japanese, faq: [{ question: "子どもも参加できますか？", answer: "6歳から参加できます。" }] };
      const translated = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { japanese: source }), context);
      expect(translated.status).toBe(200);
      expect(await translated.json()).toEqual({ sourceFingerprint: publicationManuscriptFingerprint(source), english });

      const withoutFaq = { ...english, faq: undefined };
      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify(withoutFaq) });
      expect((await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { japanese: source }), context)).status).toBe(503);

      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify(withoutFaq) });
      const empty = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { japanese: { ...japanese, faq: [] } }), context);
      expect(empty.status).toBe(200);
      expect((await empty.json()).sourceFingerprint).toBe(publicationManuscriptFingerprint(japanese));
    });

    it("translates an English manuscript into Japanese when the body is { english }, with the same FAQ row count", async () => {
      const sourceEnglish = { ...japanese, title: "Synthetic dinner", lead: "Lead", description: "Description", language: "English", faq: [{ question: "Can children join?", answer: "From age 6." }] };
      const translatedJapanese = { ...japanese, faq: [{ question: "子どもも参加できますか？", answer: "6歳から参加できます。" }] };
      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify(translatedJapanese) });
      const response = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { english: sourceEnglish }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sourceFingerprint: publicationManuscriptFingerprint(sourceEnglish), japanese: translatedJapanese });

      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ ...translatedJapanese, faq: [] }) });
      expect((await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { english: sourceEnglish }), context)).status).toBe(503);
    });

    it("rejects a translation body with both manuscripts, neither, or an invalid English one before the translator", async () => {
      for (const body of [{ japanese, english: japanese }, {}, { english: { ...japanese, notes: "x" } }]) {
        const response = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", body), context);
        expect(response.status).toBe(400);
      }
      expect(mocks.translator).not.toHaveBeenCalled();
    });

    it("rejects a draft that is both Japanese-only and English-only", async () => {
      const both = { ...draft, content: { ...draft.content, japaneseOnly: true, englishOnly: true } };
      const created = await createProduct(request("/host/api/products", "POST", both));
      expect(created.status).toBe(400);
      expect(mocks.repository.createDraft).not.toHaveBeenCalled();
    });

    it("asks the translator for a manuscript-sized answer: a FAQ makes the JSON longer than a message may be (#146)", async () => {
      const longFaq = Array.from({ length: 4 }, (_, index) => ({ question: `Q${index}?`, answer: "a".repeat(1_000) }));
      const source = { ...japanese, faq: longFaq.map(({ question }) => ({ question, answer: "こ".repeat(1_000) })) };
      const english = { ...japanese, title: "Synthetic dinner", lead: "Lead", description: "Description", language: "English", faq: longFaq };
      expect(JSON.stringify(english).length).toBeGreaterThan(4_000);
      mocks.translator.mockResolvedValueOnce({ ok: true, text: JSON.stringify(english) });
      const translated = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { japanese: source }), context);
      expect(translated.status).toBe(200);
      expect(mocks.translator).toHaveBeenLastCalledWith(expect.anything(), { maxLength: 64_000 });
    });

    it("rejects an incomplete Japanese FAQ or an unknown manuscript key before calling the translator", async () => {
      for (const source of [{ ...japanese, faq: [{ question: "質問", answer: "" }] }, { ...japanese, notes: "x" }]) {
        const response = await translateProduct(request(`/host/api/products/${product.id}/translation`, "POST", { japanese: source }), context);
        expect(response.status).toBe(400);
      }
      expect(mocks.translator).not.toHaveBeenCalled();
    });
  });

  describe("page and bookings are separate steps (#705)", () => {
    const sellerless = { actor, role: "OWNER", provider: null, readiness: null };

    it("publishes the page of a host with no seller or payout account, and never asks Stripe", async () => {
      mocks.boundary.mockResolvedValue({ ok: true, value: sellerless });
      mocks.repository.getProduct.mockResolvedValue({ ...product, seller: null, status: "DRAFT" });
      mocks.repository.getState.mockResolvedValue(null);
      mocks.repository.getSaleTerms.mockResolvedValue({ draftVersion: 4, stateVersion: null, saleTerms: terms });
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      mocks.boundary.mockClear();
      const response = await publishPage(request(`/host/api/products/${product.id}/publish-page`, "POST", { version }), context);
      expect(response.status).toBe(200);
      // The boundary is asked for the OWNER with "optional" sales: a seller is read only when there is one.
      expect(mocks.boundary).toHaveBeenCalledWith("OWNER", { providerId: null, sales: "optional" });
      expect(mocks.repository.refreshReadiness).not.toHaveBeenCalled();
      expect(mocks.repository.publishPage).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({ expectedDraftVersion: 4, expectedStateVersion: null, expectedSaleTermsVersion: 2 }));
      expect(mocks.repository.publish).not.toHaveBeenCalled();
      expect(mocks.repository.openBooking).not.toHaveBeenCalled();
    });

    it("splits the blockers of a product into page and booking reasons", async () => {
      mocks.repository.getPublicationBlockers.mockImplementation(async (_actor: unknown, _id: string, _checks: unknown, _consent: unknown, scope?: string) =>
        scope === "PAGE" ? ["PHOTOS_REQUIRED"] : ["PHOTOS_REQUIRED", "SELLER_REQUIRED", "SCHEDULE_REQUIRED"]);
      const dto = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product;
      expect(dto.pageBlockers).toEqual(["PHOTOS_REQUIRED"]);
      expect(dto.bookingBlockers).toEqual(["SELLER_REQUIRED", "SCHEDULE_REQUIRED"]);
      expect(dto.publicationBlockers).toEqual(["PHOTOS_REQUIRED", "SELLER_REQUIRED", "SCHEDULE_REQUIRED"]);
    });

    it("opens bookings only with the consent and a ready payout account, through the readiness boundary", async () => {
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      mocks.boundary.mockClear();
      const declined = await openBooking(request(`/host/api/products/${product.id}/open-booking`, "POST", { version, consentVersion: "listing-v1", accepted: false }), context);
      expect(declined.status).toBe(422);
      const opened = await openBooking(request(`/host/api/products/${product.id}/open-booking`, "POST", { version, consentVersion: "listing-v1", accepted: true }), context);
      expect(opened.status).toBe(200);
      expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null });
      expect(mocks.repository.openBooking).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({ expectedDraftVersion: 4, expectedStateVersion: 3, consentVersion: "listing-v1" }));
      mocks.boundary.mockResolvedValue({ ok: true, value: { ...hostContext, readiness: { ...hostContext.readiness, connectReady: false } } });
      const notReady = await openBooking(request(`/host/api/products/${product.id}/open-booking`, "POST", { version, consentVersion: "listing-v1", accepted: true }), context);
      expect(notReady.status).toBe(422);
      expect((await notReady.json()).error.blockers).toEqual(["CONNECT_NOT_READY"]);
      expect(mocks.repository.openBooking).toHaveBeenCalledTimes(1);
    });

    describe("with agent sales (#725)", () => {
      const agentPlan = (over: Record<string, unknown> = {}) => ({
        current: { revision: 1, plan: "SUPPORTED_15", chargeMode: "PLATFORM", sellerParty: "PROVIDER", feeBasisPoints: 1500, agreementVersion: "agent-sales-v1", stripeAccountRef: "acct_PlatformSample1", sellerDisplayName: "Sample Host", sellerNihoAccountRef: `agt_${"b".repeat(32)}`, ...over },
        phase: "ACTIVE", pending: null, transitionCommandId: null, version: 1,
      });
      const withoutSeller = { ...hostContext, provider: null, readiness: null };
      const open = async () => {
        const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
        mocks.boundary.mockClear();
        return { version, response: await openBooking(request(`/host/api/products/${product.id}/open-booking`, "POST", { version, consentVersion: "listing-v1", accepted: true }), context) };
      };
      beforeEach(() => {
        Object.assign(mocks.config, { hostAgentSalesEnabled: true, hostAccountsEnabled: true, hostAgentSalesAgreementVersion: "agent-sales-v1", hostAgentReceiverName: "Synthetic NIHO Receiver KK", hostAgentPayoutDelayDays: 3 });
        mocks.repository.providerHasSellerProfile.mockResolvedValue(false);
        mocks.disclosureRead.mockResolvedValue({ sellerDisplayName: "", disclosure: { method: "NATIVE", sellerDisplayName: "Sample Host" } });
        mocks.managedSalesGet.mockResolvedValue(agentPlan());
        mocks.consentCounts.mockResolvedValue(true);
        mocks.platformAccount.mockResolvedValue({ id: "acct_PlatformSample1", chargesEnabled: true, detailsSubmitted: true, country: "JP", defaultCurrency: "JPY" });
        vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
        mocks.boundary.mockResolvedValue({ ok: true, value: withoutSeller });
      });
      afterEach(() => { vi.unstubAllEnvs(); });

      it("opens bookings with no seller profile or readiness, reading only the platform account, and hands the store the check", async () => {
        const { response } = await open();
        expect(response.status).toBe(200);
        expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null, sales: "optional" });
        expect(mocks.platformAccount).toHaveBeenCalledWith({ expectedAccountId: "acct_PlatformSample1", platformStripeKey: "sk_test_synthetic" });
        expect(mocks.repository.openBooking).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({
          agentCheck: { agreementVersion: "agent-sales-v1", accountCheck: { stripeConnectAccountRef: "acct_PlatformSample1", checkedAtUtc: expect.any(String) } },
        }));
      });

      it("sends no account check when the platform account cannot take payments, and names Stripe's outage as unavailable", async () => {
        mocks.platformAccount.mockResolvedValueOnce({ id: "acct_PlatformSample1", chargesEnabled: false, detailsSubmitted: true, country: "JP", defaultCurrency: "JPY" });
        expect((await open()).response.status).toBe(200);
        expect(mocks.repository.openBooking).toHaveBeenLastCalledWith(actor, product.id, expect.objectContaining({ agentCheck: { agreementVersion: "agent-sales-v1", accountCheck: null } }));
        mocks.platformAccount.mockRejectedValueOnce(new Error("synthetic outage"));
        const down = await open();
        expect(down.response.status).toBe(502);
        expect(mocks.repository.openBooking).toHaveBeenCalledTimes(1);
      });

      it("sends the older publish route through the same agent branch, and lets a host with no seller profile stop its page", async () => {
        const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
        mocks.boundary.mockClear();
        const published = await publishProduct(request(`/host/api/products/${product.id}/publish`, "POST", { version, consentVersion: "listing-v1", accepted: true }), context);
        expect(published.status).toBe(200);
        expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null, sales: "optional" });
        expect(mocks.platformAccount).toHaveBeenCalledTimes(1);
        expect(mocks.repository.publish).toHaveBeenLastCalledWith(actor, product.id, expect.objectContaining({ agentCheck: { agreementVersion: "agent-sales-v1", accountCheck: expect.any(Object) } }));
        mocks.boundary.mockClear();
        const stopped = await stopProduct(request(`/host/api/products/${product.id}/stop`, "POST", { version }), context);
        expect(stopped.status).toBe(200);
        expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null, sales: "optional" });
        expect(mocks.repository.stop).toHaveBeenCalled();
        // With the flag off both still ask for the readiness, as before.
        mocks.config.hostAgentSalesEnabled = false;
        mocks.boundary.mockClear();
        await stopProduct(request(`/host/api/products/${product.id}/stop`, "POST", { version }), context);
        expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null });
      });

      it("keeps today's check for a product that is not agent sales, and for the flag off", async () => {
        mocks.managedSalesGet.mockResolvedValue(null);
        const notAgent = await open();
        expect(notAgent.response.status).toBe(422);
        expect((await notAgent.response.json()).error.blockers).toEqual(["CONNECT_NOT_READY"]);
        expect(mocks.platformAccount).not.toHaveBeenCalled();
        expect(mocks.repository.openBooking).not.toHaveBeenCalled();

        mocks.config.hostAgentSalesEnabled = false;
        mocks.boundary.mockResolvedValue({ ok: true, value: hostContext });
        expect((await open()).response.status).toBe(200);
        expect(mocks.boundary).toHaveBeenLastCalledWith("OWNER", { providerId: null });
        expect(mocks.platformAccount).not.toHaveBeenCalled();
        expect(mocks.repository.openBooking).toHaveBeenLastCalledWith(actor, product.id, expect.not.objectContaining({ agentCheck: expect.anything() }));
      });

      it("shows the 独立 10% choice only for a host whose seller is its own Stripe account, with the flag on", async () => {
        const read = async () => (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.independentSales;
        Object.assign(mocks.config, { hostStandardOnboardingEnabled: true, hostAccountsEnabled: true, hostIndependentSalesAgreementVersion: "independent-sales-v1" });
        mocks.ownStripe.mockResolvedValue("Sample Host");
        expect(await read()).toEqual({ agreementVersion: "independent-sales-v1", sellerName: "Sample Host" });
        mocks.ownStripe.mockResolvedValue(null);
        expect(await read()).toBeNull();
        mocks.ownStripe.mockRejectedValue(new Error("down"));
        expect(await read()).toBeNull();
        mocks.ownStripe.mockResolvedValue("Sample Host");
        mocks.config.hostStandardOnboardingEnabled = false;
        expect(await read()).toBeNull();
      });

      it("shows the choice (and the plan's kind) to a host with no seller profile, and nothing to one that has it or with the flag off", async () => {
        mocks.managedSalesGet.mockResolvedValue(null);
        const dto = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product;
        expect(dto.agentSales).toEqual({ agreementVersion: "agent-sales-v1", receiverName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerName: "Sample Host" });
        expect(dto.salesPlan).toBeNull();
        mocks.managedSalesGet.mockResolvedValue(agentPlan());
        const chosen = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product;
        expect(chosen.salesPlan.current).toMatchObject({ plan: "SUPPORTED_15", chargeMode: "PLATFORM", sellerParty: "PROVIDER" });
        expect(chosen.agentSales).toMatchObject({ planSellerName: "Sample Host", consentCounted: true });
        mocks.consentCounts.mockResolvedValueOnce(false);
        expect((await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.agentSales.consentCounted).toBe(false);
        // A host with a seller profile now (its own Stripe account, 3c-1): a product still sold with 代理受領 keeps its state, not offered again; any other product shows nothing.
        mocks.repository.providerHasSellerProfile.mockResolvedValue(true);
        expect((await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.agentSales).toMatchObject({ choosable: false, planSellerName: "Sample Host" });
        mocks.managedSalesGet.mockResolvedValue(null);
        expect((await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.agentSales).toBeNull();
        mocks.config.hostAgentSalesEnabled = false;
        expect((await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.agentSales).toBeNull();
      });
    });

    it("stops bookings without any payout lookup, by the state version, and refuses a stale one", async () => {
      mocks.boundary.mockResolvedValue({ ok: true, value: sellerless });
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      mocks.boundary.mockClear();
      const stopped = await stopBooking(request(`/host/api/products/${product.id}/stop-booking`, "POST", { version }), context);
      expect(stopped.status).toBe(200);
      expect(mocks.boundary).toHaveBeenCalledWith("OWNER", { providerId: null, sales: "none" });
      expect(mocks.repository.stopBooking).toHaveBeenCalledWith(actor, product.id, 3);
      mocks.repository.getState.mockResolvedValue({ ...state, version: 9 });
      const stale = await stopBooking(request(`/host/api/products/${product.id}/stop-booking`, "POST", { version }), context);
      expect(stale.status).toBe(409);
      expect(mocks.repository.stopBooking).toHaveBeenCalledTimes(1);
    });

    it("rejects extra fields and a forged page publish that carries sale input", async () => {
      const version = (await (await readProduct(request(`/host/api/products/${product.id}`), context)).json()).product.version;
      for (const route of [publishPage, stopBooking]) {
        const path = route === publishPage ? "publish-page" : "stop-booking";
        const response = await route(request(`/host/api/products/${product.id}/${path}`, "POST", { version, sellerDisplayName: "Forged" }), context);
        expect(response.status).toBe(400);
      }
      expect(mocks.repository.publishPage).not.toHaveBeenCalled();
      expect(mocks.repository.stopBooking).not.toHaveBeenCalled();
    });
  });

});
