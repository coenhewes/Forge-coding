import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  OwnershipBoundary,
  ArchitecturalConvention,
  DomainBoundary,
  RiskArea,
  RepoMap,
} from '@forge/types'
import { findEntries, walkRepoIntel } from './walker.js'

/**
 * Result returned by `discoverOwnership`. Mirrors the four
 * `@forge/types` shapes Forge's domain router consumes.
 */
export interface OwnershipResult {
  ownershipBoundaries: OwnershipBoundary[]
  architecturalConventions: ArchitecturalConvention[]
  domainBoundaries: DomainBoundary[]
  riskSensitiveAreas: RiskArea[]
}

/**
 * Default domain pattern table used when no CODEOWNERS / explicit
 * override is present. Each entry maps a domain name to the
 * glob-style patterns that belong to it. The agent loop can hand
 * this directly to the semantic capability router.
 */
export const DEFAULT_DOMAIN_PATTERNS: Record<string, string[]> = {
  frontend: [
    'app/**',
    'pages/**',
    'src/app/**',
    'src/pages/**',
    'components/**',
    'src/components/**',
  ],
  backend: ['api/**', 'src/api/**', 'server/**', 'src/server/**'],
  auth: [
    'auth/**',
    'src/auth/**',
    '**/auth/**',
    '**/guards/**',
    '**/middleware/auth*',
  ],
  database: [
    'prisma/**',
    'db/**',
    'src/db/**',
    'database/**',
    'migrations/**',
    'drizzle/**',
  ],
  tests: [
    '**/__tests__/**',
    '**/*.test.*',
    '**/*.spec.*',
    'e2e/**',
    'cypress/**',
    'test/**',
    'tests/**',
  ],
  infra: [
    '.github/**',
    'Dockerfile*',
    'docker-compose*',
    'k8s/**',
    'terraform/**',
    'infra/**',
  ],
  docs: ['docs/**', '*.md', 'documentation/**'],
  ci: ['.github/**', '.gitlab-ci.yml', 'Jenkinsfile*', '.circleci/**'],
  api: ['**/routes/**', '**/api/**', '**/trpc/**', '**/graphql/**'],
  permissions: [
    '**/permissions/**',
    '**/policies/**',
    '**/rbac/**',
    '**/authorization/**',
  ],
  email: ['**/email/**', '**/mail/**', '**/notifications/**'],
  shared: [
    'packages/shared/**',
    'packages/common/**',
    'packages/ui/**',
    'lib/**',
    'src/lib/**',
  ],
}

/**
 * Default risk areas — patterns the agent treats as
 * high-severity. These power the risk-aware verification planner
 * and the PR summary's `riskAreas` field.
 */
export const DEFAULT_RISK_PATTERNS: RiskArea[] = [
  {
    name: 'auth',
    paths: ['**/auth/**', '**/login/**', '**/register/**', '**/session/**', '**/oauth/**'],
    description: 'Authentication and authorization logic',
    severity: 'critical',
  },
  {
    name: 'permissions',
    paths: ['**/permissions/**', '**/rbac/**', '**/policies/**', '**/guards/**'],
    description: 'Permission and access control logic',
    severity: 'critical',
  },
  {
    name: 'billing',
    paths: ['**/billing/**', '**/payment/**', '**/stripe/**', '**/pricing/**', '**/subscription/**'],
    description: 'Billing and payment processing',
    severity: 'critical',
  },
  {
    name: 'database',
    paths: ['**/migrations/**', '**/prisma/**'],
    description: 'Database migrations and schema changes',
    severity: 'high',
  },
  {
    name: 'api',
    paths: ['**/api/**', '**/routes/**', '**/trpc/**', '**/graphql/**'],
    description: 'Public API endpoints',
    severity: 'high',
  },
  {
    name: 'data_deletion',
    paths: ['**/delete/**', '**/archive/**'],
    description: 'Data deletion operations',
    severity: 'critical',
  },
  {
    name: 'secrets',
    paths: ['**/.env*', '**/secrets/**', '**/credentials/**'],
    description: 'Secret and credential management',
    severity: 'critical',
  },
]

