/**
 * @forge/vscode — shell types for a future VS Code extension surface.
 *
 * This package is a placeholder scaffold. Subsequent tracks can flesh out a
 * VS Code extension (commands, webviews, status bar items) that talks to
 * Forge. For now, only typed handles and a stable version export exist so
 * the rest of the workspace can wire against them without churn.
 *
 * Do NOT add `vscode` as a dependency here — the real extension host only
 * loads the VS Code API at runtime, and wiring it now would force the
 * workspace to compile against an ambient `vscode` module it does not have.
 */

/** Activation events the future extension may register. */
export type ForgeVSCodeActivationEvent =
  | 'onCommand:forge.openTask'
  | 'onCommand:forge.runAgent'
  | 'onCommand:forge.showTui'
  | 'onLanguage:typescript'

/** Shell of a future VS Code extension. Tracks will implement these fields. */
export interface ForgeVSCodeExtension {
  /** Stable identifier for the extension (`publisher.name`). */
  readonly id: string
  /** Human-readable display name. */
  readonly displayName: string
  /** Activation events the host should listen for. */
  readonly activationEvents: readonly ForgeVSCodeActivationEvent[]
}

export const FORGE_VSCODE_VERSION = '0.0.1'

/** Empty extension shell — to be expanded by future tracks. */
export const FORGE_VSCODE_EXTENSION: ForgeVSCodeExtension = Object.freeze({
  id: 'forge.forge-vscode',
  displayName: 'Forge',
  activationEvents: [],
})