/**
 * LocalModelService — the entry point the harness calls to delegate bounded
 * sub-tasks to local models.
 *
 * Every method obeys the same contract:
 *   1. If the layer is unavailable (`router.available()` false) → return a
 *      deterministic fallback immediately (`fallbackUsed: true`).
 *   2. Otherwise: store the exact input as an artifact (stable ref), bound the
 *      input to a char budget, invoke the model under a hard timeout, parse the
 *      response, store the output as an artifact, record a durable
 *      `LocalModelRun` (source→output ids) and emit a `local_model_invoked`
 *      trace event.
 *   3. On ANY error/timeout/parse-failure → fall back deterministically. The
 *      service never throws into the agent loop.
 *
 * Results are always `authoritative: false`. The service does not touch belief,
 * verification, or task state directly — callers decide how (and whether) to
 * incorporate a non-authoritative signal, keeping Forge's discipline intact.
 */

import type {
  ClassifyRequest,
  ClassifyResult,
  DraftRequest,
  DraftResult,
  EmbedRequest,
  EmbedResult,
  ExtractRequest,
  ExtractResult,
  LocalModelConfig,
  LocalModelProvenance,
  LocalModelRun,
  LocalTaskKind,
  Message,
  RerankRequest,
  RerankResult,
  SummarizeRequest,
  SummarizeResult,
} from '@forge/types'

import { LocalModelRouter } from './router.js'
import {
  classifySystem,
  classifyUser,
  extractSystem,
  extractUser,
  rerankSystem,
  rerankUser,
  summarizeSystem,
  summarizeUser,
} from './prompts.js'
import {
  fallbackExtract,
  fallbackRerankOrder,
  fallbackSummary,
  parseClassify,
  parseExtract,
  parseRerank,
  parseSummary,
  truncateMiddle,
} from './parse.js'

export interface StoredArtifact {
  id: string
}

/** Sink for persisting exact inputs/outputs as artifacts with stable refs. */
export interface ArtifactSink {
  store(input: {
    taskId: string
    kind: 'local_model_input' | 'local_model_output'
    description: string
    content: string
    contentType: 'text' | 'json'
    metadata?: Record<string, unknown>
  }): Promise<StoredArtifact>
}

/** Sink for durable provenance rows (migration v4 `local_model_runs`). */
export interface RunSink {
  record(run: LocalModelRun): Promise<void>
}

/** Sink for `local_model_invoked` trace events. */
export interface TraceSink {
  record(taskId: string, description: string, payload: Record<string, unknown>): Promise<void>
}

export interface ServiceDeps {
  artifacts?: ArtifactSink
  runs?: RunSink
  trace?: TraceSink
  now?: () => number
  randomId?: () => string
}

const DEFAULT_MAX_INPUT_CHARS = 24_000
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_SUMMARY_TARGET_TOKENS = 200
/** Rough chars-per-token for budgeting summary output truncation in fallback. */
const CHARS_PER_TOKEN = 4

export class LocalModelService {
  private readonly router: LocalModelRouter
  private readonly deps: Required<Pick<ServiceDeps, 'now' | 'randomId'>> &
    Pick<ServiceDeps, 'artifacts' | 'runs' | 'trace'>

