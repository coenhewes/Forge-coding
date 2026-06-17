/**
 * EvidencePanel — last N evidence-ledger entries.
 *
 * Renders the most recent entries from `EvidenceLedger`. Read-only.
 */

import type { EvidenceEntry } from '@forge/types'

export type EvidencePanelFixture = { entries: EvidenceEntry[] } | EvidenceEntry[]

export class EvidencePanel {
  private entries: EvidenceEntry[]
  private lastKey = ''

  constructor(fixture: EvidencePanelFixture, private readonly limit = 10) {
    this.entries = normalise(fixture)
  }

  setFixture(fixture: EvidencePanelFixture): void {
    this.entries = normalise(fixture)
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const sorted = [...this.entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, this.limit)
    const lines: string[] = []
    lines.push(`Evidence — last ${sorted.length}/${this.entries.length}`)
    lines.push('')

    if (sorted.length === 0) {
      lines.push('  (no evidence recorded)')
    }

    for (const e of sorted) {
      const tag = tagFor(e.status)
      const kind = (e.kind ?? '').replace(/_/g, ' ')
      const when = shortTime(e.timestamp)
      const head = `  ${tag} ${when}  ${truncate(e.claim, w - 16)}`
      lines.push(head)
      const ev = (e.evidence ?? []).slice(0, 2).join('; ')
      if (ev) lines.push(`     ✓ ${truncate(ev, w - 7)}`)
      if ((e.unverified ?? []).length > 0) {
        lines.push(`     ? ${e.unverified.length} unverified`)
      }
      if (kind) lines.push(`     kind: ${truncate(kind, w - 11)}`)
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

function normalise(f: EvidencePanelFixture): EvidenceEntry[] {
  return Array.isArray(f) ? f : f.entries ?? []
}

function tagFor(status: string): string {
  switch (status) {
    case 'verified':
      return '[V]'
    case 'unverified':
      return '[.]'
    case 'needs_review':
      return '[?]'
    default:
      return '[ ]'
  }
}

function shortTime(ts: string): string {
  if (!ts) return '--:--:--'
  // Accept ISO; strip date if present.
  const tIdx = ts.indexOf('T')
  if (tIdx >= 0) return ts.slice(tIdx + 1, tIdx + 9) || ts.slice(-8)
  return ts.slice(-8)
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