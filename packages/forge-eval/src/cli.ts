#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type { ProviderConfig, ProviderName } from '@forge/types'
import { runComparison, formatReport } from './runner.js'
import { DEMO_TASK } from './demo.js'
import { BaselineComparison, formatComparisonTable } from './baseline.js'
import { EVAL_TASKS, findTask } from './tasks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function printUsage(): void {
  console.log(`forge-eval — baseline comparison harness

Usage:
  forge-eval demo
  forge-eval run --task "<task>" [--fixture <path>]
  forge-eval compare --repo <path> --task <task-id> [--report <path>] [--dry-run]
  forge-eval list

Commands:
  demo      Run the headline AGENTS.md demo (single comparison).
  run       Run a single arm-on-arm comparison with an ad-hoc task.
  compare   Run the formal baseline harness against a repo + task id.
  list      List all eval tasks defined in tasks.ts.

Options:
  --repo <path>      Path to the repo to seed each arm from (compare mode).
  --task <task-id>   Task id from EVAL_TASKS (compare mode).
  --fixture <path>   Override the default fixture (run mode).
  --report <path>    Where to write the JSON report (default: ./forge-eval-report.json).
  --max-iterations   Override the agent max iterations.
  --dry-run          Skip LLM calls; synthesize results for testing.
`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'demo'

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage()
    return
  }

  if (command === 'list') {
    console.log('Available eval tasks:')
    for (const t of EVAL_TASKS) {
      console.log(`  ${t.id.padEnd(38)} ${t.cls.padEnd(32)} ${t.title}`)
    }
    return
  }

  const provider = providerFromEnv()
  const maxIterations = Number(parseArg(args, '--max-iterations') ?? 40)
  const dryRun = hasFlag(args, '--dry-run')

  if (command === 'demo') {
    console.log('Forge Eval — same model, same repo, same task, better harness')
    console.log(`Provider: ${provider.name} (${provider.model})`)
    console.log(`Fixture:  ${SAMPLE_SAAS}`)
    console.log('Running both arms (this makes real LLM calls)...\n')
    const reportPath = parseArg(args, '--report') ?? join(process.cwd(), 'forge-eval-report.json')
    const report = await runComparison({
      task: DEMO_TASK,
      fixtureDir: SAMPLE_SAAS,
      provider,
      maxIterations,
      reportPath,
    })
    console.log(formatReport(report))
    console.log(`Full report written to ${reportPath}`)
    return
  }

  if (command === 'run') {
    const t = parseArg(args, '--task')
    if (!t) {
      console.error('Usage: forge-eval run --task "<task>" [--fixture <path>]')
      process.exit(1)
    }
    const fixture = parseArg(args, '--fixture') ? resolve(parseArg(args, '--fixture')!) : SAMPLE_SAAS
    const reportPath = parseArg(args, '--report') ?? join(process.cwd(), 'forge-eval-report.json')
    console.log('Forge Eval — same model, same repo, same task, better harness')
    console.log(`Provider: ${provider.name} (${provider.model})`)
    console.log(`Fixture:  ${fixture}`)
    console.log('Running both arms (this makes real LLM calls)...\n')
    const report = await runComparison({ task: t, fixtureDir: fixture, provider, maxIterations, reportPath })
    console.log(formatReport(report))
    console.log(`Full report written to ${reportPath}`)
    return
  }

  if (command === 'compare') {
    const repo = parseArg(args, '--repo')
    const taskId = parseArg(args, '--task')

    if (!repo || !taskId) {
      console.error('Usage: forge-eval compare --repo <path> --task <task-id> [--report <path>] [--dry-run]')
      process.exit(1)
    }

    const repoPath = resolve(repo)
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      console.error(`Error: --repo path does not exist or is not a directory: ${repoPath}`)
      process.exit(2)
    }

    const task = findTask(taskId)
    if (!task) {
      console.error(`Error: unknown task id "${taskId}". Run "forge-eval list" to see available tasks.`)
      process.exit(2)
    }

    const reportPath = parseArg(args, '--report') ?? join(process.cwd(), `forge-eval-${taskId}.json`)

    console.log('Forge Eval — baseline comparison harness')
    console.log(`Provider: ${provider.name} (${provider.model})`)
    console.log(`Repo:     ${repoPath}`)
    console.log(`Task:     ${task.id} (${task.cls}) — ${task.title}`)
    console.log(`Mode:     ${dryRun ? 'dry-run (synthetic results)' : 'live LLM calls'}`)
    console.log('')

    const baseline = new BaselineComparison({
      task,
      fixtureDir: repoPath,
      provider,
      maxIterations,
      reportPath,
      dryRun,
    })

    const report = await baseline.run()
    console.log(formatComparisonTable(report))
    console.log(`Full report written to ${reportPath}`)
    return
  }

  console.error(`Unknown command: ${command}. Use "demo", "run", "compare", or "list".`)
  printUsage()
  process.exit(1)
}

main().catch((err) => {
  console.error('Eval error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})