/**
 * @forge/context-server — typed, permissioned access to durable Forge state.
 *
 * The model-facing harness should not query Postgres directly. This package is
 * the narrow context surface: callers ask for named capabilities and receive a
 * compact `ContextSlice`, or perform named writes that are persisted with a
 * co-transactional trace event.
 */
import { randomUUID } from 'node:crypto'
import type { ContextSlice, StateStoreActor } from '@forge/types'
import type {
  ArtifactRow,
  ClaimInsert,
  DecisionInsert,
  EvidenceInsert,
  FailureInsert,
  ForgeStateStore,
  HypothesisInsert,
  PatchCandidateInsert,
  ProbeInsert,
  PromptInsert,
  SessionInsert,
  VerificationActionClaimLinkInsert,
  VerificationActionInsert,
  VerificationActionScoreInsert,
  VerificationCheckInsert,
  VerificationHistoryInsert,
} from '@forge/state-store'

export const CONTEXT_SERVER_VERSION = '0.1.0'
export const CONTEXT_SERVER_CAPABILITY = 'forge.context_server'

export type ContextReadCapability =
  | 'task.get_current_state'
  | 'task.resume'
  | 'belief.get_top_hypotheses'
  | 'belief.get_open_uncertainties'
  | 'evidence.get_for_claim'
  | 'evidence.get_exact_artifact'
  | 'failure.get_disproven_paths'
  | 'decision.get_relevant_decisions'
  | 'repo.get_related_graph_region'
  | 'tests.get_affected_tests'
  | 'verification.get_open_matrix'
  | 'pr.get_review_guidance'
  | 'trace.get_recent_events'

export type ContextWriteCapability =
  | 'task.record_snapshot'
  | 'task.record_session'
  | 'task.record_prompt'
  | 'belief.record_hypothesis'
  | 'belief.update_hypothesis'
  | 'claim.record'
  | 'claim.update'
  | 'evidence.record'
  | 'evidence.link_claim'
  | 'failure.record'
  | 'decision.record'
  | 'probe.record'
  | 'probe.record_result'
  | 'verification.record_check'
  | 'verification.record_action'
  | 'verification.record_action_score'
  | 'verification.link_action_claim'
  | 'verification.record_history'
  | 'patch.record_candidate'
  | 'command.record'
  | 'artifact.record'
  | 'trace.record_event'

export interface ContextServerHandle {
  readonly version: string
  readonly capability: string
  read<T = unknown>(capability: ContextReadCapability, input: ContextReadInput): Promise<ContextSlice<T>>
  write<T = unknown>(capability: ContextWriteCapability, input: ContextWriteInput, options?: ContextWriteOptions): Promise<ContextWriteReceipt<T>>
}

export interface ContextReadInput {
  taskId?: string
  repoId?: string
  claimId?: string
  artifactId?: string
  limit?: number
  path?: string
  status?: string
}

export type ContextWriteInput =
  | { snapshot: { id?: string; taskId: string; snapshotType: string; summary: string; payload?: Record<string, unknown> } }
  | { session: SessionInsert }
  | { prompt: PromptInsert }
  | { hypothesis: HypothesisInsert }
  | { hypothesisId: string; patch: Record<string, unknown> }
  | { claim: ClaimInsert }
  | { claimId: string; patch: Record<string, unknown> }
  | { evidence: EvidenceInsert }
  | { claimId: string; evidenceId: string; linkType: string; id?: string }
  | { failure: FailureInsert }
  | { decision: DecisionInsert }
  | { probe: ProbeInsert }
  | { probeId: string; status: string; result?: Record<string, unknown> }
  | { verificationCheck: VerificationCheckInsert }
  | { verificationAction: VerificationActionInsert }
  | { verificationActionScore: VerificationActionScoreInsert }
  | { verificationActionClaimLink: VerificationActionClaimLinkInsert }
  | { verificationHistory: VerificationHistoryInsert }
  | { patchCandidate: PatchCandidateInsert }
  | { command: Parameters<ForgeStateStore['repos']['commands']['insert']>[0] }
  | { artifact: Parameters<ForgeStateStore['repos']['artifacts']['insert']>[0] }
  | { trace: { type: string; taskId?: string | null; repoId?: string | null; actor?: string; summary: string; payload?: Record<string, unknown> } }

export interface ContextWriteOptions {
  actor?: StateStoreActor
}

export interface ContextWriteReceipt<T = unknown> {
  capability: ContextWriteCapability
  id: string
  actor: StateStoreActor
  traceEventId: string
  data: T
}

export interface ForgeContextServerOptions {
  store: ForgeStateStore
}

export class ForgeContextServer implements ContextServerHandle {
  readonly version = CONTEXT_SERVER_VERSION
  readonly capability = CONTEXT_SERVER_CAPABILITY

