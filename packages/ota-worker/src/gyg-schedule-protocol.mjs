import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

// GetYourGuide generates occurrences from an option's schedule
// (AvailabilityBlock). ENSURE_OCCURRENCE adds one start time to one date by
// rewriting only the block's specialDates; every other schedule field must be
// carried over unchanged from the read that preceded the write.
export const SCHEDULE_READ_OPERATION = "NihoEnsureScheduleRead";
export const SCHEDULE_STEP_OPERATION = "SupplierPortalUpdateScheduleStep";
export const MAX_SCHEDULE_RESPONSE_BYTES = 256 * 1024;
export const WEEKDAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

const UTC_DAY_TO_WEEKDAY = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OPTION_ID = /^[1-9]\d{0,15}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME_LENGTH = 512;
const MAX_SLOTS_PER_DAY = 288;
const MAX_SPECIAL_DATES = 5_000;
const SELECTION = "id status timezone inventoryConfiguration { availabilityType } availabilityAndPricing { status availabilityBlock { id name validityDateRange { start end } weekdays { day timeSlots { from to } } specialDates { date timeSlots { from to } } } }";

const drift = () => new ContractError("DOM_DRIFT");
const unsupported = () => new ContractError("UNSUPPORTED_SCHEDULE");
const byDate = (left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0);

// The read is the shape accepted by the live supplier GraphQL on 2026-10-31:
// a named query with an `ID!` variable holding the option id string.
export function scheduleReadQuery() {
  return `query ${SCHEDULE_READ_OPERATION}($id: ID!) { activityOption(id: $id) { ${SELECTION} } }`;
}

export function scheduleReadRequest(optionId) {
  if (typeof optionId !== "string" || !OPTION_ID.test(optionId)) throw new ContractError("UNSUPPORTED_TARGET");
  return Object.freeze({ operationName: SCHEDULE_READ_OPERATION, query: scheduleReadQuery(), variables: Object.freeze({ id: optionId }) });
}

export function isScheduleReadRequest(body, optionId) {
  try {
    const expected = scheduleReadRequest(optionId);
    return exactKeys(body, ["operationName", "query", "variables"]) && body.operationName === expected.operationName
      && body.query === expected.query && exactKeys(body.variables, ["id"]) && body.variables.id === optionId;
  } catch {
    return false;
  }
}

export function isCalendarDate(value) {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

export function weekdayOf(date) {
  if (!isCalendarDate(date)) throw new ContractError("INVALID_TARGET_TIME");
  const [year, month, day] = date.split("-").map(Number);
  return UTC_DAY_TO_WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function externalId(value, error) {
  const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : null;
  if (text === null || !EXTERNAL_ID.test(text)) throw error();
  return text;
}

const listOf = (value) => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

function readTimes(slots) {
  if (slots !== null && !Array.isArray(slots)) throw drift();
  const times = new Set();
  for (const slot of slots ?? []) {
    if (!exactKeys(slot, ["from", "to"])) throw drift();
    if (slot.to !== null || typeof slot.from !== "string" || !TIME.test(slot.from)) throw unsupported();
    times.add(slot.from);
  }
  if (times.size > MAX_SLOTS_PER_DAY) throw unsupported();
  return Object.freeze([...times].sort());
}

function readWeekdays(entries) {
  if (entries !== null && !Array.isArray(entries)) throw drift();
  const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, Object.freeze([])]));
  const seen = new Set();
  for (const entry of entries ?? []) {
    if (!exactKeys(entry, ["day", "timeSlots"])) throw drift();
    if (!WEEKDAYS.includes(entry.day) || seen.has(entry.day)) throw unsupported();
    seen.add(entry.day);
    weekdays[entry.day] = readTimes(entry.timeSlots);
  }
  return Object.freeze(weekdays);
}

function readSpecialDates(entries) {
  if (entries !== null && !Array.isArray(entries)) throw drift();
  if ((entries ?? []).length > MAX_SPECIAL_DATES) throw unsupported();
  const seen = new Set();
  const dates = [];
  for (const entry of entries ?? []) {
    if (!exactKeys(entry, ["date", "timeSlots"])) throw drift();
    if (!isCalendarDate(entry.date) || seen.has(entry.date)) throw unsupported();
    seen.add(entry.date);
    dates.push(Object.freeze({ date: entry.date, times: readTimes(entry.timeSlots) }));
  }
  return Object.freeze(dates.sort(byDate));
}

