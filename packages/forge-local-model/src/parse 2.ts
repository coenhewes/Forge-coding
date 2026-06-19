/**
 * Tolerant parsers for local-model output, plus the deterministic fallbacks
 * the service uses when the local model is unavailable, times out, or returns
 * unparseable text. Fallbacks must be pure, fast, and dependency-free.
 */

import type { ExtractedField } from '@forge/types'

/** Pull the first JSON object/array out of a possibly-noisy model response. */
export function extractJson(text: string): unknown | null {
  if (!text) return null
  // Strip ```json fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1]! : text
  // Find the first balanced {...} or [...] span.
  const start = candidate.search(/[{[]/)
  if (start === -1) return null
  const open = candidate[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function parseSummary(text: string): string | null {
  const obj = asRecord(extractJson(text))
  const summary = obj?.summary
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null
}

export function parseClassify(
  text: string,
  labels: string[],
): { label: string; confidence: number; rationale?: string } | null {
  const obj = asRecord(extractJson(text))
  if (!obj) return null
  const raw = typeof obj.label === 'string' ? obj.label.trim() : ''
  if (!raw) return null
  // Snap to the closest allowed label (case-insensitive); else 'unknown'.
  const match = labels.find((l) => l.toLowerCase() === raw.toLowerCase())
  const label = match ?? 'unknown'
  const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : 0.5
  const confidence = Math.max(0, Math.min(1, match ? confidenceRaw : 0))
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined
  return { label, confidence, rationale }
}

export function parseExtract(text: string, fields: string[]): ExtractedField[] | null {
  const obj = asRecord(extractJson(text))
  const fieldObj = asRecord(obj?.fields) ?? obj
  if (!fieldObj) return null
  const allowed = new Set(fields)
  const out: ExtractedField[] = []
  for (const [key, value] of Object.entries(fieldObj)) {
    if (!allowed.has(key)) continue
    if (value == null) continue
    out.push({ key, value: typeof value === 'string' ? value : JSON.stringify(value) })
  }
  return out.length > 0 ? out : null
}

export function parseRerank(text: string, n: number): number[] | null {
  const parsed = extractJson(text)
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)?.order)
      ? (asRecord(parsed)!.order as unknown[])
      : null
  if (!arr) return null
  const seen = new Set<number>()
  const order: number[] = []
  for (const v of arr) {
    const i = typeof v === 'number' ? v : Number(v)
    if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) {
      seen.add(i)
      order.push(i)
    }
  }
  // Append any missing indices to keep the permutation complete.
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i)
  return order.length === n ? order : null
}

/* ------------------------- deterministic fallbacks ------------------------- */

/** Deterministic head/tail truncation that keeps both ends and marks the cut. */
export function truncateMiddle(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const half = Math.max(0, Math.floor((maxChars - 40) / 2))
  const head = content.slice(0, half)
  const tail = content.slice(content.length - half)
  const omitted = content.length - head.length - tail.length
  return `${head}\n… [${omitted} chars omitted; exact original retained] …\n${tail}`
}

export function fallbackSummary(content: string, maxChars: number): string {
  return truncateMiddle(content, maxChars)
}

export function fallbackRerankOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Regex-based structured extraction used when the local model is unavailable.
 * Covers the common cases the agent cares about (file:line, error kind) and
 * `key: value` lines; anything not matched is simply omitted (never faked).
 */
export function fallbackExtract(content: string, fields: string[]): ExtractedField[] {
  const out: ExtractedField[] = []
  const want = new Set(fields)
  if (want.has('file') || want.has('line')) {
    const m = content.match(/([\w./-]+\.[a-zA-Z]+):(\d+)/)
    if (m) {
      if (want.has('file')) out.push({ key: 'file', value: m[1]! })
      if (want.has('line')) out.push({ key: 'line', value: m[2]! })
    }
  }
  if (want.has('error_kind') || want.has('error')) {
    const m = content.match(/\b([A-Z]\w*(?:Error|Exception))\b/)
    if (m) out.push({ key: want.has('error_kind') ? 'error_kind' : 'error', value: m[1]! })
  }
  // Generic "key: value" lines for any remaining requested fields.
  for (const field of fields) {
    if (out.some((f) => f.key === field)) continue
    const re = new RegExp(`(?:^|\\n)\\s*${field}\\s*[:=]\\s*(.+)`, 'i')
    const m = content.match(re)
    if (m) out.push({ key: field, value: m[1]!.trim() })
  }
  return out
}
