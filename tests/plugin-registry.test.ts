/**
 * Plugin registry tests.
 *
 * Coverage:
 *   - validatePluginManifest — accepts good manifests, rejects bad ones
 *     with specific error messages, never throws
 *   - PluginRegistry — register, unregister, list, get, findByCapability
 *   - Capability-id collision detection across plugins
 *   - Lifecycle dispatch ordering + error halting
 *   - Singleton (pluginRegistry) is process-wide and isolated from new
 *     PluginRegistry instances (so tests do not pollute each other)
 */
import { describe, expect, it } from 'vitest'
import {
  PluginRegistry,
  asCapabilityId,
  asSemver,
  pluginRegistry,
  validatePluginManifest,
  type PluginHookContext,
  type PluginLifecycleHook,
  type PluginManifest,
} from '@forge/integrations'

/** Build a minimal but valid manifest for tests. */
function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test/plugin',
    displayName: 'Test Plugin',
    version: asSemver('1.0.0'),
    minForgeVersion: asSemver('0.1.0'),
    description: 'A test plugin.',
    capabilities: [asCapabilityId('test.echo')],
    permissions: ['fs.read'],
    ...overrides,
  }
}

describe('validatePluginManifest', () => {
  it('accepts a complete, valid manifest with zero errors', () => {
    expect(validatePluginManifest(makeManifest())).toEqual([])
  })

  it('accepts a manifest with no hooks (all hooks optional)', () => {
    const m = makeManifest()
    const { hooks, ...rest } = m
    void hooks
    expect(validatePluginManifest(rest)).toEqual([])
  })

  it('rejects a non-object manifest', () => {
    expect(validatePluginManifest(null)).toEqual([
      'Plugin manifest must be a non-null object.',
    ])
    expect(validatePluginManifest(42)).toEqual([
      'Plugin manifest must be a non-null object.',
    ])
    expect(validatePluginManifest('hi')).toEqual([
      'Plugin manifest must be a non-null object.',
    ])
  })

  it('rejects invalid plugin ids', () => {
    const errors = validatePluginManifest(makeManifest({ id: 'Bad Id With Spaces' }))
    expect(errors.some((e) => /Invalid plugin id/.test(e))).toBe(true)
  })

  it('rejects invalid semver', () => {
    // Bypass asSemver (which would throw at construction time) by
    // passing a raw invalid value with a cast — validatePluginManifest
    // must still detect it.
    const errors = validatePluginManifest(
      makeManifest({ version: 'not-a-version' as never }),
    )
    expect(errors.some((e) => /Invalid plugin version/.test(e))).toBe(true)
  })

  it('rejects capabilities that do not match the `<plugin-id>.<verb>` pattern', () => {
    const errors = validatePluginManifest(
      makeManifest({ capabilities: ['BadId' as never] }),
    )
    expect(errors.some((e) => /not a valid id/i.test(e))).toBe(true)
  })

  it('rejects unrecognized permission values', () => {
    const errors = validatePluginManifest(
      makeManifest({ permissions: ['definitely.not.real' as never] }),
    )
    expect(errors.some((e) => /not recognized/i.test(e))).toBe(true)
  })

  it('rejects hooks that are not functions', () => {
    const errors = validatePluginManifest(
      makeManifest({ hooks: { onLoad: 'not-a-fn' as never } }),
    )
    expect(errors.some((e) => /onLoad.*must be a function/i.test(e))).toBe(true)
  })

  it('never throws on weird input', () => {
    expect(() => validatePluginManifest(undefined)).not.toThrow()
    expect(() => validatePluginManifest({ id: 123 })).not.toThrow()
    expect(() => validatePluginManifest({ capabilities: 'not-an-array' })).not.toThrow()
  })
})

describe('asSemver / asCapabilityId', () => {
  it('asSemver throws on invalid strings', () => {
    expect(() => asSemver('1.2')).toThrow(/Not a semver/)
    expect(() => asSemver('v1.2.3')).toThrow(/Not a semver/)
  })

  it('asSemver accepts standard semver and pre-release tags', () => {
    expect(asSemver('1.2.3')).toBe('1.2.3')
    expect(asSemver('0.0.1')).toBe('0.0.1')
    expect(asSemver('2.0.0-rc.1')).toBe('2.0.0-rc.1')
    expect(asSemver('1.0.0+build.7')).toBe('1.0.0+build.7')
  })

  it('asCapabilityId throws on malformed ids', () => {
    expect(() => asCapabilityId('NoDotsHere')).toThrow(/Not a plugin capability id/)
    expect(() => asCapabilityId('1starts.with.digit')).toThrow(/Not a plugin capability id/)
    expect(() => asCapabilityId('has spaces.in.it')).toThrow(/Not a plugin capability id/)
  })

  it('asCapabilityId accepts properly namespaced ids', () => {
    expect(asCapabilityId('auth.trace_permission_check')).toBe('auth.trace_permission_check')
    expect(asCapabilityId('db.get_table_schema')).toBe('db.get_table_schema')
  })
})

