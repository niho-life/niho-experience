import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { validateHostBioInput } from "./host-bio-rules.ts";
import { sellerOwnerSql } from "./host-sellers.ts";
import type { HostActor } from "./types.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * ホスト紹介文 (bio, #146): one public bio per Experience provider, written by its current OWNER.
 * Japanese is the source. English is published only while it was confirmed against the current
 * Japanese text (english_source_fingerprint = sha256 of bio_ja when the English was saved); the
 * readers check that again, so a changed Japanese text can never publish a stale English one.
 * Withdrawal deletes the row. No history or command receipt is kept (docs/host-bio.md).
 */

export type HostBioState = {
  /** 0 while no bio is saved. */
  readonly version: number;
  readonly bioJa: string | null;
  readonly bioEn: string | null;
  /** The saved English matches the current Japanese text, so it is published. */
  readonly englishConfirmed: boolean;
  readonly consentVersion: string | null;
  readonly updatedAtUtc: string | null;
};

export type PublicHostBio = {
  readonly ja: string;
  /** Only an English text confirmed against the current Japanese one. */
  readonly en: string | null;
};

export type SaveHostBioCommand = {
  readonly bioJa: string;
  readonly bioEn: string | null;
  /** null for the first save, the current version afterwards. */
  readonly expectedVersion: number | null;
  readonly consentVersion: string;
};

type DbRow = Record<string, unknown>;

export const EMPTY_HOST_BIO_STATE: HostBioState = Object.freeze({
  version: 0, bioJa: null, bioEn: null, englishConfirmed: false, consentVersion: null, updatedAtUtc: null,
});

/** sha256 hex of the normalized Japanese text, the English publication condition. */
export function hostBioSourceFingerprint(bioJa: string): string {
  return createHash("sha256").update(bioJa, "utf8").digest("hex");
}

/** English is published only when it was saved for exactly this Japanese text. */
function confirmedEnglish(row: DbRow): string | null {
  if (row.bio_en === null || row.bio_en === undefined || typeof row.english_source_fingerprint !== "string") return null;
  return row.english_source_fingerprint === hostBioSourceFingerprint(String(row.bio_ja)) ? String(row.bio_en) : null;
}

function stateFromRow(row: DbRow): HostBioState {
  return {
    version: Number(row.version),
    bioJa: String(row.bio_ja),
    bioEn: row.bio_en === null || row.bio_en === undefined ? null : String(row.bio_en),
    englishConfirmed: confirmedEnglish(row) !== null,
    consentVersion: String(row.consent_version),
    updatedAtUtc: new Date(row.updated_at as string | Date).toISOString(),
  };
}

async function assertCurrentOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor.providerId, "providerId");
  assertStoreIdentifier(actor.nihoUserId, "nihoUserId");
  const found = await client.query(
    `SELECT 1 FROM provider_memberships membership
      WHERE membership.provider_id=$1 AND membership.niho_user_id=$2
        AND membership.active=true AND membership.role='OWNER'
      FOR SHARE OF membership`,
    [actor.providerId, actor.nihoUserId],
  );
  if (found.rows[0] === undefined) throw new StoreAccessDeniedError();
}

function validExpectedVersion(value: unknown, nullable: boolean): number | null {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new StoreValidationError("expectedVersion is invalid.");
  return value as number;
}

