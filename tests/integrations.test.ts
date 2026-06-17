import { describe, it, expect } from 'vitest'
import {
  INTEGRATION_REGISTRY,
  INTEGRATIONS_VERSION,
  type IntegrationRegistry,
  type IntegrationName,
} from '@forge/integrations'

describe('@forge/integrations scaffold', () => {
  it('exposes a version string', () => {
    expect(typeof INTEGRATIONS_VERSION).toBe('string')
    expect(INTEGRATIONS_VERSION.length).toBeGreaterThan(0)
  })

  it('ships a typed empty IntegrationRegistry', () => {
    const registry: IntegrationRegistry = INTEGRATION_REGISTRY
    // No adapters wired by default — slots are optional.
    expect(registry.issueTracker).toBeUndefined()
    expect(registry.pullRequest).toBeUndefined()
    expect(registry.chat).toBeUndefined()
    expect(registry.ci).toBeUndefined()
  })

  it('accepts the documented IntegrationName values', () => {
    const names: IntegrationName[] = [
      'github',
      'gitlab',
      'linear',
      'jira',
      'slack',
      'circleci',
      'github-actions',
    ]
    expect(names).toHaveLength(7)
  })

  it('freezes the default registry so callers cannot mutate the slot map', () => {
    expect(Object.isFrozen(INTEGRATION_REGISTRY)).toBe(true)
  })
})