import test from "node:test";
import assert from "node:assert/strict";
import { isNamedReadOnlyQuery } from "../src/network-guard.mjs";
import {
  MAX_RESERVATION_RESPONSE_BYTES,
  RESERVATION_OPERATION_NAME,
  RESERVATION_QUERY,
  bookingFact,
  bookingStatus,
  buildSearchRequest,
  createGygReservationReaderCore,
  durationMinutes,
  parseSearchResponse,
  parseTourStart,
} from "../src/gyg-reservation-protocol.mjs";
import { createGygReadOnlyGuard, createGygReservationReader } from "../src/gyg-reservation-reader.mjs";
import { executeReservationWindow, reservationExecutorInternals, unsupportedReservationReaderFactory } from "../src/reservation-executor.mjs";
import { RESERVATION_READER_FACTORIES, RESERVATION_READER_KEYS, selectReservationReaderFactory } from "../src/reservation-reader-registry.mjs";
import { executeJob } from "../src/supervisor.mjs";
import { ContractError } from "../src/validation.mjs";

const fixedNow = Date.now();
const target = Object.freeze({
  site: "GetYourGuide", externalAccountId: "10001", externalProductId: "20002", externalOptionId: "30003",
  timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
});
const job = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001", leaseToken: "lease", purpose: "RESERVATION_WINDOW", action: "OBSERVE",
  leaseExpiresAtUtc: new Date(fixedNow + 120_000).toISOString(), deadlineAtUtc: new Date(fixedNow + 180_000).toISOString(), target,
});
const cycle = Object.freeze({
  readId: "00000000-0000-4000-8000-000000000002", receiptId: "00000000-0000-4000-8000-000000000003", generation: 3,
  manifest: [{ occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z" }],
  coverageFromUtc: "2098-12-28T15:00:00.000Z", coverageToUtc: "2099-02-28T15:00:00.000Z",
});
const coverage = { coverageFromUtc: cycle.coverageFromUtc, coverageToUtc: cycle.coverageToUtc };
const uuidFor = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

const booking = (id, overrides = {}) => ({
  id, status: "ACTIVE", guideStatus: "CONFIRMED", isPending: false, totalNumberOfParticipants: 2,
  tourStart: "2099-01-01T10:00:00+09:00",
  activityOption: { id: 30003, activity: { id: 20002 }, duration: { value: 60, unit: "MINUTES" } },
  ...overrides,
});
const otherBooking = (id) => booking(id, { activityOption: { id: 40004, activity: { id: 50005 }, duration: { value: 2, unit: "HOURS" } } });
const ok = (items, totalItems = items.length) => ({
  status: 200, bodyText: JSON.stringify({ data: { bookings: { items, pagination: { totalItems } } } }),
});
const parsedItem = (raw) => parseSearchResponse(ok([raw])).items[0];
const codeIs = (code) => (error) => error?.code === code && error.message === code;

function scripted(responses) {
  const requests = [];
  const transport = async (request) => {
    requests.push(structuredClone(request));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return typeof next === "function" ? next(request) : next;
  };
  return { requests, transport };
}

async function readAll(core, base = {}) {
  const pages = [];
  let cursor;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await core.readPage({ manifest: cycle.manifest, target, ...coverage, ...base, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    reservationExecutorInternals.readerPage(page, target, cycle);
    if (page.terminal) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("reader did not terminate");
}

test("the fixed reservation query is a named read-only query selecting only scheduling fields", () => {
  assert.equal(isNamedReadOnlyQuery(RESERVATION_QUERY, RESERVATION_OPERATION_NAME), true);
  assert.equal(RESERVATION_OPERATION_NAME, "NihoReservationWindowRead");
  const selection = RESERVATION_QUERY.slice(RESERVATION_QUERY.indexOf("{ items"));
  assert.deepEqual(new Set(selection.match(/[_A-Za-z][_0-9A-Za-z]*/g)), new Set([
    "items", "id", "status", "guideStatus", "isPending", "totalNumberOfParticipants", "tourStart",
    "activityOption", "activity", "duration", "value", "unit", "pagination", "totalItems",
  ]));
  assert.doesNotMatch(RESERVATION_QUERY, /bookingReference|customer|traveler|email|phone|price|amount|ticket|location|address|mutation|subscription/i);
});

test("search request is the exact observed input with a 24h margin on both coverage edges", () => {
  const request = buildSearchRequest({
    supplierId: "10001", coverageFromUtc: "2099-01-01T00:00:00.000Z", coverageToUtc: "2099-02-01T00:00:00.000Z", offset: 50, limit: 50,
  });
  assert.deepEqual(request, {
    operationName: "NihoReservationWindowRead",
    query: RESERVATION_QUERY,
    variables: { input: {
      limit: 50, offset: 50,
      sorts: [{ column: "creationTimestamp", direction: "DESC" }],
      filters: [
        { column: "supplierId", operation: "EQUALS", value: "10001" },
        { column: "tourStartDatetime", operation: "GREATER_THAN_OR_EQUAL_TO", value: "2098-12-31T00:00:00.000Z" },
        { column: "tourStartDatetime", operation: "LESS_THAN", value: "2099-02-02T00:00:00.000Z" },
      ],
    } },
  });
  assert.ok(Object.isFrozen(request.variables.input.filters[0]));
  const valid = { supplierId: "10001", coverageFromUtc: "2099-01-01T00:00:00.000Z", coverageToUtc: "2099-02-01T00:00:00.000Z", offset: 0 };
  for (const patch of [{ offset: -1 }, { offset: 1.5 }, { limit: 100 }, { supplierId: "supplier" }, { supplierId: 10001 },
    { coverageFromUtc: "2099-01-01T00:00:00Z" }, { coverageToUtc: "2099-01-01T00:00:00.000Z" }]) {
    assert.throws(() => buildSearchRequest({ ...valid, ...patch }), codeIs("INVALID_READER"));
  }
});

test("HTTP and GraphQL failures map to fixed codes without leaking bodies", () => {
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "AUTH_REQUIRED"], [429, "UPSTREAM_UNAVAILABLE"],
    [500, "UPSTREAM_UNAVAILABLE"], [503, "UPSTREAM_UNAVAILABLE"], [599, "UPSTREAM_UNAVAILABLE"],
    [302, "HTTP_ERROR"], [400, "HTTP_ERROR"], [404, "HTTP_ERROR"]]) {
    assert.throws(() => parseSearchResponse({ status, bodyText: "synthetic-private-body" }), codeIs(code));
  }
  const graphqlError = (extensions) => ({ status: 200, bodyText: JSON.stringify({
    errors: [{ message: "synthetic-secret-message", ...(extensions ? { extensions } : {}) }], data: null,
  }) });
  assert.throws(() => parseSearchResponse(graphqlError({ code: "UNAUTHENTICATED" })), codeIs("AUTH_REQUIRED"));
  assert.throws(() => parseSearchResponse(graphqlError({ code: "FORBIDDEN" })), codeIs("AUTH_REQUIRED"));
  for (const extensions of [undefined, { code: "INTERNAL_SERVER_ERROR" }]) {
    assert.throws(() => parseSearchResponse(graphqlError(extensions)), (error) => error.code === "INVALID_RESPONSE"
      && !String(error.message).includes("synthetic-secret") && !String(error.stack).includes("synthetic-secret"));
  }
  assert.throws(() => parseSearchResponse({ status: 200, bodyText: "{not-json" }), codeIs("INVALID_RESPONSE"));
  assert.throws(() => parseSearchResponse({ status: 200, bodyText: JSON.stringify({ data: {}, errors: "x" }) }), codeIs("INVALID_RESPONSE"));
  assert.throws(() => parseSearchResponse({ status: 200 }), codeIs("INVALID_RESPONSE"));
  assert.throws(() => parseSearchResponse({ status: "200", bodyText: "{}" }), codeIs("INVALID_RESPONSE"));
  assert.equal(parseSearchResponse({ status: 200, bodyText: JSON.stringify({ errors: [],
    data: { bookings: { items: [], pagination: { totalItems: 0 } } } }) }).totalItems, 0);
});

test("oversized bodies are refused by byte length before parsing", () => {
  assert.throws(() => parseSearchResponse({ status: 200, bodyText: " ".repeat(MAX_RESERVATION_RESPONSE_BYTES + 1) }), codeIs("PAGE_TOO_LARGE"));
  assert.throws(() => parseSearchResponse({ status: 200, bodyText: "é".repeat(MAX_RESERVATION_RESPONSE_BYTES / 2 + 1) }), codeIs("PAGE_TOO_LARGE"));
  const padded = ok([booking(1)]);
  assert.equal(parseSearchResponse({ status: 200, bodyText: padded.bodyText.padEnd(MAX_RESERVATION_RESPONSE_BYTES, " ") }).items.length, 1);
});

test("response shape is exact at every level and items never exceed the page size", () => {
  const shape = (mutate) => {
    const value = { data: { bookings: { items: [booking(1)], pagination: { totalItems: 1 } } } };
    mutate(value);
    return { status: 200, bodyText: JSON.stringify(value) };
  };
  assert.throws(() => parseSearchResponse(shape((value) => { value.extra = true; })), codeIs("INVALID_RESPONSE"));
  for (const mutate of [
    (value) => { value.data = null; },
    (value) => { value.data.other = {}; },
    (value) => { value.data.bookings.cursor = "c"; },
    (value) => { value.data.bookings.pagination.page = 1; },
    (value) => { value.data.bookings.pagination.totalItems = -1; },
    (value) => { value.data.bookings.pagination.totalItems = 100_001; },
    (value) => { value.data.bookings.pagination.totalItems = "1"; },
    (value) => { value.data.bookings.items = {}; },
    (value) => { value.data.bookings.items[0].bookingReference = "GYG-SYNTHETIC"; },
    (value) => { value.data.bookings.items[0].customer = { name: "synthetic" }; },
    (value) => { delete value.data.bookings.items[0].isPending; },
    (value) => { value.data.bookings.items[0].activityOption.title = "synthetic"; },
    (value) => { value.data.bookings.items[0].activityOption.activity.name = "synthetic"; },
    (value) => { value.data.bookings.items[0].activityOption.duration.text = "1h"; },
    (value) => { value.data.bookings.items[0].activityOption = null; },
    (value) => { value.data.bookings.items[0].id = ""; },
    (value) => { value.data.bookings.items[0].id = "has space"; },
    (value) => { value.data.bookings.items[0].id = 1.5; },
    (value) => { value.data.bookings.items[0].id = "x".repeat(129); },
    (value) => { value.data.bookings.items[0].activityOption.id = { id: 1 }; },
    (value) => { value.data.bookings.items = Array.from({ length: 51 }, (_, index) => booking(index + 1)); },
  ]) {
    assert.throws(() => parseSearchResponse(shape(mutate)), codeIs("INVALID_READER_RESPONSE"));
  }
  const parsed = parseSearchResponse(ok([booking(7), booking("B-8_x")], 9));
  assert.equal(parsed.totalItems, 9);
  assert.deepEqual(parsed.items.map((item) => [item.id, item.productId, item.optionId]), [["7", "20002", "30003"], ["B-8_x", "20002", "30003"]]);
  assert.equal(parseSearchResponse(ok(Array.from({ length: 50 }, (_, index) => booking(index + 1)))).items.length, 50);
});

test("GYG status combinations map to held, confirmed or explicitly cancelled seats", () => {
  for (const guideStatus of ["CONFIRMED", "UNCONFIRMED", "CANCELED"]) {
    for (const isPending of [false, true]) {
      assert.equal(bookingStatus({ status: "CANCELED", guideStatus, isPending }), "CANCELLED");
      const expected = guideStatus === "CONFIRMED" && !isPending ? "CONFIRMED" : "PENDING";
      assert.equal(bookingStatus({ status: "ACTIVE", guideStatus, isPending }), expected);
    }
  }
  for (const patch of [{ status: "PENDING" }, { status: "active" }, { status: "CANCELLED" }, { guideStatus: "REJECTED" },
    { guideStatus: null }, { isPending: "false" }, { isPending: 0 }]) {
    assert.throws(() => bookingStatus({ status: "ACTIVE", guideStatus: "CONFIRMED", isPending: false, ...patch }), codeIs("INVALID_READER_RESPONSE"));
  }
});

test("tour start requires an explicit offset and is normalized to canonical UTC", () => {
  for (const [input, expected] of [
    ["2026-12-12T18:30:00+09:00", "2026-12-12T09:30:00.000Z"],
    ["2026-12-12T09:30:00Z", "2026-12-12T09:30:00.000Z"],
    ["2026-12-12T09:30:00.5Z", "2026-12-12T09:30:00.500Z"],
    ["2026-12-12T18:30:00.123+09:00", "2026-12-12T09:30:00.123Z"],
    ["2026-12-12T18:30+09:00", "2026-12-12T09:30:00.000Z"],
    ["2026-12-12T04:30:00-05:00", "2026-12-12T09:30:00.000Z"],
    ["2027-01-01T08:00:00+09:00", "2026-12-31T23:00:00.000Z"],
    ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"],
  ]) {
    assert.equal(parseTourStart(input), expected);
  }
  for (const input of ["2026-12-12T18:30:00", "2026-12-12", "2026-12-12 18:30:00Z", "2026-12-12T18:30:00z",
    "2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-12-12T24:00:00Z", "2026-12-12T18:30:00.1234Z",
    "2026-12-12T18:30:00+0900", 1_797_000_000_000, "1797000000", null]) {
    assert.throws(() => parseTourStart(input), codeIs("INVALID_READER_RESPONSE"));
  }
});

test("duration is a positive whole number of minutes no longer than a day", () => {
  for (const [value, unit, minutes] of [[60, "MINUTE"], [90, "MINUTES", 90], [1.5, "HOUR", 90], [2, "HOURS", 120],
    [0.1, "hours", 6], [1, "DAY", 1_440], [1, "days", 1_440], [24, "HOURS", 1_440]].map(([v, u, m = v]) => [v, u, m])) {
    assert.equal(durationMinutes({ value, unit }), minutes);
  }
  for (const duration of [{ value: 25, unit: "HOURS" }, { value: 1.5, unit: "DAYS" }, { value: 0, unit: "MINUTES" },
    { value: -30, unit: "MINUTES" }, { value: 0.5, unit: "MINUTE" }, { value: 1, unit: "WEEK" }, { value: 1, unit: "SECONDS" },
    { value: "60", unit: "MINUTES" }, { value: Number.NaN, unit: "MINUTES" }, { value: Number.POSITIVE_INFINITY, unit: "HOURS" },
    { value: 60, unit: null }, null]) {
    assert.throws(() => durationMinutes(duration), codeIs("INVALID_READER_RESPONSE"));
  }
});

test("only target-option bookings in coverage become facts and a misplaced target option is refused", () => {
  const context = { target, ...coverage };
  assert.deepEqual(bookingFact(parsedItem(booking(11, { totalNumberOfParticipants: 3,
    activityOption: { id: "30003", activity: { id: "20002" }, duration: { value: 1.5, unit: "HOURS" } } })), context), {
    externalReservationId: "11", externalProductId: "20002", externalOptionId: "30003",
    sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:30:00.000Z", status: "CONFIRMED", seats: 3,
  });
  assert.equal(bookingFact(parsedItem(otherBooking(12)), context), null);
  // A sibling option of the same activity is another listing's booking.
  assert.equal(bookingFact(parsedItem(booking(12, {
    activityOption: { id: 99999, activity: { id: 20002 }, duration: { value: 60, unit: "MINUTES" } } })), context), null);
  assert.throws(() => bookingFact(parsedItem(booking(13, {
    activityOption: { id: 30003, activity: { id: 99999 }, duration: { value: 60, unit: "MINUTES" } } })), context),
  codeIs("INVALID_READER_RESPONSE"));
  for (const seats of [0, 1_001, 1.5, "2", null]) {
    assert.throws(() => bookingFact(parsedItem(booking(14, { totalNumberOfParticipants: seats })), context), codeIs("INVALID_READER_RESPONSE"));
  }
  assert.equal(bookingFact(parsedItem(booking(15, { totalNumberOfParticipants: 1_000 })), context).seats, 1_000);
  // Edges: the 24h search margin can return starts just outside coverage.
  assert.equal(bookingFact(parsedItem(booking(16, { tourStart: "2098-12-28T14:59:59.999Z" })), context), null);
  assert.equal(bookingFact(parsedItem(booking(17, { tourStart: "2099-02-28T15:00:00Z" })), context), null);
  assert.equal(bookingFact(parsedItem(booking(18, { tourStart: "2098-12-29T00:00:00+09:00" })), context).sourceStartAtUtc, cycle.coverageFromUtc);
  // Target items are validated strictly even when they fall outside coverage.
  assert.throws(() => bookingFact(parsedItem(booking(19, { tourStart: "2098-12-27T00:00:00", status: "ACTIVE" })), context),
    codeIs("INVALID_READER_RESPONSE"));
  assert.equal(bookingFact(parsedItem(booking(20, { status: "CANCELED", guideStatus: "CANCELED" })), context).status, "CANCELLED");
});

test("a single page with mixed products completes and counts every booking", async () => {
  const { requests, transport } = scripted([ok([booking(1), otherBooking(2), booking(3, { isPending: true })])]);
  const pages = await readAll(createGygReservationReaderCore({ target, transport }));
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].terminal, { status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true });
  assert.deepEqual(pages[0].facts.map((fact) => [fact.externalReservationId, fact.status]), [["1", "CONFIRMED"], ["3", "PENDING"]]);
  assert.equal(pages[0].snapshotToken, undefined);
  assert.ok(pages[0].facts.every((fact) => fact.sourceUpdatedAtUtc === undefined && fact.sourceRevision === undefined));
  assert.equal(requests[0].variables.input.offset, 0);
  assert.equal(requests[0].variables.input.filters[0].value, "10001");
});

