import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { ProviderAgentSales, type AgentSalesChoiceInput } from "../src/agent-sales.ts";
import { ExperienceConnectAccounts } from "../src/connect-accounts.ts";
import { ProviderDirectSellers, type IndependentSalesChoiceInput } from "../src/direct-sellers.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestBookingRepository, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ManagedExperienceSalesRepository } from "../src/managed-sales.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { ExperienceStore } from "../src/repository.ts";
import { salesKindOf } from "../src/sales-kind.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/*
 * #726 (host registration, stage 3c-2): the host whose seller is its own Stripe account chooses 独立 10% for a product (a product with no plan, or one
 * sold with 代理受領), opens bookings, and sells with the Direct charge path. Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-independent-sales";
const ACCOUNT = "acct_SyntheticIndep0001";
const PLATFORM = "acct_PlatformSynthetic1";
const PAYOUT_CONSENT = "payout-consent-synthetic-v1";
const CONSENT = "publication-independent-synthetic-v1";
const AGREEMENT = "independent-sales-synthetic-v1";
const AGENT_AGREEMENT = "agent-sales-synthetic-v1";
const NAME = "合成 販売者";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const emptyQuestions = hash("[]");
const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;
const day = (offset: number) => addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
const conflict = (message: string) => (error: unknown) => error instanceof StoreConflictError && error.message === message;

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "independent_sales", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

async function owner(pool: Pool, providerId = PROVIDER, email = "independent-owner@example.test"): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  await pool.query("INSERT INTO experience_provider_media_state (provider_id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email, nowUtc: new Date().toISOString() });
  assert.equal((await accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: new Date().toISOString() })).kind, "granted");
  await seedNotificationAddresses(pool, hostAccountId);
  await pool.query(
    `INSERT INTO experience_provider_public_profiles
       (provider_id,public_display_name,public_display_name_en,provider_kind,consent_version,consented_at,consent_source,consented_by_host_account_id,consented_by_admin_niho_user_id)
     VALUES ($1,'合成の主催者','Synthetic Host','PERSON','host-terms-synthetic-v1',clock_timestamp(),'OWNER',$2,NULL) ON CONFLICT DO NOTHING`,
    [providerId, hostAccountId]);
  return { providerId, nihoUserId: hostAccountId };
}

async function saveDisclosure(pool: Pool, actor: HostActor, name = NAME) {
  return new ProviderSellerDisclosureRepository(pool).save(actor, {
    commandId: randomUUID(), expectedVersion: null,
    disclosure: {
      method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: name, representativeName: null, publicAddress: "東京都 合成区 1-2-3",
      publicPhone: "+81 3 0000 0000", publicEmail: "seller@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true,
    },
  }, { agentSales: true });
}

/** The host's own Stripe account READY, and the seller profile and payout consent registered from it (3c-1). */
async function ownStripeSeller(pool: Pool, actor: HostActor) {
  const store = new ExperienceConnectAccounts(pool);
  const { account } = await store.reserve(actor, { creationParams: { country: "JP", metadata: { provider_id: actor.providerId, source: "niho-experience", purpose: "direct" } }, purpose: "DIRECT" });
  await store.recordAccountRef(actor, account.id, ACCOUNT);
  await store.saveSnapshot(account.id, {
    state: "READY", payoutReady: true, detailsSubmitted: true, payoutsEnabled: true, transfersActive: true, chargesEnabled: true,
    requirementsHash: hash("a"), readAtUtc: new Date().toISOString(),
  });
  if ((await pool.query("SELECT 1 FROM provider_seller_disclosures WHERE provider_id=$1", [actor.providerId])).rowCount === 0) await saveDisclosure(pool, actor);
  return new ProviderDirectSellers(pool).register(actor, { stripeConnectAccountRef: ACCOUNT, consentVersion: PAYOUT_CONSENT, nowUtc: new Date().toISOString() });
}

