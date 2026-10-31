import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJournal } from "../src/journal.mjs";
import { createNetworkGuard, isSingleRootMutation, rewriteScheduleStepBody } from "../src/network-guard.mjs";
import {
  SCHEDULE_STEP_OPERATION,
  normalizeScheduleRead,
  planEnsureOccurrence,
  plannedSpecialDates,
  scheduleReadRequest,
  scheduleStepSucceeded,
  weekdayOf,
} from "../src/gyg-schedule-protocol.mjs";
import { executeJob, supervisorInternals } from "../src/supervisor.mjs";
import { ContractError, makeResult, validateClaim } from "../src/validation.mjs";
import { runWorkerOnce } from "../src/worker.mjs";
import { SYNTHETIC_STEP_MUTATION, makeJob } from "./helpers/synthetic-gyg.mjs";

const state = { accountId: "10001", productId: "20002", optionId: "30003", localDateTime: "2099-01-01T13:00:00" };
const ORIGIN = "http://127.0.0.1:1234";
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const ensureJob = () => makeJob(state, "ENSURE_OCCURRENCE");
const wire = (action, overrides = {}) => {
  const { localDateTime: _local, desiredState: _desired, ...raw } = makeJob(state, action);
  return { ...raw, ...overrides };
};
const observation = (job, patch = {}) => ({ occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
  observedAtUtc: new Date().toISOString(), manuallyBlocked: false, bookable: true, ...patch });
const slots = (times) => times.map((from) => ({ from, to: null }));

function blockJson({ id = 7001, name = "Synthetic weekday schedule", start = "2098-12-01", end = null,
  weekdays = { thursday: ["09:00"] }, specialDates = [{ date: "2099-01-05", times: ["15:00"] }] } = {}) {
  return {
    id, name, validityDateRange: { start, end },
    weekdays: WEEKDAYS.map((day) => ({ day, timeSlots: slots(weekdays[day] ?? []) })),
    specialDates: specialDates.map((entry) => ({ date: entry.date, timeSlots: slots(entry.times) })),
  };
}

function readBody({ status = "ACTIVE", timezone = "Asia/Tokyo", availabilityType = "starting_times", pricing } = {}) {
  return { data: { activityOption: { id: 30003, status, timezone, inventoryConfiguration: { availabilityType },
    availabilityAndPricing: pricing ?? [{ status: "ACTIVE", availabilityBlock: [blockJson()] }] } } };
}

const read = (options) => normalizeScheduleRead(readBody(options), ensureJob().target);

function stepBody(block = blockJson(), patch = (value) => value) {
  const input = {
    name: block.name,
    dateRange: block.validityDateRange.end === null ? { start: block.validityDateRange.start } : { ...block.validityDateRange },
    weekdays: structuredClone(block.weekdays),
    specialDates: structuredClone(block.specialDates),
  };
  return patch({ operationName: SCHEDULE_STEP_OPERATION, query: SYNTHETIC_STEP_MUTATION, variables: { scheduleId: block.id, input } });
}

const graphqlRoute = (body, calls, headers = {}) => ({
  request: () => ({ url: () => `${ORIGIN}/graphql`, method: () => "POST", postDataJSON: () => body, headers: () => headers }),
  continue: async (options) => { calls.push(options?.postData ? ["continue", JSON.parse(options.postData)] : ["continue"]); },
  abort: async () => { calls.push(["abort"]); },
});
const navigationRoute = (url, calls) => ({
  request: () => ({ url: () => url, method: () => "GET", isNavigationRequest: () => true, resourceType: () => "document" }),
  continue: async () => { calls.push("continue"); }, abort: async () => { calls.push("abort"); },
});
const okPreflight = { async preflight() { return { ready: true, desiredState: "OPEN" }; } };