test("multiple full pages and a server-side cap continue until the fixed total", async () => {
  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const full = scripted([ok(ids(1, 50), 120), ok(ids(51, 50), 120), ok(ids(101, 20), 120)]);
  const fullPages = await readAll(createGygReservationReaderCore({ target, transport: full.transport }));
  assert.deepEqual(fullPages.map((page) => page.nextCursor ?? page.terminal.status), ["o50", "o100", "COMPLETE"]);
  assert.deepEqual(full.requests.map((request) => request.variables.input.offset), [0, 50, 100]);
  assert.equal(fullPages.flatMap((page) => page.facts).length, 120);

  const capped = scripted([ok(ids(1, 20), 45), ok(ids(21, 20), 45), ok(ids(41, 5), 45)]);
  const cappedPages = await readAll(createGygReservationReaderCore({ target, transport: capped.transport }));
  assert.deepEqual(capped.requests.map((request) => request.variables.input.offset), [0, 20, 40]);
  assert.equal(cappedPages.at(-1).terminal.status, "COMPLETE");

  const empty = scripted([ok([], 0)]);
  const emptyPages = await readAll(createGygReservationReaderCore({ target, transport: empty.transport }));
  assert.deepEqual(emptyPages, [{ facts: [], terminal: { status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true } }]);
});

