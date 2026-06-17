import type { ProviderConfig, SubagentConfig } from './provider.js'

export interface ForgeConfig {
  provider: ProviderConfig
  subagents: SubagentConfig
  mode: 'explore' | 'implement' | 'repair' | 'review' | 'maintain' | 'research'
  workDir: string
  stateDir: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  features: {
    repoGraph: boolean
    domainSystem: boolean
    evidenceLedger: boolean
    failureLedger: boolean
    decisionLedger: boolean
    checkpointSystem: boolean
    trace: boolean
  }
  git: GitConfig
}

/** How Forge integrates with git/GitHub when running a task. */
export interface GitConfig {
  /** Create a working branch at task start (implement/repair modes). */
  autoBranch: boolean
  /** Commit changed files when the task completes successfully. */
  autoCommit: boolean
  /**
   * Pull-request behavior on success:
   * - 'gh'   → run `gh pr create` (requires gh + a remote)
   * - 'file' → write the PR body to .forge/tasks/<id>/PR.md
   * - 'off'  → do not produce a PR
   */
  pr: 'gh' | 'file' | 'off'
  /** Prefix for auto-created branch names (e.g. "forge/"). */
  branchPrefix: string
  /** Base branch for the PR. Defaults to the repo's current branch at start. */
  base?: string
}

export interface ForgeConfigFile {
  provider: ProviderConfig
  subagents?: Partial<SubagentConfig>
  mode?: ForgeConfig['mode']
  logLevel?: ForgeConfig['logLevel']
  features?: Partial<ForgeConfig['features']>
  git?: Partial<GitConfig>
}
