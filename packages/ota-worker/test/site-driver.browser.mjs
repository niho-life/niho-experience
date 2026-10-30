import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createViatorDriver } from "../src/viator-driver.mjs";
import { createJalanDriver } from "../src/jalan-driver.mjs";
import { CHROME, syntheticJalan, syntheticViator } from "./helpers/synthetic-sites.mjs";

const requireBrowser = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync(CHROME)) { assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests"); t.skip("Selected Chrome executable is not installed."); return false; }
  return true;
};
const cloud = { async preflight(job) { return { ready: true, desiredState: job.desiredState }; } };

for (const definition of [
  { name: "Viator", fixture: syntheticViator, create: createViatorDriver, isClosed: (state) => state.availability === "SOLD_OUT" },
  { name: "Jalan", fixture: syntheticJalan, create: createJalanDriver, isClosed: (state) => !state.open },
]) {
  test(`${definition.name} synthetic browser stops, reopens and independently verifies after reload`, { timeout: 90_000 }, async (t) => {
    if (!requireBrowser(t)) return;
    const fixture = await definition.fixture(); t.after(() => fixture.close());
    if (definition.name === "Jalan") fixture.state.renderDelayMs = 125;
    for (const action of ["SET_CLOSED", "SET_OPEN"]) {
      const job = fixture.makeJob(action);
      const driver = await definition.create({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
        allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 1_000, writeResponseTimeoutMs: 1_000 });
      const applied = await driver.applyDesiredState();
      const verified = await driver.verifyAfterReload();
      assert.equal(applied.changed, true); assert.equal(verified.manuallyBlocked, action === "SET_CLOSED");
      assert.equal(await driver.stop(), true);
    }
    assert.equal(fixture.state.writes, 2); assert.equal(definition.isClosed(fixture.state), false);
    if (definition.name === "Viator") {
      assert.deepEqual(fixture.state.requests[0].availabilityListState.perDayPagination, { "2099-01-01": { cursor: 1, hasMore: false } });
      assert.ok(fixture.state.requests.every((body) => body.availabilityKeys.length === 1 && body.availabilityKeys[0].startTime === "13:00:00"));
    }
    assert.ok(fixture.state.reads.some((read) => definition.name === "Jalan"
      ? read.dspBaseDate === "" : read.startDate === fixture.state.initialDate));
    assert.ok(fixture.state.reads.some((read) => read.jumpToDate === "2099-01-01")
      || fixture.state.reads.some((read) => read.dspBaseDate === "20990101"));
  });

  for (const responseFailure of ["drop", "500"]) test(`${definition.name} ${responseFailure} ACK dispatches one UI SET and converges only through new readback`, { timeout: 45_000 }, async (t) => {
    if (!requireBrowser(t)) return;
    const fixture = await definition.fixture(); t.after(() => fixture.close()); fixture.state.responseFailure = responseFailure;
    const job = fixture.makeJob("SET_CLOSED");
    const driver = await definition.create({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
      allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 1_000, writeResponseTimeoutMs: 1_000 }); t.after(() => driver.stop());
    const applied = await driver.applyDesiredState();
    assert.equal(applied.observation.manuallyBlocked, true); assert.equal(driver.guard.writes, 1);
    // Native Chrome can replay an identical POST below interception when the
    // socket drops. Every received body must still be the exact same SET.
    if (definition.name === "Viator" && responseFailure === "drop") {
      assert.ok(fixture.state.writes >= 1);
      for (const request of fixture.state.requests) assert.deepEqual(request, fixture.state.requests[0]);
    } else assert.equal(fixture.state.writes, 1);
    const writesAfterReadback = fixture.state.writes;
    assert.equal(applied.responseObserved, false);
    await driver.verifyAfterReload(); assert.equal(fixture.state.writes, writesAfterReadback);
  });

  test(`${definition.name} wrong account, target drift and auth expiry stop before any write`, { timeout: 45_000 }, async (t) => {
    if (!requireBrowser(t)) return;
    const fixture = await definition.fixture(); t.after(() => fixture.close());
    const originalAccount = fixture.state.accountId;
    const originalProduct = fixture.state.productId;
    const cases = definition.name === "Viator"
      ? [["ACCOUNT_MISMATCH", () => { fixture.state.accountId = "888888"; }], ["DOM_DRIFT", () => { fixture.state.productId = "888888P2"; }], ["AUTH_REQUIRED", () => { fixture.state.authenticated = false; }], ["PRODUCT_MISMATCH", () => { fixture.state.duplicateTargetRow = true; }]]
      : [["ACCOUNT_MISMATCH", () => { fixture.state.accountId = "OtherAirId"; }], ["DOM_DRIFT", () => { fixture.state.productId = "l999999999"; }], ["AUTH_REQUIRED", () => { fixture.state.authenticated = false; }]];
    for (const [code, mutate] of cases) {
      fixture.state.accountId = originalAccount; fixture.state.productId = originalProduct; fixture.state.authenticated = true; fixture.state.duplicateTargetRow = false;
      const job = fixture.makeJob("SET_CLOSED"); mutate();
      const driver = await definition.create({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
        allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 500, writeResponseTimeoutMs: 500 });
      await assert.rejects(driver.observeTarget(), (error) => error.code === code);
      await driver.stop();
    }
    assert.equal(fixture.state.writes, 0);
  });
}
