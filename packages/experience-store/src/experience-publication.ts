import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  GUEST_BOOKING_LIMITS,
  EXPERIENCE_SUPPORT_CONSENT_VERSION,
  activeRules,
  questionsFingerprint,
  cancellationPolicyCode,
  databaseNow,
  offerPricesMatchActiveRules,
  readSaleTerms,
  salePriceSetMatchesProduct,
  tokyoDate,
  validSaleTerms,
  writeOfferPrices,
  type ProductSaleCancellationPolicy,
  type ProductSaleTerms,
  type ProductSaleTermsInput,
} from "./guest-bookings.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isHostAccountId } from "./host-accounts.ts";
import { payoutConsentStillCounts } from "./payout-account-consents.ts";
import { enqueueListingSuspensionNotification, type ListingSuspensionChange } from "./host-notification-outbox.ts";
import { isHostSellerRef } from "./host-sellers.ts";
import {
  projectPublicExperiencePublication,
  projectPublicExperiencePublicationManuscript,
  type PublicExperiencePublication,
} from "./experience-publication-projection.ts";
import { productFromRow, type DbRow } from "./rows.ts";
import { PRODUCT_COLUMNS, requireMembership } from "./repository.ts";
import { lockProviderInventory } from "./inventory.ts";
import { CLAIMED_PUBLICATION_SLUGS_CTE, VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { withTransaction } from "./transaction.ts";
import {
  englishPublicationManuscriptOf,
  publicationFaqIssue,
  publicationManuscriptFingerprint,
  validPublicationLocaleManuscript,
} from "./experience-publication-manuscript.ts";
import type { HostActor, JsonValue, ProductRecord, PublicationAdminDraftActor } from "./types.ts";
import { assertCanonicalInstant, assertMoney, assertNonEmptyText, assertStoreIdentifier, normalizeCurrency } from "./validation.ts";

export type ExperiencePublicationBlocker =
  | "ACCOUNT_NOT_USABLE"
  | "CANCELLATION_TERMS_REQUIRED"
  | "CONNECT_NOT_READY"
  | "CONSENT_OUTDATED"
  | "FEE_SETTINGS_REQUIRED"
  | "SUPPORT_CONSENT_REQUIRED"
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
  /** Present only when an immutable Admin review matches this exact saved manuscript. */
  readonly adminReview?: ExperienceAdminReviewFingerprints;
}

export type AdminSellerConfirmationMethod = "VERBAL" | "WRITTEN";

export interface ExperienceAdminReviewFingerprints {
  readonly contentFingerprint: string;
  readonly japaneseFingerprint: string;
  readonly englishFingerprint: string;
}

export interface ExperienceAdminEnglishReview {
  readonly reviewed: boolean;
  readonly reviewedAtUtc: string | null;
  readonly contentFingerprint: string;
  readonly japaneseFingerprint: string | null;
  readonly englishFingerprint: string | null;
}

export interface ExperienceAdminPublicationStatus {
  readonly draftVersion: number;
  readonly stateVersion: number | null;
  readonly saleTermsVersion: number | null;
  readonly blockers: readonly ExperiencePublicationBlocker[];
  readonly englishReview: ExperienceAdminEnglishReview;
}

export interface ExperiencePublicationManuscriptReview {
  readonly publicContentReady: boolean;
  readonly ownerConfirmed: boolean;
  readonly contentFingerprint: string;
  readonly japaneseFingerprint: string | null;
  readonly englishFingerprint: string | null;
}

