import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreConflictError } from "../src/errors.ts";
import { ChannelRuntime } from "../src/channels.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
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
  const db = await createIsolatedDatabase(databaseUrl, "booking_channels", { max: 6 });
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


const command = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const admin = { nihoUserId: "admin-channels" };

/** An open booking with an external channel listing whose slots are desired OPEN, and a worker that can claim jobs. */
async function openWithChannel(pool: Pool) {
  const owner = await sellerlessOwner(pool);
  const { publications, draft: first } = await pageReadyDraft(pool, owner, "channel-walk");
  const pageState = await publications.publishPage(owner, first.id, { expectedDraftVersion: first.version, expectedStateVersion: null, checks: CHECKS });
  await becomeSeller(pool, owner, first.id);
  const draft = await publications.getProduct(owner, first.id);
  const opened = await publications.openBooking(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: pageState.version, consentVersion: CONSENT, checks: CHECKS });
  const runtime = new ChannelRuntime(pool, {
    now: () => new Date("2099-01-01T00:00:00.000Z"),
    supportedAdapters: { "Airbnb/browser-v1@1": { canObserve: true, canClose: true, canOpen: true } },
  });
  await runtime.createExternalAccount(admin, {
    id: "account-ch", providerId: PROVIDER, site: "Airbnb", externalAccountId: "external-ch", displayName: "Synthetic account",
    operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z", privateProfileRef: "profile-ref-synthetic",
  }, command("2"));
  await runtime.createListing(admin, {
    id: "listing-ch", providerId: PROVIDER, accountId: "account-ch", productId: draft.id, externalProductId: "external-walk",
    externalOptionId: "morning", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
    capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
  }, command("4"));
  const unverified = (await runtime.listListings(admin, PROVIDER))[0]!;
  await runtime.updateListing(admin, unverified.id, {
    externalProductId: unverified.externalProductId, ...(unverified.externalOptionId === undefined ? {} : { externalOptionId: unverified.externalOptionId }),
    adapter: unverified.adapter, adapterVersion: unverified.adapterVersion, connectionMode: unverified.connectionMode,
    capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
  }, unverified.mappingVersion, command("41"));
  const credential = await runtime.mintWorkerCredential(admin, "studio-ch", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, command("10"));
  const worker = await runtime.authenticateWorker(credential.bearerToken);
  await runtime.assignWorkerAccount(admin, credential.workerId, "account-ch", null, command("11"));
  const reconciled = await runtime.reconcileListing(admin, "listing-ch", command("8"));
  assert.ok(reconciled.jobs > 0);
  return { owner, publications, draft, opened, runtime, worker };
}

const count = async (pool: Pool, sql: string) => Number((await pool.query(sql)).rows[0]?.n);

/** After the stop: every slot is desired CLOSED, no OPEN job survives, and the close-only jobs claim and pass preflight. */
async function assertChannelsClosed(pool: Pool, runtime: ChannelRuntime, worker: Awaited<ReturnType<ChannelRuntime["authenticateWorker"]>>) {
  const consumed = await runtime.consumeCalendarOutbox();
  assert.ok(consumed.events >= 1, "the stop asked for a channel reconciliation");
  assert.equal(await count(pool, "SELECT count(*)::int AS n FROM channel_desired_states WHERE desired_state='OPEN'"), 0, "no slot stays desired OPEN");
  assert.ok(await count(pool, "SELECT count(*)::int AS n FROM channel_desired_states WHERE desired_state='CLOSED'") > 0);
  assert.equal(await count(pool, "SELECT count(*)::int AS n FROM channel_jobs WHERE action IN ('SET_OPEN','ENSURE_OCCURRENCE') AND status='QUEUED'"), 0, "no OPEN job is left queued");
  assert.ok(await count(pool, "SELECT count(*)::int AS n FROM channel_jobs WHERE action='SET_CLOSED' AND status='QUEUED'") > 0, "a CLOSE job exists");
  const claimed = await runtime.claim(worker);
  assert.ok(claimed, "the CLOSE job can be claimed although the product is no longer PUBLISHED");
  assert.equal((await pool.query("SELECT action FROM channel_jobs WHERE id=$1", [claimed.id])).rows[0]?.action, "SET_CLOSED");
  assert.equal((await runtime.preflight(worker, claimed.id, claimed.leaseToken)).desiredState, "CLOSED");
  // Nothing OPEN can ever be created or run for it, not even by another reconciliation.
  await runtime.reconcileListing(admin, "listing-ch", command("9"));
  assert.equal(await count(pool, "SELECT count(*)::int AS n FROM channel_jobs WHERE action IN ('SET_OPEN','ENSURE_OCCURRENCE') AND status='QUEUED'"), 0);
}