describe('PluginRegistry — register / unregister / list', () => {
  it('registers and retrieves a manifest by id', () => {
    const reg = new PluginRegistry()
    const m = makeManifest()
    reg.register(m)
    expect(reg.size).toBe(1)
    expect(reg.get('test/plugin')?.displayName).toBe('Test Plugin')
  })

  it('rejects invalid manifests at registration time', () => {
    const reg = new PluginRegistry()
    expect(() => reg.register({ ...makeManifest(), id: 'Bad Id' })).toThrow(/rejected/)
  })

  it('rejects duplicate plugin ids', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest())
    expect(() => reg.register(makeManifest())).toThrow(/already registered/)
  })

  it('rejects plugins that redeclare a capability id owned by another plugin', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest({ id: 'plugin/a', capabilities: [asCapabilityId('shared.cap')] }))
    expect(() =>
      reg.register(
        makeManifest({
          id: 'plugin/b',
          capabilities: [asCapabilityId('shared.cap')],
        }),
      ),
    ).toThrow(/redeclares capabilities/)
  })

  it('list() returns plugins in registration order', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest({ id: 'plugin/first', capabilities: [asCapabilityId('first.cap')] }))
    reg.register(makeManifest({ id: 'plugin/second', capabilities: [asCapabilityId('second.cap')] }))
    reg.register(makeManifest({ id: 'plugin/third', capabilities: [asCapabilityId('third.cap')] }))
    expect(reg.list().map((p) => p.id)).toEqual([
      'plugin/first',
      'plugin/second',
      'plugin/third',
    ])
  })

  it('unregister removes the plugin and returns true', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest())
    expect(reg.unregister('test/plugin')).toBe(true)
    expect(reg.size).toBe(0)
    expect(reg.get('test/plugin')).toBeUndefined()
  })

  it('unregister returns false when the id is unknown', () => {
    const reg = new PluginRegistry()
    expect(reg.unregister('never-registered')).toBe(false)
  })

  it('findByCapability returns every plugin contributing the capability', () => {
    const reg = new PluginRegistry()
    reg.register(
      makeManifest({ id: 'plugin/a', capabilities: [asCapabilityId('auth.check')] }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/b',
        capabilities: [asCapabilityId('auth.check2'), asCapabilityId('auth.trace')],
      }),
    )
    reg.register(
      makeManifest({ id: 'plugin/c', capabilities: [asCapabilityId('db.query')] }),
    )
    const matches = reg.findByCapability(asCapabilityId('auth.check'))
    expect(matches.map((p) => p.id)).toEqual(['plugin/a'])
    const traceMatches = reg.findByCapability(asCapabilityId('auth.trace'))
    expect(traceMatches.map((p) => p.id)).toEqual(['plugin/b'])
    const empty = reg.findByCapability(asCapabilityId('nothing.here'))
    expect(empty).toEqual([])
  })

  it('frozen manifests cannot be mutated after registration', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest())
    const got = reg.get('test/plugin')!
    expect(Object.isFrozen(got)).toBe(true)
    expect(Object.isFrozen(got.capabilities)).toBe(true)
    expect(Object.isFrozen(got.permissions)).toBe(true)
  })
})

