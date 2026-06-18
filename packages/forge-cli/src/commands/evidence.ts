/**
 * `forge evidence <taskId> [--claim <id>]` — list the evidence ledger.
 *
 *   - Without `--claim`: returns the full evidence ledger for the
 *     task, with a summary (verified / unverified / needsReview) and
 *     all entries.
 *   - With `--claim <entryId>`: returns just that one entry (or
 *     404-equivalent when not found).
 *
 * Output:
 *   --json   → { ok, exitCode, data: { taskId, summary, entries?: EvidenceEntry[], entry?: EvidenceEntry } }
 *   --text   → human-readable per-entry list
 *
 * Exit codes:
 *   0  ok
 *   1  missing taskId or unknown claim id
 */
import { loadConfig, initConfig } from '../config.js'
import { EvidenceLedgerEngine } from '@forge/state'
import type { EvidenceEntry } from '@forge/types'
import type { CommandResult, ParsedArgs } from './output.js'
import { getOption } from './output.js'

export interface EvidenceData {
  taskId: string
  summary: { total: number; verified: number; unverified: number; needsReview: number }
  entries?: EvidenceEntry[]
  entry?: EvidenceEntry
}

export async function runEvidence(parsed: ParsedArgs): Promise<CommandResult<EvidenceData>> {
  const taskId = parsed.positional[0]
  if (!taskId) {
    return {
      ok: false,
      exitCode: 1,
      message: 'forge evidence requires a taskId. Usage: forge evidence <taskId> [--claim <entryId>]',
      textLines: ['Error: task ID required. Usage: forge evidence <taskId> [--claim <id>]'],
    }
  }

  const claimId = getOption(parsed, 'claim')

  let config = await loadConfig()
  if (!config) config = await initConfig()
  const engine = new EvidenceLedgerEngine({ stateDir: config.stateDir })
  const summary = await engine.getSummary(taskId)

  if (claimId) {
    const entry = await engine.getEntry(taskId, claimId)
    if (!entry) {
      return {
        ok: false,
        exitCode: 1,
        data: { taskId, summary, entries: [] },
        message: `Evidence entry not found: ${claimId}`,
        textLines: [`No evidence entry with id ${claimId} for task ${taskId}`],
      }
    }
    return {
      ok: true,
      exitCode: 0,
      data: { taskId, summary, entry },
      message: `Evidence entry ${claimId} for ${taskId}`,
      textLines: [
        `Evidence ${entry.id} (${entry.status})`,
        `  claim: ${entry.claim}`,
        `  kind: ${entry.kind}`,
        `  source: ${entry.source ?? '(unsourced)'}`,
        `  evidence: ${entry.evidence.length} item(s)`,
        `  unverified: ${entry.unverified.length} item(s)`,
        `  timestamp: ${entry.timestamp}`,
      ],
    }
  }

  const ledger = await engine.getLedger(taskId)
  const entries = ledger?.entries ?? []
  const textLines = [
    `Evidence Ledger for ${taskId}:`,
    `  Total: ${summary.total}`,
    `  Verified: ${summary.verified}`,
    `  Unverified: ${summary.unverified}`,
    `  Needs review: ${summary.needsReview}`,
    '',
    ...(entries.length === 0
      ? ['  (no evidence entries)']
      : entries.map((e) => `  ${e.status === 'verified' ? '✓' : e.status === 'needs_review' ? '?' : '○'} ${e.id} — ${e.claim.slice(0, 80)}`)),
  ]

  return {
    ok: true,
    exitCode: 0,
    data: { taskId, summary, entries },
    message: `${taskId}: ${summary.total} evidence entries (${summary.verified} verified)`,
    textLines,
  }
}
