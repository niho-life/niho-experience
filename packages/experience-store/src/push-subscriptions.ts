import type { Pool } from "pg";
import { StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import { assertStoreIdentifier } from "./validation.ts";

/** Coarse, from the User-Agent at subscription time; shown to nobody but the host. */
export type HostPushDeviceLabel = "iphone" | "ipad" | "android" | "mac" | "windows" | "other";
const DEVICE_LABELS: ReadonlySet<string> = new Set<HostPushDeviceLabel>(["iphone", "ipad", "android", "mac", "windows", "other"]);

export interface HostPushSubscriptionInput {
  readonly nihoUserId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly deviceLabel: HostPushDeviceLabel;
}

/** What a sender needs for one device. `id` is the row's bigint as text. */
export interface HostPushRecipient {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

const P256DH = /^[A-Za-z0-9_-]{87}$/;
const AUTH = /^[A-Za-z0-9_-]{22}$/;
const ROW_ID = /^[1-9][0-9]{0,18}$/;

function assertEndpoint(endpoint: string): void {
  // The web app checks the push service allowlist; the store keeps the column's own bounds.
  if (!endpoint.startsWith("https://") || endpoint.length > 2048) throw new StoreValidationError("endpoint must be an https URL of at most 2048 characters.");
}

function assertConnection(connectionId: string): void {
  if (connectionId.length < 1 || connectionId.length > 256) throw new StoreValidationError("connectionId must contain 1-256 characters.");
}

function assertRowId(id: string): void {
  if (!ROW_ID.test(id)) throw new StoreValidationError("id must be a subscription row id.");
}

function recipientFromRow(row: DbRow): HostPushRecipient {
  return { id: String(row.id), endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth) };
}

/**
 * The host app's Web Push subscriptions (#177 P2, migration 0004). Every statement is
 * parameterised; the endpoint never leaves this class in an error.
 */
export class HostPushSubscriptions {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** The device now belongs to whoever subscribed last: a new owner, connection or key replaces the old. */
  async save(input: HostPushSubscriptionInput): Promise<void> {
    assertStoreIdentifier(input.nihoUserId, "nihoUserId");
    assertConnection(input.connectionId);
    assertEndpoint(input.endpoint);
    if (!P256DH.test(input.p256dh) || !AUTH.test(input.auth)) throw new StoreValidationError("p256dh and auth must be unpadded base64url keys.");
    if (!DEVICE_LABELS.has(input.deviceLabel)) throw new StoreValidationError("deviceLabel is not a known device kind.");
    await this.#pool.query(
      `INSERT INTO host_push_subscriptions (niho_user_id, connection_id, endpoint, p256dh, auth, device_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE
          SET niho_user_id = EXCLUDED.niho_user_id,
              connection_id = EXCLUDED.connection_id,
              p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth,
              device_label = EXCLUDED.device_label,
              last_seen_at = clock_timestamp(),
              failure_count = 0`,
      [input.nihoUserId, input.connectionId, input.endpoint, input.p256dh, input.auth, input.deviceLabel],
    );
  }

  /** Only the user's own row; true when one was removed. */
  async remove(nihoUserId: string, endpoint: string): Promise<boolean> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    assertEndpoint(endpoint);
    const result = await this.#pool.query("DELETE FROM host_push_subscriptions WHERE niho_user_id = $1 AND endpoint = $2", [nihoUserId, endpoint]);
    return (result.rowCount ?? 0) > 0;
  }

  async has(nihoUserId: string, endpoint: string): Promise<boolean> {
    return (await this.find(nihoUserId, endpoint)) !== null;
  }

  /** The user's own subscription on this endpoint (for 設定's テスト通知), or null. */
  async find(nihoUserId: string, endpoint: string): Promise<HostPushRecipient | null> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    assertEndpoint(endpoint);
    const result = await this.#pool.query<DbRow>(
      "SELECT id::text AS id, endpoint, p256dh, auth FROM host_push_subscriptions WHERE niho_user_id = $1 AND endpoint = $2",
      [nihoUserId, endpoint],
    );
    const row = result.rows[0];
    return row === undefined ? null : recipientFromRow(row);
  }

  /**
   * 設定 opened on this device: the user's own row follows the session's current connection and counts
   * as seen, so a sign-in after the one that subscribed keeps it. False when the user has no row here.
   */
  async claim(nihoUserId: string, endpoint: string, connectionId: string): Promise<boolean> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    assertEndpoint(endpoint);
    assertConnection(connectionId);
    const result = await this.#pool.query(
      "UPDATE host_push_subscriptions SET connection_id = $3, last_seen_at = clock_timestamp() WHERE niho_user_id = $1 AND endpoint = $2",
      [nihoUserId, endpoint, connectionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Logout or a revoked connection: its devices stop receiving. */
  async removeConnection(connectionId: string): Promise<number> {
    assertConnection(connectionId);
    const result = await this.#pool.query("DELETE FROM host_push_subscriptions WHERE connection_id = $1", [connectionId]);
    return result.rowCount ?? 0;
  }

  /** The connection was used (a session refresh): its devices count as seen. */
  async touchConnection(connectionId: string): Promise<void> {
    assertConnection(connectionId);
    await this.#pool.query("UPDATE host_push_subscriptions SET last_seen_at = clock_timestamp() WHERE connection_id = $1", [connectionId]);
  }

  /** Devices of the provider's active members, seen at or after `seenAfter`. */
  async recipients(providerId: string, seenAfter: Date): Promise<HostPushRecipient[]> {
    assertStoreIdentifier(providerId, "providerId");
    if (Number.isNaN(seenAfter.getTime())) throw new StoreValidationError("seenAfter must be a valid time.");
    const result = await this.#pool.query<DbRow>(
      `SELECT s.id::text AS id, s.endpoint, s.p256dh, s.auth
         FROM host_push_subscriptions s
         JOIN provider_memberships m ON m.niho_user_id = s.niho_user_id
        WHERE m.provider_id = $1
          AND m.active = true
          AND s.last_seen_at >= $2
        ORDER BY s.id`,
      [providerId, seenAfter.toISOString()],
    );
    return result.rows.map(recipientFromRow);
  }

  async recordSent(id: string): Promise<void> {
    assertRowId(id);
    await this.#pool.query("UPDATE host_push_subscriptions SET last_success_at = clock_timestamp(), failure_count = 0 WHERE id = $1", [id]);
  }

  async recordFailure(id: string): Promise<void> {
    assertRowId(id);
    await this.#pool.query("UPDATE host_push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1", [id]);
  }

  /** The push service says the subscription is gone (404/410). */
  async removeById(id: string): Promise<void> {
    assertRowId(id);
    await this.#pool.query("DELETE FROM host_push_subscriptions WHERE id = $1", [id]);
  }
}
