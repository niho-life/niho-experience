import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant } from "./validation.ts";

export const NIHO_ACCOUNT_STATUS_CHECK_INTERVAL_SECONDS = 15 * 60;

export type NihoAccountStatus =
  | { readonly status: "active" }
  | { readonly status: "inactive" | "unknown" }
  | { readonly status: "merged"; readonly currentUserId: string };

export type NihoAccountStatusSessionKind = "host" | "traveler";

export type NihoAccountStatusCheck =
  | { readonly kind: "session-ended" }
  | { readonly kind: "not-linked" | "fresh" }
  | { readonly kind: "check"; readonly nihoUserId: string };

export type ApplyNihoAccountStatusResult =
  | { readonly kind: "active" | "stale" }
  | { readonly kind: "ended"; readonly conflicts: readonly NihoAccountStatusSessionKind[] }
  | { readonly kind: "merged"; readonly conflicts: readonly NihoAccountStatusSessionKind[] };

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const NIHO_USER_ID_MAX = 256;
const HOST_SUBJECT_LOCK_SEED = 71;
const TRAVELER_SUBJECT_LOCK_SEED = 83;

const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

function nowOf(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function subjectOf(value: unknown, field = "nihoUserId"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > NIHO_USER_ID_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || /^(?:hst|sel|trv)_/.test(value)) {
    throw new StoreValidationError(`${field} must be a NIHO user ID.`);
  }
  return value;
}

function sessionOf(value: unknown): string {
  if (typeof value !== "string" || !SESSION_TOKEN.test(value)) throw new StoreValidationError("sessionToken is invalid.");
  return value;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

async function lockSubjects(client: PoolClient, subjects: readonly string[]): Promise<void> {
  const ordered = [...new Set(subjects)].sort();
  for (const subject of ordered) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${HOST_SUBJECT_LOCK_SEED}))`, [`niho-identity-subject:${subject}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${TRAVELER_SUBJECT_LOCK_SEED}))`, [`traveler-subject:${subject}`]);
  }
}

async function recordMergedIdentity(client: PoolClient, input: {
  hostAccountId: string;
  sourceUserId: string;
  currentUserId: string;
  at: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO host_account_identity_events
       (host_account_id,event_kind,provider,subject,via,occurred_at,merged_into_subject)
     VALUES ($1,'MERGED','NIHO',$2,'NIHO_STATUS',$3::timestamptz,$4)`,
    [input.hostAccountId, input.sourceUserId, input.at, input.currentUserId],
  );
}