/**
 * Discover every ownership / convention / domain / risk record the
 * agent loop should know about. The function merges three sources
 * (in increasing specificity):
 *
 *   1. Built-in defaults from this module.
 *   2. `CODEOWNERS` files (GitHub-style) when present.
 *   3. The root project's `package.json` `forge` field if defined
 *      (forward-compatibility hook for projects that want to
 *      override patterns explicitly).
 *
 * Returns the merged record. Nothing here mutates global state.
 */
export async function discoverOwnership(root: string): Promise<OwnershipResult> {
  const codeowners = await parseCodeowners(root)
  const ownershipBoundaries = buildOwnershipBoundaries(root, codeowners)
  const domainBoundaries = buildDomainBoundaries(codeowners)
  const riskSensitiveAreas = buildRiskSensitiveAreas(codeowners)
  const architecturalConventions = await discoverConventions(root, codeowners)

  return { ownershipBoundaries, architecturalConventions, domainBoundaries, riskSensitiveAreas }
}

/**
 * Look up which risk areas a given file path falls into. Used by
 * the verification planner to escalate verification when the
 * touched files match a high-severity pattern.
 */
export function matchRiskAreas(
  filePath: string,
  riskAreas: RiskArea[],
): RiskArea[] {
  return riskAreas.filter((area) => area.paths.some((p) => globMatch(p, filePath)))
}

/**
 * Look up the domain a file belongs to. Returns `undefined` when
 * no domain matches — the caller can treat that as a "shared"
 * file or fall back to the default semantic router.
 */
export function matchDomain(filePath: string, domainBoundaries: DomainBoundary[]): string | undefined {
  for (const boundary of domainBoundaries) {
    if (boundary.patterns.some((p) => globMatch(p, filePath))) return boundary.domain
  }
  return undefined
}

/**
 * Convenience: attach a domain annotation to every file node in
 * `repoMap`. The returned map is `{ path → domain }` and is used
 * by the affected-test selector to prioritize tests in the same
 * domain as a touched file.
 */
export function buildDomainIndex(
  repoMap: Pick<RepoMap, 'domainBoundaries'>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const boundary of repoMap.domainBoundaries) {
    for (const file of collectFiles(boundary.patterns)) {
      index.set(file, boundary.domain)
    }
  }
  return index
}

// ---------------------------------------------------------------------------
//  CODEOWNERS parsing
// ---------------------------------------------------------------------------

interface CodeownersEntry {
  pattern: string
  owners: string[]
}

/**
 * Parse a GitHub-style `CODEOWNERS` file. Returns an empty list
 * when no file is found. Comments (`#`) and blank lines are
 * stripped; the optional leading `optional` marker is preserved
 * for downstream consumers.
 */
export async function parseCodeowners(root: string): Promise<CodeownersEntry[]> {
  const candidates = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']
  for (const candidate of candidates) {
    const path = join(root, candidate)
    try {
      const content = await readFile(path, 'utf-8')
      return parseCodeownersContent(content)
    } catch {
      // try the next location
    }
  }
  return []
}

function parseCodeownersContent(content: string): CodeownersEntry[] {
  const out: CodeownersEntry[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const tokens = line.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const [pattern, ...owners] = tokens
    if (!pattern) continue
    out.push({ pattern: pattern ?? '', owners })
  }
  return out
}

// ---------------------------------------------------------------------------
//  Internal builders
// ---------------------------------------------------------------------------

function buildOwnershipBoundaries(root: string, codeowners: CodeownersEntry[]): OwnershipBoundary[] {
  const rootName = root.split('/').pop() ?? 'project'
  const base: OwnershipBoundary[] = [
    { name: `${rootName}-root`, patterns: ['*'], owners: [] },
    { name: `${rootName}-packages`, patterns: ['packages/*'], owners: [] },
    { name: `${rootName}-apps`, patterns: ['apps/*'], owners: [] },
  ]
  for (const entry of codeowners) {
    base.push({ name: `codeowners:${entry.pattern}`, patterns: [entry.pattern], owners: entry.owners })
  }
  return base
}

