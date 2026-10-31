import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createGygDriver } from "../src/gyg-driver.mjs";
import { executeJob } from "../src/supervisor.mjs";
import { makeResult } from "../src/validation.mjs";
import { CHROME, makeJob, syntheticBlock, syntheticGyg, syntheticSchedule } from "./helpers/synthetic-gyg.mjs";

const requireBrowser = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync(CHROME)) {
    assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests");
    t.skip("Selected Chrome executable is not installed on this runner."); return false;
  }
  return true;
};

// The synthetic job targets Thursday 2099-01-01 13:00 Asia/Tokyo.
const TARGET_DATE = "2099-01-01";

function countingCloud({ fail } = {}) {
  const cloud = {
    preflights: 0,
    async preflight() {
      cloud.preflights += 1;
      if (fail) throw Object.assign(new Error("stale"), { code: fail });
      return { ready: true, desiredState: "OPEN" };
    },
    async renew(job) { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
  };
  return cloud;
}

async function fixtureWithSchedule(t, schedule = syntheticSchedule()) {
  const fixture = await syntheticGyg();
  t.after(() => fixture.close());
  fixture.state.schedule = schedule;
  return fixture;
}

async function openDriver(t, fixture, cloud, job = makeJob(fixture.state, "ENSURE_OCCURRENCE")) {
  const driver = await createGygDriver({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
  t.after(() => driver.stop());
  return { driver, job };
}

const ourBlock = (fixture) => fixture.state.schedule.pricing[0].blocks[0];

test("ENSURE writes the missing occurrence once, keeps the schedule, shows it in the agenda, then is idempotent", { timeout: 90_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  const before = structuredClone(ourBlock(fixture));
  const cloud = countingCloud();
  const { driver, job } = await openDriver(t, fixture, cloud);
  const ensured = await driver.ensureOccurrence();
  assert.equal(ensured.created, true);
  assert.equal(ensured.observation.occurrenceId, job.occurrenceId);
  assert.equal(ensured.observation.manuallyBlocked, false);
  assert.equal(ensured.observation.bookable, true);
  assert.equal(fixture.state.scheduleMutations, 1);
  assert.equal(driver.guard.writes, 1);
  assert.ok(cloud.preflights >= 2, "driver and interception-time preflight both run");
  assert.ok(fixture.state.scheduleReadClients.every((client) => client === "supplier-portal"));
  const after = ourBlock(fixture);
  assert.deepEqual(after.weekdays, before.weekdays);
  assert.deepEqual(after.validity, before.validity);
  assert.equal(after.name, before.name);
  assert.deepEqual(after.specialDates, [{ date: TARGET_DATE, times: ["09:00", "13:00"] }, { date: "2099-01-05", times: ["15:00"] }]);
  assert.equal(await driver.stop(), true);

  const reads = fixture.state.scheduleReads;
  const again = await openDriver(t, fixture, countingCloud({ fail: "MUST_NOT_PREFLIGHT" }));
  const second = await again.driver.ensureOccurrence();
  assert.equal(second.created, false);
  assert.equal(fixture.state.scheduleMutations, 1);
  assert.equal(fixture.state.scheduleReads, reads);
});

test("ENSURE through the supervisor in claude-code mode never starts Claude and reports ensureCreated", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  const job = makeJob(fixture.state, "ENSURE_OCCURRENCE");
  const cloud = countingCloud();
  const execution = await executeJob({
    job, cloud, config: { ...fixture.config, mode: "claude-code" }, renewEveryMs: 60_000,
    driverFactory: (options) => createGygDriver({ ...options, testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true,
      headless: true, browserFactory: fixture.browserFactory }),
    rpcFactory: async () => { throw new Error("rpc must not start"); },
    claudeExecutor: async () => { throw new Error("Claude must not start"); },
  });
  assert.equal(execution.outcome, "VERIFIED");
  assert.equal(execution.stopped, true);
  assert.equal(execution.ensureCreated, true);
  const result = makeResult({ resultId: randomUUID(), job, outcome: execution.outcome, stopped: execution.stopped,
    observation: execution.observation, ensureCreated: execution.ensureCreated });
  assert.equal(result.ensureCreated, true);
  assert.equal(result.observedState, "OPEN");
  assert.equal(fixture.state.scheduleMutations, 1);
});

test("an occurrence already in the agenda is reported without reading or writing the schedule", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t, syntheticSchedule({ pricing: [{ status: "ACTIVE",
    blocks: [syntheticBlock({ weekdays: { ...syntheticBlock().weekdays, thursday: ["09:00", "13:00"] } })] }] }));
  const { driver } = await openDriver(t, fixture, countingCloud({ fail: "MUST_NOT_PREFLIGHT" }));
  const ensured = await driver.ensureOccurrence();
  assert.equal(ensured.created, false);
  assert.equal(fixture.state.scheduleReads, 0);
  assert.equal(fixture.state.scheduleMutations, 0);
});

