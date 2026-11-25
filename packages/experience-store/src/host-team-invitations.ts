import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { StoreConflictError, StoreError, StoreValidationError } from "./errors.ts";
import { resolveHostAccountForInvitedNihoIdentityIn } from "./host-account-identities.ts";
import { hostEmail, isHostAccountId } from "./host-accounts.ts";
import { consumeResolveBucket, lockTeam, requireCurrentOwner, type HostTeamActor } from "./host-team.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * メンバーの招待 (#636, migration 0088): a provider's OWNER invites a person (by an address the email goes to) to join as COHOST.
 *
 *   create (OWNER)  →  the mail job mints the link token and emails it (listPending, issueLink)
 *   →  the person opens the link (open: the first browser to open it is the one the invitation belongs to)
 *   →  NIHO signs them in  →  accept finds or makes the person's host account, adds it to the team and uses the invitation
 *      up, in one transaction. The web layer then opens the session (HostAccountIdentities.startSessionForNihoIdentity).
 *
 * The address is where the email goes, not who the person is: whoever opens the link and signs in at NIHO joins. The address
 * is kept only while the invitation is open. The link token is 32 random bytes (base64url); only its SHA-256 is stored, and it
 * leaves this module in the return value of issueLink only (for the email's URL fragment). It works until `expires_at`, once,
 * in one browser (the SHA-256 of a random value in its HttpOnly cookie, compared in constant time).
 *
 * Lock order (every method): the invitation row, the team (advisory lock and revision row), the NIHO account and host account
 * (advisory locks), then the host account and membership rows. create and revoke check the OWNER's membership row first,
 * as every team command does.
 *
 * Nothing here logs, and nothing returns a NIHO user ID. Every time is the caller's `nowUtc`.
 */

export const HOST_TEAM_INVITATION_LIMITS = {
  /** A link works this long after the OWNER invited. */
  ttlDays: 7,
  /** Open invitations (not expired) one provider may have at a time. */
  openPerProviderMax: 20,
  pendingLimitMax: 100,
} as const;

export type HostTeamInvitationState = "QUEUED" | "SENT" | "OPENED";

export interface HostTeamInvitationView {
  readonly invitationId: string;
  readonly email: string;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly state: HostTeamInvitationState;
}

export type CreateHostTeamInvitationResult =
  | { readonly kind: "created"; readonly invitationId: string; readonly expiresAtUtc: string; readonly superseded: boolean }
  /** The address belongs to a current OWNER or COHOST of the provider: nothing written. */
  | { readonly kind: "already-member" }
  | { readonly kind: "too-many-open" };

export type HostTeamInvitationLinkIssue =
  | {
    readonly kind: "send";
    /** For the email's URL fragment only: never in a path, a query, a log or a queue. */
    readonly token: string;
    readonly toEmail: string;
    readonly expiresAtUtc: string;
    readonly providerDisplayName: string | null;
  }
  | { readonly kind: "skip" };

export type OpenHostTeamInvitationResult =
  | { readonly kind: "opened" }
  | { readonly kind: "expired" | "used" | "other-browser" | "invalid" }
  /** This browser's value already belongs to another open invitation: the caller opens again with a new value. */
  | { readonly kind: "binding-in-use" };

export type AcceptHostTeamInvitationResult =
  | { readonly kind: "accepted"; readonly hostAccountId: string; readonly providerId: string; readonly joined: boolean }
  /** No open invitation belongs to this browser (it ran out, was used, was revoked, or was never opened here). */
  | { readonly kind: "invalid" }
  | { readonly kind: "host-account-not-active" }
  /** The address's host account is bound to another NIHO account (nothing recorded; the invitation stays usable). */
  | { readonly kind: "email-account-has-identity" };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const newSecret = (): string => randomBytes(32).toString("base64url");
const isBindingHash = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.byteLength === 32;
const OPEN = "accepted_at IS NULL AND revoked_at IS NULL";

function nowOf(value: unknown): string {
  if (typeof value !== "string") throw new StoreValidationError("nowUtc must be a canonical UTC instant.");
  assertCanonicalInstant(value, "nowUtc");
  return value;
}

function actorOf(input: HostTeamActor): HostTeamActor {
  assertStoreIdentifier(input?.providerId, "providerId");
  if (!isHostAccountId(input?.hostAccountId)) throw new StoreValidationError("hostAccountId must be an Experience host account ID.");
  return { providerId: input.providerId, hostAccountId: input.hostAccountId };
}

function invitationIdOf(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("invitationId must be a UUID.");
  return value.toLowerCase();
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

/** Invitations to a provider's team: created by the OWNER, emailed by the mail job, opened and accepted by the invited person. */
export class HostTeamInvitations {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The OWNER invites an address. An open invitation of the same address is replaced (its link stops working). `already-member`
   * when that address's host account is a current OWNER or COHOST; `too-many-open` at the provider's limit. Counts against the
   * same hourly lookup limit as finding a member by address (StoreRateLimitedError).
   */
  async create(input: { readonly providerId: string; readonly hostAccountId: string; readonly email: string; readonly nowUtc: string }): Promise<CreateHostTeamInvitationResult> {
    const actor = actorOf(input);
    const { email, emailKey } = hostEmail(input?.email);
    const at = nowOf(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await requireCurrentOwner(client, actor, "FOR UPDATE");
      // The invitation row first, then the team (the order accept uses).
      const earlier = await client.query<DbRow>(
        `SELECT id::text AS id FROM provider_team_invitations WHERE provider_id = $1 AND email_key = $2 AND ${OPEN} FOR UPDATE`,
        [actor.providerId, emailKey],
      );
      await lockTeam(client, actor.providerId);
      await consumeResolveBucket(client, actor);
      const member = await client.query(
        `SELECT 1 FROM provider_memberships m JOIN host_accounts a ON a.id = m.niho_user_id
          WHERE m.provider_id = $1 AND a.email_key = $2 AND m.active AND m.role IN ('OWNER', 'COHOST')`,
        [actor.providerId, emailKey],
      );
      if ((member.rowCount ?? 0) > 0) return { kind: "already-member" } as const;
      let superseded = false;
      if (earlier.rows[0]) {
        await client.query(
          "UPDATE provider_team_invitations SET revoked_at = GREATEST($2::timestamptz, created_at), email = NULL, email_key = NULL WHERE id = $1::uuid",
          [text(earlier.rows[0], "id"), at],
        );
        superseded = true;
      }
      const open = await client.query<DbRow>(
        `SELECT count(*)::int AS n FROM provider_team_invitations WHERE provider_id = $1 AND ${OPEN} AND expires_at > $2::timestamptz`,
        [actor.providerId, at],
      );
      if (Number(open.rows[0]?.n ?? 0) >= HOST_TEAM_INVITATION_LIMITS.openPerProviderMax) return { kind: "too-many-open" } as const;
      let created;
      try {
        created = await client.query<DbRow>(
          `INSERT INTO provider_team_invitations (provider_id, role, invited_by_host_account_id, email, email_key, created_at, expires_at)
           VALUES ($1, 'COHOST', $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(days => $6))
           RETURNING id::text AS id, expires_at`,
          [actor.providerId, actor.hostAccountId, email, emailKey, at, HOST_TEAM_INVITATION_LIMITS.ttlDays],
        );
      } catch (error) {
        // Another OWNER of the same provider invited the same address at the same moment: one open invitation per address.
        if ((error as { code?: unknown } | null)?.code === "23505") throw new StoreConflictError("The address was invited concurrently; reload before continuing.");
        throw error;
      }
      const row = created.rows[0]!;
      return { kind: "created", invitationId: text(row, "id"), expiresAtUtc: isoValue(row, "expires_at"), superseded } as const;
    });
  }

  /** The OWNER's open, unexpired invitations, oldest first. */
  async list(input: { readonly providerId: string; readonly hostAccountId: string; readonly nowUtc: string }): Promise<readonly HostTeamInvitationView[]> {
    const actor = actorOf(input);
    const at = nowOf(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await requireCurrentOwner(client, actor);
      const found = await client.query<DbRow>(
        `SELECT id::text AS id, email, created_at, expires_at, token_hash IS NULL AS queued, opened_at IS NOT NULL AS opened
           FROM provider_team_invitations
          WHERE provider_id = $1 AND ${OPEN} AND expires_at > $2::timestamptz
          ORDER BY created_at, id`,
        [actor.providerId, at],
      );
      return found.rows.map((row) => ({
        invitationId: text(row, "id"),
        email: text(row, "email"),
        createdAtUtc: isoValue(row, "created_at"),
        expiresAtUtc: isoValue(row, "expires_at"),
        state: row.opened === true ? "OPENED" : row.queued === true ? "QUEUED" : "SENT",
      } satisfies HostTeamInvitationView));
    });
  }

  /** The OWNER ends one of the provider's open invitations (its link stops working). true when there was one. */
  async revoke(input: { readonly providerId: string; readonly hostAccountId: string; readonly invitationId: string; readonly nowUtc: string }): Promise<boolean> {
    const actor = actorOf(input);
    const invitationId = invitationIdOf(input?.invitationId);
    const at = nowOf(input.nowUtc);
    return withTransaction(this.#pool, async (client) => {
      await requireCurrentOwner(client, actor, "FOR UPDATE");
      const found = await client.query(
        `SELECT 1 FROM provider_team_invitations WHERE id = $1::uuid AND provider_id = $2 AND ${OPEN} FOR UPDATE`,
        [invitationId, actor.providerId],
      );
      if ((found.rowCount ?? 0) === 0) return false;
      await lockTeam(client, actor.providerId);
      const revoked = await client.query(
        `UPDATE provider_team_invitations SET revoked_at = GREATEST($3::timestamptz, created_at), email = NULL, email_key = NULL
          WHERE id = $1::uuid AND provider_id = $2 AND ${OPEN}`,
        [invitationId, actor.providerId, at],
      );
      return (revoked.rowCount ?? 0) > 0;
    });
  }

  /** The mail job: invitations whose link is still to be sent (not minted, open, not expired), oldest first. */
  async listPending(input: { readonly nowUtc: string; readonly limit: number }): Promise<readonly string[]> {
    const at = nowOf(input?.nowUtc);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > HOST_TEAM_INVITATION_LIMITS.pendingLimitMax) {
      throw new StoreValidationError(`limit must be an integer from 1 to ${HOST_TEAM_INVITATION_LIMITS.pendingLimitMax}.`);
    }
    const found = await this.#pool.query<DbRow>(
      `SELECT id::text AS id FROM provider_team_invitations
        WHERE token_hash IS NULL AND ${OPEN} AND created_at <= $1::timestamptz AND expires_at > $1::timestamptz
        ORDER BY created_at, id
        LIMIT $2`,
      [at, input.limit],
    );
    return found.rows.map((row) => text(row, "id"));
  }

  /** The mail job: mints an invitation's link token, once. `skip` for one that is unknown, closed, expired or already minted. */
  async issueLink(input: { readonly invitationId: string; readonly nowUtc: string }): Promise<HostTeamInvitationLinkIssue> {
    const invitationId = invitationIdOf(input?.invitationId);
    const at = nowOf(input.nowUtc);
    const token = newSecret();
    const issued = await this.#pool.query<DbRow>(
      `UPDATE provider_team_invitations i SET token_hash = $2, issued_at = $3::timestamptz
        WHERE i.id = $1::uuid AND i.token_hash IS NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.created_at <= $3::timestamptz AND i.expires_at > $3::timestamptz
       RETURNING i.email, i.expires_at,
         (SELECT s.provider_display_name FROM experience_host_seller_profiles s WHERE s.provider_id = i.provider_id) AS seller_name,
         (SELECT p.public_display_name FROM experience_provider_public_profiles p WHERE p.provider_id = i.provider_id) AS public_name`,
      [invitationId, digest(token), at],
    );
    const row = issued.rows[0];
    if (!row) return { kind: "skip" };
    const name = typeof row.seller_name === "string" && row.seller_name !== "" ? row.seller_name : typeof row.public_name === "string" && row.public_name !== "" ? row.public_name : null;
    return { kind: "send", token, toEmail: text(row, "email"), expiresAtUtc: isoValue(row, "expires_at"), providerDisplayName: name };
  }

  /**
   * The person opens the emailed link: the browser that does so first is the one the invitation belongs to; the same browser
   * may open it again before it is used. Another browser gets `other-browser`. `expired` covers a link that ran out or was
   * revoked or replaced, `used` one that was accepted, `invalid` anything unknown.
   */
  async open(input: { readonly token: string; readonly browserBindingHash: Uint8Array; readonly nowUtc: string }): Promise<OpenHostTeamInvitationResult> {
    const at = nowOf(input?.nowUtc);
    if (typeof input.token !== "string" || !TOKEN.test(input.token) || !isBindingHash(input.browserBindingHash)) return { kind: "invalid" };
    const binding = input.browserBindingHash;
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT id::text AS id, browser_binding_hash, expires_at <= $2::timestamptz AS expired, accepted_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked
           FROM provider_team_invitations
          WHERE token_hash = $1
          FOR UPDATE`,
        [digest(input.token), at],
      );
      const invitation = found.rows[0];
      if (!invitation) return { kind: "invalid" } as const;
      if (invitation.used === true) return { kind: "used" } as const;
      if (invitation.revoked === true || invitation.expired === true) return { kind: "expired" } as const;
      if (invitation.browser_binding_hash !== null) return sameHash(invitation.browser_binding_hash, binding) ? { kind: "opened" } as const : { kind: "other-browser" } as const;
      try {
        await client.query(
          "UPDATE provider_team_invitations SET browser_binding_hash = $2, opened_at = $3::timestamptz WHERE id = $1::uuid",
          [invitation.id, Buffer.from(binding), at],
        );
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "23505") return { kind: "binding-in-use" } as const;
        throw error;
      }
      return { kind: "opened" } as const;
    });
  }

  /**
   * The NIHO sign-in came back in the browser that opened the link: finds or makes the person's host account, adds it to the
   * team as COHOST (an account that is already an active member keeps its role) and uses the invitation up, in one
   * transaction. A refusal changes nothing and the invitation stays usable. `invalid` when no open invitation belongs to this
   * browser.
   */
  async accept(input: { readonly browserBindingHash: Uint8Array; readonly nihoUserId: string; readonly authenticatedAtUtc?: string; readonly nowUtc: string }): Promise<AcceptHostTeamInvitationResult> {
    const at = nowOf(input?.nowUtc);
    if (input.authenticatedAtUtc !== undefined) {
      if (typeof input.authenticatedAtUtc !== "string") throw new StoreValidationError("authenticatedAtUtc must be a canonical UTC instant.");
      assertCanonicalInstant(input.authenticatedAtUtc, "authenticatedAtUtc");
    }
    if (!isBindingHash(input.browserBindingHash)) return { kind: "invalid" };
    const binding = Buffer.from(input.browserBindingHash);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT id::text AS id, provider_id, email, email_key
           FROM provider_team_invitations
          WHERE browser_binding_hash = $1 AND ${OPEN}
            AND issued_at IS NOT NULL AND expires_at > $2::timestamptz
          FOR UPDATE`,
        [binding, at],
      );
      const invitation = found.rows[0];
      if (!invitation) return { kind: "invalid" } as const;
      const providerId = text(invitation, "provider_id");
      await lockTeam(client, providerId);
      const resolved = await resolveHostAccountForInvitedNihoIdentityIn(client, {
        nihoUserId: input.nihoUserId,
        email: text(invitation, "email"),
        emailKey: text(invitation, "email_key"),
        nowUtc: at,
      });
      if (resolved.kind !== "resolved") return { kind: resolved.kind } as const;
      const hostAccountId = resolved.hostAccountId;

      const membership = await client.query<DbRow>(
        "SELECT active FROM provider_memberships WHERE provider_id = $1 AND niho_user_id = $2 FOR UPDATE",
        [providerId, hostAccountId],
      );
      let joined = false;
      if (!membership.rows[0]) {
        await client.query(
          `INSERT INTO provider_memberships (provider_id, niho_user_id, role, active, created_at, updated_at)
           VALUES ($1, $2, 'COHOST', true, clock_timestamp(), clock_timestamp())`,
          [providerId, hostAccountId],
        );
        joined = true;
      } else if (membership.rows[0].active !== true) {
        await client.query(
          "UPDATE provider_memberships SET role = 'COHOST', active = true, updated_at = clock_timestamp() WHERE provider_id = $1 AND niho_user_id = $2",
          [providerId, hostAccountId],
        );
        joined = true;
      }
      if (joined) {
        await client.query("UPDATE provider_team_revisions SET version = version + 1, updated_at = clock_timestamp() WHERE provider_id = $1", [providerId]);
      }
      await client.query(
        `UPDATE provider_team_invitations
            SET accepted_at = GREATEST($2::timestamptz, opened_at), accepted_host_account_id = $3, email = NULL, email_key = NULL
          WHERE id = $1::uuid`,
        [invitation.id, at, hostAccountId],
      );
      return { kind: "accepted", hostAccountId, providerId, joined } as const;
    });
  }

  /** The mail job: closes open invitations that ran out (oldest first, up to `limit`), clearing their addresses. Returns how many. */
  async closeExpired(input: { readonly nowUtc: string; readonly limit: number }): Promise<number> {
    const at = nowOf(input?.nowUtc);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > HOST_TEAM_INVITATION_LIMITS.pendingLimitMax) {
      throw new StoreValidationError(`limit must be an integer from 1 to ${HOST_TEAM_INVITATION_LIMITS.pendingLimitMax}.`);
    }
    const closed = await this.#pool.query(
      `UPDATE provider_team_invitations SET revoked_at = expires_at, email = NULL, email_key = NULL
        WHERE id IN (
          SELECT id FROM provider_team_invitations
           WHERE ${OPEN} AND expires_at <= $1::timestamptz
           ORDER BY expires_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )`,
      [at, input.limit],
    );
    return closed.rowCount ?? 0;
  }
}
