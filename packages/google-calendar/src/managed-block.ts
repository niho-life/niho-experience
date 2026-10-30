import type { GoogleConfig } from "./index.ts";
import { boundedJson, GOOGLE_API, GoogleCalendarError, googleRequest } from "./http.ts";
import { sha256Base32Hex } from "./ids.ts";

const MANAGED_KIND = "niho-managed-block-v1";
const FIXED_SUMMARY = "NIHO availability";
const EVENT_FIELDS = "id,etag,status,start(date,dateTime),end(date,dateTime),recurrence,recurringEventId,originalStartTime(date,dateTime),transparency,visibility,extendedProperties/private";
const ACK_FIELDS = "id,etag";
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_CALENDAR_ID_LENGTH = 512;
const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_ETAG_LENGTH = 1_024;
const MAX_OCCURRENCE_DURATION_MS = 24 * 60 * 60 * 1_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const MARKER_KEYS = {
  kind: "nihoManagedKind",
  binding: "nihoManagedBinding",
  mappingVersion: "nihoManagedMappingVersion",
  desiredVersion: "nihoManagedDesiredVersion",
} as const;

export interface GoogleManagedBlockTarget {
  readonly providerOpaqueId: string;
  readonly listingOpaqueId: string;
  readonly occurrenceOpaqueId: string;
  readonly mappingVersion: number;
  readonly desiredVersion: number;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly desiredState: "OPEN" | "CLOSED";
}

export interface GoogleManagedBlockMetadata {
  readonly eventId: string;
  readonly etag: string;
  readonly bindingHash: string;
  readonly mappingVersion: number;
  readonly desiredVersion: number;
  readonly startAtUtc: string;
  readonly endAtUtc: string;
  readonly desiredState: "OPEN" | "CLOSED";
  readonly transparency: "opaque" | "transparent";
  readonly visibility: "private";
}

export type GoogleManagedBlockStopCode =
  | "ANCHOR_MISSING"
  | "TOMBSTONE"
  | "CANCELLED_EVENT"
  | "STATUS_MISMATCH"
  | "RECURRING_EVENT"
  | "ALL_DAY_EVENT"
  | "FOREIGN_EVENT"
  | "MAPPING_MISMATCH"
  | "TIME_MISMATCH"
  | "VISIBILITY_MISMATCH"
  | "STALE_INTENT"
  | "PRECONDITION_FAILED";

export type GoogleManagedBlockResult =
  | {
      readonly code: "GOOGLE_VERIFIED";
      readonly eventId: string;
      readonly changed: boolean;
      readonly writeAcknowledged: boolean;
      readonly google: GoogleManagedBlockMetadata;
    }
  | {
      readonly code: GoogleManagedBlockStopCode;
      readonly eventId: string;
      readonly changed: false;
      readonly writeAcknowledged: false;
    }
  | {
      readonly code: "WRITE_UNCERTAIN";
      readonly eventId: string;
      readonly changed: null;
      readonly writeAcknowledged: boolean;
    };

export type AssertGoogleManagedBlockCurrent = () => void | Promise<void>;

type StopResult = Extract<GoogleManagedBlockResult, { changed: false }>;
type Inspection = { ok: true; google: GoogleManagedBlockMetadata } | { ok: false; code: GoogleManagedBlockStopCode };
type ReadResult = { kind: "FOUND"; inspection: Inspection } | { kind: "MISSING" } | { kind: "TOMBSTONE" };

function boundedIdentifier(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !CONTROL_CHARACTER.test(value);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalTargetUtc(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function strongEtag(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ETAG_LENGTH
    && /^"[\x21\x23-\x7e]+"$/.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Google event dateTime is RFC3339 and may use a numeric offset rather than Z. */
function normalizeResponseDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText || !secondText || !zone) return undefined;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return undefined;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    if (zone === "-00:00") return undefined;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return undefined;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === "+" ? 1 : -1);
  }
  if (/[1-9]/.test(fraction.slice(3))) return undefined;

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, "0")));
  const utcMilliseconds = local.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(utcMilliseconds) ? new Date(utcMilliseconds).toISOString() : undefined;
}

