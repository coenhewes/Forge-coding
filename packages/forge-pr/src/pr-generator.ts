import type {
  RepoMap,
  DomainManifest,
  TaskState,
  AcceptanceContract,
  VerificationEntry,
  Checkpoint,
  PatchCandidate,
  FailureEntry,
  DecisionEntry,
  EvidenceEntry,
} from '@forge/types'
import { getDomainManifests } from '@forge/harness'

export interface PRSummary {
  title: string
  summary: string
  motivation: string
  implementationNotes: string
  acceptanceCriteria: { id: string; description: string; status: string; riskArea?: string }[]
  testPlan: string
  migrationNotes: string
  riskAreas: string[]
  knownLimitations: string[]
  followUpItems: string[]
  verificationSummary: string
  evidenceSummary: string
  failureRecoverySummary: string
  humanReviewItems: string[]
  reviewGuidance: string
  diffSummaryByDomain: string
  filesChanged: { path: string; domain?: string; risk?: string }[]
  domainsTouched: string[]
  branchName?: string
}

export interface PRGeneratorOptions {
  repoMap?: RepoMap
  domainManifests?: DomainManifest[]
}

export class PRGenerator {
  private repoMap?: RepoMap
  private domainManifests: DomainManifest[]

  constructor(options?: PRGeneratorOptions) {
    this.repoMap = options?.repoMap
    this.domainManifests = options?.domainManifests ?? getDomainManifests()
  }

  async generate(
    taskState: TaskState,
    contract: AcceptanceContract | undefined,
    verification: VerificationEntry[],
    evidence: EvidenceEntry[],
    failures: FailureEntry[],
    decisions: DecisionEntry[],
    checkpoints: Checkpoint[],
    patches: PatchCandidate[],
  ): Promise<PRSummary> {
    const domainsTouched = this.inferDomains(taskState.filesTouched)
    const filesWithDomains = this.mapFilesToDomains(taskState.filesTouched)
    const riskAreas = this.assessRiskAreas(domainsTouched, verification)
    const reviewSensitivity = this.getReviewSensitivity(domainsTouched)
    const promotedPatch = patches.find((p) => p.promoted)

    const title = this.generateTitle(taskState)
    const summary = this.generateSummary(taskState, contract, domainsTouched)
    const motivation = this.generateMotivation(taskState)
    const implementationNotes = this.generateImplementationNotes(taskState, decisions, promotedPatch)
    const testPlan = this.generateTestPlan(taskState, verification)
    const migrationNotes = this.generateMigrationNotes(taskState, contract)
    const knownLimitations = this.findKnownLimitations(evidence)
    const followUpItems = this.findFollowUpItems(contract, verification, evidence)
    const verificationSummaryText = this.formatVerificationSummary(verification)
    const evidenceSummaryText = this.formatEvidenceSummary(evidence)
    const failureRecoverySummary = this.formatFailureRecovery(failures, checkpoints)
    const humanReviewItems = this.findHumanReviewItems(verification, evidence, reviewSensitivity)
    const reviewGuidance = this.generateReviewGuidance(domainsTouched, reviewSensitivity, filesWithDomains, riskAreas)
    const diffSummaryByDomain = this.generateDiffSummaryByDomain(filesWithDomains)

    return {
      title,
      summary,
      motivation,
      implementationNotes,
      acceptanceCriteria: (contract?.criteria ?? []).map((c) => ({
        id: c.id,
        description: c.description,
        status: c.status,
        riskArea: c.riskArea,
      })),
      testPlan,
      migrationNotes,
      riskAreas,
      knownLimitations,
      followUpItems,
      verificationSummary: verificationSummaryText,
      evidenceSummary: evidenceSummaryText,
      failureRecoverySummary,
      humanReviewItems,
      reviewGuidance,
      diffSummaryByDomain,
      filesChanged: filesWithDomains,
      domainsTouched,
    }
  }

  private generateTitle(taskState: TaskState): string {
    const maxLen = 72
    const raw = taskState.currentInterpretation
    if (raw.length <= maxLen) return raw
    return raw.slice(0, maxLen).replace(/\s+\S*$/, '') + '…'
  }

