/**
 * PrReadinessPanel — pre-flight checklist for the PR.
 *
 * Each `PrChecklistItem` has a `PrCheckStatus`:
 *   'pass'    — green check; PR is ready to ship on this dimension
 *   'fail'    — red x; blocks PR readiness
 *   'pending' — still running; non-blocking but visible
 *   'na'      — not applicable to this task
 *
 * The panel also surfaces:
 *   - count of unresolved review comments (so reviewers see outstanding work)
 *   - list of risk areas (auth, billing, etc.) the PR touches
 *
 * Read-only. `handleKey` records the last key for tests; 'j'/'k' scroll.
 */

export type PrCheckStatus = 'pass' | 'fail' | 'pending' | 'na'

export interface PrChecklistItem {
  item: string
  status: PrCheckStatus
  note?: string
}

export interface PrReadinessPanelFixture {
  checklist: PrChecklistItem[]
  unresolvedReviewComments?: number
  riskAreas?: string[]
}

export class PrReadinessPanel {
  private fixture: PrReadinessPanelFixture
  private lastKey = ''
  private cursor = 0

  constructor(fixture?: PrReadinessPanelFixture) {
    this.fixture = fixture ?? { checklist: [] }
  }

  setFixture(fixture: PrReadinessPanelFixture): void {
    this.fixture = fixture
    if (this.cursor >= this.fixture.checklist.length) this.cursor = 0
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const c = this.fixture.checklist
    const passed = c.filter((x) => x.status === 'pass').length
    const failed = c.filter((x) => x.status === 'fail').length
    const pending = c.filter((x) => x.status === 'pending').length
    const na = c.filter((x) => x.status === 'na').length
    const unresolved = this.fixture.unresolvedReviewComments ?? 0
    const risks = this.fixture.riskAreas ?? []

    const lines: string[] = []
    lines.push(`PR readiness — ${passed}✓ ${failed}✗ ${pending}· ${na}n  | ${unresolved} unresolved comments`)
    lines.push('')

    if (c.length === 0) {
      lines.push('  (no checklist items)')
    }

    for (let i = 0; i < c.length; i++) {
      const it = c[i]!
      const icon = iconFor(it.status)
      const marker = i === this.cursor ? '▶' : ' '
      const head = `  ${marker}${icon} ${truncate(it.item, w - 8)}`
      lines.push(head)
      if (it.note) lines.push(`     ${truncate(it.note, w - 7)}`)
    }

    if (risks.length > 0) {
      lines.push('')
      const tags = risks.map((r) => `#${r}`).join(' ')
      lines.push(`Risk areas: ${truncate(tags, w - 12)}`)
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
    const total = this.fixture.checklist.length
    if (total === 0) return

    if (key === 'j') {
      this.cursor = (this.cursor + 1) % total
    } else if (key === 'k') {
      this.cursor = (this.cursor - 1 + total) % total
    }
  }

  getLastKey(): string {
    return this.lastKey
  }

  getCursor(): number {
    return this.cursor
  }
}

function iconFor(status: PrCheckStatus): string {
  switch (status) {
    case 'pass':
      return '[✓]'
    case 'fail':
      return '[✗]'
    case 'pending':
      return '[·]'
    case 'na':
      return '[—]'
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