function readBlock(value) {
  if (!exactKeys(value, ["id", "name", "validityDateRange", "weekdays", "specialDates"])) throw drift();
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.length > MAX_NAME_LENGTH) throw drift();
  const validity = value.validityDateRange;
  if (!exactKeys(validity, ["start", "end"]) || !isCalendarDate(validity.start)
    || (validity.end !== null && !isCalendarDate(validity.end)) || (validity.end !== null && validity.end < validity.start)) {
    throw unsupported();
  }
  return Object.freeze({
    id: externalId(value.id, drift),
    name: value.name,
    validity: Object.freeze({ start: validity.start, end: validity.end }),
    weekdays: readWeekdays(value.weekdays),
    specialDates: readSpecialDates(value.specialDates),
  });
}

// Normalized form is canonical (fixed key order, sorted lists) so two reads can
// be compared with JSON equality.
export function normalizeScheduleRead(body, target) {
  if (!exactKeys(body, ["data"], ["extensions"]) || !exactKeys(body.data, ["activityOption"])) throw drift();
  const option = body.data.activityOption;
  if (!exactKeys(option, ["id", "status", "timezone", "inventoryConfiguration", "availabilityAndPricing"])) throw drift();
  if (externalId(option.id, drift) !== target.externalOptionId) throw new ContractError("TARGET_MISMATCH");
  if (typeof option.status !== "string" || typeof option.timezone !== "string"
    || !exactKeys(option.inventoryConfiguration, ["availabilityType"])
    || typeof option.inventoryConfiguration.availabilityType !== "string") throw drift();
  const pricing = listOf(option.availabilityAndPricing).map((entry) => {
    if (!exactKeys(entry, ["status", "availabilityBlock"]) || typeof entry.status !== "string") throw drift();
    const blocks = listOf(entry.availabilityBlock).map(readBlock).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return Object.freeze({ status: entry.status, blocks: Object.freeze(blocks) });
  }).map((entry) => [JSON.stringify(entry), entry]).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, entry]) => entry);
  return Object.freeze({
    optionId: target.externalOptionId,
    status: option.status,
    timezone: option.timezone,
    availabilityType: option.inventoryConfiguration.availabilityType,
    pricing: Object.freeze(pricing),
  });
}

