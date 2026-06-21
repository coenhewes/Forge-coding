#!/usr/bin/env node

/**
 * _bench/golden/golden-gauntlet.mjs — Rigorous, ground-truth gauntlet.
 *
 * Director's rebuild of the RG01-RG10 harness. Fixes its three showstoppers:
 *   1. The gate now PROVES the bug is fixed via a GOLDEN TEST taken from the
 *      real upstream merged PR that fixed it (the previous gate "existing suite
 *      stays green" let a no-op pass, and cloned current-main where the bug was
 *      already fixed).
 *   2. Scoring is QUALITY-ADJUSTED: the winner accounts for diff minimality
 *      (agent's source diff vs the reference PR's source diff) — not tokens
 *      alone. An over-engineered fix (much larger diff) is penalised.
 *   3. Local-model offload is ENFORCED: a preflight asserts `forge local test`
 *      hits real Ollama (not the fallback) before any Forge run is allowed.
 *
 * Methodology (per case = one merged fixing PR):
 *   - Cache a full-ish clone; `git fetch --depth 2 <fixCommit>` to get the fix
 *     commit AND its parent.
 *   - Per agent: fresh worktree copy, `git checkout <fixCommit>^` (pre-fix,
 *     bug present), then `git checkout <fixCommit> -- <test files>` to lay down
 *     the GOLDEN test. Source is buggy, the repro test is present.
 *   - Assert the golden test FAILS on this baseline (bug reproduced) and is the
 *     spec the agent must satisfy.
 *   - Give BOTH agents the IDENTICAL generic task (no fix leak): localise the
 *     root cause in source, fix minimally, don't edit tests, all tests pass.
 *   - Gate: RE-APPLY the golden test files from the fix commit (anti-gaming, in
 *     case the agent weakened them), run the full verify suite → must be green.
 *   - Minimality: count the agent's non-test diff lines vs the PR's non-test
 *     diff lines (the reference minimal fix).
 *
 * Token metric (already fair in the old harness): both agents are billed on
 * UNCACHED input + output. Forge also reports cacheReadTokens so we can see
 * whether prompt caching is engaging.
 *
 * Usage:
 *   node golden-gauntlet.mjs --case GG01 [--agent forge|opencode|both]
 *   node golden-gauntlet.mjs --all
 *   node golden-gauntlet.mjs --case GG01 --prep-only   # just build + verify repro
 */

import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, createWriteStream, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractForgeTokens, extractOpencodeTokens } from '../gauntlet/utils/token-extract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = __dirname
const BENCH_DIR = join(__dirname, '..')
const FORGE_ROOT = join(BENCH_DIR, '..')
const REPO_CACHE = join(BENCH_DIR, 'repos')
const WORK_DIR = join(GOLDEN_DIR, 'work')
const RESULTS_DIR = join(GOLDEN_DIR, 'results')
const MANIFEST = join(GOLDEN_DIR, 'manifest.json')
const FORGE_CLI = join(FORGE_ROOT, 'packages', 'forge-cli', 'dist', 'cli.js')

// Test-path heuristic: anything under a tests/specs dir or *.test/*.spec file.
const TEST_RE = /(\.test\.|\.spec\.|__tests__|\/tests?\/|\/specs?\/)/

