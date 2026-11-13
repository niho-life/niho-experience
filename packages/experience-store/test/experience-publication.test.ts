import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { projectPublicExperiencePublication } from "../src/experience-publication-projection.ts";

const ADDRESS_SENTINEL = "PRIVATE_ADDRESS_SENTINEL";
const ACCESS_SENTINEL = "PRIVATE_ACCESS_SENTINEL";
const ENTRANCE_SENTINEL = "PRIVATE_ENTRANCE_SENTINEL";
const MAP_SENTINEL = "https://maps.example.test/private-map-sentinel";
const STRIPE_SENTINEL = "acct_PRIVATE_STRIPE_SENTINEL";
const NIHO_SELLER_SENTINEL = "niho-seller-private-sentinel";
const HOST_USER_SENTINEL = "host-user-private-sentinel";

const row = (disclosure: "PUBLIC" | "AFTER_BOOKING") => ({
  publication_id: 33,
  provider_id: "provider-private-sentinel",
  product_id: "product-private-sentinel",
  draft_version: 12,
  cancellation_terms_ref: "terms-private-sentinel",
  consent_version: "consent-private-sentinel",
  seller_niho_account_ref: NIHO_SELLER_SENTINEL,
  stripe_connect_account_ref: STRIPE_SENTINEL,
  slug: "synthetic-experience",
  public_title: "Synthetic experience",
  content: {
    lead: "A safe public lead.",
    description: "A safe public description.",
    facts: { language: "English", credentials: "facts-credentials-private-sentinel" },
    highlights: ["A safe highlight."],
    included: ["Synthetic materials"],
    notIncluded: [],
    knowBeforeYouGo: ["Safe public guidance."],
    notSuitableFor: [],
    timeline: [{ time: "10:00", title: "Welcome", text: "Meet the host.", photoIndex: null, private: "timeline-private-sentinel" }],
    meetingOverview: "Near a synthetic station.",
    meetingPointDisclosure: disclosure,
    meetingPoint: {
      name: "Synthetic meeting area",
      exteriorPhotoIndex: 0,
      address: ADDRESS_SENTINEL,
      accessNote: ACCESS_SENTINEL,
      entranceNote: ENTRANCE_SENTINEL,
      mapUrl: MAP_SENTINEL,
    },
    hostUserIds: [HOST_USER_SENTINEL],
    private: { contact: "private-contact-sentinel" },
    contact: "contact-private-sentinel",
    credentials: "credentials-private-sentinel",
    stripeConnectAccountRef: STRIPE_SENTINEL,
    sellerNihoAccountRef: NIHO_SELLER_SENTINEL,
    arbitraryUnknownKey: "unknown-private-sentinel",
  },
  currency: "JPY",
  unit_amount: "4000",
  seller_display_name: "Synthetic Legal Seller",
  provider_public_name: null,
  provider_kind: null,
  photos: [{ asset_id: "00000000-0000-4000-8000-000000000401", source_position: 0, placement: "GALLERY", alt_text: "Synthetic photo", alt_text_ja: "合成写真", public_credit: null }],
  published_at: "2026-11-03T00:00:00.000Z",
});

