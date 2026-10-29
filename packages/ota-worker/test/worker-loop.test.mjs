import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("an idle standalone worker stays alive for the next poll and exits normally on abort", { timeout: 25_000 }, async () => {
  const moduleUrl = new URL("../src/worker.mjs", import.meta.url).href;
  const source = `
    import { runWorkerLoop } from ${JSON.stringify(moduleUrl)};
    const controller = new AbortController();
    let polls = 0;
    const result = await runWorkerLoop({
      config: {}, journal: { current: null, async load() { return null; } },
      cloud: { async claimAllowIdle() { polls += 1; return null; } },
      signal: controller.signal, random: () => 0,
      onSummary(summary) {
        if (summary.status !== "IDLE") throw new Error("Expected idle");
        if (polls === 2) controller.abort();
      },
    });
    if (polls !== 2 || result.status !== "STOPPED") throw new Error("Worker did not stop cleanly");
    console.log("TWO_POLLS_STOPPED");
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], { timeout: 22_000 });
  assert.equal(result.stdout.trim(), "TWO_POLLS_STOPPED");
  assert.equal(result.stderr, "");
});
