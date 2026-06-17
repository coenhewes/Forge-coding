import { describe, it, expect } from 'vitest'
import {
  CONTEXT_SERVER_VERSION,
  CONTEXT_SERVER_CAPABILITY,
  type ContextServerHandle,
} from '@forge/context-server'

describe('@forge/context-server scaffold', () => {
  it('exposes a version string', () => {
    expect(typeof CONTEXT_SERVER_VERSION).toBe('string')
    expect(CONTEXT_SERVER_VERSION.length).toBeGreaterThan(0)
  })

  it('exposes a stable capability string', () => {
    expect(CONTEXT_SERVER_CAPABILITY).toBe('forge.context_server')
  })

  it('exports a typed ContextServerHandle shape', () => {
    const handle: ContextServerHandle = {
      version: CONTEXT_SERVER_VERSION,
      capability: CONTEXT_SERVER_CAPABILITY,
    }
    expect(handle.version).toBe(CONTEXT_SERVER_VERSION)
    expect(handle.capability).toBe(CONTEXT_SERVER_CAPABILITY)
  })
})