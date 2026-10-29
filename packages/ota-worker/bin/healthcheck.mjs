#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { healthcheck } from "../src/healthcheck.mjs";

const index = process.argv.indexOf("--config");
if (index < 0 || index !== process.argv.length - 2) process.exit(2);
try {
  const result = await healthcheck(await loadConfig(process.argv[index + 1]));
  process.stdout.write(`${JSON.stringify({ status: "OK", ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "FAILED", code: String(error?.code ?? "HEALTHCHECK_FAILED").slice(0, 80) })}\n`);
  process.exitCode = 1;
}