test("ENSURE_OCCURRENCE claim is accepted as OPEN only on a browser OTA target", () => {
  const job = validateClaim(wire("ENSURE_OCCURRENCE"));
  assert.equal(job.action, "ENSURE_OCCURRENCE");
  assert.equal(job.desiredState, "OPEN");
  assert.equal(job.localDateTime, "2099-01-01T13:00:00");
  const google = { site: "Airbnb", externalAccountId: "1", externalProductId: "2", timeZone: "Asia/Tokyo",
    adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" };
  for (const invalid of [
    wire("ENSURE_OCCURRENCE", { purpose: "RESERVATION_WINDOW" }),
    wire("ENSURE_OCCURRENCE", { googleDeliveryOperation: "observe" }),
    wire("ENSURE_OCCURRENCE", { target: google }),
    wire("ENSURE_OCCURRENCE", { action: "CREATE_OCCURRENCE" }),
  ]) assert.throws(() => validateClaim(invalid), ContractError);
  assert.equal(validateClaim(wire("SET_OPEN", { target: google })).desiredState, "OPEN");
});

test("makeResult carries ensureCreated only on a verified ENSURE result", () => {
  const job = ensureJob();
  for (const created of [true, false]) {
    const result = makeResult({ resultId: randomUUID(), job, outcome: "VERIFIED", stopped: true, observation: observation(job), ensureCreated: created });
    assert.equal(result.ensureCreated, created);
    assert.equal(result.observedState, "OPEN");
  }
  const review = makeResult({ resultId: randomUUID(), job, outcome: "NEEDS_REVIEW", stopped: true });
  assert.equal(Object.hasOwn(review, "ensureCreated"), false);
  for (const invalid of [
    { job, outcome: "VERIFIED", observation: observation(job) },
    { job, outcome: "VERIFIED", ensureCreated: true },
    { job, outcome: "VERIFIED", observation: observation(job), ensureCreated: "yes" },
    { job, outcome: "UNKNOWN_AFTER_SAVE", ensureCreated: true },
    { job: makeJob(state, "SET_OPEN"), outcome: "VERIFIED", observation: observation(job), ensureCreated: false },
  ]) assert.throws(() => makeResult({ resultId: randomUUID(), stopped: true, ...invalid }), ContractError);
  const setOpen = makeJob(state, "SET_OPEN");
  const legacy = makeResult({ resultId: randomUUID(), job: setOpen, outcome: "VERIFIED", stopped: true, observation: observation(setOpen) });
  assert.deepEqual(Object.keys(legacy), ["resultId", "leaseToken", "outcome", "stopped", "target", "occurrenceId", "sourceStartAtUtc",
    "sourceEndAtUtc", "observedState", "observedBookable", "observedManuallyBlocked", "observedAtUtc"]);
});

test("supervisor runs ENSURE deterministically in claude-code mode and never starts Claude", async () => {
  const job = ensureJob();
  let ensures = 0;
  const driver = {
    async ensureOccurrence() { ensures += 1; return { created: true, observation: observation(job) }; },
    async applyDesiredState() { throw new Error("must not apply"); },
    async verifyAfterReload() { throw new Error("must not verify through the open/close path"); },
    async stop() { return true; },
  };
  const result = await executeJob({ job, cloud: { async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver,
    rpcFactory: async () => { throw new Error("rpc must not start"); },
    claudeExecutor: async () => { throw new Error("Claude must not start"); } });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(result.stopped, true);
  assert.equal(result.ensureCreated, true);
  assert.equal(ensures, 1);
});

test("supervisor ENSURE failures keep the stop confirmation and never carry ensureCreated", async () => {
  const job = ensureJob();
  const cases = [
    [{ async stop() { return true; } }, "UNSUPPORTED_TARGET"],
    [{ async ensureOccurrence() { throw new ContractError("OPTION_NOT_ACTIVE"); }, async stop() { return true; } }, "OPTION_NOT_ACTIVE"],
    [{ async ensureOccurrence() { return { created: true }; }, async stop() { return true; } }, "VERIFY_FAILED"],
    [{ async ensureOccurrence() { return { created: true, observation: { ...observation(job), occurrenceId: "other" } }; }, async stop() { return true; } }, "TARGET_MISMATCH"],
  ];
  for (const mode of ["deterministic", "claude-code"]) {
    for (const [driver, reason] of cases) {
      const result = await executeJob({ job, cloud: { async renew() {} }, config: { mode, privateDir: "/tmp" }, driverFactory: async () => driver,
        claudeExecutor: async () => { throw new Error("Claude must not start"); } });
      assert.equal(result.outcome, "NEEDS_REVIEW");
      assert.equal(result.reason, reason);
      assert.equal(result.halt, true);
      assert.equal(result.stopped, true);
      assert.equal(Object.hasOwn(result, "ensureCreated"), false);
    }
  }
  const unknown = await executeJob({ job, cloud: { async renew() {} }, config: { mode: "deterministic" },
    driverFactory: async () => ({ async ensureOccurrence() { throw new ContractError("UNKNOWN_AFTER_SAVE"); }, async stop() { return true; } }) });
  assert.equal(unknown.outcome, "UNKNOWN_AFTER_SAVE");
  assert.equal(unknown.halt, true);
});

test("schedule refusal codes classify as halting NEEDS_REVIEW", () => {
  for (const code of ["OPTION_NOT_ACTIVE", "UNSUPPORTED_SCHEDULE", "AMBIGUOUS_SCHEDULE", "OUTSIDE_SCHEDULE_VALIDITY", "SCHEDULE_AGENDA_MISMATCH", "SAVE_NOT_APPLIED"]) {
    assert.deepEqual(supervisorInternals.classify(new ContractError(code)), { outcome: "NEEDS_REVIEW", quarantine: true, halt: true, reason: code });
  }
});

test("worker reports zero model invocations and the ensureCreated result for ENSURE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-ensure-"));
  const job = ensureJob();
  const posted = [];
  const cloud = { async claimAllowIdle() { return job; }, async result(id, payload) { posted.push(payload); return { acceptedAsCurrent: true, repeated: false }; } };
  const summary = await runWorkerOnce({ cloud, config: { mode: "claude-code" }, journal: createJournal(directory),
    executor: async () => ({ outcome: "VERIFIED", stopped: true, observation: observation(job), quarantine: false, halt: false, reason: null, ensureCreated: false }) });
  assert.equal(summary.status, "RESULT_ACKNOWLEDGED");
  assert.equal(summary.modelInvocations, 0);
  assert.equal(posted[0].ensureCreated, false);
});