test("mid-read drift ends PARTIAL without sending the inconsistent page", async () => {
  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const partial = { status: "PARTIAL", allPagesRead: false, allStatusesIncluded: true, coverageComplete: false };
  for (const [name, second] of [
    ["total changed", ok(ids(51, 10), 61)],
    ["duplicate id", ok([...ids(51, 9), booking(3)], 60)],
    ["duplicate inside page", ok([...ids(51, 9), booking(51)], 60)],
    ["premature empty page", ok([], 60)],
    ["overrun", ok(ids(51, 11), 60)],
  ]) {
    const { transport } = scripted([ok(ids(1, 50), 60), second]);
    const pages = await readAll(createGygReservationReaderCore({ target, transport }));
    assert.equal(pages.length, 2, name);
    assert.equal(pages[0].facts.length, 50, name);
    assert.deepEqual(pages[1], { facts: [], terminal: partial }, name);
  }
  const { transport } = scripted([ok(ids(1, 3), 2)]);
  assert.deepEqual((await readAll(createGygReservationReaderCore({ target, transport })))[0].terminal, partial);
});

test("totals over the bounded read size and cursor or target drift are refused", async () => {
  await assert.rejects(createGygReservationReaderCore({ target, transport: scripted([ok([], 4_001)]).transport })
    .readPage({ manifest: [], target, ...coverage }), codeIs("PAGE_LIMIT"));

  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const input = { manifest: [], target, ...coverage };
  const core = createGygReservationReaderCore({ target, transport: scripted([ok(ids(1, 50), 60), ok(ids(51, 10), 60)]).transport });
  await assert.rejects(core.readPage({ ...input, cursor: "o0" }), codeIs("INVALID_READER"));
  const first = await core.readPage(input);
  assert.equal(first.nextCursor, "o50");
  for (const patch of [{ cursor: "o49" }, { cursor: "50" }, { cursor: "o050" }, { cursor: 50 },
    { cursor: "o50", coverageToUtc: "2099-02-27T15:00:00.000Z" }, { cursor: "o50", target: { ...target, externalOptionId: "30004" } },
    { cursor: "o50", target: { ...target, extra: true } }]) {
    await assert.rejects(core.readPage({ ...input, ...patch }), codeIs("INVALID_READER"));
  }
  const last = await core.readPage({ ...input, cursor: "o50" });
  assert.equal(last.terminal.status, "COMPLETE");
  await assert.rejects(core.readPage({ ...input, cursor: "o60" }), codeIs("INVALID_READER"));
  await assert.rejects(core.readPage({ ...input, coverageFromUtc: "2098-12-28T15:00:00Z" }), codeIs("INVALID_READER"));
  assert.equal(await core.stop(), true);
  await assert.rejects(core.readPage(input), codeIs("READER_STOPPED"));
  assert.throws(() => createGygReservationReaderCore({ target: { ...target, site: "Viator" }, transport: async () => ({}) }), codeIs("INVALID_READER"));
  const { externalOptionId, ...withoutOption } = target;
  assert.throws(() => createGygReservationReaderCore({ target: withoutOption, transport: async () => ({}) }), codeIs("INVALID_READER"));
  assert.throws(() => createGygReservationReaderCore({ target }), codeIs("INVALID_READER"));
});

