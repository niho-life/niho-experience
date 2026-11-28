import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository, PROVIDER_SUSPENDED_CODE, isSelling } from "../src/experience-publication.ts";
import { OfficeNotices } from "../src/office-notices.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ExperienceStore } from "../src/repository.ts";
import { SiteSaleRegistration } from "../src/site-sale-registration.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/*
 * #711 (host registration, stage 4): the office's tools: host-wide suspension, the host list, the notices to the office.
 * Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-page-booking";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const ACCOUNT = "acct_SyntheticPageBooking01";
const CONSENT = "publication-consent-synthetic-v1";

const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
const rule: ScheduleRule = {
  id: "page-booking-daily", timeZone: "Asia/Tokyo", startsOn: dayFromNow(-1), localStartTime: "10:00", durationMinutes: 90,
  capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_operations", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

async function sellerlessOwner(pool: Pool): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [PROVIDER]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email: "page-booking@example.test", nowUtc: new Date().toISOString() });
  const granted = await accounts.grantProviderOwner({ providerId: PROVIDER, hostAccountId, nowUtc: new Date().toISOString() });
  assert.equal(granted.kind, "granted");
  await seedNotificationAddresses(pool, hostAccountId);
  return { providerId: PROVIDER, nihoUserId: hostAccountId };
}

/** A sellerless draft with a photo and sale terms: everything a PAGE needs (no schedule, no seller). */
async function pageReadyDraft(pool: Pool, owner: HostActor, slug: string) {
  const publications = new ExperiencePublicationRepository(pool);
  const draft = await publications.createDraft(owner, { slug, publicTitle: "Synthetic page walk", content: manuscript, currency: "JPY", unitAmount: 4_000 });
  const photoId = randomUUID();
  await publications.addMedia(owner, draft.id, {
    id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: "7".repeat(64),
    width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
  });
  const current = await publications.getProduct(owner, draft.id);
  await publications.saveSaleTerms(owner, draft.id, {
    expectedDraftVersion: current.version, expectedStateVersion: null, expectedSaleTermsVersion: null,
    saleTerms: {
      offerPrices: null, childPricing: null, minimumParticipants: 2, minimumChargeableParticipants: 3, maxPartySize: 6,
      cancellationPolicy: "CUSTOM", cancellationWindowMinutesBeforeStart: 90, cancellationRefundBasisPoints: 3_750,
      minimumAttendance: 4, bookingQuestions: [], conditionsVersion: null,
    } as never,
    checks: CHECKS,
  });
  return { publications, draft: await publications.getProduct(owner, draft.id) };
}

/** What a seller + readiness + fee settings + a schedule add: everything starting bookings needs. */
async function becomeSeller(pool: Pool, owner: HostActor, productId: string): Promise<void> {
  const publications = new ExperiencePublicationRepository(pool);
  const registration = new SiteSaleRegistration(pool);
  await registration.provisionHostAccountSeller({ providerId: PROVIDER, providerDisplayName: "Synthetic Club", sellerDisplayName: "Synthetic Legal Seller KK", stripeConnectAccountRef: ACCOUNT });
  const profile = (await pool.query("SELECT seller_niho_account_ref AS ref FROM experience_host_seller_profiles WHERE provider_id=$1", [PROVIDER])).rows[0];
  const now = Date.now();
  await publications.recordReadiness(owner, {
    accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, paymentReuseConsentVersion: "synthetic-payment-reuse-v1",
    paymentReuseConsentedAtUtc: new Date(now - 2_000).toISOString(), sellerDisplayReady: true, sellerNihoAccountRef: String(profile.ref),
    stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK", requiredConsentVersion: CONSENT,
    observedAtUtc: new Date(now - 1_000).toISOString(), validUntilUtc: new Date(now + 60_000).toISOString(),
  }, null);
  await pool.query("INSERT INTO provider_sale_settings (provider_id,support_enabled,platform_fee_basis_points) VALUES ($1,false,1000)", [PROVIDER]);
  const guests = new GuestBookingRepository(pool);
  const settings = await guests.getProviderSupportSettings(owner);
  await guests.setProviderSupportSettings(owner, { supportEnabled: false, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: settings?.version ?? 0 });
  await new ExperienceStore(pool).saveScheduleRule(owner, productId, rule, null, randomUUID());
}

