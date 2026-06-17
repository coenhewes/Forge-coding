import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { walkDir, isSourceFile } from '../repo-map/walker.js'
import { parseImports, parseExports, parseReferences, parseCallSites } from './parsers.js'

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

export interface BuildGraphOptions {
  includeCallSites?: boolean
  includeReferences?: boolean
}

export async function buildGraph(
  repoMap: RepoMap,
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

  // 1. Create file nodes from repo map files
  for (const pkg of repoMap.packages) {
    const pkgNodeId = `pkg:${pkg.name}`
    nodes.set(pkgNodeId, {
      id: pkgNodeId,
      type: 'package',
      name: pkg.name,
      path: pkg.path,
      metadata: { version: pkg.version },
    })
  }

  for (const app of repoMap.apps) {
    const appNodeId = `app:${app.name}`
    nodes.set(appNodeId, {
      id: appNodeId,
      type: 'app',
      name: app.name,
      path: app.path,
      metadata: { framework: app.framework },
    })
  }

  for (const route of repoMap.routes) {
    const routeNodeId = `route:${route.path}`
    nodes.set(routeNodeId, {
      id: routeNodeId,
      type: 'route',
      name: route.path,
      path: route.file,
    })
  }

  for (const migration of repoMap.migrations) {
    const migrationNodeId = `mig:${migration.name}`
    nodes.set(migrationNodeId, {
      id: migrationNodeId,
      type: 'migration',
      name: migration.name,
      path: migration.path,
    })
  }

  for (const table of (repoMap.database?.tables ?? [])) {
    const tableNodeId = `tbl:${table.name}`
    nodes.set(tableNodeId, {
      id: tableNodeId,
      type: 'table',
      name: table.name,
    })
  }

  // 2. Scan source files for imports, exports, symbols, calls
  const fileToImports: Map<string, string[]> = new Map()
  // Cache file contents so references/call sites can be resolved in a second
  // pass against the COMPLETE symbol table (cross-file calls depend on this).
  const fileContents: Map<string, string> = new Map()

  for await (const entry of walkDir(resolvedRoot)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue

    const fileNodeId = `file:${entry.path}`
    const hasNode = nodes.has(fileNodeId)
    if (!hasNode) {
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

    // Parse imports
    const imports = parseImports(content, entry.path)
    fileToImports.set(entry.path, imports.map((i) => i.source))
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

    // Parse exports / symbol definitions
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

  // 2b. Second pass: resolve references and call sites against the complete
  // symbol table so cross-file usages are captured (e.g. a helper defined in
  // one file and called from many others).
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

  // 3. Build test relationships
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

      // Link to source files under test
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

  // 4. Build dependency edges between packages
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

  // 5. Build cross-domain edges
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

  // 6. Build graph regions
  const domainToRegion = buildRegions(repoMap, nodes, edges)

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    regions: Array.from(domainToRegion.values()),
    symbolDefinitions: Array.from(symbolDefs.values()),
    symbolReferences: symbolRefs,
    callSites,
  }
}

function inferSourceFile(testFile: string): string | undefined {
  // e.g., src/auth/login.test.ts → src/auth/login.ts
  return testFile
    .replace(/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/, '.$2')
    .replace(/\/__tests__\//, '/')
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

  return regions
}