test("a total of exactly 4000 is accepted as a bounded read", async () => {
  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const responses = Array.from({ length: 80 }, (_, page) => ok(ids(page * 50 + 1, 50), 4_000));
  const pages = await readAll(createGygReservationReaderCore({ target, transport: scripted(responses).transport }));
  assert.equal(pages.length, 80);
  assert.equal(pages.at(-1).terminal.status, "COMPLETE");
});

const journal = () => ({ pending: [], async pendingReservationPage(page) { this.pending.push(page); }, async reservationPageAcknowledged() {} });
const pageReceipt = (payload) => {
  const terminalStatus = payload.terminal?.status;
  return {
    receiptId: payload.receiptId, readId: payload.readId, generation: cycle.generation, pageNumber: payload.pageNumber,
    applied: payload.observations.length, duplicates: 0, duplicateFacts: 0, stale: 0, needsReview: 0,
    missingActiveReservations: 0, healthUpdated: terminalStatus === "COMPLETE", repeated: false,
    ...(terminalStatus ? { terminalStatus } : { nextReceiptId: uuidFor(payload.pageNumber + 100) }),
  };
};
const cloudFor = (submitted = []) => {
  const calls = { begin: 0 };
  return {
    calls,
    async beginReservationWindow() { calls.begin += 1; return cycle; },
    async renew() { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
    async submitReservationWindowPage(_jobId, payload) { submitted.push(payload); return pageReceipt(payload); },
  };
};
const coreFactory = (responses) => async ({ target: fixedTarget }) => createGygReservationReaderCore({
  target: fixedTarget, transport: scripted(responses).transport,
});

test("executor verifies a complete GYG window read through the core reader", async () => {
  const submitted = [];
  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const result = await executeReservationWindow({ job, cloud: cloudFor(submitted), config: {}, journal: journal(), now: () => fixedNow,
    readerFactory: coreFactory([ok([...ids(1, 49), otherBooking(50)], 53), ok([...ids(51, 2), booking(53, { status: "CANCELED" })], 53)]),
  });
  assert.equal(result.outcome, "RESERVATION_VERIFIED");
  assert.equal(result.modelInvocations, 0);
  assert.equal(result.stopped, true);
  assert.equal(result.reservationReadId, cycle.readId);
  const observations = submitted.flatMap((payload) => payload.observations);
  assert.equal(observations.length, 52);
  assert.equal(observations.at(-1).status, "CANCELLED");
  assert.equal(submitted.at(-1).terminal.status, "COMPLETE");
  assert.ok(submitted.every((payload) => payload.snapshotToken === undefined));
});

test("executor turns PARTIAL into retry and GYG auth loss into a halt", async () => {
  const ids = (from, count) => Array.from({ length: count }, (_, index) => booking(from + index));
  const partial = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
    readerFactory: coreFactory([ok(ids(1, 50), 60), ok(ids(51, 10), 61)]),
  });
  assert.equal(partial.outcome, "RETRY_WAIT");
  assert.equal(partial.halt, false);
  assert.equal(partial.reservationReadId, undefined);
  assert.equal(partial.modelInvocations, 0);

  for (const response of [{ status: 401, bodyText: "" }, { status: 200, bodyText: JSON.stringify({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }) }]) {
    const privateJournal = journal();
    const auth = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: privateJournal, now: () => fixedNow,
      readerFactory: coreFactory([response]),
    });
    assert.equal(auth.outcome, "AUTH_REQUIRED");
    assert.equal(auth.halt, true);
    assert.equal(auth.reason, "AUTH_REQUIRED");
    assert.equal(auth.modelInvocations, 0);
    assert.equal(privateJournal.pending.length, 0);
  }

  const upstream = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
    readerFactory: coreFactory([{ status: 503, bodyText: "" }]),
  });
  assert.equal(upstream.outcome, "RETRY_WAIT");
  assert.equal(upstream.halt, false);

  const drift = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
    readerFactory: coreFactory([ok([booking(1, { activityOption: { id: 30003, activity: { id: 99999 }, duration: { value: 60, unit: "MINUTES" } } })])]),
  });
  assert.equal(drift.outcome, "NEEDS_REVIEW");
  assert.equal(drift.reason, "INVALID_READER_RESPONSE");

  // Session checks run inside readPage; a wrong supplier or drifted page halts
  // for review instead of retrying silently every backoff.
  for (const code of ["ACCOUNT_MISMATCH", "DOM_DRIFT"]) {
    const halted = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
      readerFactory: async () => ({ async readPage() { throw new ContractError(code); }, async stop() { return true; } }),
    });
    assert.equal(halted.outcome, "NEEDS_REVIEW");
    assert.equal(halted.halt, true);
    assert.equal(halted.reason, code);
    assert.equal(halted.stopped, true);
  }
});

