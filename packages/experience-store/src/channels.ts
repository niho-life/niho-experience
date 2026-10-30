import type { HostActor } from "./types.ts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  addLocalDays,
  expandOccurrences,
  tokyoLocalToUtc,
  type LocalDate,
  type Occurrence,
  type OccurrenceOverride,
  type OccurrenceSalesState,
} from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { isoValue, overrideFromRow, salesStateFromRow, scheduleRuleFromRow, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { evaluateStoredInventory, lockProviderInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { applyExternalReservationObservations } from "./external-reservation-ledger.ts";
import { calendarMembershipRole, listCalendarProductsForActor } from "./product-calendar-authorization.ts";
import { assertCanonicalInstant, assertNonEmptyText, assertSeats, assertStoreIdentifier } from "./validation.ts";
import { currentChannelOccurrence } from "./channel-occurrence.ts";
import {
  HEARTBEAT_STALE_MS,
  countOpenIncidents,
  loadChannelRuntimeOverview,
  providerOpenHeldSql,
  providerWorkerSignals,
  runChannelWatchdog,
  unsyncedDesiredSql,
  type ChannelRuntimeOverview,
  type ChannelWatchdogRunResult,
} from "./channel-runtime-monitor.ts";

import { CHANNEL_SITES } from "./channel-sites.ts";
export { CHANNEL_SITES } from "./channel-sites.ts";
export type ChannelSite = typeof CHANNEL_SITES[number] | (string & {});
export type ChannelConnectionMode = "BROWSER" | "GOOGLE" | "API";
export type ChannelAction = "SET_OPEN" | "SET_CLOSED" | "OBSERVE";
export type ChannelJobPurpose = "AVAILABILITY" | "RESERVATION_WINDOW" | "SLOT_RETIREMENT";
export type ChannelDesiredState = "OPEN" | "CLOSED";
export type ChannelOutcome = "VERIFIED" | "RESERVATION_VERIFIED" | "AUTH_REQUIRED" | "NEEDS_REVIEW" | "UNKNOWN_AFTER_SAVE" | "RETRY_WAIT" | "SUPERSEDED";

/**
 * This actor must be built only after the HTTP boundary has authenticated a current NIHO Admin.
 * Submitted user IDs, provider IDs, cookies, and role strings are never actor evidence.
 */
export interface ChannelAdminActor { readonly nihoUserId: string }

export interface ChannelCapabilities {
  readonly canObserve?: boolean;
  readonly canReadReservations?: boolean;
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
  readonly site: ChannelSite;
  readonly externalAccountId: string;
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
  /** Present only for the dedicated reservation-window executor. */
  readonly purpose?: "RESERVATION_WINDOW";
}

/** Server-only snapshot for the fixed Airbnb -> Google delivery adapter. */
export interface GoogleChannelDeliveryContext {
  readonly jobId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
  readonly assignmentVersion: number;
  readonly action: "SET_OPEN" | "SET_CLOSED" | "OBSERVE";
  readonly accountVersion: number;
  readonly desiredState: ChannelDesiredState;
  readonly desiredVersion: number;
  readonly mappingVersion: number;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
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
  readonly reservationReadId?: string;
  readonly reservationReceiptId?: string;
}

export type ExternalReservationStatus = "PENDING" | "CONFIRMED" | "CANCELLED";
export type ReservationReadBatchStatus = "COMPLETE" | "PARTIAL" | "FAILED";

export interface ReservationReadCycle {
  readonly readId: string;
  readonly generation: number;
  readonly repeated: boolean;
  readonly occurrenceId: string;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
}

export interface ExternalReservationObservation {
  readonly externalReservationId: string;
  readonly externalProductId: string;
  readonly externalOptionId?: string;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly status: ExternalReservationStatus;
  readonly seats: number;
  readonly sourceUpdatedAtUtc?: string;
  /** Opaque equality token. It is never ordered or interpreted. */
  readonly sourceRevision?: string;
}

export interface SubmitReservationReadInput {
  readonly receiptId: string;
  readonly readId: string;
  readonly leaseToken: string;
  readonly batchStatus: ReservationReadBatchStatus;
  readonly observations: readonly ExternalReservationObservation[];
}

export interface ReservationReadReceipt {
  readonly receiptId: string;
  readonly readId: string;
  readonly generation: number;
  readonly batchStatus: ReservationReadBatchStatus;
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly needsReview: number;
  readonly repeated: boolean;
}

export interface ReservationWindowManifestOccurrence {
  readonly occurrenceId: string;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
}

export interface ReservationWindowReadCycle {
  readonly readId: string;
  readonly generation: number;
  readonly scope: "WINDOW";
  readonly repeated: boolean;
  readonly coverageFromUtc: string;
  readonly coverageToUtc: string;
  readonly readStartedAtUtc: string;
  readonly pageNumber: 0;
  readonly receiptId: string;
  readonly manifest: readonly ReservationWindowManifestOccurrence[];
}

export interface ReservationWindowTerminalEvidence {
  readonly status: ReservationReadBatchStatus;
  readonly completedAtUtc: string;
  readonly allPagesRead: boolean;
  readonly allStatusesIncluded: boolean;
  readonly coverageComplete: boolean;
}

export interface SubmitReservationWindowPageInput {
  readonly receiptId: string;
  readonly readId: string;
  readonly leaseToken: string;
  readonly pageNumber: number;
  readonly previousReceiptId?: string;
  readonly sourceCursor?: string;
  readonly nextSourceCursor?: string;
  readonly snapshotToken?: string;
  readonly observations: readonly ExternalReservationObservation[];
  readonly terminal?: ReservationWindowTerminalEvidence;
}

export interface ReservationWindowPageReceipt {
  readonly receiptId: string;
  readonly readId: string;
  readonly generation: number;
  readonly pageNumber: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly duplicateFacts: number;
  readonly stale: number;
  readonly needsReview: number;
  readonly missingActiveReservations: number;
  readonly healthUpdated: boolean;
  readonly repeated: boolean;
  readonly terminalStatus?: ReservationReadBatchStatus;
  readonly nextReceiptId?: string;
}

export interface HostChannelStatus {
  readonly occurrenceId: string;
  readonly site: string;
  readonly desired: ChannelDesiredState;
  readonly observed?: ChannelDesiredState;
  /** HELD: a desired OPEN waits while a Studio for this provider re-reads reservations after a heartbeat gap. */
  readonly label: "SYNCED" | "PENDING" | "ERROR" | "UNVERIFIED" | "HELD";
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
  adapter_version,connection_mode,can_observe,can_read_reservations,can_close,can_open,can_create,active,mapping_version,created_at,updated_at`;

/**
 * Shown through the existing desired-row error while any old-time slot of the
 * occurrence could not be closed and read back. Other runtime errors never
 * overwrite it; it is cleared only when no retirement still needs review.
 */
const SLOT_RETIREMENT_WARNING = "旧日時の掲載枠を停止できていません。掲載先で確認してください。";

/**
 * Sites whose slots are told apart by their end as well as their start (jalan-network-guard.mjs matches startHm
 * and endHm). The others key a slot by its start only (gyg-driver.mjs: option and local start; Viator: date and start).
 */
const SLOT_KEYED_BY_END: ReadonlySet<string> = new Set(["Jalan"]);

/** Whether two times name the same external slot on the site, so closing one would close the other. */
function sameExternalSlot(site: unknown, aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart === bStart && (!SLOT_KEYED_BY_END.has(String(site)) || aEnd === bEnd);
}

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

function canonicalReservationObservation(value: ExternalReservationObservation): ExternalReservationObservation {
  return {
    externalReservationId: value.externalReservationId,
    externalProductId: value.externalProductId,
    externalOptionId: value.externalOptionId ?? "",
    sourceStartAtUtc: value.sourceStartAtUtc,
    sourceEndAtUtc: value.sourceEndAtUtc,
    status: value.status,
    seats: value.seats,
    ...(value.sourceUpdatedAtUtc === undefined ? {} : { sourceUpdatedAtUtc: value.sourceUpdatedAtUtc }),
    ...(value.sourceRevision === undefined ? {} : { sourceRevision: value.sourceRevision }),
  };
}

function validateReservationObservations(values: readonly ExternalReservationObservation[]): readonly ExternalReservationObservation[] {
  if (!Array.isArray(values) || values.length > 32) throw new StoreValidationError("observations must contain at most 32 facts.");
  const reservationIds = new Set<string>();
  for (const [index, observation] of values.entries()) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      throw new StoreValidationError(`observations[${index}] must be an object.`);
    }
    const keys = Object.keys(observation);
    const allowed = ["externalReservationId", "externalProductId", "externalOptionId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats", "sourceUpdatedAtUtc", "sourceRevision"];
    if (keys.some((key) => !allowed.includes(key))) throw new StoreValidationError(`observations[${index}] has unknown fields.`);
    assertNonEmptyText(observation.externalReservationId, `observations[${index}].externalReservationId`, 256);
    assertNonEmptyText(observation.externalProductId, `observations[${index}].externalProductId`, 256);
    if ((observation.externalOptionId ?? "").length > 256) throw new StoreValidationError(`observations[${index}].externalOptionId is too long.`);
    assertCanonicalInstant(observation.sourceStartAtUtc, `observations[${index}].sourceStartAtUtc`);
    assertCanonicalInstant(observation.sourceEndAtUtc, `observations[${index}].sourceEndAtUtc`);
    if (observation.sourceEndAtUtc <= observation.sourceStartAtUtc) throw new StoreValidationError(`observations[${index}] has an invalid time range.`);
    if (!(observation.status === "PENDING" || observation.status === "CONFIRMED" || observation.status === "CANCELLED")) {
      throw new StoreValidationError(`observations[${index}].status is invalid.`);
    }
    assertSeats(observation.seats);
    if (observation.sourceUpdatedAtUtc !== undefined) assertCanonicalInstant(observation.sourceUpdatedAtUtc, `observations[${index}].sourceUpdatedAtUtc`);
    if (observation.sourceRevision !== undefined) assertNonEmptyText(observation.sourceRevision, `observations[${index}].sourceRevision`, 256);
    if (reservationIds.has(observation.externalReservationId)) throw new StoreValidationError("Duplicate external reservation IDs are not allowed in one page.");
    reservationIds.add(observation.externalReservationId);
  }
  return values.map(canonicalReservationObservation);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reservationReceipt(value: unknown, repeated: boolean): ReservationReadReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreConflictError("Reservation receipt is invalid.");
  const result = value as Record<string, unknown>;
  if (typeof result.receiptId !== "string" || typeof result.readId !== "string"
    || !Number.isSafeInteger(result.generation) || !Number.isSafeInteger(result.applied)
    || !Number.isSafeInteger(result.duplicates) || !Number.isSafeInteger(result.stale)
    || !Number.isSafeInteger(result.needsReview)
    || (result.generation as number) < 1 || (result.applied as number) < 0 || (result.duplicates as number) < 0
    || (result.stale as number) < 0 || (result.needsReview as number) < 0
    || !(["COMPLETE", "PARTIAL", "FAILED"] as const).includes(result.batchStatus as ReservationReadBatchStatus)) {
    throw new StoreConflictError("Reservation receipt is invalid.");
  }
  return {
    receiptId: result.receiptId,
    readId: result.readId,
    generation: result.generation as number,
    batchStatus: result.batchStatus as ReservationReadBatchStatus,
    applied: result.applied as number,
    duplicates: result.duplicates as number,
    stale: result.stale as number,
    needsReview: result.needsReview as number,
    repeated,
  };
}

function reservationWindowReceipt(value: unknown, repeated: boolean): ReservationWindowPageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreConflictError("Reservation window receipt is invalid.");
  const result = value as Record<string, unknown>;
  for (const key of ["generation", "pageNumber", "applied", "duplicates", "duplicateFacts", "stale", "needsReview", "missingActiveReservations"] as const) {
    if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0) throw new StoreConflictError("Reservation window receipt is invalid.");
  }
  if (typeof result.receiptId !== "string" || typeof result.readId !== "string" || typeof result.healthUpdated !== "boolean"
    || (result.terminalStatus !== undefined && !(["COMPLETE", "PARTIAL", "FAILED"] as const).includes(result.terminalStatus as ReservationReadBatchStatus))
    || (result.nextReceiptId !== undefined && typeof result.nextReceiptId !== "string")) {
    throw new StoreConflictError("Reservation window receipt is invalid.");
  }
  return { ...(result as unknown as ReservationWindowPageReceipt), repeated };
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
    capabilities: {
      canObserve: row.can_observe === true,
      canReadReservations: row.can_read_reservations === true,
      canClose: row.can_close === true,
      canOpen: row.can_open === true,
      canCreate: row.can_create === true,
    },
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

function tokyoDate(now: Date): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}` as LocalDate;
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
  // Google verification is journaled separately and is never an Airbnb
  // bookability observation. The browser-shaped manualBlocked receipt cannot
  // be used to mark a GOOGLE listing SYNCED.
  if (input.expectedTarget.connectionMode === "GOOGLE") return false;
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
    const requested = {
      canObserve: input.capabilities?.canObserve === true,
      canReadReservations: input.capabilities?.canReadReservations === true,
      canClose: input.capabilities?.canClose === true,
      canOpen: input.capabilities?.canOpen === true,
      canCreate: input.capabilities?.canCreate === true,
    };
    const supported = this.#supportedAdapters[`${site}/${input.adapter}@${input.adapterVersion}`] ?? {};
    for (const key of ["canObserve", "canReadReservations", "canClose", "canOpen", "canCreate"] as const) {
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
      const scope = await client.query<DbRow>("SELECT provider_id FROM channel_external_accounts WHERE id=$1", [accountId]);
      if (!scope.rows[0]) throw new StoreNotFoundError("external account");
      await lockProviderInventory(client, text(scope.rows[0], "provider_id"));
      const previous = await this.#previousCommand(client, actor, commandId, "account.update", request);
      if (previous) return this.#account(client, String(previous.id));
      const existing = await client.query<DbRow>("SELECT * FROM channel_external_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const current = existing.rows[0];
      if (!current) throw new StoreNotFoundError("external account");
      validateAccount({ ...input, id: accountId, providerId: text(current, "provider_id") });
      if (integer(current, "version") !== expectedVersion) throw new StoreConflictError("External account version mismatch.");
      const targetChanged = text(current, "site") !== input.site || text(current, "external_account_id") !== input.externalAccountId;
      if (targetChanged) {
        const activeReservation = await client.query(
          `SELECT 1 FROM external_reservations
            WHERE provider_id=$1 AND account_id=$2 AND status IN ('PENDING','CONFIRMED')
              AND source_end_at>clock_timestamp() LIMIT 1`,
          [current.provider_id, accountId],
        );
        if (activeReservation.rows[0]) throw new StoreConflictError("External account identity cannot change while an active external reservation exists.");
      }
      const updated = await client.query<DbRow>(
        `UPDATE channel_external_accounts SET site=$2,external_account_id=$3,display_name=$4,operating_model=$5,active=$6,
           delegated_until=$7,revoked_at=COALESCE($8,revoked_at),private_profile_ref=COALESCE($9,private_profile_ref),version=version+1,updated_at=$10
         WHERE id=$1 RETURNING ${ACCOUNT_COLUMNS}`,
        [accountId, input.site, input.externalAccountId, input.displayName, input.operatingModel, input.active,
          input.delegatedUntilUtc ?? null, input.revokedAtUtc ?? null, input.privateProfileRef ?? null, this.#nowIso()],
      );
      if (targetChanged) {
        await client.query(
          `UPDATE channel_listings SET active=false,can_observe=false,can_read_reservations=false,can_close=false,can_open=false,can_create=false,
             mapping_version=mapping_version+1,updated_at=$2 WHERE account_id=$1`, [accountId, this.#nowIso()],
        );
      }
      await client.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2 WHERE account_id=$1 AND status='QUEUED'", [accountId, this.#nowIso()]);
      await client.query(
        `UPDATE external_reservation_read_dispatch_states s
            SET pending_job_id=NULL,next_due_at=$2,last_error='AUTHORITY_CHANGED',updated_at=$2
          FROM channel_jobs j WHERE s.pending_job_id=j.id AND j.account_id=$1
            AND j.purpose='RESERVATION_WINDOW' AND j.status='FINISHED' AND j.outcome='SUPERSEDED'`,
        [accountId, this.#nowIso()],
      );
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
           can_observe,can_read_reservations,can_close,can_open,can_create,active)
         VALUES ($1,$2,$3,$4,$5,$6,'Asia/Tokyo',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${LISTING_COLUMNS}`,
        [input.id, input.providerId, input.accountId, input.productId, input.externalProductId, input.externalOptionId ?? "",
          input.adapter, input.adapterVersion, input.connectionMode, capabilities.canObserve, capabilities.canReadReservations,
          capabilities.canClose, capabilities.canOpen, capabilities.canCreate, input.active ?? false],
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
           can_observe=$7,can_read_reservations=$8,can_close=$9,can_open=$10,can_create=$11,active=$12,mapping_version=mapping_version+1,updated_at=$13
         WHERE id=$1 RETURNING ${LISTING_COLUMNS}`,
        [listingId, input.externalProductId, input.externalOptionId ?? "", input.adapter, input.adapterVersion, input.connectionMode,
          capabilities.canObserve, capabilities.canReadReservations, capabilities.canClose, capabilities.canOpen,
          capabilities.canCreate, input.active, this.#nowIso()],
      );
      await client.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2 WHERE listing_id=$1 AND status='QUEUED'", [listingId, this.#nowIso()]);
      await client.query(
        `UPDATE external_reservation_read_dispatch_states s
            SET pending_job_id=NULL,next_due_at=$2,last_error='AUTHORITY_CHANGED',updated_at=$2
          FROM channel_jobs j WHERE s.pending_job_id=j.id AND j.listing_id=$1
            AND j.purpose='RESERVATION_WINDOW' AND j.status='FINISHED' AND j.outcome='SUPERSEDED'`,
        [listingId, this.#nowIso()],
      );
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
        await client.query("INSERT INTO channel_worker_accounts (worker_id,account_id,assigned_at) VALUES ($1,$2,$3)", [workerId, accountId, this.#nowIso()]);
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
      const provider = await client.query<{ provider_id: string }>("SELECT provider_id FROM channel_listings WHERE id=$1", [listingId]);
      if (!provider.rows[0]) throw new StoreNotFoundError("channel listing");
      await lockProviderInventory(client, provider.rows[0].provider_id);
      const previous = await this.#previousCommand(client, actor, commandId, "listing.reconcile", request);
      if (previous) return { occurrences: Number(previous.occurrences), jobs: Number(previous.jobs) };
      const reconciled = await this.#reconcile(client, "l.id=$1", [listingId], 2_000);
      const result = { occurrences: reconciled.occurrences, jobs: reconciled.jobs };
      await this.#completeCommand(client, actor, commandId, "listing.reconcile", request, result, undefined, "listing", listingId);
      return result;
    });
  }

  async enqueueDueReconciliationTicks(identity: WorkerIdentity, limit = 20): Promise<{ readonly enqueued: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("Tick limit must be between 1 and 200.");
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      const nowUtc = this.#nowIso();
      const candidates = await client.query<DbRow>(
        `SELECT DISTINCT a.provider_id
           FROM channel_worker_accounts wa
           JOIN channel_external_accounts a ON a.id=wa.account_id
           JOIN channel_listings l ON l.account_id=a.id
           JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
           LEFT JOIN calendar_reconciliation_ticks t ON t.provider_id=a.provider_id
          WHERE wa.worker_id=$1 AND wa.revoked_at IS NULL AND a.active=true AND a.revoked_at IS NULL
            AND l.active=true AND p.status='PUBLISHED'
            AND (t.provider_id IS NULL OR (t.pending_command_id IS NULL AND t.next_due_at<=$2))
          ORDER BY a.provider_id LIMIT $3`,
        [identity.workerId, nowUtc, limit],
      );
      const candidateProviderIds = candidates.rows.map((row) => text(row, "provider_id")).sort();
      for (const providerId of candidateProviderIds) await lockProviderInventory(client, providerId);
      if (candidateProviderIds.length === 0) return { enqueued: 0 };
      await client.query(
        `INSERT INTO calendar_reconciliation_ticks (provider_id,next_due_at)
         SELECT item,$2::timestamptz FROM unnest($1::text[]) AS item
         ON CONFLICT (provider_id) DO NOTHING`,
        [candidateProviderIds, nowUtc],
      );
      const due = await client.query<DbRow>(
        `SELECT t.provider_id FROM calendar_reconciliation_ticks t
          WHERE t.provider_id=ANY($1::text[]) AND t.pending_command_id IS NULL AND t.next_due_at<=$2
          ORDER BY t.next_due_at,t.provider_id FOR UPDATE OF t`,
        [candidateProviderIds, nowUtc],
      );
      const providerIds = due.rows.map((row) => text(row, "provider_id")).sort();
      for (const providerId of providerIds) {
        const commandId = await enqueueCalendarRecalculation(client, {
          providerId,
          aggregateType: "provider_inventory",
          aggregateId: providerId,
          cause: "due_reconciliation",
        });
        await client.query(
          `UPDATE calendar_reconciliation_ticks SET pending_command_id=$2::uuid,version=version+1,updated_at=$3
            WHERE provider_id=$1 AND pending_command_id IS NULL`,
          [providerId, commandId, nowUtc],
        );
      }
      return { enqueued: providerIds.length };
    });
  }

  async enqueueDueReservationReads(identity: WorkerIdentity, limit = 1): Promise<{ readonly enqueued: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new StoreValidationError("Reservation read limit must be between 1 and 10.");
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      const nowUtc = this.#nowIso();
      const deployedReaders = this.#deployedReaderKeys();

      // A queued reservation job is safe to retire when its immutable authority
      // snapshot is no longer current. A leased job is never touched here.
      const stale = await client.query<DbRow>(
        `SELECT j.id,j.provider_id,j.listing_id
           FROM channel_jobs j
           LEFT JOIN channel_external_accounts a ON a.id=j.account_id
           LEFT JOIN channel_listings l ON l.id=j.listing_id
           LEFT JOIN experience_products p ON p.provider_id=j.provider_id AND p.id=l.product_id
           LEFT JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
           LEFT JOIN channel_worker_accounts wa ON wa.account_id=j.account_id AND wa.worker_id=j.dispatch_worker_id
             AND wa.revoked_at IS NULL AND wa.version=j.dispatch_assignment_version
          WHERE j.purpose='RESERVATION_WINDOW' AND j.status='QUEUED'
            AND (j.dispatch_worker_id=$1 OR EXISTS (SELECT 1 FROM channel_worker_accounts caller
              WHERE caller.account_id=j.account_id AND caller.worker_id=$1 AND caller.revoked_at IS NULL))
            AND (a.id IS NULL OR a.active<>true OR a.revoked_at IS NOT NULL
              OR (a.delegated_until IS NOT NULL AND a.delegated_until<=$2) OR a.quarantined_at IS NOT NULL
              OR a.version IS DISTINCT FROM j.account_version OR l.id IS NULL OR l.active IS DISTINCT FROM true
              OR l.mapping_version IS DISTINCT FROM j.mapping_version
              OR l.can_observe IS DISTINCT FROM true OR l.can_read_reservations IS DISTINCT FROM true
              OR p.status IS DISTINCT FROM 'PUBLISHED' OR wa.worker_id IS NULL
              OR a.site IS DISTINCT FROM j.target_site OR a.external_account_id IS DISTINCT FROM j.target_external_account_id
              OR l.external_product_id IS DISTINCT FROM j.target_external_product_id
              OR l.external_option_id IS DISTINCT FROM j.target_external_option_id
              OR l.adapter IS DISTINCT FROM j.target_adapter OR l.adapter_version IS DISTINCT FROM j.target_adapter_version
              OR l.connection_mode IS DISTINCT FROM j.target_connection_mode OR d.listing_id IS NULL
              OR d.mapping_version IS DISTINCT FROM j.mapping_version
              OR d.source_start_at IS DISTINCT FROM j.source_start_at OR d.source_end_at IS DISTINCT FROM j.source_end_at
              OR NOT ((j.target_site || '/' || j.target_adapter || '@' || j.target_adapter_version)=ANY($3::text[])))
          ORDER BY j.provider_id COLLATE "C",j.listing_id COLLATE "C",j.id LIMIT 100`,
        [identity.workerId, nowUtc, deployedReaders],
      );
      const candidates = await client.query<DbRow>(
        `SELECT l.*,a.site,a.external_account_id,a.version AS account_version,wa.version AS assignment_version,
                s.pending_job_id,s.next_due_at,s.halted_at
           FROM channel_worker_accounts wa
           JOIN channel_external_accounts a ON a.id=wa.account_id
           JOIN channel_listings l ON l.account_id=a.id
           JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
           LEFT JOIN external_reservation_read_dispatch_states s
             ON s.provider_id=l.provider_id AND s.listing_id=l.id
          WHERE wa.worker_id=$1 AND wa.revoked_at IS NULL
            AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2)
            AND a.quarantined_at IS NULL AND l.active=true AND l.can_observe=true AND l.can_read_reservations=true
            AND (a.site || '/' || l.adapter || '@' || l.adapter_version)=ANY($4::text[])
            AND p.status='PUBLISHED' AND (s.listing_id IS NULL OR (s.pending_job_id IS NULL AND s.halted_at IS NULL AND s.next_due_at<=$2))
          ORDER BY COALESCE(s.next_due_at,'-infinity'::timestamptz),l.id COLLATE "C" LIMIT $3`,
        [identity.workerId, nowUtc, limit * 4, deployedReaders],
      );
      const providerIds = [...new Set([...stale.rows, ...candidates.rows].map((row) => text(row, "provider_id")))].sort();
      for (const providerId of providerIds) {
        await lockProviderInventory(client, providerId);
      }
      for (const job of stale.rows) {
        const retired = await client.query(
          "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2 WHERE id=$1::uuid AND status='QUEUED'",
          [job.id, nowUtc],
        );
        // A claim can win after the candidate read. Its pending lease remains
        // owned until the normal stopped-result path releases it.
        if (retired.rowCount !== 1) continue;
        await client.query(
          `UPDATE external_reservation_read_dispatch_states
              SET pending_job_id=NULL,next_due_at=$3,last_error='AUTHORITY_CHANGED',updated_at=$3
            WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$4::uuid`,
          [job.provider_id, job.listing_id, nowUtc, job.id],
        );
      }

      let enqueued = 0;
      for (const candidate of candidates.rows) {
        if (enqueued >= limit) break;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,31))", [`reservation-read-listing:${candidate.id}`]);
        const currentListing = await client.query<DbRow>(
          `SELECT l.*,a.site,a.external_account_id,a.version AS account_version,wa.version AS assignment_version
             FROM channel_worker_accounts wa
             JOIN channel_external_accounts a ON a.id=wa.account_id
             JOIN channel_listings l ON l.account_id=a.id
             JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
            WHERE wa.worker_id=$1 AND wa.revoked_at IS NULL AND l.id=$2
              AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$3)
              AND a.quarantined_at IS NULL AND l.active=true AND l.can_observe=true AND l.can_read_reservations=true
              AND p.status='PUBLISHED' FOR SHARE OF wa,a,l,p`,
          [identity.workerId, candidate.id, nowUtc],
        );
        const listing = currentListing.rows[0];
        if (!listing || !this.#adapterSupports(listing, "OBSERVE") || !this.#adapterSupportsReservationRead(listing)) continue;
        await client.query(
          `INSERT INTO external_reservation_read_dispatch_states
            (provider_id,listing_id,account_id,product_id,next_due_at,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$5,$5) ON CONFLICT (provider_id,listing_id) DO NOTHING`,
          [listing.provider_id, listing.id, listing.account_id, listing.product_id, nowUtc],
        );
        const state = await client.query<DbRow>(
          `SELECT * FROM external_reservation_read_dispatch_states
            WHERE provider_id=$1 AND listing_id=$2 FOR UPDATE`, [listing.provider_id, listing.id],
        );
        if (!state.rows[0] || state.rows[0].pending_job_id !== null || state.rows[0].halted_at !== null
          || isoValue(state.rows[0], "next_due_at") > nowUtc) continue;

        const today = tokyoDate(this.#now());
        const canonical = await this.#reservationWindowManifest(client, text(listing, "provider_id"), text(listing, "product_id"),
          tokyoLocalToUtc(addLocalDays(today, -3), "00:00"), tokyoLocalToUtc(addLocalDays(today, 59), "00:00"));
        const anchorResult = await client.query<DbRow>(
          `SELECT d.* FROM channel_desired_states d
            JOIN unnest($4::text[],$5::timestamptz[],$6::timestamptz[]) AS c(id,start_at,end_at)
              ON d.occurrence_id=c.id AND d.source_start_at=c.start_at AND d.source_end_at=c.end_at
            WHERE d.listing_id=$1 AND d.mapping_version=$2
            ORDER BY CASE WHEN d.source_end_at>$3 THEN 0 ELSE 1 END,d.source_start_at,d.occurrence_id COLLATE "C"
            LIMIT 1 FOR UPDATE OF d`,
          [listing.id, listing.mapping_version, nowUtc, canonical.map((item) => item.id),
            canonical.map((item) => item.startUtc), canonical.map((item) => item.endUtc)],
        );
        const anchor = anchorResult.rows[0];
        if (!anchor) {
          await client.query(
            `UPDATE external_reservation_read_dispatch_states SET retry_count=LEAST(retry_count+1,5),
               last_error='NO_CANONICAL_ANCHOR',next_due_at=$3::timestamptz + interval '1 minute',updated_at=$3
              WHERE provider_id=$1 AND listing_id=$2`, [listing.provider_id, listing.id, nowUtc],
          );
          continue;
        }
        const jobId = randomUUID();
        const dispatchSequence = integer(state.rows[0], "dispatch_sequence") + 1;
        const inserted = await client.query(
          `INSERT INTO channel_jobs
            (id,provider_id,account_id,listing_id,occurrence_id,action,purpose,dispatch_sequence,dispatch_worker_id,dispatch_assignment_version,
             account_version,desired_version,mapping_version,
             target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
             target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,priority,job_deadline_at)
           VALUES ($1,$2,$3,$4,$5,'OBSERVE','RESERVATION_WINDOW',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Asia/Tokyo',$16,$17,$18,$19,$20,40,NULL)`,
          [jobId, listing.provider_id, listing.account_id, listing.id, anchor.occurrence_id, dispatchSequence,
            identity.workerId, listing.assignment_version, listing.account_version, anchor.desired_version, listing.mapping_version, listing.site, listing.external_account_id,
            listing.external_product_id, listing.external_option_id, listing.adapter, listing.adapter_version,
            listing.connection_mode, anchor.source_start_at, anchor.source_end_at],
        );
        if ((inserted.rowCount ?? 0) !== 1) throw new StoreConflictError("Reservation read job was not inserted.");
        await client.query(
          `UPDATE external_reservation_read_dispatch_states SET pending_job_id=$3::uuid,dispatch_sequence=$4,last_error=NULL,updated_at=$5
            WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id IS NULL`,
          [listing.provider_id, listing.id, jobId, dispatchSequence, nowUtc],
        );
        enqueued += 1;
      }
      return { enqueued };
    });
  }

  /** Consume and expand only rows locked by this transaction; any expansion failure rolls back the processed cursor. */
  async consumeCalendarOutbox(limit = 50, identity?: WorkerIdentity): Promise<{ readonly events: number; readonly occurrences: number; readonly jobs: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("Outbox limit must be between 1 and 200.");
    return withTransaction(this.#pool, async (client) => {
      if (identity) await this.#requireWorker(client, identity);
      const events = await client.query<DbRow>(
        `SELECT e.id,e.provider_id,e.command_id,e.channel_dispatch_cursor,e.channel_dispatch_from::text,e.channel_dispatch_to::text FROM calendar_outbox_events e
          WHERE e.processed_at IS NULL AND e.available_at <= $1
            AND ($3::text IS NULL OR EXISTS (
              SELECT 1 FROM channel_worker_accounts wa
              JOIN channel_external_accounts a ON a.id=wa.account_id
              WHERE wa.worker_id=$3 AND wa.revoked_at IS NULL AND a.provider_id=e.provider_id
            ))
          ORDER BY e.id LIMIT $2 FOR UPDATE OF e SKIP LOCKED`,
        [this.#nowIso(), limit, identity?.workerId ?? null],
      );
      for (const providerId of [...new Set(events.rows.map((event) => text(event, "provider_id")))].sort()) {
        await lockProviderInventory(client, providerId);
      }
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
        if (reconciled.continuation === null) {
          completed += 1;
          const nextDueAtUtc = new Date(this.#now().getTime() + 60_000).toISOString();
          await client.query(
            `UPDATE calendar_reconciliation_ticks
                SET pending_command_id=NULL,last_completed_at=$3,next_due_at=$4,version=version+1,updated_at=$3
              WHERE provider_id=$1 AND pending_command_id=$2::uuid`,
            [event.provider_id, event.command_id, this.#nowIso(), nextDueAtUtc],
          );
        }
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
      await this.#reviewOrphanedRetirements(client, listingId);
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
          const availability = await this.#liveAvailability(client, text(listing, "provider_id"), text(listing, "product_id"), occurrence, this.#nowIso());
          const desiredState: ChannelDesiredState = availability.bookable ? "OPEN" : "CLOSED";
          const desired = await this.#upsertDesired(client, listing, occurrence, desiredState, availability.reason);
          jobCount += await this.#enqueueDesiredJob(client, listing, occurrence, desiredState, desired.desiredVersion);
          lastCursor = { listingId, ruleId: storedRule.rule.id, occurrenceId: occurrence.id };
        }
      }
    }
    return { occurrences: occurrenceCount, jobs: jobCount, continuation: null };
  }

  async #liveAvailability(client: PoolClient, providerId: string, productId: string, occurrence: Occurrence, nowUtc: string) {
    return (await evaluateStoredInventory(client, providerId, productId, occurrence, nowUtc, 1)).availability;
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
          (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at,desired_changed_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,
        [listing.id, listing.provider_id, occurrence.id, desiredState, reason, mappingVersion, occurrence.startUtc, occurrence.endUtc, this.#nowIso()],
      );
      return { desiredVersion: 1 };
    }
    const desiredVersion = integer(current, "desired_version") + 1;
    await client.query(
      `UPDATE channel_desired_states SET desired_state=$3,reason=$4,desired_version=$5,mapping_version=$6,source_start_at=$7,
         source_end_at=$8,updated_at=$9,desired_changed_at=$9 WHERE listing_id=$1 AND occurrence_id=$2`,
      [listing.id, occurrence.id, desiredState, reason, desiredVersion, mappingVersion, occurrence.startUtc, occurrence.endUtc, this.#nowIso()],
    );
    if (isoValue(current, "source_start_at") !== occurrence.startUtc || isoValue(current, "source_end_at") !== occurrence.endUtc) {
      await this.#retireRescheduledSlot(client, listing, current, occurrence);
    }
    return { desiredVersion };
  }

  /**
   * Runs in the desired-row transaction when an occurrence keeps its ID but
   * moves in time. `previous` is the locked desired row before the move. The
   * new time stays with the normal desired row; only the old time is retired.
   */
  async #retireRescheduledSlot(client: PoolClient, listing: DbRow, previous: DbRow, occurrence: Occurrence): Promise<void> {
    const nowUtc = this.#nowIso();
    const listingId = text(listing, "id");
    // A -> B -> A: the restored slot belongs to the desired row again (the site's slot, not only the exact times).
    const restored = await client.query<DbRow>(
      `UPDATE channel_slot_retirements SET status='SUPERSEDED',reason='TIME_RESTORED',updated_at=$5
        WHERE listing_id=$1 AND occurrence_id=$2 AND source_start_at=$3 AND ($6::boolean IS FALSE OR source_end_at=$4)
          AND status IN ('PENDING','NEEDS_REVIEW') RETURNING id`,
      [listingId, occurrence.id, occurrence.startUtc, occurrence.endUtc, nowUtc, SLOT_KEYED_BY_END.has(String(listing.site))],
    );
    if (restored.rows.length > 0) {
      await client.query(
        `UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2
          WHERE purpose='SLOT_RETIREMENT' AND slot_retirement_id=ANY($1::uuid[]) AND status='QUEUED'`,
        [restored.rows.map((row) => text(row, "id")), nowUtc],
      );
    }
    // GOOGLE listings are out of scope here: the Google-only output calendar
    // is handled by a separate issue, and its delivery stops on a timing mismatch.
    const verifiedClosed = previous.observed_state === "CLOSED"
      && previous.observed_desired_version !== null && previous.observed_mapping_version !== null
      && integer(previous, "observed_desired_version") === integer(previous, "desired_version")
      && integer(previous, "observed_mapping_version") === integer(previous, "mapping_version");
    // A slot that has already started cannot be sold, and sites drop past slots
    // from their availability pages, so closing it would only fail as drift.
    const oldTimeStarted = isoValue(previous, "source_start_at") <= nowUtc;
    // Only the end moved on a site that keys slots by their start: the old time is the current slot, so nothing retires.
    const slotMoved = !sameExternalSlot(listing.site, isoValue(previous, "source_start_at"), isoValue(previous, "source_end_at"),
      occurrence.startUtc, occurrence.endUtc);
    // The old time was offered under an earlier mapping (another external product or option): this listing's target
    // is not where it was sold, so staff check it instead of closing the new target's slot at that time.
    const mappingChanged = integer(previous, "mapping_version") !== integer(listing, "mapping_version");
    if (listing.connection_mode !== "GOOGLE" && slotMoved && !verifiedClosed && !oldTimeStarted) {
      // OPEN, unverified, or an older observation: fail safe and close the old time.
      const closable = !mappingChanged && listing.can_close === true && this.#adapterSupports(listing, "SET_CLOSED");
      const reviewReason = mappingChanged ? "MAPPING_CHANGED" : "CLOSE_UNSUPPORTED";
      const saved = await client.query<DbRow>(
        `INSERT INTO channel_slot_retirements
          (id,provider_id,listing_id,occurrence_id,source_start_at,source_end_at,mapping_version,account_version,retirement_version,status,reason)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)
         ON CONFLICT (listing_id,occurrence_id,source_start_at,source_end_at) DO UPDATE
           SET mapping_version=EXCLUDED.mapping_version,account_version=EXCLUDED.account_version,
               retirement_version=channel_slot_retirements.retirement_version+1,status=EXCLUDED.status,
               reason=EXCLUDED.reason,updated_at=$11
         RETURNING id,retirement_version`,
        [randomUUID(), listing.provider_id, listingId, occurrence.id, previous.source_start_at, previous.source_end_at,
          mappingChanged ? previous.mapping_version : listing.mapping_version, listing.account_version,
          closable ? "PENDING" : "NEEDS_REVIEW", closable ? null : reviewReason, nowUtc],
      );
      const retirement = saved.rows[0]!;
      if (closable) {
        await client.query(
          `UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$2
            WHERE purpose='SLOT_RETIREMENT' AND slot_retirement_id=$1::uuid AND status='QUEUED'`,
          [retirement.id, nowUtc],
        );
        await client.query(
          `INSERT INTO channel_jobs
            (id,provider_id,account_id,listing_id,occurrence_id,action,purpose,slot_retirement_id,account_version,desired_version,mapping_version,
             target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,target_adapter,
             target_adapter_version,target_connection_mode,source_start_at,source_end_at,priority,job_deadline_at)
           VALUES ($1,$2,$3,$4,$5,'SET_CLOSED','SLOT_RETIREMENT',$6::uuid,$7,$8,$9,$10,$11,$12,$13,'Asia/Tokyo',$14,$15,$16,$17,$18,100,NULL)
           ON CONFLICT (slot_retirement_id,desired_version) WHERE purpose='SLOT_RETIREMENT' DO NOTHING`,
          [randomUUID(), listing.provider_id, listing.account_id, listingId, occurrence.id, retirement.id, listing.account_version,
            integer(retirement, "retirement_version"), listing.mapping_version, listing.site, listing.external_account_id,
            listing.external_product_id, listing.external_option_id, listing.adapter, listing.adapter_version, listing.connection_mode,
            previous.source_start_at, previous.source_end_at],
        );
      }
    }
    await this.#syncRetirementWarning(client, listingId, occurrence.id);
  }

  /** Keeps the desired-row warning equal to "some old-time slot of this occurrence needs review". */
  async #syncRetirementWarning(client: PoolClient, listingId: string, occurrenceId: string): Promise<void> {
    await client.query(
      `UPDATE channel_desired_states d
          SET last_error=CASE
            WHEN EXISTS (SELECT 1 FROM channel_slot_retirements r
              WHERE r.listing_id=d.listing_id AND r.occurrence_id=d.occurrence_id AND r.status='NEEDS_REVIEW') THEN $3
            WHEN d.last_error=$3 THEN NULL ELSE d.last_error END
        WHERE d.listing_id=$1 AND d.occurrence_id=$2`,
      [listingId, occurrenceId, SLOT_RETIREMENT_WARNING],
    );
  }

  /** Only the job's own PENDING retirement version moves; a newer or finished retirement is left alone. */
  async #finishRetirement(client: PoolClient, job: DbRow, status: "CLOSED_VERIFIED" | "NEEDS_REVIEW" | "SUPERSEDED", reason: string | null): Promise<void> {
    const updated = await client.query<DbRow>(
      `UPDATE channel_slot_retirements SET status=$3,reason=$4,updated_at=$5
        WHERE id=$1::uuid AND retirement_version=$2 AND status='PENDING' RETURNING listing_id,occurrence_id`,
      [job.slot_retirement_id, job.desired_version, status, reason, this.#nowIso()],
    );
    const row = updated.rows[0];
    if (row) await this.#syncRetirementWarning(client, text(row, "listing_id"), text(row, "occurrence_id"));
  }

  /**
   * A PENDING retirement whose current job was superseded outside the result
   * path (account or listing update) has no executor left. Make it visible.
   * Callers hold the provider inventory mutex and the listing lock.
   */
  async #reviewOrphanedRetirements(client: PoolClient, listingId: string): Promise<void> {
    const orphaned = await client.query<DbRow>(
      `UPDATE channel_slot_retirements r SET status='NEEDS_REVIEW',reason='AUTHORITY_CHANGED',updated_at=$2
        WHERE r.listing_id=$1 AND r.status='PENDING' AND NOT EXISTS (
          SELECT 1 FROM channel_jobs j WHERE j.purpose='SLOT_RETIREMENT' AND j.slot_retirement_id=r.id
            AND j.desired_version=r.retirement_version AND j.status IN ('QUEUED','LEASED'))
        RETURNING r.occurrence_id`,
      [listingId, this.#nowIso()],
    );
    for (const occurrenceId of new Set(orphaned.rows.map((row) => text(row, "occurrence_id")))) {
      await this.#syncRetirementWarning(client, listingId, occurrenceId);
    }
  }

  async #enqueueDesiredJob(client: PoolClient, listing: DbRow, occurrence: Occurrence, desiredState: ChannelDesiredState, desiredVersion: number): Promise<number> {
    const action = desiredAction(desiredState);
    const capability = (action === "SET_OPEN" ? listing.can_open === true : listing.can_close === true) && this.#adapterSupports(listing, action);
    if (!capability) {
      await client.query(
        "UPDATE channel_desired_states SET last_error=CASE WHEN last_error=$4 THEN last_error ELSE $3 END WHERE listing_id=$1 AND occurrence_id=$2",
        [listing.id, occurrence.id, `${action} is unsupported by this mapping.`, SLOT_RETIREMENT_WARNING],
      );
      return 0;
    }
    const nowUtc = this.#nowIso();
    const accountUsable = listing.account_active === true && listing.revoked_at === null
      && (listing.delegated_until === null || isoValue(listing, "delegated_until") > nowUtc) && listing.quarantined_at === null;
    if (!accountUsable) {
      await client.query(
        `UPDATE channel_desired_states SET last_error=CASE WHEN last_error=$3 THEN last_error
           ELSE 'External account is inactive, expired, revoked, or quarantined.' END WHERE listing_id=$1 AND occurrence_id=$2`,
        [listing.id, occurrence.id, SLOT_RETIREMENT_WARNING],
      );
      return 0;
    }
    const existing = await client.query(
      `SELECT 1 FROM channel_jobs WHERE listing_id=$1 AND occurrence_id=$2 AND action=$3 AND account_version=$4
         AND desired_version=$5 AND mapping_version=$6 AND purpose='AVAILABILITY'`,
      [listing.id, occurrence.id, action, listing.account_version, desiredVersion, listing.mapping_version],
    );
    if (existing.rows[0]) return 0;
    await client.query(
      "UPDATE channel_desired_states SET last_error=CASE WHEN last_error=$3 THEN last_error ELSE NULL END WHERE listing_id=$1 AND occurrence_id=$2",
      [listing.id, occurrence.id, SLOT_RETIREMENT_WARNING],
    );
    await client.query(
      "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',updated_at=$3 WHERE listing_id=$1 AND occurrence_id=$2 AND status='QUEUED' AND purpose='AVAILABILITY'",
      [listing.id, occurrence.id, nowUtc],
    );
    const inserted = await client.query(
      `INSERT INTO channel_jobs
        (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,target_site,
         target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,target_adapter,target_adapter_version,
         target_connection_mode,source_start_at,source_end_at,priority,job_deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Asia/Tokyo',$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (listing_id,occurrence_id,action,account_version,desired_version,mapping_version)
         WHERE purpose='AVAILABILITY' DO NOTHING`,
      [randomUUID(), listing.provider_id, listing.account_id, listing.id, occurrence.id, action, listing.account_version, desiredVersion,
        listing.mapping_version, listing.site, listing.external_account_id, listing.external_product_id, listing.external_option_id,
        listing.adapter, listing.adapter_version, listing.connection_mode, occurrence.startUtc, occurrence.endUtc, desiredState === "CLOSED" ? 100 : 50, null],
    );
    return inserted.rowCount ?? 0;
  }

  async #requireWorker(client: PoolClient, identity: WorkerIdentity): Promise<DbRow> {
    // Serialize a worker's requests before taking job/account locks. SHARE then
    // heartbeat UPDATE lets concurrent claims/renewals deadlock on lock upgrade.
    const result = await client.query<DbRow>("SELECT * FROM channel_workers WHERE id=$1 FOR UPDATE", [identity.workerId]);
    const worker = result.rows[0];
    if (!worker || worker.revoked_at !== null || integer(worker, "version") !== identity.credentialVersion
      || isoValue(worker, "credential_expires_at") <= this.#nowIso()) throw new StoreAccessDeniedError();
    return worker;
  }

  #deployedActionKeys(): string[] {
    return Object.entries(this.#supportedAdapters).flatMap(([key, capability]) => [
      ...(capability.canOpen === true ? [`${key}/SET_OPEN`] : []),
      ...(capability.canClose === true ? [`${key}/SET_CLOSED`] : []),
      ...(capability.canObserve === true ? [`${key}/OBSERVE`] : []),
    ]);
  }

  #deployedReaderKeys(): string[] {
    return Object.entries(this.#supportedAdapters)
      .filter(([, capability]) => capability.canObserve === true && capability.canReadReservations === true)
      .map(([key]) => key);
  }

  /**
   * A heartbeat gap starts this worker's OPEN hold and pulls its reservation
   * reads forward. The hold ends only after every readable listing of its live,
   * unquarantined accounts completed a read that started after the latest gap.
   */
  async #refreshOpenHold(client: PoolClient, worker: DbRow, nowUtc: string): Promise<void> {
    const workerId = text(worker, "id");
    const previousHeartbeat = worker.last_heartbeat_at === null ? null : Date.parse(isoValue(worker, "last_heartbeat_at"));
    let holdSince = worker.open_hold_since === null ? null : isoValue(worker, "open_hold_since");
    if (previousHeartbeat === null || this.#now().getTime() - previousHeartbeat > HEARTBEAT_STALE_MS) {
      // Restart from this gap, not an older hold: a read that finished before the
      // Studio went silent again does not cover reservations taken during the gap.
      holdSince = nowUtc;
      await client.query("UPDATE channel_workers SET open_hold_since=$2 WHERE id=$1", [workerId, nowUtc]);
      // Best effort: a row a dispatcher currently locks keeps its own schedule.
      await client.query(
        `UPDATE external_reservation_read_dispatch_states s SET next_due_at=$2,updated_at=$2
          WHERE (s.provider_id,s.listing_id) IN (
            SELECT ds.provider_id,ds.listing_id FROM external_reservation_read_dispatch_states ds
              JOIN channel_listings l ON l.provider_id=ds.provider_id AND l.id=ds.listing_id
              JOIN channel_external_accounts a ON a.id=l.account_id
              JOIN channel_worker_accounts wa ON wa.account_id=a.id AND wa.worker_id=$1 AND wa.revoked_at IS NULL
             WHERE a.active=true AND a.revoked_at IS NULL AND l.active=true AND l.can_read_reservations=true
               AND ds.pending_job_id IS NULL AND ds.halted_at IS NULL AND ds.next_due_at>$2
             FOR UPDATE OF ds SKIP LOCKED)`,
        [workerId, nowUtc],
      );
    }
    if (holdSince === null) return;
    const unread = await client.query(
      `SELECT 1 FROM channel_worker_accounts wa
         JOIN channel_external_accounts a ON a.id=wa.account_id
         JOIN channel_listings l ON l.account_id=a.id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         LEFT JOIN external_reservation_listing_health h ON h.provider_id=l.provider_id AND h.listing_id=l.id
        WHERE wa.worker_id=$1 AND wa.revoked_at IS NULL
          AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2) AND a.quarantined_at IS NULL
          AND l.active=true AND l.can_observe=true AND l.can_read_reservations=true AND p.status='PUBLISHED'
          AND (a.site || '/' || l.adapter || '@' || l.adapter_version)=ANY($4::text[])
          AND (h.listing_id IS NULL OR h.read_started_at<$3) LIMIT 1`,
      [workerId, nowUtc, holdSince, this.#deployedReaderKeys()],
    );
    if (!unread.rows[0]) await client.query("UPDATE channel_workers SET open_hold_since=NULL WHERE id=$1 AND open_hold_since IS NOT NULL", [workerId]);
  }

  async claim(identity: WorkerIdentity): Promise<ClaimedChannelJob | null> {
    return withTransaction(this.#pool, async (client) => {
      const worker = await this.#requireWorker(client, identity);
      const nowUtc = this.#nowIso();
      await client.query("UPDATE channel_workers SET last_heartbeat_at=$2,updated_at=$2 WHERE id=$1", [identity.workerId, nowUtc]);
      await this.#refreshOpenHold(client, worker, nowUtc);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('channel-browser-global',11))");
      const existingLease = await client.query<DbRow>("SELECT id,account_id,lease_expires_at FROM channel_jobs WHERE status='LEASED' FOR UPDATE");
      if (existingLease.rows[0] && isoValue(existingLease.rows[0], "lease_expires_at") <= nowUtc) {
        await this.#quarantine(client, text(existingLease.rows[0], "account_id"), "LEASE_EXPIRED");
        return null;
      }
      if (existingLease.rows[0]) return null;
      // An expiring retirement also updates its retirement and desired-row
      // warning, so take those providers' inventory mutex first, as dispatchers do.
      const retirementProviders = (await client.query<DbRow>(
        `SELECT DISTINCT provider_id FROM channel_jobs
          WHERE status='QUEUED' AND purpose='SLOT_RETIREMENT'
            AND (attempt_count>=5 OR (job_deadline_at IS NOT NULL AND job_deadline_at<=$1))`, [nowUtc],
      )).rows.map((row) => text(row, "provider_id")).sort();
      for (const providerId of retirementProviders) await lockProviderInventory(client, providerId);
      const expired = await client.query<DbRow>(
        `UPDATE channel_jobs j SET status='FINISHED',outcome='NEEDS_REVIEW',updated_at=$1
          WHERE j.status='QUEUED' AND (j.attempt_count>=5 OR (j.job_deadline_at IS NOT NULL AND j.job_deadline_at<=$1))
            AND (j.purpose<>'SLOT_RETIREMENT' OR j.provider_id=ANY($2::text[]))
          RETURNING j.account_id,j.purpose,j.slot_retirement_id,j.desired_version`, [nowUtc, retirementProviders],
      );
      for (const row of expired.rows) {
        await this.#quarantine(client, text(row, "account_id"), "RETRY_DEADLINE");
        if (row.purpose === "SLOT_RETIREMENT") await this.#finishRetirement(client, row, "NEEDS_REVIEW", "RETRY_DEADLINE");
      }
      const deployedActions = this.#deployedActionKeys();
      const deployedReservationAdapters = this.#deployedReaderKeys();
      const result = await client.query<DbRow>(
        `SELECT j.*,wa.version AS assignment_version FROM channel_jobs j
          JOIN channel_external_accounts a ON a.id=j.account_id
          JOIN channel_listings l ON l.id=j.listing_id
          JOIN experience_products p ON p.provider_id=j.provider_id AND p.id=l.product_id
          LEFT JOIN channel_desired_states d ON j.purpose IN ('AVAILABILITY','RESERVATION_WINDOW')
            AND d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
          LEFT JOIN channel_slot_retirements r ON j.purpose='SLOT_RETIREMENT' AND r.id=j.slot_retirement_id
          JOIN channel_worker_accounts wa ON wa.account_id=j.account_id AND wa.worker_id=$1 AND wa.revoked_at IS NULL
          LEFT JOIN external_reservation_read_dispatch_states rs ON rs.pending_job_id=j.id
         WHERE j.status='QUEUED' AND j.next_attempt_at<=$2 AND (j.job_deadline_at IS NULL OR j.job_deadline_at>$2)
           AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2)
           -- MANUAL_HANDLING: staff own the external profile, so not even an OBSERVE may run until stop-confirmed recovery.
           AND (a.quarantined_at IS NULL OR (j.purpose='AVAILABILITY' AND j.action='OBSERVE' AND a.quarantine_reason<>'MANUAL_HANDLING'))
           AND a.version=j.account_version AND l.active=true AND l.mapping_version=j.mapping_version AND p.status='PUBLISHED'
           AND ((j.purpose IN ('AVAILABILITY','RESERVATION_WINDOW')
               AND d.mapping_version=j.mapping_version AND d.source_start_at=j.source_start_at AND d.source_end_at=j.source_end_at
               AND ((j.purpose='AVAILABILITY' AND d.desired_version=j.desired_version
                    AND (j.action='OBSERVE' OR (j.action='SET_OPEN' AND d.desired_state='OPEN') OR (j.action='SET_CLOSED' AND d.desired_state='CLOSED')))
                 OR (j.purpose='RESERVATION_WINDOW' AND j.action='OBSERVE' AND rs.halted_at IS NULL)))
             OR (j.purpose='SLOT_RETIREMENT' AND j.action='SET_CLOSED' AND r.status='PENDING' AND r.retirement_version=j.desired_version
               AND r.listing_id=j.listing_id AND r.occurrence_id=j.occurrence_id
               AND r.mapping_version=j.mapping_version AND r.account_version=j.account_version
               AND r.source_start_at=j.source_start_at AND r.source_end_at=j.source_end_at))
           AND (j.purpose IN ('AVAILABILITY','SLOT_RETIREMENT') OR (j.dispatch_worker_id=$1 AND j.dispatch_assignment_version=wa.version))
           AND ((j.action='SET_OPEN' AND l.can_open) OR (j.action='SET_CLOSED' AND l.can_close)
             OR (j.action='OBSERVE' AND l.can_observe AND (j.purpose='AVAILABILITY' OR l.can_read_reservations)))
           AND (j.target_site || '/' || j.target_adapter || '@' || j.target_adapter_version || '/' || j.action)=ANY($3::text[])
           AND (j.purpose IN ('AVAILABILITY','SLOT_RETIREMENT') OR (j.target_site || '/' || j.target_adapter || '@' || j.target_adapter_version)=ANY($4::text[]))
           -- New OPEN stays QUEUED (no attempt/deadline) while any live Studio of the provider is held or stale.
           -- preflight does not repeat this; the seconds between claim and preflight are accepted.
           AND (j.action<>'SET_OPEN' OR NOT ${providerOpenHeldSql("j.provider_id", "$2", "$5")})
         ORDER BY j.priority DESC,j.next_attempt_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [identity.workerId, nowUtc, deployedActions, deployedReservationAdapters, new Date(this.#now().getTime() - HEARTBEAT_STALE_MS).toISOString()],
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
        ...(job.purpose === "RESERVATION_WINDOW" ? { purpose: "RESERVATION_WINDOW" as const } : {}),
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

  /**
   * Automatic quarantine. A staff pause (MANUAL_HANDLING) keeps its reason: no lease expiry, late result or other
   * automatic error may turn it into a reason that lets an OBSERVE run or that its completion would clear.
   */
  async #quarantine(client: PoolClient, accountId: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE channel_external_accounts SET quarantined_at=COALESCE(quarantined_at,$2),
         quarantine_reason=CASE WHEN quarantine_reason='MANUAL_HANDLING' THEN quarantine_reason ELSE $3 END,updated_at=$2 WHERE id=$1`,
      [accountId, this.#nowIso(), reason],
    );
  }

  /** Staff actions (pause, stop-confirmed recovery) replace whatever reason is there. */
  async #quarantineByStaff(client: PoolClient, accountId: string, reason: "MANUAL_HANDLING" | "MANUAL_RECOVERY_OBSERVE_REQUIRED"): Promise<void> {
    await client.query(
      "UPDATE channel_external_accounts SET quarantined_at=COALESCE(quarantined_at,$2),quarantine_reason=$3,updated_at=$2 WHERE id=$1",
      [accountId, this.#nowIso(), reason],
    );
  }

  async #lockJobInventory(client: PoolClient, identity: WorkerIdentity, jobId: string, resultId?: string): Promise<void> {
    // Read the worker-owned scope without a job row lock first. Dispatchers lock
    // provider inventory before desired/job rows, so the reverse order can deadlock.
    const scope = await client.query<{ provider_id: string }>(
      `SELECT j.provider_id FROM channel_jobs j WHERE j.id=$1::uuid
        AND (j.leased_worker_id=$2 OR EXISTS (
          SELECT 1 FROM channel_job_results r
           WHERE r.job_id=j.id AND r.worker_id=$2 AND r.result_id=$3::uuid))`,
      [jobId, identity.workerId, resultId ?? null],
    );
    if (!scope.rows[0]) throw new StoreAccessDeniedError();
    await lockProviderInventory(client, scope.rows[0].provider_id);
  }

  #adapterSupportsReservationRead(row: DbRow): boolean {
    const site = text(row, row.target_site === undefined ? "site" : "target_site");
    const adapter = text(row, row.target_adapter === undefined ? "adapter" : "target_adapter");
    const version = text(row, row.target_adapter_version === undefined ? "adapter_version" : "target_adapter_version");
    return this.#supportedAdapters[`${site}/${adapter}@${version}`]?.canReadReservations === true;
  }

  async #requireReservationReadAuthority(client: PoolClient, job: DbRow): Promise<{ readonly occurrence: Occurrence; readonly current: DbRow }> {
    const nowUtc = this.#nowIso();
    if (job.action !== "OBSERVE" || isoValue(job, "lease_expires_at") <= nowUtc || isoValue(job, "job_deadline_at") <= nowUtc) {
      throw new StoreConflictError("Reservation read lease is stale.");
    }
    const state = await client.query<DbRow>(
      `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,a.site,a.external_account_id,
              l.active AS listing_active,l.product_id,l.mapping_version,l.external_product_id,l.external_option_id,l.adapter,l.adapter_version,
              l.connection_mode,l.can_observe,l.can_read_reservations,p.status AS product_status
         FROM channel_external_accounts a
         JOIN channel_listings l ON l.account_id=a.id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
        WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,p`,
      [job.account_id, job.listing_id],
    );
    const current = state.rows[0];
    if (!current || current.account_active !== true || current.revoked_at !== null
      || (current.delegated_until !== null && isoValue(current, "delegated_until") <= nowUtc) || current.quarantined_at !== null
      || current.listing_active !== true || current.product_status !== "PUBLISHED"
      || current.can_observe !== true || current.can_read_reservations !== true
      || integer(current, "account_version") !== integer(job, "account_version")
      || integer(current, "mapping_version") !== integer(job, "mapping_version")
      || current.site !== job.target_site || current.external_account_id !== job.target_external_account_id
      || current.external_product_id !== job.target_external_product_id || current.external_option_id !== job.target_external_option_id
      || current.adapter !== job.target_adapter || current.adapter_version !== job.target_adapter_version
      || current.connection_mode !== job.target_connection_mode
      || !this.#adapterSupports(job, "OBSERVE") || !this.#adapterSupportsReservationRead(job)) {
      throw new StoreConflictError("Reservation read authority is stale.");
    }
    const occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
    if (occurrence.startUtc !== isoValue(job, "source_start_at") || occurrence.endUtc !== isoValue(job, "source_end_at")) {
      throw new StoreConflictError("Reservation read occurrence mapping is stale.");
    }
    return { occurrence, current };
  }

  async #reservationWindowManifest(
    client: PoolClient,
    providerId: string,
    productId: string,
    coverageFromUtc: string,
    coverageToUtc: string,
  ): Promise<readonly Occurrence[]> {
    const fromDate = tokyoDate(new Date(coverageFromUtc));
    const toDate = tokyoDate(new Date(coverageToUtc));
    const rules = await client.query<DbRow>(
      `SELECT ${RULE_COLUMNS} FROM schedule_rules WHERE provider_id=$1 AND product_id=$2 ORDER BY id COLLATE "C"`,
      [providerId, productId],
    );
    const occurrences: Occurrence[] = [];
    for (const ruleRow of rules.rows) {
      const storedRule = scheduleRuleFromRow(ruleRow);
      const overridesResult = await client.query<DbRow>(
        `SELECT occurrence_id,kind,local_date::text AS local_date,to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,version
           FROM schedule_occurrence_overrides WHERE provider_id=$1 AND rule_id=$2`,
        [providerId, storedRule.rule.id],
      );
      const salesResult = await client.query<DbRow>(
        "SELECT occurrence_id,desired_state,version FROM schedule_occurrence_sales_states WHERE provider_id=$1 AND rule_id=$2",
        [providerId, storedRule.rule.id],
      );
      const expanded = expandOccurrences({
        rule: storedRule.rule,
        overrides: overridesResult.rows.map((row) => overrideFromRow(row).override),
        salesStates: salesResult.rows.map((row) => salesStateFromRow(row).state),
        fromDate,
        toDate,
      }).filter((occurrence) => occurrence.startUtc >= coverageFromUtc && occurrence.startUtc < coverageToUtc);
      occurrences.push(...expanded);
      if (occurrences.length > 512) throw new StoreConflictError("Reservation window exceeds 512 canonical occurrences.");
    }
    occurrences.sort((left, right) => left.startUtc.localeCompare(right.startUtc)
      || left.endUtc.localeCompare(right.endUtc) || left.id.localeCompare(right.id));
    return occurrences;
  }

  async beginReservationWindowRead(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<ReservationWindowReadCycle> {
    assertUuid(jobId, "jobId");
    assertNonEmptyText(leaseToken, "leaseToken", 100);
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      await this.#lockJobInventory(client, identity, jobId);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      if (job.purpose !== "RESERVATION_WINDOW") throw new StoreConflictError("This job is not a reservation-window read.");
      const authority = await this.#requireReservationReadAuthority(client, job);
      const existing = await client.query<DbRow>(
        `SELECT r.*,p.receipt_id FROM external_reservation_reads r
           JOIN external_reservation_window_page_receipts p ON p.read_id=r.read_id AND p.page_number=0
          WHERE r.job_id=$1::uuid AND r.lease_epoch=$2 AND r.read_scope='WINDOW'`,
        [jobId, job.lease_epoch],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const manifest = await client.query<DbRow>(
          `SELECT occurrence_id,source_start_at,source_end_at FROM external_reservation_read_manifest_occurrences
            WHERE read_id=$1::uuid ORDER BY manifest_index`, [row.read_id],
        );
        return {
          readId: text(row, "read_id"), generation: integer(row, "read_generation"), scope: "WINDOW", repeated: true,
          coverageFromUtc: isoValue(row, "coverage_from"), coverageToUtc: isoValue(row, "coverage_to"),
          readStartedAtUtc: isoValue(row, "read_started_at"), pageNumber: 0, receiptId: text(row, "receipt_id"),
          manifest: manifest.rows.map((item) => ({ occurrenceId: text(item, "occurrence_id"),
            sourceStartAtUtc: isoValue(item, "source_start_at"), sourceEndAtUtc: isoValue(item, "source_end_at") })),
        };
      }
      const readStartedAtUtc = this.#nowIso();
      const today = tokyoDate(this.#now());
      const coverageFromUtc = tokyoLocalToUtc(addLocalDays(today, -3), "00:00");
      const coverageToUtc = tokyoLocalToUtc(addLocalDays(today, 59), "00:00");
      const occurrences = await this.#reservationWindowManifest(client, text(job, "provider_id"), text(authority.current, "product_id"), coverageFromUtc, coverageToUtc);
      const manifest = occurrences.map((occurrence) => ({ occurrenceId: occurrence.id,
        sourceStartAtUtc: occurrence.startUtc, sourceEndAtUtc: occurrence.endUtc }));
      const manifestFingerprint = fingerprint(manifest);
      const readId = randomUUID();
      const firstReceiptId = randomUUID();
      const inserted = await client.query<DbRow>(
        `INSERT INTO external_reservation_reads
          (read_id,job_id,worker_id,lease_epoch,lease_assignment_version,provider_id,account_id,listing_id,product_id,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,
           account_version,mapping_version,read_scope,coverage_from,coverage_to,manifest_fingerprint,read_started_at)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'WINDOW',$16,$17,$18,$19)
         RETURNING read_generation`,
        [readId, jobId, identity.workerId, job.lease_epoch, job.lease_assignment_version, job.provider_id, job.account_id,
          job.listing_id, authority.current.product_id, job.target_site, job.target_external_account_id,
          job.target_external_product_id, job.target_external_option_id, job.account_version, job.mapping_version,
          coverageFromUtc, coverageToUtc, manifestFingerprint, readStartedAtUtc],
      );
      for (const [index, occurrence] of manifest.entries()) {
        await client.query(
          `INSERT INTO external_reservation_read_manifest_occurrences
            (read_id,manifest_index,occurrence_id,source_start_at,source_end_at) VALUES ($1::uuid,$2,$3,$4,$5)`,
          [readId, index, occurrence.occurrenceId, occurrence.sourceStartAtUtc, occurrence.sourceEndAtUtc],
        );
      }
      await client.query(
        `INSERT INTO external_reservation_window_page_receipts
          (receipt_id,read_id,job_id,worker_id,page_number) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,0)`,
        [firstReceiptId, readId, jobId, identity.workerId],
      );
      return {
        readId, generation: integer(inserted.rows[0]!, "read_generation"), scope: "WINDOW", repeated: false,
        coverageFromUtc, coverageToUtc, readStartedAtUtc, pageNumber: 0, receiptId: firstReceiptId, manifest,
      };
    });
  }

  async beginReservationRead(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<ReservationReadCycle> {
    assertUuid(jobId, "jobId");
    assertNonEmptyText(leaseToken, "leaseToken", 100);
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      await this.#lockJobInventory(client, identity, jobId);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      if (job.purpose !== "AVAILABILITY") throw new StoreConflictError("This job is not a one-occurrence read.");
      const authority = await this.#requireReservationReadAuthority(client, job);
      const existing = await client.query<DbRow>(
        `SELECT read_id,read_generation,occurrence_id,source_start_at,source_end_at
           FROM external_reservation_reads WHERE job_id=$1::uuid AND lease_epoch=$2 AND read_scope='OCCURRENCE'`,
        [jobId, job.lease_epoch],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          readId: text(row, "read_id"), generation: integer(row, "read_generation"), repeated: true,
          occurrenceId: text(row, "occurrence_id"), sourceStartAtUtc: isoValue(row, "source_start_at"), sourceEndAtUtc: isoValue(row, "source_end_at"),
        };
      }
      const readId = randomUUID();
      const inserted = await client.query<DbRow>(
        `INSERT INTO external_reservation_reads
          (read_id,job_id,worker_id,lease_epoch,lease_assignment_version,provider_id,account_id,listing_id,product_id,occurrence_id,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,source_start_at,source_end_at,
           account_version,mapping_version)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING read_generation`,
        [readId, jobId, identity.workerId, job.lease_epoch, job.lease_assignment_version, job.provider_id, job.account_id,
          job.listing_id, text(authority.current, "product_id"), job.occurrence_id,
          job.target_site, job.target_external_account_id, job.target_external_product_id, job.target_external_option_id,
          job.source_start_at, job.source_end_at, job.account_version, job.mapping_version],
      );
      return {
        readId, generation: integer(inserted.rows[0]!, "read_generation"), repeated: false,
        occurrenceId: text(job, "occurrence_id"), sourceStartAtUtc: isoValue(job, "source_start_at"), sourceEndAtUtc: isoValue(job, "source_end_at"),
      };
    });
  }

  async submitReservationWindowPage(
    identity: WorkerIdentity,
    jobId: string,
    input: SubmitReservationWindowPageInput,
  ): Promise<ReservationWindowPageReceipt> {
    assertUuid(jobId, "jobId");
    assertUuid(input.receiptId, "receiptId");
    assertUuid(input.readId, "readId");
    assertNonEmptyText(input.leaseToken, "leaseToken", 100);
    if (!Number.isInteger(input.pageNumber) || input.pageNumber < 0 || input.pageNumber > 4095) {
      throw new StoreValidationError("pageNumber is invalid.");
    }
    if (input.previousReceiptId !== undefined) assertUuid(input.previousReceiptId, "previousReceiptId");
    if (input.sourceCursor !== undefined) assertNonEmptyText(input.sourceCursor, "sourceCursor", 512);
    if (input.nextSourceCursor !== undefined) assertNonEmptyText(input.nextSourceCursor, "nextSourceCursor", 512);
    if (input.snapshotToken !== undefined) assertNonEmptyText(input.snapshotToken, "snapshotToken", 256);
    const observations = validateReservationObservations(input.observations);
    if (input.pageNumber === 0 && input.sourceCursor !== undefined) throw new StoreValidationError("The first page cannot include a source cursor.");
    if (input.pageNumber > 0 && input.sourceCursor === undefined) throw new StoreValidationError("A later page requires the previous source cursor.");
    if (input.terminal === undefined && input.nextSourceCursor === undefined) throw new StoreValidationError("A non-terminal page requires a next source cursor.");
    if (input.terminal === undefined && input.pageNumber === 4095) throw new StoreValidationError("The final bounded page must be terminal.");
    if (input.terminal !== undefined && input.nextSourceCursor !== undefined) throw new StoreValidationError("A terminal page cannot include a next source cursor.");
    if (input.terminal !== undefined) {
      const terminalKeys = Object.keys(input.terminal);
      const expectedKeys = ["status", "completedAtUtc", "allPagesRead", "allStatusesIncluded", "coverageComplete"];
      if (terminalKeys.length !== expectedKeys.length || terminalKeys.some((key) => !expectedKeys.includes(key))) {
        throw new StoreValidationError("terminal has unknown or missing fields.");
      }
      if (!(input.terminal.status === "COMPLETE" || input.terminal.status === "PARTIAL" || input.terminal.status === "FAILED")
        || typeof input.terminal.allPagesRead !== "boolean" || typeof input.terminal.allStatusesIncluded !== "boolean"
        || typeof input.terminal.coverageComplete !== "boolean") throw new StoreValidationError("terminal is invalid.");
      assertCanonicalInstant(input.terminal.completedAtUtc, "terminal.completedAtUtc");
      if (input.terminal.status === "COMPLETE" && !(input.terminal.allPagesRead
        && input.terminal.allStatusesIncluded && input.terminal.coverageComplete)) {
        throw new StoreValidationError("A complete terminal page requires complete pagination, status, and coverage evidence.");
      }
      if (input.terminal.status === "FAILED" && observations.length !== 0) throw new StoreValidationError("A failed terminal page cannot contain facts.");
    }
    const canonicalInput = {
      jobId, workerId: identity.workerId, receiptId: input.receiptId, readId: input.readId,
      leaseToken: input.leaseToken, pageNumber: input.pageNumber,
      previousReceiptId: input.previousReceiptId ?? "", sourceCursor: input.sourceCursor ?? "",
      nextSourceCursor: input.nextSourceCursor ?? "",
      snapshotToken: input.snapshotToken ?? "", observations,
      terminal: input.terminal === undefined ? null : {
        status: input.terminal.status,
        completedAtUtc: input.terminal.completedAtUtc,
        allPagesRead: input.terminal.allPagesRead,
        allStatusesIncluded: input.terminal.allStatusesIncluded,
        coverageComplete: input.terminal.coverageComplete,
      },
    };
    const requestFingerprint = fingerprint(canonicalInput);
    const sourceCursorFingerprint = input.sourceCursor === undefined ? null : digest(input.sourceCursor);
    const nextSourceCursorFingerprint = input.nextSourceCursor === undefined ? null : digest(input.nextSourceCursor);
    const snapshotTokenFingerprint = input.snapshotToken === undefined ? null : digest(input.snapshotToken);

    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      const scope = await client.query<{ provider_id: string }>(
        `SELECT j.provider_id FROM channel_jobs j
          JOIN external_reservation_window_page_receipts p ON p.job_id=j.id
         WHERE j.id=$1::uuid AND p.receipt_id=$3::uuid AND p.worker_id=$2`,
        [jobId, identity.workerId, input.receiptId],
      );
      if (!scope.rows[0]) throw new StoreAccessDeniedError();
      await lockProviderInventory(client, scope.rows[0].provider_id);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,29))", [`external-reservation-window-receipt:${input.receiptId}`]);
      const pageResult = await client.query<DbRow>(
        "SELECT * FROM external_reservation_window_page_receipts WHERE receipt_id=$1::uuid FOR UPDATE", [input.receiptId],
      );
      const page = pageResult.rows[0];
      if (!page || page.read_id !== input.readId || page.job_id !== jobId || page.worker_id !== identity.workerId
        || integer(page, "page_number") !== input.pageNumber
        || (page.previous_receipt_id ?? undefined) !== input.previousReceiptId) throw new StoreAccessDeniedError();
      if (page.request_fingerprint !== null) {
        if (page.request_fingerprint !== requestFingerprint) throw new StoreConflictError("Reservation page receipt was already used with different input.");
        const authorized = await client.query<DbRow>(
          `SELECT j.target_site,j.target_adapter,j.target_adapter_version FROM external_reservation_reads r
             JOIN channel_worker_accounts wa ON wa.account_id=r.account_id AND wa.worker_id=r.worker_id
             JOIN channel_external_accounts a ON a.id=r.account_id AND a.provider_id=r.provider_id
             JOIN channel_listings l ON l.id=r.listing_id AND l.provider_id=r.provider_id AND l.account_id=r.account_id
             JOIN channel_jobs j ON j.id=r.job_id
             JOIN experience_products p ON p.provider_id=r.provider_id AND p.id=r.product_id
            WHERE r.read_id=$1::uuid AND r.read_scope='WINDOW' AND j.purpose='RESERVATION_WINDOW'
              AND wa.revoked_at IS NULL AND wa.version=r.lease_assignment_version
              AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2)
              AND a.version=r.account_version AND a.site=r.target_site AND a.external_account_id=r.target_external_account_id
              AND l.active=true AND l.can_observe=true AND l.can_read_reservations=true
              AND l.mapping_version=r.mapping_version AND l.product_id=r.product_id
              AND l.external_product_id=r.target_external_product_id AND l.external_option_id=r.target_external_option_id
              AND l.adapter=j.target_adapter AND l.adapter_version=j.target_adapter_version
              AND l.connection_mode=j.target_connection_mode AND p.status='PUBLISHED'
            FOR SHARE OF wa,a,l,p`, [input.readId, this.#nowIso()],
        );
        if (!authorized.rows[0] || !this.#adapterSupports(authorized.rows[0], "OBSERVE")
          || !this.#adapterSupportsReservationRead(authorized.rows[0])) throw new StoreAccessDeniedError();
        return reservationWindowReceipt(page.result, true);
      }

      const job = await this.#leasedJob(client, identity, jobId, input.leaseToken);
      if (job.purpose !== "RESERVATION_WINDOW") throw new StoreConflictError("This job is not a reservation-window read.");
      await this.#requireReservationReadAuthority(client, job);
      const readResult = await client.query<DbRow>(
        "SELECT * FROM external_reservation_reads WHERE read_id=$1::uuid FOR UPDATE", [input.readId],
      );
      const read = readResult.rows[0];
      if (!read || read.read_scope !== "WINDOW" || read.status !== "OPEN" || read.job_id !== jobId || read.worker_id !== identity.workerId
        || integer(read, "lease_epoch") !== integer(job, "lease_epoch")
        || integer(read, "lease_assignment_version") !== integer(job, "lease_assignment_version")) throw new StoreAccessDeniedError();
      if (input.pageNumber === 0 && input.previousReceiptId !== undefined) throw new StoreConflictError("The first page cannot have a predecessor.");
      if (input.pageNumber > 0) {
        if (input.previousReceiptId === undefined) throw new StoreConflictError("The page predecessor is missing.");
        const previous = await client.query<DbRow>(
          `SELECT * FROM external_reservation_window_page_receipts
            WHERE receipt_id=$1::uuid AND read_id=$2::uuid AND page_number=$3 FOR UPDATE`,
          [input.previousReceiptId, input.readId, input.pageNumber - 1],
        );
        const previousPage = previous.rows[0];
        if (!previousPage || previousPage.request_fingerprint === null || previousPage.terminal_status !== null
          || previousPage.next_source_cursor_fingerprint !== sourceCursorFingerprint
          || previousPage.snapshot_token_fingerprint !== snapshotTokenFingerprint) {
          throw new StoreConflictError("Reservation window page order, source cursor, or snapshot token is inconsistent.");
        }
      }
      if (nextSourceCursorFingerprint !== null) {
        const reusedCursor = await client.query(
          `SELECT 1 FROM external_reservation_window_page_receipts
            WHERE read_id=$1::uuid AND submitted_at IS NOT NULL
              AND (source_cursor_fingerprint=$2 OR next_source_cursor_fingerprint=$2) LIMIT 1`,
          [input.readId, nextSourceCursorFingerprint],
        );
        if (reusedCursor.rows.length > 0) throw new StoreConflictError("Reservation pagination cursor did not advance.");
      }
      const coverageFromUtc = isoValue(read, "coverage_from");
      const coverageToUtc = isoValue(read, "coverage_to");
      const currentManifest = await this.#reservationWindowManifest(
        client, text(read, "provider_id"), text(read, "product_id"), coverageFromUtc, coverageToUtc,
      );
      const currentManifestDto = currentManifest.map((occurrence) => ({ occurrenceId: occurrence.id,
        sourceStartAtUtc: occurrence.startUtc, sourceEndAtUtc: occurrence.endUtc }));
      if (fingerprint(currentManifestDto) !== read.manifest_fingerprint) {
        throw new StoreConflictError("Reservation window manifest is stale.");
      }
      const targetsByTime = new Map<string, Occurrence[]>();
      for (const occurrence of currentManifest) {
        const key = `${occurrence.startUtc}\n${occurrence.endUtc}`;
        targetsByTime.set(key, [...(targetsByTime.get(key) ?? []), occurrence]);
      }

      const newObservations: ExternalReservationObservation[] = [];
      let duplicateFacts = 0;
      for (const observation of observations) {
        const observationFingerprint = fingerprint(observation);
        const seen = await client.query<DbRow>(
          `SELECT observation_fingerprint FROM external_reservation_window_facts
            WHERE read_id=$1::uuid AND external_reservation_id=$2`, [input.readId, observation.externalReservationId],
        );
        if (seen.rows[0]) {
          if (seen.rows[0].observation_fingerprint !== observationFingerprint) {
            throw new StoreConflictError("A reservation changed between pages; the scan is incomplete.");
          }
          duplicateFacts += 1;
          continue;
        }
        await client.query(
          `INSERT INTO external_reservation_window_facts
            (read_id,external_reservation_id,observation_fingerprint,first_page_number) VALUES ($1::uuid,$2,$3,$4)`,
          [input.readId, observation.externalReservationId, observationFingerprint, input.pageNumber],
        );
        newObservations.push(observation);
      }
      const generation = integer(read, "read_generation");
      const providerId = text(read, "provider_id");
      const applied = await applyExternalReservationObservations(client, {
        readId: input.readId, generation, providerId, accountId: text(read, "account_id"), listingId: text(read, "listing_id"),
        productId: text(read, "product_id"), targetSite: text(read, "target_site"),
        targetExternalAccountId: text(read, "target_external_account_id"),
        targetExternalProductId: text(read, "target_external_product_id"),
        targetExternalOptionId: text(read, "target_external_option_id"),
      }, newObservations, async (observation) => {
        const matches = targetsByTime.get(`${observation.sourceStartAtUtc}\n${observation.sourceEndAtUtc}`) ?? [];
        return matches.length === 1 ? { occurrence: matches[0]! } : null;
      }, () => this.#nowIso());

      let missingActiveReservations = 0;
      let healthUpdated = false;
      let nextReceiptId: string | undefined;
      const terminalStatus = input.terminal?.status;
      if (input.terminal === undefined) {
        nextReceiptId = randomUUID();
        await client.query(
          `INSERT INTO external_reservation_window_page_receipts
            (receipt_id,read_id,job_id,worker_id,page_number,previous_receipt_id)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid)`,
          [nextReceiptId, input.readId, jobId, identity.workerId, input.pageNumber + 1, input.receiptId],
        );
      } else {
        const completedAtUtc = input.terminal.completedAtUtc;
        const nowWithSkew = new Date(this.#now().getTime() + 5 * 60 * 1_000).toISOString();
        if (completedAtUtc < isoValue(read, "read_started_at") || completedAtUtc > nowWithSkew) {
          throw new StoreConflictError("Reservation window completion time is outside the read.");
        }
        const manifestIds = currentManifest.map((occurrence) => occurrence.id);
        const missing = await client.query<DbRow>(
          `SELECT count(*)::text AS count FROM external_reservations e
            WHERE e.provider_id=$1 AND e.listing_id=$2 AND e.account_id=$3
              AND e.status IN ('PENDING','CONFIRMED')
              AND (e.occurrence_id=ANY($4::text[]) OR (e.source_start_at >= $5 AND e.source_start_at < $6))
              AND NOT EXISTS (SELECT 1 FROM external_reservation_window_facts f
                WHERE f.read_id=$7::uuid AND f.external_reservation_id=e.external_reservation_id)`,
          [providerId, read.listing_id, read.account_id, manifestIds, coverageFromUtc, coverageToUtc, input.readId],
        );
        missingActiveReservations = Number(missing.rows[0]?.count ?? 0);
        const unresolved = await client.query(
          `SELECT 1 FROM external_reservation_revisions
            WHERE read_id=$1::uuid AND disposition IN ('NEEDS_REVIEW','STALE') LIMIT 1`, [input.readId],
        );
        const completeEvidence = input.terminal.status === "COMPLETE" && input.terminal.allPagesRead
          && input.terminal.allStatusesIncluded && input.terminal.coverageComplete;
        if (completeEvidence && missingActiveReservations === 0 && unresolved.rows.length === 0) {
          const freshUntilUtc = new Date(new Date(completedAtUtc).getTime() + 45 * 60 * 1_000).toISOString();
          const nextDueAtUtc = new Date(new Date(completedAtUtc).getTime() + 15 * 60 * 1_000).toISOString();
          const health = await client.query(
            `INSERT INTO external_reservation_listing_health
              (provider_id,listing_id,account_id,product_id,read_id,read_generation,account_version,mapping_version,
               coverage_from,coverage_to,read_started_at,read_finished_at,last_complete_at,next_due_at,fresh_until)
             VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14)
             ON CONFLICT (provider_id,listing_id) DO UPDATE SET
               account_id=EXCLUDED.account_id,product_id=EXCLUDED.product_id,read_id=EXCLUDED.read_id,
               read_generation=EXCLUDED.read_generation,account_version=EXCLUDED.account_version,mapping_version=EXCLUDED.mapping_version,
               coverage_from=EXCLUDED.coverage_from,coverage_to=EXCLUDED.coverage_to,read_started_at=EXCLUDED.read_started_at,
               read_finished_at=EXCLUDED.read_finished_at,last_complete_at=EXCLUDED.last_complete_at,
               next_due_at=EXCLUDED.next_due_at,fresh_until=EXCLUDED.fresh_until,updated_at=clock_timestamp()
             WHERE external_reservation_listing_health.read_generation < EXCLUDED.read_generation
             RETURNING 1`,
            [providerId, read.listing_id, read.account_id, read.product_id, input.readId, generation,
              read.account_version, read.mapping_version, coverageFromUtc, coverageToUtc,
              read.read_started_at, completedAtUtc, nextDueAtUtc, freshUntilUtc],
          );
          healthUpdated = health.rows.length > 0;
          if (healthUpdated) {
            await enqueueCalendarRecalculation(client, {
              providerId, aggregateType: "product_inventory", aggregateId: text(read, "product_id"),
              cause: "external_reservation_read_health_changed",
            });
            await enqueueCalendarRecalculation(client, {
              providerId, aggregateType: "product_inventory", aggregateId: text(read, "product_id"),
              cause: "external_reservation_read_health_expired", availableAtUtc: freshUntilUtc,
            });
          }
        }
        await client.query(
          `UPDATE external_reservation_reads SET status='SUBMITTED',batch_status=$2,submitted_at=$3
            WHERE read_id=$1::uuid`, [input.readId, input.terminal.status, completedAtUtc],
        );
      }
      const storedResult = {
        receiptId: input.receiptId, readId: input.readId, generation, pageNumber: input.pageNumber,
        applied: applied.applied, duplicates: applied.duplicates, duplicateFacts, stale: applied.stale,
        needsReview: applied.needsReview, missingActiveReservations, healthUpdated,
        ...(terminalStatus === undefined ? {} : { terminalStatus }),
        ...(nextReceiptId === undefined ? {} : { nextReceiptId }),
      };
      await client.query(
        `UPDATE external_reservation_window_page_receipts SET request_fingerprint=$2,source_cursor_fingerprint=$3,
           next_source_cursor_fingerprint=$4,snapshot_token_fingerprint=$5,
           terminal_status=$6,result=$7::jsonb,submitted_at=$8 WHERE receipt_id=$1::uuid`,
        [input.receiptId, requestFingerprint, sourceCursorFingerprint, nextSourceCursorFingerprint,
          snapshotTokenFingerprint, terminalStatus ?? null, JSON.stringify(storedResult), this.#nowIso()],
      );
      return { ...storedResult, repeated: false };
    });
  }

  async submitReservationRead(identity: WorkerIdentity, jobId: string, input: SubmitReservationReadInput): Promise<ReservationReadReceipt> {
    assertUuid(jobId, "jobId");
    assertUuid(input.receiptId, "receiptId");
    assertUuid(input.readId, "readId");
    assertNonEmptyText(input.leaseToken, "leaseToken", 100);
    if (!(input.batchStatus === "COMPLETE" || input.batchStatus === "PARTIAL" || input.batchStatus === "FAILED")) {
      throw new StoreValidationError("batchStatus is invalid.");
    }
    if (!Array.isArray(input.observations) || input.observations.length > 32 || (input.batchStatus === "FAILED" && input.observations.length !== 0)) {
      throw new StoreValidationError("observations must be a bounded successful or partial batch.");
    }
    const reservationIds = new Set<string>();
    for (const [index, observation] of input.observations.entries()) {
      if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
        throw new StoreValidationError(`observations[${index}] must be an object.`);
      }
      const keys = Object.keys(observation);
      const allowed = ["externalReservationId", "externalProductId", "externalOptionId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats", "sourceUpdatedAtUtc", "sourceRevision"];
      if (keys.some((key) => !allowed.includes(key))) throw new StoreValidationError(`observations[${index}] has unknown fields.`);
      assertNonEmptyText(observation.externalReservationId, `observations[${index}].externalReservationId`, 256);
      assertNonEmptyText(observation.externalProductId, `observations[${index}].externalProductId`, 256);
      if ((observation.externalOptionId ?? "").length > 256) throw new StoreValidationError(`observations[${index}].externalOptionId is too long.`);
      assertCanonicalInstant(observation.sourceStartAtUtc, `observations[${index}].sourceStartAtUtc`);
      assertCanonicalInstant(observation.sourceEndAtUtc, `observations[${index}].sourceEndAtUtc`);
      if (observation.sourceEndAtUtc <= observation.sourceStartAtUtc) throw new StoreValidationError(`observations[${index}] has an invalid time range.`);
      if (!(observation.status === "PENDING" || observation.status === "CONFIRMED" || observation.status === "CANCELLED")) {
        throw new StoreValidationError(`observations[${index}].status is invalid.`);
      }
      assertSeats(observation.seats);
      if (observation.sourceUpdatedAtUtc !== undefined) assertCanonicalInstant(observation.sourceUpdatedAtUtc, `observations[${index}].sourceUpdatedAtUtc`);
      if (observation.sourceRevision !== undefined) assertNonEmptyText(observation.sourceRevision, `observations[${index}].sourceRevision`, 256);
      if (reservationIds.has(observation.externalReservationId)) throw new StoreValidationError("Duplicate external reservation IDs are not allowed in one batch.");
      reservationIds.add(observation.externalReservationId);
    }
    const observations = input.observations.map(canonicalReservationObservation);
    const requestFingerprint = fingerprint({ jobId, workerId: identity.workerId,
      receiptId: input.receiptId, readId: input.readId, leaseToken: input.leaseToken,
      batchStatus: input.batchStatus, observations });
    return withTransaction(this.#pool, async (client) => {
      // Match preflight/result: serialize the worker before provider/job locks.
      await this.#requireWorker(client, identity);
      const scope = await client.query<{ provider_id: string }>(
        `SELECT j.provider_id FROM channel_jobs j WHERE j.id=$1::uuid AND (j.leased_worker_id=$2 OR EXISTS (
           SELECT 1 FROM external_reservation_receipts r WHERE r.job_id=j.id AND r.worker_id=$2 AND r.receipt_id=$3::uuid))`,
        [jobId, identity.workerId, input.receiptId],
      );
      if (!scope.rows[0]) throw new StoreAccessDeniedError();
      await lockProviderInventory(client, scope.rows[0].provider_id);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,29))", [`external-reservation-receipt:${input.receiptId}`]);
      const existingReceipt = await client.query<DbRow>(
        "SELECT read_id,job_id,worker_id,request_fingerprint,result FROM external_reservation_receipts WHERE receipt_id=$1::uuid",
        [input.receiptId],
      );
      if (existingReceipt.rows[0]) {
        const row = existingReceipt.rows[0];
        if (row.read_id !== input.readId || row.job_id !== jobId || row.worker_id !== identity.workerId || row.request_fingerprint !== requestFingerprint) {
          throw new StoreConflictError("Reservation receipt ID was already used with different input.");
        }
        // A committed receipt survives STOP/lease expiry, but never a revoked or
        // re-created assignment. The fingerprint also proves the original token.
        const authorized = await client.query(
          `SELECT 1 FROM external_reservation_reads r
             JOIN channel_worker_accounts wa ON wa.account_id=r.account_id AND wa.worker_id=r.worker_id
             JOIN channel_external_accounts a ON a.id=r.account_id
            WHERE r.read_id=$1::uuid AND wa.revoked_at IS NULL AND wa.version=r.lease_assignment_version
              AND a.active=true AND a.revoked_at IS NULL
              AND (a.delegated_until IS NULL OR a.delegated_until>$2)
              AND a.site=r.target_site AND a.external_account_id=r.target_external_account_id
            FOR SHARE OF wa,a`, [input.readId, this.#nowIso()],
        );
        if (!authorized.rows[0]) throw new StoreAccessDeniedError();
        return reservationReceipt(row.result, true);
      }
      const job = await this.#leasedJob(client, identity, jobId, input.leaseToken);
      const authority = await this.#requireReservationReadAuthority(client, job);
      const readResult = await client.query<DbRow>("SELECT * FROM external_reservation_reads WHERE read_id=$1::uuid FOR UPDATE", [input.readId]);
      const read = readResult.rows[0];
      if (!read || read.read_scope !== "OCCURRENCE" || read.job_id !== jobId || read.worker_id !== identity.workerId
        || integer(read, "lease_epoch") !== integer(job, "lease_epoch")
        || integer(read, "lease_assignment_version") !== integer(job, "lease_assignment_version")) throw new StoreAccessDeniedError();
      if (read.status !== "OPEN") throw new StoreConflictError("Reservation read was already submitted with another receipt.");
      const generation = integer(read, "read_generation");
      const providerId = text(read, "provider_id");
      const productId = text(read, "product_id");
      const targetSite = text(read, "target_site");
      const targetAccount = text(read, "target_external_account_id");
      const targetOption = text(read, "target_external_option_id");
      const targetStart = isoValue(read, "source_start_at");
      const targetEnd = isoValue(read, "source_end_at");
      const { applied, duplicates, stale, needsReview } = await applyExternalReservationObservations(client, {
        readId: input.readId, generation, providerId, accountId: text(read, "account_id"), listingId: text(read, "listing_id"),
        productId, targetSite, targetExternalAccountId: targetAccount,
        targetExternalProductId: text(read, "target_external_product_id"), targetExternalOptionId: targetOption,
      }, observations, async (observation) => observation.sourceStartAtUtc === targetStart && observation.sourceEndAtUtc === targetEnd
        ? { occurrence: authority.occurrence } : null, () => this.#nowIso());
      const storedResult = {
        receiptId: input.receiptId, readId: input.readId, generation, batchStatus: input.batchStatus,
        applied, duplicates, stale, needsReview,
      };
      await client.query(
        `INSERT INTO external_reservation_receipts
          (receipt_id,read_id,job_id,worker_id,request_fingerprint,batch_status,result)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb)`,
        [input.receiptId, input.readId, jobId, identity.workerId, requestFingerprint, input.batchStatus, JSON.stringify(storedResult)],
      );
      await client.query(
        `UPDATE external_reservation_reads SET status='SUBMITTED',batch_status=$2,submitted_receipt_id=$3::uuid,
           submitted_at=$4 WHERE read_id=$1::uuid`,
        [input.readId, input.batchStatus, input.receiptId, this.#nowIso()],
      );
      return { ...storedResult, repeated: false };
    });
  }

  async preflight(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<{ readonly ready: true; readonly desiredState: ChannelDesiredState }>{
    assertUuid(jobId, "jobId");
    const result = await withTransaction(this.#pool, async (client): Promise<{ ready: true; desiredState: ChannelDesiredState } | { conflict: string }> => {
      await this.#requireWorker(client, identity);
      await this.#lockJobInventory(client, identity, jobId);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      const nowUtc = this.#nowIso();
      if (isoValue(job, "lease_expires_at") <= nowUtc || isoValue(job, "job_deadline_at") <= nowUtc) {
        await this.#quarantine(client, text(job, "account_id"), "LEASE_EXPIRED");
        return { conflict: "Lease or job deadline expired; the account remains locked." };
      }
      if (job.purpose === "SLOT_RETIREMENT") return this.#preflightRetirement(client, job, nowUtc);
      const current = await client.query<DbRow>(
        `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,l.active AS listing_active,
                a.site,l.product_id,l.mapping_version,l.can_open,l.can_close,l.can_observe,l.adapter,l.adapter_version,
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
        const availability = await this.#liveAvailability(client, text(job, "provider_id"), text(state, "product_id"), occurrence, nowUtc);
        if (desiredAction(availability.bookable ? "OPEN" : "CLOSED") !== job.action) {
          return { conflict: "Live availability changed; the old lease remains locked until stopped." };
        }
      }
      return { ready: true, desiredState };
    });
    if ("conflict" in result) throw new StoreConflictError(result.conflict);
    return result;
  }

  /**
   * A retirement job is checked against its retirement row, never the
   * new-time desired row. Closing an old slot is always the safe side, so
   * live availability is not consulted and a vanished occurrence still closes.
   */
  async #preflightRetirement(client: PoolClient, job: DbRow, nowUtc: string): Promise<{ ready: true; desiredState: ChannelDesiredState } | { conflict: string }> {
    const current = await client.query<DbRow>(
      `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,l.active AS listing_active,
              a.site,l.mapping_version,l.can_close,l.adapter,l.adapter_version,p.status AS product_status,
              r.status AS retirement_status,r.retirement_version,r.listing_id AS retirement_listing_id,r.occurrence_id AS retirement_occurrence_id,
              r.mapping_version AS retirement_mapping_version,r.account_version AS retirement_account_version,r.source_start_at,r.source_end_at
         FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         JOIN channel_slot_retirements r ON r.id=$3::uuid
        WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,r`,
      [job.account_id, job.listing_id, job.slot_retirement_id],
    );
    const state = current.rows[0];
    if (!state || state.account_active !== true || state.revoked_at !== null
      || (state.delegated_until !== null && isoValue(state, "delegated_until") <= nowUtc) || state.listing_active !== true
      || state.can_close !== true || state.product_status !== "PUBLISHED" || !this.#adapterSupports(state, "SET_CLOSED")
      || state.quarantined_at !== null || job.action !== "SET_CLOSED") {
      await this.#quarantine(client, text(job, "account_id"), "PREFLIGHT_AUTHORITY_STALE");
      return { conflict: "Job authority is stale; the account remains locked." };
    }
    if (integer(state, "account_version") !== integer(job, "account_version")
      || integer(state, "mapping_version") !== integer(job, "mapping_version")
      || state.retirement_status !== "PENDING" || integer(state, "retirement_version") !== integer(job, "desired_version")
      || state.retirement_listing_id !== job.listing_id || state.retirement_occurrence_id !== job.occurrence_id
      || integer(state, "retirement_mapping_version") !== integer(job, "mapping_version")
      || integer(state, "retirement_account_version") !== integer(job, "account_version")
      || isoValue(state, "source_start_at") !== isoValue(job, "source_start_at") || isoValue(state, "source_end_at") !== isoValue(job, "source_end_at")) {
      return { conflict: "Retirement snapshot is stale; the old lease remains locked until stopped." };
    }
    let occurrence: Occurrence | undefined;
    try {
      occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
    } catch (error) {
      if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
    }
    if (occurrence && sameExternalSlot(state.site, occurrence.startUtc, occurrence.endUtc, isoValue(job, "source_start_at"), isoValue(job, "source_end_at"))) {
      return { conflict: "The retired slot is the current occurrence slot again; the old lease remains locked until stopped." };
    }
    return { ready: true, desiredState: "CLOSED" };
  }

  /**
   * Reuses the full preflight and lease/assignment authorization. No caller can
   * provide provider, listing, occurrence, desired state, or UTC boundaries.
   */
  async googleDeliveryContext(
    identity: WorkerIdentity,
    jobId: string,
    leaseToken: string,
    operation: "dispatch" | "reconcile" = "dispatch",
  ): Promise<GoogleChannelDeliveryContext> {
    const preflight = await this.preflight(identity, jobId, leaseToken);
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      await this.#lockJobInventory(client, identity, jobId);
      const job = await this.#leasedJob(client, identity, jobId, leaseToken);
      if (job.purpose !== "AVAILABILITY" || job.target_site !== "Airbnb"
        || job.target_connection_mode !== "GOOGLE" || job.target_adapter !== "airbnb-google-busy"
        || job.target_adapter_version !== "1"
        || (operation === "dispatch" ? (job.action !== "SET_OPEN" && job.action !== "SET_CLOSED") : job.action !== "OBSERVE")) {
        throw new StoreAccessDeniedError();
      }
      const nowUtc = this.#nowIso();
      if (isoValue(job, "lease_expires_at") <= nowUtc || isoValue(job, "job_deadline_at") <= nowUtc) throw new StoreConflictError("Delivery lease expired.");
      return {
        jobId,
        providerId: text(job, "provider_id"), accountId: text(job, "account_id"), listingId: text(job, "listing_id"),
        occurrenceId: text(job, "occurrence_id"), workerId: identity.workerId,
        leaseEpoch: integer(job, "lease_epoch"), assignmentVersion: integer(job, "lease_assignment_version"),
        action: job.action as "SET_OPEN" | "SET_CLOSED" | "OBSERVE", accountVersion: integer(job, "account_version"),
        desiredState: preflight.desiredState,
        desiredVersion: integer(job, "desired_version"), mappingVersion: integer(job, "mapping_version"),
        sourceStartAtUtc: isoValue(job, "source_start_at"), sourceEndAtUtc: isoValue(job, "source_end_at"),
      };
    });
  }

  async #currentOccurrence(client: PoolClient, providerId: string, listingId: string, occurrenceId: string): Promise<Occurrence> {
    return currentChannelOccurrence(client, providerId, listingId, occurrenceId);
  }

  async submitResult(identity: WorkerIdentity, jobId: string, input: ChannelResultInput): Promise<{ readonly acceptedAsCurrent: boolean; readonly repeated: boolean }> {
    assertUuid(jobId, "jobId");
    assertUuid(input.resultId, "resultId");
    if (!(["VERIFIED", "RESERVATION_VERIFIED", "AUTH_REQUIRED", "NEEDS_REVIEW", "UNKNOWN_AFTER_SAVE", "RETRY_WAIT", "SUPERSEDED"] as const).includes(input.outcome)) {
      throw new StoreValidationError("result.outcome is invalid.");
    }
    if (input.reservationReadId !== undefined) assertUuid(input.reservationReadId, "result.reservationReadId");
    if (input.reservationReceiptId !== undefined) assertUuid(input.reservationReceiptId, "result.reservationReceiptId");
    if (input.observedAtUtc) assertCanonicalInstant(input.observedAtUtc, "result.observedAtUtc");
    if (input.sourceStartAtUtc) assertCanonicalInstant(input.sourceStartAtUtc, "result.sourceStartAtUtc");
    if (input.sourceEndAtUtc) assertCanonicalInstant(input.sourceEndAtUtc, "result.sourceEndAtUtc");
    if (input.observedState !== undefined && input.observedState !== "OPEN" && input.observedState !== "CLOSED") throw new StoreValidationError("result.observedState is invalid.");
    const reservationShape = input.outcome === "RESERVATION_VERIFIED"
      && input.reservationReadId !== undefined && input.reservationReceiptId !== undefined
      && input.occurrenceId === undefined && input.sourceStartAtUtc === undefined && input.sourceEndAtUtc === undefined
      && input.observedState === undefined && input.observedBookable === undefined
      && input.observedManuallyBlocked === undefined && input.observedAtUtc === undefined;
    if (input.outcome === "RESERVATION_VERIFIED" && !reservationShape) {
      throw new StoreValidationError("RESERVATION_VERIFIED requires only the terminal reservation read receipt.");
    }
    if (input.outcome !== "RESERVATION_VERIFIED" && (input.reservationReadId !== undefined || input.reservationReceiptId !== undefined)) {
      throw new StoreValidationError("Reservation receipt fields require RESERVATION_VERIFIED.");
    }
    return withTransaction(this.#pool, async (client) => {
      await this.#requireWorker(client, identity);
      await this.#lockJobInventory(client, identity, jobId, input.resultId);
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
          observedBookable: input.observedBookable, observedManuallyBlocked: input.observedManuallyBlocked, observedAtUtc: input.observedAtUtc,
          reservationReadId: input.reservationReadId, reservationReceiptId: input.reservationReceiptId });
        if (repeated.rows[0].fingerprint !== resultFingerprint) throw new StoreConflictError("Result ID was already used with different input.");
        return { acceptedAsCurrent: repeated.rows[0].accepted_as_current === true, repeated: true };
      }
      const jobResult = await client.query<DbRow>("SELECT * FROM channel_jobs WHERE id=$1::uuid FOR UPDATE", [jobId]);
      const job = jobResult.rows[0];
      if (!job || job.status !== "LEASED" || job.leased_worker_id !== identity.workerId || typeof job.lease_digest !== "string"
        || !secureDigestMatch(job.lease_digest, input.leaseToken)) throw new StoreAccessDeniedError();
      const reservationJob = job.purpose === "RESERVATION_WINDOW";
      const retirementJob = job.purpose === "SLOT_RETIREMENT";
      const availabilityJob = !reservationJob && !retirementJob;
      if (!reservationJob && job.target_connection_mode === "GOOGLE" && input.outcome === "VERIFIED") {
        throw new StoreValidationError("GOOGLE jobs require independent Google delivery and Airbnb observation receipts.");
      }
      if ((reservationJob && input.outcome === "VERIFIED") || (!reservationJob && input.outcome === "RESERVATION_VERIFIED")) {
        throw new StoreValidationError("Result outcome does not match the job purpose.");
      }
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
        observedBookable: input.observedBookable, observedManuallyBlocked: input.observedManuallyBlocked, observedAtUtc: input.observedAtUtc,
        reservationReadId: input.reservationReadId, reservationReceiptId: input.reservationReceiptId });
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
      const currentResult = retirementJob
        ? await client.query<DbRow>(
          `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,a.site,
                  l.active AS listing_active,l.product_id,l.mapping_version,l.adapter,l.adapter_version,l.can_open,l.can_close,l.can_observe,
                  r.status AS retirement_status,r.retirement_version,r.listing_id AS retirement_listing_id,r.occurrence_id AS retirement_occurrence_id,
                  r.mapping_version AS retirement_mapping_version,r.account_version AS retirement_account_version,r.source_start_at,r.source_end_at,
                  p.status AS product_status
             FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
             JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
             JOIN channel_slot_retirements r ON r.id=$3::uuid
            WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,p FOR UPDATE OF r`,
          [job.account_id, job.listing_id, job.slot_retirement_id])
        : await client.query<DbRow>(reservationJob
        ? `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,a.site,a.external_account_id,
                l.active AS listing_active,l.product_id,l.mapping_version,l.adapter,l.adapter_version,l.connection_mode,
                l.external_product_id,l.external_option_id,l.can_open,l.can_close,l.can_observe,l.can_read_reservations,
                p.status AS product_status
             FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
             JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
            WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,p`
        : `SELECT a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,a.site,
                l.active AS listing_active,l.product_id,l.mapping_version,l.adapter,l.adapter_version,l.can_open,l.can_close,l.can_observe,
                d.desired_version,d.desired_state,d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at,
                p.status AS product_status
             FROM channel_external_accounts a JOIN channel_listings l ON l.account_id=a.id
             JOIN channel_desired_states d ON d.listing_id=l.id AND d.occurrence_id=$3
             JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
            WHERE a.id=$1 AND l.id=$2 FOR SHARE OF a,l,d,p`,
        reservationJob ? [job.account_id, job.listing_id] : [job.account_id, job.listing_id, job.occurrence_id]);
      const current = currentResult.rows[0];
      const action = text(job, "action") as ChannelAction;
      const capability = action === "SET_OPEN" ? current?.can_open : action === "SET_CLOSED" ? current?.can_close : current?.can_observe;
      let liveOccurrenceMatches = false;
      let liveActionAllowed = action === "OBSERVE";
      // A retirement's old time must still differ from the live occurrence; a
      // vanished occurrence still leaves the old external slot to close.
      let retiredTimeStillOld = false;
      if (current && retirementJob) {
        try {
          const occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
          retiredTimeStillOld = occurrence.startUtc !== isoValue(job, "source_start_at") || occurrence.endUtc !== isoValue(job, "source_end_at");
        } catch (error) {
          if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
          retiredTimeStillOld = true;
        }
      }
      if (current && availabilityJob) {
        try {
          const occurrence = await this.#currentOccurrence(client, text(job, "provider_id"), text(job, "listing_id"), text(job, "occurrence_id"));
          liveOccurrenceMatches = occurrence.startUtc === isoValue(job, "source_start_at") && occurrence.endUtc === isoValue(job, "source_end_at")
            && isoValue(current, "source_start_at") === occurrence.startUtc && isoValue(current, "source_end_at") === occurrence.endUtc;
          if (liveOccurrenceMatches && action !== "OBSERVE") {
            const availability = await this.#liveAvailability(client, text(job, "provider_id"), text(current, "product_id"), occurrence, nowUtc);
            liveActionAllowed = desiredAction(availability.bookable ? "OPEN" : "CLOSED") === action;
          }
        } catch (error) {
          if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
        }
      }
      const desiredStateCurrent = current !== undefined
        && (action === "OBSERVE" || (action === "SET_OPEN" && current.desired_state === "OPEN") || (action === "SET_CLOSED" && current.desired_state === "CLOSED"));
      const availabilityVersionsCurrent = availabilityJob && assignmentCurrent && current !== undefined && current.account_active === true && current.revoked_at === null
        && (current.delegated_until === null || isoValue(current, "delegated_until") > nowUtc)
        && current.listing_active === true && current.product_status === "PUBLISHED" && capability === true
        && (current.quarantined_at === null || action === "OBSERVE") && this.#adapterSupports(current, action)
        && integer(current, "account_version") === integer(job, "account_version")
        && integer(current, "mapping_version") === integer(job, "mapping_version")
        && integer(current, "desired_mapping_version") === integer(job, "mapping_version")
        && integer(current, "desired_version") === integer(job, "desired_version")
        && desiredStateCurrent && liveOccurrenceMatches && liveActionAllowed;
      const reservationVersionsCurrent = reservationJob && assignmentCurrent && current !== undefined
        && current.account_active === true && current.revoked_at === null
        && (current.delegated_until === null || isoValue(current, "delegated_until") > nowUtc)
        && current.quarantined_at === null && current.listing_active === true && current.product_status === "PUBLISHED"
        && current.can_observe === true && current.can_read_reservations === true
        && this.#adapterSupports(current, "OBSERVE") && this.#adapterSupportsReservationRead(current)
        && integer(current, "account_version") === integer(job, "account_version")
        && integer(current, "mapping_version") === integer(job, "mapping_version")
        && current.site === job.target_site && current.external_account_id === job.target_external_account_id
        && current.external_product_id === job.target_external_product_id
        && current.external_option_id === job.target_external_option_id
        && current.adapter === job.target_adapter && current.adapter_version === job.target_adapter_version
        && current.connection_mode === job.target_connection_mode;
      const retirementVersionsCurrent = retirementJob && assignmentCurrent && current !== undefined
        && current.account_active === true && current.revoked_at === null
        && (current.delegated_until === null || isoValue(current, "delegated_until") > nowUtc)
        && current.quarantined_at === null && current.listing_active === true && current.product_status === "PUBLISHED"
        && action === "SET_CLOSED" && current.can_close === true && this.#adapterSupports(current, "SET_CLOSED")
        && integer(current, "account_version") === integer(job, "account_version")
        && integer(current, "mapping_version") === integer(job, "mapping_version")
        && current.retirement_status === "PENDING" && integer(current, "retirement_version") === integer(job, "desired_version")
        && current.retirement_listing_id === job.listing_id && current.retirement_occurrence_id === job.occurrence_id
        && integer(current, "retirement_mapping_version") === integer(job, "mapping_version")
        && integer(current, "retirement_account_version") === integer(job, "account_version")
        && isoValue(current, "source_start_at") === isoValue(job, "source_start_at")
        && isoValue(current, "source_end_at") === isoValue(job, "source_end_at")
        && retiredTimeStillOld;
      let reservationReceiptCurrent = false;
      let reservationNextDueAt: string | undefined;
      let reservationCompletedAt: string | undefined;
      if (reservationJob && input.outcome === "RESERVATION_VERIFIED" && input.reservationReadId && input.reservationReceiptId) {
        const proof = await client.query<DbRow>(
          `SELECT r.manifest_fingerprint,r.coverage_from,r.coverage_to,r.product_id,h.next_due_at,h.last_complete_at
             FROM external_reservation_reads r
             JOIN external_reservation_window_page_receipts pr ON pr.read_id=r.read_id AND pr.receipt_id=$2::uuid
             JOIN external_reservation_listing_health h ON h.read_id=r.read_id AND h.provider_id=r.provider_id AND h.listing_id=r.listing_id
            WHERE r.read_id=$1::uuid AND r.job_id=$3::uuid AND r.worker_id=$4 AND r.lease_epoch=$5
              AND r.read_scope='WINDOW' AND r.status='SUBMITTED' AND r.batch_status='COMPLETE'
              AND pr.terminal_status='COMPLETE' AND pr.request_fingerprint IS NOT NULL
              AND h.read_generation=r.read_generation
              AND pr.result->>'receiptId'=$2::text AND pr.result->>'readId'=$1::text
              AND (pr.result->>'generation')::bigint=r.read_generation
              AND (pr.result->>'pageNumber')::integer=pr.page_number
              AND pr.result->>'terminalStatus'='COMPLETE'
              AND (pr.result->>'healthUpdated')::boolean=true
              AND (pr.result->>'missingActiveReservations')::integer=0
              AND (pr.result->>'needsReview')::integer=0 AND (pr.result->>'stale')::integer=0
              AND r.account_version=$6 AND r.mapping_version=$7
            FOR SHARE OF r,pr,h`,
          [input.reservationReadId, input.reservationReceiptId, jobId, identity.workerId, leaseEpoch,
            job.account_version, job.mapping_version],
        );
        const row = proof.rows[0];
        if (row && reservationVersionsCurrent) {
          const manifest = await this.#reservationWindowManifest(client, text(job, "provider_id"), text(row, "product_id"),
            isoValue(row, "coverage_from"), isoValue(row, "coverage_to"));
          const dto = manifest.map((occurrence) => ({ occurrenceId: occurrence.id,
            sourceStartAtUtc: occurrence.startUtc, sourceEndAtUtc: occurrence.endUtc }));
          reservationReceiptCurrent = fingerprint(dto) === row.manifest_fingerprint;
          reservationNextDueAt = isoValue(row, "next_due_at");
          reservationCompletedAt = isoValue(row, "last_complete_at");
        }
      }
      const acceptedAsCurrent = reservationJob
        ? input.outcome === "RESERVATION_VERIFIED" && input.stopped && withinLease && exactTarget
          && reservationVersionsCurrent && reservationReceiptCurrent
        : channelReadbackAccepted({
        action, expectedTarget: targetFromRow(job), resultTarget: input.target,
        outcome: input.outcome, stopped: input.stopped, withinLease,
        versionsCurrent: retirementJob ? retirementVersionsCurrent : availabilityVersionsCurrent,
        occurrenceMatches: occurrenceMatchesSnapshot, observationTimeValid,
        ...(input.observedState === undefined ? {} : { observedState: input.observedState }),
        ...(input.observedBookable === undefined ? {} : { observedBookable: input.observedBookable }),
        ...(input.observedManuallyBlocked === undefined ? {} : { observedManuallyBlocked: input.observedManuallyBlocked }),
        ...(input.observedAtUtc === undefined ? {} : { observedAtUtc: input.observedAtUtc }),
      });
      await client.query(
        `INSERT INTO channel_job_results
          (result_id,job_id,worker_id,lease_epoch,lease_digest,fingerprint,outcome,stopped,exact_target_match,
           occurrence_id,source_start_at,source_end_at,observed_state,observed_bookable,observed_manually_blocked,observed_at,
           accepted_as_current,reservation_read_id,reservation_receipt_id)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid,$19::uuid)`,
        [input.resultId, jobId, identity.workerId, leaseEpoch, leaseDigest, resultFingerprint, input.outcome, input.stopped, exactTarget,
          reservationShape ? null : input.occurrenceId ?? job.occurrence_id,
          reservationShape ? null : input.sourceStartAtUtc ?? job.source_start_at,
          reservationShape ? null : input.sourceEndAtUtc ?? job.source_end_at,
          input.observedState ?? null, input.observedBookable ?? null, input.observedManuallyBlocked ?? null, input.observedAtUtc ?? null,
          acceptedAsCurrent, input.reservationReadId ?? null, input.reservationReceiptId ?? null],
      );
      if (!withinLease) {
        await this.#quarantine(client, text(job, "account_id"), "LATE_RESULT");
        if (input.stopped) {
          await this.#finishUnsafe(client, jobId, text(job, "account_id"), "NEEDS_REVIEW", "LATE_RESULT_STOPPED");
          if (retirementJob) await this.#finishRetirement(client, job, "NEEDS_REVIEW", "LATE_RESULT");
          if (reservationJob) await client.query(
            `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,halted_at=$3,
               last_error='LATE_RESULT',updated_at=$3 WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$4::uuid`,
            [job.provider_id, job.listing_id, nowUtc, jobId],
          );
        }
        return { acceptedAsCurrent: false, repeated: false };
      }
      if (!input.stopped) {
        await this.#quarantine(client, text(job, "account_id"), "EXECUTOR_NOT_STOPPED");
        return { acceptedAsCurrent: false, repeated: false };
      }
      if (acceptedAsCurrent) {
        if (reservationJob) {
          await client.query(
            `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,retry_count=0,last_error=NULL,halted_at=NULL,
               last_success_at=$3,next_due_at=$4,updated_at=$2
              WHERE provider_id=$5 AND listing_id=$6 AND pending_job_id=$1::uuid`,
            [jobId, nowUtc, reservationCompletedAt, reservationNextDueAt, job.provider_id, job.listing_id],
          );
        } else if (retirementJob) {
          // The readback is of the old time; the new-time desired observation is untouched.
          await this.#finishRetirement(client, job, "CLOSED_VERIFIED", null);
        } else {
          await client.query(
            `UPDATE channel_desired_states SET observed_state=$3,observed_desired_version=$4,observed_mapping_version=$5,
               last_verified_at=$6,last_error=CASE WHEN last_error=$7 THEN last_error ELSE NULL END,updated_at=$6
             WHERE listing_id=$1 AND occurrence_id=$2`,
            [job.listing_id, job.occurrence_id, input.observedState, job.desired_version, job.mapping_version, input.observedAtUtc,
              SLOT_RETIREMENT_WARNING],
          );
        }
        await client.query(
          "UPDATE channel_jobs SET status='FINISHED',outcome=$3,lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
          [jobId, nowUtc, reservationJob ? "RESERVATION_VERIFIED" : "VERIFIED"],
        );
        if (!reservationJob && job.action === "OBSERVE") await this.#completeRecoveryObserve(client, job);
      } else if (reservationJob) {
        if (input.outcome === "SUPERSEDED" || !reservationVersionsCurrent) {
          await client.query(
            "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
            [jobId, nowUtc],
          );
          await client.query(
            `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,next_due_at=$3,
               last_error='AUTHORITY_CHANGED',updated_at=$3 WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$4::uuid`,
            [job.provider_id, job.listing_id, nowUtc, jobId],
          );
        } else if (input.outcome === "RETRY_WAIT") {
          const state = await client.query<DbRow>(
            `SELECT retry_count FROM external_reservation_read_dispatch_states
              WHERE provider_id=$1 AND listing_id=$2 FOR UPDATE`, [job.provider_id, job.listing_id],
          );
          const retryCount = Math.min(5, integer(state.rows[0]!, "retry_count") + 1);
          const delayMinutes = [1, 5, 15, 30, 60][retryCount - 1]!;
          await client.query(
            "UPDATE channel_jobs SET status='FINISHED',outcome='RETRY_WAIT',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
            [jobId, nowUtc],
          );
          await client.query(
            `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,retry_count=$3,last_error='READ_INCOMPLETE',
               next_due_at=$4::timestamptz + make_interval(mins=>$5),updated_at=$4
              WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$6::uuid`,
            [job.provider_id, job.listing_id, retryCount, nowUtc, delayMinutes, jobId],
          );
        } else {
          const failureOutcome = input.outcome === "RESERVATION_VERIFIED" ? "NEEDS_REVIEW" : input.outcome;
          await this.#finishUnsafe(client, jobId, text(job, "account_id"), failureOutcome, failureOutcome);
          await client.query(
            `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,halted_at=$3,last_error=$4,updated_at=$3
              WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$5::uuid`,
            [job.provider_id, job.listing_id, nowUtc,
              input.outcome === "RESERVATION_VERIFIED" ? "INVALID_COMPLETE_PROOF" : failureOutcome, jobId],
          );
        }
      } else if (!(retirementJob ? retirementVersionsCurrent : availabilityVersionsCurrent) || input.outcome === "SUPERSEDED") {
        if (input.outcome === "VERIFIED") await this.#quarantine(client, text(job, "account_id"), "STALE_RESULT");
        await client.query(
          "UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED',lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1::uuid",
          [jobId, nowUtc],
        );
        // This job no longer closes the old time. If its version is still
        // PENDING, nothing else will, so make it visible unless the old time
        // has become the live occurrence time again.
        if (retirementJob) {
          await (current !== undefined && !retiredTimeStillOld
            ? this.#finishRetirement(client, job, "SUPERSEDED", "TIME_RESTORED")
            : this.#finishRetirement(client, job, "NEEDS_REVIEW", "AUTHORITY_CHANGED"));
        }
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
          if (retirementJob) await this.#finishRetirement(client, job, "NEEDS_REVIEW", "RETRY_DEADLINE");
        }
      } else {
        const outcome = input.outcome === "VERIFIED" || input.outcome === "RETRY_WAIT" ? "NEEDS_REVIEW" : input.outcome;
        await this.#finishUnsafe(client, jobId, text(job, "account_id"), outcome, outcome);
        if (retirementJob) {
          await this.#finishRetirement(client, job, "NEEDS_REVIEW", input.outcome === "RETRY_WAIT" ? "RETRY_DEADLINE" : outcome);
        }
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
    // An observe leased before staff switched to manual handling must not lift that hold.
    const released = await client.query(
      "UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL,updated_at=$2 WHERE id=$1 AND quarantine_reason IS DISTINCT FROM 'MANUAL_HANDLING'",
      [job.account_id, this.#nowIso()],
    );
    if (released.rowCount === 0) return;
    // Only the observe job issued by an explicit staff recovery may resume a
    // halted reservation reader. This does not refresh its inventory health.
    await client.query(
      `UPDATE external_reservation_read_dispatch_states s
          SET halted_at=NULL,last_error=NULL,retry_count=0,next_due_at=$2,updated_at=$2
        WHERE s.account_id=$1 AND s.pending_job_id IS NULL AND s.halted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM channel_admin_commands c
            WHERE c.action IN ('account.recover','account.reauth') AND c.result->>'observeJobId'=$3)`,
      [job.account_id, this.#nowIso(), job.id],
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
    const availability = await this.#liveAvailability(client, text(job, "provider_id"), text(listing, "product_id"), occurrence, this.#nowIso());
    const desiredState: ChannelDesiredState = availability.bookable ? "OPEN" : "CLOSED";
    const previous = (await client.query<DbRow>(
      "SELECT * FROM channel_desired_states WHERE listing_id=$1 AND occurrence_id=$2 FOR UPDATE", [job.listing_id, job.occurrence_id],
    )).rows[0];
    const desired = await client.query<DbRow>(
      `UPDATE channel_desired_states SET desired_state=$3,reason=$4,desired_version=desired_version+1,mapping_version=$5,
         source_start_at=$6,source_end_at=$7,updated_at=$8,desired_changed_at=$8 WHERE listing_id=$1 AND occurrence_id=$2 RETURNING *`,
      [job.listing_id, job.occurrence_id, desiredState, availability.reason, listing.mapping_version,
        occurrence.startUtc, occurrence.endUtc, this.#nowIso()],
    );
    if (previous && (isoValue(previous, "source_start_at") !== occurrence.startUtc || isoValue(previous, "source_end_at") !== occurrence.endUtc)) {
      await this.#retireRescheduledSlot(client, listing, previous, occurrence);
    }
    const state = desired.rows[0];
    if (state) await this.#enqueueDesiredJob(client, listing, occurrence, desiredState, integer(state, "desired_version"));
  }

  async recoverQuarantinedLease(actor: ChannelAdminActor, accountId: string, stopConfirmed: true, commandId: string): Promise<{ readonly observeJobId: string }> {
    this.#validateActor(actor);
    assertStoreIdentifier(accountId, "accountId");
    if (stopConfirmed !== true) throw new StoreValidationError("Explicit executor stop confirmation is required.");
    const request = fingerprint({ accountId, stopConfirmed });
    return withTransaction(this.#pool, (client) => this.#recoverLease(client, actor, commandId, "account.recover", request, accountId));
  }

  /**
   * Staff confirmed both that the executor stopped and that the external login
   * was renewed. Only an AUTH_REQUIRED quarantine qualifies; the recovery is the
   * same observe-first path as `recoverQuarantinedLease`, audited separately.
   */
  async confirmReauth(actor: ChannelAdminActor, accountId: string, stopConfirmed: true, reauthConfirmed: true, commandId: string): Promise<{ readonly observeJobId: string }> {
    this.#validateActor(actor);
    assertStoreIdentifier(accountId, "accountId");
    if (stopConfirmed !== true || reauthConfirmed !== true) throw new StoreValidationError("Explicit executor stop and re-authentication confirmations are required.");
    const request = fingerprint({ accountId, stopConfirmed, reauthConfirmed });
    return withTransaction(this.#pool, (client) => this.#recoverLease(client, actor, commandId, "account.reauth", request, accountId,
      (reason) => reason !== null && reason.startsWith("AUTH_REQUIRED")));
  }

  async #recoverLease(
    client: PoolClient, actor: ChannelAdminActor, commandId: string, action: "account.recover" | "account.reauth", request: string,
    accountId: string, reasonAllowed?: (reason: string | null) => boolean,
  ): Promise<{ readonly observeJobId: string }> {
    const previous = await this.#previousCommand(client, actor, commandId, action, request);
    if (previous) return { observeJobId: String(previous.observeJobId) };
    const leased = await client.query<DbRow>(
      `SELECT j.*,l.can_observe,l.active AS listing_active,a.version AS current_account_version,a.site,a.external_account_id,a.quarantine_reason,
              l.external_product_id,l.external_option_id,l.time_zone,l.mapping_version AS current_mapping_version,
              l.adapter,l.adapter_version,l.connection_mode,
              d.desired_version AS current_desired_version,d.source_start_at AS current_source_start_at,d.source_end_at AS current_source_end_at,
              p.status AS product_status
         FROM channel_jobs j JOIN channel_listings l ON l.id=j.listing_id JOIN channel_external_accounts a ON a.id=j.account_id
         JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
        WHERE j.account_id=$1 AND (j.status='LEASED' OR (j.status='FINISHED' AND a.quarantined_at IS NOT NULL)
          -- A pause before any job ran: the newest waiting job names the listing to observe first.
          OR (j.status='QUEUED' AND a.quarantine_reason='MANUAL_HANDLING'))
        ORDER BY (j.status='LEASED') DESC,j.updated_at DESC LIMIT 1 FOR UPDATE OF j,a`, [accountId],
    );
    const job = leased.rows[0];
    if (!job) throw new StoreConflictError("No leased job requires recovery.");
    // A waiting job never reached the external site: the recovery supersedes it instead of asking for its review.
    const neverRan = job.status === "QUEUED";
    if (reasonAllowed && !reasonAllowed(job.quarantine_reason === null ? null : text(job, "quarantine_reason"))) {
      throw new StoreConflictError("This account is not waiting for re-authentication.");
    }
    if (job.can_observe !== true || job.listing_active !== true || job.product_status !== "PUBLISHED"
      || !this.#adapterSupports({ site: job.site, adapter: job.adapter, adapter_version: job.adapter_version }, "OBSERVE")) {
      throw new StoreConflictError("Recovery is closed until this mapping has a deployed OBSERVE capability and a published product.");
    }
    await this.#quarantineByStaff(client, accountId, "MANUAL_RECOVERY_OBSERVE_REQUIRED");
    await client.query(
      "UPDATE channel_jobs SET status='FINISHED',outcome=$3,lease_digest=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1",
      [job.id, this.#nowIso(), neverRan ? "SUPERSEDED" : "NEEDS_REVIEW"],
    );
    // The old slot may still be open on the site whether or not the close ran: staff are asked to check it.
    if (job.purpose === "SLOT_RETIREMENT") await this.#finishRetirement(client, job, "NEEDS_REVIEW", "MANUAL_RECOVERY_OBSERVE_REQUIRED");
    if (job.purpose === "RESERVATION_WINDOW") await client.query(
      `UPDATE external_reservation_read_dispatch_states SET pending_job_id=NULL,halted_at=$3,
         last_error='MANUAL_RECOVERY_OBSERVE_REQUIRED',updated_at=$3
        WHERE provider_id=$1 AND listing_id=$2 AND pending_job_id=$4::uuid`,
      [job.provider_id, job.listing_id, this.#nowIso(), job.id],
    );
    const recoveryDesired = await client.query<DbRow>(
      "UPDATE channel_desired_states SET desired_version=desired_version+1,updated_at=$3,desired_changed_at=$3 WHERE listing_id=$1 AND occurrence_id=$2 RETURNING desired_version,source_start_at,source_end_at",
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
    await this.#completeCommand(client, actor, commandId, action, request, { observeJobId }, text(job, "provider_id"), "external_account", accountId);
    return { observeJobId };
  }

  /** Switch an account to manual handling. Existing leases stay locked until the normal stop-confirmed recovery. */
  async pauseAccount(actor: ChannelAdminActor, accountId: string, expectedVersion: number, commandId: string): Promise<{ readonly accountId: string; readonly quarantineReason: "MANUAL_HANDLING" }> {
    this.#validateActor(actor);
    assertStoreIdentifier(accountId, "accountId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion is required.");
    const request = fingerprint({ accountId, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "account.pause", request);
      if (previous) return { accountId, quarantineReason: "MANUAL_HANDLING" as const };
      const current = await client.query<DbRow>("SELECT provider_id,version FROM channel_external_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const row = current.rows[0];
      if (!row) throw new StoreNotFoundError("external account");
      if (integer(row, "version") !== expectedVersion) throw new StoreConflictError("External account version mismatch.");
      await this.#quarantineByStaff(client, accountId, "MANUAL_HANDLING");
      await this.#completeCommand(client, actor, commandId, "account.pause", request, { accountId }, text(row, "provider_id"), "external_account", accountId);
      return { accountId, quarantineReason: "MANUAL_HANDLING" as const };
    });
  }

  /** Resume one halted reservation reader. Authority must already be current; this never refreshes inventory health. */
  async retryReservationReads(actor: ChannelAdminActor, listingId: string, commandId: string): Promise<{ readonly listingId: string; readonly nextDueAtUtc: string }> {
    this.#validateActor(actor);
    assertStoreIdentifier(listingId, "listingId");
    const request = fingerprint({ listingId });
    return withTransaction(this.#pool, async (client) => {
      const scope = await client.query<DbRow>("SELECT provider_id FROM channel_listings WHERE id=$1", [listingId]);
      if (!scope.rows[0]) throw new StoreNotFoundError("channel listing");
      const providerId = text(scope.rows[0], "provider_id");
      await lockProviderInventory(client, providerId);
      const previous = await this.#previousCommand(client, actor, commandId, "listing.reservationReadRetry", request);
      if (previous) return { listingId, nextDueAtUtc: String(previous.nextDueAtUtc) };
      const nowUtc = this.#nowIso();
      const state = await client.query<DbRow>(
        `SELECT s.halted_at,s.pending_job_id,l.active,l.can_read_reservations,a.active AS account_active,a.revoked_at,
                a.delegated_until,a.quarantined_at
           FROM external_reservation_read_dispatch_states s
           JOIN channel_listings l ON l.provider_id=s.provider_id AND l.id=s.listing_id
           JOIN channel_external_accounts a ON a.id=l.account_id
          WHERE s.provider_id=$1 AND s.listing_id=$2 FOR UPDATE OF s`,
        [providerId, listingId],
      );
      const row = state.rows[0];
      if (!row || row.halted_at === null || row.pending_job_id !== null) throw new StoreConflictError("Reservation reads are not halted for this listing.");
      if (row.account_active !== true || row.revoked_at !== null || row.quarantined_at !== null
        || (row.delegated_until !== null && isoValue(row, "delegated_until") <= nowUtc)) {
        throw new StoreConflictError("The external account must be active and not quarantined.");
      }
      if (row.active !== true || row.can_read_reservations !== true) throw new StoreConflictError("The listing must be active and allowed to read reservations.");
      await client.query(
        `UPDATE external_reservation_read_dispatch_states SET halted_at=NULL,last_error=NULL,retry_count=0,next_due_at=$3,updated_at=$3
          WHERE provider_id=$1 AND listing_id=$2 AND halted_at IS NOT NULL AND pending_job_id IS NULL`,
        [providerId, listingId, nowUtc],
      );
      await this.#completeCommand(client, actor, commandId, "listing.reservationReadRetry", request, { listingId, nextDueAtUtc: nowUtc }, providerId, "listing", listingId);
      return { listingId, nextDueAtUtc: nowUtc };
    });
  }

  /** Staff takes ownership of an open runtime incident. Incidents resolve only when the watched condition clears. */
  async acknowledgeIncident(actor: ChannelAdminActor, incidentId: string, commandId: string): Promise<{ readonly incidentId: string; readonly acknowledgedAtUtc: string }> {
    this.#validateActor(actor);
    if (!/^[1-9][0-9]{0,17}$/.test(incidentId)) throw new StoreValidationError("incidentId is invalid.");
    const request = fingerprint({ incidentId });
    return withTransaction(this.#pool, async (client) => {
      const previous = await this.#previousCommand(client, actor, commandId, "incident.acknowledge", request);
      if (previous) return { incidentId, acknowledgedAtUtc: String(previous.acknowledgedAtUtc) };
      const current = await client.query<DbRow>("SELECT provider_id,resolved_at FROM channel_runtime_incidents WHERE id=$1::bigint FOR UPDATE", [incidentId]);
      const row = current.rows[0];
      if (!row) throw new StoreNotFoundError("runtime incident");
      if (row.resolved_at !== null) throw new StoreConflictError("The runtime incident is already resolved.");
      const nowUtc = this.#nowIso();
      await client.query(
        "UPDATE channel_runtime_incidents SET assignee_niho_user_id=$2,acknowledged_at=$3,updated_at=$3 WHERE id=$1::bigint",
        [incidentId, actor.nihoUserId, nowUtc],
      );
      await this.#completeCommand(client, actor, commandId, "incident.acknowledge", request, { incidentId, acknowledgedAtUtc: nowUtc },
        row.provider_id === null ? undefined : text(row, "provider_id"), "runtime_incident", incidentId);
      return { incidentId, acknowledgedAtUtc: nowUtc };
    });
  }

  async runtimeOverview(actor: ChannelAdminActor, providerId: string): Promise<ChannelRuntimeOverview> {
    this.#validateActor(actor);
    assertStoreIdentifier(providerId, "providerId");
    return loadChannelRuntimeOverview(this.#pool, providerId, actor.nihoUserId, this.#now());
  }

  /**
   * Independent cloud watchdog. A concurrent run returns `skipped` instead of
   * waiting, so incidents are never duplicated. It changes no job, lease, or
   * quarantine; it only records incidents and holds stale Studios' new OPEN.
   */
  async runWatchdog(): Promise<ChannelWatchdogRunResult> {
    const ran = await withTransaction(this.#pool, async (client) => {
      const lock = await client.query<DbRow>("SELECT pg_try_advisory_xact_lock(hashtextextended('channel-watchdog',11)) AS locked");
      if (lock.rows[0]?.locked !== true) return null;
      return runChannelWatchdog(client, this.#now(), this.#deployedActionKeys());
    });
    if (ran) return { ...ran, skipped: false };
    return { ranAtUtc: this.#nowIso(), skipped: true, opened: 0, escalated: 0, resolved: 0, openIncidents: await countOpenIncidents(this.#pool), transitions: [] };
  }

  async hostStatuses(actor: HostActor): Promise<readonly HostChannelStatus[]> {
    assertStoreIdentifier(actor.providerId, "actor.providerId");
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
    const products = await listCalendarProductsForActor(this.#pool, actor, true);
    if (products.length === 0 && !await calendarMembershipRole(this.#pool, actor)) throw new StoreAccessDeniedError();
    const workers = await providerWorkerSignals(this.#pool, actor.providerId, this.#now());
    const result = await this.#pool.query<DbRow>(
      `SELECT d.occurrence_id,a.site,d.desired_state,d.desired_version,d.mapping_version,d.observed_state,
              d.observed_desired_version,d.observed_mapping_version,d.last_verified_at,d.last_error,
              a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,
              l.active AS listing_active,l.adapter,l.adapter_version,l.can_open,l.can_close,l.mapping_version AS current_mapping_version,p.status AS product_status,
              EXISTS (SELECT 1 FROM calendar_outbox_events e WHERE e.provider_id=d.provider_id AND e.processed_at IS NULL AND e.available_at <= $2::timestamptz) AS calendar_pending
         FROM channel_desired_states d JOIN channel_listings l ON l.id=d.listing_id
         JOIN channel_external_accounts a ON a.id=l.account_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
        WHERE d.provider_id=$1 AND l.product_id=ANY($3::text[])
        ORDER BY d.source_start_at,a.site,l.id`, [actor.providerId, this.#nowIso(), products.map((product) => product.id)],
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
      const synced = currentObservation && observed === desired;
      // No live Studio has a fresh heartbeat: a pending CLOSE cannot be written, so it needs staff, not waiting.
      if (!error && !synced && desired === "CLOSED" && !workers.freshWorker) error = "WORKER_STALE";
      const held = !error && !synced && desired === "OPEN" && workers.openHold;
      return {
        occurrenceId: text(row, "occurrence_id"), site: text(row, "site"), desired, ...(observed ? { observed } : {}),
        label: error ? "ERROR" : held ? "HELD" : row.calendar_pending === true ? "PENDING" : observed === undefined ? "UNVERIFIED" : synced ? "SYNCED" : "PENDING",
        ...(row.last_verified_at === null ? {} : { lastVerifiedAtUtc: isoValue(row, "last_verified_at") }), ...(error ? { error } : {}),
      };
    });
  }
}