export function sameSchedule(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function plannedSpecialDates(block, date, time) {
  if (!isCalendarDate(date) || typeof time !== "string" || !TIME.test(time)) throw new ContractError("INVALID_TARGET_TIME");
  const existing = block.specialDates.find((entry) => entry.date === date);
  // Whether a special date replaces or extends the weekday times is not
  // confirmed, so the target date always keeps the times it already has.
  const base = existing ? existing.times : block.weekdays[weekdayOf(date)];
  const times = Object.freeze([...new Set([...base, time])].sort());
  return Object.freeze([...block.specialDates.filter((entry) => entry.date !== date), Object.freeze({ date, times })].sort(byDate));
}

export function planEnsureOccurrence(schedule, job) {
  const date = job.localDateTime.slice(0, 10);
  const time = job.localDateTime.slice(11, 16);
  if (schedule.status !== "ACTIVE") throw new ContractError("OPTION_NOT_ACTIVE");
  if (schedule.timezone !== job.target.timeZone || schedule.availabilityType !== "starting_times") throw unsupported();
  const active = schedule.pricing.filter((entry) => entry.status === "ACTIVE");
  if (active.length !== 1 || active[0].blocks.length !== 1) throw new ContractError("AMBIGUOUS_SCHEDULE");
  const block = active[0].blocks[0];
  if (date < block.validity.start || (block.validity.end !== null && date > block.validity.end)) {
    throw new ContractError("OUTSIDE_SCHEDULE_VALIDITY");
  }
  const special = block.specialDates.find((entry) => entry.date === date);
  // The agenda had no row, so a schedule that already lists the time means the
  // two views disagree; writing could not be shown to be the missing piece.
  if (block.weekdays[weekdayOf(date)].includes(time) || special?.times.includes(time)) {
    throw new ContractError("SCHEDULE_AGENDA_MISMATCH");
  }
  const specialDates = plannedSpecialDates(block, date, time);
  const expectedAfter = Object.freeze({
    ...schedule,
    pricing: Object.freeze(schedule.pricing.map((entry) => (entry === active[0]
      ? Object.freeze({ ...entry, blocks: Object.freeze([Object.freeze({ ...block, specialDates })]) })
      : entry))),
  });
  return Object.freeze({ block, date, time, specialDates, expectedAfter });
}

function stepTimes(slots) {
  if (!Array.isArray(slots) || slots.length > MAX_SLOTS_PER_DAY) return null;
  const times = new Set();
  for (const slot of slots) {
    if (!exactKeys(slot, ["from"], ["to"]) || (slot.to !== undefined && slot.to !== null)
      || typeof slot.from !== "string" || !TIME.test(slot.from)) return null;
    times.add(slot.from);
  }
  return Object.freeze([...times].sort());
}

// Normalizes the variables the supplier screen itself sends on step 1 save.
export function normalizeScheduleStepVariables(variables) {
  if (!exactKeys(variables, ["scheduleId", "input"])) return null;
  const { input } = variables;
  if (!exactKeys(input, ["name", "dateRange", "weekdays", "specialDates"]) || typeof input.name !== "string"
    || !exactKeys(input.dateRange, ["start"], ["end"]) || !isCalendarDate(input.dateRange.start)
    || (input.dateRange.end !== undefined && input.dateRange.end !== null && !isCalendarDate(input.dateRange.end))
    || !Array.isArray(input.weekdays) || input.weekdays.length !== WEEKDAYS.length
    || !Array.isArray(input.specialDates) || input.specialDates.length > MAX_SPECIAL_DATES) return null;
  let scheduleId;
  try { scheduleId = externalId(variables.scheduleId, drift); } catch { return null; }
  const weekdays = {};
  for (const entry of input.weekdays) {
    if (!exactKeys(entry, ["day", "timeSlots"]) || !WEEKDAYS.includes(entry.day) || Object.hasOwn(weekdays, entry.day)) return null;
    const times = stepTimes(entry.timeSlots);
    if (!times) return null;
    weekdays[entry.day] = times;
  }
  const specialDates = [];
  const seen = new Set();
  for (const entry of input.specialDates) {
    if (!exactKeys(entry, ["date", "timeSlots"]) || !isCalendarDate(entry.date) || seen.has(entry.date)) return null;
    seen.add(entry.date);
    const times = stepTimes(entry.timeSlots);
    if (!times) return null;
    specialDates.push(Object.freeze({ date: entry.date, times }));
  }
  return Object.freeze({
    id: scheduleId,
    name: input.name,
    validity: Object.freeze({ start: input.dateRange.start, end: input.dateRange.end ?? null }),
    weekdays: Object.freeze(Object.fromEntries(WEEKDAYS.map((day) => [day, weekdays[day]]))),
    specialDates: Object.freeze(specialDates.sort(byDate)),
  });
}

// Returns the variables to forward (specialDates replaced) or null when the
// screen's variables differ in any way from the block read before the write.
export function rewriteScheduleStepVariables(variables, plan) {
  const screen = normalizeScheduleStepVariables(variables);
  if (!screen || !sameSchedule(screen, plan.block)) return null;
  return {
    ...variables,
    input: {
      ...variables.input,
      specialDates: plan.specialDates.map((entry) => ({ date: entry.date, timeSlots: entry.times.map((from) => ({ from, to: null })) })),
    },
  };
}

// The step mutation answers `data.<field> = { success, message, errorDetails, ... }`.
export function scheduleStepSucceeded(body) {
  if (!isPlainObject(body) || body.errors !== undefined || !isPlainObject(body.data)) return false;
  const values = Object.values(body.data);
  return values.length === 1 && isPlainObject(values[0]) && values[0].success === true;
}