  private generateSummary(taskState: TaskState, contract?: AcceptanceContract, domains?: string[]): string {
    const parts: string[] = []
    parts.push(taskState.currentInterpretation)
    parts.push('')
    if (contract && contract.criteria.length > 0) {
      const verified = contract.criteria.filter((c) => c.status === 'verified').length
      parts.push(`Acceptance: ${verified}/${contract.criteria.length} criteria verified.`)
    }
    if (domains && domains.length > 0) {
      parts.push(`Domains: ${domains.join(', ')}.`)
    }
    if (taskState.filesTouched.length > 0) {
      parts.push(`Files changed: ${taskState.filesTouched.length}.`)
    }
    return parts.join('\n')
  }

  private generateMotivation(taskState: TaskState): string {
    return taskState.currentInterpretation || taskState.originalRequest
  }

  private generateImplementationNotes(
    taskState: TaskState,
    decisions: DecisionEntry[],
    promotedPatch?: PatchCandidate,
  ): string {
    const parts: string[] = []

    if (decisions.length > 0) {
      parts.push('Key decisions:')
      for (const d of decisions) {
        parts.push(`- ${d.decision}`)
        parts.push(`  Rationale: ${d.rationale}`)
        if (d.alternativesRejected.length > 0) {
          parts.push(`  Rejected: ${d.alternativesRejected.join(', ')}`)
        }
      }
      parts.push('')
    }

    if (promotedPatch) {
      parts.push(`Patch ${promotedPatch.id} was promoted after verification.`)
      parts.push(`Files in patch: ${promotedPatch.filesChanged.map((f) => f.path).join(', ')}`)
    }

    if (taskState.filesTouched.length > 0) {
      parts.push('')
      parts.push('Files touched:')
      for (const f of taskState.filesTouched) {
        parts.push(`- ${f}`)
      }
    }

    return parts.join('\n') || 'No implementation notes recorded.'
  }

  private generateTestPlan(taskState: TaskState, verification: VerificationEntry[]): string {
    const parts: string[] = []
    if (taskState.testsRun.length > 0) {
      parts.push('Tests run:')
      for (const t of taskState.testsRun) {
        parts.push(`- ${t}`)
      }
      parts.push('')
    }
    const testChecks = verification.filter((v) => v.check.toLowerCase().includes('test'))
    if (testChecks.length > 0) {
      parts.push('Test results:')
      for (const tc of testChecks) {
        const icon = tc.status === 'passed' ? '✓' : tc.status === 'failed' ? '✗' : '○'
        parts.push(`- ${icon} ${tc.check}: ${tc.status}`)
      }
    }
    return parts.join('\n') || 'Run the existing test suite to verify no regressions.'
  }

  private generateMigrationNotes(taskState: TaskState, contract?: AcceptanceContract): string {
    const hasMigration = taskState.filesTouched.some(
      (f) => f.includes('migration') || f.includes('migrate'),
    )
    if (!hasMigration) return 'No database migrations in this change.'
    return 'This change includes database migrations. Ensure they are reviewed carefully for backward compatibility and data integrity.'
  }

  private formatVerificationSummary(verification: VerificationEntry[]): string {
    if (verification.length === 0) return 'No verification entries recorded.'
    const passed = verification.filter((v) => v.status === 'passed').length
    const failed = verification.filter((v) => v.status === 'failed').length
    const needsReview = verification.filter((v) => v.status === 'needs_human_review').length
    const parts: string[] = [
      `Passed: ${passed}`,
      `Failed: ${failed}`,
      `Needs review: ${needsReview}`,
      '',
    ]
    for (const v of verification) {
      const icon = v.status === 'passed' ? '✓' : v.status === 'failed' ? '✗' : '○'
      parts.push(`- ${icon} ${v.check}: ${v.status}`)
      if (v.notes) parts.push(`  ${v.notes.slice(0, 200)}`)
    }
    return parts.join('\n')
  }