function validateTarget(target: GoogleManagedBlockTarget): void {
  if (
    !boundedIdentifier(target.providerOpaqueId, MAX_OPAQUE_ID_LENGTH)
    || !boundedIdentifier(target.listingOpaqueId, MAX_OPAQUE_ID_LENGTH)
    || !boundedIdentifier(target.occurrenceOpaqueId, MAX_OPAQUE_ID_LENGTH)
    || !positiveSafeInteger(target.mappingVersion)
    || !positiveSafeInteger(target.desiredVersion)
    || (target.desiredState !== "OPEN" && target.desiredState !== "CLOSED")
  ) throw new TypeError("Invalid managed Google block target");
  const start = canonicalTargetUtc(target.sourceStartAtUtc);
  const end = canonicalTargetUtc(target.sourceEndAtUtc);
  if (
    start !== target.sourceStartAtUtc
    || end !== target.sourceEndAtUtc
    || Date.parse(end) <= Date.parse(start)
    || Date.parse(end) - Date.parse(start) > MAX_OCCURRENCE_DURATION_MS
  ) throw new TypeError("Invalid managed Google block time range");
}

function identityTuple(target: Pick<GoogleManagedBlockTarget, "providerOpaqueId" | "listingOpaqueId" | "occurrenceOpaqueId">): string {
  return JSON.stringify([target.providerOpaqueId, target.listingOpaqueId, target.occurrenceOpaqueId]);
}

/** Stable across mapping and desired versions, so OPEN never creates a replacement anchor. */
export function managedGoogleBlockEventId(
  target: Pick<GoogleManagedBlockTarget, "providerOpaqueId" | "listingOpaqueId" | "occurrenceOpaqueId">,
): string {
  if (
    !boundedIdentifier(target.providerOpaqueId, MAX_OPAQUE_ID_LENGTH)
    || !boundedIdentifier(target.listingOpaqueId, MAX_OPAQUE_ID_LENGTH)
    || !boundedIdentifier(target.occurrenceOpaqueId, MAX_OPAQUE_ID_LENGTH)
  ) throw new TypeError("Invalid managed Google block identity");
  return sha256Base32Hex(`niho-managed-google-event-v1\0${identityTuple(target)}`);
}

function bindingHash(target: GoogleManagedBlockTarget): string {
  return sha256Base32Hex(`niho-managed-google-binding-v1\0${JSON.stringify([
    target.providerOpaqueId,
    target.listingOpaqueId,
    target.occurrenceOpaqueId,
    target.sourceStartAtUtc,
    target.sourceEndAtUtc,
    target.mappingVersion,
  ])}`);
}

function desiredTransparency(target: GoogleManagedBlockTarget): "opaque" | "transparent" {
  return target.desiredState === "CLOSED" ? "opaque" : "transparent";
}

function marker(target: GoogleManagedBlockTarget): Record<string, string> {
  return {
    [MARKER_KEYS.kind]: MANAGED_KIND,
    [MARKER_KEYS.binding]: bindingHash(target),
    [MARKER_KEYS.mappingVersion]: String(target.mappingVersion),
    [MARKER_KEYS.desiredVersion]: String(target.desiredVersion),
  };
}

function parseMarkerInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return positiveSafeInteger(parsed) && String(parsed) === value ? parsed : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stop(code: GoogleManagedBlockStopCode, eventId: string): StopResult {
  return { code, eventId, changed: false, writeAcknowledged: false };
}

