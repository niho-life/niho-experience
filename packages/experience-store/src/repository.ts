import { createHash, randomUUID } from "node:crypto";
import {
  expandOccurrences,
  occurrenceIdFor,
  parseOccurrenceOverrides,
  parseScheduleRule,
  type Occurrence,
  type OccurrenceOverride,
  type OccurrenceSalesState,
  type ScheduleRule,
} from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import {
  BookingUnavailableError,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./errors.ts";
import {
  bookingFromRow,
  googleCalendarFromRow,
  isoValue,
  overrideFromRow,
  productFromRow,
  salesStateFromRow,
  scheduleRuleFromRow,
  type DbRow,
} from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { effectiveCalendarRole, listCalendarProductsForActor, requireProductCalendarAccess } from "./product-calendar-authorization.ts";
import {
  evaluateStoredInventory,
  lockGoogleCalendarUsage,
  lockProviderInventory,
  persistBookingInventorySnapshot,
} from "./inventory.ts";
import type {
  BookingMode,
  BookingRecord,
  CalendarAccess,
  CalendarCommandReceipt,
  CalendarProduct,
  ConfirmBookingInput,
  ConfirmBookingResult,
  CreateBookingHoldInput,
  GoogleCalendarConfiguration,
  HostActor,
  InventoryAdminActor,
  InventoryAdminProduct,
  InventoryAdminProvider,
  InventoryAdminSnapshot,
  InventoryResourceInput,
  InventoryResourceRecord,
  MembershipRole,
  ProductInput,
  ProductInventorySetting,
  ProductInventorySettingInput,
  ProductRecord,
  ProviderMembership,
  ProviderScope,
  RecordGoogleBusySyncInput,
  ScheduleView,
} from "./types.ts";
import {
  assertCanonicalInstant,
  assertMoney,
  assertNonEmptyText,
  assertSeats,
  assertStoreIdentifier,
  buildSnapshots,
  normalizeCurrency,
  validateBusySync,
} from "./validation.ts";

const PRODUCT_COLUMNS = `
  provider_id, id, slug, status, public_title, content, currency, unit_amount,
  cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref,
  seller_display_name, version, created_at, updated_at`;

const RULE_COLUMNS = `
  provider_id, id, product_id, time_zone, starts_on::text AS starts_on,
  ends_on::text AS ends_on, to_char(local_start_time, 'HH24:MI') AS local_start_time,
  duration_minutes, capacity, booking_cutoff_minutes, busy_buffer_before_minutes,
  busy_buffer_after_minutes, recurrence, version`;

const OVERRIDE_COLUMNS = `
  occurrence_id, kind, local_date::text AS local_date,
  to_char(local_start_time, 'HH24:MI') AS local_start_time, duration_minutes, version`;

const SALES_STATE_COLUMNS = `occurrence_id, desired_state, version`;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BOOKING_COLUMNS = `
  public_booking_id::text AS public_booking_id, provider_id, product_id, occurrence_id,
  status, seats, idempotency_key, hold_expires_at, occurrence_snapshot, pricing_snapshot,
  seller_snapshot, stripe_payment_ref, created_at, confirmed_at`;

const GOOGLE_COLUMNS = `
  provider_id, opaque_calendar_id, blocking_enabled, sync_status, last_attempted_at,
  last_succeeded_at, fresh_until, coverage_start, coverage_end, version`;

interface ExperienceStoreOptions {
  readonly defaultHoldSeconds?: number;
}

function oneRow(rows: readonly DbRow[], resource: string): DbRow {
  const row = rows[0];
  if (row === undefined) throw new StoreNotFoundError(resource);
  return row;
}

function validateActor(actor: HostActor, allowOperator = false): void {
  if (actor.calendarScope === "OPERATOR" && !allowOperator) throw new StoreAccessDeniedError();
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
}

function validateScope(scope: ProviderScope): void {
  assertStoreIdentifier(scope.providerId, "scope.providerId");
}

function validateInventoryAdmin(actor: InventoryAdminActor): void {
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
}

function validateCommandId(commandId: string): void {
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new StoreValidationError("commandId must be a UUID v4.");
}

function inventoryCommandFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function commandReceipt(value: unknown, repeated: boolean): CalendarCommandReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreConflictError("Calendar command result is invalid.");
  const result = value as Record<string, unknown>;
  if (typeof result.aggregateId !== "string" || !Number.isSafeInteger(result.version) || (result.version as number) < 1) {
    throw new StoreConflictError("Calendar command result is invalid.");
  }
  return { aggregateId: result.aggregateId, version: result.version as number, repeated };
}

async function previousCalendarCommand(
  client: PoolClient,
  providerId: string,
  commandId: string,
  action: string,
  requestFingerprint: string,
): Promise<CalendarCommandReceipt | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`${providerId}:${commandId}`]);
  const previous = await client.query<DbRow>(
    "SELECT action, request_fingerprint, result FROM calendar_commands WHERE provider_id=$1 AND command_id=$2::uuid",
    [providerId, commandId],
  );
  const row = previous.rows[0];
  if (row === undefined) return null;
  if (row.action !== action || row.request_fingerprint !== requestFingerprint) {
    throw new StoreConflictError("The calendar command ID was already used with different input.");
  }
  return commandReceipt(row.result, true);
}

async function completeCalendarCommand(
  client: PoolClient,
  providerId: string,
  commandId: string,
  action: string,
  requestFingerprint: string,
  aggregateType: "schedule_rule" | "schedule_occurrence" | "inventory_resource" | "product_inventory",
  receipt: CalendarCommandReceipt,
): Promise<CalendarCommandReceipt> {
  const result = { aggregateId: receipt.aggregateId, version: receipt.version };
  await client.query(
    `INSERT INTO calendar_commands (provider_id, command_id, action, request_fingerprint, result)
     VALUES ($1,$2::uuid,$3,$4,$5::jsonb)`,
    [providerId, commandId, action, requestFingerprint, JSON.stringify(result)],
  );
  await client.query(
    `INSERT INTO calendar_outbox_events
       (provider_id, command_id, aggregate_type, aggregate_id, topic, payload)
     VALUES ($1,$2::uuid,$3,$4,'calendar.changed',$5::jsonb)`,
    [providerId, commandId, aggregateType, receipt.aggregateId, JSON.stringify({ providerId, aggregateType, aggregateId: receipt.aggregateId, action, version: receipt.version })],
  );
  return { ...receipt, repeated: false };
}

async function requireMembership(
  client: PoolClient,
  actor: HostActor,
  allowedRoles: readonly MembershipRole[],
): Promise<ProviderMembership> {
  validateActor(actor);
  const result = await client.query<DbRow>(
    `SELECT provider_id, niho_user_id, role, active
       FROM provider_memberships
      WHERE provider_id = $1
        AND niho_user_id = $2
        AND active = true
        AND role = ANY($3::text[])
      FOR SHARE`,
    [actor.providerId, actor.nihoUserId, allowedRoles],
  );
  const row = result.rows[0];
  const role = row ? effectiveCalendarRole(actor, String(row.role) as MembershipRole) : null;
  if (!row || !role || !allowedRoles.includes(role)) throw new StoreAccessDeniedError();
  return {
    providerId: String(row.provider_id),
    nihoUserId: String(row.niho_user_id),
    role,
    active: row.active === true,
  };
}

function validateProduct(input: ProductInput): ProductInput & { readonly currency: string } {
  assertStoreIdentifier(input.id, "product.id");
  assertNonEmptyText(input.slug, "product.slug", 160);
  assertNonEmptyText(input.publicTitle, "product.publicTitle", 300);
  assertMoney(input.unitAmount, "product.unitAmount");
  assertNonEmptyText(input.cancellationTermsRef, "product.cancellationTermsRef");
  assertNonEmptyText(input.sellerNihoAccountRef, "product.sellerNihoAccountRef", 256);
  assertNonEmptyText(input.stripeConnectAccountRef, "product.stripeConnectAccountRef", 256);
  assertNonEmptyText(input.sellerDisplayName, "product.sellerDisplayName", 300);
  if (input.status !== "DRAFT" && input.status !== "PUBLISHED" && input.status !== "ARCHIVED") {
    throw new StoreValidationError("product.status is invalid.");
  }
  if (typeof input.content !== "object" || input.content === null || Array.isArray(input.content)) {
    throw new StoreValidationError("product.content must be a JSON object.");
  }
  try {
    JSON.stringify(input.content);
  } catch (error) {
    throw new StoreValidationError("product.content must be JSON serializable.", { cause: error });
  }
  return { ...input, currency: normalizeCurrency(input.currency) };
}

