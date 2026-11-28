import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository, isSelling } from "../src/experience-publication.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ProviderHostBioRepository } from "../src/provider-host-bios.ts";
import { ExperienceStore } from "../src/repository.ts";
import { SiteSaleRegistration } from "../src/site-sale-registration.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/*
 * #705 (host registration, stage 1b): the public PAGE and the START OF BOOKINGS are two states.
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
const rule: ScheduleRule = {
  id: "page-booking-daily", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 90,
  capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "booking_publication", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

async function sellerlessOwner(pool: Pool): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [PROVIDER]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email: "page-booking@example.test", nowUtc: new Date().toISOString() });
  const granted = await accounts.grantProviderOwner({ providerId: PROVIDER, hostAccountId, nowUtc: new Date().toISOString() });
  assert.equal(granted.kind, "granted");
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

const stateOf = async (pool: Pool, productId: string) => (await pool.query(
  "SELECT current_publication_id::int AS page,booking_publication_id::int AS booking,version::int FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2",
  [PROVIDER, productId])).rows[0];
const statusOf = async (pool: Pool, productId: string) => String((await pool.query("SELECT status FROM experience_products WHERE provider_id=$1 AND id=$2", [PROVIDER, productId])).rows[0]?.status);
const eventsOf = async (pool: Pool, productId: string) => (await pool.query(
  "SELECT kind,reason FROM experience_product_booking_events WHERE provider_id=$1 AND product_id=$2 ORDER BY id", [PROVIDER, productId])).rows.map((row) => `${row.kind}:${row.reason}`);

async function assertSaleClosed(pool: Pool, slug: string, offerId: string): Promise<void> {
  const guests = new GuestBookingRepository(pool);
  assert.equal(await guests.publicBookingTerms(slug), null, "no booking terms");
  assert.deepEqual(await guests.sellableSlugs([slug]), [], "not a sellable slug");
  await assert.rejects(guests.startGuestBooking({
    slug, offerId, occurrenceDate: "2099-01-02", adultCount: 1, childCount: 0, expectedTotalYen: 4_000,
    bookingQuestionsFingerprint: "0".repeat(64), termsConsentVersion: "v1", currentConsentVersion: "v1",
    guestName: "Synthetic Guest", guestEmail: "guest@example.test", guestLanguage: "EN", clientRequestKey: randomUUID(),
  }), StoreNotFoundError, "checkout refuses");
}

