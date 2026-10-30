import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createAirbnbCalendarObserver } from "../src/airbnb-observer.mjs";
import { CHROME } from "./helpers/synthetic-gyg.mjs";
import { syntheticAirbnb } from "./helpers/synthetic-airbnb.mjs";

function requireBrowser(t) {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync(CHROME)) { assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests"); t.skip("Selected Chrome executable is not installed."); return false; }
  return true;
}

const readyCloud = (calls = []) => ({ async preflight(job) { calls.push(job.id); return { ready: true, desiredState: "OPEN" }; } });

test("Airbnb observer proves self ownership and performs a fresh OPEN/CLOSED cycle without writes", { timeout: 45_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close()); const preflights = [];
  const observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(preflights), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000 });
  const open = await observer.observeTarget();
  assert.equal(open.bookable, true); assert.equal(open.evidence, "EXACT_SLOT_V1"); assert.equal(open.partySize, 1);
  assert.equal(Object.hasOwn(open, "manuallyBlocked"), false); assert.ok(Object.isFrozen(open));
  fixture.state.isAvailable = false; fixture.state.remainingCapacity = 8;
  const closed = await observer.observeTarget();
  assert.equal(closed.bookable, false); assert.notEqual(closed.observedAtUtc, undefined);
  assert.equal(fixture.state.profileReads, 2); assert.equal(fixture.state.calendarReads, 2); assert.equal(fixture.state.serverWrites, 0);
  assert.equal(preflights.length, 4); assert.equal(observer.guard.writes, 0); assert.equal(observer.guard.profileReads, 2);
  assert.equal(await observer.stop(), true); assert.equal(await observer.stop(), true); assert.equal(observer.guard.frozen, true);
  assert.equal(Object.hasOwn(observer, "applyDesiredState"), false); assert.equal(Object.hasOwn(observer, "model"), false);
});

test("Airbnb observer stops an unfinished response body at the lease deadline", { timeout: 15_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close());
  fixture.state.hangProfileBody = true;
  const current = Date.now();
  const observer = await createAirbnbCalendarObserver({
    job: fixture.makeJob({ leaseExpiresAtUtc: new Date(current + 1_500).toISOString(), deadlineAtUtc: new Date(current + 3_000).toISOString() }),
    cloud: readyCloud(), config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000,
  });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "INVALID_JOB_DEADLINE");
  assert.equal(await observer.stop(), true);
  assert.equal(fixture.state.profileReads, 1);
  assert.equal(fixture.state.calendarReads, 0);
  assert.equal(fixture.state.serverWrites, 0);
});

test("Airbnb observer halts on wrong account and authentication challenge", { timeout: 45_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close());
  fixture.state.reportedAccountId = "7";
  let observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "ACCOUNT_MISMATCH");
  fixture.state.reportedAccountId = null; fixture.state.authenticated = false;
  observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 500 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "AUTH_REQUIRED");
  assert.equal(fixture.state.serverWrites, 0);
});

test("Airbnb observer requires preflight both before and after reads and an active deadline", { timeout: 45_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close());
  let observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: { async preflight() {
    return { ready: false, desiredState: "OPEN" };
  } }, config: fixture.config, testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true,
  browserFactory: fixture.browserFactory, responseTimeoutMs: 500 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "STALE_PREFLIGHT");
  assert.equal(fixture.state.profileReads, 0);
  let calls = 0;
  observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: { async preflight() {
    calls += 1; return calls === 1 ? { ready: true, desiredState: "OPEN" } : { ready: false, desiredState: "OPEN" };
  } }, config: fixture.config, testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true,
  browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "STALE_PREFLIGHT");
  let clockCalls = 0; const current = Date.now(); const job = fixture.makeJob({ leaseExpiresAtUtc: new Date(current + 60_000).toISOString(), deadlineAtUtc: new Date(current + 90_000).toISOString() });
  observer = await createAirbnbCalendarObserver({ job, cloud: readyCloud(), config: fixture.config,
    now: () => new Date(clockCalls++ === 0 ? current : current + 120_000), testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 500 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "INVALID_JOB_DEADLINE");
});

test("Airbnb guard blocks a malicious fixture POST and oversized calendar bodies fail closed", { timeout: 45_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close()); fixture.state.maliciousPost = true;
  let observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 1_000 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "UNSAFE_REQUEST");
  // Both the unrelated client-config POST and the malicious save are aborted.
  assert.equal(fixture.state.serverWrites, 0); assert.equal(observer.guard.writes, 0); assert.equal(observer.guard.writeAttempts, 2);
  fixture.state.maliciousPost = false; fixture.state.oversized = true;
  observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000 });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "DOM_DRIFT");
  assert.equal(fixture.state.serverWrites, 0);
});

test("Airbnb stop reports an unconfirmed managed-process stop without optimistic recovery", { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticAirbnb(); t.after(() => fixture.close()); fixture.state.stopResult = false;
  const observer = await createAirbnbCalendarObserver({ job: fixture.makeJob(), cloud: readyCloud(), config: fixture.config,
    testOnlySupplierOrigin: fixture.origin, allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
  assert.ok(Object.isFrozen(observer)); assert.ok(Object.isFrozen(observer.guard));
  assert.equal(await observer.stop(), false); assert.equal(await observer.stop(), false); assert.equal(observer.guard.frozen, true);
});
