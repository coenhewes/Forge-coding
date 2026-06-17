/**
 * @forge/integrations/domains — Domain Manifest types
 *
 * The shared `DomainManifest` shape lives in `@forge/types` (see
 * `packages/forge-types/src/domain.ts`). This module:
 *
 *   1. Re-exports the canonical types so consumers can import the
 *      `DomainManifest` from a single place.
 *   2. Adds MCP-fabric-shaped helpers that downstream code needs:
 *        - `CapabilityDescriptor` (a typed capability that a manifest
 *          exposes, with input/output schemas, cost, and risk).
 *        - `DomainManifests` (a frozen, keyed-by-name collection that
 *          also stores the `selectedCapabilities` list per domain).
 *        - the `DOMAINS` frozen handle.
 *
 * Manifest data files (auth.ts, backend.ts, …) populate a `ManifestSet`
 * which is then frozen into `DOMAINS` and consumed by `router.ts` and
 * `probes.ts`.
 */
import type { DomainManifest } from '@forge/types'

export type {
  DomainManifest,
  DomainAccess,
  DomainSelection,
  DomainExpansionRecord,
} from '@forge/types'

/**
 * Risk surface a capability can touch. Aligns with the AGENTS.md
 * `Risk Model` section — high-severity capabilities (auth, billing,
 * migrations) demand broader verification and human review.
 */
export type CapabilityRiskLevel = 'low' | 'medium' | 'high' | 'critical'

/**
 * Category of the capability. Drives the router's clustering
 * (e.g. an `auth.*` capability maps to the `auth` domain
 * automatically; `tests.*` is always co-routed with the touched
 * domain).
 */
export type CapabilityCategory =
  | 'repo_graph'
  | 'auth'
  | 'database'
  | 'frontend'
  | 'tests'
  | 'verification'
  | 'pr'
  | 'infra'
  | 'billing'
  | 'security'
  | 'migrations'
  | 'general'

/**
 * Cost to run this capability. Combined with `risk` to influence
 * probe scoring in `probes.ts`.
 */
export type CapabilityCost = 'low' | 'medium' | 'high'

/**
 * Information gain a capability typically produces. Mirrors the
 * `ProbeRecommendation.expectedInformationGain` enum.
 */
export type CapabilityGain = 'low' | 'medium' | 'high'

/**
 * Permission tag — coarse-grained, used by the router and the
 * probe planner to filter capabilities to those the harness has
 * granted for the current task mode.
 */
export type CapabilityPermission =
  | 'read_repo_graph'
  | 'read_source'
  | 'read_database_schema'
  | 'read_migrations'
  | 'read_policies'
  | 'read_routes'
  | 'read_components'
  | 'run_test'
  | 'run_typecheck'
  | 'run_lint'
  | 'run_command'
  | 'write_repo_graph'
  | 'no_permission_required'

/**
 * Typed descriptor for a single capability exposed by a domain.
 * Mirrors the strong capability surface in AGENTS.md §4 (e.g.
 * `auth.trace_permission_check`, `db.find_migrations_touching_table`).
 */
export interface CapabilityDescriptor {
  /** Dotted capability name, e.g. `auth.trace_permission_check`. */
  readonly name: string
  /** Which domain owns this capability. Used by the router. */
  readonly domain: string
  readonly category: CapabilityCategory
  readonly risk: CapabilityRiskLevel
  readonly cost: CapabilityCost
  readonly gain: CapabilityGain
  readonly requiredPermissions: readonly CapabilityPermission[]
  /** Human-readable description shown in the TUI probe queue. */
  readonly description: string
  /**
   * Free-form JSON-schema-ish input keys. Used by the router to
   * pull a capability into context only when the matching task
   * tokens suggest that input is available.
   */
  readonly inputHints: readonly string[]
  /**
   * Free-form tags used by the router for keyword-based
   * matching — e.g. an `auth` capability has tags like
   * `["permission", "role", "guard"]`.
   */
  readonly tags: readonly string[]
  /**
   * Suggested follow-on capabilities. Helps the router emit a
   * useful `selected_capabilities` list (probe 1 → probe 2 → …).
   */
  readonly suggestedFollowUps: readonly string[]
}

/**
 * A manifest plus the capability descriptors it exposes. The router
 * iterates the `capabilities` array to build the `selected_capabilities`
 * list, and the `manifest` to enforce write/read permission boundaries.
 */
export interface DomainEntry {
  readonly manifest: DomainManifest
  readonly capabilities: readonly CapabilityDescriptor[]
}

/**
 * The frozen, keyed-by-name collection of every domain Forge ships
 * with out of the box. Adding a new domain = adding a new entry; the
 * router and the probe layer pick it up automatically.
 */
export interface DomainManifests {
  readonly byName: Readonly<Record<string, DomainEntry>>
  readonly all: readonly DomainEntry[]
  /** All capability names across all domains, in registration order. */
  readonly capabilityNames: readonly string[]
  /** Look up a single capability by its dotted name. */
  findCapability(name: string): CapabilityDescriptor | undefined
  /** List the capabilities exposed by a domain. */
  capabilitiesFor(domain: string): readonly CapabilityDescriptor[]
}
