import { resolve } from 'node:path'
import { discoverPackages } from './packages.js'
import { discoverRoutes, discoverServices, discoverComponents } from './routes.js'
import { discoverDatabase } from './database.js'
import { discoverTests } from './tests.js'
import { discoverGitHistory } from './git.js'
import { discoverOwnership } from './domains.js'

import type {
  RepoMap,
} from '@forge/types'

export interface ScanOptions {
  depth?: number
  enableGit?: boolean
}

export async function scanRepository(
  root: string,
  options?: ScanOptions,
): Promise<RepoMap> {
  const resolvedRoot = resolve(root)
  const enableGit = options?.enableGit ?? true

  const [packagesInfo, routeInfo, dbInfo, tests, gitHistory, ownership] =
    await Promise.all([
      discoverPackages(resolvedRoot),
      discoverRoutesAndServices(resolvedRoot),
      discoverDatabase(resolvedRoot),
      discoverTests(resolvedRoot),
      enableGit ? discoverGitHistory(resolvedRoot) : Promise.resolve(undefined),
      discoverOwnership(resolvedRoot),
    ])

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

async function discoverRoutesAndServices(root: string) {
  const [routes, services, components] = await Promise.all([
    discoverRoutes(root),
    discoverServices(root),
    discoverComponents(root),
  ])
  return { routes, services, components }
}
