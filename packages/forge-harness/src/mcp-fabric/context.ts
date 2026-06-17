import type {
  RepoMap,
  RepoGraph,
  DomainSelection,
  TaskState,
  AcceptanceContract,
  EvidenceLedger,
  FailureLedger,
  DecisionLedger,
  VerificationMatrix,
  DomainExpansionRecord,
} from '@forge/types'

export interface BoundedContext {
  task: string
  acceptanceContract?: AcceptanceContract
  taskState?: TaskState
  selectedDomains: string[]
  selectedCapabilities: string[]
  repoFacts: RepoFacts
  graphFacts: GraphFacts
  evidence?: EvidenceSummary
  verificationStatus?: VerificationSummary
  recentTrace?: TraceSummary
  openQuestions?: string[]
  riskConstraints?: string[]
  failureWarnings?: string[]
  checkpointStatus?: string
}

export interface RepoFacts {
  packages: number
  apps: number
  routes: number
  testSuites: number
  databaseType?: string
  primaryFramework?: string
  isMonorepo: boolean
  topLevelDirs: string[]
}

export interface GraphFacts {
  totalFiles: number
  totalSymbols: number
  totalEdges: number
  regions: string[]
  crossDomainEdges: number
  testRelationships: number
}

export interface EvidenceSummary {
  totalEntries: number
  verified: number
  unverified: number
  needsReview: number
}

export interface VerificationSummary {
  passed: number
  failed: number
  remaining: number
}

export interface TraceSummary {
  recentEvents: number
  lastAction?: string
  totalToolCalls: number
}

export interface ContextBuilderOptions {
  maxRepoFacts?: boolean
  includeGraphFacts?: boolean
  includeEvidence?: boolean
  includeTrace?: boolean
}

export class ContextBuilder {
  build(
    task: string,
    selection: DomainSelection,
    options?: {
      repoMap?: RepoMap
      repoGraph?: RepoGraph
      taskState?: TaskState
      acceptanceContract?: AcceptanceContract
      evidenceLedger?: EvidenceLedger
      failureLedger?: FailureLedger
      decisionLedger?: DecisionLedger
      verificationMatrix?: VerificationMatrix
      expansionRecords?: DomainExpansionRecord[]
      opts?: ContextBuilderOptions
    },
  ): BoundedContext {
    const context: BoundedContext = {
      task,
      selectedDomains: selection.selectedDomains,
      selectedCapabilities: selection.selectedCapabilities,
      repoFacts: this.buildRepoFacts(options?.repoMap),
      graphFacts: this.buildGraphFacts(options?.repoGraph),
    }

    if (options?.acceptanceContract) context.acceptanceContract = options.acceptanceContract
    if (options?.taskState) context.taskState = options.taskState

    if (options?.evidenceLedger) {
      context.evidence = {
        totalEntries: options.evidenceLedger.entries.length,
        verified: options.evidenceLedger.entries.filter((e) => e.status === 'verified').length,
        unverified: options.evidenceLedger.entries.filter((e) => e.status === 'unverified').length,
        needsReview: options.evidenceLedger.entries.filter((e) => e.status === 'needs_review').length,
      }
    }

    if (options?.verificationMatrix) {
      const entries = options.verificationMatrix.entries
      context.verificationStatus = {
        passed: entries.filter((e) => e.status === 'passed').length,
        failed: entries.filter((e) => e.status === 'failed').length,
        remaining: entries.filter((e) =>
          e.status === 'skipped' || e.status === 'blocked' || e.status === 'needs_human_review').length,
      }
    }

    if (options?.failureLedger && options.failureLedger.entries.length > 0) {
      const recent = options.failureLedger.entries.slice(-3)
      context.failureWarnings = recent.map((f) =>
        `Failed: ${f.hypothesis} — ${f.lesson}`,
      )
    }

    if (options?.taskState?.openQuestions && options.taskState.openQuestions.length > 0) {
      context.openQuestions = options.taskState.openQuestions
        .filter((q) => !q.resolved)
        .map((q) => q.question)
    }

    if (options?.expansionRecords && options.expansionRecords.length > 0) {
      context.riskConstraints = options.expansionRecords.map((r) =>
        `Cross-domain: ${r.initiator} → ${r.affectedDomains.join(', ')}. Required checks: ${r.requiredChecks.join(', ')}`,
      )
    }

    return context
  }

  private buildRepoFacts(repoMap?: RepoMap): RepoFacts {
    if (!repoMap) {
      return { packages: 0, apps: 0, routes: 0, testSuites: 0, isMonorepo: false, topLevelDirs: [] }
    }

    return {
      packages: repoMap.packages.length,
      apps: repoMap.apps.length,
      routes: repoMap.routes.length,
      testSuites: repoMap.testSuites.length,
      databaseType: repoMap.database?.type,
      primaryFramework: repoMap.apps[0]?.framework,
      isMonorepo: repoMap.packages.length > 1,
      topLevelDirs: [...new Set(repoMap.packages.map((p) => p.path.split('/')[2] ?? '').filter(Boolean))],
    }
  }

  private buildGraphFacts(repoGraph?: RepoGraph): GraphFacts {
    if (!repoGraph) {
      return { totalFiles: 0, totalSymbols: 0, totalEdges: 0, regions: [], crossDomainEdges: 0, testRelationships: 0 }
    }

    return {
      totalFiles: repoGraph.nodes.filter((n) => n.type === 'file').length,
      totalSymbols: repoGraph.symbolDefinitions.length,
      totalEdges: repoGraph.edges.length,
      regions: repoGraph.regions.map((r) => r.label),
      crossDomainEdges: repoGraph.edges.filter((e) => e.type === 'owned_by').length,
      testRelationships: repoGraph.edges.filter((e) => e.type === 'tests').length,
    }
  }
}