const refusals = [
  ["OPTION_NOT_ACTIVE", () => syntheticSchedule({ optionStatus: "DEACTIVATED" })],
  ["AMBIGUOUS_SCHEDULE", () => syntheticSchedule({ pricing: [{ status: "ACTIVE", blocks: [syntheticBlock(), syntheticBlock({ id: 7002, name: "Second" })] }] })],
  ["OUTSIDE_SCHEDULE_VALIDITY", () => syntheticSchedule({ pricing: [{ status: "ACTIVE", blocks: [syntheticBlock({ validity: { start: "2099-02-01", end: null } })] }] })],
  ["SCHEDULE_AGENDA_MISMATCH", () => syntheticSchedule({ agendaHidden: true, pricing: [{ status: "ACTIVE",
    blocks: [syntheticBlock({ weekdays: { ...syntheticBlock().weekdays, thursday: ["13:00"] } })] }] })],
];
for (const [code, schedule] of refusals) {
  test(`${code} stops after the schedule read without preflight or write`, { timeout: 60_000 }, async (t) => {
    if (!requireBrowser(t)) return;
    const fixture = await fixtureWithSchedule(t, schedule());
    const cloud = countingCloud({ fail: "MUST_NOT_PREFLIGHT" });
    const { driver } = await openDriver(t, fixture, cloud);
    await assert.rejects(driver.ensureOccurrence(), (error) => error.code === code);
    assert.equal(fixture.state.scheduleReads, 1);
    assert.equal(fixture.state.scheduleMutations, 0);
    assert.equal(cloud.preflights, 0);
  });
}

test("screen variables that differ from the read are refused by the guard and never reach the supplier", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  fixture.state.screenTamper = (input) => { input.weekdays[0].timeSlots.push({ from: "18:00", to: null }); };
  const before = structuredClone(ourBlock(fixture));
  const { driver } = await openDriver(t, fixture, countingCloud());
  await assert.rejects(driver.ensureOccurrence(), (error) => error.code === "WRITE_REFUSED");
  assert.equal(fixture.state.scheduleMutations, 0);
  assert.equal(driver.guard.writes, 0);
  assert.deepEqual(ourBlock(fixture), before);
});

test("success=false with an unchanged re-read is SAVE_NOT_APPLIED", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  fixture.state.scheduleResponse = "success-false";
  const before = structuredClone(ourBlock(fixture));
  const { driver } = await openDriver(t, fixture, countingCloud());
  await assert.rejects(driver.ensureOccurrence(), (error) => error.code === "SAVE_NOT_APPLIED");
  assert.equal(fixture.state.scheduleMutations, 1);
  assert.deepEqual(ourBlock(fixture), before);
});

test("a lost save response is UNKNOWN_AFTER_SAVE after exactly one delivery", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  fixture.state.scheduleResponse = "lost";
  const { driver } = await openDriver(t, fixture, countingCloud());
  await assert.rejects(driver.ensureOccurrence(), (error) => error.code === "UNKNOWN_AFTER_SAVE");
  assert.equal(fixture.state.scheduleMutations, 1);
  assert.equal(driver.guard.writes, 1);
});

test("a stale preflight right before saving prevents the write", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  const cloud = countingCloud({ fail: "STALE_PREFLIGHT" });
  const { driver } = await openDriver(t, fixture, cloud);
  await assert.rejects(driver.ensureOccurrence(), (error) => error.code === "STALE_PREFLIGHT");
  assert.equal(cloud.preflights, 1);
  assert.equal(fixture.state.scheduleMutations, 0);
});

test("a different supplier account stops before any schedule read or write", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await fixtureWithSchedule(t);
  const job = makeJob(fixture.state, "ENSURE_OCCURRENCE");
  fixture.state.accountId = "99999";
  const { driver } = await openDriver(t, fixture, countingCloud({ fail: "MUST_NOT_PREFLIGHT" }), job);
  await assert.rejects(driver.ensureOccurrence(), (error) => error.code === "ACCOUNT_MISMATCH");
  assert.equal(fixture.state.scheduleReads, 0);
  assert.equal(fixture.state.scheduleMutations, 0);
});
