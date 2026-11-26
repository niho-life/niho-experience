import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

type DbRow = Record<string, unknown>;
export const PRODUCT_MEMBER_MAX = 3;
export const MEMBER_PROFILE_LIMITS = { name: 40, role: 80, area: 40, quote: 160, introJa: 1200, introEn: 1500, alt: 500, credit: 300 } as const;
export const MEMBER_PROFILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MemberConsentMethod = "SELF" | "ORAL" | "WRITTEN";
export type MemberProxyMethod = Exclude<MemberConsentMethod, "SELF">;

export interface MemberProfileRef {
  readonly providerId: string;
  readonly memberId: string;
}

export interface MemberProfileText {
  readonly role: string | null;
  readonly area: string | null;
  readonly quote: string | null;
  readonly intro: string | null;
}

export interface MemberProfilePhoto {
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string | null;
}

export interface MemberProfileDraft {
  readonly name: string;
  readonly ja: MemberProfileText;
  readonly en: MemberProfileText | null;
  readonly photo: MemberProfilePhoto | null;
  readonly photoReady: boolean;
  readonly version: number;
  readonly updatedBy: { readonly kind: "MEMBER" | "ADMIN"; readonly id: string; readonly at: string };
  readonly pendingConsent: { readonly method: MemberProxyMethod; readonly recordedAt: string; readonly recordedBy: string } | null;
}

export interface MemberProfileState {
  readonly draft: MemberProfileDraft | null;
  readonly publication: { readonly id: string; readonly version: number; readonly visible: boolean; readonly name: string; readonly english: boolean } | null;
  readonly proxyPermission: { readonly method: MemberConsentMethod; readonly grantedAt: string; readonly grantedBy: string } | null;
}

export interface PublicMemberProfile {
  readonly slug: string | null;
  readonly name: string;
  readonly text: MemberProfileText;
  readonly photo: { readonly src: string; readonly alt: string; readonly credit: string | null };
}

export interface ProductMemberSelection {
  readonly options: readonly (MemberProfileRef & { readonly name: string })[];
  readonly selected: readonly (MemberProfileRef & { readonly name: string | null })[];
}

type DraftInput = {
  readonly name: unknown;
  readonly ja: unknown;
  readonly en: unknown;
  readonly photo: unknown;
  readonly expectedVersion: unknown;
};

interface ProfileUpload {
  readonly id: string;
  readonly objectKey: string;
  readonly sourceRefHash: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

const CURRENT_MEMBER_ROLES = "('OWNER','COHOST')";
const textControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const lineControl = /[\u0000-\u001f\u007f-\u009f]/;
const iso = (value: unknown) => new Date(String(value instanceof Date ? value.toISOString() : value)).toISOString();
const nullableText = (value: unknown): string | null => typeof value === "string" ? value : null;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

export function memberProxyMethod(value: unknown): MemberProxyMethod {
  if (value !== "ORAL" && value !== "WRITTEN") throw new StoreValidationError("Consent method must be ORAL or WRITTEN.");
  return value;
}

function text(value: unknown, limit: number, field: string, multiline = false): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new StoreValidationError(`${field} must be text.`);
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if ([...normalized].length > limit || (multiline ? textControl : lineControl).test(normalized)) throw new StoreValidationError(`${field} is invalid or exceeds ${limit} characters.`);
  return normalized || null;
}

export function validateMemberProfileText(value: unknown, locale: "ja" | "en"): MemberProfileText {
  if (!isRecord(value)) throw new StoreValidationError("Profile text is required.");
  return {
    role: text(value.role, MEMBER_PROFILE_LIMITS.role, "role"),
    area: text(value.area, MEMBER_PROFILE_LIMITS.area, "area"),
    quote: text(value.quote, MEMBER_PROFILE_LIMITS.quote, "quote"),
    intro: text(value.intro, locale === "ja" ? MEMBER_PROFILE_LIMITS.introJa : MEMBER_PROFILE_LIMITS.introEn, "intro", true),
  };
}

const TEXT_FIELDS = ["role", "area", "quote", "intro"] as const;
const fingerprint = (value: MemberProfileText) => createHash("sha256").update(JSON.stringify(TEXT_FIELDS.map((key) => value[key]))).digest("hex");

