import test from "node:test";
import assert from "node:assert/strict";
import { executeJob } from "../src/supervisor.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";

const state = { accountId: "10001", productId: "20002", optionId: "30003", localDateTime: "2099-01-01T13:00:00" };
const observation = (job) => ({ occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
  observedAtUtc: new Date().toISOString(), manuallyBlocked: job.desiredState === "CLOSED", bookable: job.desiredState !== "CLOSED" });

function blockingDriver(job, stoppedValue = true) {
  let rejectAction;
  let stops = 0;
  return {
    get stops() { return stops; },
    async observeTarget() { return observation(job); },
    applyDesiredState() { return new Promise((_, reject) => { rejectAction = reject; }); },
    async verifyAfterReload() { return observation(job); },
    async stop() { stops += 1; rejectAction?.(Object.assign(new Error("stopped"), { code: "DRIVER_STOPPED" })); return stoppedValue; },
  };
}

test("renew failure during action stops owned browser and prevents VERIFIED", async () => {
  const job = makeJob(state, "SET_CLOSED");
  const driver = blockingDriver(job);
  const cloud = { async preflight() {}, async renew() { throw new Error("lost lease"); } };
  const result = await executeJob({ job, cloud, config: { mode: "deterministic" }, renewEveryMs: 5, driverFactory: async () => driver });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.stopped, true);
  assert.equal(driver.stops, 1);
});

test("deadline expiry stops action and cannot report VERIFIED", async () => {
  const job = makeJob(state, "SET_CLOSED", { deadlineAtUtc: new Date(Date.now() + 25).toISOString() });
  const driver = blockingDriver(job);
  const cloud = { async preflight() {}, async renew() {} };
  const result = await executeJob({ job, cloud, config: { mode: "deterministic" }, renewEveryMs: 1_000, driverFactory: async () => driver });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.reason, "DEADLINE_EXCEEDED");
  assert.equal(result.stopped, true);
});

test("Claude child stop failure makes stopped false and downgrades otherwise verified result", async () => {
  const job = makeJob(state, "SET_OPEN");
  const driver = {
    async observeTarget() { return observation(job); }, async applyDesiredState() { return {}; }, async verifyAfterReload() { return observation(job); }, async stop() { return true; },
  };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver, rpcFactory: async () => ({ async close() {} }), claudeExecutor: async () => ({ status: "DONE", stopped: false }) });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.stopped, false);
  assert.equal(result.reason, "PROCESS_STOP_UNCONFIRMED");
});

test("Claude RATE is a local halt without site-auth quarantine", async () => {
  const job = makeJob(state, "SET_OPEN");
  const driver = {
    async observeTarget() { return observation(job); }, async applyDesiredState() {}, async verifyAfterReload() { return observation(job); }, async stop() { return true; },
  };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver, rpcFactory: async () => ({ async close() {} }), claudeExecutor: async () => ({ status: "RATE", stopped: true }) });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.halt, true);
  assert.equal(result.quarantine, false);
  assert.equal(result.reason, "RATE");
});

test("Claude exception carries positive child-stop confirmation to result", async () => {
  const job = makeJob(state, "SET_OPEN");
  const driver = { async stop() { return true; } };
  const failure = Object.assign(new Error("coarse synthetic failure"), { code: "MODEL_FAILED", stopped: true });
  const result = await executeJob({ job, cloud: { async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver, rpcFactory: async () => ({ async close() {} }), claudeExecutor: async () => { throw failure; } });
  assert.equal(result.stopped, true);
  assert.equal(result.outcome, "NEEDS_REVIEW");
});

test("model DONE prose cannot override independent driver readback", async () => {
  const job = makeJob(state, "SET_OPEN");
  const error = Object.assign(new Error("not bookable"), { code: "VERIFY_FAILED" });
  const driver = { async observeTarget() { return observation(job); }, async applyDesiredState() {}, async verifyAfterReload() { throw error; }, async stop() { return true; } };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver, rpcFactory: async () => ({ async close() {} }), claudeExecutor: async () => ({ status: "DONE", stopped: true }) });
  assert.equal(result.outcome, "NEEDS_REVIEW");
});

