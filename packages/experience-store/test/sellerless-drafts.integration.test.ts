import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ExperienceStore } from "../src/repository.ts";
import { SiteSaleRegistration } from "../src/site-sale-registration.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/*
 * #704 (host registration, stage 1a): a host provider OWNER whose provider has no seller profile can draft; nothing that
 * sells accepts the draft; registering the seller later gives the drafts their seller. Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-sellerless";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const ACCOUNT = "acct_SyntheticSellerless01";
const CONSENT = "publication-consent-synthetic-v1";

const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "sellerless_drafts", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

/** A provider with no seller profile and an ACTIVE host account as its OWNER. */
async function sellerlessOwner(pool: Pool): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [PROVIDER]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email: "sellerless@example.test", nowUtc: new Date().toISOString() });
  const granted = await accounts.grantProviderOwner({ providerId: PROVIDER, hostAccountId, nowUtc: new Date().toISOString() });
  assert.equal(granted.kind, "granted");
  return { providerId: PROVIDER, nihoUserId: hostAccountId };
}

const sellerColumns = async (pool: Pool, productId: string) => (await pool.query(
  "SELECT seller_niho_account_ref AS ref,stripe_connect_account_ref AS acct,seller_display_name AS name,version FROM experience_products WHERE provider_id=$1 AND id=$2",
  [PROVIDER, productId])).rows[0];