function inspectEvent(raw: Record<string, unknown>, target: GoogleManagedBlockTarget, eventId: string): Inspection {
  if (raw.id !== eventId) return { ok: false, code: "FOREIGN_EVENT" };
  if (!strongEtag(raw.etag)) {
    throw new GoogleCalendarError("INVALID_RESPONSE");
  }
  if (raw.status === "cancelled") return { ok: false, code: "CANCELLED_EVENT" };
  if (raw.status !== "confirmed") return { ok: false, code: "STATUS_MISMATCH" };
  // A series parent can retain the anchor ID and its first start/end. Changing
  // that parent affects all instances, so neither a series nor an instance is
  // a single-occurrence control, even when copied private markers still match.
  if ("recurrence" in raw || "recurringEventId" in raw || "originalStartTime" in raw) {
    return { ok: false, code: "RECURRING_EVENT" };
  }

  const start = recordOrUndefined(raw.start);
  const end = recordOrUndefined(raw.end);
  if (!start || !end) throw new GoogleCalendarError("INVALID_RESPONSE");
  if ("date" in start || "date" in end) return { ok: false, code: "ALL_DAY_EVENT" };

  const properties = recordOrUndefined(raw.extendedProperties);
  const privateProperties = recordOrUndefined(properties?.private);
  if (!privateProperties || privateProperties[MARKER_KEYS.kind] !== MANAGED_KIND) return { ok: false, code: "FOREIGN_EVENT" };
  const eventMappingVersion = parseMarkerInteger(privateProperties[MARKER_KEYS.mappingVersion]);
  if (eventMappingVersion === undefined) return { ok: false, code: "FOREIGN_EVENT" };
  if (eventMappingVersion !== target.mappingVersion) return { ok: false, code: "MAPPING_MISMATCH" };

  const startAtUtc = normalizeResponseDateTime(start.dateTime);
  const endAtUtc = normalizeResponseDateTime(end.dateTime);
  if (!startAtUtc || !endAtUtc || startAtUtc !== target.sourceStartAtUtc || endAtUtc !== target.sourceEndAtUtc) {
    return { ok: false, code: "TIME_MISMATCH" };
  }
  const expectedBinding = bindingHash(target);
  if (privateProperties[MARKER_KEYS.binding] !== expectedBinding) return { ok: false, code: "FOREIGN_EVENT" };
  if (raw.visibility !== "private") return { ok: false, code: "VISIBILITY_MISMATCH" };

  const eventDesiredVersion = parseMarkerInteger(privateProperties[MARKER_KEYS.desiredVersion]);
  if (eventDesiredVersion === undefined) return { ok: false, code: "FOREIGN_EVENT" };
  if (eventDesiredVersion > target.desiredVersion) return { ok: false, code: "STALE_INTENT" };
  const transparency = raw.transparency === undefined ? "opaque" : raw.transparency;
  if (transparency !== "opaque" && transparency !== "transparent") throw new GoogleCalendarError("INVALID_RESPONSE");
  return {
    ok: true,
    google: {
      eventId,
      etag: raw.etag,
      bindingHash: expectedBinding,
      mappingVersion: eventMappingVersion,
      desiredVersion: eventDesiredVersion,
      startAtUtc,
      endAtUtc,
      desiredState: transparency === "opaque" ? "CLOSED" : "OPEN",
      transparency,
      visibility: "private",
    },
  };
}

