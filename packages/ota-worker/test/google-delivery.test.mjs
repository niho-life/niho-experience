import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCloudClient, CloudError } from "../src/cloud-client.mjs";
import { executeGoogleDelivery } from "../src/google-delivery-executor.mjs";
import { createJournal } from "../src/journal.mjs";
import { executeJob } from "../src/supervisor.mjs";
import { validateClaim, validateTarget } from "../src/validation.mjs";
import { runWorkerOnce } from "../src/worker.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

function googleWire(action = "SET_CLOSED", overrides = {}) {
  const now = Date.now();
  return {
    id: randomUUID(), leaseToken: "lease-token", leaseExpiresAtUtc: new Date(now + 60_000).toISOString(),
    deadlineAtUtc: new Date(now + 150_000).toISOString(), action, occurrenceId: "synthetic-google-occurrence",
    desiredVersion: 1, mappingVersion: 1, sourceStartAtUtc: "2099-01-01T04:00:00.000Z",
    sourceEndAtUtc: "2099-01-01T05:00:00.000Z",
    target: { site: "Airbnb", externalAccountId: "12345", externalProductId: "67890",
      timeZone: "Asia/Tokyo", adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" },
    ...overrides,
  };
}

function executorCloud(job, overrides = {}) {
  return {
    async preflight() { return { ready: true, desiredState: job.desiredState ?? "CLOSED" }; },
    async renew() { return { leaseExpiresAtUtc: new Date(Math.min(Date.parse(job.deadlineAtUtc), Date.now() + 60_000)).toISOString() }; },
    async googleDelivery() { return { deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }; },
    ...overrides,
  };
}

test("Airbnb Google target is fixed and does not enter the browser adapter registry", () => {
  const target = googleWire().target;
  assert.equal(validateTarget(target).connectionMode, "GOOGLE");
  assert.equal(validateTarget({ ...target, externalOptionId: "" }).adapter, "airbnb-google-busy");
  for (const patch of [
    { externalAccountId: "0" }, { externalAccountId: "account" }, { externalAccountId: "1".repeat(129) }, { externalProductId: "-1" },
    { externalOptionId: "1" }, { adapter: "airbnb-browser" }, { adapterVersion: "2" },
    { connectionMode: "API" }, { connectionMode: "BROWSER" }, { timeZone: "UTC" },
  ]) assert.throws(() => validateTarget({ ...target, ...patch }));
  assert.equal(validateClaim(googleWire()).target.site, "Airbnb");
});

test("cloud delivery pins path, bearer request body, operation, and exact DTO", async () => {
  const job = validateClaim(googleWire());
  const requests = [];
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url, init) => {
    requests.push({ path: new URL(url).pathname, init });
    return json({ deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
  } });
  assert.equal((await client.googleDelivery(job, "dispatch")).phase, "GOOGLE_VERIFIED");
  assert.equal(requests[0].path, `/internal/ota/v1/jobs/${job.id}/google-delivery`);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${"x".repeat(40)}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { leaseToken: "lease-token", operation: "dispatch" });

  const observed = validateClaim(googleWire("OBSERVE"));
  await assert.rejects(client.googleDelivery(observed, "dispatch"), (error) => error.code === "INVALID_GOOGLE_DELIVERY_OPERATION");
  await client.googleDelivery(observed, "reconcile");
  assert.deepEqual(JSON.parse(requests[1].init.body), { leaseToken: "lease-token", operation: "reconcile" });
});

test("cloud delivery rejects missing, extra, secret-bearing, unknown, and Airbnb-synced DTOs", async () => {
  const job = validateClaim(googleWire());
  const base = { deliveryId: randomUUID(), phase: "STOPPED", airbnb: "UNVERIFIED", reason: "WRITE_UNCERTAIN" };
  const invalid = [
    { phase: "STOPPED", airbnb: "UNVERIFIED" }, { ...base, extra: true }, { ...base, token: "secret" },
    { ...base, tokens: ["secret"] }, { ...base, calendarId: "private" }, { ...base, phase: "VERIFIED" }, { ...base, reason: "UNKNOWN_REASON" },
    { ...base, airbnb: "SYNCED" },
  ];
  for (const body of invalid) {
    const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => json(body) });
    await assert.rejects(client.googleDelivery(job, "dispatch"), (error) => error.code === "INVALID_RESPONSE");
  }
  const valid = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => json(base) });
  assert.equal((await valid.googleDelivery(job, "dispatch")).reason, "WRITE_UNCERTAIN");
  for (const reason of ["DESIRED_MISMATCH", "AUTHORITY_CHANGED", "GOOGLE_UNAVAILABLE", "GOOGLE_REVOKED", "INVALID_RESPONSE", "NO_JOURNAL"]) {
    const known = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => json({ ...base, reason }) });
    assert.equal((await known.googleDelivery(job, "dispatch")).reason, reason);
  }
});

