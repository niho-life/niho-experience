import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  addLocalDays,
  addMinutes,
  evaluateAvailability,
  expandOccurrences,
  type BusyInterval,
  type Occurrence,
  type OccurrenceOverride,
  type OccurrenceSalesState,
} from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { googleCalendarFromRow, isoValue, overrideFromRow, salesStateFromRow, scheduleRuleFromRow, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertCanonicalInstant, assertNonEmptyText, assertStoreIdentifier, effectiveGoogleSyncStatus } from "./validation.ts";

export const CHANNEL_SITES = [
  "Airbnb", "GetYourGuide", "Viator", "Klook", "Jalan", "Asoview", "ActivityJapan", "Rezio", "Reddy",
] as const;
export type ChannelSite = typeof CHANNEL_SITES[number] | (string & {});
export type ChannelConnectionMode = "BROWSER" | "GOOGLE" | "API";
export type ChannelAction = "SET_OPEN" | "SET_CLOSED" | "OBSERVE";
export type ChannelDesiredState = "OPEN" | "CLOSED";
export type ChannelOutcome = "VERIFIED" | "AUTH_REQUIRED" | "NEEDS_REVIEW" | "UNKNOWN_AFTER_SAVE" | "RETRY_WAIT" | "SUPERSEDED";

/**
 * This actor must be built only after the HTTP boundary has authenticated a current NIHO Admin.
 * Submitted user IDs, provider IDs, cookies, and role strings are never actor evidence.
 */
export interface ChannelAdminActor { readonly nihoUserId: string }

export interface ChannelCapabilities {
  readonly canObserve?: boolean;
  readonly canClose?: boolean;
  readonly canOpen?: boolean;
  readonly canCreate?: boolean;
}

export interface ExternalAccountInput {
  readonly id: string;
  readonly providerId: string;
  readonly site: ChannelSite;
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly operatingModel: 1 | 2 | 3 | 4;
  readonly active?: boolean;
  readonly delegatedUntilUtc?: string;
  readonly revokedAtUtc?: string;
  /** Opaque Secret Manager/profile reference. Never included in read DTOs. */
  readonly privateProfileRef?: string;
}

export interface ExternalAccountUpdate {
  readonly displayName: string;
  readonly operatingModel: 1 | 2 | 3 | 4;
  readonly active: boolean;
  readonly delegatedUntilUtc?: string;
  readonly revokedAtUtc?: string;
  readonly privateProfileRef?: string;
}

export interface ExternalAccountDto {
  readonly id: string;
  readonly providerId: string;
  readonly site: string;
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly operatingModel: 1 | 2 | 3 | 4;
  readonly active: boolean;
  readonly delegatedUntilUtc?: string;
  readonly revokedAtUtc?: string;
  readonly version: number;
  readonly quarantined: boolean;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface ChannelListingInput {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly productId: string;
  readonly externalProductId: string;
  readonly externalOptionId?: string;
  readonly timeZone?: "Asia/Tokyo";
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly connectionMode: ChannelConnectionMode;
  readonly capabilities?: ChannelCapabilities;
  readonly active?: boolean;
}

export interface ChannelListingUpdate {
  readonly externalProductId: string;
  readonly externalOptionId?: string;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly connectionMode: ChannelConnectionMode;
  readonly capabilities: ChannelCapabilities;
  readonly active: boolean;
}

export interface ChannelListingDto {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly productId: string;
  readonly externalProductId: string;
  readonly externalOptionId?: string;
  readonly timeZone: "Asia/Tokyo";
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly connectionMode: ChannelConnectionMode;
  readonly capabilities: Required<ChannelCapabilities>;
  readonly active: boolean;
  readonly mappingVersion: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface WorkerCredential {
  readonly workerId: string;
  /** Returned exactly once. The database stores only its SHA-256 digest. */
  readonly bearerToken: string;
  readonly expiresAtUtc: string;
}

export interface WorkerIdentity { readonly workerId: string; readonly credentialVersion: number }

export interface ChannelTarget {
  readonly site: string;
  readonly externalAccountId: string;
  readonly externalProductId: string;
  readonly externalOptionId?: string;
  readonly timeZone: "Asia/Tokyo";
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly connectionMode: ChannelConnectionMode;
}

export interface ClaimedChannelJob {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtUtc: string;
  readonly deadlineAtUtc: string;
  readonly action: ChannelAction;
  readonly occurrenceId: string;
  readonly desiredVersion: number;
  readonly mappingVersion: number;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly target: ChannelTarget;
}

export interface ChannelResultInput {
  readonly resultId: string;
  readonly leaseToken: string;
  readonly outcome: ChannelOutcome;
  readonly stopped: boolean;
  readonly target: ChannelTarget;
  readonly occurrenceId?: string;
  readonly sourceStartAtUtc?: string;
  readonly sourceEndAtUtc?: string;
  readonly observedState?: ChannelDesiredState;
  /** Actual customer bookability. This is distinct from the site's manual block control. */
  readonly observedBookable?: boolean;
  readonly observedManuallyBlocked?: boolean;
  readonly observedAtUtc?: string;
}

export interface HostChannelStatus {
  readonly occurrenceId: string;
  readonly site: string;
  readonly desired: ChannelDesiredState;
  readonly observed?: ChannelDesiredState;
  readonly label: "SYNCED" | "PENDING" | "ERROR" | "UNVERIFIED";
  readonly lastVerifiedAtUtc?: string;
  readonly error?: string;
}

export interface ChannelRuntimeOptions {
  readonly now?: () => Date;
  /** Adapter keys explicitly accepted by deployment, e.g. `Airbnb/browser-v1@1`. Empty means all capabilities stay false. */
  readonly supportedAdapters?: Readonly<Record<string, ChannelCapabilities>>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RULE_COLUMNS = `provider_id,id,product_id,time_zone,starts_on::text AS starts_on,ends_on::text AS ends_on,
  to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,capacity,booking_cutoff_minutes,
  busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence,version`;
const ACCOUNT_COLUMNS = `id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until,
  revoked_at,version,quarantined_at,created_at,updated_at`;
const LISTING_COLUMNS = `id,provider_id,account_id,product_id,external_product_id,external_option_id,time_zone,adapter,
  adapter_version,connection_mode,can_observe,can_close,can_open,can_create,active,mapping_version,created_at,updated_at`;

interface DispatchCursor { readonly listingId: string; readonly ruleId: string; readonly occurrenceId: string }
interface DispatchPage { readonly fromDate: string; readonly toDate: string; readonly after?: DispatchCursor }

function integer(row: DbRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new StoreConflictError(`Database returned an invalid ${key}.`);
  return value;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreConflictError(`Database returned an invalid ${key}.`);
  return value;
}

function optionalIso(row: DbRow, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : isoValue(row, key);
}

function assertUuid(value: string, path: string): void {
  if (!UUID_V4.test(value)) throw new StoreValidationError(`${path} must be a UUID v4.`);
}

function fingerprint(value: unknown): string {
  return digest(JSON.stringify(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureDigestMatch(expectedHex: string, raw: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(digest(raw), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function accountDto(row: DbRow): ExternalAccountDto {
  const delegatedUntilUtc = optionalIso(row, "delegated_until");
  const revokedAtUtc = optionalIso(row, "revoked_at");
  return {
    id: text(row, "id"), providerId: text(row, "provider_id"), site: text(row, "site"),
    externalAccountId: text(row, "external_account_id"), displayName: text(row, "display_name"),
    operatingModel: integer(row, "operating_model") as 1 | 2 | 3 | 4, active: row.active === true,
    ...(delegatedUntilUtc === undefined ? {} : { delegatedUntilUtc }), ...(revokedAtUtc === undefined ? {} : { revokedAtUtc }),
    version: integer(row, "version"), quarantined: row.quarantined_at !== null,
    createdAtUtc: isoValue(row, "created_at"), updatedAtUtc: isoValue(row, "updated_at"),
  };
}

function listingDto(row: DbRow): ChannelListingDto {
  const option = text(row, "external_option_id");
  return {
    id: text(row, "id"), providerId: text(row, "provider_id"), accountId: text(row, "account_id"),
    productId: text(row, "product_id"), externalProductId: text(row, "external_product_id"),
    ...(option === "" ? {} : { externalOptionId: option }), timeZone: "Asia/Tokyo",
    adapter: text(row, "adapter"), adapterVersion: text(row, "adapter_version"),
    connectionMode: text(row, "connection_mode") as ChannelConnectionMode,
    capabilities: { canObserve: row.can_observe === true, canClose: row.can_close === true, canOpen: row.can_open === true, canCreate: row.can_create === true },
    active: row.active === true, mappingVersion: integer(row, "mapping_version"),
    createdAtUtc: isoValue(row, "created_at"), updatedAtUtc: isoValue(row, "updated_at"),
  };
}

function validateAccount(input: ExternalAccountInput | (ExternalAccountUpdate & { id: string; providerId: string; site: string; externalAccountId: string })): void {
  assertStoreIdentifier(input.id, "account.id");
  assertStoreIdentifier(input.providerId, "account.providerId");
  assertNonEmptyText(input.site, "account.site", 80);
  assertNonEmptyText(input.externalAccountId, "account.externalAccountId", 256);
  assertNonEmptyText(input.displayName, "account.displayName", 300);
  if (![1, 2, 3, 4].includes(input.operatingModel)) throw new StoreValidationError("account.operatingModel is invalid.");
  if (input.delegatedUntilUtc) assertCanonicalInstant(input.delegatedUntilUtc, "account.delegatedUntilUtc");
  if (input.revokedAtUtc) assertCanonicalInstant(input.revokedAtUtc, "account.revokedAtUtc");
  if (input.privateProfileRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(input.privateProfileRef)) {
    throw new StoreValidationError("account.privateProfileRef must be an opaque reference, not a path or credential value.");
  }
}

function tokyoDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function targetFromRow(row: DbRow): ChannelTarget {
  const option = text(row, "target_external_option_id");
  return {
    site: text(row, "target_site"), externalAccountId: text(row, "target_external_account_id"),
    externalProductId: text(row, "target_external_product_id"), ...(option === "" ? {} : { externalOptionId: option }),
    timeZone: "Asia/Tokyo", adapter: text(row, "target_adapter"), adapterVersion: text(row, "target_adapter_version"),
    connectionMode: text(row, "target_connection_mode") as ChannelConnectionMode,
  };
}

function targetEqual(left: ChannelTarget, right: ChannelTarget): boolean {
  return left.site === right.site && left.externalAccountId === right.externalAccountId
    && left.externalProductId === right.externalProductId && (left.externalOptionId ?? "") === (right.externalOptionId ?? "")
    && left.timeZone === right.timeZone && left.adapter === right.adapter && left.adapterVersion === right.adapterVersion
    && left.connectionMode === right.connectionMode;
}

export function channelReadbackAccepted(input: {
  readonly action: ChannelAction;
  readonly expectedTarget: ChannelTarget;
  readonly resultTarget: ChannelTarget;
  readonly outcome: ChannelOutcome;
  readonly stopped: boolean;
  readonly withinLease: boolean;
  readonly versionsCurrent: boolean;
  readonly occurrenceMatches: boolean;
  readonly observationTimeValid: boolean;
  readonly observedState?: ChannelDesiredState;
  readonly observedBookable?: boolean;
  readonly observedManuallyBlocked?: boolean;
  readonly observedAtUtc?: string;
}): boolean {
  if (input.outcome !== "VERIFIED" || !input.stopped || !input.withinLease || !input.versionsCurrent
    || !input.occurrenceMatches || !input.observationTimeValid || !targetEqual(input.expectedTarget, input.resultTarget)
    || input.observedState === undefined || input.observedBookable === undefined
    || input.observedManuallyBlocked === undefined || input.observedAtUtc === undefined) return false;
  if (input.action === "SET_OPEN") {
    return input.observedState === "OPEN" && input.observedBookable && !input.observedManuallyBlocked;
  }
  if (input.action === "SET_CLOSED") {
    return input.observedState === "CLOSED" && !input.observedBookable && input.observedManuallyBlocked;
  }
  return input.observedManuallyBlocked ? !input.observedBookable : true;
}

function desiredAction(state: ChannelDesiredState): ChannelAction {
  return state === "CLOSED" ? "SET_CLOSED" : "SET_OPEN";
}

export class ChannelRuntime {
  readonly #pool: Pool;
  readonly #now: () => Date;
  readonly #supportedAdapters: Readonly<Record<string, ChannelCapabilities>>;

  constructor(pool: Pool, options: ChannelRuntimeOptions = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
    this.#supportedAdapters = options.supportedAdapters ?? {};
  }

  #nowIso(): string { return this.#now().toISOString(); }

  #validateActor(actor: ChannelAdminActor): void {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  }

  #capabilities(site: string, input: Pick<ChannelListingInput, "adapter" | "adapterVersion" | "capabilities">): Required<ChannelCapabilities> {
    const requested = { canObserve: input.capabilities?.canObserve === true, canClose: input.capabilities?.canClose === true, canOpen: input.capabilities?.canOpen === true, canCreate: input.capabilities?.canCreate === true };
    const supported = this.#supportedAdapters[`${site}/${input.adapter}@${input.adapterVersion}`] ?? {};
    for (const key of ["canObserve", "canClose", "canOpen", "canCreate"] as const) {
      if (requested[key] && supported[key] !== true) throw new StoreValidationError(`${key} is not enabled for this deployed adapter.`);
    }
    return requested;
  }

  #adapterSupports(row: DbRow, action: ChannelAction): boolean {
    const supported = this.#supportedAdapters[`${text(row, row.target_site === undefined ? "site" : "target_site")}/${text(row, row.target_adapter === undefined ? "adapter" : "target_adapter")}@${text(row, row.target_adapter_version === undefined ? "adapter_version" : "target_adapter_version")}`];
    if (!supported) return false;
    if (action === "SET_OPEN") return supported.canOpen === true;
    if (action === "SET_CLOSED") return supported.canClose === true;
    return supported.canObserve === true;
  }

  async #previousCommand(client: PoolClient, actor: ChannelAdminActor, commandId: string, action: string, request: string): Promise<Record<string, unknown> | null> {
    assertUuid(commandId, "commandId");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [commandId]);
    const result = await client.query<DbRow>("SELECT actor_niho_user_id,action,request_fingerprint,result FROM channel_admin_commands WHERE command_id=$1::uuid", [commandId]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.actor_niho_user_id !== actor.nihoUserId || row.action !== action || row.request_fingerprint !== request) {
      throw new StoreConflictError("The channel command ID was already used with different input.");
    }
    if (!row.result || typeof row.result !== "object" || Array.isArray(row.result)) throw new StoreConflictError("Channel command result is invalid.");
    return row.result as Record<string, unknown>;
  }

  async #completeCommand(client: PoolClient, actor: ChannelAdminActor, commandId: string, action: string, request: string, result: Record<string, unknown>, providerId?: string, resourceType?: string, resourceId?: string): Promise<void> {
    await client.query("INSERT INTO channel_admin_commands (command_id,actor_niho_user_id,action,request_fingerprint,result) VALUES ($1::uuid,$2,$3,$4,$5::jsonb)", [commandId, actor.nihoUserId, action, request, JSON.stringify(result)]);
    if (resourceType && resourceId) await client.query(
      "INSERT INTO channel_audit_events (actor_niho_user_id,provider_id,resource_type,resource_id,action,command_id) VALUES ($1,$2,$3,$4,$5,$6::uuid)",
      [actor.nihoUserId, providerId ?? null, resourceType, resourceId, action, commandId],
    );
  }

  async createExternalAccount(actor: ChannelAdminActor, input: ExternalAccountInput, commandId: string): Promise<ExternalAccountDto> {
    this.#validateActor(actor);
    validateAccount(input);
    const request = fingerprint(input);
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "account.create", request);
      if (previous) return this.#account(client, String(previous.id));
      const row = await client.query<DbRow>(
        `INSERT INTO channel_external_accounts
          (id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until,revoked_at,private_profile_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${ACCOUNT_COLUMNS}`,
        [input.id, input.providerId, input.site, input.externalAccountId, input.displayName, input.operatingModel,
          input.active ?? false, input.delegatedUntilUtc ?? null, input.revokedAtUtc ?? null, input.privateProfileRef ?? null],
      );
      const saved = accountDto(row.rows[0]!);
      await this.#completeCommand(client, actor, commandId, "account.create", request, { id: saved.id, version: saved.version }, saved.providerId, "external_account", saved.id);
      return saved;
    });
  }

