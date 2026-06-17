import type { ToolDefinition } from '@forge/types'

export type CapabilityResult = {
  success: boolean
  data?: unknown
  error?: string
}

export interface CapabilityDefinition {
  /** e.g. "auth.trace_permission_check" */
  name: string
  /** Human-readable description */
  description: string
  /** JSON Schema for input */
  inputSchema: Record<string, unknown>
  /** Which domain this belongs to */
  domain: string
}

export type CapabilityHandler = (
  input: Record<string, unknown>,
  context: CapabilityContext,
) => Promise<CapabilityResult>

export interface CapabilityContext {
  repoRoot: string
  repoMap: unknown
  repoGraph: unknown
  taskState: unknown
  evidence: unknown
  failureLedger: unknown
  decisionLedger: unknown
}

export interface CapabilityImplementation {
  definition: CapabilityDefinition
  handler: CapabilityHandler
}

export class CapabilityRegistry {
  private implementations = new Map<string, CapabilityImplementation>()

  register(impl: CapabilityImplementation): void {
    this.implementations.set(impl.definition.name, impl)
  }

  registerMany(impls: CapabilityImplementation[]): void {
    for (const impl of impls) {
      this.register(impl)
    }
  }

  get(name: string): CapabilityImplementation | undefined {
    return this.implementations.get(name)
  }

  getByDomain(domain: string): CapabilityImplementation[] {
    return Array.from(this.implementations.values())
      .filter((i) => i.definition.domain === domain)
  }

  getAll(): Map<string, CapabilityImplementation> {
    return new Map(this.implementations)
  }

  toToolDefinitions(): ToolDefinition[] {
    return Array.from(this.implementations.values()).map((impl) => ({
      name: impl.definition.name,
      description: impl.definition.description,
      inputSchema: impl.definition.inputSchema as Record<string, unknown>,
    }))
  }

  toToolDefinitionsForDomains(domains: string[]): ToolDefinition[] {
    return this.getByDomains(domains).map((impl) => ({
      name: impl.definition.name,
      description: impl.definition.description,
      inputSchema: impl.definition.inputSchema as Record<string, unknown>,
    }))
  }

  getByDomains(domains: string[]): CapabilityImplementation[] {
    const result: CapabilityImplementation[] = []
    for (const domain of domains) {
      result.push(...this.getByDomain(domain))
    }
    return result
  }
}
