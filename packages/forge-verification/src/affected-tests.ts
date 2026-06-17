import type {
  RepoMap,
  RepoGraph,
  DomainManifest,
  TestSelection,
  GraphNode,
  GraphEdge,
  SymbolDefinition,
  CallSite,
  RiskArea,
} from '@forge/types'

export interface AffectedTestSelectorOptions {
  repoMap: RepoMap
  repoGraph: RepoGraph
  domainManifests: DomainManifest[]
}

export class AffectedTestSelector {
  private repoMap: RepoMap
  private repoGraph: RepoGraph
  private domainManifests: DomainManifest[]

  constructor(options: AffectedTestSelectorOptions) {
    this.repoMap = options.repoMap
    this.repoGraph = options.repoGraph
    this.domainManifests = options.domainManifests
  }

  select(
    taskId: string,
    filesChanged: string[],
    options?: {
      acceptanceCriteria?: string[]
      riskProfile?: string[]
    },
  ): TestSelection {
    const symbolsChanged = this.findSymbolsInFiles(filesChanged)
    const callersAffected = this.findCallers(symbolsChanged)
    const routesAffected = this.findRoutesForFiles(filesChanged)
    const tablesAffected = this.findTablesForFiles(filesChanged)
    const migrationsAffected = this.findMigrations(filesChanged)
    const domainsTouched = this.findDomains(filesChanged)
    const riskProfile = this.assessRisk(domainsTouched, filesChanged, options?.riskProfile)
    const historicalFlakyTests = this.findFlakyTests()
    const crossDomainEdges = this.findCrossDomainEdges(domainsTouched)
    const reviewSensitivity = this.getReviewSensitivity(domainsTouched)
    const selectedTests = this.selectTests(
      filesChanged,
      symbolsChanged,
      callersAffected,
      routesAffected,
      tablesAffected,
      domainsTouched,
      riskProfile,
    )

    const rationale = this.buildRationale(
      filesChanged,
      symbolsChanged,
      domainsTouched,
      riskProfile,
      selectedTests,
    )

    return {
      taskId,
      filesChanged,
      symbolsChanged,
      callersAffected,
      routesAffected,
      tablesAffected,
      migrationsAffected,
      domainsTouched,
      riskProfile,
      historicalFlakyTests,
      acceptanceCriteria: options?.acceptanceCriteria ?? [],
      crossDomainEdges,
      reviewSensitivity,
      selectedTests,
      rationale,
    }
  }

  private findSymbolsInFiles(files: string[]): string[] {
    const symbols: string[] = []
    for (const symbol of this.repoGraph.symbolDefinitions) {
      if (files.some((f) => symbol.file === f || symbol.file.startsWith(f.replace(/\/[^/]+$/, '')))) {
        symbols.push(symbol.name)
      }
    }
    return [...new Set(symbols)]
  }

  private findCallers(symbols: string[]): string[] {
    const callers: string[] = []
    for (const callSite of this.repoGraph.callSites) {
      if (symbols.includes(callSite.callee)) {
        callers.push(callSite.caller)
      }
    }
    return [...new Set(callers)]
  }

  private findRoutesForFiles(files: string[]): string[] {
    const routes: string[] = []
    for (const route of this.repoMap.routes) {
      if (files.some((f) => route.file === f || f.startsWith(dirname(route.file)))) {
        routes.push(route.path)
      }
    }
    return [...new Set(routes)]
  }

  private findTablesForFiles(files: string[]): string[] {
    if (!this.repoMap.database) return []

    const tables: string[] = []
    for (const migration of this.repoMap.migrations) {
      if (files.some((f) => migration.path === f)) {
        tables.push(...migration.tablesTouched)
      }
    }
    return [...new Set(tables)]
  }

  private findMigrations(files: string[]): string[] {
    return this.repoMap.migrations
      .filter((m) => files.some((f) => m.path === f))
      .map((m) => m.name)
  }

  private findDomains(files: string[]): string[] {
    const domains = new Set<string>()

    for (const manifest of this.domainManifests) {
      for (const pattern of manifest.owns) {
        const regex = this.patternToRegex(pattern)
        if (files.some((f) => regex.test(f))) {
          domains.add(manifest.domain)
          break
        }
      }
    }

    return [...domains]
  }

  private assessRisk(domains: string[], files: string[], externalRisk?: string[]): string[] {
    const risks = new Set<string>(externalRisk ?? [])

    // Check if any changed files are in risk-sensitive areas
    for (const area of this.repoMap.riskSensitiveAreas) {
      for (const pattern of area.paths) {
        const regex = this.patternToRegex(pattern)
        if (files.some((f) => regex.test(f))) {
          risks.add(area.name)
          break
        }
      }
    }

    return [...risks]
  }

  private findFlakyTests(): string[] {
    return this.repoMap.testSuites
      .filter((t) => t.files.some((f) => f.includes('flaky')))
      .flatMap((t) => t.files)
  }

