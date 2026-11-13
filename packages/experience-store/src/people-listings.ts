import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * 街の人 (#564, docs/people.md): who the Japanese site shows on 街の人 and on a page of their own. The Admin decides
 * (a row per provider, reusing the provider's public profile and photo), the public readers add the conditions that
 * keep a person off the page by themselves: the public profile must exist and the provider photo must be READY with
 * its rights confirmed. Nothing else about the provider is read here (no seller, payout, member or booking data).
 */

type DbRow = Record<string, unknown>;

export const PEOPLE_LISTING_LIMITS = { roleMax: 80, areaMax: 40, quoteMax: 160, introMax: 1200, slugMin: 2, slugMax: 60 } as const;

export interface PeopleListingInput {
  readonly slug: string;
  readonly roleJa: string;
  readonly areaJa: string;
  readonly quoteJa: string | null;
  /** null: the provider's own bio is shown, if they wrote one. */
  readonly introJa: string | null;
  readonly sortOrder: number;
}

export interface AdminPeopleListingRow {
  readonly providerId: string;
  readonly publicDisplayName: string;
  /** A READY, rights-confirmed provider photo is selected: without it nobody is shown. */
  readonly photoReady: boolean;
  readonly hasHostBio: boolean;
  /** Public experiences this provider has now (any language). */
  readonly publicExperienceCount: number;
  readonly listing: (PeopleListingInput & { readonly version: number; readonly updatedAtUtc: string }) | null;
  /** The person is on the public pages right now. */
  readonly visible: boolean;
}

export interface PublicPerson {
  readonly slug: string;
  readonly name: string;
  readonly roleJa: string;
  readonly areaJa: string;
  readonly quoteJa: string | null;
  /** The listing's introduction, else the provider's own bio, else null. */
  readonly introJa: string | null;
  readonly photo: { readonly src: string; readonly altJa: string; readonly credit: string | null };
  /** The slugs of this person's public experiences, newest first (the page filters them to the language it shows). */
  readonly experienceSlugs: readonly string[];
  readonly sortOrder: number;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BLOCK_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function line(value: unknown, path: string, max: number, required: boolean): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new StoreValidationError(`${path} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new StoreValidationError(`${path} must be text.`);
  const text = value.normalize("NFC");
  if (text !== text.trim() || [...text].length < 1 || [...text].length > max || CONTROL.test(text)) throw new StoreValidationError(`${path} must be 1-${max} characters on one line without spaces at the ends.`);
  return text;
}

export function validatePeopleListingInput(raw: PeopleListingInput): PeopleListingInput {
  if (!raw || typeof raw !== "object") throw new StoreValidationError("Listing input is required.");
  const slug = raw.slug;
  if (typeof slug !== "string" || !SLUG.test(slug) || slug.length < PEOPLE_LISTING_LIMITS.slugMin || slug.length > PEOPLE_LISTING_LIMITS.slugMax) {
    throw new StoreValidationError("slug must be 2-60 lowercase letters, digits and single hyphens.");
  }
  let intro: string | null = null;
  if (raw.introJa !== null && raw.introJa !== undefined && raw.introJa !== "") {
    if (typeof raw.introJa !== "string") throw new StoreValidationError("introJa must be text.");
    intro = raw.introJa.normalize("NFC").replace(/\r\n?/g, "\n").trim().replace(/\n{3,}/g, "\n\n");
    if ([...intro].length < 1 || [...intro].length > PEOPLE_LISTING_LIMITS.introMax || BLOCK_CONTROL.test(intro)) {
      throw new StoreValidationError(`introJa must be 1-${PEOPLE_LISTING_LIMITS.introMax} characters.`);
    }
  }
  if (!Number.isInteger(raw.sortOrder) || raw.sortOrder < 0 || raw.sortOrder > 9999) throw new StoreValidationError("sortOrder must be an integer from 0 to 9999.");
  return {
    slug,
    roleJa: line(raw.roleJa, "roleJa", PEOPLE_LISTING_LIMITS.roleMax, true) as string,
    areaJa: line(raw.areaJa, "areaJa", PEOPLE_LISTING_LIMITS.areaMax, true) as string,
    quoteJa: line(raw.quoteJa, "quoteJa", PEOPLE_LISTING_LIMITS.quoteMax, false),
    introJa: intro,
    sortOrder: raw.sortOrder,
  };
}

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

/** A READY provider photo whose rights were confirmed and which is the provider's current PROVIDER_PHOTO selection. */
const PHOTO_JOIN = `
  JOIN experience_provider_media_selection photo ON photo.provider_id=listing.provider_id AND photo.placement='PROVIDER_PHOTO'
  JOIN experience_provider_media_assets asset
    ON asset.id=photo.asset_id AND asset.provider_id=photo.provider_id AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL`;

const PUBLIC_COLUMNS = `
  listing.slug,listing.role_ja,listing.area_ja,listing.quote_ja,listing.sort_order,
  COALESCE(listing.intro_ja,bio.bio_ja) AS intro_ja,
  profile.public_display_name,
  photo.asset_id::text AS photo_asset_id,photo.alt_text_ja AS photo_alt_ja,photo.public_credit AS photo_credit,
  COALESCE((SELECT jsonb_agg(visible.slug ORDER BY visible.published_at DESC,visible.slug)
              FROM visible_publications visible WHERE visible.provider_id=listing.provider_id),'[]'::jsonb) AS experience_slugs`;

const PUBLIC_FROM = `
  FROM experience_people_listings listing
  JOIN experience_provider_public_profiles profile ON profile.provider_id=listing.provider_id
  ${PHOTO_JOIN}
  LEFT JOIN provider_host_bios bio ON bio.provider_id=listing.provider_id`;

function publicPerson(row: DbRow): PublicPerson {
  const slugs = Array.isArray(row.experience_slugs) ? row.experience_slugs.filter((value): value is string => typeof value === "string") : [];
  return {
    slug: String(row.slug),
    name: String(row.public_display_name),
    roleJa: String(row.role_ja),
    areaJa: String(row.area_ja),
    quoteJa: typeof row.quote_ja === "string" ? row.quote_ja : null,
    introJa: typeof row.intro_ja === "string" ? row.intro_ja : null,
    photo: {
      src: `/api/public/experience-provider-media/${encodeURIComponent(String(row.photo_asset_id))}`,
      altJa: String(row.photo_alt_ja),
      credit: typeof row.photo_credit === "string" ? row.photo_credit : null,
    },
    experienceSlugs: slugs,
    sortOrder: Number(row.sort_order),
  };
}

export class PeopleListingRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** The Admin's list: every provider with a public profile, whether it is on 街の人 and why not if it is not shown. */
  async adminList(): Promise<readonly AdminPeopleListingRow[]> {
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT profile.provider_id,profile.public_display_name,
              EXISTS (SELECT 1 FROM experience_provider_media_selection photo
                        JOIN experience_provider_media_assets asset
                          ON asset.id=photo.asset_id AND asset.provider_id=photo.provider_id AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
                       WHERE photo.provider_id=profile.provider_id AND photo.placement='PROVIDER_PHOTO') AS photo_ready,
              EXISTS (SELECT 1 FROM provider_host_bios bio WHERE bio.provider_id=profile.provider_id) AS has_bio,
              (SELECT count(*)::int FROM visible_publications visible WHERE visible.provider_id=profile.provider_id) AS experience_count,
              listing.slug,listing.role_ja,listing.area_ja,listing.quote_ja,listing.intro_ja,listing.sort_order,listing.version,listing.updated_at
         FROM experience_provider_public_profiles profile
         LEFT JOIN experience_people_listings listing ON listing.provider_id=profile.provider_id
        ORDER BY (listing.provider_id IS NULL),listing.sort_order,profile.public_display_name COLLATE "C",profile.provider_id COLLATE "C"
        LIMIT 500`,
    );
    return result.rows.map((row) => {
      const listed = typeof row.slug === "string";
      return {
        providerId: String(row.provider_id),
        publicDisplayName: String(row.public_display_name),
        photoReady: row.photo_ready === true,
        hasHostBio: row.has_bio === true,
        publicExperienceCount: Number(row.experience_count),
        listing: listed ? {
          slug: String(row.slug), roleJa: String(row.role_ja), areaJa: String(row.area_ja),
          quoteJa: typeof row.quote_ja === "string" ? row.quote_ja : null,
          introJa: typeof row.intro_ja === "string" ? row.intro_ja : null,
          sortOrder: Number(row.sort_order), version: Number(row.version), updatedAtUtc: iso(row.updated_at),
        } : null,
        visible: listed && row.photo_ready === true,
      };
    });
  }

  /** Lists a provider on 街の人 (expectedVersion null) or changes its row (the version the Admin saw). */
  async adminSave(adminNihoUserId: string, providerId: string, expectedVersion: number | null, rawInput: PeopleListingInput): Promise<void> {
    assertStoreIdentifier(adminNihoUserId, "adminNihoUserId");
    assertStoreIdentifier(providerId, "providerId");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    const input = validatePeopleListingInput(rawInput);
    await withTransaction(this.#pool, async (client) => {
      const profile = await client.query("SELECT 1 FROM experience_provider_public_profiles WHERE provider_id=$1 FOR SHARE", [providerId]);
      if (!profile.rows[0]) throw new StoreNotFoundError("The provider has no public profile.");
      try {
        const result = expectedVersion === null
          ? await client.query(
            `INSERT INTO experience_people_listings (provider_id,slug,role_ja,area_ja,quote_ja,intro_ja,sort_order,updated_by_admin_niho_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider_id) DO NOTHING`,
            [providerId, input.slug, input.roleJa, input.areaJa, input.quoteJa, input.introJa, input.sortOrder, adminNihoUserId],
          )
          : await client.query(
            `UPDATE experience_people_listings
                SET slug=$2,role_ja=$3,area_ja=$4,quote_ja=$5,intro_ja=$6,sort_order=$7,updated_by_admin_niho_user_id=$8,
                    version=version+1,updated_at=clock_timestamp()
              WHERE provider_id=$1 AND version=$9`,
            [providerId, input.slug, input.roleJa, input.areaJa, input.quoteJa, input.introJa, input.sortOrder, adminNihoUserId, expectedVersion],
          );
        if (result.rowCount !== 1) throw new StoreConflictError("The listing changed; reload and try again.");
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new StoreConflictError("That slug is already used by another person.");
        throw error;
      }
    });
  }

  /** Takes the person off 街の人 (the row is deleted; the public profile and the photo stay). */
  async adminWithdraw(adminNihoUserId: string, providerId: string, expectedVersion: number): Promise<void> {
    assertStoreIdentifier(adminNihoUserId, "adminNihoUserId");
    assertStoreIdentifier(providerId, "providerId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion must be a positive integer.");
    const result = await this.#pool.query("DELETE FROM experience_people_listings WHERE provider_id=$1 AND version=$2", [providerId, expectedVersion]);
    if (result.rowCount !== 1) throw new StoreConflictError("The listing changed or is already withdrawn.");
  }

  /** Everyone shown on 街の人, in the Admin's order. */
  async listPublic(): Promise<readonly PublicPerson[]> {
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM}
        ORDER BY listing.sort_order,listing.slug COLLATE "C" LIMIT 200`,
    );
    return result.rows.map(publicPerson);
  }

  async getPublicBySlug(slug: string): Promise<PublicPerson | null> {
    if (!SLUG.test(slug) || slug.length > PEOPLE_LISTING_LIMITS.slugMax) return null;
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} WHERE listing.slug=$1`, [slug],
    );
    return result.rows[0] ? publicPerson(result.rows[0]) : null;
  }

  /**
   * For an experience page or card that wants a link to the person: which listed person delivers each of these
   * experiences (by experience slug). Experiences whose provider is not on 街の人 are left out.
   */
  async personForExperiences(experienceSlugs: readonly string[]): Promise<ReadonlyMap<string, { readonly slug: string; readonly name: string }>> {
    const unique = [...new Set(experienceSlugs)].filter((slug) => typeof slug === "string" && slug.length > 0 && slug.length <= 160).slice(0, 200);
    if (unique.length === 0) return new Map();
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT visible.slug AS experience_slug,listing.slug AS person_slug,profile.public_display_name
         FROM visible_publications visible
         JOIN experience_people_listings listing ON listing.provider_id=visible.provider_id
         JOIN experience_provider_public_profiles profile ON profile.provider_id=listing.provider_id
         ${PHOTO_JOIN}
        WHERE visible.slug = ANY($1::text[])`, [unique],
    );
    return new Map(result.rows.map((row) => [String(row.experience_slug), { slug: String(row.person_slug), name: String(row.public_display_name) }]));
  }
}
