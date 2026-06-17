import type { CapabilityContext } from './capabilities.js'
import { CapabilityRegistry, type CapabilityResult } from './capabilities.js'
import type { DomainManifest } from '@forge/types'

export interface ExecuteOptions {
  /** Override domain permission checks */
  bypassPermissions?: boolean
}

export class CapabilityExecutor {
  constructor(
    private registry: CapabilityRegistry,
    private domainManifests: DomainManifest[],
    private context: CapabilityContext,
  ) {}

  async execute(
    capabilityName: string,
    input: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<CapabilityResult> {
    const impl = this.registry.get(capabilityName)
    if (!impl) {
      return { success: false, error: `Unknown capability: ${capabilityName}` }
    }

    // Permission check: verify the capability's domain is accessible
    if (!options?.bypassPermissions) {
      const permission = this.checkPermissions(capabilityName, impl.definition.domain)
      if (!permission.allowed) {
        return { success: false, error: permission.reason }
      }
    }

    try {
      return await impl.handler(input, this.context)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async executeBatch(
    calls: { name: string; input: Record<string, unknown> }[],
  ): Promise<{ name: string; result: CapabilityResult }[]> {
    return Promise.all(
      calls.map(async ({ name, input }) => ({
        name,
        result: await this.execute(name, input),
      })),
    )
  }

  private checkPermissions(
    capabilityName: string,
    domain: string,
  ): { allowed: boolean; reason?: string } {
    const manifest = this.domainManifests.find((m) => m.domain === domain)
    if (!manifest) {
      return { allowed: false, reason: `Domain '${domain}' has no manifest` }
    }
    // Domain is selected — capability is allowed
    return { allowed: true }
  }

  updateContext(context: CapabilityContext): void {
    this.context = context
  }
}
