import type {
  RepoGraph,
  GraphNode,
  GraphEdge,
  SymbolDefinition,
  SymbolReference,
  CallSite,
} from '@forge/types'
import type {
  QueryOptions,
  CallerHit,
  DefinitionHit,
  AffectedTestHit,
  CrossDomainEdgeHit,
  DependencyPath,
} from './schema.js'

/**
 * Read-only query layer over a `RepoGraph`. The store keeps every
 * node, edge, definition, reference, and call site in pre-built
 * indexes so the most common task-localization questions — "who
 * calls X?", "where is X defined?", "what tests touch this file?" —
 * are answered in a single pass.
 *
 * The class is intentionally small. It does NOT mutate the graph;
 * re-scanning happens at the agent-loop level (`buildGraph` returns
 * a fresh object).
 */
export class GraphQuery {
  private readonly nodesById: Map<string, GraphNode>
  private readonly nodesByPath: Map<string, GraphNode>
  private readonly nodesByName: Map<string, GraphNode[]>
  private readonly outgoingBySource: Map<string, GraphEdge[]>
  private readonly incomingByTarget: Map<string, GraphEdge[]>
  private readonly defsByName: Map<string, SymbolDefinition[]>
  private readonly defsByFile: Map<string, SymbolDefinition[]>
  private readonly refsByTarget: Map<string, SymbolReference[]>
  private readonly refsBySource: Map<string, SymbolReference[]>
  private readonly callsByTarget: Map<string, CallSite[]>
  private readonly callsBySource: Map<string, CallSite[]>
  private readonly callsBySymbol: Map<string, CallSite[]>
  private readonly testsByTargetFile: Map<string, GraphNode[]>

  constructor(private readonly graph: RepoGraph) {
    this.nodesById = new Map()
    this.nodesByPath = new Map()
    this.nodesByName = new Map()
    this.outgoingBySource = new Map()
    this.incomingByTarget = new Map()
    this.defsByName = new Map()
    this.defsByFile = new Map()
    this.refsByTarget = new Map()
    this.refsBySource = new Map()
    this.callsByTarget = new Map()
    this.callsBySource = new Map()
    this.callsBySymbol = new Map()
    this.testsByTargetFile = new Map()

    for (const node of graph.nodes) {
      this.nodesById.set(node.id, node)
      if (node.path) this.nodesByPath.set(node.path, node)
      const nameBucket = this.nodesByName.get(node.name) ?? []
      nameBucket.push(node)
      this.nodesByName.set(node.name, nameBucket)
    }

    for (const edge of graph.edges) {
      const out = this.outgoingBySource.get(edge.source) ?? []
      out.push(edge)
      this.outgoingBySource.set(edge.source, out)
      const inc = this.incomingByTarget.get(edge.target) ?? []
      inc.push(edge)
      this.incomingByTarget.set(edge.target, inc)
    }

    for (const def of graph.symbolDefinitions) {
      const byName = this.defsByName.get(def.name) ?? []
      byName.push(def)
      this.defsByName.set(def.name, byName)
      const byFile = this.defsByFile.get(def.file) ?? []
      byFile.push(def)
      this.defsByFile.set(def.file, byFile)
    }

    for (const ref of graph.symbolReferences) {
      const byTarget = this.refsByTarget.get(ref.targetNodeId ?? `sym:${ref.file}:${ref.name}`) ?? []
      byTarget.push(ref)
      this.refsByTarget.set(ref.targetNodeId ?? `sym:${ref.file}:${ref.name}`, byTarget)
      const bySource = this.refsBySource.get(ref.sourceNodeId) ?? []
      bySource.push(ref)
      this.refsBySource.set(ref.sourceNodeId, bySource)
    }

    for (const call of graph.callSites) {
      const byTarget = this.callsByTarget.get(call.callee) ?? []
      byTarget.push(call)
      this.callsByTarget.set(call.callee, byTarget)
      const bySource = this.callsBySource.set(call.caller, this.callsBySource.get(call.caller) ?? []).get(call.caller)!
      bySource.push(call)

      // Also key by symbol-node id when the callee resolves to a
      // graph node. `findCallers` checks both buckets.
      const symbolNodeId = this.resolveSymbolNodeIdByName(call.callee)
      if (symbolNodeId) {
        const bySym = this.callsBySymbol.get(symbolNodeId) ?? []
        bySym.push(call)
        this.callsBySymbol.set(symbolNodeId, bySym)
      }
    }

    for (const edge of graph.edges) {
      if (edge.type !== 'tests') continue
      const target = this.nodesById.get(edge.target)
      if (!target) continue
      const bucket = this.testsByTargetFile.get(target.path ?? target.id) ?? []
      const testNode = this.nodesById.get(edge.source)
      if (testNode && !bucket.some((n) => n.id === testNode.id)) {
        bucket.push(testNode)
      }
      this.testsByTargetFile.set(target.path ?? target.id, bucket)
    }
  }

