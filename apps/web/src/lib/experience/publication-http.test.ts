import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" },
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  mediaStorage: null as null | { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
  coverInput: vi.fn(),
  coverImage: vi.fn(),
  repository: {
    refreshReadiness: vi.fn(),
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
    stop: vi.fn(),
    addMedia: vi.fn(),
    getProviderMedia: vi.fn(),
    addProviderMedia: vi.fn(),
    saveProviderMediaSelection: vi.fn(),
    revokeProviderMedia: vi.fn(),
  },
  meetingGuides: { readForProduct: vi.fn(), saveForProduct: vi.fn() },
  translator: vi.fn(),
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
vi.mock("./store-server", () => ({ experiencePublicationRepository: () => mocks.repository, guestMeetingGuideRepository: () => mocks.meetingGuides }));
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
    Object.assign(mocks.config, { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" });
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

  it("uses one opaque version for edit, sale terms, publish, stop and restart", async () => {
    const read = await readProduct(request(`/host/api/products/${product.id}`), context);
    const dto = (await read.json()).product;
    const version = dto.version;
    expect(dto.version).toEqual(expect.any(String));
    expect(dto.media[0].previewUrl).toContain(media[0]!.id);
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

  it("returns the next product version when a photo changes the publication draft", async () => {
    const addedMedia = {
      id: "00000000-0000-4000-8000-000000000402", position: 1, sourcePosition: 1, placement: "GALLERY", width: 640, height: 480,
      byteSize: 2048, altText: "Second synthetic photo", altTextJa: "2枚目の合成写真", publicCredit: null,
    };
    mocks.mediaStorage = { write: vi.fn().mockResolvedValue(undefined), read: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) };
    mocks.coverInput.mockResolvedValue(Buffer.from("synthetic-original"));
    mocks.coverImage.mockResolvedValue({ bytes: Buffer.from("synthetic-jpeg"), width: 640, height: 480 });
    mocks.repository.addMedia.mockResolvedValue(addedMedia);
    mocks.repository.getProduct.mockResolvedValue({ ...product, version: 5 });
    mocks.repository.getSaleTerms.mockResolvedValue({ draftVersion: 5, stateVersion: 3, saleTerms: terms });
    mocks.repository.listMedia.mockResolvedValue([...media, addedMedia]);
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
    expect(body.asset.id).toBe(addedMedia.id);
    expect(body.product.version).toBe(Buffer.from("1:5:3:2").toString("base64url"));
    expect(body.product.media).toHaveLength(2);
    expect(mocks.repository.addMedia).toHaveBeenCalledWith(actor, product.id, expect.objectContaining({
      altText: "Second synthetic photo", altTextJa: "2枚目の合成写真",
    }));
  });

  it("uses seller-level profile media with explicit rights, localized alts, and version CAS", async () => {
    const read = await readProviderMedia(request("/host/api/provider-media"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ providerMedia: { version: 5, assets: [{ previewUrl: `/host/api/provider-media/${providerMedia.assets[0]!.id}` }] } });

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
    expect(mocks.boundary).toHaveBeenCalledWith("OWNER");

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
});