test("registry is off by default and returns the exact unsupported sentinel", async () => {
  const key = "GetYourGuide/gyg-browser@1";
  assert.deepEqual(RESERVATION_READER_KEYS, [key]);
  const viatorJob = { ...job, target: { ...target, site: "Viator", adapter: "viator-browser", externalProductId: "1P1", externalOptionId: "TG1" } };
  for (const [candidate, config] of [[job, {}], [job, { reservationReaders: [] }], [job, { reservationReaders: "GetYourGuide/gyg-browser@1" }],
    [viatorJob, { reservationReaders: [key] }]]) {
    assert.equal(selectReservationReaderFactory({ job: candidate, config }), unsupportedReservationReaderFactory);
  }
  const enabled = selectReservationReaderFactory({ job, config: { reservationReaders: [key] } });
  assert.equal(enabled, RESERVATION_READER_FACTORIES[key]);
  assert.notEqual(enabled, unsupportedReservationReaderFactory);
  // The enabled factory is the GYG browser reader: it fails closed on a missing
  // profile mapping before any browser process is started.
  await assert.rejects(enabled({ target, config: { accountProfiles: {}, browserExecutable: "/nonexistent" } }), codeIs("PROFILE_MAPPING_MISSING"));

  const cloud = cloudFor();
  const result = await executeJob({ job, cloud, config: { mode: "deterministic" }, journal: journal(), now: () => fixedNow,
    driverFactory: async () => { throw new Error("availability driver must not run"); },
  });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "UNSUPPORTED_READER");
  assert.equal(result.stopped, true);
  assert.equal(cloud.calls.begin, 0);

  const injected = await executeJob({ job, cloud: cloudFor(), config: { mode: "deterministic" }, journal: journal(), now: () => fixedNow,
    reservationReaderFactory: coreFactory([ok([booking(1)])]),
  });
  assert.equal(injected.outcome, "RESERVATION_VERIFIED");
});