test("new special dates keep every other date and include the date's existing times", () => {
  assert.equal(weekdayOf("2099-01-01"), "thursday");
  const block = read().pricing[0].blocks[0];
  assert.deepEqual(plannedSpecialDates(block, "2099-01-01", "13:00"),
    [{ date: "2099-01-01", times: ["09:00", "13:00"] }, { date: "2099-01-05", times: ["15:00"] }]);
  assert.deepEqual(plannedSpecialDates(block, "2099-01-01", "08:30")[0].times, ["08:30", "09:00"]);
  const withSpecial = read({ pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({
    weekdays: { thursday: ["09:00", "11:00"] },
    specialDates: [{ date: "2099-01-05", times: ["15:00"] }, { date: "2099-01-01", times: ["16:00", "10:00", "10:00"] }],
  })] }] }).pricing[0].blocks[0];
  assert.deepEqual(plannedSpecialDates(withSpecial, "2099-01-01", "13:00"),
    [{ date: "2099-01-01", times: ["10:00", "13:00", "16:00"] }, { date: "2099-01-05", times: ["15:00"] }]);
  assert.deepEqual(plannedSpecialDates(withSpecial, "2099-01-01", "10:00")[0].times, ["10:00", "16:00"]);
  const saturday = plannedSpecialDates(block, "2099-01-03", "13:00");
  assert.deepEqual(saturday, [{ date: "2099-01-03", times: ["13:00"] }, { date: "2099-01-05", times: ["15:00"] }]);
});

