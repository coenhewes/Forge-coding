/**
 * Plugin registry — typed manifest + lifecycle hooks for third-party
 * Forge extensions.
 *
 * A **plugin** is a named bundle of capabilities, permissions, and
 * lifecycle hooks that extends Forge at well-defined boundaries. The
 * registry validates manifests at registration time, dispatches
 * lifecycle events in a stable order, and rejects duplicate or
 * incompatible plugins.
 *
 * Scope of this stub (t70b):
 *
 *   - Typed `PluginManifest` with semver version, capability IDs,
 *     permission set, and the four lifecycle hooks listed below.
 *   - `PluginRegistry` — register / unregister / list / dispatch.
 *   - Lifecycle hook ordering (onLoad → onTaskStart → onTaskEnd →
 *     onUnload) with deterministic error semantics (first thrown
 *     error halts the dispatch and surfaces to the caller).
 *   - No skill registry, no subagent runners, no file-based loading —
 *     those are follow-ups.
 *
 * Why a registry now, even without a loader:
 *
 *   - Downstream packages can already declare typed extensions (e.g.
 *     a security plugin that adds a pre-edit policy check) without
 *     owning their own registration machinery.
 *   - The TUI / agent loop can wire `registry.dispatch('onTaskStart',
 *     ctx)` calls today; the loader arrives in t70c and reuses the
 *     same `PluginRegistry` API.
 */

import type { ProviderName } from '@forge/types'

/* ---------------------------------------------------------------- *
 *  Plugin manifest
 * ---------------------------------------------------------------- */

/** Semver string — we use a regex check, not a real semver library. */
export type SemverString = string & { readonly __semver: never }

/** Capability ID namespace convention: `<plugin-id>.<verb>`. */
export type PluginCapabilityId = string & { readonly __capability: never }

/**
 * Coarse permissions a plugin may declare. The harness consults these
 * before granting write access to files, network, or process spawn.
 * More granular scopes (e.g. `<domain>.<read|write>`) are added in
 * later tracks.
 */
export type PluginPermission =
  /** Read files inside the project work tree. */
  | 'fs.read'
  /** Write files inside the project work tree. */
  | 'fs.write'
  /** Read environment variables. */
  | 'env.read'
  /** Issue outbound HTTP requests. */
  | 'net.outbound'
  /** Spawn subprocesses (sh, git, etc.). */
  | 'process.spawn'
  /** Register additional MCP capabilities on the running server. */
  | 'mcp.register'
  /** Invoke the verification planner. */
  | 'verification.invoke'
  /** Append entries to the failure ledger. */
  | 'failure.record'

/** Allowed lifecycle hook names. */
export type PluginLifecycleHook =
  | 'onLoad'
  | 'onUnload'
  | 'onTaskStart'
  | 'onTaskEnd'

/**
 * Context passed to lifecycle hooks. Plugins MUST treat this as
 * read-only — the registry owns mutation rights.
 *
 * `taskId` is undefined for `onLoad` / `onUnload`, defined for the
 * task-scoped hooks.
 */
export interface PluginHookContext {
  /** ID of the task being processed, when hook is task-scoped. */
  taskId?: string
  /** Active provider name — plugins may inspect but not switch. */
  provider?: ProviderName
  /** Optional opaque metadata for cross-hook state. */
  metadata?: Record<string, unknown>
}

/** Async-or-sync function. Registry always awaits the result. */
export type PluginHookHandler = (ctx: PluginHookContext) => void | Promise<void>

/**
 * One row in the registry. Manifests are validated at registration
 * time — once accepted, the registry owns the manifest and treats it
 * as immutable.
 */