/** Current schedule rules the OWNER may price. Provider and inventory identifiers stay server-side. */
export interface ExperienceHostSaleOffer {
  readonly id: string;
  readonly localStartTime: string;
  readonly durationMinutes: number;
  readonly capacity: number;
  readonly recurrence: { readonly kind: "DAILY" | "WEEKLY" | "WEEKENDS" | "SELECTED_WEEKDAYS"; readonly weekdays?: readonly string[] };
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

/**
 * An operator-provisioned Experience seller: its legal seller name, its payout account and either an explicit bridge to
 * NIHO's legacy Connect lookup key (the NIHO login), or none (a seller registered for Experience host accounts, ADR 0003,
 * whose readiness is read from Stripe directly and whose seller reference is a provider-scoped `sel_` reference).
 */
export interface ExperienceHostSellerProfile {
  readonly providerId: string;
  /** NIHO's legacy Connect lookup key; null for a seller registered for Experience host accounts. */
  readonly legacyProviderId: string | null;
  readonly providerDisplayName: string;
  readonly sellerNihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
}

/** A seller mapped to a NIHO user and NIHO's legacy Connect lookup key (the NIHO login). */
export interface NihoMappedSellerProfile extends ExperienceHostSellerProfile {
  readonly legacyProviderId: string;
}

/** A seller registered for Experience host accounts (ADR 0003): no NIHO key, a `sel_` seller reference. */
export interface HostAccountSellerProfile extends ExperienceHostSellerProfile {
  readonly legacyProviderId: null;
}

export interface ExperienceHostProviderMembership extends NihoMappedSellerProfile {
  readonly memberRole: "OWNER" | "EDITOR";
}

export type HostAccountSellerProfileResolution =
  /** The host account is the active OWNER of no provider. */
  | { readonly kind: "none" }
  /** It is the active OWNER of more than one provider: the host screens resolve exactly one. */
  | { readonly kind: "ambiguous" }
  /** Its provider has no seller registered for host accounts (none, or one mapped to NIHO instead). */
  | { readonly kind: "setup-required"; readonly providerId: string }
  | { readonly kind: "ready"; readonly profile: HostAccountSellerProfile; readonly hostAccountActive: boolean };

/** Name-only seller choice exposed by the Admin draft BFF. */
export interface ExperienceAdminDraftSeller {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly sellerDisplayName: string;
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

export interface PublicExperienceProviderMedia {
  readonly id: string;
  readonly placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

/** Allowlisted media metadata for the authenticated seller. Object keys stay server-side. */
export interface ExperienceHostMediaAsset {
  readonly id: string;
  readonly position: number;
  readonly sourcePosition: number;
  readonly placement: "GALLERY";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostMediaSelectionInput {
  readonly id: string;
  readonly altText: string;
  readonly altTextJa: string;
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
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostProviderMediaAsset {
  readonly id: string;
  readonly placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostProviderMediaAssetInput {
  readonly id: string;
  readonly objectKey: string;
  readonly sourceRefHash: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly placement: ExperienceHostProviderMediaAsset["placement"];
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostProviderMediaSelectionInput {
  readonly id: string;
  readonly placement: ExperienceHostProviderMediaAsset["placement"];
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
}

export interface ExperienceHostProviderMedia {
  readonly version: number;
  readonly assets: readonly ExperienceHostProviderMediaAsset[];
}

const SALE_TERMS_COLUMNS = `provider_id,product_id,child_price_amount,child_min_age,child_max_age,child_adult_required,
  minimum_participants,minimum_chargeable_participants,max_party_size,cancellation_policy,
  cancellation_window_minutes_before_start,cancellation_refund_basis_points,minimum_attendance,booking_questions,
  booking_questions_fingerprint,conditions_version,version,updated_at`;

const PUBLIC_READER_COLUMNS = `
  draft_version,publisher_kind,admin_proxy_review,
  slug,public_title,content,currency,unit_amount,seller_display_name,published_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'asset_id',media.asset_id::text,'alt_text',media.alt_text,'alt_text_ja',media.alt_text_ja,
      'public_credit',media.public_credit,'placement',media.placement,'source_position',media.source_position
    ) ORDER BY media.position)
      FROM experience_product_publication_media media
      JOIN experience_product_media_assets asset ON asset.id=media.asset_id AND asset.state='READY'
     WHERE media.publication_id=visible_publications.publication_id
  ),'[]'::jsonb) AS photos,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'asset_id',selection.asset_id::text,'placement',selection.placement,
      'alt_text',selection.alt_text,'alt_text_ja',selection.alt_text_ja,'public_credit',selection.public_credit
    ) ORDER BY selection.placement)
      FROM experience_provider_media_selection selection
      JOIN experience_provider_media_assets asset
        ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id
       AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
     WHERE selection.provider_id=visible_publications.provider_id
  ),'[]'::jsonb) AS provider_media`;

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

async function readProviderMedia(client: PoolClient, providerId: string): Promise<ExperienceHostProviderMedia> {
  const state = await client.query<{ version: number }>("SELECT version FROM experience_provider_media_state WHERE provider_id=$1", [providerId]);
  const result = await client.query<DbRow>(
    `SELECT asset.id,selection.placement,asset.width,asset.height,asset.byte_size,
            selection.alt_text,selection.alt_text_ja,selection.public_credit
       FROM experience_provider_media_selection selection
       JOIN experience_provider_media_assets asset
         ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id
      WHERE selection.provider_id=$1 AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
      ORDER BY selection.placement`, [providerId],
  );
  return {
    version: safeInteger(state.rows[0]?.version, "provider media version"),
    assets: result.rows.map((row) => ({
      id: String(row.id), placement: String(row.placement) as ExperienceHostProviderMediaAsset["placement"],
      width: safeInteger(row.width, "provider media width"), height: safeInteger(row.height, "provider media height"),
      byteSize: safeInteger(row.byte_size, "provider media byte_size"), altText: String(row.alt_text),
      altTextJa: String(row.alt_text_ja), publicCredit: row.public_credit === null ? null : String(row.public_credit),
    })),
  };
}

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
  if (checks.adminReview !== undefined && (!/^[0-9a-f]{64}$/.test(checks.adminReview.contentFingerprint)
    || !/^[0-9a-f]{64}$/.test(checks.adminReview.japaneseFingerprint)
    || !/^[0-9a-f]{64}$/.test(checks.adminReview.englishFingerprint))) {
    throw new StoreValidationError("Admin publication review fingerprints are invalid.");
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new StoreValidationError("Publication content must be JSON serializable.");
  return serialized;
}

const fingerprint = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** Shared server-side content/fingerprint review. ADMIN review never writes OWNER confirmation into the draft. */
export function publicationManuscriptReview(
  content: Readonly<Record<string, unknown>>,
  publicTitle: string,
): ExperiencePublicationManuscriptReview {
  const japanese = content.ja;
  const english = englishPublicationManuscriptOf(publicTitle, content);
  // An empty or absent FAQ is excluded from both fingerprints (byte-identical to pre-FAQ manuscripts).
  const japaneseFingerprint = validPublicationLocaleManuscript(japanese) ? publicationManuscriptFingerprint(japanese) : null;
  const englishFingerprint = validPublicationLocaleManuscript(english) ? publicationManuscriptFingerprint(english) : null;
  const translation = content.translation;
  const ownerConfirmed = japaneseFingerprint !== null && englishFingerprint !== null
    && isJsonRecord(translation)
    && translation.sourceFingerprint === japaneseFingerprint
    && translation.confirmedSourceFingerprint === japaneseFingerprint
    && translation.confirmedEnglishFingerprint === englishFingerprint;
  const reviewableContent = japaneseFingerprint !== null && englishFingerprint !== null
    ? {
      ...content,
      translation: {
        sourceFingerprint: japaneseFingerprint,
        confirmedSourceFingerprint: japaneseFingerprint,
        confirmedEnglishFingerprint: englishFingerprint,
      },
    }
    : content;
  return {
    // This temporary projection validates the allowlisted public fields without
    // persisting or asserting OWNER confirmation for an Admin-authored review.
    publicContentReady: projectPublicExperiencePublicationManuscript(reviewableContent as Readonly<Record<string, JsonValue>>) !== null
      && japaneseFingerprint !== null && englishFingerprint !== null,
    ownerConfirmed,
    contentFingerprint: fingerprint(content),
    japaneseFingerprint,
    englishFingerprint,
  };
}

function validateAdminDraftActor(actor: PublicationAdminDraftActor): void {
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
}

async function adminDraftSeller(client: PoolClient, providerId: string): Promise<ExperienceHostSellerProfile> {
  assertStoreIdentifier(providerId, "providerId");
  const result = await client.query<DbRow>(
    `SELECT provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,
            stripe_connect_account_ref,seller_display_name
       FROM experience_host_seller_profiles WHERE provider_id=$1 FOR SHARE`,
    [providerId],
  );
  const row = result.rows[0];
  if (!row) throw new StoreNotFoundError("seller workspace");
  return {
    providerId: String(row.provider_id), legacyProviderId: row.legacy_provider_id === null ? null : String(row.legacy_provider_id),
    providerDisplayName: String(row.provider_display_name), sellerNihoAccountRef: String(row.seller_niho_account_ref),
    stripeConnectAccountRef: String(row.stripe_connect_account_ref), sellerDisplayName: String(row.seller_display_name),
  };
}

async function requireNeverPublishedAdminDraft(
  client: PoolClient,
  providerId: string,
  productId: string,
  lock: "" | " FOR SHARE" | " FOR UPDATE" = "",
): Promise<ProductRecord> {
  assertStoreIdentifier(providerId, "providerId");
  assertStoreIdentifier(productId, "productId");
  const result = await client.query<DbRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM experience_products p
      WHERE p.provider_id=$1 AND p.id=$2 AND p.status='DRAFT'
        AND EXISTS (
          SELECT 1 FROM admin_product_draft_audit_events draft_audit
           WHERE draft_audit.provider_id=p.provider_id AND draft_audit.product_id=p.id
             AND draft_audit.action='DRAFT_CREATED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM experience_product_publications publication
           WHERE publication.provider_id=p.provider_id AND publication.product_id=p.id
        )${lock}`,
    [providerId, productId],
  );
  if (!result.rows[0]) throw new StoreAccessDeniedError();
  return productFromRow(result.rows[0]);
}

async function adminPhotosReady(client: PoolClient, providerId: string, productId: string): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT COUNT(*) > 0
            AND bool_and(asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
              AND btrim(selection.alt_text)<>'' AND btrim(selection.alt_text_ja)<>'') AS ready
       FROM experience_product_media_selection selection
       JOIN experience_product_media_assets asset
         ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
      WHERE selection.provider_id=$1 AND selection.product_id=$2 AND selection.placement='GALLERY'`,
    [providerId, productId],
  );
  return result.rows[0]?.ready === true;
}

async function matchingAdminEnglishReview(
  client: PoolClient,
  actor: PublicationAdminDraftActor,
  product: ProductRecord,
): Promise<{ readonly reviewedAtUtc: string; readonly contentFingerprint: string; readonly japaneseFingerprint: string; readonly englishFingerprint: string } | null> {
  const review = publicationManuscriptReview(product.content, product.publicTitle);
  if (!review.publicContentReady || !review.japaneseFingerprint || !review.englishFingerprint) return null;
  const result = await client.query<DbRow>(
    `SELECT reviewed_at,content_fingerprint,japanese_fingerprint,english_fingerprint
       FROM admin_product_english_reviews
      WHERE provider_id=$1 AND product_id=$2 AND draft_version=$3 AND actor_niho_user_id=$4
        AND content_fingerprint=$5 AND japanese_fingerprint=$6 AND english_fingerprint=$7
      ORDER BY reviewed_at DESC,id DESC LIMIT 1`,
    [product.providerId, product.id, product.version, actor.nihoUserId,
      review.contentFingerprint, review.japaneseFingerprint, review.englishFingerprint],
  );
  return result.rows[0] ? {
    reviewedAtUtc: iso(result.rows[0].reviewed_at, "reviewed_at"),
    contentFingerprint: String(result.rows[0].content_fingerprint),
    japaneseFingerprint: String(result.rows[0].japanese_fingerprint),
    englishFingerprint: String(result.rows[0].english_fingerprint),
  } : null;
}

async function auditAdminDraft(
  client: PoolClient,
  actor: PublicationAdminDraftActor,
  providerId: string,
  productId: string,
  action: "DRAFT_CREATED" | "DRAFT_SAVED" | "SALE_TERMS_SAVED" | "MEDIA_ADDED" | "MEDIA_SELECTION_SAVED",
  metadata: Readonly<Record<string, JsonValue>> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO admin_product_draft_audit_events
       (actor_niho_user_id,provider_id,product_id,action,metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [actor.nihoUserId, providerId, productId, action, JSON.stringify(metadata)],
  );
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
  if (input.unitAmount !== 0 && input.unitAmount < GUEST_BOOKING_LIMITS.minimumChargeYen) {
    throw new StoreValidationError(`product.unitAmount must be 0 or at least ${GUEST_BOOKING_LIMITS.minimumChargeYen}.`);
  }
  assertNonEmptyText(input.cancellationTermsRef, "product.cancellationTermsRef", 512);
  if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) {
    throw new StoreValidationError("product.content must be a JSON object.");
  }
  try { JSON.stringify(input.content); }
  catch (error) { throw new StoreValidationError("product.content must be JSON serializable.", { cause: error }); }
  // FAQ is optional, but a written FAQ must be complete: nothing is dropped silently.
  const faqIssue = input.content.faq === undefined ? null : publicationFaqIssue(input.content.faq);
  if (faqIssue) throw new StoreValidationError(`product.content.${faqIssue}`);
  const japanese = input.content.ja;
  const japaneseFaqIssue = isJsonRecord(japanese) && japanese.faq !== undefined ? publicationFaqIssue(japanese.faq) : null;
  if (japaneseFaqIssue) throw new StoreValidationError(`product.content.ja.${japaneseFaqIssue}`);
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

async function lockedState(client: PoolClient, providerId: string, productId: string, lock = true): Promise<ExperiencePublicationState | null> {
  const result = await client.query<DbRow>(
    `SELECT provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
            operations_suspension_code,owner_resume_required,first_published_at,version,updated_at
       FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2${lock ? " FOR UPDATE" : ""}`,
    [providerId, productId],
  );
  return result.rows[0] ? stateFromRow(result.rows[0]) : null;
}

/**
 * Tells the product's OWNER and operators that operations stopped or cleared its listing (#109), in the transaction that
 * changed the state. The title is the current publication's (what the public saw), else the draft's.
 */
async function notifyListingSuspension(client: PoolClient, row: DbRow, change: ListingSuspensionChange): Promise<void> {
  const state = stateFromRow(row);
  const titled = await client.query<{ title: string | null }>(
    `SELECT COALESCE(pub.public_title, p.public_title) AS title
       FROM experience_products p
       LEFT JOIN experience_product_publications pub ON pub.id=$3 AND pub.provider_id=p.provider_id AND pub.product_id=p.id
      WHERE p.provider_id=$1 AND p.id=$2`,
    [state.providerId, state.productId, state.currentPublicationId],
  );
  await enqueueListingSuspensionNotification(client, {
    providerId: state.providerId,
    productId: state.productId,
    experienceTitle: titled.rows[0]?.title ?? null,
    change,
    stateVersion: state.version,
  });
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
  const manuscriptReview = publicationManuscriptReview(product.content, product.publicTitle);
  const matchesAdminReview = checks.adminReview !== undefined
    && manuscriptReview.publicContentReady
    && checks.adminReview.contentFingerprint === manuscriptReview.contentFingerprint
    && checks.adminReview.japaneseFingerprint === manuscriptReview.japaneseFingerprint
    && checks.adminReview.englishFingerprint === manuscriptReview.englishFingerprint;
  const projectionContent = matchesAdminReview
    ? {
      ...product.content,
      translation: {
        sourceFingerprint: checks.adminReview!.japaneseFingerprint,
        confirmedSourceFingerprint: checks.adminReview!.japaneseFingerprint,
        confirmedEnglishFingerprint: checks.adminReview!.englishFingerprint,
      },
    }
    : product.content;
  const manuscript = projectPublicExperiencePublicationManuscript(projectionContent);
  if (manuscript === null) result.push("PUBLIC_CONTENT_INVALID");
  const photoIndices = manuscript === null ? [] : [
    ...manuscript.content.timeline.flatMap((item) => item.photoIndex === null ? [] : [item.photoIndex]),
    ...(manuscript.meetingPoint?.exteriorPhotoIndex === null || manuscript.meetingPoint?.exteriorPhotoIndex === undefined
      ? [] : [manuscript.meetingPoint.exteriorPhotoIndex]),
  ];
  const media = await client.query<{ positions: number[] | null }>(
    `SELECT COALESCE(array_agg(asset.source_position ORDER BY selection.position),'{}'::integer[]) AS positions
       FROM experience_product_media_selection selection
       JOIN experience_product_media_assets asset
         ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
      WHERE selection.provider_id=$1 AND selection.product_id=$2 AND selection.placement='GALLERY'
        AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL`,
    [product.providerId, product.id],
  );
  const positions = new Set((media.rows[0]?.positions ?? []).map(Number));
  if (!checks.photosReady || positions.size === 0 || photoIndices.some((index) => !positions.has(index))) result.push("PHOTOS_REQUIRED");
  if (product.currency !== "JPY" || (product.unitAmount !== 0 && product.unitAmount < GUEST_BOOKING_LIMITS.minimumChargeYen)) result.push("PRICE_REQUIRED");
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
    "SELECT provider_id,support_consent_version,support_agreement_revision FROM provider_sale_settings WHERE provider_id=$1 FOR SHARE",
    [product.providerId],
  );
  if (!feeSettings.rows[0]) result.push("FEE_SETTINGS_REQUIRED");
  else if (feeSettings.rows[0].support_consent_version !== EXPERIENCE_SUPPORT_CONSENT_VERSION
    || feeSettings.rows[0].support_agreement_revision === null) result.push("SUPPORT_CONSENT_REQUIRED");
  if (facts.rows[0]?.sale_terms !== true || product.cancellationTermsRef.trim() === "") result.push("CANCELLATION_TERMS_REQUIRED");
  if (facts.rows[0]?.schedule !== true) result.push("SCHEDULE_REQUIRED");
  const terms = await readSaleTerms(client, product.providerId, product.id, true);
  if (terms !== null && !salePriceSetMatchesProduct(product.unitAmount, terms)) result.push("PRICE_REQUIRED");
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
  publisherKind: "OWNER" | "ADMIN_PROXY" = "OWNER",
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
        consent_version,published_by_niho_user_id,published_by_admin_niho_user_id,publisher_kind,sale_terms_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     RETURNING id`,
    [product.providerId, product.id, product.version, saleTermsVersion, product.slug, product.publicTitle,
      JSON.stringify(product.content), product.currency, product.unitAmount, product.cancellationTermsRef,
      product.sellerNihoAccountRef, product.stripeConnectAccountRef, product.sellerDisplayName, consentVersion,
      publisherKind === "OWNER" ? publishedBy : null,
      publisherKind === "ADMIN_PROXY" ? publishedBy : null,
      publisherKind, JSON.stringify(saleTermsSnapshot)],
  );
  const publicationId = safeInteger(inserted.rows[0]?.id, "publication id");
  const media = await client.query(
    `INSERT INTO experience_product_publication_media
       (publication_id,asset_id,provider_id,product_id,position,alt_text,alt_text_ja,public_credit,placement,source_position)
     SELECT $3,asset.id,asset.provider_id,asset.product_id,
            (row_number() OVER (ORDER BY CASE selection.placement WHEN 'GALLERY' THEN 0 WHEN 'PROVIDER_PHOTO' THEN 1 ELSE 2 END,selection.position)-1)::integer,
            selection.alt_text,selection.alt_text_ja,selection.public_credit,selection.placement,asset.source_position
       FROM experience_product_media_selection selection
       JOIN experience_product_media_assets asset
         ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
      WHERE selection.provider_id=$1 AND selection.product_id=$2 AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
      ORDER BY CASE selection.placement WHEN 'GALLERY' THEN 0 WHEN 'PROVIDER_PHOTO' THEN 1 ELSE 2 END,selection.position`,
    [product.providerId, product.id, publicationId],
  );
  if (media.rowCount === 0) throw new StoreConflictError("The publication has no rights-confirmed public media.");
  return publicationId;
}

/** The caller holds the provider inventory and product locks and has checked OWNER/Admin authority. */
async function selectUploadedGalleryMedia(client: PoolClient, providerId: string, productId: string, input: ExperienceHostMediaAssetInput): Promise<ExperienceHostMediaAsset> {
  const existing = await client.query<DbRow>(
    `SELECT id,source_position,width,height,byte_size,state FROM experience_product_media_assets
      WHERE provider_id=$1 AND product_id=$2 AND source_ref_hash=$3`,
    [providerId, productId, input.sourceRefHash],
  );
  let row = existing.rows[0];
  if (row) {
    if (row.state !== "READY") throw new StoreConflictError("The existing photo is not available for reuse.");
  } else {
    const position = Number((await client.query<{ position: number }>(
      `SELECT COALESCE(MAX(source_position)+1,0)::int AS position FROM experience_product_media_assets WHERE provider_id=$1 AND product_id=$2`,
      [providerId, productId],
    )).rows[0]?.position);
    if (!Number.isSafeInteger(position) || position < 0 || position > 999) throw new StoreValidationError("A product has reached its media upload limit.");
    row = (await client.query<DbRow>(
      `INSERT INTO experience_product_media_assets
         (id,provider_id,product_id,source_position,object_key,source_ref_hash,width,height,byte_size,alt_text,public_credit,rights_confirmed_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
       RETURNING id,source_position,width,height,byte_size`,
      [input.id, providerId, productId, position, input.objectKey, input.sourceRefHash, input.width, input.height, input.byteSize, input.altText, input.publicCredit],
    )).rows[0]!;
  }
  // A retry keeps its current gallery position. A removed photo is appended once using its existing object.
  const position = Number((await client.query<{ position: number }>(
    `SELECT COALESCE(
       (SELECT position FROM experience_product_media_selection WHERE provider_id=$1 AND product_id=$2 AND asset_id=$3::uuid AND placement='GALLERY'),
       (SELECT COALESCE(MAX(position)+1,0)::int FROM experience_product_media_selection WHERE provider_id=$1 AND product_id=$2 AND placement='GALLERY')
     )::int AS position`, [providerId, productId, row.id],
  )).rows[0]?.position);
  if (!Number.isSafeInteger(position) || position < 0 || position > 19) throw new StoreValidationError("A product has reached its gallery selection limit.");
  // Assets stay immutable; selection uses the existing INSERT/DELETE runtime grants.
  await client.query("DELETE FROM experience_product_media_selection WHERE provider_id=$1 AND product_id=$2 AND asset_id=$3::uuid", [providerId, productId, row.id]);
  await client.query(
    `INSERT INTO experience_product_media_selection
       (provider_id,product_id,asset_id,placement,position,alt_text,alt_text_ja,public_credit)
     VALUES ($1,$2,$3::uuid,'GALLERY',$4,$5,$6,$7)`,
    [providerId, productId, row.id, position, input.altText, input.altTextJa, input.publicCredit],
  );
  return { id: String(row.id), position, sourcePosition: safeInteger(row.source_position, "media source position"), placement: "GALLERY",
    width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"), byteSize: safeInteger(row.byte_size, "media byte_size"),
    altText: input.altText, altTextJa: input.altTextJa, publicCredit: input.publicCredit };
}

export class ExperiencePublicationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /** Operator-provisioned seller workspaces; payment and NIHO identity references never leave the store. */
  async listAdminDraftSellers(actor: PublicationAdminDraftActor): Promise<readonly ExperienceAdminDraftSeller[]> {
    validateAdminDraftActor(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT provider_id,provider_display_name,seller_display_name
         FROM experience_host_seller_profiles
        ORDER BY provider_display_name COLLATE "C",seller_display_name COLLATE "C",provider_id COLLATE "C"
        LIMIT 500`,
    );
    return result.rows.map((row) => ({
      providerId: String(row.provider_id),
      providerDisplayName: String(row.provider_display_name),
      sellerDisplayName: String(row.seller_display_name),
    }));
  }

  async listAdminDraftProducts(actor: PublicationAdminDraftActor, providerId: string): Promise<readonly ProductRecord[]> {
    validateAdminDraftActor(actor);
    assertStoreIdentifier(providerId, "providerId");
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      const result = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products p
          WHERE p.provider_id=$1 AND p.status='DRAFT'
            AND EXISTS (
              SELECT 1 FROM admin_product_draft_audit_events draft_audit
               WHERE draft_audit.provider_id=p.provider_id AND draft_audit.product_id=p.id
                 AND draft_audit.action='DRAFT_CREATED'
            )
            AND NOT EXISTS (
              SELECT 1 FROM experience_product_publications publication
               WHERE publication.provider_id=p.provider_id AND publication.product_id=p.id
            )
          ORDER BY p.created_at DESC,p.id COLLATE "C" LIMIT 500`,
        [providerId],
      );
      return result.rows.map(productFromRow);
    });
  }

  async getAdminDraftProduct(actor: PublicationAdminDraftActor, providerId: string, productId: string): Promise<ProductRecord> {
    validateAdminDraftActor(actor);
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      return requireNeverPublishedAdminDraft(client, providerId, productId);
    });
  }

  async getAdminDraftPublicationStatus(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    consentVersion: string,
  ): Promise<ExperienceAdminPublicationStatus> {
    validateAdminDraftActor(actor);
    assertNonEmptyText(consentVersion, "consentVersion", 160);
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId);
      const manuscript = publicationManuscriptReview(product.content, product.publicTitle);
      const [state, terms, photosReady, review] = await Promise.all([
        lockedState(client, providerId, productId, false),
        readSaleTerms(client, providerId, productId),
        adminPhotosReady(client, providerId, productId),
        matchingAdminEnglishReview(client, actor, product),
      ]);
      return {
        draftVersion: product.version,
        stateVersion: state?.version ?? null,
        saleTermsVersion: terms?.version ?? null,
        blockers: await blockers(client, product, {
          manuscriptReady: review !== null,
          photosReady,
          ...(review ? { adminReview: {
            contentFingerprint: review.contentFingerprint,
            japaneseFingerprint: review.japaneseFingerprint,
            englishFingerprint: review.englishFingerprint,
          } } : {}),
        }, consentVersion, state),
        englishReview: {
          reviewed: review !== null,
          reviewedAtUtc: review?.reviewedAtUtc ?? null,
          contentFingerprint: manuscript.contentFingerprint,
          japaneseFingerprint: manuscript.japaneseFingerprint,
          englishFingerprint: manuscript.englishFingerprint,
        },
      };
    });
  }

  async reviewAdminDraftEnglish(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    expectedDraftVersion: number,
  ): Promise<ExperienceAdminEnglishReview> {
    validateAdminDraftActor(actor);
    validateExpectedVersion(expectedDraftVersion, "expectedDraftVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${providerId}:${productId}`]);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId, " FOR UPDATE");
      if (product.version !== expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      const review = publicationManuscriptReview(product.content, product.publicTitle);
      const reviewBlockers: ExperiencePublicationBlocker[] = [];
      if (!review.publicContentReady) reviewBlockers.push("PUBLIC_CONTENT_INVALID");
      if (!review.japaneseFingerprint || !review.englishFingerprint) reviewBlockers.push("MANUSCRIPT_REQUIRED");
      if (reviewBlockers.length > 0) throw new ExperiencePublicationBlockedError([...new Set(reviewBlockers)]);
      await client.query(
        `INSERT INTO admin_product_english_reviews
           (actor_niho_user_id,provider_id,product_id,draft_version,content_fingerprint,japanese_fingerprint,english_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [actor.nihoUserId, providerId, productId, product.version,
          review.contentFingerprint, review.japaneseFingerprint, review.englishFingerprint],
      );
      const matched = await matchingAdminEnglishReview(client, actor, product);
      if (!matched) throw new StoreConflictError("The reviewed manuscript changed before confirmation.");
      return {
        reviewed: true,
        reviewedAtUtc: matched.reviewedAtUtc,
        contentFingerprint: matched.contentFingerprint,
        japaneseFingerprint: matched.japaneseFingerprint,
        englishFingerprint: matched.englishFingerprint,
      };
    });
  }

  async publishAdminDraft(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    input: {
      readonly expectedDraftVersion: number;
      readonly expectedStateVersion: number | null;
      readonly expectedSaleTermsVersion: number | null;
      readonly consentVersion: string;
      readonly accepted: true;
      readonly sellerConfirmationMethod: AdminSellerConfirmationMethod;
      readonly photoRightsConfirmed: true;
    },
  ): Promise<ExperiencePublicationState> {
    validateAdminDraftActor(actor);
    validateExpectedVersion(input.expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(input.expectedStateVersion, "expectedStateVersion");
    validateExpectedVersion(input.expectedSaleTermsVersion, "expectedSaleTermsVersion");
    assertNonEmptyText(input.consentVersion, "consentVersion", 160);
    if (input.accepted !== true || input.photoRightsConfirmed !== true
      || (input.sellerConfirmationMethod !== "VERBAL" && input.sellerConfirmationMethod !== "WRITTEN")) {
      throw new StoreValidationError("Admin proxy publication confirmation is invalid.");
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${providerId}:${productId}`]);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId, " FOR UPDATE");
      if (product.version !== input.expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      await lockPublicationSlugs(client, [product.slug]);
      const state = await lockedState(client, providerId, productId);
      if ((state?.version ?? null) !== input.expectedStateVersion) throw new StoreConflictError("Publication state version mismatch: read the state again.");
      const terms = await readSaleTerms(client, providerId, productId, true);
      if ((terms?.version ?? null) !== input.expectedSaleTermsVersion) throw new StoreConflictError("Sale terms version mismatch: read the terms again.");
      const review = await matchingAdminEnglishReview(client, actor, product);
      const photosReady = await adminPhotosReady(client, providerId, productId);
      const blocked = await blockers(client, product, {
        manuscriptReady: review !== null,
        photosReady,
        ...(review ? { adminReview: {
          contentFingerprint: review.contentFingerprint,
          japaneseFingerprint: review.japaneseFingerprint,
          englishFingerprint: review.englishFingerprint,
        } } : {}),
      }, input.consentVersion, state);
      if (blocked.length > 0) throw new ExperiencePublicationBlockedError(blocked);
      if (!review || !terms) throw new StoreConflictError("Publication review or sale terms changed while publishing.");
      const changed = await client.query(
        "UPDATE experience_products SET status='PUBLISHED' WHERE provider_id=$1 AND id=$2 AND version=$3 AND status='DRAFT'",
        [providerId, productId, product.version],
      );
      if (changed.rowCount !== 1) throw new StoreConflictError("Product changed while publishing.");
      const publicationId = await insertOrFindPublication(client, product, input.consentVersion, actor.nihoUserId, "ADMIN_PROXY");
      const published = state === null
        ? await client.query<DbRow>(
          `INSERT INTO experience_product_publication_states
             (provider_id,product_id,current_publication_id,first_published_at)
           SELECT $1,$2,$3,published_at FROM experience_product_publications WHERE id=$3
           RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
             operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
          [providerId, productId, publicationId],
        )
        : await client.query<DbRow>(
          `UPDATE experience_product_publication_states
              SET current_publication_id=$3,self_stopped_at=NULL,owner_resume_required=false,
                  first_published_at=(SELECT published_at FROM experience_product_publications WHERE id=$3),
                  version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND product_id=$2 AND version=$4 AND current_publication_id IS NULL
              AND first_published_at IS NULL AND operations_suspended_at IS NULL
            RETURNING provider_id,product_id,current_publication_id,self_stopped_at,operations_suspended_at,
              operations_suspension_code,owner_resume_required,first_published_at,version,updated_at`,
          [providerId, productId, publicationId, state.version],
        );
      if (!published.rows[0]) throw new StoreConflictError("Publication state changed while publishing.");
      await client.query(
        `INSERT INTO admin_proxy_publication_audit_events
           (publication_id,provider_id,product_id,draft_version,sale_terms_version,consent_version,
            actor_niho_user_id,seller_confirmation_method,seller_confirmation_checked,photo_rights_confirmed,
            content_fingerprint,japanese_fingerprint,english_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [publicationId, providerId, productId, product.version, terms.version, input.consentVersion,
          actor.nihoUserId, input.sellerConfirmationMethod, input.accepted, input.photoRightsConfirmed,
          review.contentFingerprint, review.japaneseFingerprint, review.englishFingerprint],
      );
      return stateFromRow(published.rows[0]);
    });
  }

