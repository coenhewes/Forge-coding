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
  parseSSE,
  mapMessages,
  mapTools,
  parseToolCallsFromChunk,
  mergeChunks,
} from './base.js'

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export class OpenRouterProvider implements ModelProvider {
  private baseUrl: string
  private apiKey: string

  private pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

  constructor(private config: ProviderConfig) {
    this.baseUrl = config.apiUrl ?? DEFAULT_BASE_URL
    this.apiKey = config.apiKey ?? ''
    if (!this.apiKey) {
      throw new Error('OpenRouter provider requires an API key')
    }
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const url = buildApiUrl(this.baseUrl, '/chat/completions')
    this.pendingToolCalls.clear()

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: mapMessages(request.messages),
      stream: true,
    }

    if (request.tools) body.tools = mapTools(request.tools)
    if (request.toolChoice) body.tool_choice = request.toolChoice
    if (request.maxTokens) body.max_tokens = request.maxTokens
    if (request.temperature) body.temperature = request.temperature
    body.stream_options = { include_usage: true }

    const response = await fetchStream(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'X-Title': 'Forge',
      },
      body: JSON.stringify(body),
      timeoutMs: this.config.timeoutMs,
    })

    for await (const data of parseSSE(response)) {
      // The usage chunk arrives with empty choices — handle it before the guard.
      const usage = data.usage as Record<string, unknown> | undefined
      if (usage?.prompt_tokens !== undefined) {
        yield {
          usage: {
            inputTokens: Number(usage.prompt_tokens),
            outputTokens: Number(usage.completion_tokens ?? 0),
          },
        }
      }

      const choices = data.choices as Record<string, unknown>[] | undefined
      if (!choices || choices.length === 0) continue

      const delta = choices[0]?.delta as Record<string, unknown> | undefined
      const finishReason = choices[0]?.finish_reason as string | null | undefined

      const chunk: CompletionChunk = {}
      if (delta?.content) chunk.content = delta.content as string
      if (finishReason) chunk.finishReason = finishReason as CompletionChunk['finishReason']

      // Accumulate tool call deltas from streaming chunks
      const toolCallDeltas = delta?.tool_calls as Record<string, unknown>[] | undefined
      if (toolCallDeltas) {
        for (const tcd of toolCallDeltas) {
          const index = (tcd.index as number) ?? this.pendingToolCalls.size
          if (!this.pendingToolCalls.has(index)) {
            const func = tcd.function as Record<string, unknown> | undefined
            this.pendingToolCalls.set(index, {
              id: (tcd.id as string) || '',
              name: (func?.name as string) || '',
              arguments: (func?.arguments as string) || '',
            })
          } else {
            const existing = this.pendingToolCalls.get(index)!
            const func = tcd.function as Record<string, unknown> | undefined
            if (tcd.id) existing.id = tcd.id as string
            if (func?.name) existing.name = func.name as string
            if (func?.arguments) existing.arguments += func.arguments as string
          }
        }
      }

      // Emit complete tool calls when finish reason is tool_calls
      if (finishReason === 'tool_calls' && this.pendingToolCalls.size > 0) {
        const toolCalls: ToolCall[] = []
        for (const [, pc] of this.pendingToolCalls) {
          let input: Record<string, unknown> = {}
          if (pc.arguments) {
            try {
              input = JSON.parse(pc.arguments)
            } catch {
              input = {}
            }
          }
          toolCalls.push({ id: pc.id, name: pc.name, input })
        }
        chunk.toolCalls = toolCalls
      }

      yield chunk
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
