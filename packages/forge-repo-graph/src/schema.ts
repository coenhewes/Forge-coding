import type {
  RepoGraph,
  GraphNode,
  GraphEdge,
  GraphRegion,
  SymbolDefinition,
  SymbolReference,
  CallSite,
} from '@forge/types'

/**
 * Canonical node kinds produced by the scanner. Mirrors `GraphNode['type']`
 * but is exposed here so downstream tooling (the capability fabric, the
 * TUI dashboard, MCP servers) can pattern-match without importing
 * internal type files.
 */
export type RepoGraphNodeKind =
  | 'file'
  | 'package'
  | 'app'
  | 'symbol'
  | 'route'
  | 'test'
  | 'migration'
  | 'table'

/**
 * Canonical edge kinds produced by the scanner.
 */
export type RepoGraphEdgeKind =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'defines'
  | 'references'
  | 'routes'
  | 'tests'
  | 'depends_on'
  | 'owned_by'
  | 'connects_to'

/**
 * Symbol kinds extracted by the parsers. Mirrors
 * `SymbolDefinition['kind']` for the same pattern-matching reason as
 * `RepoGraphNodeKind`.
 */
export type RepoGraphSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'component'

/**
 * Shape returned by `parseImports`. The scanner adds `line` and
 * `type` to each entry and persists it as an `imports` edge.
 */
export interface ImportInfo {
  source: string
  line: number
  type: 'static' | 'dynamic' | 'cjs'
}

/**
 * Options accepted by `buildGraph`.
 */
export interface BuildGraphOptions {
  includeCallSites?: boolean
  includeReferences?: boolean
}

/**
 * Options accepted by `scanRepository` (the scanner).
 */
export interface ScanOptions {
  /** File extensions to include. Defaults to TS/JS-family extensions. */
  extensions?: string[]
  /** Maximum directory depth to walk. Defaults to 12. */
  maxDepth?: number
  /** Directories to ignore beyond the built-in list. */
  extraIgnoreDirs?: string[]
}

/**
 * A single raw entry yielded by `walkRepo`. The scanner reduces
 * this to graph nodes/edges.
 */
export interface RepoFileEntry {
  /** Absolute path. */
  path: string
  /** Path relative to the scan root. */
  relativePath: string
  /** True for directories. */
  isDirectory: boolean
  /** File size in bytes (0 for directories). */
  size: number
}

/**
 * Options accepted by `GraphQuery`. Defaults are tuned for the
 * Forge agent's typical task-localization queries.
 */
export interface QueryOptions {
  /** Maximum depth for transitive traversals. Defaults to 4. */
  maxDepth?: number
  /** When true, include indirect (multi-hop) callers/callees. */
  transitive?: boolean
}

/**
 * One hop in a dependency path returned by `findDependencyPath`.
 */
export interface DependencyHop {
  node: GraphNode
  edge?: GraphEdge
}

/**
 * Result of `findDependencyPath`. `nodes` is the ordered list of
 * nodes from `from` to `to`; `edges` is the parallel ordered list of
 * edges traversed.
 */
export interface DependencyPath {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * A caller reference returned by `findCallers`. Combines the call
 * site (where the call was made) with the resolved symbol node (the
 * callee). Either side may be missing when the reference cannot be
 * resolved.
 */
export interface CallerHit {
  call: CallSite
  callerFile?: GraphNode
  calleeSymbol?: GraphNode
}

/**
 * A definition returned by `findDefinitions`.
 */
export interface DefinitionHit {
  definition: SymbolDefinition
  file: GraphNode
  symbol?: GraphNode
}

/**
 * A test that touches a file pattern. Returned by
 * `findAffectedTests`.
 */
export interface AffectedTestHit {
  test: GraphNode
  /** Source files that this test covers (after `.test.ts` → `.ts`). */
  relatedFiles: GraphNode[]
  /** Test-suite metadata (framework, type) when available. */
  metadata?: Record<string, unknown>
}

/**
 * A cross-domain edge — a relationship between two distinct
 * engineering domains — returned by `findCrossDomainEdges`.
 */
export interface CrossDomainEdgeHit {
  edge: GraphEdge
  sourceDomain: string
  targetDomain: string
}

/**
 * The durable in-memory representation of a scanned repository.
 * Mirrors `RepoGraph` from `@forge/types` but adds a `root` field so
 * the store can recover absolute paths on demand.
 */
export interface StoredGraph extends RepoGraph {
  root: string
  /** ISO timestamp the graph was built. */
  builtAt: string
}

/**
 * Convenience re-exports for code that imports from this module.
 */
export type {
  RepoGraph,
  GraphNode,
  GraphEdge,
  GraphRegion,
  SymbolDefinition,
  SymbolReference,
  CallSite,
}