  async listAdminDraftSaleOffers(actor: PublicationAdminDraftActor, providerId: string, productId: string): Promise<readonly ExperienceHostSaleOffer[]> {
    validateAdminDraftActor(actor);
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      await requireNeverPublishedAdminDraft(client, providerId, productId);
      const today = tokyoDate(await databaseNow(client));
      return (await activeRules(client, providerId, productId, today)).map(({ rule }) => ({
        id: rule.id, localStartTime: rule.localStartTime, durationMinutes: rule.durationMinutes,
        capacity: rule.capacity, recurrence: rule.recurrence,
      }));
    });
  }

  async getAdminDraftSaleTerms(actor: PublicationAdminDraftActor, providerId: string, productId: string): Promise<ExperienceHostSaleTermsState> {
    validateAdminDraftActor(actor);
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId);
      const terms = await readSaleTerms(client, providerId, productId);
      return { draftVersion: product.version, stateVersion: null, saleTerms: terms ? hostSaleTerms(terms) : null };
    });
  }

  async listAdminDraftMedia(actor: PublicationAdminDraftActor, providerId: string, productId: string): Promise<readonly ExperienceHostMediaAsset[]> {
    validateAdminDraftActor(actor);
    return withTransaction(this.#pool, async (client) => {
      await adminDraftSeller(client, providerId);
      await requireNeverPublishedAdminDraft(client, providerId, productId);
      const result = await client.query<DbRow>(
        `SELECT asset.id,asset.source_position,selection.position,selection.placement,asset.width,asset.height,asset.byte_size,
                selection.alt_text,selection.alt_text_ja,selection.public_credit
           FROM experience_product_media_selection selection
           JOIN experience_product_media_assets asset
             ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
          WHERE selection.provider_id=$1 AND selection.product_id=$2 AND asset.state='READY'
          ORDER BY selection.position`,
        [providerId, productId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), position: safeInteger(row.position, "media position"),
        sourcePosition: safeInteger(row.source_position, "media source position"), placement: "GALLERY" as const,
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text),
        altTextJa: String(row.alt_text_ja), publicCredit: row.public_credit === null ? null : String(row.public_credit),
      }));
    });
  }

  async createDraftAsAdmin(
    actor: PublicationAdminDraftActor,
    providerId: string,
    rawInput: ExperiencePublicationDraftCreateInput,
  ): Promise<ProductRecord> {
    validateAdminDraftActor(actor);
    const id = randomUUID();
    const input = validateDraft({ ...rawInput, id, cancellationTermsRef: randomUUID() });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const seller = await adminDraftSeller(client, providerId);
      const result = await client.query<DbRow>(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$3,'DRAFT',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING RETURNING ${PRODUCT_COLUMNS}`,
        [providerId, id, input.slug, input.publicTitle, JSON.stringify(input.content), input.currency,
          input.unitAmount, input.cancellationTermsRef, seller.sellerNihoAccountRef,
          seller.stripeConnectAccountRef, seller.sellerDisplayName],
      );
      if (!result.rows[0]) throw new StoreConflictError("A product with this slug already exists for the seller.");
      await auditAdminDraft(client, actor, providerId, id, "DRAFT_CREATED");
      return productFromRow(result.rows[0]);
    });
  }

  async saveDraftAsAdmin(
    actor: PublicationAdminDraftActor,
    providerId: string,
    rawInput: ExperiencePublicationDraftInput,
    expectedDraftVersion: number,
  ): Promise<ProductRecord> {
    validateAdminDraftActor(actor);
    const input = validateDraft(rawInput);
    validateExpectedVersion(expectedDraftVersion, "expectedDraftVersion");
    if (input.id === "" || expectedDraftVersion === null) throw new StoreValidationError("expectedDraftVersion is required.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      const current = await requireNeverPublishedAdminDraft(client, providerId, input.id, " FOR UPDATE");
      if (current.version !== expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      await lockPublicationSlugs(client, [current.slug, input.slug]);
      const updated = await client.query<DbRow>(
        `UPDATE experience_products
            SET slug=$3,public_title=$4,content=$5::jsonb,currency=$6,unit_amount=$7,
                cancellation_terms_ref=$8,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$9 AND status='DRAFT'
          RETURNING ${PRODUCT_COLUMNS}`,
        [providerId, input.id, input.slug, input.publicTitle, JSON.stringify(input.content), input.currency,
          input.unitAmount, input.cancellationTermsRef, expectedDraftVersion],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Product version mismatch: read the draft again.");
      await auditAdminDraft(client, actor, providerId, input.id, "DRAFT_SAVED");
      return productFromRow(updated.rows[0]);
    });
  }

  async saveSaleTermsAsAdmin(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    input: Pick<ExperienceHostSaleTermsSaveInput, "expectedDraftVersion" | "expectedSaleTermsVersion" | "saleTerms">,
  ): Promise<ExperienceHostSaleTerms> {
    validateAdminDraftActor(actor);
    const terms = validSaleTerms(input.saleTerms);
    validateExpectedVersion(input.expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(input.expectedSaleTermsVersion, "expectedSaleTermsVersion");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId, " FOR UPDATE");
      if (product.version !== input.expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      if (!salePriceSetMatchesProduct(product.unitAmount, terms)) {
        throw new StoreValidationError("A free product must price every offer and child at ¥0; paid offers must meet Stripe's minimum charge.");
      }
      const fingerprint = questionsFingerprint(terms.bookingQuestions);
      const child = terms.childPricing;
      const values = [providerId, productId, child?.priceYen ?? null, child?.minAge ?? null, child?.maxAge ?? null,
        child?.adultRequired ?? null, terms.minimumParticipants, terms.minimumChargeableParticipants, terms.maxPartySize,
        terms.cancellationPolicy, terms.cancellationWindowMinutesBeforeStart, terms.cancellationRefundBasisPoints,
        terms.minimumAttendance, JSON.stringify(terms.bookingQuestions), fingerprint, terms.conditionsVersion];
      const saved = input.expectedSaleTermsVersion === null
        ? await client.query<DbRow>(
          `INSERT INTO experience_product_sale_terms (
             provider_id,product_id,child_price_amount,child_min_age,child_max_age,child_adult_required,
             minimum_participants,minimum_chargeable_participants,max_party_size,cancellation_policy,
             cancellation_window_minutes_before_start,cancellation_refund_basis_points,minimum_attendance,
             booking_questions,booking_questions_fingerprint,conditions_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
           ON CONFLICT DO NOTHING RETURNING ${SALE_TERMS_COLUMNS}`,
          values,
        )
        : await client.query<DbRow>(
          `UPDATE experience_product_sale_terms
              SET child_price_amount=$3,child_min_age=$4,child_max_age=$5,child_adult_required=$6,
                  minimum_participants=$7,minimum_chargeable_participants=$8,max_party_size=$9,cancellation_policy=$10,
                  cancellation_window_minutes_before_start=$11,cancellation_refund_basis_points=$12,
                  minimum_attendance=$13,booking_questions=$14::jsonb,booking_questions_fingerprint=$15,
                  conditions_version=$16,version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND product_id=$2 AND version=$17 RETURNING ${SALE_TERMS_COLUMNS}`,
          [...values, input.expectedSaleTermsVersion],
        );
      if (!saved.rows[0]) throw new StoreConflictError("Sale terms version mismatch: read the draft again.");
      await writeOfferPrices(client, providerId, productId, terms.offerPrices, Number(saved.rows[0].version));
      const written = await readSaleTerms(client, providerId, productId);
      if (!written) throw new StoreConflictError("Sale terms disappeared while saving.");
      await auditAdminDraft(client, actor, providerId, productId, "SALE_TERMS_SAVED");
      return hostSaleTerms(written);
    });
  }

  async addMediaAsAdmin(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    input: ExperienceHostMediaAssetInput,
  ): Promise<ExperienceHostMediaAsset> {
    validateAdminDraftActor(actor);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) throw new StoreValidationError("media.id must be a UUID v4.");
    assertNonEmptyText(input.objectKey, "media.objectKey", 512);
    if (!/^[0-9a-f]{64}$/.test(input.sourceRefHash)) throw new StoreValidationError("media.sourceRefHash must be a SHA-256 digest.");
    if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 2400
      || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > 2400
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 10 * 1024 * 1024) {
      throw new StoreValidationError("media dimensions and size are invalid.");
    }
    if (typeof input.altText !== "string" || input.altText.trim().length === 0 || input.altText.length > 500
      || typeof input.altTextJa !== "string" || input.altTextJa.trim().length === 0 || input.altTextJa.length > 500
      || (input.publicCredit !== null && (typeof input.publicCredit !== "string" || input.publicCredit.trim().length === 0 || input.publicCredit.length > 300))) {
      throw new StoreValidationError("media metadata is invalid.");
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId, " FOR UPDATE");
      const asset = await selectUploadedGalleryMedia(client, providerId, productId, input);
      const bumped = await client.query(
        `UPDATE experience_products SET version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$3 AND status='DRAFT'`,
        [providerId, productId, product.version],
      );
      if (bumped.rowCount !== 1) throw new StoreConflictError("Product changed while adding media.");
      await auditAdminDraft(client, actor, providerId, productId, "MEDIA_ADDED", { assetId: asset.id });
      return asset;
    });
  }

  async saveMediaSelectionAsAdmin(
    actor: PublicationAdminDraftActor,
    providerId: string,
    productId: string,
    expectedProductVersion: number,
    items: readonly ExperienceHostMediaSelectionInput[],
  ): Promise<readonly ExperienceHostMediaAsset[]> {
    validateAdminDraftActor(actor);
    validateExpectedVersion(expectedProductVersion, "expectedProductVersion");
    if (!Array.isArray(items) || items.length > 20) throw new StoreValidationError("media selection is invalid.");
    const ids = new Set<string>();
    for (const item of items) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
        || ids.has(item.id) || typeof item.altText !== "string" || item.altText.trim().length === 0 || item.altText.length > 500
        || typeof item.altTextJa !== "string" || item.altTextJa.trim().length === 0 || item.altTextJa.length > 500
        || (item.publicCredit !== null && (typeof item.publicCredit !== "string" || item.publicCredit.trim().length === 0 || item.publicCredit.length > 300))) {
        throw new StoreValidationError("media selection item is invalid.");
      }
      ids.add(item.id);
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await adminDraftSeller(client, providerId);
      const product = await requireNeverPublishedAdminDraft(client, providerId, productId, " FOR UPDATE");
      if (product.version !== expectedProductVersion) throw new StoreConflictError("Product changed while saving media selection.");
      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM experience_product_media_assets
          WHERE provider_id=$1 AND product_id=$2 AND state='READY' AND rights_confirmed_at IS NOT NULL
            AND id=ANY($3::uuid[])`,
        [providerId, productId, [...ids]],
      );
      if (Number(existing.rows[0]?.count ?? 0) !== ids.size) throw new StoreConflictError("A selected media asset is no longer available.");
      await client.query("DELETE FROM experience_product_media_selection WHERE provider_id=$1 AND product_id=$2", [providerId, productId]);
      for (const [position, item] of items.entries()) {
        await client.query(
          `INSERT INTO experience_product_media_selection
             (provider_id,product_id,asset_id,placement,position,alt_text,alt_text_ja,public_credit)
           VALUES ($1,$2,$3::uuid,'GALLERY',$4,$5,$6,$7)`,
          [providerId, productId, item.id, position, item.altText, item.altTextJa, item.publicCredit],
        );
      }
      const bumped = await client.query(
        `UPDATE experience_products SET version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$3 AND status='DRAFT'`,
        [providerId, productId, expectedProductVersion],
      );
      if (bumped.rowCount !== 1) throw new StoreConflictError("Product changed while saving media selection.");
      await auditAdminDraft(client, actor, providerId, productId, "MEDIA_SELECTION_SAVED", { count: items.length });
      const result = await client.query<DbRow>(
        `SELECT asset.id,asset.source_position,selection.position,asset.width,asset.height,asset.byte_size,
                selection.alt_text,selection.alt_text_ja,selection.public_credit
           FROM experience_product_media_selection selection
           JOIN experience_product_media_assets asset
             ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
          WHERE selection.provider_id=$1 AND selection.product_id=$2 ORDER BY selection.position`,
        [providerId, productId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), position: safeInteger(row.position, "media position"),
        sourcePosition: safeInteger(row.source_position, "media source position"), placement: "GALLERY" as const,
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text),
        altTextJa: String(row.alt_text_ja), publicCredit: row.public_credit === null ? null : String(row.public_credit),
      }));
    });
  }

  /**
   * First-login owner binding for an operator-provisioned seller profile. The only identity input is the
   * currently verified NIHO account ID. A profile must already map that exact ID; this never uses a
   * legacy NIHO provider ID, a browser-selected provider, or an inferred ownerUserId.
   */
  async ensureMappedOwnerMembership(nihoUserId: string): Promise<
    | { readonly kind: "linked" | "already-owner" }
    | { readonly kind: "no-mapping" | "ambiguous" | "membership-conflict" }
  > {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 47))", [`experience-host-owner:${nihoUserId}`]);
      // A seller registered for Experience host accounts (no NIHO key) is never bound to a NIHO identity.
      const mapped = await client.query<DbRow>(
        `SELECT provider_id FROM experience_host_seller_profiles
          WHERE seller_niho_account_ref=$1 AND legacy_provider_id IS NOT NULL ORDER BY provider_id COLLATE "C" FOR SHARE`,
        [nihoUserId],
      );
      if (mapped.rows.length === 0) return { kind: "no-mapping" } as const;
      if (mapped.rows.length !== 1) return { kind: "ambiguous" } as const;
      const providerId = String(mapped.rows[0]!.provider_id);
      const existing = await client.query<DbRow>(
        `SELECT role,active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 FOR UPDATE`,
        [providerId, nihoUserId],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0]!;
        return row.role === "OWNER" && row.active === true
          ? { kind: "already-owner" } as const
          : { kind: "membership-conflict" } as const;
      }
      const owners = await client.query<DbRow>(
        `SELECT provider_id FROM provider_memberships
          WHERE niho_user_id=$1 AND active=true AND role='OWNER'
          ORDER BY provider_id COLLATE "C" FOR UPDATE`,
        [nihoUserId],
      );
      if (owners.rows.length > 0) return { kind: "ambiguous" } as const;
      await client.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
         VALUES ($1,$2,'OWNER',true)`,
        [providerId, nihoUserId],
      );
      return { kind: "linked" } as const;
    });
  }

  /**
   * Host choices come from current Experience membership, never a NIHO provider directory. The NIHO login lists sellers
   * mapped to NIHO only (a seller registered for Experience host accounts has no NIHO key to read Connect with).
   */
  async listHostProviders(nihoUserId: string): Promise<readonly ExperienceHostProviderMembership[]> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT p.provider_id,p.legacy_provider_id,p.provider_display_name,p.seller_niho_account_ref,
              p.stripe_connect_account_ref,p.seller_display_name,m.role
         FROM provider_memberships m
         JOIN experience_host_seller_profiles p ON p.provider_id=m.provider_id AND p.legacy_provider_id IS NOT NULL
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

  /**
   * Resolve exactly one current Experience OWNER and its explicit NIHO seller mapping (the NIHO login). A seller
   * registered for Experience host accounts has no NIHO key: setup-required here (see currentHostAccountSellerProfile).
   */
  async currentOwnerSellerProfile(nihoUserId: string): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "setup-required" }
    | { readonly kind: "ready"; readonly profile: NihoMappedSellerProfile }
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

  /**
   * The seller an Experience host account (ADR 0003) acts for: the one provider it is the active OWNER of, and that
   * provider's seller registered for host accounts (no NIHO key, a `sel_` seller reference). A provider without one, or
   * with a seller mapped to NIHO instead, is setup-required: Admin/ops register it. `hostAccountActive` is the account's
   * status as read here. Reads the experience DB only: no NIHO and no Stripe.
   */
  async currentHostAccountSellerProfile(hostAccountId: string): Promise<HostAccountSellerProfileResolution> {
    if (!isHostAccountId(hostAccountId)) throw new StoreValidationError("hostAccountId must be a host account ID.");
    const result = await this.#pool.query<DbRow>(
      `SELECT m.provider_id,a.status AS account_status,p.provider_id AS profile_provider_id,p.legacy_provider_id,
              p.provider_display_name,p.seller_niho_account_ref,p.stripe_connect_account_ref,p.seller_display_name
         FROM provider_memberships m
         JOIN host_accounts a ON a.id=m.niho_user_id
         LEFT JOIN experience_host_seller_profiles p ON p.provider_id=m.provider_id
        WHERE m.niho_user_id=$1 AND m.active=true AND m.role='OWNER'
        ORDER BY m.provider_id COLLATE "C"`,
      [hostAccountId],
    );
    if (result.rows.length === 0) return { kind: "none" };
    if (result.rows.length !== 1) return { kind: "ambiguous" };
    const row = result.rows[0]!;
    const providerId = String(row.provider_id);
    if (row.profile_provider_id === null || row.legacy_provider_id !== null || !isHostSellerRef(row.seller_niho_account_ref)) {
      return { kind: "setup-required", providerId };
    }
    return {
      kind: "ready",
      hostAccountActive: row.account_status === "ACTIVE",
      profile: {
        providerId,
        legacyProviderId: null,
        providerDisplayName: String(row.provider_display_name),
        sellerNihoAccountRef: String(row.seller_niho_account_ref),
        stripeConnectAccountRef: String(row.stripe_connect_account_ref),
        sellerDisplayName: String(row.seller_display_name),
      },
    };
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

  /** Current, non-expired rules only. Their ids are the public offer ids used by sale terms. */
  async listActiveSaleOffers(actor: HostActor, productId: string): Promise<readonly ExperienceHostSaleOffer[]> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query(
        "SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2",
        [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const today = tokyoDate(await databaseNow(client));
      return (await activeRules(client, actor.providerId, productId, today)).map(({ rule }) => ({
        id: rule.id,
        localStartTime: rule.localStartTime,
        durationMinutes: rule.durationMinutes,
        capacity: rule.capacity,
        recurrence: rule.recurrence,
      }));
    });
  }

  /** Re-evaluate the saved draft; the browser never claims that a prerequisite is ready. */
  async getPublicationBlockers(
    actor: HostActor,
    productId: string,
    checks: ExperiencePublicationContentChecks,
    consentVersion: string | null,
  ): Promise<readonly ExperiencePublicationBlocker[]> {
    assertStoreIdentifier(productId, "productId");
    validateChecks(checks);
    if (consentVersion !== null) assertNonEmptyText(consentVersion, "consentVersion", 160);
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const productResult = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products p WHERE p.provider_id=$1 AND p.id=$2 FOR SHARE`,
        [actor.providerId, productId],
      );
      if (!productResult.rows[0]) throw new StoreNotFoundError("product");
      const state = await lockedState(client, actor.providerId, productId);
      return blockers(client, productFromRow(productResult.rows[0]), checks, consentVersion, state);
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
      // A host account's payout consent (ADR 0003) is read before Stripe answers, and may be withdrawn meanwhile. A
      // withdrawal takes this inventory lock first, so under it the claim is checked again: a consent read before a
      // withdrawal is written as no consent, never back as a valid one.
      let consent = { accepted: input.paymentReuseConsentAccepted, version: input.paymentReuseConsentVersion, at: input.paymentReuseConsentedAtUtc };
      if (consent.accepted && isHostAccountId(membership.nihoUserId)) {
        const counts = consent.version !== null && consent.at !== null && await payoutConsentStillCounts(client, {
          providerId: actor.providerId,
          stripeConnectAccountRef: input.stripeConnectAccountRef,
          consentVersion: consent.version,
          consentedAtUtc: consent.at,
        });
        if (!counts) consent = { accepted: false, version: null, at: null };
      }
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
          consent.accepted, consent.version, consent.at,
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
        `SELECT asset.id,asset.source_position,selection.position,selection.placement,asset.width,asset.height,asset.byte_size,
                selection.alt_text,selection.alt_text_ja,selection.public_credit
           FROM experience_product_media_selection selection
           JOIN experience_product_media_assets asset
             ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
          WHERE selection.provider_id=$1 AND selection.product_id=$2 AND asset.state='READY'
          ORDER BY CASE selection.placement WHEN 'GALLERY' THEN 0 WHEN 'PROVIDER_PHOTO' THEN 1 ELSE 2 END,selection.position`,
        [actor.providerId, productId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), position: safeInteger(row.position, "media position"),
        sourcePosition: safeInteger(row.source_position, "media source position"),
        placement: String(row.placement) as ExperienceHostMediaAsset["placement"],
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text), altTextJa: String(row.alt_text_ja),
        publicCredit: row.public_credit === null ? null : String(row.public_credit),
      }));
    });
  }

  async getProviderMedia(actor: HostActor): Promise<ExperienceHostProviderMedia> {
    assertStoreIdentifier(actor.providerId, "providerId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      await client.query("INSERT INTO experience_provider_media_state (provider_id) VALUES ($1) ON CONFLICT DO NOTHING", [actor.providerId]);
      return readProviderMedia(client, actor.providerId);
    });
  }

  async addProviderMedia(actor: HostActor, expectedVersion: number, input: ExperienceHostProviderMediaAssetInput): Promise<ExperienceHostProviderMedia> {
    assertStoreIdentifier(actor.providerId, "providerId");
    validateExpectedVersion(expectedVersion, "expectedVersion");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) throw new StoreValidationError("provider media.id must be a UUID v4.");
    assertNonEmptyText(input.objectKey, "provider media.objectKey", 512);
    if (!/^[0-9a-f]{64}$/.test(input.sourceRefHash)) throw new StoreValidationError("provider media.sourceRefHash must be a SHA-256 digest.");
    if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 2400
      || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > 2400
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 10 * 1024 * 1024) throw new StoreValidationError("provider media dimensions and size are invalid.");
    if (!["PROVIDER_PHOTO", "BUSINESS_LOGO"].includes(input.placement)) throw new StoreValidationError("provider media placement is invalid.");
    if (typeof input.altText !== "string" || input.altText.trim().length === 0 || input.altText.length > 500
      || typeof input.altTextJa !== "string" || input.altTextJa.trim().length === 0 || input.altTextJa.length > 500) throw new StoreValidationError("provider media alt text is invalid.");
    if (input.publicCredit !== null && (typeof input.publicCredit !== "string" || input.publicCredit.trim().length === 0 || input.publicCredit.length > 300)) throw new StoreValidationError("provider media credit is invalid.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      await client.query("INSERT INTO experience_provider_media_state (provider_id) VALUES ($1) ON CONFLICT DO NOTHING", [actor.providerId]);
      const state = await client.query<{ version: number }>("SELECT version FROM experience_provider_media_state WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      if (!state.rows[0] || Number(state.rows[0].version) !== expectedVersion) throw new StoreConflictError("Provider media version mismatch.");
      const old = await client.query<{ asset_id: string }>("SELECT asset_id FROM experience_provider_media_selection WHERE provider_id=$1 AND placement=$2 FOR UPDATE", [actor.providerId, input.placement]);
      await client.query("DELETE FROM experience_provider_media_selection WHERE provider_id=$1 AND placement=$2", [actor.providerId, input.placement]);
      if (old.rows[0]) await client.query("UPDATE experience_provider_media_assets SET state='REVOKED' WHERE provider_id=$1 AND id=$2::uuid", [actor.providerId, old.rows[0].asset_id]);
      await client.query(
        `INSERT INTO experience_provider_media_assets
           (id,provider_id,object_key,source_ref_hash,width,height,byte_size,rights_confirmed_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [input.id, actor.providerId, input.objectKey, input.sourceRefHash, input.width, input.height, input.byteSize],
      );
      await client.query(
        `INSERT INTO experience_provider_media_selection
           (provider_id,placement,asset_id,alt_text,alt_text_ja,public_credit)
         VALUES ($1,$2,$3::uuid,$4,$5,$6)`,
        [actor.providerId, input.placement, input.id, input.altText, input.altTextJa, input.publicCredit],
      );
      const bumped = await client.query("UPDATE experience_provider_media_state SET version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND version=$2", [actor.providerId, state.rows[0]!.version]);
      if (bumped.rowCount !== 1) throw new StoreConflictError("Provider media version mismatch.");
      return readProviderMedia(client, actor.providerId);
    });
  }

  async saveProviderMediaSelection(actor: HostActor, expectedVersion: number, items: readonly ExperienceHostProviderMediaSelectionInput[]): Promise<ExperienceHostProviderMedia> {
    assertStoreIdentifier(actor.providerId, "providerId");
    validateExpectedVersion(expectedVersion, "expectedVersion");
    if (!Array.isArray(items) || items.length > 2) throw new StoreValidationError("provider media selection is invalid.");
    const ids = new Set<string>();
    const placements = new Set<string>();
    for (const item of items) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
        || ids.has(item.id) || !["PROVIDER_PHOTO", "BUSINESS_LOGO"].includes(item.placement)
        || placements.has(item.placement) || typeof item.altText !== "string" || item.altText.trim().length === 0 || item.altText.length > 500
        || typeof item.altTextJa !== "string" || item.altTextJa.trim().length === 0 || item.altTextJa.length > 500
        || (item.publicCredit !== null && (typeof item.publicCredit !== "string" || item.publicCredit.trim().length === 0 || item.publicCredit.length > 300))) throw new StoreValidationError("provider media selection item is invalid.");
      ids.add(item.id); placements.add(item.placement);
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const state = await client.query<{ version: number }>("SELECT version FROM experience_provider_media_state WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      if (!state.rows[0] || Number(state.rows[0].version) !== expectedVersion) throw new StoreConflictError("Provider media version mismatch.");
      const selected = await client.query<{ asset_id: string; placement: string }>("SELECT asset_id,placement FROM experience_provider_media_selection WHERE provider_id=$1 ORDER BY placement FOR UPDATE", [actor.providerId]);
      if (selected.rowCount !== items.length || items.some((item) => !selected.rows.some((row) => String(row.asset_id) === item.id && String(row.placement) === item.placement))) throw new StoreConflictError("Provider media selection changed; use the explicit remove or replace operation.");
      for (const item of items) {
        const updated = await client.query(
        `UPDATE experience_provider_media_selection selection
            SET alt_text=$4,alt_text_ja=$5,public_credit=$6
           FROM experience_provider_media_assets asset
          WHERE selection.provider_id=$1 AND selection.placement=$2 AND selection.asset_id=$3::uuid
            AND asset.id=selection.asset_id AND asset.provider_id=selection.provider_id
            AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL`,
        [actor.providerId, item.placement, item.id, item.altText, item.altTextJa, item.publicCredit],
        );
        if (updated.rowCount !== 1) throw new StoreConflictError("Selected provider media is no longer available.");
      }
      const bumped = await client.query("UPDATE experience_provider_media_state SET version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND version=$2", [actor.providerId, expectedVersion]);
      if (bumped.rowCount !== 1) throw new StoreConflictError("Provider media version mismatch.");
      return readProviderMedia(client, actor.providerId);
    });
  }

  async revokeProviderMedia(actor: HostActor, assetId: string, expectedVersion: number): Promise<ExperienceHostProviderMedia> {
    assertStoreIdentifier(actor.providerId, "providerId");
    validateExpectedVersion(expectedVersion, "expectedVersion");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) throw new StoreNotFoundError("provider media");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const state = await client.query<{ version: number }>("SELECT version FROM experience_provider_media_state WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      if (!state.rows[0] || Number(state.rows[0].version) !== expectedVersion) throw new StoreConflictError("Provider media version mismatch.");
      const selected = await client.query("DELETE FROM experience_provider_media_selection WHERE provider_id=$1 AND asset_id=$2::uuid RETURNING asset_id", [actor.providerId, assetId]);
      if (selected.rowCount !== 1) throw new StoreNotFoundError("provider media");
      await client.query("UPDATE experience_provider_media_assets SET state='REVOKED' WHERE provider_id=$1 AND id=$2::uuid", [actor.providerId, assetId]);
      const bumped = await client.query("UPDATE experience_provider_media_state SET version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND version=$2", [actor.providerId, expectedVersion]);
      if (bumped.rowCount !== 1) throw new StoreConflictError("Provider media version mismatch.");
      return readProviderMedia(client, actor.providerId);
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
    if (typeof input.altText !== "string" || input.altText.trim().length === 0 || input.altText.length > 500) throw new StoreValidationError("media.altText is invalid.");
    if (typeof input.altTextJa !== "string" || input.altTextJa.trim().length === 0 || input.altTextJa.length > 500) throw new StoreValidationError("media.altTextJa is invalid.");
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
      const asset = await selectUploadedGalleryMedia(client, actor.providerId, productId, input);
      const versioned = await client.query(
        `UPDATE experience_products SET version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$3 RETURNING version`,
        [actor.providerId, productId, product.rows[0].version],
      );
      if (versioned.rowCount !== 1) throw new StoreConflictError("Product changed while adding media.");
      return asset;
    });
  }

  async saveMediaSelection(
    actor: HostActor,
    productId: string,
    expectedProductVersion: number,
    items: readonly ExperienceHostMediaSelectionInput[],
  ): Promise<readonly ExperienceHostMediaAsset[]> {
    assertStoreIdentifier(productId, "productId");
    validateExpectedVersion(expectedProductVersion, "expectedProductVersion");
    if (!Array.isArray(items) || items.length > 20) throw new StoreValidationError("media selection is invalid.");
    const ids = new Set<string>();
    for (const item of items) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
        || ids.has(item.id)
        || typeof item.altText !== "string" || item.altText.trim().length === 0 || item.altText.length > 500
        || typeof item.altTextJa !== "string" || item.altTextJa.trim().length === 0 || item.altTextJa.length > 500
        || (item.publicCredit !== null && (typeof item.publicCredit !== "string" || item.publicCredit.trim().length === 0 || item.publicCredit.length > 300))) {
        throw new StoreValidationError("media selection item is invalid.");
      }
      ids.add(item.id);
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query<{ version: number }>(
        "SELECT version FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE", [actor.providerId, productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      if (Number(product.rows[0].version) !== expectedProductVersion) throw new StoreConflictError("Product changed while saving media selection.");
      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM experience_product_media_assets
          WHERE provider_id=$1 AND product_id=$2 AND state='READY' AND rights_confirmed_at IS NOT NULL
            AND id=ANY($3::uuid[])`,
        [actor.providerId, productId, [...ids]],
      );
      if (Number(existing.rows[0]?.count ?? 0) !== ids.size) throw new StoreConflictError("A selected media asset is no longer available.");
      await client.query("DELETE FROM experience_product_media_selection WHERE provider_id=$1 AND product_id=$2", [actor.providerId, productId]);
      for (const [position, item] of items.entries()) {
        await client.query(
          `INSERT INTO experience_product_media_selection
             (provider_id,product_id,asset_id,placement,position,alt_text,alt_text_ja,public_credit)
           VALUES ($1,$2,$3::uuid,'GALLERY',$4,$5,$6,$7)`,
          [actor.providerId, productId, item.id, position, item.altText, item.altTextJa, item.publicCredit],
        );
      }
      const bumped = await client.query(
        `UPDATE experience_products SET version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$3 RETURNING version`,
        [actor.providerId, productId, expectedProductVersion],
      );
      if (bumped.rowCount !== 1) throw new StoreConflictError("Product changed while saving media selection.");
      const result = await client.query<DbRow>(
        `SELECT asset.id,asset.source_position,selection.position,selection.placement,asset.width,asset.height,asset.byte_size,
                selection.alt_text,selection.alt_text_ja,selection.public_credit
           FROM experience_product_media_selection selection
           JOIN experience_product_media_assets asset
             ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id AND asset.product_id=selection.product_id
          WHERE selection.provider_id=$1 AND selection.product_id=$2
          ORDER BY CASE selection.placement WHEN 'GALLERY' THEN 0 WHEN 'PROVIDER_PHOTO' THEN 1 ELSE 2 END,selection.position`,
        [actor.providerId, productId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), position: safeInteger(row.position, "media position"),
        sourcePosition: safeInteger(row.source_position, "media source position"),
        placement: String(row.placement) as ExperienceHostMediaAsset["placement"],
        width: safeInteger(row.width, "media width"), height: safeInteger(row.height, "media height"),
        byteSize: safeInteger(row.byte_size, "media byte_size"), altText: String(row.alt_text),
        altTextJa: String(row.alt_text_ja), publicCredit: row.public_credit === null ? null : String(row.public_credit),
      }));
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
      if (!salePriceSetMatchesProduct(product.unitAmount, terms)) {
        throw new StoreValidationError("A free product must price every offer and child at ¥0; paid offers must meet Stripe's minimum charge.");
      }
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
      // A second suspension of a suspended listing (another reason code) is not news to the host.
      const before = await client.query<{ suspended: boolean }>(
        "SELECT operations_suspended_at IS NOT NULL AS suspended FROM experience_product_publication_states WHERE provider_id=$1 AND product_id=$2",
        [providerId, productId],
      );
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
      if (before.rows[0]?.suspended !== true) await notifyListingSuspension(client, result.rows[0], "SUSPENDED");
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
      await notifyListingSuspension(client, result.rows[0], "CLEARED");
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

  async hasPendingPublicationChanges(actor: HostActor, productId: string): Promise<boolean> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR", "VIEWER"]);
      const result = await client.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM experience_product_publication_states state
             JOIN experience_products product ON product.provider_id=state.provider_id AND product.id=state.product_id
             JOIN experience_product_publications publication ON publication.id=state.current_publication_id
             LEFT JOIN experience_product_sale_terms terms ON terms.provider_id=product.provider_id AND terms.product_id=product.id
            WHERE state.provider_id=$1 AND state.product_id=$2
              AND (publication.draft_version<>product.version
                OR publication.sale_terms_version IS DISTINCT FROM terms.version)
         ) AS pending`,
        [actor.providerId, productId],
      );
      return result.rows[0]?.pending === true;
    });
  }

  /** The one source for catalog, detail, metadata, sitemap and new-checkout admission. */
  async getPublicBySlug(slug: string): Promise<PublicExperiencePublication | null> {
    assertNonEmptyText(slug, "slug", 160);
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT ${PUBLIC_READER_COLUMNS} FROM visible_publications WHERE slug=$1 ORDER BY publication_id DESC LIMIT 2`,
      [slug],
    );
    return result.rows.length === 1 ? projectPublicExperiencePublication(result.rows[0]!) : null;
  }

  /**
   * Internal route-selection guard: a mapped host seller's current or historical slug stays reserved after
   * stop, suspension, rename, or draft so a same-slug legacy NIHO page cannot become visible again.
   */
  async listClaimedSlugs(): Promise<readonly string[]> {
    const result = await this.#pool.query<{ slug: string }>(
      `WITH ${CLAIMED_PUBLICATION_SLUGS_CTE}
       SELECT slug FROM claimed_publication_slugs ORDER BY slug COLLATE "C"`,
    );
    return result.rows.map((row) => String(row.slug));
  }

  async claimsSlug(slug: string): Promise<boolean> {
    assertNonEmptyText(slug, "slug", 160);
    const result = await this.#pool.query(
      `WITH ${CLAIMED_PUBLICATION_SLUGS_CTE}
       SELECT 1 FROM claimed_publication_slugs WHERE slug=$1 LIMIT 1`,
      [slug],
    );
    return result.rows.length > 0;
  }

  async listPublic(): Promise<readonly PublicExperiencePublication[]> {
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
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
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
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

  /** A provider profile image is public only while an active product by that seller is published. */
  async getPublicProviderMediaAsset(assetId: string): Promise<PublicExperienceMediaAsset | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) return null;
    const result = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT asset.object_key,asset.byte_size
         FROM visible_publications publication
         JOIN experience_provider_media_selection selection ON selection.provider_id=publication.provider_id
         JOIN experience_provider_media_assets asset
           ON asset.id=selection.asset_id AND asset.provider_id=selection.provider_id
        WHERE asset.id=$1::uuid AND asset.state='READY' AND asset.rights_confirmed_at IS NOT NULL
        LIMIT 1`, [assetId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { objectKey: String(row.object_key), byteSize: safeInteger(row.byte_size, "provider media byte_size") };
  }
}

export type { PublicExperiencePublication } from "./experience-publication-projection.ts";
