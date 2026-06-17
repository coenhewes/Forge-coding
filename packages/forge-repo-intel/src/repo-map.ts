import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolve } from 'node:path'
import type {
  RepoMap,
  PackageInfo,
  AppInfo,
  EntrypointInfo,
  RouteInfo,
  ServiceInfo,
  ComponentInfo,
  DatabaseInfo,
  TableInfo,
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
import { discoverPackages } from './commands.js'
import { discoverOwnership, type OwnershipResult } from './ownership.js'
import { findEntries, isSourceFile, isTestFile, walkRepoIntel } from './walker.js'

/**
 * Options accepted by `scanRepository`.
 */
export interface RepoIntelScanOptions {
  /** Max directory depth to walk. Defaults to 12. */
  depth?: number
  /** Include git history (recent commits, active branch, changed files). Defaults to true. */
  enableGit?: boolean
  /** Cache results to disk under `.forge/repo-intel/`. Defaults to false. */
  persist?: boolean
}

/**
 * High-level entry point. Walk the repo, parse every discoverable
 * artifact, and return a fully-populated `RepoMap` ready for the
 * agent loop's domain router, verification planner, and TUI
 * dashboard.
 *
 * The scanner fans out to four sub-discoverers in parallel:
 *
 *   - `discoverPackages` → packages, apps, entrypoints, commands
 *   - `discoverRoutesAndServices` → routes, services, components
 *   - `discoverDatabase` → database schema + migrations
 *   - `discoverTests` → test suites with framework detection
 *   - `discoverOwnership` → ownership + domains + risk + conventions
 *   - `discoverGitHistory` → recent commits + branch info (optional)
 *
 * All discoverers are permissive — a malformed file is silently
 * skipped rather than aborting the scan. This keeps `scanRepository`
 * robust on partial checkouts and during long-horizon sessions where
 * files are added/removed concurrently.
 */
export async function scanRepository(
  root: string,
  options?: RepoIntelScanOptions,
): Promise<RepoMap> {
  const resolvedRoot = resolve(root)
  const enableGit = options?.enableGit ?? true

  const [packagesInfo, routeInfo, dbInfo, tests, ownership, gitHistory] = await Promise.all([
    discoverPackages(resolvedRoot),
    discoverRoutesAndServices(resolvedRoot),
    discoverDatabase(resolvedRoot),
    discoverTests(resolvedRoot),
    discoverOwnership(resolvedRoot),
    enableGit ? discoverGitHistory(resolvedRoot) : Promise.resolve(undefined),
  ])

  if (options?.persist) {
    await persistRepoMap(resolvedRoot, {
      packages: packagesInfo.packages,
      apps: packagesInfo.apps,
      entrypoints: packagesInfo.entrypoints,
      routes: routeInfo.routes,
      services: routeInfo.services,
      components: routeInfo.components,
      database: dbInfo.database,
      migrations: dbInfo.migrations,
      testSuites: tests,
      buildCommands: packagesInfo.buildCommands,
      lintCommands: packagesInfo.lintCommands,
      typecheckCommands: packagesInfo.typecheckCommands,
      ownershipBoundaries: ownership.ownershipBoundaries,
      architecturalConventions: ownership.architecturalConventions,
      domainBoundaries: ownership.domainBoundaries,
      riskSensitiveAreas: ownership.riskSensitiveAreas,
      recentGitHistory: gitHistory,
    }).catch(() => undefined)
  }

  return {
    packages: packagesInfo.packages,
    apps: packagesInfo.apps,
    entrypoints: packagesInfo.entrypoints,
    routes: routeInfo.routes,
    services: routeInfo.services,
    components: routeInfo.components,
    database: dbInfo.database,
    migrations: dbInfo.migrations,
    testSuites: tests,
    buildCommands: packagesInfo.buildCommands,
    lintCommands: packagesInfo.lintCommands,
    typecheckCommands: packagesInfo.typecheckCommands,
    ownershipBoundaries: ownership.ownershipBoundaries,
    architecturalConventions: ownership.architecturalConventions,
    domainBoundaries: ownership.domainBoundaries,
    riskSensitiveAreas: ownership.riskSensitiveAreas,
    recentGitHistory: gitHistory,
  }
}

/**
 * The main agent-loop accessor. Wraps `scanRepository` and applies
 * project-specific overrides (CODEOWNERS, forge field) so callers
 * don't have to plumb those through manually.
 */
export class RepoIntel {
  private cache: RepoMap | null = null
  private readonly root: string

  constructor(root: string, private readonly options?: RepoIntelScanOptions) {
    this.root = resolve(root)
  }

  /**
   * Build (or return the cached) `RepoMap`. The cache is invalidated
   * by `invalidate()`. Callers that need fresh data after a known
   * repository mutation should call `invalidate()` first.
   */
  async build(): Promise<RepoMap> {
    if (this.cache) return this.cache
    this.cache = await scanRepository(this.root, this.options)
    return this.cache
  }

  /** Force the next `build()` to re-walk the repo. */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Convenience: list every package the workspace declares. Useful
   * for capability registries that need to register one handler per
   * package.
   */
  async listPackages(): Promise<PackageInfo[]> {
    const map = await this.build()
    return map.packages
  }

  /**
   * Convenience: list every risk area. Mirrors `riskSensitiveAreas`
   * from the underlying `RepoMap`, but exposed here so callers that
   * only have a `RepoIntel` instance don't need to re-fetch the map.
   */
  async listRiskAreas(): Promise<RiskArea[]> {
    const map = await this.build()
    return map.riskSensitiveAreas
  }

  /**
   * Convenience: which risk areas does `filePath` touch?
   */
  async risksFor(filePath: string): Promise<RiskArea[]> {
    const map = await this.build()
    return map.riskSensitiveAreas.filter((area) =>
      area.paths.some((p) => matchesGlob(p, filePath)),
    )
  }
}

// ---------------------------------------------------------------------------
//  Routes / services / components
// ---------------------------------------------------------------------------

async function discoverRoutesAndServices(root: string): Promise<{
  routes: RouteInfo[]
  services: ServiceInfo[]
  components: ComponentInfo[]
}> {
  const [routes, services, components] = await Promise.all([
    discoverRoutes(root),
    discoverServices(root),
    discoverComponents(root),
  ])
  return { routes, services, components }
}

async function discoverRoutes(root: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = []
  for await (const entry of walkRepoIntel(root)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue
    const rel = entry.relativePath

    try {
      const content = await readFile(entry.path, 'utf-8')

      // Next.js App Router: file-based pages
      if (rel.includes('/app/') && (rel.endsWith('/page.tsx') || rel.endsWith('/page.js') || rel.endsWith('/page.jsx'))) {
        const routePath = '/' + rel
          .replace(/^.*?\/app\//, '')
          .replace(/\/page\.(tsx|jsx|js|ts)$/, '')
          .replace(/\[\.\.\.(\w+)\]/g, ':$1*')
          .replace(/\[(\w+)\]/g, ':$1')
          .replace(/\/\(.*?\)/g, '')
          .replace(/\/index$/, '') || '/'

        routes.push({ path: routePath, handler: rel.split('/').pop() ?? 'page', file: entry.path, middleware: [] })
      }

      // Next.js App Router API routes
      if (rel.includes('/app/') && (rel.endsWith('/route.ts') || rel.endsWith('/route.js'))) {
        const routePath = '/' + rel
          .replace(/^.*?\/app\//, '')
          .replace(/\/route\.(ts|js)$/, '')
          .replace(/\[\.\.\.(\w+)\]/g, ':$1*')
          .replace(/\[(\w+)\]/g, ':$1')
          .replace(/\/\(.*?\)/g, '')

        const methods = extractHttpMethods(content)
        for (const method of methods) {
          routes.push({
            method,
            path: routePath,
            handler: `${method} ${rel.split('/').pop() ?? 'route'}`,
            file: entry.path,
          })
        }
      }

      // Express-style route discovery
      const expressRoutePattern = /(app|router)\.(get|post|put|patch|delete|options)\s*\(\s*['"`]([^'"`]+)['"`]/g
      let match: RegExpExecArray | null
      while ((match = expressRoutePattern.exec(content)) !== null) {
        routes.push({
          method: match[2]!.toUpperCase(),
          path: match[3]!,
          handler: match[0]!.split(',')[1]?.trim() ?? 'handler',
          file: entry.path,
        })
      }
    } catch {
      // skip unreadable files
    }
  }
  return routes
}

async function discoverServices(root: string): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = []
  for await (const entry of walkRepoIntel(root)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue
    const rel = entry.relativePath
    const isServiceDir = rel.includes('/services/') || rel.includes('/service/')
    const isServiceFile = rel.endsWith('.service.ts') || rel.endsWith('.service.js')
    const isLibDir = rel.includes('/lib/')
    if (!(isServiceDir || isServiceFile || isLibDir)) continue
    try {
      const content = await readFile(entry.path, 'utf-8')
      const exports = extractExports(content)
      if (exports.length > 0) {
        services.push({
          name: entry.relativePath.split('/').pop()?.replace(/\.(ts|js)$/, '') ?? 'unknown',
          path: entry.path,
          exportedNames: exports,
        })
      }
    } catch {
      // skip
    }
  }
  return services
}

async function discoverComponents(root: string): Promise<ComponentInfo[]> {
  const components: ComponentInfo[] = []
  for await (const entry of walkRepoIntel(root)) {
    if (entry.isDirectory) continue
    const ext = entry.path.split('.').pop()
    if (ext !== 'tsx' && ext !== 'jsx') continue
    const rel = entry.relativePath
    if (rel.includes('test') || rel.includes('spec') || rel.includes('config')) continue
    try {
      const content = await readFile(entry.path, 'utf-8')
      const componentName = extractComponentName(content, entry.path)
      if (componentName) {
        components.push({ name: componentName, path: entry.path, framework: 'react' })
      }
    } catch {
      // skip
    }
  }
  return components
}

// ---------------------------------------------------------------------------
//  Database + migrations
// ---------------------------------------------------------------------------

async function discoverDatabase(root: string): Promise<{
  database: DatabaseInfo | null
  migrations: MigrationInfo[]
}> {
  const database = await findDatabaseSchema(root)
  const migrations = await discoverMigrations(root)
  return { database, migrations }
}

async function findDatabaseSchema(root: string): Promise<DatabaseInfo | null> {
  const prismaFiles = await findEntries(
    root,
    (e) => !e.isDirectory && e.relativePath.endsWith('schema.prisma') && !e.relativePath.includes('node_modules'),
  )
  if (prismaFiles.length > 0) return parsePrismaSchema(prismaFiles[0]!.path)

  const knexFiles = await findEntries(root, (e) =>
    !e.isDirectory && (e.relativePath.endsWith('knexfile.ts') || e.relativePath.endsWith('knexfile.js')),
  )
  if (knexFiles.length > 0) return { type: 'postgres', tables: [], orm: 'knex' }

  const drizzleFiles = await findEntries(root, (e) =>
    !e.isDirectory && (e.relativePath.includes('drizzle.config') || e.relativePath.includes('drizzle/')),
  )
  if (drizzleFiles.length > 0) return { type: 'postgres', tables: [], orm: 'drizzle' }

  return null
}

async function parsePrismaSchema(schemaPath: string): Promise<DatabaseInfo> {
  try {
    const content = await readFile(schemaPath, 'utf-8')
    const tables: TableInfo[] = []
    const providerMatch = content.match(/provider\s*=\s*["'](\w+)["']/)
    const provider = providerMatch?.[1]?.toLowerCase() ?? 'postgres'
    const dbType: DatabaseInfo['type'] =
      provider === 'mysql' ? 'mysql'
        : provider === 'sqlite' ? 'sqlite'
        : provider === 'mongodb' ? 'mongodb'
        : 'postgres'

    const modelRegex = /model\s+(\w+)\s*\{([^}]+\})\s*\}/gs
    let modelMatch: RegExpExecArray | null
    while ((modelMatch = modelRegex.exec(content)) !== null) {
      const tableName = modelMatch[1]!
      const block = modelMatch[2]!
      tables.push({ name: tableName, columns: parsePrismaFields(block) })
    }
    return { type: dbType, tables, orm: 'prisma' }
  } catch {
    return { type: 'postgres', tables: [], orm: 'prisma' }
  }
}

function parsePrismaFields(block: string): TableInfo['columns'] {
  const columns: TableInfo['columns'] = []
  const fieldRegex = /^\s{2,}(\w+)\s+(\w+(?:\[\])?)\s*(@\w+(?:\([^)]*\))?)?/gm
  let match: RegExpExecArray | null
  while ((match = fieldRegex.exec(block)) !== null) {
    const name = match[1]!
    const type = match[2]!
    const attrs = match[3] ?? ''
    columns.push({
      name,
      type,
      nullable: !attrs.includes('@required'),
      primaryKey: attrs.includes('@id'),
      foreignKey: attrs.includes('@relation') ? name : undefined,
    })
  }
  return columns
}

async function discoverMigrations(root: string): Promise<MigrationInfo[]> {
  const migrations: MigrationInfo[] = []
  for await (const entry of walkRepoIntel(root)) {
    if (entry.isDirectory && entry.relativePath.includes('prisma/migrations/')) {
      const migrationName = basename(entry.path)
      const migrationDir = entry.path
      try {
        const ok = await readFile(join(migrationDir, 'migration.sql'), 'utf-8').then(() => true).catch(() => false)
        if (ok) {
          const sql = await readFile(join(migrationDir, 'migration.sql'), 'utf-8').catch(() => '')
          migrations.push({
            name: migrationName,
            path: migrationDir,
            timestamp: migrationName.split('_')[0] ?? migrationName,
            state: 'applied',
            tablesTouched: extractTablesFromSql(sql),
          })
        }
      } catch {
        // skip
      }
    }
  }
  return migrations
}

function extractTablesFromSql(sql: string): string[] {
  const tables = new Set<string>()
  const tableRegex = /(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?\w+["'`]?\.)?["'`]?(\w+)["'`]?/gi
  let match: RegExpExecArray | null
  while ((match = tableRegex.exec(sql)) !== null) {
    if (match[1]) tables.add(match[1])
  }
  return Array.from(tables)
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

const FRAMEWORK_INDICATORS: Record<string, string[]> = {
  vitest: ['vitest.config', 'vite.config'],
  jest: ['jest.config', 'jest.config.js', 'jest.config.ts'],
  mocha: ['.mocharc', 'mocha.opts'],
  playwright: ['playwright.config', 'playwright-ct.config'],
  cypress: ['cypress.config', 'cypress.json'],
  ava: ['ava.config'],
  uvu: [],
}

async function discoverTests(root: string): Promise<TestSuiteInfo[]> {
  const testSuites: Map<string, TestSuiteInfo> = new Map()
  const framework = await detectTestFramework(root)

  for await (const entry of walkRepoIntel(root)) {
    if (entry.isDirectory) continue
    if (!isTestFile(entry.relativePath)) continue
    const relPath = entry.relativePath
    const className = deriveTestSuiteName(relPath)
    const baseDir = findTestBaseDir(relPath)
    if (!baseDir) continue
    const existing = testSuites.get(baseDir)
    if (existing) {
      existing.files.push(entry.path)
    } else {
      testSuites.set(baseDir, {
        name: className,
        path: baseDir,
        framework,
        type: deriveTestType(relPath),
        files: [entry.path],
      })
    }
  }
  return Array.from(testSuites.values())
}

async function detectTestFramework(root: string): Promise<string> {
  for (const [framework, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
    for (const indicator of indicators) {
      const found = await findEntries(
        root,
        (e) => !e.isDirectory && e.relativePath.includes(indicator),
        { maxDepth: 3 },
      )
      if (found.length > 0) return framework
    }
  }
  try {
    const content = await readFile(join(root, 'package.json'), 'utf-8')
    const json = JSON.parse(content) as Record<string, unknown>
    const deps = {
      ...((json.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((json.devDependencies as Record<string, unknown> | undefined) ?? {}),
    }
    if ('vitest' in deps) return 'vitest'
    if ('jest' in deps) return 'jest'
    if ('playwright' in deps) return 'playwright'
    if ('cypress' in deps) return 'cypress'
    if ('mocha' in deps) return 'mocha'
  } catch {
    // fall through
  }
  return 'unknown'
}

function deriveTestSuiteName(relPath: string): string {
  const parts = relPath.split('/')
  const testDirIndex = parts.findIndex((p) => p === '__tests__' || p === 'test' || p === 'tests')
  if (testDirIndex >= 0) return parts.slice(0, testDirIndex + 1).join('/')
  return parts[parts.length - 1]?.replace(/\.(test|spec|e2e)\.\w+$/, '') ?? 'unknown'
}

function findTestBaseDir(relPath: string): string | null {
  const parts = relPath.split('/')
  const testDirIndex = parts.findIndex((p) => p === '__tests__' || p === 'test' || p === 'tests')
  if (testDirIndex >= 0) return parts.slice(0, testDirIndex + 1).join('/')
  return parts.slice(0, -1).join('/') || null
}

function deriveTestType(relPath: string): TestSuiteInfo['type'] {
  if (relPath.includes('/e2e/') || relPath.endsWith('.e2e.ts') || relPath.endsWith('.e2e.tsx')) return 'e2e'
  if (relPath.includes('/integration/') || relPath.endsWith('.integration.ts')) return 'integration'
  if (relPath.includes('/visual/') || relPath.includes('/screenshot/')) return 'visual'
  return 'unit'
}

// ---------------------------------------------------------------------------
//  Git history
// ---------------------------------------------------------------------------

async function discoverGitHistory(root: string): Promise<GitHistory | undefined> {
  try {
    const recentCommits = getRecentCommits(root)
    const activeBranch = getActiveBranch(root)
    const changedFiles = getChangedFiles(root)
    return { recentCommits, activeBranch, changedFiles }
  } catch {
    return undefined
  }
}

function getRecentCommits(root: string, count = 10): GitCommit[] {
  try {
    const output = execSync(
      `git log --oneline -${count} --format="%H||%s||%an||%aI"`,
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 },
    )
    return output.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('||')
      const hash = parts[0] ?? ''
      const message = parts[1] ?? ''
      const author = parts[2] ?? ''
      const date = parts[3] ?? ''

      let files: string[] = []
      try {
        const fileOutput = execSync(
          `git diff-tree --no-commit-id --name-only -r ${hash}`,
          { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
        )
        files = fileOutput.trim().split('\n').filter(Boolean)
      } catch {
        // files not always available
      }
      return { hash, message, author, date, files }
    })
  } catch {
    return []
  }
}

function getActiveBranch(root: string): string {
  try {
    return execSync(
      'git branch --show-current',
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
    ).trim()
  } catch {
    return 'unknown'
  }
}

function getChangedFiles(root: string): string[] {
  try {
    const output = execSync(
      'git diff --name-only HEAD~5 HEAD',
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
    )
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
//  Tiny utilities
// ---------------------------------------------------------------------------

function extractHttpMethods(content: string): string[] {
  const methods: string[] = []
  const pattern = /\bexport\s+(async\s+)?(function\s+)?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) methods.push(match[3]!)
  if (methods.length === 0) methods.push('GET')
  return methods
}

function extractExports(content: string): string[] {
  const exports: string[] = []
  const exportPattern = /export\s+(?:async\s+)?(?:function|const|class|default\s+(?:function|class)?\s*)?(\w+)/g
  let match: RegExpExecArray | null
  while ((match = exportPattern.exec(content)) !== null) {
    if (match[1]) exports.push(match[1])
  }
  return exports
}

function extractComponentName(content: string, filePath: string): string | undefined {
  const exportDefault = content.match(/export\s+default\s+(?:function\s+)?(\w+)/)
  if (exportDefault?.[1]) return exportDefault[1]
  const namedExport = content.match(/export\s+(?:const|function)\s+(\w+)/)
  if (namedExport?.[1]) return namedExport[1]
  const fileName = filePath.split('/').pop()?.replace(/\.(tsx|jsx)$/, '')
  if (fileName && /^[A-Z]/.test(fileName)) return fileName
  return undefined
}

function matchesGlob(pattern: string, filePath: string): boolean {
  if (!pattern.includes('*')) return filePath === pattern || filePath.includes(pattern)
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexd = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
  return new RegExp(`(^|/)${regexd}($|/)`).test(filePath)
}

async function persistRepoMap(root: string, map: RepoMap): Promise<void> {
  const dir = join(root, '.forge', 'repo-intel')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'repo-map.json'),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        ...map,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

// Suppress unused warnings for type imports we keep for documentation.
void (null as unknown as OwnershipResult)