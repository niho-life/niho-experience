import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stopManagedBrowser } from "../src/managed-browser.mjs";
import { spawnOwned } from "../src/owned-process.mjs";

const needsProcess = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Seatbelt blocks child process control; verified by main and CI."); return false; }
  return true;
};

test("unresponsive CDP close cannot prevent the owned process group from stopping", { timeout: 20_000 }, async (t) => {
  if (!needsProcess(t)) return;
  const owned = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
  t.after(() => owned.stop());
  const browser = { close: () => new Promise(() => {}) };
  assert.equal(await stopManagedBrowser(browser, owned, 10), true);
  assert.throws(() => process.kill(-owned.pid, 0), (error) => error.code === "ESRCH");
});

test("close failure cannot turn an unconfirmed process stop into success", async () => {
  let attempts = 0;
  const browser = { close: async () => { throw new Error("synthetic CDP failure"); } };
  assert.equal(await stopManagedBrowser(browser, { stop: async () => { attempts += 1; return false; } }, 10), false);
  assert.equal(attempts, 1);
});

test("owned Chrome receives a graceful close and a passive exit window before forced stop", async () => {
  const order = [];
  const browser = {
    async newBrowserCDPSession() { return { async send(method) { order.push(method); } }; },
    async close() { throw new Error("transport disconnect is not a Chrome shutdown"); },
  };
  const owned = {
    async waitForStop(ms) { assert.equal(ms, 25); order.push("wait"); return true; },
    async stop() { order.push("stop-proof"); return true; },
  };
  assert.equal(await stopManagedBrowser(browser, owned, 10, 25), true);
  assert.deepEqual(order, ["Browser.close", "wait", "stop-proof"]);
});

test("a hung graceful close still reaches the independent process stop", async () => {
  let waits = 0;
  let stops = 0;
  const browser = { newBrowserCDPSession: () => new Promise(() => {}) };
  const owned = {
    async waitForStop() { waits += 1; return false; },
    async stop() { stops += 1; return false; },
  };
  assert.equal(await stopManagedBrowser(browser, owned, 10, 10), false);
  assert.equal(waits, 1);
  assert.equal(stops, 1);
});

test("passive process waiting does not send a signal", async (t) => {
  if (!needsProcess(t)) return;
  const owned = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
  t.after(() => owned.stop());
  assert.equal(await owned.waitForStop(25), false);
  assert.doesNotThrow(() => process.kill(owned.pid, 0));
  assert.equal(await owned.stop(), true);
  assert.equal(await owned.waitForStop(25), true);
});

test("a missing executable reports a controlled error without a late unhandled event", async (t) => {
  if (!needsProcess(t)) return;
  assert.throws(() => spawnOwned(`/tmp/niho-ota-missing-${randomUUID()}`, []), (error) => error.code === "PROCESS_START_FAILED");
  await new Promise((resolve) => setImmediate(resolve));
});
