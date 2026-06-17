import { randomUUID } from 'node:crypto'
import type {
  Claim,
  EvidenceRef,
  GraphEdge,
  GraphNode,
  RepoGraph,
  TaskBeliefState,
} from '@forge/types'
import type { TxContext } from '@forge/state-store'
import type { ActiveVerificationPlanner } from './planner.js'

/**
 * Stale-claim invalidation.
 *
 * When source files change, any claim whose supporting evidence was
 * generated from those files (or from symbols transitively reachable
 * through the repo graph) is no longer trustworthy — the underlying
 * code no longer matches the evidence. We mark those claims `stale`
 * and return them so the planner re-enters them into the queue.
 *
 * Pure helper (no DB) is exported as `findStaleClaimsForFiles` so
 * tests can exercise the logic without a Postgres connection.
 */

export interface StaleInvalidationOptions {
  /** Optional reason to record on the claim's `staleReason`. */
  reason?: string
  /** Repo graph for transitive file-to-file resolution. */
  repoGraph?: RepoGraph
}

/**
 * Find all claims whose evidence references any of the changed files
 * (directly OR through transitive graph reachability).
 */
export function findStaleClaimsForFiles(
  claims: Claim[],
  filesChanged: string[],
  opts: StaleInvalidationOptions = {},
): Claim[] {
  if (filesChanged.length === 0) return []
  const direct = new Set(filesChanged)
  const transitive = transitiveFiles(direct, opts.repoGraph)
  const all = new Set<string>([...direct, ...transitive])

  return claims
    .filter((claim) => {
      if (claim.status !== 'verified' && claim.status !== 'partially_verified') return false
      return claim.supportingEvidence.some((ref) => refMatchesFile(ref, all))
    })
    .map((claim) => markStale(claim, opts.reason))
}

/**
 * Persist the stale-invalidation result in one transaction.
 *
 * The transaction:
 *   1) updates each claim's `status` to `stale` and drops confidence
 *      to a cap of 0.49 (so a single pass can recover it),
 *   2) records a `claim_invalidated` trace event so the audit trail
 *      shows what changed and why.
 *
 * `invalidate(claims, files)` returns the in-memory list of claims
 * that were just invalidated (for the planner to re-enqueue).
 */
export function markStale(
  claim: Claim,
  reason: string = 'Source changed after verification',
): Claim {
  return {
    ...claim,
    status: 'stale',
    staleReason: reason,
    confidence: Math.min(claim.confidence, 0.49),
  }
}

export interface MarkStaleForChangedFilesInput {
  taskId: string
  filesChanged: string[]
  claims: Claim[]
  beliefState?: TaskBeliefState
  reason?: string
  repoGraph?: RepoGraph
  actor?: string
}

export interface MarkStaleForChangedFilesOutput {
  invalidated: Claim[]
  traceEventId?: string
}

export async function markStaleForChangedFiles(
  tx: TxContext,
  input: MarkStaleForChangedFilesInput,
): Promise<MarkStaleForChangedFilesOutput> {
  const invalidated = findStaleClaimsForFiles(input.claims, input.filesChanged, {
    reason: input.reason,
    repoGraph: input.repoGraph,
  })
  if (invalidated.length === 0) return { invalidated: [] }

  for (const claim of invalidated) {
    await tx.repos.claims.update(claim.id, {
      status: 'stale',
      confidence: claim.confidence,
    })
  }

  const trace = await tx.trace({
    type: 'claim_invalidated',
    taskId: input.taskId,
    actor: input.actor ?? 'system',
    summary: `Invalidated ${invalidated.length} claim(s) due to ${input.filesChanged.length} file change(s)`,
    payload: {
      filesChanged: input.filesChanged,
      invalidatedClaimIds: invalidated.map((c) => c.id),
      reason: input.reason ?? 'Source changed after verification',
    },
  })

  return { invalidated, traceEventId: trace.id }
}

/**
 * Compute the set of files transitively affected by a change to the
 * given files, via the repo graph. We use BFS through `imports`,
 * `references`, `depends_on`, `tests`, and `routes` edges — anything
 * that means "this file/symbol could be impacted by the change".
 *
 * Edges are followed in BOTH directions: if `a imports b` and we
 * change `b`, then `a` is reachable as a reverse-follower, because
 * `a` is a caller/dependent of the changed code.
 */
export function transitiveFiles(direct: Set<string>, graph?: RepoGraph): Set<string> {
  if (!graph) return new Set()
  const all = new Set<string>(direct)
  // Build a quick map from `path` → node id.
  const byPath = new Map<string, GraphNode>()
  for (const node of graph.nodes) {
    if (node.path) byPath.set(node.path, node)
  }
  // Bidirectional adjacency — for an edge a→b we also record b→a so
  // the BFS can reach callers when we start from a callee.
  const adjacency = new Map<string, Set<string>>()
  const addAdj = (from: string, to: string) => {
    if (!adjacency.has(from)) adjacency.set(from, new Set())
    adjacency.get(from)!.add(to)
  }
  for (const edge of graph.edges) {
    addAdj(edge.source, edge.target)
    addAdj(edge.target, edge.source)
  }
  const followTypes = new Set([
    'imports',
    'references',
    'depends_on',
    'tests',
    'routes',
    'calls',
    'exports',
    'defines',
    'connects_to',
  ])
  const queue: string[] = []
  for (const path of direct) {
    const node = byPath.get(path)
    if (node) queue.push(node.id)
  }
  const seen = new Set<string>(queue)
  while (queue.length > 0) {
    const id = queue.shift()!
    const neighbors = adjacency.get(id)
    if (!neighbors) continue
    for (const neighbor of neighbors) {
      if (seen.has(neighbor)) continue
      // Find the original directed edge to determine its type.
      const edge = graph.edges.find((e) => (e.source === id && e.target === neighbor) || (e.source === neighbor && e.target === id))
      if (!edge || !followTypes.has(edge.type)) continue
      seen.add(neighbor)
      const node = graph.nodes.find((n) => n.id === neighbor)
      if (node?.path) all.add(node.path)
      queue.push(neighbor)
    }
  }
  return all
}

function refMatchesFile(ref: EvidenceRef, fileSet: Set<string>): boolean {
  if (!ref.artifactRef) {
    // Heuristic: a bare id like `evidence:auth-tests:test_xyz` may
    // encode a path under it — try a substring match against the set.
    for (const file of fileSet) {
      if (ref.id.includes(file)) return true
    }
    return false
  }
  for (const file of fileSet) {
    if (ref.artifactRef === file) return true
    if (ref.artifactRef.endsWith(file)) return true
    if (ref.artifactRef.includes(file)) return true
  }
  return false
}

/**
 * Re-export of the planner's pure helper, kept here so callers
 * (TUI, TUI command) only need to import from `stale.ts`.
 */
export const staleHelpers = { refMatchesFile, transitiveFiles, markStale, findStaleClaimsForFiles }
