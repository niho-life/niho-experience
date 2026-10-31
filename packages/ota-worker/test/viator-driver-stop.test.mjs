import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createViatorDriver } from "../src/viator-driver.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";

const state = { accountId: "999999", productId: "999999P1", optionId: "TG1", localDateTime: "2099-01-01T13:00:00" };
const target = Object.freeze({ site: "Viator", externalAccountId: state.accountId, externalProductId: state.productId,
  externalOptionId: state.optionId, timeZone: "Asia/Tokyo", adapter: "viator-browser", adapterVersion: "1", connectionMode: "BROWSER" });
const job = makeJob(state, "OBSERVE", { target });

function fakeBrowser() {
  const page = new EventEmitter();
  page.setDefaultTimeout = () => {};
  page.frames = () => [page];
  page.url = () => "about:blank";
  const context = new EventEmitter();
  context.route = async () => {};
  context.pages = () => [page];
  context.newCDPSession = async () => ({ async send() {} });
  context.addInitScript = async () => {};
  let stops = 0;
  return {
    value: { pid: 123, context, async stop() { stops += 1; return true; } },
    get stops() { return stops; },
  };
}

const config = { browserExecutable: "/synthetic/chrome", siteAccountProfiles: { Viator: { [state.accountId]: "/synthetic/profile" } },
  privateDir: "/synthetic", debugScreenshots: false };
const cloud = { async preflight() {} };

test("driver stop always stops owned Chrome when monitor stop fails", async () => {
  const browser = fakeBrowser();
  const driver = await createViatorDriver({ job, cloud, config, browserFactory: async () => browser.value,
    accessMonitorFactory: () => ({ async assertAvailable() { return true; }, async stop() { throw new Error("persist failed"); } }) });
  assert.equal(await driver.stop(), true);
  assert.equal(browser.stops, 1);
  assert.equal(await driver.stop(), true);
  assert.equal(browser.stops, 1);
});

test("driver setup catch always stops owned Chrome", async () => {
  const browser = fakeBrowser();
  await assert.rejects(createViatorDriver({ job, cloud, config, browserFactory: async () => browser.value,
    accessMonitorFactory: () => { throw new Error("monitor setup failed"); } }), /monitor setup failed/);
  assert.equal(browser.stops, 1);
});


test("owned Chrome stops while monitor persistence is still pending", async () => {
  const browser = fakeBrowser();
  let release;
  const persistence = new Promise((resolve) => { release = resolve; });
  const driver = await createViatorDriver({ job, cloud, config, browserFactory: async () => browser.value,
    accessMonitorFactory: () => ({ async assertAvailable() { return true; }, async stop() { await persistence; } }) });
  const stopping = driver.stop();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browser.stops, 1, "disk persistence must not delay the owned process stop");
  } finally { release(); }
  assert.equal(await stopping, true);
});
