import type { DomainManifest, RepoMap } from '@forge/types'

export const DEFAULT_DOMAINS: DomainManifest[] = [
  {
    domain: 'frontend',
    owns: ['app/**', 'pages/**', 'src/app/**', 'src/pages/**', 'components/**', 'src/components/**', 'ui/**', 'src/ui/**'],
    allowedReads: ['app/**', 'pages/**', 'src/**', 'components/**', 'ui/**'],
    allowedWrites: ['app/**', 'pages/**', 'src/app/**', 'src/pages/**', 'components/**', 'src/components/**', 'ui/**', 'src/ui/**'],
    relatedDomains: ['backend', 'api', 'tests', 'shared'],
    forbiddenByDefault: ['backend/**', 'api/**', 'server/**', 'database/**', 'infra/**'],
    riskProfile: ['frontend_logic'],
    verification: ['frontend_tests'],
    reviewSensitivity: 'low',
  },
  {
    domain: 'backend',
    owns: ['api/**', 'src/api/**', 'server/**', 'src/server/**', 'services/**', 'src/services/**'],
    allowedReads: ['api/**', 'src/**', 'server/**', 'database/**', 'auth/**'],
    allowedWrites: ['api/**', 'src/api/**', 'server/**', 'src/server/**', 'services/**', 'src/services/**'],
    relatedDomains: ['frontend', 'database', 'auth', 'api', 'tests'],
    forbiddenByDefault: ['frontend/**', 'ui/**', 'infra/**'],
    riskProfile: ['api_changes', 'data_handling'],
    verification: ['api_tests', 'integration_tests'],
    reviewSensitivity: 'medium',
  },
  {
    domain: 'auth',
    owns: ['auth/**', 'src/auth/**', '**/auth/**', '**/guards/**', '**/middleware/auth*', '**/permissions/**', '**/rbac/**', '**/policies/**'],
    allowedReads: ['auth/**', 'src/**', 'api/**', 'database/**', '**/users/**'],
    allowedWrites: ['auth/**', 'src/auth/**', '**/auth/**', '**/guards/**', '**/middleware/auth*', '**/permissions/**', '**/rbac/**', '**/policies/**'],
    relatedDomains: ['backend', 'database', 'frontend', 'security', 'tests'],
    forbiddenByDefault: ['billing/**', 'ui/**', 'infra/**'],
    riskProfile: ['authentication', 'authorization', 'permissions', 'security', 'access_control'],
    verification: ['auth_tests', 'permission_tests', 'auth_regression'],
    reviewSensitivity: 'critical',
  },
  {
    domain: 'database',
    owns: ['prisma/**', 'db/**', 'src/db/**', 'database/**', 'migrations/**', 'drizzle/**', 'src/migrations/**', 'schema/**'],
    allowedReads: ['prisma/**', 'db/**', 'src/**', 'migrations/**', 'database/**'],
    allowedWrites: ['prisma/**', 'db/**', 'src/db/**', 'database/**', 'migrations/**', 'drizzle/**', 'schema/**'],
    relatedDomains: ['backend', 'auth', 'api', 'tests'],
    forbiddenByDefault: ['frontend/**', 'ui/**', 'app/**', 'infra/**'],
    riskProfile: ['schema_changes', 'migrations', 'data_integrity'],
    verification: ['migration_tests', 'database_tests'],
    reviewSensitivity: 'high',
  },
  {
    domain: 'tests',
    owns: ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*', 'e2e/**', 'cypress/**', 'test/**', 'tests/**', '**/__test__/**'],
    allowedReads: ['**/*'],
    allowedWrites: ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*', 'e2e/**', 'cypress/**', 'test/**', 'tests/**', '**/__test__/**'],
    relatedDomains: ['frontend', 'backend', 'auth', 'database', 'api'],
    forbiddenByDefault: ['infra/**', 'deploy/**', 'config/**'],
    riskProfile: ['test_quality', 'coverage'],
    verification: ['test_suite'],
    reviewSensitivity: 'low',
  },
  {
    domain: 'infra',
    owns: ['.github/**', 'Dockerfile*', 'docker-compose*', 'k8s/**', 'terraform/**', 'infra/**', 'deploy/**', '.helm/**'],
    allowedReads: ['infra/**', '.github/**', '*.yml', '*.yaml'],
    allowedWrites: ['.github/**', 'Dockerfile*', 'docker-compose*', 'k8s/**', 'terraform/**', 'infra/**', 'deploy/**', '.helm/**'],
    relatedDomains: ['ci', 'backend', 'security'],
    forbiddenByDefault: ['app/**', 'src/**', 'packages/**', 'ui/**'],
    riskProfile: ['deployment', 'infrastructure', 'ci_cd'],
    verification: ['deploy_tests'],
    reviewSensitivity: 'high',
  },
  {
    domain: 'docs',
    owns: ['docs/**', '*.md', 'documentation/**', '**/*.md', 'wiki/**'],
    allowedReads: ['**/*'],
    allowedWrites: ['docs/**', '*.md', 'documentation/**', '**/*.md', 'wiki/**'],
    relatedDomains: [],
    forbiddenByDefault: ['src/**', 'app/**', 'api/**'],
    riskProfile: ['documentation'],
    verification: [],
    reviewSensitivity: 'none',
  },
  {
    domain: 'ci',
    owns: ['.github/**', '.gitlab-ci.yml', 'Jenkinsfile*', '.circleci/**', '.buildkite/**', 'ci/**'],
    allowedReads: ['.github/**', '.gitlab-ci.yml', 'Jenkinsfile*', '.circleci/**', '.buildkite/**', 'ci/**'],
    allowedWrites: ['.github/**', '.gitlab-ci.yml', 'Jenkinsfile*', '.circleci/**', '.buildkite/**', 'ci/**'],
    relatedDomains: ['infra', 'tests', 'security'],
    forbiddenByDefault: ['src/**', 'app/**', 'packages/**'],
    riskProfile: ['ci_integrity', 'build_process'],
    verification: ['ci_tests'],
    reviewSensitivity: 'medium',
  },
  {
    domain: 'api',
    owns: ['**/routes/**', '**/api/**', '**/trpc/**', '**/graphql/**', '**/endpoints/**', '**/controllers/**'],
    allowedReads: ['**/routes/**', '**/api/**', '**/shared/**', 'auth/**', 'database/**'],
    allowedWrites: ['**/routes/**', '**/api/**', '**/trpc/**', '**/graphql/**', '**/endpoints/**', '**/controllers/**'],
    relatedDomains: ['backend', 'auth', 'database', 'frontend', 'tests'],
    forbiddenByDefault: ['ui/**', 'app/**', 'infra/**'],
    riskProfile: ['api_contract', 'backward_compatibility'],
    verification: ['api_tests', 'contract_tests'],
    reviewSensitivity: 'high',
  },
  {
    domain: 'permissions',
    owns: ['**/permissions/**', '**/policies/**', '**/rbac/**', '**/authorization/**', '**/guards/**', '**/casl/**'],
    allowedReads: ['**/permissions/**', '**/policies/**', '**/rbac/**', 'auth/**', '**/users/**'],
    allowedWrites: ['**/permissions/**', '**/policies/**', '**/rbac/**', '**/authorization/**', '**/guards/**'],
    relatedDomains: ['auth', 'backend', 'database', 'security', 'tests'],
    forbiddenByDefault: ['ui/**', 'billing/**', 'infra/**'],
    riskProfile: ['authorization', 'rbac', 'access_control', 'security'],
    verification: ['permission_tests', 'auth_regression'],
    reviewSensitivity: 'critical',
  },
  {
    domain: 'email',
    owns: ['**/email/**', '**/mail/**', '**/notifications/**', '**/templates/**'],
    allowedReads: ['**/email/**', '**/mail/**', '**/shared/**', '**/users/**'],
    allowedWrites: ['**/email/**', '**/mail/**', '**/notifications/**', '**/templates/**'],
    relatedDomains: ['backend', 'api', 'tests'],
    forbiddenByDefault: ['infra/**', 'database/**', 'ui/**'],
    riskProfile: ['email_delivery', 'notification_logic'],
    verification: ['email_tests'],
    reviewSensitivity: 'low',
  },
  {
    domain: 'shared',
    owns: ['packages/shared/**', 'packages/common/**', 'packages/ui/**', 'lib/**', 'src/lib/**', 'shared/**', 'packages/types/**'],
    allowedReads: ['packages/shared/**', 'packages/common/**', 'packages/ui/**', 'lib/**', 'src/lib/**', 'shared/**'],
    allowedWrites: ['packages/shared/**', 'packages/common/**', 'packages/ui/**', 'lib/**', 'src/lib/**', 'shared/**'],
    relatedDomains: ['frontend', 'backend', 'tests'],
    forbiddenByDefault: ['infra/**', 'deploy/**'],
    riskProfile: ['shared_code', 'cross_cutting'],
    verification: ['shared_tests'],
    reviewSensitivity: 'medium',
  },
  {
    domain: 'security',
    owns: ['**/security/**', '**/encryption/**', '**/crypto/**', '**/sso/**', '**/oauth/**', '**/jwt/**', '**/csrf/**', '**/cors/**', '**/helmet/**'],
    allowedReads: ['**/security/**', 'auth/**', '**/users/**', 'config/**'],
    allowedWrites: ['**/security/**', '**/encryption/**', '**/crypto/**', '**/sso/**', '**/oauth/**', '**/jwt/**', '**/csrf/**', '**/cors/**'],
    relatedDomains: ['auth', 'backend', 'database', 'infra', 'permissions'],
    forbiddenByDefault: ['ui/**', 'app/**', 'frontend/**'],
    riskProfile: ['security', 'encryption', 'authentication', 'vulnerability'],
    verification: ['security_tests', 'vulnerability_scan'],
    reviewSensitivity: 'critical',
  },
  {
    domain: 'billing',
    owns: ['**/billing/**', '**/payment/**', '**/stripe/**', '**/pricing/**', '**/subscription/**', '**/invoice/**', '**/checkout/**'],
    allowedReads: ['**/billing/**', '**/payment/**', '**/stripe/**', '**/users/**', 'database/**'],
    allowedWrites: ['**/billing/**', '**/payment/**', '**/stripe/**', '**/pricing/**', '**/subscription/**', '**/invoice/**'],
    relatedDomains: ['backend', 'database', 'api', 'email', 'security', 'tests'],
    forbiddenByDefault: ['ui/**', 'app/**', 'frontend/**', 'infra/**'],
    riskProfile: ['payments', 'billing', 'financial_data', 'compliance'],
    verification: ['billing_tests', 'payment_tests'],
    reviewSensitivity: 'critical',
  },
  {
    domain: 'observability',
    owns: ['**/monitoring/**', '**/logging/**', '**/metrics/**', '**/telemetry/**', '**/tracing/**', '**/sentry/**', '**/datadog/**'],
    allowedReads: ['**/monitoring/**', '**/logging/**', '**/metrics/**', '**/shared/**'],
    allowedWrites: ['**/monitoring/**', '**/logging/**', '**/metrics/**', '**/telemetry/**', '**/tracing/**'],
    relatedDomains: ['infra', 'backend', 'security'],
    forbiddenByDefault: ['ui/**', 'app/**', 'frontend/**'],
    riskProfile: ['observability', 'monitoring'],
    verification: ['observability_tests'],
    reviewSensitivity: 'low',
  },
]

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  frontend: ['frontend', 'ui', 'component', 'page', 'layout', 'view', 'template'],
  backend: ['backend', 'server', 'service', 'api route', 'controller', 'handler'],
  auth: ['auth', 'login', 'register', 'signup', 'signin', 'logout', 'session', 'oauth', 'sso', 'password', 'token', 'jwt', 'invite', 'role', 'permission'],
  database: ['database', 'migration', 'schema', 'table', 'sql', 'query', 'orm', 'prisma', 'drizzle', 'model', 'column'],
  tests: ['test', 'spec', 'e2e', 'integration test', 'unit test', 'coverage'],
  infra: ['infra', 'deploy', 'docker', 'kubernetes', 'terraform', 'github actions', 'ci/cd'],
  docs: ['doc', 'readme', 'documentation', 'wiki'],
  ci: ['ci', 'github action', 'gitlab ci', 'build pipeline', 'jenkins'],
  api: ['api', 'endpoint', 'route', 'graphql', 'trpc', 'rest', 'http'],
  permissions: ['permission', 'rbac', 'policy', 'guard', 'authorize', 'acl'],
  email: ['email', 'mail', 'notification', 'send', 'template'],
  shared: ['shared', 'common', 'util', 'helper', 'lib'],
  security: ['security', 'encrypt', 'crypto', 'csrf', 'cors', 'vulnerability', 'audit'],
  billing: ['billing', 'payment', 'stripe', 'subscription', 'pricing', 'invoice', 'checkout'],
  observability: ['observability', 'monitoring', 'logging', 'metrics', 'telemetry', 'sentry'],
}

