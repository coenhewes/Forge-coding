/**
 * BeliefPanel — top hypotheses with confidence bars.
 *
 * Consumes `Hypothesis[]` from `@forge/types` belief module. Read-only — never
 * mutates the underlying belief store.
 */

import type { Hypothesis } from '@forge/types'

export type BeliefPanelFixture = Hypothesis[] | { hypotheses: Hypothesis[] }

export class BeliefPanel {
  private hypotheses: Hypothesis[]
  private lastKey = ''

  constructor(fixture: BeliefPanelFixture) {
    this.hypotheses = normalise(fixture)
  }

  setFixture(fixture: BeliefPanelFixture): void {
    this.hypotheses = normalise(fixture)
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const top = [...this.hypotheses]
      .filter((hyp) => hyp.status !== 'disproven' && hyp.status !== 'superseded')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6)

    const lines: string[] = []
    lines.push(`Belief — top ${top.length} hypotheses`)
    lines.push('')

    if (top.length === 0) {
      lines.push('  (no live hypotheses)')
    }

    for (const hyp of top) {
      const pct = Math.round(Math.max(0, Math.min(1, hyp.confidence)) * 100)
      const bar = renderBar(pct, Math.max(8, Math.min(24, w - 24)))
      const status = tagFor(hyp.status)
      const claim = truncate(hyp.claim, w - bar.length - status.length - 12)
      lines.push(`  ${status} ${pct.toString().padStart(3)}% ${bar} ${claim}`)
      const domains = (hyp.relevantDomains ?? []).slice(0, 4).join(', ')
      if (domains) lines.push(`     domains: ${truncate(domains, w - 14)}`)
      const sup = hyp.supportingEvidence?.length ?? 0
      const con = hyp.contradictingEvidence?.length ?? 0
      lines.push(`     ev: +${sup}/-${con}`)
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

function normalise(f: BeliefPanelFixture): Hypothesis[] {
  return Array.isArray(f) ? f : f.hypotheses ?? []
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  return '[' + '#'.repeat(filled) + '-'.repeat(Math.max(0, width - filled)) + ']'
}

function tagFor(status: string): string {
  switch (status) {
    case 'verified':
    case 'likely':
      return '[v]'
    case 'disproven':
    case 'contradicted':
    case 'superseded':
      return '[x]'
    case 'unknown':
    case 'plausible':
      return '[.]'
    default:
      return '[?]'
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