/**
 * Semantic code index — the previously-dormant embedding layer, wired on.
 *
 * At startup we chunk the repo's SOURCE files, embed each chunk with the local
 * embed model (free, unmetered), and persist the vectors in Postgres
 * (EmbeddingRepo). The `search_semantic` tool then embeds the model's natural-
 * language query, finds the nearest chunks by cosine, and returns the exact
 * snippets — so the frontier model can locate relevant code in ONE query
 * instead of brute-force paging files (which dominated long-horizon runs).
 *
 * V1 keeps it simple: fixed line-window chunks, source files only (tests are the
 * spec, not the fix surface), cosine in process. Snippets are re-read from disk
 * at query time, so only vectors + refs live in the DB.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import type { LocalModelService } from '@forge/local-model'
import type { EmbeddingRepo } from '@forge/state-store'

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.go', '.py', '.rs', '.java', '.rb', '.php'])
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', '.forge', '.turbo', 'vendor', '__snapshots__'])
const CHUNK_LINES = 50
const BATCH = 32
const MAX_CHUNKS = 6000 // bound time/memory on very large repos
// Cap the text sent to the embed model. nomic-embed-text rejects inputs over its
// context window with HTTP 400 (observed on a 6289-char chunk of long lines).
// We only truncate the EMBEDDED text — the snippet returned to the model is
// re-read from disk by line range, so retrieval quality is barely affected.
const MAX_EMBED_CHARS = 2000
const TARGET_TYPE = 'text' as const

export interface Chunk { ref: string; file: string; start: number; end: number; text: string }

function isTestFile(path: string): boolean {
  return /(\.test\.|\.spec\.|__tests__|\/tests?\/|\/specs?\/)/.test(path)
}

/** Recursively collect non-test source files under workDir. */
export function collectSourceFiles(workDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full); continue }
      if (!SOURCE_EXT.has(extname(name))) continue
      if (name.endsWith('.d.ts')) continue
      const rel = relative(workDir, full)
      if (isTestFile(rel)) continue
      out.push(rel)
    }
  }
  walk(workDir)
  return out
}

/** Split a file into fixed line-window chunks. ref = `relPath#start-end` (1-indexed). */
export function chunkFile(workDir: string, relPath: string): Chunk[] {
  let content: string
  try { content = readFileSync(join(workDir, relPath), 'utf-8') } catch { return [] }
  const lines = content.split('\n')
  if (lines.length === 0 || content.trim().length === 0) return []
  const chunks: Chunk[] = []
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const start = i + 1
    const end = Math.min(i + CHUNK_LINES, lines.length)
    const text = lines.slice(i, end).join('\n')
    if (text.trim().length === 0) continue
    chunks.push({ ref: `${relPath}#${start}-${end}`, file: relPath, start, end, text })
  }
  return chunks
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

export interface IndexDeps {
  workDir: string
  repoId: string
  localModel: LocalModelService
  embeddingRepo: EmbeddingRepo
  model: string
  taskId: string
}

/**
 * Build the semantic index for the repo. Returns the chunk count, or
 * { fallback: true } if the local embed model is unavailable (a run without real
 * embeddings should fall back to lexical tools, not store garbage vectors).
 */
export async function indexRepo(deps: IndexDeps): Promise<{ indexed: number; files: number; fallback: boolean }> {
  const { workDir, repoId, localModel, embeddingRepo, model } = deps
  const files = collectSourceFiles(workDir)
  const chunks: Chunk[] = []
  for (const f of files) {
    for (const c of chunkFile(workDir, f)) {
      chunks.push(c)
      if (chunks.length >= MAX_CHUNKS) break
    }
    if (chunks.length >= MAX_CHUNKS) break
  }
  if (chunks.length === 0) return { indexed: 0, files: files.length, fallback: false }

  const embedText = (c: Chunk) => c.text.slice(0, MAX_EMBED_CHARS)
  const store = async (c: Chunk, vector: number[]) => {
    await embeddingRepo.upsert({
      // id must be a UUID (column type); uniqueness for re-index is handled by
      // the upsert conflict key (repo_id, target_type, target_ref, model).
      id: randomUUID(),
      repoId,
      targetType: TARGET_TYPE,
      targetRef: c.ref,
      model,
      dim: vector.length,
      vector,
      contentHash: hash(c.text),
    })
  }

  let indexed = 0
  let firstBatch = true
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH)
    // No taskId: indexing embeds are infrastructure, not task evidence — avoids
    // recording 100s of provenance entries (noise) per run.
    const res = await localModel.embed({ texts: batch.map(embedText) })
    if (!res.provenance.fallbackUsed && res.vectors.length === batch.length) {
      for (let j = 0; j < batch.length; j++) await store(batch[j]!, res.vectors[j]!)
      indexed += batch.length
      firstBatch = false
      continue
    }
    // Batch failed. If a tiny known-good probe also fails on the FIRST batch, the
    // embed model is genuinely unavailable → abort so the caller uses lexical tools.
    if (firstBatch) {
      const probe = await localModel.embed({ texts: ['ok'] })
      if (probe.provenance.fallbackUsed || probe.vectors.length !== 1) {
        return { indexed: 0, files: files.length, fallback: true }
      }
      firstBatch = false
    }
    // Model is up but some chunk in this batch is bad (e.g., too long even after
    // truncation) — embed chunk-by-chunk and skip only the offenders, so one bad
    // chunk never kills the whole index.
    for (const c of batch) {
      const one = await localModel.embed({ texts: [embedText(c)] })
      if (!one.provenance.fallbackUsed && one.vectors.length === 1) {
        await store(c, one.vectors[0]!)
        indexed++
      }
    }
  }
  return { indexed, files: files.length, fallback: indexed === 0 }
}

export interface SearchResult { file: string; start: number; end: number; score: number; snippet: string }

/** Embed the query, find nearest chunks, re-read the snippets from disk. */
export async function searchSemantic(
  query: string,
  deps: IndexDeps,
  topK = 8,
): Promise<SearchResult[]> {
  const { workDir, repoId, localModel, embeddingRepo, model, taskId } = deps
  const emb = await localModel.embed({ taskId, texts: [query] })
  if (emb.provenance.fallbackUsed || emb.vectors.length === 0) return []
  const hits = await embeddingRepo.nearest(repoId, emb.vectors[0]!, { targetType: TARGET_TYPE, model, topK })
  const results: SearchResult[] = []
  for (const h of hits) {
    const m = h.targetRef.match(/^(.*)#(\d+)-(\d+)$/)
    if (!m) continue
    const file = m[1]!
    const start = Number(m[2])
    const end = Number(m[3])
    let snippet = ''
    const full = join(workDir, file)
    if (existsSync(full)) {
      try {
        const lines = readFileSync(full, 'utf-8').split('\n')
        snippet = lines.slice(start - 1, end).join('\n')
      } catch { /* file may have been edited/removed */ }
    }
    results.push({ file, start, end, score: +h.score.toFixed(3), snippet })
  }
  return results
}
