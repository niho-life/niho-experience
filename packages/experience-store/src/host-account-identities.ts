import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreError, StoreValidationError } from "./errors.ts";
import { HOST_ACCOUNT_LIMITS, isHostAccountId, openHostSessionIn, type HostLoginResult } from "./host-accounts.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * ログインを NIHO アカウントへ揃える (Epic #591, #593, migration 0083): a host account (`hst_`) is bound to one NIHO
 * account, and a NIHO sign-in that proves the account opens an Experience session for the `hst_` it is bound to.
 *
 * - NIHO only proves who is signing in. Nothing here keeps a NIHO token; the NIHO user ID (the binding's `subject`) is
 *   read by this module and the audit trail only, and never leaves it in a return value, a log or an error message.
 * - The person's ID in Experience stays `hst_`. A binding adds a row; no actor column, article author, publication
 *   version or photo is rewritten.
 * - A NIHO account is bound to one host account at a time, and a host account has one NIHO account at a time. Binding is
 *   refused, and the refusal is recorded, when either side is taken. Unlinking keeps the row (history).
 * - Only an ACTIVE host account is bound or opens a session. Ops registers the host account first (#596); a NIHO account
 *   nobody registered gets `not-linked`.
 * - Binding needs a proof the caller states in its input and this module checks: the host's own recent session plus a
 *   recent NIHO sign-in (settings), or Admin/ops. An invitation link (#596) is consumed by the caller in the same
 *   transaction and binds through `linkNihoIdentityIn`.
 *
 * Every time is the caller's `nowUtc` (a canonical UTC instant), as in HostAccounts.
 */

export type NihoIdentityRoute = "INVITATION" | "SETTINGS" | "OPS" | "WRITER";

/** What allows a binding or an unbinding: the host's own session in 設定, or Admin/ops by hand. */
export type NihoIdentityLinkProof =
  | {
    readonly kind: "SESSION";
    /** The host's current session (HostSession.sessionRef): it must belong to the account and have been opened by a recent sign-in. */
    readonly sessionRef: string;
    /** NIHO's `auth_time` of the sign-in that produced this NIHO user ID: within the recent-authentication window. */
    readonly nihoAuthenticatedAtUtc: string;
  }
  | { readonly kind: "OPS" };

export type NihoIdentityUnlinkProof =
  | {
    readonly kind: "SESSION";
    readonly sessionRef: string;
    /** Whether the host can still sign in another way (the email link) once the NIHO account is unbound. */
    readonly emailSignInAvailable: boolean;
  }
  | { readonly kind: "OPS" };

export type LinkNihoIdentityResult =
  | { readonly kind: "linked" | "already-linked" }
  | {
    readonly kind:
      /** No such account, or it is suspended. */
      | "host-account-not-active"
      /** The NIHO account is bound to another host account (recorded). */
      | "identity-in-use"
      /** This host account is bound to another NIHO account: unbind it first (recorded). */
      | "account-has-identity"
      /** The proof is missing, too old or not this account's session (recorded). */
      | "recent-authentication-required";
  };

export type UnlinkNihoIdentityResult =
  | { readonly kind: "unlinked" | "not-linked" | "recent-authentication-required" }
  /** Nothing else would let the host in (recorded). */
  | { readonly kind: "last-sign-in-method" };

export type NihoSessionResult =
  | Extract<HostLoginResult, { readonly kind: "ok" }>
  /** No active binding for this NIHO account: nobody registered it as a host. */
  | { readonly kind: "not-linked" }
  /** Bound to a host account that is suspended. */
  | { readonly kind: "account-suspended" };

/** The active binding of a host account as 設定 shows it. The NIHO user ID is not part of it. */
export interface NihoIdentityStatus {
  readonly linkedAtUtc: string;
  readonly lastLoginAtUtc: string | null;
  readonly linkedVia: NihoIdentityRoute;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_MAX = 256;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A host account or seller reference is never a NIHO user ID (docs/host-accounts.md). */
const NOT_A_NIHO_ID = /^(?:hst|sel)_/;
/** NIHO's `auth_time` cannot be older than this: a bound on garbage, not a policy (the recent-authentication rule is stricter). */
const NIHO_AUTH_MAX_AGE_DAYS = 400;
const SUBJECT_LOCK_SEED = 71;
const ACCOUNT_LOCK_SEED = 73;
const UNIQUE_VIOLATION = "23505";

function nowOf(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function accountOf(value: unknown): string {
  if (!isHostAccountId(value)) throw new StoreValidationError("hostAccountId must be a host account ID.");
  return value;
}

function subjectOf(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > SUBJECT_MAX || CONTROL.test(value) || NOT_A_NIHO_ID.test(value)) {
    throw new StoreValidationError("nihoUserId must be a NIHO user ID.");
  }
  return value;
}

function sessionRefOf(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("sessionRef must be a UUID.");
  return value.toLowerCase();
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function routeOf(row: DbRow): NihoIdentityRoute {
  const via = row.linked_via;
  if (via !== "INVITATION" && via !== "SETTINGS" && via !== "OPS" && via !== "WRITER") throw new StoreError("Database returned an invalid linked_via.");
  return via;
}

type RefusalReason = "IDENTITY_IN_USE" | "ACCOUNT_HAS_IDENTITY" | "RECENT_AUTHENTICATION_REQUIRED" | "LAST_SIGN_IN_METHOD";

async function recordEvent(
  client: PoolClient,
  input: { readonly hostAccountId: string; readonly kind: "LINKED" | "UNLINKED" | "LINK_REFUSED" | "UNLINK_REFUSED"; readonly subject: string; readonly via: NihoIdentityRoute; readonly reason?: RefusalReason; readonly at: string },
): Promise<void> {
  await client.query(
    `INSERT INTO host_account_identity_events (host_account_id, event_kind, provider, subject, via, reason, occurred_at)
     VALUES ($1, $2, 'NIHO', $3, $4, $5, $6::timestamptz)`,
    [input.hostAccountId, input.kind, input.subject, input.via, input.reason ?? null, input.at],
  );
}

/**
 * True when `sessionRef` is a live session of the ACTIVE account, at the account's current version, opened by a sign-in
 * no older than the recent-authentication window (and not from the future). Run with the account row locked.
 */
async function recentSession(client: PoolClient, hostAccountId: string, sessionRef: string, at: string): Promise<boolean> {
  const found = await client.query(
    `SELECT 1
       FROM host_sessions s
       JOIN host_accounts a ON a.id = s.host_account_id
      WHERE s.host_account_id = $1 AND s.session_ref = $2::uuid AND s.revoked_at IS NULL
        AND s.idle_expires_at > $3::timestamptz AND s.absolute_expires_at > $3::timestamptz
        AND a.status = 'ACTIVE' AND a.session_version = s.session_version
        AND s.authenticated_at >= $3::timestamptz - make_interval(mins => $4)
        AND s.authenticated_at <= $3::timestamptz`,
    [hostAccountId, sessionRef, at, HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes],
  );
  return (found.rowCount ?? 0) > 0;
}

function recentNihoAuthentication(authenticatedAtUtc: unknown, at: string): boolean {
  if (typeof authenticatedAtUtc !== "string") throw new StoreValidationError("nihoAuthenticatedAtUtc must be a canonical UTC instant.");
  assertCanonicalInstant(authenticatedAtUtc, "nihoAuthenticatedAtUtc");
  const authenticated = Date.parse(authenticatedAtUtc);
  const now = Date.parse(at);
  return authenticated <= now && authenticated >= now - HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes * 60_000;
}

/** One identity's bindings take turns, whatever path writes them: the NIHO account first, then the host account. */
async function lockBindings(client: PoolClient, hostAccountId: string, subject: string | null): Promise<void> {
  if (subject !== null) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${SUBJECT_LOCK_SEED}))`, [`niho-identity-subject:${subject}`]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${ACCOUNT_LOCK_SEED}))`, [`niho-identity-account:${hostAccountId}`]);
}

async function activeAccount(client: PoolClient, hostAccountId: string): Promise<boolean> {
  const host = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR SHARE", [hostAccountId]);
  return host.rows[0]?.status === "ACTIVE";
}

/** The binding itself, after the proof: idempotent for the same pair, refused (and recorded) when either side is taken. */
async function bind(client: PoolClient, input: { readonly hostAccountId: string; readonly subject: string; readonly via: NihoIdentityRoute; readonly at: string }): Promise<LinkNihoIdentityResult> {
  const { hostAccountId, subject, via, at } = input;
  const own = await client.query<DbRow>(
    "SELECT subject FROM host_account_identities WHERE host_account_id = $1 AND provider = 'NIHO' AND unlinked_at IS NULL",
    [hostAccountId],
  );
  if (own.rows[0]) {
    if (own.rows[0].subject === subject) return { kind: "already-linked" };
    await recordEvent(client, { hostAccountId, kind: "LINK_REFUSED", subject, via, reason: "ACCOUNT_HAS_IDENTITY", at });
    return { kind: "account-has-identity" };
  }
  const taken = await client.query("SELECT 1 FROM host_account_identities WHERE provider = 'NIHO' AND subject = $1 AND unlinked_at IS NULL", [subject]);
  if ((taken.rowCount ?? 0) > 0) {
    await recordEvent(client, { hostAccountId, kind: "LINK_REFUSED", subject, via, reason: "IDENTITY_IN_USE", at });
    return { kind: "identity-in-use" };
  }
  try {
    await client.query(
      `INSERT INTO host_account_identities (host_account_id, provider, subject, linked_via, linked_at)
       VALUES ($1, 'NIHO', $2, $3, $4::timestamptz)`,
      [hostAccountId, subject, via, at],
    );
  } catch (error) {
    // The locks above make a race impossible; the unique indexes are the last guard.
    if ((error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) throw new StoreConflictError("The NIHO account binding changed concurrently; try again.");
    throw error;
  }
  await recordEvent(client, { hostAccountId, kind: "LINKED", subject, via, at });
  return { kind: "linked" };
}

/**
 * Binds a NIHO account to an ACTIVE host account inside the caller's transaction, with no proof check: the caller has
 * already proven the person (an invitation link consumed in the same transaction, #596). The same locks and outcomes as
 * HostAccountIdentities.linkNihoIdentity. Inputs are validated here.
 */
export async function linkNihoIdentityIn(
  client: PoolClient,
  input: { readonly hostAccountId: string; readonly nihoUserId: string; readonly via: NihoIdentityRoute; readonly nowUtc: string },
): Promise<LinkNihoIdentityResult> {
  const hostAccountId = accountOf(input?.hostAccountId);
  const subject = subjectOf(input.nihoUserId);
  const at = nowOf(input.nowUtc);
  if (input.via !== "INVITATION" && input.via !== "SETTINGS" && input.via !== "OPS") throw new StoreValidationError("via must be INVITATION, SETTINGS or OPS.");
  await lockBindings(client, hostAccountId, subject);
  if (!await activeAccount(client, hostAccountId)) return { kind: "host-account-not-active" };
  return bind(client, { hostAccountId, subject, via: input.via, at });
}

export type InvitedNihoIdentityResult =
  | { readonly kind: "resolved"; readonly hostAccountId: string; readonly created: boolean }
  | { readonly kind: "host-account-not-active" | "email-account-has-identity" };

const INVITED_EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * 招待を受けた NIHO アカウントのホストアカウントを決める (#636), inside the caller's transaction (the invitation is used up in
 * the same one). The NIHO account is what counts; the invitation's address is only where the email went:
 * - a NIHO account already bound to a host account: that account (an account without an address takes the invited one when
 *   no other account has it);
 * - otherwise the ACTIVE host account that has the invited address and no NIHO account: the NIHO account is bound to it
 *   (opening the link proves the address, so it is marked verified);
 * - an account with that address bound to another NIHO account is refused, and nothing is recorded (its owner may be someone
 *   else); a suspended one is refused;
 * - no account at all: a new one is made with the address and the NIHO account bound to it.
 * The NIHO user ID never leaves this function. Locks: the NIHO account, then the host account, then its row.
 */
export async function resolveHostAccountForInvitedNihoIdentityIn(
  client: PoolClient,
  input: { readonly nihoUserId: string; readonly email: string; readonly emailKey: string; readonly nowUtc: string },
): Promise<InvitedNihoIdentityResult> {
  const subject = subjectOf(input?.nihoUserId);
  const at = nowOf(input.nowUtc);
  const { email, emailKey } = input;
  if (typeof email !== "string" || typeof emailKey !== "string" || email.length < 3 || email.length > 254 || emailKey.length < 3 || emailKey.length > 254
    || !INVITED_EMAIL.test(email) || !INVITED_EMAIL.test(emailKey)) {
    throw new StoreValidationError("email must be an email address of 3-254 characters.");
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${SUBJECT_LOCK_SEED}))`, [`niho-identity-subject:${subject}`]);
  const bound = await client.query<DbRow>(
    "SELECT host_account_id FROM host_account_identities WHERE provider = 'NIHO' AND subject = $1 AND unlinked_at IS NULL",
    [subject],
  );
  if (bound.rows[0]) {
    const hostAccountId = text(bound.rows[0], "host_account_id");
    await lockBindings(client, hostAccountId, subject);
    const again = await client.query("SELECT 1 FROM host_account_identities WHERE provider = 'NIHO' AND subject = $1 AND host_account_id = $2 AND unlinked_at IS NULL", [subject, hostAccountId]);
    if ((again.rowCount ?? 0) === 0) throw new StoreConflictError("The NIHO account binding changed concurrently; try again.");
    const account = await client.query<DbRow>("SELECT status, email_key FROM host_accounts WHERE id = $1 FOR UPDATE", [hostAccountId]);
    if (account.rows[0]?.status !== "ACTIVE") return { kind: "host-account-not-active" };
    if (account.rows[0].email_key === null) {
      const taken = await client.query("SELECT 1 FROM host_accounts WHERE email_key = $1", [emailKey]);
      if ((taken.rowCount ?? 0) === 0) {
        try {
          await client.query(
            `UPDATE host_accounts SET email = $2, email_key = $3, email_verified_at = GREATEST($4::timestamptz, created_at), updated_at = GREATEST(updated_at, $4::timestamptz)
              WHERE id = $1`,
            [hostAccountId, email, emailKey, at],
          );
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) throw new StoreConflictError("The address was taken concurrently; try again.");
          throw error;
        }
      }
    }
    return { kind: "resolved", hostAccountId, created: false };
  }

  const byEmail = await client.query<DbRow>("SELECT id FROM host_accounts WHERE email_key = $1", [emailKey]);
  if (byEmail.rows[0]) {
    const hostAccountId = text(byEmail.rows[0], "id");
    await lockBindings(client, hostAccountId, subject);
    const account = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 AND email_key = $2 FOR UPDATE", [hostAccountId, emailKey]);
    if (!account.rows[0]) throw new StoreConflictError("The host account changed concurrently; try again.");
    if (account.rows[0].status !== "ACTIVE") return { kind: "host-account-not-active" };
    const other = await client.query("SELECT 1 FROM host_account_identities WHERE host_account_id = $1 AND provider = 'NIHO' AND unlinked_at IS NULL", [hostAccountId]);
    if ((other.rowCount ?? 0) > 0) return { kind: "email-account-has-identity" };
    const linked = await bind(client, { hostAccountId, subject, via: "INVITATION", at });
    if (linked.kind !== "linked") throw new StoreError("The invited NIHO account could not be bound.");
    await client.query(
      `UPDATE host_accounts SET email_verified_at = COALESCE(email_verified_at, GREATEST($2::timestamptz, created_at)), updated_at = GREATEST(updated_at, $2::timestamptz)
        WHERE id = $1`,
      [hostAccountId, at],
    );
    return { kind: "resolved", hostAccountId, created: false };
  }

  const hostAccountId = `hst_${randomBytes(16).toString("hex")}`;
  await lockBindings(client, hostAccountId, subject);
  try {
    await client.query(
      `INSERT INTO host_accounts (id, email, email_key, email_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
      [hostAccountId, email, emailKey, at],
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) throw new StoreConflictError("The address was taken concurrently; try again.");
    throw error;
  }
  const linked = await bind(client, { hostAccountId, subject, via: "INVITATION", at });
  if (linked.kind !== "linked") throw new StoreError("The invited NIHO account could not be bound.");
  return { kind: "resolved", hostAccountId, created: true };
}

/** NIHO accounts bound to host accounts, and the NIHO sign-in that opens an Experience session for a bound one. */
export class HostAccountIdentities {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Binds a NIHO account to an ACTIVE host account. `SESSION`: the host's own session in 設定 must have been opened by
   * a sign-in within the recent-authentication window, and so must the NIHO sign-in that gave this user ID; `OPS`:
   * Admin/ops by hand. A NIHO account already bound to another host account, or a host account already bound to another
   * NIHO account, is refused and the refusal recorded. The same pair again changes nothing.
   */
  async linkNihoIdentity(input: {
    readonly hostAccountId: string;
    readonly nihoUserId: string;
    readonly proof: NihoIdentityLinkProof;
    readonly nowUtc: string;
  }): Promise<LinkNihoIdentityResult> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const subject = subjectOf(input.nihoUserId);
    const at = nowOf(input.nowUtc);
    const proof = input.proof;
    if (proof?.kind !== "SESSION" && proof?.kind !== "OPS") throw new StoreValidationError("proof must be a session or ops.");
    const sessionRef = proof.kind === "SESSION" ? sessionRefOf(proof.sessionRef) : null;
    const nihoRecent = proof.kind === "SESSION" ? recentNihoAuthentication(proof.nihoAuthenticatedAtUtc, at) : true;
    const via: NihoIdentityRoute = proof.kind === "SESSION" ? "SETTINGS" : "OPS";
    return withTransaction(this.#pool, async (client) => {
      await lockBindings(client, hostAccountId, subject);
      if (!await activeAccount(client, hostAccountId)) return { kind: "host-account-not-active" } as const;
      if (sessionRef !== null && (!nihoRecent || !await recentSession(client, hostAccountId, sessionRef, at))) {
        await recordEvent(client, { hostAccountId, kind: "LINK_REFUSED", subject, via, reason: "RECENT_AUTHENTICATION_REQUIRED", at });
        return { kind: "recent-authentication-required" } as const;
      }
      return bind(client, { hostAccountId, subject, via, at });
    });
  }

  /**
   * Opens an Experience session for the host account a NIHO account is bound to, once the web layer has proven the NIHO
   * account (code exchange and `identity`). `authenticatedAtUtc` is NIHO's `auth_time` (the sign-in the person did at
   * NIHO), never after `nowUtc`; it is the session's `authenticated_at`, so the recent-authentication rule reads NIHO's
   * sign-in. The session is as any other: the account's current `session_version`, 14 idle days, 30 at most, signed out
   * and ended the same way. `not-linked` for a NIHO account nobody registered, `account-suspended` for a suspended one.
   */
  async startSessionForNihoIdentity(input: { readonly nihoUserId: string; readonly authenticatedAtUtc: string; readonly nowUtc: string }): Promise<NihoSessionResult> {
    const subject = subjectOf(input?.nihoUserId);
    const at = nowOf(input.nowUtc);
    if (typeof input.authenticatedAtUtc !== "string") throw new StoreValidationError("authenticatedAtUtc must be a canonical UTC instant.");
    assertCanonicalInstant(input.authenticatedAtUtc, "authenticatedAtUtc");
    const authenticated = Date.parse(input.authenticatedAtUtc);
    const now = Date.parse(at);
    if (authenticated > now || authenticated < now - NIHO_AUTH_MAX_AGE_DAYS * 86_400_000) {
      throw new StoreValidationError("authenticatedAtUtc must not be in the future or older than 400 days.");
    }
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT i.id::text AS id, i.host_account_id, a.status, a.session_version
           FROM host_account_identities i
           JOIN host_accounts a ON a.id = i.host_account_id
          WHERE i.provider = 'NIHO' AND i.subject = $1 AND i.unlinked_at IS NULL
          FOR UPDATE OF i
          FOR SHARE OF a`,
        [subject],
      );
      const binding = found.rows[0];
      if (!binding) return { kind: "not-linked" } as const;
      if (binding.status !== "ACTIVE") return { kind: "account-suspended" } as const;
      await client.query(
        "UPDATE host_account_identities SET last_login_at = GREATEST(last_login_at, linked_at, $2::timestamptz) WHERE id = $1::uuid",
        [binding.id, at],
      );
      return openHostSessionIn(client, {
        hostAccountId: text(binding, "host_account_id"),
        sessionVersion: Number(binding.session_version),
        createdAtUtc: at,
        authenticatedAtUtc: input.authenticatedAtUtc,
      });
    });
  }

  /**
   * First /write sign-in for a current NIHO writer. The web layer calls this only after the just-verified NIHO identity
   * passed the current writer-authority check. Provisioning the email-less hst_ actor, its immutable NIHO binding and the
   * first session is one idempotent transaction. A pre-existing host/writer binding is preserved and reused.
   */
  async startWriterSessionForNihoIdentity(input: { readonly nihoUserId: string; readonly authenticatedAtUtc: string; readonly nowUtc: string }): Promise<NihoSessionResult> {
    const subject = subjectOf(input?.nihoUserId);
    const at = nowOf(input.nowUtc);
    if (typeof input.authenticatedAtUtc !== "string") throw new StoreValidationError("authenticatedAtUtc must be a canonical UTC instant.");
    assertCanonicalInstant(input.authenticatedAtUtc, "authenticatedAtUtc");
    const authenticated = Date.parse(input.authenticatedAtUtc);
    const current = Date.parse(at);
    if (authenticated > current || authenticated < current - NIHO_AUTH_MAX_AGE_DAYS * 86_400_000) {
      throw new StoreValidationError("authenticatedAtUtc must not be in the future or older than 400 days.");
    }
    return withTransaction(this.#pool, async (client) => {
      // All identity writers take the subject lock first. Once the target account is known, take its account lock too
      // and re-read: unlinking is account-locked, so this prevents provisioning beside a concurrent unlink/relink.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${SUBJECT_LOCK_SEED}))`, [`niho-identity-subject:${subject}`]);
      let existing = await client.query<DbRow>(
        `SELECT i.id::text AS id, i.host_account_id, a.status, a.session_version
           FROM host_account_identities i
           JOIN host_accounts a ON a.id=i.host_account_id
          WHERE i.provider='NIHO' AND i.subject=$1 AND i.unlinked_at IS NULL
          FOR SHARE OF a`,
        [subject],
      );
      let binding = existing.rows[0];
      if (binding) {
        await lockBindings(client, text(binding, "host_account_id"), subject);
        existing = await client.query<DbRow>(
          `SELECT i.id::text AS id, i.host_account_id, a.status, a.session_version
             FROM host_account_identities i
             JOIN host_accounts a ON a.id=i.host_account_id
            WHERE i.provider='NIHO' AND i.subject=$1 AND i.unlinked_at IS NULL
            FOR UPDATE OF i FOR SHARE OF a`,
          [subject],
        );
        binding = existing.rows[0];
      }
      if (binding) {
        if (binding.status !== "ACTIVE") return { kind: "account-suspended" } as const;
        await client.query(
          "UPDATE host_account_identities SET last_login_at=GREATEST(last_login_at, linked_at, $2::timestamptz) WHERE id=$1::uuid",
          [binding.id, at],
        );
        return openHostSessionIn(client, {
          hostAccountId: text(binding, "host_account_id"),
          sessionVersion: Number(binding.session_version),
          createdAtUtc: at,
          authenticatedAtUtc: input.authenticatedAtUtc,
        });
      }
      const hostAccountId = `hst_${randomBytes(16).toString("hex")}`;
      await lockBindings(client, hostAccountId, subject);
      const raced = await client.query<DbRow>(
        `SELECT i.id::text AS id, i.host_account_id, a.status, a.session_version
           FROM host_account_identities i
           JOIN host_accounts a ON a.id=i.host_account_id
          WHERE i.provider='NIHO' AND i.subject=$1 AND i.unlinked_at IS NULL
          FOR UPDATE OF i FOR SHARE OF a`,
        [subject],
      );
      if (raced.rows[0] !== undefined) throw new StoreConflictError("NIHO identity binding changed while the writer account was being provisioned.");
      await client.query(
        `INSERT INTO host_accounts (id,email,email_key,created_at,updated_at)
         VALUES ($1,NULL,NULL,$2::timestamptz,$2::timestamptz)`,
        [hostAccountId, at],
      );
      await client.query(
        `INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at,last_login_at)
         VALUES ($1,'NIHO',$2,'WRITER',$3::timestamptz,$3::timestamptz)`,
        [hostAccountId, subject, at],
      );
      await recordEvent(client, { hostAccountId, kind: "LINKED", subject, via: "WRITER", at });
      return openHostSessionIn(client, {
        hostAccountId,
        sessionVersion: 1,
        createdAtUtc: at,
        authenticatedAtUtc: input.authenticatedAtUtc,
      });
    });
  }

  /** Trusted server-side resolution for NIHO S2S calls. The NIHO subject never enters a browser projection. */
  async readNihoUserId(input: { readonly hostAccountId: string }, queryable: Pool | PoolClient = this.#pool): Promise<string | null> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const found = await queryable.query<DbRow>(
      `SELECT i.subject
         FROM host_account_identities i
         JOIN host_accounts a ON a.id=i.host_account_id AND a.status='ACTIVE'
        WHERE i.host_account_id=$1 AND i.provider='NIHO' AND i.unlinked_at IS NULL`,
      [hostAccountId],
    );
    return found.rows[0] ? text(found.rows[0], "subject") : null;
  }

  /**
   * Unbinds a host account's NIHO account (the row stays, marked). `SESSION`: the host's own recent session, and not
   * when nothing else would let them in (the email-link method must be enabled and the account must have an address);
   * `OPS`: always.
   * `not-linked` when no binding is active.
   */
  async unlinkNihoIdentity(input: { readonly hostAccountId: string; readonly proof: NihoIdentityUnlinkProof; readonly nowUtc: string }): Promise<UnlinkNihoIdentityResult> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const at = nowOf(input.nowUtc);
    const proof = input.proof;
    if (proof?.kind !== "SESSION" && proof?.kind !== "OPS") throw new StoreValidationError("proof must be a session or ops.");
    const sessionRef = proof.kind === "SESSION" ? sessionRefOf(proof.sessionRef) : null;
    const via: NihoIdentityRoute = proof.kind === "SESSION" ? "SETTINGS" : "OPS";
    return withTransaction(this.#pool, async (client) => {
      await lockBindings(client, hostAccountId, null);
      const active = await client.query<DbRow>(
        `SELECT i.id::text AS id, i.subject, a.email IS NOT NULL AS email_sign_in_available
           FROM host_account_identities i JOIN host_accounts a ON a.id = i.host_account_id
          WHERE i.host_account_id = $1 AND i.provider = 'NIHO' AND i.unlinked_at IS NULL
          FOR UPDATE OF i`,
        [hostAccountId],
      );
      const binding = active.rows[0];
      if (!binding) return { kind: "not-linked" } as const;
      const subject = text(binding, "subject");
      if (proof.kind === "SESSION") {
        if (!await recentSession(client, hostAccountId, sessionRef!, at)) {
          await recordEvent(client, { hostAccountId, kind: "UNLINK_REFUSED", subject, via, reason: "RECENT_AUTHENTICATION_REQUIRED", at });
          return { kind: "recent-authentication-required" } as const;
        }
        if (!proof.emailSignInAvailable || binding.email_sign_in_available !== true) {
          await recordEvent(client, { hostAccountId, kind: "UNLINK_REFUSED", subject, via, reason: "LAST_SIGN_IN_METHOD", at });
          return { kind: "last-sign-in-method" } as const;
        }
      }
      await client.query("UPDATE host_account_identities SET unlinked_at = GREATEST($2::timestamptz, linked_at) WHERE id = $1::uuid", [binding.id, at]);
      await recordEvent(client, { hostAccountId, kind: "UNLINKED", subject, via, at });
      return { kind: "unlinked" } as const;
    });
  }

  /** The active binding of a host account for 設定, or null. It never carries the NIHO user ID. */
  async readNihoIdentity(input: { readonly hostAccountId: string }): Promise<NihoIdentityStatus | null> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const found = await this.#pool.query<DbRow>(
      `SELECT linked_at, last_login_at, linked_via FROM host_account_identities
        WHERE host_account_id = $1 AND provider = 'NIHO' AND unlinked_at IS NULL`,
      [hostAccountId],
    );
    const row = found.rows[0];
    if (!row) return null;
    return { linkedAtUtc: isoValue(row, "linked_at"), lastLoginAtUtc: row.last_login_at === null ? null : isoValue(row, "last_login_at"), linkedVia: routeOf(row) };
  }
}
