import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeArgv, minimalClaudeEnv, validateClaudeAuthStatus } from "../src/claude-runner.mjs";
import { mcpRpcInternals } from "../src/mcp-rpc.mjs";

test("Claude argv is restricted to the reviewed flags and three fixed MCP names", () => {
  const argv = claudeArgv("/private/config.json");
  assert.deepEqual(argv.slice(0, 12), ["--restricted", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--tools", "", "--strict-mcp-config", "--mcp-config", "/private/config.json", "--allowedTools", "mcp__niho_ota__observe_target"]);
  assert.equal(argv.includes("mcp__niho_ota__apply_desired_state"), true);
  assert.equal(argv.includes("mcp__niho_ota__verify_after_reload"), true);
  assert.equal(argv.includes("--bare"), false);
  assert.equal(argv.includes("--max-turns"), true);
  assert.equal(argv.includes("8"), true);
  assert.equal(argv.includes("--no-session-persistence"), true);
});

test("Claude child environment is minimal and refuses API-key fallback", () => {
  const env = minimalClaudeEnv({ HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp", PATH: "/untrusted" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TERM", "TMPDIR"]);
  assert.equal(env.PATH.includes("untrusted"), false);
  assert.throws(() => minimalClaudeEnv({ HOME: "/synthetic", ANTHROPIC_API_KEY: "secret" }), (error) => error.code === "API_FALLBACK_REFUSED");
  assert.throws(() => minimalClaudeEnv({ HOME: "/synthetic", CLAUDE_CODE_OAUTH_TOKEN: "secret" }), (error) => error.code === "API_FALLBACK_REFUSED");
});

test("Claude auth status accepts only claude.ai first-party Max", () => {
  assert.equal(validateClaudeAuthStatus({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
    analyticsDisabled: false, projectsDirectory: "/synthetic/projects", configDirectory: "/synthetic/config", email: null, orgId: null, orgName: null,
    benignFutureMetadata: { synthetic: true } }), true);
  for (const value of [
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", subscriptionType: "max" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "thirdParty", subscriptionType: "max" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" },
  ]) assert.throws(() => validateClaudeAuthStatus(value), (error) => error.code === "CLAUDE_AUTH_REQUIRED");
});

test("minimal Claude environment preserves login identity without copying arbitrary credentials", () => {
  const env = minimalClaudeEnv({ HOME: "/synthetic/home", USER: "synthetic", LOGNAME: "synthetic", SHELL: "/bin/zsh",
    WORKER_BEARER: "synthetic-private-value", SSH_AUTH_SOCK: "/synthetic/agent.sock" });
  assert.equal(env.USER, "synthetic"); assert.equal(env.LOGNAME, "synthetic"); assert.equal(env.SHELL, "/bin/zsh");
  assert.equal("WORKER_BEARER" in env, false); assert.equal("SSH_AUTH_SOCK" in env, false);
});

function runMcp(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/ota-mcp.mjs", import.meta.url)), "--socket", "/tmp/unused-niho-ota-test.sock"], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH },
    });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolve({ code, output }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("MCP lists only empty-argument tools and aborts unknown arguments", async () => {
  const listed = await runMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(listed.code, 0);
  const tools = JSON.parse(listed.output).result.tools;
  assert.equal(tools.length, 3);
  assert.equal(tools.every((tool) => tool.inputSchema.additionalProperties === false && Object.keys(tool.inputSchema.properties).length === 0), true);

  const refused = await runMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "observe_target", arguments: { url: "https://example.test" } } });
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.output).error.code, -32601);
});

test("supervisor RPC serializes tools and gates each call", async () => {
  let active = 0;
  let maxActive = 0;
  let gates = 0;
  const tool = async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { ok: true };
  };
  const invoke = mcpRpcInternals.createSerializedToolInvoker({ observe_target: tool }, { assertGate() { gates += 1; } });
  await Promise.all([
    invoke("observe_target"),
    invoke("observe_target"),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(gates, 2);
});
