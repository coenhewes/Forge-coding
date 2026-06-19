/**
 * Tool-output bounding.
 *
 * Every tool result that the agent sees goes through `compactToolResult`.
 * Oversized bodies are compressed with deterministic, content-aware rules and
 * the exact original bytes are persisted to
 * `<stateDir>/.forge/artifacts/<taskId>/<sha256>.bin`.
 *
 * This is Forge's Headroom-inspired CCR shape: compress what the model sees,
 * cache the original locally, and let the model retrieve by stable ref when it
 * needs exact evidence.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_TOOL_RESULT_BUDGET = 4000

export type ToolCompressionStrategy =
  | 'passthrough'
  | 'head_tail'
  | 'json_array'
  | 'search_results'
  | 'log'
  | 'diff_or_code'

export interface ToolCompressionSavings {
  originalBytes: number
  emittedBytes: number
  estimatedOriginalTokens: number
  estimatedEmittedTokens: number
  estimatedTokensSaved: number
}

export interface CompactedToolResult {
  /** Body the model actually sees. */
  content: string
  /** Stable reference the model can use to fetch the full bytes. */
  artifactRef?: string
  /** Total bytes in the original output. */
  totalBytes: number
  /** Bytes that were preserved/emitted to the model. */
  preservedBytes: number
  /** True iff the result was compacted/truncated. */
  truncated: boolean
  /** Where the full bytes live on disk. */
  artifactPath?: string
  /** Deterministic strategy used before the model sees the result. */
  strategy: ToolCompressionStrategy
  /** Approximate token/byte savings for observability. */
  savings: ToolCompressionSavings
}

export interface CompactOptions {
  /** Per-result char budget. Defaults to 4000. */
  budget?: number
  /** Task id used to namespace artifact storage. */
  taskId: string
  /** Root of the artifacts directory (defaults to <stateDir>/.forge/artifacts). */
  artifactsDir: string
  /** Tool name — included in metadata/markers for traceability. */
  toolName?: string
}

export async function compactToolResult(
  content: string,
  options: CompactOptions,
): Promise<CompactedToolResult> {
  const budget = options.budget ?? DEFAULT_TOOL_RESULT_BUDGET
  const totalBytes = Buffer.byteLength(content, 'utf-8')

  if (content.length <= budget) {
    return {
      content,
      totalBytes,
      preservedBytes: totalBytes,
      truncated: false,
      strategy: 'passthrough',
      savings: savingsFor(content, content),
    }
  }

  const hash = createHash('sha256').update(content, 'utf-8').digest('hex')
  const artifactDir = join(options.artifactsDir, options.taskId)
  await mkdir(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, `${hash}.bin`)
  await writeFile(artifactPath, content, 'utf-8')

  const compressed = compressByContentType(content, budget)
  const display = withRetrievalMarker({
    body: compressed.content,
    hash,
    toolName: options.toolName,
    totalBytes,
    originalLength: content.length,
    strategy: compressed.strategy,
    omittedSummary: compressed.omittedSummary,
  })
  const savings = savingsFor(content, display)

  return {
    content: display,
    artifactRef: hash,
    totalBytes,
    preservedBytes: Buffer.byteLength(display, 'utf-8'),
    truncated: true,
    artifactPath,
    strategy: compressed.strategy,
    savings,
  }
}

interface TypedCompression {
  content: string
  strategy: ToolCompressionStrategy
  omittedSummary: string
}

function compressByContentType(content: string, budget: number): TypedCompression {
  const json = compressJsonArray(content, budget)
  if (json) return json
  if (looksLikeSearchResults(content)) return compressSearchResults(content, budget)
  if (looksLikeDiffOrCode(content)) return compressDiffOrCode(content, budget)
  if (looksLikeLog(content)) return compressLog(content, budget)
  return compressHeadTail(content, budget, 'head_tail', 'middle content omitted')
}

