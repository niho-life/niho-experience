import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnOwned } from "../src/owned-process.mjs";

async function exitedOwnedProcess(t) {
  if (process.env.CODEX_SANDBOX === "seatbelt") {
    t.skip("Seatbelt blocks owned process-group control.");
    return null;
  }
  const owned = spawnOwned(process.execPath, ["-e", ""]);
  if (!owned.exited) await once(owned.child, "exit");
  return owned;
}

for (const operation of ["waitForStop", "stop"]) {
  test(`${operation} waits through transient EPERM and still requires a real missing group`, async (t) => {
    const owned = await exitedOwnedProcess(t);
    if (!owned) return;
    const actualKill = process.kill;
    let unknownProbes = 0;
    let missingProbes = 0;
    t.mock.method(process, "kill", function (pid, signal) {
      if (pid === -owned.pid && signal === 0) {
        if (unknownProbes < 2) {
          unknownProbes += 1;
          throw Object.assign(new Error("unconfirmed"), { code: "EPERM" });
        }
        try { return actualKill.call(process, pid, signal); }
        catch (error) { if (error.code === "ESRCH") missingProbes += 1; throw error; }
      }
      return actualKill.call(process, pid, signal);
    });
    try {
      assert.equal(await owned[operation](250), true);
      assert.equal(unknownProbes, 2);
      assert.ok(missingProbes > 0);
    } finally {
      t.mock.restoreAll();
      assert.equal(await owned.stop(), true);
    }
  });
}

test("persistent EPERM cannot become stop proof, including after signals report ESRCH", async (t) => {
  const owned = await exitedOwnedProcess(t);
  if (!owned) return;
  const actualKill = process.kill;
  t.mock.method(process, "kill", function (pid, signal) {
    if (pid === -owned.pid && signal === 0) throw Object.assign(new Error("unconfirmed"), { code: "EPERM" });
    return actualKill.call(process, pid, signal);
  });
  try {
    assert.equal(await owned.waitForStop(25), false);
    assert.equal(await owned.stop(25), false);
  } finally {
    t.mock.restoreAll();
    assert.equal(await owned.stop(), true);
  }
});
