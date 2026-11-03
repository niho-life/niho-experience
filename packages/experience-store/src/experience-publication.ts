import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import {
  projectPublicExperiencePublication,
  projectPublicExperiencePublicationManuscript,
  type PublicExperiencePublication,
} from "./experience-publication-projection.ts";
import { productFromRow, type DbRow } from "./rows.ts";
import { PRODUCT_COLUMNS, requireMembership } from "./repository.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor, JsonValue, ProductRecord } from "./types.ts";
import { assertCanonicalInstant, assertMoney, assertNonEmptyText, assertStoreIdentifier, normalizeCurrency } from "./validation.ts";

export type ExperiencePublicationBlocker =
  | "ACCOUNT_NOT_USABLE"
  | "CANCELLATION_TERMS_REQUIRED"
  | "CONNECT_NOT_READY"
  | "CONSENT_OUTDATED"
  | "MANUSCRIPT_REQUIRED"
  | "OPERATIONS_SUSPENDED"
  | "OWNER_NOT_CURRENT"
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

export interface ProviderPublicationReadinessInput {
  readonly accountUsable: boolean;
  readonly connectReady: boolean;
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

const PUBLICATION_COLUMNS = `
  p.id AS publication_id, p.slug, p.public_title, p.content, p.currency,
  p.unit_amount, p.seller_display_name, p.published_at, s.first_published_at`;

const PUBLIC_READER_COLUMNS = `
  slug, public_title, content, currency, unit_amount, seller_display_name, published_at`;

const VISIBLE_PUBLICATIONS = `
  WITH visible_publications AS (
    SELECT ${PUBLICATION_COLUMNS}
      FROM experience_product_publication_states s
      JOIN experience_product_publications p ON p.id=s.current_publication_id
      JOIN provider_publication_readiness r ON r.provider_id=s.provider_id
     WHERE s.self_stopped_at IS NULL
       AND s.operations_suspended_at IS NULL
       AND s.owner_resume_required=false
       AND r.account_usable=true
       AND r.connect_ready=true
       AND r.seller_display_ready=true
       AND r.observed_at <= clock_timestamp()
       AND r.valid_until > clock_timestamp()
       AND r.valid_until <= r.observed_at + interval '10 minutes'
       AND r.required_consent_version=p.consent_version
       AND r.seller_niho_account_ref=p.seller_niho_account_ref
       AND r.stripe_connect_account_ref=p.stripe_connect_account_ref
       AND r.seller_display_name=p.seller_display_name
       AND EXISTS (
         SELECT 1 FROM provider_memberships m
          WHERE m.provider_id=r.provider_id AND m.niho_user_id=r.owner_niho_user_id
            AND m.role='OWNER' AND m.active=true
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
  for (const value of [input.accountUsable, input.connectReady, input.sellerDisplayReady]) {
    if (typeof value !== "boolean") throw new StoreValidationError("Publication readiness flags must be booleans.");
  }
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
    `SELECT provider_id,owner_niho_user_id,account_usable,connect_ready,seller_display_ready,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
            required_consent_version,observed_at,valid_until,version,updated_at,
            observed_at <= clock_timestamp() AND valid_until > clock_timestamp()
              AND valid_until <= observed_at + interval '10 minutes' AS currently_valid
       FROM provider_publication_readiness WHERE provider_id=$1${lock ? " FOR SHARE" : ""}`,
    [providerId],
  );
  return result.rows[0] ?? null;
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
  if (!checks.photosReady) result.push("PHOTOS_REQUIRED");
  if (projectPublicExperiencePublicationManuscript(product.content) === null) result.push("PUBLIC_CONTENT_INVALID");
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
  if (facts.rows[0]?.sale_terms !== true || product.cancellationTermsRef.trim() === "") result.push("CANCELLATION_TERMS_REQUIRED");
  if (facts.rows[0]?.schedule !== true) result.push("SCHEDULE_REQUIRED");
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
  const previous = await client.query<DbRow>(
    `SELECT id FROM experience_product_publications
      WHERE provider_id=$1 AND product_id=$2 AND draft_version=$3 AND consent_version=$4`,
    [product.providerId, product.id, product.version, consentVersion],
  );
  if (previous.rows[0]) return safeInteger(previous.rows[0].id, "publication id");
  const inserted = await client.query<DbRow>(
    `INSERT INTO experience_product_publications
       (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,
        cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
        consent_version,published_by_niho_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [product.providerId, product.id, product.version, product.slug, product.publicTitle, JSON.stringify(product.content),
      product.currency, product.unitAmount, product.cancellationTermsRef, product.sellerNihoAccountRef,
      product.stripeConnectAccountRef, product.sellerDisplayName, consentVersion, publishedBy],
  );
  return safeInteger(inserted.rows[0]?.id, "publication id");
}

