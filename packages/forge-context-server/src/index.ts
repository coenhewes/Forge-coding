/**
 * @forge/context-server — repo-aware context provider for the agent harness.
 *
 * This package exposes the MCP-style context-server surface used by Forge's
 * domainized capability fabric. It depends on @forge/state-store for durable
 * claim/evidence storage and @forge/types for shared interfaces.
 *
 * This file is a placeholder scaffold. Subsequent tracks will fill in the
 * actual context-server implementation (capability registry, slice builders,
 * bounded-context assembly). Keep this file's surface stable so downstream
 * tracks and the harness can wire against it without churn.
 */

export const CONTEXT_SERVER_VERSION = '0.0.1'

/** Capability string used to route context requests into this package. */
export const CONTEXT_SERVER_CAPABILITY = 'forge.context_server'

/** Marker type used by callers that want a typed handle to the context-server. */
export interface ContextServerHandle {
  readonly version: string
  readonly capability: string
}