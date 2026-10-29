import {
  EXPERIENCE_TIME_ZONE,
  type BookingOccurrenceSnapshot,
  type ExpandOccurrencesInput,
  type Occurrence,
  type OccurrenceId,
  type OccurrenceOverride,
  type OccurrenceSalesState,
  type ScheduleRule,
  type UtcInstant,
} from "#types";
import { addLocalDays, addMinutes, localDateDistance, tokyoLocalToUtc, weekdayOf } from "#time";
import {
  DomainValidationError,
  assertIntegerInRange,
  assertLocalDate,
  assertUtcInstant,
  parseOccurrenceOverrides,
  parseScheduleRule,
} from "#validation";

export const MAX_EXPANSION_DAYS = 90;

export function occurrenceIdFor(ruleId: string, sourceLocalDate: string): OccurrenceId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ruleId)) {
    throw new DomainValidationError(["ruleId must be a stable 1-128 character identifier"]);
  }
  assertLocalDate(sourceLocalDate, "sourceLocalDate");
  return `${encodeURIComponent(ruleId)}@${sourceLocalDate}`;
}

function recursOn(rule: ScheduleRule, localDate: string): boolean {
  const weekday = weekdayOf(localDate);
  switch (rule.recurrence.kind) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return weekday === weekdayOf(rule.startsOn);
    case "WEEKENDS":
      return weekday === "SATURDAY" || weekday === "SUNDAY";
    case "SELECTED_WEEKDAYS":
      return rule.recurrence.weekdays.includes(weekday);
  }
}

function toOccurrence(
  rule: ScheduleRule,
  sourceLocalDate: string,
  override: OccurrenceOverride | undefined,
  salesState: OccurrenceSalesState | undefined,
): Occurrence {
  const occurrenceId = occurrenceIdFor(rule.id, sourceLocalDate);
  const reschedule = override?.kind === "RESCHEDULE" ? override : undefined;
  const localDate = reschedule?.localDate ?? sourceLocalDate;
  const localStartTime = reschedule?.localStartTime ?? rule.localStartTime;
  const durationMinutes = reschedule?.durationMinutes ?? rule.durationMinutes;
  const startUtc = tokyoLocalToUtc(localDate, localStartTime);
  return {
    id: occurrenceId,
    ruleId: rule.id,
    sourceLocalDate,
    localDate,
    localStartTime,
    timeZone: EXPERIENCE_TIME_ZONE,
    startUtc,
    endUtc: addMinutes(startUtc, durationMinutes),
    durationMinutes,
    capacity: rule.capacity,
    bookingCutoffMinutes: rule.bookingCutoffMinutes,
    busyBufferBeforeMinutes: rule.busyBufferBeforeMinutes,
    busyBufferAfterMinutes: rule.busyBufferAfterMinutes,
    // CLOSE is read only for pre-migration compatibility. New writes use the orthogonal sales state.
    status: salesState?.desiredState ?? (override?.kind === "CLOSE" ? "CLOSED" : "OPEN"),
    rescheduled: reschedule !== undefined,
  };
}

export function expandOccurrences(input: ExpandOccurrencesInput): readonly Occurrence[] {
  const rule = parseScheduleRule(input.rule);
  assertLocalDate(input.fromDate, "fromDate");
  assertLocalDate(input.toDate, "toDate");
  const distance = localDateDistance(input.fromDate, input.toDate);
  if (distance < 0) throw new DomainValidationError(["toDate must not be before fromDate"]);
  if (distance + 1 > MAX_EXPANSION_DAYS) {
    throw new DomainValidationError([`expansion must not exceed ${MAX_EXPANSION_DAYS} inclusive days`]);
  }
  const overrides = parseOccurrenceOverrides(input.overrides ?? []);
  const overridesById = new Map(overrides.map((override) => [override.occurrenceId, override]));
  const salesStatesById = new Map((input.salesStates ?? []).map((state) => [state.occurrenceId, state]));
  const firstDate = input.fromDate < rule.startsOn ? rule.startsOn : input.fromDate;
  const lastDate = rule.endsOn !== undefined && rule.endsOn < input.toDate ? rule.endsOn : input.toDate;
  const sourceDates = new Set<string>();
  const occurrences: Occurrence[] = [];
  if (firstDate <= lastDate) {
    for (let offset = 0; offset <= localDateDistance(firstDate, lastDate); offset += 1) {
      const sourceLocalDate = addLocalDays(firstDate, offset);
      if (recursOn(rule, sourceLocalDate)) sourceDates.add(sourceLocalDate);
    }
  }
  // A moved occurrence keeps its source identity even when that source is outside
  // the viewed range. Include it where the host actually sees the new date.
  for (const override of overrides) {
    if (override.kind !== "RESCHEDULE" || override.localDate < input.fromDate || override.localDate > input.toDate) continue;
    const marker = override.occurrenceId.lastIndexOf("@");
    const sourceLocalDate = override.occurrenceId.slice(marker + 1);
    if (marker < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(sourceLocalDate) || override.occurrenceId !== occurrenceIdFor(rule.id, sourceLocalDate)) continue;
    if (sourceLocalDate < rule.startsOn || (rule.endsOn && sourceLocalDate > rule.endsOn) || !recursOn(rule, sourceLocalDate)) continue;
    sourceDates.add(sourceLocalDate);
  }
  for (const sourceLocalDate of sourceDates) {
    const id = occurrenceIdFor(rule.id, sourceLocalDate);
    const occurrence = toOccurrence(rule, sourceLocalDate, overridesById.get(id), salesStatesById.get(id));
    if (occurrence.localDate >= input.fromDate && occurrence.localDate <= input.toDate) occurrences.push(occurrence);
  }
  return occurrences.sort((left, right) => left.startUtc.localeCompare(right.startUtc) || left.id.localeCompare(right.id));
}

export function createBookingOccurrenceSnapshot(
  occurrence: Occurrence,
  seats: number,
  acceptedAtUtc: UtcInstant,
): BookingOccurrenceSnapshot {
  assertIntegerInRange(seats, "seats", 1, 1_000);
  if (seats > occurrence.capacity) {
    throw new DomainValidationError(["seats must not exceed occurrence capacity"]);
  }
  assertUtcInstant(acceptedAtUtc, "acceptedAtUtc");
  return Object.freeze({
    occurrenceId: occurrence.id,
    ruleId: occurrence.ruleId,
    sourceLocalDate: occurrence.sourceLocalDate,
    localDate: occurrence.localDate,
    localStartTime: occurrence.localStartTime,
    timeZone: occurrence.timeZone,
    startUtc: occurrence.startUtc,
    endUtc: occurrence.endUtc,
    capacityAtAcceptance: occurrence.capacity,
    seats,
    acceptedAtUtc,
  });
}
