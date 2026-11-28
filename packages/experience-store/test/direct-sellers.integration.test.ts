import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import { ProviderAgentSales, type AgentSalesChoiceInput } from "../src/agent-sales.ts";
import { retireConnectAccount } from "../src/connect-account-retirement.ts";
import { ExperienceConnectAccounts } from "../src/connect-accounts.ts";
import { ProviderDirectSellers } from "../src/direct-sellers.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { ExperienceStore } from "../src/repository.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/*
 * #726 (host registration, stage 3c-1): the host's own Stripe account (a DIRECT connect-account row) and the seller profile the runtime
 * creates from it (migrations 0098 and 0099). Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-direct-seller";
const ACCOUNT = "acct_SyntheticDirect0001";
const PLATFORM = "acct_PlatformSynthetic1";
const CONSENT = "payout-consent-synthetic-v1";
const NAME = "合成 販売者";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const params = (purpose: string) => ({ country: "JP", metadata: { provider_id: PROVIDER, source: "niho-experience", purpose } });
const emptyQuestions = hash("[]");
const day = (offset: number) => addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);

async function withDb(run: (pool: Pool, db: Awaited<ReturnType<typeof createIsolatedDatabase>>) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "direct_sellers", { max: 6 });
  try { await run(db.pool, db); } finally { await db.dispose(); }
}

/** A provider with an ACTIVE host account as its OWNER and a public profile, and no seller profile. */
async function owner(pool: Pool, providerId = PROVIDER, email = "direct-owner@example.test"): Promise<HostActor> {
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

const snapshot = (over: Record<string, unknown> = {}) => ({
  state: "READY" as const, payoutReady: true, detailsSubmitted: true, payoutsEnabled: true, transfersActive: true, chargesEnabled: true,
  requirementsHash: hash("a"), readAtUtc: new Date().toISOString(), ...over,
});

/** A DIRECT row with its Stripe account recorded and (by default) a READY snapshot just read. */
async function directAccount(pool: Pool, actor: HostActor, over: Record<string, unknown> | null = {}, ref = ACCOUNT) {
  const store = new ExperienceConnectAccounts(pool);
  const { account } = await store.reserve(actor, { creationParams: params("direct"), purpose: "DIRECT" });
  await store.recordAccountRef(actor, account.id, ref);
  if (over !== null) await store.saveSnapshot(account.id, snapshot(over));
  return account;
}

const register = (pool: Pool, actor: HostActor, over: Record<string, unknown> = {}) =>
  new ProviderDirectSellers(pool).register(actor, { stripeConnectAccountRef: ACCOUNT, consentVersion: CONSENT, nowUtc: new Date().toISOString(), ...over } as never);
const conflict = (message: string) => (error: unknown) => error instanceof StoreConflictError && error.message === message;

describe("migrations 0098 and 0099", { skip }, () => {
  it("allows a DIRECT purpose and keeps the charges flag", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const payout = await store.reserve(actor, { creationParams: params("payout") });
      const direct = await store.reserve(actor, { creationParams: params("direct"), purpose: "DIRECT" });
      assert.notEqual(payout.account.id, direct.account.id);
      assert.deepEqual([payout.account.purpose, direct.account.purpose], ["PAYOUT", "DIRECT"]);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET purpose='OTHER' WHERE id=$1", [payout.account.id]), { code: "23514" });
      await store.recordAccountRef(actor, direct.account.id, ACCOUNT);
      await store.saveSnapshot(direct.account.id, snapshot());
      assert.equal((await store.currentDirect(PROVIDER))?.snapshot?.chargesEnabled, true);
      assert.equal(await store.currentPayout(PROVIDER).then((row) => row?.snapshot ?? null), null);
      // One Stripe account is one row, whichever the purpose.
      await assert.rejects(() => store.recordAccountRef(actor, payout.account.id, ACCOUNT), StoreConflictError);
    });
  });

  it("keeps the seller profile's account columns consistent", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const account = await directAccount(pool, actor);
      const insert = (columns: string, values: unknown[]) => pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name${columns})
         VALUES ($1,$2,'X',$3,$4,'X'${columns ? ",$5,$6" : ""})`, values);
      const sel = `sel_${"a".repeat(32)}`;
      // One without the other; a legacy key; a NIHO-shaped reference; another provider's or another Stripe account's row: all refused.
      await assert.rejects(() => pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id)
         VALUES ($1,NULL,'X',$2,$3,'X',$4::uuid)`, [PROVIDER, sel, ACCOUNT, account.id]), { code: "23514" });
      await assert.rejects(() => insert(",connect_account_id,connect_account_purpose", [PROVIDER, "legacy-x", sel, ACCOUNT, account.id, "DIRECT"]), { code: "23514" });
      await assert.rejects(() => insert(",connect_account_id,connect_account_purpose", [PROVIDER, null, "seller-x", ACCOUNT, account.id, "DIRECT"]), { code: "23514" });
      await assert.rejects(() => insert(",connect_account_id,connect_account_purpose", [PROVIDER, null, sel, "acct_SyntheticOther0002", account.id, "DIRECT"]), { code: "23503" });
      await assert.rejects(() => insert(",connect_account_id,connect_account_purpose", [PROVIDER, null, sel, ACCOUNT, account.id, "PAYOUT"]), { code: "23514" });
      await insert(",connect_account_id,connect_account_purpose", [PROVIDER, null, sel, ACCOUNT, account.id, "DIRECT"]);
      await assert.rejects(() => pool.query("DELETE FROM experience_connect_accounts WHERE id=$1", [account.id]), /never deleted/);
    });
  });
});

