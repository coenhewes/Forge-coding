/**
 * BeliefStore — typed persistence facade for the Active Repo Belief Graph.
 *
 * Wraps the lower-level `BeliefRepo`, `HypothesisRepo`, `ClaimRepo`,
 * `EvidenceRepo`, `ClaimEvidenceLinkRepo`, and `ProbeRepo` inside
 * `ForgeStateStore.tx(...)` so that every belief mutation lands in the
 * same transaction as its `trace_events` row.
 *
 * The class is intentionally narrow — it only exposes the methods the
 * belief engine, probe planner, truth-maintenance layer, and assurance
 * generator need. Each method either creates or refreshes the
 * in-memory `TaskBeliefState` view (built via `ActiveRepoBeliefGraph`)
 * so callers can chain updates without re-querying.
 *
 * Stub mode: when constructed with a no-op `StateStoreLike` (used by
 * the test suite when no Postgres is available), all writes succeed
 * against an in-memory map. This keeps the unit tests fast and
 * hermetic while letting live-DB tests still exercise the same code
 * paths against real Postgres.
 */
import { randomUUID } from 'node:crypto'
import type {
  BeliefNode,
  BeliefEdge,
  Claim,
  Contradiction,
  EvidenceRef,
  Hypothesis,
  ProbeRecommendation,
  TaskBeliefState,
} from '@forge/types'
import type { ForgeStateStore, TxContext } from '@forge/state-store'
import { clamp01 } from './util.js'

/** Minimal slice of `ForgeStateStore` that BeliefStore relies on. */
export interface StateStoreLike {
  tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T>
  /** Autocommit (non-transactional) read access to the repos. */
  readonly repos: {
    beliefs: TxContext['repos']['beliefs']
    hypotheses: TxContext['repos']['hypotheses']
    claims: TxContext['repos']['claims']
    evidence: TxContext['repos']['evidence']
    claimEvidenceLinks: TxContext['repos']['claimEvidenceLinks']
    probes: TxContext['repos']['probes']
  }
}

/** Optional clock for deterministic tests. */
export interface BeliefStoreOptions {
  now?: () => Date
  /**
   * Optional URN generator — defaults to crypto.randomUUID. Used in
   * tests so we can produce stable ids for assertions.
   */
  idFactory?: () => string
  /**
   * The task belief graph instance used to (re)build the in-memory
   * TaskBeliefState view. Required only if you call
   * `createTaskBeliefState` / `loadTaskBeliefState` and want a
   * hydrated view back; pure persistence callers can omit it.
   */
  graphBuilder?: TaskBeliefStateBuilder
}

export interface TaskBeliefStateBuilder {
  build(input: {
    taskId: string
    repoId: string
    goal: string
    acceptanceCriteria: string[]
    hypotheses: Hypothesis[]
    claims: Claim[]
  }): TaskBeliefState
}

const DEFAULT_NOW = (): Date => new Date()
const DEFAULT_ID = (): string => randomUUID()

/**
 * Pluggable input shape for `addHypothesis`. We accept a partial
 * `Hypothesis` so the caller can supply the meaningful fields (claim,
 * relevant domains, etc.) and let the store fill in timestamps.
 */
export type HypothesisInput = Omit<
  Hypothesis,
  'id' | 'status' | 'confidence' | 'supportingEvidence' | 'contradictingEvidence' | 'assumptions' | 'suggestedProbes' | 'suggestedPatchStrategies' | 'createdAt' | 'updatedAt'
> & {
  status?: Hypothesis['status']
  confidence?: number
}

/** Input for `addClaim`. */
export type ClaimInput = Omit<
  Claim,
  'id' | 'status' | 'confidence' | 'supportingEvidence' | 'contradictingEvidence' | 'missingEvidence' | 'verificationChecks' | 'createdAt' | 'updatedAt'
> & {
  status?: Claim['status']
  confidence?: number
}

export class BeliefStore {
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly builder?: TaskBeliefStateBuilder

