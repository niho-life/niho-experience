import { ADAPTER_REGISTRY, CONNECTION_MODE, OPTIONAL_TARGET_KEYS, TARGET_KEYS } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject, validateTarget } from "./validation.mjs";

// Observed GetYourGuide supplier contract (read-only). Only scheduling fields
// are selected; guest names, contacts, prices, tickets and locations exist on
// the Booking type but must never be requested.
export const RESERVATION_OPERATION_NAME = "NihoReservationWindowRead";
export const RESERVATION_QUERY = "query NihoReservationWindowRead($input: BookingSearchInput!) { bookings: supplierBookingEntitySearch(input: $input) { items { id status guideStatus isPending totalNumberOfParticipants tourStart activityOption { id activity { id } duration { value unit } } } pagination { totalItems } } }";
export const RESERVATION_PAGE_SIZE = 50;
export const MAX_RESERVATION_TOTAL = 4_000;
export const MAX_RESERVATION_RESPONSE_BYTES = 1024 * 1024;

const MAX_TOTAL_ITEMS = 100_000;
// GYG's interpretation of tourStartDatetime filters (supplier local vs UTC) is
// unconfirmed. Read a day beyond both edges and drop out-of-coverage facts.
const EDGE_MARGIN_MS = 24 * 60 * 60 * 1000;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOUR_START = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const CURSOR = /^o(?:0|[1-9]\d{0,8})$/;
const ITEM_KEYS = ["id", "status", "guideStatus", "isPending", "totalNumberOfParticipants", "tourStart", "activityOption"];
const DURATION_MINUTES = new Map([["MINUTE", 1], ["MINUTES", 1], ["HOUR", 60], ["HOURS", 60], ["DAY", 1_440], ["DAYS", 1_440]]);
const GYG = ADAPTER_REGISTRY.GetYourGuide;

const invalidResponse = () => new ContractError("INVALID_READER_RESPONSE");

function canonicalInstant(value) {
  return typeof value === "string" && CANONICAL_UTC.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function assertReaderTarget(target) {
  let valid;
  try { valid = validateTarget(target); } catch { throw new ContractError("INVALID_READER"); }
  if (valid.site !== GYG.site || valid.adapter !== GYG.adapter || valid.adapterVersion !== GYG.adapterVersion
    || valid.connectionMode !== CONNECTION_MODE || typeof valid.externalOptionId !== "string" || valid.externalOptionId.length < 1) {
    throw new ContractError("INVALID_READER");
  }
  return valid;
}

export function sameReaderTarget(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = [...TARGET_KEYS, ...OPTIONAL_TARGET_KEYS];
  return exactKeys(left, TARGET_KEYS, OPTIONAL_TARGET_KEYS) && exactKeys(right, TARGET_KEYS, OPTIONAL_TARGET_KEYS)
    && keys.every((key) => left[key] === right[key]);
}

export function buildSearchRequest({ supplierId, coverageFromUtc, coverageToUtc, offset, limit = RESERVATION_PAGE_SIZE }) {
  if (typeof supplierId !== "string" || !/^\d{1,128}$/.test(supplierId)
    || !canonicalInstant(coverageFromUtc) || !canonicalInstant(coverageToUtc) || coverageFromUtc >= coverageToUtc
    || !Number.isSafeInteger(offset) || offset < 0 || limit !== RESERVATION_PAGE_SIZE) {
    throw new ContractError("INVALID_READER");
  }
  const from = new Date(Date.parse(coverageFromUtc) - EDGE_MARGIN_MS).toISOString();
  const to = new Date(Date.parse(coverageToUtc) + EDGE_MARGIN_MS).toISOString();
  return Object.freeze({
    operationName: RESERVATION_OPERATION_NAME,
    query: RESERVATION_QUERY,
    variables: Object.freeze({
      input: Object.freeze({
        limit,
        offset,
        sorts: Object.freeze([Object.freeze({ column: "creationTimestamp", direction: "DESC" })]),
        filters: Object.freeze([
          Object.freeze({ column: "supplierId", operation: "EQUALS", value: supplierId }),
          Object.freeze({ column: "tourStartDatetime", operation: "GREATER_THAN_OR_EQUAL_TO", value: from }),
          Object.freeze({ column: "tourStartDatetime", operation: "LESS_THAN", value: to }),
        ]),
      }),
    }),
  });
}

function externalId(value) {
  const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : null;
  if (text === null || !EXTERNAL_ID.test(text)) throw invalidResponse();
  return text;
}

function bookingItem(value) {
  if (!exactKeys(value, ITEM_KEYS)) throw invalidResponse();
  const option = value.activityOption;
  if (!exactKeys(option, ["id", "activity", "duration"]) || !exactKeys(option.activity, ["id"])
    || !exactKeys(option.duration, ["value", "unit"])) throw invalidResponse();
  return Object.freeze({
    id: externalId(value.id),
    productId: externalId(option.activity.id),
    optionId: externalId(option.id),
    status: value.status,
    guideStatus: value.guideStatus,
    isPending: value.isPending,
    totalNumberOfParticipants: value.totalNumberOfParticipants,
    tourStart: value.tourStart,
    duration: Object.freeze({ value: option.duration.value, unit: option.duration.unit }),
  });
}

// Error messages and raw bodies stay out of thrown errors: only fixed codes.
export function parseSearchResponse(response) {
  if (!isPlainObject(response) || !Number.isSafeInteger(response.status)) throw new ContractError("INVALID_RESPONSE");
  const { status, bodyText } = response;
  if (status === 401 || status === 403) throw new ContractError("AUTH_REQUIRED");
  if (status === 429 || (status >= 500 && status <= 599)) throw new ContractError("UPSTREAM_UNAVAILABLE");
  if (status < 200 || status > 299) throw new ContractError("HTTP_ERROR");
  if (typeof bodyText !== "string") throw new ContractError("INVALID_RESPONSE");
  if (bodyText.length > MAX_RESERVATION_RESPONSE_BYTES || Buffer.byteLength(bodyText, "utf8") > MAX_RESERVATION_RESPONSE_BYTES) {
    throw new ContractError("PAGE_TOO_LARGE");
  }
  let body;
  try { body = JSON.parse(bodyText); } catch { throw new ContractError("INVALID_RESPONSE"); }
  if (!exactKeys(body, [], ["data", "errors", "extensions"])) throw new ContractError("INVALID_RESPONSE");
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) throw new ContractError("INVALID_RESPONSE");
    if (body.errors.length > 0) {
      const auth = body.errors.some((error) => isPlainObject(error) && isPlainObject(error.extensions)
        && ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.extensions.code));
      throw new ContractError(auth ? "AUTH_REQUIRED" : "INVALID_RESPONSE");
    }
  }
  if (!exactKeys(body.data, ["bookings"])) throw invalidResponse();
  const { bookings } = body.data;
  if (!exactKeys(bookings, ["items", "pagination"]) || !exactKeys(bookings.pagination, ["totalItems"])
    || !Number.isSafeInteger(bookings.pagination.totalItems) || bookings.pagination.totalItems < 0
    || bookings.pagination.totalItems > MAX_TOTAL_ITEMS
    || !Array.isArray(bookings.items) || bookings.items.length > RESERVATION_PAGE_SIZE) throw invalidResponse();
  return Object.freeze({
    totalItems: bookings.pagination.totalItems,
    items: Object.freeze(bookings.items.map(bookingItem)),
  });
}

