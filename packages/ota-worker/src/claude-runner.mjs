import { join } from "node:path";
import { atomicPrivateJson } from "./private-fs.mjs";
import { spawnOwned } from "./owned-process.mjs";
import { CLAUDE_VERSION, TOOL_NAMES } from "./constants.mjs";
import { ContractError, isPlainObject } from "./validation.mjs";

const MAX_OUTPUT = 128 * 1024;
const FORBIDDEN_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/;

export function minimalClaudeEnv(source = process.env) {
  const forbidden = Object.keys(source).filter((key) => FORBIDDEN_ENV.test(key) && source[key]);
  if (forbidden.length) throw new ContractError("API_FALLBACK_REFUSED");
  if (typeof source.HOME !== "string" || source.HOME.length < 1) throw new ContractError("CLAUDE_HOME_REQUIRED");
  return Object.freeze({
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: source.HOME,
    TMPDIR: source.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
  });
}

export function claudeArgv(mcpConfigPath) {
  return [
    "--restricted",
    "--setting-sources", "",
    "--settings", '{"disableAllHooks":true}',
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", mcpConfigPath,
    "--allowedTools", ...TOOL_NAMES.map((name) => `mcp__niho_ota__${name}`),
    "--max-turns", "8",
    "--no-session-persistence",
    "--output-format", "json",
    "--print",
  ];
}

export function validateClaudeAuthStatus(value) {
  if (!isPlainObject(value) || value.loggedIn !== true || value.authMethod !== "claude.ai" || value.apiProvider !== "firstParty"
    || String(value.subscriptionType).toLowerCase() !== "max") throw new ContractError("CLAUDE_AUTH_REQUIRED");
  return true;
}

function collect(child, { signal, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new ContractError("CLAUDE_ABORTED"));
    const timer = setTimeout(() => finish(new ContractError("CLAUDE_TIMEOUT")), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) { finish(new ContractError("CLAUDE_ABORTED")); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { finish(new ContractError("CLAUDE_OUTPUT_TOO_LARGE")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", append(stdout));
    child.stderr.on("data", append(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(null, { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function withStopped(error, stopped) {
  const failure = error instanceof Error ? error : new ContractError("CLAUDE_FAILED");
  failure.stopped = stopped === true;
  return failure;
}

export async function verifyClaudeAuth({ executable, env, signal, spawnFactory = spawnOwned, timeoutMs = 10_000 }) {
  if (signal?.aborted) throw withStopped(new ContractError("CLAUDE_ABORTED"), true);
  const owned = spawnFactory(executable, ["auth", "status", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output;
  try { output = await collect(owned.child, { signal, timeoutMs }); }
  catch (error) { throw withStopped(error, await owned.stop()); }
  const stopped = await owned.stop();
  if (!stopped || output.code !== 0) throw withStopped(new ContractError("CLAUDE_AUTH_REQUIRED"), stopped);
  let value;
  try { value = JSON.parse(output.stdout); } catch { throw withStopped(new ContractError("CLAUDE_AUTH_REQUIRED"), stopped); }
  try { return validateClaudeAuthStatus(value); }
  catch (error) { throw withStopped(error, stopped); }
}

export async function runClaude({ config, socketPath, signal, spawnFactory = spawnOwned, verifyAuth = verifyClaudeAuth }) {
  if (signal.aborted) throw withStopped(new ContractError("CLAUDE_ABORTED"), true);
  const env = minimalClaudeEnv();
  await verifyAuth({ executable: config.claudeExecutable, env, signal, spawnFactory });
  if (signal.aborted) throw withStopped(new ContractError("CLAUDE_ABORTED"), true);
  const mcpPath = join(config.privateDir, "claude-mcp.json");
  await atomicPrivateJson(mcpPath, { mcpServers: { niho_ota: { command: process.execPath, args: [join(import.meta.dirname, "../bin/ota-mcp.mjs"), "--socket", socketPath] } } });
  if (signal.aborted) throw withStopped(new ContractError("CLAUDE_ABORTED"), true);
  const owned = spawnFactory(config.claudeExecutable, claudeArgv(mcpPath), { env, stdio: ["pipe", "pipe", "pipe"] });
  let stopPromise = null;
  const stop = () => { stopPromise ??= owned.stop(); return stopPromise; };
  const onAbort = () => { void stop(); };
  signal.addEventListener("abort", onAbort, { once: true });
  const prompt = "Use only the three NIHO OTA tools. Observe the immutable target, apply the desired state if the tool permits it, then verify after reload. Your prose is not evidence; the supervisor independently verifies.";
  owned.child.stdin.end(prompt);
  let output;
  try { output = await collect(owned.child, { signal, timeoutMs: 180_000 }); }
  catch (error) { throw withStopped(error, await stop()); }
  finally { signal.removeEventListener("abort", onAbort); }
  const stopped = await stop();
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/weekly limit|rate limit|usage limit/i.test(combined)) return { status: "RATE", stopped };
  if (/authentication|not logged in|unauthorized/i.test(combined)) return { status: "AUTH", stopped };
  if (output.code !== 0) return { status: "FAILED", stopped };
  return { status: "DONE", stopped };
}

export async function assertClaudeVersion(executable, env = minimalClaudeEnv(), { signal, timeoutMs = 10_000 } = {}) {
  if (signal?.aborted) throw withStopped(new ContractError("CLAUDE_ABORTED"), true);
  const owned = spawnOwned(executable, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output;
  try { output = await collect(owned.child, { signal, timeoutMs }); }
  catch (error) { throw withStopped(error, await owned.stop()); }
  const stopped = await owned.stop();
  if (!stopped || output.code !== 0 || !output.stdout.trim().startsWith(CLAUDE_VERSION)) {
    throw withStopped(new ContractError("CLAUDE_VERSION_MISMATCH"), stopped);
  }
}

export const claudeRunnerInternals = Object.freeze({ collect, FORBIDDEN_ENV });