  constructor(private readonly store: StateStoreLike, options: BeliefStoreOptions = {}) {
    this.now = options.now ?? DEFAULT_NOW
    this.idFactory = options.idFactory ?? DEFAULT_ID
    this.builder = options.graphBuilder
  }

  /**
   * Seed a task belief state: the repos row, the task row, an initial
   * `beliefs` row, plus the caller-supplied hypotheses and claims.
   * Returns the hydrated `TaskBeliefState` view.
   *
   * We expect the caller to have already inserted the `repos` and
   * `tasks` rows (or pass them in `input`). The belief store does not
   * own lifecycle of those — it just attaches belief-shaped data to
   * an existing task.
   */
  async createTaskBeliefState(
    taskId: string,
    input: {
      repoId: string
      goal: string
      acceptanceCriteria?: string[]
      hypotheses?: HypothesisInput[]
      claims?: ClaimInput[]
    },
  ): Promise<TaskBeliefState> {
    const nowIso = this.now().toISOString()
    const nowDate = this.now()

    const hypotheses: Hypothesis[] = (input.hypotheses ?? []).map((h) => this.toHypothesis(h, nowIso))
    const claims: Claim[] = (input.claims ?? []).map((c) => this.toClaim(c, nowIso))

    // Persist every shape that has a dedicated table.
    await this.store.tx(async (ctx) => {
      for (const h of hypotheses) {
        await ctx.repos.hypotheses.insert({
          id: h.id,
          taskId,
          claim: h.claim,
          status: h.status,
          confidence: h.confidence,
          relevantDomains: h.relevantDomains,
          relevantGraphNodes: h.relevantGraphNodes,
          payload: {},
        })
        await ctx.trace({
          type: 'hypothesis_added',
          taskId,
          repoId: input.repoId,
          actor: 'system',
          summary: `Hypothesis added: ${h.claim}`,
          payload: { hypothesisId: h.id, claim: h.claim, confidence: h.confidence },
        })
      }
      for (const c of claims) {
        await ctx.repos.claims.insert({
          id: c.id,
          taskId,
          acceptanceCriterionId: c.acceptanceCriterionRefs[0] ?? null,
          text: c.text,
          status: c.status,
          confidence: c.confidence,
          riskLevel: c.riskLevel,
          reviewerGuidance: c.reviewerGuidance ?? null,
          payload: {},
        })
        await ctx.trace({
          type: 'claim_added',
          taskId,
          repoId: input.repoId,
          actor: 'system',
          summary: `Claim added: ${c.text}`,
          payload: { claimId: c.id, riskLevel: c.riskLevel },
        })
      }
      await ctx.trace({
        type: 'belief_state_created',
        taskId,
        repoId: input.repoId,
        actor: 'system',
        summary: `Initial task belief state with ${hypotheses.length} hypotheses and ${claims.length} claims`,
        payload: { goal: input.goal, hypothesisCount: hypotheses.length, claimCount: claims.length },
      })
    })

    void nowDate
    return this.hydrateView({
      taskId,
      repoId: input.repoId,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      hypotheses,
      claims,
    })
  }

  /** Load (or rebuild) the in-memory `TaskBeliefState` view. */
  async loadTaskBeliefState(taskId: string): Promise<TaskBeliefState | null> {
    const hypotheses = await this.store.repos.hypotheses.listByTask(taskId)
    if (hypotheses.length === 0) return null
    const claims = await this.store.repos.claims.listByTask(taskId)
    const repoId = ''
    const goal = ''
    return this.hydrateView({
      taskId,
      repoId,
      goal,
      acceptanceCriteria: [],
      hypotheses: hypotheses.map(hypothesisRowToHypothesis),
      claims: claims.map((row) => claimRowToClaim(row, new Date().toISOString())),
    })
  }