const choose = (pool: Pool, actor: HostActor, productId: string, over: Partial<IndependentSalesChoiceInput> = {}) =>
  new ProviderDirectSellers(pool).chooseIndependent(actor, productId, {
    commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGREEMENT,
    sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller", nowUtc: new Date().toISOString(), ...over,
  });

async function product(pool: Pool, actor: HostActor, slug = "indep-walk") {
  const publications = new ExperiencePublicationRepository(pool);
  const draft = await publications.createDraft(actor, { slug, publicTitle: "Synthetic independent walk", content: manuscript, currency: "JPY", unitAmount: 10_000 });
  const rule: ScheduleRule = {
    id: `${slug}-daily`, timeZone: "Asia/Tokyo", startsOn: day(-1), localStartTime: "10:00", durationMinutes: 90,
    capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await new ExperienceStore(pool).saveScheduleRule(actor, draft.id, rule, null, randomUUID());
  const photoId = randomUUID();
  await publications.addMedia(actor, draft.id, {
    id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: hash(slug),
    width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
  });
  await pool.query(
    `INSERT INTO experience_product_sale_terms (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,booking_questions,booking_questions_fingerprint,conditions_version)
     VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`, [actor.providerId, draft.id, emptyQuestions]);
  return { draft, rule };
}

/** The readiness snapshot a Direct sale is opened on (what the host screen's refresh writes). */
async function readiness(pool: Pool, actor: HostActor, sellerRef: string) {
  const consent = (await new ProviderPayoutAccountConsents(pool).current(actor))!;
  const observed = new Date(Date.now() - 1_000);
  await new ExperiencePublicationRepository(pool).refreshReadiness(actor, {
    accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, paymentReuseConsentVersion: consent.consentVersion,
    paymentReuseConsentedAtUtc: consent.consentedAtUtc, sellerDisplayReady: true, sellerNihoAccountRef: sellerRef,
    stripeConnectAccountRef: ACCOUNT, sellerDisplayName: NAME, requiredConsentVersion: CONSENT,
    observedAtUtc: observed.toISOString(), validUntilUtc: new Date(observed.getTime() + 5 * 60_000).toISOString(),
  });
}

async function openDirect(pool: Pool, actor: HostActor, productId: string) {
  const publications = new ExperiencePublicationRepository(pool);
  const current = await publications.getProduct(actor, productId);
  const state = await publications.getState(actor, productId);
  return publications.openBooking(actor, productId, { expectedDraftVersion: current.version, expectedStateVersion: state?.version ?? null, consentVersion: CONSENT, checks: CHECKS });
}

const blockersOf = (pool: Pool, actor: HostActor, productId: string) =>
  new ExperiencePublicationRepository(pool).getPublicationBlockers(actor, productId, CHECKS, CONSENT);
const reasons = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof ExperiencePublicationBlockedError ? [...error.blockers] : [String(error)]; }
  return [];
};
const request = (slug: string, offerId: string, email: string, revision: number, over: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput => ({
  slug, offerId, occurrenceDate: day(3), adultCount: 1, childCount: 0, expectedTotalYen: 10_000, bookingQuestionsFingerprint: emptyQuestions,
  answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT, conditionsConsentVersion: null, salesPlanRevision: revision,
  guestName: "Synthetic Guest", guestEmail: email, guestLanguage: "JA", clientRequestKey: randomUUID(), ...over,
});

describe("choosing 独立 10% for a product with no sales plan", { skip }, () => {
  it("writes revision 1, its state and the product's seller columns; the same command again is the same result", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      const registered = await ownStripeSeller(pool, actor);
      const before = await new ExperiencePublicationRepository(pool).getProduct(actor, draft.id);
      const input: IndependentSalesChoiceInput = {
        commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGREEMENT,
        sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller", nowUtc: new Date().toISOString(),
      };
      const sellers = new ProviderDirectSellers(pool);
      const chosen = await sellers.chooseIndependent(actor, draft.id, input);
      assert.equal(chosen.replayed, false);
      assert.equal(chosen.sellerRef, registered.sellerRef);
      const current = chosen.state.current;
      assert.deepEqual([current.revision, current.plan, current.chargeMode, current.sellerParty, current.feeBasisPoints, current.agreementVersion, current.agreementConfirmationMethod,
        current.sellerNihoAccountRef, current.stripeAccountRef, current.sellerDisplayName, current.agreementConfirmedBy, current.payoutDelayDays, current.receivingAgentName],
      [1, "INDEPENDENT_10", "CONNECT_DIRECT", "PROVIDER", 1000, AGREEMENT, "OWNER_WEB", registered.sellerRef, ACCOUNT, NAME, actor.nihoUserId, null, null]);
      assert.equal(current.sellerDisclosureUrl, input.sellerDisclosureUrl);
      assert.equal(chosen.state.phase, "ACTIVE");
      assert.equal(salesKindOf(current), "DIRECT");
      const after = await new ExperiencePublicationRepository(pool).getProduct(actor, draft.id);
      assert.deepEqual(after.seller, { sellerNihoAccountRef: registered.sellerRef, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: NAME });
      assert.equal(after.version, before.version + 1);
      assert.equal(chosen.productVersion, after.version);

      const again = await sellers.chooseIndependent(actor, draft.id, input);
      assert.equal(again.replayed, true);
      assert.equal(again.state.current.revision, 1);
      assert.equal((await pool.query("SELECT 1 FROM experience_product_sales_plan_versions WHERE product_id=$1", [draft.id])).rowCount, 1);
      // The command ID with other terms, and a second choice with a new command, are refused.
      await assert.rejects(() => sellers.chooseIndependent(actor, draft.id, { ...input, agreementVersion: "other" }), conflict("The command was already used."));
      await assert.rejects(() => choose(pool, actor, draft.id, { expectedStateVersion: 1 }), conflict("VERSION_CONFLICT"));
      await assert.rejects(() => choose(pool, actor, draft.id), conflict("VERSION_CONFLICT"));
    });
  });

  it("works for a product that has no seller yet, and refuses another seller's product", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      const { draft: other } = await product(pool, actor, "indep-other");
      const registered = await ownStripeSeller(pool, actor);
      await pool.query("UPDATE experience_products SET seller_niho_account_ref=NULL,stripe_connect_account_ref=NULL,seller_display_name=NULL WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]);
      assert.equal((await choose(pool, actor, draft.id)).sellerRef, registered.sellerRef);

      await pool.query("UPDATE experience_products SET seller_niho_account_ref=$3 WHERE provider_id=$1 AND id=$2", [PROVIDER, other.id, `sel_${"f".repeat(32)}`]);
      await assert.rejects(() => choose(pool, actor, other.id), conflict("SELLER_MISMATCH"));
    });
  });

  it("is refused for each missing piece, and writes nothing", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      // No seller profile; a legacy-style profile (no own Stripe account).
      await assert.rejects(() => choose(pool, actor, draft.id), conflict("DIRECT_SELLER_REQUIRED"));
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-x','X','seller-x','acct_SyntheticSeller001','X')`, [PROVIDER]);
      await assert.rejects(() => choose(pool, actor, draft.id), conflict("DIRECT_SELLER_REQUIRED"));
      await pool.query("DELETE FROM experience_host_seller_profiles WHERE provider_id=$1", [PROVIDER]);

      await ownStripeSeller(pool, actor);
      // Not an OWNER, not a host account, and a missing product.
      const editor = await new HostAccounts(pool).provisionHostAccount({ email: "independent-editor@example.test", nowUtc: new Date().toISOString() });
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'EDITOR',true)", [PROVIDER, editor.hostAccountId]);
      await assert.rejects(() => choose(pool, { providerId: PROVIDER, nihoUserId: editor.hostAccountId }, draft.id), StoreAccessDeniedError);
      await assert.rejects(() => choose(pool, { providerId: PROVIDER, nihoUserId: "niho-user-1" }, draft.id), StoreAccessDeniedError);
      await assert.rejects(() => choose(pool, actor, "no-such-product"), /not found/i);
      await assert.rejects(() => choose(pool, actor, draft.id, { commandId: "x" }), /commandId/);
      await assert.rejects(() => choose(pool, actor, draft.id, { sellerDisclosureUrl: "http://x" }), /sellerDisclosureUrl/);
      // The seller name differs from the public disclosure's.
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name='別名' WHERE provider_id=$1", [PROVIDER]);
      await assert.rejects(() => choose(pool, actor, draft.id), conflict("SELLER_DISCLOSURE_REQUIRED"));
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name=$2 WHERE provider_id=$1", [PROVIDER, NAME]);
      // The payout consent no longer counts.
      assert.equal((await new ProviderPayoutAccountConsents(pool).revoke(actor, { nowUtc: new Date().toISOString() })).outcome, "REVOKED");
      await assert.rejects(() => choose(pool, actor, draft.id), conflict("PAYOUT_CONSENT_REQUIRED"));
      assert.equal((await pool.query("SELECT 1 FROM experience_product_sales_plan_versions")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM experience_product_sales_plan_states")).rowCount, 0);
    });
  });

  it("is serialised: two commands for one product leave one revision", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      await ownStripeSeller(pool, actor);
      const results = await Promise.allSettled([choose(pool, actor, draft.id), choose(pool, actor, draft.id)]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      assert.equal((await pool.query("SELECT 1 FROM experience_product_sales_plan_versions")).rowCount, 1);
    });
  });
});

