/**
 * @forge/repo-intel — repo-intelligence map for Forge.
 *
 * This package produces the *structured* understanding of a
 * repository: packages, apps, entrypoints, routes, services,
 * components, database schema, migrations, test suites, build /
 * lint / typecheck / test commands, ownership boundaries,
 * architectural conventions, domain boundaries, and risk areas.
 *
 * Three layers:
 *
 *   - `repo-map.ts` — orchestrator. `scanRepository(root)` returns
 *     a fully populated `RepoMap`. `RepoIntel` is the cached,
 *     invalidation-aware accessor the agent loop uses.
 *   - `commands.ts` — extracts per-package and `turbo.json` build /
 *     lint / typecheck / test commands. Backed by the package.json
 *     scripts block and the workspace orchestrator.
 *   - `ownership.ts` — derives ownership boundaries, domain
 *     boundaries, and risk-sensitive areas from a built-in table,
 *     `CODEOWNERS` files, and tsconfig presence.
 *   - `walker.ts` — shared filesystem walker (single source of
 *     truth for ignored directories and depth limits).
 *
 * The companion package is `@forge/repo-graph`, which builds the
 * structural graph (imports, exports, call sites, references). The
 * two are designed to compose: `scanRepository` feeds
 * `buildGraph(repoMap, root)`.
 */

export {
  // Orchestrator
  scanRepository,
  RepoIntel,
} from './repo-map.js'

export type {
  RepoIntelScanOptions,
} from './repo-map.js'

export {
  // Commands
  discoverPackages,
  discoverCommands,
  discoverEntrypoints,
} from './commands.js'

export type {
  DiscoveredCommands,
  DiscoverPackagesOptions,
} from './commands.js'

export {
  // Ownership / domains / risk / conventions
  discoverOwnership,
  matchDomain,
  matchRiskAreas,
  buildDomainIndex,
  parseCodeowners,
  DEFAULT_DOMAIN_PATTERNS,
  DEFAULT_RISK_PATTERNS,
} from './ownership.js'

export type {
  OwnershipResult,
} from './ownership.js'

export {
  // Walker (also re-exported from the graph package)
  walkRepoIntel,
  findEntries,
  extname,
  isSourceFile,
  isTestFile,
  DEFAULT_IGNORED_DIRS,
} from './walker.js'

export type {
  RepoIntelFileEntry,
  WalkOptions,
} from './walker.js'

// Re-export `RepoMap` and the types `@forge/types` declares so
// callers can import everything from one place.
export type {
  RepoMap,
  PackageInfo,
  AppInfo,
  EntrypointInfo,
  RouteInfo,
  ServiceInfo,
  ComponentInfo,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  MigrationInfo,
  TestSuiteInfo,
  CommandInfo,
  OwnershipBoundary,
  ArchitecturalConvention,
  DomainBoundary,
  RiskArea,
  GitHistory,
  GitCommit,
} from '@forge/types'