#!/usr/bin/env node
// Long-horizon SaaS-build benchmark runner. Blank repo + spec.md → run an agent (Forge full, or
// opencode) with the resource oracle live → install/build/start the app → grade with the hidden
// acceptance suite (works + complete + designed). Always Forge vs opencode.
//
// Usage: node longhorizon-runner.mjs --agent forge|opencode [--max-iterations N] [--timeout-hours H] [--port P]
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FORGE_ROOT = join(HERE, '..', '..')
const FORGE_CLI = join(FORGE_ROOT, 'packages', 'forge-cli', 'dist', 'cli.js')
const SECRETS = join(HERE, '.secrets', 'stripe.env')
const SPEC = join(HERE, 'spec.md')
const GRADER = join(HERE, 'acceptance', 'run-acceptance.mjs')
const ORACLE = join(HERE, 'resource-oracle.mjs')

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const AGENT = arg('--agent', 'forge')
const MAX_ITER = Number(arg('--max-iterations', '800'))
const TIMEOUT_H = Number(arg('--timeout-hours', '4'))
const PORT = Number(arg('--port', String(4400 + Math.floor(Math.random() * 100))))
const ts = new Date().toISOString().replace(/[:.]/g, '-')
// CRITICAL: the agent work dir MUST live OUTSIDE the forge repo. When it was nested
// inside, opencode resolved its project root to the outer repo, wrote TaskFlow files
// to the repo root, ran `npm install` there, and clobbered the repo's pnpm-linked
// node_modules/@forge/* — breaking Forge itself. An out-of-repo dir with its own git
// init is the agent's sole project root.
const WORK = join(process.env.HOME, 'forge-lh-work', `${AGENT}-${ts}`)
const RESULTS = join(HERE, 'runs')
mkdirSync(WORK, { recursive: true }); mkdirSync(RESULTS, { recursive: true })

function envFromSecrets() {
  const e = {}
  for (const l of readFileSync(SECRETS, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2] }
  return e
}
const SEC = envFromSecrets()
function minimaxKey() {
  try { const c = JSON.parse(readFileSync(join(FORGE_ROOT, '.forge', 'config.json'), 'utf8')); return c?.providers?.minimax?.apiKey || c?.provider?.apiKey || process.env.MINIMAX_API_KEY || '' } catch { return process.env.MINIMAX_API_KEY || '' }
}
const MINIMAX_KEY = minimaxKey()
const log = (m) => console.log(`[lh ${AGENT}] ${m}`)
function sh(cmd, opts = {}) {
  try { return { stdout: execSync(cmd, { encoding: 'utf8', ...opts }), exitCode: 0 } }
  catch (e) { return { stdout: (e.stdout || '') + (e.stderr || ''), exitCode: e.status ?? 1 } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function warmOllama() { try { await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: 'qwen2.5-coder:14b', messages: [{ role: 'user', content: 'ok' }], stream: false }) }) } catch {} }

