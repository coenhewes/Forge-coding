/**
 * @forge/repo-graph — structural software-graph layer for Forge.
 *
 * The package exposes three layers:
 *
 *   - `scanner.ts` walks the filesystem, parses every source file,
 *     and produces a `RepoGraph` (nodes, edges, regions, symbols,
 *     references, call sites).
 *   - `query.ts` provides read-only `GraphQuery` / `GraphStore`
 *     helpers the agent loop uses to answer the recurring
 *     localization questions ("who calls X?", "what tests touch
 *     this file?", "what's the shortest path from A to B?").
 *   - `schema.ts` declares the public types the rest of Forge
 *     consumes (caller hits, dependency paths, cross-domain hits,
 *     pattern matching helpers).
 *
 * The scanner is two-pass by design so cross-file callers and
 * references resolve correctly — the first pass builds the complete
 * symbol table, the second emits `calls` and `references` edges.
 */

export {
  // Scanner — filesystem + parsers
  walkRepo,
  extname,
  isSourceFile,
  isTestFile,
  inferSourceFile,
  parseImports,
  parseExports,
  parseReferences,
  parseCallSites,
  buildGraph,
} from './scanner.js'

export {
  // Query API
  GraphQuery,
  GraphStore,
} from './query.js'

export type {
  // Schema — public types
  RepoGraphNodeKind,
  RepoGraphEdgeKind,
  RepoGraphSymbolKind,
  ImportInfo,
  BuildGraphOptions,
  ScanOptions,
  RepoFileEntry,
  QueryOptions,
  DependencyHop,
  DependencyPath,
  CallerHit,
  DefinitionHit,
  AffectedTestHit,
  CrossDomainEdgeHit,
  StoredGraph,
} from './schema.js'

// Re-export RepoGraph + graph types from @forge/types for callers
// that prefer to import everything from the graph package.
export type {
  RepoGraph,
  GraphNode,
  GraphEdge,
  GraphRegion,
  SymbolDefinition,
  SymbolReference,
  CallSite,
} from '@forge/types'