describe("page and bookings are separate states (#705)", { skip }, () => {
  it("publishes a sellerless page that is public but never sellable", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft } = await pageReadyDraft(pool, owner, "page-only-walk");

      // The page blockers are empty; the booking blockers (SELLER_REQUIRED and the schedule) are not part of them.
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, CHECKS, null, "PAGE"), []);
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, CHECKS, CONSENT), ["SCHEDULE_REQUIRED", "SELLER_REQUIRED"]);
      // An unfinished page still names its reasons.
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, { manuscriptReady: false, photosReady: false }, null, "PAGE"),
        ["MANUSCRIPT_REQUIRED", "PHOTOS_REQUIRED"]);

      const state = await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, checks: CHECKS });
      assert.equal(state.bookingPublicationId, null);
      assert.ok(state.currentPublicationId !== null);
      assert.equal(await statusOf(pool, draft.id), "DRAFT", "a page-only product stays DRAFT, the gate every sale reader filters on");

      const page = await publications.getPublicBySlug(draft.slug);
      assert.ok(page, "the page is public");
      assert.equal(page.sellerDisplayName, null);
      assert.equal(page.bookingAvailable, false);
      assert.equal(page.unitAmount, 4_000);
      assert.deepEqual((await publications.listPublic()).map((item) => item.slug), [draft.slug]);
      assert.equal(await publications.claimsSlug(draft.slug), true, "a sellerless provider's slug is claimed");
      assert.ok((await publications.listClaimedSlugs()).includes(draft.slug));
      const photo = (await pool.query("SELECT asset_id::text FROM experience_product_publication_media WHERE publication_id=$1", [state.currentPublicationId])).rows[0];
      assert.ok(await publications.getPublicMediaAsset(String(photo.asset_id)), "the image relay serves a page's photo");

      // The host's bio shows on a page that has no seller (it used to need the seller profile).
      const bios = new ProviderHostBioRepository(pool);
      await bios.save(owner, { bioJa: "合成のホスト紹介です。", bioEn: null, expectedVersion: null, consentVersion: "host-bio-consent-v1" });
      assert.deepEqual(await bios.getPublicBySlug(draft.slug), { ja: "合成のホスト紹介です。", en: null });

      // The page row has no seller, no consent and no sale terms; no sale event exists.
      const row = (await pool.query("SELECT seller_niho_account_ref,consent_version,sale_terms_version::int AS v,sale_terms_snapshot FROM experience_product_publications WHERE id=$1", [state.currentPublicationId])).rows[0];
      assert.deepEqual(row, { seller_niho_account_ref: null, consent_version: null, v: 0, sale_terms_snapshot: {} });
      assert.deepEqual(await eventsOf(pool, draft.id), []);

      // Every money path stays closed to it: terms, sellable slugs, checkout, OTA/channel and article readers (status).
      await assertSaleClosed(pool, draft.slug, rule.id);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_products WHERE status='PUBLISHED' AND slug=$1", [draft.slug])).rows[0]?.n, 0);

      // A page is stopped like any page (self-stop) and comes back with publishPage.
      const stopped = await publications.stop(owner, draft.id, state.version);
      assert.equal(await publications.getPublicBySlug(draft.slug), null);
      const again = await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: stopped.version, checks: CHECKS });
      assert.equal(again.selfStoppedAtUtc, null);
      assert.ok(await publications.getPublicBySlug(draft.slug));
    });
  });

  it("opens bookings once the seller and readiness exist, and stopping them leaves the page public", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "open-then-stop");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      assert.ok(draft.seller, "the registered seller is attached to the draft");

      // The page alone still works without bookings; openBooking asks for the booking blockers too.
      const input = { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS };
      const opened = await publications.openBooking(owner, draft.id, input);
      assert.equal(opened.bookingPublicationId, opened.currentPublicationId, "page and sale version are one row while bookings are open");
      assert.equal(await statusOf(pool, draft.id), "PUBLISHED");
      assert.deepEqual(await eventsOf(pool, draft.id), ["OPENED:OWNER_OPENED"]);
      const sale = (await pool.query("SELECT seller_display_name,consent_version,sale_terms_version::int AS v FROM experience_product_publications WHERE id=$1", [opened.bookingPublicationId])).rows[0];
      assert.equal(sale.seller_display_name, "Synthetic Legal Seller KK");
      assert.ok(sale.v > 0);

      const guests = new GuestBookingRepository(pool);
      const bookable = await publications.getPublicBySlug(draft.slug);
      assert.equal(bookable?.bookingAvailable, true);
      assert.equal(bookable?.sellerDisplayName, "Synthetic Legal Seller KK");
      assert.ok(await guests.publicBookingTerms(draft.slug), "booking terms read the sale version");
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);

      // Stop bookings: the page stays on its page version, the sale closes, the product is DRAFT again, the log has both.
      const stopped = await publications.stopBooking(owner, draft.id, opened.version);
      assert.equal(stopped.bookingPublicationId, null);
      assert.equal(stopped.currentPublicationId, opened.currentPublicationId);
      assert.equal(await statusOf(pool, draft.id), "DRAFT");
      assert.deepEqual(await eventsOf(pool, draft.id), ["OPENED:OWNER_OPENED", "STOPPED:OWNER_STOPPED"]);
      const stillPublic = await publications.getPublicBySlug(draft.slug);
      assert.ok(stillPublic, "the page stays public");
      assert.equal(stillPublic.bookingAvailable, false);
      assert.equal(stillPublic.sellerDisplayName, null, "the seller is shown only while bookings are open, though the version carries one");
      await assertSaleClosed(pool, draft.slug, rule.id);
      // A stale version or a second stop is a conflict, and writes no second event.
      await assert.rejects(publications.stopBooking(owner, draft.id, opened.version), StoreConflictError);
      await assert.rejects(publications.stopBooking(owner, draft.id, stopped.version), StoreConflictError);
      assert.equal((await eventsOf(pool, draft.id)).length, 2);

      // Bookings open again on the current draft.
      const reopened = await publications.openBooking(owner, draft.id, { ...input, expectedStateVersion: stopped.version });
      assert.equal(reopened.bookingPublicationId, reopened.currentPublicationId);
      assert.equal(await statusOf(pool, draft.id), "PUBLISHED");
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);
    });
  });

  it("publishing the page again after a stop does not restart bookings; only openBooking does (#706)", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "page-after-stop");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const opened = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS });
      // 「ページを止める」 keeps the sale version behind, so the page's "publish again" must not pick it up.
      const stopped = await publications.stop(owner, draft.id, opened.version);
      assert.equal(isSelling(stopped), false);
      const republished = await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: stopped.version, checks: CHECKS });
      assert.equal(isSelling(republished), false);
      assert.equal(republished.bookingPublicationId, null, "the stopped sale version is dropped, not resumed");
      assert.equal(republished.selfStoppedAtUtc, null, "the page is public again");
      assert.equal(await statusOf(pool, draft.id), "DRAFT");
      const page = await publications.getPublicBySlug(draft.slug);
      assert.ok(page, "the page is public");
      assert.equal(page.bookingAvailable, false);
      await assertSaleClosed(pool, draft.slug, rule.id);
      // Bookings start again only when the owner starts them (with the consent that goes with it).
      const reopened = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: republished.version, consentVersion: CONSENT, checks: CHECKS });
      assert.equal(isSelling(reopened), true);
      assert.deepEqual(await eventsOf(pool, draft.id), ["OPENED:OWNER_OPENED", "STOPPED:OWNER_SELF_STOPPED", "OPENED:OWNER_OPENED"]);
    });
  });

  it("moves page and sale version together while bookings are open, or refuses with the booking blockers", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "republish-open");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const opened = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS });

      // An edit while bookings are open republishes the page AND the sale version, so the page is sold as shown.
      const saved = await publications.saveDraft(owner, {
        id: draft.id, slug: draft.slug, publicTitle: "Synthetic page walk, revised", content: manuscript,
        currency: "JPY", unitAmount: 4_000, cancellationTermsRef: draft.cancellationTermsRef,
      }, draft.version, opened.version, CHECKS);
      assert.equal(saved.publicationUpdated, true);
      const moved = await stateOf(pool, draft.id);
      assert.notEqual(moved.page, opened.currentPublicationId);
      assert.equal(moved.booking, moved.page);
      assert.equal((await new GuestBookingRepository(pool).publicBookingTerms(draft.slug))?.title, "Synthetic page walk, revised");
      assert.deepEqual(await eventsOf(pool, draft.id), ["OPENED:OWNER_OPENED", "OPENED:OWNER_REPUBLISHED"]);

      // publishPage while bookings are open needs the booking blockers too: an expired readiness refuses it.
      await pool.query("UPDATE provider_publication_readiness SET observed_at=clock_timestamp()-interval '20 minutes',valid_until=clock_timestamp()-interval '15 minutes' WHERE provider_id=$1", [PROVIDER]);
      const now = await publications.getProduct(owner, draft.id);
      await assert.rejects(
        publications.publishPage(owner, draft.id, { expectedDraftVersion: now.version, expectedStateVersion: moved.version, checks: CHECKS }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes("READINESS_EXPIRED"),
      );
      // The host can stop bookings first, then publish the page alone.
      const stopped = await publications.stopBooking(owner, draft.id, moved.version);
      const pageOnly = await publications.publishPage(owner, draft.id, { expectedDraftVersion: now.version, expectedStateVersion: stopped.version, checks: CHECKS });
      assert.equal(pageOnly.bookingPublicationId, null);
      assert.ok(await publications.getPublicBySlug(draft.slug));
      assert.equal(await statusOf(pool, draft.id), "DRAFT");
    });
  });

  it("keeps status PUBLISHED equal to 'bookings open' for every product with a state, and refuses wrong shapes in the database", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "shapes");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      const equivalent = async () => (await pool.query(
        `SELECT count(*)::int AS n FROM experience_products p JOIN experience_product_publication_states s ON s.provider_id=p.provider_id AND s.product_id=p.id
          WHERE (p.status='PUBLISHED') <> (s.booking_publication_id IS NOT NULL)`)).rows[0]?.n;
      assert.equal(await equivalent(), 0);
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const opened = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS });
      assert.equal(await equivalent(), 0);
      await publications.stopBooking(owner, draft.id, opened.version);
      assert.equal(await equivalent(), 0);

      // A booking version must be the page version and must be a sale version (seller + terms).
      const saleId = (await stateOf(pool, draft.id)).page;
      const pageRow = (await pool.query("SELECT id::int FROM experience_product_publications WHERE provider_id=$1 AND product_id=$2 AND seller_niho_account_ref IS NULL", [PROVIDER, draft.id])).rows[0]?.id;
      const setBooking = (id: number) => pool.query("UPDATE experience_product_publication_states SET booking_publication_id=$3 WHERE provider_id=$1 AND product_id=$2", [PROVIDER, draft.id, id]);
      await assert.rejects(setBooking(pageRow), { code: "23514" }, "a booking version that is not the page version");
      await pool.query("UPDATE experience_product_publication_states SET current_publication_id=$3 WHERE provider_id=$1 AND product_id=$2", [PROVIDER, draft.id, pageRow]);
      await assert.rejects(setBooking(pageRow), { code: "23514" }, "a page version (no seller, no terms) can never be a booking version");
      await assert.rejects(setBooking(saleId), { code: "23514" }, "the booking version must equal the page version");
      await pool.query("UPDATE experience_product_publication_states SET current_publication_id=$3 WHERE provider_id=$1 AND product_id=$2", [PROVIDER, draft.id, saleId]);
      // Even a valid booking version cannot be set under a DRAFT product: the status/booking constraint trigger refuses at commit.
      await assert.rejects(setBooking(saleId), { code: "23514" });

      // Publication rows: the seller group is all-or-none, a page row has no terms, a new sale row has terms.
      const insert = (columns: string, values: string) => pool.query(
        `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,published_by_niho_user_id,${columns})
         VALUES ($1,$2,99,'z','z','{}','JPY',1000,'t',$3,${values})`, [PROVIDER, draft.id, owner.nihoUserId]);
      await assert.rejects(insert("seller_niho_account_ref", "'sel_only'"), { code: "23514" });
      await assert.rejects(insert("sale_terms_version", "3"), { code: "23514" });
      await assert.rejects(insert("seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,sale_terms_version",
        "'s','a','n','c',0"), { code: "23514" });
      await assert.rejects(pool.query("UPDATE experience_product_publications SET public_title='x' WHERE id=$1", [pageRow]), { code: "23514" });
      // The event log is append-only.
      await assert.rejects(pool.query("UPDATE experience_product_booking_events SET reason='X' WHERE provider_id=$1", [PROVIDER]), { code: "23514" });
      await assert.rejects(pool.query("DELETE FROM experience_product_booking_events WHERE provider_id=$1", [PROVIDER]), { code: "23514" });
    });
  });

  it("records every transition that stops or (re)starts selling, even a re-opening of the same sale version", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "ledger");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const input = (version: number) => ({ expectedDraftVersion: draft.version, expectedStateVersion: version, consentVersion: CONSENT, checks: CHECKS });
      const version = async () => (await publications.getState(owner, draft.id))!.version;
      await publications.openBooking(owner, draft.id, input(pageState.version));
      // The same sale version again (nothing changed): still an OPENED row.
      await publications.openBooking(owner, draft.id, input(await version()));
      // Self-stop and the restart that follows.
      await publications.stop(owner, draft.id, await version());
      assert.equal(isSelling(await publications.getState(owner, draft.id)), false);
      await publications.openBooking(owner, draft.id, input(await version()));
      assert.equal(isSelling(await publications.getState(owner, draft.id)), true);
      // Operations suspension, its lifting (selling stays closed until the owner restarts) and the restart.
      await publications.suspendByOperations({ nihoUserId: "ops-synthetic" }, PROVIDER, draft.id, "POLICY_REVIEW", await version());
      await publications.clearOperationsSuspension({ nihoUserId: "ops-synthetic" }, PROVIDER, draft.id, await version());
      assert.equal(isSelling(await publications.getState(owner, draft.id)), false, "owner_resume_required keeps it closed");
      await publications.openBooking(owner, draft.id, input(await version()));
      // Closing what is already closed writes no second STOPPED: a suspension of a self-stopped listing is not a new stop.
      await publications.stop(owner, draft.id, await version());
      await publications.suspendByOperations({ nihoUserId: "ops-synthetic" }, PROVIDER, draft.id, "POLICY_REVIEW", await version());
      await publications.clearOperationsSuspension({ nihoUserId: "ops-synthetic" }, PROVIDER, draft.id, await version());
      await publications.openBooking(owner, draft.id, input(await version()));
      // Stopping bookings of a listing a self-stop already closed writes no second STOPPED, then it opens again.
      await publications.stop(owner, draft.id, await version());
      await publications.stopBooking(owner, draft.id, await version());
      await publications.openBooking(owner, draft.id, input(await version()));
      // Consent withdrawal.
      const consents = new ProviderPayoutAccountConsents(pool);
      await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: "payout-account-consent-v1", nowUtc: new Date().toISOString() });
      await consents.revoke(owner, { nowUtc: new Date().toISOString() });
      assert.deepEqual(await eventsOf(pool, draft.id), [
        "OPENED:OWNER_OPENED", "OPENED:OWNER_REPUBLISHED",
        "STOPPED:OWNER_SELF_STOPPED", "OPENED:OWNER_RESUMED",
        "STOPPED:OPERATIONS_SUSPENDED", "OPENED:OWNER_RESUMED",
        "STOPPED:OWNER_SELF_STOPPED", "OPENED:OWNER_RESUMED",
        "STOPPED:OWNER_SELF_STOPPED", "OPENED:OWNER_RESUMED",
        "STOPPED:CONSENT_REVOKED",
      ]);
    });
  });

  it("keeps the status writers from breaking 'status PUBLISHED <=> bookings open', and says 'taking bookings' only when it is", async () => {
    await withDb(async (pool) => {
      const owner = await sellerlessOwner(pool);
      const { publications, draft: first } = await pageReadyDraft(pool, owner, "writers");
      const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
      await becomeSeller(pool, owner, first.id);
      const draft = await publications.getProduct(owner, first.id);
      const status = (value: string) => ({
        id: draft.id, slug: draft.slug, status: value as "DRAFT", publicTitle: draft.publicTitle, content: draft.content, currency: draft.currency,
        unitAmount: draft.unitAmount, cancellationTermsRef: draft.cancellationTermsRef,
        sellerNihoAccountRef: draft.seller!.sellerNihoAccountRef, stripeConnectAccountRef: draft.seller!.stripeConnectAccountRef,
        sellerDisplayName: draft.seller!.sellerDisplayName,
      });
      const store = new ExperienceStore(pool);
      // A page-only product cannot be written PUBLISHED, by the store or by SQL.
      await assert.rejects(store.updateProduct(owner, status("PUBLISHED"), draft.version), StoreConflictError);
      await assert.rejects(pool.query("UPDATE experience_products SET status='PUBLISHED' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]), { code: "23514" });
      const open = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS });
      // An open product cannot be written DRAFT, nor its booking version dropped under a PUBLISHED status.
      const current = await publications.getProduct(owner, draft.id);
      await assert.rejects(store.updateProduct(owner, status("DRAFT"), current.version), StoreConflictError);
      await assert.rejects(pool.query("UPDATE experience_products SET status='DRAFT' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]), { code: "23514" });
      await assert.rejects(pool.query("UPDATE experience_product_publication_states SET booking_publication_id=NULL WHERE provider_id=$1 AND product_id=$2", [PROVIDER, draft.id]), { code: "23514" });
      // Both together in one transaction are fine (that is what stopBooking does); archiving is free.
      assert.equal(isSelling(open), true);
      await pool.query("UPDATE experience_products SET status='ARCHIVED' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]);
      await pool.query("UPDATE experience_products SET status='PUBLISHED' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]);
      // isSelling: a booking version alone is not enough.
      for (const change of [{ selfStoppedAtUtc: "2026-11-28T00:00:00.000Z" }, { operationsSuspendedAtUtc: "2026-11-28T00:00:00.000Z" }, { ownerResumeRequired: true }, { bookingPublicationId: null }]) {
        assert.equal(isSelling({ ...open, ...change }), false, JSON.stringify(change));
      }
      assert.equal(isSelling(null), false);
      // The public flag follows: not public at all while stopped; public with bookingAvailable=true only while selling.
      assert.equal((await publications.getPublicBySlug(draft.slug))?.bookingAvailable, true);
      const stopped = await publications.stop(owner, draft.id, open.version);
      assert.equal(await publications.getPublicBySlug(draft.slug), null);
      assert.equal(isSelling(stopped), false);
    });
  });
});
