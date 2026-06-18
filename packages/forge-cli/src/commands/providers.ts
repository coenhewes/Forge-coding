/**
 * `forge providers` — list supported LLM providers and probe one.
 *
 * Subcommands (parsed from `parsed.positional[0]`):
 *   - `list`   (default) — print the catalog table.
 *   - `test <name>` — probe reachability for one provider. Exit code:
 *       0 — reachable, 2xx
 *       1 — unreachable / auth failed / timed out
 *       2 — reachable but unexpected status
 *
 * Output follows the standard `CommandResult` shape so `--json` and
 * `--text` both work uniformly with the rest of the CLI.
 */
import {
  PROVIDER_CATALOG,
  listProviderNames,
  probeProvider,
  requireProviderEntry,
} from '@forge/provider'
import type { ProviderName } from '@forge/types'
import type { CommandResult, ParsedArgs } from './output.js'

export interface ProvidersListRow {
  name: ProviderName
  vendor: string
  tools: boolean
  vision: boolean
  streaming: boolean
  contextWindow: number
  costTier: number
  defaultModel: string
  requiresApiKey: boolean
}

export interface ProvidersListData {
  count: number
  providers: ProvidersListRow[]
}

export interface ProvidersTestData {
  name: ProviderName
  ok: boolean
  endpoint: string
  latencyMs: number
  hasApiKey: boolean
  message: string
  error?: string
}

/** Dispatcher — picks the right subcommand based on positional args. */
export async function runProviders(parsed: ParsedArgs): Promise<CommandResult> {
  const sub = parsed.positional[0] ?? 'list'
  if (sub === 'list') {
    return runProvidersList(parsed)
  }
  if (sub === 'test') {
    return runProvidersTest(parsed)
  }
  return {
    ok: false,
    exitCode: 1,
    message: `Unknown subcommand: ${sub}. Use \`list\` or \`test <name>\`.`,
    textLines: [`forge providers: unknown subcommand '${sub}'`, 'Usage: forge providers <list|test <name>>'],
  }
}

async function runProvidersList(_parsed: ParsedArgs): Promise<CommandResult<ProvidersListData>> {
  const providers: ProvidersListRow[] = PROVIDER_CATALOG.map((entry) => ({
    name: entry.name,
    vendor: entry.vendor,
    tools: entry.capabilities.tools,
    vision: entry.capabilities.vision,
    streaming: entry.capabilities.streaming,
    contextWindow: entry.contextWindow,
    costTier: entry.costTier,
    defaultModel: entry.defaultModel,
    requiresApiKey: entry.requiresApiKey,
  }))

  const header = [
    'NAME'.padEnd(16),
    'VENDOR'.padEnd(14),
    'TOOLS',
    'VISION',
    'STREAM',
    'CTX'.padStart(8),
    'TIER',
    'DEFAULT MODEL',
  ].join('  ')

  const rows = providers.map((p) =>
    [
      p.name.padEnd(16),
      p.vendor.padEnd(14),
      p.tools ? '✓' : '·',
      p.vision ? '✓' : '·',
      p.streaming ? '✓' : '·',
      formatContextWindow(p.contextWindow).padStart(8),
      String(p.costTier),
      p.defaultModel,
    ].join('  '),
  )

  return {
    ok: true,
    exitCode: 0,
    data: { count: providers.length, providers },
    message: `${providers.length} provider(s) supported.`,
    textLines: [
      `Supported providers (${providers.length}):`,
      '',
      header,
      ...rows,
      '',
      `All names: ${listProviderNames().join(', ')}`,
      'Run `forge providers test <name>` to probe reachability.',
    ],
  }
}

async function runProvidersTest(parsed: ParsedArgs): Promise<CommandResult<ProvidersTestData>> {
  const name = parsed.positional[1] as ProviderName | undefined
  if (!name) {
    return {
      ok: false,
      exitCode: 1,
      message: 'Usage: forge providers test <name>',
      textLines: ['forge providers test: missing provider name', 'Usage: forge providers test <name>'],
    }
  }

  // Validate against the catalog BEFORE issuing a network request so
  // we never probe arbitrary URLs.
  try {
    requireProviderEntry(name)
  } catch {
    return {
      ok: false,
      exitCode: 1,
      message: `Unknown provider: ${name}`,
      textLines: [
        `forge providers test: unknown provider '${name}'`,
        `Known providers: ${listProviderNames().join(', ')}`,
      ],
    }
  }

  const report = await probeProvider(name, { timeoutMs: 8_000 })

  // Distinguish "server reachable, just rejected" from "can't reach it".
  const unreachable =
    report.error === 'ProviderUnreachableError' ||
    report.error === 'ProviderTimeoutError'
  const exitCode = report.ok ? 0 : unreachable ? 1 : 2

  return {
    ok: report.ok,
    exitCode,
    data: {
      name: report.name,
      ok: report.ok,
      endpoint: report.endpoint,
      latencyMs: report.latencyMs,
      hasApiKey: report.hasApiKey,
      message: report.message,
      error: report.error,
    },
    message: report.ok
      ? `${report.name}: reachable (${report.latencyMs}ms)`
      : `${report.name}: ${report.message}`,
    textLines: [
      `${report.ok ? '✓' : '✗'} ${report.name}`,
      `    endpoint: ${report.endpoint}`,
      `    latency:  ${report.latencyMs}ms`,
      `    api-key:  ${report.hasApiKey ? 'present' : 'missing'}`,
      `    message:  ${report.message}`,
      ...(report.error ? [`    error:    ${report.error}`] : []),
    ],
  }
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return `${tokens}`
}
