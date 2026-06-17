export interface RepoMap {
  packages: PackageInfo[]
  apps: AppInfo[]
  entrypoints: EntrypointInfo[]
  routes: RouteInfo[]
  services: ServiceInfo[]
  components: ComponentInfo[]
  database: DatabaseInfo | null
  migrations: MigrationInfo[]
  testSuites: TestSuiteInfo[]
  buildCommands: CommandInfo[]
  lintCommands: CommandInfo[]
  typecheckCommands: CommandInfo[]
  ownershipBoundaries: OwnershipBoundary[]
  architecturalConventions: ArchitecturalConvention[]
  domainBoundaries: DomainBoundary[]
  riskSensitiveAreas: RiskArea[]
  recentGitHistory?: GitHistory
}

export interface PackageInfo {
  name: string
  path: string
  type: 'library' | 'application' | 'tool'
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

export interface AppInfo {
  name: string
  path: string
  packageName: string
  entrypoints: string[]
  framework?: string
}

export interface EntrypointInfo {
  path: string
  type: 'api' | 'page' | 'middleware' | 'worker' | 'other'
}

export interface RouteInfo {
  method?: string
  path: string
  handler: string
  file: string
  middleware?: string[]
}

export interface ServiceInfo {
  name: string
  path: string
  exportedNames: string[]
}

export interface ComponentInfo {
  name: string
  path: string
  framework: 'react' | 'vue' | 'svelte' | 'other'
}

export interface DatabaseInfo {
  type: 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'other'
  tables: TableInfo[]
  orm?: string
}

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
  indexes?: string[]
  relations?: string[]
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  foreignKey?: string
  default?: string
}

export interface MigrationInfo {
  name: string
  path: string
  timestamp: string
  state: 'pending' | 'applied' | 'reverted'
  tablesTouched: string[]
}

export interface TestSuiteInfo {
  name: string
  path: string
  framework: string
  type: 'unit' | 'integration' | 'e2e' | 'visual'
  files: string[]
  relatedFiles?: string[]
}

export interface CommandInfo {
  name: string
  command: string
  workingDirectory: string
}

export interface OwnershipBoundary {
  name: string
  patterns: string[]
  owners?: string[]
}

export interface ArchitecturalConvention {
  pattern: string
  description: string
  enforced: boolean
}

export interface DomainBoundary {
  domain: string
  patterns: string[]
}

export interface RiskArea {
  name: string
  paths: string[]
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface GitHistory {
  recentCommits: GitCommit[]
  activeBranch: string
  changedFiles: string[]
}

export interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
  files: string[]
}
