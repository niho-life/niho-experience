import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { TRAVELER_ACCOUNT_LIMITS, TravelerAccounts, isTravelerAccountId, type TravelerSignInResult } from "../src/traveler-accounts.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 旅行者のアカウント (#597, migration 0085): accounts and sessions against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const NIHO_A = "niho-user-synthetic-traveler-a";
const NIHO_B = "niho-user-synthetic-traveler-b";

type Opened = Extract<TravelerSignInResult, { kind: "ok" }>;

async function withTravelers(run: (context: { pool: Pool; travelers: TravelerAccounts }) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "traveler_accounts", { max: 4 });
  try {
    await run({ pool: db.pool, travelers: new TravelerAccounts(db.pool) });
  } finally {
    await db.dispose();
  }
}

describe("traveler accounts", () => {
  it("makes the account at the first sign-in, finds it again by the NIHO user ID, and opens a session each time", async () => {
    await withTravelers(async ({ pool, travelers }) => {
      const first = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(-5 * MINUTE), nowUtc: at(0) });
      assert.equal(first.kind, "ok");
      const a = first as Opened;
      assert.equal(a.created, true);
      assert.ok(isTravelerAccountId(a.travelerAccountId));
      assert.match(a.sessionToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(a.absoluteExpiresAtUtc, at(30 * DAY));

      const read = await travelers.readSession({ sessionToken: a.sessionToken, nowUtc: at(MINUTE) });
      assert.deepEqual(read, { travelerAccountId: a.travelerAccountId, sessionRef: a.sessionRef, authenticatedAtUtc: at(-5 * MINUTE), idleExpiresAtUtc: at(14 * DAY), absoluteExpiresAtUtc: at(30 * DAY) });

      // The same NIHO account again: the same account, a second session; another NIHO account: another account.
      const again = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) }) as Opened;
      assert.equal(again.created, false);
      assert.equal(again.travelerAccountId, a.travelerAccountId);
      assert.notEqual(again.sessionToken, a.sessionToken);
      const other = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) }) as Opened;
      assert.notEqual(other.travelerAccountId, a.travelerAccountId);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM traveler_accounts")).rows[0]!.n, 2);
      // Only the SHA-256 of a session is stored; the NIHO user ID is stored (the one personal datum) and nothing else about the person.
      const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'traveler_accounts' ORDER BY column_name")).rows.map((row) => row.column_name);
      assert.deepEqual(columns, ["created_at", "id", "last_login_at", "provider", "session_version", "status", "subject", "suspended_at"]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM traveler_sessions WHERE session_hash = $1", [Buffer.from(a.sessionToken)])).rows[0]!.n, 0);
    });
  });

  it("signs a session out, ends it after its idle days and its 30 days, and slides the idle end hourly", async () => {
    await withTravelers(async ({ travelers }) => {
      const a = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as Opened;
      const b = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as Opened;
      assert.equal(await travelers.revokeSession({ sessionToken: a.sessionToken, nowUtc: at(MINUTE) }), true);
      assert.equal(await travelers.revokeSession({ sessionToken: a.sessionToken, nowUtc: at(MINUTE) }), false);
      assert.equal(await travelers.readSession({ sessionToken: a.sessionToken, nowUtc: at(2 * MINUTE) }), null);
      // The other session is not touched, and a use after an hour moves the idle end.
      const used = await travelers.readSession({ sessionToken: b.sessionToken, nowUtc: at(10 * DAY) });
      assert.equal(used?.idleExpiresAtUtc, at(24 * DAY));
      assert.equal((await travelers.readSession({ sessionToken: b.sessionToken, nowUtc: at(23 * DAY) }))?.idleExpiresAtUtc, at(30 * DAY));
      assert.equal(await travelers.readSession({ sessionToken: b.sessionToken, nowUtc: at(30 * DAY + MINUTE) }), null);
      // Malformed and unknown values are just no session.
      assert.equal(await travelers.readSession({ sessionToken: "short", nowUtc: at(0) }), null);
      assert.equal(await travelers.readSession({ sessionToken: "x".repeat(43), nowUtc: at(0) }), null);
      assert.equal(await travelers.revokeSession({ sessionToken: "short", nowUtc: at(0) }), false);
    });
  });

  it("ends every session of a suspended account, signs it in no more, and cleans up the account's ended sessions at a sign-in", async () => {
    await withTravelers(async ({ pool, travelers }) => {
      const a = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as Opened;
      assert.equal(await travelers.suspendTravelerAccount({ travelerAccountId: a.travelerAccountId, nowUtc: at(MINUTE) }), "CHANGED");
      assert.equal(await travelers.suspendTravelerAccount({ travelerAccountId: a.travelerAccountId, nowUtc: at(MINUTE) }), "UNCHANGED");
      assert.equal(await travelers.readSession({ sessionToken: a.sessionToken, nowUtc: at(2 * MINUTE) }), null);
      assert.deepEqual(await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) }), { kind: "account-suspended" });
      await assert.rejects(travelers.suspendTravelerAccount({ travelerAccountId: `trv_${"0".repeat(32)}`, nowUtc: at(0) }), StoreNotFoundError);

      // An active account's ended sessions go at its next sign-in; its live one stays.
      const b = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(0), nowUtc: at(0) }) as Opened;
      const c = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(0), nowUtc: at(DAY) }) as Opened;
      await travelers.revokeSession({ sessionToken: b.sessionToken, nowUtc: at(2 * DAY) });
      const d = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(3 * DAY), nowUtc: at(3 * DAY) }) as Opened;
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM traveler_sessions WHERE traveler_account_id = $1", [b.travelerAccountId])).rows[0]!.n, 2);
      assert.notEqual(await travelers.readSession({ sessionToken: c.sessionToken, nowUtc: at(3 * DAY) }), null);
      assert.notEqual(await travelers.readSession({ sessionToken: d.sessionToken, nowUtc: at(3 * DAY) }), null);
      assert.ok(TRAVELER_ACCOUNT_LIMITS.purgePerSignIn >= 1);
    });
  });

  it("is a different account from a host account, in other tables, and a NIHO user ID is never a host or traveler reference", async () => {
    await withTravelers(async ({ pool, travelers }) => {
      const hosts = new HostAccounts(pool);
      const host = await hosts.provisionHostAccount({ email: "also-traveler@example.com", nowUtc: at(0) });
      const traveler = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as Opened;
      assert.notEqual(traveler.travelerAccountId, host.hostAccountId);
      assert.match(traveler.travelerAccountId, /^trv_/);
      // A traveler session token opens nothing on the host side, and the other way round.
      assert.equal(await hosts.readSession({ sessionToken: traveler.sessionToken, nowUtc: at(MINUTE) }), null);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_sessions")).rows[0]!.n, 0);
      const hostSession = await (async () => {
        await hosts.requestLogin({ email: "also-traveler@example.com", browserBindingHash: Buffer.alloc(32, 1), nowUtc: at(0) });
        const [pending] = await hosts.listPendingLoginRequests({ nowUtc: at(SECOND), limit: 5 });
        const issued = await hosts.issueLoginLink({ requestId: pending!, nowUtc: at(SECOND) });
        assert.equal(issued.kind, "send");
        const opened = await hosts.consumeLogin({ token: (issued as { token: string }).token, browserBindingHash: Buffer.alloc(32, 1), nowUtc: at(2 * SECOND) });
        assert.equal(opened.kind, "ok");
        return (opened as { sessionToken: string }).sessionToken;
      })();
      assert.equal(await travelers.readSession({ sessionToken: hostSession, nowUtc: at(MINUTE) }), null);
      for (const nihoUserId of [`hst_${"a".repeat(32)}`, `sel_${"a".repeat(32)}`, `trv_${"a".repeat(32)}`, "", "x".repeat(257), "a\nb", "​hidden", 7 as unknown as string]) {
        await assert.rejects(travelers.signInWithNihoIdentity({ nihoUserId, authenticatedAtUtc: at(0), nowUtc: at(0) }), StoreValidationError, String(nihoUserId));
      }
      await assert.rejects(travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(MINUTE), nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(-401 * DAY), nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: "now", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(pool.query("INSERT INTO traveler_accounts (id, provider, subject, created_at) VALUES ($1, 'NIHO', $2, $3)", [`trv_${"b".repeat(32)}`, `hst_${"c".repeat(32)}`, at(0)]), /check/);
    });
  });

  it("makes one account when the same NIHO account signs in twice at once", async () => {
    await withTravelers(async ({ pool, travelers }) => {
      const results = await Promise.all([1, 2, 3].map(() => travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) })));
      assert.equal(results.filter((result) => result.kind === "ok" && result.created).length, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM traveler_accounts")).rows[0]!.n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM traveler_sessions")).rows[0]!.n, 3);
    });
  });
});
