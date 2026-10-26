import { parseOccurrenceOverrides, parseScheduleRule, type GoogleSyncStatus } from "@niho-experience/experience-domain";
import { StoreError } from "./errors.ts";
import type {
  BookingRecord,
  GoogleCalendarConfiguration,
  ProductRecord,
  StoredOccurrenceOverride,
  StoredScheduleRule,
} from "./types.ts";

export type DbRow = Record<string, unknown>;

function stringValue(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function optionalString(row: DbRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new StoreError(`Database returned an invalid ${key}.`);
}

function numberValue(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function booleanValue(row: DbRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function objectValue(row: DbRow, key: string): Record<string, unknown> {
  const value = row[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError(`Database returned an invalid ${key}.`);
  }
  return value as Record<string, unknown>;
}

export function isoValue(row: DbRow, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new StoreError(`Database returned an invalid ${key}.`);
}

export function productFromRow(row: DbRow): ProductRecord {
  return {
    providerId: stringValue(row, "provider_id"),
    id: stringValue(row, "id"),
    slug: stringValue(row, "slug"),
    status: stringValue(row, "status") as ProductRecord["status"],
    publicTitle: stringValue(row, "public_title"),
    content: objectValue(row, "content") as ProductRecord["content"],
    currency: stringValue(row, "currency"),
    unitAmount: numberValue(row, "unit_amount"),
    cancellationTermsRef: stringValue(row, "cancellation_terms_ref"),
    sellerNihoAccountRef: stringValue(row, "seller_niho_account_ref"),
    stripeConnectAccountRef: stringValue(row, "stripe_connect_account_ref"),
    sellerDisplayName: stringValue(row, "seller_display_name"),
    version: numberValue(row, "version"),
    createdAtUtc: isoValue(row, "created_at"),
    updatedAtUtc: isoValue(row, "updated_at"),
  };
}

export function scheduleRuleFromRow(row: DbRow): StoredScheduleRule {
  const raw = {
    id: stringValue(row, "id"),
    timeZone: stringValue(row, "time_zone"),
    startsOn: stringValue(row, "starts_on"),
    ...(row.ends_on === null ? {} : { endsOn: stringValue(row, "ends_on") }),
    localStartTime: stringValue(row, "local_start_time"),
    durationMinutes: numberValue(row, "duration_minutes"),
    capacity: numberValue(row, "capacity"),
    bookingCutoffMinutes: numberValue(row, "booking_cutoff_minutes"),
    busyBufferBeforeMinutes: numberValue(row, "busy_buffer_before_minutes"),
    busyBufferAfterMinutes: numberValue(row, "busy_buffer_after_minutes"),
    recurrence: objectValue(row, "recurrence"),
  };
  return {
    providerId: stringValue(row, "provider_id"),
    productId: stringValue(row, "product_id"),
    rule: parseScheduleRule(raw),
    version: numberValue(row, "version"),
  };
}

export function overrideFromRow(row: DbRow): StoredOccurrenceOverride {
  const raw = row.kind === "CLOSE"
    ? { occurrenceId: stringValue(row, "occurrence_id"), kind: "CLOSE" }
    : {
        occurrenceId: stringValue(row, "occurrence_id"),
        kind: "RESCHEDULE",
        localDate: stringValue(row, "local_date"),
        localStartTime: stringValue(row, "local_start_time"),
        ...(row.duration_minutes === null ? {} : { durationMinutes: numberValue(row, "duration_minutes") }),
      };
  const parsed = parseOccurrenceOverrides([raw])[0];
  if (parsed === undefined) throw new StoreError("Database returned an invalid occurrence override.");
  return { override: parsed, version: numberValue(row, "version") };
}

export function googleCalendarFromRow(row: DbRow): GoogleCalendarConfiguration {
  return {
    providerId: stringValue(row, "provider_id"),
    opaqueCalendarId: stringValue(row, "opaque_calendar_id"),
    blockingEnabled: booleanValue(row, "blocking_enabled"),
    syncStatus: stringValue(row, "sync_status") as GoogleSyncStatus,
    ...(optionalString(row, "last_attempted_at") === undefined
      ? {}
      : { lastAttemptedAtUtc: optionalString(row, "last_attempted_at")! }),
    ...(optionalString(row, "last_succeeded_at") === undefined
      ? {}
      : { lastSucceededAtUtc: optionalString(row, "last_succeeded_at")! }),
    ...(optionalString(row, "fresh_until") === undefined
      ? {}
      : { freshUntilUtc: optionalString(row, "fresh_until")! }),
    ...(optionalString(row, "coverage_start") === undefined
      ? {}
      : { coverageStartUtc: optionalString(row, "coverage_start")! }),
    ...(optionalString(row, "coverage_end") === undefined
      ? {}
      : { coverageEndUtc: optionalString(row, "coverage_end")! }),
    version: numberValue(row, "version"),
  };
}

export function bookingFromRow(row: DbRow): BookingRecord {
  const stripePaymentRef = optionalString(row, "stripe_payment_ref");
  const confirmedAtUtc = optionalString(row, "confirmed_at");
  return {
    publicBookingId: stringValue(row, "public_booking_id"),
    providerId: stringValue(row, "provider_id"),
    productId: stringValue(row, "product_id"),
    occurrenceId: stringValue(row, "occurrence_id"),
    status: stringValue(row, "status") as BookingRecord["status"],
    seats: numberValue(row, "seats"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    holdExpiresAtUtc: isoValue(row, "hold_expires_at"),
    occurrenceSnapshot: objectValue(row, "occurrence_snapshot") as unknown as BookingRecord["occurrenceSnapshot"],
    pricingSnapshot: objectValue(row, "pricing_snapshot") as unknown as BookingRecord["pricingSnapshot"],
    sellerSnapshot: objectValue(row, "seller_snapshot") as unknown as BookingRecord["sellerSnapshot"],
    ...(stripePaymentRef === undefined ? {} : { stripePaymentRef }),
    createdAtUtc: isoValue(row, "created_at"),
    ...(confirmedAtUtc === undefined ? {} : { confirmedAtUtc }),
  };
}
