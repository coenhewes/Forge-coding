import { randomUUID } from 'node:crypto'
import type {
  BeliefEdge,
  BeliefNode,
  CapabilityObservation,
  Claim,
  EvidenceKind,
  EvidenceRef,
  Hypothesis,
  TaskBeliefState,
  VerificationAction,
} from '@forge/types'
import type { TxContext } from '@forge/state-store'

/**
 * Result of a verification action — what came back from running the
 * candidate. Pass/fail/error are the canonical outcomes; evidence id
 * is the durable pointer to the artifact; outputSummary is a short
 * human-readable string (last 200 chars of stdout, the test summary
 * line, etc.) that we persist in the trace event for audit.
 */
export interface ActionResult {
  /** "passed" | "failed" | "error" — for human-review we treat as "passed" with weak evidence. */
  status: 'passed' | 'failed' | 'error'
  /** Stable id of the evidence row that was created in the same txn. */
  evidenceId: string
  /** Short, durable summary of the action's output. Optional but recommended. */
  outputSummary?: string
  /** True if the evidence directly proves the targeted claim (e.g. test output) — default true. */
  strongEvidence?: boolean
  /** Free-form artifacts (test paths, files inspected, etc.) — goes into trace payload. */
  payload?: Record<string, unknown>
}

export interface RecordActionResultInput {
  taskId: string
  actionId: string
  action: VerificationAction
  result: ActionResult
  /** Belief graph for the task; updated in place and returned. */
  beliefState: TaskBeliefState
  /** Optional actor name for the trace event. */
  actor?: string
}

export interface RecordActionResultOutput {
  /** Updated claims (one per previously-linked claim). */
  updatedClaims: Claim[]
  /** Same evidence id passed in, echoed for convenience. */
  evidenceId: string
  /** Confidence deltas applied (per-claim). */
  confidenceDeltas: Array<{ claimId: string; before: number; after: number }>
  /** Belief graph with new evidence ref + belief updates. */
  beliefState: TaskBeliefState
  /** The trace event id written inside the txn. */
  traceEventId: string
}

/**
 * Update a single claim's confidence based on a verification result.
 * Exported for unit tests.
 *
 * Rules (from the spec):
 *   pass + strong evidence ⇒ confidence += (1 - confidence) * 0.5
 *   pass + weak evidence   ⇒ confidence += (1 - confidence) * 0.2
 *   fail                   ⇒ confidence -= confidence * 0.6
 *
 * Multiple passes stabilize (asymptote → 1.0); failures don't reset
 * to 0 because we only take 60% of whatever the current confidence is.
 */
export function applyConfidenceDelta(claim: Claim, result: ActionResult): {
  next: Claim
  delta: { claimId: string; before: number; after: number }
} {
  const before = claim.confidence
  let after = before
  if (result.status === 'passed') {
    const factor = result.strongEvidence === false ? 0.2 : 0.5
    after = before + (1 - before) * factor
    if (after < before) after = before // never decrease on pass
  } else {
    after = before - before * 0.6
    if (after > before) after = before // sanity guard
  }
  after = clamp01(round2(after))

  const next: Claim = result.status === 'passed'
    ? {
        ...claim,
        confidence: after,
        status: after >= thresholdForRisk(claim.riskLevel) ? 'verified' : (claim.status === 'verified' ? 'verified' : 'partially_verified'),
        supportingEvidence: claim.supportingEvidence.some((e) => e.id === result.evidenceId)
          ? claim.supportingEvidence
          : [...claim.supportingEvidence, { id: result.evidenceId }],
        missingEvidence: claim.missingEvidence.filter(() => result.status === 'passed'),
        staleReason: result.status === 'passed' ? undefined : claim.staleReason,
      }
    : {
        ...claim,
        confidence: after,
        status: 'contradicted',
        contradictingEvidence: claim.contradictingEvidence.some((e) => e.id === result.evidenceId)
          ? claim.contradictingEvidence
          : [...claim.contradictingEvidence, { id: result.evidenceId }],
      }

  return { next, delta: { claimId: claim.id, before, after } }
}

/**
 * Update the belief graph with a new evidence ref and per-claim
 * confidence deltas. Adds evidence / claim nodes and `supports` /
 * `contradicts` edges as appropriate.
 */