describe("reserving a row by purpose", { skip }, () => {
  it("is one per purpose; the loser of two requests reads the winner's", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const [a, b] = await Promise.all([
        store.reserve(actor, { creationParams: { ...params("direct"), n: 1 }, purpose: "DIRECT" }),
        store.reserve(actor, { creationParams: { ...params("direct"), n: 2 }, purpose: "DIRECT" }),
      ]);
      assert.equal(a.account.id, b.account.id);
      assert.deepEqual([a.created, b.created].sort(), [false, true]);
      const payout = await store.reserve(actor, { creationParams: params("payout") });
      assert.equal(payout.created, true, "the payout account is a row of its own");
      assert.equal((await store.currentDirect(PROVIDER))?.account.id, a.account.id);
      assert.equal((await store.currentPayout(PROVIDER))?.account.id, payout.account.id);
      await assert.rejects(() => store.reserve(actor, { creationParams: params("direct"), purpose: "OTHER" as never }), /purpose is not valid/);
    });
  });

  it("DIRECT is refused once there is a seller profile; PAYOUT then needs a history of agent sales", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-x','X','seller-x','acct_SyntheticSeller001','X')`, [PROVIDER]);
      await assert.rejects(() => store.reserve(actor, { creationParams: params("direct"), purpose: "DIRECT" }), conflict("SELLER_EXISTS"));
      await assert.rejects(() => store.reserve(actor, { creationParams: params("payout") }), conflict("SELLER_EXISTS"));
      assert.equal(await store.agentSalesHistoryExists(PROVIDER), false);
      // A withdrawn consent is still history: NIHO still sends what it took.
      await pool.query(
        `INSERT INTO provider_agent_sales_consents (id,provider_id,seller_ref,consent_version,consented_by_host_account_id,consented_at,revoked_at,revoked_by_host_account_id)
         VALUES ($1,$2,$3,'v1',$4,clock_timestamp(),clock_timestamp(),$4)`, [randomUUID(), PROVIDER, `agt_${"b".repeat(32)}`, actor.nihoUserId]);
      assert.equal(await store.agentSalesHistoryExists(PROVIDER), true);
      assert.equal((await store.reserve(actor, { creationParams: params("payout") })).created, true);
      await assert.rejects(() => store.reserve(actor, { creationParams: params("direct"), purpose: "DIRECT" }), conflict("SELLER_EXISTS"));
    });
  });

  it("a valid payout row is returned whatever the seller is; a new one needs no seller or a history (the screen's rule is payoutBlock)", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const made = await store.reserve(actor, { creationParams: params("payout") });
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-x','X','seller-x','acct_SyntheticSeller001','X')`, [PROVIDER]);
      const again = await store.reserve(actor, { creationParams: params("payout") });
      assert.deepEqual([again.created, again.account.id], [false, made.account.id], "no history needed to continue the row it has");
      assert.equal((await store.payoutBlock(PROVIDER))?.current?.account.id, made.account.id);
      await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator" });
      assert.equal(await store.payoutBlock(PROVIDER), null, "no row and no history: not shown, and not reservable");
      await assert.rejects(() => store.reserve(actor, { creationParams: params("payout") }), conflict("SELLER_EXISTS"));
      await pool.query(
        `INSERT INTO provider_agent_sales_consents (id,provider_id,seller_ref,consent_version,consented_by_host_account_id,consented_at)
         VALUES ($1,$2,$3,'v1',$4,clock_timestamp())`, [randomUUID(), PROVIDER, `agt_${"e".repeat(32)}`, actor.nihoUserId]);
      assert.deepEqual(await store.payoutBlock(PROVIDER), { current: null });
      assert.equal((await store.reserve(actor, { creationParams: params("payout") })).created, true);
    });
  });

  it("sends no email for a host's own account", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const account = await directAccount(pool, actor, null);
      const store = new ExperienceConnectAccounts(pool);
      const need = snapshot({ state: "ACTION_REQUIRED", payoutReady: false, requirementsHash: hash("need") });
      assert.deepEqual(await store.saveSnapshot(account.id, need, { notify: true }), { saved: true, mailQueued: false });
      assert.equal((await pool.query("SELECT 1 FROM outbox_messages")).rowCount, 0);
      await assert.rejects(() => store.saveSnapshot(account.id, snapshot({ state: "VERIFYING", payoutReady: true })), /payout-ready/);
    });
  });
});

