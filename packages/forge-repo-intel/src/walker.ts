import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'

/**
 * Directories ignored by every repo-intel walker. Mirrors the
 * harness's existing list so behavior is identical for callers
 * upgrading to the dedicated package.
 */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', '.next', '.forge', 'build',
  'out', 'coverage', '.turbo', '.cache', 'target', 'venv',
  '.venv', '__pycache__', '.gitlab', '.github',
])

const DEFAULT_MAX_DEPTH = 12

/**
 * Single file/directory entry yielded by `walkRepoIntel`. Mirrors
 * `FileEntry` from the harness so existing consumers continue to
 * work.
 */
export interface RepoIntelFileEntry {
  /** Absolute path. */
  path: string
  /** Path relative to the scan root. */
  relativePath: string
  /** True for directories. */
  isDirectory: boolean
  /** File size in bytes (0 for directories). */
  size: number
}

/** Options accepted by `walkRepoIntel`. */
export interface WalkOptions {
  /** Max directory depth to descend. Defaults to 12. */
  maxDepth?: number
  /** Additional ignore patterns beyond the built-in list. */
  extraIgnoreDirs?: string[]
}

/**
 * Walk the file tree under `root`, yielding one entry per file or
 * directory. Ignored directories short-circuit recursion. Errors
 * on individual entries (permission denied, ENOENT) are swallowed
 * so a single bad subtree does not abort the whole scan.
 */
export async function* walkRepoIntel(
  root: string,
  options?: WalkOptions,
): AsyncGenerator<RepoIntelFileEntry> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
  const ignored = new Set(DEFAULT_IGNORED_DIRS)
  if (options?.extraIgnoreDirs) {
    for (const dir of options.extraIgnoreDirs) ignored.add(dir)
  }

  async function* walk(currentPath: string, depth: number): AsyncGenerator<RepoIntelFileEntry> {
    if (depth > maxDepth) return

    let entries: { name: string; isDirectory: boolean; isFile: boolean }[]
    try {
      const dirEntries = await readdir(currentPath, { withFileTypes: true })
      entries = dirEntries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      }))
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory && ignored.has(entry.name)) continue

      const fullPath = join(currentPath, entry.name)
      const relPath = relative(root, fullPath)

      if (entry.isDirectory) {
        yield { path: fullPath, relativePath: relPath, isDirectory: true, size: 0 }
        yield* walk(fullPath, depth + 1)
      } else if (entry.isFile) {
        let fileStat: { size: number }
        try {
          fileStat = await stat(fullPath)
        } catch {
          continue
        }
        yield { path: fullPath, relativePath: relPath, isDirectory: false, size: fileStat.size }
      }
    }
  }

  yield* walk(root, 0)
}

/** Lowercase extension of a file path (`.ts`, `.tsx`, `.json`, …). */
export function extname(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

/** True when the path ends in a TS/JS-family extension. */
export function isSourceFile(path: string): boolean {
  const ext = extname(path)
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)
}

/** True when the file looks like a test (heuristic). */
export function isTestFile(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return (
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.includes('.e2e.') ||
    path.includes('/__tests__/') ||
    path.includes('/test/') ||
    path.includes('/tests/') ||
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx') ||
    name.endsWith('.spec.ts') ||
    name.endsWith('.spec.tsx')
  )
}

/**
 * Collect every entry under `root` matching `predicate` into a flat
 * array. Used by `discoverDatabase` and friends when they need the
 * full list rather than the streaming generator.
 */
export async function findEntries(
  root: string,
  predicate: (entry: RepoIntelFileEntry) => boolean,
  options?: WalkOptions,
): Promise<RepoIntelFileEntry[]> {
  const out: RepoIntelFileEntry[] = []
  for await (const entry of walkRepoIntel(root, options)) {
    if (predicate(entry)) out.push(entry)
  }
  return out
}

/** Re-export for code that imports `dirname` from this package. */
export { dirname }