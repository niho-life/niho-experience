import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { enqueueHostBookingMails, HOST_MAIL_TOPICS } from "./host-mail-shared.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * The host's payout account (Epic #700 stage 3a, #710, migration 0095, docs/host-payouts.md): the Stripe Express account an
 * OWNER registers for the provider from 設定 › 受取口座. This module is the runtime's side: it reserves the row BEFORE Stripe is
 * asked (so two requests never make two accounts), records the account ID once, keeps the last state read from Stripe and queues
 * the mail that says more information is needed. It never retires a row (connect-account-retirement.ts, the office's) and
 * never deletes one (a trigger refuses).
 *
 * Authority: `reserve` and `recordAccountRef` check the actor (an active OWNER, an ACTIVE host account) themselves. The reads
 * and `saveSnapshot` take a provider or an account the caller already authorised (the page's provider, a webhook's own account).
 */

export const CONNECT_ACCOUNT_PURPOSES = ["PAYOUT"] as const;
export type ConnectAccountPurpose = (typeof CONNECT_ACCOUNT_PURPOSES)[number];
export const CONNECT_ACCOUNT_STATES = ["IN_PROGRESS", "VERIFYING", "ACTION_REQUIRED", "REJECTED", "READY"] as const;
export type ConnectAccountState = (typeof CONNECT_ACCOUNT_STATES)[number];

export interface ConnectAccountRecord {
  readonly id: string;
  readonly providerId: string;
  readonly purpose: ConnectAccountPurpose;
  /** null while the account is being created. */
  readonly stripeAccountRef: string | null;
  readonly creationParams: Record<string, unknown>;
  readonly createdByHostAccountId: string;
  readonly createdAtUtc: string;
  readonly retiredAtUtc: string | null;
}

export interface ConnectAccountSnapshot {
  readonly state: ConnectAccountState;
  readonly payoutReady: boolean;
  readonly detailsSubmitted: boolean;
  readonly payoutsEnabled: boolean;
  readonly transfersActive: boolean;
  readonly requirementsHash: string;
  readonly readAtUtc: string;
}

export interface ConnectAccountWithSnapshot {
  readonly account: ConnectAccountRecord;
  readonly snapshot: ConnectAccountSnapshot | null;
}

export interface ConnectAccountReservation {
  readonly account: ConnectAccountRecord;
  /** false: a valid row already existed (an unfinished creation, or the registered account). */
  readonly created: boolean;
}

export interface ConnectAccountSnapshotInput extends Omit<ConnectAccountSnapshot, "readAtUtc"> {
  /** When Stripe was read: an older read never replaces a newer one. */
  readonly readAtUtc: string;
}

export interface ConnectAccountSnapshotSaved {
  /** false: a newer read was already kept. */
  readonly saved: boolean;
  /** An "more information is needed" email was queued (none if the same need was already mailed). */
  readonly mailQueued: boolean;
}

const ACCOUNT_REF = /^acct_[A-Za-z0-9]{8,250}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

const COLUMNS = "id,provider_id,purpose,stripe_account_ref,creation_params,created_by_host_account_id,created_at,retired_at";
const SNAPSHOT_COLUMNS = "state,payout_ready,details_submitted,payouts_enabled,transfers_active,requirements_hash,read_at";

function accountFromRow(row: DbRow): ConnectAccountRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    purpose: String(row.purpose) as ConnectAccountPurpose,
    stripeAccountRef: typeof row.stripe_account_ref === "string" ? row.stripe_account_ref : null,
    creationParams: row.creation_params as Record<string, unknown>,
    createdByHostAccountId: String(row.created_by_host_account_id),
    createdAtUtc: isoValue(row, "created_at"),
    retiredAtUtc: row.retired_at === null || row.retired_at === undefined ? null : isoValue(row, "retired_at"),
  };
}

function snapshotFromRow(row: DbRow): ConnectAccountSnapshot | null {
  if (typeof row.state !== "string") return null;
  return {
    state: row.state as ConnectAccountState,
    payoutReady: row.payout_ready === true,
    detailsSubmitted: row.details_submitted === true,
    payoutsEnabled: row.payouts_enabled === true,
    transfersActive: row.transfers_active === true,
    requirementsHash: String(row.requirements_hash),
    readAtUtc: isoValue(row, "read_at"),
  };
}

function validActor(actor: HostActor): void {
  if (typeof actor?.providerId !== "string") throw new StoreValidationError("actor.providerId must be a stable 1-256 character identifier.");
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  if (!isHostAccountId(actor.nihoUserId)) throw new StoreAccessDeniedError();
}

async function requireHostAccountOwner(client: PoolClient, actor: HostActor): Promise<void> {
  const owner = await client.query(
    `SELECT 1 FROM provider_memberships membership
       JOIN host_accounts account ON account.id=membership.niho_user_id AND account.status='ACTIVE'
      WHERE membership.provider_id=$1 AND membership.niho_user_id=$2 AND membership.active=true AND membership.role='OWNER'
      FOR SHARE OF membership,account`,
    [actor.providerId, actor.nihoUserId],
  );
  if ((owner.rowCount ?? 0) === 0) throw new StoreAccessDeniedError();
}

