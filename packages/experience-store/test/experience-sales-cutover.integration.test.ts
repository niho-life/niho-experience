import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = { providerId: "provider-owner-seller-synthetic", nihoUserId: "owner-seller-synthetic" } as const;
const CONDITIONS = "a4".repeat(32);
const CONSENT = "listing-owner-seller-v1";
const SLUG = "owner-seller-synthetic";
const QUESTIONS_FINGERPRINT = createHash("sha256").update("[]", "utf8").digest("hex");
const productContent = {
  lead: "Synthetic lead.", description: "Synthetic description.", facts: { language: "English" },
  highlights: ["Synthetic highlight."], included: ["Materials"], notIncluded: [], knowBeforeYouGo: ["Bring curiosity."],
  notSuitableFor: [], timeline: [], meetingOverview: "Near the synthetic station.",
  meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
};

describe("Experience owner publication is the only Experience checkout source", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("does not sell unpublished legacy products and snapshots published terms for new reservations", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "experience_owner_seller", { max: 4 });
    const pool = db.pool;
    try {
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [OWNER.providerId]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER')", [OWNER.providerId, OWNER.nihoUserId]);

      const store = new ExperienceStore(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const bookings = new GuestBookingRepository(pool);
      const sellerReadiness = {
        accountUsable: true, connectReady: true, sellerDisplayReady: true,
        paymentReuseConsentAccepted: true, paymentReuseConsentVersion: "synthetic-payment-reuse-v1",
        paymentReuseConsentedAtUtc: new Date(Date.now() - 2_000).toISOString(),
        sellerNihoAccountRef: "seller-owner-synthetic", stripeConnectAccountRef: "acct_owner_synthetic",
        sellerDisplayName: "Synthetic legal seller", requiredConsentVersion: CONSENT,
        observedAtUtc: new Date(Date.now() - 1_000).toISOString(), validUntilUtc: new Date(Date.now() + 60_000).toISOString(),
      } as const;
      await publications.recordReadiness(OWNER, sellerReadiness, null);
      const localToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const date = addLocalDays(localToday, 1);
      const rule: ScheduleRule = {
        id: "owner-seller-daily", timeZone: "Asia/Tokyo", startsOn: date, localStartTime: "10:00",
        durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0,
        busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      const product = await publications.createDraft(OWNER, {
        slug: SLUG, publicTitle: "Synthetic owner seller experience",
        content: productContent, currency: "JPY", unitAmount: 1000,
      });
      assert.equal(product.status, "DRAFT");
      assert.match(product.id, /^[0-9a-f-]{36}$/i, "the store generates the product ID");
      assert.equal(product.sellerNihoAccountRef, sellerReadiness.sellerNihoAccountRef);
      assert.equal(product.stripeConnectAccountRef, sellerReadiness.stripeConnectAccountRef);
      assert.equal(product.sellerDisplayName, sellerReadiness.sellerDisplayName);
      await pool.query(
        `INSERT INTO experience_product_media_assets
           (id,provider_id,product_id,source_position,object_key,source_ref_hash,width,height,byte_size,alt_text,
            public_credit,rights_confirmed_at)
         VALUES ('00000000-0000-4000-8000-000000000451',$1,$2,0,
           'experience-products/00000000-0000-4000-8000-000000000451.jpg',$3,640,480,2048,'Synthetic photo',NULL,clock_timestamp())`,
        [OWNER.providerId, product.id, "4".repeat(64)],
      );
      await pool.query(
        `INSERT INTO experience_product_media_selection
           (provider_id,product_id,asset_id,placement,position,alt_text,alt_text_ja,public_credit)
         VALUES ($1,$2,'00000000-0000-4000-8000-000000000451','GALLERY',0,'Synthetic photo','合成写真',NULL)`,
        [OWNER.providerId, product.id],
      );
      await store.saveScheduleRule(OWNER, product.id, rule, null, "00000000-0000-4000-8000-000000000452");
      await pool.query(
        `INSERT INTO experience_product_sale_terms
           (provider_id,product_id,minimum_participants,minimum_chargeable_participants,minimum_attendance,
            max_party_size,cancellation_policy,cancellation_window_minutes_before_start,cancellation_refund_basis_points,
            booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,3,4,4,'FREE_UNTIL_24H',90,3750,'[]'::jsonb,$3,$4)`,
        [OWNER.providerId, product.id, QUESTIONS_FINGERPRINT, CONDITIONS],
      );
      await bookings.setProviderSupportSettings(OWNER, {
        supportEnabled: false, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: 0,
      });
      const legacyProduct = await store.createProduct(OWNER, {
        id: "product-unpublished-synthetic", slug: "unpublished-owner-seller-synthetic", status: "PUBLISHED", publicTitle: "Synthetic unpublished legacy product",
        content: productContent, currency: "JPY", unitAmount: 1000, cancellationTermsRef: "cancel-legacy-v1",
        sellerNihoAccountRef: "seller-owner-synthetic", stripeConnectAccountRef: "acct_owner_synthetic",
        sellerDisplayName: "Synthetic legal seller",
      });
      const legacyRule: ScheduleRule = { ...rule, id: "legacy-daily" };
      await store.saveScheduleRule(OWNER, legacyProduct.id, legacyRule, null, "00000000-0000-4000-8000-000000000453");
      await pool.query(
        `INSERT INTO experience_product_sale_terms
           (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,
            booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,4,'FREE_UNTIL_24H','[]'::jsonb,$3,$4)`,
        [OWNER.providerId, legacyProduct.id, QUESTIONS_FINGERPRINT, CONDITIONS],
      );
      assert.equal(await bookings.publicBookingTerms(legacyProduct.slug), null, "a product without an owner publication cannot use a legacy checkout fallback");
      await assert.rejects(bookings.startGuestBooking({
        slug: legacyProduct.slug, offerId: legacyRule.id, occurrenceDate: date, adultCount: 1, childCount: 0, expectedTotalYen: 1000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Synthetic Guest", guestEmail: "guest@example.test",
        guestLanguage: "EN", clientRequestKey: "unpublished-product-checkout",
      }), StoreNotFoundError);

      let state = await publications.publish(OWNER, product.id, {
        expectedDraftVersion: product.version, expectedStateVersion: null, consentVersion: CONSENT,
        checks: { manuscriptReady: true, photosReady: true },
      });

      assert.equal((await bookings.publicBookingTerms(SLUG))?.sellerDisplayName, "Synthetic legal seller");
      assert.equal((await store.getProduct(OWNER, product.id)).status, "PUBLISHED");
      assert.deepEqual(await bookings.sellableSlugs([SLUG]), [SLUG]);

      let readiness = await publications.recordReadiness(OWNER, { ...sellerReadiness, connectReady: false }, 1);
      assert.equal((await bookings.publicBookingTerms(SLUG))?.sellerDisplayName, "Synthetic legal seller");
      const expiredAt = Date.now();
      readiness = await publications.recordReadiness(OWNER, {
        ...sellerReadiness,
        observedAtUtc: new Date(expiredAt - 2_000).toISOString(),
        validUntilUtc: new Date(expiredAt - 1_000).toISOString(),
      }, readiness.version);
      assert.deepEqual(await bookings.sellableSlugs([SLUG]), [SLUG], "published items do not disappear when a short-lived owner check expires");
      readiness = await publications.recordReadiness(OWNER, sellerReadiness, readiness.version);

      // A later mutable term edit cannot change the terms already published for new checkout.
      await pool.query(
        `UPDATE experience_product_sale_terms
            SET max_party_size=3,cancellation_policy='NONE',conditions_version=$3
          WHERE provider_id=$1 AND product_id=$2`,
        [OWNER.providerId, product.id, "b5".repeat(32)],
      );
      const publicTerms = await bookings.publicBookingTerms(SLUG);
      assert.equal(publicTerms?.offers[0]?.maxPartySize, 4);
      assert.equal(publicTerms?.offers[0]?.cancellationPolicy.code, "CUSTOM");
      assert.deepEqual(publicTerms?.offers[0]?.cancellationTerms, { cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3750 });
      assert.equal(publicTerms?.offers[0]?.minimumChargeableParticipants, 3);
      assert.equal(Object.hasOwn(publicTerms?.offers[0] ?? {}, "privateBooking"), false);
      assert.equal(Object.hasOwn(publicTerms?.offers[0] ?? {}, "minimumAttendance"), false);
      assert.deepEqual(await bookings.sellableSlugs([SLUG]), [SLUG]);

      const started = await bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: addLocalDays(date, 1), adultCount: 2, childCount: 0, expectedTotalYen: 3000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Synthetic Guest", guestEmail: "guest@example.test",
        guestLanguage: "EN", clientRequestKey: "owner-seller-booking-1",
      });
      assert.deepEqual(started.booking.pricingSnapshot.bookingTerms, {
        minimumParticipants: 1, minimumChargeableParticipants: 3, maxPartySize: 4,
        cancellationPolicy: "FREE_UNTIL_24H", cancellationWindowMinutesBeforeStart: 90, cancellationRefundBasisPoints: 3750, bookingQuestions: [],
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, conditionsVersion: CONDITIONS, minimumAttendance: 4,
      });
      await bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: addLocalDays(date, 1), adultCount: 2, childCount: 0, expectedTotalYen: 3000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Another Synthetic Guest", guestEmail: "other@example.test",
        guestLanguage: "EN", clientRequestKey: "owner-seller-booking-2",
      });
      await assert.rejects(bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: addLocalDays(date, 1), adultCount: 1, childCount: 0, expectedTotalYen: 3000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Third Synthetic Guest", guestEmail: "third@example.test",
        guestLanguage: "EN", clientRequestKey: "owner-seller-booking-3",
      }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "FULL"));

      state = await publications.stop(OWNER, product.id, state.version);
      assert.equal(await bookings.publicBookingTerms(SLUG), null, "an owner stop immediately closes new Experience checkout");
      state = await publications.publish(OWNER, product.id, {
        expectedDraftVersion: product.version, expectedStateVersion: state.version, consentVersion: CONSENT,
        checks: { manuscriptReady: true, photosReady: true },
      });
      assert.equal((await bookings.publicBookingTerms(SLUG))?.sellerDisplayName, "Synthetic legal seller", "the owner can explicitly resume sales");
    } finally {
      await db.dispose();
    }
  });
});
