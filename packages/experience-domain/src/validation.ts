import {
  EXPERIENCE_TIME_ZONE,
  type BusyInterval,
  type OccurrenceOverride,
  type Recurrence,
  type ScheduleRule,
  type UtcInstant,
  type Weekday,
} from "#types";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WEEKDAYS = new Set<Weekday>([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

export class DomainValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid experience domain input: ${issues.join("; ")}`);
    this.name = "DomainValidationError";
    this.issues = [...issues];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string, path: string, issues: string[]): string {
  const value = record[key];
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string`);
    return "";
  }
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  issues: string[],
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${path}.${key} must be an integer from ${min} to ${max}`);
    return min;
  }
  return value as number;
}

export function assertLocalDate(value: unknown, path = "date"): asserts value is string {
  const match = typeof value === "string" ? LOCAL_DATE_PATTERN.exec(value) : null;
  if (!match) throw new DomainValidationError([`${path} must use YYYY-MM-DD`]);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new DomainValidationError([`${path} must be a real date from 1970 onward`]);
  }
}

export function assertLocalTime(value: unknown, path = "time"): asserts value is string {
  const match = typeof value === "string" ? LOCAL_TIME_PATTERN.exec(value) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new DomainValidationError([`${path} must use 24-hour HH:mm`]);
  }
}

export function assertUtcInstant(value: unknown, path = "instant"): asserts value is UtcInstant {
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) {
    throw new DomainValidationError([`${path} must be a canonical UTC instant with milliseconds`]);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new DomainValidationError([`${path} must be a real canonical UTC instant`]);
  }
}

function parseRecurrence(value: unknown, path: string, issues: string[]): Recurrence {
  const record = requireRecord(value, path, issues);
  const kind = readString(record, "kind", path, issues);
  if (kind === "DAILY" || kind === "WEEKLY" || kind === "WEEKENDS") return { kind };
  if (kind === "SELECTED_WEEKDAYS") {
    const rawWeekdays = record.weekdays;
    if (!Array.isArray(rawWeekdays) || rawWeekdays.length === 0) {
      issues.push(`${path}.weekdays must be a non-empty array`);
      return { kind, weekdays: [] };
    }
    const weekdays: Weekday[] = [];
    for (const [index, weekday] of rawWeekdays.entries()) {
      if (typeof weekday !== "string" || !WEEKDAYS.has(weekday as Weekday)) {
        issues.push(`${path}.weekdays[${index}] is not a supported weekday`);
      } else if (weekdays.includes(weekday as Weekday)) {
        issues.push(`${path}.weekdays must not contain duplicates`);
      } else {
        weekdays.push(weekday as Weekday);
      }
    }
    return { kind, weekdays };
  }
  issues.push(`${path}.kind must be DAILY, WEEKLY, WEEKENDS, or SELECTED_WEEKDAYS`);
  return { kind: "DAILY" };
}

export function parseScheduleRule(value: unknown): ScheduleRule {
  const issues: string[] = [];
  const record = requireRecord(value, "rule", issues);
  const id = readString(record, "id", "rule", issues);
  if (!IDENTIFIER_PATTERN.test(id)) issues.push("rule.id must be a stable 1-128 character identifier");
  const timeZone = readString(record, "timeZone", "rule", issues);
  if (timeZone !== EXPERIENCE_TIME_ZONE) issues.push(`rule.timeZone must be ${EXPERIENCE_TIME_ZONE}`);
  const startsOn = readString(record, "startsOn", "rule", issues);
  const localStartTime = readString(record, "localStartTime", "rule", issues);
  try {
    assertLocalDate(startsOn, "rule.startsOn");
  } catch (error) {
    if (error instanceof DomainValidationError) issues.push(...error.issues);
  }
  try {
    assertLocalTime(localStartTime, "rule.localStartTime");
  } catch (error) {
    if (error instanceof DomainValidationError) issues.push(...error.issues);
  }
  const endsOnValue = record.endsOn;
  let endsOn: string | undefined;
  if (endsOnValue !== undefined) {
    if (typeof endsOnValue !== "string") {
      issues.push("rule.endsOn must be a string when provided");
    } else {
      endsOn = endsOnValue;
      try {
        assertLocalDate(endsOn, "rule.endsOn");
      } catch (error) {
        if (error instanceof DomainValidationError) issues.push(...error.issues);
      }
      if (startsOn && endsOn < startsOn) issues.push("rule.endsOn must not be before rule.startsOn");
    }
  }
  const recurrence = parseRecurrence(record.recurrence, "rule.recurrence", issues);
  const rule: ScheduleRule = {
    id,
    timeZone: EXPERIENCE_TIME_ZONE,
    startsOn,
    ...(endsOn === undefined ? {} : { endsOn }),
    localStartTime,
    durationMinutes: readInteger(record, "durationMinutes", "rule", 1, 1_440, issues),
    capacity: readInteger(record, "capacity", "rule", 1, 1_000, issues),
    bookingCutoffMinutes: readInteger(record, "bookingCutoffMinutes", "rule", 0, 525_600, issues),
    busyBufferBeforeMinutes: readInteger(record, "busyBufferBeforeMinutes", "rule", 0, 1_440, issues),
    busyBufferAfterMinutes: readInteger(record, "busyBufferAfterMinutes", "rule", 0, 1_440, issues),
    recurrence,
  };
  if (issues.length > 0) throw new DomainValidationError(issues);
  return rule;
}

export function parseOccurrenceOverrides(value: unknown): readonly OccurrenceOverride[] {
  if (!Array.isArray(value)) throw new DomainValidationError(["overrides must be an array"]);
  const issues: string[] = [];
  const result: OccurrenceOverride[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const path = `overrides[${index}]`;
    const record = requireRecord(item, path, issues);
    const occurrenceId = readString(record, "occurrenceId", path, issues);
    if (occurrenceId.length === 0 || occurrenceId.length > 256) {
      issues.push(`${path}.occurrenceId must contain 1-256 characters`);
    } else if (seen.has(occurrenceId)) {
      issues.push(`overrides must not contain duplicate occurrenceId values`);
    }
    seen.add(occurrenceId);
    const kind = readString(record, "kind", path, issues);
    if (kind === "CLOSE") {
      result.push({ occurrenceId, kind });
      continue;
    }
    if (kind === "RESCHEDULE") {
      const localDate = readString(record, "localDate", path, issues);
      const localStartTime = readString(record, "localStartTime", path, issues);
      try {
        assertLocalDate(localDate, `${path}.localDate`);
      } catch (error) {
        if (error instanceof DomainValidationError) issues.push(...error.issues);
      }
      try {
        assertLocalTime(localStartTime, `${path}.localStartTime`);
      } catch (error) {
        if (error instanceof DomainValidationError) issues.push(...error.issues);
      }
      const durationValue = record.durationMinutes;
      let durationMinutes: number | undefined;
      if (durationValue !== undefined) {
        durationMinutes = readInteger(record, "durationMinutes", path, 1, 1_440, issues);
      }
      result.push({
        occurrenceId,
        kind,
        localDate,
        localStartTime,
        ...(durationMinutes === undefined ? {} : { durationMinutes }),
      });
      continue;
    }
    issues.push(`${path}.kind must be CLOSE or RESCHEDULE`);
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
  return result;
}

export function parseBusyIntervals(value: unknown): readonly BusyInterval[] {
  if (!Array.isArray(value)) throw new DomainValidationError(["busyIntervals must be an array"]);
  const issues: string[] = [];
  const result: BusyInterval[] = [];
  for (const [index, item] of value.entries()) {
    const path = `busyIntervals[${index}]`;
    const record = requireRecord(item, path, issues);
    const startUtc = readString(record, "startUtc", path, issues);
    const endUtc = readString(record, "endUtc", path, issues);
    try {
      assertUtcInstant(startUtc, `${path}.startUtc`);
      assertUtcInstant(endUtc, `${path}.endUtc`);
      if (startUtc >= endUtc) issues.push(`${path} must have startUtc before endUtc`);
    } catch (error) {
      if (error instanceof DomainValidationError) issues.push(...error.issues);
    }
    result.push({ startUtc, endUtc });
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
  return result;
}

export function assertIntegerInRange(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new DomainValidationError([`${path} must be an integer from ${min} to ${max}`]);
  }
}
