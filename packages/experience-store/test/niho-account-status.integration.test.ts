import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { HostAccountIdentities } from "../src/host-account-identities.ts";
import { NihoAccountStatusStore } from "../src/niho-account-status.ts";
import { TravelerAccounts, type TravelerSignInResult } from "../src/traveler-accounts.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** S1b (#627, migration 0087): status-based expiry and merge against the real schema, synthetic identities only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const NIHO_A = "niho-user-synthetic-status-a";
const NIHO_B = "niho-user-synthetic-status-b";

type TravelerOpened = Extract<TravelerSignInResult, { kind: "ok" }>;

async function withStatusStore(run: (context: {
  pool: Pool;
  identities: HostAccountIdentities;
  travelers: TravelerAccounts;
  status: NihoAccountStatusStore;
}) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "niho_account_status", { max: 8 });
  try {
    await run({
      pool: db.pool,
      identities: new HostAccountIdentities(db.pool),
      travelers: new TravelerAccounts(db.pool),
      status: new NihoAccountStatusStore(db.pool),
    });
  } finally {
    await db.dispose();
  }
}

describe("NIHO account status (#627)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("checks no more than every 15 minutes and ends every linked session for inactive or unknown accounts", async () => {
    await withStatusStore(async ({ pool, identities, travelers, status }) => {
      const host = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) });
      assert.equal(host.kind, "ok");
      if (host.kind !== "ok") return;
      const traveler = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as TravelerOpened;

      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: host.sessionToken, nowUtc: at(0) }), { kind: "check", nihoUserId: NIHO_A });
      assert.deepEqual(await status.applyStatus({ kind: "host", sessionToken: host.sessionToken, nihoUserId: NIHO_A, result: { status: "active" }, nowUtc: at(0) }), { kind: "active" });
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: host.sessionToken, nowUtc: at(15 * MINUTE - 1) }), { kind: "fresh" });
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: host.sessionToken, nowUtc: at(15 * MINUTE) }), { kind: "check", nihoUserId: NIHO_A });

      assert.deepEqual(await status.applyStatus({ kind: "host", sessionToken: host.sessionToken, nihoUserId: NIHO_A, result: { status: "inactive" }, nowUtc: at(15 * MINUTE) }), { kind: "ended", conflicts: [] });
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: host.sessionToken, nowUtc: at(16 * MINUTE) }), { kind: "session-ended" });
      assert.deepEqual(await status.prepareCheck({ kind: "traveler", sessionToken: traveler.sessionToken, nowUtc: at(16 * MINUTE) }), { kind: "session-ended" });
      assert.equal((await pool.query("SELECT status FROM host_accounts WHERE id=$1", [host.hostAccountId])).rows[0]?.status, "ACTIVE");
      assert.equal((await pool.query("SELECT status FROM traveler_accounts WHERE id=$1", [traveler.travelerAccountId])).rows[0]?.status, "ACTIVE");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identities WHERE subject=$1 AND unlinked_at IS NULL", [NIHO_A])).rows[0]?.n, 1);

      const hostAgain = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) });
      const travelerAgain = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) });
      assert.equal(hostAgain.kind, "ok");
      assert.equal(travelerAgain.kind, "ok");

      const unknown = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(HOUR), nowUtc: at(HOUR) });
      assert.equal(unknown.kind, "ok");
      if (unknown.kind !== "ok") return;
      assert.deepEqual(await status.applyStatus({ kind: "host", sessionToken: unknown.sessionToken, nihoUserId: NIHO_B, result: { status: "unknown" }, nowUtc: at(HOUR + MINUTE) }), { kind: "ended", conflicts: [] });
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: unknown.sessionToken, nowUtc: at(HOUR + 2 * MINUTE) }), { kind: "session-ended" });
    });
  });

  it("moves host/writer and traveler bindings to the merged ID without changing Experience account IDs", async () => {
    await withStatusStore(async ({ pool, identities, travelers, status }) => {
      const host = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) });
      assert.equal(host.kind, "ok");
      if (host.kind !== "ok") return;
      const traveler = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as TravelerOpened;

      assert.deepEqual(await status.applyStatus({
        kind: "host",
        sessionToken: host.sessionToken,
        nihoUserId: NIHO_A,
        result: { status: "merged", currentUserId: NIHO_B },
        nowUtc: at(MINUTE),
      }), { kind: "merged", conflicts: [] });

      const history = await pool.query<{ subject: string; linked_via: string; unlinked_at: Date | null }>(
        "SELECT subject,linked_via,unlinked_at FROM host_account_identities WHERE host_account_id=$1 ORDER BY linked_at,id",
        [host.hostAccountId],
      );
      assert.equal(history.rows.length, 2);
      assert.equal(history.rows[0]?.subject, NIHO_A);
      assert.ok(history.rows[0]?.unlinked_at);
      assert.equal(history.rows[1]?.subject, NIHO_B);
      assert.equal(history.rows[1]?.linked_via, "WRITER");
      assert.equal(history.rows[1]?.unlinked_at, null);
      assert.deepEqual(await pool.query<{ event_kind: string; subject: string; merged_into_subject: string }>(
        "SELECT event_kind,subject,merged_into_subject FROM host_account_identity_events WHERE host_account_id=$1 AND event_kind='MERGED'",
        [host.hostAccountId],
      ).then((result) => result.rows.map(({ event_kind, subject, merged_into_subject }) => ({ event_kind, subject, merged_into_subject }))), [
        { event_kind: "MERGED", subject: NIHO_A, merged_into_subject: NIHO_B },
      ]);
      assert.equal((await pool.query("SELECT subject FROM traveler_accounts WHERE id=$1", [traveler.travelerAccountId])).rows[0]?.subject, NIHO_B);
      assert.match(host.hostAccountId, /^hst_/);
      assert.match(traveler.travelerAccountId, /^trv_/);
      assert.equal((await identities.readNihoUserId({ hostAccountId: host.hostAccountId })), NIHO_B);
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: host.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "fresh" });
      assert.deepEqual(await status.prepareCheck({ kind: "traveler", sessionToken: traveler.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "check", nihoUserId: NIHO_B });
    });
  });

  it("does not move a source mapping when the target already has one and reports the conflicting domains", async () => {
    await withStatusStore(async ({ pool, identities, travelers, status }) => {
      const sourceHost = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) });
      const targetHost = await identities.startWriterSessionForNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(0), nowUtc: at(0) });
      assert.equal(sourceHost.kind, "ok");
      assert.equal(targetHost.kind, "ok");
      if (sourceHost.kind !== "ok" || targetHost.kind !== "ok") return;
      const sourceTraveler = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(0), nowUtc: at(0) }) as TravelerOpened;
      const targetTraveler = await travelers.signInWithNihoIdentity({ nihoUserId: NIHO_B, authenticatedAtUtc: at(0), nowUtc: at(0) }) as TravelerOpened;

      assert.deepEqual(await status.applyStatus({
        kind: "host",
        sessionToken: sourceHost.sessionToken,
        nihoUserId: NIHO_A,
        result: { status: "merged", currentUserId: NIHO_B },
        nowUtc: at(MINUTE),
      }), { kind: "ended", conflicts: ["host", "traveler"] });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identities WHERE subject=$1 AND unlinked_at IS NULL", [NIHO_A])).rows[0]?.n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identity_events WHERE subject=$1 AND event_kind='MERGED'", [NIHO_A])).rows[0]?.n, 0);
      assert.equal((await pool.query("SELECT subject FROM traveler_accounts WHERE id=$1", [sourceTraveler.travelerAccountId])).rows[0]?.subject, NIHO_A);
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: sourceHost.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "session-ended" });
      assert.deepEqual(await status.prepareCheck({ kind: "traveler", sessionToken: sourceTraveler.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "session-ended" });
      assert.deepEqual(await status.prepareCheck({ kind: "host", sessionToken: targetHost.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "check", nihoUserId: NIHO_B });
      assert.deepEqual(await status.prepareCheck({ kind: "traveler", sessionToken: targetTraveler.sessionToken, nowUtc: at(2 * MINUTE) }), { kind: "check", nihoUserId: NIHO_B });
    });
  });
});