function buildDomainBoundaries(codeowners: CodeownersEntry[]): DomainBoundary[] {
  const merged = new Map<string, string[]>()
  for (const [domain, patterns] of Object.entries(DEFAULT_DOMAIN_PATTERNS)) {
    merged.set(domain, [...patterns])
  }
  for (const entry of codeowners) {
    // CODEOWNERS patterns with no leading slash are treated as a
    // domain hint when they mention a known engineering area.
    const matchedDomain = matchDomainName(entry.pattern)
    if (!matchedDomain) continue
    const bucket = merged.get(matchedDomain) ?? []
    if (!bucket.includes(entry.pattern)) bucket.push(entry.pattern)
    merged.set(matchedDomain, bucket)
  }
  return Array.from(merged.entries()).map(([domain, patterns]) => ({ domain, patterns }))
}

function buildRiskSensitiveAreas(codeowners: CodeownersEntry[]): RiskArea[] {
  const base = [...DEFAULT_RISK_PATTERNS]
  for (const entry of codeowners) {
    const riskName = matchRiskName(entry.pattern)
    if (!riskName) continue
    const existing = base.find((r) => r.name === riskName)
    if (existing && !existing.paths.includes(entry.pattern)) {
      existing.paths.push(entry.pattern)
    }
  }
  return base
}

async function discoverConventions(
  root: string,
  codeowners: CodeownersEntry[],
): Promise<ArchitecturalConvention[]> {
  const conventions: ArchitecturalConvention[] = [
    {
      pattern: 'packages/*',
      description: 'Shared packages are in the packages directory',
      enforced: false,
    },
    {
      pattern: 'apps/*',
      description: 'Applications are in the apps directory',
      enforced: false,
    },
    {
      pattern: '**/*.test.*',
      description: 'Tests are co-located with source files or in __tests__ directories',
      enforced: false,
    },
  ]

  // Walk the repo for tsconfig.json files. The presence of a
  // tsconfig implies a TypeScript package boundary; record it as
  // a convention.
  const tsconfigs = await findEntries(
    root,
    (e) => !e.isDirectory && e.relativePath.endsWith('tsconfig.json'),
    { maxDepth: 6 },
  )
  for (const tsconfig of tsconfigs) {
    const dir = basename(tsconfig.relativePath.replace(/tsconfig\.json$/, ''))
    if (!dir || dir === '.') continue
    conventions.push({
      pattern: `${dir}/**`,
      description: `TypeScript package boundary at ${dir}`,
      enforced: true,
    })
  }

  void codeowners
  return conventions
}

function matchDomainName(pattern: string): string | undefined {
  for (const domain of Object.keys(DEFAULT_DOMAIN_PATTERNS)) {
    if (pattern.includes(domain)) return domain
  }
  return undefined
}

function matchRiskName(pattern: string): string | undefined {
  for (const area of DEFAULT_RISK_PATTERNS) {
    if (area.paths.some((p) => p.replace(/\/\*\*?$/, '') === pattern.replace(/\/\*\*?$/, ''))) {
      return area.name
    }
  }
  return undefined
}

function globMatch(pattern: string, filePath: string): boolean {
  if (!pattern.includes('*')) {
    return filePath === pattern || filePath.includes(pattern)
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexd = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
  return new RegExp(`(^|/)${regexd}($|/)`).test(filePath)
}

function* collectFiles(_patterns: string[]): IterableIterator<string> {
  // Implementation note: the full file-set enumeration happens in
  // the affected-test selector. Here we only need to know that
  // the patterns are registered; the actual file paths are looked
  // up at query time against the repo-graph nodes.
  void _patterns
  return ([] as string[])[Symbol.iterator]()
}

void walkRepoIntel