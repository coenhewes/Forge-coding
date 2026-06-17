import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.forge', 'build',
  'out', 'coverage', '.turbo', '.cache', 'target', 'venv',
  '.venv', '__pycache__', '.gitlab', '.github',
])

const MAX_DEPTH = 12

export interface FileEntry {
  path: string
  relativePath: string
  isDirectory: boolean
  size: number
}

export async function* walkDir(
  root: string,
  options?: { depth?: number; includePatterns?: string[] },
): AsyncGenerator<FileEntry> {
  const maxDepth = options?.depth ?? MAX_DEPTH

  async function* walk(currentPath: string, depth: number): AsyncGenerator<FileEntry> {
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
      if (entry.isDirectory && IGNORED_DIRS.has(entry.name)) continue

      const fullPath = join(currentPath, entry.name)
      const relPath = relative(root, fullPath)

      if (entry.isDirectory) {
        yield {
          path: fullPath,
          relativePath: relPath,
          isDirectory: true,
          size: 0,
        }
        yield* walk(fullPath, depth + 1)
      } else if (entry.isFile) {
        let fileStat: { size: number }
        try {
          fileStat = await stat(fullPath)
        } catch {
          continue
        }
        yield {
          path: fullPath,
          relativePath: relPath,
          isDirectory: false,
          size: fileStat.size,
        }
      }
    }
  }

  yield* walk(root, 0)
}

export async function findFiles(
  root: string,
  pattern: (entry: FileEntry) => boolean,
): Promise<FileEntry[]> {
  const results: FileEntry[] = []
  for await (const entry of walkDir(root)) {
    if (pattern(entry)) results.push(entry)
  }
  return results
}

export function extname(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

export function isSourceFile(path: string): boolean {
  const ext = extname(path)
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)
}

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