test("browser reader factory rejects unsupported targets before starting a browser", async () => {
  let started = 0;
  const browserFactory = async () => { started += 1; throw new Error("must not start"); };
  for (const candidate of [{ ...target, site: "Viator" }, { ...target, adapterVersion: "2" }, { ...target, externalOptionId: undefined }]) {
    await assert.rejects(createGygReservationReader({ target: candidate, config: { accountProfiles: { 10001: "/synthetic" } }, browserFactory }),
      codeIs("INVALID_READER"));
  }
  await assert.rejects(createGygReservationReader({ target, config: { accountProfiles: { 10001: "/synthetic" } }, browserFactory,
    testOnlySupplierOrigin: "http://127.0.0.1:1234" }), codeIs("INVALID_DRIVER_ORIGIN"));
  assert.equal(started, 0);
});

const origin = "http://127.0.0.1:1234";
const routeFor = ({ url, method = "GET", navigation = false, type = navigation ? "document" : "fetch", body, headers = {} }, calls) => ({
  request: () => ({
    url: () => url, method: () => method, isNavigationRequest: () => navigation, resourceType: () => type, headers: () => headers,
    postDataJSON: () => { if (body === undefined) throw new Error("no body"); return body; },
    postData: () => (body === undefined ? null : JSON.stringify(body)),
  }),
  continue: async () => { calls.push("continue"); },
  abort: async () => { calls.push("abort"); },
});

