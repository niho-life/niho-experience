import {
  ADAPTER_REGISTRY,
  CONNECTION_MODE,
  GOOGLE_DELIVERY_TARGET,
  MAX_JOB_MS,
  MAX_CLOCK_SKEW_MS,
  OPTIONAL_TARGET_KEYS,
  TARGET_KEYS,
  TIME_ZONE,
} from "./constants.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TOKYO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00$/;
const DIGITS = /^\d+$/;

export class ContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyText(value, max, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new ContractError("INVALID_CONTRACT", `${name} is invalid`);
  return value;
}

function canonicalInstant(value, name) {
  const milliseconds = typeof value === "string" && value.endsWith("Z") && !value.includes(".") ? value.replace(/Z$/, ".000Z") : value;
  if (typeof value !== "string" || !UTC_INSTANT.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== milliseconds) {
    throw new ContractError("INVALID_CONTRACT", `${name} must be a UTC instant`);
  }
  return value;
}

export function validateTarget(value) {
  if (!exactKeys(value, TARGET_KEYS, OPTIONAL_TARGET_KEYS)) throw new ContractError("TARGET_MISMATCH");
  if (value.site === GOOGLE_DELIVERY_TARGET.site) {
    const account = nonEmptyText(value.externalAccountId, 128, "externalAccountId");
    const product = nonEmptyText(value.externalProductId, 128, "externalProductId");
    if (value.adapter !== GOOGLE_DELIVERY_TARGET.adapter
      || value.adapterVersion !== GOOGLE_DELIVERY_TARGET.adapterVersion
      || value.connectionMode !== GOOGLE_DELIVERY_TARGET.connectionMode
      || value.timeZone !== TIME_ZONE
      || !/^[1-9]\d*$/.test(account)
      || !/^[1-9]\d*$/.test(product)
      || (value.externalOptionId !== undefined && value.externalOptionId !== "")) {
      throw new ContractError("UNSUPPORTED_TARGET");
    }
    return Object.freeze({ ...value });
  }
  const adapter = ADAPTER_REGISTRY[value.site];
  if (!adapter || value.adapter !== adapter.adapter || value.adapterVersion !== adapter.adapterVersion
    || value.connectionMode !== CONNECTION_MODE || value.timeZone !== TIME_ZONE) throw new ContractError("UNSUPPORTED_TARGET");
  const account = nonEmptyText(value.externalAccountId, 128, "externalAccountId");
  const product = nonEmptyText(value.externalProductId, 128, "externalProductId");
  const option = nonEmptyText(value.externalOptionId, 128, "externalOptionId");
  const valid = value.site === "GetYourGuide"
    ? DIGITS.test(account) && DIGITS.test(product) && DIGITS.test(option)
    : value.site === "Viator"
      ? DIGITS.test(account) && /^\d+P\d+$/.test(product) && /^TG[A-Za-z0-9]+$/.test(option)
      : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account) && /^l\d+$/.test(product)
        && /^(?:0|[1-9]\d*)$/.test(option) && Number.isSafeInteger(Number(option));
  if (!valid) throw new ContractError("TARGET_MISMATCH");
  return Object.freeze({ ...value });
}

export function isGoogleDeliveryTarget(target) {
  return target?.site === GOOGLE_DELIVERY_TARGET.site
    && target?.adapter === GOOGLE_DELIVERY_TARGET.adapter
    && target?.adapterVersion === GOOGLE_DELIVERY_TARGET.adapterVersion
    && target?.connectionMode === GOOGLE_DELIVERY_TARGET.connectionMode
    && target?.timeZone === TIME_ZONE;
}

export function tokyoLocalFromUtc(value) {
  const instant = canonicalInstant(value, "sourceStartAtUtc");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

export function validateTokyoLocal(value) {
  const match = typeof value === "string" ? TOKYO_LOCAL.exec(value) : null;
  if (!match) throw new ContractError("INVALID_TARGET_TIME");
  const [, year, month, day, hour, minute] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59) throw new ContractError("INVALID_TARGET_TIME");
  return value;
}

