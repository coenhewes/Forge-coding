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
}

export interface CompletionResult {
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  usage?: {
    inputTokens: number
    outputTokens: number
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
