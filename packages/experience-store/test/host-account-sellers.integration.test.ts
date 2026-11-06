import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { HOST_BIO_CONSENT_VERSION } from "../src/host-bio-rules.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ProviderHostBioRepository } from "../src/provider-host-bios.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { SiteSaleRegistration, type HostAccountSellerInput } from "../src/site-sale-registration.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/*
 * 受取口座 (ADR 0003 slice 3, migration 0065): sellers registered for Experience host accounts, the resolver the host
 * boundary uses, the OWNER's payout-account consent, and the seller disclosure / host bio OWNER rules for such sellers.
 * Real schema, synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const at = (minutes = 0): string => new Date(T0 + minutes * 60_000).toISOString();
const SELLER_REF = /^sel_[0-9a-f]{32}$/;
const ACCOUNT = "acct_SyntheticHostSeller01";
const OTHER_ACCOUNT = "acct_SyntheticHostSeller02";
const VERSION = "payout-account-consent-v1";

const seller = (providerId: string, overrides: Partial<HostAccountSellerInput> = {}): HostAccountSellerInput => ({
  providerId,
  providerDisplayName: "Synthetic Supper Club",
  sellerDisplayName: "Synthetic Legal Seller KK",
  stripeConnectAccountRef: ACCOUNT,
  ...overrides,
});

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_account_sellers", { max: 6 });
  try {
    await run(db.pool);
  } finally {
    await db.dispose();
  }
}

/** A host account by address, made the provider's first OWNER (the provider must exist). */
async function hostOwner(pool: Pool, providerId: string, email: string): Promise<HostActor> {
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email, nowUtc: at() });
  const granted = await accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: at() });
  assert.equal(granted.kind, "granted");
  return { providerId, nihoUserId: hostAccountId };
}

/** A host account with another role (or an extra OWNER), inserted as Admin would by hand. */
async function hostMember(pool: Pool, providerId: string, email: string, role: "OWNER" | "EDITOR"): Promise<HostActor> {
  const { hostAccountId } = await new HostAccounts(pool).provisionHostAccount({ email, nowUtc: at() });
  await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,$3)", [providerId, hostAccountId, role]);
  return { providerId, nihoUserId: hostAccountId };
}

/** A seller mapped to NIHO (the NIHO login's provisioning) with its NIHO OWNER. */
async function nihoSeller(pool: Pool, providerId: string, nihoUserId: string, account: string): Promise<void> {
  await new SiteSaleRegistration(pool).provisionHostSeller({
    providerId, legacyProviderId: `legacy-${providerId}`, providerDisplayName: "NIHO mapped provider",
    sellerNihoAccountRef: nihoUserId, stripeConnectAccountRef: account, sellerDisplayName: "NIHO Legal Seller", supportEnabled: false,
  });
  await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER')", [providerId, nihoUserId]);
}

async function sellerRef(pool: Pool, providerId: string): Promise<string> {
  return String((await pool.query("SELECT seller_niho_account_ref FROM experience_host_seller_profiles WHERE provider_id=$1", [providerId])).rows[0]!.seller_niho_account_ref);
}

/** One listed product of the provider, as the publication flow leaves it. */
async function listedProduct(pool: Pool, actor: HostActor, slug: string, account = ACCOUNT, sellerName = "Synthetic Legal Seller KK"): Promise<void> {
  const ref = await sellerRef(pool, actor.providerId);
  await pool.query(
    `INSERT INTO experience_products
       (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
        seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
     VALUES ($1,$2,$2,'PUBLISHED','Synthetic supper','{}','JPY',5000,'synthetic-terms',$3,$4,$5)`,
    [actor.providerId, slug, ref, account, sellerName],
  );
  const publication = await pool.query<{ id: string }>(
    `INSERT INTO experience_product_publications
       (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
        seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
     VALUES ($1,$2,1,$2,'Synthetic supper','{}','JPY',5000,'synthetic-terms',$3,$4,$5,'publication-v1',$6) RETURNING id::text`,
    [actor.providerId, slug, ref, account, sellerName, actor.nihoUserId],
  );
  await pool.query(
    `INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,first_published_at)
     VALUES ($1,$2,$3,clock_timestamp())`,
    [actor.providerId, slug, publication.rows[0]!.id],
  );
}

async function activeConsents(pool: Pool, providerId: string): Promise<number> {
  return Number((await pool.query("SELECT count(*)::int AS n FROM provider_payout_account_consents WHERE provider_id=$1 AND revoked_at IS NULL", [providerId])).rows[0]!.n);
}

