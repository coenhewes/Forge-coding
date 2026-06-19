#!/usr/bin/env node
/**
 * codex_project_inspector
 *
 * An MCP-style JSON-RPC 2.0 server that runs over stdio.
 *
 * Protocol
 * --------
 *  - Each request is a single line of JSON written to stdin (newline-terminated).
 *  - Each response is a single line of JSON written to stdout (newline-terminated).
 *  - The server logs diagnostics to stderr only — never to stdout.
 *  - Standard JSON-RPC 2.0 envelopes are used:
 *
 *      --> {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
 *      <-- {"jsonrpc":"2.0","id":1,"result":{"tools":["inspect_tree","summarize_package","run_command_safe"]}}
 *
 *      --> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect_tree","arguments":{"maxDepth":2}}}
 *      <-- {"jsonrpc":"2.0","id":2,"result":{"ok":true,"data":{...}}}
 *
 *  - Notifications (no `id`) are accepted but produce no response.
 *  - Parsing errors are reported using the standard -32700 code, etc.
 */

import * as readline from "node:readline";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JSON_RPC_ERRORS,
} from "./types";
import { TOOLS, listToolNames, ToolName } from "./tools";

const SERVER_NAME = "codex_project_inspector";
const SERVER_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeError(
  id: JsonRpcRequest["id"] | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    isPlainObject(v) &&
    v.jsonrpc === "2.0" &&
    typeof v.method === "string" &&
    (v.id === undefined ||
      v.id === null ||
      typeof v.id === "string" ||
      typeof v.id === "number")
  );
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

interface MethodContext {
  writeLine: (line: string) => void;
}

async function handleRequest(
  req: JsonRpcRequest,
  ctx: MethodContext
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
    }

    case "ping": {
      return { jsonrpc: "2.0", id, result: { pong: true } };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: listToolNames().map((name) => {
            const t = TOOLS[name as ToolName];
            return {
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            };
          }),
        },
      };
    }

    case "tools/call": {
      const params = req.params;
      if (!isPlainObject(params)) {
        return makeError(id, JSON_RPC_ERRORS.INVALID_PARAMS, "params must be an object");
      }
      const name = params.name;
      const arguments_ = params.arguments ?? {};
      if (typeof name !== "string") {
        return makeError(id, JSON_RPC_ERRORS.INVALID_PARAMS, "params.name must be a string");
      }
      if (!(name in TOOLS)) {
        return makeError(
          id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Unknown tool: '${name}'. Available tools: ${listToolNames().join(", ")}`
        );
      }
      const tool = TOOLS[name as ToolName];
      try {
        const result = await tool.handler(arguments_ as never);
        if (!result.ok) {
          // Tool-level error: surface as a JSON-RPC INTERNAL_ERROR but include the
          // structured detail in `data` so the agent can inspect it.
          return makeError(
            id,
            JSON_RPC_ERRORS.INTERNAL_ERROR,
            result.error.message,
            { code: result.error.code }
          );
        }
        return { jsonrpc: "2.0", id, result: { ok: true, data: result.data } };
      } catch (err) {
        return makeError(
          id,
          JSON_RPC_ERRORS.INTERNAL_ERROR,
          (err as Error).message
        );
      }
    }

    case "shutdown": {
      // Respond and exit cleanly.
      ctx.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result: { shutdown: true } }));
      // Give the response a tick to flush, then exit.
      setImmediate(() => process.exit(0));
      return null;
    }

    default: {
      return makeError(
        id,
        JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method: '${req.method}'`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

function writeLine(line: string): void {
  process.stdout.write(line + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function startServer(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  log(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`);

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      writeLine(
        JSON.stringify(
          makeError(null, JSON_RPC_ERRORS.PARSE_ERROR, `Invalid JSON: ${(err as Error).message}`)
        )
      );
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      writeLine(
        JSON.stringify(
          makeError(
            (isPlainObject(parsed) ? (parsed.id as never) : null) ?? null,
            JSON_RPC_ERRORS.INVALID_REQUEST,
            "Invalid JSON-RPC 2.0 request"
          )
        )
      );
      return;
    }

    try {
      const resp = await handleRequest(parsed, { writeLine });
      if (resp !== null) writeLine(JSON.stringify(resp));
    } catch (err) {
      writeLine(
        JSON.stringify(
          makeError(
            parsed.id ?? null,
            JSON_RPC_ERRORS.INTERNAL_ERROR,
            (err as Error).message
          )
        )
      );
    }
  });

  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
}

if (require.main === module) {
  startServer();
}

export { startServer, handleRequest, isJsonRpcRequest };