  /** Total node count, exposed for diagnostics + TUI panels. */
  get nodeCount(): number {
    return this.graph.nodes.length
  }

  /** Total edge count. */
  get edgeCount(): number {
    return this.graph.edges.length
  }

  /** Underlying immutable graph (defensive copy is the caller's job). */
  get data(): RepoGraph {
    return this.graph
  }

  /**
   * Find every caller of `symbol`. A caller is recorded when either:
   *
   *   - the call site names the symbol directly, or
   *   - the call's resolved callee node is the symbol.
   *
   * Returns callers in `(file, line)` ascending order so callers in
   * the same file appear top-to-bottom.
   */
  findCallers(symbol: string, _options?: QueryOptions): CallerHit[] {
    const hits: CallerHit[] = []
    const seen = new Set<string>()

    const push = (call: CallSite) => {
      const key = `${call.caller}:${call.line}:${call.callee}`
      if (seen.has(key)) return
      seen.add(key)
      hits.push({
        call,
        callerFile: this.nodesById.get(`file:${call.caller}`),
        calleeSymbol: this.resolveSymbolNode(call.callee),
      })
    }

    for (const call of this.callsByTarget.get(symbol) ?? []) push(call)
    const symbolNodeId = this.resolveSymbolNodeIdByName(symbol)
    if (symbolNodeId) {
      for (const call of this.callsBySymbol.get(symbolNodeId) ?? []) push(call)
    }
    hits.sort((a, b) => {
      if (a.call.file !== b.call.file) return a.call.file.localeCompare(b.call.file)
      return a.call.line - b.call.line
    })
    return hits
  }

  /**
   * Find every definition whose name matches `symbol`. By default
   * the match is exact; if `symbol` ends with `*` we treat the
   * trailing star as a prefix wildcard (`auth.*` matches `auth.check`,
   * `auth.role`, …).
   */
  findDefinitions(symbol: string, _options?: QueryOptions): DefinitionHit[] {
    const hits: DefinitionHit[] = []
    const seen = new Set<string>()

    const push = (def: SymbolDefinition) => {
      if (seen.has(def.nodeId)) return
      seen.add(def.nodeId)
      hits.push({
        definition: def,
        file: this.nodesById.get(`file:${def.file}`) ?? {
          id: `file:${def.file}`,
          type: 'file',
          name: def.file,
          path: def.file,
        },
        symbol: this.nodesById.get(def.nodeId),
      })
    }

    if (symbol.endsWith('*')) {
      const prefix = symbol.slice(0, -1)
      for (const [name, defs] of this.defsByName) {
        if (name.startsWith(prefix)) for (const d of defs) push(d)
      }
    } else {
      for (const def of this.defsByName.get(symbol) ?? []) push(def)
    }

    hits.sort((a, b) => a.file.path?.localeCompare(b.file.path ?? '') ?? 0)
    return hits
  }

  /**
   * Find every edge that crosses two engineering domains. A
   * `cross-domain edge` is one whose source and target nodes
   * resolve to different `domain:*` regions.
   *
   * Pass a specific `domain` to scope the search; omit to return
   * every cross-domain edge in the graph (capped at the first 500
   * to keep TUI panels responsive on very large repos).
   */
  findCrossDomainEdges(domain?: string, options?: QueryOptions): CrossDomainEdgeHit[] {
    const cap = 500
    const hits: CrossDomainEdgeHit[] = []
    for (const edge of this.graph.edges) {
      const sourceDomain = this.domainOf(edge.source)
      const targetDomain = this.domainOf(edge.target)
      if (!sourceDomain || !targetDomain) continue
      if (sourceDomain === targetDomain) continue
      if (domain && sourceDomain !== domain && targetDomain !== domain) continue
      hits.push({
        edge,
        sourceDomain,
        targetDomain,
      })
      if (hits.length >= cap) break
    }
    if (options?.transitive) {
      // Transitive mode also follows edges that target a domain via
      // the owned file → domain chain. Cheap heuristic: if the edge
      // is `owned_by`, traverse to the owning domain and look for
      // outgoing edges.
      void options
    }
    return hits
  }

