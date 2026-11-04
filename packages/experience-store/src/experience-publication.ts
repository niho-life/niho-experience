import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  questionsFingerprint,
  cancellationPolicyCode,
  databaseNow,
  offerPricesMatchActiveRules,
  readSaleTerms,
  tokyoDate,
  validSaleTerms,
  writeOfferPrices,
  type ProductSaleCancellationPolicy,
  type ProductSaleTerms,
  type ProductSaleTermsInput,
} from "./guest-bookings.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import {
  projectPublicExperiencePublication,
  projectPublicExperiencePublicationManuscript,
  type PublicExperiencePublication,
} from "./experience-publication-projection.ts";
import { productFromRow, type DbRow } from "./rows.ts";
import { PRODUCT_COLUMNS, requireMembership } from "./repository.ts";
import { lockProviderInventory } from "./inventory.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor, JsonValue, ProductRecord } from "./types.ts";
import { assertCanonicalInstant, assertMoney, assertNonEmptyText, assertStoreIdentifier, normalizeCurrency } from "./validation.ts";

export type ExperiencePublicationBlocker =
  | "ACCOUNT_NOT_USABLE"
  | "CANCELLATION_TERMS_REQUIRED"
  | "CONNECT_NOT_READY"
  | "CONSENT_OUTDATED"
  | "FEE_SETTINGS_REQUIRED"
  | "MANUSCRIPT_REQUIRED"
  | "OPERATIONS_SUSPENDED"
  | "OWNER_NOT_CURRENT"
  | "PAYMENT_REUSE_CONSENT_REQUIRED"
  | "PHOTOS_REQUIRED"
  | "PRICE_REQUIRED"
  | "PUBLIC_CONTENT_INVALID"
  | "READINESS_EXPIRED"
  | "READINESS_MISSING"
  | "SCHEDULE_REQUIRED"
  | "SELLER_MISMATCH"
  | "SLUG_IN_USE";

export class ExperiencePublicationBlockedError extends StoreValidationError {
  readonly blockers: readonly ExperiencePublicationBlocker[];

  constructor(blockers: readonly ExperiencePublicationBlocker[]) {
    super(`Experience publication is blocked: ${blockers.join(", ")}.`);
    this.name = "ExperiencePublicationBlockedError";
    this.blockers = blockers;
  }
}

/**
 * The page validator lives at the authenticated server boundary, next to the page
 * DTO. These two results are coupled to the draft saved in the same transaction;
 * the browser must never call this repository directly or assert them itself.
 */
export interface ExperiencePublicationContentChecks {
  readonly manuscriptReady: boolean;
  readonly photosReady: boolean;
}

/**
 * Server-only draft write model. Seller/account/consent fields are deliberately
 * absent: editing a page cannot turn its host into the legal seller or attest
 * to external readiness.
 */
export interface ExperiencePublicationDraftInput {
  readonly id: string;
  readonly slug: string;
  readonly publicTitle: string;
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly currency: string;
  readonly unitAmount: number;
  readonly cancellationTermsRef: string;
}

/** OWNER create input. Product ID and seller/Connect fields are always generated or resolved by the server. */
export type ExperiencePublicationDraftCreateInput = Omit<ExperiencePublicationDraftInput, "id" | "cancellationTermsRef">;

/** Host DTO for editable sale terms. Internal provider/product IDs and the question fingerprint stay server-side. */
export type ExperienceHostSaleTerms = Omit<ProductSaleTerms,
  "providerId" | "productId" | "bookingQuestionsFingerprint" | "cancellationPolicy"> & {
    readonly cancellationPolicy: ProductSaleCancellationPolicy;
  };

export interface ExperienceHostSaleTermsState {
  readonly draftVersion: number;
  readonly stateVersion: number | null;
  readonly saleTerms: ExperienceHostSaleTerms | null;
}

export interface ExperienceHostSaleTermsSaveInput {
  readonly expectedDraftVersion: number;
  readonly expectedStateVersion: number | null;
  readonly expectedSaleTermsVersion: number | null;
  readonly saleTerms: ProductSaleTermsInput;
  readonly checks: ExperiencePublicationContentChecks;
}

export interface ExperienceHostSaleTermsSaveResult extends Omit<ExperienceHostSaleTermsState, "saleTerms"> {
  readonly saleTerms: ExperienceHostSaleTerms;
  readonly publicationUpdated: boolean;
  readonly blockers: readonly ExperiencePublicationBlocker[];
}

export interface ProviderPublicationReadinessInput {
  readonly accountUsable: boolean;
  readonly connectReady: boolean;
  readonly paymentReuseConsentAccepted: boolean;
  readonly paymentReuseConsentVersion: string | null;
  readonly paymentReuseConsentedAtUtc: string | null;
  readonly sellerDisplayReady: boolean;
  readonly sellerNihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
  readonly requiredConsentVersion: string;
  readonly observedAtUtc: string;
  readonly validUntilUtc: string;
}

export interface ProviderPublicationReadiness extends ProviderPublicationReadinessInput {
  readonly providerId: string;
  readonly ownerNihoUserId: string;
  readonly version: number;
  readonly updatedAtUtc: string;
}

/** Explicit bridge from an Experience seller to NIHO's legacy Connect lookup key. */
export interface ExperienceHostSellerProfile {
  readonly providerId: string;
  readonly legacyProviderId: string;
  readonly providerDisplayName: string;
  readonly sellerNihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
}

export interface ExperienceHostProviderMembership extends ExperienceHostSellerProfile {
  readonly memberRole: "OWNER" | "EDITOR";
}

export interface ExperiencePublicationState {
  readonly providerId: string;
  readonly productId: string;
  readonly currentPublicationId: number | null;
  readonly selfStoppedAtUtc: string | null;
  readonly operationsSuspendedAtUtc: string | null;
  readonly operationsSuspensionCode: string | null;
  readonly ownerResumeRequired: boolean;
  readonly firstPublishedAtUtc: string | null;
  readonly version: number;
  readonly updatedAtUtc: string;
}

export interface PublicationOperationsActor {
  /** A stable NIHO user ID, established only after the operations/Admin boundary authenticates it. */
  readonly nihoUserId: string;
}

export interface PublicExperienceMediaAsset {
  readonly objectKey: string;
  readonly byteSize: number;
}

