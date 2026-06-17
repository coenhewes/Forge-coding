import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ForgeConfigFile, ForgeConfig, ProviderName } from '@forge/types'

export const DEFAULT_STATE_DIR = '.forge'

export const DEFAULT_CONFIG: ForgeConfig = {
  provider: { name: 'openrouter', model: 'anthropic/claude-sonnet-20241022', maxTokens: 4096, temperature: 0.2 },
  subagents: {
    enabled: false,
    provider: { name: 'openrouter', model: 'anthropic/claude-sonnet-20241022', maxTokens: 4096, temperature: 0.2 },
    maxSubagents: 3,
  },
  mode: 'implement',
  workDir: process.cwd(),
  stateDir: join(process.cwd(), DEFAULT_STATE_DIR),
  logLevel: 'info',
  features: {
    repoGraph: true, domainSystem: true, evidenceLedger: true,
    failureLedger: true, decisionLedger: true, checkpointSystem: true, trace: true,
  },
  git: { autoBranch: true, autoCommit: true, pr: 'file', branchPrefix: 'forge/' },
}

export async function initConfig(fileConfig: ForgeConfigFile): Promise<void> {
  const stateDir = join(process.cwd(), DEFAULT_STATE_DIR)
  const fp = join(stateDir, 'config.json')

  await mkdir(dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(fileConfig, null, 2), 'utf-8')

  const subdirs = ['tasks', 'evidence', 'evidence/artifacts', 'failures', 'decisions', 'verification', 'checkpoints', 'patches', 'traces']
  for (const subdir of subdirs) {
    await mkdir(join(stateDir, subdir), { recursive: true })
  }
}
