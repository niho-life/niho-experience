import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAirbnbCalendarObserver } from "../src/airbnb-observer.mjs";
import { createCloudClient } from "../src/cloud-client.mjs";
import { createJournal } from "../src/journal.mjs";
import { executeJob } from "../src/supervisor.mjs";
import { runWorkerOnce } from "../src/worker.mjs";
import { syntheticAirbnb } from "./helpers/synthetic-airbnb.mjs";
import { CHROME } from "./helpers/synthetic-gyg.mjs";

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function requireBrowser(t) {
  if (process.env.CODEX_SANDBOX === "seatbelt") {
    t.skip("Codex seatbelt blocks Chrome/listen process control; run on the reviewed Studio executor."); return false;
  }
  if (!existsSync(CHROME)) {
    assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests");
    t.skip("Selected Chrome executable is not installed."); return false;
  }
  return true;
}

for (const scenario of [
  { name: "SET OPEN matches", action: "SET_OPEN", desired: "OPEN", bookable: true, outcome: "VERIFIED" },
  { name: "SET CLOSED matches", action: "SET_CLOSED", desired: "CLOSED", bookable: false, outcome: "VERIFIED" },
  { name: "SET CLOSED waits", action: "SET_CLOSED", desired: "CLOSED", bookable: true, outcome: "RETRY_WAIT" },
  { name: "due OBSERVE waits", action: "OBSERVE", desired: "OPEN", bookable: false, outcome: "RETRY_WAIT" },
]) {
test(`real cloud claim, native Chrome, journal, and typed result: ${scenario.name}`,
  { timeout: 45_000 }, async (t) => {
    if (!requireBrowser(t)) return;
    const fixture = await syntheticAirbnb(); t.after(() => fixture.close());
    fixture.state.isAvailable = scenario.bookable;
    const claimed = fixture.makeJob({ action: scenario.action,
      ...(scenario.action === "OBSERVE" ? { googleDeliveryOperation: "observe" } : {}) });
    const deliveryId = randomUUID();
    const operations = []; let selectedBody; let observer;
    const cloud = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/google-sync")) return json({ processed: false, applied: false });
      if (path.endsWith("/claim")) return json({ job: claimed });
      if (path.endsWith("/preflight")) return json({ ready: true, desiredState: scenario.desired });
      if (path.endsWith("/renew")) return json({ leaseExpiresAtUtc: new Date(Date.now() + 120_000).toISOString() });
      if (path.endsWith("/google-delivery")) { operations.push(JSON.parse(init.body).operation); return json({ deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" }); }
      if (path.endsWith("/result")) {
        assert.equal(observer.guard.frozen, true);
        selectedBody = JSON.parse(init.body);
        return json({ acceptedAsCurrent: scenario.outcome === "VERIFIED", repeated: false });
      }
      throw new Error(`unexpected ${path}`);
    } });
    const directory = await mkdtemp(join(tmpdir(), "niho-google-airbnb-browser-"));
    const journal = createJournal(directory);
    const config = { ...fixture.config, privateDir: directory, googleDeliveryEnabled: true, googleAirbnbObservationEnabled: true };
    const result = await runWorkerOnce({ cloud, config, journal, executor: (options) => executeJob({ ...options,
      airbnbObserverFactory: async (factoryOptions) => {
        observer = await createAirbnbCalendarObserver({ ...factoryOptions, testOnlySupplierOrigin: fixture.origin,
          allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory, responseTimeoutMs: 2_000 });
        return observer;
      },
    }) });
    assert.equal(result.status, scenario.outcome === "VERIFIED" ? "RESULT_ACKNOWLEDGED" : "RESULT_ACKNOWLEDGED_NOT_CURRENT");
    assert.equal(result.outcome, scenario.outcome);
    assert.equal(result.stopped, true); assert.equal(result.modelInvocations, 0);
    assert.deepEqual(operations, scenario.action === "OBSERVE" ? ["observe"] : ["dispatch", "observe"]);
    assert.equal(fixture.state.profileReads, 1); assert.equal(fixture.state.calendarReads, 1);
    assert.equal(fixture.state.serverWrites, 0); assert.equal(observer.guard.writes, 0); assert.equal(observer.guard.frozen, true);
    assert.equal(selectedBody.googleAirbnbProof.deliveryId, deliveryId);
    assert.equal(selectedBody.observedBookable, scenario.bookable);
    assert.equal(selectedBody.observedState, scenario.bookable ? "OPEN" : "CLOSED");
    assert.equal(Object.hasOwn(selectedBody, "observedManuallyBlocked"), false);
    assert.equal(journal.current, null);
    assert.equal(existsSync(join(directory, "worker-halt.json")), false);
  });
}