/** Allowlisted media metadata for the authenticated seller. Object keys stay server-side. */
export interface ExperienceHostMediaAsset {
  readonly id: string;
  readonly position: number;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostMediaAssetInput {
  readonly id: string;
  readonly objectKey: string;
  readonly sourceRefHash: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly publicCredit: string | null;
}

const PUBLICATION_COLUMNS = `
  p.id AS publication_id,p.provider_id,p.product_id,p.slug,p.public_title,p.content,p.currency,
  p.unit_amount, p.seller_display_name, p.published_at, s.first_published_at`;

const SALE_TERMS_COLUMNS = `provider_id,product_id,child_price_amount,child_min_age,child_max_age,child_adult_required,
  minimum_participants,minimum_chargeable_participants,max_party_size,cancellation_policy,
  cancellation_window_minutes_before_start,cancellation_refund_basis_points,minimum_attendance,booking_questions,
  booking_questions_fingerprint,conditions_version,version,updated_at`;

const PUBLIC_READER_COLUMNS = `
  slug,public_title,content,currency,unit_amount,seller_display_name,published_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'asset_id',media.asset_id::text,'alt_text',media.alt_text,'public_credit',media.public_credit
    ) ORDER BY media.position)
      FROM experience_product_publication_media media
      JOIN experience_product_media_assets asset ON asset.id=media.asset_id AND asset.state='READY'
     WHERE media.publication_id=visible_publications.publication_id
  ),'[]'::jsonb) AS photos`;

const VISIBLE_PUBLICATIONS = `
  WITH visible_publications AS (
    SELECT ${PUBLICATION_COLUMNS}
      FROM experience_product_publication_states s
      JOIN experience_product_publications p ON p.id=s.current_publication_id
      JOIN experience_products product ON product.provider_id=s.provider_id AND product.id=s.product_id
     WHERE s.self_stopped_at IS NULL
       AND s.operations_suspended_at IS NULL
       AND s.owner_resume_required=false
       AND product.status='PUBLISHED'
       AND NOT EXISTS (
         SELECT 1 FROM experience_product_publication_media media
         JOIN experience_product_media_assets asset ON asset.id=media.asset_id
          WHERE media.publication_id=p.id AND asset.state<>'READY'
       )
  )`;

const safeInteger = (value: unknown, field: string): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreValidationError(`Database returned an invalid ${field}.`);
  return parsed;
};

const iso = (value: unknown, field: string): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new StoreValidationError(`Database returned an invalid ${field}.`);
  return date.toISOString();
};

const nullableIso = (value: unknown, field: string): string | null => value === null ? null : iso(value, field);

function stateFromRow(row: DbRow): ExperiencePublicationState {
  return {
    providerId: String(row.provider_id),
    productId: String(row.product_id),
    currentPublicationId: row.current_publication_id === null ? null : safeInteger(row.current_publication_id, "current_publication_id"),
    selfStoppedAtUtc: nullableIso(row.self_stopped_at, "self_stopped_at"),
    operationsSuspendedAtUtc: nullableIso(row.operations_suspended_at, "operations_suspended_at"),
    operationsSuspensionCode: row.operations_suspension_code === null ? null : String(row.operations_suspension_code),
    ownerResumeRequired: row.owner_resume_required === true,
    firstPublishedAtUtc: nullableIso(row.first_published_at, "first_published_at"),
    version: safeInteger(row.version, "version"),
    updatedAtUtc: iso(row.updated_at, "updated_at"),
  };
}

function readinessFromRow(row: DbRow): ProviderPublicationReadiness {
  return {
    providerId: String(row.provider_id),
    ownerNihoUserId: String(row.owner_niho_user_id),
    accountUsable: row.account_usable === true,
    connectReady: row.connect_ready === true,
    paymentReuseConsentAccepted: row.payment_reuse_consent_accepted === true,
    paymentReuseConsentVersion: row.payment_reuse_consent_version === null ? null : String(row.payment_reuse_consent_version),
    paymentReuseConsentedAtUtc: nullableIso(row.payment_reuse_consented_at, "payment_reuse_consented_at"),
    sellerDisplayReady: row.seller_display_ready === true,
    sellerNihoAccountRef: String(row.seller_niho_account_ref),
    stripeConnectAccountRef: String(row.stripe_connect_account_ref),
    sellerDisplayName: String(row.seller_display_name),
    requiredConsentVersion: String(row.required_consent_version),
    observedAtUtc: iso(row.observed_at, "observed_at"),
    validUntilUtc: iso(row.valid_until, "valid_until"),
    version: safeInteger(row.version, "version"),
    updatedAtUtc: iso(row.updated_at, "updated_at"),
  };
}

function validateChecks(checks: ExperiencePublicationContentChecks): void {
  if (typeof checks.manuscriptReady !== "boolean" || typeof checks.photosReady !== "boolean") {
    throw new StoreValidationError("Publication content checks must be booleans established by the server validator.");
  }
}

function hostSaleTerms(terms: ProductSaleTerms): ExperienceHostSaleTerms {
  return {
    offerPrices: terms.offerPrices,
    childPricing: terms.childPricing,
    minimumParticipants: terms.minimumParticipants,
    minimumChargeableParticipants: terms.minimumChargeableParticipants,
    maxPartySize: terms.maxPartySize,
    cancellationPolicy: cancellationPolicyCode(terms),
    cancellationWindowMinutesBeforeStart: terms.cancellationWindowMinutesBeforeStart,
    cancellationRefundBasisPoints: terms.cancellationRefundBasisPoints,
    minimumAttendance: terms.minimumAttendance,
    bookingQuestions: terms.bookingQuestions,
    conditionsVersion: terms.conditionsVersion,
    version: terms.version,
    updatedAtUtc: terms.updatedAtUtc,
  };
}

function validateDraft(input: ExperiencePublicationDraftInput): ExperiencePublicationDraftInput & { readonly currency: string } {
  assertStoreIdentifier(input.id, "product.id");
  assertNonEmptyText(input.slug, "product.slug", 160);
  assertNonEmptyText(input.publicTitle, "product.publicTitle", 300);
  assertMoney(input.unitAmount, "product.unitAmount");
  assertNonEmptyText(input.cancellationTermsRef, "product.cancellationTermsRef", 512);
  if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) {
    throw new StoreValidationError("product.content must be a JSON object.");
  }
  try { JSON.stringify(input.content); }
  catch (error) { throw new StoreValidationError("product.content must be JSON serializable.", { cause: error }); }
  return { ...input, currency: normalizeCurrency(input.currency) };
}

