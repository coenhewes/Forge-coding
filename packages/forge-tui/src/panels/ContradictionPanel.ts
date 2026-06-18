/**
 * ContradictionPanel — open contradictions + stale claims, two sections.
 *
 * `ContradictionPanelFixture.contradictions` are surfaced claim-vs-evidence
 * conflicts sorted by `raisedAt` desc (newest first).
 * `ContradictionPanelFixture.staleClaims` are claims whose supporting evidence
 * has gone stale, sorted by reason severity (security/permissions > behaviour
 * drift > data freshness).
 *
 * Read-only. `handleKey` records the last key for tests; tab toggles focus
 * between sections, 'j'/'k' move within a section, 'r' is a no-op for
 * "mark resolved".
 */

export interface Contradiction {
  id: string
  claimId: string
  evidenceId: string
  note: string
  raisedAt: string
}

export interface StaleClaim {
  claimId: string
  taskId: string
  lastEvidenceAt: string
  reason: string
}

export interface ContradictionPanelFixture {
  contradictions?: Contradiction[]
  staleClaims?: StaleClaim[]
}

type StaleSeverity = 'security' | 'behaviour' | 'freshness' | 'unknown'

export class ContradictionPanel {
  private fixture: ContradictionPanelFixture
  private lastKey = ''
  private cursor = 0
  private focus: 'contradictions' | 'stale' = 'contradictions'

  constructor(fixture?: ContradictionPanelFixture) {
    this.fixture = fixture ?? {}
  }

  setFixture(fixture: ContradictionPanelFixture): void {
    this.fixture = fixture
    if (this.focus === 'contradictions' && this.cursor >= (this.fixture.contradictions?.length ?? 0)) {
      this.cursor = 0
    }
    if (this.focus === 'stale' && this.cursor >= (this.fixture.staleClaims?.length ?? 0)) {
      this.cursor = 0
    }
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const contradictions = this.fixture.contradictions ?? []
    const staleClaims = this.fixture.staleClaims ?? []

    const sorted = [...contradictions].sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1))
    const stale = [...staleClaims].sort(
      (a, b) => severityRank(b.reason) - severityRank(a.reason) || (a.lastEvidenceAt < b.lastEvidenceAt ? -1 : 1),
    )

    const lines: string[] = []
    lines.push(`Contradictions — ${sorted.length} open, ${stale.length} stale claims`)
    lines.push('')

    lines.push('Open contradictions:')
    if (sorted.length === 0) {
      lines.push('  (none)')
    }
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!
      const marker = this.focus === 'contradictions' && i === this.cursor ? '▶' : ' '
      const head = `  ${marker}[!] ${truncate(c.id, 10)} ${truncate(c.claimId, w - 30)} ↔ ${truncate(c.evidenceId, w - 34)}`
      lines.push(head)
      lines.push(`     ${truncate(c.note, w - 7)}`)
      lines.push(`     raised: ${truncate(shortTime(c.raisedAt), w - 12)}`)
    }

    lines.push('')
    lines.push('Stale claims:')
    if (stale.length === 0) {
      lines.push('  (none)')
    }
    for (let i = 0; i < stale.length; i++) {
      const s = stale[i]!
      const marker = this.focus === 'stale' && i === this.cursor ? '▶' : ' '
      const sev = severityLabel(s.reason)
      const head = `  ${marker}[${sev}] ${truncate(s.claimId, w - 22)}`
      lines.push(head)
      lines.push(`     reason: ${truncate(s.reason, w - 13)}`)
      lines.push(`     last evidence: ${truncate(shortTime(s.lastEvidenceAt), w - 20)}  task: ${truncate(s.taskId, w - 36)}`)
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key

    if (key === 'tab' || key === '\t') {
      this.focus = this.focus === 'contradictions' ? 'stale' : 'contradictions'
      this.cursor = 0
      return
    }

    const section = this.focus === 'contradictions'
      ? (this.fixture.contradictions ?? [])
      : (this.fixture.staleClaims ?? [])
    if (section.length === 0) return

    if (key === 'j') {
      this.cursor = (this.cursor + 1) % section.length
    } else if (key === 'k') {
      this.cursor = (this.cursor - 1 + section.length) % section.length
    }
    // 'r' = mark resolved (no-op stub: panels are read-only)
  }

  getLastKey(): string {
    return this.lastKey
  }

  getFocus(): 'contradictions' | 'stale' {
    return this.focus
  }

  getCursor(): number {
    return this.cursor
  }
}

function severityRank(reason: string): number {
  switch (classifySeverity(reason)) {
    case 'security':
      return 4
    case 'behaviour':
      return 3
    case 'freshness':
      return 2
    default:
      return 1
  }
}

function classifySeverity(reason: string): StaleSeverity {
  const r = reason.toLowerCase()
  if (/(auth|permission|security|role|sso)/.test(r)) return 'security'
  if (/(behav|drift|logic|contract|api)/.test(r)) return 'behaviour'
  if (/(data|fresh|stale|outdated|old|expired)/.test(r)) return 'freshness'
  return 'unknown'
}

function severityLabel(reason: string): string {
  switch (classifySeverity(reason)) {
    case 'security':
      return '!'
    case 'behaviour':
      return '~'
    case 'freshness':
      return '·'
    default:
      return '?'
  }
}

function shortTime(ts: string): string {
  if (!ts) return '--:--:--'
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
