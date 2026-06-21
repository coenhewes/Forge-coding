#!/usr/bin/env node

/**
 * _bench/gauntlet/runner.mjs — Real-Issue Gauntlet Orchestrator
 *
 * Orchestrates the 10-test gauntlet comparing Forge vs opencode on
 * real upstream repos and real GitHub issues.
 *
 * Usage:
 *   node runner.mjs                # Run all tests from RG01 to RG10
 *   node runner.mjs --test RG03    # Run a single test
 *   node runner.mjs --resume       # Resume from first uncompleted test
 *   node runner.mjs --smoke        # Quick smoke test (uses a small repo)
 */

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractForgeTokens, extractOpencodeTokens } from './utils/token-extract.mjs'
import { writeResult, updateSummary, updateManifest } from './utils/result-writer.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GAUNTLET_DIR = __dirname
const BENCH_DIR = join(__dirname, '..')
const MANIFEST_PATH = join(GAUNTLET_DIR, 'real-gauntlet.json')
const REPO_CACHE = join(BENCH_DIR, 'repos')
const WORK_DIR = join(BENCH_DIR, 'worktrees')
const FORGE_ROOT = join(__dirname, '..', '..')
const MINIMAX_KEY = 'REDACTED_MINIMAX_API_KEY'

function run(cmd, opts = {}) {
  const { cwd = FORGE_ROOT, ignoreFailure = false, timeout = 300_000, input, env = {} } = opts
  try {
    const result = execFileSync('sh', ['-c', cmd], {
      cwd,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, ...env },
      input,
    })
    return { stdout: result, stderr: '', exitCode: 0 }
  } catch (err) {
    if (ignoreFailure) {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
    }
    throw new Error(`Command failed (exit ${err.status}): ${cmd}\n${(err.stderr ?? '').slice(-1024)}`)
  }
}

function getManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
}

function getTest(id) {
  const manifest = getManifest()
  const test = manifest.find(e => e.id === id)
  if (!test) throw new Error(`Test ${id} not found in manifest`)
  return test
}

function cloneRepo(test) {
  const cacheDir = join(REPO_CACHE, test.id)
  if (existsSync(cacheDir)) {
    console.log(`  [${test.id}] Repo already cached at ${cacheDir}`)
    return cacheDir
  }
  mkdirSync(REPO_CACHE, { recursive: true })
  console.log(`  [${test.id}] Cloning ${test.repo}...`)
  run(`git clone --depth 1 --branch ${test.defaultBranch} https://github.com/${test.repo}.git ${cacheDir}`)
  return cacheDir
}

function installDeps(test, cacheDir) {
  console.log(`  [${test.id}] Installing dependencies...`)
  run(test.install, { cwd: cacheDir, timeout: 600_000 })
}

function verifyBaseline(test, cacheDir) {
  console.log(`  [${test.id}] Verifying baseline (${test.verify})...`)
  try {
    run(test.verify, { cwd: cacheDir, timeout: 600_000 })
    console.log(`  [${test.id}] Baseline verify: PASS`)
    return true
  } catch (err) {
    console.log(`  [${test.id}] Baseline verify: FAIL — ${err.message}`)
    return false
  }
}

function generateTask(test, cacheDir) {
  console.log(`  [${test.id}] Fetching issue #${test.issueUrl.split('/').pop()}...`)

  // Fetch issue details from GitHub
  const repoPath = test.repo
  const issueNum = test.issueUrl.split('/').pop()

  let issueTitle = ''
  let issueBody = ''
  let issueComments = ''

  try {
    const titleResult = run(`gh issue view ${issueNum} --repo ${repoPath} --json title,body --jq '.title + "|||" + .body'`, { timeout: 30_000 })
    const parts = titleResult.stdout.trim().split('|||')
    issueTitle = parts[0] ?? ''
    issueBody = parts[1] ?? ''
  } catch {
    console.log(`  [${test.id}] Warning: could not fetch issue, using URL as title`)
    issueTitle = test.issueUrl
  }

  try {
    const commentsResult = run(`gh issue view ${issueNum} --repo ${repoPath} --json comments --jq '.comments[] | "### " + .author.name + ":\n" + .body'`, { timeout: 30_000 })
    issueComments = commentsResult.stdout.trim()
  } catch {
    // comments optional
  }

  const taskMd = [
    `# Task: Implement GitHub Issue #${issueNum}`,
    '',
    `**Issue URL:** ${test.issueUrl}`,
    `**Title:** ${issueTitle}`,
    `**Task kind:** ${test.taskKind}`,
    '',
    '---',
    '',
    '## Issue Description',
    '',
    issueBody,
    '',
    issueComments ? '## Issue Comments\n' : '',
    issueComments ? issueComments : '',
    '---',
    '',
    '## Requirements',
    '',
    '1. Implement the issue faithfully.',
    '2. Add or update regression tests to verify the fix/feature.',
    '3. Do NOT weaken, delete, skip, or rewrite existing tests to make them pass.',
    '4. Verify your work by running the project\'s existing test suite.',
    `5. Verify command: \`${test.verify}\``,
    '',
    '## Verify Command',
    '',
    `\`\`\`bash\n${test.verify}\n\`\`\``,
    '',
  ].join('\n')

  const taskPath = join(cacheDir, '..', `${test.id}-TASK.md`)
  writeFileSync(taskPath, taskMd)
  console.log(`  [${test.id}] TASK.md written to ${taskPath}`)
  return taskPath
}