function validateReadiness(input: ProviderPublicationReadinessInput): void {
  for (const value of [input.accountUsable, input.connectReady, input.paymentReuseConsentAccepted, input.sellerDisplayReady]) {
    if (typeof value !== "boolean") throw new StoreValidationError("Publication readiness flags must be booleans.");
  }
  if (!(input.paymentReuseConsentVersion === null || typeof input.paymentReuseConsentVersion === "string")
      || !(input.paymentReuseConsentedAtUtc === null || typeof input.paymentReuseConsentedAtUtc === "string")
      || input.paymentReuseConsentAccepted !== (input.paymentReuseConsentVersion !== null && input.paymentReuseConsentedAtUtc !== null)) {
    throw new StoreValidationError("Publication payment reuse consent is inconsistent.");
  }
  if (input.paymentReuseConsentVersion !== null) assertNonEmptyText(input.paymentReuseConsentVersion, "readiness.paymentReuseConsentVersion", 160);
  if (input.paymentReuseConsentedAtUtc !== null) assertCanonicalInstant(input.paymentReuseConsentedAtUtc, "readiness.paymentReuseConsentedAtUtc");
  assertNonEmptyText(input.sellerNihoAccountRef, "readiness.sellerNihoAccountRef", 256);
  assertNonEmptyText(input.stripeConnectAccountRef, "readiness.stripeConnectAccountRef", 256);
  assertNonEmptyText(input.sellerDisplayName, "readiness.sellerDisplayName", 300);
  assertNonEmptyText(input.requiredConsentVersion, "readiness.requiredConsentVersion", 160);
  assertCanonicalInstant(input.observedAtUtc, "readiness.observedAtUtc");
  assertCanonicalInstant(input.validUntilUtc, "readiness.validUntilUtc");
  const observedAt = Date.parse(input.observedAtUtc);
  const validUntil = Date.parse(input.validUntilUtc);
  if (observedAt > Date.now()) {
    throw new StoreValidationError("readiness.observedAtUtc must not be in the future.");
  }
  if (validUntil <= observedAt) {
    throw new StoreValidationError("readiness.validUntilUtc must be after observedAtUtc.");
  }
  if (validUntil - observedAt > 10 * 60 * 1_000) {
    throw new StoreValidationError("readiness validity must not exceed 10 minutes.");
  }
}

function validateExpectedVersion(value: number | null, field: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new StoreValidationError(`${field} must be null or a positive integer.`);
}

async function lockedState(client: PoolClient, providerId: string, productId: string): Promise<ExperiencePublicationState | null> {
  const result = await client.query<DbRow>(
    `SELECT provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at
       FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2 FOR UPDATE`,
    [providerId, productId],
  );
  return result.rows[0] ? stateFromRow(result.rows[0]) : null;
}

async function readinessRow(client: PoolClient, providerId: string, lock = false): Promise<DbRow | null> {
  const result = await client.query<DbRow>(
    `SELECT provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
            payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
            required_consent_version,observed_at,valid_until,version,updated_at,
            observed_at <= clock_timestamp() AND valid_until > clock_timestamp()
              AND valid_until <= observed_at + interval '10 minutes' AS currently_valid
       FROM provider_publication_readiness WHERE provider_id=$1${lock ? " FOR SHARE" : ""}`,
    [providerId],
  );
  return result.rows[0] ?? null;
}

async function lockPublicationSlugs(client: PoolClient, slugs: readonly string[]): Promise<void> {
  for (const slug of [...new Set(slugs)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`experience-publication-slug:${slug}`]);
  }
}

async function blockers(
  client: PoolClient,
  product: ProductRecord,
  checks: ExperiencePublicationContentChecks,
  consentVersion: string | null,
  state: ExperiencePublicationState | null,
): Promise<ExperiencePublicationBlocker[]> {
  const result: ExperiencePublicationBlocker[] = [];
  if (!checks.manuscriptReady) result.push("MANUSCRIPT_REQUIRED");
  const manuscript = projectPublicExperiencePublicationManuscript(product.content);
  if (manuscript === null) result.push("PUBLIC_CONTENT_INVALID");
  const photoIndices = manuscript === null ? [] : [
    ...manuscript.content.timeline.flatMap((item) => item.photoIndex === null ? [] : [item.photoIndex]),
    ...(manuscript.meetingPoint?.exteriorPhotoIndex === null || manuscript.meetingPoint?.exteriorPhotoIndex === undefined
      ? [] : [manuscript.meetingPoint.exteriorPhotoIndex]),
  ];
  const media = await client.query<{ positions: number[] | null }>(
    `SELECT COALESCE(array_agg(source_position ORDER BY source_position),'{}'::integer[]) AS positions
       FROM experience_product_media_assets
      WHERE provider_id=$1 AND product_id=$2 AND state='READY' AND rights_confirmed_at IS NOT NULL`,
    [product.providerId, product.id],
  );
  const positions = new Set((media.rows[0]?.positions ?? []).map(Number));
  if (!checks.photosReady || positions.size === 0 || photoIndices.some((index) => !positions.has(index))) result.push("PHOTOS_REQUIRED");
  if (product.currency !== "JPY" || product.unitAmount <= 0) result.push("PRICE_REQUIRED");
  const facts = await client.query<{ sale_terms: boolean; schedule: boolean; slug_in_use: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM experience_product_sale_terms t WHERE t.provider_id=$1 AND t.product_id=$2) AS sale_terms,
       EXISTS (SELECT 1 FROM schedule_rules r WHERE r.provider_id=$1 AND r.product_id=$2
                AND (r.ends_on IS NULL OR r.ends_on >= (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date)) AS schedule,
       EXISTS (
         SELECT 1 FROM experience_product_publication_states s
         JOIN experience_product_publications p ON p.id=s.current_publication_id
          WHERE p.slug=$3 AND NOT (s.provider_id=$1 AND s.product_id=$2)
       ) AS slug_in_use`,
    [product.providerId, product.id, product.slug],
  );
  const feeSettings = await client.query(
    "SELECT provider_id FROM provider_sale_settings WHERE provider_id=$1 FOR SHARE",
    [product.providerId],
  );
  if (!feeSettings.rows[0]) result.push("FEE_SETTINGS_REQUIRED");
  if (facts.rows[0]?.sale_terms !== true || product.cancellationTermsRef.trim() === "") result.push("CANCELLATION_TERMS_REQUIRED");
  if (facts.rows[0]?.schedule !== true) result.push("SCHEDULE_REQUIRED");
  const terms = await readSaleTerms(client, product.providerId, product.id, true);
  if (terms !== null && terms.offerPrices !== null) {
    const today = tokyoDate(await databaseNow(client));
    if (!await offerPricesMatchActiveRules(client, terms, product.providerId, product.id, today)) result.push("PRICE_REQUIRED");
  }
  if (facts.rows[0]?.slug_in_use === true) result.push("SLUG_IN_USE");
  if (state?.operationsSuspendedAtUtc !== null && state?.operationsSuspendedAtUtc !== undefined) result.push("OPERATIONS_SUSPENDED");

  const row = await readinessRow(client, product.providerId, true);
  if (!row) return [...result, "READINESS_MISSING"];
  const readiness = readinessFromRow(row);
  if (row.currently_valid !== true) result.push("READINESS_EXPIRED");
  const currentOwner = await client.query<{ current_owner: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM provider_memberships m
        WHERE m.provider_id=$1 AND m.niho_user_id=$2 AND m.role='OWNER' AND m.active=true
     ) AS current_owner`,
    [product.providerId, readiness.ownerNihoUserId],
  );
  if (currentOwner.rows[0]?.current_owner !== true) result.push("OWNER_NOT_CURRENT");
  if (!readiness.accountUsable) result.push("ACCOUNT_NOT_USABLE");
  if (!readiness.connectReady) result.push("CONNECT_NOT_READY");
  if (!readiness.paymentReuseConsentAccepted) result.push("PAYMENT_REUSE_CONSENT_REQUIRED");
  if (!readiness.sellerDisplayReady
      || readiness.sellerNihoAccountRef !== product.sellerNihoAccountRef
      || readiness.stripeConnectAccountRef !== product.stripeConnectAccountRef
      || readiness.sellerDisplayName !== product.sellerDisplayName) result.push("SELLER_MISMATCH");
  if (consentVersion === null || consentVersion !== readiness.requiredConsentVersion) result.push("CONSENT_OUTDATED");
  return result;
}

