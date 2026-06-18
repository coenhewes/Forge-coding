/**
 * PR generator — belief + verification-state aware.
 *
 * Consumes the full durable-task surface (TaskBeliefState, ClaimEvidenceGraph,
 * ActiveVerificationPlan, TaskRiskAssessment, ArtifactRef[]) plus the legacy
 * ledgers (TaskState, AcceptanceContract, VerificationEntry, EvidenceEntry,
 * FailureEntry, DecisionEntry, Checkpoint, PatchCandidate) and produces a
 * reviewable PR body in the order prescribed by feature_requests/featurerequest1.md
 * §"Example final PR section".
 *
 * The 11 output sections, in order:
 *   1.  Title                  (derived from task + first acceptance criterion)
 *   2.  Summary                (<= 8 lines)
 *   3.  Acceptance status      (criteria + status + risk)
 *   4.  Claim-Evidence Summary (verified / disproven / stale / human-review)
 *   5.  Active Verification Summary (planned, completed, deferred)
 *   6.  Failed Hypotheses and Recovery
 *   7.  Decisions Ledger
 *   8.  Risk Review Guide
 *   9.  Changed Domains        (from belief)
 *   10. Human Review Required
 *   11. Reviewer Guide
 *   (12. Exact Artifact References — links to .forge/artifacts/...)
 *
 * The PR body markdown template lives in ./templates/pr-body.md.ts and is
 * composed by `renderPRBody`.
 */
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
import type { ActiveVerificationPlan, VerificationAction } from '@forge/types'
import type { TaskBeliefState, TaskRiskAssessment } from '@forge/types'
import { getDomainManifests } from '@forge/harness'
import { renderPRBody } from './templates/pr-body.js'

// ---------------------------------------------------------------------------
// Local types — section/output/meta. ArtifactRef lives in @forge/types
// (promoted from this package). The legacy import path @forge/pr/ArtifactRef
// still works via the re-export in ./types.ts and ./index.ts.
// ---------------------------------------------------------------------------

export type { PRGeneratorSection, PRGeneratorOutput, PRGeneratorMeta } from './types.js'

import type { PRGeneratorSection, PRGeneratorOutput, PRGeneratorMeta } from './types.js'

export interface PRGeneratorInput {
  task: TaskState
  contract: AcceptanceContract | undefined
  verification: VerificationEntry[]
  evidence: EvidenceEntry[]
  failures: FailureEntry[]
  decisions: DecisionEntry[]
  checkpoints: Checkpoint[]
  patches: PatchCandidate[]

  /** Live belief state for the task — drives Changed Domains + hypotheses. */
  belief: TaskBeliefState
  /** Assurance case from @forge/belief's generateAssuranceCase(). */
  claimEvidenceGraph: ClaimEvidenceGraph
  /** Active verification plan from @forge/verification-planner. */
  activeVerification: ActiveVerificationPlan
  /** Concrete artifacts to link in the PR body. */
  artifactRefs: ArtifactRef[]
  /** Risk model from the harness's assessTaskRisk(). */
  riskAssessment: TaskRiskAssessment
}

export interface PRGeneratorOptions {
  repoMap?: RepoMap
  domainManifests?: DomainManifest[]
  /** Override the clock for deterministic snapshots. */
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a structured PR summary from the full durable task surface.
 *
 * Pure / async — does not touch the filesystem, network, or state store. The
 * caller is responsible for assembling the inputs (typically in FINALIZE)
 * and for persisting `output.body` to the PR.
 */
export async function generatePRSummary(
  input: PRGeneratorInput,
  options: PRGeneratorOptions = {},
): Promise<PRGeneratorOutput> {
  const ctx = new PRGeneratorContext(input, options)
  const title = ctx.buildTitle()
  const summary = ctx.buildSummary()
  const sections: PRGeneratorSection[] = [
    ctx.buildAcceptanceSection(),
    ctx.buildClaimEvidenceSection(),
    ctx.buildActiveVerificationSection(),
    ctx.buildFailedHypothesesSection(),
    ctx.buildDecisionsSection(),
    ctx.buildRiskReviewGuideSection(),
    ctx.buildChangedDomainsSection(),
    ctx.buildHumanReviewSection(),
    ctx.buildReviewerGuideSection(),
    ctx.buildArtifactRefsSection(),
  ]
  const body = renderPRBody({ title, summary, sections })
  const meta = ctx.buildMeta(title, summary)
  const promotedPatch = input.patches.find((p) => p.promoted)
  return { title, summary, sections, body, promotedPatch, meta }
}

// ---------------------------------------------------------------------------
// Context — bundles input + derived helpers so section builders stay small.
// ---------------------------------------------------------------------------

class PRGeneratorContext {
  readonly input: PRGeneratorInput
  readonly domainManifests: DomainManifest[]
  readonly now: () => Date

