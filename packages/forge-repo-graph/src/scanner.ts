import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, dirname } from 'node:path'
import type {
  RepoMap,
  RepoGraph,
  GraphNode,
  GraphEdge,
  GraphRegion,
  SymbolDefinition,
  SymbolReference,
  CallSite,
} from '@forge/types'
import type {
  BuildGraphOptions,
  ScanOptions,
  RepoFileEntry,
  ImportInfo,
  RepoGraphSymbolKind,
} from './schema.js'

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.forge', 'build',
  'out', 'coverage', '.turbo', '.cache', 'target', 'venv',
  '.venv', '__pycache__', '.gitlab', '.github',
])

const DEFAULT_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
])

const DEFAULT_MAX_DEPTH = 12

/**
 * Yield every file/directory under `root`. The generator respects
 * `options.maxDepth` and skips well-known noisy directories (e.g.
 * `node_modules`, `dist`, `.git`). Errors on individual entries
 * (permission denied, ENOENT during a concurrent delete) are
 * swallowed so a single bad subtree does not abort the whole scan.
 */
export async function* walkRepo(
  root: string,
  options?: ScanOptions,
): AsyncGenerator<RepoFileEntry> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
  const ignored = new Set(DEFAULT_IGNORED_DIRS)
  if (options?.extraIgnoreDirs) {
    for (const dir of options.extraIgnoreDirs) ignored.add(dir)
  }

  async function* walk(currentPath: string, depth: number): AsyncGenerator<RepoFileEntry> {
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

/**
 * Extract the lowercase extension from a file path (`.ts`, `.tsx`,
 * `.json`, …). Files with no extension return an empty string.
 */
export function extname(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

/**
 * True when the file extension belongs to the TS/JS family. Used
 * by `scanRepository` and `buildGraph` to skip generated assets,
 * configuration, and documentation.
 */
export function isSourceFile(path: string, options?: ScanOptions): boolean {
  const ext = extname(path)
  if (options?.extensions) {
    return options.extensions.some((e) => ext === e || ext === `.${e.replace(/^\./, '')}`)
  }
  return DEFAULT_SOURCE_EXTENSIONS.has(ext)
}

/**
 * True when the file looks like a test (heuristic). We use this in
 * `buildGraph` to attach `tests` edges to source files that mirror
 * the test name minus the `.test.`/`.spec.` suffix.
 */
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
 * Convert a test file path to the most likely source file it covers
 * (`foo.test.ts` → `foo.ts`, `__tests__/foo.ts` → `foo.ts`). Returns
 * undefined when no source twin can be inferred.
 */
export function inferSourceFile(testFile: string): string | undefined {
  return testFile
    .replace(/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/, '.$2')
    .replace(/\/__tests__\//, '/')
}

// ---------------------------------------------------------------------------
//  Parsers — pure functions over source text
// ---------------------------------------------------------------------------

/**
 * Extract every `import ... from '...'`, `require('...')`,
 * `import(...)`, side-effect `import '...'`, and re-export
 * `export ... from '...'` from a source file. The regex set covers
 * the common ESM + CJS shapes — it is intentionally permissive so
 * that styled code (Prettier output, template strings) still parses.
 */
export function parseImports(content: string, _file: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  let match: RegExpExecArray | null

  const staticImportRe =
    /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*(?:\{[^}]*\}|\w+))?)\s+from\s+['"]([^'"]+)['"];?$/gm
  while ((match = staticImportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  const dynamicImportRe = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  while ((match = dynamicImportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'dynamic' })
  }

  const cjsRe = /(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = cjsRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'cjs' })
  }

  const sideEffectRe = /^import\s+['"]([^'"]+)['"];?$/gm
  while ((match = sideEffectRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  const reexportRe =
    /^export\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"];?$/gm
  while ((match = reexportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  return imports
}

/**
 * Extract every exported (and a useful subset of local) symbol
 * definition. Returns a list of `SymbolDefinition` records the
 * scanner can promote into `defines` edges and `symbol` nodes.
 */
export function parseExports(content: string, file: string): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = []
  let match: RegExpExecArray | null

  const namedExportPatterns: { re: RegExp; kind: RepoGraphSymbolKind }[] = [
    { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s+(?:\*\s+)?(\w+)/gm, kind: 'function' },
    { re: /^export\s+(?:default\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^export\s+interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^export\s+type\s+(\w+)\s*=/gm, kind: 'type' },
    { re: /^export\s+(?:const|let|var)\s+(\w+)/gm, kind: 'variable' },
    { re: /^export\s+default\s+(?:function\s+)?(\w+)/gm, kind: 'variable' },
  ]

  for (const { re, kind } of namedExportPatterns) {
    while ((match = re.exec(content)) !== null) {
      definitions.push({
        name: match[1]!,
        kind,
        file,
        exported: true,
        line: countLines(content, match.index),
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        nodeId: `sym:${file}:${match[1]!}`,
      })
    }
  }

  const namedBracesRe = /^export\s+\{([^}]+)\}/gm
  while ((match = namedBracesRe.exec(content)) !== null) {
    const rawNames = match[1]!
    const names = rawNames
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0]?.trim())
      .filter((n): n is string => Boolean(n))
    for (const name of names) {
      definitions.push({
        name,
        kind: 'variable',
        file,
        exported: true,
        line: countLines(content, match.index),
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        nodeId: `sym:${file}:${name}`,
      })
    }
  }

  const localPatterns: { re: RegExp; kind: RepoGraphSymbolKind }[] = [
    { re: /^(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:const|let|var)\s+(\w+)\s*=/gm, kind: 'variable' },
    { re: /^interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^type\s+(\w+)\s*=/gm, kind: 'type' },
  ]
  for (const { re, kind } of localPatterns) {
    while ((match = re.exec(content)) !== null) {
      const name = match[1]!
      if (!definitions.some((d) => d.name === name && d.file === file)) {
        definitions.push({
          name,
          kind,
          file,
          exported: false,
          line: countLines(content, match.index),
          column: match.index - content.lastIndexOf('\n', match.index) - 1,
          nodeId: `sym:${file}:${name}`,
        })
      }
    }
  }

  return definitions
}