export class ProviderHostBioRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async getForOwner(actor: HostActor): Promise<HostBioState> {
    return withTransaction(this.#pool, async (client) => {
      await assertCurrentOwner(client, actor);
      const result = await client.query<DbRow>("SELECT * FROM provider_host_bios WHERE provider_id=$1", [actor.providerId]);
      return result.rows[0] ? stateFromRow(result.rows[0]) : EMPTY_HOST_BIO_STATE;
    });
  }

  async save(actor: HostActor, command: SaveHostBioCommand): Promise<HostBioState> {
    const expectedVersion = validExpectedVersion(command.expectedVersion, true);
    const input = validateHostBioInput({ bioJa: command.bioJa, bioEn: command.bioEn, consentVersion: command.consentVersion });
    const englishFingerprint = input.bioEn === null ? null : hostBioSourceFingerprint(input.bioJa);
    return withTransaction(this.#pool, async (client) => {
      await assertCurrentOwner(client, actor);
      if (expectedVersion === null) {
        // A concurrent first save waits on the primary key and then inserts nothing: it is a conflict.
        const inserted = await client.query<DbRow>(
          `INSERT INTO provider_host_bios
             (provider_id,bio_ja,bio_en,english_source_fingerprint,consent_version,consented_at,consented_by_niho_user_id,version)
           VALUES ($1,$2,$3,$4,$5,clock_timestamp(),$6,1)
           ON CONFLICT (provider_id) DO NOTHING
           RETURNING *`,
          [actor.providerId, input.bioJa, input.bioEn, englishFingerprint, input.consentVersion, actor.nihoUserId],
        );
        if (!inserted.rows[0]) throw new StoreConflictError("A host bio already exists; read it again.");
        return stateFromRow(inserted.rows[0]);
      }
      const locked = await client.query<DbRow>("SELECT version FROM provider_host_bios WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      if (!locked.rows[0] || Number(locked.rows[0].version) !== expectedVersion) throw new StoreConflictError("Host bio version changed; read it again.");
      const updated = await client.query<DbRow>(
        `UPDATE provider_host_bios SET
           bio_ja=$2,bio_en=$3,english_source_fingerprint=$4,consent_version=$5,consented_at=clock_timestamp(),
           consented_by_niho_user_id=$6,version=version+1,updated_at=clock_timestamp()
         WHERE provider_id=$1
         RETURNING *`,
        [actor.providerId, input.bioJa, input.bioEn, englishFingerprint, input.consentVersion, actor.nihoUserId],
      );
      return stateFromRow(updated.rows[0]!);
    });
  }

  /** Withdrawal removes the bio; the public pages stop showing it on their next read. */
  async withdraw(actor: HostActor, expectedVersion: number): Promise<HostBioState> {
    const version = validExpectedVersion(expectedVersion, false);
    return withTransaction(this.#pool, async (client) => {
      await assertCurrentOwner(client, actor);
      const deleted = await client.query("DELETE FROM provider_host_bios WHERE provider_id=$1 AND version=$2 RETURNING provider_id", [actor.providerId, version]);
      if (!deleted.rows[0]) throw new StoreConflictError("Host bio version changed or is already withdrawn; read it again.");
      return EMPTY_HOST_BIO_STATE;
    });
  }

  /**
   * The bio of the provider of one currently public publication, read with the same "currently public"
   * conditions as the seller disclosure. Provider, NIHO and consent identifiers never leave this method.
   */
  async getPublicBySlug(slug: string): Promise<PublicHostBio | null> {
    if (typeof slug !== "string" || slug.length < 1 || slug.length > 160) return null;
    const result = await this.#pool.query<DbRow>(
      `SELECT bio.bio_ja,bio.bio_en,bio.english_source_fingerprint
         FROM experience_product_publication_states state
         JOIN experience_product_publications publication
           ON publication.id=state.current_publication_id
          AND publication.provider_id=state.provider_id AND publication.product_id=state.product_id
         JOIN experience_host_seller_profiles profile ON profile.provider_id=publication.provider_id
         JOIN provider_host_bios bio ON bio.provider_id=publication.provider_id
        WHERE publication.slug=$1
          AND state.self_stopped_at IS NULL AND state.operations_suspended_at IS NULL AND state.owner_resume_required=false
          AND publication.seller_niho_account_ref=profile.seller_niho_account_ref
          AND publication.stripe_connect_account_ref=profile.stripe_connect_account_ref
          AND EXISTS (
            SELECT 1 FROM provider_memberships owner
             WHERE owner.provider_id=publication.provider_id
               AND owner.active=true AND owner.role='OWNER'
               AND ${sellerOwnerSql("owner", "profile")}
          )
        ORDER BY publication.published_at DESC,publication.id DESC LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ja: String(row.bio_ja), en: confirmedEnglish(row) };
  }
}