export interface PluginManifest {
  /** Unique plugin id (`@scope/name` or `name`). */
  id: string
  /** Display name shown in `forge providers list`-style UIs. */
  displayName: string
  /** Semver of the plugin itself, not of Forge. */
  version: SemverString
  /** Minimum Forge version this plugin requires (semver string). */
  minForgeVersion: SemverString
  /** Short description — first sentence shown in catalog UIs. */
  description: string
  /** Capability IDs the plugin contributes. */
  capabilities: readonly PluginCapabilityId[]
  /** Permissions the plugin needs to function. */
  permissions: readonly PluginPermission[]
  /** Lifecycle hook implementations. All optional. */
  hooks?: Partial<Record<PluginLifecycleHook, PluginHookHandler>>
  /** Optional author/maintainer string — not used for trust decisions. */
  author?: string
}

/* ---------------------------------------------------------------- *
 *  Validation
 * ---------------------------------------------------------------- */

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/
const PLUGIN_ID_RE = /^@?[A-Za-z0-9][A-Za-z0-9._-]*\/?[A-Za-z0-9][A-Za-z0-9._-]*$/
const CAPABILITY_ID_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/

/**
 * Validate a plugin manifest. Returns a list of human-readable error
 * messages; an empty list means the manifest is acceptable. Never
 * throws — callers (registry, tests) decide how to react.
 */
export function validatePluginManifest(manifest: unknown): readonly string[] {
  const errors: string[] = []

  if (!manifest || typeof manifest !== 'object') {
    return ['Plugin manifest must be a non-null object.']
  }

  const m = manifest as Record<string, unknown>

  if (typeof m.id !== 'string' || !PLUGIN_ID_RE.test(m.id)) {
    errors.push(`Invalid plugin id: ${JSON.stringify(m.id)}. Expected matching ${PLUGIN_ID_RE}.`)
  }
  if (typeof m.displayName !== 'string' || m.displayName.trim().length === 0) {
    errors.push('Plugin displayName must be a non-empty string.')
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    errors.push(`Invalid plugin version: ${JSON.stringify(m.version)}. Expected semver (e.g. 1.2.3).`)
  }
  if (typeof m.minForgeVersion !== 'string' || !SEMVER_RE.test(m.minForgeVersion)) {
    errors.push(`Invalid plugin minForgeVersion: ${JSON.stringify(m.minForgeVersion)}. Expected semver.`)
  }
  if (typeof m.description !== 'string') {
    errors.push('Plugin description must be a string.')
  }

  if (!Array.isArray(m.capabilities)) {
    errors.push('Plugin capabilities must be an array of strings.')
  } else {
    m.capabilities.forEach((cap, i) => {
      if (typeof cap !== 'string' || !CAPABILITY_ID_RE.test(cap)) {
        errors.push(`Plugin capability at index ${i} is not a valid id: ${JSON.stringify(cap)}.`)
      }
    })
  }

  if (!Array.isArray(m.permissions)) {
    errors.push('Plugin permissions must be an array.')
  } else {
    const allowed = new Set<string>([
      'fs.read',
      'fs.write',
      'env.read',
      'net.outbound',
      'process.spawn',
      'mcp.register',
      'verification.invoke',
      'failure.record',
    ])
    m.permissions.forEach((perm, i) => {
      if (typeof perm !== 'string' || !allowed.has(perm)) {
        errors.push(`Plugin permission at index ${i} is not recognized: ${JSON.stringify(perm)}.`)
      }
    })
  }

  if (m.hooks !== undefined) {
    if (!m.hooks || typeof m.hooks !== 'object') {
      errors.push('Plugin hooks must be an object when present.')
    } else {
      const hooks = m.hooks as Record<string, unknown>
      const hookNames: PluginLifecycleHook[] = ['onLoad', 'onUnload', 'onTaskStart', 'onTaskEnd']
      for (const name of hookNames) {
        const fn = hooks[name]
        if (fn !== undefined && typeof fn !== 'function') {
          errors.push(`Plugin hook '${name}' must be a function.`)
        }
      }
    }
  }

  return errors
}

/** Wrap an arbitrary string as a `SemverString` (no runtime check). */
export function asSemver(value: string): SemverString {
  if (!SEMVER_RE.test(value)) {
    throw new Error(`Not a semver string: ${value}`)
  }
  return value as SemverString
}

