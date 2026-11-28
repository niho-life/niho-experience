import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { attachSellerToSellerlessProducts } from "../src/site-sale-registration.ts";
import { ProviderAgentSales, type AgentSalesChoiceInput } from "../src/agent-sales.ts";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestBookingRepository, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ManagedExperienceSalesRepository } from "../src/managed-sales.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { ExperienceStore } from "../src/repository.ts";
import { agentPlanSql, countedAgentConsentSql, salesKindOf } from "../src/sales-kind.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/*
 * #725 (host registration, stage 3b-1): the host with no seller profile sells with 代理受領: it chooses the plan, NIHO's platform account
 * takes the payment (the 20% sale's platform path), and the rest of the system treats the booking by its own snapshot. Real schema,
 * synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-agent-sales";
const PLATFORM = "acct_PlatformSynthetic1";
const CONSENT = "publication-agent-synthetic-v1";
const AGENT_AGREEMENT = "agent-sales-synthetic-v1";
const RECEIVER = "Synthetic NIHO Receiver KK";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const ADMIN = { nihoUserId: "admin-agent-synthetic" } as const;
const emptyQuestions = createHash("sha256").update("[]").digest("hex");
const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;

const day = (offset: number) => addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "agent_sales", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

/** A provider with an ACTIVE host account as its OWNER and a public profile, and no seller profile. */
async function agentOwner(pool: Pool, providerId = PROVIDER, email = "agent-owner@example.test"): Promise<HostActor> {
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

const NAME = "合成 販売者";
async function saveDisclosure(pool: Pool, owner: HostActor, name = NAME, expectedVersion: number | null = null) {
  return new ProviderSellerDisclosureRepository(pool).save(owner, {
    commandId: randomUUID(), expectedVersion,
    disclosure: {
      method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: name, representativeName: null, publicAddress: "東京都 合成区 1-2-3",
      publicPhone: "+81 3 0000 0000", publicEmail: "seller@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true,
    },
  }, { agentSales: true });
}

const choice = (over: Partial<AgentSalesChoiceInput> = {}): AgentSalesChoiceInput => ({
  commandId: randomUUID(), expectedStateVersion: null, agreementVersion: AGENT_AGREEMENT, accepted: true, platformAccountId: PLATFORM,
  receivingAgentName: RECEIVER, payoutDelayDays: 3, sellerDisclosureUrl: "https://travel.example.test/experiences/agent-walk/seller", ...over,
});

/** A draft with a schedule, a photo and sale terms, ready to choose a plan and open. */
async function product(pool: Pool, owner: HostActor, slug = "agent-walk") {
  const publications = new ExperiencePublicationRepository(pool);
  const draft = await publications.createDraft(owner, { slug, publicTitle: "Synthetic agent walk", content: manuscript, currency: "JPY", unitAmount: 10_000 });
  const rule: ScheduleRule = {
    id: `${slug}-daily`, timeZone: "Asia/Tokyo", startsOn: day(-1), localStartTime: "10:00", durationMinutes: 90,
    capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await new ExperienceStore(pool).saveScheduleRule(owner, draft.id, rule, null, randomUUID());
  const photoId = randomUUID();
  await publications.addMedia(owner, draft.id, {
    id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: createHash("sha256").update(slug).digest("hex"),
    width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
  });
  await pool.query(
    `INSERT INTO experience_product_sale_terms (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,booking_questions,booking_questions_fingerprint,conditions_version)
     VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`, [owner.providerId, draft.id, emptyQuestions]);
  return { draft, rule };
}

const fresh = () => ({ stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() });
async function open(pool: Pool, owner: HostActor, productId: string, agentCheck: { agreementVersion: string; accountCheck: { stripeConnectAccountRef: string; checkedAtUtc: string } | null } = { agreementVersion: AGENT_AGREEMENT, accountCheck: fresh() }) {
  const publications = new ExperiencePublicationRepository(pool);
  const current = await publications.getProduct(owner, productId);
  const state = await publications.getState(owner, productId);
  return publications.openBooking(owner, productId, {
    expectedDraftVersion: current.version, expectedStateVersion: state?.version ?? null, consentVersion: CONSENT, checks: CHECKS, agentCheck,
  });
}

const request = (slug: string, offerId: string, email: string, over: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput => ({
  slug, offerId, occurrenceDate: day(3), adultCount: 1, childCount: 0, expectedTotalYen: 10_000, bookingQuestionsFingerprint: emptyQuestions,
  answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT, conditionsConsentVersion: null, salesPlanRevision: 1,
  guestName: "Synthetic Guest", guestEmail: email, guestLanguage: "JA", clientRequestKey: randomUUID(), ...over,
});

const reasons = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof ExperiencePublicationBlockedError ? [...error.blockers] : [String(error)]; }
  return [];
};

describe("sales kind (sales-kind.ts)", () => {
  it("reads a snapshot into one kind, and refuses a platform charge that is neither", () => {
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "MANAGED_20", feeBasisPoints: 2000 }), "MANAGED_20", "a booking from before sellerParty");
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "MANAGED_20", sellerParty: "NIHO", feeBasisPoints: 2000 }), "MANAGED_20");
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "SUPPORTED_15", sellerParty: "PROVIDER", feeBasisPoints: 1500 }), "AGENT_15");
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "SUPPORTED_15", feeBasisPoints: 1500 }), null, "no sellerParty: not an agent sale");
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "SUPPORTED_15", sellerParty: "PROVIDER", feeBasisPoints: 1000 }), null);
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "INDEPENDENT_10", sellerParty: "PROVIDER", feeBasisPoints: 1000 }), null);
    assert.equal(salesKindOf({ chargeMode: "PLATFORM", salesPlan: "MANAGED_20", sellerParty: "PROVIDER", feeBasisPoints: 2000 }), null);
    assert.equal(salesKindOf({}), "DIRECT");
    assert.equal(salesKindOf({ chargeMode: "CONNECT_DIRECT", salesPlan: "SUPPORTED_15", feeBasisPoints: 1500 }), "DIRECT");
    assert.equal(salesKindOf(null), null);
    assert.match(agentPlanSql("plan"), /plan\.seller_party='PROVIDER'/);
    assert.match(countedAgentConsentSql("p.provider_id", "plan"), /revoked_at IS NULL/);
  });
});