describe("stopping bookings closes the external channel slots (#705)", { skip }, () => {
  it("stopBooking: desired CLOSED, CLOSE jobs run for the DRAFT product, a leased OPEN is refused, and an OPEN is never created", async () => {
    await withDb(async (pool) => {
      const { publications, owner, draft, opened, runtime, worker } = await openWithChannel(pool);
      assert.equal(await count(pool, "SELECT count(*)::int AS n FROM channel_desired_states WHERE desired_state='OPEN'") > 0 ? 1 : 0, 1, "slots are desired OPEN while bookings are open");
      // Set aside the close jobs of slots that were never open (past the cutoff), so the lease below is an OPEN.
      await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE action='SET_CLOSED' AND status='QUEUED'");
      const leasedOpen = await runtime.claim(worker);
      assert.ok(leasedOpen);
      assert.equal((await pool.query("SELECT action FROM channel_jobs WHERE id=$1", [leasedOpen.id])).rows[0]?.action, "SET_OPEN");
      assert.equal((await runtime.preflight(worker, leasedOpen.id, leasedOpen.leaseToken)).desiredState, "OPEN");

      await publications.stopBooking(owner, draft.id, opened.version);
      assert.equal((await pool.query("SELECT status FROM experience_products WHERE id=$1", [draft.id])).rows[0]?.status, "DRAFT");
      // The OPEN job leased before the stop is refused at preflight.
      await assert.rejects(() => runtime.preflight(worker, leasedOpen.id, leasedOpen.leaseToken), StoreConflictError);
      await runtime.submitResult(worker, leasedOpen.id, { resultId: command("12"), leaseToken: leasedOpen.leaseToken, outcome: "SUPERSEDED", stopped: true, target: leasedOpen.target });
      await assertChannelsClosed(pool, runtime, worker);

      // Opening again re-opens the slots (the channel follows the product).
      const reopened = await publications.getState(owner, draft.id);
      const current = await publications.getProduct(owner, draft.id);
      await publications.openBooking(owner, draft.id, { expectedDraftVersion: current.version, expectedStateVersion: reopened!.version, consentVersion: CONSENT, checks: CHECKS });
      await runtime.consumeCalendarOutbox();
      assert.ok(await count(pool, "SELECT count(*)::int AS n FROM channel_desired_states WHERE desired_state='OPEN'") > 0);
    });
  });

  it("self-stop, operations suspension and consent withdrawal close the slots too", async () => {
    for (const how of ["self-stop", "suspension", "consent"] as const) {
      await withDb(async (pool) => {
        const { publications, owner, draft, opened, runtime, worker } = await openWithChannel(pool);
        if (how === "self-stop") await publications.stop(owner, draft.id, opened.version);
        else if (how === "suspension") await publications.suspendByOperations({ nihoUserId: "ops-synthetic" }, PROVIDER, draft.id, "POLICY_REVIEW", opened.version);
        else {
          const consents = new ProviderPayoutAccountConsents(pool);
          await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: "payout-account-consent-v1", nowUtc: new Date().toISOString() });
          assert.equal((await consents.revoke(owner, { nowUtc: new Date().toISOString() })).outcome, "REVOKED");
        }
        // The product stays PUBLISHED in these paths (the page and its bookings come back with the owner's restart),
        // but a listing that is not taking bookings is closed on the channels all the same.
        assert.equal((await pool.query("SELECT status FROM experience_products WHERE id=$1", [draft.id])).rows[0]?.status, "PUBLISHED", how);
        await assertChannelsClosed(pool, runtime, worker);
      });
    }
  });
});
