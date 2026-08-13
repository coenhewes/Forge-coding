import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { ForgeConfigFile, ForgeConfig, CheapModelConfig } from '@forge/types'

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
  git: {
    autoBranch: true,
    autoCommit: true,
    pr: 'file',
    branchPrefix: 'forge/',
  },
  cheapModel: {
    // Opt-in: enabled only when a cheap provider is reachable (probed once).
    // Defaults to local Ollama; override `instruct`/`embed` with any provider
    // (local, free API like Nous upstage/solar-pro4:free, or cheap remote).
    enabled: 'auto',
    instruct: {
      name: 'ollama',
      model: 'qwen3:8b',
      apiUrl: 'http://localhost:11434',
      maxTokens: 512,
      temperature: 0.1,
      timeoutMs: 45_000,
    },
    maxInputChars: 24_000,
    timeoutMs: 45_000,
    summaryTargetTokens: 200,
    compactionThresholdChars: 4_000,
  },
}

export function configPath(stateDir?: string): string {
  return join(stateDir ?? DEFAULT_STATE_DIR, 'config.json')
}

/**
 * Honor `FORGE_STATE_DIR` env var when no explicit `stateDir` is
 * passed. This lets the CLI commands and tests redirect state
 * to a hermetic temp directory without monkey-patching cwd.
 */
function effectiveStateDir(stateDir?: string): string {
  if (stateDir) return stateDir
  const env = process.env.FORGE_STATE_DIR
  if (env && env.length > 0) return env
  return DEFAULT_STATE_DIR
}

export async function loadConfig(stateDir?: string): Promise<ForgeConfig | null> {
  const fp = configPath(effectiveStateDir(stateDir))
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
  const envStateDir = process.env.FORGE_STATE_DIR
  const stateDir = envStateDir && envStateDir.length > 0 ? envStateDir : join(workDir, DEFAULT_STATE_DIR)

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
    git: {
      ...DEFAULT_CONFIG.git,
      ...fileConfig.git,
    },
    // cheapModel is the canonical key; legacy localModel is merged on top only
    // if present, so old configs keep working.
    cheapModel: mergeCheapModel(fileConfig.cheapModel, fileConfig.localModel),
  }
}

/** Resolve the cheap-model config, honoring both the new `cheapModel` key and
 *  the deprecated `localModel` key (deprecated wins if both are set). */
function mergeCheapModel(
  cheap?: CheapModelConfig,
  legacy?: CheapModelConfig,
): CheapModelConfig {
  const base: CheapModelConfig = { ...(DEFAULT_CONFIG.cheapModel!) }
  if (cheap) Object.assign(base, cheap)
  if (legacy) Object.assign(base, legacy)
  return base as CheapModelConfig
}

export async function initConfig(overrides?: Partial<ForgeConfigFile>): Promise<ForgeConfig> {
  const workDir = process.cwd()
  const envStateDir = process.env.FORGE_STATE_DIR
  const stateDir = envStateDir && envStateDir.length > 0 ? envStateDir : join(workDir, DEFAULT_STATE_DIR)

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
  const subdirs = ['state', 'tasks', 'evidence', 'evidence/artifacts', 'failures', 'decisions', 'verification', 'checkpoints', 'patches']
  for (const subdir of subdirs) {
    await mkdir(join(stateDir, subdir), { recursive: true })
  }

  return config
}

export function isInitialized(stateDir?: string): boolean {
  return existsSync(configPath(effectiveStateDir(stateDir)))
}