describe("migration 0096: agent sales data", { skip }, () => {
  it("fills seller_party, allows only the agent combination on a platform SUPPORTED_15 revision, and keeps the others as they were", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const { draft } = await product(pool, owner);
      const insert = (values: Record<string, unknown>) => {
        const row = { provider_id: PROVIDER, product_id: draft.id, revision: 1, plan: "SUPPORTED_15", charge_mode: "CONNECT_DIRECT", provider_public_profile_version: 1,
          seller_display_name: "S", seller_disclosure_url: "https://example.test/s", seller_niho_account_ref: "seller-x", stripe_account_ref: "acct_SyntheticDirect1",
          fee_basis_points: 1500, agreement_version: "v1", agreement_confirmed_by: "someone", agreement_confirmation_method: "OWNER_WEB", agreement_confirmed_at: new Date().toISOString(), ...values };
        const keys = Object.keys(row);
        return pool.query(`INSERT INTO experience_product_sales_plan_versions (${keys.join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
      };
      // Direct rows (15% and 10%) and the 20% row keep their shapes; seller_party is computed.
      await insert({ revision: 1 });
      await insert({ revision: 2, plan: "INDEPENDENT_10", fee_basis_points: 1000 });
      await insert({ revision: 3, plan: "MANAGED_20", charge_mode: "PLATFORM", fee_basis_points: 2000, payment_due_days: 10, pilot_approved: true, activated_by_admin_niho_user_id: "admin" });
      assert.deepEqual((await pool.query("SELECT revision,seller_party,payout_delay_days,receiving_agent_name FROM experience_product_sales_plan_versions ORDER BY revision")).rows,
        [{ revision: "1", seller_party: "PROVIDER", payout_delay_days: null, receiving_agent_name: null },
          { revision: "2", seller_party: "PROVIDER", payout_delay_days: null, receiving_agent_name: null },
          { revision: "3", seller_party: "NIHO", payout_delay_days: null, receiving_agent_name: null }]);
      const agent = { plan: "SUPPORTED_15", charge_mode: "PLATFORM", seller_niho_account_ref: `agt_${"a".repeat(32)}`, stripe_account_ref: PLATFORM, payout_delay_days: 3, receiving_agent_name: RECEIVER };
      await assert.rejects(insert({ revision: 4, ...agent, payout_delay_days: null }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, payout_delay_days: 31 }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, receiving_agent_name: null }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, seller_niho_account_ref: "seller-x" }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, fee_basis_points: 1000 }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, plan: "INDEPENDENT_10", fee_basis_points: 1000 }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, pilot_approved: true }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, ...agent, agreement_confirmation_method: "WRITTEN" }), { code: "23514" });
      await assert.rejects(insert({ revision: 4, payout_delay_days: 3 }), { code: "23514" }, "a Direct row carries no payout delay");
      await assert.rejects(insert({ revision: 4, plan: "MANAGED_20", charge_mode: "PLATFORM", fee_basis_points: 2000, payment_due_days: 10, pilot_approved: true, activated_by_admin_niho_user_id: "admin", receiving_agent_name: "x" }), { code: "23514" });
      await insert({ revision: 4, ...agent });
      assert.equal((await pool.query("SELECT seller_party FROM experience_product_sales_plan_versions WHERE revision=4")).rows[0]?.seller_party, "PROVIDER");
      // The revision stays immutable, and an approval request is still only for MANAGED_20 (0072).
      await assert.rejects(pool.query("UPDATE experience_product_sales_plan_versions SET receiving_agent_name='Other' WHERE revision=4"), /immutable/);
      await assert.rejects(insert({ revision: 5, ...agent, acceptance_mode: "APPROVAL" }), { code: "23514" });
    });
  });

  it("keeps one seller reference per provider in the consent history, never deletes, and moves only the revoke columns", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const ref = `agt_${"b".repeat(32)}`;
      const insert = (sellerRef: string) => pool.query(
        "INSERT INTO provider_agent_sales_consents (id,provider_id,seller_ref,consent_version,consented_by_host_account_id,consented_at) VALUES ($1,$2,$3,'v1',$4,clock_timestamp())",
        [randomUUID(), PROVIDER, sellerRef, owner.nihoUserId]);
      await assert.rejects(insert("sel_bad"), { code: "23514" });
      await insert(ref);
      await assert.rejects(insert(ref), { code: "23505" }, "one active consent");
      await pool.query("UPDATE provider_agent_sales_consents SET revoked_at=clock_timestamp(),revoked_by_host_account_id=$1", [owner.nihoUserId]);
      await assert.rejects(insert(`agt_${"c".repeat(32)}`), /never changes/);
      await insert(ref);
      await assert.rejects(pool.query("DELETE FROM provider_agent_sales_consents"), /never deleted/);
      await assert.rejects(pool.query("UPDATE provider_agent_sales_consents SET consent_version='v2'"), /immutable/);
      await assert.rejects(pool.query("UPDATE provider_agent_sales_consents SET seller_ref=$1", [`agt_${"d".repeat(32)}`]), /immutable/);
      await assert.rejects(pool.query("UPDATE provider_agent_sales_consents SET revoked_at=NULL,revoked_by_host_account_id=NULL WHERE revoked_at IS NOT NULL"), /stays revoked/);
    });
  });
});

describe("choosing agent sales", { skip }, () => {
  it("writes the consent, revision, state and the product's seller together, once per command", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const { draft } = await product(pool, owner);
      const before = await new ExperiencePublicationRepository(pool).getProduct(owner, draft.id);
      assert.equal(before.seller, null);

      // No public seller disclosure yet.
      await assert.rejects(agent.choose(owner, draft.id, choice()), (error) => error instanceof StoreConflictError && error.message === "SELLER_DISCLOSURE_REQUIRED");
      await saveDisclosure(pool, owner);

      const input = choice();
      const chosen = await agent.choose(owner, draft.id, input);
      assert.equal(chosen.replayed, false);
      assert.match(chosen.sellerRef, /^agt_[0-9a-f]{32}$/);
      const { current } = chosen.state;
      assert.deepEqual([current.revision, current.plan, current.chargeMode, current.sellerParty, current.feeBasisPoints, current.payoutDelayDays, current.receivingAgentName],
        [1, "SUPPORTED_15", "PLATFORM", "PROVIDER", 1500, 3, RECEIVER]);
      assert.deepEqual([current.sellerDisplayName, current.stripeAccountRef, current.sellerNihoAccountRef, current.agreementVersion, current.agreementConfirmedBy, current.agreementConfirmationMethod],
        [NAME, PLATFORM, chosen.sellerRef, AGENT_AGREEMENT, owner.nihoUserId, "OWNER_WEB"]);
      assert.equal(chosen.state.version, 1);
      const after = await new ExperiencePublicationRepository(pool).getProduct(owner, draft.id);
      assert.deepEqual(after.seller, { sellerNihoAccountRef: chosen.sellerRef, stripeConnectAccountRef: PLATFORM, sellerDisplayName: NAME });
      assert.equal(after.version, before.version + 1);
      assert.equal(chosen.productVersion, after.version);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_agent_sales_consents WHERE provider_id=$1 AND revoked_at IS NULL", [PROVIDER])).rows[0]?.n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_host_seller_profiles")).rows[0]?.n, 0, "no seller profile is created");

      // The same command again is the same result, and writes nothing more.
      const again = await agent.choose(owner, draft.id, input);
      assert.equal(again.replayed, true);
      assert.deepEqual([again.state.current.revision, again.sellerRef, again.productVersion], [1, chosen.sellerRef, after.version]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_product_sales_plan_versions")).rows[0]?.n, 1);
      // The same command with another agreement is a conflict.
      await assert.rejects(agent.choose(owner, draft.id, { ...input, agreementVersion: "agent-sales-synthetic-v2" }), StoreConflictError);
      // A stale state version is refused.
      await assert.rejects(agent.choose(owner, draft.id, choice({ expectedStateVersion: null })), StoreConflictError);
    });
  });

  it("refuses a host with a seller profile, a product on another plan, a non-OWNER and a NIHO user", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const { draft } = await product(pool, owner);
      await saveDisclosure(pool, owner);

      const accounts = new HostAccounts(pool);
      const editor = await accounts.provisionHostAccount({ email: "agent-editor@example.test", nowUtc: new Date().toISOString() });
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'EDITOR',true)", [PROVIDER, editor.hostAccountId]);
      await assert.rejects(agent.choose({ providerId: PROVIDER, nihoUserId: editor.hostAccountId }, draft.id, choice()), StoreAccessDeniedError);
      await assert.rejects(agent.choose({ providerId: PROVIDER, nihoUserId: "niho-user-1" }, draft.id, choice()), StoreAccessDeniedError);
      await assert.rejects(agent.choose(owner, draft.id, choice({ accepted: false as never })));
      await assert.rejects(agent.choose(owner, draft.id, choice({ payoutDelayDays: 0 })));
      await assert.rejects(agent.choose(owner, draft.id, choice({ platformAccountId: "acct_x" })));

      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-x','X','seller-x','acct_SyntheticSeller001','X')`, [PROVIDER]);
      await assert.rejects(agent.choose(owner, draft.id, choice()), (error) => error instanceof StoreConflictError && error.message === "SELLER_EXISTS");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_agent_sales_consents")).rows[0]?.n, 0);
    });
  });

  it("chooses again only while bookings are stopped; the seller reference never changes, and a 20% or Direct product cannot move", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const { draft } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      const first = await agent.choose(owner, draft.id, choice());
      await open(pool, owner, draft.id);

      await assert.rejects(agent.choose(owner, draft.id, choice({ expectedStateVersion: first.state.version })), /Stop taking bookings/);
      const state = await publications.getState(owner, draft.id);
      await publications.stopBooking(owner, draft.id, state!.version);

      const second = await agent.choose(owner, draft.id, choice({ expectedStateVersion: first.state.version, agreementVersion: "agent-sales-synthetic-v2", payoutDelayDays: 5 }));
      assert.deepEqual([second.state.current.revision, second.state.current.agreementVersion, second.state.current.payoutDelayDays], [2, "agent-sales-synthetic-v2", 5]);
      assert.equal(second.sellerRef, first.sellerRef, "the same host keeps its agent seller reference");
      const consents = (await pool.query("SELECT consent_version,revoked_at IS NOT NULL AS revoked FROM provider_agent_sales_consents ORDER BY consented_at,id")).rows;
      assert.deepEqual(consents, [{ consent_version: AGENT_AGREEMENT, revoked: true }, { consent_version: "agent-sales-synthetic-v2", revoked: false }]);
      // The same version and OWNER again keeps the active consent row.
      await agent.choose(owner, draft.id, choice({ expectedStateVersion: second.state.version, agreementVersion: "agent-sales-synthetic-v2" }));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_agent_sales_consents")).rows[0]?.n, 2);

      // A product on a 20% plan cannot move to agent sales.
      const other = await product(pool, owner, "agent-other");
      await pool.query(
        `INSERT INTO experience_product_sales_plan_versions (provider_id,product_id,revision,plan,charge_mode,provider_public_profile_version,seller_display_name,seller_disclosure_url,
           seller_niho_account_ref,stripe_account_ref,fee_basis_points,agreement_version,agreement_confirmed_by,agreement_confirmation_method,agreement_confirmed_at,payment_due_days,pilot_approved,activated_by_admin_niho_user_id)
         VALUES ($1,$2,1,'MANAGED_20','PLATFORM',1,'N','https://example.test/n','niho-seller',$3,2000,'v','a','WRITTEN',clock_timestamp(),10,true,'admin')`, [PROVIDER, other.draft.id, PLATFORM]);
      await pool.query("INSERT INTO experience_product_sales_plan_states (provider_id,product_id,current_revision) VALUES ($1,$2,1)", [PROVIDER, other.draft.id]);
      await assert.rejects(agent.choose(owner, other.draft.id, choice({ expectedStateVersion: 1 })), /another plan/);

      // A product with a Direct plan switch is refused the other way: an agent product cannot begin the owner switch.
      await assert.rejects(new ManagedExperienceSalesRepository(pool).beginOwnerSwitch(owner, draft.id, {
        commandId: randomUUID(), expectedVersion: (await new ManagedExperienceSalesRepository(pool).get(PROVIDER, draft.id))!.version, plan: "INDEPENDENT_10",
        agreementVersion: "v", agreementConfirmedAtUtc: new Date().toISOString(), sellerDisclosureUrl: "https://example.test/s", stripeReady: true,
      }), /agent-sales product cannot switch/);
    });
  });
});

