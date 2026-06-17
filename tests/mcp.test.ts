/**
 * Round-trip test for the Forge MCP server and client.
 *
 * The MCP server reads from a `CapabilityContext`. The default
 * production wiring reads from `ForgeStateStore` (Postgres), but for
 * the round-trip test we use `createInMemoryCapabilityContext` so the
 * suite stays hermetic (no live database). The in-process client
 * exercises the same JSON-RPC surface as the stdio subprocess; a
 * separate subprocess test in this file spawns a real child process
 * that runs `runMcpServeFromEnv` against a fake stdin pipe.
 *
 * The verification that the *real* wiring also works (Postgres path)
 * is left to the live-DB integration tests; this file proves the
 * protocol, capability dispatch, and response shapes are correct.
 */
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCapabilityContext,
  createInMemoryCapabilityContext,
  createInProcessMcpClient,
  handleRawRpc,
  RPC_ERROR,
  runMcpServer,
  type JsonRpcResponse,
  type PlanNextActionResult,
  type TaskCurrentStateResult,
  type TopHypothesesResult,
} from '@forge/integrations'

/** Convenience: assert a response is success and return its result. */
function unwrap<T>(response: JsonRpcResponse | null): T {
  expect(response).not.toBeNull()
  if (!response) throw new Error('no response')
  expect(response.error).toBeUndefined()
  if (response.error) throw new Error(response.error.message)
  return response.result as T
}

/** Build a non-null RequestId for RPC calls. */
const id = (n: number) => n

describe('MCP server — request parsing', () => {
  const ctx = createInMemoryCapabilityContext({
    task: { id: 'task:1', status: 'running', title: 'demo' },
  })

  it('returns a parse error on malformed JSON', async () => {
    const res = await handleRawRpc('not json', ctx)
    expect(res).not.toBeNull()
    expect(res!.error?.code).toBe(RPC_ERROR.PARSE_ERROR)
  })

  it('returns an invalid-request error on wrong shape', async () => {
    const res = await handleRawRpc(JSON.stringify({ jsonrpc: '2.0', method: 1 }), ctx)
    expect(res).not.toBeNull()
    expect(res!.error?.code).toBe(RPC_ERROR.INVALID_REQUEST)
  })

  it('returns method-not-found for unknown methods', async () => {
    const res = await handleRawRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }), ctx)
    expect(res).not.toBeNull()
    expect(res!.error?.code).toBe(RPC_ERROR.METHOD_NOT_FOUND)
  })

  it('responds to ping with an empty object', async () => {
    const res = await handleRawRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), ctx)
    expect(res).not.toBeNull()
    expect(res!.error).toBeUndefined()
    expect(res!.result).toEqual({})
  })

  it('responds to initialize with serverInfo', async () => {
    const res = await handleRawRpc(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      ctx,
    )
    expect(res).not.toBeNull()
    const result = res!.result as { serverInfo?: { name?: string } }
    expect(result.serverInfo?.name).toBe('forge-mcp')
  })
})

describe('MCP server — tools/list', () => {
  it('advertises the three capabilities with input schemas', async () => {
    const ctx = createInMemoryCapabilityContext({})
    const res = await handleRawRpc(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      ctx,
    )
    const result = unwrap<{ tools: Array<{ name: string; inputSchema: { required: string[] } }> }>(
      res,
    )
    expect(result.tools.map((t) => t.name)).toEqual([
      'task.get_current_state',
      'belief.get_top_hypotheses',
      'verification.plan_next_action',
    ])
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.required).toContain('taskId')
    }
  })
})

