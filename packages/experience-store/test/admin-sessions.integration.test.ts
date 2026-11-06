import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { ADMIN_SESSION_LIMITS, AdminSessions, adminActorIdForGoogleSubject, isAdminActorId } from "../src/admin-sessions.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** Admin のログイン (ADR 0003 slice 4, migration 0066): Google sign-in sessions against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const ADMIN = adminActorIdForGoogleSubject("100000000000000000001");
const OTHER = adminActorIdForGoogleSubject("100000000000000000002");
const EMAIL = "admin.sample@niho.life";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withSessions(run: (context: { readonly pool: Pool; readonly sessions: AdminSessions }) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "admin_sessions", { max: 4 });
  try {
    await run({ pool: db.pool, sessions: new AdminSessions(db.pool) });
  } finally {
    await db.dispose();
  }
}

async function lastSeen(pool: Pool, sessionRef: string): Promise<string> {
  return ((await pool.query("SELECT last_seen_at FROM admin_sessions WHERE session_ref = $1", [sessionRef])).rows[0]!.last_seen_at as Date).toISOString();
}

describe("admin actor IDs", () => {
  it("derive `adm_` + 32 hex from the Google subject, never the address, stable and distinct per subject", () => {
    const expected = `adm_${createHash("sha256").update("google:100000000000000000001").digest("hex").slice(0, 32)}`;
    assert.equal(ADMIN, expected);
    assert.equal(adminActorIdForGoogleSubject("100000000000000000001"), ADMIN);
    assert.notEqual(OTHER, ADMIN);
    assert.equal(isAdminActorId(ADMIN), true);
    for (const value of ["hst_0123456789abcdef0123456789abcdef", "adm_0123", `adm_${"A".repeat(32)}`, "admin@niho.life", 1]) assert.equal(isAdminActorId(value), false, String(value));
    for (const sub of ["", "a b", "x".repeat(256), "é", null]) assert.throws(() => adminActorIdForGoogleSubject(sub), StoreValidationError, String(sub));
  });
});

