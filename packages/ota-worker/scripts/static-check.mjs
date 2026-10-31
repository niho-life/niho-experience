import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (packageJson.type !== "module" || packageJson.engines.node !== "24.x" || packageJson.dependencies["playwright-core"] !== "1.56.1") {
  throw new Error("package metadata drift");
}
await Promise.all([
  "src/index.mjs", "src/supervisor.mjs", "src/driver-registry.mjs", "src/gyg-driver.mjs", "src/viator-driver.mjs", "src/jalan-driver.mjs",
  "src/airbnb-observer.mjs", "src/airbnb-protocol.mjs", "src/airbnb-network-guard.mjs",
  "src/network-guard.mjs", "src/viator-network-guard.mjs", "src/jalan-network-guard.mjs", "src/worker.mjs",
  "src/mcp-stdio.mjs", "src/healthcheck.mjs", "src/reservation-executor.mjs", "src/reservation-reader-registry.mjs",
  "src/gyg-reservation-reader.mjs", "src/gyg-reservation-protocol.mjs", "src/gyg-schedule-protocol.mjs", "src/gyg-ensure-occurrence.mjs",
  "src/browser-driver-common.mjs",
].map((path) => import(join(root, path))));