const OPS = { nihoUserId: "ops-synthetic" };
const CHANNEL_CAUSE = "operations_suspended";

const stateRow = async (pool: Pool, productId: string) => (await pool.query(
  "SELECT operations_suspension_code AS code,owner_resume_required AS resume,booking_publication_id IS NOT NULL AS booking FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2",
  [PROVIDER, productId])).rows[0] as { code: string | null; resume: boolean; booking: boolean };
const eventsOf = async (pool: Pool, productId: string) => (await pool.query(
  "SELECT kind,reason FROM experience_product_booking_events WHERE provider_id=$1 AND product_id=$2 ORDER BY id", [PROVIDER, productId])).rows.map((row) => `${row.kind}:${row.reason}`);
const notices = async (pool: Pool) => (await pool.query("SELECT kind,payload FROM experience_office_notices WHERE provider_id=$1 ORDER BY kind", [PROVIDER])).rows;

/** Three published experiences: A is taking bookings, B is a page only, C is a page an operator already suspended on its own. */
async function threeExperiences(pool: Pool) {
  const owner = await sellerlessOwner(pool);
  const { publications, draft: a0 } = await pageReadyDraft(pool, owner, "ops-a");
  const b0 = (await pageReadyDraft(pool, owner, "ops-b")).draft;
  const c0 = (await pageReadyDraft(pool, owner, "ops-c")).draft;
  const pageA = await publications.publishPage(owner, a0.id, { expectedDraftVersion: a0.version, expectedStateVersion: null, checks: CHECKS });
  await publications.publishPage(owner, b0.id, { expectedDraftVersion: b0.version, expectedStateVersion: null, checks: CHECKS });
  const pageC = await publications.publishPage(owner, c0.id, { expectedDraftVersion: c0.version, expectedStateVersion: null, checks: CHECKS });
  await becomeSeller(pool, owner, a0.id);
  const a = await publications.getProduct(owner, a0.id);
  const input = (draftVersion: number, stateVersion: number) => ({ expectedDraftVersion: draftVersion, expectedStateVersion: stateVersion, consentVersion: CONSENT, checks: CHECKS });
  await publications.openBooking(owner, a.id, input(a.version, pageA.version));
  await publications.suspendByOperations(OPS, PROVIDER, c0.id, "OTHER_REASON", pageC.version);
  // An active channel listing, so a stop of bookings asks for the slots to be closed.
  await pool.query("INSERT INTO channel_external_accounts (id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until) VALUES ('acct-ops',$1,'Airbnb','1','Synthetic',2,true,'2099-02-01T00:00:00Z')", [PROVIDER]);
  await pool.query("INSERT INTO channel_listings (id,provider_id,account_id,product_id,external_product_id,external_option_id,adapter,adapter_version,connection_mode,active) VALUES ('listing-ops',$1,'acct-ops',$2,'9','','airbnb-google-busy','1','GOOGLE',true)", [PROVIDER, a.id]);
  return { owner, publications, a, b: b0, c: c0, input };
}