describe("sellers registered for Experience host accounts", { skip }, () => {
  it("registers the provider and its seller with a minted seller reference and no NIHO ID; the same input is UNCHANGED", async () => {
    await withDb(async (pool) => {
      const registration = new SiteSaleRegistration(pool);
      assert.equal(await registration.canProvisionHostAccountSeller(), true);
      assert.deepEqual(await registration.currentHostAccountSellerState({ providerId: "provider-supper", stripeConnectAccountRef: ACCOUNT }), {
        providerExists: false, sellerProfile: null, accountUsedElsewhere: false,
      });
      assert.deepEqual(await registration.provisionHostAccountSeller(seller("provider-supper")), { provider: "CREATED", sellerProfile: "CREATED" });
      const row = (await pool.query("SELECT * FROM experience_host_seller_profiles WHERE provider_id='provider-supper'")).rows[0]!;
      assert.equal(row.legacy_provider_id, null);
      assert.match(String(row.seller_niho_account_ref), SELLER_REF);
      assert.equal(row.stripe_connect_account_ref, ACCOUNT);
      assert.deepEqual(await registration.provisionHostAccountSeller(seller("provider-supper")), { provider: "UNCHANGED", sellerProfile: "UNCHANGED" });
      assert.equal(await sellerRef(pool, "provider-supper"), row.seller_niho_account_ref);
      assert.deepEqual(await registration.currentHostAccountSellerState({ providerId: "provider-supper", stripeConnectAccountRef: ACCOUNT }), {
        providerExists: true,
        sellerProfile: { kind: "host-account", providerDisplayName: "Synthetic Supper Club", sellerDisplayName: "Synthetic Legal Seller KK", stripeConnectAccountRef: ACCOUNT },
        accountUsedElsewhere: false,
      });
      // An existing provider without a seller keeps its row; only the seller is created.
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-existing')");
      assert.deepEqual(await registration.provisionHostAccountSeller(seller("provider-existing", { stripeConnectAccountRef: OTHER_ACCOUNT })), { provider: "UNCHANGED", sellerProfile: "CREATED" });
      assert.notEqual(await sellerRef(pool, "provider-existing"), row.seller_niho_account_ref);
    });
  });

  it("refuses a differing seller, a seller mapped to NIHO, an account in use, and Experience IDs as NIHO seller references", async () => {
    await withDb(async (pool) => {
      const registration = new SiteSaleRegistration(pool);
      await registration.provisionHostAccountSeller(seller("provider-supper"));
      await assert.rejects(() => registration.provisionHostAccountSeller(seller("provider-supper", { sellerDisplayName: "Another Seller" })), StoreConflictError);
      await assert.rejects(() => registration.provisionHostAccountSeller(seller("provider-supper", { stripeConnectAccountRef: OTHER_ACCOUNT })), StoreConflictError);
      // Another provider cannot register the same account.
      assert.equal((await registration.currentHostAccountSellerState({ providerId: "provider-copy", stripeConnectAccountRef: ACCOUNT })).accountUsedElsewhere, true);
      await assert.rejects(() => registration.provisionHostAccountSeller(seller("provider-copy")), StoreConflictError);
      // A NIHO-mapped seller is not replaced.
      await nihoSeller(pool, "provider-niho", "niho-user-synthetic-1", OTHER_ACCOUNT);
      assert.deepEqual((await registration.currentHostAccountSellerState({ providerId: "provider-niho", stripeConnectAccountRef: OTHER_ACCOUNT })).sellerProfile, { kind: "niho" });
      await assert.rejects(() => registration.provisionHostAccountSeller(seller("provider-niho", { stripeConnectAccountRef: OTHER_ACCOUNT })), StoreConflictError);
      for (const bad of [{ sellerDisplayName: " padded" }, { providerDisplayName: "" }, { sellerDisplayName: "two\nlines" }, { stripeConnectAccountRef: "acct_1" }]) {
        await assert.rejects(() => registration.provisionHostAccountSeller(seller("provider-bad", bad)), StoreValidationError, JSON.stringify(bad));
      }
      // The NIHO provisioning never takes an Experience host account or seller reference as the NIHO user.
      for (const ref of [`hst_${"a".repeat(32)}`, `sel_${"b".repeat(32)}`]) {
        await assert.rejects(() => registration.provisionHostSeller({
          providerId: "provider-shape", legacyProviderId: "legacy-shape", providerDisplayName: "Shape", sellerNihoAccountRef: ref,
          stripeConnectAccountRef: "acct_SyntheticShape0001", sellerDisplayName: "Shape Seller", supportEnabled: false,
        }), StoreValidationError, ref);
      }
      // The schema: no NIHO key only with a seller reference.
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-raw')");
      await assert.rejects(() => pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-raw',NULL,'Raw','niho-user-raw','acct_SyntheticRaw00001','Raw Seller')`,
      ), (error: { code?: string }) => error.code === "23514");
    });
  });
});