  async updateExternalAccount(actor: ChannelAdminActor, accountId: string, input: ExternalAccountUpdate, expectedVersion: number, commandId: string): Promise<ExternalAccountDto> {
    this.#validateActor(actor);
    assertStoreIdentifier(accountId, "accountId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion is required.");
    const request = fingerprint({ accountId, input, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "account.update", request);
      if (previous) return this.#account(client, String(previous.id));
      const existing = await client.query<DbRow>("SELECT * FROM channel_external_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const current = existing.rows[0];
      if (!current) throw new StoreNotFoundError("external account");
      validateAccount({ ...input, id: accountId, providerId: text(current, "provider_id"), site: text(current, "site"), externalAccountId: text(current, "external_account_id") });
      if (integer(current, "version") !== expectedVersion) throw new StoreConflictError("External account version mismatch.");
      const updated = await client.query<DbRow>(
        `UPDATE channel_external_accounts SET display_name=$2,operating_model=$3,active=$4,delegated_until=$5,revoked_at=$6,
           private_profile_ref=$7,version=version+1,updated_at=$8 WHERE id=$1 RETURNING ${ACCOUNT_COLUMNS}`,
        [accountId, input.displayName, input.operatingModel, input.active, input.delegatedUntilUtc ?? null, input.revokedAtUtc ?? null, input.privateProfileRef ?? null, this.#nowIso()],
      );
      await client.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2 WHERE account_id=$1 AND status='QUEUED'", [accountId, this.#nowIso()]);
      const saved = accountDto(updated.rows[0]!);
      await this.#completeCommand(client, actor, commandId, "account.update", request, { id: saved.id, version: saved.version }, saved.providerId, "external_account", saved.id);
      return saved;
    });
  }

  async #account(client: PoolClient, accountId: string): Promise<ExternalAccountDto> {
    const result = await client.query<DbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM channel_external_accounts WHERE id=$1`, [accountId]);
    if (!result.rows[0]) throw new StoreNotFoundError("external account");
    return accountDto(result.rows[0]);
  }

  async listExternalAccounts(actor: ChannelAdminActor, providerId: string): Promise<readonly ExternalAccountDto[]> {
    this.#validateActor(actor);
    assertStoreIdentifier(providerId, "providerId");
    const result = await this.#pool.query<DbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM channel_external_accounts WHERE provider_id=$1 ORDER BY site,id`, [providerId]);
    return result.rows.map(accountDto);
  }

  async createListing(actor: ChannelAdminActor, input: ChannelListingInput, commandId: string): Promise<ChannelListingDto> {
    this.#validateActor(actor);
    this.#validateListing(input);
    const request = fingerprint(input);
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "listing.create", request);
      if (previous) return this.#listing(client, String(previous.id));
      const account = await client.query<DbRow>("SELECT site FROM channel_external_accounts WHERE id=$1 AND provider_id=$2 FOR SHARE", [input.accountId, input.providerId]);
      if (!account.rows[0]) throw new StoreNotFoundError("external account");
      const capabilities = this.#capabilities(text(account.rows[0], "site"), input);
      const saved = await client.query<DbRow>(
        `INSERT INTO channel_listings
          (id,provider_id,account_id,product_id,external_product_id,external_option_id,time_zone,adapter,adapter_version,connection_mode,
           can_observe,can_close,can_open,can_create,active)
         VALUES ($1,$2,$3,$4,$5,$6,'Asia/Tokyo',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${LISTING_COLUMNS}`,
        [input.id, input.providerId, input.accountId, input.productId, input.externalProductId, input.externalOptionId ?? "",
          input.adapter, input.adapterVersion, input.connectionMode, capabilities.canObserve, capabilities.canClose, capabilities.canOpen, capabilities.canCreate, input.active ?? false],
      );
      const dto = listingDto(saved.rows[0]!);
      await this.#completeCommand(client, actor, commandId, "listing.create", request, { id: dto.id, version: dto.mappingVersion }, dto.providerId, "listing", dto.id);
      return dto;
    });
  }

  async updateListing(actor: ChannelAdminActor, listingId: string, input: ChannelListingUpdate, expectedVersion: number, commandId: string): Promise<ChannelListingDto> {
    this.#validateActor(actor);
    assertStoreIdentifier(listingId, "listingId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion is required.");
    const request = fingerprint({ listingId, input, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "listing.update", request);
      if (previous) return this.#listing(client, String(previous.id));
      const currentResult = await client.query<DbRow>(
        `SELECT l.*,a.site FROM channel_listings l JOIN channel_external_accounts a ON a.id=l.account_id WHERE l.id=$1 FOR UPDATE OF l`, [listingId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new StoreNotFoundError("channel listing");
      this.#validateListing({ ...input, id: listingId, providerId: text(current, "provider_id"), accountId: text(current, "account_id"), productId: text(current, "product_id") });
      if (integer(current, "mapping_version") !== expectedVersion) throw new StoreConflictError("Listing mapping version mismatch.");
      const capabilities = this.#capabilities(text(current, "site"), input);
      const updated = await client.query<DbRow>(
        `UPDATE channel_listings SET external_product_id=$2,external_option_id=$3,adapter=$4,adapter_version=$5,connection_mode=$6,
           can_observe=$7,can_close=$8,can_open=$9,can_create=$10,active=$11,mapping_version=mapping_version+1,updated_at=$12
         WHERE id=$1 RETURNING ${LISTING_COLUMNS}`,
        [listingId, input.externalProductId, input.externalOptionId ?? "", input.adapter, input.adapterVersion, input.connectionMode,
          capabilities.canObserve, capabilities.canClose, capabilities.canOpen, capabilities.canCreate, input.active, this.#nowIso()],
      );
      await client.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2 WHERE listing_id=$1 AND status='QUEUED'", [listingId, this.#nowIso()]);
      const dto = listingDto(updated.rows[0]!);
      await this.#completeCommand(client, actor, commandId, "listing.update", request, { id: dto.id, version: dto.mappingVersion }, dto.providerId, "listing", dto.id);
      return dto;
    });
  }

  #validateListing(input: ChannelListingInput): void {
    assertStoreIdentifier(input.id, "listing.id");
    assertStoreIdentifier(input.providerId, "listing.providerId");
    assertStoreIdentifier(input.accountId, "listing.accountId");
    assertStoreIdentifier(input.productId, "listing.productId");
    assertNonEmptyText(input.externalProductId, "listing.externalProductId", 256);
    if ((input.externalOptionId ?? "").length > 256) throw new StoreValidationError("listing.externalOptionId is too long.");
    if ((input.timeZone ?? "Asia/Tokyo") !== "Asia/Tokyo") throw new StoreValidationError("listing.timeZone must be Asia/Tokyo.");
    assertNonEmptyText(input.adapter, "listing.adapter", 120);
    assertNonEmptyText(input.adapterVersion, "listing.adapterVersion", 80);
    if (!(["BROWSER", "GOOGLE", "API"] as const).includes(input.connectionMode)) throw new StoreValidationError("listing.connectionMode is invalid.");
  }

  async #listing(client: PoolClient, listingId: string): Promise<ChannelListingDto> {
    const result = await client.query<DbRow>(`SELECT ${LISTING_COLUMNS} FROM channel_listings WHERE id=$1`, [listingId]);
    if (!result.rows[0]) throw new StoreNotFoundError("channel listing");
    return listingDto(result.rows[0]);
  }

  async listListings(actor: ChannelAdminActor, providerId: string): Promise<readonly ChannelListingDto[]> {
    this.#validateActor(actor);
    assertStoreIdentifier(providerId, "providerId");
    const result = await this.#pool.query<DbRow>(`SELECT ${LISTING_COLUMNS} FROM channel_listings WHERE provider_id=$1 ORDER BY account_id,id`, [providerId]);
    return result.rows.map(listingDto);
  }

  async mintWorkerCredential(actor: ChannelAdminActor, workerId: string, displayName: string, expiresAtUtc: string, expectedVersion: number | null, commandId: string): Promise<WorkerCredential> {
    this.#validateActor(actor);
    assertStoreIdentifier(workerId, "workerId");
    assertNonEmptyText(displayName, "displayName", 200);
    assertCanonicalInstant(expiresAtUtc, "expiresAtUtc");
    if (expiresAtUtc <= this.#nowIso()) throw new StoreValidationError("Worker credential expiry must be in the future.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    const request = fingerprint({ workerId, displayName, expiresAtUtc, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "worker.mint", request);
      if (previous) throw new StoreConflictError("A worker credential is returned only once and cannot be replayed.");
      const secret = randomBytes(32).toString("base64url");
      const bearerToken = `${workerId}.${secret}`;
      const current = await client.query<DbRow>("SELECT version FROM channel_workers WHERE id=$1 FOR UPDATE", [workerId]);
      let version: number;
      if (!current.rows[0]) {
        if (expectedVersion !== null) throw new StoreConflictError("Worker was not found.");
        await client.query("INSERT INTO channel_workers (id,display_name,credential_digest,credential_expires_at) VALUES ($1,$2,$3,$4)", [workerId, displayName, digest(bearerToken), expiresAtUtc]);
        version = 1;
      } else {
        if (expectedVersion === null || integer(current.rows[0], "version") !== expectedVersion) throw new StoreConflictError("Worker version mismatch.");
        await client.query(
          `UPDATE channel_workers SET display_name=$2,credential_digest=$3,credential_expires_at=$4,revoked_at=NULL,
             version=version+1,updated_at=$5 WHERE id=$1`, [workerId, displayName, digest(bearerToken), expiresAtUtc, this.#nowIso()],
        );
        version = expectedVersion + 1;
      }
      await this.#completeCommand(client, actor, commandId, "worker.mint", request, { id: workerId, version }, undefined, "worker", workerId);
      return { workerId, bearerToken, expiresAtUtc };
    });
  }

  async assignWorkerAccount(actor: ChannelAdminActor, workerId: string, accountId: string, expectedVersion: number | null, commandId: string): Promise<void> {
    this.#validateActor(actor);
    assertStoreIdentifier(workerId, "workerId");
    assertStoreIdentifier(accountId, "accountId");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion must be null or a positive integer.");
    const request = fingerprint({ workerId, accountId, expectedVersion });
    await withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "worker.assign", request);
      if (previous) return;
      const current = await client.query<DbRow>(
        "SELECT version FROM channel_worker_accounts WHERE worker_id=$1 AND account_id=$2 FOR UPDATE", [workerId, accountId],
      );
      let version: number;
      if (!current.rows[0]) {
        if (expectedVersion !== null) throw new StoreConflictError("Worker assignment was not found.");
        await client.query("INSERT INTO channel_worker_accounts (worker_id,account_id) VALUES ($1,$2)", [workerId, accountId]);
        version = 1;
      } else {
        if (expectedVersion === null || integer(current.rows[0], "version") !== expectedVersion) throw new StoreConflictError("Worker assignment version mismatch.");
        await client.query(
          "UPDATE channel_worker_accounts SET revoked_at=NULL,assigned_at=$3,version=version+1 WHERE worker_id=$1 AND account_id=$2",
          [workerId, accountId, this.#nowIso()],
        );
        version = expectedVersion + 1;
      }
      await this.#completeCommand(client, actor, commandId, "worker.assign", request, { id: `${workerId}:${accountId}`, version }, undefined, "worker_assignment", `${workerId}:${accountId}`);
    });
  }

  async revokeWorkerAccount(actor: ChannelAdminActor, workerId: string, accountId: string, expectedVersion: number, commandId: string): Promise<void> {
    this.#validateActor(actor);
    assertStoreIdentifier(workerId, "workerId");
    assertStoreIdentifier(accountId, "accountId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion is required.");
    const request = fingerprint({ workerId, accountId, expectedVersion });
    await withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "worker.unassign", request);
      if (previous) return;
      const revoked = await client.query(
        `UPDATE channel_worker_accounts SET revoked_at=$4,version=version+1
          WHERE worker_id=$1 AND account_id=$2 AND version=$3 AND revoked_at IS NULL`,
        [workerId, accountId, expectedVersion, this.#nowIso()],
      );
      if (revoked.rowCount !== 1) throw new StoreConflictError("Worker assignment version mismatch or already revoked.");
      await this.#completeCommand(client, actor, commandId, "worker.unassign", request, { id: `${workerId}:${accountId}`, version: expectedVersion + 1 }, undefined, "worker_assignment", `${workerId}:${accountId}`);
    });
  }

  async revokeWorker(actor: ChannelAdminActor, workerId: string, expectedVersion: number, commandId: string): Promise<void> {
    this.#validateActor(actor);
    const request = fingerprint({ workerId, expectedVersion });
    await withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "worker.revoke", request);
      if (previous) return;
      const result = await client.query(
        "UPDATE channel_workers SET revoked_at=$3,version=version+1,updated_at=$3 WHERE id=$1 AND version=$2 AND revoked_at IS NULL",
        [workerId, expectedVersion, this.#nowIso()],
      );
      if (result.rowCount !== 1) throw new StoreConflictError("Worker version mismatch or already revoked.");
      await this.#completeCommand(client, actor, commandId, "worker.revoke", request, { id: workerId }, undefined, "worker", workerId);
    });
  }

  async authenticateWorker(bearerToken: string): Promise<WorkerIdentity> {
    if (bearerToken.length > 300 || !bearerToken.includes(".")) throw new StoreAccessDeniedError();
    const workerId = bearerToken.slice(0, bearerToken.indexOf("."));
    if (!workerId) throw new StoreAccessDeniedError();
    const result = await this.#pool.query<DbRow>("SELECT credential_digest,credential_expires_at,revoked_at,version FROM channel_workers WHERE id=$1", [workerId]);
    const worker = result.rows[0];
    if (!worker || worker.revoked_at !== null || isoValue(worker, "credential_expires_at") <= this.#nowIso()
      || !secureDigestMatch(text(worker, "credential_digest"), bearerToken)) throw new StoreAccessDeniedError();
    return { workerId, credentialVersion: integer(worker, "version") };
  }

  async reconcileListing(actor: ChannelAdminActor, listingId: string, commandId: string): Promise<{ readonly occurrences: number; readonly jobs: number }> {
    this.#validateActor(actor);
    assertStoreIdentifier(listingId, "listingId");
    const request = fingerprint({ listingId });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "listing.reconcile", request);
      if (previous) return { occurrences: Number(previous.occurrences), jobs: Number(previous.jobs) };
      const reconciled = await this.#reconcile(client, "l.id=$1", [listingId], 2_000);
      const result = { occurrences: reconciled.occurrences, jobs: reconciled.jobs };
      await this.#completeCommand(client, actor, commandId, "listing.reconcile", request, result, undefined, "listing", listingId);
      return result;
    });
  }

  /** Consume and expand only rows locked by this transaction; any expansion failure rolls back the processed cursor. */
  async consumeCalendarOutbox(limit = 50, identity?: WorkerIdentity): Promise<{ readonly events: number; readonly occurrences: number; readonly jobs: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("Outbox limit must be between 1 and 200.");
    return withTransaction(this.#pool, async (client) => {
      if (identity) await this.#requireWorker(client, identity);
      const events = await client.query<DbRow>(
        `SELECT e.id,e.provider_id,e.channel_dispatch_cursor,e.channel_dispatch_from::text,e.channel_dispatch_to::text FROM calendar_outbox_events e
          WHERE e.processed_at IS NULL AND e.available_at <= $1
            AND ($3::text IS NULL OR EXISTS (
              SELECT 1 FROM channel_worker_accounts wa
              JOIN channel_external_accounts a ON a.id=wa.account_id
              WHERE wa.worker_id=$3 AND wa.revoked_at IS NULL AND a.provider_id=e.provider_id
            ))
          ORDER BY e.id LIMIT $2 FOR UPDATE OF e SKIP LOCKED`,
        [this.#nowIso(), limit, identity?.workerId ?? null],
      );
      let occurrences = 0;
      let jobs = 0;
      let completed = 0;
      for (const event of events.rows) {
        const remaining = 2_000 - occurrences;
        if (remaining <= 0) break;
        const fromDate = event.channel_dispatch_from === null ? tokyoDate(this.#now()) : text(event, "channel_dispatch_from");
        const toDate = event.channel_dispatch_to === null ? addLocalDays(fromDate, 55) : text(event, "channel_dispatch_to");
        const after = event.channel_dispatch_cursor as DispatchCursor | null;
        const reconciled = await this.#reconcile(client, "l.provider_id=$1", [text(event, "provider_id")], remaining,
          { fromDate, toDate, ...(after === null ? {} : { after }) });
        occurrences += reconciled.occurrences;
        jobs += reconciled.jobs;
        await client.query(
          `UPDATE calendar_outbox_events SET channel_dispatch_cursor=$2::jsonb,channel_dispatch_from=$3::date,
             channel_dispatch_to=$4::date,processed_at=$5,attempts=attempts+1 WHERE id=$1`,
          [event.id, reconciled.continuation === null ? null : JSON.stringify(reconciled.continuation), fromDate, toDate,
            reconciled.continuation === null ? this.#nowIso() : null],
        );
        if (reconciled.continuation === null) completed += 1;
        else break;
      }
      return { events: completed, occurrences, jobs };
    });
  }

  async #reconcile(client: PoolClient, listingWhere: string, params: readonly unknown[], maxOccurrences: number, page?: DispatchPage): Promise<{ occurrences: number; jobs: number; continuation: DispatchCursor | null }> {
    const listings = await client.query<DbRow>(
      `SELECT l.*,a.site,a.external_account_id,a.active AS account_active,a.delegated_until,a.revoked_at,a.version AS account_version,a.quarantined_at
         FROM channel_listings l JOIN channel_external_accounts a ON a.id=l.account_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
        WHERE ${listingWhere} AND l.active=true AND p.status='PUBLISHED' ORDER BY l.id COLLATE "C"`, [...params],
    );
    let occurrenceCount = 0;
    let jobCount = 0;
    const fromDate = page?.fromDate ?? tokyoDate(this.#now());
    const toDate = page?.toDate ?? addLocalDays(fromDate, 55);
    let lastCursor: DispatchCursor | null = null;
    for (const listing of listings.rows) {
      const listingId = text(listing, "id");
      if (page?.after && listingId < page.after.listingId) continue;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,19))", [`channel-listing:${text(listing, "id")}`]);
      const rules = await client.query<DbRow>(`SELECT ${RULE_COLUMNS} FROM schedule_rules WHERE provider_id=$1 AND product_id=$2 ORDER BY id COLLATE "C"`, [listing.provider_id, listing.product_id]);
      for (const ruleRow of rules.rows) {
        const storedRule = scheduleRuleFromRow(ruleRow);
        if (page?.after && listingId === page.after.listingId && storedRule.rule.id < page.after.ruleId) continue;
        const overridesResult = await client.query<DbRow>(
          `SELECT occurrence_id,kind,local_date::text AS local_date,to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,version
             FROM schedule_occurrence_overrides WHERE provider_id=$1 AND rule_id=$2`, [listing.provider_id, storedRule.rule.id],
        );
        const salesResult = await client.query<DbRow>(
          "SELECT occurrence_id,desired_state,version FROM schedule_occurrence_sales_states WHERE provider_id=$1 AND rule_id=$2",
          [listing.provider_id, storedRule.rule.id],
        );
        const overrides: OccurrenceOverride[] = overridesResult.rows.map((row) => overrideFromRow(row).override);
        const salesStates: OccurrenceSalesState[] = salesResult.rows.map((row) => salesStateFromRow(row).state);
        const occurrences = expandOccurrences({ rule: storedRule.rule, overrides, salesStates, fromDate, toDate });
        for (const occurrence of [...occurrences].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
          if (page?.after && listingId === page.after.listingId && storedRule.rule.id === page.after.ruleId && occurrence.id <= page.after.occurrenceId) continue;
          if (page && occurrenceCount === maxOccurrences) return { occurrences: occurrenceCount, jobs: jobCount, continuation: lastCursor };
          occurrenceCount += 1;
          if (occurrenceCount > maxOccurrences) throw new StoreConflictError("Channel reconciliation exceeded its occurrence bound.");
          const availability = await this.#liveAvailability(client, text(listing, "provider_id"), occurrence, this.#nowIso());
          const desiredState: ChannelDesiredState = availability.bookable ? "OPEN" : "CLOSED";
          const desired = await this.#upsertDesired(client, listing, occurrence, desiredState, availability.reason);
          jobCount += await this.#enqueueDesiredJob(client, listing, occurrence, desiredState, desired.desiredVersion);
          lastCursor = { listingId, ruleId: storedRule.rule.id, occurrenceId: occurrence.id };
        }
      }
    }
    return { occurrences: occurrenceCount, jobs: jobCount, continuation: null };
  }

  async #liveAvailability(client: PoolClient, providerId: string, occurrence: Occurrence, nowUtc: string) {
    const reservations = await client.query<{ confirmed: string; held: string }>(
      `SELECT COALESCE(sum(seats) FILTER (WHERE status='CONFIRMED'),0)::text AS confirmed,
              COALESCE(sum(seats) FILTER (WHERE status='HOLD' AND hold_expires_at>$3),0)::text AS held
         FROM bookings WHERE provider_id=$1 AND occurrence_id=$2`, [providerId, occurrence.id, nowUtc],
    );
    const row = reservations.rows[0];
    const googleResult = await client.query<DbRow>("SELECT * FROM provider_google_calendars WHERE provider_id=$1", [providerId]);
    const googleRow = googleResult.rows[0];
    let blockingEnabled = false;
    let syncStatus: "FRESH" | "STALE" | "FAILED" = "STALE";
    let busyIntervals: BusyInterval[] = [];
    if (googleRow) {
      const google = googleCalendarFromRow(googleRow);
      blockingEnabled = google.blockingEnabled;
      const rangeStart = addMinutes(occurrence.startUtc, -occurrence.busyBufferBeforeMinutes);
      const rangeEnd = addMinutes(occurrence.endUtc, occurrence.busyBufferAfterMinutes);
      const covered = google.coverageStartUtc !== undefined && google.coverageEndUtc !== undefined
        && google.coverageStartUtc <= rangeStart && google.coverageEndUtc >= rangeEnd;
      syncStatus = covered ? effectiveGoogleSyncStatus(google.syncStatus, google.freshUntilUtc, nowUtc) : "STALE";
      if (blockingEnabled && syncStatus === "FRESH") {
        const busy = await client.query<DbRow>(
          "SELECT start_at,end_at FROM google_busy_intervals WHERE provider_id=$1 AND opaque_calendar_id=$2 AND end_at>$3 AND start_at<$4 ORDER BY start_at",
          [providerId, google.opaqueCalendarId, rangeStart, rangeEnd],
        );
        busyIntervals = busy.rows.map((entry) => ({ startUtc: isoValue(entry, "start_at"), endUtc: isoValue(entry, "end_at") }));
      }
    }
    return evaluateAvailability({
      occurrence, requestedSeats: 1, confirmedSeats: Number(row?.confirmed ?? 0), heldSeats: Number(row?.held ?? 0), nowUtc,
      googleCalendar: { blockingEnabled, syncStatus, busyIntervals },
    });
  }

  async #upsertDesired(client: PoolClient, listing: DbRow, occurrence: Occurrence, desiredState: ChannelDesiredState, reason: string): Promise<{ desiredVersion: number }> {
    const currentResult = await client.query<DbRow>(
      "SELECT * FROM channel_desired_states WHERE listing_id=$1 AND occurrence_id=$2 FOR UPDATE", [listing.id, occurrence.id],
    );
    const current = currentResult.rows[0];
    const mappingVersion = integer(listing, "mapping_version");
    if (current && current.desired_state === desiredState && current.reason === reason && integer(current, "mapping_version") === mappingVersion
      && isoValue(current, "source_start_at") === occurrence.startUtc && isoValue(current, "source_end_at") === occurrence.endUtc) {
      return { desiredVersion: integer(current, "desired_version") };
    }
    if (!current) {
      await client.query(
        `INSERT INTO channel_desired_states
          (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`,
        [listing.id, listing.provider_id, occurrence.id, desiredState, reason, mappingVersion, occurrence.startUtc, occurrence.endUtc],
      );
      return { desiredVersion: 1 };
    }
    const desiredVersion = integer(current, "desired_version") + 1;
    await client.query(
      `UPDATE channel_desired_states SET desired_state=$3,reason=$4,desired_version=$5,mapping_version=$6,source_start_at=$7,
         source_end_at=$8,updated_at=$9 WHERE listing_id=$1 AND occurrence_id=$2`,
      [listing.id, occurrence.id, desiredState, reason, desiredVersion, mappingVersion, occurrence.startUtc, occurrence.endUtc, this.#nowIso()],
    );
    return { desiredVersion };
  }

  async #enqueueDesiredJob(client: PoolClient, listing: DbRow, occurrence: Occurrence, desiredState: ChannelDesiredState, desiredVersion: number): Promise<number> {
    const action = desiredAction(desiredState);
    const capability = (action === "SET_OPEN" ? listing.can_open === true : listing.can_close === true) && this.#adapterSupports(listing, action);
    if (!capability) {
      await client.query("UPDATE channel_desired_states SET last_error=$3 WHERE listing_id=$1 AND occurrence_id=$2", [listing.id, occurrence.id, `${action} is unsupported by this mapping.`]);
      return 0;
    }
    const nowUtc = this.#nowIso();
    const accountUsable = listing.account_active === true && listing.revoked_at === null
      && (listing.delegated_until === null || isoValue(listing, "delegated_until") > nowUtc) && listing.quarantined_at === null;
    if (!accountUsable) {
      await client.query("UPDATE channel_desired_states SET last_error='External account is inactive, expired, revoked, or quarantined.' WHERE listing_id=$1 AND occurrence_id=$2", [listing.id, occurrence.id]);
      return 0;
    }
    const existing = await client.query(
      `SELECT 1 FROM channel_jobs WHERE listing_id=$1 AND occurrence_id=$2 AND action=$3 AND account_version=$4
         AND desired_version=$5 AND mapping_version=$6`,
      [listing.id, occurrence.id, action, listing.account_version, desiredVersion, listing.mapping_version],
    );
    if (existing.rows[0]) return 0;
    await client.query("UPDATE channel_desired_states SET last_error=NULL WHERE listing_id=$1 AND occurrence_id=$2", [listing.id, occurrence.id]);
    await client.query(
      "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$3 WHERE listing_id=$1 AND occurrence_id=$2 AND status='QUEUED'",
      [listing.id, occurrence.id, nowUtc],
    );
    const inserted = await client.query(
      `INSERT INTO channel_jobs
        (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,target_site,
         target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,target_adapter,target_adapter_version,
         target_connection_mode,source_start_at,source_end_at,priority,job_deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Asia/Tokyo',$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (listing_id,occurrence_id,action,account_version,desired_version,mapping_version) DO NOTHING`,
      [randomUUID(), listing.provider_id, listing.account_id, listing.id, occurrence.id, action, listing.account_version, desiredVersion,
        listing.mapping_version, listing.site, listing.external_account_id, listing.external_product_id, listing.external_option_id,
        listing.adapter, listing.adapter_version, listing.connection_mode, occurrence.startUtc, occurrence.endUtc, desiredState === "CLOSED" ? 100 : 50, null],
    );
    return inserted.rowCount ?? 0;
  }

  async #requireWorker(client: PoolClient, identity: WorkerIdentity): Promise<DbRow> {
    const result = await client.query<DbRow>("SELECT * FROM channel_workers WHERE id=$1 FOR SHARE", [identity.workerId]);
    const worker = result.rows[0];
    if (!worker || worker.revoked_at !== null || integer(worker, "version") !== identity.credentialVersion
      || isoValue(worker, "credential_expires_at") <= this.#nowIso()) throw new StoreAccessDeniedError();
    return worker;
  }

  async claim(identity: WorkerIdentity): Promise<ClaimedChannelJob | null> {
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      const nowUtc = this.#nowIso();
      await client.query("UPDATE channel_workers SET last_heartbeat_at=$2,updated_at=$2 WHERE id=$1", [identity.workerId, nowUtc]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('channel-browser-global',11))");
      const existingLease = await client.query<DbRow>("SELECT id,account_id,lease_expires_at FROM channel_jobs WHERE status='LEASED' FOR UPDATE");
      if (existingLease.rows[0] && isoValue(existingLease.rows[0], "lease_expires_at") <= nowUtc) {
        await client.query(
          "UPDATE channel_external_accounts SET quarantined_at=COALESCE(quarantined_at,$2),quarantine_reason='LEASE_EXPIRED',updated_at=$2 WHERE id=$1",
          [existingLease.rows[0].account_id, nowUtc],
        );
        return null;
      }
      if (existingLease.rows[0]) return null;
      const expired = await client.query<DbRow>(
        `UPDATE channel_jobs j SET status='FINISHED',outcome='NEEDS_REVIEW',updated_at=$1
          WHERE j.status='QUEUED' AND (j.attempt_count>=5 OR (j.job_deadline_at IS NOT NULL AND j.job_deadline_at<=$1))
          RETURNING j.account_id`, [nowUtc],
      );
      for (const row of expired.rows) await this.#quarantine(client, text(row, "account_id"), "RETRY_DEADLINE");
      const deployedActions = Object.entries(this.#supportedAdapters).flatMap(([key, capability]) => [
        ...(capability.canOpen === true ? [`${key}/SET_OPEN`] : []),
        ...(capability.canClose === true ? [`${key}/SET_CLOSED`] : []),
        ...(capability.canObserve === true ? [`${key}/OBSERVE`] : []),
      ]);
      const result = await client.query<DbRow>(
        `SELECT j.*,wa.version AS assignment_version FROM channel_jobs j
          JOIN channel_external_accounts a ON a.id=j.account_id
          JOIN channel_listings l ON l.id=j.listing_id
          JOIN experience_products p ON p.provider_id=j.provider_id AND p.id=l.product_id
          JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
          JOIN channel_worker_accounts wa ON wa.account_id=j.account_id AND wa.worker_id=$1 AND wa.revoked_at IS NULL
         WHERE j.status='QUEUED' AND j.next_attempt_at<=$2 AND (j.job_deadline_at IS NULL OR j.job_deadline_at>$2)
           AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2)
           AND (a.quarantined_at IS NULL OR j.action='OBSERVE')
           AND a.version=j.account_version AND l.active=true AND l.mapping_version=j.mapping_version AND p.status='PUBLISHED'
           AND d.desired_version=j.desired_version AND d.mapping_version=j.mapping_version
           AND (j.action='OBSERVE' OR (j.action='SET_OPEN' AND d.desired_state='OPEN') OR (j.action='SET_CLOSED' AND d.desired_state='CLOSED'))
           AND ((j.action='SET_OPEN' AND l.can_open) OR (j.action='SET_CLOSED' AND l.can_close) OR (j.action='OBSERVE' AND l.can_observe))
           AND (j.target_site || '/' || j.target_adapter || '@' || j.target_adapter_version || '/' || j.action)=ANY($3::text[])
         ORDER BY j.priority DESC,j.next_attempt_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [identity.workerId, nowUtc, deployedActions],
      );
      const job = result.rows.find((candidate) => this.#adapterSupports(candidate, text(candidate, "action") as ChannelAction));
      if (!job) return null;
      const leaseToken = randomBytes(32).toString("base64url");
      const deadlineAtUtc = job.job_deadline_at === null ? new Date(this.#now().getTime() + 180_000).toISOString() : isoValue(job, "job_deadline_at");
      const leaseExpiresAtUtc = new Date(Math.min(this.#now().getTime() + 120_000, Date.parse(deadlineAtUtc))).toISOString();
      await client.query(
        `UPDATE channel_jobs SET status='LEASED',leased_worker_id=$2,lease_digest=$3,lease_expires_at=$4,
           job_deadline_at=COALESCE(job_deadline_at,$5),lease_epoch=lease_epoch+1,lease_started_at=$6,lease_assignment_version=$7,
           attempt_count=attempt_count+1,updated_at=$6 WHERE id=$1`,
        [job.id, identity.workerId, digest(leaseToken), leaseExpiresAtUtc, deadlineAtUtc, nowUtc, job.assignment_version],
      );
      await client.query("UPDATE channel_workers SET last_heartbeat_at=$2,updated_at=$2 WHERE id=$1", [identity.workerId, nowUtc]);
      return {
        id: text(job, "id"), leaseToken, leaseExpiresAtUtc, deadlineAtUtc, action: text(job, "action") as ChannelAction,
        occurrenceId: text(job, "occurrence_id"), desiredVersion: integer(job, "desired_version"), mappingVersion: integer(job, "mapping_version"),
        sourceStartAtUtc: isoValue(job, "source_start_at"), sourceEndAtUtc: isoValue(job, "source_end_at"), target: targetFromRow(job),
      };
    });
  }

  async renew(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<{ readonly leaseExpiresAtUtc: string }> {
    assertUuid(jobId, "jobId");
    const result = await withTransaction(this.#pool, async (client): Promise<{ leaseExpiresAtUtc: string } | { conflict: string }> => {
      await this.#requireWorker(client, identity);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      const nowMs = this.#now().getTime();
      if (Date.parse(isoValue(job, "lease_expires_at")) <= nowMs || Date.parse(isoValue(job, "job_deadline_at")) <= nowMs
        || nowMs - Date.parse(isoValue(job, "updated_at")) > 60_000) {
        await this.#quarantine(client, text(job, "account_id"), "LEASE_RENEWAL_LATE");
        return { conflict: "Lease renewal is stale; the account remains locked." };
      }
      const leaseExpiresAtUtc = new Date(Math.min(nowMs + 120_000, Date.parse(isoValue(job, "job_deadline_at")))).toISOString();
      await client.query("UPDATE channel_jobs SET lease_expires_at=$2,updated_at=$3 WHERE id=$1", [jobId, leaseExpiresAtUtc, this.#nowIso()]);
      await client.query("UPDATE channel_workers SET last_heartbeat_at=$2,updated_at=$2 WHERE id=$1", [identity.workerId, this.#nowIso()]);
      return { leaseExpiresAtUtc };
    });
    if ("conflict" in result) throw new StoreConflictError(result.conflict);
    return result;
  }

  async #leasedJob(client: PoolClient, identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<DbRow> {
    const result = await client.query<DbRow>("SELECT * FROM channel_jobs WHERE id=$1::uuid FOR UPDATE", [jobId]);
    const job = result.rows[0];
    if (!job || job.status !== "LEASED" || job.leased_worker_id !== identity.workerId || typeof job.lease_digest !== "string"
      || !secureDigestMatch(job.lease_digest, leaseToken)) throw new StoreAccessDeniedError();
    const assignment = await client.query(
      "SELECT 1 FROM channel_worker_accounts WHERE worker_id=$1 AND account_id=$2 AND revoked_at IS NULL AND version=$3 FOR SHARE",
      [identity.workerId, job.account_id, job.lease_assignment_version],
    );
    if (!assignment.rows[0]) throw new StoreAccessDeniedError();
    return job;
  }

  async #quarantine(client: PoolClient, accountId: string, reason: string): Promise<void> {
    await client.query(
      "UPDATE channel_external_accounts SET quarantined_at=COALESCE(quarantined_at,$2),quarantine_reason=$3,updated_at=$2 WHERE id=$1",
      [accountId, this.#nowIso(), reason],
    );
  }

  async preflight(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<{ readonly ready: true; readonly desiredState: ChannelDesiredState }>{
    assertUuid(jobId, "jobId");
    const result = await withTransaction(this.#pool, async (client): Promise<{ ready: true; desiredState: ChannelDesiredState } | { conflict: string }> => {
      await this.#requireWorker(client, identity);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      const nowUtc = this.#nowIso();
      if (isoValue(job, "lease_expires_at") <= nowUtc || isoValue(job, "job_deadline_at") <= nowUtc) {
        await this.#quarantine(client, text(job, "account_id"), "LEASE_EXPIRED");
        return { conflict: "Lease or job deadline expired; the account remains locked." };
      }
      const current = await client.query<DbRow>(
        `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,l.active AS listing_active,
                a.site,l.mapping_version,l.can_open,l.can_close,l.can_observe,l.adapter,l.adapter_version,
                d.desired_state,d.desired_version,d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at,p.status AS product_status
           FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
           JOIN channel_desired_states d ON d.listing_id=l.id AND d.occurrence_id=$3
           JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
          WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,d`,
        [job.account_id, job.listing_id, job.occurrence_id],
      );
      const state = current.rows[0];
      const capability = job.action === "SET_OPEN" ? state?.can_open : job.action === "SET_CLOSED" ? state?.can_close : state?.can_observe;
      if (!state || state.account_active !== true || state.revoked_at !== null
        || (state.delegated_until !== null && isoValue(state, "delegated_until") <= nowUtc) || state.listing_active !== true || capability !== true
        || state.product_status !== "PUBLISHED" || !this.#adapterSupports(state, text(job, "action") as ChannelAction)
        || (state.quarantined_at !== null && job.action !== "OBSERVE")) {
        await this.#quarantine(client, text(job, "account_id"), "PREFLIGHT_AUTHORITY_STALE");
        return { conflict: "Job authority is stale; the account remains locked." };
      }
      if (integer(state, "account_version") !== integer(job, "account_version")
        || integer(state, "mapping_version") !== integer(job, "mapping_version")
        || integer(state, "desired_mapping_version") !== integer(job, "mapping_version")
        || integer(state, "desired_version") !== integer(job, "desired_version")) {
        return { conflict: "Job snapshot is stale; the old lease remains locked until stopped." };
      }
      const desiredState = text(state, "desired_state") as ChannelDesiredState;
      if ((job.action === "SET_OPEN" && desiredState !== "OPEN") || (job.action === "SET_CLOSED" && desiredState !== "CLOSED")) {
        return { conflict: "Job desired state is stale; the old lease remains locked until stopped." };
      }
      let occurrence: Occurrence;
      try {
        occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
      } catch (error) {
        if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
        await this.#quarantine(client, text(job, "account_id"), "SOURCE_OCCURRENCE_STALE");
        return { conflict: "Source occurrence no longer exists; the account remains locked." };
      }
      if (occurrence.startUtc !== isoValue(job, "source_start_at") || occurrence.endUtc !== isoValue(job, "source_end_at")
        || isoValue(state, "source_start_at") !== occurrence.startUtc || isoValue(state, "source_end_at") !== occurrence.endUtc) {
        await this.#quarantine(client, text(job, "account_id"), "SOURCE_OCCURRENCE_STALE");
        return { conflict: "Source occurrence timing changed; the account remains locked." };
      }
      if (job.action !== "OBSERVE") {
        const availability = await this.#liveAvailability(client, text(job, "provider_id"), occurrence, nowUtc);
        if (desiredAction(availability.bookable ? "OPEN" : "CLOSED") !== job.action) {
          return { conflict: "Live availability changed; the old lease remains locked until stopped." };
        }
      }
      return { ready: true, desiredState };
    });
    if ("conflict" in result) throw new StoreConflictError(result.conflict);
    return result;
  }

  async #currentOccurrence(client: PoolClient, providerId: string, listingId: string, occurrenceId: string): Promise<Occurrence> {
    const marker = occurrenceId.lastIndexOf("@");
    if (marker < 1) throw new StoreValidationError("occurrenceId is invalid.");
    let ruleId: string;
    try { ruleId = decodeURIComponent(occurrenceId.slice(0, marker)); } catch (error) { throw new StoreValidationError("occurrenceId is invalid.", { cause: error }); }
    const sourceDate = occurrenceId.slice(marker + 1);
    const ruleResult = await client.query<DbRow>(
      `SELECT ${RULE_COLUMNS} FROM schedule_rules r
        WHERE r.provider_id=$1 AND r.id=$3 AND EXISTS (
          SELECT 1 FROM channel_listings l WHERE l.provider_id=r.provider_id AND l.product_id=r.product_id AND l.id=$2
        )`, [providerId, listingId, ruleId],
    );
    if (!ruleResult.rows[0]) throw new StoreNotFoundError("schedule rule");
    const storedRule = scheduleRuleFromRow(ruleResult.rows[0]);
    const overrideResult = await client.query<DbRow>(
      `SELECT occurrence_id,kind,local_date::text AS local_date,to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,version
       FROM schedule_occurrence_overrides WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3`, [providerId, ruleId, occurrenceId],
    );
    const salesResult = await client.query<DbRow>(
      "SELECT occurrence_id,desired_state,version FROM schedule_occurrence_sales_states WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3",
      [providerId, ruleId, occurrenceId],
    );
    const override = overrideResult.rows[0] ? overrideFromRow(overrideResult.rows[0]).override : undefined;
    const sales = salesResult.rows[0] ? salesStateFromRow(salesResult.rows[0]).state : undefined;
    const targetDate = override?.kind === "RESCHEDULE" ? override.localDate : sourceDate;
    const occurrence = expandOccurrences({ rule: storedRule.rule, overrides: override ? [override] : [], salesStates: sales ? [sales] : [], fromDate: targetDate, toDate: targetDate })
      .find((candidate) => candidate.id === occurrenceId);
    if (!occurrence) throw new StoreNotFoundError("schedule occurrence");
    return occurrence;
  }

  async submitResult(identity: WorkerIdentity, jobId: string, input: ChannelResultInput): Promise<{ readonly acceptedAsCurrent: boolean; readonly repeated: boolean }> {
    assertUuid(jobId, "jobId");
    assertUuid(input.resultId, "resultId");
    if (!(["VERIFIED", "AUTH_REQUIRED", "NEEDS_REVIEW", "UNKNOWN_AFTER_SAVE", "RETRY_WAIT", "SUPERSEDED"] as const).includes(input.outcome)) {
      throw new StoreValidationError("result.outcome is invalid.");
    }
    if (input.observedAtUtc) assertCanonicalInstant(input.observedAtUtc, "result.observedAtUtc");
    if (input.sourceStartAtUtc) assertCanonicalInstant(input.sourceStartAtUtc, "result.sourceStartAtUtc");
    if (input.sourceEndAtUtc) assertCanonicalInstant(input.sourceEndAtUtc, "result.sourceEndAtUtc");
    if (input.observedState !== undefined && input.observedState !== "OPEN" && input.observedState !== "CLOSED") throw new StoreValidationError("result.observedState is invalid.");
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,23))", [`channel-result:${input.resultId}`]);
      const repeated = await client.query<DbRow>(
        "SELECT job_id,worker_id,lease_epoch,lease_digest,fingerprint,accepted_as_current FROM channel_job_results WHERE result_id=$1::uuid",
        [input.resultId],
      );
      if (repeated.rows[0]) {
        const receipt = repeated.rows[0];
        if (receipt.job_id !== jobId || receipt.worker_id !== identity.workerId || !secureDigestMatch(text(receipt, "lease_digest"), input.leaseToken)) {
          throw new StoreAccessDeniedError();
        }
        const resultFingerprint = fingerprint({ jobId, workerId: identity.workerId, leaseEpoch: integer(receipt, "lease_epoch"), leaseDigest: receipt.lease_digest,
          outcome: input.outcome, stopped: input.stopped, target: input.target, occurrenceId: input.occurrenceId,
          sourceStartAtUtc: input.sourceStartAtUtc, sourceEndAtUtc: input.sourceEndAtUtc, observedState: input.observedState,
          observedBookable: input.observedBookable, observedManuallyBlocked: input.observedManuallyBlocked, observedAtUtc: input.observedAtUtc });
        if (repeated.rows[0].fingerprint !== resultFingerprint) throw new StoreConflictError("Result ID was already used with different input.");
        return { acceptedAsCurrent: repeated.rows[0].accepted_as_current === true, repeated: true };
      }
      const jobResult = await client.query<DbRow>("SELECT * FROM channel_jobs WHERE id=$1::uuid FOR UPDATE", [jobId]);
      const job = jobResult.rows[0];
      if (!job || job.status !== "LEASED" || job.leased_worker_id !== identity.workerId || typeof job.lease_digest !== "string"
        || !secureDigestMatch(job.lease_digest, input.leaseToken)) throw new StoreAccessDeniedError();
      const assignment = await client.query(
        "SELECT 1 FROM channel_worker_accounts WHERE worker_id=$1 AND account_id=$2 AND revoked_at IS NULL AND version=$3 FOR SHARE",
        [identity.workerId, job.account_id, job.lease_assignment_version],
      );
      const assignmentCurrent = assignment.rows[0] !== undefined;
      const leaseDigest = text(job, "lease_digest");
      const leaseEpoch = integer(job, "lease_epoch");
      const resultFingerprint = fingerprint({ jobId, workerId: identity.workerId, leaseEpoch, leaseDigest,
        outcome: input.outcome, stopped: input.stopped, target: input.target, occurrenceId: input.occurrenceId,
        sourceStartAtUtc: input.sourceStartAtUtc, sourceEndAtUtc: input.sourceEndAtUtc, observedState: input.observedState,
        observedBookable: input.observedBookable, observedManuallyBlocked: input.observedManuallyBlocked, observedAtUtc: input.observedAtUtc });
      const exactTarget = targetEqual(targetFromRow(job), input.target);
      const occurrenceMatchesSnapshot = input.occurrenceId === job.occurrence_id
        && input.sourceStartAtUtc === isoValue(job, "source_start_at") && input.sourceEndAtUtc === isoValue(job, "source_end_at");
      const verifiedShape = input.outcome === "VERIFIED" && exactTarget && occurrenceMatchesSnapshot
        && input.observedState !== undefined && input.observedBookable !== undefined
        && input.observedManuallyBlocked !== undefined && input.observedAtUtc !== undefined;
      if (input.outcome === "VERIFIED" && !verifiedShape) throw new StoreValidationError("VERIFIED requires exact target and structured readback observation.");
      const nowUtc = this.#nowIso();
      const withinLease = isoValue(job, "lease_expires_at") > nowUtc && isoValue(job, "job_deadline_at") > nowUtc;
      const observedMs = input.observedAtUtc === undefined ? Number.NaN : Date.parse(input.observedAtUtc);
      const observationTimeValid = Number.isFinite(observedMs) && observedMs >= Date.parse(isoValue(job, "lease_started_at"))
        && observedMs <= Math.min(Date.parse(isoValue(job, "lease_expires_at")), Date.parse(isoValue(job, "job_deadline_at")), this.#now().getTime() + 5_000);
      const currentResult = await client.query<DbRow>(
        `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,a.site,
                l.active AS listing_active,l.mapping_version,l.adapter,l.adapter_version,l.can_open,l.can_close,l.can_observe,
                d.desired_version,d.desired_state,d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at,
                p.status AS product_status
           FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
           JOIN channel_desired_states d ON d.listing_id=l.id AND d.occurrence_id=$3
           JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
          WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,d`, [job.account_id, job.listing_id, job.occurrence_id],
      );
      const current = currentResult.rows[0];
      const action = text(job, "action") as ChannelAction;
      const capability = action === "SET_OPEN" ? current?.can_open : action === "SET_CLOSED" ? current?.can_close : current?.can_observe;
      let liveOccurrenceMatches = false;
      let liveActionAllowed = action === "OBSERVE";
      if (current) {
        try {
          const occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
          liveOccurrenceMatches = occurrence.startUtc === isoValue(job, "source_start_at") && occurrence.endUtc === isoValue(job, "source_end_at")
            && isoValue(current, "source_start_at") === occurrence.startUtc && isoValue(current, "source_end_at") === occurrence.endUtc;
          if (liveOccurrenceMatches && action !== "OBSERVE") {
            const availability = await this.#liveAvailability(client, text(job, "provider_id"), occurrence, nowUtc);
            liveActionAllowed = desiredAction(availability.bookable ? "OPEN" : "CLOSED") === action;
          }
        } catch (error) {
          if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
        }
      }
      const desiredStateCurrent = current !== undefined
        && (action === "OBSERVE" || (action === "SET_OPEN" && current.desired_state === "OPEN") || (action === "SET_CLOSED" && current.desired_state === "CLOSED"));
      const versionsCurrent = assignmentCurrent && current !== undefined && current.account_active === true && current.revoked_at === null
        && (current.delegated_until === null || isoValue(current, "delegated_until") > nowUtc)
        && current.listing_active === true && current.product_status === "PUBLISHED" && capability === true
        && (current.quarantined_at === null || action === "OBSERVE") && this.#adapterSupports(current, action)
        && integer(current, "account_version") === integer(job, "account_version")
        && integer(current, "mapping_version") === integer(job, "mapping_version")
        && integer(current, "desired_mapping_version") === integer(job, "mapping_version")
        && integer(current, "desired_version") === integer(job, "desired_version")
        && desiredStateCurrent && liveOccurrenceMatches && liveActionAllowed;
      const acceptedAsCurrent = channelReadbackAccepted({
        action, expectedTarget: targetFromRow(job), resultTarget: input.target,
        outcome: input.outcome, stopped: input.stopped, withinLease, versionsCurrent,
        occurrenceMatches: occurrenceMatchesSnapshot, observationTimeValid,
        ...(input.observedState === undefined ? {} : { observedState: input.observedState }),
        ...(input.observedBookable === undefined ? {} : { observedBookable: input.observedBookable }),
        ...(input.observedManuallyBlocked === undefined ? {} : { observedManuallyBlocked: input.observedManuallyBlocked }),
        ...(input.observedAtUtc === undefined ? {} : { observedAtUtc: input.observedAtUtc }),
      });
      await client.query(
        `INSERT INTO channel_job_results
          (result_id,job_id,worker_id,lease_epoch,lease_digest,fingerprint,outcome,stopped,exact_target_match,
           occurrence_id,source_start_at,source_end_at,observed_state,observed_bookable,observed_manually_blocked,observed_at,accepted_as_current)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [input.resultId, jobId, identity.workerId, leaseEpoch, leaseDigest, resultFingerprint, input.outcome, input.stopped, exactTarget,
          input.occurrenceId ?? job.occurrence_id, input.sourceStartAtUtc ?? job.source_start_at, input.sourceEndAtUtc ?? job.source_end_at,
          input.observedState ?? null, input.observedBookable ?? null, input.observedManuallyBlocked ?? null, input.observedAtUtc ?? null, acceptedAsCurrent],
      );
      if (!withinLease) {
        await this.#quarantine(client, text(job, "account_id"), "LATE_RESULT");
        if (input.stopped) await this.#finishUnsafe(client, jobId, text(job, "account_id"), "NEEDS_REVIEW", "LATE_RESULT_STOPPED");
        return { acceptedAsCurrent: false, repeated: false };
      }
      if (!input.stopped) {
        await this.#quarantine(client, text(job, "account_id"), "EXECUTOR_NOT_STOPPED");
        return { acceptedAsCurrent: false, repeated: false };
      }
      if (acceptedAsCurrent) {
        await client.query(
          `UPDATE channel_desired_states SET observed_state=$3,observed_desired_version=$4,observed_mapping_version=$5,
             last_verified_at=$6,last_error=NULL,updated_at=$6 WHERE listing_id=$1 AND occurrence_id=$2`,
          [job.listing_id, job.occurrence_id, input.observedState, job.desired_version, job.mapping_version, input.observedAtUtc],
        );
        await client.query(
          "UPDATE channel_jobs SET status='FINISHED',outcome='VERIFIED',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
          [jobId, nowUtc],
        );
        if (job.action === "OBSERVE") await this.#completeRecoveryObserve(client, job);
      } else if (!versionsCurrent || input.outcome === "SUPERSEDED") {
        if (input.outcome === "VERIFIED") await this.#quarantine(client, text(job, "account_id"), "STALE_RESULT");
        await client.query(
          "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
          [jobId, nowUtc],
        );
      } else if (input.outcome === "RETRY_WAIT" && integer(job, "attempt_count") < 5) {
        const backoffSeconds = Math.min(60, 2 ** integer(job, "attempt_count") * 5);
        const nextAttemptAt = new Date(this.#now().getTime() + backoffSeconds * 1_000).toISOString();
        if (nextAttemptAt < isoValue(job, "job_deadline_at")) {
          await client.query(
            `UPDATE channel_jobs SET status='QUEUED',outcome='RETRY_WAIT',next_attempt_at=$2,leased_worker_id=NULL,
               lease_digest=NULL,lease_started_at=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1::uuid`, [jobId, nextAttemptAt, nowUtc],
          );
        } else {
          await this.#finishUnsafe(client, jobId, text(job, "account_id"), "NEEDS_REVIEW", "RETRY_DEADLINE");
        }
      } else {
        const outcome = input.outcome === "VERIFIED" || input.outcome === "RETRY_WAIT" ? "NEEDS_REVIEW" : input.outcome;
        await this.#finishUnsafe(client, jobId, text(job, "account_id"), outcome, outcome);
      }
      return { acceptedAsCurrent, repeated: false };
    });
  }

  async #finishUnsafe(client: PoolClient, jobId: string, accountId: string, outcome: ChannelOutcome, reason: string): Promise<void> {
    await client.query(
      "UPDATE channel_jobs SET status='FINISHED',outcome=$2,lease_digest=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1::uuid",
      [jobId, outcome, this.#nowIso()],
    );
    if (outcome === "AUTH_REQUIRED" || outcome === "NEEDS_REVIEW" || outcome === "UNKNOWN_AFTER_SAVE") await this.#quarantine(client, accountId, reason);
  }

  async #completeRecoveryObserve(client: PoolClient, job: DbRow): Promise<void> {
    await client.query(
      "UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL,updated_at=$2 WHERE id=$1",
      [job.account_id, this.#nowIso()],
    );
    const listingResult = await client.query<DbRow>(
      `SELECT l.*,a.site,a.external_account_id,a.active AS account_active,a.delegated_until,a.revoked_at,a.version AS account_version,a.quarantined_at
         FROM channel_listings l JOIN channel_external_accounts a ON a.id=l.account_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         WHERE l.id=$1 AND l.active=true AND p.status='PUBLISHED'`, [job.listing_id],
    );
    const listing = listingResult.rows[0];
    if (!listing) return;
    const occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
    const availability = await this.#liveAvailability(client, text(job, "provider_id"), occurrence, this.#nowIso());
    const desiredState: ChannelDesiredState = availability.bookable ? "OPEN" : "CLOSED";
    const desired = await client.query<DbRow>(
      `UPDATE channel_desired_states SET desired_state=$3,reason=$4,desired_version=desired_version+1,mapping_version=$5,
         source_start_at=$6,source_end_at=$7,updated_at=$8 WHERE listing_id=$1 AND occurrence_id=$2 RETURNING *`,
      [job.listing_id, job.occurrence_id, desiredState, availability.reason, listing.mapping_version,
        occurrence.startUtc, occurrence.endUtc, this.#nowIso()],
    );
    const state = desired.rows[0];
    if (state) await this.#enqueueDesiredJob(client, listing, occurrence, desiredState, integer(state, "desired_version"));
  }

  async recoverQuarantinedLease(actor: ChannelAdminActor, accountId: string, stopConfirmed: true, commandId: string): Promise<{ readonly observeJobId: string }> {
    this.#validateActor(actor);
    assertStoreIdentifier(accountId, "accountId");
    if (stopConfirmed !== true) throw new StoreValidationError("Explicit executor stop confirmation is required.");
    const request = fingerprint({ accountId, stopConfirmed });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "account.recover", request);
      if (previous) return { observeJobId: String(previous.observeJobId) };
      const leased = await client.query<DbRow>(
        `SELECT j.*,l.can_observe,l.active AS listing_active,a.version AS current_account_version,a.site,a.external_account_id,
                l.external_product_id,l.external_option_id,l.time_zone,l.mapping_version AS current_mapping_version,
                l.adapter,l.adapter_version,l.connection_mode,
                d.desired_version AS current_desired_version,d.source_start_at AS current_source_start_at,d.source_end_at AS current_source_end_at,
                p.status AS product_status
           FROM channel_jobs j JOIN channel_listings l ON l.id=j.listing_id JOIN channel_external_accounts a ON a.id=j.account_id
           JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
           JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
          WHERE j.account_id=$1 AND (j.status='LEASED' OR (j.status='FINISHED' AND a.quarantined_at IS NOT NULL))
          ORDER BY (j.status='LEASED') DESC,j.updated_at DESC LIMIT 1 FOR UPDATE OF j,a`, [accountId],
      );
      const job = leased.rows[0];
      if (!job) throw new StoreConflictError("No leased job requires recovery.");
      if (job.can_observe !== true || job.listing_active !== true || job.product_status !== "PUBLISHED"
        || !this.#adapterSupports({ site: job.site, adapter: job.adapter, adapter_version: job.adapter_version }, "OBSERVE")) {
        throw new StoreConflictError("Recovery is closed until this mapping has a deployed OBSERVE capability and a published product.");
      }
      await this.#quarantine(client, accountId, "MANUAL_RECOVERY_OBSERVE_REQUIRED");
      await client.query(
        "UPDATE channel_jobs SET status='FINISHED',outcome='NEEDS_REVIEW',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1",
        [job.id, this.#nowIso()],
      );
      const recoveryDesired = await client.query<DbRow>(
        "UPDATE channel_desired_states SET desired_version=desired_version+1,updated_at=$3 WHERE listing_id=$1 AND occurrence_id=$2 RETURNING desired_version,source_start_at,source_end_at",
        [job.listing_id, job.occurrence_id, this.#nowIso()],
      );
      const currentDesired = recoveryDesired.rows[0];
      if (!currentDesired) throw new StoreConflictError("Recovery desired state is missing.");
      const observeJobId = randomUUID();
      await client.query(
        `INSERT INTO channel_jobs
          (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,target_site,
           target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,target_adapter,target_adapter_version,
           target_connection_mode,source_start_at,source_end_at,priority,job_deadline_at)
         VALUES ($1,$2,$3,$4,$5,'OBSERVE',$6,$7,$8,$9,$10,$11,$12,'Asia/Tokyo',$13,$14,$15,$16,$17,90,$18)`,
        [observeJobId, job.provider_id, accountId, job.listing_id, job.occurrence_id, job.current_account_version, currentDesired.desired_version,
          job.current_mapping_version, job.site, job.external_account_id, job.external_product_id, job.external_option_id,
          job.adapter, job.adapter_version, job.connection_mode, currentDesired.source_start_at, currentDesired.source_end_at, null],
      );
      await this.#completeCommand(client, actor, commandId, "account.recover", request, { observeJobId }, text(job, "provider_id"), "external_account", accountId);
      return { observeJobId };
    });
  }

  async hostStatuses(actor: { readonly providerId: string; readonly nihoUserId: string }): Promise<readonly HostChannelStatus[]> {
    assertStoreIdentifier(actor.providerId, "actor.providerId");
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
    const membership = await this.#pool.query(
      "SELECT 1 FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true",
      [actor.providerId, actor.nihoUserId],
    );
    if (!membership.rows[0]) throw new StoreAccessDeniedError();
    const result = await this.#pool.query<DbRow>(
      `SELECT d.occurrence_id,a.site,d.desired_state,d.desired_version,d.mapping_version,d.observed_state,
              d.observed_desired_version,d.observed_mapping_version,d.last_verified_at,d.last_error,
              a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,
              l.active AS listing_active,l.adapter,l.adapter_version,l.can_open,l.can_close,l.mapping_version AS current_mapping_version,p.status AS product_status,
              EXISTS (SELECT 1 FROM calendar_outbox_events e WHERE e.provider_id=d.provider_id AND e.processed_at IS NULL) AS calendar_pending
         FROM channel_desired_states d JOIN channel_listings l ON l.id=d.listing_id
         JOIN channel_external_accounts a ON a.id=l.account_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
        WHERE d.provider_id=$1 ORDER BY d.source_start_at,a.site,l.id`, [actor.providerId],
    );
    return result.rows.map((row) => {
      const desired = text(row, "desired_state") as ChannelDesiredState;
      const observed = row.observed_state === null ? undefined : text(row, "observed_state") as ChannelDesiredState;
      const action = desiredAction(desired);
      let error: string | undefined;
      if (row.account_active !== true) error = "ACCOUNT_INACTIVE";
      else if (row.revoked_at !== null) error = "ACCOUNT_REVOKED";
      else if (row.delegated_until !== null && isoValue(row, "delegated_until") <= this.#nowIso()) error = "DELEGATION_EXPIRED";
      else if (row.quarantined_at !== null) error = "ACCOUNT_QUARANTINED";
      else if (row.listing_active !== true) error = "LISTING_INACTIVE";
      else if (row.product_status !== "PUBLISHED") error = "PRODUCT_UNPUBLISHED";
      else if ((action === "SET_OPEN" ? row.can_open : row.can_close) !== true) error = "CAPABILITY_UNAVAILABLE";
      else if (!this.#adapterSupports(row, action)) error = "ADAPTER_UNAVAILABLE";
      else if (row.last_error !== null) error = "RUNTIME_ERROR";
      const currentObservation = observed !== undefined && row.observed_desired_version !== null && row.observed_mapping_version !== null
        && integer(row, "observed_desired_version") === integer(row, "desired_version")
        && integer(row, "observed_mapping_version") === integer(row, "mapping_version")
        && integer(row, "observed_mapping_version") === integer(row, "current_mapping_version");
      return {
        occurrenceId: text(row, "occurrence_id"), site: text(row, "site"), desired, ...(observed ? { observed } : {}),
        label: error ? "ERROR" : row.calendar_pending === true ? "PENDING" : observed === undefined ? "UNVERIFIED" : currentObservation && observed === desired ? "SYNCED" : "PENDING",
        ...(row.last_verified_at === null ? {} : { lastVerifiedAtUtc: isoValue(row, "last_verified_at") }), ...(error ? { error } : {}),
      };
    });
  }
}
