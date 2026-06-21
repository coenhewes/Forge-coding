export type ProviderName = 'openrouter' | 'ollama' | 'ollama-cloud' | 'openai' | 'anthropic' | 'minimax'

export interface ProviderConfig {
  name: ProviderName
  model: string
  apiKey?: string
  apiUrl?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export interface CompletionRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolDefinition[]
  toolChoice?: string
  maxTokens?: number
  temperature?: number
  stream?: boolean
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
  /**
   * Marks this message as the END of the cacheable, append-only prefix. The
   * provider places a prompt-cache breakpoint on its last content block so the
   * stable prefix (system + tools + task + append-only history) is served from
   * cache on later turns, while volatile content after it (the per-turn
   * situation report) stays fresh. See agent-loop runCompletion.
   */
  cacheBoundary?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface CompletionChunk {
  content?: string
  toolCalls?: ToolCall[]
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'error'
  /** Token usage, emitted on the final chunk(s) when the provider reports it. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    /**
     * Input tokens served from the provider's prompt cache (Anthropic-style
     * `cache_read_input_tokens`). These are NOT included in `inputTokens` —
     * the provider reports the uncached input separately. Surfacing this lets
     * us confirm whether prompt caching actually engages in real runs.
     */
    cacheReadTokens?: number
  }
}

export interface CompletionResult {
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
  }
}

export interface ModelProvider {
  complete(request: CompletionRequest): AsyncIterable<CompletionChunk>
  completeSync(request: CompletionRequest): Promise<CompletionResult>
}

export interface SubagentConfig {
  enabled: boolean
  provider: ProviderConfig
  maxSubagents: number
}