function prepareWorktrees(test, cacheDir) {
  const testDir = join(WORK_DIR, test.id)
  const forgeDir = join(testDir, 'forge')
  const opencodeDir = join(testDir, 'opencode')

  // Clean and recreate
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true })
  }
  mkdirSync(forgeDir, { recursive: true })
  mkdirSync(opencodeDir, { recursive: true })

  // Copy repo state into both worktrees
  console.log(`  [${test.id}] Copying repo to forge worktree...`)
  cpSync(cacheDir, forgeDir, { recursive: true })
  console.log(`  [${test.id}] Copying repo to opencode worktree...`)
  cpSync(cacheDir, opencodeDir, { recursive: true })

  // Reinstall deps in worktrees — cpSync corrupts bun/yarn symlinks
  console.log(`  [${test.id}] Reinstalling deps in forge worktree...`)
  run(test.install, { cwd: forgeDir, timeout: 600_000 })
  console.log(`  [${test.id}] Reinstalling deps in opencode worktree...`)
  run(test.install, { cwd: opencodeDir, timeout: 600_000 })

  return { forgeDir, opencodeDir }
}

function forgeRun(test, forgeDir, taskPath) {
  console.log(`  [${test.id}] Running Forge...`)

  // Create fresh database
  const dbResult = run(`${BENCH_DIR}/freshdb.sh ${test.id}`, { timeout: 30_000 })
  const dbUrl = dbResult.stdout.trim().split('\n').pop()

  // Copy .forge/config.json from host
  const hostConfig = join(FORGE_ROOT, '.forge', 'config.json')
  if (existsSync(hostConfig)) {
    mkdirSync(join(forgeDir, '.forge'), { recursive: true })
    cpSync(hostConfig, join(forgeDir, '.forge', 'config.json'))
  }

  // Run forge with --json
  console.log(`  [${test.id}] Forge agent running (DB: ${dbUrl})...`)
  const env = {
    FORGE_DATABASE_URL: dbUrl,
    MINIMAX_API_KEY: MINIMAX_KEY,
  }

  const start = Date.now()
  let forgeResult
  try {
    forgeResult = run(`forge run --file ${taskPath} --json`, {
      cwd: forgeDir,
      env,
      timeout: test.timeout ?? 3 * 3600 * 1000, // 3 hours default
    })
  } catch (err) {
    // timeout or crash
    forgeResult = { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
  }
  const runtimeMs = Date.now() - start

  // Extract tokens
  const tokens = extractForgeTokens(forgeResult.stdout)

  // Extract iterations from JSON
  let iterations = 0
  try {
    const parsed = JSON.parse(forgeResult.stdout)
    iterations = parsed?.data?.iterations ?? 0
  } catch {}

  console.log(`  [${test.id}] Forge done (tokens: ${tokens ? `${tokens.inputTokens}/${tokens.outputTokens}` : 'N/A'}, runtime: ${(runtimeMs/1000).toFixed(0)}s)`)

  return {
    stdout: forgeResult.stdout,
    stderr: forgeResult.stderr,
    exitCode: forgeResult.exitCode,
    runtimeMs,
    tokens,
    iterations,
  }
}

function opencodeRun(test, opencodeDir, taskPath) {
  console.log(`  [${test.id}] Running opencode...`)

  const env = {
    MINIMAX_API_KEY: MINIMAX_KEY,
  }

  const taskContent = readFileSync(taskPath, 'utf-8')
  const msg = taskContent.split('\n').slice(0, 5).join('; ').slice(0, 200)

  const start = Date.now()
  let ocResult
  try {
    ocResult = run(`opencode run -m minimax/MiniMax-M3 --format json -f "${taskPath}" -- "${msg}"`, {
      cwd: opencodeDir,
      env,
      timeout: test.timeout ?? 3 * 3600 * 1000,
    })
  } catch (err) {
    ocResult = { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
  }
  const runtimeMs = Date.now() - start

  // Extract tokens
  const tokens = extractOpencodeTokens(ocResult.stdout)

  console.log(`  [${test.id}] opencode done (tokens: ${tokens ? `${tokens.inputTokens}/${tokens.outputTokens}` : 'N/A'}, runtime: ${(runtimeMs/1000).toFixed(0)}s)`)

  // Clean up orphaned opencode server process
  try {
    run('pkill -f "opencode -s"', { ignoreFailure: true })
  } catch {}

  return {
    stdout: ocResult.stdout,
    stderr: ocResult.stderr,
    exitCode: ocResult.exitCode,
    runtimeMs,
    tokens,
  }
}

function scoreWorktree(test, workDir) {
  console.log(`  [${test.id}] Scoring worktree...`)
  try {
    const result = run(`node ${join(GAUNTLET_DIR, 'utils', 'score.mjs')} ${workDir} "${test.verify}"`, { timeout: 600_000 })
    return JSON.parse(result.stdout)
  } catch (err) {
    return { status: 'failed', error: err.message, gatePassed: false }
  }
}

function determineWinner(test, forgeResult, opencodeResult, forgeScore, opencodeScore) {
  const forgePass = forgeScore?.gatePassed === true
  const opencodePass = opencodeScore?.gatePassed === true
  const forgeTokens = (forgeResult.tokens?.inputTokens ?? 0) + (forgeResult.tokens?.outputTokens ?? 0)
  const opencodeTokens = (opencodeResult.tokens?.inputTokens ?? 0) + (opencodeResult.tokens?.outputTokens ?? 0)

  if (forgePass && opencodePass) {
    if (forgeTokens <= opencodeTokens) return 'Forge'
    return 'opencode'
  }
  if (forgePass && !opencodePass) return 'Forge'
  if (!forgePass && opencodePass) return 'opencode'
  return 'no winner'
}

function buildResult(test, forgeResult, opencodeResult, forgeScore, opencodeScore) {
  const forgePass = forgeScore?.gatePassed === true
  const opencodePass = opencodeScore?.gatePassed === true
  const forgeTokens = (forgeResult.tokens?.inputTokens ?? 0) + (forgeResult.tokens?.outputTokens ?? 0)
  const opencodeTokens = (opencodeResult.tokens?.inputTokens ?? 0) + (opencodeResult.tokens?.outputTokens ?? 0)

  const winner = determineWinner(test, forgeResult, opencodeResult, forgeScore, opencodeScore)

  // Determine gate
  let gatePassed = false
  if (forgePass && opencodePass && forgeTokens <= opencodeTokens) gatePassed = true
  if (forgePass && !opencodePass) gatePassed = true

  return {
    id: test.id,
    repo: test.repo,
    issueUrl: test.issueUrl,
    verifyCommand: test.verify,
    forge: {
      status: forgePass ? 'PASS' : 'FAIL',
      tokens: forgeResult.tokens,
      iterations: forgeResult.iterations,
      verifyOutput: forgeScore,
      notes: [],
      defect: null,
      fixApplied: null,
    },
    opencode: {
      status: opencodePass ? 'PASS' : 'FAIL',
      tokens: opencodeResult.tokens,
      verifyOutput: opencodeScore,
      notes: [],
    },
    winner,
    gatePassed,
    rerunRequired: !gatePassed,
  }
}

function storeArtifacts(testId, forgeResult, opencodeResult) {
  const artDir = join(GAUNTLET_DIR, testId)
  mkdirSync(artDir, { recursive: true })

  writeFileSync(join(artDir, 'forge-output.json'), JSON.stringify({
    stdout: forgeResult.stdout.slice(-50000),
    stderr: forgeResult.stderr.slice(-50000),
    exitCode: forgeResult.exitCode,
    runtimeMs: forgeResult.runtimeMs,
    tokens: forgeResult.tokens,
  }, null, 2))

  writeFileSync(join(artDir, 'opencode-output.json'), JSON.stringify({
    stdout: opencodeResult.stdout.slice(-50000),
    stderr: opencodeResult.stderr.slice(-50000),
    exitCode: opencodeResult.exitCode,
    runtimeMs: opencodeResult.runtimeMs,
    tokens: opencodeResult.tokens,
  }, null, 2))
}

async function runTest(id) {
  const test = getTest(id)
  const results = []

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Starting ${test.id}: ${test.repo} — ${test.issueUrl}`)
  console.log(`${'='.repeat(60)}`)

  // 1. Clone
  const cacheDir = cloneRepo(test)

  // 2. Install deps
  installDeps(test, cacheDir)

  // 3. Verify baseline
  const baselinePass = verifyBaseline(test, cacheDir)
  if (!baselinePass) {
    console.log(`  [${test.id}] Baseline FAIL — marking test as invalid, recording reason`)
    const result = {
      id: test.id,
      repo: test.repo,
      issueUrl: test.issueUrl,
      verifyCommand: test.verify,
      forge: { status: 'SKIP', tokens: null, iterations: 0, verifyOutput: null, notes: ['Baseline failed — test environment issue'], defect: null, fixApplied: null },
      opencode: { status: 'SKIP', tokens: null, verifyOutput: null, notes: [] },
      winner: 'no winner',
      gatePassed: false,
      rerunRequired: true,
    }
    writeResult(GAUNTLET_DIR, test.id, result)
    updateManifest(MANIFEST_PATH, test.id, 'baseline_failed')
    results.push(result)
    allResults.push(result)
    updateSummary(GAUNTLET_DIR, allResults)
    return result
  }

  // 4. Generate TASK.md
  const taskPath = generateTask(test, cacheDir)

  // 5. Prepare worktrees
  const { forgeDir, opencodeDir } = prepareWorktrees(test, cacheDir)

  // 6. Run opencode
  const opencodeResult = opencodeRun(test, opencodeDir, taskPath)

  // 7. Run Forge
  const forgeResult = forgeRun(test, forgeDir, taskPath)

  // 8. Score both
  const forgeScore = scoreWorktree(test, forgeDir)
  const opencodeScore = scoreWorktree(test, opencodeDir)

  // 9. Build result
  const result = buildResult(test, forgeResult, opencodeResult, forgeScore, opencodeScore)

  // 10. Store artifacts
  storeArtifacts(test.id, forgeResult, opencodeResult)

  // 11. Write result
  writeResult(GAUNTLET_DIR, test.id, result)
  updateManifest(MANIFEST_PATH, test.id, result.gatePassed ? 'passed' : 'failed')
  allResults.push(result)
  updateSummary(GAUNTLET_DIR, allResults)

  console.log(`\n  ${test.id}: ${result.winner} wins. Gate: ${result.gatePassed ? 'PASS' : 'FAIL'}`)
  console.log(`  Forge: ${result.forge.status} (${(forgeResult.tokens?.inputTokens ?? 0) + (forgeResult.tokens?.outputTokens ?? 0)} tokens)`)
  console.log(`  opencode: ${result.opencode.status} (${(opencodeResult.tokens?.inputTokens ?? 0) + (opencodeResult.tokens?.outputTokens ?? 0)} tokens)`)

  return result
}

// ─── Main ────────────────────────────────────────────────────────────

const allResults = []
const args = process.argv.slice(2)

async function main() {
  // Load any existing results for summary continuity
  try {
    const existingSummary = readFileSync(join(GAUNTLET_DIR, 'SUMMARY.md'), 'utf-8')
    // Could parse existing results, but we'll rebuild from scratch
  } catch {}

  if (args.includes('--smoke')) {
    console.log('Smoke test mode: will run just RG01 with reduced timeout')
    // Use a small test quickly
  }

  let testsToRun = []

  const specificTest = args.find(a => a.startsWith('--test='))
  if (specificTest) {
    const id = specificTest.split('=')[1]
    testsToRun = [id]
  } else if (args.includes('--resume')) {
    const manifest = getManifest()
    testsToRun = manifest.filter(e => e.status !== 'passed').map(e => e.id)
    if (testsToRun.length === 0) {
      console.log('All tests passed! Nothing to resume.')
      return
    }
  } else {
    testsToRun = getManifest().map(e => e.id)
  }

  for (const id of testsToRun) {
    try {
      const result = await runTest(id)
      // If Forge failed and rerun is required, prompt for fix
      if (result.rerunRequired && !args.includes('--no-iterate')) {
        if (result.forge.status !== 'SKIP') {
          console.log(`\n⚠ ${id}: Forge needs attention.`)
          console.log(`  Winner: ${result.winner}`)
          console.log(`  Forge verify: ${result.forge.status}`)
          if (result.forge.status === 'FAIL') {
            console.log('  Forge verification FAILED — inspect forge worktree and fix the harness')
          } else if (result.winner === 'opencode') {
            console.log('  Forge used more tokens than opencode — diagnose token sink')
          }
          console.log(`  Artifacts in _bench/gauntlet/${id}/`)
          console.log('  Fix the issue, then rerun with: node runner.mjs --test=' + id)
        }
      }
    } catch (err) {
      console.error(`Error running ${id}:`, err)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('Gauntlet complete!')
  console.log('='.repeat(60))
  updateSummary(GAUNTLET_DIR, allResults)
}

main().catch(err => {
  console.error('Runner error:', err)
  process.exit(1)
})
