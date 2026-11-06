import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { isHostEmail } from "./host-mail-shared.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * Admin のログイン (ADR 0003 decision 4, slice 4, migration 0066): the server-side sessions of admins who signed in to
 * /admin with Google. Who may sign in (the allowlist) is decided by the web layer, at sign-in and again on every request
 * with the address a session holds; this module only keeps sessions.
 *
 * - A session ID is 32 random bytes (base64url). Only its SHA-256 is stored; the raw value leaves this module in
 *   `openSession`'s result only, for the admin's HttpOnly cookie.
 * - Sessions end after 2 idle hours, 12 hours after they opened, or when signed out. `session_ref` names a session
 *   without opening it.
 * - The admin's actor ID is `adm_` + 32 hex derived from the Google account's subject (`adminActorIdForGoogleSubject`).
 *
 * Nothing here logs; callers must not log session IDs or addresses either. Every time is the caller's `nowUtc`.
 */

export const ADMIN_SESSION_LIMITS = {
  /** A session nobody used for this long ends. */
  sessionIdleMinutes: 120,
  /** A session ends this long after it opened, whatever else. */
  sessionAbsoluteHours: 12,
  /** A session's last use is written at most once in this many seconds. */
  touchIntervalSeconds: 300,
  purgeLimitMax: 5_000,
} as const;

/**
 * The actor ID of an admin signed in with Google: `adm_` and 32 lower-case hex digits, the first half of the SHA-256 of
 * `google:<sub>` (the Google account's stable subject). It goes where a NIHO user ID went (`*_niho_user_id` columns)
 * until they are renamed. It is never the address, stays the same when the address changes, and its prefix never
 * matches a NIHO user ID, a host account ID (`hst_`) or a seller reference (`sel_`).
 */
export type AdminActorId = string;

export interface AdminSessionOpened {
  /** The cookie's value. It exists only here and in the admin's HttpOnly cookie. */
  readonly sessionToken: string;
  /** Not a secret: names the session without opening it. */
  readonly sessionRef: string;
  readonly adminActorId: AdminActorId;
  /** When the session ends at the latest: the cookie lives no longer. */
  readonly absoluteExpiresAtUtc: string;
}

export interface AdminSession {
  readonly adminActorId: AdminActorId;
  /** The lower-case address the admin signed in with: the web layer checks it against the allowlist on every request. */
  readonly email: string;
  readonly sessionRef: string;
  /** When the admin signed in with Google. */
  readonly authenticatedAtUtc: string;
  readonly idleExpiresAtUtc: string;
  readonly absoluteExpiresAtUtc: string;
}

const ADMIN_ACTOR_ID = /^adm_[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Google's `sub`: up to 255 printable ASCII characters, never reused for another account. */
const GOOGLE_SUBJECT = /^[\x21-\x7E]{1,255}$/;

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const isSecret = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);

/** An admin actor ID: `adm_` and 32 lower-case hex digits. */
export const isAdminActorId = (value: unknown): value is AdminActorId => typeof value === "string" && ADMIN_ACTOR_ID.test(value);

/** The actor ID of the Google account with this subject (see AdminActorId). StoreValidationError for a malformed subject. */
export function adminActorIdForGoogleSubject(sub: unknown): AdminActorId {
  if (typeof sub !== "string" || !GOOGLE_SUBJECT.test(sub)) throw new StoreValidationError("sub must be a Google account subject.");
  return `adm_${createHash("sha256").update(`google:${sub}`, "utf8").digest("hex").slice(0, 32)}`;
}

