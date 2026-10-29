import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstance } from "../src/single-instance.mjs";

test("OS lock rejects the live PID/start token and can be reacquired after release", async (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks child-process start-token inspection."); return; }
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-lock-"));
  const first = await acquireSingleInstance(directory);
  await assert.rejects(acquireSingleInstance(directory), (error) => error.code === "ALREADY_RUNNING");
  await first.release();
  const second = await acquireSingleInstance(directory);
  await second.release();
});

test("invalid stale lock requires manual recovery and is never unlinked", async (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks child-process start-token inspection."); return; }
  const directory = await mkdtemp(join(tmpdir(), "niho-ota-stale-lock-"));
  await writeFile(join(directory, "worker.lock"), '{"pid":999999,"bootToken":"old","startToken":"old","instanceId":"old"}\n', { mode: 0o600 });
  await assert.rejects(acquireSingleInstance(directory), (error) => error.code === "STALE_LOCK_NEEDS_REVIEW");
});
