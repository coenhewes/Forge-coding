/**
 * TracePanel — last N trace events as a vertical timeline.
 *
 * Renders `TraceEvent[]` from `@forge/types`. Read-only.
 */

import type { TraceEvent } from '@forge/types'

export type TracePanelFixture = { events: TraceEvent[] } | TraceEvent[]

export class TracePanel {
  private events: TraceEvent[]
  private lastKey = ''

  constructor(fixture: TracePanelFixture, private readonly limit = 20) {
    this.events = normalise(fixture)
  }

  setFixture(fixture: TracePanelFixture): void {
    this.events = normalise(fixture)
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const sorted = [...this.events].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, this.limit)

    const lines: string[] = []
    lines.push(`Trace — last ${sorted.length}/${this.events.length}`)
    lines.push('')

    if (sorted.length === 0) {
      lines.push('  (no trace events)')
    }

    let prevTs = ''
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i]!
      const when = shortTime(ev.timestamp)
      const dur = ev.durationMs != null ? ` (${ev.durationMs}ms)` : ''
      const sep = i === 0 ? '┌' : i === sorted.length - 1 ? '└' : '│'
      const head = `  ${sep} ${when}${dur}  ${ev.type}`
      lines.push(head)
      const desc = truncate(ev.description, w - 7)
      if (desc) lines.push(`  │  ${desc}`)
      // Marker for repeated timestamps (helps spot bursts).
      if (i > 0 && when === prevTs) lines.push(`  │  (same time as prev)`)
      prevTs = when
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

function normalise(f: TracePanelFixture): TraceEvent[] {
  return Array.isArray(f) ? f : f.events ?? []
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