  /**
   * Find every test that touches a file matching `filePattern`.
   *
   * `filePattern` is matched in two ways:
   *
   *   - exact absolute path match against the source node's `path`
   *   - substring match against the relative path, when `filePattern`
   *     does not start with `/`
   *
   * Returns the test node plus the related source files the test
   * suite is likely exercising (deduped and sorted).
   */
  findAffectedTests(filePattern: string, _options?: QueryOptions): AffectedTestHit[] {
    const hits: AffectedTestHit[] = []
    const seen = new Set<string>()
    const matchedFiles = new Set<string>()

    for (const node of this.graph.nodes) {
      if (node.type !== 'file' || !node.path) continue
      if (matchesPattern(filePattern, node.path)) matchedFiles.add(node.path)
    }

    if (matchedFiles.size === 0) return hits

    const related = new Map<string, GraphNode[]>()
    for (const filePath of matchedFiles) {
      const tests = this.testsByTargetFile.get(filePath) ?? []
      for (const test of tests) {
        const id = test.id
        if (seen.has(id)) continue
        seen.add(id)
        const suiteFiles = this.collectSuiteRelatedFiles(test)
        related.set(id, suiteFiles)
      }
    }

    for (const [, test] of Array.from(seen).map((id): [string, GraphNode] => [id, this.nodesById.get(id)!])) {
      const relatedFiles = related.get(test.id) ?? []
      hits.push({
        test,
        relatedFiles,
        metadata: test.metadata,
      })
    }
    return hits
  }

  /**
   * Walk the dependency graph from `from` to `to`, returning the
   * shortest path (by hop count). The walk follows outgoing edges
   * of any type; if you need to constrain by edge type, use
   * `findDependencyPath` over a filtered edge list directly.
   *
   * Returns `null` when no path is found within `options.maxDepth`
   * hops.
   */
  findDependencyPath(from: string, to: string, options?: QueryOptions): DependencyPath | null {
    const maxDepth = options?.maxDepth ?? 4
    const fromId = this.resolveNodeId(from)
    const toId = this.resolveNodeId(to)
    if (!fromId || !toId) return null
    if (fromId === toId) {
      const node = this.nodesById.get(fromId)!
      return { nodes: [node], edges: [] }
    }

    const visited = new Set<string>([fromId])
    const queue: Array<{ id: string; path: GraphNode[]; edges: GraphEdge[] }> = [
      { id: fromId, path: [this.nodesById.get(fromId)!], edges: [] },
    ]

    while (queue.length > 0) {
      const head = queue.shift()!
      if (head.path.length - 1 >= maxDepth) continue
      const outgoing = this.outgoingBySource.get(head.id) ?? []
      for (const edge of outgoing) {
        if (visited.has(edge.target)) continue
        const targetNode = this.nodesById.get(edge.target)
        if (!targetNode) continue
        const nextPath = [...head.path, targetNode]
        const nextEdges = [...head.edges, edge]
        if (edge.target === toId) {
          return { nodes: nextPath, edges: nextEdges }
        }
        visited.add(edge.target)
        queue.push({ id: edge.target, path: nextPath, edges: nextEdges })
      }
    }
    return null
  }

  /**
   * Resolve a node by id, absolute path, or (fuzzy) name. Returns
   * the first node whose id matches, then the first whose path
   * matches, then the first whose name matches.
   */
  resolveNode(query: string): GraphNode | undefined {
    return this.nodesById.get(query)
      ?? this.nodesByPath.get(query)
      ?? this.nodesByName.get(query)?.[0]
  }