test("read-only guard allows only fixed navigations, static GETs and named read queries", async () => {
  const guard = createGygReadOnlyGuard({ supplierOrigin: origin, cdnOrigin: origin });
  const calls = [];
  const handle = (request) => guard.handle(routeFor(request, calls));
  await handle({ url: `${origin}/company-profile/company-details`, navigation: true });
  await handle({ url: `${origin}/bookings`, navigation: true });
  await handle({ url: `${origin}/app.js`, type: "script" });
  assert.deepEqual(calls.splice(0), ["continue", "continue", "continue"]);
  assert.equal(guard.externalNavigationBlocked, false);
  await handle({ url: `${origin}/api/private.json`, type: "fetch" });
  assert.deepEqual(calls.splice(0), ["abort"]);
  assert.equal(guard.externalNavigationBlocked, false);
  for (const url of [`${origin}/bookings?status=ACTIVE`, `${origin}/bookings/123`, `${origin}/manage/availability`, "https://example.test/login"]) {
    const local = createGygReadOnlyGuard({ supplierOrigin: origin, cdnOrigin: origin });
    const localCalls = [];
    await local.handle(routeFor({ url, navigation: true }, localCalls));
    assert.deepEqual(localCalls, ["abort"], url);
    assert.equal(local.externalNavigationBlocked, true, url);
  }
  const refresh = createGygReadOnlyGuard();
  const refreshCalls = [];
  await refresh.handle({
    request: () => ({ url: () => "https://securetoken.googleapis.com/v1/token?key=synthetic_public_api_key_12345", method: () => "POST",
      resourceType: () => "fetch", isNavigationRequest: () => false, headers: () => ({ "content-type": "application/x-www-form-urlencoded" }),
      postData: () => "grant_type=refresh_token&refresh_token=synthetic-private-token" }),
    continue: async () => { refreshCalls.push("continue"); }, abort: async () => { refreshCalls.push("abort"); },
  });
  assert.deepEqual(refreshCalls, ["continue"]);
});