describe("experience publication public projection", () => {
  it("returns only the explicit traveler allowlist and strips every private sentinel", () => {
    const projected = projectPublicExperiencePublication(row("PUBLIC"));
    assert.deepEqual(Object.keys(projected ?? {}), [
      "slug", "publicTitle", "content", "meetingOverview", "meetingPointDisclosure", "meetingPoint",
      "currency", "unitAmount", "sellerDisplayName", "providerPublicName", "providerPublicNameEn", "providerKind",
      "photos", "providerPhoto", "businessLogo", "japanese", "japaneseOnly", "publishedAtUtc",
    ]);
    assert.deepEqual(projected?.meetingPoint, { name: "Synthetic meeting area", exteriorPhotoIndex: 0 });
    assert.deepEqual(projected?.photos, [{
      src: "/api/public/experience-media/00000000-0000-4000-8000-000000000401",
      alt: "Synthetic photo", altJa: "合成写真", publicCredit: null,
    }]);
    assert.deepEqual(Object.keys(projected?.content ?? {}), [
      "lead", "description", "facts", "highlights", "included", "notIncluded", "knowBeforeYouGo",
      "notSuitableFor", "timeline", "faq",
    ]);
    assert.deepEqual(projected?.content.faq, []);
    const serialized = JSON.stringify(projected);
    for (const sentinel of [
      ADDRESS_SENTINEL, ACCESS_SENTINEL, ENTRANCE_SENTINEL, MAP_SENTINEL, STRIPE_SENTINEL,
      NIHO_SELLER_SENTINEL, HOST_USER_SENTINEL, "private-contact-sentinel", "credentials-private-sentinel",
      "unknown-private-sentinel",
    ]) assert.doesNotMatch(serialized, new RegExp(sentinel));
  });

  it("always nulls meetingPoint when disclosure is AFTER_BOOKING", () => {
    const projected = projectPublicExperiencePublication(row("AFTER_BOOKING"));
    assert.equal(projected?.meetingPointDisclosure, "AFTER_BOOKING");
    assert.equal(projected?.meetingPoint, null);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_(ADDRESS|ACCESS|ENTRANCE)|private-map-sentinel/);
  });

  it("projects seller profile media separately from product gallery and omits unset assets", () => {
    const projected = projectPublicExperiencePublication({
      ...row("AFTER_BOOKING"),
      provider_media: [
        { asset_id: "00000000-0000-4000-8000-000000000402", placement: "PROVIDER_PHOTO", alt_text: "Seller portrait", alt_text_ja: "販売者の写真", public_credit: null },
        { asset_id: "00000000-0000-4000-8000-000000000403", placement: "BUSINESS_LOGO", alt_text: "Seller logo", alt_text_ja: "販売者のロゴ", public_credit: "Synthetic designer" },
      ],
    });
    assert.deepEqual(projected?.providerPhoto, {
      src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000402",
      alt: "Seller portrait", altJa: "販売者の写真", publicCredit: null,
    });
    assert.deepEqual(projected?.businessLogo, {
      src: "/api/public/experience-provider-media/00000000-0000-4000-8000-000000000403",
      alt: "Seller logo", altJa: "販売者のロゴ", publicCredit: "Synthetic designer",
    });
    assert.equal(projectPublicExperiencePublication({ ...row("AFTER_BOOKING"), provider_media: [] })?.providerPhoto, null);
  });

  it("projects only the separately consented provider name and kind, never a seller-name fallback", () => {
    const consented = projectPublicExperiencePublication({
      ...row("AFTER_BOOKING"), provider_public_name: "Synthetic Actual Host", provider_kind: "PERSON",
    });
    assert.equal(consented?.providerPublicName, "Synthetic Actual Host");
    assert.equal(consented?.providerKind, "PERSON");
    assert.equal(consented?.providerPublicNameEn, null);
    assert.equal(projectPublicExperiencePublication({ ...row("AFTER_BOOKING"), provider_public_name: "Synthetic Actual Host", provider_kind: "PERSON", provider_public_name_en: "Synthetic Host" })?.providerPublicNameEn, "Synthetic Host");
    assert.equal(consented?.sellerDisplayName, "Synthetic Legal Seller");
    assert.equal(projectPublicExperiencePublication({ ...row("AFTER_BOOKING"), provider_kind: "UNKNOWN" }), null);
  });

  it("fails closed when an approved content field has the wrong shape", () => {
    const malformed = row("PUBLIC");
    assert.equal(projectPublicExperiencePublication({ ...malformed, content: { ...malformed.content, highlights: "not-an-array" } }), null);
  });
});

describe("experience publication readiness validation", () => {
  const repository = new ExperiencePublicationRepository({
    query: () => { throw new Error("database must not be reached for invalid readiness"); },
  } as never);
  const actor = { providerId: "provider-synthetic", nihoUserId: "owner-synthetic" } as const;
  const readiness = (observedAt: number, validUntil: number) => ({
    accountUsable: true,
    connectReady: true,
    paymentReuseConsentAccepted: true,
    paymentReuseConsentVersion: "synthetic-payment-reuse-v1",
    paymentReuseConsentedAtUtc: new Date(observedAt - 1).toISOString(),
    sellerDisplayReady: true,
    sellerNihoAccountRef: "seller-synthetic",
    stripeConnectAccountRef: "acct_synthetic",
    sellerDisplayName: "Synthetic Legal Seller",
    requiredConsentVersion: "consent-synthetic-v1",
    observedAtUtc: new Date(observedAt).toISOString(),
    validUntilUtc: new Date(validUntil).toISOString(),
  });

  it("rejects a readiness observation from the future before touching PostgreSQL", async () => {
    const future = Date.now() + 60_000;
    await assert.rejects(repository.recordReadiness(actor, readiness(future, future + 60_000), null), StoreValidationError);
  });

  it("rejects a readiness validity window longer than ten minutes before touching PostgreSQL", async () => {
    const observedAt = Date.now() - 1_000;
    await assert.rejects(repository.recordReadiness(actor, readiness(observedAt, observedAt + 10 * 60_000 + 1), null), StoreValidationError);
  });
});