function sourceDateFromOccurrence(ruleId: string, occurrenceId: string): string {
  const marker = occurrenceId.lastIndexOf("@");
  const sourceDate = marker < 0 ? "" : occurrenceId.slice(marker + 1);
  try {
    if (occurrenceIdFor(ruleId, sourceDate) !== occurrenceId) throw new Error("mismatch");
  } catch (error) {
    throw new StoreValidationError("occurrenceId does not belong to the requested schedule rule.", { cause: error });
  }
  return sourceDate;
}

function occurrenceForSource(
  rule: ScheduleRule,
  override: OccurrenceOverride | undefined,
  salesState: OccurrenceSalesState | undefined,
  occurrenceId: string,
): Occurrence {
  const sourceDate = sourceDateFromOccurrence(rule.id, occurrenceId);
  const targetDate = override?.kind === "RESCHEDULE" ? override.localDate : sourceDate;
  const occurrence = expandOccurrences({
    rule,
    overrides: override === undefined ? [] : [override],
    salesStates: salesState === undefined ? [] : [salesState],
    fromDate: targetDate,
    toDate: targetDate,
  }).find((candidate) => candidate.id === occurrenceId);
  if (occurrence === undefined) throw new StoreNotFoundError("schedule occurrence");
  return occurrence;
}

export class ExperienceStore {
  readonly #pool: Pool;
  readonly #defaultHoldSeconds: number;