function sh(cmd, opts = {}) {
  const { cwd = FORGE_ROOT, timeout = 300_000, env = {}, ignoreFailure = false, input } = opts
  try {
    const stdout = execFileSync('sh', ['-c', cmd], {
      cwd, encoding: 'utf-8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env }, input,
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    if (ignoreFailure) return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
    throw new Error(`Command failed (exit ${err.status}): ${cmd}\n${(err.stderr ?? '').slice(-2048)}`)
  }
}

function log(id, msg) { console.log(`  [${id}] ${msg}`) }

function getManifest() { return JSON.parse(readFileSync(MANIFEST, 'utf-8')) }
function getCase(id) {
  const c = getManifest().find((e) => e.id === id)
  if (!c) throw new Error(`Case ${id} not found`)
  const multi = Array.isArray(c.bugs) && c.bugs.length > 0
  if (!multi && (!c.fixCommit || c.fixCommit === 'PENDING')) throw new Error(`Case ${id} has no fixCommit`)
  return c
}

const MINIMAX_KEY = process.env.MINIMAX_API_KEY || readMinimaxKey()
function readMinimaxKey() {
  try {
    const env = readFileSync(join(FORGE_ROOT, '.env'), 'utf-8')
    const m = env.match(/MINIMAX_API_KEY=(.+)/)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(join(FORGE_ROOT, '.forge', 'config.json'), 'utf-8'))
    return cfg?.providers?.minimax?.apiKey || cfg?.provider?.apiKey || ''
  } catch {}
  return ''
}

/** A run without local-model offload is INVALID. Assert real Ollama, not fallback. */
function assertLocalModel() {
  console.log('=== preflight: local model (Ollama offload is mandatory) ===')
  const r = sh(`node -r dotenv/config ${FORGE_CLI} local test`, { cwd: FORGE_ROOT, timeout: 180_000, ignoreFailure: true })
  const out = r.stdout + r.stderr
  if (!/summarize:\s*ollama/.test(out) || /fallback/.test(out)) {
    throw new Error(`Local model not healthy (real Ollama required, no fallback). Output:\n${out.slice(-600)}`)
  }
  if (!/embed:\s*ok/.test(out)) throw new Error(`Local embeddings not healthy:\n${out.slice(-600)}`)
  console.log('  local model: OK (real Ollama, embeddings ok)\n')
}

/** Ensure a full-ish cached clone exists and the fix commit + parent are fetched. */
function ensureRepo(c) {
  const cacheDir = join(REPO_CACHE, c.id)
  if (!existsSync(join(cacheDir, '.git'))) {
    mkdirSync(REPO_CACHE, { recursive: true })
    log(c.id, `cloning ${c.repo}...`)
    sh(`git clone https://github.com/${c.repo}.git ${cacheDir}`, { timeout: 600_000 })
  }
  // Multi-bug cases fetch each bug commit in analyzeBugs; single-bug fetches here.
  if (c.fixCommit) {
    log(c.id, `fetching fix commit ${c.fixCommit.slice(0, 8)} + parent...`)
    sh(`git fetch --depth 2 origin ${c.fixCommit}`, { cwd: cacheDir, timeout: 120_000 })
  }
  if (!existsSync(join(cacheDir, 'node_modules'))) {
    log(c.id, `installing deps (${c.install})...`)
    sh(c.install, { cwd: cacheDir, timeout: 900_000 })
  }
  return cacheDir
}

/** Classify the fix commit's changed files; compute the reference minimal diff. */
function analyzeFix(c, cacheDir) {
  const names = sh(`git diff --name-only ${c.fixCommit}^ ${c.fixCommit}`, { cwd: cacheDir }).stdout
    .trim().split('\n').filter(Boolean)
  const testFiles = names.filter((f) => TEST_RE.test(f))
  const srcFiles = names.filter((f) => !TEST_RE.test(f))
  // Reference minimal-fix size = +/- lines in NON-test files of the real PR.
  const numstat = sh(`git diff --numstat ${c.fixCommit}^ ${c.fixCommit}`, { cwd: cacheDir }).stdout.trim().split('\n')
  let refSrcLines = 0
  for (const line of numstat) {
    const [add, del, file] = line.split('\t')
    if (file && !TEST_RE.test(file)) refSrcLines += (Number(add) || 0) + (Number(del) || 0)
  }
  return { testFiles, srcFiles, refSrcLines }
}

/** Build a fresh pre-fix worktree with the golden test applied. */
function prepareWorktree(c, cacheDir, agent, fix) {
  const wd = join(WORK_DIR, c.id, agent)
  if (existsSync(wd)) rmSync(wd, { recursive: true })
  mkdirSync(wd, { recursive: true })
  log(c.id, `[${agent}] APFS-cloning pre-fix worktree...`)
  // clonefile copy (instant on APFS) including node_modules.
  sh(`cp -c -R ${cacheDir}/. ${wd}/`, { timeout: 300_000 })
  // Reset to pre-fix state (bug present), clean any stray state.
  sh(`git checkout -q -f ${c.fixCommit}^`, { cwd: wd })
  sh(`git clean -fdq -e node_modules -e .forge`, { cwd: wd, ignoreFailure: true })
  // Lay down the GOLDEN test files from the fix commit.
  for (const t of fix.testFiles) sh(`git checkout ${c.fixCommit} -- "${t}"`, { cwd: wd })
  // Forge needs a config; opencode needs none here.
  if (agent === 'forge') {
    mkdirSync(join(wd, '.forge'), { recursive: true })
    cpSync(join(FORGE_ROOT, '.forge', 'config.json'), join(wd, '.forge', 'config.json'))
  }
  return wd
}

function runVerify(c, wd, opts = {}) {
  const cwd = c.verifyCwd && c.verifyCwd !== '.' ? join(wd, c.verifyCwd) : wd
  return sh(c.verifyCmd, { cwd, timeout: 900_000, ignoreFailure: true, ...opts })
}

/** Assert the golden test reproduces the bug on the prepared baseline. */
function assertReproFails(c, wd) {
  const cmd = c.singleTestCmd || c.verifyCmd
  const cwd = c.verifyCwd && c.verifyCwd !== '.' ? join(wd, c.verifyCwd) : wd
  const r = sh(cmd, { cwd, timeout: 600_000, ignoreFailure: true })
  if (r.exitCode === 0) {
    throw new Error(`Repro did NOT fail on baseline — golden test passes without the fix. Case ${c.id} is invalid.`)
  }
  log(c.id, `repro confirmed FAILING on baseline (exit ${r.exitCode}) ✓`)
}

/** Re-apply golden tests (anti-gaming) and report agent's non-test diff size. */
function gateAndMinimality(c, wd, fix) {
  // Anti-gaming: restore the golden test files exactly as upstream wrote them.
  for (const t of fix.testFiles) sh(`git checkout ${c.fixCommit} -- "${t}"`, { cwd: wd, ignoreFailure: true })
  const verify = runVerify(c, wd)
  // Agent's non-test diff vs the pre-fix baseline.
  const numstat = sh(`git diff --numstat ${c.fixCommit}^ -- .`, { cwd: wd, ignoreFailure: true }).stdout.trim().split('\n')
  let agentSrcLines = 0
  const touched = []
  for (const line of numstat) {
    const [add, del, file] = line.split('\t')
    if (!file) continue
    touched.push(file)
    if (!TEST_RE.test(file)) agentSrcLines += (Number(add) || 0) + (Number(del) || 0)
  }
  // Test-weakening guard on NON-golden test files only.
  const editedTests = touched.filter((f) => TEST_RE.test(f) && !fix.testFiles.includes(f))
  const diffText = sh(`git diff ${c.fixCommit}^ -- .`, { cwd: wd, ignoreFailure: true }).stdout
  const weakened = editedTests.length > 0 || /\b(it|test|describe)\.skip\b|\.todo\(/.test(diffText)
  return {
    passed: verify.exitCode === 0 && !weakened,
    verifyExit: verify.exitCode,
    agentSrcLines,
    refSrcLines: fix.refSrcLines,
    minimalityRatio: fix.refSrcLines > 0 ? +(agentSrcLines / fix.refSrcLines).toFixed(2) : null,
    editedNonGoldenTests: editedTests,
    weakened,
    verifyTail: (verify.stdout + verify.stderr).slice(-1200),
  }
}

// ---------------------------------------------------------------------------
// MULTI-BUG (long-horizon) cases. A case with `bugs: [{fixCommit, pr}]` seeds
// SEVERAL independent real-PR bugs at once by reverse-applying each fix's SOURCE
// hunks onto current main (golden tests are already merged into main, so they
// stay intact). The agent must localise + fix ALL of them across many turns —
// the regime where opencode's flat transcript degrades and Forge's durable
// bounded state should win. Surgical reverse-apply (vs checking out an old
// parent) preserves all unrelated later changes, so only the seeded bugs fail.
// ---------------------------------------------------------------------------

function analyzeBugs(c, cacheDir) {
  const bugs = []
  let totalRefLines = 0
  const allSrcFiles = new Set(), allTestFiles = new Set()
  for (const b of c.bugs) {
    sh(`git fetch --depth 2 origin ${b.fixCommit}`, { cwd: cacheDir, timeout: 120_000 })
    const names = sh(`git diff --name-only ${b.fixCommit}^ ${b.fixCommit}`, { cwd: cacheDir }).stdout.trim().split('\n').filter(Boolean)
    const testFiles = names.filter((f) => TEST_RE.test(f))
    const srcFiles = names.filter((f) => !TEST_RE.test(f))
    const numstat = sh(`git diff --numstat ${b.fixCommit}^ ${b.fixCommit}`, { cwd: cacheDir }).stdout.trim().split('\n')
    let refLines = 0
    for (const line of numstat) {
      const [add, del, file] = line.split('\t')
      if (file && !TEST_RE.test(file)) refLines += (Number(add) || 0) + (Number(del) || 0)
    }
    srcFiles.forEach((f) => allSrcFiles.add(f)); testFiles.forEach((f) => allTestFiles.add(f))
    totalRefLines += refLines
    bugs.push({ ...b, srcFiles, testFiles, refLines })
  }
  return { bugs, totalRefLines, srcFiles: [...allSrcFiles], testFiles: [...allTestFiles] }
}

function prepareMultiBug(c, cacheDir, agent, info) {
  const wd = join(WORK_DIR, c.id, agent)
  if (existsSync(wd)) rmSync(wd, { recursive: true })
  mkdirSync(wd, { recursive: true })
  log(c.id, `[${agent}] APFS-cloning worktree (main) for ${info.bugs.length}-bug seed...`)
  sh(`cp -c -R ${cacheDir}/. ${wd}/`, { timeout: 300_000 })
  sh(`git checkout -q -f main`, { cwd: wd, ignoreFailure: true })
  sh(`git clean -fdq -e node_modules -e .forge`, { cwd: wd, ignoreFailure: true })
  const mainSha = sh(`git rev-parse HEAD`, { cwd: wd }).stdout.trim()
  // Seed each bug by reverse-applying its SOURCE hunks (tests already in main).
  for (const b of info.bugs) {
    const srcArgs = b.srcFiles.map((f) => `"${f}"`).join(' ')
    const r = sh(`git show ${b.fixCommit} -- ${srcArgs} | git apply -R`, { cwd: wd, ignoreFailure: true })
    if (r.exitCode !== 0) throw new Error(`Bug ${b.pr} (${b.fixCommit.slice(0,8)}) did not reverse-apply cleanly onto main — case ${c.id} invalid. ${r.stderr.slice(-300)}`)
    log(c.id, `[${agent}] seeded bug PR#${b.pr} (${b.srcFiles.join(', ')})`)
  }
  // Snapshot the buggy+golden baseline so agent work diffs cleanly against it.
  sh(`git add -A && git -c user.email=b@b -c user.name=b commit -q -m bug-baseline`, { cwd: wd })
  const baselineSha = sh(`git rev-parse HEAD`, { cwd: wd }).stdout.trim()
  if (agent === 'forge') {
    mkdirSync(join(wd, '.forge'), { recursive: true })
    cpSync(join(FORGE_ROOT, '.forge', 'config.json'), join(wd, '.forge', 'config.json'))
  }
  return { wd, mainSha, baselineSha }
}

/** Assert the seeded bugs reproduce (full suite fails on the baseline). */
function assertMultiRepro(c, wd) {
  const r = runVerify(c, wd)
  if (r.exitCode === 0) throw new Error(`Multi-bug baseline PASSES — seeds did not reproduce. Case ${c.id} invalid.`)
  log(c.id, `multi-bug baseline FAILING as expected (exit ${r.exitCode}) ✓`)
}

function gateMultiBug(c, ctx, info) {
  const { wd, mainSha, baselineSha } = ctx
  // Anti-gaming: restore all golden test files to their upstream (main) version.
  for (const t of info.testFiles) sh(`git checkout ${mainSha} -- "${t}"`, { cwd: wd, ignoreFailure: true })
  const verify = runVerify(c, wd)
  // Agent's diff vs the buggy baseline snapshot.
  const numstat = sh(`git diff --numstat ${baselineSha} -- .`, { cwd: wd, ignoreFailure: true }).stdout.trim().split('\n')
  let agentSrcLines = 0
  const touched = []
  for (const line of numstat) {
    const [add, del, file] = line.split('\t')
    if (!file) continue
    touched.push(file)
    if (!TEST_RE.test(file)) agentSrcLines += (Number(add) || 0) + (Number(del) || 0)
  }
  const editedTests = touched.filter((f) => TEST_RE.test(f) && !info.testFiles.includes(f))
  const diffText = sh(`git diff ${baselineSha} -- .`, { cwd: wd, ignoreFailure: true }).stdout
  const weakened = editedTests.length > 0 || /\b(it|test|describe)\.skip\b|\.todo\(/.test(diffText)
  return {
    passed: verify.exitCode === 0 && !weakened,
    verifyExit: verify.exitCode,
    agentSrcLines, refSrcLines: info.totalRefLines,
    minimalityRatio: info.totalRefLines > 0 ? +(agentSrcLines / info.totalRefLines).toFixed(2) : null,
    editedNonGoldenTests: editedTests, weakened,
    verifyTail: (verify.stdout + verify.stderr).slice(-1200),
  }
}

/** Parse the --text final summary token lines into the same shape as extractForgeTokens. */
function parseForgeTextTokens(text) {
  const m = text.match(/Main-model tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out\s*over\s*(\d+)\s*calls/)
  if (!m) return null
  const cr = text.match(/Cache-read tokens:\s*(\d+)/)
  return {
    inputTokens: Number(m[1]),
    outputTokens: Number(m[2]),
    calls: Number(m[3]),
    cacheReadTokens: cr ? Number(cr[1]) : 0,
  }
}

/**
 * Warm the local model so Forge's OWN preflight smoke test (which runs a cold
 * model, ~25s, and otherwise times out → "fallback" → preflight blocks the
 * run) passes. We deliberately keep OLLAMA_KEEP_ALIVE short (30s) to free the
 * ~8.5GB model during the agent's heavy test runs (OOM guard), so the model
 * goes cold between prep steps. Warming right before spawn keeps it resident
 * through preflight without keeping it pinned during tests.
 */
async function warmOllama() {
  try {
    await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: 'qwen2.5-coder:14b', messages: [{ role: 'user', content: 'ok' }], stream: false }),
    })
  } catch {}
}

