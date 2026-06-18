/**
 * Prompt builders for local sub-tasks.
 *
 * The summary prompt shape is adapted from opencode's
 * `packages/opencode/src/session/summary.ts` (MIT) — reimplemented in Forge
 * style. See NOTICE for attribution.
 *
 * All prompts instruct the model to return strict JSON so output is parseable
 * with `parse.ts`. Local models are unreliable, so the parser is forgiving and
 * the service always has a deterministic fallback if parsing fails.
 */

import type { ClassifyRequest, ExtractRequest, RerankRequest, SummarizeRequest } from '@forge/types'

const SUMMARIZE_TARGET_TOKENS_DEFAULT = 200

export function summarizeSystem(): string {
  return [
    'You compress developer tool output for an autonomous coding agent.',
    'Preserve only decision-relevant signal: errors, failing tests with file:line,',
    'changed symbols, exit status, and actionable next steps.',
    'Drop progress bars, timestamps, and repeated boilerplate.',
    'You are NOT the source of truth: the exact original is always retained',
    'separately, so never invent details. Return strict JSON only.',
  ].join(' ')
}

export function summarizeUser(req: SummarizeRequest): string {
  const target = req.targetTokens ?? SUMMARIZE_TARGET_TOKENS_DEFAULT
  return JSON.stringify({
    instruction: `Summarize the content in <= ${target} tokens. Output JSON {"summary": string}.`,
    label: req.label ?? 'tool output',
    content: req.content,
  })
}

export function classifySystem(): string {
  return [
    'You are a triage classifier for an autonomous coding agent.',
    'Pick exactly one label from the provided set. If none fit, use "unknown".',
    'Your output is a non-authoritative signal, not a verdict. Return strict JSON only.',
  ].join(' ')
}

export function classifyUser(req: ClassifyRequest): string {
  return JSON.stringify({
    instruction:
      'Classify the content. Output JSON {"label": string, "confidence": number 0..1, "rationale": string}.',
    subject: req.subject ?? 'item',
    labels: req.labels,
    content: req.content,
  })
}

export function extractSystem(): string {
  return [
    'You extract structured fields from developer tool output for an agent.',
    'Only extract values literally present; if a field is absent, omit it.',
    'Never fabricate. Return strict JSON only.',
  ].join(' ')
}

export function extractUser(req: ExtractRequest): string {
  return JSON.stringify({
    instruction:
      'Extract the requested fields. Output JSON {"fields": {key: value, ...}} using only the requested keys.',
    subject: req.subject ?? 'output',
    fields: req.fields,
    content: req.content,
  })
}

export function rerankSystem(): string {
  return [
    'You rank candidate snippets by relevance to a query for a retrieval system.',
    'Return strict JSON only. Your ranking is advisory and re-orders within an',
    'already-filtered set; it cannot add or remove candidates.',
  ].join(' ')
}

export function rerankUser(req: RerankRequest): string {
  return JSON.stringify({
    instruction:
      'Rank candidates by relevance to the query, best first. Output JSON {"order": number[]} of 0-based indices.',
    query: req.query,
    candidates: req.candidates.map((c, i) => ({ index: i, text: c })),
  })
}
