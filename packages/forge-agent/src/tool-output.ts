/**
 * Tool-output bounding.
 *
 * Every tool result that the agent sees goes through `compactToolResult`.
 * Truncated bodies go into the model's tool message; full bytes persist
 * to `<stateDir>/.forge/artifacts/<taskId>/<sha256>.bin` and the helper
 * returns an `artifactRef` the model can quote to retrieve them.
 *
 * The default budget is 4000 chars — enough for a few screens of test
 * output but small enough to keep the working context bounded. Callers
 * can override per-tool.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_TOOL_RESULT_BUDGET = 4000

export interface CompactedToolResult {
  /** Body the model actually sees (truncated). */
  content: string
  /** Stable reference the model can use to fetch the full bytes. */
  artifactRef?: string
  /** Total bytes in the original output. */
  totalBytes: number
  /** Bytes that were preserved verbatim (≤ budget). */
  preservedBytes: number
  /** True iff the result was truncated. */
  truncated: boolean
  /** Where the full bytes live on disk. */
  artifactPath?: string
}

export interface CompactOptions {
  /** Per-result char budget. Defaults to 4000. */
  budget?: number
  /** Task id used to namespace artifact storage. */
  taskId: string
  /** Root of the artifacts directory (defaults to <stateDir>/.forge/artifacts). */
  artifactsDir: string
  /** Tool name — included in the artifact summary for traceability. */
  toolName?: string
}

/**
 * Compact a tool result for the model. Persists the full body to disk
 * and returns the truncated body the model sees plus the artifact
 * reference. If the body is already under the budget, it is returned
 * verbatim with no artifact written.
 */
export async function compactToolResult(
  content: string,
  options: CompactOptions,
): Promise<CompactedToolResult> {
  const budget = options.budget ?? DEFAULT_TOOL_RESULT_BUDGET
  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const preserved = content.slice(0, budget)
  const truncated = content.length > budget

  if (!truncated) {
    return {
      content,
      totalBytes,
      preservedBytes: totalBytes,
      truncated: false,
    }
  }

  const hash = createHash('sha256').update(content, 'utf-8').digest('hex')
  const artifactDir = join(options.artifactsDir, options.taskId)
  await mkdir(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, `${hash}.bin`)
  await writeFile(artifactPath, content, 'utf-8')

  const head = preserved
  const tailChars = Math.min(800, Math.floor(budget / 4))
  const tail = content.slice(-tailChars)
  const omittedChars = content.length - preserved.length - tailChars

  const display = [
    head,
    '',
    `…[truncated ${omittedChars} chars; full output (${totalBytes} bytes) persisted to artifact ${hash} — retrieve via .forge/artifacts/${options.taskId}/${hash}.bin]`,
    '--- tail ---',
    tail,
  ].join('\n')

  return {
    content: display,
    artifactRef: hash,
    totalBytes,
    preservedBytes: Buffer.byteLength(display, 'utf-8'),
    truncated: true,
    artifactPath,
  }
}
