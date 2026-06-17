/**
 * MCP server for Forge — exposes Forge's internal state over JSON-RPC 2.0
 * on stdio.
 *
 * Wire format: one JSON-RPC 2.0 message per line on stdout. Input lines
 * are read from stdin. This is the MCP-over-stdio convention used by
 * Claude Desktop, Cursor, and the opencode MCP client (see
 * `_refs/opencode/packages/opencode/src/mcp/`).
 *
 * Three capabilities are exposed in this track:
 *
 *   - `task.get_current_state`     — read the latest `tasks` row + most
 *                                    recent `task_snapshots` summary for
 *                                    a taskId.
 *   - `belief.get_top_hypotheses`  — read the `hypotheses` rows for a
 *                                    task, sorted by confidence.
 *   - `verification.plan_next_action`
 *                                  — read claims for a task and run
 *                                    `ActiveVerificationPlanner.plan(...)`,
 *                                    returning the recommended action
 *                                    along with its score breakdown.
 *
 * Capabilities are pluggable. The default wiring (`createCapabilityContext`)
 * reads from `ForgeStateStore` against a real Postgres connection; tests
 * use `createInMemoryCapabilityContext` so the round-trip test runs
 * hermetically without a database.
 */
import { randomUUID } from 'node:crypto'
import { BeliefStore } from '@forge/belief'
import { ActiveVerificationPlanner } from '@forge/verification-planner'
import { ForgeStateStore } from '@forge/state-store'
import type {
  ActiveVerificationPlan,
  EvidenceValueScore,
  Hypothesis,
  RiskSeverity,
  VerificationAction,
} from '@forge/types'
import { defaultStateStoreConfig } from '@forge/state-store'

/** JSON-RPC 2.0 envelope (subset we accept/emit). */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** JSON-RPC error codes used by the server. */
export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** Schema advertised by `tools/list` for each capability. */
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required: string[]
  }
}

/** Argument bag for `task.get_current_state`. */
export interface GetCurrentStateArgs {
  taskId: string
}

/** Argument bag for `belief.get_top_hypotheses`. */
export interface GetTopHypothesesArgs {
  taskId: string
  limit?: number
}

/** Argument bag for `verification.plan_next_action`. */
export interface PlanNextActionArgs {
  taskId: string
  maxCandidates?: number
}

/** Response shape for `task.get_current_state`. */
export interface TaskCurrentStateResult {
  taskId: string
  status: string | null
  mode: string | null
  title: string | null
  interpretedGoal: string | null
  currentSummary: string | null
  nextAction: string | null
  activeBranch: string | null
  updatedAt: string | null
  latestSnapshot: { id: string; summary: string; createdAt: string } | null
}

/** Response shape for `belief.get_top_hypotheses`. */
export interface TopHypothesesResult {
  taskId: string
  hypotheses: Hypothesis[]
}

/** Response shape for `verification.plan_next_action`. */
export interface PlanNextActionResult {
  taskId: string
  recommendedAction: VerificationAction | null
  candidateActions: VerificationAction[]
  scores: EvidenceValueScore[]
  warnings: string[]
  generatedAt: string
}

/**
 * The capability context supplies the data each MCP tool reads from.
 *
 * Two implementations ship with this module:
 *   - `createCapabilityContext(store)` — backed by ForgeStateStore
 *     (Postgres).
 *   - `createInMemoryCapabilityContext(...)` — backed by maps, used by
 *     `tests/mcp.test.ts` so the round-trip test runs without a DB.
 */
export interface CapabilityContext {
  getCurrentState(args: GetCurrentStateArgs): Promise<TaskCurrentStateResult>
  getTopHypotheses(args: GetTopHypothesesArgs): Promise<TopHypothesesResult>
  planNextAction(args: PlanNextActionArgs): Promise<PlanNextActionResult>
}

/* ---------------------------------------------------------------- *
 *  Capability wiring — Postgres-backed
 * ---------------------------------------------------------------- */

/** Minimal surface of `ForgeStateStore` that the capability context needs. */
export interface StateStoreSurface {
  readonly repos: {
    tasks: {
      get(id: string): Promise<TaskRow | undefined>
    }
    taskSnapshots: {
      latest(taskId: string): Promise<TaskSnapshotRow | undefined>
    }
    claims: {
      listByTask(taskId: string): Promise<ClaimRow[]>
    }
  }
  tx<T>(fn: (ctx: unknown) => Promise<T>): Promise<T>
}