  constructor(
    private readonly config: LocalModelConfig,
    router?: LocalModelRouter,
    deps: ServiceDeps = {},
  ) {
    this.router = router ?? new LocalModelRouter(config)
    this.deps = {
      artifacts: deps.artifacts,
      runs: deps.runs,
      trace: deps.trace,
      now: deps.now ?? (() => Date.now()),
      randomId:
        deps.randomId ?? (() => `lmr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    }
  }

  /** Expose enablement so callers can cheaply gate optional work. */
  available(): Promise<boolean> {
    return this.router.available()
  }

  private get maxInputChars(): number {
    return this.config.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /* -------------------------------- summarize ------------------------------- */

  async summarize(req: SummarizeRequest): Promise<SummarizeResult> {
    const started = this.deps.now()
    const targetTokens = req.targetTokens ?? this.config.summaryTargetTokens ?? DEFAULT_SUMMARY_TARGET_TOKENS
    const sourceArtifactId = await this.persistInput(req.taskId, 'summarize', req.content, req.label)

    const fallback = (): SummarizeResult => ({
      authoritative: false,
      summary: fallbackSummary(req.content, targetTokens * CHARS_PER_TOKEN),
      sourceArtifactId,
      provenance: this.provenance('summarize', started, { fallbackUsed: true, sourceArtifactId }),
    })

    if (!(await this.router.available())) return this.finalizeFallback(fallback())

    try {
      const text = await this.invokeInstruct([
        { role: 'system', content: summarizeSystem() },
        { role: 'user', content: summarizeUser({ ...req, content: this.bound(req.content), targetTokens }) },
      ])
      const summary = parseSummary(text)
      if (summary === null) return this.finalizeFallback(fallback())
      const outputArtifactId = await this.persistOutput(req.taskId, 'summarize', summary)
      const provenance = this.provenance('summarize', started, {
        fallbackUsed: false,
        sourceArtifactId,
        outputArtifactId,
      })
      await this.record(req.taskId, provenance, { label: req.label, chars: req.content.length })
      return { authoritative: false, summary, sourceArtifactId, provenance }
    } catch {
      return this.finalizeFallback(fallback())
    }
  }

  /* --------------------------------- classify ------------------------------- */

  async classify(req: ClassifyRequest): Promise<ClassifyResult> {
    const started = this.deps.now()
    const sourceArtifactId = await this.persistInput(req.taskId, 'classify', req.content, req.subject)

    const fallback = (): ClassifyResult => ({
      authoritative: false,
      label: 'unknown',
      confidence: 0,
      provenance: this.provenance('classify', started, { fallbackUsed: true, sourceArtifactId, confidence: 0 }),
    })

    if (!(await this.router.available())) return this.finalizeFallback(fallback())

    try {
      const text = await this.invokeInstruct([
        { role: 'system', content: classifySystem() },
        { role: 'user', content: classifyUser({ ...req, content: this.bound(req.content) }) },
      ])
      const parsed = parseClassify(text, req.labels)
      if (parsed === null) return this.finalizeFallback(fallback())
      const outputArtifactId = await this.persistOutput(req.taskId, 'classify', JSON.stringify(parsed))
      const provenance = this.provenance('classify', started, {
        fallbackUsed: false,
        sourceArtifactId,
        outputArtifactId,
        confidence: parsed.confidence,
      })
      await this.record(req.taskId, provenance, { subject: req.subject, label: parsed.label })
      return { authoritative: false, ...parsed, provenance }
    } catch {
      return this.finalizeFallback(fallback())
    }
  }

  /* --------------------------------- extract -------------------------------- */

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const started = this.deps.now()
    const sourceArtifactId = await this.persistInput(req.taskId, 'extract', req.content, req.subject)

    const fallback = (): ExtractResult => ({
      authoritative: false,
      fields: fallbackExtract(req.content, req.fields),
      provenance: this.provenance('extract', started, { fallbackUsed: true, sourceArtifactId }),
    })

    if (!(await this.router.available())) return this.finalizeFallback(fallback())

    try {
      const text = await this.invokeInstruct([
        { role: 'system', content: extractSystem() },
        { role: 'user', content: extractUser({ ...req, content: this.bound(req.content) }) },
      ])
      const fields = parseExtract(text, req.fields)
      if (fields === null) return this.finalizeFallback(fallback())
      const outputArtifactId = await this.persistOutput(req.taskId, 'extract', JSON.stringify(fields))
      const provenance = this.provenance('extract', started, {
        fallbackUsed: false,
        sourceArtifactId,
        outputArtifactId,
      })
      await this.record(req.taskId, provenance, { subject: req.subject, fieldCount: fields.length })
      return { authoritative: false, fields, provenance }
    } catch {
      return this.finalizeFallback(fallback())
    }
  }

  /* ---------------------------------- rerank -------------------------------- */

  async rerank(req: RerankRequest): Promise<RerankResult> {
    const started = this.deps.now()
    const n = req.candidates.length
    const identity = (): RerankResult => ({
      authoritative: false,
      order: fallbackRerankOrder(n),
      scores: fallbackRerankOrder(n).map(() => 0),
      provenance: this.provenance('rerank', started, { fallbackUsed: true }),
    })

    if (n === 0 || !(await this.router.available())) return this.finalizeFallback(identity())

    try {
      const text = await this.invokeInstruct([
        { role: 'system', content: rerankSystem() },
        {
          role: 'user',
          content: rerankUser({
            ...req,
            candidates: req.candidates.map((c) => this.bound(c, Math.floor(this.maxInputChars / n))),
          }),
        },
      ])
      const order = parseRerank(text, n)
      if (order === null) return this.finalizeFallback(identity())
      // Rank position → descending score, purely positional (advisory signal).
      const scores = order.map((_, rank) => (n - rank) / n)
      const provenance = this.provenance('rerank', started, { fallbackUsed: false })
      await this.record(req.taskId, provenance, { candidates: n })
      return { authoritative: false, order, scores, provenance }
    } catch {
      return this.finalizeFallback(identity())
    }
  }

  /* ----------------------------------- draft -------------------------------- */

  async draft(req: DraftRequest): Promise<DraftResult> {
    const started = this.deps.now()
    const kind = req.kind ?? 'notes'
    const sourceArtifactId = await this.persistInput(
      req.taskId,
      'draft',
      [req.prompt, req.context ? `\n\nContext:\n${req.context}` : ''].join(''),
      kind,
    )

    const fallback = (): DraftResult => ({
      authoritative: false,
      draft: fallbackSummary(`${req.prompt}\n${req.context ?? ''}`, (req.targetTokens ?? 240) * CHARS_PER_TOKEN),
      kind,
      requiresFrontierReview: true,
      provenance: this.provenance('draft', started, {
        fallbackUsed: true,
        fallbackReason: 'local draft model unavailable',
        sourceArtifactId,
      }),
    })

    if (!(await this.router.available())) return this.finalizeFallback(fallback())

    try {
      const targetTokens = req.targetTokens ?? 500
      const text = await this.invokeInstruct([
        {
          role: 'system',
          content:
            'You draft low-risk coding artifacts for Forge. Return only the draft. ' +
            'Your output is advisory and must be reviewed by a frontier model before any file mutation.',
        },
        {
          role: 'user',
          content: [
            `Draft kind: ${kind}`,
            `Target tokens: ${targetTokens}`,
            '',
            req.prompt,
            req.context ? `\nContext:\n${this.bound(req.context)}` : '',
          ].join('\n'),
        },
      ])
      const draft = text.trim()
      if (!draft) return this.finalizeFallback(fallback())
      const outputArtifactId = await this.persistOutput(req.taskId, 'draft', draft)
      const provenance = this.provenance('draft', started, {
        fallbackUsed: false,
        sourceArtifactId,
        outputArtifactId,
      })
      await this.record(req.taskId, provenance, { kind, chars: draft.length, requiresFrontierReview: true })
      return { authoritative: false, draft, kind, requiresFrontierReview: true, provenance }
    } catch {
      return this.finalizeFallback(fallback())
    }
  }

  /* ----------------------------------- embed -------------------------------- */

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const started = this.deps.now()
    const empty = (): EmbedResult => ({
      authoritative: false,
      vectors: [],
      dim: 0,
      provenance: this.provenance('embed', started, { fallbackUsed: true }),
    })

    if (req.texts.length === 0 || !(await this.router.available())) return this.finalizeFallback(empty())
    const provider = this.router.embedProvider()
    if (!provider) return this.finalizeFallback(empty())

    try {
      const result = await this.withTimeout(
        provider.embed({
          model: this.router.embedConfig().model,
          texts: req.texts.map((t) => this.bound(t)),
        }),
      )
      const dim = result.vectors[0]?.length ?? 0
      const provenance = this.provenance('embed', started, {
        fallbackUsed: false,
        usage: result.usage,
      })
      // Recording is best-effort: a trace/artifact sink failure must NOT discard
      // a successful embedding (that would surface as a bogus `fallbackUsed`).
      if (req.taskId) {
        try { await this.record(req.taskId, provenance, { count: req.texts.length, dim }) } catch { /* non-fatal */ }
      }
      return { authoritative: false, vectors: result.vectors, dim, provenance }
    } catch (e) {
      if ((globalThis as { process?: { env?: Record<string, string | undefined>; stderr?: { write(s: string): void } } }).process?.env?.FORGE_DEBUG_EMBED) {
        (globalThis as { process?: { stderr?: { write(s: string): void } } }).process?.stderr?.write(`[embed-fail] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
      }
      return this.finalizeFallback(empty())
    }
  }