export function updateBeliefGraph(state: TaskBeliefState, claim: Claim, result: ActionResult, beforeConfidence: number): TaskBeliefState {
  const evidenceRef: EvidenceRef = { id: result.evidenceId, summary: result.outputSummary }
  const now = new Date().toISOString()
  const evidenceNode: BeliefNode = {
    id: `evidence:${evidenceRef.id}`,
    type: 'Evidence',
    label: result.outputSummary ?? evidenceRef.id,
    status: result.status === 'passed' ? 'verified' : 'contradicted',
    confidence: result.status === 'passed' ? Math.max(beforeConfidence, claim.confidence) : beforeConfidence,
    payload: { kind: inferEvidenceKind(result) },
  }
  const evidenceEdge: BeliefEdge = {
    id: `edge:${evidenceRef.id}:${claim.id}`,
    sourceId: evidenceNode.id,
    targetId: claim.id,
    type: result.status === 'passed' ? 'supports' : 'contradicts',
    confidence: claim.confidence,
  }

  const updatedClaimNode = state.nodes.find((n) => n.id === claim.id)
  const newNodes = state.nodes.filter((n) => n.id !== claim.id)
  if (updatedClaimNode) {
    newNodes.push({ ...updatedClaimNode, status: claim.status === 'contradicted' ? 'contradicted' : claim.status === 'verified' ? 'verified' : 'plausible', confidence: claim.confidence })
  } else {
    newNodes.push({ id: claim.id, type: 'Claim', label: claim.text, status: claim.status === 'verified' ? 'verified' : 'plausible', confidence: claim.confidence })
  }
  newNodes.push(evidenceNode)

  return {
    ...state,
    claims: state.claims.map((c) => (c.id === claim.id ? claim : c)),
    evidenceRefs: state.evidenceRefs.some((e) => e.id === evidenceRef.id)
      ? state.evidenceRefs
      : [...state.evidenceRefs, evidenceRef],
    nodes: newNodes,
    edges: [...state.edges, evidenceEdge],
    updatedAt: now,
  }
}

/**
 * Record the result of a verification action: update claim confidence,
 * update the belief graph, write a trace event, all in one transaction.
 *
 * The caller passes a `TxContext` from `store.tx(ctx => ...)` so the
 * writes and the trace event are co-transactional (rollback together).
 */
export async function recordActionResult(
  tx: TxContext,
  input: RecordActionResultInput,
): Promise<RecordActionResultOutput> {
  const updatedClaims: Claim[] = []
  const deltas: Array<{ claimId: string; before: number; after: number }> = []
  let beliefState = input.beliefState

  for (const claim of beliefState.claims) {
    if (!input.action.targetClaims.includes(claim.id)) continue
    const { next, delta } = applyConfidenceDelta(claim, input.result)
    // Persist claim update.
    await tx.repos.claims.update(claim.id, {
      status: next.status,
      confidence: next.confidence,
    })
    updatedClaims.push(next)
    deltas.push(delta)
    beliefState = updateBeliefGraph(beliefState, next, input.result, delta.before)
  }

  // Insert a verification_check row for the underlying action.
  await tx.repos.verificationChecks.insert({
    id: randomUUID(),
    taskId: input.taskId,
    acceptanceCriterionId: null,
    claimId: input.action.targetClaims[0] ?? null,
    checkType: input.action.actionType,
    command: input.action.command ?? null,
    status: input.result.status === 'passed' ? 'passed' : 'failed',
    evidenceId: input.result.evidenceId,
    riskLevel: input.action.targetRisks[0] ?? null,
    reason: input.action.selectionReason,
    staleReason: null,
    payload: {
      outputSummary: input.result.outputSummary,
      strongEvidence: input.result.strongEvidence ?? true,
      targetClaims: input.action.targetClaims,
    },
  })

  const traceEvent = await tx.trace({
    type: 'verification_action_result',
    taskId: input.taskId,
    actor: input.actor ?? 'system',
    summary: `${input.action.actionType} ${input.result.status} → ${deltas.length} claim(s) updated`,
    payload: {
      actionId: input.action.id,
      actionType: input.action.actionType,
      resultStatus: input.result.status,
      evidenceId: input.result.evidenceId,
      outputSummary: input.result.outputSummary,
      deltas,
    },
  })

  return {
    updatedClaims,
    evidenceId: input.result.evidenceId,
    confidenceDeltas: deltas,
    beliefState,
    traceEventId: traceEvent.id,
  }
}

function inferEvidenceKind(result: ActionResult): EvidenceKind {
  if (result.payload?.['screenshot']) return 'screenshot'
  if (result.payload?.['runtimeOutput']) return 'runtime_output'
  if (result.status === 'failed' || result.status === 'error') return 'test_result'
  return 'test_result'
}

function thresholdForRisk(risk: Claim['riskLevel']): number {
  if (risk === 'critical') return 0.9
  if (risk === 'high') return 0.8
  if (risk === 'medium') return 0.65
  return 0.5
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Pure helper: apply many results in sequence and return the final
 * claims. Used by tests so they don't need a Postgres connection.
 */
export function applyResultsToClaims(claims: Claim[], results: Array<{ action: VerificationAction; result: ActionResult }>): Claim[] {
  let next = [...claims]
  for (const { action, result } of results) {
    for (const claimId of action.targetClaims) {
      const claim = next.find((c) => c.id === claimId)
      if (!claim) continue
      const { next: updated } = applyConfidenceDelta(claim, result)
      next = next.map((c) => (c.id === claimId ? updated : c))
    }
  }
  return next
}

/**
 * Pure helper: apply a single result to a belief graph (in memory).
 * Used by tests.
 */
export function applyResultToBelief(state: TaskBeliefState, action: VerificationAction, result: ActionResult): TaskBeliefState {
  let next = state
  for (const claimId of action.targetClaims) {
    const claim = next.claims.find((c) => c.id === claimId)
    if (!claim) continue
    const { next: updated, delta } = applyConfidenceDelta(claim, result)
    next = updateBeliefGraph(next, updated, result, delta.before)
  }
  return next
}
