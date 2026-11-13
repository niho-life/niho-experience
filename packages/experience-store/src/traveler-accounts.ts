import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * 旅行者のアカウント (Epic #591, #597, ADR 0004 §8, migration 0085): a traveler who signs in (Google, Apple or LINE, through the
 * NIHO account made on the way) has an Experience account (`trv_` + 32 hex) and a server-side session, in tables and a
 * cookie of their own. A traveler account is not a host account: no provider role, no /host, no /write.
 *
 * - The account is made the first time the NIHO user ID signs in, and found by that ID afterwards. The NIHO user ID is the
 *   only personal datum kept; it never leaves this module in a return value, a log or an error message.
 * - A session ID is 32 random bytes (base64url); only its SHA-256 is stored. 14 idle days, 30 at most. `session_ref` names a
 *   session without opening it. Raising `session_version` (suspension) ends every session.
 * - `authenticated_at` is when the traveler signed in at NIHO (its `authTime`).
 * - Nothing here ties a booking, a message or a review to an account.
 *
 * Every time is the caller's `nowUtc` (a canonical UTC instant).
 */

export const TRAVELER_ACCOUNT_LIMITS = {
  /** A session nobody used for this long ends. */
  sessionIdleDays: 14,
  /** A session ends this long after it opened, whatever else. */
  sessionAbsoluteDays: 30,
  /** A session's last use is written at most once in this many seconds. */
  touchIntervalSeconds: 3_600,
  /** Ended sessions of the account deleted per sign-in. */
  purgePerSignIn: 50,
} as const;

export type TravelerSignInResult =
  | {
    readonly kind: "ok";
    /** The cookie's value. It exists only here and in the traveler's HttpOnly cookie. */
    readonly sessionToken: string;
    /** Not a secret: names the session. */
    readonly sessionRef: string;
    readonly travelerAccountId: string;
    readonly absoluteExpiresAtUtc: string;
    /** true when this sign-in made the account. */
    readonly created: boolean;
  }
  | { readonly kind: "account-suspended" };

export interface TravelerSession {
  readonly travelerAccountId: string;
  readonly sessionRef: string;
  readonly authenticatedAtUtc: string;
  readonly idleExpiresAtUtc: string;
  readonly absoluteExpiresAtUtc: string;
}