async function insertOrFindPublication(
  client: PoolClient,
  product: ProductRecord,
  consentVersion: string,
  publishedBy: string,
): Promise<number> {
  const terms = await readSaleTerms(client, product.providerId, product.id, true);
  if (!terms) throw new StoreConflictError("Sale terms changed while preparing the immutable publication.");
  const saleTermsVersion = terms.version;
  const previous = await client.query<DbRow>(
    `SELECT id FROM experience_product_publications
      WHERE provider_id=$1 AND product_id=$2 AND draft_version=$3
        AND sale_terms_version=$4 AND consent_version=$5`,
    [product.providerId, product.id, product.version, saleTermsVersion, consentVersion],
  );
  if (previous.rows[0]) return safeInteger(previous.rows[0].id, "publication id");
  const saleTermsSnapshot = {
    offerPrices: terms.offerPrices,
    childPricing: terms.childPricing,
    minimumParticipants: terms.minimumParticipants,
    minimumChargeableParticipants: terms.minimumChargeableParticipants,
    maxPartySize: terms.maxPartySize,
    cancellationPolicy: terms.cancellationPolicy,
    cancellationWindowMinutesBeforeStart: terms.cancellationWindowMinutesBeforeStart,
    cancellationRefundBasisPoints: terms.cancellationRefundBasisPoints,
    minimumAttendance: terms.minimumAttendance,
    bookingQuestions: terms.bookingQuestions,
    bookingQuestionsFingerprint: terms.bookingQuestionsFingerprint,
    conditionsVersion: terms.conditionsVersion,
  };
  const inserted = await client.query<DbRow>(
    `INSERT INTO experience_product_publications
       (provider_id,product_id,draft_version,sale_terms_version,slug,public_title,content,currency,unit_amount,
        cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
        consent_version,published_by_niho_user_id,sale_terms_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     RETURNING id`,
    [product.providerId, product.id, product.version, saleTermsVersion, product.slug, product.publicTitle,
      JSON.stringify(product.content), product.currency, product.unitAmount, product.cancellationTermsRef,
      product.sellerNihoAccountRef, product.stripeConnectAccountRef, product.sellerDisplayName, consentVersion,
      publishedBy, JSON.stringify(saleTermsSnapshot)],
  );
  const publicationId = safeInteger(inserted.rows[0]?.id, "publication id");
  const media = await client.query(
    `INSERT INTO experience_product_publication_media
       (publication_id,asset_id,provider_id,product_id,position,alt_text,public_credit)
     SELECT $3,id,provider_id,product_id,source_position,alt_text,public_credit
       FROM experience_product_media_assets
      WHERE provider_id=$1 AND product_id=$2 AND state='READY' AND rights_confirmed_at IS NOT NULL
      ORDER BY source_position`,
    [product.providerId, product.id, publicationId],
  );
  if (media.rowCount === 0) throw new StoreConflictError("The publication has no rights-confirmed public media.");
  return publicationId;
}

