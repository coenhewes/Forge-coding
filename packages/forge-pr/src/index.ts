export {
  // v2 — belief + verification-state aware (preferred API)
  generatePRSummary,
} from './pr-generator.js'
export type {
  PRGeneratorOutput,
  PRGeneratorSection,
  PRGeneratorMeta,
} from './types.js'
export type { PRGeneratorInput, PRGeneratorOptions } from './pr-generator.js'
export { renderPRBody } from './templates/pr-body.js'
export type { PRBodyInput } from './templates/pr-body.js'
// ArtifactRef lives in @forge/types (promoted from here) — re-export for
// back-compat with any code still importing it from @forge/pr.
export type { ArtifactRef } from '@forge/types'

// v1 — kept as a thin compatibility shim so existing callers/tests
// (tests/harness-pr.test.ts) continue to work. New code should call
// `generatePRSummary()` directly with the typed input bag.
import { generatePRSummary } from './pr-generator.js'
import type {
  AcceptanceContract,
  ArtifactRef,
  Checkpoint,
  DecisionEntry,
  DomainManifest,
  EvidenceEntry,
  FailureEntry,
  PatchCandidate,
  RepoMap,
  TaskState,
  VerificationEntry,
} from '@forge/types'
import type { ClaimEvidenceGraph } from '@forge/belief'
import type { ActiveVerificationPlan, TaskBeliefState, TaskRiskAssessment } from '@forge/types'
import { getDomainManifests } from '@forge/harness'
import type { PRGeneratorOptions } from './pr-generator.js'

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

export class PRGenerator {
  private repoMap?: RepoMap
  private domainManifests: DomainManifest[]

  constructor(options?: PRGeneratorOptions) {
    this.repoMap = options?.repoMap
    this.domainManifests = options?.domainManifests ?? getDomainManifests()
  }

  /**
   * @deprecated Prefer `generatePRSummary` with the full `PRGeneratorInput`
   * bag — this signature is a back-compat shim that synthesises a minimal
   * belief/verification/risk surface from the legacy ledgers.
   */
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
    const now = new Date().toISOString()
    const domains = new Set<string>()
    for (const f of taskState.filesTouched) {
      for (const m of this.domainManifests) {
        if (m.owns.some((p) => globToRegex(p).test(f))) {
          domains.add(m.domain)
          break
        }
      }
    }
    const belief: TaskBeliefState = {
      taskId: taskState.taskId,
      repoId: taskState.taskId,
      goal: taskState.currentInterpretation || taskState.originalRequest,
      acceptanceCriteria: taskState.acceptanceCriteria,
      selectedDomains: [...domains].map((d) => ({ domain: d, confidence: 0.5, reason: 'derived from filesTouched' })),
      selectedGraphRegions: [],
      hypotheses: [],
      claims: [],
      assumptions: [],
      uncertainties: [],
      evidenceRefs: [],
      contradictions: [],
      nodes: [],
      edges: [],
      verificationObligations: [],
      humanReviewRequirements: [],
      updatedAt: now,
    }
    const claimEvidenceGraph: ClaimEvidenceGraph = {
      taskId: taskState.taskId,
      topClaim: taskState.currentInterpretation,
      generatedAt: now,
      verifiedClaims: [],
      unverifiedClaims: [],
      contradictedClaims: [],
      staleClaims: [],
      needsHumanReview: [],
      disprovenHypotheses: [],
      openHypotheses: [],
      reviewerGuidance: [],
    }
    const activeVerification: ActiveVerificationPlan = {
      taskId: taskState.taskId,
      candidateActions: [],
      scores: [],
      claimGaps: [],
      warnings: [],
      generatedAt: now,
    }
    const riskAssessment: TaskRiskAssessment = {
      level: 'medium',
      requiresMoreEvidence: false,
      requiresMoreVerification: verification.some((v) => v.status === 'failed' || v.status === 'needs_human_review'),
      requiresConservativeEdits: false,
      requiresMoreCheckpoints: false,
      requiresExplicitHumanApproval: false,
      requiresClearerWarnings: false,
      requiresStrongerReviewGuidance: false,
      notes: [],
    }
    const artifactRefs: ArtifactRef[] = []

    const out = await generatePRSummary(
      {
        task: taskState,
        contract,
        verification,
        evidence,
        failures,
        decisions,
        checkpoints,
        patches,
        belief,
        claimEvidenceGraph,
        activeVerification,
        artifactRefs,
        riskAssessment,
      },
      { repoMap: this.repoMap, domainManifests: this.domainManifests },
    )

    // Build a v1-shaped summary for back-compat consumers.
    const accepted = (contract?.criteria ?? []).map((c) => ({
      id: c.id,
      description: c.description,
      status: c.status,
      riskArea: c.riskArea,
    }))
    const acceptSec = out.sections.find((s) => s.id === 'acceptance')?.markdown ?? ''
    const failSec = out.sections.find((s) => s.id === 'failures')?.markdown ?? ''
    const verifierSec = out.sections.find((s) => s.id === 'active-verification')?.markdown ?? ''
    const claimSec = out.sections.find((s) => s.id === 'claim-evidence')?.markdown ?? ''
    const humanSec = out.sections.find((s) => s.id === 'human-review')?.markdown ?? ''
    const guideSec = out.sections.find((s) => s.id === 'reviewer-guide')?.markdown ?? ''
    const domainsSec = out.sections.find((s) => s.id === 'changed-domains')?.markdown ?? ''
    const riskSec = out.sections.find((s) => s.id === 'risk-review')?.markdown ?? ''

