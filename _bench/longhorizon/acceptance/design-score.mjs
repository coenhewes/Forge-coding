// Design-quality scoring via a LOCAL vision model (Ollama llama3.2-vision) — on-thesis local offload.
// Screenshots each key page (desktop+mobile), rates 0-10 against a modern-SaaS rubric, returns avg +
// per-page detail + screenshot paths (surfaced to the user). Unmetered, no main-model cost.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OLLAMA = 'http://127.0.0.1:11434'
const VISION_MODEL = process.env.VISION_MODEL || 'llama3.2-vision'

const RUBRIC = `You are a strict senior product designer rating ONE screenshot of a SaaS web app.
Score its VISUAL DESIGN 0-10 for a modern, polished, professional product. Use this scale HARSHLY:
 0-1 = raw unstyled HTML (default fonts, no layout, no color).
 2-3 = minimal/ugly styling, looks like a developer placeholder.
 4-5 = basic styling but generic/unfinished, weak hierarchy/spacing.
 6-7 = clean and competent, looks like a real product.
 8-9 = polished and modern (Linear/Stripe/Notion tier): strong layout, type, color, components, spacing.
 10  = exceptional.
Reply with ONLY one line: "SCORE: <n>/10 — <short reason>".`

async function scoreImage(b64) {
  // Best-effort: a flaky local vision model must NOT break grading. Retry once; return null on failure
  // (screenshots are still captured + surfaced to the user regardless).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = JSON.stringify({ model: VISION_MODEL, prompt: RUBRIC, images: [b64], stream: false, keep_alive: '10m', options: { temperature: 0 } })
      const res = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body, signal: AbortSignal.timeout(180000) })
      if (!res.ok) { if (attempt === 0) continue; return { score: null, note: `vision unavailable (HTTP ${res.status})` } }
      const txt = (await res.json()).response || ''
      // Lenient: the model may write "SCORE: 7/10", "rated 7/10", or just "7/10".
      const m = txt.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i) || txt.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)
      return { score: m ? Number(m[1]) : null, note: txt.trim().replace(/\s+/g, ' ').slice(0, 180) || 'vision returned no score' }
    } catch (e) { if (attempt === 1) return { score: null, note: 'vision unavailable: ' + String(e.message).slice(0, 80) } }
  }
  return { score: null, note: 'vision unavailable' }
}

async function authCookie(BASE) {
  try {
    const email = `dz_${Math.random().toString(36).slice(2, 8)}@t.dev`
    const r = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })
    const c = r.headers.get('set-cookie'); if (!c) return null
    const cookie = c.split(';')[0]
    const pr = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Launch plan' }) })
    let pid = null; try { pid = (await pr.json()).id } catch {}
    if (pid) await fetch(`${BASE}/api/projects/${pid}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'Draft spec' }) }).catch(() => {})
    return { cookie, pid }
  } catch { return null }
}

export async function scoreDesign(BASE, outDir) {
  mkdirSync(outDir, { recursive: true })
  const result = { designScore: 0, pages: [], screenshots: [] }
  let browser
  try { browser = await chromium.launch() } catch (e) { result.error = 'browser: ' + e.message; return result }
  const auth = await authCookie(BASE)
  const cookieHeader = auth?.cookie
  const pages = [
    { name: 'login', path: '/login' }, { name: 'signup', path: '/signup' },
    { name: 'dashboard', path: '/dashboard' },
    ...(auth?.pid ? [{ name: 'project', path: `/projects/${auth.pid}` }] : []),
  ]
  for (const vp of [{ tag: 'desktop', width: 1280, height: 800 }, { tag: 'mobile', width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    if (cookieHeader) { const [k, v] = cookieHeader.split('='); const u = new URL(BASE); await ctx.addCookies([{ name: k, value: v, domain: u.hostname, path: '/' }]) }
    const page = await ctx.newPage()
    for (const pg of pages) {
      const shot = join(outDir, `${pg.name}-${vp.tag}.png`)
      try {
        await page.goto(BASE + pg.path, { waitUntil: 'networkidle', timeout: 8000 })
        await page.screenshot({ path: shot, fullPage: false }); result.screenshots.push(shot)
        if (vp.tag === 'desktop') { const b64 = (await page.screenshot({ fullPage: false })).toString('base64'); const s = await scoreImage(b64); result.pages.push({ page: pg.name, score: s.score, note: s.note }) }
      } catch (e) { result.pages.push({ page: pg.name, score: 0, note: 'render/screenshot failed: ' + String(e.message).slice(0, 80) }) }
    }
    await ctx.close()
  }
  await browser.close().catch(() => {})
  const scored = result.pages.filter((p) => typeof p.score === 'number')
  // null (not 0) distinguishes "vision unavailable" from "genuinely scored 0".
  result.designScore = scored.length ? Math.round((scored.reduce((a, p) => a + p.score, 0) / scored.length) * 10) / 10 : null
  return result
}