export function matchMemberProfileTranslation(ja: MemberProfileText, en: MemberProfileText): void {
  if (!ja.intro || TEXT_FIELDS.some((key) => Boolean(ja[key]) !== Boolean(en[key]))) {
    throw new StoreValidationError("English must include each populated Japanese field.");
  }
}

const content = (value: unknown): MemberProfileText => value as MemberProfileText;

export function activeProfileMember(provider: string, member: string): string {
  return `EXISTS (SELECT 1 FROM provider_memberships profile_member
    WHERE profile_member.provider_id=${provider} AND profile_member.niho_user_id=${member}
      AND profile_member.active AND profile_member.role IN ${CURRENT_MEMBER_ROLES})`;
}

export function readyProfilePhoto(asset: string, provider: string): string {
  return `EXISTS (SELECT 1 FROM experience_provider_media_assets ready_photo
    WHERE ready_photo.id=${asset} AND ready_photo.provider_id=${provider}
      AND ready_photo.state='READY' AND ready_photo.rights_confirmed_at IS NOT NULL)`;
}

export const VISIBLE_MEMBER_PROFILE = `published.withdrawn_at IS NULL AND published.photo_consent_withdrawn_at IS NULL
  AND ${activeProfileMember("published.provider_id", "published.member_id")}
  AND ${readyProfilePhoto("published.photo_asset_id", "published.photo_provider_id")}`;

export function publicMemberPhotoUrl(assetId: string): string {
  return `/api/public/experience-provider-media/${encodeURIComponent(assetId)}`;
}

function keys(ref: MemberProfileRef): [string, string] {
  assertStoreIdentifier(ref.providerId, "providerId");
  assertStoreIdentifier(ref.memberId, "memberId");
  return [ref.providerId, ref.memberId];
}

