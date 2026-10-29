import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertNonEmptyText, assertStoreIdentifier } from "./validation.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

export interface GuideAdminWriterGrant {
  readonly nihoUserId: string;
  readonly active: boolean;
  readonly sourceVersion: number;
  readonly sourceInvitationId?: string;
}

export interface PutGuideAdminWriterGrantInput {
  readonly active: boolean;
  readonly sourceVersion: number;
  readonly sourceInvitationId: string;
}

export interface GuideAdminCategory {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
  readonly active: boolean;
  readonly revision: number;
}

export interface PutGuideAdminCategoryInput {
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
  readonly active: boolean;
  readonly expectedRevision: number;
}

export type GuideAdminWriterPutResult =
  | { readonly status: "APPLIED" | "UNCHANGED"; readonly writer: GuideAdminWriterGrant }
  | { readonly status: "CONFLICT"; readonly reason: "SOURCE_VERSION" | "IDEMPOTENCY_KEY_REUSED" };

export type GuideAdminCategoryPutResult =
  | { readonly status: "APPLIED"; readonly category: GuideAdminCategory }
  | { readonly status: "CONFLICT"; readonly reason: "EXPECTED_REVISION" | "IDEMPOTENCY_KEY_REUSED" };

interface CommandIdentity {
  readonly idempotencyKey: string;
  readonly actorNihoUserId: string;
}

function stringValue(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function booleanValue(row: DbRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function integerValue(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function validateUuidV4(value: string, path: string): void {
  if (!UUID_V4.test(value)) throw new StoreValidationError(`${path} must be a UUID v4.`);
}

function validatePositiveSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_INTEGER) {
    throw new StoreValidationError(`${path} must be a positive safe integer.`);
  }
}

function validateExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new StoreValidationError("expectedRevision must be a non-negative safe integer.");
  }
}

function validateCategorySlug(value: string): void {
  if (!CATEGORY_SLUG.test(value) || value.length > 80) {
    throw new StoreValidationError("category slug must use 1-80 lower-case letters, digits, and single hyphens.");
  }
}

function validateCommand(command: CommandIdentity): void {
  validateUuidV4(command.idempotencyKey, "idempotencyKey");
  assertStoreIdentifier(command.actorNihoUserId, "actorNihoUserId");
}

function writerFromRow(row: DbRow): GuideAdminWriterGrant {
  const sourceInvitationId = row.source_invitation_id;
  if (sourceInvitationId !== null && typeof sourceInvitationId !== "string") {
    throw new StoreError("Database returned an invalid source_invitation_id.");
  }
  return {
    nihoUserId: stringValue(row, "niho_user_id"),
    active: booleanValue(row, "active"),
    sourceVersion: integerValue(row, "source_version"),
    ...(typeof sourceInvitationId === "string" ? { sourceInvitationId } : {}),
  };
}

function categoryFromRow(row: DbRow): GuideAdminCategory {
  return {
    slug: stringValue(row, "slug"),
    labelEn: stringValue(row, "label_en"),
    labelJa: stringValue(row, "label_ja"),
    displayOrder: integerValue(row, "display_order"),
    active: booleanValue(row, "active"),
    revision: integerValue(row, "revision"),
  };
}

function semanticHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function lockCommandKey(client: PoolClient, idempotencyKey: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`guide-admin-command:${idempotencyKey}`]);
}

async function lockTarget(client: PoolClient, targetKind: "WRITER" | "CATEGORY", targetId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`guide-admin-target:${targetKind}:${targetId}`]);
}

async function storedReceipt(client: PoolClient, idempotencyKey: string): Promise<DbRow | undefined> {
  const receipt = await client.query<DbRow>(
    `SELECT request_hash, result, created_at
       FROM guide_admin_command_receipts
      WHERE idempotency_key=$1::uuid`,
    [idempotencyKey],
  );
  return receipt.rows[0];
}

async function insertReceipt(
  client: PoolClient,
  input: CommandIdentity & {
    readonly requestHash: string;
    readonly targetKind: "WRITER" | "CATEGORY";
    readonly targetId: string;
    readonly action: "writer.put" | "category.put";
    readonly result: GuideAdminWriterPutResult | GuideAdminCategoryPutResult;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO guide_admin_command_receipts (
       idempotency_key, request_hash, actor_niho_user_id, target_kind, target_id, action, result
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.idempotencyKey,
      input.requestHash,
      input.actorNihoUserId,
      input.targetKind,
      input.targetId,
      input.action,
      JSON.stringify(input.result),
    ],
  );
}

function receiptResult(row: DbRow): unknown {
  // Reading the timestamp proves a receipt row has the expected committed shape without
  // returning audit metadata through the API.
  isoValue(row, "created_at");
  return row.result;
}