export class ExperienceConnectAccounts {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The provider's valid payout row (the one in progress included) and what Stripe last said of it. For a provider the caller
   * has already authorised (an OWNER's own page).
   */
  async currentPayout(providerId: string): Promise<ConnectAccountWithSnapshot | null> {
    assertStoreIdentifier(providerId, "providerId");
    const found = await this.#pool.query<DbRow>(
      `SELECT ${COLUMNS.split(",").map((column) => `a.${column}`).join(",")},${SNAPSHOT_COLUMNS.split(",").map((column) => `s.${column}`).join(",")}
         FROM experience_connect_accounts a LEFT JOIN experience_connect_account_snapshots s ON s.connect_account_id=a.id
        WHERE a.provider_id=$1 AND a.purpose='PAYOUT' AND a.retired_at IS NULL`,
      [providerId],
    );
    const row = found.rows[0];
    return row ? { account: accountFromRow(row), snapshot: snapshotFromRow(row) } : null;
  }

  /** Whether the provider already has a Direct charge seller profile (the office's registration): then it never registers a payout account itself. */
  async sellerExists(providerId: string): Promise<boolean> {
    assertStoreIdentifier(providerId, "providerId");
    return ((await this.#pool.query("SELECT 1 FROM experience_host_seller_profiles WHERE provider_id=$1", [providerId])).rowCount ?? 0) > 0;
  }

  /** The row of a Stripe account (a webhook's `event.account`): any row, retired ones included (`retiredAtUtc`). null: not ours. */
  async findByAccountRef(stripeAccountRef: string): Promise<ConnectAccountWithSnapshot | null> {
    if (typeof stripeAccountRef !== "string" || !ACCOUNT_REF.test(stripeAccountRef)) throw new StoreValidationError("stripeAccountRef must be a Stripe connected account ID.");
    const found = await this.#pool.query<DbRow>(
      `SELECT ${COLUMNS.split(",").map((column) => `a.${column}`).join(",")},${SNAPSHOT_COLUMNS.split(",").map((column) => `s.${column}`).join(",")}
         FROM experience_connect_accounts a LEFT JOIN experience_connect_account_snapshots s ON s.connect_account_id=a.id
        WHERE a.stripe_account_ref=$1`,
      [stripeAccountRef],
    );
    const row = found.rows[0];
    return row ? { account: accountFromRow(row), snapshot: snapshotFromRow(row) } : null;
  }

  /**
   * Makes sure the provider has a valid payout row, before Stripe is asked: inserted with `ON CONFLICT DO NOTHING`, so two
   * requests at once leave one row, and the loser reads the winner's (its `creationParams`, id and all). The actor must be an
   * active OWNER (a host account), and the provider must have no Direct charge seller profile (StoreConflictError "SELLER_EXISTS").
   */
  async reserve(actor: HostActor, input: { readonly creationParams: Record<string, unknown>; readonly id?: string }): Promise<ConnectAccountReservation> {
    validActor(actor);
    const id = input.id ?? randomUUID();
    if (!UUID.test(id)) throw new StoreValidationError("id must be a UUID.");
    if (input.creationParams === null || typeof input.creationParams !== "object" || Array.isArray(input.creationParams)) {
      throw new StoreValidationError("creationParams must be an object.");
    }
    return withTransaction(this.#pool, async (client) => {
      await requireHostAccountOwner(client, actor);
      const seller = await client.query("SELECT 1 FROM experience_host_seller_profiles WHERE provider_id=$1 FOR SHARE", [actor.providerId]);
      if ((seller.rowCount ?? 0) > 0) throw new StoreConflictError("SELLER_EXISTS");
      const inserted = await client.query<DbRow>(
        `INSERT INTO experience_connect_accounts (id,provider_id,purpose,creation_params,created_by_host_account_id)
         VALUES ($1::uuid,$2,'PAYOUT',$3::jsonb,$4)
         ON CONFLICT (provider_id,purpose) WHERE retired_at IS NULL DO NOTHING
         RETURNING ${COLUMNS}`,
        [id, actor.providerId, JSON.stringify(input.creationParams), actor.nihoUserId],
      );
      if (inserted.rows[0]) return { account: accountFromRow(inserted.rows[0]), created: true };
      const existing = await client.query<DbRow>(
        `SELECT ${COLUMNS} FROM experience_connect_accounts WHERE provider_id=$1 AND purpose='PAYOUT' AND retired_at IS NULL`,
        [actor.providerId],
      );
      if (!existing.rows[0]) throw new StoreConflictError("The payout account changed; try again.");
      return { account: accountFromRow(existing.rows[0]), created: false };
    });
  }