async function runForge() {
  const db = sh(`${join(FORGE_ROOT, '_bench')}/freshdb.sh lh_${AGENT}`, { timeout: 60000 }).stdout.trim().split('\n').pop()
  log(`fresh DB ${db}`); await warmOllama()
  const stateDir = join(RESULTS, `forge-state-${ts}`)
  mkdirSync(stateDir, { recursive: true })
  cpSync(join(FORGE_ROOT, '.forge', 'config.json'), join(stateDir, 'config.json'))
  const livePath = join(RESULTS, `forge-live-${ts}.log`)
  const live = createWriteStream(livePath, { flags: 'w' })
  log(`live feed → ${livePath}`)
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn('node', [FORGE_CLI, 'run', '--file', SPEC, '--text', '--max-iterations', String(MAX_ITER)],
      { cwd: WORK, env: { ...process.env, FORGE_DATABASE_URL: db, MINIMAX_API_KEY: MINIMAX_KEY, FORGE_STATE_DIR: stateDir } })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d; live.write(d) })
    const kt = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_H * 3600000)
    child.on('close', (code) => {
      clearTimeout(kt); live.end()
      const m = (out + err).match(/Main-model tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out\s*over\s*(\d+)\s*calls/)
      const cr = (out + err).match(/Cache-read tokens:\s*(\d+)/)
      const it = (out + err).match(/Iterations:\s*(\d+)/)
      resolve({ exitCode: code ?? 1, runtimeMs: Date.now() - start,
        tokens: m ? { inputTokens: +m[1], outputTokens: +m[2], calls: +m[3], cacheReadTokens: cr ? +cr[1] : 0 } : null,
        iterations: it ? +it[1] : 0 })
    })
  })
}
function runOpencode() {
  const start = Date.now()
  const task = readFileSync(SPEC, 'utf8')
  const livePath = join(RESULTS, `opencode-live-${ts}.log`)
  const live = createWriteStream(livePath, { flags: 'w' })
  log(`live feed → ${livePath}`)
  // Kill any STALE opencode server first: `opencode run` attaches to a running server,
  // and a stale one rooted elsewhere makes opencode treat WORK as an "external_directory"
  // and auto-reject all writes (0 files built). Fresh server → project root = WORK.
  try { execSync('pkill -9 -f "opencode"', { stdio: 'ignore' }) } catch {}
  return new Promise((resolve) => {
    // ARGS ARRAY (no shell): the spec contains backticks + $ that a shell would
    // execute/expand, corrupting the task. spawn-with-array passes it literally.
    // --pure: run core opencode without external plugins. In this env a global plugin
    // hangs opencode at "init" (idle CPU, never reaches the model); --pure skips it and
    // the full core agent + tools (read/write/bash) work normally (verified manually).
    // --dir WORK: pin opencode's project root to the work dir explicitly.
    // --dangerously-skip-permissions: opencode's headless flag — auto-approve writes to
    // its sandbox (Forge also writes freely when autonomous; fair apples-to-apples).
    // stdin from /dev/null so opencode never blocks reading piped input.
    const child = spawn('opencode', ['run', '--pure', '--dangerously-skip-permissions', '--dir', WORK, '-m', 'minimax/MiniMax-M3', '--format', 'json', '--print-logs', '--log-level', 'INFO', task],
      { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MINIMAX_API_KEY: MINIMAX_KEY } })
    let out = ''
    child.stdout.on('data', (d) => { out += d; live.write(d) })
    child.stderr.on('data', (d) => { live.write(d) })
    const kt = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_H * 3600000)
    const done = (code) => {
      clearTimeout(kt); live.end()
      try { execSync('pkill -f "opencode -s"', { stdio: 'ignore' }) } catch {}
      writeFileSync(join(RESULTS, `opencode-stdout-${ts}.log`), out)
      let tokens = null
      try { const j = JSON.parse(out); const u = j?.usage || j?.tokens; if (u) tokens = { inputTokens: u.input ?? u.prompt_tokens ?? 0, outputTokens: u.output ?? u.completion_tokens ?? 0, cacheReadTokens: u.cache_read ?? 0 } } catch {}
      resolve({ exitCode: code ?? 1, runtimeMs: Date.now() - start, tokens, iterations: 0 })
    }
    child.on('close', done)
    child.on('error', (e) => { live.write('\n[runner] opencode spawn error: ' + e.message); done(1) })
  })
}

