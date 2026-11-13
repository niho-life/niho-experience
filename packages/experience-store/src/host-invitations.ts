import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { linkNihoIdentityIn } from "./host-account-identities.ts";
import { HOST_ACCOUNT_LIMITS, isHostAccountId } from "./host-accounts.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * ホストの招待リンク (Epic #591, #596, migration 0084): Admin/ops invites a registered host account to bind its NIHO account.
 *
 *   createInvitation (ops)  →  the mail job mints the link token and emails it (listPendingInvitations, issueInvitationLink)
 *   →  the host opens the link (openInvitation: the first browser to open it is the one the invitation belongs to)
 *   →  NIHO signs them in  →  acceptInvitation binds the NIHO account to the host account and uses the invitation up,
 *      in one transaction. The web layer then opens the session (HostAccountIdentities.startSessionForNihoIdentity).
 *
 * The link token is 32 random bytes (base64url); only its SHA-256 is stored, and it leaves this module in the return value of
 * issueInvitationLink only (for the email's URL fragment). It works until `expires_at`, once, in one browser. The browser is
 * known by the SHA-256 of a random value in its HttpOnly cookie, compared in constant time. Nothing here changes a host
 * account, its roles or anything it authored: the host account (`hst_`) stays the person's ID, the NIHO account is added.
 *
 * Nothing here logs, and nothing returns a NIHO user ID. Every time is the caller's `nowUtc`.
 */

export const HOST_INVITATION_LIMITS = {
  /** An invitation link works this long after ops created it (ops invites again when it ran out). */
  ttlDays: 7,
  pendingLimitMax: 100,
} as const;

export type CreateHostInvitationResult =
  | { readonly kind: "created"; readonly invitationId: string; readonly expiresAtUtc: string; readonly superseded: boolean }
  /** No such account, or it is suspended. */
  | { readonly kind: "host-account-not-active" }
  /** A NIHO account is already bound to the host account: nothing to invite for (unbind it first to bind another). */
  | { readonly kind: "already-linked" };

export type HostInvitationLinkIssue =
  | {
    readonly kind: "send";
    /** For the email's URL fragment only: never in a path, a query, a log or a queue. */
    readonly token: string;
    readonly toEmail: string;
    readonly expiresAtUtc: string;
  }
  | { readonly kind: "skip" };

/** What opening the link told: `opened`, or why the link cannot be used (the page says it in words). */
export type OpenHostInvitationResult =
  | { readonly kind: "opened" }
  | { readonly kind: "expired" | "used" | "other-browser" | "invalid" }
  /** This browser's value already belongs to another open invitation (a shared browser): the caller opens again with a new value. */
  | { readonly kind: "binding-in-use" };

export type AcceptHostInvitationResult =
  | { readonly kind: "accepted"; readonly hostAccountId: string }
  /** No open invitation belongs to this browser (it ran out, was used, was replaced, or was never opened here). */
  | { readonly kind: "invalid" }
  /** The NIHO account is bound to another host account (recorded; the invitation stays usable). */
  | { readonly kind: "identity-in-use" }
  /** The host account is bound to another NIHO account (recorded; the invitation stays usable). */
  | { readonly kind: "account-has-identity" }
  | { readonly kind: "host-account-not-active" };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITATION_LOCK_SEED = 79;

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const newSecret = (): string => randomBytes(32).toString("base64url");
const isBindingHash = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.byteLength === 32;

function nowOf(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function accountOf(value: unknown): string {
  if (!isHostAccountId(value)) throw new StoreValidationError("hostAccountId must be a host account ID.");
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

/** Invitations of host accounts: created by ops, emailed by the mail job, opened and accepted by the host. */
export class HostInvitations {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Admin/ops: invites an `ACTIVE` host account. An earlier invitation of the account that is still open is superseded
   * (its link stops working). The invitation is the email's queue entry: the mail job sends it. `already-linked` when a
   * NIHO account is bound already.
   */
  async createInvitation(input: { readonly hostAccountId: string; readonly nowUtc: string }): Promise<CreateHostInvitationResult> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const at = nowOf(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${INVITATION_LOCK_SEED}))`, [`host-invitation:${hostAccountId}`]);
      const account = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR SHARE", [hostAccountId]);
      if (account.rows[0]?.status !== "ACTIVE") return { kind: "host-account-not-active" } as const;
      const bound = await client.query("SELECT 1 FROM host_account_identities WHERE host_account_id = $1 AND provider = 'NIHO' AND unlinked_at IS NULL", [hostAccountId]);
      if ((bound.rowCount ?? 0) > 0) return { kind: "already-linked" } as const;
      const superseded = await client.query(
        `UPDATE host_account_invitations SET revoked_at = GREATEST($2::timestamptz, created_at)
          WHERE host_account_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [hostAccountId, at],
      );
      const created = await client.query<DbRow>(
        `INSERT INTO host_account_invitations (host_account_id, created_at, expires_at)
         VALUES ($1, $2::timestamptz, $2::timestamptz + make_interval(days => $3))
         RETURNING id::text AS id, expires_at`,
        [hostAccountId, at, HOST_INVITATION_LIMITS.ttlDays],
      );
      const row = created.rows[0]!;
      return { kind: "created", invitationId: text(row, "id"), expiresAtUtc: isoValue(row, "expires_at"), superseded: (superseded.rowCount ?? 0) > 0 } as const;
    });
  }

  /** Admin/ops: ends the host account's open invitation (its link stops working). true when there was one. */
  async revokeInvitation(input: { readonly hostAccountId: string; readonly nowUtc: string }): Promise<boolean> {
    const hostAccountId = accountOf(input?.hostAccountId);
    const at = nowOf(input.nowUtc);
    const revoked = await this.#pool.query(
      `UPDATE host_account_invitations SET revoked_at = GREATEST($2::timestamptz, created_at)
        WHERE host_account_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [hostAccountId, at],
    );
    return (revoked.rowCount ?? 0) > 0;
  }

  /** The mail job: invitations whose link is still to be sent (not minted, open, not expired, account ACTIVE), oldest first. */
  async listPendingInvitations(input: { readonly nowUtc: string; readonly limit: number }): Promise<readonly string[]> {
    const at = nowOf(input?.nowUtc);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > HOST_INVITATION_LIMITS.pendingLimitMax) {
      throw new StoreValidationError(`limit must be an integer from 1 to ${HOST_INVITATION_LIMITS.pendingLimitMax}.`);
    }
    const found = await this.#pool.query<DbRow>(
      `SELECT i.id::text AS id
         FROM host_account_invitations i
         JOIN host_accounts a ON a.id = i.host_account_id
        WHERE i.token_hash IS NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
          AND i.created_at <= $1::timestamptz AND i.expires_at > $1::timestamptz AND a.status = 'ACTIVE'
          -- The same conditions issueInvitationLink holds, so nothing listed is skipped for good and clogs the batch.
          AND NOT EXISTS (SELECT 1 FROM host_account_identities x WHERE x.host_account_id = i.host_account_id AND x.provider = 'NIHO' AND x.unlinked_at IS NULL)
        ORDER BY i.created_at, i.id
        LIMIT $2`,
      [at, input.limit],
    );
    return found.rows.map((row) => text(row, "id"));
  }

  /**
   * The mail job: mints an invitation's link token, once. `skip` for an invitation that is unknown, superseded, used,
   * expired or already minted, or whose account is suspended or bound meanwhile. The raw token is in the result only.
   */
  async issueInvitationLink(input: { readonly invitationId: string; readonly nowUtc: string }): Promise<HostInvitationLinkIssue> {
    if (typeof input?.invitationId !== "string" || !UUID.test(input.invitationId)) throw new StoreValidationError("invitationId must be a UUID.");
    const at = nowOf(input.nowUtc);
    const token = newSecret();
    const issued = await this.#pool.query<DbRow>(
      `UPDATE host_account_invitations i SET token_hash = $2, issued_at = $3::timestamptz
         FROM host_accounts a
        WHERE i.id = $1::uuid AND a.id = i.host_account_id AND i.token_hash IS NULL
          AND i.consumed_at IS NULL AND i.revoked_at IS NULL
          AND i.created_at <= $3::timestamptz AND i.expires_at > $3::timestamptz AND a.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM host_account_identities x WHERE x.host_account_id = i.host_account_id AND x.provider = 'NIHO' AND x.unlinked_at IS NULL)
       RETURNING a.email, i.expires_at`,
      [input.invitationId.toLowerCase(), digest(token), at],
    );
    const row = issued.rows[0];
    return row ? { kind: "send", token, toEmail: text(row, "email"), expiresAtUtc: isoValue(row, "expires_at") } : { kind: "skip" };
  }

  /**
   * The host opens the emailed link: the browser that does so first is the one the invitation belongs to (its cookie's
   * SHA-256 is kept); the same browser may open it again before the invitation is used up. Another browser gets
   * `other-browser`. `binding-in-use`: the browser's value holds another open invitation. `expired` covers a link that ran out or was replaced by a newer one, `used` one that bound its NIHO
   * account already, `invalid` anything unknown (the token is 256 random bits, so this says nothing about any account).
   */
  async openInvitation(input: { readonly token: string; readonly browserBindingHash: Uint8Array; readonly nowUtc: string }): Promise<OpenHostInvitationResult> {
    const at = nowOf(input?.nowUtc);
    if (typeof input.token !== "string" || !TOKEN.test(input.token) || !isBindingHash(input.browserBindingHash)) return { kind: "invalid" };
    const binding = input.browserBindingHash;
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT i.id::text AS id, i.browser_binding_hash, i.expires_at <= $2::timestamptz AS expired, i.consumed_at IS NOT NULL AS used,
                i.revoked_at IS NOT NULL AS revoked, a.status
           FROM host_account_invitations i
           JOIN host_accounts a ON a.id = i.host_account_id
          WHERE i.token_hash = $1
          FOR UPDATE OF i`,
        [digest(input.token), at],
      );
      const invitation = found.rows[0];
      if (!invitation) return { kind: "invalid" } as const;
      if (invitation.used === true) return { kind: "used" } as const;
      if (invitation.revoked === true || invitation.expired === true) return { kind: "expired" } as const;
      if (invitation.status !== "ACTIVE") return { kind: "invalid" } as const;
      if (invitation.browser_binding_hash !== null) return sameHash(invitation.browser_binding_hash, binding) ? { kind: "opened" } as const : { kind: "other-browser" } as const;
      try {
        await client.query(
          "UPDATE host_account_invitations SET browser_binding_hash = $2, opened_at = $3::timestamptz WHERE id = $1::uuid",
          [invitation.id, Buffer.from(binding), at],
        );
      } catch (error) {
        // The same cookie value already holds another open invitation: a browser belongs to one open invitation at a time.
        if ((error as { code?: unknown } | null)?.code === "23505") return { kind: "binding-in-use" } as const;
        throw error;
      }
      return { kind: "opened" } as const;
    });
  }

  /**
   * The NIHO sign-in came back in the browser that opened the link: binds the NIHO account to the invitation's host account
   * and uses the invitation up, in one transaction. A NIHO account bound elsewhere, or a host account bound to another NIHO
   * account, is refused and recorded and the invitation stays usable (the host signs in with the right NIHO account, or ops
   * fixes the binding). `invalid` when no open invitation belongs to this browser.
   */
  async acceptInvitation(input: { readonly browserBindingHash: Uint8Array; readonly nihoUserId: string; readonly nowUtc: string }): Promise<AcceptHostInvitationResult> {
    const at = nowOf(input?.nowUtc);
    if (!isBindingHash(input.browserBindingHash)) return { kind: "invalid" };
    const binding = Buffer.from(input.browserBindingHash);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT id::text AS id, host_account_id
           FROM host_account_invitations
          WHERE browser_binding_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL
            AND issued_at IS NOT NULL AND expires_at > $2::timestamptz
          FOR UPDATE`,
        [binding, at],
      );
      const invitation = found.rows[0];
      if (!invitation) return { kind: "invalid" } as const;
      const hostAccountId = text(invitation, "host_account_id");
      const linked = await linkNihoIdentityIn(client, { hostAccountId, nihoUserId: input.nihoUserId, via: "INVITATION", nowUtc: at });
      if (linked.kind !== "linked" && linked.kind !== "already-linked") {
        if (linked.kind === "identity-in-use" || linked.kind === "account-has-identity" || linked.kind === "host-account-not-active") return { kind: linked.kind } as const;
        throw new StoreError("The invitation could not be accepted.");
      }
      await client.query("UPDATE host_account_invitations SET consumed_at = $2::timestamptz WHERE id = $1::uuid", [invitation.id, at]);
      return { kind: "accepted", hostAccountId } as const;
    });
  }
}