describe("opening bookings with agent sales", { skip }, () => {
  it("opens with no seller profile, payout account, fee settings or readiness, and names each missing piece", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const { draft } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      await agent.choose(owner, draft.id, choice());
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, CHECKS, CONSENT), [], "no FEE_SETTINGS_REQUIRED, SUPPORT_CONSENT_REQUIRED or readiness reason");

      // Each reason the agent branch has.
      assert.deepEqual(await reasons(open(pool, owner, draft.id, { agreementVersion: AGENT_AGREEMENT, accountCheck: null })), ["CONNECT_NOT_READY"]);
      assert.deepEqual(await reasons(open(pool, owner, draft.id, { agreementVersion: AGENT_AGREEMENT, accountCheck: { ...fresh(), checkedAtUtc: new Date(Date.now() - 6 * 60_000).toISOString() } })), ["CONNECT_NOT_READY"], "older than five minutes");
      assert.deepEqual(await reasons(open(pool, owner, draft.id, { agreementVersion: AGENT_AGREEMENT, accountCheck: { stripeConnectAccountRef: "acct_Other0000001", checkedAtUtc: new Date().toISOString() } })), ["CONNECT_NOT_READY"]);
      assert.deepEqual(await reasons(open(pool, owner, draft.id, { agreementVersion: "agent-sales-synthetic-v9", accountCheck: fresh() })), ["AGENT_CONSENT_REQUIRED"], "the consent is not at the configured version");

      await new ProviderAgentSales(pool).revokeConsent(owner);
      assert.deepEqual(await reasons(open(pool, owner, draft.id)), ["AGENT_CONSENT_REQUIRED"]);
      await agent.choose(owner, draft.id, choice({ expectedStateVersion: 1 }));

      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name='別の名前' WHERE provider_id=$1", [PROVIDER]);
      assert.deepEqual(await reasons(open(pool, owner, draft.id)), ["SELLER_DISCLOSURE_REQUIRED"]);
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name=$2 WHERE provider_id=$1", [PROVIDER, NAME]);
      await pool.query("UPDATE provider_seller_disclosures SET method='WITHDRAWN',representative_name=NULL,public_address=NULL,public_phone=NULL,public_email=NULL,withdrawn_at=clock_timestamp(),withdrawn_by_niho_user_id=$2 WHERE provider_id=$1", [PROVIDER, owner.nihoUserId]);
      assert.deepEqual(await reasons(open(pool, owner, draft.id)), ["SELLER_DISCLOSURE_REQUIRED"]);
      await saveDisclosure(pool, owner, NAME, 1);

      // The product's seller columns must still be the revision's.
      await pool.query("UPDATE experience_products SET seller_display_name='Other' WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id]);
      assert.deepEqual(await reasons(open(pool, owner, draft.id)), ["SELLER_MISMATCH"]);
      await pool.query("UPDATE experience_products SET seller_display_name=$3 WHERE provider_id=$1 AND id=$2", [PROVIDER, draft.id, NAME]);

      const state = await open(pool, owner, draft.id);
      assert.notEqual(state.bookingPublicationId, null);
      assert.equal((await pool.query("SELECT status FROM experience_products WHERE id=$1", [draft.id])).rows[0]?.status, "PUBLISHED");
      // saveDraft and saveSaleTerms (no account check) pass the same branch and keep the sale open.
      const product0 = await publications.getProduct(owner, draft.id);
      const saved = await publications.saveDraft(owner, { id: draft.id, slug: draft.slug, publicTitle: "Synthetic agent walk, revised", content: manuscript, currency: "JPY", unitAmount: 10_000, cancellationTermsRef: product0.cancellationTermsRef }, product0.version, state.version, CHECKS);
      assert.deepEqual([saved.publicationUpdated, saved.blockers], [true, []]);
    });
  });
});

