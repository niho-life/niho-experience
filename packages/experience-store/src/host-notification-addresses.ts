import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import { HAS_HOST_ACCESS, HOST_MAIL_TOPICS, HOST_NOTIFICATION_ADDRESS_LIMITS, isHostEmail, sameEmail } from "./host-mail-shared.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * ホストへのメールの宛先 (#194, owner decision 2026-11-01; migration 0038). By default the NIHO account's verified address,
 * copied when the host signs in to /host; the host may choose another one in 設定 › 通知, which is used only once the link
 * sent to it is opened. The address is the person's (one per NIHO user), and goes once they have no membership and no
 * product-operator grant left. An address leaves this class only to the person it belongs to and to the mail job.
 */

/** 設定 › 通知's 宛先 for one person. */
export interface HostNotificationAddress {
  /** The NIHO account's verified address, as the last sign-in gave it. */
  readonly loginEmail: string | null;
  /** The address the person chose and confirmed. */
  readonly overrideEmail: string | null;
  /** Where this site's emails go now: the confirmed choice, else the sign-in's, else nowhere. */
  readonly effectiveEmail: string | null;
  /** An address waiting for its link to be opened (the newest request still open). */
  readonly pendingEmail: string | null;
}

/** What 「確認のメールを送る」 did. */
export type HostNotificationAddressChange =
  /** A confirmation email will go to the address; nothing changes until its link is opened. */
  | { readonly kind: "PENDING"; readonly address: HostNotificationAddress }
  /** The address is the sign-in's: the choice was cleared, no email needed. */
  | { readonly kind: "DEFAULT"; readonly address: HostNotificationAddress }
  /** The address is already the one in use. */
  | { readonly kind: "UNCHANGED"; readonly address: HostNotificationAddress };

export type HostLoginEmailOutcome = "stored" | "cleared" | "skipped";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** Only the person's open request: not used, not cancelled, asked for within the hour. */
const OPEN_REQUEST = (row: string) =>
  `${row}.used_at IS NULL AND ${row}.cancelled_at IS NULL
   AND ${row}.created_at > clock_timestamp() - make_interval(mins => ${HOST_NOTIFICATION_ADDRESS_LIMITS.confirmationMinutes})`;

function email(value: unknown, path: string): string {
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (!isHostEmail(trimmed)) throw new StoreValidationError(`${path} must be an email address of 3-254 characters.`);
  return trimmed;
}

const optionalText = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

async function readAddress(db: Pool | PoolClient, nihoUserId: string): Promise<HostNotificationAddress> {
  const result = await db.query<DbRow>(
    `SELECT a.login_email, a.override_email,
            (SELECT c.email FROM host_notification_address_confirmations c
              WHERE c.niho_user_id = $1 AND ${OPEN_REQUEST("c")}
              ORDER BY c.created_at DESC, c.id LIMIT 1) AS pending_email
       FROM (SELECT $1::text AS niho_user_id) u
       LEFT JOIN host_notification_addresses a ON a.niho_user_id = u.niho_user_id`,
    [nihoUserId],
  );
  const row = result.rows[0] ?? {};
  const loginEmail = optionalText(row.login_email);
  const overrideEmail = optionalText(row.override_email);
  return { loginEmail, overrideEmail, effectiveEmail: overrideEmail ?? loginEmail, pendingEmail: optionalText(row.pending_email) };
}

/** One person's changes in order (a request, a confirmation, 戻す): the rate limit counts within it. */
async function lockPerson(client: PoolClient, nihoUserId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('host-notification-address:' || $1, 0))", [nihoUserId]);
}

async function cancelOpenRequests(client: PoolClient, nihoUserId: string): Promise<void> {
  await client.query(
    "UPDATE host_notification_address_confirmations SET cancelled_at = clock_timestamp() WHERE niho_user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL",
    [nihoUserId],
  );
}

/** A row with neither address is not kept. */
async function dropEmptyRow(client: PoolClient, nihoUserId: string): Promise<void> {
  await client.query("DELETE FROM host_notification_addresses WHERE niho_user_id = $1 AND login_email IS NULL AND override_email IS NULL", [nihoUserId]);
}

async function clearOverride(client: PoolClient, nihoUserId: string): Promise<void> {
  await client.query(
    "UPDATE host_notification_addresses SET override_email = NULL, override_confirmed_at = NULL, updated_at = clock_timestamp() WHERE niho_user_id = $1",
    [nihoUserId],
  );
  await dropEmptyRow(client, nihoUserId);
}