  /** Add a hypothesis to a task. Returns the persisted row. */
  async addHypothesis(taskId: string, hyp: HypothesisInput): Promise<Hypothesis> {
    const nowIso = this.now().toISOString()
    const h = this.toHypothesis(hyp, nowIso)
    await this.store.tx(async (ctx) => {
      await ctx.repos.hypotheses.insert({
        id: h.id,
        taskId,
        claim: h.claim,
        status: h.status,
        confidence: h.confidence,
        relevantDomains: h.relevantDomains,
        relevantGraphNodes: h.relevantGraphNodes,
        payload: {},
      })
      await ctx.trace({
        type: 'hypothesis_added',
        taskId,
        actor: 'system',
        summary: `Hypothesis added: ${h.claim}`,
        payload: { hypothesisId: h.id, claim: h.claim, confidence: h.confidence },
      })
    })
    return h
  }

  /** Patch any subset of a hypothesis. */
  async updateHypothesis(taskId: string, hypId: string, patch: Partial<Hypothesis>): Promise<Hypothesis> {
    const nowIso = this.now().toISOString()
    const updated = await this.store.tx(async (ctx) => {
      const row = await ctx.repos.hypotheses.update(hypId, {
        claim: patch.claim,
        status: patch.status,
        confidence: patch.confidence,
        relevantDomains: patch.relevantDomains,
        relevantGraphNodes: patch.relevantGraphNodes,
        payload: {},
      })
      await ctx.trace({
        type: 'hypothesis_updated',
        taskId,
        actor: 'system',
        summary: `Hypothesis ${hypId} → status=${row.status} confidence=${row.confidence.toFixed(2)}`,
        payload: { hypothesisId: hypId, patch: serialisePatch(patch) },
      })
      return row
    })
    return {
      id: updated.id,
      claim: updated.claim,
      status: updated.status as Hypothesis['status'],
      confidence: updated.confidence,
      relevantDomains: updated.relevantDomains,
      relevantGraphNodes: updated.relevantGraphNodes,
      supportingEvidence: [],
      contradictingEvidence: [],
      assumptions: [],
      suggestedProbes: [],
      suggestedPatchStrategies: [],
      createdAt: updated.createdAt,
      updatedAt: nowIso,
    }
  }

  /**
   * Mark a hypothesis as contradicted/disproven with explicit
   * evidence and a human-readable reason. Updates the row, emits a
   * trace event with the reason, and returns the updated hypothesis.
   */
  async invalidateHypothesis(
    taskId: string,
    hypId: string,
    reason: string,
    contradictingEvidenceIds: string[],
  ): Promise<Hypothesis> {
    return this.updateHypothesis(taskId, hypId, {
      status: contradictingEvidenceIds.length > 0 ? 'contradicted' : 'disproven',
      confidence: 0.05,
    }).then(async (h) => {
      // Patch the payload to record the reason + evidence (re-update).
      await this.store.repos.hypotheses.update(hypId, {
        payload: { reason, contradictingEvidenceIds },
      })
      return h
    })
  }

  /** Insert a claim. */
  async addClaim(taskId: string, claim: ClaimInput): Promise<Claim> {
    const nowIso = this.now().toISOString()
    const c = this.toClaim(claim, nowIso)
    await this.store.tx(async (ctx) => {
      await ctx.repos.claims.insert({
        id: c.id,
        taskId,
        acceptanceCriterionId: c.acceptanceCriterionRefs[0] ?? null,
        text: c.text,
        status: c.status,
        confidence: c.confidence,
        riskLevel: c.riskLevel,
        reviewerGuidance: c.reviewerGuidance ?? null,
        payload: {},
      })
      await ctx.trace({
        type: 'claim_added',
        taskId,
        actor: 'system',
        summary: `Claim added: ${c.text}`,
        payload: { claimId: c.id, riskLevel: c.riskLevel },
      })
    })
    return c
  }

  /**
   * Link an evidence row to a claim with the given polarity. The
   * evidence row itself is expected to exist already (caller inserts
   * it via `store.repos.evidence.insert`); this method only manages
   * the link.
   */
  async attachEvidence(
    taskId: string,
    claimId: string,
    evidenceId: string,
    polarity: 'supports' | 'contradicts',
  ): Promise<void> {
    await this.store.tx(async (ctx) => {
      await ctx.repos.claimEvidenceLinks.insert({
        id: this.idFactory(),
        claimId,
        evidenceId,
        linkType: polarity,
      })
      await ctx.trace({
        type: 'evidence_attached',
        taskId,
        actor: 'system',
        summary: `Evidence ${evidenceId} ${polarity} claim ${claimId}`,
        payload: { claimId, evidenceId, polarity },
      })
    })
  }