describe("drafts of a provider with no seller (#704)", { skip }, () => {
  it("lets the OWNER draft and edit, blocks publication with SELLER_REQUIRED, and keeps every sale closed", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const store = new ExperienceStore(pool);

      // A draft is created with no seller (never from the client) and read back as a valid product.
      const draft = await publications.createDraft(owner, { slug: "sellerless-walk", publicTitle: "Synthetic sellerless walk", content: manuscript, currency: "JPY", unitAmount: 4_000 });
      assert.equal(draft.status, "DRAFT");
      assert.equal(draft.seller, null);
      assert.deepEqual(await sellerColumns(pool, draft.id), { ref: null, acct: null, name: null, version: "1" });
      assert.equal((await publications.getProduct(owner, draft.id)).seller, null);
      assert.deepEqual((await publications.listProducts(owner)).map(({ id }) => id), [draft.id]);

      // Manuscript, photos, sale terms and an offer are all saved.
      const rule: ScheduleRule = {
        id: "sellerless-daily", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 90,
        capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule(owner, draft.id, rule, null, randomUUID());
      const photoId = randomUUID();
      await publications.addMedia(owner, draft.id, {
        id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: "5".repeat(64),
        width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
      });
      assert.equal((await publications.listMedia(owner, draft.id)).length, 1);
      const saved = await publications.saveDraft(owner, {
        id: draft.id, slug: draft.slug, publicTitle: "Synthetic sellerless walk, revised", content: manuscript,
        currency: "JPY", unitAmount: 4_000, cancellationTermsRef: draft.cancellationTermsRef,
      }, (await publications.getProduct(owner, draft.id)).version, null, CHECKS);
      assert.equal(saved.draft.seller, null);
      assert.equal(saved.publicationUpdated, false);
      const terms = await publications.saveSaleTerms(owner, draft.id, {
        expectedDraftVersion: saved.draft.version, expectedStateVersion: null, expectedSaleTermsVersion: null,
        saleTerms: {
          offerPrices: null, childPricing: null, minimumParticipants: 2, minimumChargeableParticipants: 3, maxPartySize: 6,
          cancellationPolicy: "CUSTOM", cancellationWindowMinutesBeforeStart: 90, cancellationRefundBasisPoints: 3_750,
          minimumAttendance: 4, bookingQuestions: [], conditionsVersion: null,
        } as never,
        checks: CHECKS,
      });
      assert.deepEqual(terms.blockers, ["SELLER_REQUIRED"], "no readiness, fee or payout noise");

      // An unfinished sellerless draft keeps its content reasons and gets SELLER_REQUIRED instead of readiness/fee/payout ones.
      const unfinished = await publications.getPublicationBlockers(owner, draft.id, { manuscriptReady: false, photosReady: false }, CONSENT);
      assert.ok(unfinished.includes("MANUSCRIPT_REQUIRED") && unfinished.includes("PHOTOS_REQUIRED") && unfinished.at(-1) === "SELLER_REQUIRED", String(unfinished));
      for (const noise of ["FEE_SETTINGS_REQUIRED", "SUPPORT_CONSENT_REQUIRED", "READINESS_MISSING", "READINESS_EXPIRED", "CONNECT_NOT_READY", "PAYMENT_REUSE_CONSENT_REQUIRED"]) {
        assert.ok(!unfinished.includes(noise as never), noise);
      }

      // A finished sellerless draft is blocked by exactly SELLER_REQUIRED, in the blockers read and at publish.
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, CHECKS, CONSENT), ["SELLER_REQUIRED"]);
      const current = await publications.getProduct(owner, draft.id);
      await assert.rejects(
        publications.publish(owner, draft.id, { expectedDraftVersion: current.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.length === 1 && error.blockers[0] === "SELLER_REQUIRED",
      );
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_product_publications")).rows[0]?.n, 0);
      assert.equal(await publications.getPublicBySlug(draft.slug), null);
      assert.deepEqual(await publications.listPublic(), []);

      // The seller columns are all NULL or all set: a partial value is refused by the database.
      await assert.rejects(pool.query("UPDATE experience_products SET seller_display_name='Only a name' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]), { code: "23514" });
      await assert.rejects(pool.query(
        `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref)
         VALUES ($1,'partial','partial','DRAFT','Partial','JPY',1000,'terms','sel_only')`, [PROVIDER]), { code: "23514" });
      // And only a product with a seller can leave DRAFT, which closes every PUBLISHED-only reader (checkout, booking
      // terms, OTA/channel feeds, reviews, article links).
      await assert.rejects(pool.query("UPDATE experience_products SET status='PUBLISHED' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]), { code: "23514" });
      // A publication with a consent version but no seller is neither a page version nor a sale version (all-or-none CHECK).
      await assert.rejects(pool.query(
        `INSERT INTO experience_product_publications
           (provider_id,product_id,draft_version,sale_terms_version,slug,public_title,content,currency,unit_amount,
            cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,
            published_by_niho_user_id,publisher_kind,sale_terms_snapshot)
         VALUES ($1,$2,1,1,'x','x','{}'::jsonb,'JPY',1000,'t',NULL,NULL,NULL,'c',$3,'OWNER','{}'::jsonb)`,
        [PROVIDER, draft.id, owner.nihoUserId]), { code: "23514" });

      // Booking terms, checkout and the Admin proxy refuse the draft.
      const guests = new GuestBookingRepository(pool);
      assert.equal(await guests.publicBookingTerms(draft.slug), null);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), []);
      await assert.rejects(guests.startGuestBooking({
        slug: draft.slug, offerId: rule.id, occurrenceDate: "2099-01-02", adultCount: 1, childCount: 0, expectedTotalYen: 4_000,
        bookingQuestionsFingerprint: "0".repeat(64), termsConsentVersion: "v1", currentConsentVersion: "v1",
        guestName: "Synthetic Guest", guestEmail: "guest@example.test", guestLanguage: "EN", clientRequestKey: randomUUID(),
      }), StoreNotFoundError);
      const admin = { nihoUserId: "admin-synthetic" };
      await assert.rejects(publications.getAdminDraftProduct(admin, PROVIDER, draft.id), StoreNotFoundError);
      await assert.rejects(publications.publishAdminDraft(admin, PROVIDER, draft.id, {} as never));
    });
  });

  it("copies the seller onto the drafts when the seller is registered, and the draft then publishes", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const store = new ExperienceStore(pool);
      const first = await publications.createDraft(owner, { slug: "attach-first", publicTitle: "Synthetic attach first", content: manuscript, currency: "JPY", unitAmount: 4_000 });
      const second = await publications.createDraft(owner, { slug: "attach-second", publicTitle: "Synthetic attach second", content: manuscript, currency: "JPY", unitAmount: 4_000 });
      assert.equal(first.seller, null);
      const versionBefore = (await sellerColumns(pool, first.id)).version;

      // Registering the seller (the ops path, one transaction) copies it from the stored profile onto both drafts.
      const registration = new SiteSaleRegistration(pool);
      const input = { providerId: PROVIDER, providerDisplayName: "Synthetic Supper Club", sellerDisplayName: "Synthetic Legal Seller KK", stripeConnectAccountRef: ACCOUNT };
      assert.equal((await registration.provisionHostAccountSeller(input)).sellerProfile, "CREATED");
      const profile = (await pool.query("SELECT seller_niho_account_ref AS ref FROM experience_host_seller_profiles WHERE provider_id=$1", [PROVIDER])).rows[0];
      for (const id of [first.id, second.id]) {
        assert.deepEqual(await sellerColumns(pool, id), { ref: profile.ref, acct: ACCOUNT, name: "Synthetic Legal Seller KK", version: versionBefore },
          "the seller comes from the profile; the draft's version (an open editor's CAS token) is unchanged");
      }
      assert.deepEqual((await publications.getProduct(owner, first.id)).seller, {
        sellerNihoAccountRef: profile.ref, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK",
      });
      // A second registration changes nothing; a later draft is made with the seller from readiness, as before.
      assert.equal((await registration.provisionHostAccountSeller(input)).sellerProfile, "UNCHANGED");
      const now = Date.now();
      const readiness = {
        accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, paymentReuseConsentVersion: "synthetic-payment-reuse-v1",
        paymentReuseConsentedAtUtc: new Date(now - 2_000).toISOString(), sellerDisplayReady: true, sellerNihoAccountRef: String(profile.ref),
        stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK", requiredConsentVersion: CONSENT,
        observedAtUtc: new Date(now - 1_000).toISOString(), validUntilUtc: new Date(now + 60_000).toISOString(),
      };
      await publications.recordReadiness(owner, readiness, null);
      const third = await publications.createDraft(owner, { slug: "attach-third", publicTitle: "Synthetic attach third", content: manuscript, currency: "JPY", unitAmount: 4_000 });
      assert.equal(third.seller?.sellerNihoAccountRef, profile.ref);

      // SELLER_MISMATCH semantics are unchanged: the attached seller matches the readiness, so only the real gaps remain.
      assert.deepEqual(await publications.getPublicationBlockers(owner, first.id, CHECKS, CONSENT),
        ["PHOTOS_REQUIRED", "FEE_SETTINGS_REQUIRED", "CANCELLATION_TERMS_REQUIRED", "SCHEDULE_REQUIRED"]);
      await pool.query("INSERT INTO provider_sale_settings (provider_id,support_enabled,platform_fee_basis_points) VALUES ($1,false,1000)", [PROVIDER]);
      const guests = new GuestBookingRepository(pool);
      const supportSettings = await guests.getProviderSupportSettings(owner);
      await guests.setProviderSupportSettings(owner, { supportEnabled: false, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: supportSettings?.version ?? 0 });
      const rule: ScheduleRule = {
        id: "attach-daily", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 90,
        capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule(owner, first.id, rule, null, randomUUID());
      const photoId = randomUUID();
      await publications.addMedia(owner, first.id, {
        id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: "6".repeat(64),
        width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
      });
      await pool.query(
        `INSERT INTO experience_product_sale_terms (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`, [PROVIDER, first.id, "0".repeat(64)]);
      const ready = await publications.getProduct(owner, first.id);
      const state = await publications.publish(owner, first.id, { expectedDraftVersion: ready.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS });
      assert.equal(state.version, 1);
      const published = await publications.getPublicBySlug(first.slug);
      assert.ok(published, "the attached draft publishes with the registered seller");
      assert.equal((await pool.query("SELECT seller_niho_account_ref AS ref FROM experience_product_publications WHERE product_id=$1", [first.id])).rows[0]?.ref, profile.ref);
      // The sibling that never got a photo or terms stays unpublished.
      assert.equal(await publications.getPublicBySlug(second.slug), null);
    });
  });
});