    return {
      title: out.title,
      summary: out.summary,
      motivation: taskState.currentInterpretation || taskState.originalRequest,
      implementationNotes: (decisions.length > 0
        ? decisions.map((d) => `- ${d.decision} — ${d.rationale}`).join('\n')
        : 'No implementation notes recorded.'),
      acceptanceCriteria: accepted,
      testPlan: taskState.testsRun.length > 0
        ? `Tests run:\n${taskState.testsRun.map((t) => `- ${t}`).join('\n')}`
        : 'Run the existing test suite to verify no regressions.',
      migrationNotes: taskState.filesTouched.some((f) => f.includes('migration') || f.includes('migrate'))
        ? 'This change includes database migrations. Ensure they are reviewed carefully for backward compatibility and data integrity.'
        : 'No database migrations in this change.',
      riskAreas: collectBullet(riskSec).concat(collectBullet(domainsSec)),
      knownLimitations: evidence.flatMap((e) => e.status === 'unverified' ? e.unverified.map((u) => `${e.claim}: ${u}`) : []),
      followUpItems: collectBullet(verifierSec).concat(collectBullet(acceptSec)),
      verificationSummary: verifierSec || '_No verification entries recorded._',
      evidenceSummary: claimSec || '_No evidence recorded._',
      failureRecoverySummary: failSec || '_No failures or recovery events recorded._',
      humanReviewItems: collectBullet(humanSec),
      reviewGuidance: guideSec || 'Standard review process applies.',
      diffSummaryByDomain: domainsSec,
      filesChanged: taskState.filesTouched.map((f) => {
        const domain = this.domainManifests.find((m) => m.owns.some((p) => globToRegex(p).test(f)))
        return {
          path: f,
          domain: domain?.domain,
          risk: domain?.riskProfile.includes('security') || domain?.riskProfile.includes('permissions')
            ? 'high'
            : domain?.riskProfile.includes('billing')
              ? 'critical'
              : undefined,
        }
      }),
      domainsTouched: [...domains],
    }
  }
}

function collectBullet(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.replace(/^[\s*\-]+/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('**'))
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
  return new RegExp(`^${escaped}`)
}

/**
 * Back-compat renderer that flattens a v1 `PRSummary` to a single markdown
 * string. The new `renderPRBody(input)` is the preferred entry point.
 */
export function renderPRSummaryMarkdown(s: PRSummary): string {
  const out: string[] = [`# ${s.title}`, '']
  out.push(s.summary, '')
  out.push('## Motivation', '', s.motivation, '')
  out.push('## Implementation notes', '', s.implementationNotes, '')
  if (s.acceptanceCriteria.length > 0) {
    out.push('## Acceptance criteria', '')
    for (const c of s.acceptanceCriteria) {
      const icon = c.status === 'verified' ? '✅' : c.status === 'failed' ? '❌' : '🔶'
      out.push(`- ${icon} ${c.description}${c.riskArea ? ` _(risk: ${c.riskArea})_` : ''}`)
    }
    out.push('')
  }
  out.push('## Test plan', '', s.testPlan, '')
  out.push('## Verification summary', '', '```\n' + s.verificationSummary + '\n```', '')
  if (s.riskAreas.length > 0) {
    out.push('## Risk areas', '')
    for (const r of s.riskAreas) out.push(`- ${r}`)
    out.push('')
  }
  out.push('## Migration notes', '', s.migrationNotes, '')
  out.push('## Evidence summary', '', '```\n' + s.evidenceSummary + '\n```', '')
  out.push('## Failures & recovery', '', '```\n' + s.failureRecoverySummary + '\n```', '')
  if (s.knownLimitations.length > 0) {
    out.push('## Known limitations', '')
    for (const l of s.knownLimitations) out.push(`- ${l}`)
    out.push('')
  }
  if (s.followUpItems.length > 0) {
    out.push('## Follow-up items', '')
    for (const f of s.followUpItems) out.push(`- ${f}`)
    out.push('')
  }
  if (s.humanReviewItems.length > 0) {
    out.push('## Human review required', '')
    for (const i of s.humanReviewItems) out.push(`- ${i}`)
    out.push('')
  }
  out.push('## Review guidance', '', s.reviewGuidance, '')
  if (s.diffSummaryByDomain.trim()) {
    out.push('## Changes by domain', '', s.diffSummaryByDomain, '')
  }
  out.push('---', '', '🤖 Generated by [Forge](https://github.com/coenhewes/forge)')
  return out.join('\n')
}

export { GitClient, ghAvailable, createGhPr } from './git.js'