  constructor(input: PRGeneratorInput, options: PRGeneratorOptions) {
    this.input = input
    this.domainManifests = options.domainManifests ?? getDomainManifests()
    this.now = options.now ?? (() => new Date())
  }

  // -- Title (section 1) ---------------------------------------------------

  buildTitle(): string {
    const maxLen = 72
    const firstCriterion = this.input.contract?.criteria[0]?.description
    const raw = firstCriterion
      ? `${this.input.task.currentInterpretation} — ${firstCriterion}`
      : this.input.task.currentInterpretation || this.input.task.originalRequest
    if (raw.length <= maxLen) return raw
    return raw.slice(0, maxLen).replace(/\s+\S*$/, '') + '…'
  }

  // -- Summary (section 2) -------------------------------------------------

  buildSummary(): string {
    const lines: string[] = []
    const { task, contract, belief, riskAssessment } = this.input
    lines.push(task.currentInterpretation || task.originalRequest)

    if (contract && contract.criteria.length > 0) {
      const verified = contract.criteria.filter((c) => c.status === 'verified').length
      lines.push(`Acceptance: ${verified}/${contract.criteria.length} criteria verified.`)
    }

    const domains = belief.selectedDomains.map((d) => d.domain)
    if (domains.length > 0) lines.push(`Domains in scope: ${domains.join(', ')}.`)

    const topHypothesis = this.topHypothesis()
    if (topHypothesis) {
      lines.push(
        `Top hypothesis: "${topHypothesis.claim}" (confidence ${(topHypothesis.confidence * 100).toFixed(0)}%).`,
      )
    }

    lines.push(`Risk: ${riskAssessment.level} (${this.riskFlagSummary()}).`)
    if (task.filesTouched.length > 0) lines.push(`Files changed: ${task.filesTouched.length}.`)
    if (this.input.claimEvidenceGraph.verifiedClaims.length > 0) {
      lines.push(
        `Verified claims: ${this.input.claimEvidenceGraph.verifiedClaims.length} · ` +
          `Stale: ${this.input.claimEvidenceGraph.staleClaims.length} · ` +
          `Contradicted: ${this.input.claimEvidenceGraph.contradictedClaims.length} · ` +
          `Needs review: ${this.input.claimEvidenceGraph.needsHumanReview.length}.`,
      )
    }

    // Trim to <= 8 lines; always keep the first (interpretation).
    return lines.slice(0, 8).join('\n')
  }

  // -- Section 3 — Acceptance status --------------------------------------

  buildAcceptanceSection(): PRGeneratorSection {
    const { contract } = this.input
    if (!contract || contract.criteria.length === 0) {
      return section('acceptance', 'Acceptance status', '_No acceptance contract recorded._')
    }
    const out: string[] = []
    for (const c of contract.criteria) {
      const icon = statusIcon(c.status)
      const risk = c.riskArea ? ` _(risk: ${c.riskArea})_` : ''
      const evidence = c.evidenceRefs.length > 0 ? ` — evidence: ${c.evidenceRefs.join(', ')}` : ''
      out.push(`- ${icon} **${c.id}** — ${c.description}${risk}${evidence}`)
      if (c.notes) out.push(`  - ${c.notes}`)
    }
    return section('acceptance', 'Acceptance status', out.join('\n'))
  }

  // -- Section 4 — Claim-Evidence Summary ---------------------------------

