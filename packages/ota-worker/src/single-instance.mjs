import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ContractError, exactKeys } from "./validation.mjs";

function processStartToken(pid) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(null); return; }
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => { if (size < 512) chunks.push(chunk); size += chunk.length; });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").trim() || null : null));
  });
}

async function ownerAlive(owner) {
  if (!exactKeys(owner, ["pid", "startToken", "instanceId"]) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); } catch { return false; }
  return await processStartToken(owner.pid) === owner.startToken;
}

export async function acquireSingleInstance(privateDir) {
  const path = join(privateDir, "worker.lock");
  const startToken = await processStartToken(process.pid);
  if (!startToken) throw new ContractError("LOCK_UNAVAILABLE");
  const owner = { pid: process.pid, startToken, instanceId: randomUUID() };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    let released = false;
    return Object.freeze({
      owner,
      async release() {
        if (released) return;
        released = true;
        let current;
        try { current = JSON.parse(await readFile(path, "utf8")); } catch { return; }
        if (current.instanceId === owner.instanceId) await unlink(path).catch(() => {});
      },
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try { existing = JSON.parse(await readFile(path, "utf8")); } catch { existing = null; }
    throw new ContractError(existing && await ownerAlive(existing) ? "ALREADY_RUNNING" : "STALE_LOCK_NEEDS_REVIEW");
  }
}

export const singleInstanceInternals = Object.freeze({ processStartToken, ownerAlive });
