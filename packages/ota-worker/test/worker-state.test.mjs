import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { executeJob } from "../src/supervisor.mjs";
import { createViatorAccessMonitor } from "../src/viator-access-monitor.mjs";
import { createJournal } from "../src/journal.mjs";
import { resumeJournal, runWorkerOnce } from "../src/worker.mjs";
import { makeResult } from "../src/validation.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";
import { createHaltLatch } from "../src/halt-latch.mjs";

const state = { accountId: "10001", productId: "20002", optionId: "30003", localDateTime: "2099-01-01T13:00:00" };

test("pending result retry reuses byte-equivalent resultId and payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-journal-"));
  const journal = createJournal(directory);
  const job = makeJob(state, "SET_CLOSED");
  const result = makeResult({ resultId: randomUUID(), job, outcome: "RETRY_WAIT", stopped: true });
  await journal.claimed(job); await journal.running(); await journal.pendingResult(result);
  const attempts = [];
  const cloud = { async result(id, payload) { attempts.push(JSON.stringify({ id, payload })); if (attempts.length === 1) throw new Error("lost ack"); } };
  await assert.rejects(resumeJournal(journal, cloud));
  const reloaded = createJournal(directory);
  assert.equal((await resumeJournal(reloaded, cloud)).status, "RESULT_ACKNOWLEDGED");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
});

test("204 idle does not invoke deterministic or Claude executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-idle-"));
  let calls = 0;
  const result = await runWorkerOnce({ cloud: { async claimAllowIdle() { return null; } }, config: { mode: "claude-code" }, journal: createJournal(directory),
    executor: async () => { calls += 1; } });
  assert.equal(result.status, "IDLE");
  assert.equal(result.modelInvocations, 0);
  assert.equal(calls, 0);
});

test("restart with RUNNING journal quarantines and never replays OPEN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-restart-"));
  const first = createJournal(directory);
  const job = makeJob(state, "SET_OPEN");
  await first.claimed(job); await first.running();
  let cloudCalls = 0;
  const second = createJournal(directory);
  const result = await resumeJournal(second, { async result() { cloudCalls += 1; } });
  assert.equal(result.status, "HALT_QUARANTINED");
  assert.equal(second.current.phase, "QUARANTINED");
  assert.equal(cloudCalls, 0);
});

test("RATE halt is durably latched and does not invoke Claude again after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-rate-"));
  const job = makeJob(state, "SET_CLOSED");
  let claims = 0;
  let executions = 0;
  const cloud = {
    async claimAllowIdle() { claims += 1; return job; },
    async result() {},
  };
  const first = await runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory }, journal: createJournal(directory),
    executor: async () => { executions += 1; return { outcome: "NEEDS_REVIEW", stopped: true, observation: null, quarantine: false, halt: true, reason: "RATE" }; } });
  assert.equal(first.status, "HALT_AFTER_RESULT");
  const second = await runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory }, journal: createJournal(directory),
    executor: async () => { executions += 1; } });
  assert.equal(second.status, "HALT_LATCHED");
  assert.equal(second.reason, "RATE");
  assert.equal(claims, 1);
  assert.equal(executions, 1);
});

test("halt is latched before result delivery and a pending receipt is flushed before halt check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-halt-order-"));
  const journal = createJournal(directory);
  const latch = createHaltLatch(directory);
  const job = makeJob(state, "SET_CLOSED");
  let deliveries = 0;
  const cloud = {
    async claimAllowIdle() { return job; },
    async result() {
      deliveries += 1;
      assert.equal((await latch.read()).reason, "RATE");
      if (deliveries === 1) throw Object.assign(new Error("synthetic network loss"), { code: "NETWORK_ERROR" });
      return { acceptedAsCurrent: true, repeated: true };
    },
  };
  await assert.rejects(runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory }, journal,
    executor: async () => ({ outcome: "NEEDS_REVIEW", stopped: true, observation: null, quarantine: false, halt: true, reason: "RATE" }) }));
  assert.equal(journal.current.phase, "PENDING_RESULT");
  const resumed = await runWorkerOnce({ cloud, config: { mode: "claude-code", privateDir: directory }, journal });
  assert.equal(resumed.status, "HALT_AFTER_RESULT");
  assert.equal(deliveries, 2);
});