const TRAVELER_ACCOUNT_ID = /^trv_[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const NOT_A_NIHO_ID = /^(?:hst|sel|trv)_/;
const SUBJECT_LOCK_SEED = 83;
/** NIHO's `authTime` cannot be older than this: a bound on garbage, not a policy. */
const AUTH_MAX_AGE_DAYS = 400;

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const newSecret = (): string => randomBytes(32).toString("base64url");

/** A traveler account ID: `trv_` and 32 lower-case hex digits. */
export const isTravelerAccountId = (value: unknown): value is string => typeof value === "string" && TRAVELER_ACCOUNT_ID.test(value);

function nowOf(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function subjectOf(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || CONTROL.test(value) || NOT_A_NIHO_ID.test(value)) {
    throw new StoreValidationError("nihoUserId must be a NIHO user ID.");
  }
  return value;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

/** Travelers' accounts and sessions. */
export class TravelerAccounts {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The traveler's sign-in, once the web layer has proven the NIHO account (code exchange and `identity`): the account of
   * that NIHO user ID (made now when there is none) and a new session of it. `authenticatedAtUtc` is NIHO's `authTime`,
   * never after `nowUtc`. `account-suspended` for a suspended account. The account's ended sessions are cleaned up here.
   */
  async signInWithNihoIdentity(input: { readonly nihoUserId: string; readonly authenticatedAtUtc: string; readonly nowUtc: string }): Promise<TravelerSignInResult> {
    const subject = subjectOf(input?.nihoUserId);
    const at = nowOf(input.nowUtc);
    if (typeof input.authenticatedAtUtc !== "string") throw new StoreValidationError("authenticatedAtUtc must be a canonical UTC instant.");
    assertCanonicalInstant(input.authenticatedAtUtc, "authenticatedAtUtc");
    const authenticated = Date.parse(input.authenticatedAtUtc);
    const now = Date.parse(at);
    if (authenticated > now || authenticated < now - AUTH_MAX_AGE_DAYS * 86_400_000) {
      throw new StoreValidationError("authenticatedAtUtc must not be in the future or older than 400 days.");
    }
    return withTransaction(this.#pool, async (client) => {
      // The same NIHO account signing in twice at once makes one account.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${SUBJECT_LOCK_SEED}))`, [`traveler-subject:${subject}`]);
      let created = false;
      let found = await client.query<DbRow>(
        "SELECT id, status, session_version FROM traveler_accounts WHERE provider = 'NIHO' AND subject = $1 FOR UPDATE",
        [subject],
      );
      if (!found.rows[0]) {
        const id = `trv_${randomBytes(16).toString("hex")}`;
        found = await client.query<DbRow>(
          `INSERT INTO traveler_accounts (id, provider, subject, created_at) VALUES ($1, 'NIHO', $2, $3::timestamptz)
           RETURNING id, status, session_version`,
          [id, subject, at],
        );
        created = true;
      }
      const account = found.rows[0]!;
      if (account.status !== "ACTIVE") return { kind: "account-suspended" } as const;
      const accountId = text(account, "id");
      await client.query(
        "UPDATE traveler_accounts SET last_login_at = GREATEST(last_login_at, created_at, $2::timestamptz) WHERE id = $1",
        [accountId, at],
      );
      await client.query(
        `DELETE FROM traveler_sessions
          WHERE session_hash IN (
            SELECT session_hash FROM traveler_sessions
             WHERE traveler_account_id = $1
               AND (revoked_at IS NOT NULL OR idle_expires_at <= $2::timestamptz OR absolute_expires_at <= $2::timestamptz)
             LIMIT $3)`,
        [accountId, at, TRAVELER_ACCOUNT_LIMITS.purgePerSignIn],
      );
      const sessionToken = newSecret();
      const sessionRef = randomUUID();
      const opened = await client.query<DbRow>(
        `INSERT INTO traveler_sessions
           (session_hash, session_ref, traveler_account_id, session_version, created_at, authenticated_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz,
                 LEAST($5::timestamptz + make_interval(days => $7), $5::timestamptz + make_interval(days => $8)),
                 $5::timestamptz + make_interval(days => $8))
         RETURNING absolute_expires_at`,
        [digest(sessionToken), sessionRef, accountId, Number(account.session_version), at, input.authenticatedAtUtc, TRAVELER_ACCOUNT_LIMITS.sessionIdleDays, TRAVELER_ACCOUNT_LIMITS.sessionAbsoluteDays],
      );
      return { kind: "ok", sessionToken, sessionRef, travelerAccountId: accountId, absoluteExpiresAtUtc: isoValue(opened.rows[0]!, "absolute_expires_at"), created } as const;
    });
  }

  /**
   * The account a session cookie stands for, or null: signed out, idle 14 days, past its 30 days, ended by a suspension, or
   * no such session. Its last use is written at most once an hour, which moves the idle end up to the absolute one.
   */
  async readSession(input: { readonly sessionToken: string; readonly nowUtc: string }): Promise<TravelerSession | null> {
    const at = nowOf(input?.nowUtc);
    if (typeof input.sessionToken !== "string" || !TOKEN.test(input.sessionToken)) return null;
    const hash = digest(input.sessionToken);
    const found = await this.#pool.query<DbRow>(
      `SELECT s.traveler_account_id, s.session_ref::text AS session_ref, s.authenticated_at, s.idle_expires_at, s.absolute_expires_at,
              s.last_seen_at <= $2::timestamptz - make_interval(secs => $3) AS stale
         FROM traveler_sessions s
         JOIN traveler_accounts a ON a.id = s.traveler_account_id
        WHERE s.session_hash = $1 AND s.revoked_at IS NULL
          AND s.idle_expires_at > $2::timestamptz AND s.absolute_expires_at > $2::timestamptz
          AND a.status = 'ACTIVE' AND a.session_version = s.session_version`,
      [hash, at, TRAVELER_ACCOUNT_LIMITS.touchIntervalSeconds],
    );
    const row = found.rows[0];
    if (!row) return null;
    let idleExpiresAtUtc = isoValue(row, "idle_expires_at");
    if (row.stale === true) {
      const touched = await this.#pool.query<DbRow>(
        `UPDATE traveler_sessions s
            SET last_seen_at = $2::timestamptz,
                idle_expires_at = GREATEST(s.idle_expires_at, LEAST($2::timestamptz + make_interval(days => $3), s.absolute_expires_at))
          WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.last_seen_at <= $2::timestamptz - make_interval(secs => $4)
         RETURNING s.idle_expires_at`,
        [hash, at, TRAVELER_ACCOUNT_LIMITS.sessionIdleDays, TRAVELER_ACCOUNT_LIMITS.touchIntervalSeconds],
      );
      if (touched.rows[0]) idleExpiresAtUtc = isoValue(touched.rows[0], "idle_expires_at");
    }
    return {
      travelerAccountId: text(row, "traveler_account_id"),
      sessionRef: text(row, "session_ref"),
      authenticatedAtUtc: isoValue(row, "authenticated_at"),
      idleExpiresAtUtc,
      absoluteExpiresAtUtc: isoValue(row, "absolute_expires_at"),
    };
  }

  /** Signs one session out by its cookie value. true when a session that was not signed out yet is now. */
  async revokeSession(input: { readonly sessionToken: string; readonly nowUtc: string }): Promise<boolean> {
    const at = nowOf(input?.nowUtc);
    if (typeof input.sessionToken !== "string" || !TOKEN.test(input.sessionToken)) return false;
    const revoked = await this.#pool.query(
      `UPDATE traveler_sessions SET revoked_at = GREATEST($2::timestamptz, created_at)
        WHERE session_hash = $1 AND revoked_at IS NULL`,
      [digest(input.sessionToken), at],
    );
    return (revoked.rowCount ?? 0) > 0;
  }

  /** Suspends an account: its sessions end at once and it signs in no more until reactivated. StoreNotFoundError for no account. */
  async suspendTravelerAccount(input: { readonly travelerAccountId: string; readonly nowUtc: string }): Promise<"CHANGED" | "UNCHANGED"> {
    if (!isTravelerAccountId(input?.travelerAccountId)) throw new StoreValidationError("travelerAccountId must be a traveler account ID.");
    const at = nowOf(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>("SELECT status FROM traveler_accounts WHERE id = $1 FOR UPDATE", [input.travelerAccountId]);
      if (!found.rows[0]) throw new StoreNotFoundError("Traveler account");
      if (found.rows[0].status === "SUSPENDED") return "UNCHANGED";
      await client.query(
        "UPDATE traveler_accounts SET status = 'SUSPENDED', suspended_at = GREATEST($2::timestamptz, created_at), session_version = session_version + 1 WHERE id = $1",
        [input.travelerAccountId, at],
      );
      await client.query(
        "UPDATE traveler_sessions SET revoked_at = GREATEST($2::timestamptz, created_at) WHERE traveler_account_id = $1 AND revoked_at IS NULL",
        [input.travelerAccountId, at],
      );
      return "CHANGED";
    });
  }
}