test("an already aborted delivery never invokes fetch", async () => {
  let requests = 0;
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => {
    requests += 1; return json({});
  } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.googleDelivery(validateClaim(googleWire()), "dispatch", { signal: controller.signal }), (error) => error.code === "TIMEOUT");
  assert.equal(requests, 0);
});

test("confirmed server phases never fabricate Airbnb verification", async () => {
  const job = validateClaim(googleWire());
  for (const [phase, outcome] of [["DISPATCHING", "UNKNOWN_AFTER_SAVE"], ["UNCERTAIN", "UNKNOWN_AFTER_SAVE"],
    ["NOT_MATCHED", "NEEDS_REVIEW"], ["STOPPED", "NEEDS_REVIEW"]]) {
    const result = await executeGoogleDelivery({ job, config: { googleDeliveryEnabled: true },
      cloud: executorCloud(job, { async googleDelivery() { return { deliveryId: randomUUID(), phase, airbnb: "UNVERIFIED" }; } }) });
    assert.equal(result.outcome, outcome);
    assert.equal(result.stopped, true);
    assert.equal(result.halt, true);
    assert.equal(result.observation, null);
  }
});

test("disabled delivery is a static halt and reaches no cloud, browser, RPC, or Claude factory", async () => {
  const job = validateClaim(googleWire());
  let calls = 0;
  const result = await executeJob({ job, cloud: new Proxy({}, { get() { calls += 1; throw new Error("cloud I/O"); } }),
    config: { mode: "claude-code", googleDeliveryEnabled: false },
    driverFactory: async () => { calls += 1; }, rpcFactory: async () => { calls += 1; }, claudeExecutor: async () => { calls += 1; } });
  assert.deepEqual({ outcome: result.outcome, stopped: result.stopped, halt: result.halt, reason: result.reason, modelInvocations: result.modelInvocations },
    { outcome: "NEEDS_REVIEW", stopped: true, halt: true, reason: "GOOGLE_DELIVERY_DISABLED", modelInvocations: 0 });
  assert.equal(calls, 0);
});

test("GOOGLE_VERIFIED still requires Airbnb observation and worker reports zero model calls", async () => {
  const wire = googleWire();
  const calls = { delivery: 0, browser: 0, model: 0 };
  let reported;
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/internal/ota/v1/google-sync") return json({ processed: false, applied: false });
    if (path === "/internal/ota/v1/claim") return json({ job: wire });
    if (path.endsWith("/preflight")) return json({ ready: true, desiredState: "CLOSED" });
    if (path.endsWith("/renew")) return json({ leaseExpiresAtUtc: new Date(Date.now() + 60_000).toISOString() });
    if (path.endsWith("/google-delivery")) { calls.delivery += 1; return json({ deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }); }
    if (path.endsWith("/result")) { reported = JSON.parse(init.body); return json({ acceptedAsCurrent: true, repeated: false }); }
    throw new Error(`unexpected ${path}`);
  } });
  const directory = await mkdtemp(join(tmpdir(), "niho-google-worker-"));
  const result = await runWorkerOnce({ cloud: client, config: { mode: "claude-code", privateDir: directory, googleDeliveryEnabled: true },
    journal: createJournal(directory), executor: (options) => executeJob({ ...options,
      driverFactory: async () => { calls.browser += 1; }, claudeExecutor: async () => { calls.model += 1; } }) });
  assert.equal(result.status, "HALT_AFTER_RESULT");
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "AIRBNB_OBSERVATION_REQUIRED");
  assert.equal(result.modelInvocations, 0);
  assert.equal(reported.outcome, "NEEDS_REVIEW");
  assert.equal(reported.stopped, true);
  assert.equal(calls.delivery, 1);
  assert.equal(calls.browser, 0);
  assert.equal(calls.model, 0);
});