  constructor(pool: Pool, options: ExperienceStoreOptions = {}) {
    this.#pool = pool;
    this.#defaultHoldSeconds = options.defaultHoldSeconds ?? 900;
    if (!Number.isInteger(this.#defaultHoldSeconds) || this.#defaultHoldSeconds < 60 || this.#defaultHoldSeconds > 3_600) {
      throw new StoreValidationError("defaultHoldSeconds must be between 60 and 3600.");
    }
  }

  async verifyActiveMembership(actor: HostActor): Promise<ProviderMembership | null> {
    validateActor(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT provider_id, niho_user_id, role, active
         FROM provider_memberships
        WHERE provider_id = $1 AND niho_user_id = $2 AND active = true`,
      [actor.providerId, actor.nihoUserId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          providerId: String(row.provider_id),
          nihoUserId: String(row.niho_user_id),
          role: effectiveCalendarRole(actor, String(row.role) as MembershipRole)!,
          active: true,
        };
  }

  async verifyProductCalendarAccess(actor: HostActor, productId: string, write = false): Promise<CalendarAccess> {
    return requireProductCalendarAccess(this.#pool, actor, productId, write ? ["OWNER", "EDITOR"] : ["OWNER", "EDITOR", "VIEWER"]);
  }

  async listCalendarProducts(actor: HostActor): Promise<readonly CalendarProduct[]> {
    validateActor(actor, true);
    return listCalendarProductsForActor(this.#pool, actor);
  }

  async resolveScheduleRuleProduct(actor: HostActor, ruleId: string, write = false): Promise<string> {
    validateActor(actor, true);
    assertStoreIdentifier(ruleId, "ruleId");
    const result = await this.#pool.query<DbRow>(
      "SELECT product_id FROM schedule_rules WHERE provider_id=$1 AND id=$2",
      [actor.providerId, ruleId],
    );
    const row = result.rows[0];
    if (!row) throw new StoreNotFoundError("schedule rule");
    const productId = String(row.product_id);
    await requireProductCalendarAccess(this.#pool, actor, productId, write ? ["OWNER", "EDITOR"] : ["OWNER", "EDITOR", "VIEWER"]);
    return productId;
  }

  async createProduct(actor: HostActor, rawInput: ProductInput): Promise<ProductRecord> {
    const input = validateProduct(rawInput);
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      const result = await client.query<DbRow>(
        `INSERT INTO experience_products (
           provider_id, id, slug, status, public_title, content, currency, unit_amount,
           cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING ${PRODUCT_COLUMNS}`,
        [
          actor.providerId,
          input.id,
          input.slug,
          input.status,
          input.publicTitle,
          JSON.stringify(input.content),
          input.currency,
          input.unitAmount,
          input.cancellationTermsRef,
          input.sellerNihoAccountRef,
          input.stripeConnectAccountRef,
          input.sellerDisplayName,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new StoreConflictError("The product ID or slug is already in use in this provider.");
      return productFromRow(row);
    });
  }

  async getProduct(actor: HostActor, productId: string): Promise<ProductRecord> {
    validateActor(actor);
    assertStoreIdentifier(productId, "productId");
    const result = await this.#pool.query<DbRow>(
      `SELECT ${PRODUCT_COLUMNS}
         FROM experience_products p
        WHERE p.provider_id = $1 AND p.id = $3
          AND EXISTS (
            SELECT 1 FROM provider_memberships m
             WHERE m.provider_id=p.provider_id AND m.niho_user_id=$2 AND m.active=true
          )`,
      [actor.providerId, actor.nihoUserId, productId],
    );
    return productFromRow(oneRow(result.rows, "product"));
  }

  async getPublishedProduct(scope: ProviderScope, productId: string): Promise<ProductRecord> {
    validateScope(scope);
    assertStoreIdentifier(productId, "productId");
    const result = await this.#pool.query<DbRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM experience_products
        WHERE provider_id=$1 AND id=$2 AND status='PUBLISHED'`,
      [scope.providerId, productId],
    );
    return productFromRow(oneRow(result.rows, "published product"));
  }

  async updateProduct(actor: HostActor, rawInput: ProductInput, expectedVersion: number): Promise<ProductRecord> {
    const input = validateProduct(rawInput);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new StoreValidationError("expectedVersion must be a positive integer.");
    }
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      const result = await client.query<DbRow>(
        `UPDATE experience_products
            SET slug = $3, status = $4, public_title = $5, content = $6::jsonb,
                currency = $7, unit_amount = $8, cancellation_terms_ref = $9,
                seller_niho_account_ref = $10, stripe_connect_account_ref = $11,
                seller_display_name = $12, version = version + 1, updated_at = clock_timestamp()
          WHERE provider_id = $1 AND id = $2 AND version = $13
          RETURNING ${PRODUCT_COLUMNS}`,
        [
          actor.providerId,
          input.id,
          input.slug,
          input.status,
          input.publicTitle,
          JSON.stringify(input.content),
          input.currency,
          input.unitAmount,
          input.cancellationTermsRef,
          input.sellerNihoAccountRef,
          input.stripeConnectAccountRef,
          input.sellerDisplayName,
          expectedVersion,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new StoreConflictError("Product version mismatch or product not found in this provider.");
      return productFromRow(row);
    });
  }

  async saveInventoryResource(
    actor: HostActor,
    input: InventoryResourceInput,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateActor(actor);
    assertStoreIdentifier(input.id, "resource.id");
    assertNonEmptyText(input.displayName, "resource.displayName", 200);
    if (!(input.kind === "VENUE" || input.kind === "INSTRUCTOR" || input.kind === "EQUIPMENT")) {
      throw new StoreValidationError("resource.kind is invalid.");
    }
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    }
    validateCommandId(commandId);
    const requestFingerprint = inventoryCommandFingerprint({ input, expectedVersion });
    return this.#saveInventoryResource(actor.providerId, input, expectedVersion, commandId, requestFingerprint,
      (client) => requireMembership(client, actor, ["OWNER", "EDITOR"]));
  }

  async listInventoryResources(actor: HostActor): Promise<readonly InventoryResourceRecord[]> {
    validateActor(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT r.provider_id,r.id,r.kind,r.display_name,r.active,r.version,r.created_at,r.updated_at
         FROM inventory_resources r
        WHERE r.provider_id=$1 AND EXISTS (
          SELECT 1 FROM provider_memberships m
           WHERE m.provider_id=r.provider_id AND m.niho_user_id=$2 AND m.active=true)
        ORDER BY r.id COLLATE "C"`,
      [actor.providerId, actor.nihoUserId],
    );
    return result.rows.map((row) => ({
      providerId: String(row.provider_id), id: String(row.id), kind: String(row.kind) as InventoryResourceRecord["kind"],
      displayName: String(row.display_name), active: row.active === true, version: Number(row.version),
      createdAtUtc: isoValue(row, "created_at"), updatedAtUtc: isoValue(row, "updated_at"),
    }));
  }

  async listInventoryAdminProviders(actor: InventoryAdminActor): Promise<readonly InventoryAdminProvider[]> {
    validateInventoryAdmin(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT providers.id,providers.display_name FROM (
         SELECT p.id,COALESCE(MIN(NULLIF(BTRIM(e.seller_display_name),'')),p.id) AS display_name
           FROM experience_providers p
           LEFT JOIN experience_products e ON e.provider_id=p.id AND e.status<>'ARCHIVED'
          GROUP BY p.id
        ) providers ORDER BY providers.display_name COLLATE "C",providers.id COLLATE "C" LIMIT 500`,
    );
    return result.rows.map((row) => ({ id: String(row.id), displayName: String(row.display_name) }));
  }

  async getInventoryAdminSnapshot(actor: InventoryAdminActor, providerId: string): Promise<InventoryAdminSnapshot> {
    validateInventoryAdmin(actor);
    assertStoreIdentifier(providerId, "providerId");
    return withTransaction(this.#pool, async (client) => {
    await lockProviderInventory(client, providerId);
    const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1", [providerId]);
    if (!provider.rows[0]) throw new StoreNotFoundError("provider");
    const [productsResult, resources, settingsResult, assignmentsResult] = await Promise.all([
      client.query<DbRow>(
        `SELECT id,public_title,seller_display_name,status FROM experience_products
          WHERE provider_id=$1 AND status<>'ARCHIVED'
          ORDER BY public_title COLLATE "C",id COLLATE "C" LIMIT 500`, [providerId],
      ),
      this.#listInventoryResources(providerId, client),
      client.query<DbRow>(
        `SELECT product_id,booking_mode,version FROM product_inventory_settings
          WHERE provider_id=$1 ORDER BY product_id COLLATE "C"`, [providerId],
      ),
      client.query<DbRow>(
        `SELECT product_id,resource_id,prepare_minutes,cleanup_minutes FROM product_inventory_resources
          WHERE provider_id=$1 ORDER BY product_id COLLATE "C",resource_id COLLATE "C"`, [providerId],
      ),
    ]);
    const assignments = new Map<string, ProductInventorySetting["resources"] extends readonly (infer T)[] ? T[] : never>();
    for (const row of assignmentsResult.rows) {
      const productId = String(row.product_id);
      const current = assignments.get(productId) ?? [];
      current.push({ resourceId: String(row.resource_id), prepareMinutes: Number(row.prepare_minutes), cleanupMinutes: Number(row.cleanup_minutes) });
      assignments.set(productId, current);
    }
    const settings = new Map(settingsResult.rows.map((row) => {
      const productId = String(row.product_id);
      return [productId, {
        providerId, productId, bookingMode: String(row.booking_mode) as BookingMode,
        version: Number(row.version), resources: assignments.get(productId) ?? [],
      } satisfies ProductInventorySetting] as const;
    }));
    const products: InventoryAdminProduct[] = productsResult.rows.map((row) => {
      const id = String(row.id);
      const inventory = settings.get(id);
      return {
        id, publicTitle: String(row.public_title), sellerDisplayName: String(row.seller_display_name),
        status: String(row.status) as InventoryAdminProduct["status"], ...(inventory ? { inventory } : {}),
      };
    });
    return { providerId, products, resources };
    });
  }

  async saveInventoryResourceAsAdmin(
    actor: InventoryAdminActor,
    providerId: string,
    input: InventoryResourceInput,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateInventoryAdmin(actor);
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(input.id, "resource.id");
    assertNonEmptyText(input.displayName, "resource.displayName", 200);
    if (!(input.kind === "VENUE" || input.kind === "INSTRUCTOR" || input.kind === "EQUIPMENT")) throw new StoreValidationError("resource.kind is invalid.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    validateCommandId(commandId);
    const requestFingerprint = inventoryCommandFingerprint({ input, expectedVersion });
    return this.#saveInventoryResource(providerId, input, expectedVersion, commandId, requestFingerprint,
      (client) => this.#requireAdminProvider(client, providerId));
  }

  async saveProductInventorySetting(
    actor: HostActor,
    productId: string,
    input: ProductInventorySettingInput,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateActor(actor);
    assertStoreIdentifier(productId, "productId");
    if (input.bookingMode !== "SEAT" && input.bookingMode !== "PRIVATE_GROUP") throw new StoreValidationError("bookingMode is invalid.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    }
    validateCommandId(commandId);
    if (input.resources.length > 200) throw new StoreValidationError("A product may use at most 200 inventory resources.");
    const seen = new Set<string>();
    for (const assignment of input.resources) {
      assertStoreIdentifier(assignment.resourceId, "resourceId");
      if (seen.has(assignment.resourceId)) throw new StoreValidationError("A resource may be assigned only once per product.");
      seen.add(assignment.resourceId);
      if (!Number.isInteger(assignment.prepareMinutes) || assignment.prepareMinutes < 0 || assignment.prepareMinutes > 1_440
        || !Number.isInteger(assignment.cleanupMinutes) || assignment.cleanupMinutes < 0 || assignment.cleanupMinutes > 1_440) {
        throw new StoreValidationError("Resource preparation and cleanup must be from 0 to 1440 minutes.");
      }
    }
    const normalized = {
      bookingMode: input.bookingMode,
      resources: [...input.resources].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0),
    };
    const requestFingerprint = inventoryCommandFingerprint({ productId, input: normalized, expectedVersion });
    return this.#saveProductInventorySetting(actor.providerId, productId, normalized, expectedVersion, commandId, requestFingerprint,
      (client) => requireMembership(client, actor, ["OWNER", "EDITOR"]));
  }

  async saveProductInventorySettingAsAdmin(
    actor: InventoryAdminActor,
    providerId: string,
    productId: string,
    input: ProductInventorySettingInput,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateInventoryAdmin(actor);
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    if (input.bookingMode !== "SEAT" && input.bookingMode !== "PRIVATE_GROUP") throw new StoreValidationError("bookingMode is invalid.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    validateCommandId(commandId);
    if (input.resources.length > 200) throw new StoreValidationError("A product may use at most 200 inventory resources.");
    const seen = new Set<string>();
    for (const assignment of input.resources) {
      assertStoreIdentifier(assignment.resourceId, "resourceId");
      if (seen.has(assignment.resourceId)) throw new StoreValidationError("A resource may be assigned only once per product.");
      seen.add(assignment.resourceId);
      if (!Number.isInteger(assignment.prepareMinutes) || assignment.prepareMinutes < 0 || assignment.prepareMinutes > 1_440
        || !Number.isInteger(assignment.cleanupMinutes) || assignment.cleanupMinutes < 0 || assignment.cleanupMinutes > 1_440) {
        throw new StoreValidationError("Resource preparation and cleanup must be from 0 to 1440 minutes.");
      }
    }
    const normalized = { bookingMode: input.bookingMode, resources: [...input.resources].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0) };
    const requestFingerprint = inventoryCommandFingerprint({ productId, input: normalized, expectedVersion });
    return this.#saveProductInventorySetting(providerId, productId, normalized, expectedVersion, commandId, requestFingerprint,
      (client) => this.#requireAdminProvider(client, providerId));
  }

  async getProductInventorySetting(actor: HostActor, productId: string): Promise<ProductInventorySetting> {
    validateActor(actor);
    assertStoreIdentifier(productId, "productId");
    const membership = await this.verifyActiveMembership(actor);
    if (!membership) throw new StoreAccessDeniedError();
    return this.#productInventorySetting(this.#pool, actor.providerId, productId);
  }

  async saveScheduleRule(
    actor: HostActor,
    productId: string,
    rawRule: ScheduleRule,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateActor(actor, true);
    assertStoreIdentifier(productId, "productId");
    const rule = parseScheduleRule(rawRule);
    validateCommandId(commandId);
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    }
    const requestFingerprint = JSON.stringify({ productId, rule, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireProductCalendarAccess(client, actor, productId, ["OWNER", "EDITOR"]);
      const previous = await previousCalendarCommand(client, actor.providerId, commandId, "schedule_rule.save", requestFingerprint);
      if (previous) return previous;
      const product = await client.query<DbRow>(
        "SELECT id FROM experience_products WHERE provider_id = $1 AND id = $2 FOR SHARE",
        [actor.providerId, productId],
      );
      if (product.rows[0] === undefined) throw new StoreNotFoundError("product");

      const existing = await client.query<DbRow>(
        "SELECT product_id, version FROM schedule_rules WHERE provider_id = $1 AND id = $2 FOR UPDATE",
        [actor.providerId, rule.id],
      );
      const existingRow = existing.rows[0];
      if (existingRow === undefined && expectedVersion !== null) {
        throw new StoreConflictError("Schedule rule does not exist at the expected version.");
      }
      if (existingRow !== undefined && Number(existingRow.version) !== expectedVersion) {
        throw new StoreConflictError("Schedule rule version mismatch.");
      }
      if (existingRow !== undefined && existingRow.product_id !== productId) {
        throw new StoreConflictError("A schedule rule cannot be moved between products.");
      }
      if (existingRow !== undefined) await this.#assertScheduleHasNoFutureReservations(client, actor.providerId, rule.id);

      const values = [
        actor.providerId,
        rule.id,
        productId,
        rule.timeZone,
        rule.startsOn,
        rule.endsOn ?? null,
        rule.localStartTime,
        rule.durationMinutes,
        rule.capacity,
        rule.bookingCutoffMinutes,
        rule.busyBufferBeforeMinutes,
        rule.busyBufferAfterMinutes,
        JSON.stringify(rule.recurrence),
      ];
      const result = existingRow === undefined
        ? await client.query<DbRow>(
            `INSERT INTO schedule_rules (
               provider_id, id, product_id, time_zone, starts_on, ends_on, local_start_time,
               duration_minutes, capacity, booking_cutoff_minutes, busy_buffer_before_minutes,
               busy_buffer_after_minutes, recurrence
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             RETURNING ${RULE_COLUMNS}`,
            values,
          )
        : await client.query<DbRow>(
            `UPDATE schedule_rules
                SET product_id=$3, time_zone=$4, starts_on=$5, ends_on=$6, local_start_time=$7,
                    duration_minutes=$8, capacity=$9, booking_cutoff_minutes=$10,
                    busy_buffer_before_minutes=$11, busy_buffer_after_minutes=$12,
                    recurrence=$13::jsonb, version=version+1, updated_at=clock_timestamp()
              WHERE provider_id=$1 AND id=$2
              RETURNING ${RULE_COLUMNS}`,
            values,
          );
      const saved = scheduleRuleFromRow(oneRow(result.rows, "schedule rule"));
      return completeCalendarCommand(client, actor.providerId, commandId, "schedule_rule.save", requestFingerprint, "schedule_rule", {
        aggregateId: saved.rule.id,
        version: saved.version,
        repeated: false,
      });
    });
  }

  async listSchedule(actor: HostActor, productId: string): Promise<readonly ScheduleView[]> {
    validateActor(actor, true);
    assertStoreIdentifier(productId, "productId");
    await requireProductCalendarAccess(this.#pool, actor, productId, ["OWNER", "EDITOR", "VIEWER"]);
    const rules = await this.#pool.query<DbRow>(
      `SELECT ${RULE_COLUMNS}
         FROM schedule_rules r
        WHERE r.provider_id=$1 AND r.product_id=$2
        ORDER BY r.id`,
      [actor.providerId, productId],
    );
    const views: ScheduleView[] = [];
    for (const row of rules.rows) {
      const storedRule = scheduleRuleFromRow(row);
      const overrides = await this.#pool.query<DbRow>(
        `SELECT ${OVERRIDE_COLUMNS}
           FROM schedule_occurrence_overrides o
          WHERE o.provider_id=$1 AND o.rule_id=$2
          ORDER BY o.occurrence_id`,
        [actor.providerId, storedRule.rule.id],
      );
      const salesStates = await this.#pool.query<DbRow>(
        `SELECT ${SALES_STATE_COLUMNS}
           FROM schedule_occurrence_sales_states s
          WHERE s.provider_id=$1 AND s.rule_id=$2
          ORDER BY s.occurrence_id`,
        [actor.providerId, storedRule.rule.id],
      );
      views.push({ rule: storedRule, overrides: overrides.rows.map(overrideFromRow), salesStates: salesStates.rows.map(salesStateFromRow) });
    }
    return views;
  }

  async saveOccurrenceOverride(
    actor: HostActor,
    productId: string,
    ruleId: string,
    rawOverride: OccurrenceOverride,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateActor(actor, true);
    assertStoreIdentifier(productId, "productId");
    const override = parseOccurrenceOverrides([rawOverride])[0];
    if (override === undefined) throw new StoreValidationError("override is required.");
    if (override.kind !== "RESCHEDULE") throw new StoreValidationError("Only a reschedule may be stored as an occurrence override.");
    validateCommandId(commandId);
    sourceDateFromOccurrence(ruleId, override.occurrenceId);
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    }
    const requestFingerprint = JSON.stringify({ productId, ruleId, override, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireProductCalendarAccess(client, actor, productId, ["OWNER", "EDITOR"]);
      const previous = await previousCalendarCommand(client, actor.providerId, commandId, "occurrence.reschedule", requestFingerprint);
      if (previous) return previous;
      const ruleResult = await client.query<DbRow>(
        `SELECT ${RULE_COLUMNS} FROM schedule_rules WHERE provider_id=$1 AND product_id=$2 AND id=$3 FOR UPDATE`,
        [actor.providerId, productId, ruleId],
      );
      const storedRule = scheduleRuleFromRow(oneRow(ruleResult.rows, "schedule rule"));
      occurrenceForSource(storedRule.rule, undefined, undefined, override.occurrenceId);
      await this.#assertOccurrenceHasNoReservations(client, actor.providerId, override.occurrenceId);
      const current = await client.query<DbRow>(
        `SELECT version FROM schedule_occurrence_overrides
          WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3 FOR UPDATE`,
        [actor.providerId, ruleId, override.occurrenceId],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined && expectedVersion !== null) throw new StoreConflictError("Occurrence override was not found.");
      if (currentRow !== undefined && Number(currentRow.version) !== expectedVersion) {
        throw new StoreConflictError("Occurrence override version mismatch.");
      }
      const localDate = override.localDate;
      const localStartTime = override.localStartTime;
      const durationMinutes = override.durationMinutes ?? null;
      const values = [actor.providerId, ruleId, override.occurrenceId, override.kind, localDate, localStartTime, durationMinutes];
      const result = currentRow === undefined
        ? await client.query<DbRow>(
            `INSERT INTO schedule_occurrence_overrides
               (provider_id, rule_id, occurrence_id, kind, local_date, local_start_time, duration_minutes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING ${OVERRIDE_COLUMNS}`,
            values,
          )
        : await client.query<DbRow>(
            `UPDATE schedule_occurrence_overrides
                SET kind=$4, local_date=$5, local_start_time=$6, duration_minutes=$7,
                    version=version+1, updated_at=clock_timestamp()
              WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3
              RETURNING ${OVERRIDE_COLUMNS}`,
            values,
          );
      const saved = overrideFromRow(oneRow(result.rows, "occurrence override"));
      return completeCalendarCommand(client, actor.providerId, commandId, "occurrence.reschedule", requestFingerprint, "schedule_occurrence", {
        aggregateId: saved.override.occurrenceId,
        version: saved.version,
        repeated: false,
      });
    });
  }

  async setOccurrenceSalesState(
    actor: HostActor,
    productId: string,
    ruleId: string,
    rawState: OccurrenceSalesState,
    expectedVersion: number | null,
    commandId: string,
  ): Promise<CalendarCommandReceipt> {
    validateActor(actor, true);
    assertStoreIdentifier(productId, "productId");
    sourceDateFromOccurrence(ruleId, rawState.occurrenceId);
    if (rawState.desiredState !== "OPEN" && rawState.desiredState !== "CLOSED") throw new StoreValidationError("desiredState is invalid.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    validateCommandId(commandId);
    const requestFingerprint = JSON.stringify({ productId, ruleId, state: rawState, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireProductCalendarAccess(client, actor, productId, ["OWNER", "EDITOR"]);
      const previous = await previousCalendarCommand(client, actor.providerId, commandId, "occurrence.sales_state", requestFingerprint);
      if (previous) return previous;
      const rule = await client.query<DbRow>(
        `SELECT ${RULE_COLUMNS} FROM schedule_rules WHERE provider_id=$1 AND product_id=$2 AND id=$3 FOR UPDATE`,
        [actor.providerId, productId, ruleId],
      );
      const storedRule = scheduleRuleFromRow(oneRow(rule.rows, "schedule rule"));
      const timing = await client.query<DbRow>(
        `SELECT ${OVERRIDE_COLUMNS} FROM schedule_occurrence_overrides
          WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3`,
        [actor.providerId, ruleId, rawState.occurrenceId],
      );
      const storedOverride = timing.rows[0] === undefined ? undefined : overrideFromRow(timing.rows[0]).override;
      occurrenceForSource(storedRule.rule, storedOverride, rawState, rawState.occurrenceId);
      const current = await client.query<DbRow>(
        `SELECT ${SALES_STATE_COLUMNS} FROM schedule_occurrence_sales_states
          WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3 FOR UPDATE`,
        [actor.providerId, ruleId, rawState.occurrenceId],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined && expectedVersion !== null) throw new StoreConflictError("Occurrence sales state was not found.");
      if (currentRow !== undefined && Number(currentRow.version) !== expectedVersion) throw new StoreConflictError("Occurrence sales state version mismatch.");
      const savedResult = currentRow === undefined
        ? await client.query<DbRow>(
            `INSERT INTO schedule_occurrence_sales_states (provider_id, rule_id, occurrence_id, desired_state)
             VALUES ($1,$2,$3,$4) RETURNING ${SALES_STATE_COLUMNS}`,
            [actor.providerId, ruleId, rawState.occurrenceId, rawState.desiredState],
          )
        : await client.query<DbRow>(
            `UPDATE schedule_occurrence_sales_states
                SET desired_state=$4, version=version+1, updated_at=clock_timestamp()
              WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3
              RETURNING ${SALES_STATE_COLUMNS}`,
            [actor.providerId, ruleId, rawState.occurrenceId, rawState.desiredState],
          );
      const saved = salesStateFromRow(oneRow(savedResult.rows, "occurrence sales state"));
      return completeCalendarCommand(client, actor.providerId, commandId, "occurrence.sales_state", requestFingerprint, "schedule_occurrence", {
        aggregateId: saved.state.occurrenceId,
        version: saved.version,
        repeated: false,
      });
    });
  }

  async configureGoogleCalendar(
    actor: HostActor,
    input: { readonly opaqueCalendarId: string; readonly blockingEnabled: boolean },
    expectedVersion: number | null,
  ): Promise<GoogleCalendarConfiguration> {
    validateActor(actor);
    assertNonEmptyText(input.opaqueCalendarId, "opaqueCalendarId");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      await lockGoogleCalendarUsage(client, [input.opaqueCalendarId]);
      const outputCollision = await client.query(
        "SELECT 1 FROM google_channel_output_bindings WHERE opaque_calendar_id=$1 FOR SHARE",
        [input.opaqueCalendarId],
      );
      if (outputCollision.rows[0]) throw new StoreConflictError("An Airbnb output calendar cannot be used as busy input.");
      const current = await client.query<DbRow>(
        `SELECT ${GOOGLE_COLUMNS} FROM provider_google_calendars WHERE provider_id=$1 FOR UPDATE`,
        [actor.providerId],
      );
      const row = current.rows[0];
      if (row === undefined && expectedVersion !== null) throw new StoreConflictError("Google calendar configuration was not found.");
      if (row !== undefined && Number(row.version) !== expectedVersion) {
        throw new StoreConflictError("Google calendar configuration version mismatch.");
      }
      if (row === undefined) {
        const inserted = await client.query<DbRow>(
          `INSERT INTO provider_google_calendars (provider_id, opaque_calendar_id, blocking_enabled)
           VALUES ($1,$2,$3)
           RETURNING ${GOOGLE_COLUMNS}`,
          [actor.providerId, input.opaqueCalendarId, input.blockingEnabled],
        );
        const configuration = googleCalendarFromRow(oneRow(inserted.rows, "Google calendar configuration"));
        await enqueueCalendarRecalculation(client, { providerId: actor.providerId, aggregateType: "google_calendar", aggregateId: actor.providerId, cause: "google_configuration_changed" });
        return configuration;
      }
      const calendarChanged = row.opaque_calendar_id !== input.opaqueCalendarId;
      if (calendarChanged) {
        await client.query("DELETE FROM google_busy_intervals WHERE provider_id=$1", [actor.providerId]);
      }
      const updated = await client.query<DbRow>(
        `UPDATE provider_google_calendars
            SET opaque_calendar_id=$2, blocking_enabled=$3,
                sync_status=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN 'STALE' ELSE sync_status END,
                last_attempted_at=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN NULL ELSE last_attempted_at END,
                last_succeeded_at=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN NULL ELSE last_succeeded_at END,
                fresh_until=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN NULL ELSE fresh_until END,
                coverage_start=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN NULL ELSE coverage_start END,
                coverage_end=CASE WHEN opaque_calendar_id IS DISTINCT FROM $2 THEN NULL ELSE coverage_end END,
                version=version+1, updated_at=clock_timestamp()
          WHERE provider_id=$1
          RETURNING ${GOOGLE_COLUMNS}`,
        [actor.providerId, input.opaqueCalendarId, input.blockingEnabled],
      );
      const configuration = googleCalendarFromRow(oneRow(updated.rows, "Google calendar configuration"));
      await enqueueCalendarRecalculation(client, { providerId: actor.providerId, aggregateType: "google_calendar", aggregateId: actor.providerId, cause: "google_configuration_changed" });
      return configuration;
    });
  }

  async getGoogleCalendar(actor: HostActor): Promise<GoogleCalendarConfiguration | null> {
    validateActor(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT ${GOOGLE_COLUMNS}
         FROM provider_google_calendars g
        WHERE g.provider_id=$1
          AND EXISTS (
            SELECT 1 FROM provider_memberships m
             WHERE m.provider_id=g.provider_id AND m.niho_user_id=$2 AND m.active=true
          )`,
      [actor.providerId, actor.nihoUserId],
    );
    return result.rows[0] === undefined ? null : googleCalendarFromRow(result.rows[0]);
  }

  async recordGoogleBusySync(scope: ProviderScope, input: RecordGoogleBusySyncInput): Promise<GoogleCalendarConfiguration> {
    validateScope(scope);
    assertNonEmptyText(input.opaqueCalendarId, "opaqueCalendarId");
    const intervals = validateBusySync(input.attemptedAtUtc, input.freshUntilUtc, input.busyIntervals);
    assertCanonicalInstant(input.coverageStartUtc, "coverageStartUtc");
    assertCanonicalInstant(input.coverageEndUtc, "coverageEndUtc");
    if (input.coverageEndUtc <= input.coverageStartUtc) throw new StoreValidationError("Google busy coverage must have a positive duration.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, scope.providerId);
      const current = await client.query<DbRow>(
        `SELECT ${GOOGLE_COLUMNS} FROM provider_google_calendars
          WHERE provider_id=$1 AND opaque_calendar_id=$2
            AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM provider_google_connections c
              JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
                AND m.active=true AND m.role='OWNER'
              WHERE c.provider_id=$1 AND c.connection_generation=$3)) FOR UPDATE`,
        [scope.providerId, input.opaqueCalendarId, input.connectionGeneration ?? null],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined) throw new StoreNotFoundError("Google calendar configuration");
      const currentConfiguration = googleCalendarFromRow(currentRow);
      if (
        currentConfiguration.lastAttemptedAtUtc !== undefined
        && currentConfiguration.lastAttemptedAtUtc >= input.attemptedAtUtc
      ) {
        return currentConfiguration;
      }
      const updated = await client.query<DbRow>(
        `UPDATE provider_google_calendars
            SET sync_status='FRESH', last_attempted_at=$3, last_succeeded_at=$3, fresh_until=$4,
                coverage_start=$5, coverage_end=$6,
                version=version+1, updated_at=clock_timestamp()
          WHERE provider_id=$1 AND opaque_calendar_id=$2
          RETURNING ${GOOGLE_COLUMNS}`,
        [scope.providerId, input.opaqueCalendarId, input.attemptedAtUtc, input.freshUntilUtc, input.coverageStartUtc, input.coverageEndUtc],
      );
      const configuration = googleCalendarFromRow(oneRow(updated.rows, "Google calendar configuration"));
      await client.query("DELETE FROM google_busy_intervals WHERE provider_id=$1", [scope.providerId]);
      if (intervals.length > 0) {
        await client.query(
          `INSERT INTO google_busy_intervals
             (provider_id, opaque_calendar_id, start_at, end_at, sync_version)
           SELECT $1, $2, item.start_utc::timestamptz, item.end_utc::timestamptz, $3
             FROM jsonb_to_recordset($4::jsonb) AS item(start_utc text, end_utc text)`,
          [
            scope.providerId,
            input.opaqueCalendarId,
            configuration.version,
            JSON.stringify(intervals.map((interval) => ({ start_utc: interval.startUtc, end_utc: interval.endUtc }))),
          ],
        );
      }
      await enqueueCalendarRecalculation(client, { providerId: scope.providerId, aggregateType: "google_calendar", aggregateId: scope.providerId, cause: "google_busy_changed" });
      await enqueueCalendarRecalculation(client, { providerId: scope.providerId, aggregateType: "google_calendar", aggregateId: scope.providerId, cause: "google_freshness_expired", availableAtUtc: input.freshUntilUtc });
      return configuration;
    });
  }

  async recordGoogleSyncFailure(
    scope: ProviderScope,
    input: { readonly opaqueCalendarId: string; readonly attemptedAtUtc: string; readonly connectionGeneration?: number },
  ): Promise<GoogleCalendarConfiguration> {
    validateScope(scope);
    assertNonEmptyText(input.opaqueCalendarId, "opaqueCalendarId");
    assertCanonicalInstant(input.attemptedAtUtc, "attemptedAtUtc");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, scope.providerId);
      const current = await client.query<DbRow>(
        `SELECT ${GOOGLE_COLUMNS} FROM provider_google_calendars
          WHERE provider_id=$1 AND opaque_calendar_id=$2
            AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM provider_google_connections c
              JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
                AND m.active=true AND m.role='OWNER'
              WHERE c.provider_id=$1 AND c.connection_generation=$3)) FOR UPDATE`,
        [scope.providerId, input.opaqueCalendarId, input.connectionGeneration ?? null],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined) throw new StoreNotFoundError("Google calendar configuration");
      const currentConfiguration = googleCalendarFromRow(currentRow);
      if (
        currentConfiguration.lastAttemptedAtUtc !== undefined
        && currentConfiguration.lastAttemptedAtUtc >= input.attemptedAtUtc
      ) {
        return currentConfiguration;
      }
      const result = await client.query<DbRow>(
        `UPDATE provider_google_calendars
            SET sync_status='FAILED', last_attempted_at=$3, fresh_until=NULL,
                version=version+1, updated_at=clock_timestamp()
          WHERE provider_id=$1 AND opaque_calendar_id=$2
          RETURNING ${GOOGLE_COLUMNS}`,
        [scope.providerId, input.opaqueCalendarId, input.attemptedAtUtc],
      );
      const configuration = googleCalendarFromRow(oneRow(result.rows, "Google calendar configuration"));
      await enqueueCalendarRecalculation(client, { providerId: scope.providerId, aggregateType: "google_calendar", aggregateId: scope.providerId, cause: "google_sync_failed" });
      return configuration;
    });
  }

  async createBookingHold(scope: ProviderScope, input: CreateBookingHoldInput): Promise<BookingRecord> {
    validateScope(scope);
    assertStoreIdentifier(input.productId, "productId");
    assertNonEmptyText(input.occurrenceId, "occurrenceId", 256);
    assertNonEmptyText(input.idempotencyKey, "idempotencyKey", 256);
    assertSeats(input.seats);
    const holdSeconds = input.holdSeconds ?? this.#defaultHoldSeconds;
    if (!Number.isInteger(holdSeconds) || holdSeconds < 60 || holdSeconds > 3_600) {
      throw new StoreValidationError("holdSeconds must be between 60 and 3600.");
    }

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, scope.providerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [scope.providerId, input.idempotencyKey]);
      const previous = await client.query<DbRow>(
        `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE provider_id=$1 AND idempotency_key=$2`,
        [scope.providerId, input.idempotencyKey],
      );
      const previousRow = previous.rows[0];
      if (previousRow !== undefined) {
        const booking = bookingFromRow(previousRow);
        if (booking.productId !== input.productId || booking.occurrenceId !== input.occurrenceId || booking.seats !== input.seats) {
          throw new StoreConflictError("The idempotency key was already used with different booking input.");
        }
        return booking;
      }

      const productResult = await client.query<DbRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM experience_products
          WHERE provider_id=$1 AND id=$2 AND status='PUBLISHED' FOR SHARE`,
        [scope.providerId, input.productId],
      );
      const product = productFromRow(oneRow(productResult.rows, "published product"));
      const occurrence = await this.#materializeAndLockOccurrence(client, scope, input.productId, input.occurrenceId);
      const nowResult = await client.query<DbRow>("SELECT clock_timestamp() AS now");
      const nowUtc = isoValue(oneRow(nowResult.rows, "database time"), "now");
      const inventory = await evaluateStoredInventory(client, scope.providerId, input.productId, occurrence, nowUtc, input.seats);
      if (!inventory.availability.bookable) {
        throw new BookingUnavailableError(inventory.availability.reason, inventory.availability.availableSeats);
      }

      const snapshots = buildSnapshots(occurrence, input.seats, nowUtc, product);
      const publicBookingId = randomUUID();
      const inserted = await client.query<DbRow>(
        `INSERT INTO bookings (
           public_booking_id, provider_id, product_id, occurrence_id, status, seats,
           idempotency_key, hold_expires_at, occurrence_snapshot, pricing_snapshot, seller_snapshot
         ) VALUES (
           $1,$2,$3,$4,'HOLD',$5,$6,clock_timestamp()+($7*interval '1 second'),$8::jsonb,$9::jsonb,$10::jsonb
         ) RETURNING id, ${BOOKING_COLUMNS}`,
        [
          publicBookingId,
          scope.providerId,
          input.productId,
          occurrence.id,
          input.seats,
          input.idempotencyKey,
          holdSeconds,
          JSON.stringify(snapshots.occurrenceSnapshot),
          JSON.stringify(snapshots.pricingSnapshot),
          JSON.stringify(snapshots.sellerSnapshot),
        ],
      );
      const insertedRow = oneRow(inserted.rows, "booking hold");
      const booking = bookingFromRow(insertedRow);
      await persistBookingInventorySnapshot(client, {
        providerId: scope.providerId,
        bookingId: Number(insertedRow.id),
        occurrence,
        bookingMode: inventory.bookingMode,
        occupancies: inventory.occupancies,
      });
      await enqueueCalendarRecalculation(client, {
        providerId: scope.providerId, aggregateType: "schedule_occurrence", aggregateId: occurrence.id, cause: "booking_hold_created",
      });
      await enqueueCalendarRecalculation(client, {
        providerId: scope.providerId, aggregateType: "schedule_occurrence", aggregateId: occurrence.id,
        cause: "booking_hold_expired", availableAtUtc: booking.holdExpiresAtUtc,
      });
      return booking;
    });
  }

  async confirmBookingPayment(scope: ProviderScope, input: ConfirmBookingInput): Promise<ConfirmBookingResult> {
    validateScope(scope);
    assertNonEmptyText(input.publicBookingId, "publicBookingId", 64);
    assertNonEmptyText(input.connectedAccountId, "connectedAccountId", 256);
    assertNonEmptyText(input.stripePaymentRef, "stripePaymentRef", 256);
    assertNonEmptyText(input.stripeEventId, "stripeEventId", 256);
    assertNonEmptyText(input.stripeEventType, "stripeEventType", 256);
    assertCanonicalInstant(input.eventOccurredAtUtc, "eventOccurredAtUtc");
    assertMoney(input.amount, "amount");
    if (input.amount === 0) throw new StoreValidationError("A Stripe payment amount must be greater than zero.");
    const currency = normalizeCurrency(input.currency);

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, scope.providerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [input.stripeEventId]);
      const initial = await client.query<DbRow>(
        `SELECT id, occurrence_id FROM bookings WHERE provider_id=$1 AND public_booking_id=$2::uuid`,
        [scope.providerId, input.publicBookingId],
      );
      const initialRow = initial.rows[0];
      if (initialRow === undefined) throw new StoreNotFoundError("booking");
      await client.query(
        `SELECT occurrence_id FROM schedule_occurrences
          WHERE provider_id=$1 AND occurrence_id=$2 FOR UPDATE`,
        [scope.providerId, initialRow.occurrence_id],
      );
      const bookingResult = await client.query<DbRow>(
        `SELECT id, ${BOOKING_COLUMNS} FROM bookings
          WHERE provider_id=$1 AND public_booking_id=$2::uuid FOR UPDATE`,
        [scope.providerId, input.publicBookingId],
      );
      const bookingRow = oneRow(bookingResult.rows, "booking");
      const booking = bookingFromRow(bookingRow);
      if (booking.sellerSnapshot.stripeConnectAccountRef !== input.connectedAccountId) {
        throw new StoreConflictError("Stripe event account does not match the booking seller snapshot.");
      }

      const existingEvent = await client.query<DbRow>(
        `SELECT event_id FROM stripe_webhook_events
          WHERE event_id=$1 AND provider_id=$2 AND booking_id=$3`,
        [input.stripeEventId, scope.providerId, bookingRow.id],
      );
      if (existingEvent.rows[0] !== undefined) return { booking, duplicateEvent: true };

      const nowResult = await client.query<DbRow>("SELECT clock_timestamp() AS now");
      const nowUtc = isoValue(oneRow(nowResult.rows, "database time"), "now");
      const samePayment = booking.stripePaymentRef === undefined || booking.stripePaymentRef === input.stripePaymentRef;
      if (!samePayment) throw new StoreConflictError("The booking already references a different Stripe payment.");

      let outcome: "CONFIRMED" | "PAYMENT_REVIEW" | "DUPLICATE";
      if (booking.stripePaymentRef !== undefined) {
        outcome = "DUPLICATE";
      } else {
        const pricing = booking.pricingSnapshot;
        const paymentMatches = pricing.totalAmount === input.amount && pricing.currency === currency;
        const holdIsActive = booking.status === "HOLD" && booking.holdExpiresAtUtc > nowUtc;
        outcome = holdIsActive && paymentMatches ? "CONFIRMED" : "PAYMENT_REVIEW";
      }

      const eventInsert = await client.query<DbRow>(
        `INSERT INTO stripe_webhook_events
           (event_id, provider_id, event_type, booking_id, occurred_at, outcome)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [input.stripeEventId, scope.providerId, input.stripeEventType, bookingRow.id, input.eventOccurredAtUtc, outcome],
      );
      if (eventInsert.rows[0] === undefined) {
        const scopedDuplicate = await client.query<DbRow>(
          `SELECT event_id FROM stripe_webhook_events
            WHERE event_id=$1 AND provider_id=$2 AND booking_id=$3`,
          [input.stripeEventId, scope.providerId, bookingRow.id],
        );
        if (scopedDuplicate.rows[0] === undefined) throw new StoreConflictError("Stripe event ID is already used outside this booking scope.");
        return { booking, duplicateEvent: true };
      }

      if (outcome === "DUPLICATE") return { booking, duplicateEvent: true };
      const updated = await client.query<DbRow>(
        `UPDATE bookings
            SET status=$3, stripe_payment_ref=$4,
                confirmed_at=CASE WHEN $3='CONFIRMED' THEN clock_timestamp() ELSE NULL END,
                updated_at=clock_timestamp()
          WHERE provider_id=$1 AND id=$2
          RETURNING ${BOOKING_COLUMNS}`,
        [scope.providerId, bookingRow.id, outcome, input.stripePaymentRef],
      );
      const updatedBooking = bookingFromRow(oneRow(updated.rows, "booking"));
      await client.query(
        `INSERT INTO payment_ledger_entries
           (provider_id, entry_id, booking_id, kind, amount, currency, stripe_payment_ref, stripe_event_id, occurred_at)
         VALUES ($1,$2,$3,'PAYMENT_CAPTURED',$4,$5,$6,$2,$7)`,
        [scope.providerId, input.stripeEventId, bookingRow.id, input.amount, currency, input.stripePaymentRef, input.eventOccurredAtUtc],
      );
      await client.query(
        `INSERT INTO outbox_messages
           (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
         VALUES ($1,'booking',$2,$3,$4,$5::jsonb)`,
        [
          scope.providerId,
          updatedBooking.publicBookingId,
          outcome === "CONFIRMED" ? "booking.confirmed" : "booking.payment_review_required",
          input.stripeEventId,
          JSON.stringify({ publicBookingId: updatedBooking.publicBookingId, providerId: scope.providerId, outcome }),
        ],
      );
      await enqueueCalendarRecalculation(client, {
        providerId: scope.providerId,
        aggregateType: "schedule_occurrence",
        aggregateId: updatedBooking.occurrenceId,
        cause: outcome === "CONFIRMED" ? "booking_confirmed" : "booking_payment_review",
      });
      return { booking: updatedBooking, duplicateEvent: false };
    });
  }

  async getBooking(actor: HostActor, publicBookingId: string): Promise<BookingRecord> {
    validateActor(actor);
    assertNonEmptyText(publicBookingId, "publicBookingId", 64);
    const result = await this.#pool.query<DbRow>(
      `SELECT ${BOOKING_COLUMNS}
         FROM bookings b
        WHERE b.provider_id=$1 AND b.public_booking_id=$3::uuid
          AND EXISTS (
            SELECT 1 FROM provider_memberships m
             WHERE m.provider_id=b.provider_id AND m.niho_user_id=$2 AND m.active=true
          )`,
      [actor.providerId, actor.nihoUserId, publicBookingId],
    );
    return bookingFromRow(oneRow(result.rows, "booking"));
  }

  async releaseExpiredHolds(scope: ProviderScope, limit = 500): Promise<number> {
    validateScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new StoreValidationError("limit must be from 1 to 5000.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, scope.providerId);
      const result = await client.query<DbRow>(
        `WITH expired AS (
           SELECT id FROM bookings
            WHERE provider_id=$1 AND status='HOLD' AND hold_expires_at <= clock_timestamp()
            ORDER BY hold_expires_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE bookings b SET status='EXPIRED', updated_at=clock_timestamp()
          FROM expired e WHERE b.provider_id=$1 AND b.id=e.id
         RETURNING b.occurrence_id`,
        [scope.providerId, limit],
      );
      for (const occurrenceId of new Set(result.rows.map((row) => String(row.occurrence_id)))) {
        await enqueueCalendarRecalculation(client, {
          providerId: scope.providerId, aggregateType: "schedule_occurrence", aggregateId: occurrenceId, cause: "booking_hold_released",
        });
      }
      return result.rowCount ?? 0;
    });
  }

  async #requireAdminProvider(client: PoolClient, providerId: string): Promise<void> {
    const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1 FOR SHARE", [providerId]);
    if (!provider.rows[0]) throw new StoreNotFoundError("provider");
  }

  async #listInventoryResources(providerId: string, client: Pool | PoolClient = this.#pool): Promise<readonly InventoryResourceRecord[]> {
    const result = await client.query<DbRow>(
      `SELECT provider_id,id,kind,display_name,active,version,created_at,updated_at
         FROM inventory_resources WHERE provider_id=$1 ORDER BY id COLLATE "C"`, [providerId],
    );
    return result.rows.map((row) => ({
      providerId: String(row.provider_id), id: String(row.id), kind: String(row.kind) as InventoryResourceRecord["kind"],
      displayName: String(row.display_name), active: row.active === true, version: Number(row.version),
      createdAtUtc: isoValue(row, "created_at"), updatedAtUtc: isoValue(row, "updated_at"),
    }));
  }

  async #saveInventoryResource(
    providerId: string,
    input: InventoryResourceInput,
    expectedVersion: number | null,
    commandId: string,
    requestFingerprint: string,
    authorize: (client: PoolClient) => Promise<unknown>,
  ): Promise<CalendarCommandReceipt> {
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await authorize(client);
      const previous = await previousCalendarCommand(client, providerId, commandId, "inventory_resource.save", requestFingerprint);
      if (previous) return previous;
      const current = await client.query<DbRow>(
        "SELECT kind,display_name,active,version FROM inventory_resources WHERE provider_id=$1 AND id=$2 FOR UPDATE",
        [providerId, input.id],
      );
      const row = current.rows[0];
      if (row === undefined && expectedVersion !== null) throw new StoreConflictError("Inventory resource was not found.");
      if (row !== undefined && (expectedVersion === null || Number(row.version) !== expectedVersion)) throw new StoreConflictError("Inventory resource version mismatch.");
      if (row !== undefined && row.kind !== input.kind) throw new StoreConflictError("Inventory resource kind is immutable.");
      const saved = row === undefined
        ? await client.query<DbRow>(
            `INSERT INTO inventory_resources (provider_id,id,kind,display_name,active)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING provider_id,id,kind,display_name,active,version,created_at,updated_at`,
            [providerId, input.id, input.kind, input.displayName, input.active],
          )
        : await client.query<DbRow>(
            `UPDATE inventory_resources SET display_name=$3,active=$4,version=version+1,updated_at=clock_timestamp()
              WHERE provider_id=$1 AND id=$2
              RETURNING provider_id,id,kind,display_name,active,version,created_at,updated_at`,
            [providerId, input.id, input.displayName, input.active],
          );
      const savedRow = oneRow(saved.rows, "inventory resource");
      return completeCalendarCommand(client, providerId, commandId, "inventory_resource.save", requestFingerprint,
        "inventory_resource", { aggregateId: input.id, version: Number(savedRow.version), repeated: false });
    });
  }

  async #saveProductInventorySetting(
    providerId: string,
    productId: string,
    normalized: ProductInventorySettingInput,
    expectedVersion: number | null,
    commandId: string,
    requestFingerprint: string,
    authorize: (client: PoolClient) => Promise<unknown>,
  ): Promise<CalendarCommandReceipt> {
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await authorize(client);
      const previous = await previousCalendarCommand(client, providerId, commandId, "product_inventory.save", requestFingerprint);
      if (previous) return previous;
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE", [providerId, productId]);
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const active = await client.query(
        `SELECT 1 FROM bookings WHERE provider_id=$1 AND product_id=$2
          AND (occurrence_snapshot->>'endUtc')::timestamptz>clock_timestamp()
          AND (status='CONFIRMED' OR (status='HOLD' AND hold_expires_at>clock_timestamp()))
         UNION ALL
         SELECT 1 FROM external_reservations WHERE provider_id=$1 AND (
          (product_id=$2 AND source_end_at>clock_timestamp() AND status IN ('PENDING','CONFIRMED'))
          OR (needs_review=true AND review_reason IN ('TARGET_MISMATCH','CONFLICTING_SOURCE_VERSION'))) LIMIT 1`,
        [providerId, productId],
      );
      if (active.rows[0]) throw new StoreConflictError("Product inventory cannot change while an active hold or confirmed booking exists.");
      const current = await client.query<DbRow>(
        "SELECT version FROM product_inventory_settings WHERE provider_id=$1 AND product_id=$2 FOR UPDATE", [providerId, productId],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined && expectedVersion !== null) throw new StoreConflictError("Product inventory setting was not found.");
      if (currentRow !== undefined && (expectedVersion === null || Number(currentRow.version) !== expectedVersion)) throw new StoreConflictError("Product inventory setting version mismatch.");
      if (normalized.resources.length > 0) {
        const owned = await client.query<{ id: string }>(
          "SELECT id FROM inventory_resources WHERE provider_id=$1 AND id=ANY($2::text[]) FOR SHARE",
          [providerId, normalized.resources.map((item) => item.resourceId)],
        );
        if (owned.rowCount !== normalized.resources.length) throw new StoreConflictError("Every assigned resource must belong to the same provider.");
      }
      const version = currentRow === undefined ? 1 : Number(currentRow.version) + 1;
      if (currentRow === undefined) {
        await client.query("INSERT INTO product_inventory_settings (provider_id,product_id,booking_mode) VALUES ($1,$2,$3)",
          [providerId, productId, normalized.bookingMode]);
      } else {
        await client.query(
          "UPDATE product_inventory_settings SET booking_mode=$3,version=version+1,updated_at=clock_timestamp() WHERE provider_id=$1 AND product_id=$2",
          [providerId, productId, normalized.bookingMode],
        );
        await client.query("DELETE FROM product_inventory_resources WHERE provider_id=$1 AND product_id=$2", [providerId, productId]);
      }
      for (const assignment of normalized.resources) {
        await client.query(
          `INSERT INTO product_inventory_resources (provider_id,product_id,resource_id,prepare_minutes,cleanup_minutes)
           VALUES ($1,$2,$3,$4,$5)`,
          [providerId, productId, assignment.resourceId, assignment.prepareMinutes, assignment.cleanupMinutes],
        );
      }
      return completeCalendarCommand(client, providerId, commandId, "product_inventory.save", requestFingerprint,
        "product_inventory", { aggregateId: productId, version, repeated: false });
    });
  }

  async #productInventorySetting(client: Pool | PoolClient, providerId: string, productId: string): Promise<ProductInventorySetting> {
    const setting = await client.query<DbRow>(
      "SELECT booking_mode,version FROM product_inventory_settings WHERE provider_id=$1 AND product_id=$2",
      [providerId, productId],
    );
    const row = oneRow(setting.rows, "product inventory setting");
    const resources = await client.query<DbRow>(
      `SELECT resource_id,prepare_minutes,cleanup_minutes FROM product_inventory_resources
        WHERE provider_id=$1 AND product_id=$2 ORDER BY resource_id COLLATE "C"`,
      [providerId, productId],
    );
    return {
      providerId,
      productId,
      bookingMode: String(row.booking_mode) as BookingMode,
      version: Number(row.version),
      resources: resources.rows.map((item) => ({
        resourceId: String(item.resource_id),
        prepareMinutes: Number(item.prepare_minutes),
        cleanupMinutes: Number(item.cleanup_minutes),
      })),
    };
  }

  async #assertScheduleHasNoFutureReservations(client: PoolClient, providerId: string, ruleId: string): Promise<void> {
    const result = await client.query<DbRow>(
      `SELECT 1 FROM schedule_occurrences o
         JOIN bookings b ON b.provider_id=o.provider_id AND b.occurrence_id=o.occurrence_id
        WHERE o.provider_id=$1 AND o.rule_id=$2 AND o.end_at > clock_timestamp()
          AND (b.status='CONFIRMED' OR (b.status='HOLD' AND b.hold_expires_at > clock_timestamp()))
       UNION ALL
       SELECT 1 FROM external_reservations e
        WHERE e.provider_id=$1 AND (
          (split_part(e.occurrence_id,'@',1)=$3 AND e.source_end_at > clock_timestamp() AND e.status IN ('PENDING','CONFIRMED'))
          OR (e.needs_review=true AND e.review_reason IN ('TARGET_MISMATCH','CONFLICTING_SOURCE_VERSION')))
        LIMIT 1`,
      [providerId, ruleId, encodeURIComponent(ruleId)],
    );
    if (result.rows[0] !== undefined) {
      throw new StoreConflictError("A schedule with active holds or future confirmed bookings cannot be changed.");
    }
  }

  async #assertOccurrenceHasNoReservations(client: PoolClient, providerId: string, occurrenceId: string): Promise<void> {
    const result = await client.query<DbRow>(
      `SELECT 1 FROM bookings
        WHERE provider_id=$1 AND occurrence_id=$2
          AND (status='CONFIRMED' OR (status='HOLD' AND hold_expires_at > clock_timestamp()))
       UNION ALL
       SELECT 1 FROM external_reservations
        WHERE provider_id=$1 AND ((occurrence_id=$2 AND status IN ('PENDING','CONFIRMED'))
          OR (needs_review=true AND review_reason IN ('TARGET_MISMATCH','CONFLICTING_SOURCE_VERSION')))
        LIMIT 1`,
      [providerId, occurrenceId],
    );
    if (result.rows[0] !== undefined) {
      throw new StoreConflictError("An occurrence with an active hold or confirmed booking cannot be changed.");
    }
  }

  async #materializeAndLockOccurrence(
    client: PoolClient,
    scope: ProviderScope,
    productId: string,
    occurrenceId: string,
  ): Promise<Occurrence> {
    const marker = occurrenceId.lastIndexOf("@");
    if (marker < 1) throw new StoreValidationError("occurrenceId is invalid.");
    let ruleId: string;
    try {
      ruleId = decodeURIComponent(occurrenceId.slice(0, marker));
    } catch (error) {
      throw new StoreValidationError("occurrenceId is invalid.", { cause: error });
    }
    const ruleResult = await client.query<DbRow>(
      `SELECT ${RULE_COLUMNS} FROM schedule_rules
        WHERE provider_id=$1 AND product_id=$2 AND id=$3 FOR SHARE`,
      [scope.providerId, productId, ruleId],
    );
    const storedRule = scheduleRuleFromRow(oneRow(ruleResult.rows, "schedule rule"));
    const overrideResult = await client.query<DbRow>(
      `SELECT ${OVERRIDE_COLUMNS} FROM schedule_occurrence_overrides
        WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3`,
      [scope.providerId, ruleId, occurrenceId],
    );
    const storedOverride = overrideResult.rows[0] === undefined ? undefined : overrideFromRow(overrideResult.rows[0]).override;
    const salesStateResult = await client.query<DbRow>(
      `SELECT ${SALES_STATE_COLUMNS} FROM schedule_occurrence_sales_states
        WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3`,
      [scope.providerId, ruleId, occurrenceId],
    );
    const storedSalesState = salesStateResult.rows[0] === undefined ? undefined : salesStateFromRow(salesStateResult.rows[0]).state;
    const occurrence = occurrenceForSource(storedRule.rule, storedOverride, storedSalesState, occurrenceId);
    await client.query(
      `INSERT INTO schedule_occurrences (
         provider_id, occurrence_id, product_id, rule_id, source_local_date, local_date,
         local_start_time, time_zone, start_at, end_at, duration_minutes, capacity,
         booking_cutoff_minutes, busy_buffer_before_minutes, busy_buffer_after_minutes,
         status, rescheduled, schedule_rule_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (provider_id, occurrence_id) DO UPDATE SET
         product_id=EXCLUDED.product_id, rule_id=EXCLUDED.rule_id,
         source_local_date=EXCLUDED.source_local_date, local_date=EXCLUDED.local_date,
         local_start_time=EXCLUDED.local_start_time, time_zone=EXCLUDED.time_zone,
         start_at=EXCLUDED.start_at, end_at=EXCLUDED.end_at,
         duration_minutes=EXCLUDED.duration_minutes, capacity=EXCLUDED.capacity,
         booking_cutoff_minutes=EXCLUDED.booking_cutoff_minutes,
         busy_buffer_before_minutes=EXCLUDED.busy_buffer_before_minutes,
         busy_buffer_after_minutes=EXCLUDED.busy_buffer_after_minutes,
         status=EXCLUDED.status, rescheduled=EXCLUDED.rescheduled,
         schedule_rule_version=EXCLUDED.schedule_rule_version, updated_at=clock_timestamp()`,
      [
        scope.providerId,
        occurrence.id,
        productId,
        occurrence.ruleId,
        occurrence.sourceLocalDate,
        occurrence.localDate,
        occurrence.localStartTime,
        occurrence.timeZone,
        occurrence.startUtc,
        occurrence.endUtc,
        occurrence.durationMinutes,
        occurrence.capacity,
        occurrence.bookingCutoffMinutes,
        occurrence.busyBufferBeforeMinutes,
        occurrence.busyBufferAfterMinutes,
        occurrence.status,
        occurrence.rescheduled,
        storedRule.version,
      ],
    );
    await client.query(
      "SELECT occurrence_id FROM schedule_occurrences WHERE provider_id=$1 AND occurrence_id=$2 FOR UPDATE",
      [scope.providerId, occurrence.id],
    );
    return occurrence;
  }

}