describe("admin sessions", { skip: databaseUrl === undefined }, () => {
  it("open with a hashed token and a reference, and read back as the admin who signed in", async () => {
    await withSessions(async ({ pool, sessions }) => {
      const opened = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(0) });
      assert.match(opened.sessionToken, TOKEN);
      assert.match(opened.sessionRef, UUID);
      assert.equal(opened.adminActorId, ADMIN);
      assert.equal(opened.absoluteExpiresAtUtc, at(ADMIN_SESSION_LIMITS.sessionAbsoluteHours * HOUR));
      // Only the SHA-256 is stored; nothing from Google.
      const row = (await pool.query("SELECT * FROM admin_sessions")).rows[0]!;
      assert.deepEqual(row.session_hash, createHash("sha256").update(opened.sessionToken).digest());
      assert.equal(JSON.stringify(row).includes(opened.sessionToken), false);
      assert.deepEqual(Object.keys(row).sort(), [
        "absolute_expires_at", "admin_actor_id", "authenticated_at", "created_at", "email", "idle_expires_at", "last_seen_at", "revoked_at", "session_hash", "session_ref",
      ]);
      assert.deepEqual(await sessions.readSession({ sessionToken: opened.sessionToken, nowUtc: at(MINUTE) }), {
        adminActorId: ADMIN,
        email: EMAIL,
        sessionRef: opened.sessionRef,
        authenticatedAtUtc: at(0),
        idleExpiresAtUtc: at(2 * HOUR),
        absoluteExpiresAtUtc: at(12 * HOUR),
      });
      // A reference or a malformed value opens nothing.
      assert.equal(await sessions.readSession({ sessionToken: opened.sessionRef, nowUtc: at(MINUTE) }), null);
      assert.equal(await sessions.readSession({ sessionToken: "x".repeat(43), nowUtc: at(MINUTE) }), null);
    });
  });

  it("refuses an address that is not lower case and an actor ID that is not an admin's", async () => {
    await withSessions(async ({ sessions }) => {
      await assert.rejects(sessions.openSession({ adminActorId: ADMIN, email: "Admin.Sample@niho.life", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(sessions.openSession({ adminActorId: "hst_0123456789abcdef0123456789abcdef", email: EMAIL, nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: "2026-11-07" }), StoreValidationError);
    });
  });

  it("ends after 2 idle hours, slides the idle end at most every 5 minutes, and never past 12 hours", async () => {
    await withSessions(async ({ pool, sessions }) => {
      const opened = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(0) });
      const read = (offsetMs: number) => sessions.readSession({ sessionToken: opened.sessionToken, nowUtc: at(offsetMs) });
      // Within the touch interval the last use stays.
      assert.equal((await read(4 * MINUTE))?.idleExpiresAtUtc, at(2 * HOUR));
      assert.equal(await lastSeen(pool, opened.sessionRef), at(0));
      // After it, the read moves the idle end.
      assert.equal((await read(90 * MINUTE))?.idleExpiresAtUtc, at(90 * MINUTE + 2 * HOUR));
      assert.equal(await lastSeen(pool, opened.sessionRef), at(90 * MINUTE));
      // Unused for 2 hours: ended.
      assert.equal(await read(90 * MINUTE + 2 * HOUR), null);

      const kept = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(0) });
      const keep = (offsetMs: number) => sessions.readSession({ sessionToken: kept.sessionToken, nowUtc: at(offsetMs) });
      for (let hour = 1; hour < 12; hour += 1) assert.ok(await keep(hour * HOUR), `hour ${hour}`);
      assert.equal((await keep(11 * HOUR + 30 * MINUTE))?.idleExpiresAtUtc, at(12 * HOUR));
      assert.equal(await keep(12 * HOUR), null);
    });
  });

  it("signs one session out by its cookie value, or every session of an admin", async () => {
    await withSessions(async ({ sessions }) => {
      const first = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(0) });
      const second = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(SECOND) });
      const other = await sessions.openSession({ adminActorId: OTHER, email: "other.sample@niho.life", nowUtc: at(SECOND) });
      assert.equal(await sessions.revokeSession({ sessionToken: first.sessionToken, nowUtc: at(MINUTE) }), true);
      assert.equal(await sessions.revokeSession({ sessionToken: first.sessionToken, nowUtc: at(MINUTE) }), false);
      assert.equal(await sessions.revokeSession({ sessionToken: first.sessionRef, nowUtc: at(MINUTE) }), false);
      assert.equal(await sessions.readSession({ sessionToken: first.sessionToken, nowUtc: at(2 * MINUTE) }), null);
      assert.ok(await sessions.readSession({ sessionToken: second.sessionToken, nowUtc: at(2 * MINUTE) }));

      assert.equal(await sessions.revokeActorSessions({ adminActorId: ADMIN, nowUtc: at(3 * MINUTE) }), 1);
      assert.equal(await sessions.readSession({ sessionToken: second.sessionToken, nowUtc: at(4 * MINUTE) }), null);
      assert.ok(await sessions.readSession({ sessionToken: other.sessionToken, nowUtc: at(4 * MINUTE) }));
      await assert.rejects(sessions.revokeActorSessions({ adminActorId: "admin@niho.life", nowUtc: at(0) }), StoreValidationError);
    });
  });

  it("purges signed-out, idle and expired sessions and keeps open ones", async () => {
    await withSessions(async ({ pool, sessions }) => {
      const open = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(10 * HOUR) });
      const revoked = await sessions.openSession({ adminActorId: ADMIN, email: EMAIL, nowUtc: at(10 * HOUR) });
      await sessions.revokeSession({ sessionToken: revoked.sessionToken, nowUtc: at(10 * HOUR + MINUTE) });
      await sessions.openSession({ adminActorId: OTHER, email: "other.sample@niho.life", nowUtc: at(0) });
      const count = async () => Number((await pool.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n);
      assert.equal(await count(), 3);
      // The idle one (opened at 0, unused since) and the revoked one go; the open one stays.
      assert.equal(await sessions.purgeExpired({ nowUtc: at(11 * HOUR), limit: 1 }), 1);
      assert.equal(await sessions.purgeExpired({ nowUtc: at(11 * HOUR), limit: 10 }), 1);
      assert.equal(await sessions.purgeExpired({ nowUtc: at(11 * HOUR), limit: 10 }), 0);
      assert.equal(await count(), 1);
      assert.ok(await sessions.readSession({ sessionToken: open.sessionToken, nowUtc: at(11 * HOUR) }));
      await assert.rejects(sessions.purgeExpired({ nowUtc: at(0), limit: 0 }), StoreValidationError);
      await assert.rejects(sessions.purgeExpired({ nowUtc: at(0), limit: ADMIN_SESSION_LIMITS.purgeLimitMax + 1 }), StoreValidationError);
    });
  });
});