describe("agent sales and the rest of the store", { skip }, () => {
  it("never opens bookings without the platform account check (fail closed), whichever route asks", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const { draft } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      await new ProviderAgentSales(pool).choose(owner, draft.id, choice());
      const current = await publications.getProduct(owner, draft.id);
      const input = { expectedDraftVersion: current.version, expectedStateVersion: null, consentVersion: CONSENT, checks: CHECKS };
      assert.deepEqual(await reasons(publications.openBooking(owner, draft.id, input)), ["CONNECT_NOT_READY"]);
      assert.deepEqual(await reasons(publications.publish(owner, draft.id, input)), ["CONNECT_NOT_READY"]);
      assert.equal((await publications.getState(owner, draft.id)), null);
      // The page alone and the blockers read need no check.
      assert.deepEqual(await publications.getPublicationBlockers(owner, draft.id, CHECKS, CONSENT), []);
      assert.notEqual((await publications.publish(owner, draft.id, { ...input, agentCheck: { agreementVersion: AGENT_AGREEMENT, accountCheck: fresh() } })).bookingPublicationId, null);
    });
  });

  it("does not give an agent-sales product a registered seller", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const { draft } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      const chosen = await new ProviderAgentSales(pool).choose(owner, draft.id, choice());
      const sellerless = await product(pool, owner, "agent-sellerless");
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,NULL,'X',$2,'acct_SyntheticSeller001','登録された販売者')`, [PROVIDER, `sel_${"c".repeat(32)}`]);
      const client = await pool.connect();
      try { assert.equal(await attachSellerToSellerlessProducts(client, PROVIDER), 1, "only the sellerless draft"); } finally { client.release(); }
      const rows = (await pool.query("SELECT id,seller_niho_account_ref AS ref,seller_display_name AS name FROM experience_products WHERE provider_id=$1", [PROVIDER])).rows;
      assert.deepEqual(rows.find((row) => row.id === draft.id), { id: draft.id, ref: chosen.sellerRef, name: NAME });
      assert.equal(rows.find((row) => row.id === sellerless.draft.id)?.name, "登録された販売者");
    });
  });

  it("holds the seller name while agent sales take bookings, with or without a seller profile", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const disclosures = new ProviderSellerDisclosureRepository(pool);
      const { draft } = await product(pool, owner);
      const saved = await saveDisclosure(pool, owner);
      await new ProviderAgentSales(pool).choose(owner, draft.id, choice());
      await open(pool, owner, draft.id);
      // A seller profile registered afterwards: the old (no-option) path is held by the same rule.
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,NULL,'X',$2,'acct_SyntheticSeller001',$3)`, [PROVIDER, `sel_${"c".repeat(32)}`, NAME]);
      const body = (name: string) => ({ method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: name, representativeName: null, publicAddress: "東京都", publicPhone: "+81 3 0000 0000", publicEmail: "seller@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true as const });
      await assert.rejects(disclosures.save(owner, { commandId: randomUUID(), expectedVersion: saved.version, disclosure: body("別名") }), StoreConflictError);
      await assert.rejects(disclosures.withdraw(owner, { commandId: randomUUID(), expectedVersion: saved.version }), StoreConflictError);
    });
  });
});