  /* --------------------------------- helpers -------------------------------- */

  private bound(content: string, max = this.maxInputChars): string {
    return truncateMiddle(content, max)
  }

  private async invokeInstruct(messages: Message[]): Promise<string> {
    const provider = this.router.instructProvider()
    const cfg = this.router.instructConfig()
    const result = await this.withTimeout(
      provider.completeSync({
        model: cfg.model,
        messages,
        temperature: cfg.temperature ?? 0.1,
        maxTokens: cfg.maxTokens ?? 1024,
      }),
    )
    return result.content
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local-model timeout')), this.timeoutMs)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  private provenance(
    taskKind: LocalTaskKind,
    started: number,
    extra: Partial<LocalModelProvenance>,
  ): LocalModelProvenance {
    const cfg = this.router.configFor(taskKind)
    return {
      runId: this.deps.randomId(),
      taskKind,
      model: cfg.model,
      provider: extra.fallbackUsed ? 'fallback' : cfg.name,
      latencyMs: this.deps.now() - started,
      createdAt: new Date(this.deps.now()).toISOString(),
      fallbackUsed: extra.fallbackUsed ?? false,
      fallbackReason: extra.fallbackReason,
      sourceArtifactId: extra.sourceArtifactId,
      outputArtifactId: extra.outputArtifactId,
      confidence: extra.confidence,
      usage: extra.usage,
      savings: extra.savings,
    }
  }