function eventUrl(calendarId: string, eventId: string): URL {
  const url = new URL(`${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  url.searchParams.set("fields", EVENT_FIELDS);
  return url;
}

function writeUrl(calendarId: string, eventId?: string): URL {
  const suffix = eventId === undefined ? "" : `/${encodeURIComponent(eventId)}`;
  const url = new URL(`${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events${suffix}`);
  url.searchParams.set("sendUpdates", "none");
  url.searchParams.set("fields", ACK_FIELDS);
  return url;
}

function headers(accessToken: string, body = false): HeadersInit {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

function responseError(response: Response): GoogleCalendarError {
  return new GoogleCalendarError(response.status === 401 || response.status === 403 ? "REVOKED" : response.status >= 500 ? "UNAVAILABLE" : "INVALID_RESPONSE");
}

async function readEvent(
  config: GoogleConfig,
  accessToken: string,
  calendarId: string,
  target: GoogleManagedBlockTarget,
  eventId: string,
): Promise<ReadResult> {
  const response = await googleRequest(config, eventUrl(calendarId, eventId).href, { method: "GET", headers: headers(accessToken) });
  if (response.status === 404) return { kind: "MISSING" };
  if (response.status === 410) return { kind: "TOMBSTONE" };
  if (!response.ok) throw responseError(response);
  return { kind: "FOUND", inspection: inspectEvent(await boundedJson(response), target, eventId) };
}

function exactDesired(inspection: Inspection, target: GoogleManagedBlockTarget): inspection is Extract<Inspection, { ok: true }> {
  return inspection.ok
    && inspection.google.desiredVersion === target.desiredVersion
    && inspection.google.transparency === desiredTransparency(target);
}

async function readAfterWrite(
  config: GoogleConfig,
  accessToken: string,
  calendarId: string,
  target: GoogleManagedBlockTarget,
  eventId: string,
): Promise<ReadResult | undefined> {
  try {
    return await readEvent(config, accessToken, calendarId, target, eventId);
  } catch {
    return undefined;
  }
}

async function acknowledged(response: Response, eventId: string): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = await boundedJson(response);
    return body.id === eventId && strongEtag(body.etag);
  } catch {
    return false;
  }
}

function uncertain(eventId: string, writeAcknowledged: boolean): GoogleManagedBlockResult {
  return { code: "WRITE_UNCERTAIN", eventId, changed: null, writeAcknowledged };
}

/**
 * Mutates only NIHO-owned control anchors. A Google verification is not an Airbnb observation.
 * The server callback must re-check the current target/version/lease in durable state.
 */
export async function applyGoogleManagedBlock(
  config: GoogleConfig,
  accessToken: string,
  calendarId: string,
  target: GoogleManagedBlockTarget,
  assertCurrent: AssertGoogleManagedBlockCurrent,
): Promise<GoogleManagedBlockResult> {
  validateTarget(target);
  if (!boundedIdentifier(calendarId, MAX_CALENDAR_ID_LENGTH) || !boundedIdentifier(accessToken, MAX_ACCESS_TOKEN_LENGTH)) {
    throw new TypeError("Invalid managed Google block credentials");
  }
  if (typeof assertCurrent !== "function") throw new TypeError("assertCurrent is required");

  const eventId = managedGoogleBlockEventId(target);
  await assertCurrent();
  const initial = await readEvent(config, accessToken, calendarId, target, eventId);
  if (initial.kind === "TOMBSTONE") return stop("TOMBSTONE", eventId);
  if (initial.kind === "MISSING" && target.desiredState === "OPEN") return stop("ANCHOR_MISSING", eventId);
  if (initial.kind === "FOUND" && !initial.inspection.ok) return stop(initial.inspection.code, eventId);

  const existing = initial.kind === "FOUND" && initial.inspection.ok ? initial.inspection.google : undefined;
  if (
    existing
    && existing.desiredVersion === target.desiredVersion
    && existing.transparency === desiredTransparency(target)
  ) {
    await assertCurrent();
    return { code: "GOOGLE_VERIFIED", eventId, changed: false, writeAcknowledged: false, google: existing };
  }

  await assertCurrent();
  let response: Response | undefined;
  try {
    if (!existing) {
      response = await googleRequest(config, writeUrl(calendarId).href, {
        method: "POST",
        headers: headers(accessToken, true),
        body: JSON.stringify({
          id: eventId,
          summary: FIXED_SUMMARY,
          start: { dateTime: target.sourceStartAtUtc },
          end: { dateTime: target.sourceEndAtUtc },
          visibility: "private",
          transparency: desiredTransparency(target),
          extendedProperties: { private: marker(target) },
        }),
      });
    } else {
      response = await googleRequest(config, writeUrl(calendarId, eventId).href, {
        method: "PATCH",
        headers: { ...headers(accessToken, true), "if-match": existing.etag },
        body: JSON.stringify({
          transparency: desiredTransparency(target),
          extendedProperties: { private: marker(target) },
        }),
      });
    }
  } catch {
    response = undefined;
  }

  if (response?.status === 412) return stop("PRECONDITION_FAILED", eventId);
  if (response && response.status !== 409 && !response.ok && response.status < 500) throw responseError(response);

  const writeAcknowledged = response ? await acknowledged(response, eventId) : false;
  const readback = await readAfterWrite(config, accessToken, calendarId, target, eventId);
  if (!readback || readback.kind !== "FOUND") return uncertain(eventId, writeAcknowledged);
  if (!readback.inspection.ok) {
    if (!existing && response?.status === 409) return stop(readback.inspection.code, eventId);
    return uncertain(eventId, writeAcknowledged);
  }
  if (!exactDesired(readback.inspection, target)) return uncertain(eventId, writeAcknowledged);
  if (existing && readback.inspection.google.etag === existing.etag) return uncertain(eventId, writeAcknowledged);

  await assertCurrent();
  return {
    code: "GOOGLE_VERIFIED",
    eventId,
    changed: !existing && response?.status === 409 ? false : true,
    writeAcknowledged,
    google: readback.inspection.google,
  };
}