describe("the reasons a host with its own Stripe account cannot open bookings", { skip }, () => {
  it("SALES_PLAN_REQUIRED with no plan (and no fee settings reasons); none of the fee reasons once 独立 10% is chosen", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      const registered = await ownStripeSeller(pool, actor);
      const before = await blockersOf(pool, actor, draft.id);
      assert.ok(before.includes("SALES_PLAN_REQUIRED"), before.join());
      assert.ok(!before.includes("FEE_SETTINGS_REQUIRED") && !before.includes("SUPPORT_CONSENT_REQUIRED"), before.join());
      // The page needs no plan.
      assert.ok(!(await new ExperiencePublicationRepository(pool).getPublicationBlockers(actor, draft.id, CHECKS, null, "PAGE")).includes("SALES_PLAN_REQUIRED"));
      assert.ok((await reasons(openDirect(pool, actor, draft.id))).includes("SALES_PLAN_REQUIRED"));

      await choose(pool, actor, draft.id);
      const chosen = await blockersOf(pool, actor, draft.id);
      for (const reason of ["SALES_PLAN_REQUIRED", "FEE_SETTINGS_REQUIRED", "SUPPORT_CONSENT_REQUIRED", "SELLER_MISMATCH", "SELLER_DISCLOSURE_REQUIRED"]) assert.ok(!chosen.includes(reason as never), `${reason}: ${chosen.join()}`);
      // The readiness a Direct sale has is still asked for.
      assert.ok(chosen.includes("READINESS_MISSING"), chosen.join());
      await readiness(pool, actor, registered.sellerRef);
      assert.deepEqual(await blockersOf(pool, actor, draft.id), [], "with the readiness a Direct sale has, nothing else is missing");

      // The plan's seller and the public disclosure's name are checked.
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name='別名' WHERE provider_id=$1", [PROVIDER]);
      assert.ok((await blockersOf(pool, actor, draft.id)).includes("SELLER_DISCLOSURE_REQUIRED"));
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name=$2 WHERE provider_id=$1", [PROVIDER, NAME]);
      await pool.query("UPDATE experience_products SET seller_niho_account_ref=$3 WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id, `sel_${"e".repeat(32)}`]);
      assert.ok((await blockersOf(pool, actor, draft.id)).includes("SELLER_MISMATCH"));
    });
  });

  it("leaves the checks of a Direct host with no own-Stripe profile as they were (fee settings and support consent)", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,NULL,'X',$2,'acct_SyntheticOffice001',$3)`, [PROVIDER, `sel_${"a".repeat(32)}`, NAME]);
      await pool.query("UPDATE experience_products SET seller_niho_account_ref=$3,stripe_connect_account_ref='acct_SyntheticOffice001',seller_display_name=$4 WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id, `sel_${"a".repeat(32)}`, NAME]);
      const blockers = await blockersOf(pool, actor, draft.id);
      assert.ok(blockers.includes("FEE_SETTINGS_REQUIRED"), blockers.join());
      assert.ok(!blockers.includes("SALES_PLAN_REQUIRED"), blockers.join());
    });
  });
});

describe("selling with 独立 10%", { skip }, () => {
  it("opens bookings and a booking takes the Direct charge path", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft, rule } = await product(pool, actor);
      const registered = await ownStripeSeller(pool, actor);
      await choose(pool, actor, draft.id);
      await readiness(pool, actor, registered.sellerRef);
      await openDirect(pool, actor, draft.id);

      const guests = new GuestBookingRepository(pool);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);
      const started = await guests.startGuestBooking(request(draft.slug, rule.id, "independent-guest@example.test", 1));
      const seller = started.booking.sellerSnapshot;
      assert.deepEqual([seller.chargeMode, seller.salesPlan, seller.feeBasisPoints, seller.displayName, seller.stripeConnectAccountRef, seller.nihoAccountRef],
        ["CONNECT_DIRECT", "INDEPENDENT_10", 1000, NAME, ACCOUNT, registered.sellerRef]);
      assert.equal(salesKindOf(seller), "DIRECT");
      assert.deepEqual([started.booking.pricingSnapshot.platformFee?.basisPoints, started.booking.pricingSnapshot.platformFee?.amount], [1000, 1000]);
    });
  });
});

describe("switching from 代理受領 to 独立 10%", { skip }, () => {
  it("is allowed with bookings open: the open Checkout is expired, the paid booking keeps its snapshot, new bookings are Direct", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft, rule } = await product(pool, actor);
      await saveDisclosure(pool, actor);
      const agentChoice: AgentSalesChoiceInput = {
        commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGENT_AGREEMENT, accepted: true, platformAccountId: PLATFORM,
        receivingAgentName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller",
      };
      await new ProviderAgentSales(pool).choose(actor, draft.id, agentChoice);
      const publications = new ExperiencePublicationRepository(pool);
      const current = await publications.getProduct(actor, draft.id);
      await publications.openBooking(actor, draft.id, {
        expectedDraftVersion: current.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS,
        agentCheck: { agreementVersion: AGENT_AGREEMENT, accountCheck: { stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() } },
      });
      // The host registers its own Stripe account afterwards (3c-1): the agent product is not attached to it.
      const registered = await ownStripeSeller(pool, actor);
      const guests = new GuestBookingRepository(pool);
      const store = new ExperienceStore(pool);
      const paid = await guests.startGuestBooking({ ...request(draft.slug, rule.id, "agent-paid@example.test", 1), agentSalesEnabled: true });
      await guests.attachCheckoutSession(paid.publicBookingId, "cs_test_agent_paid_1");
      await store.confirmBookingPayment({ providerId: PROVIDER }, {
        publicBookingId: paid.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_AgentPaid00001",
        stripeEventId: "evt_AgentPaid00001", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      });
      const open = await guests.startGuestBooking({ ...request(draft.slug, rule.id, "agent-open@example.test", 1, { occurrenceDate: day(4) }), agentSalesEnabled: true });
      await guests.attachCheckoutSession(open.publicBookingId, "cs_test_agent_open_1");

      const managed = new ManagedExperienceSalesRepository(pool);
      const state = (await managed.get(PROVIDER, draft.id))!;
      assert.equal(salesKindOf({ chargeMode: state.current.chargeMode, salesPlan: state.current.plan, sellerParty: state.current.sellerParty, feeBasisPoints: state.current.feeBasisPoints }), "AGENT_15");
      const command = randomUUID();
      const begin = (commandId: string, allow = true) => managed.beginOwnerSwitch(actor, draft.id, {
        commandId, expectedVersion: state.version, plan: "INDEPENDENT_10", agreementVersion: AGREEMENT, agreementConfirmedAtUtc: new Date().toISOString(),
        sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller", stripeReady: true, ...(allow ? { allowAgentToIndependent: true as const } : {}),
      });
      // Without the 独立 10% route's permission (the sales-plan route's call) it is refused, though the seller is its own Stripe account.
      await assert.rejects(() => begin(randomUUID(), false), conflict("An agent-sales product cannot switch to a Direct charge."));
      assert.equal(await managed.hasOwnStripeSeller(PROVIDER), true);
      const begun = await begin(command);
      assert.equal(begun.state.phase, "EXPIRING_OLD_CHECKOUTS");
      assert.deepEqual(begun.openCheckouts.map((checkout) => checkout.checkoutSessionRef), ["cs_test_agent_open_1"]);
      assert.equal(begun.state.pending?.plan, "INDEPENDENT_10");
      assert.equal(begun.state.pending?.sellerNihoAccountRef, registered.sellerRef);
      // The same command again, mid-switch, returns the same open Checkout.
      assert.equal((await begin(command)).openCheckouts.length, 1);
      const reconciled = await managed.recordCheckoutOutcome(actor, draft.id, command, "cs_test_agent_open_1", "EXPIRED");
      const done = await managed.finalizeSwitch(actor, draft.id, command, reconciled.version);
      assert.deepEqual([done.phase, done.current.plan, done.current.chargeMode, done.current.revision, done.current.feeBasisPoints], ["ACTIVE", "INDEPENDENT_10", "CONNECT_DIRECT", 2, 1000]);
      const after = await publications.getProduct(actor, draft.id);
      assert.deepEqual(after.seller, { sellerNihoAccountRef: registered.sellerRef, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: NAME });

      // The paid booking keeps its agent-sales snapshot (3b-2 still sends its payout to the Express account); the next one is Direct.
      const kept = (await pool.query("SELECT seller_snapshot FROM bookings WHERE public_booking_id=$1::uuid", [paid.publicBookingId])).rows[0]!.seller_snapshot as Record<string, unknown>;
      assert.deepEqual([kept.chargeMode, kept.salesPlan, kept.sellerParty], ["PLATFORM", "SUPPORTED_15", "PROVIDER"]);
      assert.equal(salesKindOf(kept as never), "AGENT_15");
      await readiness(pool, actor, registered.sellerRef);
      assert.deepEqual(await blockersOf(pool, actor, draft.id), []);
      const next = await guests.startGuestBooking(request(draft.slug, rule.id, "indep-after@example.test", 2, { occurrenceDate: day(5) }));
      assert.deepEqual([next.booking.sellerSnapshot.chargeMode, next.booking.sellerSnapshot.salesPlan, next.booking.sellerSnapshot.feeBasisPoints], ["CONNECT_DIRECT", "INDEPENDENT_10", 1000]);
    });
  });

  it("is refused for a host with no own-Stripe profile (a legacy Direct profile)", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const { draft } = await product(pool, actor);
      await saveDisclosure(pool, actor);
      await new ProviderAgentSales(pool).choose(actor, draft.id, {
        commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGENT_AGREEMENT, accepted: true, platformAccountId: PLATFORM,
        receivingAgentName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller",
      });
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,NULL,'X',$2,'acct_SyntheticOffice001',$3)`, [PROVIDER, `sel_${"a".repeat(32)}`, NAME]);
      const managed = new ManagedExperienceSalesRepository(pool);
      const state = (await managed.get(PROVIDER, draft.id))!;
      await assert.rejects(() => managed.beginOwnerSwitch(actor, draft.id, {
        commandId: randomUUID(), expectedVersion: state.version, plan: "INDEPENDENT_10", agreementVersion: AGREEMENT, agreementConfirmedAtUtc: new Date().toISOString(),
        sellerDisclosureUrl: "https://travel.example.test/experiences/indep-walk/seller", stripeReady: true, allowAgentToIndependent: true,
      }), conflict("An agent-sales product cannot switch to a Direct charge."));
      assert.equal(await managed.hasOwnStripeSeller(PROVIDER), false);
    });
  });
});