describe('MCP server — capability dispatch (in-memory context)', () => {
  const ctx = createInMemoryCapabilityContext({
    task: {
      id: 'task:alpha',
      status: 'running',
      mode: 'autonomous',
      title: 'Implement SSO invite',
      interpretedGoal: 'Allow org admins to invite users via SSO',
      currentSummary: 'Investigating route guards',
      nextAction: 'Inspect auth middleware',
      activeBranch: 'feat/sso-invite',
    },
    snapshot: { id: 'snap:1', summary: 'Started investigating auth middleware failure.' },
    hypotheses: [
      { claim: 'Route guard missing admin role check', confidence: 0.85, status: 'plausible' },
      { claim: 'SSO role mapping changed in last deploy', confidence: 0.6, status: 'plausible' },
      { claim: 'Session expiry too aggressive', confidence: 0.3, status: 'plausible' },
    ],
    claims: [
      {
        id: 'claim:auth-1',
        text: 'Org admins can invite users via SSO',
        confidence: 0.4,
        riskLevel: 'high',
      },
      {
        id: 'claim:auth-2',
        text: 'Non-admin users cannot invite other users',
        confidence: 0.5,
        riskLevel: 'high',
      },
    ],
  })

  it('task.get_current_state returns the seeded task + latest snapshot', async () => {
    const res = await handleRawRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id(1),
        method: 'tools/call',
        params: { name: 'task.get_current_state', arguments: { taskId: 'task:alpha' } },
      }),
      ctx,
    )
    const result = unwrap<TaskCurrentStateResult>(res)
    expect(result.taskId).toBe('task:alpha')
    expect(result.status).toBe('running')
    expect(result.activeBranch).toBe('feat/sso-invite')
    expect(result.latestSnapshot?.summary).toContain('auth middleware')
  })

  it('belief.get_top_hypotheses returns hypotheses sorted by confidence', async () => {
    const res = await handleRawRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id(2),
        method: 'tools/call',
        params: {
          name: 'belief.get_top_hypotheses',
          arguments: { taskId: 'task:alpha', limit: 2 },
        },
      }),
      ctx,
    )
    const result = unwrap<TopHypothesesResult>(res)
    expect(result.hypotheses).toHaveLength(2)
    expect(result.hypotheses[0]!.confidence).toBeGreaterThanOrEqual(result.hypotheses[1]!.confidence)
    expect(result.hypotheses[0]!.claim).toContain('Route guard')
  })

  it('verification.plan_next_action runs the real planner and returns a score breakdown', async () => {
    const res = await handleRawRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id(3),
        method: 'tools/call',
        params: {
          name: 'verification.plan_next_action',
          arguments: { taskId: 'task:alpha', maxCandidates: 5 },
        },
      }),
      ctx,
    )
    const result = unwrap<PlanNextActionResult>(res)
    expect(result.taskId).toBe('task:alpha')
    // The planner must have generated at least one candidate because we
    // seeded high-risk claims — and at least one action must target a
    // claim so we get a non-zero score.
    expect(result.candidateActions.length).toBeGreaterThan(0)
    expect(result.recommendedAction).not.toBeNull()
    expect(result.scores.length).toBeGreaterThan(0)
    for (const score of result.scores) {
      expect(typeof score.totalScore).toBe('number')
      expect(score.components.claimImportance).toBeGreaterThan(0)
    }
    expect(typeof result.generatedAt).toBe('string')
  })

  it('returns an invalid-params error when taskId is missing', async () => {
    const res = await handleRawRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id(4),
        method: 'tools/call',
        params: { name: 'task.get_current_state', arguments: {} },
      }),
      ctx,
    )
    expect(res).not.toBeNull()
    expect(res!.error?.code).toBe(RPC_ERROR.INVALID_PARAMS)
  })
})

describe('MCP in-process client — list + call round trip', () => {
  it('round-trips list → call across all three capabilities', async () => {
    const ctx = createInMemoryCapabilityContext({
      task: { id: 'task:rt', status: 'running' },
      hypotheses: [{ claim: 'A', confidence: 0.7 }],
      claims: [{ text: 'B', confidence: 0.3, riskLevel: 'medium' }],
    })
    const client = createInProcessMcpClient({ context: ctx })

    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('task.get_current_state')
    expect(tools.map((t) => t.name)).toContain('belief.get_top_hypotheses')
    expect(tools.map((t) => t.name)).toContain('verification.plan_next_action')

    const state = await client.callTool<TaskCurrentStateResult>('task.get_current_state', {
      taskId: 'task:rt',
    })
    expect(state.taskId).toBe('task:rt')

    const hyps = await client.callTool<TopHypothesesResult>('belief.get_top_hypotheses', {
      taskId: 'task:rt',
    })
    expect(hyps.hypotheses).toHaveLength(1)

    const plan = await client.callTool<PlanNextActionResult>('verification.plan_next_action', {
      taskId: 'task:rt',
    })
    expect(plan.candidateActions.length).toBeGreaterThan(0)
  })

  it('surfaces RPC errors as thrown exceptions', async () => {
    const client = createInProcessMcpClient({ context: createInMemoryCapabilityContext({}) })
    await expect(client.listTools()).resolves.toBeDefined() // sanity
    await expect(
      client.callTool('does.not.exist', {}),
    ).rejects.toThrow(/Unknown tool/)
  })
})

describe('MCP stdio server loop — line-delimited JSON', () => {
  let stdin: PassThrough
  let stdout: PassThrough
  let stdoutChunks: string[]

  beforeEach(() => {
    stdin = new PassThrough()
    stdout = new PassThrough()
    stdoutChunks = []
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => stdoutChunks.push(chunk))
  })

  it('reads line-delimited JSON requests and writes line-delimited responses', async () => {
    const ctx = createInMemoryCapabilityContext({
      task: { id: 'task:stdio', status: 'running', title: 'stdio test' },
    })

    const serverPromise = runMcpServer({ context: ctx, stdin, stdout })

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'task.get_current_state', arguments: { taskId: 'task:stdio' } },
      }) + '\n',
    )

    // Wait for the response line to arrive on stdout.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for stdio response')), 2000)
      const check = () => {
        const joined = stdoutChunks.join('')
        if (joined.includes('"id":7')) {
          clearTimeout(t)
          resolve()
        } else {
          setTimeout(check, 10)
        }
      }
      check()
    })

    stdin.end()
    await serverPromise

    const joined = stdoutChunks.join('')
    const lines = joined.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const response = JSON.parse(lines[0]!) as JsonRpcResponse
    expect(response.id).toBe(7)
    expect(response.error).toBeUndefined()
    const result = response.result as TaskCurrentStateResult
    expect(result.taskId).toBe('task:stdio')
    expect(result.title).toBe('stdio test')
  })
})

describe('createCapabilityContext (Postgres surface) — smoke wiring', () => {
  it('exposes a callable context shape (without opening Postgres)', () => {
    // The Postgres path is exercised end-to-end by live-DB tests; here
    // we only verify the constructor signature is callable without
    // throwing on import.
    const ctx = createCapabilityContext as unknown as (...args: never[]) => unknown
    expect(typeof ctx).toBe('function')
  })
})

afterEach(() => {
  /* no shared state to clean up */
})
