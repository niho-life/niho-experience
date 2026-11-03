import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { ExperienceSalesCutover } from "../src/experience-sales-cutover.ts";
import { GuestBookingRepository } from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = { providerId: "provider-cutover-synthetic", nihoUserId: "owner-cutover-synthetic" } as const;
const CONDITIONS = "a4".repeat(32);
const CONSENT = "listing-cutover-v1";
const SLUG = "cutover-synthetic";
const QUESTIONS_FINGERPRINT = createHash("sha256").update("[]", "utf8").digest("hex");
const productContent = {
  lead: "Synthetic lead.", description: "Synthetic description.", facts: { language: "English" },
  highlights: ["Synthetic highlight."], included: ["Materials"], notIncluded: [], knowBeforeYouGo: ["Bring curiosity."],
  notSuitableFor: [], timeline: [], meetingOverview: "Near the synthetic station.",
  meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
};

describe("Experience product sales cutover", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("keeps checkout closed until old holds and confirmed seats are reconciled, then uses immutable booking terms and shared inventory", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_cutover_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [OWNER.providerId]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER')", [OWNER.providerId, OWNER.nihoUserId]);

      const store = new ExperienceStore(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const cutover = new ExperienceSalesCutover(pool);
      const bookings = new GuestBookingRepository(pool);
      const localToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const date = addLocalDays(localToday, 1);
      const rule: ScheduleRule = {
        id: "cutover-daily", timeZone: "Asia/Tokyo", startsOn: date, localStartTime: "10:00",
        durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0,
        busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      const product = await store.createProduct(OWNER, {
        id: "product-cutover-synthetic", slug: SLUG, status: "PUBLISHED", publicTitle: "Synthetic cutover experience",
        content: productContent, currency: "JPY", unitAmount: 1000, cancellationTermsRef: "cancel-cutover-v1",
        sellerNihoAccountRef: "seller-cutover-synthetic", stripeConnectAccountRef: "acct_cutover_synthetic",
        sellerDisplayName: "Synthetic legal seller",
      });
      await pool.query(
        `INSERT INTO experience_product_media_assets
           (id,provider_id,product_id,source_position,object_key,source_ref_hash,width,height,byte_size,alt_text,
            public_credit,rights_confirmed_at)
         VALUES ('00000000-0000-4000-8000-000000000451',$1,$2,0,
           'experience-products/00000000-0000-4000-8000-000000000451.jpg',$3,640,480,2048,'Synthetic photo',NULL,clock_timestamp())`,
        [OWNER.providerId, product.id, "4".repeat(64)],
      );
      await store.saveScheduleRule(OWNER, product.id, rule, null, "00000000-0000-4000-8000-000000000452");
      await pool.query(
        `INSERT INTO experience_product_sale_terms
           (provider_id,product_id,minimum_participants,minimum_chargeable_participants,private_booking,minimum_attendance,
            max_party_size,cancellation_policy,cancellation_window_minutes_before_start,cancellation_refund_basis_points,
            booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,3,true,4,4,'FREE_UNTIL_24H',90,3750,'[]'::jsonb,$3,$4)`,
        [OWNER.providerId, product.id, QUESTIONS_FINGERPRINT, CONDITIONS],
      );
      await pool.query(
        `INSERT INTO provider_sale_settings (provider_id,support_enabled,platform_fee_basis_points)
         VALUES ($1,false,1000)`,
        [OWNER.providerId],
      );
      const legacyProduct = await store.createProduct(OWNER, {
        id: "product-legacy-synthetic", slug: "legacy-cutover-synthetic", status: "PUBLISHED", publicTitle: "Synthetic legacy product",
        content: productContent, currency: "JPY", unitAmount: 1000, cancellationTermsRef: "cancel-legacy-v1",
        sellerNihoAccountRef: "seller-cutover-synthetic", stripeConnectAccountRef: "acct_cutover_synthetic",
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
      assert.ok(await bookings.publicBookingTerms("legacy-cutover-synthetic"), "a pre-cutover legacy product remains on its original checkout path");
      const legacyCutover = await cutover.recordLegacySalesStopped(OWNER.providerId, legacyProduct.id);
      assert.equal(await bookings.publicBookingTerms("legacy-cutover-synthetic"), null, "a cutover row removes the product from the legacy Experience checkout path");
      assert.equal(legacyCutover.phase, "LEGACY_STOPPED");

      const scheduleOccurrenceId = occurrenceIdFor(rule.id, date);

      const readiness = await publications.recordReadiness(OWNER, {
        accountUsable: true, connectReady: true, sellerDisplayReady: true,
        sellerNihoAccountRef: "seller-cutover-synthetic", stripeConnectAccountRef: "acct_cutover_synthetic",
        sellerDisplayName: "Synthetic legal seller", requiredConsentVersion: CONSENT,
        observedAtUtc: new Date(Date.now() - 1_000).toISOString(), validUntilUtc: new Date(Date.now() + 60_000).toISOString(),
      }, null);
      await publications.publish(OWNER, product.id, {
        expectedDraftVersion: product.version, expectedStateVersion: null, consentVersion: CONSENT,
        checks: { manuscriptReady: true, photosReady: true },
      });

      assert.equal(await bookings.publicBookingTerms(SLUG), null, "published content cannot sell before the old channel is fully cut over");
      assert.deepEqual(await bookings.sellableSlugs([SLUG]), []);
      await assert.rejects(bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: date, adultCount: 2, childCount: 0, expectedTotalYen: 2000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Synthetic Guest", guestEmail: "guest@example.test",
        guestLanguage: "EN", clientRequestKey: "cutover-before-stop",
      }), StoreNotFoundError);

      let state = await cutover.recordLegacySalesStopped(OWNER.providerId, product.id);
      assert.equal(state.phase, "LEGACY_STOPPED");
      await assert.rejects(cutover.recordLegacyHoldsDrained(OWNER.providerId, product.id, state.version + 1), StoreConflictError);
      state = await cutover.recordLegacyHoldsDrained(OWNER.providerId, product.id, state.version);
      assert.equal(state.phase, "HOLDS_DRAINED");
      await assert.rejects(cutover.enableExperienceSales(OWNER.providerId, product.id, state.version), StoreConflictError);
      state = await cutover.importConfirmedInventory({
        providerId: OWNER.providerId, productId: product.id, expectedVersion: state.version,
        reservations: [{ sourceRefHash: "c".repeat(64), sourceRevision: 7, occurrenceId: scheduleOccurrenceId, seats: 2 }],
      });
      assert.equal(state.importedReservationCount, 1);
      assert.equal(state.importedSeatCount, 2);
      state = await cutover.enableExperienceSales(OWNER.providerId, product.id, state.version);
      assert.equal(state.phase, "EXPERIENCE_ACTIVE");

      // A later mutable term edit cannot change the terms already published for new checkout.
      await pool.query(
        `UPDATE experience_product_sale_terms
            SET max_party_size=3,private_booking=false,cancellation_policy='NONE',conditions_version=$3
          WHERE provider_id=$1 AND product_id=$2`,
        [OWNER.providerId, product.id, "b5".repeat(32)],
      );
      const publicTerms = await bookings.publicBookingTerms(SLUG);
      assert.equal(publicTerms?.offers[0]?.maxPartySize, 4);
      assert.equal(publicTerms?.offers[0]?.cancellationPolicy.code, "CUSTOM");
      assert.deepEqual(publicTerms?.offers[0]?.cancellationTerms, { cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3750 });
      assert.equal(publicTerms?.offers[0]?.minimumChargeableParticipants, 3);
      assert.equal(publicTerms?.offers[0]?.privateBooking, true);
      assert.equal(Object.hasOwn(publicTerms?.offers[0] ?? {}, "minimumAttendance"), false);
      assert.deepEqual(await bookings.sellableSlugs([SLUG]), [SLUG]);

      const started = await bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: addLocalDays(date, 1), adultCount: 2, childCount: 0, expectedTotalYen: 3000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Synthetic Guest", guestEmail: "guest@example.test",
        guestLanguage: "EN", clientRequestKey: "cutover-after-import",
      });
      assert.deepEqual(started.booking.pricingSnapshot.bookingTerms, {
        minimumParticipants: 1, minimumChargeableParticipants: 3, privateBooking: true, maxPartySize: 4,
        cancellationPolicy: "FREE_UNTIL_24H", cancellationWindowMinutesBeforeStart: 90, cancellationRefundBasisPoints: 3750, bookingQuestions: [],
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, conditionsVersion: CONDITIONS, minimumAttendance: 4,
      });
      await assert.rejects(bookings.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: addLocalDays(date, 1), adultCount: 1, childCount: 0, expectedTotalYen: 3000,
        bookingQuestionsFingerprint: QUESTIONS_FINGERPRINT, termsConsentVersion: "site-terms-v1", currentConsentVersion: "site-terms-v1",
        conditionsConsentVersion: CONDITIONS, guestName: "Another Synthetic Guest", guestEmail: "other@example.test",
        guestLanguage: "EN", clientRequestKey: "cutover-capacity-reject",
      }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "FULL"));

      state = await cutover.stopExperienceSales(OWNER.providerId, product.id, state.version);
      assert.equal(state.phase, "EXPERIENCE_STOPPED");
      assert.equal(await bookings.publicBookingTerms(SLUG), null, "rollback stops Experience admission before any legacy channel can reopen");
      assert.equal(readiness.version, 1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});
