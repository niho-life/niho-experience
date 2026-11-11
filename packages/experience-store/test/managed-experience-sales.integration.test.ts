import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestBookingRepository, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ManagedExperienceSalesRepository } from "../src/managed-sales.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ExperienceStore } from "../src/repository.ts";
import { SiteSaleRegistration } from "../src/site-sale-registration.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "admin-managed-synthetic" } as const;
const PLATFORM = "acct_PlatformSynthetic1";
const CONNECT = "acct_OwnerSynthetic0001";
const PUBLICATION_CONSENT = "publication-managed-synthetic-v1";
const emptyQuestions = createHash("sha256").update("[]").digest("hex");

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

function bookingRequest(slug: string, offerId: string, occurrenceDate: string, revision: number, email: string): StartGuestBookingInput {
  return {
    slug, offerId, occurrenceDate, adultCount: 1, childCount: 0, expectedTotalYen: 10_000,
    bookingQuestionsFingerprint: emptyQuestions, answers: [], termsConsentVersion: PUBLICATION_CONSENT,
    currentConsentVersion: PUBLICATION_CONSENT, conditionsConsentVersion: null, salesPlanRevision: revision,
    guestName: "Synthetic Guest", guestEmail: email, guestLanguage: "JA", clientRequestKey: randomUUID(),
  };
}

