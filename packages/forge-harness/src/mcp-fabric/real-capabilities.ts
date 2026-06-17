import { execFileSync } from 'node:child_process'
import type { RepoMap, RepoGraph, DomainManifest } from '@forge/types'
import { CapabilityRegistry, type CapabilityImplementation, type CapabilityContext } from './capabilities.js'

/**
 * Real, repo-aware capability implementations — the semantic surface AGENTS.md
 * calls for. Unlike the generated stubs, these query the RepoMap and RepoGraph
 * (and ripgrep) to return concrete engineering facts: callers, definitions,
 * dependency paths, related tests, table schemas, etc.
 *
 * Handlers are read-only by design. Mutations stay on the generic primitives
 * (write_file/edit_file/run_command) so the discovery surface can be granted
 * freely while writes remain gated.
 */

function map(ctx: CapabilityContext): RepoMap | undefined {
  return ctx.repoMap as RepoMap | undefined
}
function graph(ctx: CapabilityContext): RepoGraph | undefined {
  return ctx.repoGraph as RepoGraph | undefined
}

/** Map every graph node id to the domain of the region that contains it. */
function nodeDomainIndex(g: RepoGraph): Map<string, string> {
  const idx = new Map<string, string>()
  for (const region of g.regions) {
    if (!region.domain) continue
    for (const nodeId of region.nodeIds) idx.set(nodeId, region.domain)
  }
  return idx
}