describe("registering the seller from the host's own account", { skip }, () => {
  it("writes the profile, the consent and the sellerless products together", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const account = await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      const publications = new ExperiencePublicationRepository(pool);
      const draft = await publications.createDraft(actor, {
        slug: "direct-walk", publicTitle: "Synthetic walk", currency: "JPY", unitAmount: 10_000,
        content: { lead: "L", description: "D", facts: { language: "English" }, highlights: ["H"], included: ["I"], notIncluded: [], knowBeforeYouGo: ["K"], notSuitableFor: [], timeline: [], meetingOverview: "M", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null },
      });
      assert.equal(draft.seller, null);

      const registered = await register(pool, actor);
      assert.match(registered.sellerRef, /^sel_[0-9a-f]{32}$/);
      assert.equal(registered.sellerDisplayName, NAME);
      assert.equal(registered.consent.outcome, "RECORDED");
      assert.equal(registered.attachedProducts, 1);
      const profile = (await pool.query(
        "SELECT legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id,connect_account_purpose FROM experience_host_seller_profiles WHERE provider_id=$1", [PROVIDER])).rows[0];
      assert.deepEqual(profile, {
        legacy_provider_id: null, provider_display_name: "合成の主催者", seller_niho_account_ref: registered.sellerRef,
        stripe_connect_account_ref: ACCOUNT, seller_display_name: NAME, connect_account_id: account.id, connect_account_purpose: "DIRECT",
      });
      const consent = await new ProviderPayoutAccountConsents(pool).current(actor);
      assert.deepEqual([consent?.stripeConnectAccountRef, consent?.consentVersion], [ACCOUNT, CONSENT]);
      const product = await publications.getProduct(actor, draft.id);
      assert.deepEqual(product.seller, { sellerNihoAccountRef: registered.sellerRef, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: NAME });
      assert.equal(product.version, draft.version, "the draft's version stays");

      // Once: a second registration is refused, and so is a payout/direct reservation.
      await assert.rejects(() => register(pool, actor), conflict("SELLER_EXISTS"));
    });
  });

  it("refuses each missing piece and writes nothing", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const noProfile = async () => {
        assert.equal((await pool.query("SELECT 1 FROM experience_host_seller_profiles")).rowCount, 0);
        assert.equal((await pool.query("SELECT 1 FROM provider_payout_account_consents")).rowCount, 0);
      };
      // No row at all.
      await assert.rejects(() => register(pool, actor), conflict("DIRECT_ACCOUNT_NOT_READY"));
      const account = await directAccount(pool, actor, null);
      // No snapshot; a state that is not READY; a read of a few minutes ago; another account ID.
      await assert.rejects(() => register(pool, actor), conflict("DIRECT_ACCOUNT_NOT_READY"));
      await store.saveSnapshot(account.id, snapshot({ state: "VERIFYING", payoutReady: false }));
      await assert.rejects(() => register(pool, actor), conflict("DIRECT_ACCOUNT_NOT_READY"));
      await store.saveSnapshot(account.id, snapshot({ readAtUtc: new Date(Date.now() - 6 * 60_000).toISOString() }));
      await assert.rejects(() => register(pool, actor), conflict("DIRECT_ACCOUNT_NOT_READY"));
      await store.saveSnapshot(account.id, snapshot());
      await assert.rejects(() => register(pool, actor, { stripeConnectAccountRef: "acct_SyntheticOther0002" }), conflict("DIRECT_ACCOUNT_NOT_READY"));
      // READY, but no NATIVE seller disclosure.
      await assert.rejects(() => register(pool, actor), conflict("SELLER_DISCLOSURE_REQUIRED"));
      await saveDisclosure(pool, actor);
      // Not an OWNER, and not a host account.
      const accounts = new HostAccounts(pool);
      const editor = await accounts.provisionHostAccount({ email: "direct-editor@example.test", nowUtc: new Date().toISOString() });
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'EDITOR',true)", [PROVIDER, editor.hostAccountId]);
      await assert.rejects(() => register(pool, { providerId: PROVIDER, nihoUserId: editor.hostAccountId }), StoreAccessDeniedError);
      await assert.rejects(() => register(pool, { providerId: PROVIDER, nihoUserId: "niho-user-1" }), StoreAccessDeniedError);
      await assert.rejects(() => register(pool, actor, { consentVersion: " " }), /consentVersion/);
      await assert.rejects(() => register(pool, actor, { stripeConnectAccountRef: "acct_x" }), /stripeConnectAccountRef/);
      await noProfile();
      // A retired row is not a row.
      await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator", purpose: "DIRECT" });
      await assert.rejects(() => register(pool, actor), conflict("DIRECT_ACCOUNT_NOT_READY"));
      await noProfile();
    });
  });

  it("leaves nothing behind when a later step fails", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      await pool.query(`CREATE FUNCTION fail_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$`);
      await pool.query("CREATE TRIGGER fail_consent BEFORE INSERT ON provider_payout_account_consents FOR EACH ROW EXECUTE FUNCTION fail_consent()");
      await assert.rejects(() => register(pool, actor), /synthetic failure/);
      assert.equal((await pool.query("SELECT 1 FROM experience_host_seller_profiles")).rowCount, 0, "the profile is rolled back with the consent");
      await pool.query("DROP TRIGGER fail_consent ON provider_payout_account_consents");
      assert.equal((await register(pool, actor)).consent.outcome, "RECORDED");
    });
  });

  it("is serialised: two registrations leave one profile", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      const results = await Promise.allSettled([register(pool, actor), register(pool, actor)]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      assert.equal((await pool.query("SELECT 1 FROM experience_host_seller_profiles")).rowCount, 1);
    });
  });
});

