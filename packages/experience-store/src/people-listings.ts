import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { activeProfileMember, publicMemberPhotoUrl, readyProfilePhoto, VISIBLE_MEMBER_PROFILE } from "./member-profiles.ts";
import { VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

type DbRow = Record<string, unknown>;
export const PEOPLE_LISTING_LIMITS = { slugMin: 2, slugMax: 60 } as const;
export const PEOPLE_MEMBER_ROLES = ["OWNER", "COHOST"] as const;
type PeopleMemberRole = (typeof PEOPLE_MEMBER_ROLES)[number];

export interface PeopleListingInput {
  readonly slug: string;
  readonly sortOrder: number;
}

export interface PeopleListingTarget {
  readonly providerId: string;
  readonly memberId: string | null;
}

export interface AdminPeopleListingRow extends PeopleListingTarget {
  readonly key: string;
  readonly providerName: string;
  readonly memberRole: PeopleMemberRole | null;
  readonly name: string | null;
  readonly legacyName: string | null;
  readonly visible: boolean;
  readonly listing: (PeopleListingInput & {
    readonly id: string;
    readonly version: number;
    readonly updatedAtUtc: string;
  }) | null;
}

export interface PublicPerson {
  readonly slug: string;
  readonly name: string;
  readonly roleJa: string;
  readonly areaJa: string;
  readonly quoteJa: string | null;
  readonly introJa: string | null;
  readonly photo: { readonly src: string; readonly altJa: string; readonly credit: string | null };
  readonly experienceSlugs: readonly string[];
  readonly sortOrder: number;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LISTING_ID = /^plg_[0-9a-f]{32}$/;
const nullableText = (value: unknown): string | null => typeof value === "string" ? value : null;

export function validatePeopleListingInput(raw: PeopleListingInput): PeopleListingInput {
  if (!raw || typeof raw !== "object") throw new StoreValidationError("Listing input is required.");
  const { slug, sortOrder } = raw;
  if (typeof slug !== "string" || !SLUG.test(slug) || slug.length < PEOPLE_LISTING_LIMITS.slugMin || slug.length > PEOPLE_LISTING_LIMITS.slugMax) {
    throw new StoreValidationError("slug must be 2-60 lowercase letters, digits and single hyphens.");
  }
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) throw new StoreValidationError("sortOrder must be an integer from 0 to 9999.");
  return { slug, sortOrder };
}

export const LISTED_PUBLIC_MEMBER_JOIN = `JOIN experience_provider_member_profile_publications published
    ON published.provider_id=listing.provider_id AND published.member_id=listing.member_id AND ${VISIBLE_MEMBER_PROFILE}`;

const PUBLIC_COLUMNS = `listing.slug,listing.sort_order,published.name_ja,published.content_ja->>'role' AS role_ja,
  published.content_ja->>'area' AS area_ja,published.content_ja->>'quote' AS quote_ja,published.content_ja->>'intro' AS intro_ja,
  published.photo_asset_id,published.photo_alt_ja,published.photo_credit,
  COALESCE((SELECT jsonb_agg(visible.slug ORDER BY visible.published_at DESC,visible.slug)
              FROM visible_publications visible
              JOIN experience_product_member_profiles link ON link.product_provider_id=visible.provider_id AND link.product_id=visible.product_id
             WHERE link.profile_provider_id=listing.provider_id AND link.member_id=listing.member_id),'[]'::jsonb) AS experience_slugs`;

function publicPerson(row: DbRow): PublicPerson {
  return {
    slug: String(row.slug), name: String(row.name_ja),
    roleJa: nullableText(row.role_ja) ?? "", areaJa: nullableText(row.area_ja) ?? "",
    quoteJa: nullableText(row.quote_ja), introJa: nullableText(row.intro_ja),
    photo: { src: publicMemberPhotoUrl(String(row.photo_asset_id)), altJa: String(row.photo_alt_ja), credit: nullableText(row.photo_credit) },
    experienceSlugs: Array.isArray(row.experience_slugs) ? row.experience_slugs : [],
    sortOrder: Number(row.sort_order),
  };
}

export class PeopleListingRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async adminList(): Promise<readonly AdminPeopleListingRow[]> {
    const rows = await this.#pool.query<DbRow>(
      `WITH people AS (
         SELECT listing.id,listing.provider_id,listing.member_id,listing.slug,listing.sort_order,listing.version,listing.updated_at,
                listing.name_ja AS legacy_name,member.role
           FROM experience_people_listings listing
           LEFT JOIN provider_memberships member
             ON member.provider_id=listing.provider_id AND member.niho_user_id=listing.member_id
            AND member.active AND member.role IN ('OWNER','COHOST')
          UNION ALL
         SELECT NULL,member.provider_id,member.niho_user_id,NULL,NULL,NULL,NULL,NULL,member.role
           FROM provider_memberships member
          WHERE member.active AND member.role IN ('OWNER','COHOST')
            AND NOT EXISTS (SELECT 1 FROM experience_people_listings listing
                 WHERE listing.provider_id=member.provider_id AND listing.member_id=member.niho_user_id)
       )
       SELECT people.*,COALESCE(provider.public_display_name,people.provider_id) AS provider_name,
              published.name_ja,
              (people.id IS NOT NULL AND published.id IS NOT NULL AND ${readyProfilePhoto("published.photo_asset_id", "published.photo_provider_id")}
                AND ${activeProfileMember("people.provider_id", "people.member_id")}) AS visible
         FROM people
         LEFT JOIN experience_provider_public_profiles provider ON provider.provider_id=people.provider_id
         LEFT JOIN experience_provider_member_profile_publications published
           ON published.provider_id=people.provider_id AND published.member_id=people.member_id AND published.withdrawn_at IS NULL
        ORDER BY people.sort_order NULLS LAST, people.slug COLLATE "C", provider_name, people.member_id
        LIMIT 1000`,
    );
    return rows.rows.map((row) => {
      const providerId = String(row.provider_id);
      const memberId = nullableText(row.member_id);
      const id = nullableText(row.id);
      return {
        key: id ?? `new:${providerId}:${memberId}`, providerId, memberId, providerName: String(row.provider_name),
        memberRole: row.role === "OWNER" || row.role === "COHOST" ? row.role : null,
        name: nullableText(row.name_ja), legacyName: nullableText(row.legacy_name), visible: row.visible === true,
        listing: id ? { id, slug: String(row.slug), sortOrder: Number(row.sort_order), version: Number(row.version), updatedAtUtc: new Date(String(row.updated_at)).toISOString() } : null,
      };
    });
  }

  async adminSave(adminId: string, listingId: string | null, expectedVersion: number | null, target: PeopleListingTarget, input: PeopleListingInput): Promise<{ readonly id: string }> {
    assertStoreIdentifier(adminId, "adminId");
    assertStoreIdentifier(target.providerId, "providerId");
    if (target.memberId !== null) assertStoreIdentifier(target.memberId, "memberId");
    if ((listingId === null) !== (expectedVersion === null)
      || (listingId !== null && (!LISTING_ID.test(listingId) || !Number.isSafeInteger(expectedVersion) || expectedVersion! < 1))) {
      throw new StoreValidationError("A listing id and version are required to update a listing.");
    }
    const { slug, sortOrder } = validatePeopleListingInput(input);
    return withTransaction(this.#pool, async (client) => {
      const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1 FOR SHARE", [target.providerId]);
      if (!provider.rowCount) throw new StoreNotFoundError("The provider was not found.");
      if (target.memberId !== null) {
        const member = await client.query(
          "SELECT 1 FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active AND role IN ('OWNER','COHOST') FOR SHARE",
          [target.providerId, target.memberId],
        );
        if (!member.rowCount) throw new StoreValidationError("The member must be a current OWNER or co-host.");
      }
      const id = listingId ?? `plg_${randomUUID().replaceAll("-", "")}`;
      try {
        if (listingId === null) {
          if (target.memberId === null) throw new StoreValidationError("A member is required for a new listing.");
          await client.query(
            `INSERT INTO experience_people_listings (id,provider_id,member_id,slug,sort_order,updated_by_admin_niho_user_id)
             VALUES ($1,$2,$3,$4,$5,$6)`, [id, target.providerId, target.memberId, slug, sortOrder, adminId],
          );
        } else {
          const result = await client.query<DbRow>(
            `SELECT * FROM experience_people_listings
              WHERE id=$1 AND provider_id=$2 AND version=$3 AND (member_id IS NULL OR member_id=$4)
              FOR UPDATE`, [id, target.providerId, expectedVersion, target.memberId],
          );
          const previous = result.rows[0];
          if (!previous) throw new StoreConflictError("The listing changed.");
          if (target.memberId && previous.member_id === null && previous.name_ja !== null) {
            // Attaching an account to a legacy listing imports the original material as a draft.
            // A member's existing draft always takes precedence.
            await client.query(
              `INSERT INTO experience_provider_member_profiles
                 (provider_id,member_id,name_ja,content_ja,photo_provider_id,photo_asset_id,photo_alt_ja,photo_credit,updated_at,updated_by,updated_by_kind)
               SELECT provider_id,$2,name_ja,jsonb_build_object('role',role_ja,'area',area_ja,'quote',quote_ja,'intro',intro_ja),
                      photo_provider_id,photo_asset_id,photo_alt_ja,photo_credit,updated_at,updated_by_admin_niho_user_id,'ADMIN'
                 FROM experience_people_listings WHERE id=$1
               ON CONFLICT DO NOTHING`, [id, target.memberId],
            );
          }
          await client.query(
            `UPDATE experience_people_listings
                SET member_id=$3,slug=$4,sort_order=$5,updated_by_admin_niho_user_id=$6,version=version+1,updated_at=clock_timestamp()
              WHERE id=$1 AND provider_id=$2`, [id, target.providerId, target.memberId, slug, sortOrder, adminId],
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new StoreConflictError("The slug or member is already listed.");
        throw error;
      }
      return { id };
    });
  }

  async adminWithdraw(adminId: string, listingId: string, expectedVersion: number): Promise<void> {
    assertStoreIdentifier(adminId, "adminId");
    if (!LISTING_ID.test(listingId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("A listing id and version are required.");
    const result = await this.#pool.query("DELETE FROM experience_people_listings WHERE id=$1 AND version=$2", [listingId, expectedVersion]);
    if (!result.rowCount) throw new StoreConflictError("The listing changed or was removed.");
  }

  async listPublic(): Promise<readonly PublicPerson[]> {
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE} SELECT ${PUBLIC_COLUMNS}
         FROM experience_people_listings listing ${LISTED_PUBLIC_MEMBER_JOIN}
        ORDER BY listing.sort_order,listing.slug COLLATE "C" LIMIT 200`,
    );
    return result.rows.map(publicPerson);
  }

  async getPublicBySlug(slug: string): Promise<PublicPerson | null> {
    if (!SLUG.test(slug) || slug.length > PEOPLE_LISTING_LIMITS.slugMax) return null;
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE} SELECT ${PUBLIC_COLUMNS}
         FROM experience_people_listings listing ${LISTED_PUBLIC_MEMBER_JOIN}
        WHERE listing.slug=$1`, [slug],
    );
    return result.rows[0] ? publicPerson(result.rows[0]) : null;
  }
}