describe('PluginRegistry — lifecycle dispatch', () => {
  it('invokes every registered handler in registration order', async () => {
    const reg = new PluginRegistry()
    const calls: string[] = []
    reg.register(
      makeManifest({
        id: 'plugin/first',
        capabilities: [asCapabilityId('first.hook')],
        hooks: { onLoad: () => void calls.push('first') },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/second',
        capabilities: [asCapabilityId('second.hook')],
        hooks: { onLoad: () => void calls.push('second') },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/third',
        capabilities: [asCapabilityId('third.hook')],
        hooks: { onLoad: () => void calls.push('third') },
      }),
    )
    await reg.dispatch('onLoad', {})
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('awaits async handlers', async () => {
    const reg = new PluginRegistry()
    const seen: string[] = []
    reg.register(
      makeManifest({
        id: 'plugin/a',
        capabilities: [asCapabilityId('a.start')],
        hooks: {
          onTaskStart: async () => {
            await new Promise((r) => setTimeout(r, 5))
            seen.push('a')
          },
        },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/b',
        capabilities: [asCapabilityId('b.start')],
        hooks: {
          onTaskStart: () => {
            seen.push('b')
          },
        },
      }),
    )
    await reg.dispatch('onTaskStart', { taskId: 'task:1' })
    expect(seen).toEqual(['a', 'b'])
  })

  it('skips plugins that do not implement the dispatched hook', async () => {
    const reg = new PluginRegistry()
    const seen: string[] = []
    reg.register(makeManifest({ id: 'plugin/silent', capabilities: [asCapabilityId('silent.cap')] }))
    reg.register(
      makeManifest({
        id: 'plugin/active',
        capabilities: [asCapabilityId('active.end')],
        hooks: { onTaskEnd: () => void seen.push('end') },
      }),
    )
    await reg.dispatch('onTaskEnd', { taskId: 'task:1' })
    expect(seen).toEqual(['end'])
  })

  it('halts dispatch and surfaces the first handler error', async () => {
    const reg = new PluginRegistry()
    const seen: string[] = []
    reg.register(
      makeManifest({
        id: 'plugin/first',
        capabilities: [asCapabilityId('first.unload')],
        hooks: { onUnload: () => void seen.push('first') },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/throws',
        capabilities: [asCapabilityId('throws.unload')],
        hooks: {
          onUnload: () => {
            throw new Error('plugin blew up')
          },
        },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/never-reached',
        capabilities: [asCapabilityId('never.unload')],
        hooks: { onUnload: () => void seen.push('never') },
      }),
    )

    await expect(reg.dispatch('onUnload', {})).rejects.toThrow(/plugin blew up/)
    expect(seen).toEqual(['first'])
  })

  it('halts dispatch on a rejected async handler', async () => {
    const reg = new PluginRegistry()
    const seen: string[] = []
    reg.register(
      makeManifest({
        id: 'plugin/first',
        capabilities: [asCapabilityId('first.start')],
        hooks: { onTaskStart: () => void seen.push('first') },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/rejects',
        capabilities: [asCapabilityId('rejects.start')],
        hooks: {
          onTaskStart: async () => {
            await Promise.resolve()
            throw new Error('async boom')
          },
        },
      }),
    )
    reg.register(
      makeManifest({
        id: 'plugin/never',
        capabilities: [asCapabilityId('never.start')],
        hooks: { onTaskStart: () => void seen.push('never') },
      }),
    )
    await expect(reg.dispatch('onTaskStart', { taskId: 't' })).rejects.toThrow(/async boom/)
    expect(seen).toEqual(['first'])
  })

  it('passes the hook context to each handler', async () => {
    const reg = new PluginRegistry()
    const captured: PluginHookContext[] = []
    reg.register(
      makeManifest({
        id: 'plugin/capture',
        capabilities: [asCapabilityId('capture.start')],
        hooks: {
          onTaskStart: (ctx) => void captured.push(ctx),
        },
      }),
    )
    const ctx: PluginHookContext = {
      taskId: 'task:xyz',
      provider: 'anthropic',
      metadata: { foo: 'bar' },
    }
    await reg.dispatch('onTaskStart', ctx)
    expect(captured).toEqual([ctx])
  })

  it('supports every documented hook name without special-casing', async () => {
    const reg = new PluginRegistry()
    const seen: PluginLifecycleHook[] = []
    const allHooks: PluginLifecycleHook[] = ['onLoad', 'onUnload', 'onTaskStart', 'onTaskEnd']
    for (const name of allHooks) {
      reg.register(
        makeManifest({
          id: `plugin-${name}`,
          capabilities: [asCapabilityId(`${name.replace(/^on/, '').toLowerCase()}.probe`)],
          hooks: { [name]: () => void seen.push(name) },
        }),
      )
    }
    for (const name of allHooks) {
      await reg.dispatch(name, {})
    }
    expect(seen).toEqual(allHooks)
  })

  it('clear() removes every plugin and returns the previous list', () => {
    const reg = new PluginRegistry()
    reg.register(makeManifest({ id: 'plugin/a', capabilities: [asCapabilityId('a.clear')] }))
    reg.register(makeManifest({ id: 'plugin/b', capabilities: [asCapabilityId('b.clear')] }))
    const previous = reg.clear()
    expect(previous.map((p) => p.id).sort()).toEqual(['plugin/a', 'plugin/b'])
    expect(reg.size).toBe(0)
  })
})

describe('pluginRegistry singleton', () => {
  it('exposes a PluginRegistry instance', () => {
    expect(pluginRegistry).toBeInstanceOf(PluginRegistry)
  })

  it('is shared across the process (mutations persist)', () => {
    const id = 'plugin/singleton-probe'
    const cap = asCapabilityId('singleton.probe')
    pluginRegistry.register(makeManifest({ id, capabilities: [cap] }))
    expect(pluginRegistry.get(id)).toBeDefined()
    // clean up so we don't pollute later runs in the same worker
    pluginRegistry.unregister(id)
  })
})
