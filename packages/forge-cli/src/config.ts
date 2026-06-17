import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { ForgeConfigFile, ForgeConfig } from '@forge/types'

export const DEFAULT_STATE_DIR = '.forge'

export const DEFAULT_CONFIG: ForgeConfig = {
  provider: {
    name: 'openrouter',
    model: 'anthropic/claude-sonnet-20241022',
    maxTokens: 4096,
    temperature: 0.2,
  },
  subagents: {
    enabled: false,
    provider: {
      name: 'openrouter',
      model: 'anthropic/claude-sonnet-20241022',
      maxTokens: 4096,
      temperature: 0.2,
    },
    maxSubagents: 3,
  },
  mode: 'implement',
  workDir: process.cwd(),
  stateDir: join(process.cwd(), DEFAULT_STATE_DIR),
  logLevel: 'info',
  features: {
    repoGraph: true,
    domainSystem: true,
    evidenceLedger: true,
    failureLedger: true,
    decisionLedger: true,
    checkpointSystem: true,
    trace: true,
  },
}

export function configPath(stateDir?: string): string {
  return join(stateDir ?? DEFAULT_STATE_DIR, 'config.json')
}

export async function loadConfig(stateDir?: string): Promise<ForgeConfig | null> {
  const fp = configPath(stateDir)
  try {
    const content = await readFile(fp, 'utf-8')
    const parsed = JSON.parse(content) as ForgeConfigFile
    return resolveConfig(parsed)
  } catch {
    return null
  }
}

export function resolveConfig(fileConfig: ForgeConfigFile): ForgeConfig {
  const workDir = process.cwd()
  const stateDir = join(workDir, DEFAULT_STATE_DIR)

  return {
    provider: fileConfig.provider,
    subagents: {
      enabled: fileConfig.subagents?.enabled ?? DEFAULT_CONFIG.subagents.enabled,
      provider: fileConfig.subagents?.provider ?? DEFAULT_CONFIG.subagents.provider,
      maxSubagents: fileConfig.subagents?.maxSubagents ?? DEFAULT_CONFIG.subagents.maxSubagents,
    },
    mode: fileConfig.mode ?? DEFAULT_CONFIG.mode,
    workDir,
    stateDir,
    logLevel: fileConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
    features: {
      ...DEFAULT_CONFIG.features,
      ...fileConfig.features,
    },
  }
}

export async function initConfig(overrides?: Partial<ForgeConfigFile>): Promise<ForgeConfig> {
  const workDir = process.cwd()
  const stateDir = join(workDir, DEFAULT_STATE_DIR)

  const fileConfig: ForgeConfigFile = {
    provider: overrides?.provider ?? DEFAULT_CONFIG.provider,
    subagents: overrides?.subagents,
    mode: overrides?.mode ?? DEFAULT_CONFIG.mode,
    logLevel: overrides?.logLevel ?? DEFAULT_CONFIG.logLevel,
    features: overrides?.features,
  }

  const config = resolveConfig(fileConfig)

  const fp = configPath(stateDir)
  await mkdir(dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(fileConfig, null, 2), 'utf-8')

  // Create state subdirectories
  const subdirs = ['tasks', 'evidence', 'evidence/artifacts', 'failures', 'decisions', 'verification', 'checkpoints', 'patches']
  for (const subdir of subdirs) {
    await mkdir(join(stateDir, subdir), { recursive: true })
  }

  return config
}

export function isInitialized(stateDir?: string): boolean {
  return existsSync(configPath(stateDir))
}
