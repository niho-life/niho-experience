import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { assertProfileAccessAvailable } from "../src/profile-access-hold.mjs";
import { createViatorDriver } from "../src/viator-driver.mjs";
import { CHROME, syntheticViator } from "./helpers/synthetic-sites.mjs";

const requireBrowser = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync(CHROME)) { assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests"); t.skip("Selected Chrome executable is not installed."); return false; }
  return true;
};
const cloud = { async preflight(job) { return { ready: true, desiredState: job.desiredState }; } };

async function driverFor(fixture, action = "SET_CLOSED") {
  return createViatorDriver({ job: fixture.makeJob(action), cloud, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 500, writeResponseTimeoutMs: 500 });
}

for (const [name, mutate, reason] of [
  ["supplier document 403", (state) => { state.documentStatus = 403; }, "ACCESS_RESTRICTED"],
  ["availability API 429", (state) => { state.readStatus = 429; }, "RATE_LIMITED"],
  ["captcha iframe document", (state) => { state.challengeIframe = true; }, "BOT_CHALLENGE"],
  ["Japanese temporary restriction text", (state) => { state.restrictionText = "アクセスは一時的に制限されています"; }, "ACCESS_RESTRICTED"],
  ["Japanese robot restriction text", (state) => { state.restrictionText = "ロボットによるアクセスでないことを確認いたします。"; }, "BOT_CHALLENGE"],
]) test(`Viator local Chrome detects ${name}, persists hold and dispatches no save`, { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticViator(); t.after(() => fixture.close()); mutate(fixture.state);
  const profile = fixture.config.siteAccountProfiles.Viator[fixture.state.accountId];
  const driver = await driverFor(fixture); t.after(() => driver.stop());
  await assert.rejects(driver.observeTarget(), (error) => error.code === "SITE_ACCESS_RESTRICTED" && error.reasonCode === reason);
  const reads = fixture.state.reads.length;
  await assert.rejects(driver.applyDesiredState(), (error) => error.code === "SITE_ACCESS_RESTRICTED");
  assert.equal(fixture.state.reads.length, reads, "no new supplier read is dispatched after the hold");
  assert.equal(fixture.state.writes, 0);
  await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "PROFILE_ACCESS_HELD" && error.reasonCode === reason);
  assert.equal(await driver.stop(), true);
});

for (const status of [403, 429]) test(`Viator availability update ${status} preserves UNKNOWN_AFTER_SAVE and persists hold`, { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticViator(); t.after(() => fixture.close()); fixture.state.updateStatus = status;
  const profile = fixture.config.siteAccountProfiles.Viator[fixture.state.accountId];
  const driver = await driverFor(fixture); t.after(() => driver.stop());
  await assert.rejects(driver.applyDesiredState(), (error) => error.code === "UNKNOWN_AFTER_SAVE");
  const writes = fixture.state.writes;
  assert.equal(writes, 1);
  await assert.rejects(driver.applyDesiredState(), (error) => error.code === "SITE_ACCESS_RESTRICTED");
  assert.equal(fixture.state.writes, writes);
  await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "PROFILE_ACCESS_HELD"
    && error.reasonCode === (status === 429 ? "RATE_LIMITED" : "ACCESS_RESTRICTED"));
  assert.equal(await driver.stop(), true);
});

test("Viator ordinary captcha-delivery script/image is not a challenge", { timeout: 30_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticViator(); t.after(() => fixture.close()); fixture.state.ordinaryBotAssets = true;
  const profile = fixture.config.siteAccountProfiles.Viator[fixture.state.accountId];
  const driver = await driverFor(fixture, "OBSERVE"); t.after(() => driver.stop());
  const observed = await driver.observeTarget();
  assert.equal(observed.bookable, true);
  assert.equal(await assertProfileAccessAvailable(profile), true);
  assert.equal(fixture.state.writes, 0);
  assert.equal(await driver.stop(), true);
});