async function runForge(c, wd, taskPath) {
  const db = sh(`${BENCH_DIR}/freshdb.sh ${c.id}`, { timeout: 60_000 }).stdout.trim().split('\n').pop()
  log(c.id, `[forge] fresh DB ${db}`)
  log(c.id, `[forge] warming local model so preflight smoke passes...`)
  await warmOllama()
  const maxIter = c.maxIterations ?? 200
  // LIVE tracking: stream the agent's stderr event feed to a tailable log in
  // real time (execFileSync buffered it until exit — blind on a loop-prone
  // tool). stdout (the final --json) is collected separately for tokens.
  const liveDir = join(RESULTS_DIR, c.id)
  mkdirSync(liveDir, { recursive: true })
  const livePath = join(liveDir, 'forge-live.log')
  return new Promise((resolve) => {
    const start = Date.now()
    const live = createWriteStream(livePath, { flags: 'w' })
    live.write(`# GG ${c.id} forge live feed — DB ${db}\n# tail -f ${livePath}\n\n`)
    // --text (NOT --json): the live event renderer is only enabled when NOT
    // --json (run.ts: createRunRenderer(!parsed.json)). --json = zero live
    // events. So we run --text: the renderer streams to stderr (→ live log)
    // and the final summary (with the token lines) lands on stdout.
    const child = spawn('node', [FORGE_CLI, 'run', '--file', taskPath, '--text', '--max-iterations', String(maxIter)], {
      cwd: wd, env: { ...process.env, FORGE_DATABASE_URL: db, MINIMAX_API_KEY: MINIMAX_KEY },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d; live.write(d) })
    const killTimer = setTimeout(() => child.kill('SIGKILL'), (c.timeoutHours ?? 3) * 3600_000)
    child.on('close', (code) => {
      clearTimeout(killTimer)
      live.end()
      const tokens = parseForgeTextTokens(stdout + '\n' + stderr)
      const iterMatch = (stdout + stderr).match(/Iterations:\s*(\d+)/)
      const iterations = iterMatch ? Number(iterMatch[1]) : 0
      resolve({ stdout, stderr, exitCode: code ?? 1, runtimeMs: Date.now() - start, tokens, iterations })
    })
  })
}