describe("host-wide suspension (#711)", { skip }, () => {
  it("closes every public experience, records the stop of the selling one and keeps an individual suspension as it was", async () => {
    await withDb(async (pool) => {
      const { owner, publications, a, b, c } = await threeExperiences(pool);
      const before = Number((await pool.query("SELECT count(*)::int AS n FROM calendar_outbox_events WHERE payload->>'cause'=$1", [CHANNEL_CAUSE])).rows[0].n);
      const result = await publications.suspendProviderByOperations(OPS, PROVIDER, "POLICY_VIOLATION");
      assert.deepEqual(result, { changed: true, suspendedProducts: 2 });
      assert.equal((await stateRow(pool, a.id)).code, PROVIDER_SUSPENDED_CODE);
      assert.equal((await stateRow(pool, b.id)).code, PROVIDER_SUSPENDED_CODE);
      assert.equal((await stateRow(pool, c.id)).code, "OTHER_REASON", "an experience stopped on its own keeps its own code");
      assert.equal(isSelling(await publications.getState(owner, a.id)), false);
      assert.deepEqual(await eventsOf(pool, a.id), ["OPENED:OWNER_OPENED", "STOPPED:OPERATIONS_SUSPENDED"]);
      assert.deepEqual(await eventsOf(pool, b.id), []);
      const after = Number((await pool.query("SELECT count(*)::int AS n FROM calendar_outbox_events WHERE payload->>'cause'=$1", [CHANNEL_CAUSE])).rows[0].n);
      assert.ok(after > before, "the external slots are asked to close");
      assert.equal(await publications.getPublicBySlug("ops-a"), null);
      assert.equal(await publications.getPublicBySlug("ops-b"), null);
      const row = (await pool.query("SELECT operations_suspension_code AS code,operations_suspended_by_niho_user_id AS by FROM experience_providers WHERE id=$1", [PROVIDER])).rows[0];
      assert.deepEqual(row, { code: "POLICY_VIOLATION", by: "ops-synthetic" });
      assert.deepEqual((await pool.query("SELECT kind,reason,actor_niho_user_id AS actor FROM experience_provider_operations_events WHERE provider_id=$1 ORDER BY id", [PROVIDER])).rows,
        [{ kind: "SUSPENDED", reason: "POLICY_VIOLATION", actor: "ops-synthetic" }]);
      // The host is told once per experience it lost (the individually suspended one was told earlier, not again).
      const mails = (await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE provider_id=$1 AND topic='host.notify.listing_suspension'", [PROVIDER])).rows[0];
      assert.equal(Number(mails.n), 3, "C's own suspension, then A and B");
      // Idempotent: nothing changes, nothing is written again.
      assert.deepEqual(await publications.suspendProviderByOperations(OPS, PROVIDER, "POLICY_VIOLATION"), { changed: false, suspendedProducts: 0 });
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM experience_provider_operations_events")).rows[0].n), 1);
      await assert.rejects(publications.suspendProviderByOperations(OPS, "no-such-provider", "X"), StoreNotFoundError);
    });
  });

  it("blocks publishing, opening bookings, the owner's restart and a per-experience lift while suspended, but not editing a draft", async () => {
    await withDb(async (pool) => {
      const { owner, publications, a, b, input } = await threeExperiences(pool);
      await publications.suspendProviderByOperations(OPS, PROVIDER, "UNDER_REVIEW");
      const fresh = await pageReadyDraft(pool, owner, "ops-new");
      const blockedWith = (code: string) => (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes(code as never);
      const stateA = (await publications.getState(owner, a.id))!;
      await assert.rejects(publications.publishPage(owner, fresh.draft.id, { expectedDraftVersion: fresh.draft.version, expectedStateVersion: null, checks: CHECKS }), blockedWith("PROVIDER_SUSPENDED"));
      await assert.rejects(publications.openBooking(owner, a.id, input(a.version, stateA.version)), blockedWith("PROVIDER_SUSPENDED"));
      await assert.rejects(publications.publish(owner, a.id, input(a.version, stateA.version)), blockedWith("PROVIDER_SUSPENDED"));
      const stateB = (await publications.getState(owner, b.id))!;
      await assert.rejects(publications.publishPage(owner, b.id, { expectedDraftVersion: b.version, expectedStateVersion: stateB.version, checks: CHECKS }), blockedWith("PROVIDER_SUSPENDED"));
      await assert.rejects(publications.clearOperationsSuspension(OPS, PROVIDER, a.id, stateA.version), blockedWith("PROVIDER_SUSPENDED"));
      assert.deepEqual(await publications.getPublicationBlockers(owner, fresh.draft.id, CHECKS, null, "PAGE"), ["PROVIDER_SUSPENDED"]);
      // A draft can still be edited (and does not go public: the experience is suspended).
      const saved = await publications.saveDraft(owner, {
        id: a.id, slug: a.slug, publicTitle: "Edited while suspended", content: a.content, currency: "JPY", unitAmount: 4_100, cancellationTermsRef: a.cancellationTermsRef,
      } as never, a.version, stateA.version, CHECKS);
      assert.equal(saved.draft.publicTitle, "Edited while suspended");
      assert.equal(saved.publicationUpdated, false);
    });
  });

  it("lifts only the host suspension's own stops, and nothing sells until the owner restarts", async () => {
    await withDb(async (pool) => {
      const { owner, publications, a, b, c, input } = await threeExperiences(pool);
      await publications.suspendProviderByOperations(OPS, PROVIDER, "UNDER_REVIEW");
      assert.deepEqual(await publications.clearProviderOperationsSuspension(OPS, PROVIDER), { changed: true, suspendedProducts: 2 });
      assert.equal((await stateRow(pool, a.id)).code, null);
      assert.equal((await stateRow(pool, b.id)).code, null);
      assert.equal((await stateRow(pool, c.id)).code, "OTHER_REASON", "the other stop stays");
      assert.equal((await stateRow(pool, a.id)).resume, true, "the owner still has to restart it");
      assert.equal(isSelling(await publications.getState(owner, a.id)), false);
      assert.equal(await publications.getPublicBySlug("ops-a"), null, "not public again until the owner restarts");
      assert.deepEqual((await pool.query("SELECT kind FROM experience_provider_operations_events WHERE provider_id=$1 ORDER BY id", [PROVIDER])).rows.map((r) => r.kind), ["SUSPENDED", "CLEARED"]);
      assert.deepEqual(await publications.clearProviderOperationsSuspension(OPS, PROVIDER), { changed: false, suspendedProducts: 0 });
      // The owner restarts A: bookings open again; the individually suspended C still cannot.
      const stateA = (await publications.getState(owner, a.id))!;
      await publications.openBooking(owner, a.id, input(a.version, stateA.version));
      assert.equal(isSelling(await publications.getState(owner, a.id)), true);
      assert.deepEqual(await eventsOf(pool, a.id), ["OPENED:OWNER_OPENED", "STOPPED:OPERATIONS_SUSPENDED", "OPENED:OWNER_RESUMED"]);
      const stateC = (await publications.getState(owner, c.id))!;
      await assert.rejects(publications.publishPage(owner, c.id, { expectedDraftVersion: c.version, expectedStateVersion: stateC.version, checks: CHECKS }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes("OPERATIONS_SUSPENDED"));
    });
  });

  it("keeps the operations event log append-only and the suspension columns all-or-none", async () => {
    await withDb(async (pool) => {
      const { publications } = await threeExperiences(pool);
      await publications.suspendProviderByOperations(OPS, PROVIDER, "UNDER_REVIEW");
      await assert.rejects(pool.query("UPDATE experience_provider_operations_events SET reason='X'"), { code: "23514" });
      await assert.rejects(pool.query("DELETE FROM experience_provider_operations_events"), { code: "23514" });
      await assert.rejects(pool.query("UPDATE experience_providers SET operations_suspension_code=NULL WHERE id=$1", [PROVIDER]), { code: "23514" });
      await assert.rejects(pool.query("UPDATE experience_providers SET operations_suspension_code='lower' WHERE id=$1", [PROVIDER]), { code: "23514" });
    });
  });
});

/** Starts a guest checkout (a HOLD) on experience A and returns what the payment webhook names. */
async function startCheckout(pool: Pool, slug: string) {
  const guests = new GuestBookingRepository(pool);
  const terms = (await guests.publicBookingTerms(slug))!;
  const offer = terms.offers[0]!;
  return guests.startGuestBooking({
    slug, offerId: offer.id, occurrenceDate: dayFromNow(3), adultCount: 3, childCount: 0, expectedTotalYen: 12_000,
    bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint, termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: terms.conditionsVersion, guestName: "Synthetic Guest", guestEmail: "guest@example.test", guestLanguage: "EN", clientRequestKey: randomUUID(),
  } as never);
}
const pay = (pool: Pool, start: Awaited<ReturnType<typeof startCheckout>>, event: string) => new ExperienceStore(pool).confirmBookingPayment(
  { providerId: PROVIDER }, {
    publicBookingId: start.publicBookingId, connectedAccountId: start.stripeConnectAccountRef, stripePaymentRef: `pi_${event}`, stripeEventId: `evt_${event}`,
    stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 12_000, currency: "JPY",
  });
const bookingMessages = async (pool: Pool, topic: string) => Number((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE provider_id=$1 AND topic=$2", [PROVIDER, topic])).rows[0].n);

describe("a payment that began before a suspension (#711)", { skip }, () => {
  it("is confirmed as before when nothing is suspended", async () => {
    await withDb(async (pool) => {
      const { a } = await threeExperiences(pool);
      const result = await pay(pool, await startCheckout(pool, a.slug), "clear");
      assert.equal(result.booking.status, "CONFIRMED");
      assert.equal(await bookingMessages(pool, "booking.confirmed"), 1);
    });
  });

  it("goes to PAYMENT_REVIEW after a host-wide suspension, with no confirmation mail or notice", async () => {
    await withDb(async (pool) => {
      const { publications, a } = await threeExperiences(pool);
      const start = await startCheckout(pool, a.slug);
      await publications.suspendProviderByOperations(OPS, PROVIDER, "UNDER_REVIEW");
      const result = await pay(pool, start, "host");
      assert.equal(result.booking.status, "PAYMENT_REVIEW");
      assert.equal(await bookingMessages(pool, "booking.confirmed"), 0);
      assert.equal(await bookingMessages(pool, "booking.payment_review_required"), 1);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM outbox_messages WHERE provider_id=$1 AND topic='host.notify.new_booking'", [PROVIDER])).rows[0].n), 0);
    });
  });

  it("goes to PAYMENT_REVIEW after a per-experience suspension, but not after the owner's own stop of bookings", async () => {
    await withDb(async (pool) => {
      const { owner, publications, a } = await threeExperiences(pool);
      const first = await startCheckout(pool, a.slug);
      const second = await startCheckout(pool, a.slug);
      // The owner stops bookings: the payment in progress is still taken.
      const state = (await publications.getState(owner, a.id))!;
      await publications.stopBooking(owner, a.id, state.version);
      assert.equal((await pay(pool, first, "owner-stop")).booking.status, "CONFIRMED");
      // Then operations suspends the experience: the other one is held for review.
      const stopped = (await publications.getState(owner, a.id))!;
      await publications.suspendByOperations(OPS, PROVIDER, a.id, "POLICY_REVIEW", stopped.version);
      assert.equal((await pay(pool, second, "product")).booking.status, "PAYMENT_REVIEW");
      assert.equal(await bookingMessages(pool, "booking.confirmed"), 1);
    });
  });
});

describe("a reserved reason code (#711)", { skip }, () => {
  it("is refused for a single experience: only the host-wide suspension may use PROVIDER_SUSPENDED", async () => {
    await withDb(async (pool) => {
      const { owner, publications, b } = await threeExperiences(pool);
      const state = (await publications.getState(owner, b.id))!;
      await assert.rejects(publications.suspendByOperations(OPS, PROVIDER, b.id, "PROVIDER_SUSPENDED", state.version), StoreValidationError);
      assert.equal((await stateRow(pool, b.id)).code, null);
    });
  });
});

describe("notices to the office (#711)", { skip }, () => {
  it("queues one notice for the first page and one for the first bookings, never again", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "notice-a");
      const second = (await pageReadyDraft(pool, owner, "notice-b")).draft;
      const page = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      assert.deepEqual((await notices(pool)).map((row) => row.kind), ["FIRST_PAGE_PUBLISHED"]);
      assert.equal((await notices(pool))[0]!.payload.experienceTitle, "Synthetic page walk");
      // Another page of the same host is not news.
      await publications.publishPage(owner, second.id, { expectedDraftVersion: second.version, expectedStateVersion: null, checks: CHECKS });
      assert.equal((await notices(pool)).length, 1);
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const input = { expectedDraftVersion: draft.version, expectedStateVersion: page.version, consentVersion: CONSENT, checks: CHECKS };
      const opened = await publications.openBooking(owner, draft.id, input);
      assert.deepEqual((await notices(pool)).map((row) => row.kind), ["FIRST_BOOKING_OPENED", "FIRST_PAGE_PUBLISHED"]);
      // Stop and open again, republish the page: nothing more is queued.
      const stopped = await publications.stopBooking(owner, draft.id, opened.version);
      await publications.openBooking(owner, draft.id, { ...input, expectedStateVersion: stopped.version });
      assert.equal((await notices(pool)).length, 2);
      // The mail job claims each once, and a reported SENT closes it.
      const outbox = new OfficeNotices(pool);
      const claimed = await outbox.claimNotices({ limit: 5, leaseSeconds: 60 });
      assert.deepEqual(claimed.map((n) => n.kind).sort(), ["FIRST_BOOKING_OPENED", "FIRST_PAGE_PUBLISHED"]);
      assert.equal(claimed[0]!.route, "OFFICE");
      assert.equal(await outbox.recordNotice(PROVIDER, "FIRST_PAGE_PUBLISHED", "SENT", claimed.find((n) => n.kind === "FIRST_PAGE_PUBLISHED")!.claimToken), "SENT");
      assert.equal(await outbox.recordNotice(PROVIDER, "FIRST_BOOKING_OPENED", "RETRY", claimed.find((n) => n.kind === "FIRST_BOOKING_OPENED")!.claimToken), "PENDING");
      assert.deepEqual(await outbox.claimNotices({ limit: 5, leaseSeconds: 60 }), [], "a retry waits for its backoff");
    });
  });

  it("queues both at once when the first publish also opens bookings, and nothing for a host that already published or sold", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "notice-both");
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      await publications.publish(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS });
      assert.deepEqual((await notices(pool)).map((row) => row.kind), ["FIRST_BOOKING_OPENED", "FIRST_PAGE_PUBLISHED"]);
    });
    // A host that was publishing and selling before this change: its state and a BACKFILL event exist, but no notice row.
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "notice-old");
      const second = (await pageReadyDraft(pool, owner, "notice-old-2")).draft;
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const opened = await publications.publish(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS });
      await pool.query("DELETE FROM experience_office_notices");
      await pool.query("ALTER TABLE experience_product_booking_events DISABLE TRIGGER experience_product_booking_events_no_update");
      await pool.query("UPDATE experience_product_booking_events SET reason='BACKFILL' WHERE provider_id=$1", [PROVIDER]);
      await pool.query("ALTER TABLE experience_product_booking_events ENABLE TRIGGER experience_product_booking_events_no_update");
      // Its next page and its restarted bookings add no notice.
      await publications.publishPage(owner, second.id, { expectedDraftVersion: second.version, expectedStateVersion: null, checks: CHECKS });
      const stopped = await publications.stopBooking(owner, draft.id, opened.version);
      await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: stopped.version, consentVersion: CONSENT, checks: CHECKS });
      assert.deepEqual(await notices(pool), []);
    });
  });
});