test("schedule read normalization accepts single blocks and refuses unsupported or ambiguous schedules", () => {
  const job = ensureJob();
  const single = normalizeScheduleRead(readBody({ pricing: [{ status: "ACTIVE", availabilityBlock: blockJson() }] }), job.target);
  assert.deepEqual(single, read());
  const plan = planEnsureOccurrence(read(), job);
  assert.equal(plan.block.id, "7001");
  assert.deepEqual(plan.expectedAfter.pricing[0].blocks[0].specialDates, plan.specialDates);
  assert.deepEqual(plan.expectedAfter.pricing[0].blocks[0].weekdays, plan.block.weekdays);
  const inactive = { status: "DEACTIVATED", availabilityBlock: [blockJson({ id: 7100 }), blockJson({ id: 7101 })] };
  assert.equal(planEnsureOccurrence(read({ pricing: [inactive, { status: "ACTIVE", availabilityBlock: [blockJson()] }] }), job).block.id, "7001");
  const cases = [
    ["OPTION_NOT_ACTIVE", { status: "DEACTIVATED" }],
    ["UNSUPPORTED_SCHEDULE", { timezone: "Europe/Berlin" }],
    ["UNSUPPORTED_SCHEDULE", { availabilityType: "time_period" }],
    ["AMBIGUOUS_SCHEDULE", { pricing: [] }],
    ["AMBIGUOUS_SCHEDULE", { pricing: [{ status: "ACTIVE", availabilityBlock: [] }] }],
    ["AMBIGUOUS_SCHEDULE", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson(), blockJson({ id: 7002 })] }] }],
    ["AMBIGUOUS_SCHEDULE", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson()] }, { status: "ACTIVE", availabilityBlock: [blockJson({ id: 7002 })] }] }],
    ["OUTSIDE_SCHEDULE_VALIDITY", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({ start: "2099-01-02" })] }] }],
    ["OUTSIDE_SCHEDULE_VALIDITY", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({ end: "2098-12-31" })] }] }],
    ["SCHEDULE_AGENDA_MISMATCH", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({ weekdays: { thursday: ["13:00"] } })] }] }],
    ["SCHEDULE_AGENDA_MISMATCH", { pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({ specialDates: [{ date: "2099-01-01", times: ["13:00"] }] })] }] }],
  ];
  for (const [code, options] of cases) assert.throws(() => planEnsureOccurrence(read(options), job), (error) => error.code === code, code);
  assert.equal(planEnsureOccurrence(read({ pricing: [{ status: "ACTIVE", availabilityBlock: [blockJson({ end: "2099-01-01" })] }] }), job).date, "2099-01-01");
  const drifted = [
    [(body) => { body.data.activityOption.id = 99999; }, "TARGET_MISMATCH"],
    [(body) => { body.data.activityOption.extra = true; }, "DOM_DRIFT"],
    [(body) => { body.errors = [{ message: "denied" }]; }, "DOM_DRIFT"],
    [(body) => { body.data.activityOption.availabilityAndPricing[0].availabilityBlock[0].weekdays[3].timeSlots[0].to = "10:00"; }, "UNSUPPORTED_SCHEDULE"],
    [(body) => { body.data.activityOption.availabilityAndPricing[0].availabilityBlock[0].weekdays[3].timeSlots[0].from = "9:00"; }, "UNSUPPORTED_SCHEDULE"],
    [(body) => { body.data.activityOption.availabilityAndPricing[0].availabilityBlock[0].weekdays[3].day = "Thursday"; }, "UNSUPPORTED_SCHEDULE"],
    [(body) => { body.data.activityOption.availabilityAndPricing[0].availabilityBlock[0].specialDates.push({ date: "2099-01-05", timeSlots: [] }); }, "UNSUPPORTED_SCHEDULE"],
  ];
  for (const [mutate, code] of drifted) {
    const body = readBody(); mutate(body);
    assert.throws(() => normalizeScheduleRead(body, job.target), (error) => error.code === code, code);
  }
  assert.throws(() => scheduleReadRequest("030003"), (error) => error.code === "UNSUPPORTED_TARGET");
  const request = scheduleReadRequest("30003");
  assert.match(request.query, /^query NihoEnsureScheduleRead\(\$id: ID!\) \{ activityOption\(id: \$id\)/);
  assert.deepEqual(request.variables, { id: "30003" });
});

