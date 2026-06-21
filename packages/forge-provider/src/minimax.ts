import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  CompletionResult,
  ModelProvider,
  ToolCall,
} from '@forge/types'

import {
  buildApiUrl,
  fetchStream,
  parseAnthropicEventStream,
  mapAnthropicMessages,
  mapAnthropicTools,
  getSystemMessage,
  mergeChunks,
  safeParseToolInput,
} from './base.js'

const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic/v1'

export class MinimaxProvider implements ModelProvider {
  private baseUrl: string
  private apiKey: string

  private pendingToolCalls: Map<string, { name: string; input: string }> = new Map()

  constructor(private config: ProviderConfig) {
    this.baseUrl = config.apiUrl ?? DEFAULT_BASE_URL
    this.apiKey = config.apiKey ?? ''
    if (!this.apiKey) {
      throw new Error('Minimax provider requires an API key')
    }
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const url = buildApiUrl(this.baseUrl, '/messages')
    this.pendingToolCalls.clear()

    const system = getSystemMessage(request.messages)
    const messages = mapAnthropicMessages(request.messages)

    // Place a prompt-cache breakpoint at the end of the append-only history
    // (the message tagged with cacheBoundary by the agent loop). This caches
    // the whole stable prefix — system + tools + task + history — so only the
    // volatile per-turn situation report and the model's reply are billed as
    // fresh input on later turns. Without this, the entire messages array is
    // re-billed every call (the dominant token cost on long-horizon runs).
    for (const m of messages) {
      const content = m.content as Record<string, unknown>[] | undefined
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.__cacheBoundary) {
          delete block.__cacheBoundary
          block.cache_control = { type: 'ephemeral' }
        }
      }
    }

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages,
      stream: true,
    }

    // Prompt caching: the system prompt and tool schemas are stable across the
    // many calls of a long-horizon run (~4-5K tokens combined). Marking them
    // with cache_control lets MiniMax serve them from cache on later calls, so
    // they stop counting as fresh input tokens — the single biggest lever on
    // Forge's main-model token cost (local-model work is already free). The
    // cache covers everything up to and including the marked block, so we mark
    // the system block and the LAST tool.
    if (system) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }
    if (request.tools) {
      const tools = mapAnthropicTools(request.tools)
      if (tools && tools.length > 0) {
        tools[tools.length - 1] = {
          ...tools[tools.length - 1],
          cache_control: { type: 'ephemeral' },
        }
      }
      body.tools = tools
    }
    if (request.maxTokens) body.max_tokens = request.maxTokens
    if (request.temperature) body.temperature = request.temperature

    if (!body.max_tokens) body.max_tokens = 8192

    const response = await fetchStream(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: this.config.timeoutMs,
    })

    for await (const { event, data } of parseAnthropicEventStream(response)) {
      const chunk: CompletionChunk = {}

      if (event === 'content_block_delta') {
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && delta.text) {
          chunk.content = delta.text as string
        }
      }

      if (event === 'content_block_start') {
        const contentBlock = data.content_block as Record<string, unknown> | undefined
        if (contentBlock?.type === 'tool_use') {
          this.pendingToolCalls.set(contentBlock.id as string, {
            name: contentBlock.name as string,
            input: '',
          })
        }
      }

      if (event === 'content_block_delta') {
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const toolUseId = data.index !== undefined
            ? Array.from(this.pendingToolCalls.keys()).at(-1)
            : undefined
          if (toolUseId) {
            const existing = this.pendingToolCalls.get(toolUseId)
            if (existing) {
              existing.input += delta.partial_json as string
            }
          }
        }
      }

      if (event === 'message_stop') {
        chunk.finishReason = 'stop'
      }

      // Token usage (Anthropic-style): input_tokens arrives on message_start,
      // output_tokens accumulates on message_delta. Surface both so the agent
      // loop can track real main-model spend (the metric Forge optimizes:
      // verified tasks per main-model token, with local-model work being free).
      if (event === 'message_start') {
        const msg = data.message as Record<string, unknown> | undefined
        const usage = msg?.usage as Record<string, unknown> | undefined
        if (usage && typeof usage.input_tokens === 'number') {
          chunk.usage = { inputTokens: usage.input_tokens as number }
          if (typeof usage.cache_read_input_tokens === 'number') {
            chunk.usage.cacheReadTokens = usage.cache_read_input_tokens as number
          }
        }
      }

      if (event === 'message_delta') {
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason === 'end_turn') {
          chunk.finishReason = 'stop'
        } else if (delta?.stop_reason === 'max_tokens') {
          chunk.finishReason = 'length'
        } else if (delta?.stop_reason === 'tool_use') {
          chunk.finishReason = 'tool_calls'
        }
        // MiniMax reports the FINAL token counts on message_delta — both
        // input_tokens and output_tokens (message_start carries zeros). Capture
        // both here.
        const usage = data.usage as Record<string, unknown> | undefined
        if (usage) {
          const next = { ...chunk.usage }
          if (typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
            next.inputTokens = usage.input_tokens as number
          }
          if (typeof usage.output_tokens === 'number') {
            next.outputTokens = usage.output_tokens as number
          }
          // cache_read_input_tokens: input served from MiniMax's prompt cache.
          // The diagnostic for whether our cache_control markers actually engage.
          if (typeof usage.cache_read_input_tokens === 'number') {
            next.cacheReadTokens = usage.cache_read_input_tokens as number
          }
          chunk.usage = next
        }
      }

      yield chunk
    }

    if (this.pendingToolCalls.size > 0) {
      const toolCalls: ToolCall[] = []
      let truncated = false
      for (const [id, tc] of this.pendingToolCalls) {
        const parsed = safeParseToolInput(tc.input)
        if (parsed === undefined) {
          // Tool args were unparseable — almost always because the response
          // hit max_tokens mid-string. Drop this call and signal truncation so
          // the loop can ask the model to retry with smaller output, instead of
          // throwing and killing the whole run.
          truncated = true
          continue
        }
        toolCalls.push({ id, name: tc.name, input: parsed })
      }
      if (toolCalls.length > 0) yield { toolCalls, finishReason: 'tool_calls' }
      if (truncated) yield { finishReason: 'length' }
    }
  }

  async completeSync(request: CompletionRequest): Promise<CompletionResult> {
    const chunks: CompletionChunk[] = []
    for await (const chunk of this.complete(request)) {
      chunks.push(chunk)
    }
    return mergeChunks(chunks)
  }
}
