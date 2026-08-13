import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  CompletionResult,
  ModelProvider,
  ToolCall,
} from '@forge/types'

import { appendFileSync } from 'node:fs'

import {
  buildApiUrl,
  fetchStream,
  parseSSE,
  mapMessages,
  mapTools,
  parseToolCallsFromChunk,
  mergeChunks,
} from './base.js'

// Nous Research Inference API is an OpenAI-compatible surface
// (https://inference-api.nousresearch.com/v1). The transport is identical to
// OpenAI: same /chat/completions contract, Bearer auth, tool-call shape.
const DEFAULT_BASE_URL = 'https://inference-api.nousresearch.com/v1'

export class NousProvider implements ModelProvider {
  private baseUrl: string
  private apiKey: string

  private pendingToolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map()

  constructor(private config: ProviderConfig) {
    this.baseUrl = config.apiUrl ?? DEFAULT_BASE_URL
    this.apiKey = config.apiKey ?? ''
    if (!this.apiKey) {
      throw new Error('Nous provider requires an API key (NOUS_API_KEY)')
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

    if (process.env.FORGE_DEBUG_PROVIDER) {
      try { appendFileSync('/tmp/forge-provider-req.jsonl', JSON.stringify({ url, hasKey: !!this.apiKey, keyPrefix: this.apiKey.slice(0, 10), body }) + '\n') } catch {}
    }

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
      // Reasoning models stream their answer in `reasoning` and may leave
      // `content` empty. Surface reasoning as the text the agent sees.
      else if (delta?.reasoning) chunk.content = delta.reasoning as string
      if (finishReason) chunk.finishReason = finishReason as CompletionChunk['finishReason']

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