describe("the host list (#711)", { skip }, () => {
  it("shows route, owners, counts, first dates and the suspension, never a NIHO user ID", async () => {
    await withDb(async (pool) => {
      const { owner, publications, a } = await threeExperiences(pool);
      await pool.query("INSERT INTO experience_provider_public_profiles (provider_id,public_display_name,public_display_name_en,provider_kind,consent_version,consented_at,version,consent_source,consented_by_admin_niho_user_id) VALUES ($1,'合成の会','Synthetic Club','BUSINESS','v1',clock_timestamp(),1,'ADMIN','admin-synthetic')", [PROVIDER]);
      // A second provider, registered by its own owner and never published.
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-self')");
      const accounts = new HostAccounts(pool);
      const { hostAccountId } = await accounts.provisionHostAccount({ email: "self@example.test", nowUtc: new Date().toISOString() });
      await pool.query("INSERT INTO experience_provider_self_registrations (provider_id,host_account_id,host_terms_version,host_terms_accepted_at) VALUES ('provider-self',$1,'terms-v1',clock_timestamp())", [hostAccountId]);
      // "Public" is what the public site shows: the page the office suspended one by one (c) is not counted.
      const before = (await publications.listAdminHosts(OPS)).find((host) => host.providerId === PROVIDER)!;
      assert.equal(before.publicPages, 2, "a suspended page is not a public page");
      assert.equal(before.sellingPages, 1);
      await publications.suspendProviderByOperations(OPS, PROVIDER, "UNDER_REVIEW");
      const hosts = await publications.listAdminHosts(OPS);
      const main = hosts.find((host) => host.providerId === PROVIDER)!;
      // One host is read by its own ID (a host older than the newest 500 is still found); an unknown ID is null.
      assert.deepEqual(await publications.getAdminHost(OPS, PROVIDER), main);
      assert.equal(await publications.getAdminHost(OPS, "provider-unknown"), null);
      const self = hosts.find((host) => host.providerId === "provider-self")!;
      assert.equal(main.route, "OFFICE");
      assert.equal(main.publicDisplayName, "合成の会");
      assert.equal(main.consentSource, "ADMIN");
      assert.deepEqual(main.owners.map((o) => ({ id: o.hostAccountId, status: o.status, email: o.email })), [{ id: owner.nihoUserId, status: "ACTIVE", email: "page-booking@example.test" }]);
      assert.equal(main.publicPages, 0, "a suspended host has no public page, whatever its current versions");
      assert.equal(main.sellingPages, 0, "suspended: nothing is selling");
      assert.ok(main.firstPublishedAtUtc);
      assert.ok(main.firstBookingOpenedAtUtc);
      assert.ok(main.operationsSuspendedAtUtc);
      assert.equal(main.operationsSuspensionCode, "UNDER_REVIEW");
      assert.equal(self.route, "SELF");
      assert.equal(self.publicPages, 0);
      assert.equal(self.firstPublishedAtUtc, null);
      assert.equal(self.firstBookingOpenedAtUtc, null);
      assert.equal(self.operationsSuspendedAtUtc, null);
      assert.ok(!JSON.stringify(hosts).includes("niho-user"));
      void a;
    });
  });
});