  /**
   * Writes the Stripe account ID into the reserved row, once. The same ID again is a no-op; another ID, or a row that is
   * retired, is a StoreConflictError (never overwritten: a trigger refuses it too).
   */
  async recordAccountRef(actor: HostActor, id: string, stripeAccountRef: string): Promise<ConnectAccountRecord> {
    validActor(actor);
    if (typeof id !== "string" || !UUID.test(id)) throw new StoreValidationError("id must be a UUID.");
    if (typeof stripeAccountRef !== "string" || !ACCOUNT_REF.test(stripeAccountRef)) throw new StoreValidationError("stripeAccountRef must be a Stripe connected account ID.");
    return withTransaction(this.#pool, async (client) => {
      await requireHostAccountOwner(client, actor);
      const row = await client.query<DbRow>(
        `SELECT ${COLUMNS} FROM experience_connect_accounts WHERE id=$1::uuid AND provider_id=$2 FOR UPDATE`,
        [id, actor.providerId],
      );
      const current = row.rows[0];
      if (!current || current.retired_at !== null) throw new StoreConflictError("The payout account was retired; read it again.");
      if (typeof current.stripe_account_ref === "string") {
        if (current.stripe_account_ref === stripeAccountRef) return accountFromRow(current);
        throw new StoreConflictError("The payout account already has a Stripe account.");
      }
      try {
        const updated = await client.query<DbRow>(
          `UPDATE experience_connect_accounts SET stripe_account_ref=$2 WHERE id=$1::uuid AND stripe_account_ref IS NULL AND retired_at IS NULL RETURNING ${COLUMNS}`,
          [id, stripeAccountRef],
        );
        return accountFromRow(updated.rows[0]!);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new StoreConflictError("That Stripe account belongs to another payout account.");
        throw error;
      }
    });
  }

  /**
   * Keeps what Stripe was just read to say of the account (an older read never replaces a newer one). With `notify`, a state
   * of ACTION_REQUIRED queues one email to the provider's OWNER, keyed by the account and the requirements' hash: the same need
   * is never mailed twice, a new need is.
   */
  async saveSnapshot(connectAccountId: string, input: ConnectAccountSnapshotInput, options: { readonly notify: boolean } = { notify: false }): Promise<ConnectAccountSnapshotSaved> {
    if (typeof connectAccountId !== "string" || !UUID.test(connectAccountId)) throw new StoreValidationError("connectAccountId must be a UUID.");
    if (!(CONNECT_ACCOUNT_STATES as readonly string[]).includes(input.state)) throw new StoreValidationError("state is not valid.");
    if (typeof input.requirementsHash !== "string" || !HASH.test(input.requirementsHash)) throw new StoreValidationError("requirementsHash must be a SHA-256 hex digest.");
    if (input.payoutReady && input.state !== "READY") throw new StoreValidationError("Only a READY account is payout-ready.");
    assertCanonicalInstant(input.readAtUtc, "readAtUtc");
    return withTransaction(this.#pool, async (client) => {
      const account = await client.query<DbRow>(
        "SELECT provider_id,stripe_account_ref,retired_at FROM experience_connect_accounts WHERE id=$1::uuid FOR SHARE",
        [connectAccountId],
      );
      const row = account.rows[0];
      if (!row || typeof row.stripe_account_ref !== "string") throw new StoreConflictError("The payout account has no Stripe account yet.");
      const saved = await client.query(
        `INSERT INTO experience_connect_account_snapshots
           (connect_account_id,stripe_account_ref,state,payout_ready,details_submitted,payouts_enabled,transfers_active,requirements_hash,read_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)
         ON CONFLICT (connect_account_id) DO UPDATE
            SET state=EXCLUDED.state,payout_ready=EXCLUDED.payout_ready,details_submitted=EXCLUDED.details_submitted,
                payouts_enabled=EXCLUDED.payouts_enabled,transfers_active=EXCLUDED.transfers_active,
                requirements_hash=EXCLUDED.requirements_hash,read_at=EXCLUDED.read_at
          WHERE experience_connect_account_snapshots.read_at <= EXCLUDED.read_at`,
        [connectAccountId, row.stripe_account_ref, input.state, input.payoutReady, input.detailsSubmitted, input.payoutsEnabled, input.transfersActive, input.requirementsHash, input.readAtUtc],
      );
      // Whether to mail is decided from what is kept NOW (a newer read of the screen may have been kept first), not from whether this
      // write won: the key (account and requirements' hash) keeps one need from being mailed twice.
      let mailQueued = false;
      if (options.notify && row.retired_at === null) {
        const kept = await client.query<DbRow>(
          "SELECT state,details_submitted,requirements_hash FROM experience_connect_account_snapshots WHERE connect_account_id=$1::uuid",
          [connectAccountId],
        );
        const current = kept.rows[0];
        if (current && current.state === "ACTION_REQUIRED" && current.details_submitted === true) {
          mailQueued = (await enqueueHostBookingMails(client, {
            providerId: String(row.provider_id),
            topic: HOST_MAIL_TOPICS.payoutAccountAttention,
            aggregateType: "experience_connect_account",
            aggregateId: connectAccountId,
            deduplicationKey: `payout-account-attention:${connectAccountId}:${String(current.requirements_hash)}`,
            // The hash lets the job refuse a mail whose need is no longer the kept one.
            payload: { v: 1, requirementsHash: String(current.requirements_hash) },
          })) > 0;
        }
      }
      return { saved: (saved.rowCount ?? 0) > 0, mailQueued };
    });
  }
}