export class HostNotificationAddresses {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * A sign-in to /host: the NIHO account's address when NIHO marked it verified, else null (none, or not verified). A
   * verified address is kept only for someone with a membership or a product-operator grant here, or who signed in to
   * accept an invitation (`invitation`; kept for a day before the grant exists). Null clears the copy of an earlier
   * sign-in: an address NIHO no longer calls verified is not used. A choice made in 設定 › 通知 stays.
   */
  async recordLogin(input: { readonly nihoUserId: string; readonly verifiedEmail: string | null; readonly invitation?: boolean }): Promise<HostLoginEmailOutcome> {
    assertStoreIdentifier(input.nihoUserId, "nihoUserId");
    if (input.verifiedEmail === null) {
      return withTransaction(this.#pool, async (client) => {
        const cleared = await client.query(
          `UPDATE host_notification_addresses SET login_email = NULL, login_email_at = NULL, updated_at = clock_timestamp()
            WHERE niho_user_id = $1 AND login_email IS NOT NULL`,
          [input.nihoUserId],
        );
        await dropEmptyRow(client, input.nihoUserId);
        return (cleared.rowCount ?? 0) > 0 ? "cleared" : "skipped";
      });
    }
    const verified = email(input.verifiedEmail, "verifiedEmail");
    const invitation = input.invitation === true;
    const result = await this.#pool.query(
      `INSERT INTO host_notification_addresses (niho_user_id, login_email, login_email_at, access_grace_until)
       SELECT $1, $2, clock_timestamp(), CASE WHEN $3 THEN clock_timestamp() + make_interval(hours => $4) END
        WHERE $3 OR ${HAS_HOST_ACCESS("$1")}
       ON CONFLICT (niho_user_id) DO UPDATE
          SET login_email = EXCLUDED.login_email,
              login_email_at = EXCLUDED.login_email_at,
              access_grace_until = GREATEST(host_notification_addresses.access_grace_until, EXCLUDED.access_grace_until),
              updated_at = clock_timestamp()`,
      [input.nihoUserId, verified, invitation, HOST_NOTIFICATION_ADDRESS_LIMITS.accessGraceHours],
    );
    return (result.rowCount ?? 0) > 0 ? "stored" : "skipped";
  }

  async get(nihoUserId: string): Promise<HostNotificationAddress> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    return readAddress(this.#pool, nihoUserId);
  }

  /**
   * 「確認のメールを送る」 in 設定 › 通知 of `providerId`, which the person must belong to (a membership or a product-operator
   * grant). The sign-in's own address needs no link: the choice is cleared. Another address waits for its link (an hour,
   * once); the mail job sends it through the outbox. A newer request cancels the older ones. At most
   * HOST_NOTIFICATION_ADDRESS_LIMITS.requestsPerHour requests an hour.
   */
  async requestChange(input: { readonly nihoUserId: string; readonly providerId: string; readonly email: string }): Promise<HostNotificationAddressChange> {
    assertStoreIdentifier(input.nihoUserId, "nihoUserId");
    assertStoreIdentifier(input.providerId, "providerId");
    const address = email(input.email, "email");
    return withTransaction(this.#pool, async (client) => {
      await lockPerson(client, input.nihoUserId);
      const member = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id = $1 AND m.niho_user_id = $2 AND m.active)
            OR EXISTS (SELECT 1 FROM product_operator_grants g WHERE g.provider_id = $1 AND g.niho_user_id = $2 AND g.active
                        AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp()))`,
        [input.providerId, input.nihoUserId],
      );
      if (member.rows.length === 0) throw new StoreAccessDeniedError();
      const current = await readAddress(client, input.nihoUserId);
      if (sameEmail(address, current.overrideEmail) || (current.overrideEmail === null && sameEmail(address, current.loginEmail))) {
        await cancelOpenRequests(client, input.nihoUserId);
        return { kind: "UNCHANGED", address: await readAddress(client, input.nihoUserId) };
      }
      if (sameEmail(address, current.loginEmail)) {
        await cancelOpenRequests(client, input.nihoUserId);
        await clearOverride(client, input.nihoUserId);
        return { kind: "DEFAULT", address: await readAddress(client, input.nihoUserId) };
      }
      const recent = await client.query<DbRow>(
        `SELECT count(*)::int AS requests, EXTRACT(EPOCH FROM (min(created_at) + interval '1 hour' - clock_timestamp()))::int AS wait
           FROM host_notification_address_confirmations
          WHERE niho_user_id = $1 AND created_at > clock_timestamp() - interval '1 hour'`,
        [input.nihoUserId],
      );
      if (Number(recent.rows[0]?.requests ?? 0) >= HOST_NOTIFICATION_ADDRESS_LIMITS.requestsPerHour) {
        throw new StoreRateLimitedError(Math.max(1, Number(recent.rows[0]?.wait ?? 60)));
      }
      await cancelOpenRequests(client, input.nihoUserId);
      const created = await client.query<DbRow>(
        "INSERT INTO host_notification_address_confirmations (niho_user_id, email) VALUES ($1, $2) RETURNING id::text AS id",
        [input.nihoUserId, address],
      );
      const id = String(created.rows[0]?.id);
      await client.query(
        `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
         VALUES ($1, 'host_notification_address', $2, $3, $4, $5::jsonb)`,
        [input.providerId, id, HOST_MAIL_TOPICS.addressConfirmation, `host-mail:address-confirmation:${id}`, JSON.stringify({ v: 1 })],
      );
      return { kind: "PENDING", address: await readAddress(client, input.nihoUserId) };
    });
  }

  /** 「ログインのメールに戻す」: the choice goes, and any open request with it. */
  async useLoginEmail(nihoUserId: string): Promise<HostNotificationAddress> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      await lockPerson(client, nihoUserId);
      await cancelOpenRequests(client, nihoUserId);
      await clearOverride(client, nihoUserId);
      return readAddress(client, nihoUserId);
    });
  }

  /** 「取り消す」 under a request: its link no longer works. */
  async cancelChange(nihoUserId: string): Promise<HostNotificationAddress> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      await lockPerson(client, nihoUserId);
      await cancelOpenRequests(client, nihoUserId);
      return readAddress(client, nihoUserId);
    });
  }

  /**
   * The link was opened: the token of an open request (an hour, once) for someone who still has access makes its address
   * the one in use. Null for anything else (unknown, used, cancelled, expired, access ended); the page does not say which.
   */
  async confirm(token: string): Promise<{ readonly email: string } | null> {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const hash = tokenHash(token);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        "SELECT niho_user_id FROM host_notification_address_confirmations WHERE token_hash = $1",
        [hash],
      );
      const nihoUserId = found.rows[0]?.niho_user_id;
      if (typeof nihoUserId !== "string") return null;
      await lockPerson(client, nihoUserId);
      const open = await client.query<DbRow>(
        `UPDATE host_notification_address_confirmations c SET used_at = clock_timestamp()
          WHERE c.token_hash = $1 AND ${OPEN_REQUEST("c")} AND ${HAS_HOST_ACCESS("c.niho_user_id")}
          RETURNING c.id, c.email`,
        [hash],
      );
      const confirmed = open.rows[0];
      if (!confirmed || typeof confirmed.email !== "string") return null;
      await client.query(
        "UPDATE host_notification_address_confirmations SET cancelled_at = clock_timestamp() WHERE niho_user_id = $1 AND id <> $2 AND used_at IS NULL AND cancelled_at IS NULL",
        [nihoUserId, confirmed.id],
      );
      await client.query(
        `INSERT INTO host_notification_addresses (niho_user_id, override_email, override_confirmed_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (niho_user_id) DO UPDATE
            SET override_email = EXCLUDED.override_email, override_confirmed_at = EXCLUDED.override_confirmed_at, updated_at = clock_timestamp()`,
        [nihoUserId, confirmed.email],
      );
      return { email: confirmed.email };
    });
  }

  /**
   * The mail job (#320's run): the addresses of everyone with no active membership and no active, unexpired product-operator
   * grant left (an invitation's sign-in waits out its grace), their requests, and requests spent or cancelled a day ago. Up
   * to `limit` people. The number of rows deleted.
   */
  async purge(options: { readonly limit?: number } = {}): Promise<number> {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > HOST_NOTIFICATION_ADDRESS_LIMITS.purgedPerRunMax) {
      throw new StoreValidationError(`limit must be from 1 to ${HOST_NOTIFICATION_ADDRESS_LIMITS.purgedPerRunMax}.`);
    }
    const result = await this.#pool.query<DbRow>(
      `WITH gone AS (
         SELECT a.niho_user_id FROM host_notification_addresses a
          WHERE NOT ${HAS_HOST_ACCESS("a.niho_user_id")}
            AND (a.access_grace_until IS NULL OR a.access_grace_until <= clock_timestamp())
          ORDER BY a.niho_user_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), addresses AS (
         DELETE FROM host_notification_addresses a USING gone WHERE a.niho_user_id = gone.niho_user_id RETURNING a.niho_user_id
       ), requests AS (
         -- A request is good for an hour, so one a day old is spent, cancelled or expired whatever its columns say.
         DELETE FROM host_notification_address_confirmations c
          WHERE c.niho_user_id IN (SELECT niho_user_id FROM gone)
             OR c.created_at < clock_timestamp() - make_interval(hours => $2)
         RETURNING c.id
       )
       SELECT (SELECT count(*) FROM addresses)::int + (SELECT count(*) FROM requests)::int AS purged`,
      [limit, HOST_NOTIFICATION_ADDRESS_LIMITS.confirmationKeepHours],
    );
    return Number(result.rows[0]?.purged ?? 0);
  }
}