test("supervisor rejects OPEN readback that is manually open but actually Not Bookable", async () => {
  const job = makeJob(state, "SET_OPEN");
  const notBookable = { ...observation(job), manuallyBlocked: false, bookable: false };
  const driver = { async observeTarget() { return notBookable; }, async applyDesiredState() {}, async verifyAfterReload() { return notBookable; }, async stop() { return true; } };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "deterministic" }, driverFactory: async () => driver });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "VERIFY_FAILED");
});

test("auth expiry is a halt and quarantine outcome", async () => {
  const job = makeJob(state, "OBSERVE");
  const driver = { async observeTarget() { throw Object.assign(new Error("auth"), { code: "AUTH_REQUIRED" }); }, async stop() { return true; } };
  const result = await executeJob({ job, cloud: { async renew() {} }, config: { mode: "deterministic" }, driverFactory: async () => driver });
  assert.equal(result.outcome, "AUTH_REQUIRED");
  assert.equal(result.halt, true);
  assert.equal(result.quarantine, true);
});

test("deterministic mode uses its final verification exactly once", async () => {
  const job = makeJob(state, "SET_CLOSED");
  let verifies = 0;
  const driver = {
    async observeTarget() { return observation(job); },
    async applyDesiredState() {},
    async verifyAfterReload() { verifies += 1; return observation(job); },
    async stop() { return true; },
  };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "deterministic" }, driverFactory: async () => driver });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(verifies, 1);
});

test("Claude mode retains one independent verification after model execution", async () => {
  const job = makeJob(state, "SET_OPEN");
  let verifies = 0;
  const driver = {
    async observeTarget() { return observation(job); }, async applyDesiredState() {},
    async verifyAfterReload() { verifies += 1; return observation(job); }, async stop() { return true; },
  };
  const result = await executeJob({ job, cloud: { async preflight() {}, async renew() {} }, config: { mode: "claude-code", privateDir: "/tmp" },
    driverFactory: async () => driver, rpcFactory: async () => ({ async close() {} }), claudeExecutor: async () => ({ status: "DONE", stopped: true }) });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(verifies, 1);
});

test("final mismatch, lease loss and unconfirmed stop cannot become VERIFIED", async () => {
  const mismatchJob = makeJob(state, "SET_OPEN");
  const mismatch = await executeJob({ job: mismatchJob, cloud: { async preflight() {}, async renew() {} }, config: { mode: "deterministic" },
    driverFactory: async () => ({ async observeTarget() { return observation(mismatchJob); }, async applyDesiredState() {},
      async verifyAfterReload() { return { ...observation(mismatchJob), bookable: false }; }, async stop() { return true; } }) });
  assert.equal(mismatch.outcome, "NEEDS_REVIEW");

  const stoppedJob = makeJob(state, "SET_CLOSED");
  const unconfirmed = await executeJob({ job: stoppedJob, cloud: { async preflight() {}, async renew() {} }, config: { mode: "deterministic" },
    driverFactory: async () => ({ async observeTarget() { return observation(stoppedJob); }, async applyDesiredState() {},
      async verifyAfterReload() { return observation(stoppedJob); }, async stop() { return false; } }) });
  assert.notEqual(unconfirmed.outcome, "VERIFIED");
  assert.equal(unconfirmed.reason, "PROCESS_STOP_UNCONFIRMED");
});

test("site access restriction is a non-auth halt", async () => {
  const job = makeJob(state, "OBSERVE");
  const driver = { async observeTarget() { throw Object.assign(new Error("restricted"), { code: "SITE_ACCESS_RESTRICTED" }); }, async stop() { return true; } };
  const result = await executeJob({ job, cloud: { async renew() {} }, config: { mode: "deterministic" }, driverFactory: async () => driver });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "SITE_ACCESS_RESTRICTED");
  assert.equal(result.halt, true);
  assert.equal(result.quarantine, true);
});
