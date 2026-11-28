import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { HostAccountIdentities, type RegisterHostSelfResult } from "../src/host-account-identities.ts";
import { HOST_PROVIDER_OWNER_LIMIT, HostAccounts, grantProviderOwnerIn } from "../src/host-accounts.ts";
import { ProviderPublicNameError } from "../src/provider-public-name.ts";
import { withTransaction } from "../src/transaction.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 自分でホスト登録する (#707, migration 0093): the registration's rows, its atomicity, the 3-provider limit, the consent CHECK. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const MINUTE = 60_000;
const T0 = Date.parse("2026-11-28T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const NIHO_A = "niho-user-synthetic-a";
const NIHO_B = "niho-user-synthetic-b";

const form = (overrides: Record<string, unknown> = {}) => ({
  providerKind: "PERSON" as const,
  publicDisplayName: "鎌倉の茶室",
  publicDisplayNameEn: "Kamakura Tea Room",
  hostTermsVersion: "host-terms-2026-11-28",
  notificationEmail: "Tea@Example.com",
  ...overrides,
});

async function withStore(run: (context: { pool: Pool; accounts: HostAccounts; identities: HostAccountIdentities }) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_self_reg", { max: 8 });
  try {
    await run({ pool: db.pool, accounts: new HostAccounts(db.pool), identities: new HostAccountIdentities(db.pool) });
  } finally {
    await db.dispose();
  }
}

const count = async (pool: Pool, table: string): Promise<number> => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
const TABLES = ["host_accounts", "host_account_identities", "host_account_identity_events", "host_sessions", "experience_providers", "experience_provider_media_state",
  "experience_provider_public_profiles", "provider_memberships", "experience_provider_self_registrations", "host_notification_address_confirmations", "outbox_messages"];
const snapshot = async (pool: Pool): Promise<readonly number[]> => Promise.all(TABLES.map((table) => count(pool, table)));

async function registered(identities: HostAccountIdentities, nihoUserId: string, offset = 0, overrides: Record<string, unknown> = {}) {
  const result = await identities.registerHostSelf({ nihoUserId, authenticatedAtUtc: at(offset), nowUtc: at(offset + MINUTE), ...form(overrides) });
  assert.equal(result.kind, "registered");
  return result as Extract<RegisterHostSelfResult, { kind: "registered" }>;
}

describe("host self-registration", { skip: databaseUrl === undefined }, () => {
  it("creates the host account, identity, provider, consented name, OWNER, record, pending address and session at once", async () => {
    await withStore(async ({ pool, accounts, identities }) => {
      const result = await registered(identities, NIHO_A);
      assert.equal(result.notificationAddress, "PENDING");
      assert.match(result.hostAccountId, /^hst_[0-9a-f]{32}$/);
      assert.match(result.providerId, /^prv_[0-9a-f]{32}$/);

      const account = (await pool.query("SELECT email, email_key, email_verified_at, status FROM host_accounts WHERE id = $1", [result.hostAccountId])).rows[0]!;
      assert.deepEqual([account.email, account.email_key, account.email_verified_at, account.status], [null, null, null, "ACTIVE"]);
      const identity = (await pool.query("SELECT subject, linked_via, unlinked_at FROM host_account_identities WHERE host_account_id = $1", [result.hostAccountId])).rows;
      assert.deepEqual(identity.map((row) => [row.subject, row.linked_via, row.unlinked_at]), [[NIHO_A, "SELF_REGISTRATION", null]]);
      const events = (await pool.query("SELECT event_kind, via FROM host_account_identity_events WHERE host_account_id = $1", [result.hostAccountId])).rows;
      assert.deepEqual(events.map((row) => [row.event_kind, row.via]), [["LINKED", "SELF_REGISTRATION"]]);

      assert.equal(await count(pool, "experience_providers"), 1);
      assert.equal(await count(pool, "experience_provider_media_state"), 1);
      const profile = (await pool.query("SELECT * FROM experience_provider_public_profiles WHERE provider_id = $1", [result.providerId])).rows[0]!;
      assert.deepEqual(
        [profile.public_display_name, profile.public_display_name_en, profile.provider_kind, profile.consent_version, profile.consent_source, profile.consented_by_host_account_id, profile.consented_by_admin_niho_user_id],
        ["鎌倉の茶室", "Kamakura Tea Room", "PERSON", "host-terms-2026-11-28", "OWNER", result.hostAccountId, null],
      );
      const member = (await pool.query("SELECT role, active FROM provider_memberships WHERE provider_id = $1 AND niho_user_id = $2", [result.providerId, result.hostAccountId])).rows;
      assert.deepEqual(member.map((row) => [row.role, row.active]), [["OWNER", true]]);
      const record = (await pool.query("SELECT host_account_id, host_terms_version, host_terms_accepted_at FROM experience_provider_self_registrations WHERE provider_id = $1", [result.providerId])).rows[0]!;
      assert.deepEqual([record.host_account_id, record.host_terms_version, (record.host_terms_accepted_at as Date).toISOString()], [result.hostAccountId, "host-terms-2026-11-28", at(MINUTE)]);

      // The address waits for its link and is never a sign-in address.
      const pending = (await pool.query("SELECT niho_user_id, email FROM host_notification_address_confirmations")).rows;
      assert.deepEqual(pending.map((row) => [row.niho_user_id, row.email]), [[result.hostAccountId, "Tea@Example.com"]]);
      assert.equal((await pool.query("SELECT 1 FROM outbox_messages WHERE topic = 'host.mail.address_confirmation' AND provider_id = $1", [result.providerId])).rowCount, 1);
      assert.equal(await count(pool, "host_notification_addresses"), 0);

      const session = await accounts.readSession({ sessionToken: result.sessionToken, nowUtc: at(2 * MINUTE) });
      assert.equal(session?.hostAccountId, result.hostAccountId);
      assert.equal(session?.email, null);
      assert.equal(session?.authenticatedAtUtc, at(0));
    });
  });

  it("changes nothing for a NIHO account that already has a host account", async () => {
    await withStore(async ({ pool, identities }) => {
      await registered(identities, NIHO_A);
      const before = await snapshot(pool);
      assert.deepEqual(await identities.registerHostSelf({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(5 * MINUTE), ...form() }), { kind: "already-linked" });
      assert.deepEqual(await snapshot(pool), before);
      // At the same time: exactly one registration.
      const raced = await Promise.all([NIHO_B, NIHO_B].map((nihoUserId) => identities.registerHostSelf({ nihoUserId, authenticatedAtUtc: at(0), nowUtc: at(6 * MINUTE), ...form() })));
      assert.deepEqual(raced.map((result) => result.kind).sort(), ["already-linked", "registered"]);
      assert.equal(await count(pool, "experience_providers"), 2);
    });
  });

  it("leaves no host account or provider when a later step fails", async () => {
    await withStore(async ({ pool, identities }) => {
      const before = await snapshot(pool);
      // A new account has no earlier confirmation requests, so make late steps fail with a constraint instead.
      await pool.query("ALTER TABLE experience_provider_self_registrations ADD CONSTRAINT synthetic_failure CHECK (false) NOT VALID");
      await assert.rejects(identities.registerHostSelf({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(MINUTE), ...form() }));
      await pool.query("ALTER TABLE experience_provider_self_registrations DROP CONSTRAINT synthetic_failure");
      assert.deepEqual(await snapshot(pool), before);

      // The same when the very last step (the confirmation request) fails.
      await pool.query("ALTER TABLE host_notification_address_confirmations ADD CONSTRAINT synthetic_failure CHECK (false) NOT VALID");
      await assert.rejects(identities.registerHostSelf({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(MINUTE), ...form() }));
      await pool.query("ALTER TABLE host_notification_address_confirmations DROP CONSTRAINT synthetic_failure");
      assert.deepEqual(await snapshot(pool), before);
    });
  });

  it("rolls the whole registration back when asking for the confirmation email is rate limited", async () => {
    await withStore(async ({ pool, identities }) => {
      const first = await registered(identities, NIHO_A);
      // The person has used up the hour's confirmation requests.
      for (let i = 0; i < 5; i += 1) {
        await pool.query("INSERT INTO host_notification_address_confirmations (niho_user_id, email, cancelled_at) VALUES ($1, $2, clock_timestamp())", [first.hostAccountId, `earlier-${i}@example.com`]);
      }
      const before = await snapshot(pool);
      await assert.rejects(identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(2 * MINUTE), ...form({ notificationEmail: "another@example.com" }) }), StoreRateLimitedError);
      assert.deepEqual(await snapshot(pool), before);
    });
  });

  it("checks the input before writing anything", async () => {
    await withStore(async ({ pool, identities }) => {
      const before = await snapshot(pool);
      const attempt = (overrides: Record<string, unknown>) => identities.registerHostSelf({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(MINUTE), ...form(overrides) });
      await assert.rejects(attempt({ publicDisplayName: "NIHO 公式" }), (error) => error instanceof ProviderPublicNameError && error.code === "PUBLIC_NAME_RESERVED");
      await assert.rejects(attempt({ publicDisplayNameEn: "Support 事務局" }), ProviderPublicNameError);
      await assert.rejects(attempt({ publicDisplayName: " " }), StoreValidationError);
      await assert.rejects(attempt({ providerKind: "COMPANY" }), StoreValidationError);
      await assert.rejects(attempt({ hostTermsVersion: "" }), StoreValidationError);
      await assert.rejects(attempt({ notificationEmail: "not-an-address" }), StoreValidationError);
      await assert.rejects(identities.registerHostSelf({ nihoUserId: NIHO_A, authenticatedAtUtc: at(2 * MINUTE), nowUtc: at(MINUTE), ...form() }), StoreValidationError);
      await assert.rejects(identities.registerHostSelf({ nihoUserId: "hst_deadbeef", authenticatedAtUtc: at(0), nowUtc: at(MINUTE), ...form() }), StoreValidationError);
      assert.deepEqual(await snapshot(pool), before);
      // Without an English name the column is empty.
      const plain = await registered(identities, NIHO_A, 0, { publicDisplayNameEn: undefined });
      assert.equal((await pool.query("SELECT public_display_name_en FROM experience_provider_public_profiles WHERE provider_id = $1", [plain.providerId])).rows[0]!.public_display_name_en, null);
    });
  });

  it("adds a host to an existing account up to the limit, and not beyond", async () => {
    await withStore(async ({ pool, accounts, identities }) => {
      const first = await registered(identities, NIHO_A);
      const second = await identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(2 * MINUTE), ...form({ publicDisplayName: "二つ目", notificationEmail: "tea@example.com" }) });
      assert.equal(second.kind, "registered");
      // The same address as the first request: it is already waiting, so a new request replaces it.
      const third = await identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(3 * MINUTE), ...form({ publicDisplayName: "三つ目" }) });
      assert.equal(third.kind, "registered");
      assert.equal(HOST_PROVIDER_OWNER_LIMIT, 3);
      const before = await snapshot(pool);
      assert.deepEqual(await identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(4 * MINUTE), ...form({ publicDisplayName: "四つ目" }) }), { kind: "owner-limit-reached" });
      assert.deepEqual(await snapshot(pool), before);

      await accounts.suspendHostAccount({ actorId: "test-actor", hostAccountId: first.hostAccountId, nowUtc: at(5 * MINUTE) });
      assert.deepEqual(await identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(6 * MINUTE), ...form() }), { kind: "account-suspended" });
      assert.deepEqual(await snapshot(pool), before);
      await assert.rejects(identities.registerHostSelfForAccount({ hostAccountId: `hst_${"0".repeat(32)}`, nowUtc: at(6 * MINUTE), ...form() }), StoreNotFoundError);
    });
  });

  it("lets exactly one of two simultaneous registrations take the last place", async () => {
    await withStore(async ({ pool, identities }) => {
      const first = await registered(identities, NIHO_A);
      const second = await identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(2 * MINUTE), ...form({ notificationEmail: "two@example.com" }) });
      assert.equal(second.kind, "registered");
      const raced = await Promise.all([1, 2].map((n) =>
        identities.registerHostSelfForAccount({ hostAccountId: first.hostAccountId, nowUtc: at(3 * MINUTE), ...form({ publicDisplayName: `同時 ${n}`, notificationEmail: `race${n}@example.com` }) })));
      assert.deepEqual(raced.map((result) => result.kind).sort(), ["owner-limit-reached", "registered"]);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM provider_memberships WHERE niho_user_id = $1 AND role = 'OWNER' AND active", [first.hostAccountId])).rows[0]!.n), 3);
      assert.equal(await count(pool, "experience_providers"), 3);
    });
  });

  it("limits a host account to 3 active OWNER memberships in grantProviderOwnerIn and in the database", async () => {
    await withStore(async ({ pool, accounts }) => {
      await pool.query("INSERT INTO experience_providers (id) VALUES ('p1'), ('p2'), ('p3'), ('p4'), ('p5')");
      const { hostAccountId } = await accounts.provisionHostAccount({ email: "limit@example.com", nowUtc: at(0) });
      const grant = (providerId: string) => accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: at(MINUTE) });
      assert.deepEqual(await grant("p1"), { kind: "granted" });
      assert.deepEqual(await grant("p2"), { kind: "granted" });
      assert.deepEqual(await grant("p3"), { kind: "granted" });
      assert.deepEqual(await grant("p3"), { kind: "already-owner" });
      assert.deepEqual(await grant("p4"), { kind: "owner-limit-reached" });
      // The trigger: a direct write cannot make a 4th, by insert or by turning one on.
      await assert.rejects(pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ('p4', $1, 'OWNER', true)", [hostAccountId]), /at most 3 providers/);
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ('p4', $1, 'EDITOR', true), ('p5', $1, 'OWNER', false)", [hostAccountId]);
      await assert.rejects(pool.query("UPDATE provider_memberships SET role = 'OWNER' WHERE provider_id = 'p4' AND niho_user_id = $1", [hostAccountId]), /at most 3 providers/);
      await assert.rejects(pool.query("UPDATE provider_memberships SET active = true WHERE provider_id = 'p5' AND niho_user_id = $1", [hostAccountId]), /at most 3 providers/);
      // Giving one up makes room; the old NIHO user IDs are not limited.
      await pool.query("UPDATE provider_memberships SET active = false WHERE provider_id = 'p1' AND niho_user_id = $1", [hostAccountId]);
      await pool.query("UPDATE provider_memberships SET active = true WHERE provider_id = 'p5' AND niho_user_id = $1", [hostAccountId]);
      for (const provider of ["p1", "p2", "p3", "p4", "p5"]) await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ($1, 'niho-legacy-owner', 'OWNER', true)", [provider]);
      // An account counts under its own lock, in the caller's transaction as well.
      const other = (await accounts.provisionHostAccount({ email: "other@example.com", nowUtc: at(0) })).hostAccountId;
      assert.deepEqual(await withTransaction(pool, (client) => grantProviderOwnerIn(client, { providerId: "p1", hostAccountId: other, nowUtc: at(MINUTE) })), { kind: "granted" });
    });
  });

  it("allows an ADMIN or an OWNER consent, and no other combination", async () => {
    await withStore(async ({ pool, identities }) => {
      const host = await registered(identities, NIHO_A);
      await pool.query("INSERT INTO experience_providers (id) VALUES ('p-admin'), ('p-bad')");
      const insert = (providerId: string, source: string | null, admin: string | null, hostAccount: string | null) => pool.query(
        `INSERT INTO experience_provider_public_profiles (provider_id, public_display_name, consent_version, consented_at, consent_source, consented_by_admin_niho_user_id, consented_by_host_account_id)
         VALUES ($1, 'Synthetic', 'v1', clock_timestamp(), $2, $3, $4)`, [providerId, source, admin, hostAccount]);
      await insert("p-admin", "ADMIN", "niho-admin-synthetic", null);
      for (const [source, admin, hostAccount] of [
        ["ADMIN", null, null], ["ADMIN", "niho-admin-synthetic", host.hostAccountId], ["ADMIN", null, host.hostAccountId],
        ["OWNER", null, null], ["OWNER", "niho-admin-synthetic", host.hostAccountId], ["OWNER", "niho-admin-synthetic", null],
        ["STAFF", "niho-admin-synthetic", null], [null, "niho-admin-synthetic", null],
      ] as const) {
        await assert.rejects(insert("p-bad", source, admin, hostAccount), (error) => (error as { code?: string }).code === "23514" || (error as { code?: string }).code === "23502", `${source}/${admin}/${hostAccount}`);
      }
      // An OWNER's consent is replaced by an ADMIN's in one write, never mixed.
      await assert.rejects(pool.query("UPDATE experience_provider_public_profiles SET consent_source = 'ADMIN', consented_by_admin_niho_user_id = 'niho-admin-synthetic' WHERE provider_id = $1", [host.providerId]));
      await pool.query(
        "UPDATE experience_provider_public_profiles SET consent_source = 'ADMIN', consented_by_admin_niho_user_id = 'niho-admin-synthetic', consented_by_host_account_id = NULL WHERE provider_id = $1", [host.providerId]);
    });
  });

  it("keeps the registration record append-only", async () => {
    await withStore(async ({ pool, identities }) => {
      const host = await registered(identities, NIHO_A);
      await assert.rejects(pool.query("UPDATE experience_provider_self_registrations SET host_terms_version = 'other' WHERE provider_id = $1", [host.providerId]), /append-only/);
      await assert.rejects(pool.query("DELETE FROM experience_provider_self_registrations WHERE provider_id = $1", [host.providerId]), /append-only/);
      await assert.rejects(pool.query("INSERT INTO experience_provider_self_registrations (provider_id, host_account_id, host_terms_version, host_terms_accepted_at) VALUES ($1, $2, '', now())", [host.providerId, host.hostAccountId]));
    });
  });
});
