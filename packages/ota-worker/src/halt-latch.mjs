import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateJson } from "./private-fs.mjs";

export function createHaltLatch(privateDir, now = () => new Date()) {
  const path = join(privateDir, "worker-halt.json");
  return Object.freeze({
    path,
    async read() {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        return value?.version === 1 && typeof value.reason === "string" ? value : { version: 1, reason: "INVALID_HALT_LATCH" };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        return { version: 1, reason: "INVALID_HALT_LATCH" };
      }
    },
    async set(reason) { await atomicPrivateJson(path, { version: 1, reason: String(reason).slice(0, 80), createdAtUtc: now().toISOString() }); },
    async clearExplicitly() { await unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; }); },
  });
}