export function validateClaim(value, nowMs = Date.now()) {
  if (!exactKeys(value, [
    "id", "leaseToken", "leaseExpiresAtUtc", "deadlineAtUtc", "action", "occurrenceId", "desiredVersion",
    "mappingVersion", "sourceStartAtUtc", "sourceEndAtUtc", "target",
  ], ["purpose"])) throw new ContractError("INVALID_JOB");
  if (!UUID_V4.test(value.id) || typeof value.leaseToken !== "string" || value.leaseToken.length < 1 || value.leaseToken.length > 100
    || !["SET_OPEN", "SET_CLOSED", "OBSERVE"].includes(value.action)
    || typeof value.occurrenceId !== "string" || value.occurrenceId.length < 1 || value.occurrenceId.length > 256
    || !Number.isSafeInteger(value.desiredVersion) || value.desiredVersion < 1
    || !Number.isSafeInteger(value.mappingVersion) || value.mappingVersion < 1
    || (value.purpose !== undefined && value.purpose !== "RESERVATION_WINDOW")
    || (value.purpose === "RESERVATION_WINDOW" && value.action !== "OBSERVE")) throw new ContractError("INVALID_JOB");
  canonicalInstant(value.leaseExpiresAtUtc, "leaseExpiresAtUtc");
  canonicalInstant(value.deadlineAtUtc, "deadlineAtUtc");
  canonicalInstant(value.sourceStartAtUtc, "sourceStartAtUtc");
  canonicalInstant(value.sourceEndAtUtc, "sourceEndAtUtc");
  const deadlineMs = Date.parse(value.deadlineAtUtc);
  if (deadlineMs <= nowMs || deadlineMs - nowMs > MAX_JOB_MS + MAX_CLOCK_SKEW_MS || Date.parse(value.leaseExpiresAtUtc) <= nowMs || Date.parse(value.leaseExpiresAtUtc) > deadlineMs
    || Date.parse(value.sourceEndAtUtc) <= Date.parse(value.sourceStartAtUtc)) throw new ContractError("INVALID_JOB_DEADLINE");
  const target = validateTarget(value.target);
  const localDateTime = validateTokyoLocal(tokyoLocalFromUtc(value.sourceStartAtUtc));
  return Object.freeze({ ...value, target, localDateTime, desiredState: value.action === "SET_CLOSED" ? "CLOSED" : value.action === "SET_OPEN" ? "OPEN" : undefined });
}

export function validatePreflight(value, desiredState) {
  const stateMatches = desiredState === undefined
    ? value?.desiredState === "OPEN" || value?.desiredState === "CLOSED"
    : value?.desiredState === desiredState;
  if (!exactKeys(value, ["ready", "desiredState"]) || value.ready !== true || !stateMatches) {
    throw new ContractError("STALE_PREFLIGHT");
  }
  return Object.freeze({ ready: true, desiredState: value.desiredState });
}

export function validateObservation(value, job) {
  if (!exactKeys(value, ["occurrenceId", "sourceStartAtUtc", "sourceEndAtUtc", "observedAtUtc", "manuallyBlocked", "bookable"])) {
    throw new ContractError("DOM_DRIFT");
  }
  if (value.occurrenceId !== job.occurrenceId || value.sourceStartAtUtc !== job.sourceStartAtUtc || value.sourceEndAtUtc !== job.sourceEndAtUtc
    || typeof value.manuallyBlocked !== "boolean" || typeof value.bookable !== "boolean") throw new ContractError("TARGET_MISMATCH");
  canonicalInstant(value.observedAtUtc, "observedAtUtc");
  return Object.freeze({ ...value });
}

export function makeResult({ resultId, job, outcome, stopped, observation }) {
  if (!UUID_V4.test(resultId) || typeof stopped !== "boolean") throw new ContractError("INVALID_RESULT");
  if (!["VERIFIED", "AUTH_REQUIRED", "NEEDS_REVIEW", "UNKNOWN_AFTER_SAVE", "RETRY_WAIT", "SUPERSEDED"].includes(outcome)) {
    throw new ContractError("INVALID_RESULT");
  }
  return Object.freeze({
    resultId,
    leaseToken: job.leaseToken,
    outcome,
    stopped,
    target: job.target,
    ...(observation ? {
      occurrenceId: observation.occurrenceId,
      sourceStartAtUtc: observation.sourceStartAtUtc,
      sourceEndAtUtc: observation.sourceEndAtUtc,
      observedState: observation.manuallyBlocked ? "CLOSED" : "OPEN",
      observedBookable: observation.bookable,
      observedManuallyBlocked: observation.manuallyBlocked,
      observedAtUtc: observation.observedAtUtc,
    } : {}),
  });
}

export function makeReservationResult({ resultId, job, outcome, stopped, reservationReadId, reservationReceiptId }) {
  if (!UUID_V4.test(resultId) || typeof stopped !== "boolean" || job.purpose !== "RESERVATION_WINDOW"
    || !["RESERVATION_VERIFIED", "AUTH_REQUIRED", "NEEDS_REVIEW", "RETRY_WAIT", "SUPERSEDED"].includes(outcome)) {
    throw new ContractError("INVALID_RESULT");
  }
  const verified = outcome === "RESERVATION_VERIFIED";
  if ((verified && !(UUID_V4.test(reservationReadId ?? "") && UUID_V4.test(reservationReceiptId ?? "")))
    || (!verified && (reservationReadId !== undefined || reservationReceiptId !== undefined))) {
    throw new ContractError("INVALID_RESULT");
  }
  return Object.freeze({
    resultId, leaseToken: job.leaseToken, outcome, stopped, target: job.target,
    ...(verified ? { reservationReadId, reservationReceiptId } : {}),
  });
}