function compressJsonArray(content: string, budget: number): TypedCompression | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < 6 || !parsed.every(isRecord)) return null

  const items = parsed as Array<Record<string, unknown>>
  const keep = new Map<number, Record<string, unknown>>()
  const add = (idx: number) => {
    if (idx >= 0 && idx < items.length) keep.set(idx, items[idx]!)
  }

  for (let i = 0; i < Math.min(3, items.length); i++) add(i)
  for (let i = Math.max(0, items.length - 2); i < items.length; i++) add(i)
  for (let i = 0; i < items.length; i++) {
    if (hasNotableValue(items[i]!)) add(i)
  }

  const maxItems = Math.max(8, Math.min(24, Math.floor(budget / 300)))
  const step = Math.max(1, Math.floor(items.length / Math.max(1, maxItems - keep.size)))
  for (let i = 0; keep.size < maxItems && i < items.length; i += step) add(i)

  const keptIndices = [...keep.keys()].sort((a, b) => a - b)
  const kept = keptIndices.map((idx) => ({ _index: idx, ...items[idx] }))
  const dropped = items.length - kept.length
  const body = JSON.stringify(
    {
      _forge_compressed: {
        strategy: 'json_array',
        originalItems: items.length,
        keptItems: kept.length,
        droppedItems: dropped,
        commonKeys: commonKeys(items),
        droppedSummary: summarizeCategories(items.filter((_, idx) => !keep.has(idx))),
      },
      items: kept,
    },
    null,
    2,
  )

  if (body.length >= content.length) return null
  return {
    content: boundText(body, budget),
    strategy: 'json_array',
    omittedSummary: `${dropped} JSON row(s) omitted; preserved schema, boundary rows, notable rows, and representative samples`,
  }
}

function compressSearchResults(content: string, budget: number): TypedCompression {
  const lines = content.split('\n').filter(Boolean)
  const byFile = new Map<string, string[]>()
  for (const line of lines) {
    const parsed = parseSearchLine(line)
    if (!parsed) continue
    const existing = byFile.get(parsed.file) ?? []
    existing.push(`${parsed.line}:${parsed.body}`)
    byFile.set(parsed.file, existing)
  }
  if (byFile.size === 0) return compressHeadTail(content, budget, 'search_results', 'search output omitted')

  const out: string[] = [`[forge compressed search results: ${lines.length} matches across ${byFile.size} files]`]
  const maxFiles = 18
  let fileCount = 0
  let kept = 0
  for (const [file, matches] of byFile) {
    if (fileCount++ >= maxFiles) break
    out.push('', file)
    const selected = selectImportantLines(matches, 5)
    kept += selected.length
    for (const match of selected) out.push(`  ${match}`)
    if (matches.length > selected.length) out.push(`  ... ${matches.length - selected.length} match(es) omitted in this file`)
  }
  if (byFile.size > maxFiles) out.push('', `... ${byFile.size - maxFiles} file(s) omitted`)

  return {
    content: boundText(out.join('\n'), budget),
    strategy: 'search_results',
    omittedSummary: `${Math.max(0, lines.length - kept)} search match(es) omitted; grouped by file with boundary/error-looking matches preserved`,
  }
}

function compressLog(content: string, budget: number): TypedCompression {
  const lines = content.split('\n')
  const keep = new Set<number>()
  const addRange = (idx: number, radius: number) => {
    for (let i = Math.max(0, idx - radius); i <= Math.min(lines.length - 1, idx + radius); i++) keep.add(i)
  }

  for (let i = 0; i < Math.min(20, lines.length); i++) keep.add(i)
  for (let i = Math.max(0, lines.length - 20); i < lines.length; i++) keep.add(i)
  for (let i = 0; i < lines.length; i++) {
    if (isImportantLogLine(lines[i] ?? '')) addRange(i, 3)
  }

  const maxLines = Math.max(80, Math.floor(budget / 80))
  const selected = [...keep].sort((a, b) => a - b).slice(0, maxLines)
  const out: string[] = [`[forge compressed log: ${lines.length} lines -> ${selected.length} selected lines]`]
  let previous = -1
  for (const idx of selected) {
    if (previous >= 0 && idx > previous + 1) out.push(`... ${idx - previous - 1} line(s) omitted ...`)
    out.push(`${idx + 1}: ${lines[idx]}`)
    previous = idx
  }

  return {
    content: boundText(out.join('\n'), budget),
    strategy: 'log',
    omittedSummary: `${Math.max(0, lines.length - selected.length)} log line(s) omitted; preserved failures, warnings, stack traces, summaries, head, and tail`,
  }
}

function compressDiffOrCode(content: string, budget: number): TypedCompression {
  return compressHeadTail(
    content,
    budget,
    'diff_or_code',
    'diff/code conservatively head-tail compacted; retrieve exact artifact before editing from omitted sections',
  )
}

