import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudClient } from "../src/cloud-client.mjs";
import { executeGoogleDelivery } from "../src/google-delivery-executor.mjs";
import { createJournal } from "../src/journal.mjs";
import { executeJob } from "../src/supervisor.mjs";
import { runWorkerOnce } from "../src/worker.mjs";
import {
  ContractError, makeGoogleAirbnbResult, makeResult, projectRawClaim, validateClaim, validateGoogleAirbnbObservation,
} from "../src/validation.mjs";

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function wire(action = "SET_CLOSED", overrides = {}) {
  const current = Date.now();
  return {
    id: randomUUID(), leaseToken: "lease", leaseExpiresAtUtc: new Date(current + 60_000).toISOString(),
    deadlineAtUtc: new Date(current + 150_000).toISOString(), action, occurrenceId: "occurrence-308",
    desiredVersion: 3, mappingVersion: 4, sourceStartAtUtc: "2099-01-01T04:00:00.000Z",
    sourceEndAtUtc: "2099-01-01T05:00:00.000Z",
    target: { site: "Airbnb", externalAccountId: "12345", externalProductId: "67890", externalOptionId: "",
      timeZone: "Asia/Tokyo", adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" },
    ...overrides,
  };
}

function observation(job, bookable, overrides = {}) {
  return {
    occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
    observedAtUtc: new Date(Date.now() + 10).toISOString(), bookable, evidence: "EXACT_SLOT_V1", partySize: 1,
    ...overrides,
  };
}

function harness(job, desiredState, bookable, overrides = {}) {
  const deliveryId = randomUUID();
  const calls = { operations: [], reads: 0, stops: 0, factoryJobs: [] };
  const cloud = {
    async preflight() { return { ready: true, desiredState }; },
    async renew() { return { leaseExpiresAtUtc: new Date(Math.min(Date.parse(job.deadlineAtUtc), Date.now() + 90_000)).toISOString() }; },
    async googleDelivery(_job, operation) {
      calls.operations.push(operation);
      return { deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" };
    },
    ...overrides.cloud,
  };
  const airbnbObserverFactory = async ({ job: rawJob, cloud: observerCloud }) => {
    calls.factoryJobs.push(rawJob);
    return {
      async observeTarget() {
        calls.reads += 1;
        await observerCloud.preflight(rawJob);
        await observerCloud.preflight(rawJob);
        return observation(rawJob, bookable);
      },
      async stop() { calls.stops += 1; return true; },
    };
  };
  return { cloud, airbnbObserverFactory, calls, deliveryId };
}

const enabled = Object.freeze({ googleDeliveryEnabled: true, googleAirbnbObservationEnabled: true });

test("claim marker is exact and raw projection removes derived parser fields", () => {
  const marked = validateClaim(wire("OBSERVE", { googleDeliveryOperation: "observe" }));
  assert.equal(marked.googleDeliveryOperation, "observe");
  assert.equal(marked.desiredState, undefined);
  const projected = projectRawClaim(marked);
  assert.equal(Object.hasOwn(projected, "localDateTime"), false);
  assert.equal(Object.hasOwn(projected, "desiredState"), false);
  assert.equal(projected.googleDeliveryOperation, "observe");
  for (const invalid of [
    wire("OBSERVE", { googleDeliveryOperation: "reconcile" }), wire("SET_OPEN", { googleDeliveryOperation: "observe" }),
    wire("OBSERVE", { purpose: "RESERVATION_WINDOW", googleDeliveryOperation: "observe" }),
    { ...wire("OBSERVE", { googleDeliveryOperation: "observe" }), target: { ...wire().target, site: "GetYourGuide" } },
  ]) assert.throws(() => validateClaim(invalid), ContractError);
});

test("SET OPEN/CLOSED always dispatches once, fresh-observes once, and returns only matched/opposite typed states", async () => {
  for (const [action, desiredState] of [["SET_OPEN", "OPEN"], ["SET_CLOSED", "CLOSED"]]) {
    for (const bookable of [true, false]) {
      const job = validateClaim(wire(action));
      const fixture = harness(job, desiredState, bookable);
      const result = await executeGoogleDelivery({ job, config: enabled, cloud: fixture.cloud,
        airbnbObserverFactory: fixture.airbnbObserverFactory });
      assert.equal(result.outcome, bookable === (desiredState === "OPEN") ? "VERIFIED" : "RETRY_WAIT");
      assert.deepEqual(fixture.calls.operations, ["dispatch", "observe"]);
      assert.equal(fixture.calls.reads, 1); assert.equal(fixture.calls.stops, 1);
      assert.equal(result.stopped, true); assert.equal(result.halt, false); assert.equal(result.quarantine, false);
      assert.deepEqual(result.googleAirbnbProof, { deliveryId: fixture.deliveryId, evidence: "EXACT_SLOT_V1", partySize: 1 });
      assert.equal(Object.hasOwn(result.observation, "manuallyBlocked"), false);
      assert.equal(Object.hasOwn(fixture.calls.factoryJobs[0], "desiredState"), false);
    }
  }
});

test("marked due OBSERVE is GET-only; unmarked OBSERVE remains historical reconcile without a receipt", async () => {
  const due = validateClaim(wire("OBSERVE", { googleDeliveryOperation: "observe" }));
  const dueFixture = harness(due, "OPEN", true);
  const result = await executeGoogleDelivery({ job: due, config: enabled, cloud: dueFixture.cloud,
    airbnbObserverFactory: dueFixture.airbnbObserverFactory });
  assert.equal(result.outcome, "VERIFIED");
  assert.deepEqual(dueFixture.calls.operations, ["observe"]);

  const legacy = validateClaim(wire("OBSERVE"));
  const legacyFixture = harness(legacy, "OPEN", true);
  const historical = await executeGoogleDelivery({ job: legacy, config: enabled, cloud: legacyFixture.cloud,
    airbnbObserverFactory: legacyFixture.airbnbObserverFactory });
  assert.equal(historical.outcome, "NEEDS_REVIEW");
  assert.equal(historical.reason, "AIRBNB_OBSERVATION_REQUIRED");
  assert.deepEqual(legacyFixture.calls.operations, ["reconcile"]);
  assert.equal(legacyFixture.calls.reads, 0);
  assert.equal(historical.googleAirbnbProof, undefined);
});

test("cloud client permits only SET dispatch/observe, marked observe, and legacy reconcile", async () => {
  const operations = [];
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (_url, init) => {
    operations.push(JSON.parse(init.body).operation);
    return json({ deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
  } });
  const setJob = validateClaim(wire("SET_OPEN"));
  await client.googleDelivery(setJob, "dispatch"); await client.googleDelivery(setJob, "observe");
  await assert.rejects(client.googleDelivery(setJob, "reconcile"), (error) => error.code === "INVALID_GOOGLE_DELIVERY_OPERATION");
  const due = validateClaim(wire("OBSERVE", { googleDeliveryOperation: "observe" }));
  await client.googleDelivery(due, "observe");
  await assert.rejects(client.googleDelivery(due, "reconcile"), (error) => error.code === "INVALID_GOOGLE_DELIVERY_OPERATION");
  const legacy = validateClaim(wire("OBSERVE"));
  await client.googleDelivery(legacy, "reconcile");
  await assert.rejects(client.googleDelivery(legacy, "observe"), (error) => error.code === "INVALID_GOOGLE_DELIVERY_OPERATION");
  assert.deepEqual(operations, ["dispatch", "observe", "observe", "reconcile"]);
});

test("observation flag off preserves SET legacy flow and blocks marked OBSERVE before I/O", async () => {
  const setJob = validateClaim(wire("SET_CLOSED"));
  const setFixture = harness(setJob, "CLOSED", false);
  const legacy = await executeGoogleDelivery({ job: setJob, config: { googleDeliveryEnabled: true }, cloud: setFixture.cloud,
    airbnbObserverFactory: setFixture.airbnbObserverFactory });
  assert.equal(legacy.reason, "AIRBNB_OBSERVATION_REQUIRED");
  assert.deepEqual(setFixture.calls.operations, ["dispatch"]);
  assert.equal(setFixture.calls.reads, 0);

  let calls = 0;
  const due = validateClaim(wire("OBSERVE", { googleDeliveryOperation: "observe" }));
  const blocked = await executeGoogleDelivery({ job: due, config: { googleDeliveryEnabled: true },
    cloud: new Proxy({}, { get() { calls += 1; throw new Error("unexpected I/O"); } }),
    airbnbObserverFactory: async () => { calls += 1; } });
  assert.equal(blocked.reason, "GOOGLE_AIRBNB_OBSERVATION_DISABLED");
  assert.equal(calls, 0);
});

test("dispatch ambiguity stays unknown while a failed fresh GET is a stopped review", async () => {
  const job = validateClaim(wire("SET_CLOSED"));
  const ambiguous = harness(job, "CLOSED", false, { cloud: { async googleDelivery() { throw new Error("lost ACK"); } } });
  const unknown = await executeGoogleDelivery({ job, config: enabled, cloud: ambiguous.cloud,
    airbnbObserverFactory: ambiguous.airbnbObserverFactory });
  assert.equal(unknown.outcome, "UNKNOWN_AFTER_SAVE"); assert.equal(unknown.stopped, false);

  let calls = 0;
  const getFailure = harness(job, "CLOSED", false, { cloud: { async googleDelivery(_job, operation) {
    calls += 1;
    if (operation === "observe") throw Object.assign(new Error("read failed"), { code: "TIMEOUT" });
    return { deliveryId: getFailure.deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" };
  } } });
  const safe = await executeGoogleDelivery({ job, config: enabled, cloud: getFailure.cloud,
    airbnbObserverFactory: getFailure.airbnbObserverFactory });
  assert.equal(calls, 2); assert.equal(safe.outcome, "NEEDS_REVIEW"); assert.equal(safe.stopped, true);
  assert.equal(safe.googleAirbnbProof, undefined);
});

test("fresh delivery mismatch and malformed native facts stop without typed proof", async () => {
  const job = validateClaim(wire("SET_CLOSED"));
  let calls = 0;
  const mismatch = harness(job, "CLOSED", false, { cloud: { async googleDelivery() {
    calls += 1;
    return { deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" };
  } } });
  const mismatched = await executeGoogleDelivery({ job, config: enabled, cloud: mismatch.cloud,
    airbnbObserverFactory: mismatch.airbnbObserverFactory });
  assert.equal(calls, 2); assert.equal(mismatched.reason, "GOOGLE_DELIVERY_MISMATCH");
  assert.equal(mismatched.googleAirbnbProof, undefined); assert.equal(mismatch.calls.reads, 0);

  const malformed = harness(job, "CLOSED", false);
  const invalid = await executeGoogleDelivery({ job, config: enabled, cloud: malformed.cloud,
    airbnbObserverFactory: async () => ({ async observeTarget() { return { ...observation(job, false), manuallyBlocked: true }; },
      async stop() { return true; } }) });
  assert.equal(invalid.outcome, "NEEDS_REVIEW"); assert.equal(invalid.stopped, true);
  assert.equal(invalid.googleAirbnbProof, undefined); assert.equal(invalid.observation, null);
});

test("native observation and typed result reject extra/manual fields, wrong identity/time/party/proof/outcome", () => {
  const job = validateClaim(wire("SET_OPEN"));
  const valid = observation(job, true);
  assert.equal(validateGoogleAirbnbObservation(valid, job).bookable, true);
  for (const patch of [
    { extra: true }, { manuallyBlocked: false }, { occurrenceId: "other" }, { sourceStartAtUtc: "2099-01-01T04:00:01.000Z" },
    { partySize: 2 }, { evidence: "DAY_V1" }, { observedAtUtc: job.deadlineAtUtc },
  ]) assert.throws(() => validateGoogleAirbnbObservation({ ...valid, ...patch }, job), ContractError);
  const proof = { deliveryId: randomUUID(), evidence: "EXACT_SLOT_V1", partySize: 1 };
  const built = makeGoogleAirbnbResult({ resultId: randomUUID(), job, outcome: "VERIFIED", stopped: true,
    observation: valid, googleAirbnbProof: proof, expectedDesiredState: "OPEN" });
  assert.equal(built.observedState, "OPEN"); assert.equal(Object.hasOwn(built, "observedManuallyBlocked"), false);
  assert.throws(() => makeResult({ resultId: randomUUID(), job, outcome: "VERIFIED", stopped: true, observation: valid }), ContractError);
  for (const patch of [{ stopped: false }, { outcome: "RETRY_WAIT" }, { googleAirbnbProof: { ...proof, partySize: 2 } },
    { googleAirbnbProof: { ...proof, deliveryId: randomUUID(), extra: true } }]) {
    assert.throws(() => makeGoogleAirbnbResult({ resultId: randomUUID(), job, outcome: "VERIFIED", stopped: true,
      observation: valid, googleAirbnbProof: proof, expectedDesiredState: "OPEN", ...patch }), ContractError);
  }
});

test("observer auth/DOM failures close safely; hung factory/read/stop cannot outlive the lease", async () => {
  const normal = validateClaim(wire("SET_CLOSED"));
  for (const code of ["AUTH_REQUIRED", "DOM_DRIFT"]) {
    const fixture = harness(normal, "CLOSED", false);
    fixture.airbnbObserverFactory = async () => ({ async observeTarget() { throw new ContractError(code); },
      async stop() { fixture.calls.stops += 1; return true; } });
    const result = await executeGoogleDelivery({ job: normal, config: enabled, cloud: fixture.cloud,
      airbnbObserverFactory: fixture.airbnbObserverFactory });
    assert.equal(result.outcome, code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "NEEDS_REVIEW");
    assert.equal(result.stopped, true); assert.equal(result.googleAirbnbProof, undefined); assert.equal(fixture.calls.stops, 1);
  }

  const rejectedFactory = harness(normal, "CLOSED", false);
  const unconfirmed = await executeGoogleDelivery({ job: normal, config: enabled, cloud: rejectedFactory.cloud,
    airbnbObserverFactory: async () => { throw new ContractError("DOM_DRIFT"); } });
  assert.equal(unconfirmed.stopped, false); assert.equal(unconfirmed.reason, "PROCESS_STOP_UNCONFIRMED");
  assert.equal(unconfirmed.googleAirbnbProof, undefined);

  for (const mode of ["factory", "read", "stop"]) {
    const current = Date.now();
    const short = validateClaim(wire("SET_CLOSED", { leaseExpiresAtUtc: new Date(current + 70).toISOString(),
      deadlineAtUtc: new Date(current + 100).toISOString() }));
    const fixture = harness(short, "CLOSED", false, { cloud: { async renew() { return { leaseExpiresAtUtc: short.deadlineAtUtc }; } } });
    let stops = 0;
    const factory = mode === "factory" ? async () => new Promise(() => {}) : async () => ({
      async observeTarget() { return mode === "read" ? new Promise(() => {}) : observation(short, false); },
      async stop() { stops += 1; return mode === "stop" ? new Promise(() => {}) : true; },
    });
    const started = Date.now();
    const result = await executeGoogleDelivery({ job: short, config: enabled, cloud: fixture.cloud,
      airbnbObserverFactory: factory, renewEveryMs: 1_000 });
    assert.ok(Date.now() - started < 500);
    assert.equal(result.stopped, false); assert.equal(result.halt, true); assert.equal(result.googleAirbnbProof, undefined);
    if (mode !== "factory") assert.equal(stops, 1);
  }
});

test("real claim parser projects a raw DTO and worker emits the exact typed body", async () => {
  const claimed = wire("SET_OPEN");
  const deliveryId = randomUUID();
  let selectedBody; let factoryJob; let deliveryCalls = 0;
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/google-sync")) return json({ processed: false, applied: false });
    if (path.endsWith("/claim")) return json({ job: claimed });
    if (path.endsWith("/preflight")) return json({ ready: true, desiredState: "OPEN" });
    if (path.endsWith("/renew")) return json({ leaseExpiresAtUtc: new Date(Date.now() + 90_000).toISOString() });
    if (path.endsWith("/google-delivery")) { deliveryCalls += 1; return json({ deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }); }
    if (path.endsWith("/result")) { selectedBody = JSON.parse(init.body); return json({ acceptedAsCurrent: true, repeated: false }); }
    throw new Error(`unexpected ${path}`);
  } });
  const directory = await mkdtemp(join(tmpdir(), "niho-google-airbnb-cloud-"));
  const result = await runWorkerOnce({ cloud: client, config: { ...enabled, mode: "deterministic", privateDir: directory },
    journal: createJournal(directory), executor: (options) => executeJob({ ...options, airbnbObserverFactory: async ({ job, cloud }) => {
      factoryJob = job;
      return { async observeTarget() { await cloud.preflight(job); await cloud.preflight(job); return observation(job, true); }, async stop() { return true; } };
    } }) });
  assert.equal(result.status, "RESULT_ACKNOWLEDGED"); assert.equal(deliveryCalls, 2);
  assert.deepEqual(Object.keys(factoryJob).sort(), [...Object.keys(claimed)].sort());
  assert.equal(Object.hasOwn(factoryJob, "localDateTime"), false); assert.equal(Object.hasOwn(factoryJob, "desiredState"), false);
  assert.deepEqual(Object.keys(selectedBody).sort(), ["googleAirbnbProof", "leaseToken", "observedAtUtc", "observedBookable",
    "observedState", "occurrenceId", "outcome", "resultId", "sourceEndAtUtc", "sourceStartAtUtc", "stopped", "target"].sort());
  assert.equal(selectedBody.outcome, "VERIFIED"); assert.equal(selectedBody.googleAirbnbProof.deliveryId, deliveryId);
  assert.equal(Object.hasOwn(selectedBody, "observedManuallyBlocked"), false);
});

test("typed pending result replay is byte-identical and non-current ACK does not re-execute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-google-airbnb-replay-"));
  const job = validateClaim(wire("SET_CLOSED"));
  const proof = { deliveryId: randomUUID(), evidence: "EXACT_SLOT_V1", partySize: 1 };
  let executions = 0; let claims = 0; const bodies = [];
  const cloud = {
    async claimAllowIdle() { claims += 1; return job; },
    async result(_id, body) {
      bodies.push(JSON.stringify(body));
      if (bodies.length === 1) throw new Error("lost ACK");
      return { acceptedAsCurrent: false, repeated: true };
    },
  };
  const executor = async () => { executions += 1; return { outcome: "RETRY_WAIT", stopped: true,
    observation: observation(job, true), expectedDesiredState: "CLOSED", googleAirbnbProof: proof,
    quarantine: false, halt: false, modelInvocations: 0 }; };
  await assert.rejects(runWorkerOnce({ cloud, config: { mode: "deterministic", privateDir: directory },
    journal: createJournal(directory), executor }));
  const resumed = await runWorkerOnce({ cloud, config: { mode: "deterministic", privateDir: directory },
    journal: createJournal(directory), executor });
  assert.equal(resumed.status, "RESULT_ACKNOWLEDGED_NOT_CURRENT"); assert.equal(resumed.modelInvocations, 0);
  assert.equal(executions, 1); assert.equal(claims, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).outcome, "RETRY_WAIT");
});