test("renew failure and deadline before send are stopped without a mutating request", async () => {
  const job = validateClaim(googleWire());
  let deliveries = 0;
  const renewFailed = await executeGoogleDelivery({ job, config: { googleDeliveryEnabled: true }, cloud: executorCloud(job, {
    async renew() { throw Object.assign(new Error("lost"), { code: "LEASE_RENEW_FAILED" }); },
    async googleDelivery() { deliveries += 1; },
  }) });
  assert.equal(renewFailed.outcome, "NEEDS_REVIEW");
  assert.equal(renewFailed.stopped, true);
  assert.equal(deliveries, 0);

  let clock = Date.parse(job.leaseExpiresAtUtc);
  const expired = await executeGoogleDelivery({ job, config: { googleDeliveryEnabled: true }, now: () => clock,
    cloud: executorCloud(job, { async preflight() { clock = Date.parse(job.deadlineAtUtc); return {}; },
      async googleDelivery() { deliveries += 1; } }) });
  assert.equal(expired.stopped, true);
  assert.equal(deliveries, 0);
});

test("lease expiry bounds a stalled preflight and a stalled renew independently of the job deadline", async () => {
  for (const afterSend of [false, true]) {
    const job = validateClaim(googleWire("SET_CLOSED", {
      leaseExpiresAtUtc: new Date(Date.now() + 80).toISOString(), deadlineAtUtc: new Date(Date.now() + 1000).toISOString(),
    }));
    let deliveries = 0; let renewals = 0; let upstreamSettled = false;
    const stall = async () => { await new Promise((resolve) => setTimeout(resolve, 300)); upstreamSettled = true; };
    const result = await executeGoogleDelivery({ job, config: { googleDeliveryEnabled: true }, renewEveryMs: 5,
      cloud: executorCloud(job, {
        async preflight() { if (!afterSend) await stall(); return {}; },
        async renew() { renewals += 1; if (renewals > 1) await stall(); return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
        async googleDelivery() { deliveries += 1; await stall(); return {}; },
      }) });
    assert.equal(upstreamSettled, false);
    assert.equal(deliveries, afterSend ? 1 : 0);
    assert.equal(result.stopped, !afterSend);
    assert.equal(result.outcome, afterSend ? "UNKNOWN_AFTER_SAVE" : "NEEDS_REVIEW");
  }
});

test("renew loss, late ACK, hanging body, and invalid DTO after send stay unknown and stopped false", async () => {
  const short = validateClaim(googleWire("SET_CLOSED", {
    leaseExpiresAtUtc: new Date(Date.now() + 80).toISOString(), deadlineAtUtc: new Date(Date.now() + 100).toISOString(),
  }));
  let renewals = 0;
  const renewalLoss = await executeGoogleDelivery({ job: short, config: { googleDeliveryEnabled: true }, renewEveryMs: 5,
    cloud: executorCloud(short, {
      async renew() { renewals += 1; if (renewals > 1) throw new Error("lost"); return { leaseExpiresAtUtc: new Date(Date.now() + 70).toISOString() }; },
      async googleDelivery() { return new Promise(() => {}); },
    }) });
  assert.equal(renewalLoss.outcome, "UNKNOWN_AFTER_SAVE");
  assert.equal(renewalLoss.stopped, false);

  const lateJob = validateClaim(googleWire("SET_CLOSED", {
    leaseExpiresAtUtc: new Date(Date.now() + 40).toISOString(), deadlineAtUtc: new Date(Date.now() + 45).toISOString(),
  }));
  const late = await executeGoogleDelivery({ job: lateJob, config: { googleDeliveryEnabled: true }, renewEveryMs: 1_000,
    cloud: executorCloud(lateJob, {
      async renew() { return { leaseExpiresAtUtc: lateJob.deadlineAtUtc }; },
      async googleDelivery() { await new Promise((resolve) => setTimeout(resolve, 80)); return { deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }; },
    }) });
  assert.equal(late.outcome, "UNKNOWN_AFTER_SAVE");
  assert.equal(late.stopped, false);
  await new Promise((resolve) => setTimeout(resolve, 90));

  const lateRejectJob = validateClaim(googleWire("SET_CLOSED", {
    leaseExpiresAtUtc: new Date(Date.now() + 40).toISOString(), deadlineAtUtc: new Date(Date.now() + 45).toISOString(),
  }));
  const lateReject = await executeGoogleDelivery({ job: lateRejectJob, config: { googleDeliveryEnabled: true }, renewEveryMs: 1_000,
    cloud: executorCloud(lateRejectJob, {
      async renew() { return { leaseExpiresAtUtc: lateRejectJob.deadlineAtUtc }; },
      async googleDelivery() { await new Promise((resolve) => setTimeout(resolve, 80)); throw new Error("late rejection"); },
    }) });
  assert.equal(lateReject.outcome, "UNKNOWN_AFTER_SAVE");
  assert.equal(lateReject.stopped, false);
  await new Promise((resolve) => setTimeout(resolve, 90));

  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"deliveryId":')); }, cancel() { cancelled = true; } });
  const hangingClient = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(stream, {
    status: 200, headers: { "content-type": "application/json" },
  }) });
  const hangingJob = validateClaim(googleWire("SET_CLOSED", {
    leaseExpiresAtUtc: new Date(Date.now() + 35).toISOString(), deadlineAtUtc: new Date(Date.now() + 40).toISOString(),
  }));
  const hanging = await executeGoogleDelivery({ job: hangingJob, config: { googleDeliveryEnabled: true }, renewEveryMs: 1_000,
    cloud: { ...executorCloud(hangingJob), async renew() { return { leaseExpiresAtUtc: hangingJob.deadlineAtUtc }; },
      googleDelivery: hangingClient.googleDelivery } });
  assert.equal(hanging.stopped, false);
  assert.equal(cancelled, true);

  const invalidClient = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => json({
    deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "SYNCED",
  }) });
  const invalidJob = validateClaim(googleWire());
  const invalid = await executeGoogleDelivery({ job: invalidJob, config: { googleDeliveryEnabled: true },
    cloud: { ...executorCloud(invalidJob), googleDelivery: invalidClient.googleDelivery } });
  assert.equal(invalid.outcome, "UNKNOWN_AFTER_SAVE");
  assert.equal(invalid.stopped, false);
});