  private formatEvidenceSummary(evidence: EvidenceEntry[]): string {
    if (evidence.length === 0) return 'No evidence recorded.'
    const parts: string[] = [`${evidence.length} evidence entries.`]
    for (const e of evidence) {
      const icon = e.status === 'verified' ? '✓' : e.status === 'needs_review' ? '?' : '○'
      parts.push(`- ${icon} ${e.claim} (${e.kind})`)
      if (e.evidence.length > 0) {
        for (const ev of e.evidence) {
          parts.push(`  Evidence: ${ev.slice(0, 150)}`)
        }
      }
      if (e.unverified.length > 0) {
        for (const uv of e.unverified) {
          parts.push(`  Unverified: ${uv}`)
        }
      }
    }
    return parts.join('\n')
  }

  private formatFailureRecovery(failures: FailureEntry[], checkpoints: Checkpoint[]): string {
    const parts: string[] = []
    if (failures.length > 0) {
      parts.push(`Failed attempts: ${failures.length}`)
      for (const f of failures) {
        parts.push(`- ${f.hypothesis}`)
        parts.push(`  Action: ${f.action}`)
        parts.push(`  Lesson: ${f.lesson}`)
        if (f.nextHypothesis) parts.push(`  Next: ${f.nextHypothesis}`)
      }
      parts.push('')
    }
    const rejected = checkpoints.filter((c) => c.promotionDecision === 'rejected')
    if (rejected.length > 0) {
      parts.push(`Rejected checkpoints: ${rejected.length}`)
      for (const cp of rejected) {
        parts.push(`- ${cp.hypothesis}: ${cp.failureReason}`)
      }
      parts.push('')
    }
    const promoted = checkpoints.filter((c) => c.promotionDecision === 'promoted')
    if (promoted.length > 0) {
      parts.push(`Promoted checkpoints: ${promoted.length}`)
      for (const cp of promoted) {
        parts.push(`- ${cp.hypothesis} (${cp.id})`)
      }
    }
    return parts.join('\n') || 'No failures or recovery events recorded.'
  }

  private findKnownLimitations(evidence: EvidenceEntry[]): string[] {
    const limitations: string[] = []
    for (const e of evidence) {
      if (e.status === 'unverified') {
        limitations.push(...e.unverified.map((uv) => `${e.claim}: ${uv}`))
      }
    }
    return limitations.length > 0 ? limitations : ['None identified.']
  }

  private findFollowUpItems(
    contract?: AcceptanceContract,
    verification?: VerificationEntry[],
    evidence?: EvidenceEntry[],
  ): string[] {
    const items: string[] = []

    if (contract) {
      const unmet = contract.criteria.filter(
        (c) => c.status === 'needs_review' || c.status === 'blocked' || c.status === 'failed',
      )
      for (const c of unmet) {
        items.push(`Acceptance criterion needs attention: ${c.description}`)
      }
    }

    if (verification) {
      const failed = verification.filter((v) => v.status === 'failed')
      for (const v of failed) {
        items.push(`Verification check failed: ${v.check}`)
      }
      const needsReview = verification.filter((v) => v.status === 'needs_human_review')
      for (const v of needsReview) {
        items.push(`Verification needs human review: ${v.check}`)
      }
    }

    if (evidence) {
      const needsReview = evidence.filter((e) => e.status === 'needs_review')
      for (const e of needsReview) {
        items.push(`Evidence needs review: ${e.claim}`)
      }
    }

    return items.length > 0 ? items : ['No follow-up items identified.']
  }

  private findHumanReviewItems(
    verification: VerificationEntry[],
    evidence: EvidenceEntry[],
    reviewSensitivity: { domain: string; level: string }[],
  ): string[] {
    const items: string[] = []

    for (const rs of reviewSensitivity) {
      items.push(`Domain ${rs.domain} has review sensitivity: ${rs.level}`)
    }

    for (const v of verification) {
      if (v.status === 'needs_human_review') {
        items.push(`Verification: ${v.check}`)
      }
    }

    for (const e of evidence) {
      if (e.status === 'needs_review') {
        items.push(`Evidence: ${e.claim}`)
      }
    }

    return items.length > 0 ? items : ['No human review items flagged.']
  }

