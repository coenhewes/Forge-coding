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
}

export interface ForgeConfigFile {
  provider: ProviderConfig
  subagents?: Partial<SubagentConfig>
  mode?: ForgeConfig['mode']
  logLevel?: ForgeConfig['logLevel']
  features?: Partial<ForgeConfig['features']>
}