export class ExperiencePublicationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /** Host choices come from current Experience membership, never a NIHO provider directory. */
  async listHostProviders(nihoUserId: string): Promise<readonly ExperienceHostProviderMembership[]> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT p.provider_id,p.legacy_provider_id,p.provider_display_name,p.seller_niho_account_ref,
              p.stripe_connect_account_ref,p.seller_display_name,m.role
         FROM provider_memberships m
         JOIN experience_host_seller_profiles p ON p.provider_id=m.provider_id
        WHERE m.niho_user_id=$1 AND m.active=true AND m.role IN ('OWNER','EDITOR')
        ORDER BY p.provider_display_name COLLATE "C",p.provider_id COLLATE "C"`,
      [nihoUserId],
    );
    return result.rows.map((row) => ({
      providerId: String(row.provider_id),
      legacyProviderId: String(row.legacy_provider_id),
      providerDisplayName: String(row.provider_display_name),
      sellerNihoAccountRef: String(row.seller_niho_account_ref),
      stripeConnectAccountRef: String(row.stripe_connect_account_ref),
      sellerDisplayName: String(row.seller_display_name),
      memberRole: String(row.role) as "OWNER" | "EDITOR",
    }));
  }

  /** Resolve exactly one current Experience OWNER and its explicit seller mapping. */
  async currentOwnerSellerProfile(nihoUserId: string): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "setup-required" }
    | { readonly kind: "ready"; readonly profile: ExperienceHostSellerProfile }
  > {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT m.provider_id,p.legacy_provider_id,p.provider_display_name,p.seller_niho_account_ref,
              p.stripe_connect_account_ref,p.seller_display_name
         FROM provider_memberships m
         LEFT JOIN experience_host_seller_profiles p ON p.provider_id=m.provider_id
        WHERE m.niho_user_id=$1 AND m.active=true AND m.role='OWNER'
        ORDER BY m.provider_id COLLATE "C"`,
      [nihoUserId],
    );
    if (result.rows.length === 0) return { kind: "none" };
    if (result.rows.length !== 1) return { kind: "ambiguous" };
    const row = result.rows[0]!;
    if (row.legacy_provider_id === null) return { kind: "setup-required" };
    return { kind: "ready", profile: {
      providerId: String(row.provider_id),
      legacyProviderId: String(row.legacy_provider_id),
      providerDisplayName: String(row.provider_display_name),
      sellerNihoAccountRef: String(row.seller_niho_account_ref),
      stripeConnectAccountRef: String(row.stripe_connect_account_ref),
      sellerDisplayName: String(row.seller_display_name),
    } };
  }

  /** Current owner-owned drafts; provider and payment references are never part of the host DTO. */
  async listProducts(actor: HostActor): Promise<readonly ProductRecord[]> {
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const result = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products p
          WHERE p.provider_id=$1 ORDER BY p.created_at DESC,p.id COLLATE "C"`,
        [actor.providerId],
      );
      return result.rows.map(productFromRow);
    });
  }

  async getProduct(actor: HostActor, productId: string): Promise<ProductRecord> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const result = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products p
          WHERE p.provider_id=$1 AND p.id=$2`,
        [actor.providerId, productId],
      );
      if (!result.rows[0]) throw new StoreNotFoundError("product");
      return productFromRow(result.rows[0]);
    });
  }

  /** Record the fresh NIHO/Connect result used by publication and public checkout. */
  async refreshReadiness(actor: HostActor, input: ProviderPublicationReadinessInput): Promise<ProviderPublicationReadiness> {
    validateReadiness(input);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const membership = await requireMembership(client, actor, ["OWNER"]);
      const result = await client.query<DbRow>(
        `INSERT INTO provider_publication_readiness
           (provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
            payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
            required_consent_version,observed_at,valid_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz)
         ON CONFLICT (provider_id) DO UPDATE
           SET owner_niho_user_id=EXCLUDED.owner_niho_user_id,
               account_usable=EXCLUDED.account_usable,connect_ready=EXCLUDED.connect_ready,
               payment_reuse_consent_accepted=EXCLUDED.payment_reuse_consent_accepted,
               payment_reuse_consent_version=EXCLUDED.payment_reuse_consent_version,
               payment_reuse_consented_at=EXCLUDED.payment_reuse_consented_at,
               seller_display_ready=EXCLUDED.seller_display_ready,
               seller_niho_account_ref=EXCLUDED.seller_niho_account_ref,
               stripe_connect_account_ref=EXCLUDED.stripe_connect_account_ref,
               seller_display_name=EXCLUDED.seller_display_name,
               required_consent_version=EXCLUDED.required_consent_version,
               observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until,
               version=provider_publication_readiness.version+1,updated_at=clock_timestamp()
         RETURNING provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
           payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
           seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
           required_consent_version,observed_at,valid_until,version,updated_at`,
        [actor.providerId, membership.nihoUserId, input.accountUsable, input.connectReady,
          input.paymentReuseConsentAccepted, input.paymentReuseConsentVersion, input.paymentReuseConsentedAtUtc,
          input.sellerDisplayReady, input.sellerNihoAccountRef, input.stripeConnectAccountRef,
          input.sellerDisplayName, input.requiredConsentVersion, input.observedAtUtc, input.validUntilUtc],
      );
      return readinessFromRow(result.rows[0]!);
    });
  }

  async listMedia(actor: HostActor, productId: string): Promise<readonly ExperienceHostMediaAsset[]> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2", [actor.providerId, productId]);
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const result = await client.query<DbRow>(
        `SELECT id,source_position,width,height,byte_size,alt_text,public_credit
           FROM experience_product_media_assets
          WHERE provider_id=$1 AND product_id=$2 AND state='READY' ORDER BY source_position`,
        [actor.providerId, productId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), position: safeInteger(row.source_position, "media position"),
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text),
        publicCredit: row.public_credit === null ? null : String(row.public_credit),
      }));
    });
  }

  async addMedia(actor: HostActor, productId: string, input: ExperienceHostMediaAssetInput): Promise<ExperienceHostMediaAsset> {
    assertStoreIdentifier(productId, "productId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
      throw new StoreValidationError("media.id must be a UUID v4.");
    }
    assertNonEmptyText(input.objectKey, "media.objectKey", 512);
    if (!/^[0-9a-f]{64}$/.test(input.sourceRefHash)) throw new StoreValidationError("media.sourceRefHash must be a SHA-256 digest.");
    if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 2400
      || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > 2400
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 10 * 1024 * 1024) {
      throw new StoreValidationError("media dimensions and size are invalid.");
    }
    if (typeof input.altText !== "string" || input.altText.length > 500) throw new StoreValidationError("media.altText is invalid.");
    if (input.publicCredit !== null && (typeof input.publicCredit !== "string" || input.publicCredit.trim().length === 0 || input.publicCredit.length > 300)) {
      throw new StoreValidationError("media.publicCredit is invalid.");
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query<{ version: number }>(
        "SELECT version FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE",
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const next = await client.query<{ position: number }>(
        `SELECT COALESCE(MAX(source_position)+1,0)::int AS position
           FROM experience_product_media_assets WHERE provider_id=$1 AND product_id=$2`,
        [actor.providerId, productId],
      );
      const position = Number(next.rows[0]?.position);
      if (!Number.isSafeInteger(position) || position < 0 || position > 19) throw new StoreValidationError("A product can have at most 20 photos.");
      const result = await client.query<DbRow>(
        `INSERT INTO experience_product_media_assets
           (id,provider_id,product_id,source_position,object_key,source_ref_hash,width,height,byte_size,alt_text,public_credit,rights_confirmed_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
         RETURNING id,source_position,width,height,byte_size,alt_text,public_credit`,
        [input.id, actor.providerId, productId, position, input.objectKey, input.sourceRefHash,
          input.width, input.height, input.byteSize, input.altText, input.publicCredit],
      );
      const row = result.rows[0]!;
      const versioned = await client.query(
        `UPDATE experience_products SET version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$3 RETURNING version`,
        [actor.providerId, productId, product.rows[0].version],
      );
      if (versioned.rowCount !== 1) throw new StoreConflictError("Product changed while adding media.");
      return {
        id: String(row.id), position: safeInteger(row.source_position, "media position"),
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text),
        publicCredit: row.public_credit === null ? null : String(row.public_credit),
      };
    });
  }

  async createDraft(actor: HostActor, rawInput: ExperiencePublicationDraftCreateInput): Promise<ProductRecord> {
    const id = randomUUID();
    const input = validateDraft({ ...rawInput, id, cancellationTermsRef: randomUUID() });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const membership = await requireMembership(client, actor, ["OWNER"]);
      const readinessResult = await client.query<DbRow>(
        `SELECT owner_niho_user_id,account_usable,seller_display_ready,seller_niho_account_ref,
                stripe_connect_account_ref,seller_display_name,
                observed_at <= clock_timestamp() AND valid_until > clock_timestamp()
                  AND valid_until <= observed_at + interval '10 minutes' AS currently_valid
           FROM provider_publication_readiness WHERE provider_id=$1 FOR SHARE`,
        [actor.providerId],
      );
      const readiness = readinessResult.rows[0];
      if (!readiness || String(readiness.owner_niho_user_id) !== membership.nihoUserId
          || readiness.account_usable !== true || readiness.seller_display_ready !== true
          || readiness.currently_valid !== true) {
        throw new StoreValidationError("A current OWNER and seller profile are required to create a product.");
      }
      const sellerNihoAccountRef = String(readiness.seller_niho_account_ref);
      const stripeConnectAccountRef = String(readiness.stripe_connect_account_ref);
      const sellerDisplayName = String(readiness.seller_display_name);
      assertNonEmptyText(sellerNihoAccountRef, "readiness.sellerNihoAccountRef", 256);
      assertNonEmptyText(stripeConnectAccountRef, "readiness.stripeConnectAccountRef", 256);
      assertNonEmptyText(sellerDisplayName, "readiness.sellerDisplayName", 300);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${id}`]);
      const result = await client.query<DbRow>(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$3,'DRAFT',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING
         RETURNING ${PRODUCT_COLUMNS}`,
        [actor.providerId, id, input.slug, input.publicTitle, JSON.stringify(input.content), input.currency,
          input.unitAmount, input.cancellationTermsRef, sellerNihoAccountRef, stripeConnectAccountRef, sellerDisplayName],
      );
      if (!result.rows[0]) throw new StoreConflictError("A product with this slug already exists for the seller.");
      return productFromRow(result.rows[0]);
    });
  }

  async getSaleTerms(actor: HostActor, productId: string): Promise<ExperienceHostSaleTermsState> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      const product = await client.query<DbRow>(
        "SELECT version FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE",
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const state = await lockedState(client, actor.providerId, productId);
      const result = await readSaleTerms(client, actor.providerId, productId);
      return {
        draftVersion: safeInteger(product.rows[0].version, "product version"),
        stateVersion: state?.version ?? null,
        saleTerms: result ? hostSaleTerms(result) : null,
      };
    });
  }

  async saveSaleTerms(
    actor: HostActor,
    productId: string,
    input: ExperienceHostSaleTermsSaveInput,
  ): Promise<ExperienceHostSaleTermsSaveResult> {
    assertStoreIdentifier(productId, "productId");
    const terms = validSaleTerms(input.saleTerms);
    validateChecks(input.checks);
    validateExpectedVersion(input.expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(input.expectedStateVersion, "expectedStateVersion");
    validateExpectedVersion(input.expectedSaleTermsVersion, "expectedSaleTermsVersion");
    if (input.expectedDraftVersion === null) throw new StoreValidationError("expectedDraftVersion must be a positive integer.");
    const fingerprint = questionsFingerprint(terms.bookingQuestions);

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${productId}`]);
      const productResult = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE`,
        [actor.providerId, productId],
      );
      const product = productResult.rows[0] ? productFromRow(productResult.rows[0]) : null;
      if (!product) throw new StoreNotFoundError("product");
      if (product.version !== input.expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      const state = await lockedState(client, actor.providerId, productId);
      if ((state?.version ?? null) !== input.expectedStateVersion) {
        throw new StoreConflictError("Publication state version mismatch: read the state again.");
      }

      const child = terms.childPricing;
      const values = [
        actor.providerId, productId, child?.priceYen ?? null, child?.minAge ?? null, child?.maxAge ?? null, child?.adultRequired ?? null,
        terms.minimumParticipants, terms.minimumChargeableParticipants, terms.maxPartySize,
        terms.cancellationPolicy, terms.cancellationWindowMinutesBeforeStart, terms.cancellationRefundBasisPoints,
        terms.minimumAttendance, JSON.stringify(terms.bookingQuestions), fingerprint, terms.conditionsVersion,
      ];
      const saved = input.expectedSaleTermsVersion === null
        ? await client.query<DbRow>(
          `INSERT INTO experience_product_sale_terms (
             provider_id, product_id, child_price_amount, child_min_age, child_max_age, child_adult_required,
             minimum_participants, minimum_chargeable_participants, max_party_size,
             cancellation_policy, cancellation_window_minutes_before_start, cancellation_refund_basis_points,
             minimum_attendance, booking_questions, booking_questions_fingerprint, conditions_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
           ON CONFLICT DO NOTHING
           RETURNING ${SALE_TERMS_COLUMNS}`,
          values,
        )
        : await client.query<DbRow>(
          `UPDATE experience_product_sale_terms
              SET child_price_amount=$3, child_min_age=$4, child_max_age=$5, child_adult_required=$6,
                  minimum_participants=$7, minimum_chargeable_participants=$8, max_party_size=$9,
                  cancellation_policy=$10, cancellation_window_minutes_before_start=$11, cancellation_refund_basis_points=$12,
                  minimum_attendance=$13, booking_questions=$14::jsonb,
                  booking_questions_fingerprint=$15, conditions_version=$16,
                  version=version+1, updated_at=clock_timestamp()
            WHERE provider_id=$1 AND product_id=$2 AND version=$17
            RETURNING ${SALE_TERMS_COLUMNS}`,
          [...values, input.expectedSaleTermsVersion],
        );
      const termsRow = saved.rows[0];
      if (!termsRow) {
        throw new StoreConflictError(input.expectedSaleTermsVersion === null
          ? "Sale terms already exist for this product."
          : "Sale terms version mismatch or sale terms not found in this provider.");
      }
      await writeOfferPrices(client, actor.providerId, productId, terms.offerPrices, Number(termsRow.version));
      const writtenTerms = await readSaleTerms(client, actor.providerId, productId);
      if (!writtenTerms) throw new StoreConflictError("Sale terms disappeared while saving.");

      let consentVersion: string | null = null;
      if (state?.currentPublicationId !== null && state?.currentPublicationId !== undefined) {
        const current = await client.query<DbRow>("SELECT consent_version FROM experience_product_publications WHERE id=$1", [state.currentPublicationId]);
        consentVersion = current.rows[0] ? String(current.rows[0].consent_version) : null;
      }
      const blocked = await blockers(client, product, input.checks, consentVersion, state);
      const active = state !== null && state.currentPublicationId !== null && state.selfStoppedAtUtc === null
        && state.operationsSuspendedAtUtc === null && !state.ownerResumeRequired;
      if (!active || blocked.length > 0 || consentVersion === null) {
        return {
          draftVersion: product.version,
          stateVersion: state?.version ?? null,
          saleTerms: hostSaleTerms(writtenTerms),
          publicationUpdated: false,
          blockers: consentVersion === null && active && !blocked.includes("CONSENT_OUTDATED")
            ? [...blocked, "CONSENT_OUTDATED"] : blocked,
        };
      }

      const publicationId = await insertOrFindPublication(client, product, consentVersion, actor.nihoUserId);
      const updatedState = await client.query<DbRow>(
        `UPDATE experience_product_publication_states
            SET current_publication_id=$3,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$4
          RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
        [actor.providerId, productId, publicationId, state.version],
      );
      if (!updatedState.rows[0]) throw new StoreConflictError("Publication state version mismatch.");
      return {
        draftVersion: product.version,
        stateVersion: stateFromRow(updatedState.rows[0]).version,
        saleTerms: hostSaleTerms(writtenTerms),
        publicationUpdated: true,
        blockers: [],
      };
    });
  }

  async recordReadiness(
    actor: HostActor,
    input: ProviderPublicationReadinessInput,
    expectedVersion: number | null,
  ): Promise<ProviderPublicationReadiness> {
    validateReadiness(input);
    validateExpectedVersion(expectedVersion, "expectedVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const membership = await requireMembership(client, actor, ["OWNER"]);
      const values = [actor.providerId, membership.nihoUserId, input.accountUsable, input.connectReady,
        input.paymentReuseConsentAccepted, input.paymentReuseConsentVersion, input.paymentReuseConsentedAtUtc,
        input.sellerDisplayReady, input.sellerNihoAccountRef, input.stripeConnectAccountRef,
        input.sellerDisplayName, input.requiredConsentVersion, input.observedAtUtc, input.validUntilUtc];
      const result = expectedVersion === null
        ? await client.query<DbRow>(
          `INSERT INTO provider_publication_readiness
             (provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
              payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
              seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
              required_consent_version,observed_at,valid_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz)
           ON CONFLICT DO NOTHING
           RETURNING provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
             payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
             required_consent_version,observed_at,valid_until,version,updated_at`, values)
        : await client.query<DbRow>(
          `UPDATE provider_publication_readiness
              SET owner_niho_user_id=$2,account_usable=$3,connect_ready=$4,payment_reuse_consent_accepted=$5,
                  payment_reuse_consent_version=$6,payment_reuse_consented_at=$7::timestamptz,seller_display_ready=$8,
                  seller_niho_account_ref=$9,stripe_connect_account_ref=$10,seller_display_name=$11,
                  required_consent_version=$12,observed_at=$13::timestamptz,valid_until=$14::timestamptz,
                  version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND version=$15
            RETURNING provider_id,owner_niho_user_id,account_usable,connect_ready,payment_reuse_consent_accepted,
              payment_reuse_consent_version,payment_reuse_consented_at,seller_display_ready,
              seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
              required_consent_version,observed_at,valid_until,version,updated_at`, [...values, expectedVersion]);
      if (!result.rows[0]) throw new StoreConflictError("Publication readiness version mismatch.");
      return readinessFromRow(result.rows[0]);
    });
  }

  async saveDraft(
    actor: HostActor,
    rawInput: ExperiencePublicationDraftInput,
    expectedDraftVersion: number,
    expectedStateVersion: number | null,
    checks: ExperiencePublicationContentChecks,
  ): Promise<{ readonly draft: ProductRecord; readonly publicationUpdated: boolean; readonly blockers: readonly ExperiencePublicationBlocker[] }> {
    const input = validateDraft(rawInput);
    validateChecks(checks);
    validateExpectedVersion(expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(expectedStateVersion, "expectedStateVersion");
    if (expectedDraftVersion === null) throw new StoreValidationError("expectedDraftVersion must be a positive integer.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${input.id}`]);
      const current = await client.query<{ slug: string }>(
        "SELECT slug FROM experience_products WHERE provider_id=$1 AND id=$2 AND version=$3 FOR UPDATE",
        [actor.providerId, input.id, expectedDraftVersion],
      );
      if (!current.rows[0]) throw new StoreConflictError("Product version mismatch or product not found in this provider.");
      await lockPublicationSlugs(client, [current.rows[0].slug, input.slug]);
      const updated = await client.query<DbRow>(
        `UPDATE experience_products
            SET slug=$3,public_title=$4,content=$5::jsonb,currency=$6,unit_amount=$7,
                cancellation_terms_ref=$8,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$9
          RETURNING ${PRODUCT_COLUMNS}`,
        [actor.providerId, input.id, input.slug, input.publicTitle, JSON.stringify(input.content), input.currency,
          input.unitAmount, input.cancellationTermsRef, expectedDraftVersion],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Product version mismatch or product not found in this provider.");
      const draft = productFromRow(updated.rows[0]);
      const state = await lockedState(client, actor.providerId, input.id);
      if ((state?.version ?? null) !== expectedStateVersion) {
        throw new StoreConflictError("Publication state version mismatch: read the state again.");
      }
      let consent: string | null = null;
      if (state?.currentPublicationId !== null && state?.currentPublicationId !== undefined) {
        const current = await client.query<DbRow>("SELECT consent_version FROM experience_product_publications WHERE id=$1", [state.currentPublicationId]);
        consent = current.rows[0] ? String(current.rows[0].consent_version) : null;
      }
      const blocked = await blockers(client, draft, checks, consent, state);
      const active = state !== null && state.currentPublicationId !== null && state.selfStoppedAtUtc === null
        && state.operationsSuspendedAtUtc === null && !state.ownerResumeRequired;
      if (!active || blocked.length > 0) return { draft, publicationUpdated: false, blockers: blocked };
      const publicationId = await insertOrFindPublication(client, draft, consent!, actor.nihoUserId);
      const changed = await client.query(
        `UPDATE experience_product_publication_states
            SET current_publication_id=$3,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$4`,
        [actor.providerId, input.id, publicationId, state.version],
      );
      if (changed.rowCount !== 1) throw new StoreConflictError("Publication state version mismatch.");
      return { draft, publicationUpdated: true, blockers: [] };
    });
  }

  async publish(
    actor: HostActor,
    productId: string,
    input: {
      readonly expectedDraftVersion: number;
      readonly expectedStateVersion: number | null;
      /** When supplied by a host API CAS token, publish only the terms the owner just reviewed. */
      readonly expectedSaleTermsVersion?: number | null;
      readonly consentVersion: string;
      readonly checks: ExperiencePublicationContentChecks;
    },
  ): Promise<ExperiencePublicationState> {
    assertStoreIdentifier(productId, "productId");
    validateExpectedVersion(input.expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(input.expectedStateVersion, "expectedStateVersion");
    if (input.expectedSaleTermsVersion !== undefined) validateExpectedVersion(input.expectedSaleTermsVersion, "expectedSaleTermsVersion");
    assertNonEmptyText(input.consentVersion, "consentVersion", 160);
    validateChecks(input.checks);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${productId}`]);
      const productResult = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE`,
        [actor.providerId, productId],
      );
      if (!productResult.rows[0]) throw new StoreNotFoundError("product");
      const product = productFromRow(productResult.rows[0]);
      if (product.version !== input.expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      await lockPublicationSlugs(client, [product.slug]);
      const state = await lockedState(client, actor.providerId, productId);
      if ((state?.version ?? null) !== input.expectedStateVersion) throw new StoreConflictError("Publication state version mismatch: read the state again.");
      if (input.expectedSaleTermsVersion !== undefined) {
        const currentTerms = await readSaleTerms(client, actor.providerId, productId, true);
        if ((currentTerms?.version ?? null) !== input.expectedSaleTermsVersion) {
          throw new StoreConflictError("Sale terms version mismatch: read the terms again.");
        }
      }
      const blocked = await blockers(client, product, input.checks, input.consentVersion, state);
      if (blocked.length > 0) throw new ExperiencePublicationBlockedError(blocked);
      await client.query(
        "UPDATE experience_products SET status='PUBLISHED' WHERE provider_id=$1 AND id=$2 AND status='DRAFT'",
        [actor.providerId, productId],
      );
      const publicationId = await insertOrFindPublication(client, product, input.consentVersion, actor.nihoUserId);
      const result = state === null
        ? await client.query<DbRow>(
          `INSERT INTO experience_product_publication_states
             (provider_id,product_id,current_publication_id,first_published_at)
           SELECT $1,$2,$3,published_at FROM experience_product_publications WHERE id=$3
           RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
             operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
          [actor.providerId, productId, publicationId])
        : await client.query<DbRow>(
          `UPDATE experience_product_publication_states
              SET current_publication_id=$3,self_stopped_at=NULL,owner_resume_required=false,
                  version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND product_id=$2 AND version=$4 AND operations_suspended_at IS NULL
            RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
              operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
          [actor.providerId, productId, publicationId, state.version]);
      if (!result.rows[0]) throw new StoreConflictError("Publication state changed while publishing.");
      return stateFromRow(result.rows[0]);
    });
  }

  async stop(actor: HostActor, productId: string, expectedStateVersion: number): Promise<ExperiencePublicationState> {
    assertStoreIdentifier(productId, "productId");
    validateExpectedVersion(expectedStateVersion, "expectedStateVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_publication_states
            SET self_stopped_at=COALESCE(self_stopped_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3 AND current_publication_id IS NOT NULL
          RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
        [actor.providerId, productId, expectedStateVersion],
      );
      if (!result.rows[0]) throw new StoreConflictError("Publication state version mismatch or publication not found.");
      return stateFromRow(result.rows[0]);
    });
  }

  async suspendByOperations(
    actor: PublicationOperationsActor,
    providerId: string,
    productId: string,
    reasonCode: string,
    expectedStateVersion: number,
  ): Promise<ExperiencePublicationState> {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    if (!/^[A-Z0-9_]{1,80}$/.test(reasonCode)) throw new StoreValidationError("reasonCode must be an uppercase machine code.");
    validateExpectedVersion(expectedStateVersion, "expectedStateVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_publication_states
            SET operations_suspended_at=clock_timestamp(),operations_suspension_code=$4,
                operations_suspended_by_niho_user_id=$5,owner_resume_required=true,
                version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3 AND current_publication_id IS NOT NULL
          RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
        [providerId, productId, expectedStateVersion, reasonCode, actor.nihoUserId],
      );
      if (!result.rows[0]) throw new StoreConflictError("Publication state version mismatch or publication not found.");
      return stateFromRow(result.rows[0]);
    });
  }

  async clearOperationsSuspension(
    actor: PublicationOperationsActor,
    providerId: string,
    productId: string,
    expectedStateVersion: number,
  ): Promise<ExperiencePublicationState> {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    validateExpectedVersion(expectedStateVersion, "expectedStateVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_publication_states
            SET operations_suspended_at=NULL,operations_suspension_code=NULL,
                operations_suspended_by_niho_user_id=NULL,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3 AND operations_suspended_at IS NOT NULL
          RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
        [providerId, productId, expectedStateVersion],
      );
      if (!result.rows[0]) throw new StoreConflictError("Publication state version mismatch or operations suspension not found.");
      return stateFromRow(result.rows[0]);
    });
  }

  async getState(actor: HostActor, productId: string): Promise<ExperiencePublicationState | null> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR", "VIEWER"]);
      return lockedState(client, actor.providerId, productId);
    });
  }

  /** The one source for catalog, detail, metadata, sitemap and new-checkout admission. */
  async getPublicBySlug(slug: string): Promise<PublicExperiencePublication | null> {
    assertNonEmptyText(slug, "slug", 160);
    const result = await this.#pool.query<DbRow>(
      `${VISIBLE_PUBLICATIONS}
       SELECT ${PUBLIC_READER_COLUMNS} FROM visible_publications WHERE slug=$1 ORDER BY publication_id DESC LIMIT 2`,
      [slug],
    );
    return result.rows.length === 1 ? projectPublicExperiencePublication(result.rows[0]!) : null;
  }

  async listPublic(): Promise<readonly PublicExperiencePublication[]> {
    const result = await this.#pool.query<DbRow>(
      `${VISIBLE_PUBLICATIONS}
       SELECT ${PUBLIC_READER_COLUMNS} FROM visible_publications
        WHERE NOT EXISTS (
          SELECT 1 FROM visible_publications duplicate
           WHERE duplicate.slug=visible_publications.slug AND duplicate.publication_id<>visible_publications.publication_id
        )
        ORDER BY visible_publications.first_published_at DESC,visible_publications.publication_id DESC`,
    );
    return result.rows.flatMap((row) => {
      const publication = projectPublicExperiencePublication(row);
      return publication === null ? [] : [publication];
    });
  }

  /** Internal object-store locator for the anonymous relay; never serialize this value to a client. */
  async getPublicMediaAsset(assetId: string): Promise<PublicExperienceMediaAsset | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) return null;
    const result = await this.#pool.query<DbRow>(
      `${VISIBLE_PUBLICATIONS}
       SELECT asset.object_key,asset.byte_size
         FROM visible_publications publication
         JOIN experience_product_publication_media media ON media.publication_id=publication.publication_id
         JOIN experience_product_media_assets asset ON asset.id=media.asset_id AND asset.state='READY'
        WHERE asset.id=$1::uuid LIMIT 1`,
      [assetId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { objectKey: String(row.object_key), byteSize: safeInteger(row.byte_size, "media byte_size") };
  }
}

export type { PublicExperiencePublication } from "./experience-publication-projection.ts";
