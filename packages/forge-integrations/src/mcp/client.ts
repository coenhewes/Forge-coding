/**
 * MCP client for Forge — speaks JSON-RPC 2.0 over stdio to a
 * `forge mcp serve` subprocess.
 *
 * This is the symmetric counterpart of `server.ts`. Two transports
 * are supported:
 *
 *   1. `StdioMcpClient.spawn(command, args, env)` — runs a child
 *      process (typically `node packages/forge-cli/dist/cli.js mcp
 *      serve`) and proxies calls through its stdin/stdout.
 *   2. `InProcessMcpClient.connect(context)` — wraps an existing
 *      `CapabilityContext` so callers (and tests) can drive the same
 *      JSON-RPC surface without spawning a subprocess.
 *
 * The protocol is line-delimited JSON: one JSON-RPC message per line
 * on each direction, matching the convention used by Claude Desktop,
 * Cursor, and the opencode MCP client.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  handleRawRpc,
  type CapabilityContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDescriptor,
} from './server.js'

/** A connected client capable of issuing MCP RPCs. */
export interface McpClient {
  /** Close the transport and free resources. */
  close(): Promise<void>
  /** RPC primitive: send any method, await the matching response. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Convenience: `tools/list` → returns the registered tool descriptors. */
  listTools(): Promise<ToolDescriptor[]>
  /** Convenience: `tools/call` → invoke a named tool with arguments. */
  callTool<T = unknown>(name: string, arguments_: Record<string, unknown>): Promise<T>
}

/* ---------------------------------------------------------------- *
 *  In-process client — wraps a CapabilityContext for tests.
 * ---------------------------------------------------------------- */

export interface InProcessMcpClientOptions {
  context: CapabilityContext
  /** Optional logger for RPC traffic (used by tests). */
  logger?: (line: string) => void
}

/**
 * In-process client. Useful for tests and for embedding the MCP
 * surface inside another process without stdio plumbing.
 */
export function createInProcessMcpClient(opts: InProcessMcpClientOptions): McpClient {
  return {
    async close() {
      /* no-op */
    },
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const req: JsonRpcRequest = { jsonrpc: '2.0', id: randomUUID(), method, params }
      const response = await handleRawRpc(JSON.stringify(req), opts.context, opts.logger)
      if (!response) {
        throw new Error('Server returned no response (notification not handled).')
      }
      if (response.error) {
        const err = new Error(response.error.message) as Error & { code?: number; data?: unknown }
        err.code = response.error.code
        err.data = response.error.data
        throw err
      }
      return response.result as T
    },
    async listTools() {
      const result = await this.request<{ tools: ToolDescriptor[] }>('tools/list')
      return result.tools
    },
    async callTool<T>(name: string, arguments_: Record<string, unknown>) {
      return this.request<T>('tools/call', { name, arguments: arguments_ })
    },
  }
}

/* ---------------------------------------------------------------- *
 *  Stdio client — spawns a subprocess and proxies via stdin/stdout.
 * ---------------------------------------------------------------- */

export interface StdioMcpClientOptions {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  /** cwd for the child process. */
  cwd?: string
  /** Max time to wait for a single response (default 10s). */
  responseTimeoutMs?: number
  /** Optional logger for RPC traffic. */
  logger?: (line: string) => void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Spawn a child process and return an McpClient backed by its stdio.
 * The child is expected to speak JSON-RPC 2.0 line-delimited JSON on
 * stdout and read JSON-RPC requests from stdin. The client writes a
 * trailing newline after every request.
 */
export function spawnStdioMcpClient(opts: StdioMcpClientOptions): McpClient {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<string, PendingCall>()
  const responseTimeoutMs = opts.responseTimeoutMs ?? 10_000
  const log = opts.logger ?? (() => undefined)

  let buffer = ''
  let closed = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.length > 0) void dispatch(line)
      nl = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) log(`stderr: ${line}`)
    }
  })
  child.on('close', (code, signal) => {
    closed = true
    const err = new Error(
      `MCP subprocess exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
    )
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  })
  child.on('error', (err) => {
    closed = true
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  })

  async function dispatch(line: string): Promise<void> {
    let parsed: JsonRpcResponse | null = null
    try {
      parsed = JSON.parse(line) as JsonRpcResponse
    } catch {
      log(`client: unparseable line ${line.slice(0, 120)}`)
      return
    }
    if (parsed.id === undefined || parsed.id === null) return
    const key = String(parsed.id)
    const p = pending.get(key)
    if (!p) {
      log(`client: no pending call for id=${key}`)
      return
    }
    pending.delete(key)
    clearTimeout(p.timer)
    if (parsed.error) {
      const err = new Error(parsed.error.message) as Error & { code?: number; data?: unknown }
      err.code = parsed.error.code
      err.data = parsed.error.data
      p.reject(err)
    } else {
      p.resolve(parsed.result)
    }
  }

  return {
    async close() {
      if (closed) return
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (closed) return resolve()
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          resolve()
        }, 1500)
        child.once('close', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) throw new Error('MCP client is closed.')
      const id = randomUUID()
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      const payload = JSON.stringify(req) + '\n'
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP request timed out after ${responseTimeoutMs}ms: ${method}`))
        }, responseTimeoutMs)
        pending.set(id, { resolve, reject, timer })
      })
      child.stdin.write(payload)
      return promise as Promise<T>
    },
    async listTools() {
      const result = await this.request<{ tools: ToolDescriptor[] }>('tools/list')
      return result.tools
    },
    async callTool<T>(name: string, arguments_: Record<string, unknown>) {
      return this.request<T>('tools/call', { name, arguments: arguments_ })
    },
  }
}