describe("the seller a host account acts for", { skip }, () => {
  it("resolves exactly one OWNER provider's host-account seller, and the NIHO path never sees it", async () => {
    await withDb(async (pool) => {
      const publications = new ExperiencePublicationRepository(pool);
      const accounts = new HostAccounts(pool);
      const registration = new SiteSaleRegistration(pool);
      const { hostAccountId: nobody } = await accounts.provisionHostAccount({ email: "nobody@example.test", nowUtc: at() });
      assert.deepEqual(await publications.currentHostAccountSellerProfile(nobody), { kind: "none" });
      await assert.rejects(() => publications.currentHostAccountSellerProfile("niho-user-synthetic"), StoreValidationError);

      // An OWNER whose provider has no seller yet, or a seller mapped to NIHO: setup-required.
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-bare')");
      const bare = await hostOwner(pool, "provider-bare", "bare@example.test");
      assert.deepEqual(await publications.currentHostAccountSellerProfile(bare.nihoUserId), { kind: "setup-required", providerId: "provider-bare" });
      await nihoSeller(pool, "provider-niho", "niho-user-synthetic-1", OTHER_ACCOUNT);
      const onNiho = await hostOwner(pool, "provider-niho", "on-niho@example.test");
      assert.deepEqual(await publications.currentHostAccountSellerProfile(onNiho.nihoUserId), { kind: "setup-required", providerId: "provider-niho" });

      await registration.provisionHostAccountSeller(seller("provider-supper"));
      const owner = await hostOwner(pool, "provider-supper", "owner@example.test");
      const ref = await sellerRef(pool, "provider-supper");
      const ready = {
        kind: "ready",
        hostAccountActive: true,
        profile: {
          providerId: "provider-supper", legacyProviderId: null, providerDisplayName: "Synthetic Supper Club",
          sellerNihoAccountRef: ref, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK",
        },
      };
      assert.deepEqual(await publications.currentHostAccountSellerProfile(owner.nihoUserId), ready);
      await accounts.suspendHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(1) });
      assert.deepEqual(await publications.currentHostAccountSellerProfile(owner.nihoUserId), { ...ready, hostAccountActive: false });
      await accounts.reactivateHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(2) });

      // The NIHO login's lookups skip a host-account seller.
      assert.deepEqual(await publications.currentOwnerSellerProfile(owner.nihoUserId), { kind: "setup-required" });
      assert.deepEqual(await publications.listHostProviders(owner.nihoUserId), []);
      assert.deepEqual(await publications.ensureMappedOwnerMembership(ref), { kind: "no-mapping" });

      // OWNER of two providers (only by hand): ambiguous.
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-bare',$1,'OWNER')", [owner.nihoUserId]);
      assert.deepEqual(await publications.currentHostAccountSellerProfile(owner.nihoUserId), { kind: "ambiguous" });
    });
  });
});

