/**
 * Plugin subsystem barrel. The plugin layer is intentionally minimal
 * in t70b — typed manifest + registry, no loader, no skills, no
 * subagents. Later tracks (t70c) add file-system discovery.
 */
export * from './registry.js'