function now(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function actorId(value: unknown): AdminActorId {
  if (!isAdminActorId(value)) throw new StoreValidationError("adminActorId must be an admin actor ID.");
  return value;
}

function email(value: unknown): string {
  if (!isHostEmail(value) || value !== value.toLowerCase()) throw new StoreValidationError("email must be a lower-case email address of 3-254 characters.");
  return value;
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

/** The sessions of admins signed in with Google. */
export class AdminSessions {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Opens a session for an admin the web layer has just verified with Google and found on the allowlist. */
  async openSession(input: { readonly adminActorId: AdminActorId; readonly email: string; readonly nowUtc: string }): Promise<AdminSessionOpened> {
    const admin = actorId(input?.adminActorId);
    const address = email(input.email);
    const at = now(input.nowUtc);
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionRef = randomUUID();
    const opened = await this.#pool.query<DbRow>(
      `INSERT INTO admin_sessions
         (session_hash, session_ref, admin_actor_id, email, created_at, authenticated_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2::uuid, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz,
               LEAST($5::timestamptz + make_interval(mins => $6), $5::timestamptz + make_interval(hours => $7)),
               $5::timestamptz + make_interval(hours => $7))
       RETURNING absolute_expires_at`,
      [digest(sessionToken), sessionRef, admin, address, at, ADMIN_SESSION_LIMITS.sessionIdleMinutes, ADMIN_SESSION_LIMITS.sessionAbsoluteHours],
    );
    return { sessionToken, sessionRef, adminActorId: admin, absoluteExpiresAtUtc: isoValue(opened.rows[0]!, "absolute_expires_at") };
  }

  /**
   * The admin a session cookie stands for, or null: signed out, idle 2 hours, past its 12 hours, or no such session.
   * Its last use is written at most once in 5 minutes, which moves the idle end up to the absolute one. The caller still
   * checks the address against the allowlist.
   */
  async readSession(input: { readonly sessionToken: string; readonly nowUtc: string }): Promise<AdminSession | null> {
    const at = now(input?.nowUtc);
    if (!isSecret(input.sessionToken)) return null;
    const hash = digest(input.sessionToken);
    const found = await this.#pool.query<DbRow>(
      `SELECT admin_actor_id, email, session_ref::text AS session_ref, authenticated_at, idle_expires_at, absolute_expires_at,
              last_seen_at <= $2::timestamptz - make_interval(secs => $3) AS stale
         FROM admin_sessions
        WHERE session_hash = $1 AND revoked_at IS NULL
          AND idle_expires_at > $2::timestamptz AND absolute_expires_at > $2::timestamptz`,
      [hash, at, ADMIN_SESSION_LIMITS.touchIntervalSeconds],
    );
    const row = found.rows[0];
    if (!row) return null;
    let idleExpiresAtUtc = isoValue(row, "idle_expires_at");
    if (row.stale === true) {
      const touched = await this.#pool.query<DbRow>(
        `UPDATE admin_sessions s
            SET last_seen_at = $2::timestamptz,
                idle_expires_at = GREATEST(s.idle_expires_at, LEAST($2::timestamptz + make_interval(mins => $3), s.absolute_expires_at))
          WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.last_seen_at <= $2::timestamptz - make_interval(secs => $4)
         RETURNING s.idle_expires_at`,
        [hash, at, ADMIN_SESSION_LIMITS.sessionIdleMinutes, ADMIN_SESSION_LIMITS.touchIntervalSeconds],
      );
      if (touched.rows[0]) idleExpiresAtUtc = isoValue(touched.rows[0], "idle_expires_at");
    }
    const admin = text(row, "admin_actor_id");
    if (!isAdminActorId(admin)) throw new StoreError("Database returned an invalid admin_actor_id.");
    return {
      adminActorId: admin,
      email: text(row, "email"),
      sessionRef: text(row, "session_ref"),
      authenticatedAtUtc: isoValue(row, "authenticated_at"),
      idleExpiresAtUtc,
      absoluteExpiresAtUtc: isoValue(row, "absolute_expires_at"),
    };
  }

  /** Signs one session out by its cookie value. true when a session that was not signed out yet is now. */
  async revokeSession(input: { readonly sessionToken: string; readonly nowUtc: string }): Promise<boolean> {
    const at = now(input?.nowUtc);
    if (!isSecret(input.sessionToken)) return false;
    const revoked = await this.#pool.query(
      `UPDATE admin_sessions SET revoked_at = GREATEST($2::timestamptz, created_at)
        WHERE session_hash = $1 AND revoked_at IS NULL`,
      [digest(input.sessionToken), at],
    );
    return (revoked.rowCount ?? 0) > 0;
  }

  /** Signs every session of an admin out (taken off the allowlist, say); returns how many were still open. */
  async revokeActorSessions(input: { readonly adminActorId: AdminActorId; readonly nowUtc: string }): Promise<number> {
    const admin = actorId(input?.adminActorId);
    const at = now(input.nowUtc);
    const revoked = await this.#pool.query(
      `UPDATE admin_sessions SET revoked_at = GREATEST($2::timestamptz, created_at)
        WHERE admin_actor_id = $1 AND revoked_at IS NULL`,
      [admin, at],
    );
    return revoked.rowCount ?? 0;
  }

  /** The mail job: deletes up to `limit` sessions that can no longer read anything (signed out, idle or past their end). */
  async purgeExpired(input: { readonly nowUtc: string; readonly limit: number }): Promise<number> {
    const at = now(input?.nowUtc);
    const limit = boundedInteger(input.limit, "limit", 1, ADMIN_SESSION_LIMITS.purgeLimitMax);
    const purged = await this.#pool.query(
      `WITH due AS (
         SELECT session_hash FROM admin_sessions
          WHERE revoked_at IS NOT NULL OR idle_expires_at <= $1::timestamptz OR absolute_expires_at <= $1::timestamptz
          ORDER BY absolute_expires_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM admin_sessions s USING due WHERE s.session_hash = due.session_hash`,
      [at, limit],
    );
    return purged.rowCount ?? 0;
  }
}