  /**
   * Update a claim's confidence and status (e.g. after a verification
   * matrix run, a truth-maintenance pass, or a manual override).
   */
  async updateClaimConfidence(
    taskId: string,
    claimId: string,
    confidence: number,
    status: Claim['status'],
  ): Promise<Claim> {
    const nowIso = this.now().toISOString()
    const updated = await this.store.tx(async (ctx) => {
      const row = await ctx.repos.claims.update(claimId, {
        status,
        confidence: clamp01(confidence),
      })
      await ctx.trace({
        type: 'claim_confidence_updated',
        taskId,
        actor: 'system',
        summary: `Claim ${claimId} → confidence=${row.confidence?.toFixed(2) ?? 'n/a'} status=${row.status}`,
        payload: { claimId, confidence: row.confidence, status: row.status },
      })
      return row
    })
    return claimRowToClaim(updated, nowIso)
  }

  /** Record a contradiction (claim ↔ evidence). */
  async addContradiction(taskId: string, claimId: string, evidenceId: string, note: string): Promise<void> {
    await this.store.tx(async (ctx) => {
      await ctx.repos.claimEvidenceLinks.insert({
        id: this.idFactory(),
        claimId,
        evidenceId,
        linkType: 'contradicts',
      })
      await ctx.trace({
        type: 'contradiction_recorded',
        taskId,
        actor: 'system',
        summary: `Contradiction on claim ${claimId}: ${note}`,
        payload: { claimId, evidenceId, note },
      })
    })
  }

  /**
   * Add a probe recommendation. The probe lands in the `probes` table
   * with status='proposed'. The caller is responsible for running it
   * and then calling `recordProbeResult`.
   */
  async addProbe(taskId: string, probe: ProbeRecommendation): Promise<ProbeRecommendation> {
    await this.store.tx(async (ctx) => {
      await ctx.repos.probes.insert({
        id: probe.id,
        taskId,
        capability: probe.capability,
        status: 'proposed',
        expectedInformationGain: probe.expectedInformationGain,
        cost: probe.cost,
        risk: probe.risk,
        reason: probe.reason,
        input: probe.input ?? {},
        result: null,
      })
      await ctx.trace({
        type: 'probe_proposed',
        taskId,
        actor: 'system',
        summary: `Probe proposed: ${probe.capability}`,
        payload: { probeId: probe.id, capability: probe.capability },
      })
    })
    return probe
  }

  /**
   * Record the outcome of a probe. The polarity is stored in the
   * probe's `result.payload.outcome` so the planner can filter on it
   * later. Status moves to 'completed'.
   */
  async recordProbeResult(
    taskId: string,
    probeId: string,
    outcome: 'supports' | 'contradicts' | 'inconclusive',
    notes: string,
  ): Promise<void> {
    await this.store.tx(async (ctx) => {
      await ctx.repos.probes.update(probeId, {
        status: 'completed',
        result: { outcome, notes },
        completedAt: this.now().toISOString(),
      })
      await ctx.trace({
        type: 'probe_completed',
        taskId,
        actor: 'system',
        summary: `Probe ${probeId} → ${outcome}: ${notes}`,
        payload: { probeId, outcome, notes },
      })
    })
  }

  /* ---------------------------------------------------------------- *
   *  Internals
   * ---------------------------------------------------------------- */

  private toHypothesis(input: HypothesisInput, nowIso: string): Hypothesis {
    return {
      id: this.idFactory(),
      claim: input.claim,
      status: input.status ?? 'plausible',
      confidence: clamp01(input.confidence ?? 0.4),
      relevantDomains: input.relevantDomains ?? [],
      relevantGraphNodes: input.relevantGraphNodes ?? [],
      supportingEvidence: [],
      contradictingEvidence: [],
      assumptions: [],
      suggestedProbes: [],
      suggestedPatchStrategies: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    }
  }