test("read-only guard aborts every write and keeps only app session headers in memory", async () => {
  const guard = createGygReadOnlyGuard({ supplierOrigin: origin, cdnOrigin: origin });
  const calls = [];
  const post = (body, extra = {}) => guard.handle(routeFor({ url: `${origin}/graphql`, method: "POST", body, ...extra }, calls));
  const waiting = guard.waitForAppRead(0, 5_000);
  await post({ operationName: "SyntheticMarkSeen", query: "mutation SyntheticMarkSeen { markSeen { ok } }", variables: {} });
  await post({ operationName: "Inbox_UnreadCountChanged", query: "subscription Inbox_UnreadCountChanged { inbox { unread } }", variables: {} });
  await post({ operationName: "Anonymous", query: "{ viewer { id } }" });
  await post([{ operationName: "Batch", query: "query Batch { viewer { id } }" }]);
  await guard.handle(routeFor({ url: `${origin}/track`, method: "POST", body: {} }, calls));
  await guard.handle(routeFor({ url: `${origin}/graphql`, method: "PUT", body: {} }, calls));
  await guard.handle(routeFor({ url: "https://analytics.example.test/collect", method: "POST", body: {} }, calls));
  assert.deepEqual(calls.splice(0), Array(7).fill("abort"));
  assert.equal(guard.refusedWrites, 7);
  assert.equal(guard.appReads, 0);
  assert.deepEqual(guard.sessionHeaders(), {});

  await post({ operationName: "SupplierBookings", query: "query SupplierBookings { bookings { id } }", variables: {} }, {
    headers: {
      authorization: "Bearer synthetic-session-token", "x-gyg-client": "supplier-portal", cookie: "synthetic=cookie",
      "content-type": "application/json", "x-bad": "line\nbreak", referer: `${origin}/bookings`,
    },
  });
  assert.deepEqual(calls.splice(0), ["continue"]);
  assert.equal(await waiting, true);
  assert.equal(guard.appReads, 1);
  assert.deepEqual(guard.sessionHeaders(), { authorization: "Bearer synthetic-session-token", "x-gyg-client": "supplier-portal" });

  await post({ operationName: RESERVATION_OPERATION_NAME, query: RESERVATION_QUERY, variables: {} }, { headers: { authorization: "Bearer other" } });
  await post({ operationName: RESERVATION_OPERATION_NAME, query: `${RESERVATION_QUERY} `, variables: {} });
  assert.deepEqual(calls.splice(0), ["continue", "abort"]);
  assert.equal(guard.appReads, 1);
  assert.equal(guard.sessionHeaders().authorization, "Bearer synthetic-session-token");

  assert.equal(await guard.waitForAppRead(1, 5), false);
  const pending = guard.waitForAppRead(1, 5_000);
  guard.freeze();
  assert.equal(await pending, false);
  await post({ operationName: "SupplierBookings", query: "query SupplierBookings { bookings { id } }" });
  await guard.handle(routeFor({ url: `${origin}/bookings`, navigation: true }, calls));
  assert.deepEqual(calls, ["abort", "abort"]);
});
