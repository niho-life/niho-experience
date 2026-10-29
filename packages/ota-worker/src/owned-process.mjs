import { spawn } from "node:child_process";
import { ContractError } from "./validation.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function spawnOwned(executable, args, options = {}) {
  const child = spawn(executable, args, {
    detached: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env,
  });
  // A failed exec emits `error` on the next tick even when no PID was returned.
  child.on("error", () => {});
  if (!child.pid) throw new ContractError("PROCESS_START_FAILED");
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => { exited = true; exitCode = code; });

  const groupState = () => {
    try { process.kill(-child.pid, 0); return "ALIVE"; }
    catch (error) { return error?.code === "ESRCH" ? "GONE" : "UNKNOWN"; }
  };

  async function waitForStop(timeoutMs = 3_000) {
    const until = Date.now() + timeoutMs;
    while (groupState() !== "GONE" && Date.now() < until) await delay(25);
    return groupState() === "GONE";
  }

  async function stop(timeoutMs = 5_000) {
    try {
      if (groupState() === "GONE") return true;
      // macOS can briefly report EPERM while Chrome's group is being reaped.
      // Neither a failed signal nor an exited leader proves the group is gone.
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      if (await waitForStop(timeoutMs)) return true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      return await waitForStop(2_000);
    } catch {
      return false;
    }
  }

  return Object.freeze({ child, pid: child.pid, get exited() { return exited; }, get exitCode() { return exitCode; }, waitForStop, stop });
}
