import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  CompletionResult,
  ModelProvider,
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

const DEFAULT_BASE_URL = 'https://api.minimax.chat/v1'

export class MinimaxProvider implements ModelProvider {
  private baseUrl: string
  private apiKey: string

  constructor(private config: ProviderConfig) {
    this.baseUrl = config.apiUrl ?? DEFAULT_BASE_URL
    this.apiKey = config.apiKey ?? ''
    if (!this.apiKey) {
      throw new Error('Minimax provider requires an API key')
    }
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const url = buildApiUrl(this.baseUrl, '/chat/completions')

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: mapMessages(request.messages),
      stream: true,
    }

    if (request.tools) body.tools = mapTools(request.tools)
    if (request.maxTokens) body.max_tokens = request.maxTokens
    if (request.temperature) body.temperature = request.temperature

    const response = await fetchStream(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: this.config.timeoutMs,
    })

    for await (const data of parseSSE(response)) {
      const choices = data.choices as Record<string, unknown>[] | undefined
      if (!choices || choices.length === 0) continue

      const delta = choices[0]?.delta as Record<string, unknown> | undefined
      const finishReason = choices[0]?.finish_reason as string | null | undefined

      const chunk: CompletionChunk = {}
      if (delta?.content) chunk.content = delta.content as string
      if (finishReason) chunk.finishReason = finishReason as CompletionChunk['finishReason']

      const toolCalls = parseToolCallsFromChunk(data)
      if (toolCalls) chunk.toolCalls = toolCalls

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