/** Row shape returned by `task_snapshots.latest`. */
export interface TaskSnapshotRow {
  id: string
  taskId: string
  snapshotType: string
  summary: string
  payload: Record<string, unknown>
  createdAt: string
}

/** Row shape returned by `tasks.get`. Mirrors `TaskRow` in
 * `@forge/state-store`'s typed repos. Re-declared here so the MCP
 * module doesn't have to depend on internal repo paths. */
export interface TaskRow {
  id: string
  repoId: string
  title: string
  originalRequest: string
  interpretedGoal: string | null
  status: string
  mode: string
  activeBranch: string | null
  activePatchCandidateId: string | null
  currentSummary: string | null
  nextAction: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** Row shape returned by `claims.listByTask`. */
export interface ClaimRow {
  id: string
  taskId: string
  text: string
  status: string
  confidence: number | null
  riskLevel: string | null
  acceptanceCriterionId: string | null
  reviewerGuidance: string | null
}

/**
 * Construct a capability context that reads from a live `ForgeStateStore`.
 *
 * `beliefStore` (optional) is used by `planNextAction` to read
 * hypotheses via the typed `BeliefStore.loadTaskBeliefState` path. If
 * omitted, the planner receives only the claims and no hypothesis
 * signal — still useful, still deterministic.
 */
export function createCapabilityContext(
  store: ForgeStateStore,
  options: { beliefStore?: BeliefStore } = {},
): CapabilityContext {
  // `BeliefStore`'s constructor types `StateStoreLike` tightly; the
  // production ForgeStateStore is structurally compatible but TS can't
  // infer it through the cross-package type. The same cast is used by
  // `createBeliefStore(store)` (see t20-belief-graph). Keeping the cast
  // local so the rest of this module sees a fully-typed context.
  const beliefStore =
    options.beliefStore ?? new BeliefStore(store as unknown as ConstructorParameters<typeof BeliefStore>[0])
  const planner = new ActiveVerificationPlanner()
  return {
    async getCurrentState({ taskId }) {
      const task = await store.repos.tasks.get(taskId)
      const snapshot = await store.repos.taskSnapshots.latest(taskId)
      return {
        taskId,
        status: task?.status ?? null,
        mode: task?.mode ?? null,
        title: task?.title ?? null,
        interpretedGoal: task?.interpretedGoal ?? null,
        currentSummary: task?.currentSummary ?? null,
        nextAction: task?.nextAction ?? null,
        activeBranch: task?.activeBranch ?? null,
        updatedAt: task?.updatedAt ?? null,
        latestSnapshot: snapshot
          ? { id: snapshot.id, summary: snapshot.summary, createdAt: snapshot.createdAt }
          : null,
      }
    },

    async getTopHypotheses({ taskId, limit }) {
      const beliefState = await beliefStore.loadTaskBeliefState(taskId)
      const all = beliefState?.hypotheses ?? []
      const sorted = [...all].sort((a, b) => b.confidence - a.confidence)
      const cap = Math.max(1, Math.min(limit ?? 5, sorted.length))
      return { taskId, hypotheses: sorted.slice(0, cap) }
    },

    async planNextAction({ taskId, maxCandidates }) {
      const beliefState = await beliefStore.loadTaskBeliefState(taskId)
      const claimRows = await store.repos.claims.listByTask(taskId)
      const claims = claimRows.map(claimRowToClaim)
      const plan: ActiveVerificationPlan = planner.plan({
        taskId,
        claims,
        hypotheses: beliefState?.hypotheses ?? [],
      })
      const capped = Math.max(1, maxCandidates ?? 5)
      const candidateActions = plan.candidateActions.slice(0, capped)
      const candidateIds = new Set(candidateActions.map((a) => a.id))
      return {
        taskId,
        recommendedAction: plan.recommendedAction
          ? candidateIds.has(plan.recommendedAction.id)
            ? plan.recommendedAction
            : candidateActions[0] ?? null
          : candidateActions[0] ?? null,
        candidateActions,
        scores: plan.scores.filter((s) => candidateIds.has(s.actionId)),
        warnings: plan.warnings,
        generatedAt: plan.generatedAt,
      }
    },
  }
}

/* ---------------------------------------------------------------- *
 *  In-memory capability context — used by the round-trip test so the
 *  capability handler is exercised without Postgres.
 * ---------------------------------------------------------------- */

export interface InMemoryHypothesisSeed {
  id?: string
  claim: string
  status?: Hypothesis['status']
  confidence: number
  relevantDomains?: string[]
}

export interface InMemoryClaimSeed {
  id?: string
  text: string
  status?: string
  confidence?: number
  riskLevel?: RiskSeverity
}

export interface InMemoryTaskSeed {
  id: string
  status?: string
  mode?: string
  title?: string
  interpretedGoal?: string | null
  currentSummary?: string | null
  nextAction?: string | null
  activeBranch?: string | null
  updatedAt?: string | null
}

export interface InMemorySnapshotSeed {
  id?: string
  summary: string
}

export interface InMemoryCapabilityContextOptions {
  task?: InMemoryTaskSeed
  snapshot?: InMemorySnapshotSeed
  hypotheses?: InMemoryHypothesisSeed[]
  claims?: InMemoryClaimSeed[]
}

/**
 * Build a `CapabilityContext` backed by plain in-memory data. The
 * planner is the real `ActiveVerificationPlanner` so the response
 * shape is identical to the live-DB path; only the read sources are
 * stubs. This is what `tests/mcp.test.ts` uses for the round-trip
 * test, so the test runs hermetically without Postgres.
 */
export function createInMemoryCapabilityContext(
  opts: InMemoryCapabilityContextOptions,
): CapabilityContext {
  const planner = new ActiveVerificationPlanner()
  const nowIso = new Date().toISOString()
  // The DB row shape (`tasks` table) — not the higher-level `TaskState`
  // (which carries harness concepts like `currentInterpretation` and
  // `acceptanceCriteria`). `getCurrentState` reads whichever subset the
  // MCP capability surface cares about.
  type DbTaskRow = {
    id: string
    title: string | null
    status: string | null
    mode: string | null
    interpretedGoal: string | null
    currentSummary: string | null
    nextAction: string | null
    activeBranch: string | null
    updatedAt: string | null
  }
  const task: DbTaskRow | null = opts.task
    ? {
        id: opts.task.id,
        title: opts.task.title ?? 'in-memory task',
        status: opts.task.status ?? 'running',
        mode: opts.task.mode ?? 'autonomous',
        interpretedGoal: opts.task.interpretedGoal ?? null,
        currentSummary: opts.task.currentSummary ?? null,
        nextAction: opts.task.nextAction ?? null,
        activeBranch: opts.task.activeBranch ?? null,
        updatedAt: opts.task.updatedAt ?? nowIso,
      }
    : null
  const snapshot = opts.snapshot
    ? {
        id: opts.snapshot.id ?? randomUUID(),
        taskId: opts.task?.id ?? 'task:test',
        snapshotType: 'manual',
        summary: opts.snapshot.summary,
        payload: {},
        createdAt: nowIso,
      }
    : null
  const hypotheses: Hypothesis[] = (opts.hypotheses ?? []).map((h, i) => ({
    id: h.id ?? `hyp:${i}`,
    claim: h.claim,
    status: h.status ?? 'plausible',
    confidence: h.confidence,
    relevantDomains: h.relevantDomains ?? [],
    relevantGraphNodes: [],
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  }))
  const claims = (opts.claims ?? []).map((c, i) => ({
    id: c.id ?? `claim:${i}`,
    text: c.text,
    status: (c.status ?? 'unverified') as TaskCurrentStateResult['status'] extends string
      ? string
      : string,
    confidence: c.confidence ?? 0.4,
    riskLevel: c.riskLevel ?? ('medium' as RiskSeverity),
    acceptanceCriterionRefs: [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    reviewerGuidance: undefined,
  }))

  return {
    async getCurrentState({ taskId }) {
      return {
        taskId,
        status: task?.status ?? null,
        mode: task?.mode ?? null,
        title: task?.title ?? null,
        interpretedGoal: task?.interpretedGoal ?? null,
        currentSummary: task?.currentSummary ?? null,
        nextAction: task?.nextAction ?? null,
        activeBranch: task?.activeBranch ?? null,
        updatedAt: task?.updatedAt ?? null,
        latestSnapshot: snapshot
          ? { id: snapshot.id, summary: snapshot.summary, createdAt: snapshot.createdAt }
          : null,
      }
    },

    async getTopHypotheses({ taskId, limit }) {
      const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence)
      const cap = Math.max(1, Math.min(limit ?? 5, sorted.length || 1))
      return { taskId, hypotheses: sorted.slice(0, cap) }
    },

    async planNextAction({ taskId, maxCandidates }) {
      const plan = planner.plan({
        taskId,
        claims: claims as unknown as Parameters<typeof planner.plan>[0]['claims'],
        hypotheses,
      })
      const capped = Math.max(1, maxCandidates ?? 5)
      const candidateActions = plan.candidateActions.slice(0, capped)
      const candidateIds = new Set(candidateActions.map((a) => a.id))
      return {
        taskId,
        recommendedAction:
          plan.recommendedAction && candidateIds.has(plan.recommendedAction.id)
            ? plan.recommendedAction
            : candidateActions[0] ?? null,
        candidateActions,
        scores: plan.scores.filter((s) => candidateIds.has(s.actionId)),
        warnings: plan.warnings,
        generatedAt: plan.generatedAt,
      }
    },
  }
}

/* ---------------------------------------------------------------- *
 *  Tool registry
 * ---------------------------------------------------------------- */

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'task.get_current_state',
    description:
      'Read the latest task row and most recent snapshot for a given taskId from the Forge state store.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task identifier.' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'belief.get_top_hypotheses',
    description:
      'Return the highest-confidence hypotheses for a task, sorted by confidence. `limit` defaults to 5.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task identifier.' },
        limit: { type: 'integer', description: 'Max number of hypotheses to return (default 5).' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'verification.plan_next_action',
    description:
      'Run ActiveVerificationPlanner against a task and return the recommended verification action plus the full score breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task identifier.' },
        maxCandidates: { type: 'integer', description: 'Cap on returned candidates (default 5).' },
      },
      required: ['taskId'],
    },
  },
]