describe("a booking with agent sales", { skip }, () => {
  it("is sold with the provider as seller, carries its own flag, is a platform charge, and is not a 20% booking", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const guests = new GuestBookingRepository(pool);
      const store = new ExperienceStore(pool);
      const { draft, rule } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      const chosen = await agent.choose(owner, draft.id, choice());
      await open(pool, owner, draft.id);

      const terms = await guests.publicBookingTerms(draft.slug);
      assert.equal(terms?.sellerDisplayName, NAME);
      assert.equal(terms?.paymentCollectedBy, RECEIVER);
      assert.equal(terms?.sellerDisclosureUrl, undefined, "the seller information is the host's own page, not a stored URL");
      assert.equal(terms?.salesPlanRevision, 1);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);

      // Its flag is its own: closed unless true, and the 20% flag does not open it.
      await assert.rejects(guests.startGuestBooking({ ...request(draft.slug, rule.id, "no-flag@example.test") }), /not found/i);
      await assert.rejects(guests.startGuestBooking({ ...request(draft.slug, rule.id, "off@example.test"), agentSalesEnabled: false }), /not found/i);
      await assert.rejects(guests.startGuestBooking({ ...request(draft.slug, rule.id, "managed-on@example.test"), managedSalesEnabled: true }), /not found/i);

      const started = await guests.startGuestBooking({ ...request(draft.slug, rule.id, "agent-guest@example.test"), agentSalesEnabled: true, managedSalesEnabled: false });
      const seller = started.booking.sellerSnapshot;
      assert.deepEqual([seller.chargeMode, seller.salesPlan, seller.sellerParty, seller.feeBasisPoints, seller.payoutDelayDays, seller.receivingAgentName, seller.displayName, seller.stripeConnectAccountRef, seller.nihoAccountRef],
        ["PLATFORM", "SUPPORTED_15", "PROVIDER", 1500, 3, RECEIVER, NAME, PLATFORM, chosen.sellerRef]);
      assert.equal(seller.salesPlanRevision, 1);
      assert.equal(salesKindOf(seller), "AGENT_15");
      assert.deepEqual([started.booking.pricingSnapshot.platformFee?.basisPoints, started.booking.pricingSnapshot.platformFee?.amount], [1500, 1500]);
      // The same request again returns the same booking; with the flag off it is closed as well.
      const key = randomUUID();
      const held = await guests.startGuestBooking({ ...request(draft.slug, rule.id, "again@example.test", { clientRequestKey: key }), agentSalesEnabled: true });
      assert.equal((await guests.startGuestBooking({ ...request(draft.slug, rule.id, "again@example.test", { clientRequestKey: key }), agentSalesEnabled: true })).publicBookingId, held.publicBookingId);
      await assert.rejects(guests.startGuestBooking({ ...request(draft.slug, rule.id, "again@example.test", { clientRequestKey: key }), agentSalesEnabled: false }), /not found/i);

      // The 20% mail is not queued, at the start or at the payment.
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%'", [started.publicBookingId])).rows, []);
      await guests.attachCheckoutSession(started.publicBookingId, "cs_test_agent_paid_1");
      await store.confirmBookingPayment({ providerId: PROVIDER }, {
        publicBookingId: started.publicBookingId, connectedAccountId: PLATFORM, stripePaymentRef: "pi_AgentPaid00001",
        stripeEventId: "evt_AgentPaid00001", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(), amount: 10_000, currency: "JPY",
      });
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%'", [started.publicBookingId])).rows, []);

      // The office sees it with its kind; a refund is a platform charge's, with no application fee to reverse.
      const cancellations = new BookingCancellations(pool);
      const preview = await cancellations.previewSupportOperation(ADMIN, { action: "CANCEL", publicBookingId: started.publicBookingId, refund: { kind: "PARTIAL", amount: 2_000 } });
      const cancelled = await cancellations.cancelAsSupport(ADMIN, started.publicBookingId, {
        commandId: randomUUID(), expectedSnapshot: preview.expectedSnapshot, reason: "GUEST_REQUEST", refund: { kind: "PARTIAL", amount: 2_000 },
      });
      const refund = cancelled.refunds[0]!;
      assert.deepEqual([refund.chargeMode, refund.connectedAccountId, refund.refundApplicationFee], ["PLATFORM", PLATFORM, false]);
      assert.deepEqual((await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 AND topic LIKE 'managed.%'", [started.publicBookingId])).rows, []);
      const listed = (await cancellations.supportEnabledBookings({ publicBookingId: started.publicBookingId })).bookings[0];
      assert.equal(listed?.salesKind, "AGENT_15");
      assert.equal(listed?.supportEligible, true, "it is an office booking");
    });
  });

  it("stops selling when the consent is withdrawn or the public seller name differs", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const agent = new ProviderAgentSales(pool);
      const guests = new GuestBookingRepository(pool);
      const { draft, rule } = await product(pool, owner);
      await saveDisclosure(pool, owner);
      await agent.choose(owner, draft.id, choice());
      await open(pool, owner, draft.id);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);

      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name='別の名前' WHERE provider_id=$1", [PROVIDER]);
      assert.equal(await guests.publicBookingTerms(draft.slug), null);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), []);
      await pool.query("UPDATE provider_seller_disclosures SET seller_display_name=$2 WHERE provider_id=$1", [PROVIDER, NAME]);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), [draft.slug]);

      assert.equal(await agent.revokeConsent(owner), "REVOKED");
      assert.equal(await agent.revokeConsent(owner), "NONE");
      assert.equal(await guests.publicBookingTerms(draft.slug), null);
      assert.deepEqual(await guests.sellableSlugs([draft.slug]), []);
      await assert.rejects(guests.startGuestBooking({ ...request(draft.slug, rule.id, "revoked@example.test"), agentSalesEnabled: true }), /not found/i);
    });
  });
});