test("schedule step rewrite replaces only specialDates when the screen matches the read", () => {
  const plan = planEnsureOccurrence(read(), ensureJob());
  const body = stepBody();
  const rewritten = rewriteScheduleStepBody(body, plan);
  assert.deepEqual(rewritten.variables.input.specialDates, [
    { date: "2099-01-01", timeSlots: [{ from: "09:00", to: null }, { from: "13:00", to: null }] },
    { date: "2099-01-05", timeSlots: [{ from: "15:00", to: null }] },
  ]);
  assert.deepEqual({ ...rewritten.variables.input, specialDates: undefined }, { ...body.variables.input, specialDates: undefined });
  assert.equal(rewritten.query, body.query);
  assert.equal(rewritten.variables.scheduleId, 7001);
  assert.ok(rewriteScheduleStepBody(stepBody(blockJson(), (value) => { value.variables.scheduleId = "7001"; return value; }), plan));
  const mismatches = [
    (value) => { value.variables.scheduleId = 7002; },
    (value) => { value.variables.input.name = "Renamed"; },
    (value) => { value.variables.input.extra = true; },
    (value) => { value.variables.input.dateRange.start = "2098-12-02"; },
    (value) => { value.variables.input.dateRange.end = "2099-12-31"; },
    (value) => { value.variables.input.weekdays[3].timeSlots.push({ from: "18:00", to: null }); },
    (value) => { value.variables.input.weekdays.pop(); },
    (value) => { value.variables.input.weekdays[3].timeSlots[0].to = "10:00"; },
    (value) => { value.variables.input.specialDates = []; },
    (value) => { value.variables.input.specialDates[0].timeSlots = []; },
    (value) => { value.variables.extra = 1; },
    (value) => { value.extensions = {}; },
    (value) => { value.query = "mutation SupplierPortalUpdateScheduleStep { a { ok } b { ok } }"; },
    (value) => { value.query = "query SupplierPortalUpdateScheduleStep { a { ok } }"; },
    (value) => { value.query = `${SYNTHETIC_STEP_MUTATION} mutation Other { a { ok } }`; },
  ];
  for (const mutate of mismatches) {
    const value = stepBody(); mutate(value);
    assert.equal(rewriteScheduleStepBody(value, plan), null, String(mutate));
  }
  assert.equal(isSingleRootMutation(`fragment F on Result { ok } ${SYNTHETIC_STEP_MUTATION}`, SCHEDULE_STEP_OPERATION), true);
  assert.equal(isSingleRootMutation("mutation SupplierPortalUpdateScheduleStep { ...F }", SCHEDULE_STEP_OPERATION), false);
});

test("schedule step response success requires one data value with success=true and no errors", () => {
  assert.equal(scheduleStepSucceeded({ data: { updateScheduleStep: { success: true, message: null, errorDetails: [] } } }), true);
  for (const body of [
    { data: { updateScheduleStep: { success: false } } },
    { data: { updateScheduleStep: { success: true } }, errors: [{ message: "x" }] },
    { data: { a: { success: true }, b: { success: true } } },
    { data: null }, null,
  ]) assert.equal(scheduleStepSucceeded(body), false);
});

test("ENSURE guard forwards one matching schedule step with rewritten specialDates under a permit", async () => {
  const job = ensureJob();
  const plan = planEnsureOccurrence(read(), job);
  let preflights = 0;
  const guard = createNetworkGuard({ job, cloud: { async preflight() { preflights += 1; return { ready: true, desiredState: "OPEN" }; } },
    supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  const calls = [];
  guard.beginScheduleWrite(plan);
  await guard.handle(graphqlRoute(stepBody(), calls));
  assert.equal(calls[0][0], "continue");
  assert.deepEqual(calls[0][1].variables.input.specialDates.map((entry) => entry.date), ["2099-01-01", "2099-01-05"]);
  await guard.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls[1], ["abort"]);
  assert.throws(() => guard.endScheduleWrite(), (error) => error.code === "WRITE_REFUSED");
  assert.equal(guard.writes, 1);
  assert.equal(preflights, 1);
  guard.beginScheduleWrite(plan);
  await guard.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls[2], ["abort"]);
  assert.throws(() => guard.endScheduleWrite(), (error) => error.code === "WRITE_REFUSED");
});

