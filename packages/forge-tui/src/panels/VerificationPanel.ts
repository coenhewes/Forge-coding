/**
 * VerificationPanel — verification plan + claim confidence gaps.
 *
 * Renders the recommended + candidate actions from an `ActiveVerificationPlan`
 * plus the claim-level gaps that triggered the plan. Read-only.
 */

import type { ActiveVerificationPlan } from '@forge/types'

export type VerificationPanelFixture = ActiveVerificationPlan

export class VerificationPanel {
  private plan: VerificationPanelFixture
  private lastKey = ''

  constructor(fixture: VerificationPanelFixture) {
    this.plan = fixture
  }

  setFixture(fixture: VerificationPanelFixture): void {
    this.plan = fixture
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const lines: string[] = []
    lines.push(`Verification plan — ${this.plan.candidateActions.length} candidates`)
    lines.push('')

    const rec = this.plan.recommendedAction
    if (rec) {
      const score = scoreFor(this.plan, rec.id)
      const headline = `Recommended: ${rec.actionType}` + (rec.command ? ` (${truncate(rec.command, w - 20)})` : '')
      lines.push(`  > ${truncate(headline, w - 4)}`)
      lines.push(`    expected gain: ${score.toFixed(2)}  status: ${rec.status}`)
      const reason = truncate(rec.selectionReason, w - 4)
      lines.push(`    why: ${reason}`)
    } else {
      lines.push('  (no recommended action — investigate gaps below)')
    }

    lines.push('')
    lines.push('Candidates:')
    const ranked = [...this.plan.candidateActions]
      .sort((a, b) => scoreFor(this.plan, b.id) - scoreFor(this.plan, a.id))
      .slice(0, 4)
    for (const a of ranked) {
      if (rec && a.id === rec.id) continue
      const score = scoreFor(this.plan, a.id)
      const target = a.targetClaims?.[0] ?? a.targetRisks?.[0] ?? '-'
      lines.push(`  · ${a.actionType} [${score.toFixed(1)}] ${truncate(target, w - 24)}`)
    }

    lines.push('')
    lines.push(`Claim gaps (${this.plan.claimGaps.length}):`)
    const gaps = [...this.plan.claimGaps]
      .sort((a, b) => (riskRank(b.riskLevel) - riskRank(a.riskLevel)) || (a.confidence - b.confidence))
      .slice(0, 3)
    for (const g of gaps) {
      const pct = Math.round(g.confidence * 100)
      const missing = g.missingEvidence?.length ?? 0
      lines.push(`  ${pct}% ${g.status} ${truncate(g.text, w - 18)}`)
      if (missing > 0) lines.push(`     missing evidence: ${missing}`)
    }

    if (this.plan.warnings.length > 0) {
      lines.push('')
      lines.push('Warnings:')
      for (const w0 of this.plan.warnings.slice(0, 2)) {
        lines.push(`  ! ${truncate(w0, w - 4)}`)
      }
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
  }

  getLastKey(): string {
    return this.lastKey
  }
}

function scoreFor(plan: VerificationPanelFixture, actionId: string): number {
  const s = plan.scores?.find((x) => x.actionId === actionId)
  return s?.totalScore ?? plan.candidateActions.find((a) => a.id === actionId)?.expectedEvidenceValue ?? 0
}

function riskRank(level: string): number {
  switch (level) {
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

function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function padWidth(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => (line.length < width ? line + ' '.repeat(width - line.length) : line.slice(0, width)))
    .join('\n')
}