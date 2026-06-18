/**
 * CompactionPolicy — decides which message contents are large enough to be
 * worth compacting and rewrites them in place as `summary + stable ref`.
 *
 * The threshold/trigger approach is adapted from opencode's
 * `packages/opencode/src/session/{overflow,compaction}.ts` (MIT): compact only
 * when content exceeds a size threshold, and keep the exact original
 * retrievable rather than discarding it. Reimplemented in Forge style; see
 * NOTICE for attribution.
 *
 * Critically, compaction NEVER destroys evidence: the summary carries the
 * artifact id of the byte-exact original, recoverable via the context-server
 * `evidence.get_exact_artifact` capability.
 */

import type { Message } from '@forge/types'

import type { LocalModelService } from './service.js'

export interface CompactionPolicyConfig {
  /** Tool outputs larger than this many chars are candidates for compaction. */
  thresholdChars: number
  /** Target size of the generated summary, in tokens. */
  targetTokens: number
}

const DEFAULT_THRESHOLD_CHARS = 4_000
const DEFAULT_TARGET_TOKENS = 200

export interface CompactionResult {
  messages: Message[]
  /** Number of messages compacted. */
  compacted: number
  /** Stable artifact refs of the exact originals that were compacted. */
  refs: string[]
}

export class CompactionPolicy {
  private readonly config: CompactionPolicyConfig

  constructor(
    private readonly service: LocalModelService,
    config?: Partial<CompactionPolicyConfig>,
  ) {
    this.config = {
      thresholdChars: config?.thresholdChars ?? DEFAULT_THRESHOLD_CHARS,
      targetTokens: config?.targetTokens ?? DEFAULT_TARGET_TOKENS,
    }
  }

  shouldCompact(content: string): boolean {
    return content.length > this.config.thresholdChars
  }

  /**
   * Compact oversized `tool` messages into `summary + ref`. Returns a NEW
   * message array (input is not mutated). If the local layer is unavailable,
   * the summary falls back to deterministic head/tail truncation but the exact
   * original is still stored and referenced — so the agent's working context
   * shrinks either way and nothing is lost.
   */
  async compactToolOutputs(taskId: string, messages: Message[]): Promise<CompactionResult> {
    const out: Message[] = []
    const refs: string[] = []
    let compacted = 0

    for (const message of messages) {
      if (message.role !== 'tool' || !this.shouldCompact(message.content)) {
        out.push(message)
        continue
      }
      const result = await this.service.summarize({
        taskId,
        content: message.content,
        label: `tool result (${message.toolCallId ?? 'unknown'})`,
        targetTokens: this.config.targetTokens,
      })
      const ref = result.sourceArtifactId
      if (ref) refs.push(ref)
      compacted++
      out.push({
        ...message,
        content: [
          ref
            ? `[compacted: exact output retained as ${ref}; recover via evidence.get_exact_artifact]`
            : `[compacted: ${message.content.length} chars summarized]`,
          result.summary,
        ].join('\n'),
      })
    }

    return { messages: out, compacted, refs }
  }
}