function runOpencode(c, wd, taskPath) {
  const task = readFileSync(taskPath, 'utf-8')
  const start = Date.now()
  // Full task via stdin-free arg (validated form): pass the whole task text.
  const r = sh(`opencode run -m minimax/MiniMax-M3 --format json ${JSON.stringify(task)}`,
    { cwd: wd, timeout: (c.timeoutHours ?? 3) * 3600_000, ignoreFailure: true, env: { MINIMAX_API_KEY: MINIMAX_KEY } })
  sh('pkill -f "opencode -s"', { ignoreFailure: true })
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, runtimeMs: Date.now() - start, tokens: extractOpencodeTokens(r.stdout) }
}

function writeTask(c, wd, fix) {
  // Generic, fix-free task. The golden test IS the spec.
  const task = [
    `# Task: fix a regression`,
    ``,
    `One or more regressions were introduced in this repository. There are failing`,
    `tests that reproduce the problem.`,
    ``,
    `1. Run the test suite with: \`${c.verifyCmd}\`${c.verifyCwd && c.verifyCwd !== '.' ? ` (from \`${c.verifyCwd}\`)` : ''}.`,
    `2. Find ALL the failing tests.`,
    `3. Localise the ROOT CAUSE in the SOURCE code for each failure.`,
    `4. Fix each one MINIMALLY. Do NOT rewrite whole functions; make the smallest`,
    `   change that addresses the root cause.`,
    `5. Do NOT edit, weaken, skip, or delete any test.`,
    `6. The entire test suite must pass when you are done.`,
    ``,
  ].join('\n')
  const p = join(wd, '..', `${c.id}-TASK.md`)
  writeFileSync(p, task)
  return p
}

const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

/** One prepare→run→score cycle for an agent. Returns a per-run record. */
async function runAgentOnce(c, agent, multi, info, cacheDir, runIdx) {
  const ctx = multi ? prepareMultiBug(c, cacheDir, agent, info) : { wd: prepareWorktree(c, cacheDir, agent, info) }
  const wd = ctx.wd
  if (multi) assertMultiRepro(c, wd); else assertReproFails(c, wd)
  const taskPath = writeTask(c, wd, info)
  log(c.id, `[${agent}] run ${runIdx} starting…`)
  const run = await (agent === 'forge' ? runForge(c, wd, taskPath) : runOpencode(c, wd, taskPath))
  const blob = run.stdout + '\n' + run.stderr
  const preflightBlocked = /Local model layer is unavailable|smoke test used fallback|preflight failed|no task provided/i.test(blob)
  const invalid = preflightBlocked || (run.tokens == null && agent === 'forge')
  const score = invalid ? null : (multi ? gateMultiBug(c, ctx, info) : gateAndMinimality(c, wd, info))
  const toks = run.tokens
  const totalTok = toks ? (toks.inputTokens ?? 0) + (toks.outputTokens ?? 0) : null
  // Persist last run's logs for forensics.
  mkdirSync(join(RESULTS_DIR, c.id), { recursive: true })
  writeFileSync(join(RESULTS_DIR, c.id, `${agent}-run${runIdx}-stdout.log`), run.stdout.slice(-200_000))
  if (invalid) {
    log(c.id, `[${agent}] run ${runIdx}: INVALID (${preflightBlocked ? 'preflight blocked' : 'no model calls'})`)
    return { invalid: true, reason: preflightBlocked ? 'preflight blocked' : 'no model calls', totalUncachedTokens: totalTok }
  }
  log(c.id, `[${agent}] run ${runIdx}: gate=${score.passed ? 'PASS' : 'FAIL'} tokens=${totalTok} cacheRead=${toks?.cacheReadTokens ?? '?'} srcLines=${score.agentSrcLines} (ref ${multi ? info.totalRefLines : info.refSrcLines}, ratio ${score.minimalityRatio})`)
  return {
    gatePassed: score.passed, verifyExit: score.verifyExit,
    totalUncachedTokens: totalTok, cacheReadTokens: toks?.cacheReadTokens ?? null,
    iterations: run.iterations ?? null, runtimeMs: run.runtimeMs,
    agentSrcLines: score.agentSrcLines, minimalityRatio: score.minimalityRatio,
    weakened: score.weakened,
  }
}

/** Aggregate N runs of one agent into pass-rate + medians (MM3 variance control). */
function aggregateRuns(runs) {
  const valid = runs.filter((r) => !r.invalid)
  const passers = valid.filter((r) => r.gatePassed)
  // Median tokens/minimality computed over PASSING runs (a failed run's tokens
  // aren't a meaningful cost for the same outcome); fall back to all valid runs.
  const tokBase = passers.length > 0 ? passers : valid
  return {
    runsTotal: runs.length,
    invalidCount: runs.length - valid.length,
    passes: passers.length,
    passRate: valid.length ? +(passers.length / valid.length).toFixed(2) : 0,
    medianTokens: median(tokBase.map((r) => r.totalUncachedTokens).filter((x) => x != null)),
    medianSrcLines: median(passers.map((r) => r.agentSrcLines).filter((x) => x != null)),
    medianMinimality: median(passers.map((r) => r.minimalityRatio).filter((x) => x != null)),
    runs: runs,
  }
}

async function runCase(id, agents, runsPerAgent = 1) {
  const c = getCase(id)
  const multi = Array.isArray(c.bugs) && c.bugs.length > 0
  console.log(`\n${'='.repeat(64)}\nCASE ${c.id}: ${c.repo}${multi ? ` — ${c.bugs.length}-BUG long-horizon` : ` PR#${c.pr} — ${c.title}`} (${runsPerAgent} run(s)/agent)\n${'='.repeat(64)}`)
  const cacheDir = ensureRepo(c)
  const info = multi ? analyzeBugs(c, cacheDir) : analyzeFix(c, cacheDir)
  const refLines = multi ? info.totalRefLines : info.refSrcLines
  log(c.id, multi
    ? `${info.bugs.length} bugs, ${info.srcFiles.length} src file(s), ${refLines} total ref lines; golden tests: ${info.testFiles.join(', ')}`
    : `fix: ${info.srcFiles.length} src file(s) (${refLines} ref lines), golden test(s): ${info.testFiles.join(', ')}`)

  const result = { id: c.id, repo: c.repo, pr: c.pr ?? null, longHorizon: !!multi, refSrcLines: refLines, runsPerAgent, agents: {} }

  for (const agent of agents) {
    if (agent === 'forge') assertLocalModel()
    const runs = []
    for (let i = 1; i <= runsPerAgent; i++) runs.push(await runAgentOnce(c, agent, multi, info, cacheDir, i))
    const agg = aggregateRuns(runs)
    result.agents[agent] = agg
    log(c.id, `[${agent}] AGG: ${agg.passes}/${agg.runsTotal} pass, median ${agg.medianTokens} tok, median srcLines ${agg.medianSrcLines} (ratio ${agg.medianMinimality})`)
    // Persist incrementally so a long multi-run case isn't lost on interruption.
    mkdirSync(join(RESULTS_DIR, c.id), { recursive: true })
    writeFileSync(join(RESULTS_DIR, c.id, 'result.json'), JSON.stringify(result, null, 2))
  }

  result.verdict = verdict(result.agents)
  writeFileSync(join(RESULTS_DIR, c.id, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`\nVERDICT ${c.id}: ${result.verdict}\n`)
  return result
}

/**
 * Quality-adjusted verdict over AGGREGATED runs (MM3 variance control):
 * reliability (pass-rate) first, then minimality (over-engineering penalty),
 * then median uncached tokens of passing runs.
 */
function verdict(agents) {
  const f = agents.forge, o = agents.opencode
  if (!f || !o) {
    const a = f || o, who = f ? 'forge' : 'opencode'
    return a ? `${who}: ${a.passes}/${a.runsTotal} pass, median ${a.medianTokens} tok, minimality ${a.medianMinimality}` : 'no run'
  }
  const fmt = (who, a) => `${who} ${a.passes}/${a.runsTotal} pass · median ${a.medianTokens} tok · minimality ${a.medianMinimality}`
  const summary = `[${fmt('Forge', f)}] vs [${fmt('opencode', o)}]`
  // Reliability gate first: an agent that passes more often wins (a flaky pass
  // shouldn't beat a reliable one). Require a margin of >1 pass to call it.
  if (f.passes - o.passes >= 1 && f.passRate >= o.passRate) return `Forge (more reliable: ${f.passes}/${f.runsTotal} vs ${o.passes}/${o.runsTotal}) — ${summary}`
  if (o.passes - f.passes >= 1 && o.passRate >= f.passRate) return `opencode (more reliable: ${o.passes}/${o.runsTotal} vs ${f.passes}/${f.runsTotal}) — ${summary}`
  if (f.passes === 0 && o.passes === 0) return `no winner (both 0 pass) — ${summary}`
  // Comparable reliability — compare quality-adjusted on the passing runs.
  const OVER = 2.5
  const fOver = f.medianMinimality != null && f.medianMinimality > OVER
  const oOver = o.medianMinimality != null && o.medianMinimality > OVER
  if (fOver && !oOver) return `opencode (Forge over-engineered: ${f.medianMinimality}x ref) — ${summary}`
  if (oOver && !fOver) return `Forge (opencode over-engineered: ${o.medianMinimality}x ref) — ${summary}`
  if (f.medianTokens == null || o.medianTokens == null) return `inconclusive — ${summary}`
  return f.medianTokens <= o.medianTokens
    ? `Forge (median ${f.medianTokens} <= ${o.medianTokens} tok) — ${summary}`
    : `opencode (median ${o.medianTokens} < ${f.medianTokens} tok) — ${summary}`
}

// ---- CLI ----
const args = process.argv.slice(2)
function arg(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const prepOnly = args.includes('--prep-only')

async function main() {
  mkdirSync(WORK_DIR, { recursive: true })
  mkdirSync(RESULTS_DIR, { recursive: true })
  let ids
  if (args.includes('--all')) ids = getManifest().map((c) => c.id)
  else ids = [arg('--case', 'GG01')]
  const agentArg = arg('--agent', 'both')
  const agents = agentArg === 'both' ? ['forge', 'opencode'] : [agentArg]
  const runsPerAgent = Math.max(1, Number(arg('--runs', '1')) || 1)

  if (prepOnly) {
    for (const id of ids) {
      const c = getCase(id)
      const multi = Array.isArray(c.bugs) && c.bugs.length > 0
      const cacheDir = ensureRepo(c)
      if (multi) {
        const info = analyzeBugs(c, cacheDir)
        const ctx = prepareMultiBug(c, cacheDir, 'prep', info)
        assertMultiRepro(c, ctx.wd)
        console.log(`PREP OK ${id}: ${info.bugs.length} bugs seeded across ${info.srcFiles.join(',')}; ${info.totalRefLines} total ref lines; suite fails as expected`)
      } else {
        const fix = analyzeFix(c, cacheDir)
        const wd = prepareWorktree(c, cacheDir, 'prep', fix)
        assertReproFails(c, wd)
        console.log(`PREP OK ${id}: golden ${fix.testFiles.join(',')} reproduces; ref ${fix.refSrcLines} src lines`)
      }
    }
    return
  }

  const results = []
  for (const id of ids) results.push(await runCase(id, agents, runsPerAgent))
  console.log('\n===== SUMMARY =====')
  for (const r of results) console.log(`${r.id}: ${r.verdict}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