  private generateReviewGuidance(
    domains: string[],
    sensitivity: { domain: string; level: string }[],
    files: { path: string; domain?: string; risk?: string }[],
    riskAreas: string[],
  ): string {
    const parts: string[] = []

    if (sensitivity.length > 0) {
      parts.push('Priority review areas (by sensitivity):')
      const sorted = [...sensitivity].sort((a, b) => {
        const levels: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 }
        return (levels[b.level] ?? 0) - (levels[a.level] ?? 0)
      })
      for (const s of sorted) {
        parts.push(`- ${s.domain} (${s.level})`)
      }
      parts.push('')
    }

    if (riskAreas.length > 0) {
      parts.push('Risk areas:')
      for (const r of riskAreas) {
        parts.push(`- ${r}`)
      }
      parts.push('')
    }

    if (files.length > 0) {
      parts.push('Files to review first:')
      const highRiskFiles = files.filter((f) => f.risk === 'high' || f.risk === 'critical')
      const normalFiles = files.filter((f) => !highRiskFiles.includes(f))
      for (const f of highRiskFiles) {
        parts.push(`- [HIGH] ${f.path}${f.domain ? ` (${f.domain})` : ''}`)
      }
      for (const f of normalFiles) {
        parts.push(`- ${f.path}${f.domain ? ` (${f.domain})` : ''}${f.risk ? ` [${f.risk}]` : ''}`)
      }
    }

    return parts.join('\n') || 'Standard review process applies.'
  }

  private generateDiffSummaryByDomain(files: { path: string; domain?: string; risk?: string }[]): string {
    const byDomain = new Map<string, { files: string[]; risks: string[] }>()

    for (const f of files) {
      const domain = f.domain ?? 'uncategorized'
      if (!byDomain.has(domain)) byDomain.set(domain, { files: [], risks: [] })
      const entry = byDomain.get(domain)!
      entry.files.push(f.path)
      if (f.risk) entry.risks.push(f.risk)
    }

    const parts: string[] = []
    for (const [domain, info] of byDomain) {
      const riskBadge = info.risks.length > 0 ? ` [${[...new Set(info.risks)].join(', ')}]` : ''
      parts.push(`### ${domain}${riskBadge}`)
      parts.push(`${info.files.length} file(s) changed:`)
      for (const f of info.files) {
        parts.push(`- \`${f}\``)
      }
      parts.push('')
    }
    return parts.join('\n')
  }

  private inferDomains(files: string[]): string[] {
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

  private mapFilesToDomains(files: string[]): { path: string; domain?: string; risk?: string }[] {
    return files.map((f) => {
      const domain = this.domainManifests.find((m) =>
        m.owns.some((p) => this.patternToRegex(p).test(f)),
      )
      return {
        path: f,
        domain: domain?.domain,
        risk: domain?.riskProfile.includes('security') || domain?.riskProfile.includes('permissions')
          ? 'high'
          : domain?.riskProfile.includes('billing')
            ? 'critical'
            : undefined,
      }
    })
  }

  private assessRiskAreas(domains: string[], verification: VerificationEntry[]): string[] {
    const risks: string[] = []
    for (const manifest of this.domainManifests) {
      if (domains.includes(manifest.domain)) {
        risks.push(...manifest.riskProfile)
      }
    }
    // Add failed checks as risks
    for (const v of verification) {
      if (v.status === 'failed' && v.riskLevel) {
        risks.push(`Check failed: ${v.check} (${v.riskLevel})`)
      }
    }
    return [...new Set(risks)]
  }

  private getReviewSensitivity(domains: string[]): { domain: string; level: string }[] {
    return this.domainManifests
      .filter((m) => domains.includes(m.domain))
      .filter((m) => m.reviewSensitivity !== 'none')
      .map((m) => ({ domain: m.domain, level: m.reviewSensitivity }))
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
