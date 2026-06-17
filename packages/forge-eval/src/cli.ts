#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { ProviderConfig, ProviderName } from '@forge/types'
import { runComparison, formatReport } from './runner.js'
import { DEMO_TASK } from './demo.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/cli.js → package root → fixtures/sample-saas
const SAMPLE_SAAS = resolve(__dirname, '..', 'fixtures', 'sample-saas')

function providerFromEnv(): ProviderConfig {
  return {
    name: (process.env.FORGE_PROVIDER as ProviderName) ?? 'minimax',
    model: process.env.FORGE_MODEL ?? 'minimax-m3',
    maxTokens: 8192,
    temperature: 0.2,
  }
}

function parseArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'demo'

  let task: string
  let fixture: string

  if (command === 'demo') {
    task = DEMO_TASK
    fixture = SAMPLE_SAAS
  } else if (command === 'run') {
    const t = parseArg(args, '--task')
    if (!t) {
      console.error('Usage: forge-eval run --task "<task>" [--fixture <path>]')
      process.exit(1)
    }
    task = t
    fixture = parseArg(args, '--fixture') ? resolve(parseArg(args, '--fixture')!) : SAMPLE_SAAS
  } else {
    console.error(`Unknown command: ${command}. Use "demo" or "run".`)
    process.exit(1)
    return
  }

  const provider = providerFromEnv()
  const maxIterations = Number(parseArg(args, '--max-iterations') ?? 40)
  const reportPath = parseArg(args, '--report') ?? join(process.cwd(), 'forge-eval-report.json')

  console.log('Forge Eval — same model, same repo, same task, better harness')
  console.log(`Provider: ${provider.name} (${provider.model})`)
  console.log(`Fixture:  ${fixture}`)
  console.log('Running both arms (this makes real LLM calls)...\n')

  const report = await runComparison({ task, fixtureDir: fixture, provider, maxIterations, reportPath })
  console.log(formatReport(report))
  console.log(`Full report written to ${reportPath}`)
}

main().catch((err) => {
  console.error('Eval error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
