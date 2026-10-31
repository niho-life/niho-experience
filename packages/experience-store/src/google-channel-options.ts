import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { currentChannelOccurrence } from "./channel-occurrence.ts";
import { lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";

export interface GoogleChannelPendingSetupCommand {
  readonly commandId: string;
  readonly expectedMappingVersion: number;
}

export interface GoogleChannelPendingAnchorCommand extends GoogleChannelPendingSetupCommand {
  readonly expectedDesiredVersion: number;
}

export interface GoogleChannelOptionCandidate {
  readonly listingId: string;
  readonly accountDisplayName: string;
  readonly mappingVersion: number;
  readonly localDate: string;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly desiredVersion?: number;
  readonly pendingSetup?: GoogleChannelPendingSetupCommand;
  readonly pendingAnchor?: GoogleChannelPendingAnchorCommand;
}

export interface GoogleChannelOptions {
  readonly connected: boolean;
  readonly candidates: readonly GoogleChannelOptionCandidate[];
}

type CandidateRow = Record<string, unknown> & {
  listing_id: string;
  display_name: string;
  mapping_version: string;
};

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StoreConflictError("Stored Google channel version is invalid.");
  return parsed;
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function assertActor(actor: HostActor): void {
  if (!actor.providerId || !actor.nihoUserId || actor.calendarScope === "OPERATOR" || actor.calendarRoleCeiling !== "OWNER") {
    throw new StoreAccessDeniedError();
  }
}

function assertTarget(productId: string, occurrenceId: string): void {
  if (!productId || productId.length > 256 || !occurrenceId || occurrenceId.length > 256) {
    throw new StoreValidationError("Invalid Google channel options target.");
  }
}

async function transaction<T>(pool: Pool, providerId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockProviderInventory(client, providerId);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Owner-only read model for the existing setup, anchor, and activation commands. */
export class GoogleChannelOptionsRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async get(actor: HostActor, productId: string, occurrenceId: string): Promise<GoogleChannelOptions> {
    assertActor(actor);
    assertTarget(productId, occurrenceId);
    return transaction(this.#pool, actor.providerId, async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM provider_memberships
          WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role='OWNER' FOR SHARE`,
        [actor.providerId, actor.nihoUserId],
      );
      if (!membership.rows[0]) throw new StoreAccessDeniedError();
      const product = await client.query(
        "SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2",
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreValidationError("Unknown Google channel product.");
      const connection = (await client.query<{ connected_by_niho_user_id: string }>(
        "SELECT connected_by_niho_user_id FROM provider_google_connections WHERE provider_id=$1 FOR SHARE",
        [actor.providerId],
      )).rows[0];
      if (connection && connection.connected_by_niho_user_id !== actor.nihoUserId) throw new StoreAccessDeniedError();

      const rows = (await client.query<CandidateRow>(
        `SELECT l.id AS listing_id,l.mapping_version,a.display_name,
                d.desired_version,d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at,
                s.command_id AS setup_command_id,s.expected_mapping_version AS setup_mapping_version,
                h.command_id AS anchor_command_id,h.mapping_version AS anchor_mapping_version,
                h.desired_version AS anchor_desired_version
           FROM channel_listings l
           JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
           LEFT JOIN channel_desired_states d ON d.provider_id=l.provider_id AND d.listing_id=l.id AND d.occurrence_id=$4
           LEFT JOIN LATERAL (
             SELECT command_id,expected_mapping_version FROM google_channel_setup_journals
              WHERE provider_id=l.provider_id AND listing_id=l.id AND created_by_niho_user_id=$3
                AND phase IN ('PREPARING','CREATING','UNCERTAIN') ORDER BY created_at DESC LIMIT 1
           ) s ON true
           LEFT JOIN LATERAL (
             SELECT command_id,mapping_version,desired_version FROM google_channel_anchor_journals
              WHERE provider_id=l.provider_id AND listing_id=l.id AND occurrence_id=$4 AND actor_niho_user_id=$3
                AND phase IN ('PREPARING','INITIALIZING','UNCERTAIN') ORDER BY created_at DESC LIMIT 1
           ) h ON true
          WHERE l.provider_id=$1 AND l.product_id=$2 AND l.active=true
            AND l.adapter='airbnb-google-busy' AND l.adapter_version='1' AND l.connection_mode='GOOGLE'
            AND l.external_option_id='' AND l.external_product_id ~ '^[1-9][0-9]{0,127}$'
            AND a.site='Airbnb' AND a.active=true AND a.revoked_at IS NULL AND a.quarantined_at IS NULL
            AND (a.delegated_until IS NULL OR a.delegated_until > clock_timestamp())
            AND a.external_account_id ~ '^[1-9][0-9]{0,127}$'
          ORDER BY a.display_name,l.id`,
        [actor.providerId, productId, actor.nihoUserId, occurrenceId],
      )).rows;

      const candidates: GoogleChannelOptionCandidate[] = [];
      for (const row of rows) {
        let occurrence;
        try { occurrence = await currentChannelOccurrence(client, actor.providerId, row.listing_id, occurrenceId); }
        catch { throw new StoreValidationError("Occurrence does not belong to the selected product."); }
        const mappingVersion = positiveInteger(row.mapping_version);
        const desiredStart = iso(row.source_start_at);
        const desiredEnd = iso(row.source_end_at);
        const desiredReady = row.desired_version !== null && row.desired_version !== undefined
          && positiveInteger(row.desired_mapping_version) === mappingVersion
          && desiredStart === occurrence.startUtc && desiredEnd === occurrence.endUtc;
        candidates.push({
          listingId: row.listing_id,
          accountDisplayName: row.display_name,
          mappingVersion,
          localDate: occurrence.localDate,
          sourceStartAtUtc: occurrence.startUtc,
          sourceEndAtUtc: occurrence.endUtc,
          ...(desiredReady ? { desiredVersion: positiveInteger(row.desired_version) } : {}),
          ...(row.setup_command_id ? { pendingSetup: {
            commandId: String(row.setup_command_id), expectedMappingVersion: positiveInteger(row.setup_mapping_version),
          } } : {}),
          ...(row.anchor_command_id ? { pendingAnchor: {
            commandId: String(row.anchor_command_id), expectedMappingVersion: positiveInteger(row.anchor_mapping_version),
            expectedDesiredVersion: positiveInteger(row.anchor_desired_version),
          } } : {}),
        });
      }
      return { connected: connection !== undefined, candidates };
    });
  }
}
