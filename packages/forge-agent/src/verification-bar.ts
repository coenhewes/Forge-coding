/**
 * Verification bar — the objective "production-ready" checks that back the
 * done-gate. A criterion can only be marked `verified` once the checks it
 * requires have passing evidence here (not on the model's say-so).
 *
 * Checks (auto-detected from the repo):
 *   - test       — the project's test command
 *   - typecheck  — `tsc --noEmit` (or a `typecheck` script)
 *   - build      — the build command
 *   - boot       — the start/dev command actually starts without crashing
 *   - e2e        — for a web app: load the RUNNING app in a real headless browser,
 *                  assert the UI actually renders without console/page errors, and
 *                  score the visual design with a local vision model. This is what
 *                  catches "the server boots but the UI is broken or bare" — the
 *                  failure boot can't see. Gates completion of web-app tasks.
 *
 * All checks are bounded (timeouts) and never throw to the caller — they return
 * a structured result so the agent loop stays resumable.
 */
import { execSync, spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { VerificationCheckKind } from '@forge/types'

// e2e is now runnable (browser-level). Only 'visual'-style manual checks stay out.
export type RunnableCheck = VerificationCheckKind

export interface CheckResult {
  kind: RunnableCheck
  command: string
  passed: boolean
  output: string
}

const DEFAULT_TIMEOUT_MS = 180_000
const BOOT_WAIT_MS = 8_000
const BOOT_READY_RE = /listening|ready|started|running on|server.*\b\d{2,5}\b|localhost:\d+/i
const BOOT_ERROR_RE = /error|exception|cannot find|EADDRINUSE|unhandled|throw/i

// e2e browser check tunables.
const E2E_READY_TIMEOUT_MS = 30_000
const E2E_DESIGN_MIN = Number(process.env.FORGE_E2E_DESIGN_MIN ?? '6') // avg design score (0-10) the public pages must clear
const VISION_MODEL = process.env.FORGE_VISION_MODEL ?? 'llama3.2-vision'
const OLLAMA_URL = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

/** Detect a runnable command per check kind from package.json + repo layout. */
export function detectChecks(workDir: string): Record<RunnableCheck, string | null> {
  let scripts: Record<string, string> = {}
  const pkgPath = join(workDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {}) as Record<string, string>
    } catch {
      scripts = {}
    }
  }
  const has = (name: string) => typeof scripts[name] === 'string' && scripts[name]!.trim().length > 0
  const hasTsconfig = existsSync(join(workDir, 'tsconfig.json'))
  const startCmd = has('start') ? 'npm start' : has('dev') ? 'npm run dev' : has('serve') ? 'npm run serve' : null

  return {
    test: has('test') ? 'npm test' : null,
    typecheck: has('typecheck') ? 'npm run typecheck' : hasTsconfig ? 'npx tsc --noEmit' : null,
    build: has('build') ? 'npm run build' : null,
    boot: startCmd,
    // e2e only applies to runnable web apps (something to serve + a browser to drive).
    e2e: startCmd,
  }
}

function runCommandCheck(kind: RunnableCheck, workDir: string, command: string): CheckResult {
  try {
    const out = execSync(command, { cwd: workDir, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
    return { kind, command, passed: true, output: (out || '').trim().slice(-4000) || '(no output)' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'check failed'
    return { kind, command, passed: false, output: output.slice(-4000) }
  }
}

/**
 * Boot check: start the server, watch its output for a readiness signal, and
 * treat "stayed up for BOOT_WAIT_MS without crashing or erroring" as success.
 */
function runBootCheck(workDir: string, command: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: workDir, shell: true, detached: true })
    let out = ''
    let settled = false
    const finish = (passed: boolean, note: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      resolve({ kind: 'boot', command, passed, output: `${note}\n${out}`.trim().slice(-4000) })
    }
    child.stdout?.on('data', (d) => {
      out += d.toString()
      if (BOOT_READY_RE.test(out)) finish(true, 'boot: detected readiness signal')
    })
    child.stderr?.on('data', (d) => {
      out += d.toString()
      if (BOOT_ERROR_RE.test(out)) finish(false, 'boot: error in startup output')
    })
    child.on('exit', (code) => finish(code === 0, `boot: process exited early with code ${code}`))
    child.on('error', (e) => finish(false, `boot: failed to start (${e.message})`))
    const timer = setTimeout(() => finish(true, `boot: stayed up ${BOOT_WAIT_MS}ms without crashing`), BOOT_WAIT_MS)
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Rate a PNG screenshot 0-10 for modern-SaaS visual design via a local vision model. */
async function scoreDesign(pngB64: string): Promise<{ score: number | null; note: string }> {
  const rubric = `You are a strict senior product designer rating ONE screenshot of a web app for modern, polished SaaS visual design. Scale HARSHLY: 0-1 raw unstyled HTML; 2-3 ugly placeholder; 4-5 basic/generic; 6-7 clean real product; 8-9 polished (Linear/Stripe/Notion tier); 10 exceptional. Reply with ONLY: SCORE: <n>/10 — <short reason>.`
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      // keep_alive holds the 8GB vision model resident — cold loads intermittently return empty.
      body: JSON.stringify({ model: VISION_MODEL, prompt: rubric, images: [pngB64], stream: false, keep_alive: '10m', options: { temperature: 0 } }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) return { score: null, note: `vision unavailable (HTTP ${res.status})` }
    const txt = ((await res.json()) as { response?: string }).response ?? ''
    const m = txt.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i) ?? txt.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)
    return { score: m ? Number(m[1]) : null, note: txt.trim().replace(/\s+/g, ' ').slice(0, 180) }
  } catch (e) {
    return { score: null, note: 'vision unavailable: ' + String((e as Error).message).slice(0, 80) }
  }
}