function parseWriterResult(value: unknown): GuideAdminWriterPutResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("Database returned an invalid writer command result.");
  const result = value as Record<string, unknown>;
  if (result.status === "CONFLICT" && (result.reason === "SOURCE_VERSION" || result.reason === "IDEMPOTENCY_KEY_REUSED")) {
    return { status: result.status, reason: result.reason };
  }
  if ((result.status === "APPLIED" || result.status === "UNCHANGED") && result.writer && typeof result.writer === "object" && !Array.isArray(result.writer)) {
    const writer = result.writer as Record<string, unknown>;
    const sourceInvitationId = writer.sourceInvitationId;
    if (
      typeof writer.nihoUserId === "string"
      && typeof writer.active === "boolean"
      && Number.isSafeInteger(writer.sourceVersion)
      && (sourceInvitationId === undefined || typeof sourceInvitationId === "string")
    ) {
      return {
        status: result.status,
        writer: {
          nihoUserId: writer.nihoUserId,
          active: writer.active,
          sourceVersion: writer.sourceVersion as number,
          ...(typeof sourceInvitationId === "string" ? { sourceInvitationId } : {}),
        },
      };
    }
  }
  throw new StoreError("Database returned an invalid writer command result.");
}

function parseCategoryResult(value: unknown): GuideAdminCategoryPutResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("Database returned an invalid category command result.");
  const result = value as Record<string, unknown>;
  if (result.status === "CONFLICT" && (result.reason === "EXPECTED_REVISION" || result.reason === "IDEMPOTENCY_KEY_REUSED")) {
    return { status: result.status, reason: result.reason };
  }
  if (result.status === "APPLIED" && result.category && typeof result.category === "object" && !Array.isArray(result.category)) {
    const category = result.category as Record<string, unknown>;
    if (
      typeof category.slug === "string"
      && typeof category.labelEn === "string"
      && typeof category.labelJa === "string"
      && Number.isSafeInteger(category.displayOrder)
      && typeof category.active === "boolean"
      && Number.isSafeInteger(category.revision)
    ) {
      return {
        status: "APPLIED",
        category: {
          slug: category.slug,
          labelEn: category.labelEn,
          labelJa: category.labelJa,
          displayOrder: category.displayOrder as number,
          active: category.active,
          revision: category.revision as number,
        },
      };
    }
  }
  throw new StoreError("Database returned an invalid category command result.");
}

