/**
 * CheckpointPanel — patch candidates tracked during checkpointed patch search.
 *
 * Each `PatchCandidate` is one patch attempt the harness tried. The panel
 * renders one row per candidate with a status badge:
 *   [+] promoted      — the verified patch that landed
 *   [.] active/partial — currently considered
 *   [x] rejected      — failed verification / rolled back
 *   [?] pending       — verification not run yet
 *
 * Promoted candidates are visually highlighted so the reviewer can spot the
 * winning patch at a glance. Read-only — `handleKey` only records the last
 * key for tests; 'j'/'k' move the cursor, 'p' is a no-op stub for "mark
 * promoted".
 *
 * NOTE: t53's stub shipped a wider `testResult`/`verificationStatus` enum than
 * the spec asked for. We accept both the stub's enum strings and the spec's
 * broader ones so callers (and dashboard tests) can use either.
 */

export interface PatchCandidate {
  id: string
  hypothesis: string
  filesChanged: string[]
  reason: string
  testResult: 'pass' | 'fail' | 'skipped' | 'pending' | string
  verificationStatus: 'pending' | 'verified' | 'failed' | 'inconclusive' | 'passed' | 'partial' | 'not_run' | string
  promoted: boolean
}

export interface CheckpointPanelFixture {
  candidates: PatchCandidate[]
}

export class CheckpointPanel {
  private fixture: CheckpointPanelFixture
  private lastKey = ''
  private cursor = 0

  constructor(fixture?: CheckpointPanelFixture) {
    this.fixture = fixture ?? { candidates: [] }
  }

  setFixture(fixture: CheckpointPanelFixture): void {
    this.fixture = fixture
    if (this.cursor >= this.fixture.candidates.length) this.cursor = 0
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const sorted = [...this.fixture.candidates].sort(
      (a, b) => Number(b.promoted) - Number(a.promoted),
    )
    const promoted = sorted.filter((c) => c.promoted).length
    const passed = sorted.filter((c) => c.verificationStatus === 'passed' || c.verificationStatus === 'verified').length

    const lines: string[] = []
    lines.push(`Checkpoints — ${sorted.length} candidates (${promoted} promoted, ${passed} passed)`)
    lines.push('')

    if (sorted.length === 0) {
      lines.push('  (no patch candidates)')
    }

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!
      const badge = badgeFor(c)
      const marker = i === this.cursor ? '▶' : ' '
      const verified = isPassed(c) ? '✓' : isFailed(c) ? '✗' : '·'
      const head = `  ${marker}${badge} ${verified} ${truncate(c.id, w - 14)}`
      lines.push(promotedHead(head, c))
      lines.push(`     ${truncate(c.hypothesis, w - 7)}`)
      lines.push(`     files: ${c.filesChanged.length}  test: ${truncate(c.testResult || '-', w - 24)}`)
      lines.push(`     status: ${c.verificationStatus}${c.promoted ? '  ★ promoted' : ''}`)
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
    const total = this.fixture.candidates.length
    if (total === 0) return

    if (key === 'j') {
      this.cursor = (this.cursor + 1) % total
    } else if (key === 'k') {
      this.cursor = (this.cursor - 1 + total) % total
    }
    // 'p' = mark promoted (no-op stub: panels are read-only)
  }

  getLastKey(): string {
    return this.lastKey
  }

  getCursor(): number {
    return this.cursor
  }
}

function badgeFor(c: PatchCandidate): string {
  if (c.promoted) return '[+]'
  if (isFailed(c)) return '[x]'
  if (isPending(c)) return '[?]'
  return '[.]'
}

function isPassed(c: PatchCandidate): boolean {
  return c.verificationStatus === 'passed' || c.verificationStatus === 'verified'
}

function isFailed(c: PatchCandidate): boolean {
  return c.verificationStatus === 'failed' || c.verificationStatus === 'inconclusive'
}

function isPending(c: PatchCandidate): boolean {
  return (
    c.verificationStatus === 'pending' ||
    c.verificationStatus === 'not_run' ||
    c.testResult === 'pending'
  )
}

/**
 * Highlight promoted candidates with a leading '=' so reviewers can spot the
 * winning patch at a glance. ASCII-only so headless + snapshot tests stay
 * stable.
 */
function promotedHead(head: string, c: PatchCandidate): string {
  if (!c.promoted) return head
  return `= ${head.slice(3)}`
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