  private findCrossDomainEdges(domains: string[]): string[] {
    const edges: string[] = []
    for (const edge of this.repoGraph.edges) {
      if (edge.type === 'depends_on' || edge.type === 'connects_to') {
        edges.push(`${edge.source}->${edge.target}`)
      }
    }
    return edges
  }

  private getReviewSensitivity(domains: string[]): string[] {
    const sensitivities: string[] = []
    for (const manifest of this.domainManifests) {
      if (domains.includes(manifest.domain) && manifest.reviewSensitivity !== 'none') {
        sensitivities.push(`${manifest.domain}:${manifest.reviewSensitivity}`)
      }
    }
    return sensitivities
  }

  private selectTests(
    files: string[],
    symbols: string[],
    callers: string[],
    routes: string[],
    tables: string[],
    domains: string[],
    riskProfile: string[],
  ): string[] {
    const selected = new Set<string>()
    const isHighRisk = riskProfile.length > 0 || domains.some((d) => d === 'auth' || d === 'billing' || d === 'security')

    // Direct file-to-test mapping via TestSuiteInfo.relatedFiles
    for (const suite of this.repoMap.testSuites) {
      for (const file of files) {
        if (suite.relatedFiles?.some((rf) => file === rf || file.startsWith(rf.replace(/\/[^/]+$/, '')))) {
          suite.files.forEach((f) => selected.add(f))
        }
      }
    }

    // Symbol-based: tests for files containing changed symbols
    for (const suite of this.repoMap.testSuites) {
      for (const suiteFile of suite.files) {
        for (const symbol of symbols) {
          if (suiteFile.toLowerCase().includes(symbol.toLowerCase())) {
            selected.add(suiteFile)
          }
        }
      }
    }

    // Caller-based: tests for files that call changed functions
    for (const suite of this.repoMap.testSuites) {
      for (const suiteFile of suite.files) {
        for (const caller of callers) {
          if (suiteFile.toLowerCase().includes(caller.toLowerCase())) {
            selected.add(suiteFile)
          }
        }
      }
    }

    // Route-based: tests for affected routes
    for (const suite of this.repoMap.testSuites) {
      for (const route of routes) {
        const routeSlug = route.replace(/[^a-zA-Z0-9]/g, '-')
        if (suite.files.some((f) => f.toLowerCase().includes(routeSlug.toLowerCase()))) {
          suite.files.forEach((f) => selected.add(f))
        }
      }
    }

    // Domain-based tests
    for (const suite of this.repoMap.testSuites) {
      for (const domain of domains) {
        if (suite.path.toLowerCase().includes(domain.toLowerCase())) {
          suite.files.forEach((f) => selected.add(f))
        }
      }
    }

    // Table-based: tests referencing changed tables
    for (const suite of this.repoMap.testSuites) {
      for (const table of tables) {
        if (suite.path.toLowerCase().includes(table.toLowerCase())) {
          suite.files.forEach((f) => selected.add(f))
        }
      }
    }

    // High risk: add all tests from affected domains
    if (isHighRisk) {
      for (const suite of this.repoMap.testSuites) {
        for (const domain of domains) {
          if (suite.path.toLowerCase().includes(domain.toLowerCase())) {
            suite.files.forEach((f) => selected.add(f))
          }
        }
      }
    }

    // Graph edge-based: follow import edges to find test connections
    for (const edge of this.repoGraph.edges) {
      if (edge.type === 'tests' || edge.type === 'depends_on') {
        const sourceFile = this.findNodePath(edge.source)
        const targetFile = this.findNodePath(edge.target)
        if (sourceFile && files.some((f) => sourceFile.includes(f))) {
          const testSuite = this.repoMap.testSuites.find((t) =>
            t.files.some((tf) => targetFile && targetFile.includes(tf)),
          )
          if (testSuite) testSuite.files.forEach((f) => selected.add(f))
        }
      }
    }

    return [...selected]
  }

  private buildRationale(
    files: string[],
    symbols: string[],
    domains: string[],
    riskProfile: string[],
    selectedTests: string[],
  ): string {
    const parts: string[] = []

    if (files.length > 0) parts.push(`${files.length} files changed`)
    if (symbols.length > 0) parts.push(`${symbols.length} symbols affected`)
    if (domains.length > 0) parts.push(`domains: ${domains.join(', ')}`)
    if (riskProfile.length > 0) parts.push(`risk: ${riskProfile.join(', ')}`)
    if (selectedTests.length > 0) parts.push(`${selectedTests.length} tests selected`)
    if (riskProfile.length > 0) parts.push('broadened selection due to risk profile')

    return parts.join('; ')
  }

  private findNodePath(nodeId: string): string | undefined {
    const node = this.repoGraph.nodes.find((n) => n.id === nodeId)
    return node?.path
  }

  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '___DOUBLESTAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLESTAR___/g, '.*')
    return new RegExp(`^${escaped}`)
  }
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(0, idx) : '.'
}