export class GuideAdminRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getWriterGrant(nihoUserId: string): Promise<GuideAdminWriterGrant> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT niho_user_id, active, source_version, source_invitation_id::text
         FROM guide_writer_grants WHERE niho_user_id=$1`,
      [nihoUserId],
    );
    const row = result.rows[0];
    return row === undefined ? { nihoUserId, active: false, sourceVersion: 0 } : writerFromRow(row);
  }

  async putWriterGrant(
    command: CommandIdentity,
    nihoUserId: string,
    input: PutGuideAdminWriterGrantInput,
  ): Promise<GuideAdminWriterPutResult> {
    validateCommand(command);
    const normalizedCommand = { ...command, idempotencyKey: command.idempotencyKey.toLowerCase() };
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    if (typeof input.active !== "boolean") throw new StoreValidationError("active must be a boolean.");
    validatePositiveSafeInteger(input.sourceVersion, "sourceVersion");
    validateUuidV4(input.sourceInvitationId, "sourceInvitationId");
    const requestHash = semanticHash({
      route: "PUT /internal/guide-admin/v1/writers/{nihoUserId}",
      actorNihoUserId: normalizedCommand.actorNihoUserId,
      target: { nihoUserId },
      body: {
        active: input.active,
        sourceVersion: input.sourceVersion,
        sourceInvitationId: input.sourceInvitationId.toLowerCase(),
      },
    });

    return withTransaction(this.#pool, async (client) => {
      await lockCommandKey(client, normalizedCommand.idempotencyKey);
      const existingReceipt = await storedReceipt(client, normalizedCommand.idempotencyKey);
      if (existingReceipt !== undefined) {
        return stringValue(existingReceipt, "request_hash") === requestHash
          ? parseWriterResult(receiptResult(existingReceipt))
          : { status: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" };
      }

      await lockTarget(client, "WRITER", nihoUserId);
      const currentResult = await client.query<DbRow>(
        `SELECT niho_user_id, active, source_version, source_invitation_id::text
           FROM guide_writer_grants WHERE niho_user_id=$1 FOR UPDATE`,
        [nihoUserId],
      );
      const currentRow = currentResult.rows[0];
      let result: GuideAdminWriterPutResult;
      if (currentRow !== undefined && integerValue(currentRow, "source_version") > input.sourceVersion) {
        result = { status: "CONFLICT", reason: "SOURCE_VERSION" };
      } else if (currentRow !== undefined && integerValue(currentRow, "source_version") === input.sourceVersion) {
        const current = writerFromRow(currentRow);
        result = current.active === input.active && current.sourceInvitationId?.toLowerCase() === input.sourceInvitationId.toLowerCase()
          ? { status: "UNCHANGED", writer: current }
          : { status: "CONFLICT", reason: "SOURCE_VERSION" };
      } else {
        const updated = await client.query<DbRow>(
          `INSERT INTO guide_writer_grants (
             niho_user_id, granted_by_niho_user_id, active, source_version, source_invitation_id
           ) VALUES ($1,$2,$3,$4,$5::uuid)
           ON CONFLICT (niho_user_id) DO UPDATE
             SET granted_by_niho_user_id=EXCLUDED.granted_by_niho_user_id,
                 active=EXCLUDED.active,
                 source_version=EXCLUDED.source_version,
                 source_invitation_id=EXCLUDED.source_invitation_id,
                 updated_at=clock_timestamp()
           RETURNING niho_user_id, active, source_version, source_invitation_id::text`,
          [nihoUserId, normalizedCommand.actorNihoUserId, input.active, input.sourceVersion, input.sourceInvitationId],
        );
        result = { status: "APPLIED", writer: writerFromRow(updated.rows[0]!) };
      }
      await insertReceipt(client, {
        ...normalizedCommand,
        requestHash,
        targetKind: "WRITER",
        targetId: nihoUserId,
        action: "writer.put",
        result,
      });
      return result;
    });
  }

  async listCategories(): Promise<readonly GuideAdminCategory[]> {
    const result = await this.#pool.query<DbRow>(
      `SELECT slug, label_en, label_ja, display_order, active, revision
         FROM guide_categories ORDER BY display_order, slug`,
    );
    return result.rows.map(categoryFromRow);
  }

  async putCategory(
    command: CommandIdentity,
    slug: string,
    input: PutGuideAdminCategoryInput,
  ): Promise<GuideAdminCategoryPutResult> {
    validateCommand(command);
    const normalizedCommand = { ...command, idempotencyKey: command.idempotencyKey.toLowerCase() };
    validateCategorySlug(slug);
    assertNonEmptyText(input.labelEn, "labelEn", 120);
    assertNonEmptyText(input.labelJa, "labelJa", 120);
    if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0 || input.displayOrder > 1_000_000) {
      throw new StoreValidationError("displayOrder must be an integer from 0 to 1000000.");
    }
    if (typeof input.active !== "boolean") throw new StoreValidationError("active must be a boolean.");
    validateExpectedRevision(input.expectedRevision);
    const requestHash = semanticHash({
      route: "PUT /internal/guide-admin/v1/categories/{slug}",
      actorNihoUserId: normalizedCommand.actorNihoUserId,
      target: { slug },
      body: {
        labelEn: input.labelEn,
        labelJa: input.labelJa,
        displayOrder: input.displayOrder,
        active: input.active,
        expectedRevision: input.expectedRevision,
      },
    });

    return withTransaction(this.#pool, async (client) => {
      await lockCommandKey(client, normalizedCommand.idempotencyKey);
      const existingReceipt = await storedReceipt(client, normalizedCommand.idempotencyKey);
      if (existingReceipt !== undefined) {
        return stringValue(existingReceipt, "request_hash") === requestHash
          ? parseCategoryResult(receiptResult(existingReceipt))
          : { status: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" };
      }

      await lockTarget(client, "CATEGORY", slug);
      const currentResult = await client.query<DbRow>(
        `SELECT slug, label_en, label_ja, display_order, active, revision
           FROM guide_categories WHERE slug=$1 FOR UPDATE`,
        [slug],
      );
      const current = currentResult.rows[0];
      let result: GuideAdminCategoryPutResult;
      if (input.expectedRevision === 0 && current === undefined) {
        const inserted = await client.query<DbRow>(
          `INSERT INTO guide_categories (slug, label_en, label_ja, display_order, active, revision)
           VALUES ($1,$2,$3,$4,$5,1)
           RETURNING slug, label_en, label_ja, display_order, active, revision`,
          [slug, input.labelEn, input.labelJa, input.displayOrder, input.active],
        );
        result = { status: "APPLIED", category: categoryFromRow(inserted.rows[0]!) };
      } else if (current !== undefined && input.expectedRevision > 0 && integerValue(current, "revision") === input.expectedRevision) {
        const updated = await client.query<DbRow>(
          `UPDATE guide_categories
              SET label_en=$2, label_ja=$3, display_order=$4, active=$5,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE slug=$1
            RETURNING slug, label_en, label_ja, display_order, active, revision`,
          [slug, input.labelEn, input.labelJa, input.displayOrder, input.active],
        );
        result = { status: "APPLIED", category: categoryFromRow(updated.rows[0]!) };
      } else {
        result = { status: "CONFLICT", reason: "EXPECTED_REVISION" };
      }
      await insertReceipt(client, {
        ...normalizedCommand,
        requestHash,
        targetKind: "CATEGORY",
        targetId: slug,
        action: "category.put",
        result,
      });
      return result;
    });
  }
}