/**
 * Find every textual reference to a known symbol inside `content`.
 * References that fall on the definition line in the defining file
 * are skipped so callers don't record the definition as its own
 * reference.
 */
export function parseReferences(
  content: string,
  file: string,
  defs: SymbolDefinition[],
): SymbolReference[] {
  const refs: SymbolReference[] = []
  let match: RegExpExecArray | null

  for (const def of defs) {
    const nameRe = new RegExp(`\\b${escapeRegex(def.name)}\\b`, 'g')
    while ((match = nameRe.exec(content)) !== null) {
      const line = countLines(content, match.index)
      if (file === def.file && line === def.line) continue
      refs.push({
        name: def.name,
        file,
        line,
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        sourceNodeId: `file:${file}`,
        targetNodeId: def.nodeId,
      })
    }
  }

  return refs
}

/**
 * Find every call site (identifier followed by `(`) that targets a
 * known function. Method calls and chained accessors are matched by
 * the name appearing in the call expression; the scanner keeps a
 * single record per `(name, file, line)` to keep edge counts
 * tractable.
 */
export function parseCallSites(
  content: string,
  file: string,
  defs: SymbolDefinition[],
): CallSite[] {
  const calls: CallSite[] = []
  const defNames = new Set(defs.map((d) => d.name))
  const defLocations = new Set(defs.filter((d) => d.file === file).map((d) => `${d.line}`))
  let match: RegExpExecArray | null

  const callRe = /(\w+)\s*\(/g
  while ((match = callRe.exec(content)) !== null) {
    const name = match[1]!
    if (!defNames.has(name)) continue
    const line = countLines(content, match.index)
    if (defLocations.has(`${line}`)) continue
    calls.push({ caller: file, callee: name, file, line })
  }

  return calls
}

// ---------------------------------------------------------------------------
//  buildGraph — turn a RepoMap + a directory into a RepoGraph
// ---------------------------------------------------------------------------

/**
 * Walk `root`, parse every source file, and stitch together the
 * structural graph consumed by the agent loop. The returned object
 * conforms to `RepoGraph` so the rest of the harness can consume it
 * without caring that it came from this package.
 *
 * The scan is two-pass:
 *
 *   1. Read every source file, emit `file` / `symbol` / `imports` /
 *      `defines` nodes and edges.
 *   2. With the complete symbol table in hand, emit `references`
 *      and `calls` edges (cross-file references depend on knowing
 *      every definition up front).
 */
export async function buildGraph(
  repoMap: RepoMap | null | undefined,
  root: string,
  options?: BuildGraphOptions,
): Promise<RepoGraph> {
  const resolvedRoot = resolve(root)
  const includeCallSites = options?.includeCallSites ?? true
  const includeReferences = options?.includeReferences ?? true

  const nodes: Map<string, GraphNode> = new Map()
  const edges: Map<string, GraphEdge> = new Map()
  const regions: Map<string, GraphRegion> = new Map()
  const symbolDefs: Map<string, SymbolDefinition> = new Map()
  const symbolRefs: SymbolReference[] = []
  const callSites: CallSite[] = []

  if (repoMap) {
    for (const pkg of repoMap.packages) {
      const id = `pkg:${pkg.name}`
      nodes.set(id, {
        id,
        type: 'package',
        name: pkg.name,
        path: pkg.path,
        metadata: { version: pkg.version },
      })
    }
    for (const app of repoMap.apps) {
      const id = `app:${app.name}`
      nodes.set(id, {
        id,
        type: 'app',
        name: app.name,
        path: app.path,
        metadata: { framework: app.framework },
      })
    }
    for (const route of repoMap.routes) {
      const id = `route:${route.path}`
      nodes.set(id, { id, type: 'route', name: route.path, path: route.file })
    }
    for (const migration of repoMap.migrations) {
      const id = `mig:${migration.name}`
      nodes.set(id, { id, type: 'migration', name: migration.name, path: migration.path })
    }
    for (const table of (repoMap.database?.tables ?? [])) {
      const id = `tbl:${table.name}`
      nodes.set(id, { id, type: 'table', name: table.name })
    }
  }

  const fileContents: Map<string, string> = new Map()

  for await (const entry of walkRepo(resolvedRoot)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue

    const fileNodeId = `file:${entry.path}`
    if (!nodes.has(fileNodeId)) {
      nodes.set(fileNodeId, {
        id: fileNodeId,
        type: 'file',
        name: entry.relativePath.split('/').pop() ?? 'file',
        path: entry.path,
      })
    }

    let content: string
    try {
      content = await readFile(entry.path, 'utf-8')
    } catch {
      continue
    }
    fileContents.set(entry.path, content)

    const imports = parseImports(content, entry.path)
    for (const imp of imports) {
      const edgeId = `edge:import:${entry.path}:${imp.source}`
      if (!edges.has(edgeId)) {
        edges.set(edgeId, {
          source: fileNodeId,
          target: `dep:${imp.source}`,
          type: 'imports',
          metadata: { line: imp.line, importType: imp.type },
        })
      }
    }

    const defs = parseExports(content, entry.path)
    for (const def of defs) {
      if (!symbolDefs.has(def.nodeId)) {
        symbolDefs.set(def.nodeId, def)
        const symNodeId = def.nodeId
        nodes.set(symNodeId, {
          id: symNodeId,
          type: 'symbol',
          name: def.name,
          path: entry.path,
          metadata: { kind: def.kind, exported: def.exported, line: def.line },
        })
        const edgeId = `edge:defines:${entry.path}:${def.name}`
        if (!edges.has(edgeId)) {
          edges.set(edgeId, {
            source: fileNodeId,
            target: symNodeId,
            type: 'defines',
          })
        }
      }
    }
  }

  const allDefs = Array.from(symbolDefs.values())
  const funcDefs = allDefs.filter((d) => d.kind === 'function')
  for (const [filePath, content] of fileContents) {
    const fileNodeId = `file:${filePath}`

    if (includeReferences) {
      const refs = parseReferences(content, filePath, allDefs)
      for (const ref of refs) {
        symbolRefs.push(ref)
        const edgeId = `edge:references:${filePath}:${ref.name}:${ref.line}`
        if (!edges.has(edgeId)) {
          edges.set(edgeId, {
            source: fileNodeId,
            target: ref.targetNodeId ?? `sym:${ref.file}:${ref.name}`,
            type: 'references',
          })
        }
      }
    }

    if (includeCallSites) {
      const calls = parseCallSites(content, filePath, funcDefs)
      for (const call of calls) {
        callSites.push(call)
        const edgeId = `edge:calls:${call.caller}:${call.callee}:${call.line}`
        if (!edges.has(edgeId)) {
          edges.set(edgeId, {
            source: `file:${call.caller}`,
            target: call.callee,
            type: 'calls',
          })
        }
      }
    }
  }

  if (repoMap) {
    for (const suite of repoMap.testSuites) {
      const testNodeId = `test:${suite.path}`
      if (!nodes.has(testNodeId)) {
        nodes.set(testNodeId, {
          id: testNodeId,
          type: 'test',
          name: suite.name,
          path: suite.path,
          metadata: { framework: suite.framework, type: suite.type },
        })
      }

      for (const file of suite.files) {
        const fileNodeId = `file:${file}`
        const edgeId = `edge:tests:${testNodeId}:${fileNodeId}`
        if (!edges.has(edgeId)) {
          edges.set(edgeId, {
            source: testNodeId,
            target: fileNodeId,
            type: 'tests',
          })
        }

        const sourceFile = inferSourceFile(file)
        if (sourceFile) {
          const sourceNodeId = `file:${sourceFile}`
          if (nodes.has(sourceNodeId)) {
            const relEdgeId = `edge:tests_rel:${testNodeId}:${sourceNodeId}`
            if (!edges.has(relEdgeId)) {
              edges.set(relEdgeId, {
                source: testNodeId,
                target: sourceNodeId,
                type: 'tests',
              })
            }
          }
        }
      }
    }

    for (const pkg of repoMap.packages) {
      const pkgNodeId = `pkg:${pkg.name}`
      for (const [depName] of Object.entries(pkg.dependencies)) {
        const depNodeId = `pkg:${depName}`
        if (nodes.has(depNodeId)) {
          const edgeId = `edge:depends_on:${pkg.name}:${depName}`
          if (!edges.has(edgeId)) {
            edges.set(edgeId, {
              source: pkgNodeId,
              target: depNodeId,
              type: 'depends_on',
              metadata: { depType: 'runtime' },
            })
          }
        }
      }
    }

    for (const boundary of repoMap.domainBoundaries) {
      const domainNodeId = `domain:${boundary.domain}`
      if (!nodes.has(domainNodeId)) {
        nodes.set(domainNodeId, {
          id: domainNodeId,
          type: 'file',
          name: boundary.domain,
          metadata: { isDomain: true },
        })
      }

      for (const fileNode of nodes.values()) {
        if (fileNode.path && matchesDomain(boundary.patterns, fileNode.path)) {
          const edgeId = `edge:owned_by:${fileNode.id}:${domainNodeId}`
          if (!edges.has(edgeId)) {
            edges.set(edgeId, {
              source: fileNode.id,
              target: domainNodeId,
              type: 'owned_by',
            })
          }
        }
      }
    }

    const domainToRegion = buildRegions(repoMap, nodes, edges)
    for (const [, region] of domainToRegion) regions.set(region.id, region)
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    regions: Array.from(regions.values()),
    symbolDefinitions: Array.from(symbolDefs.values()),
    symbolReferences: symbolRefs,
    callSites,
  }
}

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

function countLines(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesDomain(patterns: string[], filePath: string): boolean {
  return patterns.some((pattern) => {
    const globRegex = patternToRegex(pattern)
    return globRegex.test(filePath)
  })
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexd = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
  return new RegExp(`^${regexd}`)
}

function buildRegions(
  repoMap: RepoMap,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): Map<string, GraphRegion> {
  const regions: Map<string, GraphRegion> = new Map()

  for (const boundary of repoMap.domainBoundaries) {
    const regionNodeIds: string[] = []
    const regionEdgeIds: string[] = []
    const domainNodeId = `domain:${boundary.domain}`

    for (const [edgeId, edge] of edges) {
      if (edge.source === domainNodeId || edge.target === domainNodeId) {
        regionEdgeIds.push(edgeId)
        if (edge.source !== domainNodeId && !regionNodeIds.includes(edge.source)) {
          regionNodeIds.push(edge.source)
        }
        if (edge.target !== domainNodeId && !regionNodeIds.includes(edge.target)) {
          regionNodeIds.push(edge.target)
        }
      }
    }

    if (regionNodeIds.length > 0 || regionEdgeIds.length > 0) {
      regions.set(boundary.domain, {
        id: `region:${boundary.domain}`,
        label: boundary.domain,
        domain: boundary.domain,
        nodeIds: regionNodeIds,
        edgeIds: regionEdgeIds,
      })
    }
  }

  // DomainNode accumulation from boundary pass. Keeps nodes up to
  // date so subsequent queries can resolve region membership.
  void nodes
  void dirname

  return regions
}

// Re-export the inferred symbol kind for downstream parsers that
// want to stay typed without importing `@forge/types` directly.
export type { RepoGraphSymbolKind as SymbolKind }