async function gradeBuiltApp() {
  const r = { installOk: false, buildOk: false, startOk: false, score: { passed: 0, total: 0 }, designScore: 0, checks: [] }
  if (!existsSync(join(WORK, 'package.json'))) { log('no package.json — agent produced no app'); return r }
  log('npm install…')
  r.installOk = sh('npm install --no-audit --no-fund', { cwd: WORK, timeout: 600000 }).exitCode === 0
  log(`install ${r.installOk ? 'ok' : 'FAILED'}; npm run build…`)
  r.buildOk = sh('npm run build', { cwd: WORK, timeout: 600000 }).exitCode === 0
  log(`starting app on :${PORT}…`)
  const appLog = createWriteStream(join(RESULTS, `app-${AGENT}-${ts}.log`), { flags: 'w' })
  const app = spawn('npm', ['start'], { cwd: WORK, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' } })
  app.stdout.on('data', (d) => appLog.write(d)); app.stderr.on('data', (d) => appLog.write(d))
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/login`); r.startOk = true; break } catch { await sleep(1000) } }
  log(`app ${r.startOk ? 'up' : 'did NOT start'}; grading…`)
  const g = sh(`node ${GRADER} http://127.0.0.1:${PORT} ${join(RESULTS, `shots-${AGENT}-${ts}`)}`,
    { env: { ...process.env, STRIPE_SECRET_KEY: SEC.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: SEC.STRIPE_WEBHOOK_SECRET }, timeout: 300000 })
  try { const d = JSON.parse(g.stdout); r.score = { passed: d.passed, total: d.total }; r.checks = d.checks; r.designScore = d.designScore ?? 0; r.designPages = d.designPages; r.screenshots = d.screenshots } catch { r.checks = [{ name: 'grader', passed: false, detail: g.stdout.slice(0, 300) }] }
  app.kill('SIGKILL'); appLog.end()
  return r
}

async function main() {
  log(`workdir ${WORK}`)
  sh('git init -q', { cwd: WORK }); writeFileSync(join(WORK, '.gitkeep'), '')
  // FAIRNESS: give BOTH agents the real Stripe test-mode credentials up front in .env
  // (no agent-specific request protocol). "Did it ask for resources" is observational only,
  // never a graded differentiator — both start with everything they need to build billing.
  writeFileSync(join(WORK, '.env'),
    Object.entries(SEC).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' + `PORT=3000\n`)
  log('wrote .env with Stripe test-mode keys (both agents, up front)')
  const oracle = spawn('node', [ORACLE, WORK, SECRETS], { stdio: ['ignore', 'inherit', 'inherit'] })
  log(`agent run starting (maxIter ${MAX_ITER}, timeout ${TIMEOUT_H}h)…`)
  const run = await (AGENT === 'forge' ? runForge() : runOpencode())
  oracle.kill('SIGKILL')
  log(`agent done in ${(run.runtimeMs / 60000).toFixed(1)}min, exit ${run.exitCode}, iters ${run.iterations}`)
  let oracleLog = []
  try { oracleLog = readFileSync(join(WORK, '.oracle-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
  const grade = await gradeBuiltApp()
  const result = {
    agent: AGENT, ts, workdir: WORK, runtimeMs: run.runtimeMs, iterations: run.iterations,
    tokens: run.tokens, install: grade.installOk, build: grade.buildOk, started: grade.startOk,
    score: grade.score, designScore: grade.designScore, designPages: grade.designPages, screenshots: grade.screenshots,
    askedForResources: oracleLog.length, oracleLog,
    failedChecks: grade.checks.filter((c) => !c.passed).map((c) => c.name),
  }
  const outPath = join(RESULTS, `result-${AGENT}-${ts}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  log(`RESULT: ${grade.score.passed}/${grade.score.total} checks · design ${grade.designScore}/10 · install=${grade.installOk} build=${grade.buildOk} start=${grade.startOk} · asked=${oracleLog.length} · tokens=${run.tokens ? run.tokens.inputTokens + '+' + run.tokens.outputTokens : 'n/a'} · ${outPath}`)
  // Force a clean exit — orphaned app/browser child handles can otherwise keep
  // the event loop alive and leave the driver lingering.
  setTimeout(() => process.exit(0), 500)
}
main().catch((e) => { console.error(e); process.exit(1) })
