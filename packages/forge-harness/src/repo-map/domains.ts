import type { OwnershipBoundary, ArchitecturalConvention, DomainBoundary, RiskArea } from '@forge/types'

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  '.next/**',
  '.forge/**',
  'build/**',
  'coverage/**',
]

const DOMAIN_PATTERNS: Record<string, string[]> = {
  frontend: ['app/**', 'pages/**', 'src/app/**', 'src/pages/**', 'components/**', 'src/components/**'],
  backend: ['api/**', 'src/api/**', 'server/**', 'src/server/**'],
  auth: ['auth/**', 'src/auth/**', '**/auth/**', '**/guards/**', '**/middleware/auth*'],
  database: ['prisma/**', 'db/**', 'src/db/**', 'database/**', 'migrations/**', 'drizzle/**'],
  tests: ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', 'e2e/**', 'cypress/**', 'test/**', 'tests/**'],
  infra: ['.github/**', 'Dockerfile*', 'docker-compose*', 'k8s/**', 'terraform/**', 'infra/**'],
  docs: ['docs/**', '*.md', 'documentation/**'],
  ci: ['.github/**', '.gitlab-ci.yml', 'Jenkinsfile*', '.circleci/**'],
  api: ['**/routes/**', '**/api/**', '**/trpc/**', '**/graphql/**'],
  permissions: ['**/permissions/**', '**/policies/**', '**/rbac/**', '**/authorization/**'],
  email: ['**/email/**', '**/mail/**', '**/notifications/**'],
  shared: ['packages/shared/**', 'packages/common/**', 'packages/ui/**', 'lib/**', 'src/lib/**'],
}

const RISK_PATTERNS: RiskArea[] = [
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

export async function discoverOwnership(root: string): Promise<{
  ownershipBoundaries: OwnershipBoundary[]
  architecturalConventions: ArchitecturalConvention[]
  domainBoundaries: DomainBoundary[]
  riskSensitiveAreas: RiskArea[]
}> {
  const ownershipBoundaries = buildOwnershipBoundaries(root)
  const domainBoundaries = buildDomainBoundaries()
  const riskSensitiveAreas = [...RISK_PATTERNS]
  const architecturalConventions = await discoverConventions(root)

  return { ownershipBoundaries, architecturalConventions, domainBoundaries, riskSensitiveAreas }
}

function buildOwnershipBoundaries(root: string): OwnershipBoundary[] {
  const rootName = root.split('/').pop() ?? 'project'
  return [
    {
      name: `${rootName}-root`,
      patterns: ['*'],
      owners: [],
    },
    {
      name: `${rootName}-packages`,
      patterns: ['packages/*'],
      owners: [],
    },
    {
      name: `${rootName}-apps`,
      patterns: ['apps/*'],
      owners: [],
    },
  ]
}

function buildDomainBoundaries(): DomainBoundary[] {
  return Object.entries(DOMAIN_PATTERNS).map(([domain, patterns]) => ({
    domain,
    patterns,
  }))
}

async function discoverConventions(root: string): Promise<ArchitecturalConvention[]> {
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

  return conventions
}