async function invalidateHostAccounts(client: PoolClient, ids: readonly string[], at: string): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE host_accounts SET session_version=session_version+1,updated_at=GREATEST(updated_at,$2::timestamptz)
      WHERE id=ANY($1::text[])`,
    [ids, at],
  );
}

async function invalidateTravelerAccounts(client: PoolClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query("UPDATE traveler_accounts SET session_version=session_version+1 WHERE id=ANY($1::text[])", [ids]);
}

/** Server-side status tracking and identity migration for host, writer, and traveler sessions. */
export class NihoAccountStatusStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async prepareCheck(input: { readonly kind: NihoAccountStatusSessionKind; readonly sessionToken: string; readonly nowUtc: string }): Promise<NihoAccountStatusCheck> {
    const token = sessionOf(input?.sessionToken);
    const at = nowOf(input.nowUtc);
    const hash = digest(token);
    const host = input.kind === "host";
    if (!host && input.kind !== "traveler") throw new StoreValidationError("kind must be host or traveler.");
    const found = host
      ? await this.#pool.query<DbRow>(
        `SELECT i.subject AS niho_user_id,s.niho_status_checked_at
           FROM host_sessions s
           JOIN host_accounts a ON a.id=s.host_account_id
           LEFT JOIN host_account_identities i ON i.host_account_id=a.id AND i.provider='NIHO' AND i.unlinked_at IS NULL
          WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2::timestamptz AND s.absolute_expires_at>$2::timestamptz
            AND a.status='ACTIVE' AND a.session_version=s.session_version`, [hash, at])
      : await this.#pool.query<DbRow>(
        `SELECT a.subject AS niho_user_id,s.niho_status_checked_at
           FROM traveler_sessions s JOIN traveler_accounts a ON a.id=s.traveler_account_id
          WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2::timestamptz AND s.absolute_expires_at>$2::timestamptz
            AND a.status='ACTIVE' AND a.session_version=s.session_version`, [hash, at]);
    const row = found.rows[0];
    if (!row) return { kind: "session-ended" };
    if (typeof row.niho_user_id !== "string") return { kind: "not-linked" };
    const subject = subjectOf(row.niho_user_id);
    if (row.niho_status_checked_at !== null && row.niho_status_checked_at !== undefined) {
      const checkedAt = Date.parse(isoValue(row, "niho_status_checked_at"));
      if (Date.parse(at) - checkedAt < NIHO_ACCOUNT_STATUS_CHECK_INTERVAL_SECONDS * 1000) return { kind: "fresh" };
    }
    return { kind: "check", nihoUserId: subject };
  }

  async applyStatus(input: {
    readonly kind: NihoAccountStatusSessionKind;
    readonly sessionToken: string;
    readonly nihoUserId: string;
    readonly result: NihoAccountStatus;
    readonly nowUtc: string;
  }): Promise<ApplyNihoAccountStatusResult> {
    const token = sessionOf(input?.sessionToken);
    const subject = subjectOf(input?.nihoUserId);
    const at = nowOf(input.nowUtc);
    const hash = digest(token);
    const host = input.kind === "host";
    if (!host && input.kind !== "traveler") throw new StoreValidationError("kind must be host or traveler.");
    const status = input.result?.status;
    const currentUserId = status === "merged" ? subjectOf(input.result.currentUserId, "currentUserId") : null;
    if (status !== "active" && status !== "inactive" && status !== "unknown" && status !== "merged") throw new StoreValidationError("result.status is invalid.");
    if (currentUserId === subject) throw new StoreValidationError("A merged account must point to a different NIHO user ID.");

    return withTransaction(this.#pool, async (client) => {
      await lockSubjects(client, currentUserId === null ? [subject] : [subject, currentUserId]);

      const current = host
        ? await client.query<DbRow>(
          `SELECT s.host_account_id AS account_id
             FROM host_sessions s JOIN host_accounts a ON a.id=s.host_account_id
             JOIN host_account_identities i ON i.host_account_id=a.id AND i.provider='NIHO' AND i.unlinked_at IS NULL
            WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2::timestamptz AND s.absolute_expires_at>$2::timestamptz
              AND a.status='ACTIVE' AND a.session_version=s.session_version AND i.subject=$3 FOR UPDATE OF s,a,i`, [hash, at, subject])
        : await client.query<DbRow>(
          `SELECT a.id AS account_id
             FROM traveler_sessions s JOIN traveler_accounts a ON a.id=s.traveler_account_id
            WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2::timestamptz AND s.absolute_expires_at>$2::timestamptz
              AND a.status='ACTIVE' AND a.session_version=s.session_version AND a.subject=$3 FOR UPDATE OF s,a`, [hash, at, subject]);
      if (!current.rows[0]) return { kind: "stale" } as const;

      if (status === "active") {
        const stamped = host
          ? await client.query("UPDATE host_sessions SET niho_status_checked_at=$2::timestamptz WHERE session_hash=$1", [hash, at])
          : await client.query("UPDATE traveler_sessions SET niho_status_checked_at=$2::timestamptz WHERE session_hash=$1", [hash, at]);
        return (stamped.rowCount ?? 0) === 1 ? { kind: "active" } as const : { kind: "stale" } as const;
      }

      if (status === "inactive" || status === "unknown") {
        const hostRows = await client.query<DbRow>(
          `SELECT host_account_id FROM host_account_identities WHERE provider='NIHO' AND subject=$1 AND unlinked_at IS NULL ORDER BY host_account_id FOR UPDATE`, [subject]);
        const travelerRows = await client.query<DbRow>(
          `SELECT id FROM traveler_accounts WHERE provider='NIHO' AND subject=$1 ORDER BY id FOR UPDATE`, [subject]);
        const hostIds = hostRows.rows.map((row) => text(row, "host_account_id"));
        const travelerIds = travelerRows.rows.map((row) => text(row, "id"));
        await invalidateHostAccounts(client, hostIds, at);
        await invalidateTravelerAccounts(client, travelerIds);
        return { kind: "ended", conflicts: [] } as const;
      }
      const mergedUserId = currentUserId;
      if (mergedUserId === null) throw new StoreValidationError("A merged account must include its current NIHO user ID.");

      const hostRows = await client.query<DbRow>(
        `SELECT id::text AS identity_id,host_account_id,linked_via FROM host_account_identities
          WHERE provider='NIHO' AND subject=$1 AND unlinked_at IS NULL ORDER BY host_account_id FOR UPDATE`, [subject]);
      const hostTarget = await client.query<DbRow>(
        `SELECT host_account_id FROM host_account_identities WHERE provider='NIHO' AND subject=$1 AND unlinked_at IS NULL FOR UPDATE`, [mergedUserId]);
      const travelerRows = await client.query<DbRow>(
        "SELECT id FROM traveler_accounts WHERE provider='NIHO' AND subject=$1 ORDER BY id FOR UPDATE", [subject]);
      const travelerTarget = await client.query<DbRow>(
        "SELECT id FROM traveler_accounts WHERE provider='NIHO' AND subject=$1 FOR UPDATE", [mergedUserId]);
      const hostConflict = hostRows.rows.length > 0 && hostTarget.rows.length > 0;
      const travelerConflict = travelerRows.rows.length > 0 && travelerTarget.rows.length > 0;
      const conflicts: NihoAccountStatusSessionKind[] = [];

      if (hostConflict) {
        conflicts.push("host");
        await invalidateHostAccounts(client, hostRows.rows.map((row) => text(row, "host_account_id")), at);
      } else {
        for (const row of hostRows.rows) {
          const hostAccountId = text(row, "host_account_id");
          const linkedVia = text(row, "linked_via");
          const identityId = text(row, "identity_id");
          await client.query("UPDATE host_account_identities SET unlinked_at=GREATEST(linked_at,$2::timestamptz) WHERE id=$1::uuid", [identityId, at]);
          await client.query(
            `INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at,last_login_at)
             VALUES ($1,'NIHO',$2,$3,$4::timestamptz,$4::timestamptz)`, [hostAccountId, mergedUserId, linkedVia, at]);
          await recordMergedIdentity(client, { hostAccountId, sourceUserId: subject, currentUserId: mergedUserId, at });
        }
      }

      if (travelerConflict) {
        conflicts.push("traveler");
        await invalidateTravelerAccounts(client, travelerRows.rows.map((row) => text(row, "id")));
      } else if (travelerRows.rows.length > 0) {
        await client.query("UPDATE traveler_accounts SET subject=$2 WHERE provider='NIHO' AND subject=$1", [subject, mergedUserId]);
      }

      const currentConflict = conflicts.includes(input.kind);
      if (currentConflict) return { kind: "ended", conflicts } as const;
      const stamped = host
        ? await client.query(
          `UPDATE host_sessions s SET niho_status_checked_at=$2::timestamptz
            WHERE s.session_hash=$1 AND EXISTS (
              SELECT 1 FROM host_account_identities i WHERE i.host_account_id=s.host_account_id AND i.provider='NIHO' AND i.subject=$3 AND i.unlinked_at IS NULL
            )`, [hash, at, mergedUserId])
        : await client.query(
          `UPDATE traveler_sessions s SET niho_status_checked_at=$2::timestamptz
            WHERE s.session_hash=$1 AND EXISTS (
              SELECT 1 FROM traveler_accounts a WHERE a.id=s.traveler_account_id AND a.provider='NIHO' AND a.subject=$3
            )`, [hash, at, mergedUserId]);
      if ((stamped.rowCount ?? 0) !== 1) return { kind: "stale" } as const;
      return { kind: "merged", conflicts } as const;
    });
  }
}