function compressHeadTail(
  content: string,
  budget: number,
  strategy: ToolCompressionStrategy,
  omittedSummary: string,
): TypedCompression {
  const headChars = Math.max(500, Math.floor(budget * 0.72))
  const tailChars = Math.min(1200, Math.max(300, Math.floor(budget * 0.22)))
  const omittedChars = Math.max(0, content.length - headChars - tailChars)
  return {
    content: [
      content.slice(0, headChars),
      '',
      `...[${omittedChars} chars omitted]...`,
      '--- tail ---',
      content.slice(-tailChars),
    ].join('\n'),
    strategy,
    omittedSummary,
  }
}

function withRetrievalMarker(input: {
  body: string
  hash: string
  toolName?: string
  totalBytes: number
  originalLength: number
  strategy: ToolCompressionStrategy
  omittedSummary: string
}): string {
  const omittedChars = Math.max(0, input.originalLength - input.body.length)
  return [
    input.body,
    '',
    `[forge compression: tool=${input.toolName ?? 'unknown'}; strategy=${input.strategy}; original=${input.totalBytes} bytes; omitted=${omittedChars} chars; ref=${input.hash}; retrieve with retrieve_artifact artifact_ref="${input.hash}" query="<optional search>"]`,
    `[omitted summary: ${input.omittedSummary}]`,
  ].join('\n')
}

function savingsFor(original: string, emitted: string): ToolCompressionSavings {
  const originalBytes = Buffer.byteLength(original, 'utf-8')
  const emittedBytes = Buffer.byteLength(emitted, 'utf-8')
  const estimatedOriginalTokens = estimateTokens(original)
  const estimatedEmittedTokens = estimateTokens(emitted)
  return {
    originalBytes,
    emittedBytes,
    estimatedOriginalTokens,
    estimatedEmittedTokens,
    estimatedTokensSaved: Math.max(0, estimatedOriginalTokens - estimatedEmittedTokens),
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeSearchResults(content: string): boolean {
  const lines = content.split('\n').slice(0, 30)
  return lines.filter((line) => parseSearchLine(line)).length >= 3
}

function parseSearchLine(line: string): { file: string; line: number; body: string } | null {
  const match = /^(.*?):(\d+):(.+)$/.exec(line)
  if (!match) return null
  return { file: match[1]!, line: Number(match[2]), body: match[3]! }
}

function looksLikeLog(content: string): boolean {
  return /error|failed|failure|exception|traceback|warning|pytest|vitest|jest|npm err|panic|stack/i.test(content.slice(0, 8000))
}

function looksLikeDiffOrCode(content: string): boolean {
  return /^diff --git /m.test(content)
    || /^@@ /m.test(content)
    || /\b(function|class|interface|const|let|var|import|export|def|fn|impl)\b/.test(content.slice(0, 4000))
}

function hasNotableValue(item: Record<string, unknown>): boolean {
  return Object.values(item).some((value) => /error|fail|critical|warning|exception|timeout|denied|invalid/i.test(String(value)))
}

function commonKeys(items: Array<Record<string, unknown>>): string[] {
  const counts = new Map<string, number>()
  for (const item of items.slice(0, 100)) {
    for (const key of Object.keys(item)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key]) => key)
}

function summarizeCategories(items: Array<Record<string, unknown>>): string[] {
  const fields = ['type', 'status', 'kind', 'category', 'level', 'severity', 'state', 'result', 'outcome']
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const field of fields) {
      const value = item[field]
      if (typeof value === 'string' && value.length > 0 && value.length < 60) {
        const label = `${field}=${value}`
        counts.set(label, (counts.get(label) ?? 0) + 1)
        break
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, count]) => `${count} ${label}`)
}

function selectImportantLines(lines: string[], max: number): string[] {
  const selected = new Map<number, string>()
  const add = (idx: number) => {
    if (idx >= 0 && idx < lines.length) selected.set(idx, lines[idx]!)
  }
  add(0)
  add(lines.length - 1)
  for (let i = 0; i < lines.length; i++) {
    if (/error|fail|critical|warning|exception|timeout|denied|invalid/i.test(lines[i]!)) add(i)
    if (selected.size >= max) break
  }
  const step = Math.max(1, Math.floor(lines.length / max))
  for (let i = 0; selected.size < max && i < lines.length; i += step) add(i)
  return [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
}

function isImportantLogLine(line: string): boolean {
  return /error|failed|failure|exception|traceback|warning|critical|panic|assert|expected|received|npm err|summary|tests? failed|tests? passed/i.test(line)
}

function boundText(text: string, budget: number): string {
  if (text.length <= budget + 1200) return text
  const head = text.slice(0, Math.floor(budget * 0.75))
  const tail = text.slice(-Math.floor(budget * 0.2))
  return `${head}\n...[compressed output re-bounded]...\n${tail}`
}