describe("the OWNER's payout-account consent", { skip }, () => {
  async function supper(pool: Pool): Promise<{ owner: HostActor; consents: ProviderPayoutAccountConsents }> {
    await new SiteSaleRegistration(pool).provisionHostAccountSeller(seller("provider-supper"));
    return { owner: await hostOwner(pool, "provider-supper", "owner@example.test"), consents: new ProviderPayoutAccountConsents(pool) };
  }

  it("records, repeats and reads a consent for the registered account only, and a new version replaces it", async () => {
    await withDb(async (pool) => {
      const { owner, consents } = await supper(pool);
      assert.equal(await consents.current(owner), null);
      await assert.rejects(() => consents.record(owner, { stripeConnectAccountRef: OTHER_ACCOUNT, consentVersion: VERSION, nowUtc: at(1) }), StoreConflictError);
      for (const bad of [" v1", "", "v".repeat(161), "two\nlines"]) {
        await assert.rejects(() => consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: bad, nowUtc: at(1) }), StoreValidationError);
      }
      await assert.rejects(() => consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: "2026-11-07" }), StoreValidationError);
      const expected = { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, consentedAtUtc: at(1), consentedByHostAccountId: owner.nihoUserId };
      assert.deepEqual(await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(1) }), { outcome: "RECORDED", consent: expected });
      assert.deepEqual(await consents.current(owner), expected);
      assert.deepEqual(await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(2) }), { outcome: "UNCHANGED", consent: expected });
      const next = await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: "payout-account-consent-v2", nowUtc: at(3) });
      assert.equal(next.outcome, "RECORDED");
      assert.equal(next.consent.consentVersion, "payout-account-consent-v2");
      assert.equal(await activeConsents(pool, "provider-supper"), 1);
      const history = await pool.query("SELECT consent_version,revoked_at,revoked_by_niho_user_id FROM provider_payout_account_consents WHERE provider_id='provider-supper' ORDER BY consented_at");
      assert.deepEqual(history.rows.map((row) => [row.consent_version, (row.revoked_at as Date | null)?.toISOString() ?? null, row.revoked_by_niho_user_id]), [
        [VERSION, at(3), owner.nihoUserId],
        ["payout-account-consent-v2", null, null],
      ]);
      // Admin/ops changing the account leaves no consent that counts.
      await pool.query("UPDATE experience_host_seller_profiles SET stripe_connect_account_ref=$1 WHERE provider_id='provider-supper'", [OTHER_ACCOUNT]);
      assert.equal(await consents.current(owner), null);
      await assert.rejects(() => consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(4) }), StoreConflictError);
    });
  });

  it("refuses anyone but an active host-account OWNER of a provider with a host-account seller", async () => {
    await withDb(async (pool) => {
      const { owner, consents } = await supper(pool);
      const input = { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(1) };
      const editor = await hostMember(pool, "provider-supper", "editor@example.test", "EDITOR");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-supper','niho-user-synthetic-9','OWNER')");
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-other')");
      const otherOwner = await hostOwner(pool, "provider-other", "other@example.test");
      for (const actor of [editor, { providerId: "provider-supper", nihoUserId: "niho-user-synthetic-9" }, { providerId: "provider-supper", nihoUserId: otherOwner.nihoUserId }]) {
        await assert.rejects(() => consents.record(actor, input), StoreAccessDeniedError, actor.nihoUserId);
        await assert.rejects(() => consents.current(actor), StoreAccessDeniedError, actor.nihoUserId);
        await assert.rejects(() => consents.revoke(actor, { nowUtc: at(1) }), StoreAccessDeniedError, actor.nihoUserId);
      }
      // A suspended OWNER is refused until reactivated.
      const accounts = new HostAccounts(pool);
      await accounts.suspendHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(1) });
      await assert.rejects(() => consents.record(owner, input), StoreAccessDeniedError);
      await accounts.reactivateHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(2) });
      assert.equal((await consents.record(owner, { ...input, nowUtc: at(3) })).outcome, "RECORDED");
      // A host-account OWNER of a seller mapped to NIHO has nothing to consent to here.
      await nihoSeller(pool, "provider-niho", "niho-user-synthetic-1", OTHER_ACCOUNT);
      const onNiho = await hostOwner(pool, "provider-niho", "on-niho@example.test");
      assert.equal(await consents.current(onNiho), null);
      await assert.rejects(() => consents.record(onNiho, { ...input, stripeConnectAccountRef: OTHER_ACCOUNT }), StoreConflictError);
      assert.equal(await activeConsents(pool, "provider-niho"), 0);
    });
  });

  it("withdrawal stops the listings and clears the snapshot's consent; a consent counts only while its OWNER is OWNER", async () => {
    await withDb(async (pool) => {
      const { owner, consents } = await supper(pool);
      const publications = new ExperiencePublicationRepository(pool);
      await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(1) });
      await listedProduct(pool, owner, "synthetic-supper-a");
      await listedProduct(pool, owner, "synthetic-supper-b");
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=clock_timestamp() WHERE product_id='synthetic-supper-b'");
      const observed = new Date(Date.now() - 1_000);
      await publications.refreshReadiness(owner, {
        accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, paymentReuseConsentVersion: VERSION,
        paymentReuseConsentedAtUtc: at(1), sellerDisplayReady: true, sellerNihoAccountRef: await sellerRef(pool, "provider-supper"),
        stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK", requiredConsentVersion: "publication-v1",
        observedAtUtc: observed.toISOString(), validUntilUtc: new Date(observed.getTime() + 5 * 60_000).toISOString(),
      });

      assert.deepEqual(await consents.revoke(owner, { nowUtc: at(2) }), { outcome: "REVOKED", stoppedPublications: 1 });
      const states = await pool.query("SELECT product_id,self_stopped_at IS NOT NULL AS stopped FROM experience_product_publication_states WHERE provider_id='provider-supper' ORDER BY product_id");
      assert.deepEqual(states.rows, [{ product_id: "synthetic-supper-a", stopped: true }, { product_id: "synthetic-supper-b", stopped: true }]);
      const snapshot = (await pool.query("SELECT payment_reuse_consent_accepted,payment_reuse_consent_version FROM provider_publication_readiness WHERE provider_id='provider-supper'")).rows[0]!;
      assert.deepEqual(snapshot, { payment_reuse_consent_accepted: false, payment_reuse_consent_version: null });
      assert.equal(await consents.current(owner), null);
      assert.deepEqual(await consents.revoke(owner, { nowUtc: at(3) }), { outcome: "NONE", stoppedPublications: 0 });

      // OWNER change: the consent of an OWNER who left no longer counts; the new OWNER consents again.
      await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(4) });
      const successor = await hostMember(pool, "provider-supper", "successor@example.test", "OWNER");
      assert.equal((await consents.current(successor))?.consentedByHostAccountId, owner.nihoUserId);
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-supper' AND niho_user_id=$1", [owner.nihoUserId]);
      assert.equal(await consents.current(successor), null);
      const replaced = await consents.record(successor, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(5) });
      assert.equal(replaced.outcome, "RECORDED");
      assert.equal(replaced.consent.consentedByHostAccountId, successor.nihoUserId);
      assert.equal(await activeConsents(pool, "provider-supper"), 1);
      const left = await pool.query("SELECT revoked_by_niho_user_id FROM provider_payout_account_consents WHERE consented_by_niho_user_id=$1 AND revoked_at IS NOT NULL ORDER BY consented_at DESC LIMIT 1", [owner.nihoUserId]);
      assert.equal(left.rows[0]!.revoked_by_niho_user_id, successor.nihoUserId);
    });
  });

  it("never writes back a consent read before its withdrawal: a stale snapshot is stored without it, and publishing stays closed", async () => {
    await withDb(async (pool) => {
      const { owner, consents } = await supper(pool);
      const publications = new ExperiencePublicationRepository(pool);
      await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(1) });
      // The boundary read this consent, then waited for Stripe; meanwhile another request withdrew it.
      const read = await consents.current(owner);
      assert.ok(read);
      assert.equal((await consents.revoke(owner, { nowUtc: at(2) })).outcome, "REVOKED");
      const observed = new Date(Date.now() - 1_000);
      const snapshot = {
        accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, paymentReuseConsentVersion: read.consentVersion,
        paymentReuseConsentedAtUtc: read.consentedAtUtc, sellerDisplayReady: true, sellerNihoAccountRef: await sellerRef(pool, "provider-supper"),
        stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK", requiredConsentVersion: "publication-v1",
        observedAtUtc: observed.toISOString(), validUntilUtc: new Date(observed.getTime() + 5 * 60_000).toISOString(),
      };
      const stale = await publications.refreshReadiness(owner, snapshot);
      assert.deepEqual([stale.paymentReuseConsentAccepted, stale.paymentReuseConsentVersion, stale.paymentReuseConsentedAtUtc], [false, null, null]);

      // A new consent counts again, but only the one the snapshot names: the old consent's time no longer matches.
      const renewed = await consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(3) });
      assert.equal((await publications.refreshReadiness(owner, snapshot)).paymentReuseConsentAccepted, false);
      const fresh = await publications.refreshReadiness(owner, { ...snapshot, paymentReuseConsentedAtUtc: renewed.consent.consentedAtUtc });
      assert.equal(fresh.paymentReuseConsentAccepted, true);
      // Another account or version than the active consent's is not it either.
      assert.equal((await publications.refreshReadiness(owner, { ...snapshot, paymentReuseConsentVersion: "another-version", paymentReuseConsentedAtUtc: renewed.consent.consentedAtUtc })).paymentReuseConsentAccepted, false);
    });
  });

  it("keeps one active consent under concurrent records", async () => {
    await withDb(async (pool) => {
      const { owner, consents } = await supper(pool);
      const same = await Promise.all(Array.from({ length: 4 }, () => consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: VERSION, nowUtc: at(1) })));
      assert.deepEqual(same.map((result) => result.outcome).sort(), ["RECORDED", "UNCHANGED", "UNCHANGED", "UNCHANGED"]);
      const versions = await Promise.all(["v-a", "v-b", "v-c"].map((version, index) => consents.record(owner, { stripeConnectAccountRef: ACCOUNT, consentVersion: version, nowUtc: at(2 + index) })));
      assert.ok(versions.every((result) => result.outcome === "RECORDED"));
      assert.equal(await activeConsents(pool, "provider-supper"), 1);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM provider_payout_account_consents")).rows[0]!.n), 4);
      // The partial unique index holds even without the store's lock.
      await assert.rejects(() => pool.query(
        `INSERT INTO provider_payout_account_consents (id,provider_id,stripe_connect_account_ref,consent_version,consented_by_niho_user_id,consented_at)
         VALUES ($1,'provider-supper',$2,'v-raw',$3,clock_timestamp())`,
        [randomUUID(), ACCOUNT, owner.nihoUserId],
      ), (error: { code?: string }) => error.code === "23505");
    });
  });
});