describe("the seller profile's insert guard", { skip }, () => {
  async function asRuntime(pool: Pool, run: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>, options: { readonly memberOfOwner?: boolean } = {}): Promise<void> {
    const role = `exp_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
    if (options.memberOfOwner) {
      const owner = (await pool.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='experience_host_seller_profiles'::regclass")).rows[0]!.owner as string;
      await pool.query(`GRANT "${owner}" TO ${role}`);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await run((sql, values) => client.query(sql, values));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }
  const insertSql = `INSERT INTO experience_host_seller_profiles
    (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id,connect_account_purpose)
    VALUES ($1,NULL,'X',$2,$3,'X',$4::uuid,'DIRECT')`;
  const sel = `sel_${"c".repeat(32)}`;

  it("refuses the runtime a profile with no account, another provider's, another Stripe account's, or a retired one", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const other = await owner(pool, "provider-someone-else", "someone@example.test");
      const mine = await directAccount(pool, actor);
      const theirs = await directAccount(pool, other, {}, "acct_SyntheticTheirs001");
      await asRuntime(pool, async (query) => {
        await assert.rejects(() => query(
          `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,NULL,'X',$2,'acct_SyntheticLegacy001','X')`, [PROVIDER, sel]), /own valid Stripe account/);
      });
      await asRuntime(pool, async (query) => {
        // Another provider's row: the foreign key already says the provider and account must be the row's own; the trigger says it too.
        await assert.rejects(() => query(insertSql, [PROVIDER, sel, "acct_SyntheticTheirs001", theirs.id]), /foreign key|own valid Stripe account/);
      });
      await asRuntime(pool, async (query) => {
        await query(insertSql, [PROVIDER, sel, ACCOUNT, mine.id]);
      });
      await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator", purpose: "DIRECT" });
      await asRuntime(pool, async (query) => {
        await assert.rejects(() => query(insertSql, [PROVIDER, sel, ACCOUNT, mine.id]), /own valid Stripe account/);
      });
      assert.equal((await pool.query("SELECT 1 FROM experience_host_seller_profiles")).rowCount, 0, "each runtime insert was rolled back");
    });
  });

  it("is not fooled by a temporary table of the runtime's own (the function pins its search_path)", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const mine = await directAccount(pool, actor);
      await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator", purpose: "DIRECT" });
      await asRuntime(pool, async (query) => {
        // The real row is retired (and the foreign key does not mind); a temporary table of the same name says it is valid.
        await query("CREATE TEMP TABLE pg_class (oid oid, relowner oid)");
        await query("INSERT INTO pg_temp.pg_class SELECT 'experience_host_seller_profiles'::regclass::oid, oid FROM pg_roles WHERE rolname=current_user");
        await query("CREATE TEMP TABLE experience_connect_accounts (id uuid, provider_id text, purpose text, retired_at timestamptz, stripe_account_ref text)");
        await query("INSERT INTO pg_temp.experience_connect_accounts VALUES ($1,$2,'DIRECT',NULL,$3)", [mine.id, PROVIDER, ACCOUNT]);
        await assert.rejects(() => query(insertSql, [PROVIDER, sel, ACCOUNT, mine.id]), /own valid Stripe account/);
      });
    });
  });

  it("lets the table's owner (the office's scripts) write the profile as before", async () => {
    await withDb(async (pool) => {
      await owner(pool);
      // The migration identity's role (here: a member of the table's owner) writes a legacy or a host-account profile with no account row.
      await asRuntime(pool, async (query) => {
        await query(
          `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,NULL,'X',$2,'acct_SyntheticOffice001','X')`, [PROVIDER, sel]);
        await query(
          `INSERT INTO experience_providers (id) VALUES ('provider-legacy')`);
        await query(
          `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ('provider-legacy','legacy-y','Y','seller-y','acct_SyntheticOffice002','Y')`);
      }, { memberOfOwner: true });
    });
  });
});

describe("retiring a host's own account", { skip }, () => {
  it("refuses one the seller profile is bound to, and retires one that is not", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      await register(pool, actor);
      await assert.rejects(() => retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator", purpose: "DIRECT" }), /change the seller first/);
      assert.equal((await new ExperienceConnectAccounts(pool).currentDirect(PROVIDER))?.account.retiredAtUtc, null);
      // The payout account's retirement is unchanged (and never touches the DIRECT row).
      assert.equal(await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator" }), null);

      const other = await owner(pool, "provider-unbound", "unbound@example.test");
      const row = await directAccount(pool, other, {}, "acct_SyntheticUnbound01");
      assert.equal((await retireConnectAccount(pool, { providerId: "provider-unbound", retiredBy: "operator", purpose: "DIRECT" }))?.id, row.id);
    });
  });
});

describe("a registration racing a retirement", { skip }, () => {
  it("the database refuses to retire an account row a seller profile is bound to", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const account = await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      await register(pool, actor);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET retired_at=clock_timestamp(),retired_by='x' WHERE id=$1", [account.id]), /not retired/);
      assert.equal((await pool.query("SELECT 1 FROM experience_connect_accounts WHERE id=$1 AND retired_at IS NULL", [account.id])).rowCount, 1);
    });
  });

  it("a retirement that started while register held the row waits, then is refused", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      await directAccount(pool, actor);
      await saveDisclosure(pool, actor);
      const holder = await pool.connect();
      try {
        // register's first read of the row, held open
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM experience_connect_accounts WHERE provider_id=$1 AND purpose='DIRECT' FOR SHARE", [PROVIDER]);
        const retiring = retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator", purpose: "DIRECT" });
        const outcome = retiring.then(() => "retired", (error: Error) => error.message);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const account = (await holder.query("SELECT id FROM experience_connect_accounts WHERE purpose='DIRECT'")).rows[0]!.id as string;
        await holder.query(
          `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,connect_account_id,connect_account_purpose)
           VALUES ($1,NULL,'X',$2,$3,'X',$4::uuid,'DIRECT')`, [PROVIDER, `sel_${"d".repeat(32)}`, ACCOUNT, account]);
        await holder.query("COMMIT");
        assert.match(await outcome, /change the seller first/);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      assert.equal((await new ExperienceConnectAccounts(pool).currentDirect(PROVIDER))?.account.retiredAtUtc, null);
    });
  });
});

describe("withdrawing the payout-account consent", { skip }, () => {
  it("does not stop an agent-sales publication", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const draft = await publications.createDraft(actor, {
        slug: "agent-walk", publicTitle: "Synthetic agent walk", currency: "JPY", unitAmount: 10_000,
        content: { lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" }, highlights: ["H"], included: ["I"], notIncluded: [], knowBeforeYouGo: ["K"], notSuitableFor: [], timeline: [], meetingOverview: "M", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null },
      });
      const rule: ScheduleRule = {
        id: "agent-daily", timeZone: "Asia/Tokyo", startsOn: day(-1), localStartTime: "10:00", durationMinutes: 90,
        capacity: 6, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await new ExperienceStore(pool).saveScheduleRule(actor, draft.id, rule, null, randomUUID());
      const photoId = randomUUID();
      await publications.addMedia(actor, draft.id, {
        id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: hash("agent-walk"),
        width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
      });
      await pool.query(
        `INSERT INTO experience_product_sale_terms (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`, [PROVIDER, draft.id, emptyQuestions]);
      await saveDisclosure(pool, actor);
      const choice: AgentSalesChoiceInput = {
        commandId: randomUUID(), expectedStateVersion: null, agreementVersion: "agent-sales-synthetic-v1", accepted: true, platformAccountId: PLATFORM,
        receivingAgentName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerDisclosureUrl: "https://travel.example.test/experiences/agent-walk/seller",
      };
      await new ProviderAgentSales(pool).choose(actor, draft.id, choice);
      const current = await publications.getProduct(actor, draft.id);
      await publications.openBooking(actor, draft.id, {
        expectedDraftVersion: current.version, expectedStateVersion: null, consentVersion: "publication-agent-synthetic-v1",
        checks: { manuscriptReady: true, photosReady: true },
        agentCheck: { agreementVersion: "agent-sales-synthetic-v1", accountCheck: { stripeConnectAccountRef: PLATFORM, checkedAtUtc: new Date().toISOString() } },
      });
      const selling = async () => (await pool.query("SELECT self_stopped_at IS NULL AS selling FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2", [PROVIDER, draft.id])).rows[0]?.selling;
      assert.equal(await selling(), true);

      // The host then gets its own account and seller profile for other products, and withdraws that consent.
      await directAccount(pool, actor);
      await register(pool, actor);
      const consents = new ProviderPayoutAccountConsents(pool);
      const withdrawn = await consents.revoke(actor, { nowUtc: new Date().toISOString() });
      assert.deepEqual([withdrawn.outcome, withdrawn.stoppedPublications], ["REVOKED", 0]);
      assert.equal(await selling(), true, "an agent-sales product is paid to NIHO's account, not to this one");
    });
  });
});
