import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isHostEmail } from "./host-mail-shared.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * ホストのアカウント (ADR 0003, owner policy 2026-11-07, migration 0064): Experience's own host accounts. A host signs in
 * with a single-use link emailed to them; there is no password and no NIHO account behind it. Provider roles
 * (provider_memberships) bind to the host account ID (`hst_` + 32 hex), which the `*_niho_user_id` columns hold until
 * they are renamed; it never matches a NIHO user ID.
 *
 * - A link token and a session ID are 32 random bytes (base64url). Only their SHA-256 is stored; the raw values leave
 *   this module in return values only (the token for the email's URL fragment, the session ID for the HttpOnly cookie).
 * - A link works for 15 minutes, once, only in the browser that asked for it: the web layer keeps a random value in an
 *   HttpOnly cookie and passes its SHA-256 as `browserBindingHash`, compared here in constant time.
 * - `requestLogin` answers alike whether the address has an account, is suspended or is over its limits. The request
 *   row is the email's queue entry (IDs and hashes only); the mail job mints the token later (`issueLoginLink`), so
 *   the raw token is never stored and the request does no mail work while the person waits.
 * - Sessions are server-side: 14 idle days, 30 days at most. `session_ref` names a session without opening it.
 *   Raising the account's `session_version` (sign out everywhere, suspension) ends every session and unused link.
 *
 * Nothing here logs; callers must not log tokens, session IDs or addresses either. Every time is the caller's `nowUtc`
 * (a canonical UTC instant), so the web and job processes share one clock rule.
 */

export const HOST_ACCOUNT_LIMITS = {
  /** A sign-in link works this long after it was asked for. */
  linkTtlMinutes: 15,
  /** Sign-in links one account may ask for in the rolling window below. */
  loginRequestsPerWindow: 5,
  /** The limit's rolling window. Requests are kept this long, then the job deletes them. */
  loginRequestWindowMinutes: 60,
  /** A new link waits this long after the account's previous request. */
  loginRequestSpacingSeconds: 30,
  /** A session nobody used for this long ends. */
  sessionIdleDays: 14,
  /** A session ends this long after it opened, whatever else. */
  sessionAbsoluteDays: 30,
  /** A session's last use is written at most once in this many seconds. */
  touchIntervalSeconds: 3_600,
  /** The web layer asks for a sign-in at most this old (`authenticatedAtUtc`) before a sensitive change. */
  recentAuthenticationMinutes: 30,
  pendingLimitMax: 100,
  purgeLimitMax: 5_000,
} as const;

export interface ProvisionedHostAccount {
  readonly hostAccountId: string;
  /** false when the address already had an account (whatever its status, which this leaves as it is). */
  readonly created: boolean;
}

/** The one answer to "email me a sign-in link", whatever happened. */
export interface HostLoginRequestAccepted {
  readonly kind: "accepted";
}

export type HostLoginLinkIssue =
  | {
    readonly kind: "send";
    /** For the link's URL fragment only: never in a path, a query, a log or a queue. */
    readonly token: string;
    readonly toEmail: string;
    readonly expiresAtUtc: string;
  }
  | { readonly kind: "skip" };

export type HostLoginResult =
  | {
    readonly kind: "ok";
    /** The cookie's value. It exists only here and in the host's HttpOnly cookie. */
    readonly sessionToken: string;
    /** Not a secret: names the session to push subscriptions, audit records and "sign out that device". */
    readonly sessionRef: string;
    readonly hostAccountId: string;
    /** When the session ends at the latest: the cookie lives no longer. */
    readonly absoluteExpiresAtUtc: string;
  }
  | { readonly kind: "invalid" };

export interface HostSession {
  readonly hostAccountId: string;
  readonly email: string;
  readonly sessionRef: string;
  /** When the host last proved the address with a link. */
  readonly authenticatedAtUtc: string;
  readonly idleExpiresAtUtc: string;
  readonly absoluteExpiresAtUtc: string;
}

/** One session by its cookie value, or one of the account's own sessions by its reference ("sign out that device"). */
export type HostSessionRevocation =
  | { readonly sessionToken: string; readonly nowUtc: string }
  | { readonly hostAccountId: string; readonly sessionRef: string; readonly nowUtc: string };

export type HostAccountChange = "CHANGED" | "UNCHANGED";

export type GrantProviderOwnerResult =
  | { readonly kind: "granted" | "already-owner" }
  | {
    readonly kind:
      | "provider-not-found"
      /** No such account, or it is suspended. */
      | "host-account-not-active"
      /** The account already has another role on this provider, or an inactive membership: changed by hand only. */
      | "membership-conflict"
      /** The account is already the OWNER of another provider (the host screens resolve exactly one). */
      | "owner-of-another-provider"
      /** Another host account is already this provider's OWNER: this path registers the first one only. */
      | "provider-has-host-owner";
  };

const HOST_ACCOUNT_ID = /^hst_[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Format characters (zero-width and the like) and line or paragraph separators: never part of an address. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LOGIN_LOCK_SEED = 61;
const OWNER_LOCK_SEED = 47;
const PROVIDER_HOST_OWNER_LOCK_SEED = 67;

const ACCEPTED: HostLoginRequestAccepted = Object.freeze({ kind: "accepted" });
const SKIP: HostLoginLinkIssue = Object.freeze({ kind: "skip" });
const INVALID: HostLoginResult = Object.freeze({ kind: "invalid" });

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const newSecret = (): string => randomBytes(32).toString("base64url");
const isSecret = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);
const isBindingHash = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.byteLength === 32;

/** A host account ID: `hst_` and 32 lower-case hex digits. */
export const isHostAccountId = (value: unknown): value is string => typeof value === "string" && HOST_ACCOUNT_ID.test(value);

function hostEmail(input: unknown): { readonly email: string; readonly emailKey: string } {
  const email = typeof input === "string" ? input.normalize("NFKC").trim() : "";
  const emailKey = email.toLowerCase();
  if (!isHostEmail(email) || !isHostEmail(emailKey) || INVISIBLE.test(email)) {
    throw new StoreValidationError("email must be an email address of 3-254 characters.");
  }
  return { email, emailKey };
}

/**
 * The account key of an address: trimmed, NFKC, lower case, 3-254 characters with one @ and a dot in the domain, and
 * no space, control or invisible character. StoreValidationError otherwise.
 */
export function normalizeHostEmail(input: unknown): string {
  return hostEmail(input).emailKey;
}

function now(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function hostAccountId(value: unknown): string {
  if (!isHostAccountId(value)) throw new StoreValidationError("hostAccountId must be a host account ID.");
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

function sameHash(stored: unknown, given: Uint8Array): boolean {
  if (!(stored instanceof Uint8Array) || stored.byteLength !== given.byteLength) return false;
  return timingSafeEqual(stored, given);
}

/** Sessions of an account that still read anything, signed out at once (`$1` the account, `$2` the time). */
const REVOKE_ACCOUNT_SESSIONS = `UPDATE host_sessions SET revoked_at = GREATEST($2::timestamptz, created_at)
  WHERE host_account_id = $1 AND revoked_at IS NULL`;

/** Host accounts, their sign-in links and sessions, and the first OWNER membership Admin/ops give one. */
export class HostAccounts {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Admin/ops: the account of an address, created ACTIVE when there is none. The same address again is the same account. */
  async provisionHostAccount(input: { readonly email: string; readonly nowUtc: string }): Promise<ProvisionedHostAccount> {
    const { email, emailKey } = hostEmail(input?.email);
    const at = now(input?.nowUtc);
    const id = `hst_${randomBytes(16).toString("hex")}`;
    const inserted = await this.#pool.query<DbRow>(
      `INSERT INTO host_accounts (id, email, email_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (email_key) DO NOTHING RETURNING id`,
      [id, email, emailKey, at],
    );
    if (inserted.rows[0]) return { hostAccountId: text(inserted.rows[0], "id"), created: true };
    const existing = await this.#pool.query<DbRow>("SELECT id FROM host_accounts WHERE email_key = $1", [emailKey]);
    if (!existing.rows[0]) throw new StoreError("The host account could not be provisioned; try again.");
    return { hostAccountId: text(existing.rows[0], "id"), created: false };
  }

  /**
   * "Email me a sign-in link". For an ACTIVE account under its limits (5 an hour, 30 seconds apart) this records the
   * request, which is also the email's queue entry; the mail job sends it. The answer is the same whatever happened:
   * no account, a suspended one, a limit. StoreValidationError only for something that is not an address or a binding.
   */
  async requestLogin(input: { readonly email: string; readonly browserBindingHash: Uint8Array; readonly nowUtc: string }): Promise<HostLoginRequestAccepted> {
    const { emailKey } = hostEmail(input?.email);
    if (!isBindingHash(input.browserBindingHash)) throw new StoreValidationError("browserBindingHash must be 32 bytes.");
    const at = now(input.nowUtc);
    await withTransaction(this.#pool, async (client) => {
      // Requests for one address take turns, so the limits hold under concurrency; an unknown address waits alike.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('host-login:' || $1::text, ${LOGIN_LOCK_SEED}))`, [emailKey]);
      await client.query(
        `WITH account AS (
           SELECT a.id, a.session_version FROM host_accounts a
            WHERE a.email_key = $1 AND a.status = 'ACTIVE'
              AND NOT EXISTS (SELECT 1 FROM host_login_requests r
                               WHERE r.host_account_id = a.id AND r.created_at > $3::timestamptz - make_interval(secs => $5))
              AND (SELECT count(*) FROM host_login_requests r
                    WHERE r.host_account_id = a.id AND r.created_at > $3::timestamptz - make_interval(mins => $8)) < $6
         )
         INSERT INTO host_login_requests (id, host_account_id, session_version, browser_binding_hash, created_at, expires_at)
         SELECT $2::uuid, account.id, account.session_version, $4, $3::timestamptz, $3::timestamptz + make_interval(mins => $7)
           FROM account`,
        [
          emailKey, randomUUID(), at, Buffer.from(input.browserBindingHash), HOST_ACCOUNT_LIMITS.loginRequestSpacingSeconds,
          HOST_ACCOUNT_LIMITS.loginRequestsPerWindow, HOST_ACCOUNT_LIMITS.linkTtlMinutes, HOST_ACCOUNT_LIMITS.loginRequestWindowMinutes,
        ],
      );
    });
    return ACCEPTED;
  }

  /** The mail job: requests whose link is still to be sent (not minted, not expired, account ACTIVE), oldest first. */
  async listPendingLoginRequests(input: { readonly nowUtc: string; readonly limit: number }): Promise<readonly string[]> {
    const at = now(input?.nowUtc);
    const limit = boundedInteger(input.limit, "limit", 1, HOST_ACCOUNT_LIMITS.pendingLimitMax);
    const found = await this.#pool.query<DbRow>(
      `SELECT r.id::text AS id
         FROM host_login_requests r
         JOIN host_accounts a ON a.id = r.host_account_id
        WHERE r.token_hash IS NULL AND r.created_at <= $1::timestamptz AND r.expires_at > $1::timestamptz
          AND a.status = 'ACTIVE' AND a.session_version = r.session_version
        ORDER BY r.created_at, r.id
        LIMIT $2`,
      [at, limit],
    );
    return found.rows.map((row) => text(row, "id"));
  }

  /**
   * The mail job: mints a request's link token, once. `skip` for a request that is unknown, expired, already minted
   * or used, or whose account is suspended or signed out everywhere since. The raw token is in the result only.
   */
  async issueLoginLink(input: { readonly requestId: string; readonly nowUtc: string }): Promise<HostLoginLinkIssue> {
    if (typeof input?.requestId !== "string" || !UUID.test(input.requestId)) throw new StoreValidationError("requestId must be a UUID.");
    const at = now(input.nowUtc);
    const token = newSecret();
    const issued = await this.#pool.query<DbRow>(
      `UPDATE host_login_requests r SET token_hash = $2, issued_at = $3::timestamptz
         FROM host_accounts a
        WHERE r.id = $1::uuid AND a.id = r.host_account_id AND r.token_hash IS NULL
          AND r.created_at <= $3::timestamptz AND r.expires_at > $3::timestamptz
          AND a.status = 'ACTIVE' AND a.session_version = r.session_version
       RETURNING a.email, r.expires_at`,
      [input.requestId.toLowerCase(), digest(token), at],
    );
    const row = issued.rows[0];
    return row ? { kind: "send", token, toEmail: text(row, "email"), expiresAtUtc: isoValue(row, "expires_at") } : SKIP;
  }

  /**
   * Opens a session from a link, once: the token is unused and unexpired, the browser is the one that asked, and the
   * account is ACTIVE at the version the link was asked at. Marks the link used, the address verified and opens the
   * session in one transaction. `invalid` alike for anything else. A browser mismatch leaves the link usable in the
   * browser that asked for it.
   */
  async consumeLogin(input: { readonly token: string; readonly browserBindingHash: Uint8Array; readonly nowUtc: string }): Promise<HostLoginResult> {
    const at = now(input?.nowUtc);
    if (!isSecret(input.token) || !isBindingHash(input.browserBindingHash)) return INVALID;
    const binding = input.browserBindingHash;
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT r.id::text AS id, r.browser_binding_hash, r.host_account_id, r.session_version
           FROM host_login_requests r
           JOIN host_accounts a ON a.id = r.host_account_id
          WHERE r.token_hash = $1 AND r.consumed_at IS NULL
            AND r.issued_at <= $2::timestamptz AND r.expires_at > $2::timestamptz
            AND a.status = 'ACTIVE' AND a.session_version = r.session_version
          FOR UPDATE OF r, a`,
        [digest(input.token), at],
      );
      const request = found.rows[0];
      if (!request || !sameHash(request.browser_binding_hash, binding)) return INVALID;
      const accountId = text(request, "host_account_id");
      await client.query("UPDATE host_login_requests SET consumed_at = $2::timestamptz WHERE id = $1::uuid", [request.id, at]);
      await client.query(
        `UPDATE host_accounts SET email_verified_at = COALESCE(email_verified_at, GREATEST($2::timestamptz, created_at)),
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE id = $1`,
        [accountId, at],
      );
      const sessionToken = newSecret();
      const sessionRef = randomUUID();
      const opened = await client.query<DbRow>(
        `INSERT INTO host_sessions
           (session_hash, session_ref, host_account_id, session_version, created_at, authenticated_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz,
                 LEAST($5::timestamptz + make_interval(days => $6), $5::timestamptz + make_interval(days => $7)),
                 $5::timestamptz + make_interval(days => $7))
         RETURNING absolute_expires_at`,
        [digest(sessionToken), sessionRef, accountId, request.session_version, at, HOST_ACCOUNT_LIMITS.sessionIdleDays, HOST_ACCOUNT_LIMITS.sessionAbsoluteDays],
      );
      return { kind: "ok", sessionToken, sessionRef, hostAccountId: accountId, absoluteExpiresAtUtc: isoValue(opened.rows[0]!, "absolute_expires_at") };
    });
  }

  /**
   * The account a session cookie stands for, or null: signed out, idle 14 days, past its 30 days, signed out
   * everywhere, the account suspended, or no such session. Its last use is written at most once an hour, which moves
   * the idle end up to the absolute one. A session reference is not a session token and opens nothing.
   */
  async readSession(input: { readonly sessionToken: string; readonly nowUtc: string }): Promise<HostSession | null> {
    const at = now(input?.nowUtc);
    if (!isSecret(input.sessionToken)) return null;
    const hash = digest(input.sessionToken);
    const found = await this.#pool.query<DbRow>(
      `SELECT s.host_account_id, a.email, s.session_ref::text AS session_ref, s.authenticated_at, s.idle_expires_at, s.absolute_expires_at,
              s.last_seen_at <= $2::timestamptz - make_interval(secs => $3) AS stale
         FROM host_sessions s
         JOIN host_accounts a ON a.id = s.host_account_id
        WHERE s.session_hash = $1 AND s.revoked_at IS NULL
          AND s.idle_expires_at > $2::timestamptz AND s.absolute_expires_at > $2::timestamptz
          AND a.status = 'ACTIVE' AND a.session_version = s.session_version`,
      [hash, at, HOST_ACCOUNT_LIMITS.touchIntervalSeconds],
    );
    const row = found.rows[0];
    if (!row) return null;
    let idleExpiresAtUtc = isoValue(row, "idle_expires_at");
    if (row.stale === true) {
      const touched = await this.#pool.query<DbRow>(
        `UPDATE host_sessions s
            SET last_seen_at = $2::timestamptz,
                idle_expires_at = GREATEST(s.idle_expires_at, LEAST($2::timestamptz + make_interval(days => $3), s.absolute_expires_at))
          WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.last_seen_at <= $2::timestamptz - make_interval(secs => $4)
         RETURNING s.idle_expires_at`,
        [hash, at, HOST_ACCOUNT_LIMITS.sessionIdleDays, HOST_ACCOUNT_LIMITS.touchIntervalSeconds],
      );
      if (touched.rows[0]) idleExpiresAtUtc = isoValue(touched.rows[0], "idle_expires_at");
    }
    return {
      hostAccountId: text(row, "host_account_id"),
      email: text(row, "email"),
      sessionRef: text(row, "session_ref"),
      authenticatedAtUtc: isoValue(row, "authenticated_at"),
      idleExpiresAtUtc,
      absoluteExpiresAtUtc: isoValue(row, "absolute_expires_at"),
    };
  }

  /**
   * Signs one session out: by its cookie value, or one of the account's own sessions by its reference. true when a
   * session that was not signed out yet is now; an unknown, foreign or already ended one changes nothing.
   */
  async revokeSession(input: HostSessionRevocation): Promise<boolean> {
    const at = now(input?.nowUtc);
    if ("sessionToken" in input) {
      if (!isSecret(input.sessionToken)) return false;
      const revoked = await this.#pool.query(
        "UPDATE host_sessions SET revoked_at = GREATEST($2::timestamptz, created_at) WHERE session_hash = $1 AND revoked_at IS NULL",
        [digest(input.sessionToken), at],
      );
      return (revoked.rowCount ?? 0) > 0;
    }
    const account = hostAccountId(input.hostAccountId);
    if (typeof input.sessionRef !== "string" || !UUID.test(input.sessionRef)) return false;
    const revoked = await this.#pool.query(
      `UPDATE host_sessions SET revoked_at = GREATEST($3::timestamptz, created_at)
        WHERE host_account_id = $1 AND session_ref = $2::uuid AND revoked_at IS NULL`,
      [account, input.sessionRef.toLowerCase(), at],
    );
    return (revoked.rowCount ?? 0) > 0;
  }

  /** Signs out everywhere: every session and every unused link of the account stops working. StoreNotFoundError for no account. */
  async revokeAllSessions(input: { readonly hostAccountId: string; readonly nowUtc: string }): Promise<void> {
    const account = hostAccountId(input?.hostAccountId);
    const at = now(input.nowUtc);
    await withTransaction(this.#pool, async (client) => {
      const bumped = await client.query(
        `UPDATE host_accounts SET session_version = session_version + 1, updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE id = $1`,
        [account, at],
      );
      if ((bumped.rowCount ?? 0) === 0) throw new StoreNotFoundError("Host account");
      await client.query(REVOKE_ACCOUNT_SESSIONS, [account, at]);
    });
  }

  /**
   * Suspends an account: its sessions and unused links stop working at once and stay dead after a reactivation; it
   * gets no new link. Memberships stay as they are. StoreNotFoundError for no account.
   */
  async suspendHostAccount(input: { readonly hostAccountId: string; readonly nowUtc: string }): Promise<HostAccountChange> {
    const account = hostAccountId(input?.hostAccountId);
    const at = now(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR UPDATE", [account]);
      if (!found.rows[0]) throw new StoreNotFoundError("Host account");
      if (found.rows[0].status === "SUSPENDED") return "UNCHANGED";
      await client.query(
        `UPDATE host_accounts
            SET status = 'SUSPENDED', suspended_at = $2::timestamptz, session_version = session_version + 1,
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE id = $1`,
        [account, at],
      );
      await client.query(REVOKE_ACCOUNT_SESSIONS, [account, at]);
      return "CHANGED";
    });
  }

  /** Lets a suspended account ask for links again. Earlier sessions and links stay dead. StoreNotFoundError for no account. */
  async reactivateHostAccount(input: { readonly hostAccountId: string; readonly nowUtc: string }): Promise<HostAccountChange> {
    const account = hostAccountId(input?.hostAccountId);
    const at = now(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR UPDATE", [account]);
      if (!found.rows[0]) throw new StoreNotFoundError("Host account");
      if (found.rows[0].status === "ACTIVE") return "UNCHANGED";
      await client.query(
        `UPDATE host_accounts SET status = 'ACTIVE', suspended_at = NULL, updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE id = $1`,
        [account, at],
      );
      return "CHANGED";
    });
  }

  /**
   * The mail job: deletes up to `limit` requests older than an hour (all expired, no longer counted by the limit) and
   * as many sessions that can no longer read anything (signed out, idle or past their end); returns how many in all.
   */
  async purgeExpired(input: { readonly nowUtc: string; readonly limit: number }): Promise<number> {
    const at = now(input?.nowUtc);
    const limit = boundedInteger(input.limit, "limit", 1, HOST_ACCOUNT_LIMITS.purgeLimitMax);
    const requests = await this.#pool.query(
      `WITH due AS (
         SELECT id FROM host_login_requests
          WHERE created_at <= $1::timestamptz - make_interval(mins => $3)
          ORDER BY created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM host_login_requests r USING due WHERE r.id = due.id`,
      [at, limit, HOST_ACCOUNT_LIMITS.loginRequestWindowMinutes],
    );
    const sessions = await this.#pool.query(
      `WITH due AS (
         SELECT session_hash FROM host_sessions
          WHERE revoked_at IS NOT NULL OR idle_expires_at <= $1::timestamptz OR absolute_expires_at <= $1::timestamptz
          ORDER BY absolute_expires_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM host_sessions s USING due WHERE s.session_hash = due.session_hash`,
      [at, limit],
    );
    return (requests.rowCount ?? 0) + (sessions.rowCount ?? 0);
  }

  /**
   * Admin/ops: makes an ACTIVE host account the OWNER of a provider, as the first-login binding does for a NIHO user
   * (ExperiencePublicationRepository.ensureMappedOwnerMembership): under the same per-identity lock, an existing
   * membership of this account is never changed (another role or an inactive one is a conflict), and an account is
   * the OWNER of one provider at most. This path also registers the first host-account OWNER only: a provider whose
   * active OWNER is already another host account is refused. A NIHO user's OWNER membership stays as it is.
   */
  async grantProviderOwner(input: { readonly providerId: string; readonly hostAccountId: string; readonly nowUtc: string }): Promise<GrantProviderOwnerResult> {
    if (typeof input?.providerId !== "string") throw new StoreValidationError("providerId must be a stable 1-256 character identifier.");
    assertStoreIdentifier(input.providerId, "providerId");
    const account = hostAccountId(input.hostAccountId);
    const at = now(input.nowUtc);
    const providerId = input.providerId;
    return withTransaction(this.#pool, async (client) => {
      // The same key as ensureMappedOwnerMembership's: one identity's OWNER bindings take turns, whatever path writes them.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${OWNER_LOCK_SEED}))`, [`experience-host-owner:${account}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${PROVIDER_HOST_OWNER_LOCK_SEED}))`, [`experience-provider-host-owner:${providerId}`]);
      const provider = await client.query("SELECT 1 FROM experience_providers WHERE id = $1", [providerId]);
      if ((provider.rowCount ?? 0) === 0) return { kind: "provider-not-found" } as const;
      const host = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR SHARE", [account]);
      if (host.rows[0]?.status !== "ACTIVE") return { kind: "host-account-not-active" } as const;
      const existing = await client.query<DbRow>(
        "SELECT role, active FROM provider_memberships WHERE provider_id = $1 AND niho_user_id = $2 FOR UPDATE",
        [providerId, account],
      );
      if (existing.rows[0]) {
        return existing.rows[0].role === "OWNER" && existing.rows[0].active === true
          ? { kind: "already-owner" } as const
          : { kind: "membership-conflict" } as const;
      }
      const elsewhere = await client.query(
        "SELECT 1 FROM provider_memberships WHERE niho_user_id = $1 AND active AND role = 'OWNER' LIMIT 1",
        [account],
      );
      if ((elsewhere.rowCount ?? 0) > 0) return { kind: "owner-of-another-provider" } as const;
      const hostOwner = await client.query(
        "SELECT 1 FROM provider_memberships WHERE provider_id = $1 AND active AND role = 'OWNER' AND niho_user_id ~ '^hst_[0-9a-f]{32}$' LIMIT 1",
        [providerId],
      );
      if ((hostOwner.rowCount ?? 0) > 0) return { kind: "provider-has-host-owner" } as const;
      await client.query(
        `INSERT INTO provider_memberships (provider_id, niho_user_id, role, active, created_at, updated_at)
         VALUES ($1, $2, 'OWNER', true, $3::timestamptz, $3::timestamptz)`,
        [providerId, account, at],
      );
      return { kind: "granted" } as const;
    });
  }
}