describe("a worker whose lease ran out (#711)", { skip }, () => {
  it("cannot report over the worker that claimed after it", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft } = await pageReadyDraft(pool, owner, "lease");
      await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, checks: CHECKS });
      const outbox = new OfficeNotices(pool);
      const [first] = await outbox.claimNotices({ limit: 1, leaseSeconds: 30 });
      assert.ok(first);
      // A's lease runs out; B claims the same notice.
      await pool.query("UPDATE experience_office_notices SET lease_until = clock_timestamp() - interval '1 second'");
      const [second] = await outbox.claimNotices({ limit: 1, leaseSeconds: 30 });
      assert.ok(second);
      assert.notEqual(second.claimToken, first.claimToken);
      assert.equal(second.attempts, 2);
      // A's late report changes nothing (the notice is still B's, SENDING)...
      assert.equal(await outbox.recordNotice(PROVIDER, first.kind, "SENT", first.claimToken), "SENDING");
      assert.equal(await outbox.recordNotice(PROVIDER, first.kind, "FAILED", first.claimToken), "SENDING");
      // ...and B's result is the one that stays.
      assert.equal(await outbox.recordNotice(PROVIDER, second.kind, "SENT", second.claimToken), "SENT");
      assert.equal(await outbox.recordNotice(PROVIDER, first.kind, "FAILED", first.claimToken), "SENT");
    });
  });
});