describe("seller disclosure and host bio for a host-account seller", { skip }, () => {
  it("accept the provider's host-account OWNER and still refuse everyone else", async () => {
    await withDb(async (pool) => {
      await new SiteSaleRegistration(pool).provisionHostAccountSeller(seller("provider-supper"));
      const owner = await hostOwner(pool, "provider-supper", "owner@example.test");
      const editor = await hostMember(pool, "provider-supper", "editor@example.test", "EDITOR");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-supper','niho-user-synthetic-9','OWNER')");
      await nihoSeller(pool, "provider-niho", "niho-user-synthetic-1", OTHER_ACCOUNT);
      const onNiho = await hostOwner(pool, "provider-niho", "on-niho@example.test");

      const disclosures = new ProviderSellerDisclosureRepository(pool);
      const bios = new ProviderHostBioRepository(pool);
      assert.deepEqual(await disclosures.getForOwner(owner), { sellerDisplayName: "Synthetic Legal Seller KK", disclosure: null });
      for (const actor of [editor, { providerId: "provider-supper", nihoUserId: "niho-user-synthetic-9" }, onNiho]) {
        await assert.rejects(() => disclosures.getForOwner(actor), StoreAccessDeniedError, actor.nihoUserId);
      }
      // The NIHO user stays the OWNER of its own NIHO-mapped seller.
      assert.equal((await disclosures.getForOwner({ providerId: "provider-niho", nihoUserId: "niho-user-synthetic-1" })).sellerDisplayName, "NIHO Legal Seller");

      const saved = await disclosures.save(owner, {
        commandId: randomUUID(), expectedVersion: null, disclosure: {
          method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Legal Seller KK",
          externalUrl: "https://example.test/legal", consentVersion: "seller-public-disclosure-v1", accepted: true,
        },
      });
      assert.equal(saved.version, 1);
      await assert.rejects(() => bios.save(editor, { bioJa: "合成の紹介文です。", bioEn: null, expectedVersion: null, consentVersion: HOST_BIO_CONSENT_VERSION }), StoreAccessDeniedError);
      assert.equal((await bios.save(owner, { bioJa: "合成の紹介文です。", bioEn: null, expectedVersion: null, consentVersion: HOST_BIO_CONSENT_VERSION })).version, 1);

      await listedProduct(pool, owner, "synthetic-supper-public");
      assert.deepEqual(await disclosures.getPublicBySlug("synthetic-supper-public"), {
        method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Legal Seller KK", externalUrl: "https://example.test/legal",
      });
      assert.deepEqual(await bios.getPublicBySlug("synthetic-supper-public"), { ja: "合成の紹介文です。", en: null });
      // Without an ACTIVE host-account OWNER the public seller and bio disappear (the NIHO OWNER row does not count).
      const accounts = new HostAccounts(pool);
      await accounts.suspendHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(1) });
      assert.equal(await disclosures.getPublicBySlug("synthetic-supper-public"), null);
      assert.equal(await bios.getPublicBySlug("synthetic-supper-public"), null);
      await accounts.reactivateHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: at(2) });
      assert.notEqual(await disclosures.getPublicBySlug("synthetic-supper-public"), null);
    });
  });
});
