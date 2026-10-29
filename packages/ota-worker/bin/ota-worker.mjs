#!/usr/bin/env node
import { loadConfig, readBearerToken } from "../src/config.mjs";
import { createCloudClient } from "../src/cloud-client.mjs";
import { createJournal } from "../src/journal.mjs";
import { acquireSingleInstance } from "../src/single-instance.mjs";
import { runWorkerLoop } from "../src/worker.mjs";
import { healthcheck } from "../src/healthcheck.mjs";

const index = process.argv.indexOf("--config");
if (index < 0 || index !== process.argv.length - 2) process.exit(2);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let lock;
try {
  const config = await loadConfig(process.argv[index + 1]);
  lock = await acquireSingleInstance(config.privateDir);
  await healthcheck(config, { signal: controller.signal });
  const token = await readBearerToken(config.tokenFile);
  const cloud = createCloudClient({ origin: config.cloudOrigin, token });
  const journal = createJournal(config.privateDir);
  const result = await runWorkerLoop({ cloud, config, journal, signal: controller.signal, onSummary: (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`) });
  if (result.status.startsWith("HALT_")) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "FAILED", code: String(error?.code ?? "WORKER_ERROR").slice(0, 80) })}\n`);
  process.exitCode = 1;
} finally {
  await lock?.release();
}