  private toClaim(input: ClaimInput, nowIso: string): Claim {
    return {
      id: this.idFactory(),
      text: input.text,
      status: input.status ?? 'unverified',
      confidence: clamp01(input.confidence ?? 0),
      riskLevel: input.riskLevel,
      acceptanceCriterionRefs: input.acceptanceCriterionRefs ?? [],
      supportingEvidence: [],
      contradictingEvidence: [],
      missingEvidence: [],
      verificationChecks: [],
      reviewerGuidance: input.reviewerGuidance,
    }
  }

  private hydrateView(input: {
    taskId: string
    repoId: string
    goal: string
    acceptanceCriteria: string[]
    hypotheses: Hypothesis[]
    claims: Claim[]
  }): TaskBeliefState {
    if (this.builder) {
      return this.builder.build(input)
    }
    return defaultView(input)
  }
}

function serialisePatch(patch: Partial<Hypothesis>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [
      k,
      Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : v,
    ]),
  )
}

function hypothesisRowToHypothesis(row: {
  id: string
  claim: string
  status: string
  confidence: number
  relevantDomains: string[]
  relevantGraphNodes: string[]
  createdAt: string
  updatedAt: string
}): Hypothesis {
  return {
    id: row.id,
    claim: row.claim,
    status: row.status as Hypothesis['status'],
    confidence: row.confidence,
    relevantDomains: row.relevantDomains,
    relevantGraphNodes: row.relevantGraphNodes,
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function claimRowToClaim(
  row: {
    id: string
    text: string
    status: string
    confidence: number | null
    riskLevel: string | null
    acceptanceCriterionId: string | null
    reviewerGuidance: string | null
  },
  _nowIso: string,
): Claim {
  return {
    id: row.id,
    text: row.text,
    status: row.status as Claim['status'],
    confidence: row.confidence ?? 0,
    riskLevel: (row.riskLevel ?? 'low') as Claim['riskLevel'],
    acceptanceCriterionRefs: row.acceptanceCriterionId ? [row.acceptanceCriterionId] : [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    reviewerGuidance: row.reviewerGuidance ?? undefined,
  }
}

/** Build a minimal `TaskBeliefState` view (used when no graph builder is supplied). */
function defaultView(input: {
  taskId: string
  repoId: string
  goal: string
  acceptanceCriteria: string[]
  hypotheses: Hypothesis[]
  claims: Claim[]
}): TaskBeliefState {
  const nowIso = new Date().toISOString()
  // BeliefNode.status uses the narrower BeliefStatus union; map claim
  // statuses to the closest belief-status equivalent.
  const claimStatusToBelief: Record<Claim['status'], BeliefNode['status']> = {
    verified: 'verified',
    contradicted: 'contradicted',
    conflicted: 'contradicted',
    stale: 'stale',
    needs_human_review: 'needs_human_review',
    not_applicable: 'superseded',
    unverified: 'unknown',
    partially_verified: 'plausible',
  }
  const nodes: BeliefNode[] = [
    { id: `task:${input.taskId}`, type: 'Task', label: input.goal },
    ...input.hypotheses.map((h) => ({ id: h.id, type: 'Hypothesis' as const, label: h.claim, status: h.status, confidence: h.confidence })),
    ...input.claims.map((c) => ({ id: c.id, type: 'Claim' as const, label: c.text, status: claimStatusToBelief[c.status], confidence: c.confidence })),
  ]
  const edges: BeliefEdge[] = [
    ...input.hypotheses.map((h) => ({ id: `edge:localizes:${h.id}`, sourceId: `task:${input.taskId}`, targetId: h.id, type: 'localizes_to' as const, confidence: h.confidence })),
    ...input.claims.map((c) => ({ id: `edge:requires:${c.id}`, sourceId: `task:${input.taskId}`, targetId: c.id, type: 'requires_verification' as const, confidence: c.confidence })),
  ]
  return {
    taskId: input.taskId,
    repoId: input.repoId,
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
    selectedDomains: [],
    selectedGraphRegions: [],
    hypotheses: input.hypotheses,
    claims: input.claims,
    assumptions: [],
    uncertainties: [],
    evidenceRefs: [],
    contradictions: [],
    nodes,
    edges,
    verificationObligations: input.claims.map((c) => ({
      id: `obligation:${c.id}`,
      claimId: c.id,
      check: `Verify claim: ${c.text}`,
      riskLevel: c.riskLevel,
      required: c.riskLevel === 'high' || c.riskLevel === 'critical',
    })),
    humanReviewRequirements: [],
    updatedAt: nowIso,
  }
}

/* ---------------------------------------------------------------- *
 *  In-memory stub store — used by tests that don't want a live DB.
 *  Implements the same `StateStoreLike` surface; tx() runs the
 *  callback against a temporary Repos bag backed by Maps.
 * ---------------------------------------------------------------- */

interface StubRow {
  [k: string]: unknown
}

export interface InMemoryBeliefStoreOptions {
  now?: () => Date
  idFactory?: () => string
}

export class InMemoryBeliefStore {
  readonly beliefs = new Map<string, StubRow>()
  readonly hypotheses = new Map<string, StubRow>()
  readonly claims = new Map<string, StubRow>()
  readonly evidence = new Map<string, StubRow>()
  readonly claimEvidenceLinks = new Map<string, StubRow>()
  readonly probes = new Map<string, StubRow>()
  readonly traceEvents: Array<{ id: string; type: string; taskId?: string | null; payload: Record<string, unknown> }> = []

  constructor(private readonly opts: InMemoryBeliefStoreOptions = {}) {}

  /** Build a `StateStoreLike` that points at this in-memory bag. */
  asStateStoreLike(): StateStoreLike {
    const self = this
    return {
      tx: async <T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> => {
        // No real transaction — we just run the callback, then snapshot
        // the trace events it produced so callers can assert against them.
        const traceEventsBefore = self.traceEvents.length
        const repos = {
          beliefs: inMemoryBeliefRepo(self),
          hypotheses: inMemoryHypothesisRepo(self),
          claims: inMemoryClaimRepo(self),
          evidence: inMemoryEvidenceRepo(self),
          claimEvidenceLinks: inMemoryClaimEvidenceLinkRepo(self),
          probes: inMemoryProbeRepo(self),
        }
        const ctx: TxContext = {
          repos: repos as unknown as TxContext['repos'],
          trace: async (event) => {
            const row = {
              id: (self.opts.idFactory ?? randomUUID)(),
              type: event.type,
              taskId: event.taskId ?? null,
              payload: event.payload ?? {},
            }
            self.traceEvents.push(row)
            return { id: row.id, createdAt: new Date().toISOString() }
          },
        }
        const result = await fn(ctx)
        // We don't actually need a snapshot — tests can read the live
        // traceEvents array. But keeping this hook for symmetry.
        void traceEventsBefore
        return result
      },
      repos: {
        beliefs: inMemoryBeliefRepo(this),
        hypotheses: inMemoryHypothesisRepo(this),
        claims: inMemoryClaimRepo(this),
        evidence: inMemoryEvidenceRepo(this),
        claimEvidenceLinks: inMemoryClaimEvidenceLinkRepo(this),
        probes: inMemoryProbeRepo(this),
      },
    }
  }
}

function inMemoryBeliefRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['beliefs'] {
  return {
    listByTask: async (taskId: string) =>
      [...store.beliefs.values()]
        .filter((r) => r.taskId === taskId)
        .map((r) => ({ ...r }) as never),
  } as unknown as StateStoreLike['repos']['beliefs']
}

function inMemoryHypothesisRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['hypotheses'] {
  return {
    insert: async (input: Record<string, unknown>) => {
      const row = { ...input }
      store.hypotheses.set(String(input.id), row)
      return row as never
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = store.hypotheses.get(id)
      if (!existing) throw new Error(`Hypothesis not found: ${id}`)
      const next = { ...existing, ...patch }
      store.hypotheses.set(id, next)
      return next as never
    },
    get: async (id: string) => (store.hypotheses.has(id) ? ({ ...store.hypotheses.get(id)! } as never) : undefined),
    listByTask: async (taskId: string) =>
      [...store.hypotheses.values()]
        .filter((r) => r.taskId === taskId)
        .map((r) => ({ ...r }) as never),
  } as unknown as StateStoreLike['repos']['hypotheses']
}

function inMemoryClaimRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['claims'] {
  return {
    insert: async (input: Record<string, unknown>) => {
      const row = { ...input }
      store.claims.set(String(input.id), row)
      return row as never
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = store.claims.get(id)
      if (!existing) throw new Error(`Claim not found: ${id}`)
      const next = { ...existing, ...patch }
      store.claims.set(id, next)
      return next as never
    },
    get: async (id: string) => (store.claims.has(id) ? ({ ...store.claims.get(id)! } as never) : undefined),
    listByTask: async (taskId: string) =>
      [...store.claims.values()]
        .filter((r) => r.taskId === taskId)
        .map((r) => ({ ...r }) as never),
  } as unknown as StateStoreLike['repos']['claims']
}

function inMemoryEvidenceRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['evidence'] {
  return {
    insert: async (input: Record<string, unknown>) => {
      const row = { ...input }
      store.evidence.set(String(input.id), row)
      return row as never
    },
    get: async (id: string) => (store.evidence.has(id) ? ({ ...store.evidence.get(id)! } as never) : undefined),
    listByTask: async (taskId: string) =>
      [...store.evidence.values()]
        .filter((r) => r.taskId === taskId)
        .map((r) => ({ ...r }) as never),
    listByClaim: async (claimId: string) =>
      [...store.evidence.values()]
        .filter((r) =>
          [...store.claimEvidenceLinks.values()].some(
            (l) => l.claimId === claimId && l.evidenceId === r.id,
          ),
        )
        .map((r) => ({ ...r }) as never),
  } as unknown as StateStoreLike['repos']['evidence']
}

function inMemoryClaimEvidenceLinkRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['claimEvidenceLinks'] {
  return {
    insert: async (input: Record<string, unknown>) => {
      const existing = [...store.claimEvidenceLinks.values()].find(
        (l) => l.claimId === input.claimId && l.evidenceId === input.evidenceId && l.linkType === input.linkType,
      )
      if (existing) return existing as never
      const row = { ...input, createdAt: new Date().toISOString() }
      store.claimEvidenceLinks.set(String(input.id), row)
      return row as never
    },
    listByClaim: async (claimId: string) =>
      [...store.claimEvidenceLinks.values()]
        .filter((l) => l.claimId === claimId)
        .map((l) => ({ ...l }) as never),
  } as unknown as StateStoreLike['repos']['claimEvidenceLinks']
}

function inMemoryProbeRepo(store: InMemoryBeliefStore): StateStoreLike['repos']['probes'] {
  return {
    insert: async (input: Record<string, unknown>) => {
      const row = { ...input }
      store.probes.set(String(input.id), row)
      return row as never
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = store.probes.get(id)
      if (!existing) throw new Error(`Probe not found: ${id}`)
      const next = { ...existing, ...patch }
      store.probes.set(id, next)
      return next as never
    },
    listByTask: async (taskId: string) =>
      [...store.probes.values()]
        .filter((p) => p.taskId === taskId)
        .map((p) => ({ ...p }) as never),
  } as unknown as StateStoreLike['repos']['probes']
}

/**
 * The single public factory the test suite and any consumer uses to
 * build a BeliefStore from a `ForgeStateStore`. Keeps the call site
 * one line even if we add more dependencies later.
 */
export function createBeliefStore(
  store: ForgeStateStore,
  options?: BeliefStoreOptions,
): BeliefStore {
  return new BeliefStore(store as unknown as StateStoreLike, options)
}