/** Convert a simple glob ("src/**", "*.ts") to an anchored RegExp. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DS___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DS___/g, '.*')
  return new RegExp(`^${escaped}`)
}

const repoCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'repo.find_callers',
      description: 'Find call sites that call a given function/symbol. Returns caller, file, and line.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Function or symbol name' } },
        required: ['symbol'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const g = graph(ctx)
      const symbol = input.symbol as string
      if (!symbol) return { success: false, error: 'No symbol provided' }
      if (!g) return { success: false, error: 'Repo graph unavailable' }
      const callers = g.callSites
        .filter((c) => c.callee === symbol)
        .map((c) => ({ caller: c.caller, file: c.file, line: c.line }))
      return { success: true, data: { symbol, count: callers.length, callers: callers.slice(0, 50) } }
    },
  },
  {
    definition: {
      name: 'repo.find_definitions',
      description: 'Find where a symbol is defined (file, line, kind, exported).',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Symbol name' } },
        required: ['symbol'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const g = graph(ctx)
      const symbol = input.symbol as string
      if (!symbol) return { success: false, error: 'No symbol provided' }
      if (!g) return { success: false, error: 'Repo graph unavailable' }
      const defs = g.symbolDefinitions
        .filter((d) => d.name === symbol)
        .map((d) => ({ file: d.file, line: d.line, kind: d.kind, exported: d.exported }))
      return { success: true, data: { symbol, count: defs.length, definitions: defs.slice(0, 50) } }
    },
  },
  {
    definition: {
      name: 'repo.find_references',
      description: 'Find references to a symbol across the repository (file, line).',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Symbol name' } },
        required: ['symbol'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const g = graph(ctx)
      const symbol = input.symbol as string
      if (!symbol) return { success: false, error: 'No symbol provided' }
      if (!g) return { success: false, error: 'Repo graph unavailable' }
      const refs = g.symbolReferences
        .filter((r) => r.name === symbol)
        .map((r) => ({ file: r.file, line: r.line }))
      return { success: true, data: { symbol, count: refs.length, references: refs.slice(0, 80) } }
    },
  },
  {
    definition: {
      name: 'repo.find_cross_domain_edges',
      description: 'List graph edges that cross domain boundaries — where a change ripples across domains.',
      inputSchema: {
        type: 'object',
        properties: {
          domains: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict to edges touching these domains' },
        },
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const g = graph(ctx)
      if (!g) return { success: false, error: 'Repo graph unavailable' }
      const filter = (input.domains as string[] | undefined) ?? []
      const idx = nodeDomainIndex(g)
      const edges = g.edges
        .map((e) => ({ e, sd: idx.get(e.source), td: idx.get(e.target) }))
        .filter(({ sd, td }) => sd && td && sd !== td)
        .filter(({ sd, td }) => filter.length === 0 || filter.includes(sd!) || filter.includes(td!))
        .map(({ e, sd, td }) => ({ from: sd, to: td, type: e.type, source: e.source, target: e.target }))
      return { success: true, data: { count: edges.length, edges: edges.slice(0, 60) } }
    },
  },
  {
    definition: {
      name: 'repo.explain_dependency_path',
      description: 'Find a dependency path between two files/packages by following import/depends_on edges.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source file or package (name or path substring)' },
          to: { type: 'string', description: 'Target file or package (name or path substring)' },
        },
        required: ['from', 'to'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const g = graph(ctx)
      if (!g) return { success: false, error: 'Repo graph unavailable' }
      const from = input.from as string
      const to = input.to as string
      const matches = (nodeId: string, q: string) => {
        const n = g.nodes.find((x) => x.id === nodeId)
        return n ? n.id.includes(q) || n.name.includes(q) || (n.path?.includes(q) ?? false) : false
      }
      const adjacency = new Map<string, string[]>()
      for (const e of g.edges) {
        if (e.type !== 'imports' && e.type !== 'depends_on') continue
        if (!adjacency.has(e.source)) adjacency.set(e.source, [])
        adjacency.get(e.source)!.push(e.target)
      }
      const starts = g.nodes.filter((n) => matches(n.id, from)).map((n) => n.id)
      const isGoal = (id: string) => matches(id, to)
      // BFS for shortest path from any start to any goal.
      for (const start of starts) {
        const queue: string[][] = [[start]]
        const seen = new Set<string>([start])
        while (queue.length > 0) {
          const path = queue.shift()!
          const tail = path[path.length - 1]!
          if (isGoal(tail) && path.length > 1) {
            const names = path.map((id) => g.nodes.find((n) => n.id === id)?.name ?? id)
            return { success: true, data: { from, to, found: true, path: names } }
          }
          for (const next of adjacency.get(tail) ?? []) {
            if (!seen.has(next)) {
              seen.add(next)
              queue.push([...path, next])
            }
          }
        }
      }
      return { success: true, data: { from, to, found: false, path: [] } }
    },
  },
  {
    definition: {
      name: 'repo.find_ownership_boundary',
      description: 'Identify the ownership boundary and domain that a file/path belongs to.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or directory path' } },
        required: ['path'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const m = map(ctx)
      const path = input.path as string
      if (!m) return { success: false, error: 'Repo map unavailable' }
      const owners = m.ownershipBoundaries
        .filter((b) => b.patterns.some((p) => globToRegex(p).test(path)))
        .map((b) => ({ name: b.name, owners: b.owners ?? [] }))
      const domains = m.domainBoundaries
        .filter((d) => d.patterns.some((p) => globToRegex(p).test(path)))
        .map((d) => d.domain)
      return { success: true, data: { path, ownership: owners, domains } }
    },
  },
  {
    definition: {
      name: 'repo.search_code',
      description: 'Search file contents with a regex (ripgrep). Returns matching file:line snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          include: { type: 'string', description: 'Optional file glob, e.g. "*.ts"' },
          max_results: { type: 'number', description: 'Max matches (default 40)' },
        },
        required: ['pattern'],
      },
      domain: 'repo',
    },
    handler: async (input, ctx) => {
      const pattern = input.pattern as string
      if (!pattern) return { success: false, error: 'No pattern provided' }
      const max = (input.max_results as number) ?? 40
      const args = ['-n', '--no-heading']
      if (input.include) args.push('--glob', input.include as string)
      args.push('--', pattern)
      try {
        const out = execFileSync('rg', args, { cwd: ctx.repoRoot, encoding: 'utf-8', timeout: 10000 })
        const lines = out.trim().split('\n').filter(Boolean).slice(0, max)
        return { success: true, data: { count: lines.length, matches: lines } }
      } catch {
        return { success: true, data: { count: 0, matches: [] } }
      }
    },
  },
]

const testCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'tests.find_related_tests',
      description: 'Find test suites/files related to given source files (via test relationships and graph edges).',
      inputSchema: {
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' }, description: 'Source file paths' } },
        required: ['files'],
      },
      domain: 'tests',
    },
    handler: async (input, ctx) => {
      const m = map(ctx)
      const g = graph(ctx)
      const files = (input.files as string[]) ?? []
      if (!m) return { success: false, error: 'Repo map unavailable' }
      const related = new Set<string>()
      for (const suite of m.testSuites) {
        const touchesSource = (suite.relatedFiles ?? []).some((rf) => files.some((f) => rf.includes(f) || f.includes(rf)))
        if (touchesSource) suite.files.forEach((f) => related.add(f))
      }
      // Graph 'tests' edges: test node -> source node.
      if (g) {
        for (const e of g.edges) {
          if (e.type !== 'tests') continue
          const target = g.nodes.find((n) => n.id === e.target)
          if (target?.path && files.some((f) => target.path!.includes(f) || f.includes(target.path!))) {
            const src = g.nodes.find((n) => n.id === e.source)
            if (src?.path) related.add(src.path)
          }
        }
      }
      return { success: true, data: { files, count: related.size, relatedTests: [...related].slice(0, 60) } }
    },
  },
  {
    definition: {
      name: 'tests.list_suites',
      description: 'List the repository test suites (name, type, framework, file count).',
      inputSchema: { type: 'object', properties: {} },
      domain: 'tests',
    },
    handler: async (_input, ctx) => {
      const m = map(ctx)
      if (!m) return { success: false, error: 'Repo map unavailable' }
      const suites = m.testSuites.map((s) => ({ name: s.name, type: s.type, framework: s.framework, files: s.files.length }))
      return { success: true, data: { count: suites.length, suites } }
    },
  },
]

const dbCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'db.get_table_schema',
      description: 'Get the column schema for a database table.',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string', description: 'Table name' } },
        required: ['table'],
      },
      domain: 'database',
    },
    handler: async (input, ctx) => {
      const m = map(ctx)
      const table = input.table as string
      if (!m?.database) return { success: false, error: 'No database detected in repo' }
      const t = m.database.tables.find((x) => x.name === table)
      if (!t) return { success: false, error: `Table '${table}' not found. Known: ${m.database.tables.map((x) => x.name).join(', ')}` }
      return { success: true, data: { table: t.name, columns: t.columns, indexes: t.indexes ?? [], relations: t.relations ?? [] } }
    },
  },
  {
    definition: {
      name: 'db.find_migrations_touching_table',
      description: 'List migrations that touch a given table.',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string', description: 'Table name' } },
        required: ['table'],
      },
      domain: 'database',
    },
    handler: async (input, ctx) => {
      const m = map(ctx)
      const table = input.table as string
      if (!m) return { success: false, error: 'Repo map unavailable' }
      const migrations = m.migrations
        .filter((mig) => mig.tablesTouched.includes(table))
        .map((mig) => ({ name: mig.name, path: mig.path, state: mig.state }))
      return { success: true, data: { table, count: migrations.length, migrations } }
    },
  },
  {
    definition: {
      name: 'db.list_tables',
      description: 'List all known database tables.',
      inputSchema: { type: 'object', properties: {} },
      domain: 'database',
    },
    handler: async (_input, ctx) => {
      const m = map(ctx)
      if (!m?.database) return { success: false, error: 'No database detected in repo' }
      return { success: true, data: { type: m.database.type, tables: m.database.tables.map((t) => t.name) } }
    },
  },
]

/** Per-domain scoped search, so every selected domain has a real capability surface. */
function domainScopedCapabilities(manifest: DomainManifest): CapabilityImplementation[] {
  return [
    {
      definition: {
        name: `${manifest.domain}.search`,
        description: `Search code within the ${manifest.domain} domain (scoped to: ${manifest.owns.join(', ')}).`,
        inputSchema: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Regex pattern' } },
          required: ['pattern'],
        },
        domain: manifest.domain,
      },
      handler: async (input, ctx) => {
        const pattern = input.pattern as string
        if (!pattern) return { success: false, error: 'No pattern provided' }
        const args = ['-n', '--no-heading']
        for (const glob of manifest.owns) args.push('--glob', glob)
        args.push('--', pattern)
        try {
          const out = execFileSync('rg', args, { cwd: ctx.repoRoot, encoding: 'utf-8', timeout: 10000 })
          const lines = out.trim().split('\n').filter(Boolean).slice(0, 40)
          return { success: true, data: { domain: manifest.domain, count: lines.length, matches: lines } }
        } catch {
          return { success: true, data: { domain: manifest.domain, count: 0, matches: [] } }
        }
      },
    },
  ]
}

/**
 * Build the capability registry for a task: the always-on cross-cutting semantic
 * surface (repo/tests/db) plus per-domain scoped search for each selected domain.
 * db.* is only included when the repo actually has a database.
 */
export function buildCapabilityRegistry(
  selectedDomains: string[],
  manifests: DomainManifest[],
  options?: { hasDatabase?: boolean },
): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  registry.registerMany(repoCapabilities)
  registry.registerMany(testCapabilities)
  if (options?.hasDatabase) registry.registerMany(dbCapabilities)
  for (const domain of selectedDomains) {
    const manifest = manifests.find((m) => m.domain === domain)
    if (manifest) registry.registerMany(domainScopedCapabilities(manifest))
  }
  return registry
}
