/**
 * `forge local` — inspect and exercise the local-model layer.
 *
 * Subcommands (parsed from `parsed.positional[0]`):
 *   - `status` (default) — show enablement, configured models, reachability.
 *   - `test`            — round-trip a tiny summarize (and embed) call.
 *
 * The local-model layer is a non-authoritative accelerator: these commands are
 * read-only diagnostics and never mutate task state.
 */
import { LocalModelRouter, LocalModelService } from '@forge/local-model'
import type { LocalModelConfig } from '@forge/types'
import { loadConfig } from '../config.js'
import type { CommandResult, ParsedArgs } from './output.js'

export interface LocalStatusData {
  enabled: LocalModelConfig['enabled']
  available: boolean
  instruct: { provider: string; model: string; endpoint?: string }
  embed: { provider: string; model: string; endpoint?: string }
}

export interface LocalTestData {
  available: boolean
  summarize: { ok: boolean; fallbackUsed: boolean; latencyMs: number; provider: string; summary: string }
  embed: { ok: boolean; fallbackUsed: boolean; latencyMs: number; dim: number }
}

async function resolveLocalConfig(): Promise<LocalModelConfig> {
  const config = await loadConfig()
  return config?.localModel ?? { enabled: 'auto' }
}

export async function runLocal(parsed: ParsedArgs): Promise<CommandResult> {
  const sub = parsed.positional[0] ?? 'status'
  if (sub === 'status') return runLocalStatus()
  if (sub === 'test') return runLocalTest()
  return {
    ok: false,
    exitCode: 1,
    message: `Unknown subcommand: ${sub}. Use \`status\` or \`test\`.`,
    textLines: [`forge local: unknown subcommand '${sub}'`, 'Usage: forge local <status|test>'],
  }
}

async function runLocalStatus(): Promise<CommandResult<LocalStatusData>> {
  const cfg = await resolveLocalConfig()
  const router = new LocalModelRouter(cfg)
  const available = await router.available()
  const instruct = router.instructConfig()
  const embed = router.embedConfig()

  const data: LocalStatusData = {
    enabled: cfg.enabled,
    available,
    instruct: { provider: instruct.name, model: instruct.model, endpoint: instruct.apiUrl },
    embed: { provider: embed.name, model: embed.model, endpoint: embed.apiUrl },
  }

  return {
    ok: true,
    exitCode: 0,
    data,
    message: `local-model layer: ${available ? 'available' : 'unavailable'} (enabled=${cfg.enabled})`,
    textLines: [
      `local-model layer`,
      `    enabled:    ${cfg.enabled}`,
      `    available:  ${available ? 'yes' : 'no (falls back to deterministic behavior)'}`,
      `    instruct:   ${instruct.name} / ${instruct.model} @ ${instruct.apiUrl ?? 'default'}`,
      `    embed:      ${embed.name} / ${embed.model} @ ${embed.apiUrl ?? 'default'}`,
    ],
  }
}

async function runLocalTest(): Promise<CommandResult<LocalTestData>> {
  const cfg = await resolveLocalConfig()
  const service = new LocalModelService(cfg)
  const available = await service.available()

  const sample =
    'FAIL src/auth.test.ts > rejects expired tokens\n  Expected 401 but received 200\n  at src/auth.ts:42\n' +
    'x'.repeat(6_000)
  const summarize = await service.summarize({ taskId: 'local-test', content: sample, label: 'forge local test' })
  const embed = await service.embed({ taskId: 'local-test', texts: ['hello world', 'goodbye world'] })

  const data: LocalTestData = {
    available,
    summarize: {
      ok: summarize.summary.length > 0,
      fallbackUsed: summarize.provenance.fallbackUsed,
      latencyMs: summarize.provenance.latencyMs,
      provider: summarize.provenance.provider,
      summary: summarize.summary.slice(0, 240),
    },
    embed: {
      ok: embed.vectors.length === 2,
      fallbackUsed: embed.provenance.fallbackUsed,
      latencyMs: embed.provenance.latencyMs,
      dim: embed.dim,
    },
  }

  return {
    ok: true,
    exitCode: 0,
    data,
    message: available ? 'local-model round-trip complete' : 'local-model unavailable; used deterministic fallbacks',
    textLines: [
      `local-model test (${available ? 'available' : 'fallback mode'})`,
      `    summarize: ${data.summarize.fallbackUsed ? 'fallback' : data.summarize.provider} (${data.summarize.latencyMs}ms)`,
      `      → ${data.summarize.summary.replace(/\n/g, ' ')}`,
      `    embed:     ${data.embed.fallbackUsed ? 'fallback' : 'ok'} dim=${data.embed.dim} (${data.embed.latencyMs}ms)`,
    ],
  }
}