describe("the public seller disclosure of a host with no seller profile", { skip }, () => {
  it("is saved under the host's own name, is public with agent sales, and is fixed while bookings are open", async () => {
    await withDb(async (pool) => {
      const owner = await agentOwner(pool);
      const disclosures = new ProviderSellerDisclosureRepository(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const agent = new ProviderAgentSales(pool);

      // Without the agent-sales option the old rule stands: a seller profile is required.
      await assert.rejects(disclosures.getForOwner(owner), StoreAccessDeniedError);
      assert.deepEqual(await disclosures.getForOwner(owner, { agentSales: true }), { sellerDisplayName: "", disclosure: null, nameEditable: true });
      const stranger = await agentOwner(pool, "provider-agent-other", "agent-other@example.test");
      await assert.rejects(disclosures.getForOwner({ providerId: PROVIDER, nihoUserId: stranger.nihoUserId }, { agentSales: true }), StoreAccessDeniedError);
      await assert.rejects(disclosures.getForOwner({ providerId: PROVIDER, nihoUserId: "niho-user-1" }, { agentSales: true }), StoreAccessDeniedError);

      const saved = await saveDisclosure(pool, owner);
      assert.equal(saved.sellerDisplayName, NAME);
      const renamed = await saveDisclosure(pool, owner, "新しい名前", saved.version);
      assert.equal(renamed.sellerDisplayName, "新しい名前", "free to rename while nothing is sold");
      await saveDisclosure(pool, owner, NAME, renamed.version);

      const { draft } = await product(pool, owner);
      assert.equal(await publications.getPublicBySlug(draft.slug), null);
      await agent.choose(owner, draft.id, choice());
      assert.equal((await disclosures.getPublicBySlug(draft.slug)), null, "not public until bookings are open");
      await open(pool, owner, draft.id);
      const publicSeller = await disclosures.getPublicBySlug(draft.slug);
      assert.deepEqual([publicSeller?.method, publicSeller?.sellerDisplayName, publicSeller?.publicEmail], ["NATIVE", NAME, "seller@example.test"]);

      // While the agent product takes bookings: another name and a withdrawal are refused; other fields are free.
      const current = (await disclosures.getForOwner(owner, { agentSales: true }));
      assert.equal(current.nameEditable, false);
      await assert.rejects(saveDisclosure(pool, owner, "別名", current.disclosure!.version), StoreConflictError);
      await assert.rejects(disclosures.withdraw(owner, { commandId: randomUUID(), expectedVersion: current.disclosure!.version }, { agentSales: true }), StoreConflictError);
      const sameName = await disclosures.save(owner, {
        commandId: randomUUID(), expectedVersion: current.disclosure!.version,
        disclosure: { method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: NAME, representativeName: null, publicAddress: "東京都 合成区 9-9-9", publicPhone: "+81 3 1111 1111", publicEmail: "seller@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true },
      }, { agentSales: true });
      assert.equal(sameName.publicAddress, "東京都 合成区 9-9-9");

      // The consent's withdrawal removes the public page; so does stopping and then withdrawing.
      await agent.revokeConsent(owner);
      assert.equal(await disclosures.getPublicBySlug(draft.slug), null);
      const state = await publications.getState(owner, draft.id);
      await publications.stopBooking(owner, draft.id, state!.version);
      const stopped = await disclosures.withdraw(owner, { commandId: randomUUID(), expectedVersion: sameName.version }, { agentSales: true });
      assert.equal(stopped.method, "WITHDRAWN");
    });
  });
});
