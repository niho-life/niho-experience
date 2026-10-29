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

  const groupAlive = () => {
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  };

  async function stop(timeoutMs = 5_000) {
    try {
      if (!groupAlive()) return true;
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") return false; }
      const until = Date.now() + timeoutMs;
      while (groupAlive() && Date.now() < until) await delay(25);
      if (!groupAlive()) return true;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") return false; }
      const killUntil = Date.now() + 2_000;
      while (groupAlive() && Date.now() < killUntil) await delay(25);
      return !groupAlive();
    } catch {
      return false;
    }
  }

  return Object.freeze({ child, pid: child.pid, get exited() { return exited; }, get exitCode() { return exitCode; }, stop });
}