/** Dispatch a `tools/call` RPC method to the capability handler. */
async function dispatchToolCall(
  ctx: CapabilityContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'task.get_current_state': {
      const taskId = requireString(args, 'taskId')
      return ctx.getCurrentState({ taskId })
    }
    case 'belief.get_top_hypotheses': {
      const taskId = requireString(args, 'taskId')
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return ctx.getTopHypotheses({ taskId, limit })
    }
    case 'verification.plan_next_action': {
      const taskId = requireString(args, 'taskId')
      const maxCandidates =
        typeof args.maxCandidates === 'number' ? args.maxCandidates : undefined
      return ctx.planNextAction({ taskId, maxCandidates })
    }
    default:
      throw makeRpcError(RPC_ERROR.METHOD_NOT_FOUND, `Unknown tool: ${name}`)
  }
}

/* ---------------------------------------------------------------- *
 *  Server loop — JSON-RPC over stdio
 * ---------------------------------------------------------------- */

export interface McpServerOptions {
  /** Source of capability data. Required. */
  context: CapabilityContext
  /** Stdin to read requests from (defaults to process.stdin). */
  stdin?: NodeJS.ReadableStream
  /** Stdout to write responses to (defaults to process.stdout). */
  stdout?: NodeJS.WritableStream
  /** Optional logger sink — receives one-line human messages per request. */
  logger?: (line: string) => void
}