  private async persistInput(
    taskId: string,
    kind: LocalTaskKind,
    content: string,
    label?: string,
  ): Promise<string | undefined> {
    if (!this.deps.artifacts) return undefined
    try {
      const stored = await this.deps.artifacts.store({
        taskId,
        kind: 'local_model_input',
        description: `local-model ${kind} input${label ? `: ${label}` : ''}`,
        content,
        contentType: 'text',
        metadata: { taskKind: kind },
      })
      return stored.id
    } catch {
      return undefined
    }
  }

  private async persistOutput(taskId: string, kind: LocalTaskKind, content: string): Promise<string | undefined> {
    if (!this.deps.artifacts) return undefined
    try {
      const stored = await this.deps.artifacts.store({
        taskId,
        kind: 'local_model_output',
        description: `local-model ${kind} output`,
        content,
        contentType: 'text',
        metadata: { taskKind: kind },
      })
      return stored.id
    } catch {
      return undefined
    }
  }

  private async record(
    taskId: string,
    provenance: LocalModelProvenance,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const run: LocalModelRun = {
      id: provenance.runId,
      taskId,
      taskKind: provenance.taskKind,
      model: provenance.model,
      provider: provenance.provider,
      inputArtifactId: provenance.sourceArtifactId,
      outputArtifactId: provenance.outputArtifactId,
      latencyMs: provenance.latencyMs,
      inputTokens: provenance.usage?.inputTokens,
      outputTokens: provenance.usage?.outputTokens,
      confidence: provenance.confidence,
      fallbackReason: provenance.fallbackReason,
      savings: provenance.savings,
      fallbackUsed: provenance.fallbackUsed,
      createdAt: provenance.createdAt,
    }
    if (this.deps.runs) {
      try {
        await this.deps.runs.record(run)
      } catch {
        /* provenance is best-effort; never break the agent loop */
      }
    }
    if (this.deps.trace) {
      try {
        await this.deps.trace.record(taskId, `local ${provenance.taskKind} (${provenance.provider})`, {
          ...extra,
          runId: provenance.runId,
          taskKind: provenance.taskKind,
          provider: provenance.provider,
          model: provenance.model,
          latencyMs: provenance.latencyMs,
          fallbackUsed: provenance.fallbackUsed,
          fallbackReason: provenance.fallbackReason,
          savings: provenance.savings,
          sourceArtifactId: provenance.sourceArtifactId,
          outputArtifactId: provenance.outputArtifactId,
          authoritative: false,
        })
      } catch {
        /* trace is best-effort */
      }
    }
  }

  /**
   * Record a best-effort provenance row for a fallback result (so misses are
   * observable), then return it unchanged. Never throws.
   */
  private async finalizeFallback<T extends { provenance: LocalModelProvenance }>(result: T): Promise<T> {
    if (this.deps.runs) {
      try {
        await this.deps.runs.record({
          id: result.provenance.runId,
          taskKind: result.provenance.taskKind,
          model: result.provenance.model,
          provider: result.provenance.provider,
          inputArtifactId: result.provenance.sourceArtifactId,
          outputArtifactId: result.provenance.outputArtifactId,
          latencyMs: result.provenance.latencyMs,
          confidence: result.provenance.confidence,
          fallbackReason: result.provenance.fallbackReason,
          savings: result.provenance.savings,
          fallbackUsed: true,
          createdAt: result.provenance.createdAt,
        })
      } catch {
        /* ignore */
      }
    }
    return result
  }
}
