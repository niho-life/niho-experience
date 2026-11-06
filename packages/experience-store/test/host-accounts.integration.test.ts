import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { HOST_ACCOUNT_LIMITS, HostAccounts, isHostAccountId, normalizeHostEmail, type HostLoginLinkIssue, type HostLoginResult } from "../src/host-accounts.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** ホストのアカウント (ADR 0003, migration 0064): accounts, sign-in links and sessions against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
/** What the web layer passes: the SHA-256 of the random value in the requesting browser's cookie. */
const browser = (label: string): Buffer => sha256(`synthetic-browser-${label}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type Sent = Extract<HostLoginLinkIssue, { kind: "send" }>;
type Opened = Extract<HostLoginResult, { kind: "ok" }>;

interface Context {
  readonly pool: Pool;
  readonly accounts: HostAccounts;
}

async function withAccounts(run: (context: Context) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_accounts", { max: 4 });
  try {
    await run({ pool: db.pool, accounts: new HostAccounts(db.pool) });
  } finally {
    await db.dispose();
  }
}

async function provision(accounts: HostAccounts, email: string, offsetMs = 0): Promise<string> {
  return (await accounts.provisionHostAccount({ email, nowUtc: at(offsetMs) })).hostAccountId;
}

/** The mail job's run: exactly one link is due, and it is minted. */
async function mint(accounts: HostAccounts, offsetMs: number): Promise<Sent> {
  const pending = await accounts.listPendingLoginRequests({ nowUtc: at(offsetMs), limit: 10 });
  assert.equal(pending.length, 1);
  const issued = await accounts.issueLoginLink({ requestId: pending[0]!, nowUtc: at(offsetMs) });
  assert.equal(issued.kind, "send");
  return issued as Sent;
}

/** Asks for a link at `offsetMs` in browser `label`, the job mints it a second later: the raw token the email carries. */
async function linkFor(accounts: HostAccounts, email: string, offsetMs: number, label = "a"): Promise<Sent> {
  assert.deepEqual(await accounts.requestLogin({ email, browserBindingHash: browser(label), nowUtc: at(offsetMs) }), { kind: "accepted" });
  return mint(accounts, offsetMs + SECOND);
}

/** A full sign-in: asked at `offsetMs`, opened two seconds later in the same browser. */
async function signIn(accounts: HostAccounts, email: string, offsetMs: number, label = "a"): Promise<Opened> {
  const sent = await linkFor(accounts, email, offsetMs, label);
  const opened = await accounts.consumeLogin({ token: sent.token, browserBindingHash: browser(label), nowUtc: at(offsetMs + 2 * SECOND) });
  assert.equal(opened.kind, "ok");
  return opened as Opened;
}

async function requestCount(pool: Pool, hostAccountId: string): Promise<number> {
  return Number((await pool.query("SELECT count(*)::int AS n FROM host_login_requests WHERE host_account_id = $1", [hostAccountId])).rows[0]!.n);
}

async function lastSeen(pool: Pool, sessionRef: string): Promise<string> {
  return ((await pool.query("SELECT last_seen_at FROM host_sessions WHERE session_ref = $1", [sessionRef])).rows[0]!.last_seen_at as Date).toISOString();
}

describe("host account email addresses", () => {
  it("normalizes an address to its account key: trimmed, NFKC, lower case", () => {
    assert.equal(normalizeHostEmail("  Host.Sample@Example.COM \n"), "host.sample@example.com");
    assert.equal(normalizeHostEmail("ｈｏｓｔ＠ｅｘａｍｐｌｅ．ｃｏｍ"), "host@example.com");
    assert.equal(normalizeHostEmail(`${"a".repeat(242)}@example.com`).length, 254);
  });

  it("refuses what is not one address of at most 254 characters", () => {
    for (const bad of ["", "   ", "host", "host@example", "@example.com", "host@@example.com", "host@exa mple.com", "ho st@example.com",
      "host​@example.com", "host@example.com\u0000", `${"a".repeat(243)}@example.com`, 42, null, undefined]) {
      assert.throws(() => normalizeHostEmail(bad), StoreValidationError, String(bad));
    }
  });

  it("recognizes host account IDs only", () => {
    assert.equal(isHostAccountId(`hst_${"0a".repeat(16)}`), true);
    for (const bad of ["hst_", `hst_${"A".repeat(32)}`, `hst-${"0".repeat(32)}`, "niho-user-1", `hst_${"0".repeat(33)}`, 1]) {
      assert.equal(isHostAccountId(bad), false, String(bad));
    }
  });
});

describe("PostgreSQL host accounts (ADR 0003)", { skip: databaseUrl === undefined }, () => {
  it("provisions one account per address, the same again whatever its case", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      const first = await accounts.provisionHostAccount({ email: " Host@Example.com ", nowUtc: at(0) });
      assert.equal(first.created, true);
      assert.equal(isHostAccountId(first.hostAccountId), true);
      assert.deepEqual(await accounts.provisionHostAccount({ email: "host@EXAMPLE.com", nowUtc: at(MINUTE) }), { hostAccountId: first.hostAccountId, created: false });
      const other = await accounts.provisionHostAccount({ email: "other@example.com", nowUtc: at(MINUTE) });
      assert.equal(other.created, true);
      assert.notEqual(other.hostAccountId, first.hostAccountId);
      const row = (await pool.query("SELECT * FROM host_accounts WHERE id = $1", [first.hostAccountId])).rows[0]!;
      assert.equal(row.email, "Host@Example.com");
      assert.equal(row.email_key, "host@example.com");
      assert.equal(row.status, "ACTIVE");
      assert.equal(row.session_version, 1);
      assert.equal(row.email_verified_at, null);
      assert.equal((row.created_at as Date).toISOString(), at(0));
      await assert.rejects(accounts.provisionHostAccount({ email: "not-an-address", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(accounts.provisionHostAccount({ email: "host@example.com", nowUtc: "2026-11-07T00:00:00Z" }), StoreValidationError);
    });
  });

  it("answers every link request alike and queues one only for an active account within its limits", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      const active = await provision(accounts, "active@example.com");
      const suspended = await provision(accounts, "suspended@example.com");
      await accounts.suspendHostAccount({ hostAccountId: suspended, nowUtc: at(0) });
      const ask = (email: string, offsetMs: number) => accounts.requestLogin({ email, browserBindingHash: browser("a"), nowUtc: at(offsetMs) });

      const unknown = await ask("nobody@example.com", 0);
      const refused = await ask("suspended@example.com", 0);
      const queued = await ask("Active@Example.com", 0);
      assert.deepEqual(unknown, queued);
      assert.deepEqual(refused, queued);
      assert.deepEqual(queued, { kind: "accepted" });
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM host_login_requests")).rows[0]!.n), 1);
      assert.equal(await requestCount(pool, suspended), 0);

      // 30 seconds apart: a second request just before is answered alike and queues nothing.
      assert.deepEqual(await ask("active@example.com", 30 * SECOND - 1), queued);
      assert.equal(await requestCount(pool, active), 1);
      for (const offset of [30, 60, 90, 120]) assert.deepEqual(await ask("active@example.com", offset * SECOND), queued);
      assert.equal(await requestCount(pool, active), HOST_ACCOUNT_LIMITS.loginRequestsPerWindow);
      // Five in the rolling hour: the sixth is answered alike and queues nothing until the first leaves the window.
      assert.deepEqual(await ask("active@example.com", 30 * MINUTE), queued);
      assert.equal(await requestCount(pool, active), 5);
      assert.deepEqual(await ask("active@example.com", HOUR - 1), queued);
      assert.equal(await requestCount(pool, active), 5);
      assert.deepEqual(await ask("active@example.com", HOUR), queued);
      assert.equal(await requestCount(pool, active), 6);

      // The queue entries carry IDs and hashes only: no address, and no token until the job mints it.
      const rows = (await pool.query("SELECT row_to_json(r)::text AS json, token_hash, expires_at, created_at FROM host_login_requests r")).rows;
      for (const row of rows) {
        assert.equal(String(row.json).includes("example.com"), false);
        assert.equal(row.token_hash, null);
        assert.equal((row.expires_at as Date).getTime() - (row.created_at as Date).getTime(), HOST_ACCOUNT_LIMITS.linkTtlMinutes * MINUTE);
      }
      await assert.rejects(ask("not-an-address", 0), StoreValidationError);
      await assert.rejects(accounts.requestLogin({ email: "active@example.com", browserBindingHash: Buffer.alloc(16), nowUtc: at(0) }), StoreValidationError);
    });
  });

  it("mints each link once for the mail job and skips one that can no longer be sent", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      await provision(accounts, "Host@Example.com");
      await accounts.requestLogin({ email: "host@example.com", browserBindingHash: browser("a"), nowUtc: at(0) });
      const [requestId] = await accounts.listPendingLoginRequests({ nowUtc: at(MINUTE), limit: 10 });
      const issued = await accounts.issueLoginLink({ requestId: requestId!, nowUtc: at(MINUTE) });
      assert.equal(issued.kind, "send");
      const sent = issued as Sent;
      assert.match(sent.token, TOKEN);
      assert.equal(sent.toEmail, "Host@Example.com");
      assert.equal(sent.expiresAtUtc, at(HOST_ACCOUNT_LIMITS.linkTtlMinutes * MINUTE));
      const stored = (await pool.query("SELECT token_hash, issued_at, row_to_json(r)::text AS json FROM host_login_requests r WHERE id = $1", [requestId])).rows[0]!;
      assert.deepEqual(stored.token_hash, sha256(sent.token));
      assert.equal((stored.issued_at as Date).toISOString(), at(MINUTE));
      assert.equal(String(stored.json).includes(sent.token), false);
      // Once: the same request again, or the next run, mints nothing.
      assert.deepEqual(await accounts.issueLoginLink({ requestId: requestId!, nowUtc: at(2 * MINUTE) }), { kind: "skip" });
      assert.deepEqual(await accounts.listPendingLoginRequests({ nowUtc: at(2 * MINUTE), limit: 10 }), []);

      // Two job runs racing on one request: one mints it.
      await accounts.requestLogin({ email: "host@example.com", browserBindingHash: browser("a"), nowUtc: at(3 * MINUTE) });
      const [raced] = await accounts.listPendingLoginRequests({ nowUtc: at(4 * MINUTE), limit: 10 });
      const both = await Promise.all([1, 2].map(() => accounts.issueLoginLink({ requestId: raced!, nowUtc: at(4 * MINUTE) })));
      assert.deepEqual(both.map((result) => result.kind).sort(), ["send", "skip"]);

      // Expired before the job got to it.
      await accounts.requestLogin({ email: "host@example.com", browserBindingHash: browser("a"), nowUtc: at(5 * MINUTE) });
      const [late] = await accounts.listPendingLoginRequests({ nowUtc: at(6 * MINUTE), limit: 10 });
      assert.deepEqual(await accounts.listPendingLoginRequests({ nowUtc: at(20 * MINUTE), limit: 10 }), []);
      assert.deepEqual(await accounts.issueLoginLink({ requestId: late!, nowUtc: at(20 * MINUTE) }), { kind: "skip" });

      // The account was suspended after it asked.
      const other = await provision(accounts, "other@example.com");
      await accounts.requestLogin({ email: "other@example.com", browserBindingHash: browser("a"), nowUtc: at(21 * MINUTE) });
      const [suspendedRequest] = await accounts.listPendingLoginRequests({ nowUtc: at(21 * MINUTE), limit: 10 });
      await accounts.suspendHostAccount({ hostAccountId: other, nowUtc: at(22 * MINUTE) });
      assert.deepEqual(await accounts.listPendingLoginRequests({ nowUtc: at(22 * MINUTE), limit: 10 }), []);
      assert.deepEqual(await accounts.issueLoginLink({ requestId: suspendedRequest!, nowUtc: at(22 * MINUTE) }), { kind: "skip" });

      assert.deepEqual(await accounts.issueLoginLink({ requestId: "00000000-0000-4000-8000-000000000000", nowUtc: at(0) }), { kind: "skip" });
      await assert.rejects(accounts.issueLoginLink({ requestId: "not-a-uuid", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(accounts.listPendingLoginRequests({ nowUtc: at(0), limit: HOST_ACCOUNT_LIMITS.pendingLimitMax + 1 }), StoreValidationError);
    });
  });

  it("opens one session per link, once, even when two tabs open it at the same time", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      const id = await provision(accounts, "host@example.com");
      const sent = await linkFor(accounts, "host@example.com", 0);
      const consume = () => accounts.consumeLogin({ token: sent.token, browserBindingHash: browser("a"), nowUtc: at(2 * MINUTE) });
      const results = await Promise.all([consume(), consume()]);
      assert.deepEqual(results.map((result) => result.kind).sort(), ["invalid", "ok"]);
      assert.deepEqual(await consume(), { kind: "invalid" });
      const opened = results.find((result) => result.kind === "ok") as Opened;
      assert.match(opened.sessionToken, TOKEN);
      assert.match(opened.sessionRef, UUID);
      assert.equal(opened.hostAccountId, id);
      assert.equal(opened.absoluteExpiresAtUtc, at(2 * MINUTE + HOST_ACCOUNT_LIMITS.sessionAbsoluteDays * DAY));
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM host_sessions")).rows[0]!.n), 1);
      const session = (await pool.query("SELECT session_hash, row_to_json(s)::text AS json FROM host_sessions s")).rows[0]!;
      assert.deepEqual(session.session_hash, sha256(opened.sessionToken));
      assert.equal(String(session.json).includes(opened.sessionToken), false);
      const account = (await pool.query("SELECT email_verified_at FROM host_accounts WHERE id = $1", [id])).rows[0]!;
      assert.equal((account.email_verified_at as Date).toISOString(), at(2 * MINUTE));
      const request = (await pool.query("SELECT consumed_at FROM host_login_requests")).rows[0]!;
      assert.equal((request.consumed_at as Date).toISOString(), at(2 * MINUTE));
    });
  });

  it("refuses a link in another browser, once expired, and for a suspended or signed-out account", async () => {
    await withAccounts(async ({ accounts }) => {
      const id = await provision(accounts, "host@example.com");
      const sent = await linkFor(accounts, "host@example.com", 0, "laptop");
      const open = (token: string, label: string, offsetMs: number) => accounts.consumeLogin({ token, browserBindingHash: browser(label), nowUtc: at(offsetMs) });
      // Another browser cannot use it, and does not spend it for the browser that asked.
      assert.deepEqual(await open(sent.token, "phone", MINUTE), { kind: "invalid" });
      assert.deepEqual(await accounts.consumeLogin({ token: sent.token, browserBindingHash: Buffer.alloc(31), nowUtc: at(MINUTE) }), { kind: "invalid" });
      assert.deepEqual(await accounts.consumeLogin({ token: "not-a-token", browserBindingHash: browser("laptop"), nowUtc: at(MINUTE) }), { kind: "invalid" });
      assert.deepEqual(await accounts.consumeLogin({ token: "A".repeat(43), browserBindingHash: browser("laptop"), nowUtc: at(MINUTE) }), { kind: "invalid" });
      assert.equal((await open(sent.token, "laptop", MINUTE)).kind, "ok");

      // Fifteen minutes from the request, not from the email.
      const expiring = await linkFor(accounts, "host@example.com", HOUR, "laptop");
      assert.deepEqual(await open(expiring.token, "laptop", HOUR + HOST_ACCOUNT_LIMITS.linkTtlMinutes * MINUTE), { kind: "invalid" });
      assert.equal((await open(expiring.token, "laptop", HOUR + HOST_ACCOUNT_LIMITS.linkTtlMinutes * MINUTE - 1)).kind, "ok");

      // Suspended after the email went out: the link stays dead after a reactivation too.
      const beforeSuspension = await linkFor(accounts, "host@example.com", 2 * HOUR, "laptop");
      assert.equal(await accounts.suspendHostAccount({ hostAccountId: id, nowUtc: at(2 * HOUR + MINUTE) }), "CHANGED");
      assert.deepEqual(await open(beforeSuspension.token, "laptop", 2 * HOUR + 2 * MINUTE), { kind: "invalid" });
      assert.equal(await accounts.reactivateHostAccount({ hostAccountId: id, nowUtc: at(2 * HOUR + 3 * MINUTE) }), "CHANGED");
      assert.deepEqual(await open(beforeSuspension.token, "laptop", 2 * HOUR + 4 * MINUTE), { kind: "invalid" });

      // Signed out everywhere after the email went out.
      const beforeSignOut = await linkFor(accounts, "host@example.com", 3 * HOUR, "laptop");
      await accounts.revokeAllSessions({ hostAccountId: id, nowUtc: at(3 * HOUR + MINUTE) });
      assert.deepEqual(await open(beforeSignOut.token, "laptop", 3 * HOUR + 2 * MINUTE), { kind: "invalid" });
      // A new link after either works.
      assert.equal((await signIn(accounts, "host@example.com", 4 * HOUR, "laptop")).hostAccountId, id);
    });
  });

  it("reads a session until it ends, touching it at most hourly and sliding the idle end up to the absolute one", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      const id = await provision(accounts, "Host@Example.com");
      const opened = await signIn(accounts, "host@example.com", 0);
      const c = 2 * SECOND;
      const read = (offsetMs: number, token = opened.sessionToken) => accounts.readSession({ sessionToken: token, nowUtc: at(offsetMs) });
      assert.deepEqual(await read(c), {
        hostAccountId: id, email: "Host@Example.com", sessionRef: opened.sessionRef, authenticatedAtUtc: at(c),
        idleExpiresAtUtc: at(c + HOST_ACCOUNT_LIMITS.sessionIdleDays * DAY), absoluteExpiresAtUtc: opened.absoluteExpiresAtUtc,
      });
      // Within the hour nothing is written.
      assert.equal((await read(c + 30 * MINUTE))?.idleExpiresAtUtc, at(c + 14 * DAY));
      assert.equal(await lastSeen(pool, opened.sessionRef), at(c));
      // After an hour the use is written and the idle end moves.
      const touched = await read(c + 61 * MINUTE);
      assert.equal(touched?.idleExpiresAtUtc, at(c + 61 * MINUTE + 14 * DAY));
      assert.equal(touched?.authenticatedAtUtc, at(c));
      assert.equal(await lastSeen(pool, opened.sessionRef), at(c + 61 * MINUTE));
      // 14 idle days end it.
      assert.equal(await read(c + 61 * MINUTE + 14 * DAY), null);

      // A session used every 13 days still ends 30 days after it opened.
      const kept = await signIn(accounts, "host@example.com", HOUR);
      const k = HOUR + 2 * SECOND;
      assert.equal((await read(k + 13 * DAY, kept.sessionToken))?.idleExpiresAtUtc, at(k + 27 * DAY));
      assert.equal((await read(k + 26 * DAY, kept.sessionToken))?.idleExpiresAtUtc, kept.absoluteExpiresAtUtc);
      assert.notEqual(await read(k + 30 * DAY - 1, kept.sessionToken), null);
      assert.equal(await read(k + 30 * DAY, kept.sessionToken), null);
      assert.equal(await read(0, "not-a-session"), null);
      assert.equal(await read(0, "A".repeat(43)), null);
    });
  });

  it("signs out one session by its cookie or by its reference, and the reference never opens it", async () => {
    await withAccounts(async ({ accounts }) => {
      const id = await provision(accounts, "host@example.com");
      const other = await provision(accounts, "other@example.com");
      const laptop = await signIn(accounts, "host@example.com", 0, "laptop");
      const phone = await signIn(accounts, "host@example.com", MINUTE, "phone");
      const read = (token: string) => accounts.readSession({ sessionToken: token, nowUtc: at(HOUR) });

      // The reference is not a credential: it reads nothing and signs nothing out as a cookie value.
      assert.notEqual(laptop.sessionRef, phone.sessionRef);
      assert.equal(await read(laptop.sessionRef), null);
      assert.equal(await read(Buffer.from(laptop.sessionRef.replaceAll("-", ""), "hex").toString("base64url").padEnd(43, "A")), null);
      assert.equal(await accounts.revokeSession({ sessionToken: laptop.sessionRef, nowUtc: at(HOUR) }), false);
      assert.equal((await read(laptop.sessionToken))?.sessionRef, laptop.sessionRef);

      // Another account cannot sign out this one's device by its reference.
      assert.equal(await accounts.revokeSession({ hostAccountId: other, sessionRef: phone.sessionRef, nowUtc: at(HOUR) }), false);
      assert.equal(await accounts.revokeSession({ hostAccountId: id, sessionRef: "not-a-uuid", nowUtc: at(HOUR) }), false);
      assert.notEqual(await read(phone.sessionToken), null);
      // The host signs the phone out from the laptop.
      assert.equal(await accounts.revokeSession({ hostAccountId: id, sessionRef: phone.sessionRef.toUpperCase(), nowUtc: at(HOUR) }), true);
      assert.equal(await read(phone.sessionToken), null);
      assert.equal(await accounts.revokeSession({ hostAccountId: id, sessionRef: phone.sessionRef, nowUtc: at(HOUR) }), false);
      // And then the laptop itself.
      assert.equal(await accounts.revokeSession({ sessionToken: laptop.sessionToken, nowUtc: at(HOUR) }), true);
      assert.equal(await read(laptop.sessionToken), null);
      assert.equal(await accounts.revokeSession({ sessionToken: laptop.sessionToken, nowUtc: at(HOUR) }), false);
      await assert.rejects(accounts.revokeSession({ hostAccountId: "niho-user-1", sessionRef: phone.sessionRef, nowUtc: at(HOUR) }), StoreValidationError);
    });
  });

  it("signs out everywhere and ends every session of a suspended account for good", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      const id = await provision(accounts, "host@example.com");
      const bystander = await provision(accounts, "bystander@example.com");
      const one = await signIn(accounts, "host@example.com", 0, "laptop");
      const two = await signIn(accounts, "host@example.com", MINUTE, "phone");
      const theirs = await signIn(accounts, "bystander@example.com", 2 * MINUTE);
      const read = (token: string, offsetMs = HOUR) => accounts.readSession({ sessionToken: token, nowUtc: at(offsetMs) });

      await accounts.revokeAllSessions({ hostAccountId: id, nowUtc: at(10 * MINUTE) });
      assert.equal(await read(one.sessionToken), null);
      assert.equal(await read(two.sessionToken), null);
      assert.equal((await read(theirs.sessionToken))?.hostAccountId, bystander);
      assert.equal((await pool.query("SELECT session_version FROM host_accounts WHERE id = $1", [id])).rows[0]!.session_version, 2);
      const again = await signIn(accounts, "host@example.com", 20 * MINUTE);
      assert.notEqual(await read(again.sessionToken), null);

      assert.equal(await accounts.suspendHostAccount({ hostAccountId: id, nowUtc: at(HOUR) }), "CHANGED");
      assert.equal(await accounts.suspendHostAccount({ hostAccountId: id, nowUtc: at(HOUR) }), "UNCHANGED");
      assert.equal(await read(again.sessionToken, 2 * HOUR), null);
      // A suspended account gets no link, answered alike.
      assert.deepEqual(await accounts.requestLogin({ email: "host@example.com", browserBindingHash: browser("a"), nowUtc: at(2 * HOUR) }), { kind: "accepted" });
      assert.deepEqual(await accounts.listPendingLoginRequests({ nowUtc: at(2 * HOUR), limit: 10 }), []);
      assert.equal(await accounts.reactivateHostAccount({ hostAccountId: id, nowUtc: at(3 * HOUR) }), "CHANGED");
      assert.equal(await accounts.reactivateHostAccount({ hostAccountId: id, nowUtc: at(3 * HOUR) }), "UNCHANGED");
      assert.equal(await read(again.sessionToken, 3 * HOUR), null);
      const afterReactivation = await signIn(accounts, "host@example.com", 4 * HOUR);
      assert.equal((await read(afterReactivation.sessionToken, 5 * HOUR))?.hostAccountId, id);

      const unknown = `hst_${"0".repeat(32)}`;
      await assert.rejects(accounts.revokeAllSessions({ hostAccountId: unknown, nowUtc: at(0) }), StoreNotFoundError);
      await assert.rejects(accounts.suspendHostAccount({ hostAccountId: unknown, nowUtc: at(0) }), StoreNotFoundError);
      await assert.rejects(accounts.reactivateHostAccount({ hostAccountId: unknown, nowUtc: at(0) }), StoreNotFoundError);
      await assert.rejects(accounts.suspendHostAccount({ hostAccountId: "niho-user-1", nowUtc: at(0) }), StoreValidationError);
    });
  });

  it("purges requests older than the limit's window and ended sessions, bounded per call", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      await provision(accounts, "a@example.com");
      await provision(accounts, "b@example.com");
      await provision(accounts, "c@example.com");
      const a = await signIn(accounts, "a@example.com", 0);
      const b = await signIn(accounts, "b@example.com", MINUTE);
      await accounts.revokeSession({ sessionToken: b.sessionToken, nowUtc: at(2 * MINUTE) });
      const c = await signIn(accounts, "c@example.com", 50 * MINUTE);
      // A request the job never got to (left last, so the sign-ins above each saw one pending link).
      await accounts.requestLogin({ email: "a@example.com", browserBindingHash: browser("a"), nowUtc: at(2 * MINUTE) });
      const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);

      // An hour after the first requests: one per table at most per call.
      assert.equal(await accounts.purgeExpired({ nowUtc: at(HOUR + 2 * MINUTE), limit: 1 }), 2);
      assert.equal(await accounts.purgeExpired({ nowUtc: at(HOUR + 2 * MINUTE), limit: 10 }), 2);
      assert.equal(await accounts.purgeExpired({ nowUtc: at(HOUR + 2 * MINUTE), limit: 10 }), 0);
      // The request of the 50th minute still counts towards the hourly limit; live sessions stay.
      assert.equal(await count("host_login_requests"), 1);
      assert.equal(await count("host_sessions"), 2);
      assert.notEqual(await accounts.readSession({ sessionToken: a.sessionToken, nowUtc: at(HOUR + 2 * MINUTE) }), null);
      assert.notEqual(await accounts.readSession({ sessionToken: c.sessionToken, nowUtc: at(HOUR + 2 * MINUTE) }), null);

      // After 14 idle days both sessions are gone, and the last request too.
      assert.equal(await accounts.purgeExpired({ nowUtc: at(15 * DAY), limit: 10 }), 3);
      assert.equal(await count("host_login_requests"), 0);
      assert.equal(await count("host_sessions"), 0);
      assert.equal(await count("host_accounts"), 3);
      await assert.rejects(accounts.purgeExpired({ nowUtc: at(0), limit: 0 }), StoreValidationError);
      await assert.rejects(accounts.purgeExpired({ nowUtc: at(0), limit: HOST_ACCOUNT_LIMITS.purgeLimitMax + 1 }), StoreValidationError);
    });
  });

  it("gives a host account the first host OWNER membership of a provider, under the provisioning paths' invariants", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b'), ('provider-c'), ('provider-d')");
      const first = await provision(accounts, "first@example.com");
      const second = await provision(accounts, "second@example.com");
      const editor = await provision(accounts, "editor@example.com");
      const suspended = await provision(accounts, "suspended@example.com");
      await accounts.suspendHostAccount({ hostAccountId: suspended, nowUtc: at(0) });
      const grant = (providerId: string, hostAccountId: string) => accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: at(MINUTE) });

      assert.deepEqual(await grant("provider-a", first), { kind: "granted" });
      const row = (await pool.query("SELECT role, active, created_at FROM provider_memberships WHERE provider_id = 'provider-a' AND niho_user_id = $1", [first])).rows[0]!;
      assert.deepEqual([row.role, row.active, (row.created_at as Date).toISOString()], ["OWNER", true, at(MINUTE)]);
      assert.deepEqual(await grant("provider-a", first), { kind: "already-owner" });
      // One provider per OWNER account; one host-account OWNER registered per provider by this path.
      assert.deepEqual(await grant("provider-b", first), { kind: "owner-of-another-provider" });
      assert.deepEqual(await grant("provider-a", second), { kind: "provider-has-host-owner" });
      // A NIHO user's OWNER membership (the current sign-in) does not block the host account, and stays.
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ('provider-b', 'niho-owner-b', 'OWNER', true)");
      assert.deepEqual(await grant("provider-b", second), { kind: "granted" });
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM provider_memberships WHERE provider_id = 'provider-b' AND role = 'OWNER' AND active")).rows[0]!.n), 2);
      // An existing role or an inactive membership is never changed here.
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ('provider-c', $1, 'EDITOR', true)", [editor]);
      assert.deepEqual(await grant("provider-c", editor), { kind: "membership-conflict" });
      assert.equal((await pool.query("SELECT role FROM provider_memberships WHERE provider_id = 'provider-c' AND niho_user_id = $1", [editor])).rows[0]!.role, "EDITOR");
      assert.deepEqual(await grant("provider-c", suspended), { kind: "host-account-not-active" });
      assert.deepEqual(await grant("provider-c", `hst_${"0".repeat(32)}`), { kind: "host-account-not-active" });
      assert.deepEqual(await grant("provider-missing", second), { kind: "provider-not-found" });
      await assert.rejects(accounts.grantProviderOwner({ providerId: "", hostAccountId: first, nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(accounts.grantProviderOwner({ providerId: "provider-d", hostAccountId: "niho-owner-b", nowUtc: at(0) }), StoreValidationError);

      // Two accounts registered for one provider at the same time: one becomes its OWNER.
      const racerA = await provision(accounts, "racer-a@example.com");
      const racerB = await provision(accounts, "racer-b@example.com");
      const raced = await Promise.all([grant("provider-d", racerA), grant("provider-d", racerB)]);
      assert.deepEqual(raced.map((result) => result.kind).sort(), ["granted", "provider-has-host-owner"]);
    });
  });

  it("lists an account's OWNER and EDITOR providers for /host by name, with or without a NIHO seller profile", async () => {
    await withAccounts(async ({ pool, accounts }) => {
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-named'), ('provider-bare'), ('provider-viewer'), ('provider-inactive'), ('provider-other')");
      // Only one provider has a (NIHO-era) seller profile: its name is used; the others fall back to their ID.
      await pool.query(
        `INSERT INTO experience_host_seller_profiles (provider_id, legacy_provider_id, provider_display_name, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name)
         VALUES ('provider-named', 'legacy-named', 'Zen Kitchen', 'niho-user-synthetic', 'acct_synthetic12345678', 'Synthetic seller')`,
      );
      const host = await provision(accounts, "host@example.com");
      const other = await provision(accounts, "other@example.com");
      assert.deepEqual(await accounts.grantProviderOwner({ providerId: "provider-bare", hostAccountId: host, nowUtc: at(0) }), { kind: "granted" });
      await pool.query(
        `INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES
           ('provider-named', $1, 'EDITOR', true), ('provider-viewer', $1, 'VIEWER', true), ('provider-inactive', $1, 'EDITOR', false),
           ('provider-other', $2, 'OWNER', true)`,
        [host, other],
      );

      // By name in byte order (COLLATE "C", as listHostProviders): "Zen Kitchen" before "provider-bare".
      assert.deepEqual(await accounts.listProviderMemberships({ hostAccountId: host }), [
        { providerId: "provider-named", displayName: "Zen Kitchen", memberRole: "EDITOR", legacyProviderId: "legacy-named" },
        { providerId: "provider-bare", displayName: "provider-bare", memberRole: "OWNER", legacyProviderId: null },
      ]);
      assert.deepEqual((await accounts.listProviderMemberships({ hostAccountId: other })).map((row) => row.providerId), ["provider-other"]);
      // A suspended or unknown account opens nothing; a NIHO user ID is not a host account ID.
      await accounts.suspendHostAccount({ hostAccountId: host, nowUtc: at(MINUTE) });
      assert.deepEqual(await accounts.listProviderMemberships({ hostAccountId: host }), []);
      assert.deepEqual(await accounts.listProviderMemberships({ hostAccountId: `hst_${"0".repeat(32)}` }), []);
      await assert.rejects(accounts.listProviderMemberships({ hostAccountId: "niho-user-synthetic" }), StoreValidationError);
    });
  });
});
