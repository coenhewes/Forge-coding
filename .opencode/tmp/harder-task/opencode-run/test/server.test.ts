/**
 * Spawn-based JSON-RPC round-trip tests for codex_project_inspector.
 *
 * These tests boot the compiled server as a child process, talk to it over
 * real stdio pipes, and verify the JSON-RPC envelopes come back correctly.
 * No Playwright is used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

type NotificationHandler = (resp: unknown) => void;

class JsonRpcClient {
  private buffer = "";
  private pending = new Map<string | number, Pending>();
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams;
  private notificationHandlers: NotificationHandler[] = [];
  private stderr = "";
  private exited = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("exit", () => {
      this.exited = true;
      const err = new Error(`server exited unexpectedly; stderr=\n${this.stderr}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failAll(new Error(`server produced non-JSON: ${line}`));
        return;
      }
      const obj = parsed as { id?: string | number | null };
      const hasId = obj && typeof obj === "object" && "id" in obj &&
        (typeof obj.id === "string" || typeof obj.id === "number");
      if (hasId) {
        const pending = this.pending.get(obj.id as string | number);
        if (pending) {
          this.pending.delete(obj.id as string | number);
          pending.resolve(parsed);
        } else {
          // Unsolicited response with an id we never sent — treat as notification.
          for (const n of this.notificationHandlers.slice()) n(parsed);
        }
      } else {
        for (const n of this.notificationHandlers.slice()) n(parsed);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Subscribe to server-pushed messages (notifications, errors with id=null, etc.). */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  /** Expose raw stdin for tests that want to send malformed input. */
  get rawStdin(): NodeJS.WritableStream {
    return this.child.stdin;
  }

  /** True if the server process has exited. */
  get isExited(): boolean {
    return this.exited;
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 5000
  ): Promise<T> {
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      const t = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      this.child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

async function startClient(): Promise<JsonRpcClient> {
  const child = spawn("node", [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new JsonRpcClient(child);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("server boots and responds to initialize", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("initialize")) as {
      result?: { serverInfo?: { name?: string; version?: string }; capabilities?: unknown };
    };
    assert.equal(resp.result?.serverInfo?.name, "codex_project_inspector");
    assert.ok(resp.result?.serverInfo?.version, "version should be present");
    assert.ok(resp.result?.capabilities, "capabilities should be present");
  } finally {
    await client.shutdown();
  }
});

test("tools/list returns the three required tools", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("tools/list")) as {
      result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    };
    const names = (resp.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(
      names,
      ["inspect_tree", "run_command_safe", "summarize_package"],
      "tools/list must include the three required tools"
    );
    for (const tool of resp.result?.tools ?? []) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} should have a description`);
      assert.ok(tool.inputSchema, `${tool.name} should have an inputSchema`);
    }
  } finally {
    await client.shutdown();
  }
});

test("ping returns { pong: true }", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("ping")) as { result?: { pong?: boolean } };
    assert.equal(resp.result?.pong, true);
  } finally {
    await client.shutdown();
  }
});

test("inspect_tree on a real temp directory returns entries with correct shape", async () => {
  const client = await startClient();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-inspect-"));
  await fs.writeFile(path.join(tmp, "a.txt"), "hello");
  await fs.mkdir(path.join(tmp, "sub"));
  await fs.writeFile(path.join(tmp, "sub", "b.txt"), "world");
  try {
    const resp = (await client.call("tools/call", {
      name: "inspect_tree",
      arguments: { path: tmp, maxDepth: 3 },
    })) as {
      result?: {
        ok?: boolean;
        data?: { root?: string; entries?: Array<{ name: string; type: string; children?: unknown[] }> };
      };
    };
    assert.equal(resp.result?.ok, true);
    const data = resp.result?.data!;
    assert.equal(data.root, tmp);
    const names = (data.entries ?? []).map((e) => e.name).sort();
    assert.deepEqual(names, ["a.txt", "sub"]);
    const sub = data.entries!.find((e) => e.name === "sub")!;
    assert.equal(sub.type, "directory");
    assert.ok(Array.isArray(sub.children));
    const subNames = (sub.children as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(subNames, ["b.txt"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await client.shutdown();
  }
});

test("summarize_package on its own directory returns a structured summary", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("tools/call", {
      name: "summarize_package",
      arguments: { path: PROJECT_ROOT },
    })) as {
      result?: {
        ok?: boolean;
        data?: { name?: string; scripts?: Record<string, string>; hasReadme?: boolean; hasTsConfig?: boolean };
      };
    };
    assert.equal(resp.result?.ok, true);
    const data = resp.result?.data!;
    assert.equal(data.name, "codex-project-inspector");
    assert.ok(data.scripts && Object.keys(data.scripts).length > 0, "scripts should be present");
    assert.ok(data.scripts && typeof data.scripts.build === "string", "build script should be present");
    assert.ok(data.scripts && typeof data.scripts.test === "string", "test script should be present");
    assert.equal(data.hasReadme, true);
    assert.equal(data.hasTsConfig, true);
  } finally {
    await client.shutdown();
  }
});

test("run_command_safe runs an allow-listed command and returns stdout", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("tools/call", {
      name: "run_command_safe",
      arguments: { command: "node", args: ["-e", "process.stdout.write('hi')"] },
    })) as {
      result?: {
        ok?: boolean;
        data?: { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
      };
    };
    assert.equal(resp.result?.ok, true);
    const data = resp.result?.data!;
    assert.equal(data.exitCode, 0);
    assert.equal(data.stdout, "hi");
    assert.equal(data.timedOut, false);
  } finally {
    await client.shutdown();
  }
});

test("run_command_safe rejects commands outside the allow-list", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("tools/call", {
      name: "run_command_safe",
      arguments: { command: "rm", args: ["-rf", "/"] },
    })) as { error?: { code?: number; data?: { code?: string } } };
    assert.ok(resp.error, "expected an error response");
    assert.equal(resp.error?.code, -32603);
    assert.equal(resp.error?.data?.code, "COMMAND_NOT_ALLOWED");
  } finally {
    await client.shutdown();
  }
});

test("run_command_safe rejects shell metacharacters in args", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("tools/call", {
      name: "run_command_safe",
      arguments: { command: "echo", args: ["hello; rm -rf /"] },
    })) as { error?: { code?: number; data?: { code?: string } } };
    assert.ok(resp.error, "expected an error response");
    assert.equal(resp.error?.code, -32603);
    assert.equal(resp.error?.data?.code, "SHELL_METACHARS_NOT_ALLOWED");
  } finally {
    await client.shutdown();
  }
});

test("server returns METHOD_NOT_FOUND for unknown methods", async () => {
  const client = await startClient();
  try {
    const resp = (await client.call("does/not_exist")) as { error?: { code?: number; message?: string } };
    assert.ok(resp.error, "expected an error response");
    assert.equal(resp.error?.code, -32601);
  } finally {
    await client.shutdown();
  }
});

test("server returns PARSE_ERROR for non-JSON input", async () => {
  const client = await startClient();
  try {
    const errP = new Promise<{ error?: { code?: number } }>((resolve, reject) => {
      const off = client.onNotification((resp) => {
        off();
        resolve(resp as { error?: { code?: number } });
      });
      setTimeout(() => reject(new Error("no parse-error response received")), 3000);
    });
    client.rawStdin.write("this is not json\n");
    const err = await errP;
    assert.equal(err.error?.code, -32700);
  } finally {
    await client.shutdown();
  }
});

test("shutdown method exits the server", async () => {
  const client = await startClient();
  const resp = (await client.call("shutdown", {}, 3000)) as { result?: { shutdown?: boolean } };
  assert.equal(resp.result?.shutdown, true);
  // Give the server a moment to exit.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(client.isExited, "server should have exited after shutdown");
  await client.shutdown();
});

test("pipelined burst of five requests all get responses in order before shutdown exits", async () => {
  // Regression test: when initialize, tools/list, tools/call, run_command_safe,
  // and shutdown are written to stdin in one burst (no awaiting between writes),
  // the server must process them strictly in arrival order, write every
  // response, and only then exit. Previously the shutdown handler could
  // schedule `process.exit(0)` before the in-flight `run_command_safe`
  // tool call had a chance to write its response, dropping id=4 on the
  // floor. This test uses a raw spawn + raw stdio so we can observe the
  // exact arrival order of response lines on stdout.
  const child = spawn("node", [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Write all five requests in a single burst. None of these writes is
  // awaited individually; the OS pipe just gets every newline-terminated
  // line at once. The readline interface on the server side will see them
  // in order and fire five "line" events back-to-back.
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "inspect_tree",
        arguments: { path: PROJECT_ROOT, maxDepth: 1 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "run_command_safe",
        arguments: { command: "node", args: ["-e", "process.stdout.write('ok')"] },
      },
    },
    { jsonrpc: "2.0", id: 5, method: "shutdown", params: {} },
  ];
  const burst = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  child.stdin.write(burst);
  // Signal EOF so a well-behaved server that reaches the end of the
  // request stream will not block waiting for more input.
  child.stdin.end();

  // Wait for the process to exit (and the stdio streams to close) so all
  // flushed responses are visible in `stdout`. Use the "close" event,
  // which fires after stdout has been fully drained, rather than "exit".
  const exitInfo: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 10000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      exitInfo.code = code;
      exitInfo.signal = signal;
      resolve();
    });
  });

  // Parse the response lines in arrival order.
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(
    lines.length,
    5,
    `expected 5 responses in order before exit, got ${lines.length}\n` +
      `stdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}`
  );

  const responses = lines.map((line) => JSON.parse(line));
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (responses[i] as { id: number }).id,
      i + 1,
      `response at position ${i} should have id ${i + 1}; ` +
        `got ${JSON.stringify(responses[i])}`
    );
  }

  // Sanity-check the shape of each response.
  assert.ok(
    (responses[0] as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name,
    "initialize should return serverInfo.name"
  );
  assert.ok(
    (responses[1] as { result?: { tools?: unknown[] } }).result?.tools,
    "tools/list should return tools"
  );
  assert.equal(
    (responses[2] as { result?: { ok?: boolean } }).result?.ok,
    true,
    "tools/call inspect_tree should return ok"
  );
  assert.equal(
    (responses[3] as { result?: { ok?: boolean; data?: { stdout?: string } } }).result?.ok,
    true,
    "tools/call run_command_safe should return ok"
  );
  assert.equal(
    (responses[3] as { result?: { ok?: boolean; data?: { stdout?: string } } }).result?.data?.stdout,
    "ok",
    "run_command_safe should have written 'ok' to stdout"
  );
  assert.equal(
    (responses[4] as { result?: { shutdown?: boolean } }).result?.shutdown,
    true,
    "shutdown should be acknowledged"
  );

  // The server must have exited cleanly only after every prior response
  // was flushed. If the queue is broken the process either times out
  // (we kill it) or it would still pass the assertions above but the
  // responses for the in-flight tool call would be missing.
  assert.equal(
    exitInfo.code,
    0,
    `server should exit with code 0; code=${exitInfo.code} signal=${exitInfo.signal}\n` +
      `stderr=${JSON.stringify(stderr)}`
  );
});