describe("managed Experience sale end-to-end (#507/#508/#509)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("creates an unregistered provider, sells on platform, fences old Checkout, switches this product to Direct, refunds and records manual compensation", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "managed_experience_sales", { max: 6 });
    try {
      const pool = db.pool;
      const publications = new ExperiencePublicationRepository(pool);
      const store = new ExperienceStore(pool);
      const guests = new GuestBookingRepository(pool);
      const managed = new ManagedExperienceSalesRepository(pool);
      const cancellations = new BookingCancellations(pool);

      const profile = await publications.createAdminProvider(ADMIN, {
        publicDisplayName: "Synthetic Actual Provider", providerKind: "PERSON", consentVersion: "provider-profile-synthetic-v1",
      });
      assert.deepEqual(await publications.listAdminDraftProducts(ADMIN, profile.providerId), []);
      const managedConfig = {
        seller: { legalSellerName: "Synthetic NIHO Seller", commercialTransactionsUrl: "https://example.test/niho-seller", sellerNihoAccountRef: "niho-seller-synthetic", platformAccountId: PLATFORM },
        agreementVersion: "managed-20-synthetic-v1", agreementConfirmedAtUtc: new Date().toISOString(), agreementConfirmationMethod: "WRITTEN" as const, paymentDueDays: 14, pilotApproved: true as const,
      };
      const draft = await publications.createDraftAsAdmin(ADMIN, profile.providerId, {
        slug: "synthetic-managed-experience", publicTitle: "Synthetic managed experience",
        content: {
          ja: { title: "合成の完全代行体験", lead: "合成の紹介", description: "合成の説明", language: "日本語", highlights: ["合成"], included: ["合成素材"], notIncluded: [], knowBeforeYouGo: ["合成注意"], notSuitableFor: [], timeline: [] },
          lead: "Synthetic lead", description: "Synthetic description", facts: { language: "Japanese" }, highlights: ["Synthetic"], included: ["Synthetic material"], notIncluded: [], knowBeforeYouGo: ["Synthetic note"], notSuitableFor: [], timeline: [],
          meetingOverview: "Synthetic meeting point", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
        },
        currency: "JPY", unitAmount: 10_000,
      }, managedConfig);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_memberships WHERE provider_id=$1", [profile.providerId])).rows[0]?.n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_host_seller_profiles WHERE provider_id=$1", [profile.providerId])).rows[0]?.n, 0);

      const mediaId = randomUUID();
      await publications.addMediaAsAdmin(ADMIN, profile.providerId, draft.id, {
        id: mediaId, objectKey: `experience-products/${mediaId}.jpg`, sourceRefHash: "a".repeat(64), width: 1200, height: 800,
        byteSize: 4096, altText: "Synthetic managed experience", altTextJa: "合成の完全代行体験", publicCredit: null,
      });
      const offerId = randomUUID();
      const schedule: ScheduleRule = {
        id: offerId, timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90,
        capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveDraftScheduleRuleAsAdmin(ADMIN, profile.providerId, draft.id, schedule, null, offerId);
      assert.equal((await store.listDraftScheduleAsAdmin(ADMIN, profile.providerId, draft.id)).length, 1);
      const current = await publications.getAdminDraftProduct(ADMIN, profile.providerId, draft.id);
      await publications.saveSaleTermsAsAdmin(ADMIN, profile.providerId, draft.id, {
        expectedDraftVersion: current.version, expectedSaleTermsVersion: null,
        saleTerms: { offerPrices: null, childPricing: null, minimumParticipants: 1, minimumChargeableParticipants: 1, maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_24H", cancellationWindowMinutesBeforeStart: 1440, cancellationRefundBasisPoints: 10_000, minimumAttendance: null, bookingQuestions: [], conditionsVersion: null },
      });
      await publications.reviewAdminDraftEnglish(ADMIN, profile.providerId, draft.id, current.version);
      await publications.publishAdminDraft(ADMIN, profile.providerId, draft.id, {
        expectedDraftVersion: current.version, expectedStateVersion: null, expectedSaleTermsVersion: 1,
        consentVersion: PUBLICATION_CONSENT, accepted: true, sellerConfirmationMethod: "WRITTEN", photoRightsConfirmed: true,
        payoutConsentVersion: "not-used-for-managed",
        accountCheck: { stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() },
      });

      const managedTerms = await guests.publicBookingTerms(draft.slug);
      assert.equal(managedTerms?.salesPlanRevision, 1);
      assert.equal(managedTerms?.sellerDisplayName, "Synthetic NIHO Seller");
      assert.equal((await publications.getPublicBySlug(draft.slug))?.providerPublicName, "Synthetic Actual Provider");
      const paid = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "paid@example.test"));
      assert.deepEqual([paid.booking.sellerSnapshot.chargeMode, paid.booking.sellerSnapshot.salesPlan, paid.booking.sellerSnapshot.feeBasisPoints], ["PLATFORM", "MANAGED_20", 2000]);
      await guests.attachCheckoutSession(paid.publicBookingId, "cs_test_platform_paid_old");
      await store.confirmBookingPayment({ providerId: profile.providerId }, {
        publicBookingId: paid.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_PlatformPaidOld1",
        stripeEventId: "evt_PlatformPaidOld1", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      });
      const openOld = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "open@example.test"));
      await guests.attachCheckoutSession(openOld.publicBookingId, "cs_test_platform_open_old");
      const unattachedOld = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "unattached@example.test"));

      const accounts = new HostAccounts(pool);
      const nowUtc = new Date().toISOString();
      const account = await accounts.provisionHostAccount({ email: "owner-managed@example.test", nowUtc });
      const owner = { providerId: profile.providerId, nihoUserId: account.hostAccountId };
      await new SiteSaleRegistration(pool).provisionHostAccountSeller({
        providerId: profile.providerId,
        providerDisplayName: "Synthetic Actual Provider",
        sellerDisplayName: "Synthetic Owner Seller",
        stripeConnectAccountRef: CONNECT,
      });
      assert.equal((await accounts.grantProviderOwner({ providerId: owner.providerId, hostAccountId: owner.nihoUserId, nowUtc })).kind, "granted");
      await new ProviderPayoutAccountConsents(pool).record(owner, { stripeConnectAccountRef: CONNECT, consentVersion: "payout-synthetic-v1", nowUtc: new Date().toISOString() });
      await pool.query(
        `INSERT INTO provider_seller_disclosures
          (provider_id,method,seller_kind,seller_display_name,external_url,consent_version,consented_at,consented_by_niho_user_id)
         VALUES ($1,'EXTERNAL','PERSON','Synthetic Owner Seller','https://example.test/owner-seller','seller-disclosure-v1',clock_timestamp(),$2)`,
        [profile.providerId, owner.nihoUserId],
      );

      const commandId = randomUUID();
      const switchToSupported = {
        commandId, expectedVersion: 1, plan: "SUPPORTED_15", agreementVersion: "owner-supported-synthetic-v1",
        agreementConfirmedAtUtc: new Date().toISOString(), sellerDisclosureUrl: "https://example.test/owner-seller", stripeReady: true,
      } as const;
      const transition = await managed.beginOwnerSwitch(owner, draft.id, switchToSupported);
      assert.deepEqual(transition.openCheckouts, [{ publicBookingId: openOld.publicBookingId, checkoutSessionRef: "cs_test_platform_open_old" }]);
      assert.equal(await guests.publicBookingTerms(draft.slug), null, "new acceptance is durably fenced during cutover");
      await assert.rejects(guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "stale-page@example.test")), StoreNotFoundError);
      await assert.rejects(guests.attachCheckoutSession(unattachedOld.publicBookingId, "cs_test_platform_raced_old"), StoreConflictError);
      assert.equal(await guests.expireGuestHoldForSalesPlanSwitch(owner, openOld.publicBookingId, "cs_test_platform_open_old"), true);
      assert.equal((await store.getBooking(owner, openOld.publicBookingId)).status, "EXPIRED");
      const reconciled = await managed.recordCheckoutOutcome(owner, draft.id, commandId, "cs_test_platform_open_old", "EXPIRED");
      const activated = await managed.finalizeSwitch(owner, draft.id, commandId, reconciled.version);
      const replay = await managed.beginOwnerSwitch(owner, draft.id, switchToSupported);
      assert.deepEqual([replay.state.version, replay.openCheckouts], [activated.version, []]);

      const directTerms = await guests.publicBookingTerms(draft.slug);
      assert.equal(directTerms?.salesPlanRevision, 2);
      const direct = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 2, "direct@example.test"));
      assert.deepEqual([direct.booking.sellerSnapshot.chargeMode, direct.booking.sellerSnapshot.salesPlan, direct.booking.sellerSnapshot.stripeConnectAccountRef], ["CONNECT_DIRECT", "SUPPORTED_15", CONNECT]);
      const registeredSeller = await publications.currentHostAccountSellerProfile(owner.nihoUserId);
      assert.equal(registeredSeller.kind, "ready");
      assert.equal(direct.booking.sellerSnapshot.nihoAccountRef, registeredSeller.profile.sellerNihoAccountRef);
      const oldAfterSwitch = await store.getBooking(owner, paid.publicBookingId);
      assert.deepEqual([oldAfterSwitch.sellerSnapshot.chargeMode, oldAfterSwitch.sellerSnapshot.salesPlanRevision, oldAfterSwitch.sellerSnapshot.stripeConnectAccountRef], ["PLATFORM", 1, PLATFORM]);

      await guests.attachCheckoutSession(direct.publicBookingId, "cs_test_direct_supported_old");
      const supportedState = await managed.get(profile.providerId, draft.id);
      assert.ok(supportedState);
      const directCommand = randomUUID();
      const directTransition = await managed.beginOwnerSwitch(owner, draft.id, {
        commandId: directCommand, expectedVersion: supportedState.version, plan: "INDEPENDENT_10",
        agreementVersion: "owner-independent-synthetic-v1", agreementConfirmedAtUtc: new Date().toISOString(),
        sellerDisclosureUrl: "https://example.test/owner-seller", stripeReady: true,
      });
      assert.equal((await guests.publicBookingTerms(draft.slug)), null);
      assert.deepEqual(directTransition.openCheckouts, [{ publicBookingId: direct.publicBookingId, checkoutSessionRef: "cs_test_direct_supported_old" }]);
      assert.equal(await guests.expireGuestHoldForSalesPlanSwitch(owner, direct.publicBookingId, "cs_test_direct_supported_old"), true);
      const directReconciled = await managed.recordCheckoutOutcome(owner, draft.id, directCommand, "cs_test_direct_supported_old", "EXPIRED");
      await managed.finalizeSwitch(owner, draft.id, directCommand, directReconciled.version);
      assert.equal((await guests.publicBookingTerms(draft.slug))?.salesPlanRevision, 3);
      assert.deepEqual([(await store.getBooking(owner, direct.publicBookingId)).sellerSnapshot.salesPlan, (await store.getBooking(owner, direct.publicBookingId)).sellerSnapshot.salesPlanRevision], ["SUPPORTED_15", 2]);
      const independent = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 3, "independent@example.test"));
      assert.deepEqual([independent.booking.sellerSnapshot.stripeConnectAccountRef, independent.booking.sellerSnapshot.feeBasisPoints], [CONNECT, 1000]);

      const preview = await cancellations.previewSupportOperation(ADMIN, { action: "CANCEL", publicBookingId: paid.publicBookingId, refund: { kind: "PARTIAL", amount: 2_000 } });
      const cancelled = await cancellations.cancelAsSupport(ADMIN, paid.publicBookingId, {
        commandId: randomUUID(), expectedSnapshot: preview.expectedSnapshot, reason: "GUEST_REQUEST", refund: { kind: "PARTIAL", amount: 2_000 },
      });
      const refund = cancelled.refunds[0]!;
      assert.deepEqual([refund.chargeMode, refund.connectedAccountId, refund.refundApplicationFee], ["PLATFORM", PLATFORM, false]);
      await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_PlatformPartial1", status: "succeeded" });
      await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_PlatformPartial1", status: "succeeded" });

      const afterExperience = new Date(Date.parse(paid.booking.occurrenceSnapshot.endUtc) + 1000);
      const compensation = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), afterExperience);
      assert.deepEqual([compensation.capturedAmount, compensation.refundedAmount, compensation.nihoFeeAmount, compensation.providerAmount], [10_000, 2_000, 1_600, 6_400]);
      assert.equal(compensation.dueOn, addLocalDays(paid.booking.occurrenceSnapshot.localDate, 14));
      await managed.prepareCompensation(ADMIN, paid.publicBookingId, { commandId: randomUUID(), expectedVersion: compensation.version, recipientVerified: true });
      const recalculatedPrepared = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), afterExperience);
      assert.equal(recalculatedPrepared.status, "PREPARED");
      assert.equal(recalculatedPrepared.preparedAmount, 6_400);
      await managed.markCompensationResultUnknown(ADMIN, paid.publicBookingId, { commandId: randomUUID(), expectedVersion: recalculatedPrepared.version });
      const recalculatedUnknown = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), afterExperience);
      assert.equal(recalculatedUnknown.status, "RESULT_UNKNOWN");
      await assert.rejects(managed.prepareCompensation(ADMIN, paid.publicBookingId, {
        commandId: randomUUID(), expectedVersion: recalculatedUnknown.version, recipientVerified: true,
      }), StoreConflictError);
      const noDebit = { commandId: randomUUID(), expectedVersion: recalculatedUnknown.version, statementReference: "synthetic-no-debit-001" };
      const cleared = await managed.reconcileCompensationNotPaid(ADMIN, paid.publicBookingId, noDebit);
      assert.deepEqual([cleared.status, cleared.preparationId, cleared.recipientVerified], ["REVIEW_REQUIRED", null, false]);
      assert.equal((await managed.reconcileCompensationNotPaid(ADMIN, paid.publicBookingId, noDebit)).version, cleared.version);
      const fresh = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), afterExperience);
      const secondPreparation = await managed.prepareCompensation(ADMIN, paid.publicBookingId, {
        commandId: randomUUID(), expectedVersion: fresh.version, recipientVerified: true,
      });
      const secondUnknown = await managed.markCompensationResultUnknown(ADMIN, paid.publicBookingId, {
        commandId: randomUUID(), expectedVersion: secondPreparation.version,
      });
      const paidCommand = randomUUID();
      const paidCompensation = await managed.reconcileCompensation(ADMIN, paid.publicBookingId, {
        commandId: paidCommand, expectedVersion: secondUnknown.version, statementReference: "synthetic-statement-001", paidAtUtc: afterExperience.toISOString(), paidAmount: 6_400,
      });
      assert.equal(paidCompensation.status, "PAID");
      assert.equal((await managed.reconcileCompensation(ADMIN, paid.publicBookingId, {
        commandId: paidCommand, expectedVersion: secondUnknown.version, statementReference: "synthetic-statement-001", paidAtUtc: afterExperience.toISOString(), paidAmount: 6_400,
      })).paidAmount, 6_400, "a result-unknown retry cannot double-record payment");
      await assert.rejects(managed.reconcileCompensation(ADMIN, paid.publicBookingId, {
        commandId: randomUUID(), expectedVersion: paidCompensation.version, statementReference: "synthetic-statement-duplicate", paidAtUtc: afterExperience.toISOString(), paidAmount: 6_400,
      }), StoreConflictError);
      const dispute = { stripeEventId: "evt_PlatformDispute1", eventOccurredAtUtc: new Date(afterExperience.getTime() + 1_000).toISOString(),
        platformAccountId: PLATFORM, stripeDisputeRef: "dp_PlatformSynthetic1", paymentIntentRef: "pi_PlatformPaidOld1",
        amount: 1_000, currency: "JPY", status: "LOST" as const };
      assert.equal((await managed.recordDispute(dispute)).duplicate, false);
      assert.equal((await managed.recordDispute(dispute)).duplicate, true);
      const adjusted = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), new Date(afterExperience.getTime() + 2_000));
      assert.deepEqual([adjusted.status, adjusted.providerAmount, adjusted.paidAmount, adjusted.adjustmentAmount], ["ADJUSTMENT_REQUIRED", 5_600, 6_400, -800]);
      assert.equal((await managed.listHostCompensations(owner))[0]?.providerAmount, 5_600);
      assert.equal(JSON.stringify(await managed.listHostCompensations(owner)).includes(PLATFORM), false);
    } finally { await db.dispose(); }
  });
});
