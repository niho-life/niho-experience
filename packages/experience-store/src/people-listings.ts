import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * 街の人 (#564, docs/people.md): who the Japanese site shows on 街の人 and on a page of their own. A listing is a person
 * who belongs to a provider (#589, 0083): provider × member (a host account). The Admin decides who is listed and gives them
 * their name, photo, role, area, line, introduction and the experiences they are met through. The public readers add the
 * conditions that keep a person off the page by themselves: the member must be a current OWNER or COHOST of the provider
 * (whoever is shown can be written to, and the message reaches the provider's inbox, addressed to them) and the photo must be
 * READY with its rights confirmed. Nothing else about the provider is read here (no seller, payout or booking data).
 */

type DbRow = Record<string, unknown>;

export const PEOPLE_LISTING_LIMITS = { nameMax: 40, roleMax: 80, areaMax: 40, quoteMax: 160, introMax: 1200, slugMin: 2, slugMax: 60, altMax: 500, creditMax: 300 } as const;

/** The roles that make a member a person the site can show and write to. */
export const PEOPLE_MEMBER_ROLES = ["OWNER", "COHOST"] as const;
export type PeopleMemberRole = (typeof PEOPLE_MEMBER_ROLES)[number];

/** A product a person is met through, of any provider (#585). */
export interface PeopleListingExperienceRef {
  readonly providerId: string;
  readonly productId: string;
}

export const PEOPLE_LISTING_EXPERIENCES_MAX = 50;

/** A person's photo: a READY, rights-confirmed provider media asset (of any provider) with the words it is shown with. */
export interface PeopleListingPhotoInput {
  readonly assetId: string;
  readonly altJa: string;
  readonly credit: string | null;
}

export interface PeopleListingInput {
  readonly slug: string;
  /** How the person is named on the pages (a person's name, not the provider's). */
  readonly nameJa: string;
  readonly roleJa: string;
  readonly areaJa: string;
  readonly quoteJa: string | null;
  readonly introJa: string | null;
  readonly sortOrder: number;
  /**
   * Products this person is met through (#585), in the order shown. Left out (undefined): the links are not touched. An
   * array replaces them, an empty one clears them.
   */
  readonly experiences?: readonly PeopleListingExperienceRef[];
  /**
   * Left out (undefined): a new listing takes the provider's own PROVIDER_PHOTO selection when there is one, and a listing that
   * exists keeps its photo. null clears it (the person is then not shown).
   */
  readonly photo?: PeopleListingPhotoInput | null;
}

/** Who a listing is: the provider they belong to and, once they have an account, the member. */
export interface PeopleListingTarget {
  readonly providerId: string;
  /** The member's account (provider_memberships.niho_user_id); null for a draft that waits for the person's account. */
  readonly memberId: string | null;
}

export interface AdminPeopleListingRow {
  /** The listing's id; for a member who is not listed yet `new:<providerId>:<memberId>`. */
  readonly key: string;
  readonly providerId: string;
  /** The provider's public name (its id when it has no public profile). */
  readonly providerName: string;
  readonly memberId: string | null;
  /** The member's current role in the provider; null when the listing has no member, or the member is no longer a current OWNER or COHOST. */
  readonly memberRole: PeopleMemberRole | null;
  /** A READY, rights-confirmed photo is set (for a member not listed yet: the provider's own photo, which a new listing takes). */
  readonly photoReady: boolean;
  readonly listing: (Omit<PeopleListingInput, "experiences" | "photo"> & {
    readonly id: string;
    readonly version: number;
    readonly updatedAtUtc: string;
    readonly photo: PeopleListingPhotoInput | null;
    /** The linked products with what the Admin needs to recognise them. */
    readonly experiences: readonly (PeopleListingExperienceRef & { readonly slug: string; readonly title: string; readonly status: "DRAFT" | "PUBLISHED" | "ARCHIVED" })[];
  }) | null;
  /** The person is on the public pages right now. */
  readonly visible: boolean;
}

export interface PublicPerson {
  readonly slug: string;
  readonly name: string;
  readonly roleJa: string;
  readonly areaJa: string;
  readonly quoteJa: string | null;
  readonly introJa: string | null;
  readonly photo: { readonly src: string; readonly altJa: string; readonly credit: string | null };
  /**
   * The slugs of the public experiences this person is met through (the products linked to the listing, #585), newest
   * first. The page filters them to the language it shows.
   */
  readonly experienceSlugs: readonly string[];
  readonly sortOrder: number;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BLOCK_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTING_ID = /^plg_[0-9a-f]{32}$/;

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
  let experiences: PeopleListingExperienceRef[] | undefined;
  if (raw.experiences !== undefined) {
    if (!Array.isArray(raw.experiences) || raw.experiences.length > PEOPLE_LISTING_EXPERIENCES_MAX) throw new StoreValidationError(`experiences must be a list of at most ${PEOPLE_LISTING_EXPERIENCES_MAX} products.`);
    const seen = new Set<string>();
    experiences = raw.experiences.map((ref, index) => {
      if (!ref || typeof ref !== "object" || typeof ref.providerId !== "string" || typeof ref.productId !== "string") throw new StoreValidationError(`experiences[${index}] needs providerId and productId.`);
      assertStoreIdentifier(ref.providerId, `experiences[${index}].providerId`);
      assertStoreIdentifier(ref.productId, `experiences[${index}].productId`);
      const key = `${ref.providerId}\u0000${ref.productId}`;
      if (seen.has(key)) throw new StoreValidationError(`experiences[${index}] appears twice.`);
      seen.add(key);
      return { providerId: ref.providerId, productId: ref.productId };
    });
  }
  let photo: PeopleListingPhotoInput | null | undefined;
  if (raw.photo === null) photo = null;
  else if (raw.photo !== undefined) {
    if (typeof raw.photo !== "object" || typeof raw.photo.assetId !== "string" || !UUID.test(raw.photo.assetId)) throw new StoreValidationError("photo.assetId must be a media asset id.");
    photo = {
      assetId: raw.photo.assetId.toLowerCase(),
      altJa: line(raw.photo.altJa, "photo.altJa", PEOPLE_LISTING_LIMITS.altMax, true) as string,
      credit: line(raw.photo.credit, "photo.credit", PEOPLE_LISTING_LIMITS.creditMax, false),
    };
  }
  return {
    slug,
    nameJa: line(raw.nameJa, "nameJa", PEOPLE_LISTING_LIMITS.nameMax, true) as string,
    roleJa: line(raw.roleJa, "roleJa", PEOPLE_LISTING_LIMITS.roleMax, true) as string,
    areaJa: line(raw.areaJa, "areaJa", PEOPLE_LISTING_LIMITS.areaMax, true) as string,
    quoteJa: line(raw.quoteJa, "quoteJa", PEOPLE_LISTING_LIMITS.quoteMax, false),
    introJa: intro,
    sortOrder: raw.sortOrder,
    ...(experiences === undefined ? {} : { experiences }),
    ...(photo === undefined ? {} : { photo }),
  };
}

/**
 * SQL: the listing's member is a current OWNER or COHOST of the listing's provider (#589). A person is shown on the public
 * pages only then, so a message sent from their page always reaches someone who can read and answer it: the member, the
 * provider's OWNER and its co-hosts, in the provider's inbox.
 */
export const PEOPLE_MEMBER_CONDITION = `EXISTS (SELECT 1 FROM provider_memberships person_member
   WHERE person_member.provider_id=listing.provider_id AND person_member.niho_user_id=listing.member_id
     AND person_member.role IN ('OWNER','COHOST') AND person_member.active)`;

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

/** The listing's photo: a READY asset whose rights were confirmed. */
export const PEOPLE_PHOTO_JOIN = `
  JOIN experience_provider_media_assets asset
    ON asset.id=listing.photo_asset_id AND asset.provider_id=listing.photo_provider_id AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL`;

const PUBLIC_COLUMNS = `
  listing.slug,listing.name_ja,listing.role_ja,listing.area_ja,listing.quote_ja,listing.sort_order,listing.intro_ja,
  listing.photo_asset_id::text AS photo_asset_id,listing.photo_alt_ja AS photo_alt_ja,listing.photo_credit AS photo_credit,
  COALESCE((SELECT jsonb_agg(visible.slug ORDER BY visible.published_at DESC,visible.slug)
              FROM visible_publications visible
             WHERE EXISTS (SELECT 1 FROM experience_people_listing_experiences link
                            WHERE link.listing_id=listing.id
                              AND link.product_provider_id=visible.provider_id AND link.product_id=visible.product_id)),'[]'::jsonb) AS experience_slugs`;

const PUBLIC_FROM = `
  FROM experience_people_listings listing
  ${PEOPLE_PHOTO_JOIN}`;

function publicPerson(row: DbRow): PublicPerson {
  const slugs = Array.isArray(row.experience_slugs) ? row.experience_slugs.filter((value): value is string => typeof value === "string") : [];
  return {
    slug: String(row.slug),
    name: String(row.name_ja),
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

/** Replaces the linked products as a whole, in the order given. Every product must exist and not be archived. */
async function replaceLinks(client: { query: Pool["query"] }, listingId: string, refs: readonly PeopleListingExperienceRef[]): Promise<void> {
  for (const ref of refs) {
    const found = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 AND status<>'ARCHIVED' FOR SHARE", [ref.providerId, ref.productId]);
    if (!found.rows[0]) throw new StoreNotFoundError("A linked experience was not found.");
  }
  await client.query("DELETE FROM experience_people_listing_experiences WHERE listing_id=$1", [listingId]);
  for (const [index, ref] of refs.entries()) {
    await client.query(
      "INSERT INTO experience_people_listing_experiences (listing_id,product_provider_id,product_id,sort_order) VALUES ($1,$2,$3,$4)",
      [listingId, ref.providerId, ref.productId, index],
    );
  }
}

const photoReadySql = (assetColumn: string, providerColumn: string): string => `EXISTS (SELECT 1 FROM experience_provider_media_assets photo_asset
   WHERE photo_asset.id=${assetColumn} AND photo_asset.provider_id=${providerColumn} AND photo_asset.state='READY' AND photo_asset.rights_confirmed_at IS NOT NULL)`;

export class PeopleListingRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The Admin's list: every listing (shown or not, with the reason in the row's fields) and every current OWNER or COHOST who
   * is not listed yet, so the Admin can list them.
   */
  async adminList(): Promise<readonly AdminPeopleListingRow[]> {
    const listings = await this.#pool.query<DbRow>(
      `SELECT listing.id,listing.provider_id,listing.member_id,listing.slug,listing.name_ja,listing.role_ja,listing.area_ja,listing.quote_ja,listing.intro_ja,
              listing.sort_order,listing.version,listing.updated_at,
              listing.photo_asset_id::text AS photo_asset_id,listing.photo_alt_ja,listing.photo_credit,
              COALESCE(profile.public_display_name,listing.provider_id) AS provider_name,
              (SELECT person_member.role FROM provider_memberships person_member
                WHERE person_member.provider_id=listing.provider_id AND person_member.niho_user_id=listing.member_id
                  AND person_member.role IN ('OWNER','COHOST') AND person_member.active) AS member_role,
              ${photoReadySql("listing.photo_asset_id", "listing.photo_provider_id")} AS photo_ready,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('providerId',link.product_provider_id,'productId',link.product_id,'slug',product.slug,'title',product.public_title,'status',product.status)
                                         ORDER BY link.sort_order,product.slug)
                          FROM experience_people_listing_experiences link
                          JOIN experience_products product ON product.provider_id=link.product_provider_id AND product.id=link.product_id
                         WHERE link.listing_id=listing.id),'[]'::jsonb) AS linked_experiences
         FROM experience_people_listings listing
         LEFT JOIN experience_provider_public_profiles profile ON profile.provider_id=listing.provider_id
        ORDER BY listing.sort_order,listing.slug COLLATE "C"
        LIMIT 500`,
    );
    const candidates = await this.#pool.query<DbRow>(
      `SELECT member.provider_id,member.niho_user_id AS member_id,member.role,COALESCE(profile.public_display_name,member.provider_id) AS provider_name,
              ${photoReadySql("selection.asset_id", "selection.provider_id")} AS photo_ready
         FROM provider_memberships member
         LEFT JOIN experience_provider_public_profiles profile ON profile.provider_id=member.provider_id
         LEFT JOIN experience_provider_media_selection selection ON selection.provider_id=member.provider_id AND selection.placement='PROVIDER_PHOTO'
        WHERE member.active AND member.role IN ('OWNER','COHOST')
          AND NOT EXISTS (SELECT 1 FROM experience_people_listings listing WHERE listing.provider_id=member.provider_id AND listing.member_id=member.niho_user_id)
        ORDER BY COALESCE(profile.public_display_name,member.provider_id) COLLATE "C",member.provider_id COLLATE "C",member.niho_user_id COLLATE "C"
        LIMIT 500`,
    );
    const listed: AdminPeopleListingRow[] = listings.rows.map((row) => {
      const role = row.member_role === "OWNER" || row.member_role === "COHOST" ? row.member_role : null;
      const photoReady = row.photo_ready === true;
      return {
        key: String(row.id),
        providerId: String(row.provider_id),
        providerName: String(row.provider_name),
        memberId: typeof row.member_id === "string" ? row.member_id : null,
        memberRole: role,
        photoReady,
        listing: {
          id: String(row.id), slug: String(row.slug), nameJa: String(row.name_ja), roleJa: String(row.role_ja), areaJa: String(row.area_ja),
          quoteJa: typeof row.quote_ja === "string" ? row.quote_ja : null,
          introJa: typeof row.intro_ja === "string" ? row.intro_ja : null,
          sortOrder: Number(row.sort_order), version: Number(row.version), updatedAtUtc: iso(row.updated_at),
          photo: typeof row.photo_asset_id === "string" ? { assetId: row.photo_asset_id, altJa: String(row.photo_alt_ja), credit: typeof row.photo_credit === "string" ? row.photo_credit : null } : null,
          experiences: (Array.isArray(row.linked_experiences) ? row.linked_experiences : []).map((link: Record<string, unknown>) => ({
            providerId: String(link.providerId), productId: String(link.productId), slug: String(link.slug), title: String(link.title),
            status: link.status as "DRAFT" | "PUBLISHED" | "ARCHIVED",
          })),
        },
        visible: role !== null && photoReady,
      };
    });
    const unlisted: AdminPeopleListingRow[] = candidates.rows.map((row) => ({
      key: `new:${String(row.provider_id)}:${String(row.member_id)}`,
      providerId: String(row.provider_id),
      providerName: String(row.provider_name),
      memberId: String(row.member_id),
      memberRole: row.role as PeopleMemberRole,
      photoReady: row.photo_ready === true,
      listing: null,
      visible: false,
    }));
    return [...listed, ...unlisted];
  }

  /**
   * Lists a person (listingId null, expectedVersion null) or changes a listing (its id and the version the Admin saw), also
   * moving it to another provider or member. A member must be a current OWNER or COHOST of the provider; no member makes a
   * draft that is not shown until an account is attached.
   */
  async adminSave(adminNihoUserId: string, listingId: string | null, expectedVersion: number | null, target: PeopleListingTarget, rawInput: PeopleListingInput): Promise<{ readonly id: string }> {
    assertStoreIdentifier(adminNihoUserId, "adminNihoUserId");
    assertStoreIdentifier(target.providerId, "providerId");
    if (target.memberId !== null) assertStoreIdentifier(target.memberId, "memberId");
    if ((listingId === null) !== (expectedVersion === null)) throw new StoreValidationError("A new listing has neither id nor version; a change has both.");
    if (listingId !== null && !LISTING_ID.test(listingId)) throw new StoreValidationError("listingId is not a listing id.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    const input = validatePeopleListingInput(rawInput);
    return withTransaction(this.#pool, async (client) => {
      const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1 FOR SHARE", [target.providerId]);
      if (!provider.rows[0]) throw new StoreNotFoundError("The provider was not found.");
      if (target.memberId !== null) {
        const member = await client.query(
          "SELECT 1 FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active AND role IN ('OWNER','COHOST') FOR SHARE",
          [target.providerId, target.memberId],
        );
        if (!member.rows[0]) throw new StoreValidationError("The member must be a current OWNER or co-host of the provider.");
      }
      // The photo: given (an asset that is READY with its rights confirmed), cleared, kept, or (a new listing) the provider's own.
      let photo: { providerId: string; assetId: string; altJa: string; credit: string | null } | null | undefined;
      if (input.photo === null) photo = null;
      else if (input.photo !== undefined) {
        const asset = await client.query("SELECT provider_id FROM experience_provider_media_assets WHERE id=$1::uuid AND state='READY' AND rights_confirmed_at IS NOT NULL FOR SHARE", [input.photo.assetId]);
        if (!asset.rows[0]) throw new StoreNotFoundError("The photo was not found, or its rights are not confirmed.");
        photo = { providerId: String(asset.rows[0].provider_id), assetId: input.photo.assetId, altJa: input.photo.altJa, credit: input.photo.credit };
      } else if (listingId === null) {
        const own = await client.query(
          `SELECT selection.provider_id,selection.asset_id::text AS asset_id,selection.alt_text_ja,selection.public_credit
             FROM experience_provider_media_selection selection
             JOIN experience_provider_media_assets asset ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
            WHERE selection.provider_id=$1 AND selection.placement='PROVIDER_PHOTO'`,
          [target.providerId],
        );
        const row = own.rows[0];
        if (row) photo = { providerId: String(row.provider_id), assetId: String(row.asset_id), altJa: String(row.alt_text_ja), credit: typeof row.public_credit === "string" ? row.public_credit : null };
      }
      const photoColumns = photo === undefined ? null : photo === null
        ? [null, null, null, null]
        : [photo.providerId, photo.assetId, photo.altJa, photo.credit];
      let id = listingId;
      try {
        if (listingId === null) {
          id = `plg_${randomUUID().replaceAll("-", "")}`;
          await client.query(
            `INSERT INTO experience_people_listings
               (id,provider_id,member_id,slug,name_ja,role_ja,area_ja,quote_ja,intro_ja,sort_order,photo_provider_id,photo_asset_id,photo_alt_ja,photo_credit,updated_by_admin_niho_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,$13,$14,$15)`,
            [id, target.providerId, target.memberId, input.slug, input.nameJa, input.roleJa, input.areaJa, input.quoteJa, input.introJa, input.sortOrder, ...(photoColumns ?? [null, null, null, null]), adminNihoUserId],
          );
        } else {
          const result = await client.query(
            `UPDATE experience_people_listings
                SET provider_id=$2,member_id=$3,slug=$4,name_ja=$5,role_ja=$6,area_ja=$7,quote_ja=$8,intro_ja=$9,sort_order=$10,
                    photo_provider_id=CASE WHEN $11::boolean THEN $12 ELSE photo_provider_id END,
                    photo_asset_id=CASE WHEN $11::boolean THEN $13::uuid ELSE photo_asset_id END,
                    photo_alt_ja=CASE WHEN $11::boolean THEN $14 ELSE photo_alt_ja END,
                    photo_credit=CASE WHEN $11::boolean THEN $15 ELSE photo_credit END,
                    updated_by_admin_niho_user_id=$16,version=version+1,updated_at=clock_timestamp()
              WHERE id=$1 AND version=$17`,
            [listingId, target.providerId, target.memberId, input.slug, input.nameJa, input.roleJa, input.areaJa, input.quoteJa, input.introJa, input.sortOrder,
              photoColumns !== null, ...(photoColumns ?? [null, null, null, null]), adminNihoUserId, expectedVersion],
          );
          if (result.rowCount !== 1) throw new StoreConflictError("The listing changed; reload and try again.");
        }
        if (input.experiences !== undefined) await replaceLinks(client, id as string, input.experiences);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new StoreConflictError("That slug is already used by another person, or the member is already listed.");
        throw error;
      }
      return { id: id as string };
    });
  }

  /** Takes the person off 街の人 (the row is deleted; messages already sent stay with the provider). */
  async adminWithdraw(adminNihoUserId: string, listingId: string, expectedVersion: number): Promise<void> {
    assertStoreIdentifier(adminNihoUserId, "adminNihoUserId");
    if (!LISTING_ID.test(listingId)) throw new StoreValidationError("listingId is not a listing id.");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion must be a positive integer.");
    const result = await this.#pool.query("DELETE FROM experience_people_listings WHERE id=$1 AND version=$2", [listingId, expectedVersion]);
    if (result.rowCount !== 1) throw new StoreConflictError("The listing changed or is already withdrawn.");
  }

  /** Everyone shown on 街の人, in the Admin's order. */
  async listPublic(): Promise<readonly PublicPerson[]> {
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM}
        WHERE ${PEOPLE_MEMBER_CONDITION}
        ORDER BY listing.sort_order,listing.slug COLLATE "C" LIMIT 200`,
    );
    return result.rows.map(publicPerson);
  }

  async getPublicBySlug(slug: string): Promise<PublicPerson | null> {
    if (!SLUG.test(slug) || slug.length > PEOPLE_LISTING_LIMITS.slugMax) return null;
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} WHERE listing.slug=$1 AND ${PEOPLE_MEMBER_CONDITION}`, [slug],
    );
    return result.rows[0] ? publicPerson(result.rows[0]) : null;
  }

  /**
   * For an experience page or card that wants a link to the people: which listed people an experience is met through (by
   * experience slug), in the Admin's order: the people the product is linked to (#585). Experiences nobody is listed for are
   * left out.
   */
  async personForExperiences(experienceSlugs: readonly string[]): Promise<ReadonlyMap<string, readonly { readonly slug: string; readonly name: string }[]>> {
    const unique = [...new Set(experienceSlugs)].filter((slug) => typeof slug === "string" && slug.length > 0 && slug.length <= 160).slice(0, 200);
    if (unique.length === 0) return new Map();
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT visible.slug AS experience_slug,listing.slug AS person_slug,listing.name_ja
         FROM visible_publications visible
         JOIN experience_people_listing_experiences link ON link.product_provider_id=visible.provider_id AND link.product_id=visible.product_id
         JOIN experience_people_listings listing ON listing.id=link.listing_id
         ${PEOPLE_PHOTO_JOIN}
        WHERE visible.slug = ANY($1::text[]) AND ${PEOPLE_MEMBER_CONDITION}
        ORDER BY listing.sort_order,listing.slug COLLATE "C"`, [unique],
    );
    const map = new Map<string, { slug: string; name: string }[]>();
    for (const row of result.rows) {
      const slug = String(row.experience_slug);
      map.set(slug, [...(map.get(slug) ?? []), { slug: String(row.person_slug), name: String(row.name_ja) }]);
    }
    return map;
  }
}
