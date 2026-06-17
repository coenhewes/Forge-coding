/**
 * Backward-compatible re-exports for the repo-graph layer.
 *
 * The implementation now lives in `@forge/repo-graph`. This module
 * keeps the legacy entry points alive so callers that imported
 * from `@forge/harness` continue to compile.
 */

export {
  buildGraph,
  parseImports,
  parseExports,
  parseReferences,
  parseCallSites,
  walkRepo,
  extname,
  isSourceFile,
  isTestFile,
  inferSourceFile,
  GraphQuery,
  GraphStore,
} from '@forge/repo-graph'

export type { BuildGraphOptions, ImportInfo } from '@forge/repo-graph'

// Re-export the scanner's walker naming so legacy imports
// (`walkDir`, `findFiles`) keep working. The graph package exposes
// `walkRepo` as the streaming walker; there is no array helper —
// callers expecting `findFiles` use the repo-intel package instead.
export {
  walkRepo as walkDir,
} from '@forge/repo-graph'