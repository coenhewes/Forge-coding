import { describe, it, expect } from 'vitest'
import {
  FORGE_VSCODE_VERSION,
  FORGE_VSCODE_EXTENSION,
  type ForgeVSCodeExtension,
  type ForgeVSCodeActivationEvent,
} from '@forge/vscode'

describe('@forge/vscode scaffold', () => {
  it('exposes a version string', () => {
    expect(typeof FORGE_VSCODE_VERSION).toBe('string')
    expect(FORGE_VSCODE_VERSION.length).toBeGreaterThan(0)
  })

  it('ships a typed ForgeVSCodeExtension shell', () => {
    const ext: ForgeVSCodeExtension = FORGE_VSCODE_EXTENSION
    expect(ext.id).toBe('forge.forge-vscode')
    expect(ext.displayName).toBe('Forge')
    expect(Array.isArray(ext.activationEvents)).toBe(true)
  })

  it('accepts the documented activation event names', () => {
    const events: ForgeVSCodeActivationEvent[] = [
      'onCommand:forge.openTask',
      'onCommand:forge.runAgent',
      'onCommand:forge.showTui',
      'onLanguage:typescript',
    ]
    expect(events).toHaveLength(4)
  })

  it('freezes the extension shell', () => {
    expect(Object.isFrozen(FORGE_VSCODE_EXTENSION)).toBe(true)
  })
})