/**
 * Backward-compatible re-exports for the repo-map / repo-intel
 * layer.
 *
 * The implementation now lives in `@forge/repo-intel`. This module
 * keeps the legacy entry points alive so callers that imported
 * from `@forge/harness` continue to compile.
 */

export {
  scanRepository,
  RepoIntel,
  walkRepoIntel as walkDir,
  findEntries as findFiles,
  isSourceFile,
  isTestFile,
  extname,
} from '@forge/repo-intel'

export type { RepoIntelScanOptions as ScanOptions } from '@forge/repo-intel'

// Some legacy callers still expect a `FileEntry` shape that lives
// in the harness; alias it to the repo-intel equivalent.
export type { RepoIntelFileEntry as FileEntry } from '@forge/repo-intel'