export function getDomainManifests(repoMap?: RepoMap): DomainManifest[] {
  if (!repoMap) return DEFAULT_DOMAINS

  // Filter manifests to only include domains that are present in the repo
  return DEFAULT_DOMAINS.filter((manifest) => {
    const domainBoundaries = repoMap.domainBoundaries.filter((b) => b.domain === manifest.domain)
    if (domainBoundaries.length > 0) return true
    // Check if any owned paths exist in the repo packages
    const hasOwnedPaths = manifest.owns.some((pattern) =>
      repoMap.packages.some((pkg) => pkg.path.includes(pattern.split('/')[0] ?? '')) ||
      repoMap.apps.some((app) => app.path.includes(pattern.split('/')[0] ?? '')),
    )
    return hasOwnedPaths
  })
}

export function getDomainKeywords(): Record<string, string[]> {
  return { ...DOMAIN_KEYWORDS }
}

export function matchDomainsByTask(task: string, manifest?: DomainManifest[]): string[] {
  const lowerTask = task.toLowerCase()
  const matched = new Set<string>()

  const manifests = manifest ?? DEFAULT_DOMAINS

  for (const domain of manifests) {
    const keywords = DOMAIN_KEYWORDS[domain.domain]
    if (!keywords) continue
    for (const keyword of keywords) {
      if (lowerTask.includes(keyword)) {
        matched.add(domain.domain)
        break
      }
      // Check word boundaries
      const wordRe = new RegExp(`\\b${escapeForRegex(keyword)}\\b`, 'i')
      if (wordRe.test(lowerTask)) {
        matched.add(domain.domain)
        break
      }
    }
  }

  return Array.from(matched)
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