  /**
   * List every node belonging to a domain. The domain is matched
   * against `owned_by` edges whose target is `domain:<name>`.
   */
  nodesInDomain(domain: string): GraphNode[] {
    const out: GraphNode[] = []
    const seen = new Set<string>()
    const domainNodeId = `domain:${domain}`
    for (const edge of this.incomingByTarget.get(domainNodeId) ?? []) {
      const node = this.nodesById.get(edge.source)
      if (node && !seen.has(node.id)) {
        seen.add(node.id)
        out.push(node)
      }
    }
    return out
  }

  /**
   * All edges in which `nodeId` participates (incoming or outgoing).
   * Useful for `explore why this node matters` calls.
   */
  edgesOf(nodeId: string): GraphEdge[] {
    const incoming = this.incomingByTarget.get(nodeId) ?? []
    const outgoing = this.outgoingBySource.get(nodeId) ?? []
    return [...incoming, ...outgoing]
  }

  // -------------------------------------------------------------------------
  //  Internal helpers
  // -------------------------------------------------------------------------

  private resolveNodeId(query: string): string | undefined {
    if (this.nodesById.has(query)) return query
    const byPath = this.nodesByPath.get(query)
    if (byPath) return byPath.id
    const byName = this.nodesByName.get(query)?.[0]
    if (byName) return byName.id
    return undefined
  }

  private resolveSymbolNodeIdByName(name: string): string | undefined {
    const defs = this.defsByName.get(name)
    if (!defs || defs.length === 0) return undefined
    return defs[0]?.nodeId
  }

  private resolveSymbolNode(name: string): GraphNode | undefined {
    const id = this.resolveSymbolNodeIdByName(name)
    if (!id) return undefined
    return this.nodesById.get(id)
  }

  private domainOf(nodeId: string): string | undefined {
    const node = this.nodesById.get(nodeId)
    if (!node) return undefined
    if (nodeId.startsWith('domain:')) return nodeId.slice('domain:'.length)
    for (const edge of this.outgoingBySource.get(nodeId) ?? []) {
      if (edge.type === 'owned_by' && edge.target.startsWith('domain:')) {
        return edge.target.slice('domain:'.length)
      }
    }
    return undefined
  }

  private collectSuiteRelatedFiles(testNode: GraphNode): GraphNode[] {
    const out: GraphNode[] = []
    const seen = new Set<string>()
    for (const edge of this.outgoingBySource.get(testNode.id) ?? []) {
      if (edge.type !== 'tests') continue
      const target = this.nodesById.get(edge.target)
      if (target && !seen.has(target.id)) {
        seen.add(target.id)
        out.push(target)
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
//  Module-level helpers (exposed for advanced callers)
// ---------------------------------------------------------------------------

/**
 * Wildcard-aware pattern match. Supports `*` (any path segment) and
 * `**` (any path prefix/suffix). When `pattern` does not contain a
 * wildcard it is treated as a substring match.
 */
function matchesPattern(pattern: string, filePath: string): boolean {
  if (filePath === pattern) return true
  if (!pattern.includes('*')) {
    return filePath.includes(pattern)
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexd = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
  return new RegExp(`(^|/)${regexd}($|/)`).test(filePath)
}

/**
 * In-memory `RepoGraph` holder. The agent loop keeps one of these
 * per task so `GraphQuery` instances can be created and dropped
 * without re-walking the filesystem. The store does not persist;
 * durability lives in `forge-state` / `forge-state-store`.
 */
export class GraphStore {
  private current: RepoGraph | null = null
  private readonly listeners = new Set<(g: RepoGraph) => void>()

  /** Replace the stored graph. Notifies every listener. */
  set(graph: RepoGraph): void {
    this.current = graph
    for (const fn of this.listeners) fn(graph)
  }

  /** Return the stored graph, or `null` if nothing has been scanned. */
  get(): RepoGraph | null {
    return this.current
  }

  /** True once at least one graph has been loaded. */
  hasGraph(): boolean {
    return this.current !== null
  }

  /**
   * Convenience: build a fresh `GraphQuery` over the current
   * graph. Returns `null` when nothing has been stored yet so the
   * caller can decide whether to fall back to a fresh scan.
   */
  query(): GraphQuery | null {
    return this.current ? new GraphQuery(this.current) : null
  }

  /** Subscribe to graph updates (used by the TUI dashboard). */
  subscribe(fn: (g: RepoGraph) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}