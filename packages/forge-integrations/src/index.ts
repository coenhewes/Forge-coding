/**
 * @forge/integrations — typed adapter registry + domain MCP fabric.
 *
 * Three concerns live in this package:
 *
 *   1. The frozen `IntegrationRegistry` for external system adapters
 *      (GitHub, GitLab, Linear, Jira, Slack, CI providers, etc.).
 *      Downstream tracks will register concrete adapters against it.
 *
 *   2. The Domain MCP Fabric — manifests, the capability router,
 *      and probe capabilities. These implement AGENTS.md §3-6 and
 *      the Semantic Capability Fabric and Semantic Router sections
 *      of featurerequest1.
 *
 *   3. The shared, exported types so downstream code (harness, agent
 *      loop, TUI) can wire against a stable surface.
 *
 * Domain + capability + probe code lives under `./domains`, with
 * `router.ts` and `probes.ts` in this directory.
 */
import type {
  ChatAdapter,
  CiAdapter,
  IssueTrackerAdapter,
  PullRequestAdapter,
} from '@forge/types'

/* ---------------------------------------------------------------- *
 *  Section 1: External integration adapter registry
 * ---------------------------------------------------------------- */

/** Names of every integration adapter the registry can hold. */
export type IntegrationName =
  | 'github'
  | 'gitlab'
  | 'linear'
  | 'jira'
  | 'slack'
  | 'circleci'
  | 'github-actions'

/** Typed empty registry — later tracks add concrete adapters here. */
export interface IntegrationRegistry {
  readonly issueTracker?: IssueTrackerAdapter
  readonly pullRequest?: PullRequestAdapter
  readonly chat?: ChatAdapter
  readonly ci?: CiAdapter
  /** Future slot for additional adapters keyed by integration name. */
  readonly extras?: Partial<Record<IntegrationName, unknown>>
}

/** Default empty registry — a frozen handle with no adapters wired in yet. */
export const INTEGRATION_REGISTRY: IntegrationRegistry = Object.freeze({
  extras: {},
})

/* ---------------------------------------------------------------- *
 *  Section 2: Re-exports for the Domain MCP Fabric
 * ---------------------------------------------------------------- */

export {
  DOMAINS,
  DOMAIN_NAMES,
} from './domains/index.js'
export type {
  CapabilityDescriptor,
  DomainEntry,
  DomainManifests,
} from './domains/index.js'
export type {
  CapabilityCategory,
  CapabilityCost,
  CapabilityGain,
  CapabilityPermission,
  CapabilityRiskLevel,
  DomainManifest,
  DomainAccess,
  DomainSelection,
  DomainExpansionRecord,
} from './domains/index.js'

export { CapabilityRouter } from './router.js'
export type {
  RouterConfig,
  RouterResult,
  DomainRouteResult,
} from './router.js'
export { DEFAULT_ROUTER_CONFIG } from './router.js'

export {
  runProbe,
  registerProbeHandler,
  getProbeHandler,
  listImplementedCapabilities,
  listRegisteredCapabilities,
} from './probes.js'
export type {
  ProbeCallInput,
  ProbeExecution,
  ProbeHandler,
  BeliefStoreLike,
} from './probes.js'

/* ---------------------------------------------------------------- *
 *  Section 3: MCP server + client (JSON-RPC 2.0 over stdio)
 * ---------------------------------------------------------------- */

export * as mcp from './mcp/index.js'

// Top-level re-exports so callers (CLI, tests, downstream packages)
// can pull the MCP primitives without going through the namespace.
export {
  createCapabilityContext,
  createInMemoryCapabilityContext,
  handleRawRpc,
  runMcpServer,
  runMcpServeFromEnv,
  RPC_ERROR,
} from './mcp/server.js'
export type {
  CapabilityContext,
  GetCurrentStateArgs,
  GetTopHypothesesArgs,
  PlanNextActionArgs,
  TaskCurrentStateResult,
  TopHypothesesResult,
  PlanNextActionResult,
  ToolDescriptor,
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerOptions,
  InMemoryCapabilityContextOptions,
} from './mcp/server.js'

export {
  createInProcessMcpClient,
  spawnStdioMcpClient,
} from './mcp/client.js'
export type {
  McpClient,
  InProcessMcpClientOptions,
  StdioMcpClientOptions,
} from './mcp/client.js'

/* ---------------------------------------------------------------- *
 *  Section 4: Plugin registry (typed manifest + lifecycle hooks)
 * ---------------------------------------------------------------- */

export * as plugins from './plugins/index.js'

// Top-level re-exports so callers (CLI, tests, downstream packages)
// can pull plugin primitives without going through the namespace.
export {
  PluginRegistry,
  pluginRegistry,
  validatePluginManifest,
  asSemver,
  asCapabilityId,
} from './plugins/registry.js'
export type {
  PluginManifest,
  PluginLifecycleHook,
  PluginPermission,
  PluginHookContext,
  PluginHookHandler,
  SemverString,
  PluginCapabilityId,
} from './plugins/registry.js'

export const INTEGRATIONS_VERSION = '0.1.0'
