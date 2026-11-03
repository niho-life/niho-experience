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
  photos: [{ asset_id: "00000000-0000-4000-8000-000000000401", alt_text: "Synthetic photo", public_credit: null }],
  published_at: "2026-11-03T00:00:00.000Z",
});

describe("experience publication public projection", () => {
  it("returns only the explicit traveler allowlist and strips every private sentinel", () => {
    const projected = projectPublicExperiencePublication(row("PUBLIC"));
    assert.deepEqual(Object.keys(projected ?? {}), [
      "slug", "publicTitle", "content", "meetingOverview", "meetingPointDisclosure", "meetingPoint",
      "currency", "unitAmount", "sellerDisplayName", "photos", "publishedAtUtc",
    ]);
    assert.deepEqual(projected?.meetingPoint, { name: "Synthetic meeting area", exteriorPhotoIndex: 0 });
    assert.deepEqual(Object.keys(projected?.content ?? {}), [
      "lead", "description", "facts", "highlights", "included", "notIncluded", "knowBeforeYouGo",
      "notSuitableFor", "timeline",
    ]);
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
