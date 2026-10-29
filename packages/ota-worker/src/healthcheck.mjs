import { createRequire } from "node:module";
import { spawnOwned } from "./owned-process.mjs";
import { CHROME_VERSION, CLAUDE_VERSION, PLAYWRIGHT_VERSION } from "./constants.mjs";
import { ContractError } from "./validation.mjs";

const require = createRequire(import.meta.url);

async function versionOutput(executable, { signal, timeoutMs = 10_000 } = {}) {
  if (signal?.aborted) throw new ContractError("VERSION_CHECK_ABORTED");
  const owned = spawnOwned(executable, ["--version"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, LANG: "en_US.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let size = 0;
  owned.child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 4096) chunks.push(chunk); });
  let timer;
  const abort = () => { void owned.stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  const code = await Promise.race([
    new Promise((resolve, reject) => { owned.child.once("error", reject); owned.child.once("close", resolve); }),
    new Promise((_, reject) => { timer = setTimeout(() => { void owned.stop(); reject(new ContractError("VERSION_CHECK_TIMEOUT")); }, timeoutMs); timer.unref?.(); }),
  ]).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  const stopped = await owned.stop();
  if (signal?.aborted || !stopped || code !== 0 || size > 4096) throw new ContractError("VERSION_CHECK_FAILED");
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function healthcheck(config, options = {}) {
  const playwright = require("playwright-core/package.json").version;
  if (process.versions.node.split(".")[0] !== "24" || playwright !== PLAYWRIGHT_VERSION) throw new ContractError("RUNTIME_VERSION_MISMATCH");
  const browser = await versionOutput(config.browserExecutable, options);
  if (!browser.includes(CHROME_VERSION)) throw new ContractError("BROWSER_VERSION_MISMATCH");
  let claude = null;
  if (config.mode === "claude-code") {
    claude = await versionOutput(config.claudeExecutable, options);
    if (!claude.startsWith(CLAUDE_VERSION)) throw new ContractError("CLAUDE_VERSION_MISMATCH");
  }
  return Object.freeze({ nodeMajor: 24, playwright, chrome: CHROME_VERSION, claude: claude ? CLAUDE_VERSION : null });
}