test("ENSURE guard refuses a schedule step outside the permit, on mismatch, or on stale interception preflight", async () => {
  const job = ensureJob();
  const plan = planEnsureOccurrence(read(), job);
  const outside = createNetworkGuard({ job, cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  const calls = [];
  await outside.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls, [["abort"]]);
  assert.equal(outside.fatalWrite.code, "WRITE_REFUSED");
  assert.equal(outside.writes, 0);

  const mismatch = createNetworkGuard({ job, cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  mismatch.beginScheduleWrite(plan);
  await mismatch.handle(graphqlRoute(stepBody(blockJson({ weekdays: { thursday: ["09:00"], friday: ["18:00"] } })), calls));
  assert.deepEqual(calls.at(-1), ["abort"]);
  assert.throws(() => mismatch.endScheduleWrite(), (error) => error.code === "WRITE_REFUSED");
  assert.equal(mismatch.writes, 0);

  const stale = createNetworkGuard({ job, cloud: { async preflight() { return { ready: true, desiredState: "CLOSED" }; } }, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  stale.beginScheduleWrite(plan);
  await stale.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls.at(-1), ["abort"]);
  assert.throws(() => stale.endScheduleWrite(), (error) => error.code === "STALE_PREFLIGHT");
  assert.equal(stale.writes, 0);

  let release;
  const frozen = createNetworkGuard({ job, cloud: { preflight: () => new Promise((resolve) => { release = resolve; }) }, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  frozen.beginScheduleWrite(plan);
  const pending = frozen.handle(graphqlRoute(stepBody(), calls));
  frozen.freeze();
  release({ ready: true, desiredState: "OPEN" });
  await pending;
  assert.deepEqual(calls.at(-1), ["abort"]);
  assert.equal(frozen.writes, 0);
});

test("non-ENSURE jobs keep refusing the schedule step and ENSURE never opens the open/close permit", async () => {
  const setJob = makeJob(state, "SET_CLOSED");
  const guard = createNetworkGuard({ job: setJob, cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  const calls = [];
  await guard.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls, [["abort"]]);
  assert.equal(guard.fatalWrite, null);
  assert.throws(() => guard.beginScheduleWrite(planEnsureOccurrence(read(), ensureJob())), (error) => error.code === "WRITE_REFUSED");
  guard.beginUiAction();
  await guard.handle(graphqlRoute(stepBody(), calls));
  assert.deepEqual(calls.at(-1), ["abort"]);
  assert.throws(() => guard.endUiAction(), (error) => error.code === "WRITE_REFUSED");

  const ensure = createNetworkGuard({ job: ensureJob(), cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  assert.throws(() => ensure.beginUiAction(), (error) => error.code === "WRITE_REFUSED");
});

test("ENSURE guard allows only its own product page navigation and the exact schedule read, and captures app session headers", async () => {
  const calls = [];
  const ensure = createNetworkGuard({ job: ensureJob(), cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  for (const path of ["/products/details?tour_id=20002", "/products/details?tour_id=20002&optionId=30003",
    "/products/details?tour_id=99999", "/products/details?tour_id=20002&optionId=99999", "/products/details?tour_id=20002&tab=pricing",
    "/products/details?tour_id=20002&tour_id=20002"]) {
    await ensure.handle(navigationRoute(`${ORIGIN}${path}`, calls));
  }
  assert.deepEqual(calls, ["continue", "continue", "abort", "abort", "abort", "abort"]);
  const setGuard = createNetworkGuard({ job: makeJob(state, "SET_OPEN"), cloud: okPreflight, supplierOrigin: ORIGIN, cdnOrigin: ORIGIN });
  const setCalls = [];
  await setGuard.handle(navigationRoute(`${ORIGIN}/products/details?tour_id=20002`, setCalls));
  assert.deepEqual(setCalls, ["abort"]);

  const reads = [];
  const before = ensure.appReads;
  const waiting = ensure.waitForAppRead(before, 1_000);
  await ensure.handle(graphqlRoute({ operationName: "SyntheticAgendaRead", query: "query SyntheticAgendaRead { agenda { rows } }", variables: {} }, reads,
    { authorization: "Bearer synthetic", "x-client": "portal", cookie: "never-captured" }));
  assert.equal(await waiting, true);
  assert.deepEqual(ensure.sessionHeaders(), { authorization: "Bearer synthetic", "x-client": "portal" });
  await ensure.handle(graphqlRoute(scheduleReadRequest("30003"), reads, { authorization: "Bearer other" }));
  await ensure.handle(graphqlRoute({ ...scheduleReadRequest("30003"), query: "query NihoEnsureScheduleRead { activityOption(id: 30004) { id } }" }, reads));
  assert.deepEqual(reads, [["continue"], ["continue"], ["abort"]]);
  assert.equal(ensure.appReads, before + 1);
  assert.deepEqual(ensure.sessionHeaders(), { authorization: "Bearer synthetic", "x-client": "portal" });
  assert.equal(ensure.fatalWrite, null);
});
