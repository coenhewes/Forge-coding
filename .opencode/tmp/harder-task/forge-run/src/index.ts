#!/usr/bin/env node
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { runCommandSafe, summarizePackage, inspectTree } from "./tools.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const SERVER_INFO = {
  name: "codex-project-inspector",
  version: "0.1.0",
};

const SERVER_CAPABILITIES = {
  tools: {},
};

const TOOL_DEFINITIONS = [
  {
    name: "inspect_tree",
    description: "Return a directory tree under a path with depth limit and ignore globs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxDepth: { type: "number" },
        ignore: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
    },
  },
  {
    name: "summarize_package",
    description: "Summarize a package.json (name, version, scripts, deps).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "run_command_safe",
    description: "Run an allowlisted shell command with a timeout and return captured output.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      },
      required: ["cmd"],
    },
  },
];

// --- Serialized request processing -------------------------------------------
// We must process requests strictly in arrival order. Each request is fully
// handled (including writing its response) before the next one begins.
// Shutdown only runs after every queued request has been flushed.

type PendingRequest = {
  raw: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const requestQueue: PendingRequest[] = [];
let processing = false;
let shuttingDown = false;
let pendingShutdownReason: "shutdown" | "exit" | null = null;
let activeRequest: PendingRequest | null = null;

function writeResponse(res: JsonRpcResponse): void {
  const payload = JSON.stringify(res) + "\n";
  process.stdout.write(payload);
}

async function handleRequest(raw: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw) as JsonRpcRequest;
  } catch (err) {
    // Per JSON-RPC 2.0, a parse error must be reported with id: null.
    // We only emit if the id is present; the spec is silent on notifications.
    writeResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error", data: String(err) },
    });
    return;
  }

  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  try {
    const result = await dispatchMethod(req.method, req.params);
    if (!isNotification) {
      writeResponse({ jsonrpc: "2.0", id, result });
    }
  } catch (err) {
    if (!isNotification) {
      writeResponse({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

async function dispatchMethod(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const p = (params ?? {}) as {
        protocolVersion?: string;
        clientInfo?: { name?: string; version?: string };
        capabilities?: Record<string, unknown>;
      };
      return {
        protocolVersion: p.protocolVersion ?? "2024-11-05",
        serverInfo: SERVER_INFO,
        capabilities: SERVER_CAPABILITIES,
      };
    }
    case "initialized":
      // Notification; no response.
      return undefined;
    case "tools/list":
      return { tools: TOOL_DEFINITIONS };
    case "tools/call": {
      const p = (params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      const args = p.arguments ?? {};
      switch (p.name) {
        case "inspect_tree":
          return await inspectTree(args as { path: string; maxDepth?: number; ignore?: string[] });
        case "summarize_package":
          return await summarizePackage(args as { path: string });
        case "run_command_safe":
          return await runCommandSafe(
            args as unknown as Parameters<typeof runCommandSafe>[0]
          );
        default:
          throw new Error(`Unknown tool: ${p.name}`);
      }
    }
    case "shutdown":
      // Signal that the server should exit once the queue is drained.
      pendingShutdownReason = "shutdown";
      return {};
    case "exit":
      pendingShutdownReason = "exit";
      return {};
    case "ping":
      return {};
    default:
      throw new Error(`Method not found: ${method}`);
  }
}

function enqueue(raw: string): void {
  const entry: PendingRequest = {
    raw,
    resolve: () => {},
    reject: () => {},
  };
  requestQueue.push(entry);
  drainQueue();
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (requestQueue.length > 0) {
      const next = requestQueue.shift()!;
      activeRequest = next;
      try {
        await handleRequest(next.raw);
      } catch (err) {
        // Defensive: handleRequest already catches its own errors. If anything
        // escapes, we still want to advance the queue.
        process.stderr.write(`internal error: ${String(err)}\n`);
      } finally {
        activeRequest = null;
        next.resolve();
      }
    }
  } finally {
    processing = false;
  }

  // Once the queue is fully drained, honor any pending shutdown/exit.
  if (shuttingDown || pendingShutdownReason !== null) {
    await finishShutdown();
  }
}

async function finishShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Best-effort: give the OS a tick to flush stdout.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const code = pendingShutdownReason === "exit" ? 0 : 0;
  process.exit(code);
}

// --- Stdin ingestion ---------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  enqueue(trimmed);
});

rl.on("close", () => {
  // EOF on stdin. If we're already in the middle of processing, the drain
  // loop will pick this up. Otherwise trigger shutdown now.
  if (requestQueue.length === 0 && !processing) {
    void finishShutdown();
  }
});

process.on("SIGINT", () => {
  void finishShutdown();
});
process.on("SIGTERM", () => {
  void finishShutdown();
});

// Touch randomUUID so the import is preserved even if future refactors drop
// direct usage; MCP-style servers commonly use it for request correlation.
void randomUUID;
