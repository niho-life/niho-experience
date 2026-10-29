import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createGygDriver } from "../src/gyg-driver.mjs";
import { syntheticGyg, makeJob } from "./helpers/synthetic-gyg.mjs";

const requireBrowser = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) { t.skip("Pinned Studio Chrome is not installed on this runner."); return false; }
  return true;
};

test("synthetic browser alternates 20 OPEN/CLOSED jobs with reload verification", { timeout: 120_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  const cloud = { async preflight(job) { return { ready: true, desiredState: job.desiredState }; } };
  for (let index = 0; index < 20; index += 1) {
    const action = index % 2 === 0 ? "SET_CLOSED" : "SET_OPEN";
    const job = makeJob(fixture.state, action);
    const driver = await createGygDriver({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
      allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
    const applied = await driver.applyDesiredState();
    const observed = await driver.verifyAfterReload();
    assert.equal(observed.manuallyBlocked, action === "SET_CLOSED");
    assert.equal(applied.observation.sourceEndAtUtc, job.sourceEndAtUtc);
    assert.equal(await driver.stop(), true);
  }
  assert.equal(fixture.state.writes, 20);
});

test("lost save response is resolved by readback without duplicate write", { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  fixture.state.failAfterSave = true;
  const job = makeJob(fixture.state, "SET_CLOSED");
  const cloud = { async preflight() { return { ready: true, desiredState: "CLOSED" }; } };
  const driver = await createGygDriver({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
  const applied = await driver.applyDesiredState();
  assert.equal(applied.observation.manuallyBlocked, true);
  assert.equal(fixture.state.writes, 1);
  await driver.verifyAfterReload();
  assert.equal(fixture.state.writes, 1);
  await driver.stop();
});

test("wrong account, product, target time and auth expiry halt before write", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  const cloud = { async preflight() { throw new Error("must not preflight"); } };
  const cases = [
    ["ACCOUNT_MISMATCH", () => { fixture.state.accountId = "99999"; }],
    ["PRODUCT_MISMATCH", () => { fixture.state.productId = "99999"; }],
    ["DOM_DRIFT", () => { fixture.state.localDateTime = "2099-01-01T14:00:00"; }],
    ["AUTH_REQUIRED", () => { fixture.state.authenticated = false; }],
  ];
  for (const [code, mutate] of cases) {
    fixture.state.accountId = "10001"; fixture.state.productId = "20002"; fixture.state.localDateTime = "2099-01-01T13:00:00"; fixture.state.authenticated = true;
    const job = makeJob(fixture.state, "SET_CLOSED");
    mutate();
    const driver = await createGygDriver({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
      allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
    await assert.rejects(driver.observeTarget(), (error) => error.code === code);
    await driver.stop();
  }
  assert.equal(fixture.state.writes, 0);
});

test("stale cloud preflight prevents the UI write", { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  const job = makeJob(fixture.state, "SET_CLOSED");
  const cloud = { async preflight() { const error = new Error("stale"); error.code = "STALE_PREFLIGHT"; throw error; } };
  const driver = await createGygDriver({ job, cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
  await assert.rejects(driver.applyDesiredState(), (error) => error.code === "STALE_PREFLIGHT");
  assert.equal(fixture.state.writes, 0);
  await driver.stop();
});