/** Start the MCP server loop. Resolves when the input stream ends. */
export function runMcpServer(opts: McpServerOptions): Promise<void> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const log = opts.logger ?? (() => undefined)
  return new Promise<void>((resolve) => {
    let buffer = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.length > 0) void handleLine(line)
        nl = buffer.indexOf('\n')
      }
    })
    stdin.on('end', () => resolve())
    stdin.on('close', () => resolve())

    async function handleLine(raw: string) {
      const response = await handleRawRpc(raw, opts.context, log)
      if (response !== null) {
        stdout.write(JSON.stringify(response) + '\n')
      }
    }
  })
}

/** Handle a single line of input. Returns the response (or null for notifications). */
export async function handleRawRpc(
  raw: string,
  ctx: CapabilityContext,
  log: (line: string) => void = () => undefined,
): Promise<JsonRpcResponse | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(`rpc: parse_error raw=${raw.slice(0, 120)}`)
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_ERROR.PARSE_ERROR, message: 'Invalid JSON' },
    }
  }
  if (!isJsonRpcRequest(parsed)) {
    log('rpc: invalid_request')
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_ERROR.INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 request' },
    }
  }
  const { id, method, params } = parsed
  log(`rpc: method=${method} id=${String(id ?? '')}`)
  try {
    const result = await dispatchMethod(method, params ?? {}, ctx)
    if (id === undefined) return null
    return { jsonrpc: '2.0', id: id ?? null, result }
  } catch (err) {
    const rpcErr = toRpcError(err)
    return { jsonrpc: '2.0', id: id ?? null, error: rpcErr }
  }
}

