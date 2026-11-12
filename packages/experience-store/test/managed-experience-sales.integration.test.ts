import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestBookingRepository, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ManagedExperienceSalesRepository, managedPaymentDueDate } from "../src/managed-sales.ts";
import { ManagedBookingApprovalRepository } from "../src/managed-booking-approvals.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
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

it("determines the agreed due date from the original booking terms", () => {
  const monthEnd = { paymentDuePolicy: "NEXT_MONTH_END", paymentDueDays: null };
  assert.equal(managedPaymentDueDate("2026-11-15", "2026-11-15T03:30:00Z", monthEnd), "2026-12-31");
  assert.equal(managedPaymentDueDate("2026-12-31", "2026-12-31T15:00:00Z", monthEnd), "2027-02-28");
  assert.equal(managedPaymentDueDate("2028-01-31", "2028-01-31T03:30:00Z", monthEnd), "2028-02-29");
  assert.equal(managedPaymentDueDate("2026-07-01", "2026-07-01T03:30:00Z", monthEnd), "2026-08-31");
  assert.equal(managedPaymentDueDate("2026-11-15", "2026-11-15T03:30:00Z", { paymentDueDays: 14 }), "2026-11-29");
});

describe("managed Experience sale end-to-end (#507/#508/#509)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("creates an unregistered provider, sells on platform, fences old Checkout, switches this product to Direct, refunds and records manual compensation", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "managed_experience_sales", { max: 6 });
    try {
      const pool = db.pool;
      const publications = new ExperiencePublicationRepository(pool);
      const store = new ExperienceStore(pool);
      const guests = new GuestBookingRepository(pool, { assignmentNotifications: true });
      const managed = new ManagedExperienceSalesRepository(pool);
      const cancellations = new BookingCancellations(pool);

      const profile = await publications.createAdminProvider(ADMIN, {
        publicDisplayName: "Synthetic Actual Provider", providerKind: "PERSON", consentVersion: "provider-profile-synthetic-v1",
      });
      assert.deepEqual(await publications.listAdminDraftProducts(ADMIN, profile.providerId), []);
      const managedConfig = {
        seller: { legalSellerName: "Synthetic NIHO Seller", commercialTransactionsUrl: "https://example.test/niho-seller", sellerNihoAccountRef: "niho-seller-synthetic", platformAccountId: PLATFORM },
        agreementVersion: "managed-20-synthetic-v1", agreementConfirmedAtUtc: new Date().toISOString(), agreementConfirmationMethod: "WRITTEN" as const, pilotApproved: true as const,
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
      const privateDraft = await publications.createDraftAsAdmin(ADMIN, profile.providerId, {
        slug: "synthetic-managed-private-group", publicTitle: "Synthetic managed private group",
        content: {}, currency: "JPY", unitAmount: 10_000,
      }, { ...managedConfig, privateGroup: true });
      const inventory = await store.getInventoryAdminSnapshot(ADMIN, profile.providerId);
      assert.equal(inventory.products.find(({ id }) => id === privateDraft.id)?.inventory?.bookingMode, "PRIVATE_GROUP");
      assert.equal(inventory.products.find(({ id }) => id === draft.id)?.inventory, undefined);

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

      // #515: a separate immutable MANAGED_20 revision requests first and never opens Checkout in the public transaction.
      const approvalDraft = await publications.createDraftAsAdmin(ADMIN, profile.providerId, {
        slug: "synthetic-managed-approval", publicTitle: "Synthetic managed approval",
        content: {
          ja: { title: "合成の承認制体験", lead: "合成の紹介", description: "合成の説明", language: "日本語", highlights: ["合成"], included: ["合成素材"], notIncluded: [], knowBeforeYouGo: ["合成注意"], notSuitableFor: [], timeline: [] },
          lead: "Synthetic lead", description: "Synthetic description", facts: { language: "Japanese" }, highlights: ["Synthetic"], included: ["Synthetic material"], notIncluded: [], knowBeforeYouGo: ["Synthetic note"], notSuitableFor: [], timeline: [],
          meetingOverview: "Synthetic meeting point", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
        }, currency: "JPY", unitAmount: 10_000,
      }, { ...managedConfig, acceptanceMode: "APPROVAL" });
      const approvalMediaId = randomUUID();
      await publications.addMediaAsAdmin(ADMIN, profile.providerId, approvalDraft.id, {
        id: approvalMediaId, objectKey: `experience-products/${approvalMediaId}.jpg`, sourceRefHash: "b".repeat(64),
        width: 1200, height: 800, byteSize: 4096, altText: "Synthetic approval experience", altTextJa: "合成の承認制体験", publicCredit: null,
      });
      const approvalOfferId = randomUUID();
      await store.saveDraftScheduleRuleAsAdmin(ADMIN, profile.providerId, approvalDraft.id, {
        ...schedule, id: approvalOfferId,
      }, null, approvalOfferId);
      const approvalCurrent = await publications.getAdminDraftProduct(ADMIN, profile.providerId, approvalDraft.id);
      await publications.saveSaleTermsAsAdmin(ADMIN, profile.providerId, approvalDraft.id, {
        expectedDraftVersion: approvalCurrent.version, expectedSaleTermsVersion: null,
        saleTerms: { offerPrices: null, childPricing: null, minimumParticipants: 1, minimumChargeableParticipants: 1, maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_24H", cancellationWindowMinutesBeforeStart: 1440, cancellationRefundBasisPoints: 10_000, minimumAttendance: null, bookingQuestions: [], conditionsVersion: null },
      });
      await publications.reviewAdminDraftEnglish(ADMIN, profile.providerId, approvalDraft.id, approvalCurrent.version);
      const approvalPublication = await publications.publishAdminDraft(ADMIN, profile.providerId, approvalDraft.id, {
        expectedDraftVersion: approvalCurrent.version, expectedStateVersion: null, expectedSaleTermsVersion: 1,
        consentVersion: PUBLICATION_CONSENT, accepted: true, sellerConfirmationMethod: "WRITTEN", photoRightsConfirmed: true,
        payoutConsentVersion: "not-used-for-managed", accountCheck: { stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() },
      });
      assert.equal((await guests.publicBookingTerms(approvalDraft.slug))?.offers[0]?.acceptanceMode, "APPROVAL");
      const approvalRepository = new ManagedBookingApprovalRepository(pool);
      const outbox = new GuestMailOutbox(pool);
      const requested = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(2), 1, "approval@example.test"));
      assert.equal(requested.checkoutSessionRef, null);
      assert.equal(requested.booking.sellerSnapshot.acceptanceMode, "APPROVAL");
      assert.ok(Date.parse(requested.holdExpiresAt) - Date.now() > 23 * 60 * 60_000);
      assert.deepEqual((await pool.query("SELECT approval_status,checkout_session_ref FROM booking_guests WHERE booking_id=(SELECT id FROM bookings WHERE public_booking_id=$1)", [requested.publicBookingId])).rows[0], {
        approval_status: "PENDING", checkout_session_ref: null,
      });
      const requestedMail = await pool.query("SELECT topic,payload::text,available_at FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%' ORDER BY topic", [requested.publicBookingId]);
      assert.deepEqual(requestedMail.rows.map(({ topic }) => topic), [
        "managed.guest.request_expired", "managed.guest.request_received", "managed.office.new_request",
      ]);
      assert.ok(requestedMail.rows.every(({ payload }) => payload === '{\"v\": 1}'));
      // #535: the request also tells whoever can take its occurrence (one push; nobody has an address here), and no guest data.
      const assignmentRows = await pool.query("SELECT topic,payload::text FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'host.%assignment_request'", [requested.publicBookingId]);
      assert.deepEqual(assignmentRows.rows.map(({ topic }) => topic), ["host.notify.assignment_request"]);
      assert.ok(!assignmentRows.rows[0]!.payload.includes("Synthetic Guest") && !assignmentRows.rows[0]!.payload.includes("approval@example.test"));
      assert.ok(requestedMail.rows.every(({ payload }) => !payload.includes("approval@example.test") && !payload.includes("cs_")));
      const mailLease = { limit: 25, leaseSeconds: 60 };
      const receipt = (await outbox.claimManagedGuestMails(mailLease)).mails[0]!;
      assert.equal(receipt.email?.kind, "REQUEST_RECEIVED");
      assert.equal(receipt.email?.guestLanguage, "JA");
      await outbox.completeManagedGuestMail(receipt.id);
      const office = (await outbox.claimManagedOperationsMails({ ...mailLease, includeProvider: false })).mails[0]!;
      assert.equal(office.email?.kind, "NEW_REQUEST");
      assert.doesNotMatch(JSON.stringify(office), /approval@example\.test|Synthetic Guest/);
      await outbox.completeManagedOperationsMail(office.id);
      await assert.rejects(guests.attachCheckoutSession(requested.publicBookingId, "cs_test_unapproved"), StoreConflictError);
      await assert.rejects(store.confirmBookingPayment({ providerId: profile.providerId }, {
        publicBookingId: requested.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_PlatformTooEarly1",
        stripeEventId: "evt_PlatformTooEarly1", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      }), StoreConflictError);
      assert.equal((await approvalRepository.listPending(ADMIN)).requests.find((item) => item.publicBookingId === requested.publicBookingId)?.guestEmail, "approval@example.test");
      const approvedRequest = await approvalRepository.approve(ADMIN, requested.publicBookingId);
      assert.equal(approvedRequest.checkoutSessionRef, null);
      await assert.rejects(approvalRepository.decline(ADMIN, requested.publicBookingId), StoreConflictError);
      await guests.attachCheckoutSession(requested.publicBookingId, "cs_test_approved_reusable");
      await guests.attachCheckoutSession(requested.publicBookingId, "cs_test_approved_reusable");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1 AND topic='managed.guest.payment_ready'", [requested.publicBookingId])).rows[0]?.n, 1);
      const paymentMail = (await outbox.claimManagedGuestMails(mailLease)).mails[0]!;
      assert.equal(paymentMail.email?.kind, "PAYMENT_READY");
      assert.equal(await outbox.managedGuestMailStillSendable(paymentMail.id, { kind: "PAYMENT_READY", checkoutStatus: "open" }), true);
      await outbox.completeManagedGuestMail(paymentMail.id);
      assert.equal((await approvalRepository.approve(ADMIN, requested.publicBookingId)).checkoutSessionRef, "cs_test_approved_reusable");
      assert.equal((await store.confirmBookingPayment({ providerId: profile.providerId }, {
        publicBookingId: requested.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_PlatformApproval1",
        stripeEventId: "evt_PlatformApproval1", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      })).booking.status, "CONFIRMED");
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%' ORDER BY topic", [requested.publicBookingId])).rows.map(({ topic }) => topic), [
        "managed.guest.payment_ready", "managed.guest.request_expired", "managed.guest.request_received",
        "managed.office.confirmed", "managed.office.new_request", "managed.provider.confirmed",
      ]);

      const declinedRequest = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(3), 1, "declined@example.test"));
      await approvalRepository.decline(ADMIN, declinedRequest.publicBookingId);
      assert.equal((await pool.query("SELECT status FROM bookings WHERE public_booking_id=$1", [declinedRequest.publicBookingId])).rows[0]?.status, "EXPIRED");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1 AND topic='managed.guest.request_declined'", [declinedRequest.publicBookingId])).rows[0]?.n, 1);

      const expiredRequest = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(4), 1, "expired@example.test"));
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query("UPDATE bookings SET created_at=clock_timestamp()-interval '2 minutes',hold_expires_at=clock_timestamp()-interval '1 minute' WHERE public_booking_id=$1", [expiredRequest.publicBookingId]);
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      await assert.rejects(approvalRepository.approve(ADMIN, expiredRequest.publicBookingId), StoreConflictError);
      await pool.query("UPDATE outbox_messages SET available_at=clock_timestamp() WHERE aggregate_id=$1 AND topic='managed.guest.request_expired'", [expiredRequest.publicBookingId]);
      const expiry = (await outbox.claimManagedGuestMails(mailLease)).mails.find((mail) => mail.email?.publicBookingId === expiredRequest.publicBookingId)!;
      assert.equal(expiry.email?.kind, "REQUEST_EXPIRED");
      assert.equal(await outbox.managedGuestMailStillSendable(expiry.id, { kind: "REQUEST_EXPIRED" }), true);
      await approvalRepository.decline(ADMIN, expiredRequest.publicBookingId);

      const asyncRequest = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(4), 1, "async@example.test"));
      await approvalRepository.approve(ADMIN, asyncRequest.publicBookingId);
      await guests.attachCheckoutSession(asyncRequest.publicBookingId, "cs_test_async_failed");
      const asyncFailure = {
        publicBookingId: asyncRequest.publicBookingId, connectedAccountId: PLATFORM, stripeEventId: "evt_ManagedAsyncFailed",
        stripeEventType: "checkout.session.async_payment_failed" as const, checkoutSessionRef: "cs_test_async_failed",
        eventOccurredAtUtc: new Date().toISOString(),
      };
      assert.equal((await guests.releaseGuestHold({ ...asyncFailure, stripeEventId: "evt_ManagedWrongSession", checkoutSessionRef: "cs_test_other_session" })).released, false);
      assert.equal((await guests.releaseGuestHold(asyncFailure)).released, true);
      assert.equal((await guests.releaseGuestHold(asyncFailure)).duplicateEvent, true);
      const failure = (await outbox.claimManagedGuestMails(mailLease)).mails.find((mail) => mail.email?.publicBookingId === asyncRequest.publicBookingId)!;
      assert.equal(failure.email?.kind, "PAYMENT_FAILED");
      assert.equal(await outbox.managedGuestMailStillSendable(failure.id, { kind: "PAYMENT_FAILED" }), true);

      const racedRequest = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(5), 1, "raced@example.test"));
      const decisions = await Promise.allSettled([
        approvalRepository.approve(ADMIN, racedRequest.publicBookingId),
        approvalRepository.decline(ADMIN, racedRequest.publicBookingId),
      ]);
      assert.equal(decisions.filter(({ status }) => status === "fulfilled").length, 1);
      const lostDecision = decisions.find((decision) => decision.status === "rejected");
      assert.ok(lostDecision?.reason instanceof StoreConflictError);

      const pendingAtStop = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(6), 1, "pending-at-stop@example.test"));
      const approvedAtStop = await guests.startGuestBooking(bookingRequest(approvalDraft.slug, approvalOfferId, day(7), 1, "approved-at-stop@example.test"));
      await approvalRepository.approve(ADMIN, approvedAtStop.publicBookingId);
      const firstApprovalPage = await approvalRepository.listPending(ADMIN, 1, 1);
      const secondApprovalPage = await approvalRepository.listPending(ADMIN, 2, 1);
      assert.equal(firstApprovalPage.hasNext, true);
      assert.equal(firstApprovalPage.requests.length, 1);
      assert.equal(secondApprovalPage.requests.length, 1);
      assert.notEqual(firstApprovalPage.requests[0]?.publicBookingId, secondApprovalPage.requests[0]?.publicBookingId);

      await publications.suspendByOperations(ADMIN, profile.providerId, approvalDraft.id, "PILOT_STOP", approvalPublication.version);
      await assert.rejects(approvalRepository.approve(ADMIN, pendingAtStop.publicBookingId), StoreConflictError);
      await assert.rejects(guests.attachCheckoutSession(approvedAtStop.publicBookingId, "cs_test_platform_stopped"), StoreConflictError);
      await approvalRepository.decline(ADMIN, pendingAtStop.publicBookingId);

      await assert.rejects(guests.startGuestBooking({
        ...bookingRequest(draft.slug, offerId, day(2), 1, "closed@example.test"), managedSalesEnabled: false,
      }), StoreNotFoundError);
      const paid = await guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "paid@example.test"));
      assert.deepEqual([paid.booking.sellerSnapshot.chargeMode, paid.booking.sellerSnapshot.salesPlan, paid.booking.sellerSnapshot.feeBasisPoints], ["PLATFORM", "MANAGED_20", 2000]);
      assert.equal(paid.booking.sellerSnapshot.paymentDuePolicy, "NEXT_MONTH_END");
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%' ORDER BY topic", [paid.publicBookingId])).rows.map(({ topic }) => topic), []);
      await guests.attachCheckoutSession(paid.publicBookingId, "cs_test_platform_paid_old");
      await store.confirmBookingPayment({ providerId: profile.providerId }, {
        publicBookingId: paid.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_PlatformPaidOld1",
        stripeEventId: "evt_PlatformPaidOld1", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      });
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%' ORDER BY topic", [paid.publicBookingId])).rows.map(({ topic }) => topic), [
        "managed.office.confirmed", "managed.provider.confirmed",
      ]);
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
      const disclosures = new ProviderSellerDisclosureRepository(pool);
      const disclosure = {
        method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Owner Seller", representativeName: null,
        publicAddress: "Synthetic address", publicPhone: "+81 90 0000 0000", publicEmail: "owner-seller@example.test",
        consentVersion: "seller-disclosure-v1", accepted: true,
      } as const;
      await disclosures.save(owner, { commandId: randomUUID(), expectedVersion: null, disclosure });
      assert.equal(await disclosures.getPublicBySlug(draft.slug), null, "the future seller's disclosure stays private during platform sales");
      assert.equal((await guests.publicBookingTerms(draft.slug))?.sellerDisclosureUrl, "https://example.test/niho-seller");

      const commandId = randomUUID();
      const sellerDisclosureUrl = `https://example.test/experiences/${draft.slug}/seller`;
      const switchToSupported = {
        commandId, expectedVersion: 1, plan: "SUPPORTED_15", agreementVersion: "owner-supported-synthetic-v1",
        agreementConfirmedAtUtc: new Date().toISOString(), sellerDisclosureUrl, stripeReady: true,
      } as const;
      const transition = await managed.beginOwnerSwitch(owner, draft.id, switchToSupported);
      assert.deepEqual(transition.openCheckouts, [{ publicBookingId: openOld.publicBookingId, checkoutSessionRef: "cs_test_platform_open_old" }]);
      assert.equal(await guests.publicBookingTerms(draft.slug), null, "new acceptance is durably fenced during cutover");
      await assert.rejects(guests.startGuestBooking(bookingRequest(draft.slug, offerId, day(2), 1, "stale-page@example.test")), StoreNotFoundError);
      await assert.rejects(guests.attachCheckoutSession(unattachedOld.publicBookingId, "cs_test_platform_raced_old"), StoreConflictError);
      const interrupted = await managed.recordCheckoutOutcome(owner, draft.id, commandId, "cs_test_platform_open_old", "UNKNOWN");
      await assert.rejects(managed.finalizeSwitch(owner, draft.id, commandId, interrupted.version), StoreConflictError);
      const saved = await new ManagedExperienceSalesRepository(pool).get(profile.providerId, draft.id);
      assert.equal(saved?.transitionCommandId, commandId);
      assert.equal(saved?.pending?.agreementVersion, switchToSupported.agreementVersion);
      const resumed = await managed.beginOwnerSwitch(owner, draft.id, { ...switchToSupported, expectedVersion: interrupted.version });
      assert.deepEqual(resumed.openCheckouts, transition.openCheckouts);
      assert.equal(await guests.expireGuestHoldForSalesPlanSwitch(owner, openOld.publicBookingId, "cs_test_platform_open_old"), true);
      assert.equal((await store.getBooking(owner, openOld.publicBookingId)).status, "EXPIRED");
      const reconciled = await managed.recordCheckoutOutcome(owner, draft.id, commandId, "cs_test_platform_open_old", "EXPIRED");
      const activated = await managed.finalizeSwitch(owner, draft.id, commandId, reconciled.version);
      const replay = await managed.beginOwnerSwitch(owner, draft.id, switchToSupported);
      assert.deepEqual([replay.state.version, replay.openCheckouts], [activated.version, []]);

      const directTerms = await guests.publicBookingTerms(draft.slug);
      assert.equal(directTerms?.salesPlanRevision, 2);
      assert.equal(directTerms?.sellerDisclosureUrl, sellerDisclosureUrl);
      assert.deepEqual(await disclosures.getPublicBySlug(draft.slug), {
        method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Owner Seller", representativeName: null,
        publicAddress: disclosure.publicAddress, publicPhone: disclosure.publicPhone, publicEmail: disclosure.publicEmail,
      });
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
        sellerDisclosureUrl, stripeReady: true,
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
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%' ORDER BY topic", [paid.publicBookingId])).rows.map(({ topic }) => topic), [
        "managed.office.cancelled", "managed.office.confirmed",
        "managed.provider.cancelled", "managed.provider.confirmed",
      ]);
      const refund = cancelled.refunds[0]!;
      assert.deepEqual([refund.chargeMode, refund.connectedAccountId, refund.refundApplicationFee], ["PLATFORM", PLATFORM, false]);
      await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_PlatformPartial1", status: "succeeded" });
      await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_PlatformPartial1", status: "succeeded" });

      const afterExperience = new Date(Date.parse(paid.booking.occurrenceSnapshot.endUtc) + 1000);
      const compensation = await managed.calculateCompensation(ADMIN, paid.publicBookingId, randomUUID(), afterExperience);
      assert.deepEqual([compensation.capturedAmount, compensation.refundedAmount, compensation.nihoFeeAmount, compensation.providerAmount], [10_000, 2_000, 1_600, 6_400]);
      assert.equal(compensation.dueOn, managedPaymentDueDate(
        paid.booking.occurrenceSnapshot.localDate, paid.booking.occurrenceSnapshot.endUtc, { ...paid.booking.sellerSnapshot },
      ));
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