  constructor(private options: ForgeContextServerOptions) {}

  async read<T = unknown>(capability: ContextReadCapability, input: ContextReadInput): Promise<ContextSlice<T>> {
    const store = this.options.store
    const taskId = input.taskId
    const warnings: string[] = []

    switch (capability) {
      case 'task.get_current_state':
      case 'task.resume': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const [task, snapshots, sessions, prompts] = await Promise.all([
          store.repos.tasks.get(taskId),
          store.repos.taskSnapshots.listByTask(taskId, input.limit ?? 5),
          store.repos.sessions.listByTask(taskId),
          store.repos.prompts.listByTask(taskId),
        ])
        return store.contextSlice(capability, { task, snapshots, sessions, prompts } as T, {
          taskId,
          sources: ['tasks', 'task_snapshots', 'sessions', 'prompts'],
          warnings: task ? warnings : [`Task not found: ${taskId}`],
          missing: task ? [] : ['task'],
          stale: false,
        })
      }

      case 'belief.get_top_hypotheses': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const hypotheses = await store.repos.hypotheses.listByTask(taskId)
        return store.contextSlice(capability, hypotheses.slice(0, input.limit ?? 5) as T, {
          taskId,
          sources: ['hypotheses'],
          relevanceScore: hypotheses.length > 0 ? 1 : 0,
        })
      }

      case 'belief.get_open_uncertainties': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const beliefs = await store.repos.beliefs.listByTask(taskId)
        const uncertainties = beliefs.filter((b) => b.status === 'unknown' || b.status === 'plausible' || b.payload?.uncertainty === true)
        return store.contextSlice(capability, uncertainties.slice(0, input.limit ?? 10) as T, {
          taskId,
          sources: ['beliefs'],
        })
      }

      case 'evidence.get_for_claim': {
        if (!input.claimId) return missingSlice<T>(store, capability, input, 'claimId')
        const [claim, evidence, links] = await Promise.all([
          store.repos.claims.get(input.claimId),
          store.repos.evidence.listByClaim(input.claimId),
          store.repos.claimEvidenceLinks.listByClaim(input.claimId),
        ])
        return store.contextSlice(capability, { claim, evidence, links } as T, {
          taskId: claim?.taskId,
          sources: ['claims', 'evidence', 'claim_evidence_links'],
          missing: claim ? [] : ['claim'],
        })
      }

      case 'evidence.get_exact_artifact': {
        if (!input.artifactId) return missingSlice<T>(store, capability, input, 'artifactId')
        const artifact = await store.getArtifact(input.artifactId)
        const data = artifact
          ? {
              metadata: artifact.metadata,
              bytesBase64: artifact.bytes.toString('base64'),
              textPreview: textPreview(artifact.metadata, artifact.bytes),
            }
          : undefined
        return store.contextSlice(capability, data as T, {
          sources: ['artifacts', 'artifact_store'],
          warnings: artifact ? [] : [`Artifact not found: ${input.artifactId}`],
          missing: artifact ? [] : ['artifact'],
        })
      }

      case 'failure.get_disproven_paths': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const [failures, hypotheses] = await Promise.all([
          store.repos.failures.listByTask(taskId),
          store.repos.hypotheses.listByTask(taskId),
        ])
        return store.contextSlice(capability, {
          failures,
          disprovenHypotheses: hypotheses.filter((h) => h.status === 'disproven' || h.status === 'contradicted'),
        } as T, {
          taskId,
          sources: ['failures', 'hypotheses'],
        })
      }

      case 'decision.get_relevant_decisions': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const decisions = await store.repos.decisions.listRecent(taskId, input.limit ?? 10)
        return store.contextSlice(capability, decisions as T, { taskId, sources: ['decisions'] })
      }

      case 'repo.get_related_graph_region': {
        if (!input.repoId) return missingSlice<T>(store, capability, input, 'repoId')
        const [nodes, edges] = await Promise.all([
          store.repos.repoNodes.listByRepo(input.repoId),
          store.repos.repoEdges.listByRepo(input.repoId),
        ])
        const filteredNodes = input.path ? nodes.filter((n) => n.path?.includes(input.path!) || n.name.includes(input.path!)) : nodes
        const nodeIds = new Set(filteredNodes.map((n) => n.id))
        const filteredEdges = edges.filter((e) => nodeIds.has(e.sourceNodeId) || nodeIds.has(e.targetNodeId))
        return store.contextSlice(capability, {
          nodes: filteredNodes.slice(0, input.limit ?? 50),
          edges: filteredEdges.slice(0, input.limit ?? 100),
        } as T, {
          sources: ['repo_nodes', 'repo_edges'],
          relevanceScore: filteredNodes.length > 0 ? 1 : 0,
        })
      }

      case 'tests.get_affected_tests': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const checks = await store.repos.verificationChecks.listByTask(taskId)
        return store.contextSlice(capability, checks.filter((c) => c.checkType.includes('test')) as T, {
          taskId,
          sources: ['verification_checks'],
        })
      }

      case 'verification.get_open_matrix': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const [checks, actions] = await Promise.all([
          store.repos.verificationChecks.listByTask(taskId),
          store.repos.verificationActions.listByTask(taskId),
        ])
        const openStatuses = new Set(['candidate', 'selected', 'running', 'failed', 'blocked', 'stale', 'needs_human_review', 'unverified'])
        return store.contextSlice(capability, {
          checks: checks.filter((c) => !input.status || c.status === input.status),
          actions: actions.filter((a) => !input.status ? openStatuses.has(a.status) : a.status === input.status),
        } as T, {
          taskId,
          sources: ['verification_checks', 'verification_actions'],
        })
      }

      case 'pr.get_review_guidance': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const [task, claims, evidence, failures, decisions, checks, actions, patches] = await Promise.all([
          store.repos.tasks.get(taskId),
          store.repos.claims.listByTask(taskId),
          store.repos.evidence.listByTask(taskId),
          store.repos.failures.listByTask(taskId),
          store.repos.decisions.listByTask(taskId),
          store.repos.verificationChecks.listByTask(taskId),
          store.repos.verificationActions.listByTask(taskId),
          store.repos.patchCandidates.listByTask(taskId),
        ])
        return store.contextSlice(capability, { task, claims, evidence, failures, decisions, checks, actions, patches } as T, {
          taskId,
          sources: ['tasks', 'claims', 'evidence', 'failures', 'decisions', 'verification_checks', 'verification_actions', 'patch_candidates'],
        })
      }

      case 'trace.get_recent_events': {
        if (!taskId) return missingSlice<T>(store, capability, input, 'taskId')
        const trace = await store.repos.trace.listByTask(taskId, input.limit ?? 20)
        return store.contextSlice(capability, trace as T, { taskId, sources: ['trace_events'] })
      }
    }
  }

  async write<T = unknown>(capability: ContextWriteCapability, input: ContextWriteInput, options: ContextWriteOptions = {}): Promise<ContextWriteReceipt<T>> {
    const actor = options.actor ?? 'system'
    return this.options.store.tx(async (tx) => {
      const write = await performWrite<T>(tx.repos, capability, input)
      const trace = await tx.trace({
        type: `context.${capability}`,
        taskId: write.taskId,
        repoId: write.repoId,
        actor,
        summary: write.summary,
        payload: { capability, id: write.id },
      })
      return {
        capability,
        id: write.id,
        actor,
        traceEventId: trace.id,
        data: write.data,
      }
    })
  }
}

