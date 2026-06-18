import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  CompletionResult,
  ModelProvider,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from '@forge/types'

import {
  buildApiUrl,
  fetchStream,
  parseNewlineJson,
  mapMessages,
  getSystemMessage,
  mergeChunks,
  ProviderError,
} from './base.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'

export class OllamaProvider implements ModelProvider, EmbeddingProvider {
  private baseUrl: string

  constructor(private config: ProviderConfig) {
    this.baseUrl = config.apiUrl ?? DEFAULT_BASE_URL
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const url = buildApiUrl(this.baseUrl, '/api/chat')

    const system = getSystemMessage(request.messages)
    const messages = mapMessages(request.messages.filter((m) => m.role !== 'system'))

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages,
      stream: true,
    }

    if (system) body.system = system
    if (request.temperature) body.temperature = request.temperature

    const response = await fetchStream(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: this.config.timeoutMs,
    })

    for await (const data of parseNewlineJson(response)) {
      const chunk: CompletionChunk = {}

      const message = data.message as Record<string, unknown> | undefined
      if (message?.content) chunk.content = message.content as string

      if (data.done === true) {
        chunk.finishReason = 'stop'
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

  /**
   * Embed a batch of texts via Ollama's `/api/embed` endpoint
   * (`{ model, input: string[] }` → `{ embeddings: number[][] }`).
   * Non-streaming JSON; reuses the shared timeout-capped fetch.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const url = buildApiUrl(this.baseUrl, '/api/embed')
    const response = await fetchStream(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model || this.config.model,
        input: request.texts,
      }),
      timeoutMs: this.config.timeoutMs,
    })

    const data = (await response.json()) as {
      embeddings?: number[][]
      prompt_eval_count?: number
    }
    const vectors = data.embeddings
    if (!Array.isArray(vectors) || vectors.length !== request.texts.length) {
      throw new ProviderError('Ollama embed: unexpected response shape')
    }
    return {
      vectors,
      usage: data.prompt_eval_count ? { inputTokens: data.prompt_eval_count } : undefined,
    }
  }
}
