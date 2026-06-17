export { CapabilityRegistry } from './capabilities.js'
export type {
  CapabilityResult,
  CapabilityDefinition,
  CapabilityHandler,
  CapabilityContext,
  CapabilityImplementation,
} from './capabilities.js'

export { CapabilityExecutor } from './executor.js'
export type { ExecuteOptions } from './executor.js'

export { generateCapabilitiesFromManifests, generateToolDefinitions } from './generator.js'

export { ContextBuilder } from './context.js'
export type { BoundedContext, RepoFacts, GraphFacts } from './context.js'

export { authCapabilities } from './capabilities/auth.js'
export { dbCapabilities } from './capabilities/db.js'
export { testCapabilities } from './capabilities/tests.js'
export { repoCapabilities } from './capabilities/repo.js'