export function createContextServer(store: ForgeStateStore): ForgeContextServer {
  return new ForgeContextServer({ store })
}

interface WriteResult<T> {
  id: string
  taskId?: string | null
  repoId?: string | null
  summary: string
  data: T
}

async function performWrite<T>(repos: ForgeStateStore['repos'], capability: ContextWriteCapability, input: ContextWriteInput): Promise<WriteResult<T>> {
  switch (capability) {
    case 'task.record_snapshot': {
      const snapshot = requireKey(input, 'snapshot')
      const row = await repos.taskSnapshots.insert({
        id: snapshot.id ?? randomUUID(),
        taskId: snapshot.taskId,
        snapshotType: snapshot.snapshotType,
        summary: snapshot.summary,
        payload: snapshot.payload ?? {},
      })
      return result(row.id, row.taskId, null, 'Recorded task snapshot', row as T)
    }
    case 'task.record_session': {
      const row = await repos.sessions.insert(requireKey(input, 'session'))
      return result(row.id, row.taskId, row.repoId, 'Recorded session', row as T)
    }
    case 'task.record_prompt': {
      const row = await repos.prompts.insert(requireKey(input, 'prompt'))
      return result(row.id, row.taskId, null, 'Recorded prompt', row as T)
    }
    case 'belief.record_hypothesis': {
      const row = await repos.hypotheses.insert(requireKey(input, 'hypothesis'))
      return result(row.id, row.taskId, null, 'Recorded hypothesis', row as T)
    }
    case 'belief.update_hypothesis': {
      const row = await repos.hypotheses.update(requireKey(input, 'hypothesisId'), requireKey(input, 'patch'))
      return result(row.id, row.taskId, null, 'Updated hypothesis', row as T)
    }
    case 'claim.record': {
      const row = await repos.claims.insert(requireKey(input, 'claim'))
      return result(row.id, row.taskId, null, 'Recorded claim', row as T)
    }
    case 'claim.update': {
      const row = await repos.claims.update(requireKey(input, 'claimId'), requireKey(input, 'patch'))
      return result(row.id, row.taskId, null, 'Updated claim', row as T)
    }
    case 'evidence.record': {
      const row = await repos.evidence.insert(requireKey(input, 'evidence'))
      return result(row.id, row.taskId, null, 'Recorded evidence', row as T)
    }
    case 'evidence.link_claim': {
      const row = await repos.claimEvidenceLinks.insert({
        id: 'id' in input && typeof input.id === 'string' ? input.id : randomUUID(),
        claimId: requireKey(input, 'claimId'),
        evidenceId: requireKey(input, 'evidenceId'),
        linkType: requireKey(input, 'linkType'),
      })
      return result(row.id, null, null, 'Linked evidence to claim', row as T)
    }
    case 'failure.record': {
      const row = await repos.failures.insert(requireKey(input, 'failure'))
      return result(row.id, row.taskId, null, 'Recorded failure', row as T)
    }
    case 'decision.record': {
      const row = await repos.decisions.insert(requireKey(input, 'decision'))
      return result(row.id, row.taskId, null, 'Recorded decision', row as T)
    }
    case 'probe.record': {
      const row = await repos.probes.insert(requireKey(input, 'probe'))
      return result(row.id, row.taskId, null, 'Recorded probe', row as T)
    }
    case 'probe.record_result': {
      const row = await repos.probes.update(requireKey(input, 'probeId'), {
        status: requireKey(input, 'status'),
        result: 'result' in input ? input.result : undefined,
        completedAt: new Date().toISOString(),
      })
      return result(row.id, row.taskId, null, 'Recorded probe result', row as T)
    }
    case 'verification.record_check': {
      const row = await repos.verificationChecks.insert(requireKey(input, 'verificationCheck'))
      return result(row.id, row.taskId, null, 'Recorded verification check', row as T)
    }
    case 'verification.record_action': {
      const row = await repos.verificationActions.insert(requireKey(input, 'verificationAction'))
      return result(row.id, row.taskId, null, 'Recorded verification action', row as T)
    }
    case 'verification.record_action_score': {
      const row = await repos.verificationActionScores.insert(requireKey(input, 'verificationActionScore'))
      return result(row.id, null, null, 'Recorded verification action score', row as T)
    }
    case 'verification.link_action_claim': {
      const row = await repos.verificationActionClaimLinks.insert(requireKey(input, 'verificationActionClaimLink'))
      return result(row.id, null, null, 'Linked verification action to claim', row as T)
    }
    case 'verification.record_history': {
      const row = await repos.verificationHistory.upsert(requireKey(input, 'verificationHistory'))
      return result(row.id, null, row.repoId, 'Recorded verification history', row as T)
    }
    case 'patch.record_candidate': {
      const row = await repos.patchCandidates.insert(requireKey(input, 'patchCandidate'))
      return result(row.id, row.taskId, null, 'Recorded patch candidate', row as T)
    }
    case 'command.record': {
      const row = await repos.commands.insert(requireKey(input, 'command'))
      return result(row.id, row.taskId, null, 'Recorded command', row as T)
    }
    case 'artifact.record': {
      const row = await repos.artifacts.insert(requireKey(input, 'artifact'))
      return result(row.id, row.taskId, null, 'Recorded artifact', row as T)
    }
    case 'trace.record_event': {
      const traceInput = requireKey(input, 'trace')
      const row = await repos.trace.insert({
        id: randomUUID(),
        taskId: traceInput.taskId ?? null,
        repoId: traceInput.repoId ?? null,
        eventType: traceInput.type,
        actor: traceInput.actor ?? 'system',
        summary: traceInput.summary,
        payload: traceInput.payload ?? {},
      })
      return result(row.id, row.taskId, row.repoId, 'Recorded trace event', row as T)
    }
  }
}

function requireKey(obj: object, key: string): any {
  const value = (obj as Record<string, unknown>)[key]
  if (value === undefined || value === null) throw new Error(`Missing required context-server input key: ${String(key)}`)
  return value
}

function result<T>(id: string, taskId: string | null | undefined, repoId: string | null | undefined, summary: string, data: T): WriteResult<T> {
  return { id, taskId, repoId, summary, data }
}

function missingSlice<T>(store: ForgeStateStore, capability: ContextReadCapability, input: ContextReadInput, missing: string): Promise<ContextSlice<T>> {
  return store.contextSlice(capability, undefined as T, {
    taskId: input.taskId,
    sources: [],
    missing: [missing],
    warnings: [`Missing required input: ${missing}`],
    stale: false,
  })
}

function textPreview(metadata: ArtifactRow, bytes: Buffer): string | undefined {
  if (!metadata.mime?.startsWith('text/') && metadata.mime !== 'application/json') return undefined
  return bytes.toString('utf8', 0, Math.min(bytes.byteLength, 4000))
}
