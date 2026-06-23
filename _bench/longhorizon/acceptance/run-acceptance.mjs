#!/usr/bin/env node
// Hidden acceptance grader for the TaskFlow long-horizon benchmark — THREE dimensions:
//   WORKS    — real browser UI flows (ui-flow.mjs) drive the actual forms a user would.
//   COMPLETE — deterministic API/contract checks (incl. real Stripe signed webhook).
//   DESIGNED — local vision model rates screenshots (design-score.mjs).
// Usage: node run-acceptance.mjs <BASE_URL> [SHOTS_DIR]
// Emits JSON: { total, passed, checks[], designScore, designPages[], screenshots[] }.
import crypto from 'node:crypto'
import { runUiFlows } from './ui-flow.mjs'
import { scoreDesign } from './design-score.mjs'
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '')
const SHOTS = process.argv[3] || '/tmp/taskflow-shots'
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || ''
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const checks = []
const rnd = () => Math.random().toString(36).slice(2, 10)

function stripeSig(rawBody, secret) {
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}
function checkoutCompletedEvent(userId) {
  return JSON.stringify({
    id: 'evt_' + rnd(), object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_' + rnd(), object: 'checkout.session', mode: 'subscription', client_reference_id: userId, customer: 'cus_' + rnd(), payment_status: 'paid', status: 'complete' } },
  })
}

function jar() { return { cookie: '' } }
async function req(j, method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' }
  if (j.cookie) headers.cookie = j.cookie
  let res
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: opts.redirect ?? 'follow' })
  } catch (e) {
    return { status: 0, json: null, text: '', netError: String(e.message || e) }
  }
  const setc = res.headers.get('set-cookie')
  if (setc) j.cookie = setc.split(';')[0]
  let json = null
  const text = await res.text()
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}
async function check(name, fn) {
  try { const detail = await fn(); checks.push({ name, passed: true, detail: detail ?? 'ok' }) }
  catch (e) { checks.push({ name, passed: false, detail: String(e && e.message ? e.message : e).slice(0, 200) }) }
}
function expect(cond, msg) { if (!cond) throw new Error(msg) }