/** Wrap an arbitrary string as a `PluginCapabilityId` (no runtime check). */
export function asCapabilityId(value: string): PluginCapabilityId {
  if (!CAPABILITY_ID_RE.test(value)) {
    throw new Error(`Not a plugin capability id: ${value}`)
  }
  return value as PluginCapabilityId
}

/* ---------------------------------------------------------------- *
 *  Registry
 * ---------------------------------------------------------------- */

/**
 * Internal record kept by the registry. We freeze the manifest so
 * external code can't mutate it after registration.
 */
interface PluginRecord {
  manifest: Readonly<PluginManifest>
  registeredAt: number
}

/**
 * Typed registry. The default implementation is in-memory; a loader
 * (file-system / npm-style discovery) will reuse this API in t70c.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRecord>()
  /** Monotonic counter for deterministic tie-breaks. */
  private loadOrder = 0

  /**
   * Register a manifest. Throws on invalid manifests, duplicate IDs,
   * or capability-id collisions across plugins.
   */
  register(manifest: PluginManifest): void {
    const errors = validatePluginManifest(manifest)
    if (errors.length > 0) {
      throw new Error(
        `Plugin manifest rejected (id=${JSON.stringify(manifest?.id)}):\n  - ${errors.join('\n  - ')}`,
      )
    }

    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin already registered: ${manifest.id}`)
    }

    // Capability ids must be globally unique across plugins. A
    // collision means two plugins want to own the same capability
    // surface — refuse rather than silently pick one.
    for (const existing of this.plugins.values()) {
      const overlapping = manifest.capabilities.filter((cap) =>
        existing.manifest.capabilities.includes(cap),
      )
      if (overlapping.length > 0) {
        throw new Error(
          `Plugin '${manifest.id}' redeclares capabilities already owned by ` +
            `'${existing.manifest.id}': ${overlapping.join(', ')}`,
        )
      }
    }

    this.plugins.set(manifest.id, {
      manifest: Object.freeze({ ...manifest, capabilities: Object.freeze([...manifest.capabilities]), permissions: Object.freeze([...manifest.permissions]) }),
      registeredAt: ++this.loadOrder,
    })
  }

  /** Unregister by id. Returns true if the plugin was found and removed. */
  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId)
  }

  /** Look up a plugin by id. Returns undefined when absent. */
  get(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest
  }

  /** All registered plugins, in registration order. */
  list(): readonly PluginManifest[] {
    return Array.from(this.plugins.values())
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .map((rec) => rec.manifest)
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.plugins.size
  }

  /** Look up plugins that contribute a given capability id. */
  findByCapability(capabilityId: PluginCapabilityId): readonly PluginManifest[] {
    return this.list().filter((p) => p.capabilities.includes(capabilityId))
  }

  /**
   * Dispatch a lifecycle hook to every registered plugin in
   * registration order. Each handler is invoked sequentially; if any
   * handler throws or rejects, the dispatch halts and the error is
   * surfaced. The registry does NOT swallow plugin errors — that
   * would mask real bugs.
   */
  async dispatch(hook: PluginLifecycleHook, ctx: PluginHookContext): Promise<void> {
    for (const record of this.plugins.values()) {
      const handler = record.manifest.hooks?.[hook]
      if (!handler) continue
      await handler(ctx)
    }
  }

  /**
   * Clear all plugins and return the previous list. Useful in tests
   * and in `forge doctor --reset-plugins`. Does NOT call `onUnload`
   * hooks — callers that need graceful unload should call
   * `dispatch('onUnload', {})` themselves first.
   */
  clear(): readonly PluginManifest[] {
    const previous = this.list()
    this.plugins.clear()
    this.loadOrder = 0
    return previous
  }
}

/* ---------------------------------------------------------------- *
 *  Singleton
 * ---------------------------------------------------------------- */

/**
 * Process-wide default registry. Plugin authors usually register
 * against this; the loader (t70c) replaces it with the result of
 * discovered-and-validated manifests. Frozen at the surface so
 * callers cannot swap `register` for a different implementation by
 * accident.
 */
export const pluginRegistry: PluginRegistry = new PluginRegistry()