test("invalid result receipt halts with the identical pending result preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-result-invalid-"));
  const journal = createJournal(directory);
  const job = makeJob(state, "SET_CLOSED");
  const result = await runWorkerOnce({
    cloud: {
      async claimAllowIdle() { return job; },
      async result() { throw Object.assign(new Error("invalid"), { code: "INVALID_RESPONSE" }); },
    },
    config: { mode: "deterministic", privateDir: directory },
    journal,
    executor: async () => ({ outcome: "VERIFIED", stopped: true, observation: null, quarantine: false, halt: false }),
  });
  assert.equal(result.status, "HALT_PENDING_RESULT");
  assert.equal(journal.current.phase, "PENDING_RESULT");
  assert.equal((await createHaltLatch(directory).read()).reason, "RESULT_INVALID_RESPONSE");
});

test("accepted but non-current result is an audit receipt, not a green success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-result-old-"));
  const job = makeJob(state, "SET_CLOSED");
  const result = await runWorkerOnce({
    cloud: { async claimAllowIdle() { return job; }, async result() { return { acceptedAsCurrent: false, repeated: false }; } },
    config: { mode: "deterministic", privateDir: directory },
    journal: createJournal(directory),
    executor: async () => ({ outcome: "VERIFIED", stopped: true, observation: null, quarantine: false, halt: false }),
  });
  assert.equal(result.status, "RESULT_ACKNOWLEDGED_NOT_CURRENT");
  assert.equal(result.acceptedAsCurrent, false);
});

test("stopped false always creates a durable halt even for a retry outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-stop-halt-"));
  const job = makeJob(state, "SET_CLOSED");
  const result = await runWorkerOnce({
    cloud: { async claimAllowIdle() { return job; }, async result() { return { acceptedAsCurrent: true, repeated: false }; } },
    config: { mode: "deterministic", privateDir: directory },
    journal: createJournal(directory),
    executor: async () => ({ outcome: "RETRY_WAIT", stopped: false, observation: null, quarantine: true, halt: false, reason: "NETWORK_ERROR" }),
  });
  assert.equal(result.status, "HALT_AFTER_RESULT");
  assert.equal(result.reason, "PROCESS_STOP_UNCONFIRMED");
  assert.equal((await createHaltLatch(directory).read()).reason, "PROCESS_STOP_UNCONFIRMED");
});


test("stalled access-hold persistence still journals and reports a stopped halt", { timeout: 2_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-held-disk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  class Page extends EventEmitter { frames() { return []; } }
  const page = new Page();
  const monitor = createViatorAccessMonitor({ page, guard: { freeze() {} }, profile: "/synthetic/profile",
    supplierOrigin: "https://supplier.viator.com", persistHoldTimeoutMs: 20, persistHold: () => new Promise(() => {}) });
  const viator = { accountId: "999999", productId: "999999P1", optionId: "TG1", localDateTime: "2099-01-01T13:00:00" };
  const job = makeJob(viator, "OBSERVE", { target: { site: "Viator", externalAccountId: viator.accountId,
    externalProductId: viator.productId, externalOptionId: viator.optionId, timeZone: "Asia/Tokyo",
    adapter: "viator-browser", adapterVersion: "1", connectionMode: "BROWSER" } });
  let stops = 0;
  let claims = 0;
  const receipts = [];
  const driver = {
    async observeTarget() {
      page.emit("response", { status: () => 429, url: () => "https://supplier.viator.com/availability/api",
        request: () => ({ resourceType: () => "xhr" }) });
      await monitor.assertAvailable();
    },
    async stop() { stops += 1; await monitor.stop(); return true; },
  };
  const config = { mode: "deterministic", privateDir: directory };
  const cloud = {
    async claimAllowIdle() { claims += 1; return job; },
    async result(id, payload) {
      assert.equal((await createHaltLatch(directory).read()).reason, "SITE_ACCESS_RESTRICTED");
      receipts.push(payload);
      return { acceptedAsCurrent: true, repeated: false };
    },
  };
  const result = await runWorkerOnce({ cloud, config, journal: createJournal(directory),
    executor: (args) => executeJob({ ...args, driverFactory: async () => driver }) });
  assert.equal(result.status, "HALT_AFTER_RESULT");
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.stopped, true);
  assert.equal(stops, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].stopped, true);
  const restarted = await runWorkerOnce({ cloud, config, journal: createJournal(directory), executor: () => { throw new Error("must stay stopped"); } });
  assert.equal(restarted.status, "HALT_LATCHED");
  assert.equal(claims, 1);
});
