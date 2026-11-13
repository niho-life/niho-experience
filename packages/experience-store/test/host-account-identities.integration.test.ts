import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { HostAccountIdentities, linkNihoIdentityIn } from "../src/host-account-identities.ts";
import { HOST_ACCOUNT_LIMITS, HostAccounts, type HostLoginLinkIssue, type HostLoginResult } from "../src/host-accounts.ts";
import { withTransaction } from "../src/transaction.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** ログインを NIHO アカウントへ揃える (#593, migration 0083): bindings, the session a NIHO sign-in opens, the audit trail. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const browser = (label: string): Buffer => createHash("sha256").update(`synthetic-browser-${label}`, "utf8").digest();
const NIHO_A = "niho-user-synthetic-a";
const NIHO_B = "niho-user-synthetic-b";

type Opened = Extract<HostLoginResult, { kind: "ok" }>;

interface Context {
  readonly pool: Pool;
  readonly accounts: HostAccounts;
  readonly identities: HostAccountIdentities;
}

async function withIdentities(run: (context: Context) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_identities", { max: 6 });
  try {
    await run({ pool: db.pool, accounts: new HostAccounts(db.pool), identities: new HostAccountIdentities(db.pool) });
  } finally {
    await db.dispose();
  }
}

const provision = async (accounts: HostAccounts, email: string): Promise<string> => (await accounts.provisionHostAccount({ email, nowUtc: at(0) })).hostAccountId;

/** A sign-in by the emailed link at `offsetMs` (the migration-period method): the session a host is in when they open 設定. */
async function emailSession(accounts: HostAccounts, email: string, offsetMs: number): Promise<Opened> {
  await accounts.requestLogin({ email, browserBindingHash: browser("a"), nowUtc: at(offsetMs) });
  const pending = await accounts.listPendingLoginRequests({ nowUtc: at(offsetMs + SECOND), limit: 10 });
  const issued: HostLoginLinkIssue = await accounts.issueLoginLink({ requestId: pending.at(-1)!, nowUtc: at(offsetMs + SECOND) });
  assert.equal(issued.kind, "send");
  const opened = await accounts.consumeLogin({ token: (issued as Extract<HostLoginLinkIssue, { kind: "send" }>).token, browserBindingHash: browser("a"), nowUtc: at(offsetMs + 2 * SECOND) });
  assert.equal(opened.kind, "ok");
  return opened as Opened;
}

const events = async (pool: Pool, hostAccountId: string): Promise<readonly string[]> =>
  (await pool.query("SELECT event_kind, via, coalesce(reason, '') AS reason FROM host_account_identity_events WHERE host_account_id = $1 ORDER BY occurred_at, id", [hostAccountId]))
    .rows.map((row) => `${row.event_kind}/${row.via}${row.reason ? `/${row.reason}` : ""}`);

