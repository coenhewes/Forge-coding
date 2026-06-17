import type {
  CompletionRequest,
  Message,
  ToolDefinition,
  ToolCall,
  CompletionChunk,
  CompletionResult,
} from '@forge/types'

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function buildApiUrl(base: string, path: string): string {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return `${normalized}${path}`
}

export async function fetchStream(
  url: string,
  options: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ProviderError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        body,
      )
    }

    return response
  } finally {
    clearTimeout(timeout)
  }
}

export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderError('Response body is not readable')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''

      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6)
          if (data === '[DONE]') return
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6)
        if (data !== '[DONE]') {
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            // skip
          }
        }
      }
    }
}

export async function* parseAnthropicEventStream(response: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7)
      } else if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6)
        try {
          yield { event: currentEvent, data: JSON.parse(data) as Record<string, unknown> }
        } catch {
          // skip
        }
        currentEvent = ''
      }
    }
  }
}

export async function* parseNewlineJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue
      try {
        yield JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // skip
      }
    }
  }
}

export function mapMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role }
    if (m.role === 'tool') {
      base.content = m.content
      base.tool_call_id = m.toolCallId
    } else {
      base.content = m.content
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      }))
    }
    return base
  })
}

export function mapAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      })
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: Record<string, unknown>[] = []
      if (m.content) {
        content.push({ type: 'text', text: m.content })
      }
      for (const tc of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })
      }
      result.push({ role: 'assistant', content })
    } else {
      result.push({ role: m.role, content: m.content })
    }
  }
  return result
}

export function mapTools(tools?: ToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

export function mapAnthropicTools(tools?: ToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

export function parseToolCallsFromChunk(data: Record<string, unknown>): ToolCall[] | undefined {
  const choices = data.choices as Record<string, unknown>[] | undefined
  if (!choices || choices.length === 0) return undefined

  const delta = choices[0]?.delta as Record<string, unknown> | undefined
  if (!delta) return undefined

  const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => {
    const func = tc.function as Record<string, unknown> | undefined
    return {
      id: tc.id as string,
      name: func?.name as string ?? '',
      input: func?.arguments ? JSON.parse(func.arguments as string) : {},
    }
  })
}

export function mergeChunks(chunks: CompletionChunk[]): CompletionResult {
  let content = ''
  const toolCalls: ToolCall[] = []
  let finishReason: CompletionResult['finishReason'] = 'stop'

  for (const chunk of chunks) {
    if (chunk.content) content += chunk.content
    if (chunk.toolCalls) {
      for (const tc of chunk.toolCalls) {
        toolCalls.push(tc)
      }
    }
    if (chunk.finishReason) finishReason = chunk.finishReason
  }

  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, finishReason }
}

export function getSystemMessage(messages: Message[]): string | undefined {
  const system = messages.find((m) => m.role === 'system')
  return system?.content as string | undefined
}