async function main() {
  const A = jar(), B = jar()
  const emailA = `a_${rnd()}@t.dev`, emailB = `b_${rnd()}@t.dev`, pw = 'password123'

  await check('signup A → 201 {id,email,plan:free} + cookie', async () => {
    const r = await req(A, 'POST', '/api/auth/signup', { email: emailA, password: pw })
    expect(r.status === 201, `status ${r.status}`); expect(r.json && r.json.email === emailA, 'email echoed')
    expect(r.json.plan === 'free', 'default plan free'); expect(A.cookie, 'session cookie set')
  })
  await check('signup duplicate email → 409', async () => { const r = await req(jar(), 'POST', '/api/auth/signup', { email: emailA, password: pw }); expect(r.status === 409, `status ${r.status}`) })
  await check('signup short password → 422', async () => { const r = await req(jar(), 'POST', '/api/auth/signup', { email: `x_${rnd()}@t.dev`, password: 'short' }); expect(r.status === 422, `status ${r.status}`) })
  await check('GET /api/me unauth → 401', async () => { const r = await req(jar(), 'GET', '/api/me'); expect(r.status === 401, `status ${r.status}`) })
  await check('login bad creds → 401', async () => { const r = await req(jar(), 'POST', '/api/auth/login', { email: emailA, password: 'wrongpass1' }); expect(r.status === 401, `status ${r.status}`) })
  await check('login A good → 200 + cookie', async () => { const r = await req(A, 'POST', '/api/auth/login', { email: emailA, password: pw }); expect(r.status === 200, `status ${r.status}`); expect(A.cookie, 'cookie set') })
  await check('GET /api/me auth → 200 {email}', async () => { const r = await req(A, 'GET', '/api/me'); expect(r.status === 200 && r.json && r.json.email === emailA, `status ${r.status}`) })
  await check('signup B (second user)', async () => { const r = await req(B, 'POST', '/api/auth/signup', { email: emailB, password: pw }); expect(r.status === 201, `status ${r.status}`) })

  let projA1 = null
  await check('POST project A → 201 {id,name}', async () => { const r = await req(A, 'POST', '/api/projects', { name: 'Proj 1' }); expect(r.status === 201 && r.json && r.json.id != null, `status ${r.status}`); projA1 = r.json.id })
  await check('GET projects A → lists own with taskCount', async () => { const r = await req(A, 'GET', '/api/projects'); expect(r.status === 200 && Array.isArray(r.json), `status ${r.status}`); const p = r.json.find((x) => x.id === projA1); expect(p && p.taskCount === 0, 'project present taskCount 0') })
  await check('POST project empty name → 422', async () => { const r = await req(A, 'POST', '/api/projects', { name: '' }); expect(r.status === 422, `status ${r.status}`) })
  await check('free plan: 4th project → 402', async () => { await req(A, 'POST', '/api/projects', { name: 'P2' }); await req(A, 'POST', '/api/projects', { name: 'P3' }); const r = await req(A, 'POST', '/api/projects', { name: 'P4' }); expect(r.status === 402, `status ${r.status}`) })
  await check('PATCH project rename → 200', async () => { const r = await req(A, 'PATCH', `/api/projects/${projA1}`, { name: 'Renamed' }); expect(r.status === 200 && r.json && r.json.name === 'Renamed', `status ${r.status}`) })
  await check('authz: B cannot rename A project → 403/404', async () => { const r = await req(B, 'PATCH', `/api/projects/${projA1}`, { name: 'hack' }); expect(r.status === 403 || r.status === 404, `status ${r.status}`) })
  await check("authz: B's project list excludes A's", async () => { const r = await req(B, 'GET', '/api/projects'); expect(r.status === 200 && Array.isArray(r.json), `status ${r.status}`); expect(!r.json.some((x) => x.id === projA1), 'isolation broken') })

  let taskA1 = null
  await check('POST task → 201', async () => { const r = await req(A, 'POST', `/api/projects/${projA1}/tasks`, { title: 'Task 1' }); expect(r.status === 201 && r.json && r.json.id != null, `status ${r.status}`); taskA1 = r.json.id })
  await check('GET tasks → includes it', async () => { const r = await req(A, 'GET', `/api/projects/${projA1}/tasks`); expect(r.status === 200 && Array.isArray(r.json) && r.json.some((t) => t.id === taskA1), `status ${r.status}`) })
  await check('PATCH task status=done → 200', async () => { const r = await req(A, 'PATCH', `/api/tasks/${taskA1}`, { status: 'done' }); expect(r.status === 200 && r.json && r.json.status === 'done', `status ${r.status}`) })
  await check('PATCH task invalid status → 422', async () => { const r = await req(A, 'PATCH', `/api/tasks/${taskA1}`, { status: 'banana' }); expect(r.status === 422, `status ${r.status}`) })
  await check('authz: B cannot add task to A project → 403/404', async () => { const r = await req(B, 'POST', `/api/projects/${projA1}/tasks`, { title: 'x' }); expect(r.status === 403 || r.status === 404, `status ${r.status}`) })
  await check('free plan: 21st task → 402', async () => { for (let i = 0; i < 19; i++) await req(A, 'POST', `/api/projects/${projA1}/tasks`, { title: `t${i}` }); const r = await req(A, 'POST', `/api/projects/${projA1}/tasks`, { title: 'overflow' }); expect(r.status === 402, `status ${r.status}`) })

  const meA = await req(A, 'GET', '/api/me')
  const userIdA = meA.json && meA.json.id
  await check('POST /api/billing/checkout → real Stripe Checkout Session', async () => {
    const r = await req(A, 'POST', '/api/billing/checkout', {})
    expect(r.status === 200 && r.json, `status ${r.status}`)
    const url = r.json.url || '', sid = r.json.sessionId || r.json.id || ''
    expect(/checkout\.stripe\.com/.test(url) || /^cs_/.test(sid), `no real checkout (url=${url.slice(0, 40)} sid=${sid.slice(0, 12)})`)
    if (STRIPE_SECRET && /^cs_/.test(sid)) { const s = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sid}`, { headers: { authorization: `Bearer ${STRIPE_SECRET}` } }); expect(s.status === 200, `Stripe session not found (${s.status})`) }
  })
  await check('signed webhook checkout.session.completed → upgrades to pro', async () => {
    expect(STRIPE_WEBHOOK_SECRET, 'grader missing STRIPE_WEBHOOK_SECRET'); expect(userIdA, 'no user id')
    const raw = checkoutCompletedEvent(userIdA)
    const res = await fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(raw, STRIPE_WEBHOOK_SECRET) }, body: raw })
    expect(res.status === 200, `webhook status ${res.status}`)
    const me2 = await req(A, 'GET', '/api/me'); expect(me2.json && me2.json.plan === 'pro', `plan = ${me2.json && me2.json.plan}`)
  })
  await check('pro plan lifts project limit (4th ok)', async () => { const p = await req(A, 'POST', '/api/projects', { name: 'Pro P4' }); expect(p.status === 201, `status ${p.status}`) })
  await check('webhook BAD signature → 400', async () => { const raw = checkoutCompletedEvent(userIdA); const res = await fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: raw }); expect(res.status === 400, `status ${res.status}`) })

  const hasTestids = (html, ids) => ids.every((id) => html.includes(`data-testid="${id}"`))
  await check('GET /signup → 200 + testids', async () => { const r = await req(jar(), 'GET', '/signup'); expect(r.status === 200, `status ${r.status}`); expect(hasTestids(r.text, ['email', 'password', 'submit']), 'testids') })
  await check('GET /login → 200 + testids', async () => { const r = await req(jar(), 'GET', '/login'); expect(r.status === 200 && hasTestids(r.text, ['email', 'password', 'submit']), `status ${r.status}`) })
  await check('GET /dashboard unauth → redirect /login', async () => { const r = await req(jar(), 'GET', '/dashboard', undefined, { redirect: 'manual' }); expect([301, 302, 303, 307].includes(r.status), `got ${r.status}`) })
  await check('GET /dashboard auth → 200 + testids', async () => { const r = await req(A, 'GET', '/dashboard'); expect(r.status === 200, `status ${r.status}`); expect(hasTestids(r.text, ['new-project-name', 'create-project', 'logout']), 'testids') })
  await check('GET /projects/:id auth → 200 + task testids', async () => { const r = await req(A, 'GET', `/projects/${projA1}`); expect(r.status === 200 && hasTestids(r.text, ['new-task-title', 'add-task']), `status ${r.status}`) })
  await check('logout → 204 then /api/me → 401', async () => { const r = await req(A, 'POST', '/api/auth/logout'); expect(r.status === 204, `status ${r.status}`); const me = await req(A, 'GET', '/api/me'); expect(me.status === 401, `me ${me.status}`) })

  // WORKS — real browser UI flows.
  try { const ui = await runUiFlows(BASE); for (const c of ui) checks.push(c) }
  catch (e) { checks.push({ name: 'UI: flow suite', passed: false, detail: String(e).slice(0, 200) }) }

  // DESIGNED — local vision model on screenshots.
  let design = { designScore: 0, pages: [], screenshots: [] }
  try { design = await scoreDesign(BASE, SHOTS) } catch (e) { design.error = String(e).slice(0, 200) }

  const passed = checks.filter((c) => c.passed).length
  process.stdout.write(JSON.stringify({ total: checks.length, passed, checks, designScore: design.designScore, designPages: design.pages, screenshots: design.screenshots }, null, 2))
}
main().catch((e) => { process.stdout.write(JSON.stringify({ total: checks.length, passed: checks.filter((c) => c.passed).length, checks, fatal: String(e) }, null, 2)); process.exit(0) })