export class ExperiencePublicationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async recordReadiness(
    actor: HostActor,
    input: ProviderPublicationReadinessInput,
    expectedVersion: number | null,
  ): Promise<ProviderPublicationReadiness> {
    validateReadiness(input);
    validateExpectedVersion(expectedVersion, "expectedVersion");
    return withTransaction(this.#pool, async (client) => {
      const membership = await requireMembership(client, actor, ["OWNER"]);
      const values = [actor.providerId, membership.nihoUserId, input.accountUsable, input.connectReady,
        input.sellerDisplayReady, input.sellerNihoAccountRef, input.stripeConnectAccountRef,
        input.sellerDisplayName, input.requiredConsentVersion, input.observedAtUtc, input.validUntilUtc];
      const result = expectedVersion === null
        ? await client.query<DbRow>(
          `INSERT INTO provider_publication_readiness
             (provider_id,owner_niho_user_id,account_usable,connect_ready,seller_display_ready,
              seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
              required_consent_version,observed_at,valid_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz)
           ON CONFLICT DO NOTHING
           RETURNING provider_id,owner_niho_user_id,account_usable,connect_ready,seller_display_ready,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
             required_consent_version,observed_at,valid_until,version,updated_at`, values)
        : await client.query<DbRow>(
          `UPDATE provider_publication_readiness
              SET owner_niho_user_id=$2,account_usable=$3,connect_ready=$4,seller_display_ready=$5,
                  seller_niho_account_ref=$6,stripe_connect_account_ref=$7,seller_display_name=$8,
                  required_consent_version=$9,observed_at=$10::timestamptz,valid_until=$11::timestamptz,
                  version=version+1,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND version=$12
            RETURNING provider_id,owner_niho_user_id,account_usable,connect_ready,seller_display_ready,
              seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
              required_consent_version,observed_at,valid_until,version,updated_at`, [...values, expectedVersion]);
      if (!result.rows[0]) throw new StoreConflictError("Publication readiness version mismatch.");
      return readinessFromRow(result.rows[0]);
    });
  }

  async saveDraft(
    actor: HostActor,
    rawInput: ExperiencePublicationDraftInput,
    expectedVersion: number,
    checks: ExperiencePublicationContentChecks,
  ): Promise<{ readonly draft: ProductRecord; readonly publicationUpdated: boolean; readonly blockers: readonly ExperiencePublicationBlocker[] }> {
    const input = validateDraft(rawInput);
    validateChecks(checks);
    validateExpectedVersion(expectedVersion, "expectedVersion");
    if (expectedVersion === null) throw new StoreValidationError("expectedVersion must be a positive integer.");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${input.id}`]);
      const updated = await client.query<DbRow>(
        `UPDATE experience_products
            SET slug=$3,public_title=$4,content=$5::jsonb,currency=$6,unit_amount=$7,
                cancellation_terms_ref=$8,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2 AND version=$9
          RETURNING ${PRODUCT_COLUMNS}`,
        [actor.providerId, input.id, input.slug, input.publicTitle, JSON.stringify(input.content), input.currency,
          input.unitAmount, input.cancellationTermsRef, expectedVersion],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Product version mismatch or product not found in this provider.");
      const draft = productFromRow(updated.rows[0]);
      const state = await lockedState(client, actor.providerId, input.id);
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
      readonly consentVersion: string;
      readonly checks: ExperiencePublicationContentChecks;
    },
  ): Promise<ExperiencePublicationState> {
    assertStoreIdentifier(productId, "productId");
    validateExpectedVersion(input.expectedDraftVersion, "expectedDraftVersion");
    validateExpectedVersion(input.expectedStateVersion, "expectedStateVersion");
    assertNonEmptyText(input.consentVersion, "consentVersion", 160);
    validateChecks(input.checks);
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 8))", [`${actor.providerId}:${productId}`]);
      const productResult = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE`,
        [actor.providerId, productId],
      );
      if (!productResult.rows[0]) throw new StoreNotFoundError("product");
      const product = productFromRow(productResult.rows[0]);
      if (product.version !== input.expectedDraftVersion) throw new StoreConflictError("Product version mismatch: read the draft again.");
      const state = await lockedState(client, actor.providerId, productId);
      if ((state?.version ?? null) !== input.expectedStateVersion) throw new StoreConflictError("Publication state version mismatch: read the state again.");
      const blocked = await blockers(client, product, input.checks, input.consentVersion, state);
      if (blocked.length > 0) throw new ExperiencePublicationBlockedError(blocked);
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
    const result = await this.#pool.query<DbRow>(
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
    const result = await this.#pool.query<DbRow>(
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
       SELECT ${PUBLIC_READER_COLUMNS} FROM visible_publications v
        WHERE NOT EXISTS (
          SELECT 1 FROM visible_publications duplicate
           WHERE duplicate.slug=v.slug AND duplicate.publication_id<>v.publication_id
        )
        ORDER BY v.first_published_at DESC,v.publication_id DESC`,
    );
    return result.rows.flatMap((row) => {
      const publication = projectPublicExperiencePublication(row);
      return publication === null ? [] : [publication];
    });
  }
}

export type { PublicExperiencePublication } from "./experience-publication-projection.ts";
