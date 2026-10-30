import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreValidationError } from "./errors.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertStoreIdentifier } from "./validation.ts";

/** Every notification a provider gets (#109), in the order 設定 › 通知 lists them. */
export const HOST_NOTIFICATION_KEYS = [
  "NEW_BOOKING",
  "APPROVAL_DEADLINE",
  "CANCELLATION",
  "GUEST_MESSAGE",
  "DAY_BEFORE_SUMMARY",
  "NEW_REVIEW",
  "LISTING_REVIEW",
] as const;
export type HostNotificationKey = (typeof HOST_NOTIFICATION_KEYS)[number];

/** The only ones the OWNER may turn off. The others always come. */
export const STOPPABLE_HOST_NOTIFICATION_KEYS = ["GUEST_MESSAGE", "DAY_BEFORE_SUMMARY", "NEW_REVIEW"] as const satisfies readonly HostNotificationKey[];
export type StoppableHostNotificationKey = (typeof STOPPABLE_HOST_NOTIFICATION_KEYS)[number];

export interface HostNotificationItem {
  readonly key: HostNotificationKey;
  readonly enabled: boolean;
  /** True for the notifications that always come. */
  readonly locked: boolean;
}

export type HostNotificationChanges = Partial<Record<StoppableHostNotificationKey, boolean>>;

const STOPPABLE: ReadonlySet<string> = new Set(STOPPABLE_HOST_NOTIFICATION_KEYS);
const KNOWN: ReadonlySet<string> = new Set(HOST_NOTIFICATION_KEYS);

function isStoppable(key: string): key is StoppableHostNotificationKey {
  return STOPPABLE.has(key);
}

function items(rows: readonly DbRow[]): HostNotificationItem[] {
  const saved = new Map(rows.map((row) => [String(row.notification_key), row.enabled === true]));
  return HOST_NOTIFICATION_KEYS.map((key) => (isStoppable(key) ? { key, enabled: saved.get(key) ?? true, locked: false } : { key, enabled: true, locked: true }));
}

function validChanges(changes: HostNotificationChanges): [StoppableHostNotificationKey, boolean][] {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) throw new StoreValidationError("changes must be an object.");
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new StoreValidationError("changes must name at least one notification.");
  for (const [key, enabled] of entries) {
    if (!isStoppable(key)) throw new StoreValidationError(KNOWN.has(key) ? `${key} cannot be turned off.` : "changes names an unknown notification.");
    if (typeof enabled !== "boolean") throw new StoreValidationError(`${key} must be true or false.`);
  }
  return entries as [StoppableHostNotificationKey, boolean][];
}

const SELECT_ROWS = "SELECT notification_key, enabled FROM provider_notification_preferences WHERE provider_id = $1";

/** A current OWNER, not capped below OWNER by NIHO and not a product operator. */
async function requireOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
}

/**
 * 設定 › 通知 (#109, migration 0020): which of the stoppable notifications a provider gets. The
 * OWNER reads and changes them through the host console; senders ask `enabledFor` before sending.
 */
export class ProviderNotificationSettings {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** All seven, in order. Only the OWNER may read them. */
  async get(actor: HostActor): Promise<HostNotificationItem[]> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      return items((await client.query<DbRow>(SELECT_ROWS, [actor.providerId])).rows);
    });
  }

  /** Turns stoppable notifications on or off and answers all seven as they are now. */
  async update(actor: HostActor, changes: HostNotificationChanges): Promise<HostNotificationItem[]> {
    const entries = validChanges(changes);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      for (const [key, enabled] of entries) {
        await client.query(
          `INSERT INTO provider_notification_preferences (provider_id, notification_key, enabled, updated_by_niho_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider_id, notification_key) DO UPDATE
              SET enabled = EXCLUDED.enabled,
                  updated_by_niho_user_id = EXCLUDED.updated_by_niho_user_id,
                  updated_at = clock_timestamp()`,
          [actor.providerId, key, enabled, actor.nihoUserId],
        );
      }
      return items((await client.query<DbRow>(SELECT_ROWS, [actor.providerId])).rows);
    });
  }

  /** For senders (push, email): whether the provider gets this notification. The locked ones always do. */
  async enabledFor(providerId: string, key: HostNotificationKey): Promise<boolean> {
    assertStoreIdentifier(providerId, "providerId");
    if (!KNOWN.has(key)) throw new StoreValidationError("key is not a known notification.");
    if (!isStoppable(key)) return true;
    const result = await this.#pool.query<DbRow>(
      "SELECT enabled FROM provider_notification_preferences WHERE provider_id = $1 AND notification_key = $2",
      [providerId, key],
    );
    return result.rows[0] === undefined ? true : result.rows[0].enabled === true;
  }
}