describe("host account NIHO identities", () => {
  it("binds a NIHO account, opens a session for it, and leaves the host account's roles and history as they were", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-synthetic')");
      const host = await provision(accounts, "owner@example.com");
      assert.deepEqual(await accounts.grantProviderOwner({ providerId: "provider-synthetic", hostAccountId: host, nowUtc: at(0) }), { kind: "granted" });
      const rowsBefore = {
        account: (await pool.query("SELECT * FROM host_accounts WHERE id = $1", [host])).rows,
        memberships: (await pool.query("SELECT * FROM provider_memberships WHERE niho_user_id = $1", [host])).rows,
        providers: await accounts.listProviderMemberships({ hostAccountId: host }),
      };
      assert.equal(await identities.readNihoIdentity({ hostAccountId: host }), null);
      assert.deepEqual(await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(MINUTE), nowUtc: at(MINUTE) }), { kind: "not-linked" });

      // The OWNER is in 設定 with a session from the emailed link; they come back from NIHO a minute later.
      const settings = await emailSession(accounts, "owner@example.com", 10 * MINUTE);
      const rowsAfterEmail = (await pool.query("SELECT * FROM host_accounts WHERE id = $1", [host])).rows;
      assert.deepEqual(
        await identities.linkNihoIdentity({
          hostAccountId: host,
          nihoUserId: NIHO_A,
          proof: { kind: "SESSION", sessionRef: settings.sessionRef, nihoAuthenticatedAtUtc: at(10 * MINUTE + 30 * SECOND) },
          nowUtc: at(11 * MINUTE),
        }),
        { kind: "linked" },
      );
      const status = await identities.readNihoIdentity({ hostAccountId: host });
      assert.deepEqual(status, { linkedAtUtc: at(11 * MINUTE), lastLoginAtUtc: null, linkedVia: "SETTINGS" });
      // The status never carries the NIHO user ID.
      assert.equal(JSON.stringify(status).includes(NIHO_A), false);

      // The NIHO sign-in: NIHO's auth_time (a few minutes before the code exchange) is the session's authenticated_at.
      const opened = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(HOUR - 5 * MINUTE), nowUtc: at(HOUR) });
      assert.equal(opened.kind, "ok");
      const session = opened as Opened;
      assert.equal(session.hostAccountId, host);
      assert.match(session.sessionToken, /^[A-Za-z0-9_-]{43}$/);
      const read = await accounts.readSession({ sessionToken: session.sessionToken, nowUtc: at(HOUR + MINUTE) });
      assert.equal(read?.hostAccountId, host);
      assert.equal(read?.sessionRef, session.sessionRef);
      assert.equal(read?.authenticatedAtUtc, at(HOUR - 5 * MINUTE));
      assert.equal(session.absoluteExpiresAtUtc, at(HOUR + 30 * 24 * HOUR));
      assert.equal((await identities.readNihoIdentity({ hostAccountId: host }))?.lastLoginAtUtc, at(HOUR));

      // Roles, seller-facing memberships and the account row are exactly as before; the binding only added its own rows.
      assert.deepEqual((await pool.query("SELECT * FROM provider_memberships WHERE niho_user_id = $1", [host])).rows, rowsBefore.memberships);
      assert.deepEqual(await accounts.listProviderMemberships({ hostAccountId: host }), rowsBefore.providers);
      assert.deepEqual((await pool.query("SELECT * FROM host_accounts WHERE id = $1", [host])).rows, rowsAfterEmail);
      assert.equal(rowsBefore.account[0]!.id, host);
      assert.deepEqual(await events(pool, host), ["LINKED/SETTINGS"]);

      // Signing out ends it like any session, and the NIHO sign-in can open another.
      assert.equal(await accounts.revokeSession({ sessionToken: session.sessionToken, nowUtc: at(HOUR + 2 * MINUTE) }), true);
      assert.equal(await accounts.readSession({ sessionToken: session.sessionToken, nowUtc: at(HOUR + 3 * MINUTE) }), null);
      const again = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(2 * HOUR), nowUtc: at(2 * HOUR) });
      assert.equal(again.kind, "ok");
      // The email link still opens a session whose authenticated_at is the link's use, as before.
      const viaEmail = await emailSession(accounts, "owner@example.com", 3 * HOUR);
      assert.equal((await accounts.readSession({ sessionToken: viaEmail.sessionToken, nowUtc: at(3 * HOUR + MINUTE) }))?.authenticatedAtUtc, at(3 * HOUR + 2 * SECOND));
    });
  });

  it("binds one NIHO account to one host account at a time, records each refusal, and treats the same pair as already done", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const first = await provision(accounts, "first@example.com");
      const second = await provision(accounts, "second@example.com");
      const ops = (hostAccountId: string, nihoUserId: string, offsetMs: number) => identities.linkNihoIdentity({ hostAccountId, nihoUserId, proof: { kind: "OPS" }, nowUtc: at(offsetMs) });

      assert.deepEqual(await ops(first, NIHO_A, MINUTE), { kind: "linked" });
      assert.deepEqual(await ops(first, NIHO_A, 2 * MINUTE), { kind: "already-linked" });
      // A NIHO account never moves to another host account while bound; the other host account is not touched.
      assert.deepEqual(await ops(second, NIHO_A, 3 * MINUTE), { kind: "identity-in-use" });
      assert.equal(await identities.readNihoIdentity({ hostAccountId: second }), null);
      // A host account does not take a second NIHO account.
      assert.deepEqual(await ops(first, NIHO_B, 4 * MINUTE), { kind: "account-has-identity" });
      assert.deepEqual(await ops(second, NIHO_B, 5 * MINUTE), { kind: "linked" });
      assert.deepEqual(await events(pool, first), ["LINKED/OPS", "LINK_REFUSED/OPS/ACCOUNT_HAS_IDENTITY"]);
      assert.deepEqual(await events(pool, second), ["LINK_REFUSED/OPS/IDENTITY_IN_USE", "LINKED/OPS"]);

      // Two requests for one NIHO account at once: exactly one wins.
      const third = await provision(accounts, "third@example.com");
      const fourth = await provision(accounts, "fourth@example.com");
      const raced = await Promise.all([ops(third, "niho-user-raced", 6 * MINUTE), ops(fourth, "niho-user-raced", 6 * MINUTE)]);
      assert.deepEqual(raced.map((result) => result.kind).sort(), ["identity-in-use", "linked"]);
    });
  });

  it("asks for the host's recent session and a recent NIHO sign-in before binding, and checks whose session it is", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const host = await provision(accounts, "proof@example.com");
      const other = await provision(accounts, "other-proof@example.com");
      const session = await emailSession(accounts, "proof@example.com", 0);
      const otherSession = await emailSession(accounts, "other-proof@example.com", 0);
      const link = (sessionRef: string, nihoAuthenticatedAtUtc: string, nowOffsetMs: number, hostAccountId = host) =>
        identities.linkNihoIdentity({ hostAccountId, nihoUserId: NIHO_A, proof: { kind: "SESSION", sessionRef, nihoAuthenticatedAtUtc }, nowUtc: at(nowOffsetMs) });
      const window = HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes * MINUTE;

      // The session's sign-in is older than the window.
      assert.deepEqual(await link(session.sessionRef, at(window + 2 * MINUTE), window + 3 * MINUTE), { kind: "recent-authentication-required" });
      // NIHO's sign-in is older than the window (the session is fresh).
      assert.deepEqual(await link(session.sessionRef, at(-1 * HOUR), 5 * MINUTE), { kind: "recent-authentication-required" });
      // A sign-in from the future is not recent either.
      assert.deepEqual(await link(session.sessionRef, at(10 * MINUTE), 5 * MINUTE), { kind: "recent-authentication-required" });
      // Another host account's session proves nothing for this one, and a session that was signed out neither.
      assert.deepEqual(await link(otherSession.sessionRef, at(4 * MINUTE), 5 * MINUTE), { kind: "recent-authentication-required" });
      assert.deepEqual(await link("00000000-0000-4000-8000-000000000000", at(4 * MINUTE), 5 * MINUTE), { kind: "recent-authentication-required" });
      assert.equal(await accounts.revokeSession({ hostAccountId: other, sessionRef: otherSession.sessionRef, nowUtc: at(6 * MINUTE) }), true);
      assert.deepEqual(await link(otherSession.sessionRef, at(7 * MINUTE), 8 * MINUTE, other), { kind: "recent-authentication-required" });
      assert.equal(await identities.readNihoIdentity({ hostAccountId: host }), null);
      assert.equal((await events(pool, host)).every((entry) => entry === "LINK_REFUSED/SETTINGS/RECENT_AUTHENTICATION_REQUIRED"), true);
      assert.equal((await events(pool, host)).length, 5);

      // Fresh on both sides: bound.
      assert.deepEqual(await link(session.sessionRef, at(window - MINUTE), window - 30 * SECOND), { kind: "linked" });
      assert.equal(await identities.readNihoIdentity({ hostAccountId: other }), null);
    });
  });

  it("opens no session for a suspended account or a signed-out-everywhere version, and binds only an ACTIVE account", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const host = await provision(accounts, "suspend@example.com");
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: { kind: "OPS" }, nowUtc: at(MINUTE) }), { kind: "linked" });
      const before = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(2 * MINUTE), nowUtc: at(2 * MINUTE) });
      assert.equal(before.kind, "ok");

      // "Sign out everywhere" ends that session; the NIHO sign-in opens one at the new version.
      await accounts.revokeAllSessions({ hostAccountId: host, nowUtc: at(3 * MINUTE) });
      assert.equal(await accounts.readSession({ sessionToken: (before as Opened).sessionToken, nowUtc: at(4 * MINUTE) }), null);
      const after = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(4 * MINUTE), nowUtc: at(4 * MINUTE) });
      assert.equal(after.kind, "ok");
      assert.notEqual(await accounts.readSession({ sessionToken: (after as Opened).sessionToken, nowUtc: at(5 * MINUTE) }), null);

      await accounts.suspendHostAccount({ hostAccountId: host, nowUtc: at(6 * MINUTE) });
      assert.equal(await accounts.readSession({ sessionToken: (after as Opened).sessionToken, nowUtc: at(7 * MINUTE) }), null);
      assert.deepEqual(await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(8 * MINUTE), nowUtc: at(8 * MINUTE) }), { kind: "account-suspended" });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_sessions WHERE revoked_at IS NULL")).rows[0]!.n, 0);

      const another = await provision(accounts, "suspend-other@example.com");
      await accounts.suspendHostAccount({ hostAccountId: another, nowUtc: at(9 * MINUTE) });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: another, nihoUserId: NIHO_B, proof: { kind: "OPS" }, nowUtc: at(10 * MINUTE) }), { kind: "host-account-not-active" });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: `hst_${"0".repeat(32)}`, nihoUserId: NIHO_B, proof: { kind: "OPS" }, nowUtc: at(10 * MINUTE) }), { kind: "host-account-not-active" });
    });
  });

  it("unbinds, keeps the row, refuses the last way in, and lets the NIHO account go to another host account afterwards", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const host = await provision(accounts, "unlink@example.com");
      const next = await provision(accounts, "unlink-next@example.com");
      const settings = await emailSession(accounts, "unlink@example.com", 0);
      assert.deepEqual(await identities.unlinkNihoIdentity({ hostAccountId: host, proof: { kind: "OPS" }, nowUtc: at(MINUTE) }), { kind: "not-linked" });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: { kind: "OPS" }, nowUtc: at(2 * MINUTE) }), { kind: "linked" });

      const session = (ref: string, emailSignInAvailable: boolean) => ({ kind: "SESSION" as const, sessionRef: ref, emailSignInAvailable });
      // Without the email link nothing else would let the host in: refused and recorded. With it: allowed.
      assert.deepEqual(await identities.unlinkNihoIdentity({ hostAccountId: host, proof: session(settings.sessionRef, false), nowUtc: at(3 * MINUTE) }), { kind: "last-sign-in-method" });
      assert.notEqual(await identities.readNihoIdentity({ hostAccountId: host }), null);
      // A session that is no longer recent cannot unbind; the host signs in again by the link and can.
      assert.deepEqual(await identities.unlinkNihoIdentity({ hostAccountId: host, proof: session(settings.sessionRef, true), nowUtc: at(40 * MINUTE) }), { kind: "recent-authentication-required" });
      const fresh = await emailSession(accounts, "unlink@example.com", 45 * MINUTE);
      assert.deepEqual(await identities.unlinkNihoIdentity({ hostAccountId: host, proof: session(fresh.sessionRef, true), nowUtc: at(46 * MINUTE) }), { kind: "unlinked" });
      assert.equal(await identities.readNihoIdentity({ hostAccountId: host }), null);
      assert.deepEqual(await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(47 * MINUTE), nowUtc: at(47 * MINUTE) }), { kind: "not-linked" });
      assert.deepEqual(await events(pool, host), [
        "LINKED/OPS",
        "UNLINK_REFUSED/SETTINGS/LAST_SIGN_IN_METHOD",
        "UNLINK_REFUSED/SETTINGS/RECENT_AUTHENTICATION_REQUIRED",
        "UNLINKED/SETTINGS",
      ]);

      // The row is history now: the same host account binds again as a new row, and the released NIHO account is free.
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: next, nihoUserId: NIHO_A, proof: { kind: "OPS" }, nowUtc: at(48 * MINUTE) }), { kind: "linked" });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_B, proof: { kind: "OPS" }, nowUtc: at(49 * MINUTE) }), { kind: "linked" });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identities WHERE host_account_id = $1", [host])).rows[0]!.n, 2);
      // Ops unbinds whatever the way in (a wrong binding is fixed by hand).
      assert.deepEqual(await identities.unlinkNihoIdentity({ hostAccountId: host, proof: { kind: "OPS" }, nowUtc: at(50 * MINUTE) }), { kind: "unlinked" });
    });
  });

  it("binds inside the caller's transaction for an invitation, and rolls back with it", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const host = await provision(accounts, "invited@example.com");
      await assert.rejects(
        withTransaction(pool, async (client) => {
          assert.deepEqual(await linkNihoIdentityIn(client, { hostAccountId: host, nihoUserId: NIHO_A, via: "INVITATION", nowUtc: at(MINUTE) }), { kind: "linked" });
          throw new Error("the invitation could not be consumed");
        }),
        /could not be consumed/,
      );
      assert.equal(await identities.readNihoIdentity({ hostAccountId: host }), null);
      assert.deepEqual(await events(pool, host), []);
      await withTransaction(pool, async (client) => {
        assert.deepEqual(await linkNihoIdentityIn(client, { hostAccountId: host, nihoUserId: NIHO_A, via: "INVITATION", nowUtc: at(2 * MINUTE) }), { kind: "linked" });
      });
      assert.equal((await identities.readNihoIdentity({ hostAccountId: host }))?.linkedVia, "INVITATION");
      await withTransaction(pool, async (client) => {
        await assert.rejects(linkNihoIdentityIn(client, { hostAccountId: host, nihoUserId: NIHO_A, via: "WEB" as "OPS", nowUtc: at(3 * MINUTE) }), StoreValidationError);
      });
    });
  });

  it("validates its inputs and keeps the binding rows and the audit trail from being rewritten", async () => {
    await withIdentities(async ({ pool, accounts, identities }) => {
      const host = await provision(accounts, "validate@example.com");
      const ops = { kind: "OPS" as const };
      for (const nihoUserId of ["", "x".repeat(257), "a\nb", "​hidden", `hst_${"a".repeat(32)}`, `sel_${"a".repeat(32)}`, 7 as unknown as string]) {
        await assert.rejects(identities.linkNihoIdentity({ hostAccountId: host, nihoUserId, proof: ops, nowUtc: at(0) }), StoreValidationError, String(nihoUserId));
      }
      await assert.rejects(identities.linkNihoIdentity({ hostAccountId: "niho-owner", nihoUserId: NIHO_A, proof: ops, nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: ops, nowUtc: "yesterday" }), StoreValidationError);
      await assert.rejects(identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: { kind: "EMAIL" } as never, nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: { kind: "SESSION", sessionRef: "not-a-uuid", nihoAuthenticatedAtUtc: at(0) }, nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(MINUTE), nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(-401 * 24 * HOUR), nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: "now", nowUtc: at(0) }), StoreValidationError);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identities")).rows[0]!.n, 0);

      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: host, nihoUserId: NIHO_A, proof: ops, nowUtc: at(MINUTE) }), { kind: "linked" });
      // The binding changes by its last sign-in and by unlinking only; the audit trail by nothing.
      await assert.rejects(pool.query("UPDATE host_account_identities SET subject = 'niho-user-other' WHERE host_account_id = $1", [host]), /only changes by its last sign-in/);
      await assert.rejects(pool.query("UPDATE host_account_identities SET linked_via = 'SETTINGS' WHERE host_account_id = $1", [host]), /only changes/);
      await assert.rejects(pool.query("DELETE FROM host_account_identities WHERE host_account_id = $1", [host]), /never deleted/);
      await assert.rejects(pool.query("UPDATE host_account_identity_events SET via = 'OPS'"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM host_account_identity_events"), /append-only/);
      await identities.unlinkNihoIdentity({ hostAccountId: host, proof: ops, nowUtc: at(2 * MINUTE) });
      await assert.rejects(pool.query("UPDATE host_account_identities SET last_login_at = $2 WHERE host_account_id = $1", [host, at(3 * MINUTE)]), /immutable/);
      // A NIHO user ID is not a host account or seller reference, in the table as in the API.
      await assert.rejects(pool.query("INSERT INTO host_account_identities (host_account_id, provider, subject, linked_via, linked_at) VALUES ($1, 'NIHO', $2, 'OPS', $3)", [host, `hst_${"b".repeat(32)}`, at(0)]), /check/);
    });
  });
});