function dispatchMethod(
  method: string,
  params: Record<string, unknown>,
  ctx: CapabilityContext,
): Promise<unknown> | unknown {
  if (method === 'tools/list') {
    return { tools: TOOL_DESCRIPTORS }
  }
  if (method === 'tools/call') {
    const name = params.name
    if (typeof name !== 'string' || name.length === 0) {
      throw makeRpcError(RPC_ERROR.INVALID_PARAMS, 'tools/call requires `name`')
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>
    return dispatchToolCall(ctx, name, args)
  }
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'forge-mcp', version: '0.0.1' },
      capabilities: { tools: {} },
    }
  }
  if (method === 'ping') {
    return {}
  }
  throw makeRpcError(RPC_ERROR.METHOD_NOT_FOUND, `Unknown method: ${method}`)
}

/* ---------------------------------------------------------------- *
 *  CLI wiring helper — `forge mcp serve` uses this to construct a
 *  CapabilityContext from FORGE_DATABASE_URL and run the server loop
 *  against process.stdin / process.stdout.
 * ---------------------------------------------------------------- */

/**
 * Connect to Postgres (FORGE_DATABASE_URL required), wire up the
 * capability context, and run the stdio server loop until EOF.
 * Returns the exit code the CLI should use (0 on clean EOF).
 */
export async function runMcpServeFromEnv(
  rootDir = process.cwd(),
  options: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {},
): Promise<number> {
  const connectionString = process.env.FORGE_DATABASE_URL
  if (!connectionString) {
    process.stderr.write('FORGE_DATABASE_URL is not set; cannot start MCP server.\n')
    return 1
  }
  const store = new ForgeStateStore({ config: defaultStateStoreConfig(rootDir, connectionString) })
  try {
    await store.init()
  } catch (err) {
    process.stderr.write(
      `Failed to open state store: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }
  const ctx = createCapabilityContext(store)
  await runMcpServer({
    context: ctx,
    stdin: options.stdin,
    stdout: options.stdout,
  })
  return 0
}

/* ---------------------------------------------------------------- *
 *  Helpers
 * ---------------------------------------------------------------- */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw makeRpcError(RPC_ERROR.INVALID_PARAMS, `Missing string argument: ${key}`)
  }
  return value
}

function makeRpcError(code: number, message: string, data?: unknown): Error & {
  rpcCode: number
  rpcData?: unknown
} {
  const err = new Error(message) as Error & { rpcCode: number; rpcData?: unknown }
  err.rpcCode = code
  err.rpcData = data
  return err
}

function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err && typeof err === 'object' && 'rpcCode' in err && typeof (err as { rpcCode: unknown }).rpcCode === 'number') {
    const e = err as { rpcCode: number; message?: string; rpcData?: unknown }
    return {
      code: e.rpcCode,
      message: typeof e.message === 'string' ? e.message : 'RPC error',
      data: e.rpcData,
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { code: RPC_ERROR.INTERNAL_ERROR, message }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.jsonrpc !== '2.0') return false
  if (typeof v.method !== 'string') return false
  if (v.id !== undefined && v.id !== null && typeof v.id !== 'string' && typeof v.id !== 'number') {
    return false
  }
  return true
}

function claimRowToClaim(row: ClaimRow): import('@forge/types').Claim {
  return {
    id: row.id,
    text: row.text,
    status: (row.status ?? 'unverified') as import('@forge/types').Claim['status'],
    confidence: row.confidence ?? 0,
    riskLevel: (row.riskLevel ?? 'medium') as RiskSeverity,
    acceptanceCriterionRefs: row.acceptanceCriterionId ? [row.acceptanceCriterionId] : [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    reviewerGuidance: row.reviewerGuidance ?? undefined,
  }
}
