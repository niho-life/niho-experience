import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { retireConnectAccount } from "../src/connect-account-retirement.ts";
import { ExperienceConnectAccounts } from "../src/connect-accounts.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { HostMailOutbox } from "../src/host-mail-outbox.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";
import { seedNotificationAddresses } from "./helpers/notification-address.ts";

/* #710 (host registration, stage 3a): the host's payout account rows. Real schema, synthetic data. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-payout-account";
const ACCOUNT = "acct_SyntheticPayout0001";
const params = { country: "JP", metadata: { provider_id: PROVIDER, source: "niho-experience", purpose: "payout" } };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "connect_accounts", { max: 6 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

async function owner(pool: Pool, providerId = PROVIDER, email = "payout-owner@example.test"): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email, nowUtc: new Date().toISOString() });
  const granted = await accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: new Date().toISOString() });
  assert.equal(granted.kind, "granted");
  await seedNotificationAddresses(pool, hostAccountId);
  return { providerId, nihoUserId: hostAccountId };
}

const facts = (over: Record<string, unknown> = {}) => ({
  state: "IN_PROGRESS" as const, payoutReady: false, detailsSubmitted: false, payoutsEnabled: false, transfersActive: false,
  requirementsHash: hash("a"), readAtUtc: new Date().toISOString(), ...over,
});

describe("experience connect accounts (payout account)", { skip }, () => {
  it("two requests at once leave one row, and the account ID is written once", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const [a, b] = await Promise.all([
        store.reserve(actor, { creationParams: { ...params, n: 1 } }),
        store.reserve(actor, { creationParams: { ...params, n: 2 } }),
      ]);
      assert.equal(a.account.id, b.account.id);
      assert.deepEqual([a.created, b.created].sort(), [false, true]);
      assert.equal(a.account.creationParams.n, b.account.creationParams.n, "the loser reads the winner's stored parameters");
      assert.equal((await pool.query("SELECT 1 FROM experience_connect_accounts")).rowCount, 1);

      const first = await store.recordAccountRef(actor, a.account.id, ACCOUNT);
      assert.equal(first.stripeAccountRef, ACCOUNT);
      assert.equal((await store.recordAccountRef(actor, a.account.id, ACCOUNT)).stripeAccountRef, ACCOUNT, "the same ID again is a no-op");
      await assert.rejects(() => store.recordAccountRef(actor, a.account.id, "acct_SyntheticOther0002"), StoreConflictError);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET stripe_account_ref='acct_SyntheticOther0002' WHERE id=$1", [a.account.id]), /set once/);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET stripe_account_ref=NULL WHERE id=$1", [a.account.id]), /set once/);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET creation_params='{}' WHERE id=$1", [a.account.id]), /immutable/);
      assert.equal((await store.findByAccountRef(ACCOUNT))?.account.id, a.account.id);
      assert.equal(await store.findByAccountRef("acct_SyntheticUnknown03"), null);
    });
  });

  it("is the OWNER's only, and not for a provider that has a Direct charge seller", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const stranger = await owner(pool, "provider-someone-else", "someone@example.test");
      const store = new ExperienceConnectAccounts(pool);
      await assert.rejects(() => store.reserve({ providerId: PROVIDER, nihoUserId: stranger.nihoUserId }, { creationParams: params }), StoreAccessDeniedError);
      await assert.rejects(() => store.reserve({ providerId: PROVIDER, nihoUserId: "niho-user-1" }, { creationParams: params }), StoreAccessDeniedError);
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-x','X','seller-x','acct_SyntheticSeller001','X')`, [PROVIDER]);
      await assert.rejects(() => store.reserve(actor, { creationParams: params }), (error) => error instanceof StoreConflictError && error.message === "SELLER_EXISTS");
      assert.equal((await pool.query("SELECT 1 FROM experience_connect_accounts")).rowCount, 0);
    });
  });

  it("never deletes a row; after retirement a new one can be made", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const { account } = await store.reserve(actor, { creationParams: params });
      await store.recordAccountRef(actor, account.id, ACCOUNT);
      await assert.rejects(() => pool.query("DELETE FROM experience_connect_accounts WHERE id=$1", [account.id]), /never deleted/);
      const retired = await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator" });
      assert.equal(retired?.id, account.id);
      assert.equal(await retireConnectAccount(pool, { providerId: PROVIDER, retiredBy: "operator" }), null);
      assert.equal(await store.currentPayout(PROVIDER), null);
      assert.ok((await store.findByAccountRef(ACCOUNT))?.account.retiredAtUtc);
      await assert.rejects(() => pool.query("UPDATE experience_connect_accounts SET retired_at=NULL,retired_by=NULL WHERE id=$1", [account.id]), /stays retired/);
      await assert.rejects(() => store.recordAccountRef(actor, account.id, ACCOUNT), StoreConflictError);
      const next = await store.reserve(actor, { creationParams: params });
      assert.equal(next.created, true);
      assert.notEqual(next.account.id, account.id);
      assert.equal((await store.currentPayout(PROVIDER))?.account.id, next.account.id);
      // The same Stripe account cannot belong to two rows.
      await assert.rejects(() => store.recordAccountRef(actor, next.account.id, ACCOUNT), StoreConflictError);
    });
  });

  it("keeps the newest read of the state, and mails one email for one need", async () => {
    await withDb(async (pool) => {
      const actor = await owner(pool);
      const store = new ExperienceConnectAccounts(pool);
      const { account } = await store.reserve(actor, { creationParams: params });
      await assert.rejects(() => store.saveSnapshot(account.id, facts()), StoreConflictError, "no Stripe account yet");
      await store.recordAccountRef(actor, account.id, ACCOUNT);
      const t = (seconds: number) => new Date(Date.UTC(2026, 10, 28, 0, 0, seconds)).toISOString();

      assert.deepEqual(await store.saveSnapshot(account.id, facts({ readAtUtc: t(10) }), { notify: true }), { saved: true, mailQueued: false });
      assert.deepEqual(await store.saveSnapshot(account.id, facts({ state: "VERIFYING", detailsSubmitted: true, readAtUtc: t(5) })), { saved: false, mailQueued: false });
      assert.equal((await store.currentPayout(PROVIDER))?.snapshot?.state, "IN_PROGRESS", "an older read does not replace a newer one");

      const need = facts({ state: "ACTION_REQUIRED", detailsSubmitted: true, requirementsHash: hash("need-1"), readAtUtc: t(20) });
      assert.deepEqual(await store.saveSnapshot(account.id, need, { notify: false }), { saved: true, mailQueued: false }, "the screen's read does not mail");
      assert.deepEqual(await store.saveSnapshot(account.id, { ...need, readAtUtc: t(21) }, { notify: true }), { saved: true, mailQueued: true });
      assert.deepEqual(await store.saveSnapshot(account.id, { ...need, readAtUtc: t(22) }, { notify: true }), { saved: true, mailQueued: false }, "the same need is not mailed twice");
      assert.deepEqual(await store.saveSnapshot(account.id, { ...need, requirementsHash: hash("need-2"), readAtUtc: t(23) }, { notify: true }), { saved: true, mailQueued: true }, "a new need is");
      assert.equal((await store.currentPayout(PROVIDER))?.snapshot?.requirementsHash, hash("need-2"));

      // Mailed for need-1 and need-2; the kept state is need-2, so the older need's email is closed unsent.
      const outbox = new HostMailOutbox(pool);
      const claim = await outbox.claimPayoutAccountMails({ limit: 10, leaseSeconds: 60 });
      assert.equal(claim.mails.length, 2);
      assert.ok(claim.mails.every((mail) => mail.providerId === PROVIDER));
      assert.deepEqual(claim.mails.map((mail) => mail.to === null), [true, false], "only the new need's email is sent");
      for (const mail of claim.mails) await outbox.completePayoutAccountMail(mail.id);
      assert.equal((await outbox.claimPayoutAccountMails({ limit: 10, leaseSeconds: 60 })).mails.length, 0);

      // Not for a state that is not asking for information, nor for a retired account.
      await store.saveSnapshot(account.id, facts({ state: "ACTION_REQUIRED", detailsSubmitted: true, requirementsHash: hash("need-3"), readAtUtc: t(30) }), { notify: true });
      await store.saveSnapshot(account.id, facts({ state: "READY", payoutReady: true, detailsSubmitted: true, payoutsEnabled: true, transfersActive: true, readAtUtc: t(31) }));
      const stale = await outbox.claimPayoutAccountMails({ limit: 10, leaseSeconds: 60 });
      assert.deepEqual(stale.mails.map((mail) => mail.to), [null], "no longer asking: nothing is sent");
      for (const mail of stale.mails) await outbox.completePayoutAccountMail(mail.id);

      // A screen read that kept the new state first does not stop the webhook's write from mailing it.
      const newer = facts({ state: "ACTION_REQUIRED", detailsSubmitted: true, requirementsHash: hash("need-4"), readAtUtc: t(50) });
      assert.deepEqual(await store.saveSnapshot(account.id, newer, { notify: false }), { saved: true, mailQueued: false });
      assert.deepEqual(await store.saveSnapshot(account.id, { ...newer, readAtUtc: t(49) }, { notify: true }), { saved: false, mailQueued: true });
      assert.deepEqual(await store.saveSnapshot(account.id, { ...newer, readAtUtc: t(51) }, { notify: true }), { saved: true, mailQueued: false });
      for (const mail of (await outbox.claimPayoutAccountMails({ limit: 10, leaseSeconds: 60 })).mails) await outbox.completePayoutAccountMail(mail.id);
    });
  });
});