async function lockMember(client: PoolClient, ref: MemberProfileRef, role: "OWNER" | "MEMBER", lock: "SHARE" | "UPDATE" = "SHARE"): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM provider_memberships
      WHERE provider_id=$1 AND niho_user_id=$2 AND active AND role IN ${role === "OWNER" ? "('OWNER')" : CURRENT_MEMBER_ROLES}
      FOR ${lock}`, keys(ref),
  );
  if (!result.rowCount) throw new StoreAccessDeniedError();
}

async function requireProxy(client: PoolClient, ref: MemberProfileRef, adminId: string): Promise<void> {
  assertStoreIdentifier(adminId, "adminId");
  await lockMember(client, ref, "MEMBER");
  const permission = await client.query(
    `SELECT 1 FROM experience_provider_member_proxy_permissions
      WHERE provider_id=$1 AND member_id=$2 AND revoked_at IS NULL`, keys(ref),
  );
  if (!permission.rowCount) throw new StoreAccessDeniedError();
}

async function draftForUpdate(client: PoolClient, ref: MemberProfileRef, expected: unknown): Promise<DbRow | null> {
  if (expected !== null && !positiveVersion(expected)) throw new StoreValidationError("A draft version is required.");
  const result = await client.query<DbRow>(
    "SELECT * FROM experience_provider_member_profiles WHERE provider_id=$1 AND member_id=$2 FOR UPDATE", keys(ref),
  );
  const row = result.rows[0] ?? null;
  if ((row ? Number(row.version) : null) !== expected) throw new StoreConflictError("The draft changed.");
  return row;
}

function readDraft(row: DbRow): MemberProfileDraft {
  const ja = content(row.content_ja);
  return {
    name: String(row.name_ja), ja,
    en: row.english_source_fingerprint === fingerprint(ja) ? content(row.content_en) : null,
    photo: typeof row.photo_asset_id === "string" ? { assetId: row.photo_asset_id, alt: String(row.photo_alt_ja), credit: nullableText(row.photo_credit) } : null,
    photoReady: row.photo_ready === true,
    version: Number(row.version),
    updatedBy: { kind: row.updated_by_kind as "ADMIN" | "MEMBER", id: String(row.updated_by), at: iso(row.updated_at) },
    pendingConsent: row.pending_consent_method ? {
      method: memberProxyMethod(row.pending_consent_method), recordedAt: iso(row.pending_consent_at), recordedBy: String(row.pending_consent_by),
    } : null,
  };
}

async function readState(client: PoolClient, ref: MemberProfileRef, includeDraft = true): Promise<MemberProfileState> {
  const params = keys(ref);
  const result = await client.query<DbRow>(
    `SELECT published.id, published.draft_version, published.name_ja, published.content_en IS NOT NULL AS english,
            ${VISIBLE_MEMBER_PROFILE} AS visible
       FROM experience_provider_member_profile_publications published
      WHERE published.provider_id=$1 AND published.member_id=$2 AND published.withdrawn_at IS NULL`, params,
  );
  const permission = await client.query<DbRow>(
    "SELECT method,granted_at,granted_by FROM experience_provider_member_proxy_permissions WHERE provider_id=$1 AND member_id=$2 AND revoked_at IS NULL", params,
  );
  const grant = permission.rows[0];
  const draft = includeDraft && (await client.query<DbRow>(
    `SELECT draft.*, ${readyProfilePhoto("draft.photo_asset_id", "draft.photo_provider_id")} AS photo_ready
       FROM experience_provider_member_profiles draft WHERE provider_id=$1 AND member_id=$2`, params,
  )).rows[0];
  const publication = result.rows[0];
  return {
    draft: draft ? readDraft(draft) : null,
    publication: publication ? { id: String(publication.id), version: Number(publication.draft_version), visible: publication.visible === true, name: String(publication.name_ja), english: publication.english === true } : null,
    proxyPermission: grant ? { method: grant.method as MemberConsentMethod, grantedAt: iso(grant.granted_at), grantedBy: String(grant.granted_by) } : null,
  };
}

function validateRefs(value: unknown): MemberProfileRef[] {
  if (!Array.isArray(value) || value.length > PRODUCT_MEMBER_MAX) throw new StoreValidationError("Select at most three members.");
  const refs: MemberProfileRef[] = value.map((item) => {
    if (!isRecord(item) || typeof item.providerId !== "string" || typeof item.memberId !== "string") throw new StoreValidationError("A member and provider are required.");
    const ref = { providerId: item.providerId, memberId: item.memberId };
    keys(ref);
    return ref;
  });
  if (new Set(refs.map((ref) => JSON.stringify(keys(ref)))).size !== refs.length) throw new StoreValidationError("Select each member only once.");
  return refs;
}

const refKey = (ref: MemberProfileRef) => JSON.stringify(keys(ref));

async function lockProduct(client: PoolClient, providerId: string, productId: string, lock: "SHARE" | "UPDATE"): Promise<void> {
  assertStoreIdentifier(productId, "productId");
  const product = await client.query(
    `SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 AND status<>'ARCHIVED' FOR ${lock}`, [providerId, productId],
  );
  if (!product.rowCount) throw new StoreNotFoundError("Experience was not found.");
}

async function readSelection(client: PoolClient, providerId: string, productId: string): Promise<ProductMemberSelection> {
  const profiles = await client.query<DbRow>(
    `SELECT published.provider_id,published.member_id,published.name_ja
       FROM experience_provider_member_profile_publications published
      WHERE published.provider_id=$1 AND ${VISIBLE_MEMBER_PROFILE}
      ORDER BY published.name_ja COLLATE "C", published.member_id`, [providerId],
  );
  const selected = await client.query<DbRow>(
    `SELECT link.profile_provider_id AS provider_id,link.member_id,published.name_ja
       FROM experience_product_member_profiles link
       LEFT JOIN experience_provider_member_profile_publications published
         ON published.provider_id=link.profile_provider_id AND published.member_id=link.member_id AND ${VISIBLE_MEMBER_PROFILE}
      WHERE link.product_provider_id=$1 AND link.product_id=$2 ORDER BY link.sort_order`, [providerId, productId],
  );
  return {
    options: profiles.rows.map((row) => ({ providerId: String(row.provider_id), memberId: String(row.member_id), name: String(row.name_ja) })),
    selected: selected.rows.map((row) => ({ providerId: String(row.provider_id), memberId: String(row.member_id), name: nullableText(row.name_ja) })),
  };
}

export class MemberProfileRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async get(ref: MemberProfileRef): Promise<MemberProfileState> {
    return withTransaction(this.#pool, async (client) => {
      await lockMember(client, ref, "MEMBER");
      return readState(client, ref);
    });
  }

  async getAsAdmin(ref: MemberProfileRef): Promise<MemberProfileState> {
    return withTransaction(this.#pool, async (client) => {
      await lockMember(client, ref, "MEMBER");
      const grant = await client.query("SELECT 1 FROM experience_provider_member_proxy_permissions WHERE provider_id=$1 AND member_id=$2 AND revoked_at IS NULL", keys(ref));
      return readState(client, ref, Boolean(grant.rowCount));
    });
  }

  async save(ref: MemberProfileRef, input: DraftInput, adminId?: string): Promise<MemberProfileState> {
    const name = text(input.name, MEMBER_PROFILE_LIMITS.name, "name");
    if (!name) throw new StoreValidationError("Name is required.");
    const ja = validateMemberProfileText(input.ja, "ja");
    const en = input.en == null ? null : validateMemberProfileText(input.en, "en");
    if (en) matchMemberProfileTranslation(ja, en);
    if (adminId !== undefined && en) throw new StoreAccessDeniedError();
    return withTransaction(this.#pool, async (client) => {
      if (adminId === undefined) await lockMember(client, ref, "MEMBER");
      else await requireProxy(client, ref, adminId);
      const row = await draftForUpdate(client, ref, input.expectedVersion);
      const sourceFingerprint = fingerprint(ja);
      const approvedEnglish = adminId === undefined ? en : row?.english_source_fingerprint === sourceFingerprint ? content(row.content_en) : null;
      let photo: [string | null, string | null, string | null, string | null] = [null, null, null, null];
      if (input.photo !== null && input.photo !== undefined) {
        if (!isRecord(input.photo) || !row || typeof row.photo_asset_id !== "string" || input.photo.assetId !== row.photo_asset_id) throw new StoreValidationError("Select the photo attached to this draft.");
        const alt = text(input.photo.alt, MEMBER_PROFILE_LIMITS.alt, "photo.alt");
        if (!alt) throw new StoreValidationError("Photo description is required.");
        photo = [String(row.photo_provider_id), row.photo_asset_id, alt, text(input.photo.credit, MEMBER_PROFILE_LIMITS.credit, "photo.credit")];
      }
      const values = [...keys(ref), name, JSON.stringify(ja), approvedEnglish ? JSON.stringify(approvedEnglish) : null,
        approvedEnglish ? sourceFingerprint : null, ...photo, adminId ?? ref.memberId, adminId === undefined ? "MEMBER" : "ADMIN"];
      if (row) {
        await client.query(
          `UPDATE experience_provider_member_profiles
              SET name_ja=$3, content_ja=$4, content_en=$5, english_source_fingerprint=$6,
                  photo_provider_id=$7, photo_asset_id=$8, photo_alt_ja=$9, photo_credit=$10,
                  updated_by=$11,updated_by_kind=$12,updated_at=clock_timestamp(),version=version+1,
                  pending_consent_method=NULL,pending_consent_at=NULL,pending_consent_by=NULL
            WHERE provider_id=$1 AND member_id=$2`, values,
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO experience_provider_member_profiles
             (provider_id,member_id,name_ja,content_ja,content_en,english_source_fingerprint,
              photo_provider_id,photo_asset_id,photo_alt_ja,photo_credit,updated_by,updated_by_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`, values,
        );
        if (!inserted.rowCount) throw new StoreConflictError("The draft changed.");
      }
      return readState(client, ref);
    });
  }

  async addPhoto(ref: MemberProfileRef, version: unknown, altText: unknown, asset: ProfileUpload, adminId?: string): Promise<MemberProfileState> {
    const alt = text(altText, MEMBER_PROFILE_LIMITS.alt, "photo.alt");
    if (!alt || !MEMBER_PROFILE_UUID.test(asset.id) || asset.objectKey !== `experience-provider-media/${asset.id}.jpg`
      || !/^[0-9a-f]{64}$/.test(asset.sourceRefHash) || !Number.isInteger(asset.width) || !Number.isInteger(asset.height)
      || !Number.isInteger(asset.byteSize) || asset.width < 1 || asset.width > 2400 || asset.height < 1 || asset.height > 2400
      || asset.byteSize < 1 || asset.byteSize > 10 * 1024 * 1024) throw new StoreValidationError("Invalid profile photo.");
    return withTransaction(this.#pool, async (client) => {
      if (adminId === undefined) await lockMember(client, ref, "MEMBER");
      else await requireProxy(client, ref, adminId);
      if (!await draftForUpdate(client, ref, version)) throw new StoreNotFoundError("Save the draft first.");
      await client.query(
        `INSERT INTO experience_provider_media_assets
           (id,provider_id,object_key,source_ref_hash,width,height,byte_size,rights_confirmed_at,rights_confirmed_by_admin_niho_user_id,rights_consent_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8,$9)`,
        [asset.id, ref.providerId, asset.objectKey, asset.sourceRefHash, asset.width, asset.height, asset.byteSize, adminId ?? null, adminId === undefined ? null : "member-profile-photo-v1"],
      );
      await client.query(
        `UPDATE experience_provider_member_profiles
            SET photo_provider_id=provider_id,photo_asset_id=$3,photo_alt_ja=$4,photo_credit=NULL,
                updated_by=$5,updated_by_kind=$6,updated_at=clock_timestamp(),version=version+1,
                pending_consent_method=NULL,pending_consent_at=NULL,pending_consent_by=NULL
          WHERE provider_id=$1 AND member_id=$2`, [...keys(ref), asset.id, alt, adminId ?? ref.memberId, adminId === undefined ? "MEMBER" : "ADMIN"],
      );
      return readState(client, ref);
    });
  }

  async getPhoto(ref: MemberProfileRef, assetId: string, adminId?: string): Promise<{ objectKey: string; byteSize: number }> {
    if (!MEMBER_PROFILE_UUID.test(assetId)) throw new StoreNotFoundError("Profile photo was not found.");
    return withTransaction(this.#pool, async (client) => {
      if (adminId === undefined) await lockMember(client, ref, "MEMBER");
      else await requireProxy(client, ref, adminId);
      const result = await client.query<DbRow>(
        `SELECT asset.object_key,asset.byte_size FROM experience_provider_member_profiles draft
           JOIN experience_provider_media_assets asset ON asset.provider_id=draft.photo_provider_id AND asset.id=draft.photo_asset_id
          WHERE draft.provider_id=$1 AND draft.member_id=$2 AND asset.id=$3 AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL`,
        [...keys(ref), assetId],
      );
      const row = result.rows[0];
      if (!row) throw new StoreNotFoundError("Profile photo was not found.");
      return { objectKey: String(row.object_key), byteSize: Number(row.byte_size) };
    });
  }

  async setProxyPermission(ref: MemberProfileRef, granted: boolean, admin?: { id: string; method: MemberProxyMethod }): Promise<MemberProfileState> {
    if (typeof granted !== "boolean") throw new StoreValidationError("Permission is required.");
    if (admin) {
      assertStoreIdentifier(admin.id, "adminId");
      memberProxyMethod(admin.method);
      if (!granted) throw new StoreAccessDeniedError();
    }
    return withTransaction(this.#pool, async (client) => {
      // This exclusive membership lock serializes grant/revoke with all profile writes.
      await lockMember(client, ref, "MEMBER", "UPDATE");
      if (granted) {
        await client.query(
          `INSERT INTO experience_provider_member_proxy_permissions (provider_id,member_id,method,granted_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (provider_id,member_id) DO UPDATE SET
             method=EXCLUDED.method,granted_by=EXCLUDED.granted_by,granted_at=clock_timestamp(),revoked_at=NULL
           WHERE experience_provider_member_proxy_permissions.revoked_at IS NOT NULL`,
          [...keys(ref), admin?.method ?? "SELF", admin?.id ?? ref.memberId],
        );
      } else {
        await client.query(
          `UPDATE experience_provider_member_proxy_permissions SET revoked_at=clock_timestamp()
            WHERE provider_id=$1 AND member_id=$2 AND revoked_at IS NULL`, keys(ref),
        );
        await client.query(
          `UPDATE experience_provider_member_profiles SET pending_consent_method=NULL,pending_consent_at=NULL,pending_consent_by=NULL
            WHERE provider_id=$1 AND member_id=$2 AND pending_consent_method IS NOT NULL`, keys(ref),
        );
      }
      return readState(client, ref);
    });
  }

  async recordConsent(ref: MemberProfileRef, version: unknown, adminId: string, method: MemberProxyMethod, photoConsent: unknown): Promise<MemberProfileState> {
    memberProxyMethod(method);
    if (photoConsent !== true) throw new StoreValidationError("The member must consent to show the photo.");
    return withTransaction(this.#pool, async (client) => {
      await requireProxy(client, ref, adminId);
      const row = await draftForUpdate(client, ref, version);
      if (!row || !content(row.content_ja).intro || !row.photo_asset_id) throw new StoreValidationError("A complete draft with a photo is required.");
      await client.query(
        `UPDATE experience_provider_member_profiles
            SET pending_consent_method=$3,pending_consent_at=clock_timestamp(),pending_consent_by=$4 WHERE provider_id=$1 AND member_id=$2`,
        [...keys(ref), method, adminId],
      );
      return readState(client, ref);
    });
  }

  async publish(ref: MemberProfileRef, version: unknown, acceptance: unknown, adminId?: string): Promise<MemberProfileState> {
    if (acceptance !== true) throw new StoreValidationError("Publication confirmation is required.");
    return withTransaction(this.#pool, async (client) => {
      if (adminId === undefined) await lockMember(client, ref, "MEMBER");
      else await requireProxy(client, ref, adminId);
      const row = await draftForUpdate(client, ref, version);
      if (!row || !content(row.content_ja).intro || !row.photo_asset_id) throw new StoreValidationError("A complete draft with a photo is required.");
      const photo = await client.query(
        `SELECT 1 FROM experience_provider_media_assets
          WHERE id=$1 AND provider_id=$2 AND state='READY' AND rights_confirmed_at IS NOT NULL FOR SHARE`, [row.photo_asset_id, row.photo_provider_id],
      );
      if (!photo.rowCount) throw new StoreValidationError("The profile needs a rights-confirmed photo.");
      if (adminId !== undefined && !row.pending_consent_method) throw new StoreValidationError("Record the member's consent before verification.");
      await client.query(
        `UPDATE experience_provider_member_profile_publications SET withdrawn_at=clock_timestamp()
          WHERE provider_id=$1 AND member_id=$2 AND withdrawn_at IS NULL`, keys(ref),
      );
      await client.query(
        `INSERT INTO experience_provider_member_profile_publications
           (id,provider_id,member_id,draft_version,name_ja,content_ja,content_en,photo_provider_id,photo_asset_id,photo_alt_ja,photo_credit,
            consent_method,consent_at,photo_consented_at,consent_recorded_by,verified_by_admin,verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 COALESCE($13::timestamptz,clock_timestamp()),COALESCE($13::timestamptz,clock_timestamp()),$14,$15,
                 CASE WHEN $15::text IS NOT NULL THEN clock_timestamp() END)`,
        [randomUUID(), ...keys(ref), version, row.name_ja, JSON.stringify(row.content_ja),
          row.english_source_fingerprint === fingerprint(content(row.content_ja)) ? JSON.stringify(row.content_en) : null,
          row.photo_provider_id, row.photo_asset_id, row.photo_alt_ja, row.photo_credit,
          adminId === undefined ? "SELF" : row.pending_consent_method, adminId === undefined ? null : row.pending_consent_at,
          adminId === undefined ? ref.memberId : row.pending_consent_by, adminId ?? null],
      );
      // A new proxy publication always requires freshly recorded consent, even for an unchanged draft.
      await client.query(
        `UPDATE experience_provider_member_profiles SET pending_consent_method=NULL,pending_consent_at=NULL,pending_consent_by=NULL
          WHERE provider_id=$1 AND member_id=$2 AND pending_consent_method IS NOT NULL`, keys(ref),
      );
      return readState(client, ref);
    });
  }

  async withdraw(ref: MemberProfileRef, publicationId: unknown, revokePhoto: boolean): Promise<MemberProfileState> {
    if (typeof publicationId !== "string" || !MEMBER_PROFILE_UUID.test(publicationId)) throw new StoreValidationError("A publication id is required.");
    return withTransaction(this.#pool, async (client) => {
      await lockMember(client, ref, "MEMBER", "UPDATE");
      const withdrawn = await client.query(
        `UPDATE experience_provider_member_profile_publications SET withdrawn_at=clock_timestamp(),
                photo_consent_withdrawn_at=CASE WHEN $4 THEN clock_timestamp() END
          WHERE provider_id=$1 AND member_id=$2 AND id=$3 AND withdrawn_at IS NULL`,
        [...keys(ref), publicationId, revokePhoto],
      );
      if (!withdrawn.rowCount) throw new StoreConflictError("The published profile changed.");
      await client.query(
        `UPDATE experience_provider_member_profiles SET pending_consent_method=NULL,pending_consent_at=NULL,pending_consent_by=NULL
          WHERE provider_id=$1 AND member_id=$2 AND pending_consent_method IS NOT NULL`, keys(ref),
      );
      return readState(client, ref);
    });
  }

  async getProductSelection(owner: MemberProfileRef, productId: string): Promise<ProductMemberSelection> {
    return withTransaction(this.#pool, async (client) => {
      await lockMember(client, owner, "OWNER");
      await lockProduct(client, owner.providerId, productId, "SHARE");
      return readSelection(client, owner.providerId, productId);
    });
  }

  async saveProductSelection(owner: MemberProfileRef, productId: string, selected: unknown, expected: unknown): Promise<ProductMemberSelection> {
    const choices = validateRefs(selected);
    const before = validateRefs(expected);
    return withTransaction(this.#pool, async (client) => {
      await lockMember(client, owner, "OWNER");
      await lockProduct(client, owner.providerId, productId, "UPDATE");
      const current = await readSelection(client, owner.providerId, productId);
      if (JSON.stringify(current.selected.map(refKey)) !== JSON.stringify(before.map(refKey))) throw new StoreConflictError("The product selection changed.");
      const selectable = new Set(current.options.map(refKey));
      for (const ref of choices) {
        // Preserve migrated cross-provider or temporarily hidden selections already on this product.
        if (!selectable.has(refKey(ref)) && !before.some((old) => refKey(old) === refKey(ref))) throw new StoreValidationError("Choose a published profile of this provider.");
      }
      await client.query("DELETE FROM experience_product_member_profiles WHERE product_provider_id=$1 AND product_id=$2", [owner.providerId, productId]);
      for (const [order, ref] of choices.entries()) {
        await client.query(
          `INSERT INTO experience_product_member_profiles (product_provider_id,product_id,profile_provider_id,member_id,sort_order)
           VALUES ($1,$2,$3,$4,$5)`, [owner.providerId, productId, ...keys(ref), order],
        );
      }
      return readSelection(client, owner.providerId, productId);
    });
  }

  async listPublicForExperience(slug: string, locale: "ja" | "en"): Promise<readonly PublicMemberProfile[]> {
    return (await this.listPublicForExperiences([slug], locale)).get(slug) ?? [];
  }

  async listPublicForExperiences(slugs: readonly string[], locale: "ja" | "en"): Promise<ReadonlyMap<string, readonly PublicMemberProfile[]>> {
    if (slugs.length === 0) return new Map();
    const column = locale === "ja" ? "content_ja" : "content_en";
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT visible.slug AS experience_slug,listing.slug,published.name_ja,published.${column} AS localized,
              published.photo_asset_id,published.photo_alt_ja,published.photo_credit
         FROM visible_publications visible
         JOIN experience_product_member_profiles link ON link.product_provider_id=visible.provider_id AND link.product_id=visible.product_id
         JOIN experience_provider_member_profile_publications published ON published.provider_id=link.profile_provider_id AND published.member_id=link.member_id
         LEFT JOIN experience_people_listings listing ON listing.provider_id=published.provider_id AND listing.member_id=published.member_id
        WHERE visible.slug=ANY($1::text[]) AND ${VISIBLE_MEMBER_PROFILE} AND published.${column} IS NOT NULL
        ORDER BY visible.slug,link.sort_order`, [slugs],
    );
    const profiles = new Map<string, PublicMemberProfile[]>();
    for (const row of result.rows) {
      const slug = String(row.experience_slug);
      const members = profiles.get(slug) ?? [];
      members.push({
        slug: nullableText(row.slug), name: String(row.name_ja), text: content(row.localized),
        photo: { src: publicMemberPhotoUrl(String(row.photo_asset_id)), alt: String(locale === "ja" ? row.photo_alt_ja : row.name_ja), credit: nullableText(row.photo_credit) },
      });
      profiles.set(slug, members);
    }
    return profiles;
  }
}
