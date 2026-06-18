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

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages,
      stream: true,
    }

    if (system) body.system = system
    if (request.tools) body.tools = mapAnthropicTools(request.tools)
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

      if (event === 'message_delta') {
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason === 'end_turn') {
          chunk.finishReason = 'stop'
        } else if (delta?.stop_reason === 'max_tokens') {
          chunk.finishReason = 'length'
        } else if (delta?.stop_reason === 'tool_use') {
          chunk.finishReason = 'tool_calls'
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