test("404 is a stopped static halt and never falls back to browser or Claude", async () => {
  const job = validateClaim(googleWire());
  let browser = 0;
  const result = await executeJob({ job, config: { mode: "claude-code", googleDeliveryEnabled: true },
    cloud: executorCloud(job, { async googleDelivery() { throw new CloudError("HTTP_ERROR", 404); } }),
    driverFactory: async () => { browser += 1; }, claudeExecutor: async () => { browser += 1; } });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.stopped, true);
  assert.equal(result.reason, "GOOGLE_DELIVERY_UNAVAILABLE");
  assert.equal(browser, 0);
});

test("lost result ACK retries the identical result only and never dispatches Google twice", async () => {
  const wire = googleWire();
  const directory = await mkdtemp(join(tmpdir(), "niho-google-restart-"));
  let claims = 0;
  let deliveries = 0;
  let reports = 0;
  const payloads = [];
  const cloud = {
    async triggerResourceGoogleSync() { return { processed: false, applied: false }; },
    async claimAllowIdle() { claims += 1; return claims === 1 ? validateClaim(wire) : null; },
    async preflight() { return { ready: true, desiredState: "CLOSED" }; },
    async renew() { return { leaseExpiresAtUtc: new Date(Date.now() + 60_000).toISOString() }; },
    async googleDelivery() { deliveries += 1; return { deliveryId: randomUUID(), phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }; },
    async result(_id, payload) { reports += 1; payloads.push(JSON.stringify(payload)); if (reports === 1) throw new Error("lost ACK"); return { acceptedAsCurrent: true, repeated: true }; },
  };
  await assert.rejects(runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory, googleDeliveryEnabled: true }, journal: createJournal(directory) }));
  const resumed = await runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory, googleDeliveryEnabled: true }, journal: createJournal(directory) });
  assert.equal(resumed.status, "HALT_AFTER_RESULT");
  assert.equal(resumed.modelInvocations, 0);
  assert.equal(deliveries, 1);
  assert.equal(claims, 1);
  assert.equal(reports, 2);
  assert.equal(payloads[0], payloads[1]);
});