// Only GYG's explicit booking cancellation releases a seat. Every other ACTIVE
// combination (unconfirmed, pending, guide-cancelled) keeps the seat held.
export function bookingStatus({ status, guideStatus, isPending }) {
  if (!["ACTIVE", "CANCELED"].includes(status) || !["CONFIRMED", "UNCONFIRMED", "CANCELED"].includes(guideStatus)
    || typeof isPending !== "boolean") throw invalidResponse();
  if (status === "CANCELED") return "CANCELLED";
  return guideStatus === "CONFIRMED" && isPending === false ? "CONFIRMED" : "PENDING";
}

// Leap years repeat every 400 years; this avoids Date.UTC's two-digit years.
const daysInMonth = (year, month) => new Date(Date.UTC(2000 + (year % 400), month, 0)).getUTCDate();

export function parseTourStart(value) {
  const match = typeof value === "string" ? TOUR_START.exec(value) : null;
  if (!match) throw invalidResponse();
  const [, year, month, day, hour, minute, second = "00", fraction = "", zone, sign, offsetHour = "00", offsetMinute = "00"] = match;
  const [y, mo, d, h, mi, s, oh, om] = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) throw invalidResponse();
  const local = new Date(0);
  local.setUTCFullYear(y, mo - 1, d);
  local.setUTCHours(h, mi, s, Number(fraction.padEnd(3, "0") || "0"));
  const offsetMs = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  const instant = local.getTime() - offsetMs;
  if (!Number.isFinite(instant)) throw invalidResponse();
  const canonical = new Date(instant).toISOString();
  if (!canonicalInstant(canonical)) throw invalidResponse();
  return canonical;
}

export function durationMinutes(duration) {
  if (!isPlainObject(duration)) throw invalidResponse();
  const { value, unit } = duration;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || typeof unit !== "string") throw invalidResponse();
  const factor = DURATION_MINUTES.get(unit.toUpperCase());
  if (!factor) throw invalidResponse();
  const minutes = value * factor;
  const rounded = Math.round(minutes);
  if (Math.abs(minutes - rounded) > 1e-9 || rounded < 1 || rounded > 1_440) throw invalidResponse();
  return rounded;
}