describe("the office's suspension of a host account is recorded (#711)", { skip }, () => {
  it("records who suspended and reactivated, only when the account changed, append-only", async () => {
    await withDb(async (pool) => {
      const accounts = new HostAccounts(pool);
      const { hostAccountId } = await accounts.provisionHostAccount({ email: "audit@example.test", nowUtc: new Date().toISOString() });
      const at = () => new Date().toISOString();
      assert.equal(await accounts.suspendHostAccount({ hostAccountId, nowUtc: at(), actorId: "admin-a" }), "CHANGED");
      assert.equal(await accounts.suspendHostAccount({ hostAccountId, nowUtc: at(), actorId: "admin-b" }), "UNCHANGED");
      assert.equal(await accounts.reactivateHostAccount({ hostAccountId, nowUtc: at(), actorId: "admin-c" }), "CHANGED");
      assert.equal(await accounts.reactivateHostAccount({ hostAccountId, nowUtc: at(), actorId: "admin-d" }), "UNCHANGED");
      const events = (await pool.query("SELECT kind,actor_id FROM host_account_operation_events WHERE host_account_id=$1 ORDER BY id", [hostAccountId])).rows;
      assert.deepEqual(events, [{ kind: "SUSPENDED", actor_id: "admin-a" }, { kind: "REACTIVATED", actor_id: "admin-c" }]);
      await assert.rejects(accounts.suspendHostAccount({ hostAccountId, nowUtc: at(), actorId: "" }), StoreValidationError);
      await assert.rejects(pool.query("UPDATE host_account_operation_events SET actor_id='x'"), { code: "23514" });
      await assert.rejects(pool.query("DELETE FROM host_account_operation_events"), { code: "23514" });
    });
  });
});