/**
 * e2e check: boot the app on a known port, drive its main page in a real headless
 * browser, and require it to (a) actually render meaningful content, (b) throw no
 * console/page errors, and (c) clear the design bar (local vision score). This is
 * the gate that stops "boots but the UI is broken/bare" from passing as done.
 */
async function runE2eCheck(workDir: string, command: string): Promise<CheckResult> {
  const port = 4500 + Math.floor(Math.random() * 500)
  const base = `http://127.0.0.1:${port}`
  const fail = (note: string) => ({ kind: 'e2e' as RunnableCheck, command, passed: false, output: note.slice(-4000) })
  const child = spawn(command, { cwd: workDir, shell: true, detached: true, env: { ...process.env, PORT: String(port), NODE_ENV: 'production' } })
  let appOut = ''
  child.stdout?.on('data', (d) => { appOut += d.toString() })
  child.stderr?.on('data', (d) => { appOut += d.toString() })
  const killApp = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }

  try {
    // Wait for the server to accept connections.
    let up = false
    const deadline = Date.now() + E2E_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      try { await fetch(base + '/', { signal: AbortSignal.timeout(2000) }); up = true; break } catch { await sleep(700) }
    }
    if (!up) { killApp(); return fail(`e2e: app did not become reachable on PORT within ${E2E_READY_TIMEOUT_MS}ms.\n${appOut.slice(-1500)}`) }

    let chromium: typeof import('playwright').chromium
    try { ({ chromium } = await import('playwright')) } catch (e) { killApp(); return fail('e2e: playwright unavailable: ' + String((e as Error).message)) }
    const browser = await chromium.launch()
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      const consoleErrors: string[] = []
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
      const pageErrors: string[] = []
      page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

      // Probe the public surfaces a SaaS exposes (landing/login/signup — the
      // pages reachable without auth) and design-score EVERY one that renders.
      // The design gate then requires the AVERAGE across pages to clear the bar,
      // so a model can't pass by polishing one page and leaving the rest bare
      // (and averaging several vision calls also damps single-call variance).
      let best = { route: '/', status: 0, bodyLen: 0, elementCount: 0 }
      const perPage: { route: string; score: number; note: string }[] = []
      for (const route of ['/', '/login', '/signup']) {
        const resp = await page.goto(base + route, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => null)
        const status = resp?.status() ?? 0
        const bodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).trim()
        const elementCount = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0)
        if (elementCount > best.elementCount) best = { route, status, bodyLen: bodyText.length, elementCount }
        if (status < 400 && elementCount >= 12 && bodyText.length >= 20) {
          const b64 = (await page.screenshot({ fullPage: false }).catch(() => Buffer.from(''))).toString('base64')
          if (b64) { const d = await scoreDesign(b64); if (d.score != null) perPage.push({ route, score: d.score, note: d.note }) }
        }
      }
      const status = best.status
      const bodyLen = best.bodyLen
      const elementCount = best.elementCount
      const avg = perPage.length ? Math.round((perPage.reduce((a, p) => a + p.score, 0) / perPage.length) * 10) / 10 : null
      const weakest = perPage.slice().sort((a, b) => a.score - b.score)[0]
      const design = { score: avg, note: perPage.map((p) => `${p.route} ${p.score}/10`).join(', ') + (weakest ? ` — weakest: ${weakest.route} (${weakest.note})` : '') }

      // FLOW CHECK: a signup/login form must actually WORK when submitted, not
      // just render. Catches the footgun where the form looks fine but submit
      // does nothing (native GET reload) or throws — a user literally cannot sign
      // up. Generic: fill the first email+password form on /signup (or /login)
      // and require a real effect (navigation or a shown error), not a no-op.
      let formProblem: string | null = null
      try {
        const emailSel = '[data-testid=email], input[type=email], input[name=email], input[name*=email i]'
        const passSel = '[data-testid=password], input[type=password], input[name=password]'
        const submitSel = '[data-testid=submit], button[type=submit], form button'
        for (const route of ['/signup', '/login']) {
          await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => null)
          if (!(await page.locator(passSel).count().catch(() => 0))) continue
          const errBefore = pageErrors.length
          await page.fill(emailSel, `gate_${Date.now()}@t.dev`, { timeout: 5000 }).catch(() => {})
          await page.fill(passSel, 'password123', { timeout: 5000 }).catch(() => {})
          const urlBefore = page.url()
          await page.click(submitSel, { timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(2500)
          const urlAfter = page.url()
          const errEl = await page.locator('[data-testid=error], .error, [role=alert]').count().catch(() => 0)
          const nativeSubmit = /[?&](email|password)=/.test(urlAfter)
          const navigated = urlAfter.replace(/\?.*/, '') !== urlBefore.replace(/\?.*/, '')
          if (pageErrors.length > errBefore) formProblem = `the ${route} form throws a JS error on submit (${pageErrors[pageErrors.length - 1]})`
          else if (nativeSubmit) formProblem = `the ${route} form does NOT work — submitting just reloads the page with the values in the URL (the JS submit handler is not wired up; classic onsubmit footgun). A real user CANNOT sign up / log in.`
          else if (navigated || errEl > 0) formProblem = null
          else formProblem = `the ${route} form submit had NO visible effect (no navigation, no error) — it does not actually work for a user`
          break
        }
      } catch { /* never fail the gate because the checker itself errored */ }

      await browser.close().catch(() => {})
      killApp()

      // Benign noise (favicon / static-asset 404s the browser auto-requests) must
      // not hard-fail; only genuine JS errors do.
      const realConsole = consoleErrors.filter((e) => !/favicon|failed to load resource/i.test(e))
      const problems: string[] = []
      if (status && status >= 400) problems.push(`main entry page returned HTTP ${status} (no usable homepage/login at /, /login, or /dashboard)`)
      if (elementCount < 8 || bodyLen < 20) problems.push(`page rendered almost no content (${elementCount} elements, ${bodyLen} chars of text) — likely blank/broken`)
      if (pageErrors.length) problems.push(`uncaught JS errors on load: ${pageErrors.slice(0, 3).join(' | ')}`)
      if (realConsole.length) problems.push(`JS console errors: ${realConsole.slice(0, 3).join(' | ')}`)
      if (formProblem) problems.push(`UI BROKEN — ${formProblem}`)
      // Design enforces ONLY when the vision model actually scored — a flaky/empty
      // vision response must not trap the agent in endless iteration (the render +
      // form + JS-error checks still gate functionality).
      if (design.score != null && design.score < E2E_DESIGN_MIN) problems.push(`design ${design.score}/10 is below the bar (${E2E_DESIGN_MIN}) — make every page look like a polished modern SaaS. ${design.note}`)

      const passed = problems.length === 0
      const summary = passed
        ? `e2e: UI renders (${elementCount} elements), no errors, design ${design.score}/10 — ${design.note}`
        : `e2e FAILED — fix these before finishing:\n- ${problems.join('\n- ')}`
      return { kind: 'e2e', command, passed, output: summary.slice(-4000) }
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (e) {
    killApp()
    return fail('e2e: check errored: ' + String((e as Error).message))
  }
}

/** Run the requested checks (default: all detected). Skips checks with no command. */
export async function runVerification(
  workDir: string,
  kinds?: RunnableCheck[],
): Promise<CheckResult[]> {
  const detected = detectChecks(workDir)
  const wanted = kinds ?? (Object.keys(detected) as RunnableCheck[])
  const results: CheckResult[] = []
  for (const kind of wanted) {
    const command = detected[kind]
    if (!command) continue
    if (kind === 'boot') results.push(await runBootCheck(workDir, command))
    else if (kind === 'e2e') results.push(await runE2eCheck(workDir, command))
    else results.push(runCommandCheck(kind, workDir, command))
  }
  return results
}