export function bookingFact(item, { target, coverageFromUtc, coverageToUtc }) {
  // Other options, including sibling options of the same activity, are counted
  // for completeness but never reported. Option IDs identify one activity, so
  // the target option under another activity is a mapping conflict, not a skip.
  if (item.optionId !== target.externalOptionId) return null;
  if (item.productId !== target.externalProductId) throw invalidResponse();
  const status = bookingStatus(item);
  const seats = item.totalNumberOfParticipants;
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 1_000) throw invalidResponse();
  const sourceStartAtUtc = parseTourStart(item.tourStart);
  // The end comes from GYG's own duration, never from the NIHO manifest.
  const sourceEndAtUtc = new Date(Date.parse(sourceStartAtUtc) + durationMinutes(item.duration) * 60_000).toISOString();
  if (sourceStartAtUtc < coverageFromUtc || sourceStartAtUtc >= coverageToUtc) return null;
  return Object.freeze({
    externalReservationId: item.id,
    externalProductId: target.externalProductId,
    externalOptionId: target.externalOptionId,
    sourceStartAtUtc,
    sourceEndAtUtc,
    status,
    seats,
  });
}

const COMPLETE = Object.freeze({ status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true });
const PARTIAL = Object.freeze({ status: "PARTIAL", allPagesRead: false, allStatusesIncluded: true, coverageComplete: false });

// Offset pagination over a creation-time-sorted list. The first page fixes the
// expected total; any total change, re-seen id or premature empty page means a
// booking was created or removed mid-read, so the window ends PARTIAL without
// sending that page's facts. No status filter is sent, so allStatusesIncluded
// relies on GYG not hiding states implicitly; real-site acceptance must
// confirm that before this reader is enabled.
export function createGygReservationReaderCore({ target, transport }) {
  const fixedTarget = assertReaderTarget(target);
  if (typeof transport !== "function") throw new ContractError("INVALID_READER");
  let read = null;
  let busy = false;
  let stopped = false;

  const partial = (state) => {
    state.finished = true;
    return Object.freeze({ facts: Object.freeze([]), terminal: PARTIAL });
  };

  async function readPage(input) {
    if (stopped) throw new ContractError("READER_STOPPED");
    if (busy || !isPlainObject(input) || !sameReaderTarget(input.target, fixedTarget)) throw new ContractError("INVALID_READER");
    const { coverageFromUtc, coverageToUtc, cursor, signal } = input;
    if (!canonicalInstant(coverageFromUtc) || !canonicalInstant(coverageToUtc) || coverageFromUtc >= coverageToUtc) {
      throw new ContractError("INVALID_READER");
    }
    if (cursor === undefined) {
      read = { coverageFromUtc, coverageToUtc, expectedTotal: null, seenIds: new Set(), nextOffset: 0, finished: false };
    } else if (!read || read.finished || typeof cursor !== "string" || !CURSOR.test(cursor) || cursor !== `o${read.nextOffset}`
      || read.coverageFromUtc !== coverageFromUtc || read.coverageToUtc !== coverageToUtc) {
      throw new ContractError("INVALID_READER");
    }
    const state = read;
    const offset = state.nextOffset;
    const request = buildSearchRequest({
      supplierId: fixedTarget.externalAccountId, coverageFromUtc, coverageToUtc, offset, limit: RESERVATION_PAGE_SIZE,
    });
    busy = true;
    state.finished = true;
    let page;
    try {
      page = parseSearchResponse(await transport(request, signal));
    } finally {
      busy = false;
    }
    if (stopped) throw new ContractError("READER_STOPPED");
    if (state.expectedTotal === null) {
      if (page.totalItems > MAX_RESERVATION_TOTAL) throw new ContractError("PAGE_LIMIT");
      state.expectedTotal = page.totalItems;
    } else if (page.totalItems !== state.expectedTotal) {
      return partial(state);
    }
    const ids = page.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => state.seenIds.has(id))) return partial(state);
    if (ids.length === 0 && offset < state.expectedTotal) return partial(state);
    const nextOffset = offset + ids.length;
    if (nextOffset > state.expectedTotal) return partial(state);
    const facts = [];
    for (const item of page.items) {
      const fact = bookingFact(item, { target: fixedTarget, coverageFromUtc, coverageToUtc });
      if (fact) facts.push(fact);
    }
    for (const id of ids) state.seenIds.add(id);
    state.nextOffset = nextOffset;
    if (nextOffset === state.expectedTotal) {
      if (state.seenIds.size !== state.expectedTotal) return partial(state);
      return Object.freeze({ facts: Object.freeze(facts), terminal: COMPLETE });
    }
    state.finished = false;
    return Object.freeze({ facts: Object.freeze(facts), nextCursor: `o${nextOffset}` });
  }

  return Object.freeze({
    readPage,
    async stop() {
      stopped = true;
      return true;
    },
  });
}
