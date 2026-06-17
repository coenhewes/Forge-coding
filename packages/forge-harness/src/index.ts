export { scanRepository } from './repo-map/index.js'
export type { ScanOptions, FileEntry } from './repo-map/index.js'

export { buildGraph } from './repo-graph/index.js'
export type { BuildGraphOptions } from './repo-graph/index.js'
export { parseImports, parseExports, parseReferences, parseCallSites } from './repo-graph/index.js'
export type { ImportInfo } from './repo-graph/index.js'

export {
  DEFAULT_DOMAINS,
  getDomainManifests,
  getDomainKeywords,
  matchDomainsByTask,
  routeTask,
  detectCrossDomainChanges,
  requestDomainExpansion,
} from './domains/index.js'
export type { RouterOptions, CrossDomainChange } from './domains/index.js'

export {
  CapabilityRegistry,
  CapabilityExecutor,
  ContextBuilder,
  generateCapabilitiesFromManifests,
  generateToolDefinitions,
  authCapabilities,
  dbCapabilities,
  testCapabilities,
  repoCapabilities,
} from './mcp-fabric/index.js'
export type {
  CapabilityResult,
  CapabilityDefinition,
  CapabilityHandler,
  CapabilityContext,
  CapabilityImplementation,
  ExecuteOptions,
  BoundedContext,
  RepoFacts,
  GraphFacts,
} from './mcp-fabric/index.js'

