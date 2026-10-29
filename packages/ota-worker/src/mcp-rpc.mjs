import { createServer, createConnection } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { MAX_MCP_LINE_BYTES, TOOL_NAMES } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

function lineReader(stream, onLine, onViolation) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) return onViolation(new ContractError("MCP_LINE_TOO_LARGE"));
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_MCP_LINE_BYTES) return onViolation(new ContractError("MCP_LINE_TOO_LARGE"));
      onLine(line.toString("utf8"));
    }
  });
  stream.on("end", () => { if (buffer.length) onViolation(new ContractError("MCP_TRUNCATED_LINE")); });
}

function createSerializedToolInvoker(tools, { assertGate = () => {}, onToolFailure = () => {} } = {}) {
  let queue = Promise.resolve();
  return (tool) => {
    const invocation = queue.then(async () => {
      assertGate();
      return tools[tool]();
    });
    queue = invocation.catch(() => {});
    return invocation.catch((error) => { onToolFailure(error); throw error; });
  };
}

export async function createSupervisorRpc(socketPath, tools, {
  onProtocolViolation = () => {}, onToolFailure = () => {}, assertGate = () => {},
} = {}) {
  await unlink(socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const sockets = new Set();
  let closing = false;
  const invoke = createSerializedToolInvoker(tools, {
    assertGate() {
      if (closing) throw new ContractError("RPC_CLOSED");
      assertGate();
    },
    onToolFailure,
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    lineReader(socket, (line) => {
      let request;
      try { request = JSON.parse(line); } catch { onProtocolViolation("INVALID_JSON"); socket.destroy(); return; }
      if (!exactKeys(request, ["id", "tool", "arguments"]) || !Number.isSafeInteger(request.id)
        || !TOOL_NAMES.includes(request.tool) || !exactKeys(request.arguments, [])) {
        onProtocolViolation("UNKNOWN_TOOL_OR_ARGS"); socket.destroy(); return;
      }
      void (async () => {
        try {
          if (socket.destroyed) throw new ContractError("RPC_CLOSED");
          const result = await invoke(request.tool);
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        } catch (error) {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ok: false, code: String(error?.code ?? "TOOL_FAILED").slice(0, 80) })}\n`);
        }
      })();
    }, (error) => { onProtocolViolation(error.code); socket.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return Object.freeze({
    socketPath,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    },
  });
}

export function callSupervisor(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once("error", (error) => finish(error));
    lineReader(socket, (line) => {
      let response;
      try { response = JSON.parse(line); } catch { finish(new ContractError("INVALID_RPC_RESPONSE")); return; }
      if (!isPlainObject(response) || response.id !== request.id || typeof response.ok !== "boolean") return finish(new ContractError("INVALID_RPC_RESPONSE"));
      if (!response.ok) return finish(new ContractError(typeof response.code === "string" ? response.code : "TOOL_FAILED"));
      finish(null, response.result);
    }, (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

export const mcpRpcInternals = Object.freeze({ lineReader, createSerializedToolInvoker });
