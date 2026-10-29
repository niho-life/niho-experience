import { stdin, stdout } from "node:process";
import { MAX_MCP_LINE_BYTES, TOOL_NAMES } from "./constants.mjs";
import { callSupervisor } from "./mcp-rpc.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

const definitions = TOOL_NAMES.map((name) => ({
  name,
  description: name === "observe_target" ? "Observe only the immutable OTA target."
    : name === "apply_desired_state" ? "Apply the immutable job's desired state through the guarded UI action."
      : "Reload and independently verify the immutable target.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}));

function response(id, result) {
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id, code, message) {
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`);
}

export async function runMcpStdio({ socketPath, input = stdin }) {
  let buffer = Buffer.alloc(0);
  let rpcId = 0;
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) throw new ContractError("MCP_LINE_TOO_LARGE");
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const raw = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { error(null, -32700, "Parse error"); throw new ContractError("MCP_PROTOCOL_VIOLATION"); }
      if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        error(message?.id, -32600, "Invalid Request"); throw new ContractError("MCP_PROTOCOL_VIOLATION");
      }
      if (message.method === "notifications/initialized" && message.id === undefined) continue;
      if (message.method === "initialize" && message.id !== undefined && isPlainObject(message.params)) {
        response(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "niho-ota", version: "0.1.0" } });
        continue;
      }
      if (message.method === "tools/list" && message.id !== undefined && (message.params === undefined || exactKeys(message.params, []))) {
        response(message.id, { tools: definitions }); continue;
      }
      if (message.method === "tools/call" && message.id !== undefined && exactKeys(message.params, ["name", "arguments"])
        && TOOL_NAMES.includes(message.params.name) && exactKeys(message.params.arguments, [])) {
        const result = await callSupervisor(socketPath, { id: ++rpcId, tool: message.params.name, arguments: {} });
        response(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
        continue;
      }
      error(message.id, -32601, "Method not found or invalid arguments");
      throw new ContractError("MCP_PROTOCOL_VIOLATION");
    }
  }
  if (buffer.length) throw new ContractError("MCP_TRUNCATED_LINE");
}

export const mcpToolDefinitions = definitions;