  buildClaimEvidenceSection(): PRGeneratorSection {
    const g = this.input.claimEvidenceGraph
    const out: string[] = []

    if (g.verifiedClaims.length > 0) {
      out.push('### Verified')
      for (const c of g.verifiedClaims) {
        const conf = (c.confidence * 100).toFixed(0)
        out.push(`- ${c.claim.text} _(confidence ${conf}%, risk ${c.claim.riskLevel})_`)
        if (c.supportingEvidence.length > 0) {
          for (const ev of c.supportingEvidence) {
            out.push(`  - supports: ${ev.summary ?? ev.id}${ev.artifactRef ? ` [\`${ev.artifactRef}\`]` : ''}`)
          }
        }
      }
      out.push('')
    }

    if (g.contradictedClaims.length > 0) {
      out.push('### Contradicted')
      for (const c of g.contradictedClaims) {
        out.push(`- ❌ ${c.claim.text}`)
        for (const ev of c.contradictingEvidence) {
          out.push(`  - contradicts: ${ev.summary ?? ev.id}${ev.artifactRef ? ` [\`${ev.artifactRef}\`]` : ''}`)
        }
      }
      out.push('')
    }

    if (g.staleClaims.length > 0) {
      out.push('### Stale (re-verify before merge)')
      for (const c of g.staleClaims) {
        const reason = c.claim.staleReason ? ` — _${c.claim.staleReason}_` : ''
        out.push(`- ⚠️ ${c.claim.text}${reason}`)
      }
      out.push('')
    }

    if (g.needsHumanReview.length > 0) {
      out.push('### Needs human review')
      for (const c of g.needsHumanReview) {
        const guidance = c.claim.reviewerGuidance ? ` — ${c.claim.reviewerGuidance}` : ''
        out.push(`- 🔶 ${c.claim.text}${guidance}`)
      }
      out.push('')
    }

    if (g.disprovenHypotheses.length > 0) {
      out.push('### Disproven hypotheses')
      for (const h of g.disprovenHypotheses) {
        out.push(`- ~~${h.hypothesis.claim}~~ _(confidence was ${(h.confidence * 100).toFixed(0)}%)_`)
      }
      out.push('')
    }

    if (out.length === 0) {
      out.push('_No claims recorded in the assurance case yet._')
    }
    return section('claim-evidence', 'Claim-Evidence Summary', out.join('\n').trimEnd())
  }

  // -- Section 5 — Active Verification Summary ----------------------------

  buildActiveVerificationSection(): PRGeneratorSection {
    const plan = this.input.activeVerification
    const out: string[] = []
    const planned = plan.candidateActions.filter(
      (a) => a.status === 'candidate' || a.status === 'selected' || a.status === 'running',
    )
    const completed = plan.candidateActions.filter(
      (a) =>
        a.status === 'passed' || a.status === 'failed' || a.status === 'blocked' || a.status === 'skipped',
    )
    const needsReview = plan.candidateActions.filter((a) => a.status === 'needs_human_review')
    const deferred = plan.candidateActions.filter((a) => a.status === 'stale')

    if (plan.recommendedAction) {
      out.push(
        `**Recommended next action:** \`${plan.recommendedAction.actionType}\` (${plan.recommendedAction.id}) — ${plan.recommendedAction.selectionReason}`,
      )
      out.push('')
    }

    out.push(`### Planned (${planned.length})`)
    if (planned.length === 0) out.push('_None — all checks complete or deferred._')
    for (const a of planned) out.push(this.formatAction(a))
    out.push('')

    out.push(`### Completed (${completed.length})`)
    if (completed.length === 0) out.push('_None recorded yet._')
    for (const a of completed) out.push(this.formatAction(a))
    out.push('')

    if (needsReview.length > 0) {
      out.push(`### Needs human review (${needsReview.length})`)
      for (const a of needsReview) out.push(this.formatAction(a))
      out.push('')
    }

    if (deferred.length > 0) {
      out.push(`### Deferred (${deferred.length})`)
      for (const a of deferred) out.push(this.formatAction(a))
      out.push('')
    }

    if (plan.warnings.length > 0) {
      out.push('### Warnings')
      for (const w of plan.warnings) out.push(`- ${w}`)
      out.push('')
    }

    if (plan.claimGaps.length > 0) {
      out.push('### Claim gaps')
      for (const g of plan.claimGaps) {
        out.push(`- ${g.text} _(status: ${g.status}, missing: ${g.missingEvidence.join('; ') || '—'})_`)
      }
    }

    return section('active-verification', 'Active Verification Summary', out.join('\n').trimEnd())
  }

  // -- Section 6 — Failed Hypotheses and Recovery -------------------------

  buildFailedHypothesesSection(): PRGeneratorSection {
    const { failures, checkpoints } = this.input
    const out: string[] = []
    if (failures.length === 0 && checkpoints.filter((c) => c.promotionDecision === 'rejected').length === 0) {
      return section('failures', 'Failed Hypotheses and Recovery', '_No failed hypotheses recorded._')
    }
    if (failures.length > 0) {
      out.push('### Failure ledger')
      for (const f of failures) {
        out.push(`- **${f.hypothesis}**`)
        out.push(`  - Action: ${f.action}`)
        out.push(`  - Result: ${f.result}`)
        out.push(`  - Lesson: ${f.lesson}`)
        if (f.nextHypothesis) out.push(`  - Next: ${f.nextHypothesis}`)
      }
      out.push('')
    }
    const rejected = checkpoints.filter((c) => c.promotionDecision === 'rejected')
    if (rejected.length > 0) {
      out.push('### Rejected checkpoints')
      for (const cp of rejected) {
        out.push(`- ${cp.hypothesis} _(${cp.id})_ — ${cp.failureReason ?? 'no reason recorded'}`)
      }
      out.push('')
    }
    const promoted = checkpoints.filter((c) => c.promotionDecision === 'promoted')
    if (promoted.length > 0) {
      out.push('### Promoted checkpoints')
      for (const cp of promoted) {
        out.push(`- ${cp.hypothesis} _(${cp.id})_`)
      }
    }
    return section('failures', 'Failed Hypotheses and Recovery', out.join('\n').trimEnd())
  }

  // -- Section 7 — Decisions Ledger ---------------------------------------

  buildDecisionsSection(): PRGeneratorSection {
    const { decisions } = this.input
    if (decisions.length === 0) {
      return section('decisions', 'Decisions Ledger', '_No architectural decisions recorded._')
    }
    const out: string[] = []
    for (const d of decisions) {
      const tag = d.author === 'human' ? '👤' : '🤖'
      out.push(`- ${tag} **${d.decision}**`)
      out.push(`  - Rationale: ${d.rationale}`)
      if (d.alternativesRejected.length > 0) {
        out.push(`  - Rejected: ${d.alternativesRejected.join('; ')}`)
      }
      if (d.verificationRequired.length > 0) {
        out.push(`  - Verification required: ${d.verificationRequired.join('; ')}`)
      }
      if (d.domain) out.push(`  - Domain: ${d.domain}`)
    }
    return section('decisions', 'Decisions Ledger', out.join('\n'))
  }

  // -- Section 8 — Risk Review Guide --------------------------------------

  buildRiskReviewGuideSection(): PRGeneratorSection {
    const { riskAssessment } = this.input
    const out: string[] = []
    out.push(`**Overall risk: \`${riskAssessment.level}\`**`)
    if (riskAssessment.notes.length > 0) {
      out.push('')
      for (const n of riskAssessment.notes) out.push(`- ${n}`)
    }
    const flags = this.activeRiskFlags()
    if (flags.length > 0) {
      out.push('')
      out.push('### Required safeguards')
      for (const f of flags) out.push(`- [ ] ${f}`)
    }
    return section('risk-review', 'Risk Review Guide', out.join('\n'))
  }

  // -- Section 9 — Changed Domains (from belief) --------------------------

  buildChangedDomainsSection(): PRGeneratorSection {
    const { belief, task } = this.input
    const touched = new Set(task.filesTouched)
    const out: string[] = []

    if (belief.selectedDomains.length > 0) {
      out.push('### Belief-selected domains')
      for (const d of belief.selectedDomains) {
        out.push(`- **${d.domain}** _(confidence ${(d.confidence * 100).toFixed(0)}%)_ — ${d.reason}`)
      }
      out.push('')
    }

    if (touched.size > 0) {
      out.push('### Files by domain')
      const byDomain = new Map<string, string[]>()
      for (const f of task.filesTouched) {
        const domain = this.domainFor(f) ?? 'uncategorized'
        if (!byDomain.has(domain)) byDomain.set(domain, [])
        byDomain.get(domain)!.push(f)
      }
      for (const [domain, files] of byDomain) {
        out.push(`- **${domain}** (${files.length} file${files.length === 1 ? '' : 's'})`)
        for (const f of files) out.push(`  - \`${f}\``)
      }
    } else {
      out.push('_No files touched in this change._')
    }

    return section('changed-domains', 'Changed Domains', out.join('\n').trimEnd())
  }

  // -- Section 10 — Human Review Required ---------------------------------

  buildHumanReviewSection(): PRGeneratorSection {
    const items: string[] = []
    const g = this.input.claimEvidenceGraph
    for (const c of g.needsHumanReview) {
      items.push(`Review claim: ${c.claim.text}${c.claim.reviewerGuidance ? ` (${c.claim.reviewerGuidance})` : ''}`)
    }
    for (const hrr of this.input.belief.humanReviewRequirements) {
      if (hrr.status === 'open') {
        items.push(`[${hrr.riskLevel}] ${hrr.reason}`)
      }
    }
    for (const v of this.input.verification) {
      if (v.status === 'needs_human_review') {
        items.push(`Verify: ${v.check}${v.notes ? ` (${v.notes})` : ''}`)
      }
    }
    for (const e of this.input.evidence) {
      if (e.status === 'needs_review') items.push(`Evidence: ${e.claim}`)
    }
    if (this.input.riskAssessment.requiresExplicitHumanApproval) {
      items.push('Task-level risk requires explicit human approval before merge.')
    }
    if (items.length === 0) {
      return section('human-review', 'Human Review Required', '_No human review items flagged._')
    }
    return section('human-review', 'Human Review Required', items.map((i) => `- [ ] ${i}`).join('\n'))
  }

  // -- Section 11 — Reviewer Guide ----------------------------------------

  buildReviewerGuideSection(): PRGeneratorSection {
    const out: string[] = []
    const { task, belief, riskAssessment } = this.input
    const promoted = this.input.patches.find((p) => p.promoted)

    out.push('### Review order (highest leverage first)')
    if (promoted) {
      out.push(
        `1. **Start with the promoted patch** (\`${promoted.id}\`) — ${promoted.hypothesis}. ` +
          `This is the patch that survived verification.`,
      )
    } else {
      out.push('1. **No patch was promoted** — verify the staged changes are safe to merge as-is.')
    }

    if (belief.uncertainties.length > 0) {
      const top = belief.uncertainties
        .slice()
        .sort((a, b) => severityRank(b.riskLevel) - severityRank(a.riskLevel))
        .slice(0, 3)
      out.push(`2. **Resolve the top open uncertainties**:`)
      for (const u of top) out.push(`   - [${u.riskLevel}] ${u.text}`)
    }

    if (riskAssessment.requiresMoreVerification) {
      out.push(`3. **Run additional verification** — task-level risk flagged \`requiresMoreVerification\`.`)
    }
    if (riskAssessment.requiresExplicitHumanApproval) {
      out.push(`4. **Obtain explicit human approval** before merge.`)
    }
    out.push(`${promoted ? '5' : riskAssessment.requiresExplicitHumanApproval ? '5' : '4'}. **Skim the diff by domain** below.`)

    const domainFiles = new Map<string, string[]>()
    for (const f of task.filesTouched) {
      const d = this.domainFor(f) ?? 'uncategorized'
      if (!domainFiles.has(d)) domainFiles.set(d, [])
      domainFiles.get(d)!.push(f)
    }
    if (domainFiles.size > 0) {
      out.push('')
      out.push('### Diff by domain')
      for (const [d, files] of domainFiles) {
        out.push(`- **${d}** (${files.length})`)
        for (const f of files.slice(0, 10)) out.push(`  - \`${f}\``)
        if (files.length > 10) out.push(`  - _…${files.length - 10} more_`)
      }
    }

    return section('reviewer-guide', 'Reviewer Guide', out.join('\n'))
  }

  // -- Section 12 — Exact Artifact References -----------------------------

  buildArtifactRefsSection(): PRGeneratorSection {
    const { artifactRefs } = this.input
    if (artifactRefs.length === 0) {
      return section('artifacts', 'Exact Artifact References', '_No artifacts linked._')
    }
    const out: string[] = []
    for (const a of artifactRefs) {
      const title = a.title ?? a.kind
      const location = 'path' in a ? `.forge/artifacts/${a.path}` : a.uri
      const label = 'path' in a ? a.path : a.uri
      const meta = [`kind: ${a.kind}`, `id: ${a.id}`]
      if (a.mime) meta.push(`mime: ${a.mime}`)
      if (a.size !== undefined) meta.push(`size: ${a.size}B`)
      if (a.checksum) meta.push(`sha256: ${a.checksum.slice(0, 12)}…`)
      out.push(`- [\`${label}\`](${location}) — **${title}** _(${meta.join(', ')})_`)
      if (a.summary) out.push(`  - ${a.summary}`)
    }
    return section('artifacts', 'Exact Artifact References', out.join('\n'))
  }

  // -- Meta ---------------------------------------------------------------

  buildMeta(title: string, summary: string): PRGeneratorMeta {
    const g = this.input.claimEvidenceGraph
    const top = this.topHypothesis()
    const r = this.input.riskAssessment
    return {
      acceptedCount: (this.input.contract?.criteria ?? []).filter((c) => c.status === 'verified').length,
      totalCriteria: this.input.contract?.criteria.length ?? 0,
      topHypothesisConfidence: top?.confidence ?? 0,
      riskLevel: r.level,
      riskFlags: {
        requiresMoreEvidence: r.requiresMoreEvidence,
        requiresMoreVerification: r.requiresMoreVerification,
        requiresConservativeEdits: r.requiresConservativeEdits,
        requiresMoreCheckpoints: r.requiresMoreCheckpoints,
        requiresExplicitHumanApproval: r.requiresExplicitHumanApproval,
        requiresClearerWarnings: r.requiresClearerWarnings,
        requiresStrongerReviewGuidance: r.requiresStrongerReviewGuidance,
      },
      hasHumanReviewItems:
        g.needsHumanReview.length > 0 ||
        this.input.belief.humanReviewRequirements.some((h) => h.status === 'open') ||
        this.input.verification.some((v) => v.status === 'needs_human_review') ||
        this.input.evidence.some((e) => e.status === 'needs_review') ||
        r.requiresExplicitHumanApproval,
      hasStaleClaims: g.staleClaims.length > 0,
      hasContradictedClaims: g.contradictedClaims.length > 0,
      hasNeedsHumanReviewClaims: g.needsHumanReview.length > 0,
      artifactCount: this.input.artifactRefs.length,
    }
  }

  // -- Helpers ------------------------------------------------------------

  private topHypothesis() {
    const hyps = this.input.belief.hypotheses
    if (hyps.length === 0) return undefined
    return hyps.slice().sort((a, b) => b.confidence - a.confidence)[0]
  }

  private riskFlagSummary(): string {
    const flags = this.activeRiskFlags()
    return flags.length > 0 ? flags.join(', ') : 'no special handling'
  }

  private activeRiskFlags(): string[] {
    const r = this.input.riskAssessment
    const flags: string[] = []
    if (r.requiresMoreEvidence) flags.push('more evidence')
    if (r.requiresMoreVerification) flags.push('more verification')
    if (r.requiresConservativeEdits) flags.push('conservative edits')
    if (r.requiresMoreCheckpoints) flags.push('more checkpoints')
    if (r.requiresExplicitHumanApproval) flags.push('explicit human approval')
    if (r.requiresClearerWarnings) flags.push('clearer warnings')
    if (r.requiresStrongerReviewGuidance) flags.push('stronger review guidance')
    return flags
  }

  private domainFor(path: string): string | undefined {
    for (const m of this.domainManifests) {
      if (m.owns.some((p) => patternToRegex(p).test(path))) return m.domain
    }
    return undefined
  }

  private formatAction(a: VerificationAction): string {
    const icon = actionIcon(a.status)
    const target = a.targetAcceptanceCriteria.length > 0 ? a.targetAcceptanceCriteria.join(', ') : a.targetClaims.join(', ') || '—'
    return `- ${icon} \`${a.actionType}\` _(${a.id})_ → ${target} — ${a.selectionReason}`
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function section(id: string, title: string, markdown: string): PRGeneratorSection {
  return { id, title, markdown }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'verified':
      return '✅'
    case 'failed':
      return '❌'
    case 'needs_review':
      return '🔶'
    case 'blocked':
      return '⛔'
    case 'skipped':
      return '⏭️'
    default:
      return '○'
  }
}

function actionIcon(status: string): string {
  switch (status) {
    case 'passed':
      return '✅'
    case 'failed':
      return '❌'
    case 'needs_human_review':
      return '🔶'
    case 'running':
      return '⏳'
    case 'blocked':
      return '⛔'
    case 'skipped':
      return '⏭️'
    case 'stale':
      return '⚠️'
    default:
      return '○'
  }
}

function severityRank(s: string): number {
  switch (s) {
    case 'critical':
      return 4
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
  return new RegExp(`^${escaped}`)
}
