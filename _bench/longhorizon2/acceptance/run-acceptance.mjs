#!/usr/bin/env node
// Forgeflow acceptance grader — broad coverage across every feature area so incompleteness and
// regressions surface as a gradient (not pass/fail). Fail-soft: a connection error or thrown check
// counts as a failed check, never crashes the run. Comparison is Forge-vs-opencode against the SAME
// grader, so any systematic check bug penalizes both equally (the COMPARISON stays fair).
//
// Usage: node run-acceptance.mjs <baseUrl> <screenshotDir>
import crypto from 'node:crypto'
import http from 'node:http'
import { scoreDesign } from './design-score.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:3000'
const SHOTS = process.argv[3] || '/tmp/forgeflow-shots'
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''

const checks = []
const C = (name, passed, detail = '') => checks.push({ name, passed: !!passed, detail: String(detail ?? '').slice(0, 140) })
const rnd = () => Math.random().toString(36).slice(2, 9)

// fail-soft fetch; returns {status, headers, json, text, cookie}
async function req(method, path, { body, cookie, token, raw, multipart } = {}) {
  try {
    const headers = {}
    let payload
    if (multipart) { payload = multipart.body; headers['content-type'] = multipart.contentType }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    if (cookie) headers.cookie = cookie
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch {}
    const sc = res.headers.get('set-cookie')
    return { status: res.status, headers: res.headers, json, text, cookie: sc ? sc.split(';')[0] : null }
  } catch (e) { return { status: 0, text: String(e.message), error: true } }
}

async function newUser(tag) {
  const email = `${tag}_${rnd()}@t.dev`
  const r = await req('POST', '/api/auth/signup', { body: { email, password: 'password123', name: tag } })
  return { email, cookie: r.cookie, id: r.json?.id, signup: r }
}

function stripeSig(rawBody) {
  const t = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${sig}`
}
async function postWebhook(eventObj, { badSig } = {}) {
  const raw = JSON.stringify(eventObj)
  const sig = badSig ? 't=1,v1=deadbeef' : stripeSig(raw)
  try {
    const res = await fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw })
    return { status: res.status }
  } catch (e) { return { status: 0, error: String(e.message) } }
}

async function main() {
  // ---------- AUTH ----------
  const u = await newUser('owner')
  C('auth: signup → 201 + cookie', u.signup.status === 201 && !!u.cookie, `status ${u.signup.status}`)
  const dup = await req('POST', '/api/auth/signup', { body: { email: u.email, password: 'password123', name: 'x' } })
  C('auth: duplicate email → 409', dup.status === 409, `status ${dup.status}`)
  const badpw = await req('POST', '/api/auth/signup', { body: { email: `b_${rnd()}@t.dev`, password: 'x', name: 'x' } })
  C('auth: weak password → 422', badpw.status === 422, `status ${badpw.status}`)
  const login = await req('POST', '/api/auth/login', { body: { email: u.email, password: 'password123' } })
  C('auth: login → 200 + cookie', login.status === 200 && !!login.cookie)
  if (login.cookie) u.cookie = login.cookie
  const badlogin = await req('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong' } })
  C('auth: bad login → 401', badlogin.status === 401, `status ${badlogin.status}`)
  const me = await req('GET', '/api/me', { cookie: u.cookie })
  C('auth: GET /api/me → 200 with orgs[]', me.status === 200 && Array.isArray(me.json?.orgs))
  const meUnauth = await req('GET', '/api/me')
  C('auth: /api/me unauth → 401', meUnauth.status === 401, `status ${meUnauth.status}`)

  // ---------- ORGS ----------
  const org = await req('POST', '/api/orgs', { cookie: u.cookie, body: { name: 'Acme' } })
  const orgId = org.json?.id
  C('orgs: create → 201', org.status === 201 && !!orgId, `status ${org.status}`)
  const org2 = await req('POST', '/api/orgs', { cookie: u.cookie, body: { name: 'Beta' } })
  C('orgs: free plan 2nd owned org → 402', org2.status === 402, `status ${org2.status}`)
  const getOrg = await req('GET', `/api/orgs/${orgId}`, { cookie: u.cookie })
  C('orgs: GET own org → 200 role=owner', getOrg.status === 200 && getOrg.json?.role === 'owner', `role ${getOrg.json?.role}`)
  const stranger = await newUser('stranger')
  const strangerGet = await req('GET', `/api/orgs/${orgId}`, { cookie: stranger.cookie })
  C('orgs: non-member GET → 403', strangerGet.status === 403, `status ${strangerGet.status}`)
  const patchOrg = await req('PATCH', `/api/orgs/${orgId}`, { cookie: u.cookie, body: { name: 'Acme Inc' } })
  C('orgs: owner PATCH → 200', patchOrg.status === 200, `status ${patchOrg.status}`)

  // ---------- MEMBERS / INVITES / ROLES ----------
  const member = await newUser('member')
  const invite = await req('POST', `/api/orgs/${orgId}/invites`, { cookie: u.cookie, body: { email: member.email, role: 'member' } })
  C('members: owner invite → 201 + token', invite.status === 201 && !!invite.json?.token, `status ${invite.status}`)
  const accept = await req('POST', `/api/invites/${invite.json?.token}/accept`, { cookie: member.cookie })
  C('members: accept invite → 200', accept.status === 200, `status ${accept.status}`)
  const memberList = await req('GET', `/api/orgs/${orgId}/members`, { cookie: member.cookie })
  C('members: member can list members → 200', memberList.status === 200 && Array.isArray(memberList.json), `status ${memberList.status}`)
  const memberInvite = await req('POST', `/api/orgs/${orgId}/invites`, { cookie: member.cookie, body: { email: `z_${rnd()}@t.dev`, role: 'member' } })
  C('members: member cannot invite → 403', memberInvite.status === 403, `status ${memberInvite.status}`)
  // free plan member limit = 3 (owner + member = 2; add 1 more ok =3; 4th → 402)
  const m3 = await newUser('m3'); const inv3 = await req('POST', `/api/orgs/${orgId}/invites`, { cookie: u.cookie, body: { email: m3.email, role: 'member' } })
  if (inv3.json?.token) await req('POST', `/api/invites/${inv3.json.token}/accept`, { cookie: m3.cookie })
  const inv4 = await req('POST', `/api/orgs/${orgId}/invites`, { cookie: u.cookie, body: { email: `m4_${rnd()}@t.dev`, role: 'member' } })
  C('members: free member limit (4th) → 402', inv4.status === 402, `status ${inv4.status}`)
  const promote = await req('PATCH', `/api/orgs/${orgId}/members/${member.id}`, { cookie: u.cookie, body: { role: 'admin' } })
  C('members: owner change role → 200', promote.status === 200, `status ${promote.status}`)
  const memberRemove = await req('DELETE', `/api/orgs/${orgId}/members/${m3.id}`, { cookie: member.cookie })
  C('members: removing a member as admin → 204', memberRemove.status === 204, `status ${memberRemove.status}`)

  // ---------- PROJECTS ----------
  const proj = await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'Website', key: 'WEB' } })
  const projId = proj.json?.id
  C('projects: create → 201', proj.status === 201 && !!projId, `status ${proj.status}`)
  const dupKey = await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'Other', key: 'WEB' } })
  C('projects: duplicate key → 409', dupKey.status === 409, `status ${dupKey.status}`)
  await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'P2', key: 'P2' } })
  await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'P3', key: 'P3' } })
  const proj4 = await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'P4', key: 'P4' } })
  C('projects: free plan limit (4th) → 402', proj4.status === 402, `status ${proj4.status}`)
  const projList = await req('GET', `/api/orgs/${orgId}/projects`, { cookie: u.cookie })
  C('projects: list → 200', projList.status === 200 && Array.isArray(projList.json))

  // ---------- TASKS ----------
  const task = await req('POST', `/api/projects/${projId}/tasks`, { cookie: u.cookie, body: { title: 'First task', priority: 'high' } })
  const taskId = task.json?.id
  C('tasks: create → 201', task.status === 201 && !!taskId, `status ${task.status}`)
  const emptyT = await req('POST', `/api/projects/${projId}/tasks`, { cookie: u.cookie, body: { title: '' } })
  C('tasks: empty title → 422', emptyT.status === 422, `status ${emptyT.status}`)
  const badPrio = await req('POST', `/api/projects/${projId}/tasks`, { cookie: u.cookie, body: { title: 'x', priority: 'NOPE' } })
  C('tasks: invalid priority → 422', badPrio.status === 422, `status ${badPrio.status}`)
  const tlist = await req('GET', `/api/projects/${projId}/tasks`, { cookie: u.cookie })
  C('tasks: list → 200 with {tasks,total}', tlist.status === 200 && Array.isArray(tlist.json?.tasks), `keys ${tlist.json && Object.keys(tlist.json)}`)
  // seed several for filter/search/pagination
  for (let i = 0; i < 5; i++) await req('POST', `/api/projects/${projId}/tasks`, { cookie: u.cookie, body: { title: `seed ${i} alpha`, status: i % 2 ? 'doing' : 'todo' } })
  const filtered = await req('GET', `/api/projects/${projId}/tasks?status=doing`, { cookie: u.cookie })
  C('tasks: filter by status', filtered.status === 200 && (filtered.json?.tasks || []).every(t => t.status === 'doing'), `n=${filtered.json?.tasks?.length}`)
  const searched = await req('GET', `/api/projects/${projId}/tasks?q=alpha`, { cookie: u.cookie })
  C('tasks: full-text search q', searched.status === 200 && (searched.json?.tasks?.length > 0))
  const paged = await req('GET', `/api/projects/${projId}/tasks?page=1&pageSize=2`, { cookie: u.cookie })
  C('tasks: pagination (pageSize=2)', paged.status === 200 && (paged.json?.tasks?.length <= 2) && typeof paged.json?.total === 'number')
  const patchT = await req('PATCH', `/api/tasks/${taskId}`, { cookie: u.cookie, body: { status: 'done' } })
  C('tasks: patch status → 200', patchT.status === 200, `status ${patchT.status}`)
  const badStatus = await req('PATCH', `/api/tasks/${taskId}`, { cookie: u.cookie, body: { status: 'nope' } })
  C('tasks: invalid status → 422', badStatus.status === 422, `status ${badStatus.status}`)
  // assign to member → should create a notification for member
  const assign = await req('PATCH', `/api/tasks/${taskId}`, { cookie: u.cookie, body: { assigneeId: member.id } })
  C('tasks: assign to member → 200', assign.status === 200, `status ${assign.status}`)

  // ---------- LABELS ----------
  const label = await req('POST', `/api/projects/${projId}/labels`, { cookie: u.cookie, body: { name: 'bug', color: '#f00' } })
  C('labels: create → 201', label.status === 201 && !!label.json?.id, `status ${label.status}`)
  const addLabel = await req('POST', `/api/tasks/${taskId}/labels`, { cookie: u.cookie, body: { labelId: label.json?.id } })
  C('labels: attach to task', addLabel.status === 200 || addLabel.status === 201, `status ${addLabel.status}`)
  const labelList = await req('GET', `/api/projects/${projId}/labels`, { cookie: u.cookie })
  C('labels: list → 200', labelList.status === 200 && Array.isArray(labelList.json))

  // ---------- COMMENTS ----------
  const comment = await req('POST', `/api/tasks/${taskId}/comments`, { cookie: u.cookie, body: { body: 'looks good' } })
  C('comments: add → 201', comment.status === 201, `status ${comment.status}`)
  const emptyC = await req('POST', `/api/tasks/${taskId}/comments`, { cookie: u.cookie, body: { body: '' } })
  C('comments: empty → 422', emptyC.status === 422, `status ${emptyC.status}`)
  const clist = await req('GET', `/api/tasks/${taskId}/comments`, { cookie: u.cookie })
  C('comments: list → 200', clist.status === 200 && Array.isArray(clist.json))

  // ---------- NOTIFICATIONS (member was assigned + commented-on) ----------
  const notifs = await req('GET', '/api/notifications', { cookie: member.cookie })
  C('notifications: list → 200', notifs.status === 200 && Array.isArray(notifs.json))
  C('notifications: assignment created one', (notifs.json || []).length > 0, `n=${notifs.json?.length}`)
  if (notifs.json?.[0]?.id) { const rd = await req('POST', `/api/notifications/${notifs.json[0].id}/read`, { cookie: member.cookie }); C('notifications: mark read → 204', rd.status === 204, `status ${rd.status}`) } else C('notifications: mark read → 204', false, 'no notif')
  const readAll = await req('POST', '/api/notifications/read-all', { cookie: member.cookie })
  C('notifications: read-all → 204', readAll.status === 204, `status ${readAll.status}`)
  // SSE endpoint should advertise text/event-stream
  try { const sse = await fetch(BASE + '/api/notifications/stream', { headers: { cookie: u.cookie, accept: 'text/event-stream' }, signal: AbortSignal.timeout(3000) }); C('notifications: SSE stream content-type', (sse.headers.get('content-type') || '').includes('text/event-stream'), sse.headers.get('content-type')); sse.body?.cancel?.() } catch (e) { C('notifications: SSE stream content-type', false, String(e.message).slice(0, 40)) }

  // ---------- ATTACHMENTS ----------
  const boundary = '----fg' + rnd()
  const fileBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello forgeflow\r\n--${boundary}--\r\n`
  const upload = await req('POST', `/api/tasks/${taskId}/attachments`, { cookie: u.cookie, multipart: { contentType: `multipart/form-data; boundary=${boundary}`, body: fileBody } })
  C('attachments: upload → 201', upload.status === 201 && !!upload.json?.id, `status ${upload.status}`)
  if (upload.json?.id) { const dl = await req('GET', `/api/attachments/${upload.json.id}`, { cookie: u.cookie }); C('attachments: download → 200', dl.status === 200 && /hello forgeflow/.test(dl.text), `status ${dl.status}`) } else C('attachments: download → 200', false, 'no upload')

  // ---------- BILLING (real Stripe; agent provisioned its own catalog) ----------
  const checkout = await req('POST', `/api/orgs/${orgId}/billing/checkout`, { cookie: u.cookie, body: { plan: 'pro' } })
  C('billing: checkout → real checkout.stripe.com url', checkout.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(checkout.json?.url || ''), `status ${checkout.status} url ${(checkout.json?.url || '').slice(0, 30)}`)
  const badSig = await postWebhook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { client_reference_id: orgId } } }, { badSig: true })
  C('billing: webhook bad signature → 400', badSig.status === 400, `status ${badSig.status}`)
  const goodHook = await postWebhook({ id: 'evt_' + rnd(), type: 'checkout.session.completed', data: { object: { client_reference_id: String(orgId), customer: 'cus_test', subscription: 'sub_test' } } })
  C('billing: signed webhook → 200', goodHook.status === 200, `status ${goodHook.status}`)
  const afterUpgrade = await req('GET', `/api/orgs/${orgId}`, { cookie: u.cookie })
  C('billing: webhook upgraded org to pro', ['pro', 'business'].includes(afterUpgrade.json?.plan), `plan ${afterUpgrade.json?.plan}`)
  const proj4b = await req('POST', `/api/orgs/${orgId}/projects`, { cookie: u.cookie, body: { name: 'P4', key: 'P4B' } })
  C('billing: limits lifted after upgrade (4th project ok)', proj4b.status === 201, `status ${proj4b.status}`)

  // ---------- API TOKENS + v1 + RATE LIMIT (pro now) ----------
  const tok = await req('POST', '/api/tokens', { cookie: u.cookie, body: { name: 'ci' } })
  const apiToken = tok.json?.token
  C('api: create token (pro) → 201 + token shown once', tok.status === 201 && !!apiToken, `status ${tok.status}`)
  const v1ok = await req('GET', '/api/v1/projects', { token: apiToken })
  C('api: GET /api/v1/projects with Bearer → 200', v1ok.status === 200, `status ${v1ok.status}`)
  const v1bad = await req('GET', '/api/v1/projects', { token: 'bogus' })
  C('api: bad bearer token → 401', v1bad.status === 401, `status ${v1bad.status}`)
  const v1task = await req('POST', `/api/v1/projects/${projId}/tasks`, { token: apiToken, body: { title: 'via api' } })
  C('api: v1 create task → 201', v1task.status === 201, `status ${v1task.status}`)
  // rate limit: hammer 65x, expect a 429
  let got429 = false
  if (apiToken) for (let i = 0; i < 65; i++) { const r = await req('GET', '/api/v1/projects', { token: apiToken }); if (r.status === 429) { got429 = true; break } }
  C('api: rate limit → 429 after 60/min', got429)

  // ---------- OUTGOING WEBHOOKS (pro) ----------
  let received = null
  const receiver = http.createServer((rq, rs) => { let b = ''; rq.on('data', d => b += d); rq.on('end', () => { received = { sig: rq.headers['x-forgeflow-signature'], body: b }; rs.writeHead(200); rs.end('ok') }) })
  await new Promise(res => receiver.listen(0, '127.0.0.1', res))
  const rxPort = receiver.address().port
  const wh = await req('POST', `/api/orgs/${orgId}/webhooks`, { cookie: u.cookie, body: { url: `http://127.0.0.1:${rxPort}/hook`, events: ['task.created'] } })
  C('webhooks: register (pro) → 201', wh.status === 201 || wh.status === 200, `status ${wh.status}`)
  // trigger a task.created and give it a moment to deliver
  await req('POST', `/api/projects/${projId}/tasks`, { cookie: u.cookie, body: { title: 'fires webhook' } })
  await new Promise(r => setTimeout(r, 2500))
  C('webhooks: outgoing delivered with signature', !!received && /sha256=/.test(received.sig || ''), received ? 'received' : 'no delivery')
  receiver.close()

  // ---------- AUDIT ----------
  const audit = await req('GET', `/api/orgs/${orgId}/audit`, { cookie: u.cookie })
  C('audit: owner can read audit log → 200 list', audit.status === 200 && Array.isArray(audit.json), `status ${audit.status}`)
  C('audit: log captured actions', Array.isArray(audit.json) && audit.json.length > 0, `n=${audit.json?.length}`)
  const auditForbidden = await req('GET', `/api/orgs/${orgId}/audit`, { cookie: stranger.cookie })
  C('audit: non-member → 403/401', [401, 403].includes(auditForbidden.status), `status ${auditForbidden.status}`)

  // ---------- UI FLOWS (real browser) ----------
  await runUiFlows(C)

  // ---------- DESIGN (local vision) ----------
  let design = { designScore: null, pages: [], screenshots: [] }
  try { design = await scoreDesign(BASE, SHOTS) } catch (e) { design.error = String(e.message).slice(0, 80) }

  const passed = checks.filter(c => c.passed).length
  console.log(JSON.stringify({ total: checks.length, passed, checks, designScore: design.designScore, designPages: design.pages, screenshots: design.screenshots }, null, 2))
}

// Minimal browser flow: signup → create org → create project → add task → comment, plus login/logout.
async function runUiFlows(C) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { C('ui: playwright available', false, 'no playwright'); return }
  let browser
  try { browser = await chromium.launch() } catch (e) { C('ui: browser launch', false, String(e.message).slice(0, 40)); return }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(String(e.message)))
  const email = `ui_${rnd()}@t.dev`
  try {
    // signup
    await page.goto(BASE + '/signup', { waitUntil: 'domcontentloaded', timeout: 12000 })
    await page.fill('[data-testid=email]', email).catch(() => {})
    await page.fill('[data-testid=password]', 'password123').catch(() => {})
    await page.fill('[data-testid=name]', 'UI User').catch(() => {})
    await page.click('[data-testid=submit]').catch(() => {})
    await page.waitForTimeout(2000)
    C('ui: signup form logs in (→ /app)', /\/app/.test(page.url()) && !/login|signup/.test(page.url()), `url ${page.url().replace(BASE, '')}`)
    // create org (may already prompt)
    await page.fill('[data-testid=new-org-name]', 'UI Org').catch(() => {})
    await page.click('[data-testid=create-org]').catch(() => {})
    await page.waitForTimeout(1500)
    // create project
    await page.fill('[data-testid=new-project-name]', 'UI Project').catch(() => {})
    await page.fill('[data-testid=new-project-key]', 'UIP').catch(() => {})
    await page.click('[data-testid=create-project]').catch(() => {})
    await page.waitForTimeout(1500)
    const projVisible = await page.locator('[data-testid=project-item]').count().catch(() => 0)
    C('ui: project appears after create', projVisible > 0, `count ${projVisible}`)
    // open project, add task
    await page.locator('[data-testid=project-item]').first().click().catch(() => {})
    await page.waitForTimeout(1200)
    await page.fill('[data-testid=new-task-title]', 'UI task').catch(() => {})
    await page.click('[data-testid=add-task]').catch(() => {})
    await page.waitForTimeout(1500)
    const taskVisible = await page.locator('[data-testid=task-item]').count().catch(() => 0)
    C('ui: task appears after add', taskVisible > 0, `count ${taskVisible}`)
    C('ui: no JS errors during core flow', errs.length === 0, errs[0] || '')
    // logout + bad login
    await page.click('[data-testid=logout]').catch(() => {})
    await page.waitForTimeout(1000)
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.fill('[data-testid=email]', email).catch(() => {})
    await page.fill('[data-testid=password]', 'wrongpass').catch(() => {})
    await page.click('[data-testid=submit]').catch(() => {})
    await page.waitForTimeout(1500)
    const errShown = await page.locator('[data-testid=error]').count().catch(() => 0)
    C('ui: bad login shows error', errShown > 0, `errEls ${errShown}`)
  } catch (e) { C('ui: core flow completed', false, String(e.message).slice(0, 60)) }
  await browser.close().catch(() => {})
}

main().catch(e => { console.log(JSON.stringify({ total: checks.length || 1, passed: checks.filter(c => c.passed).length, checks: [...checks, { name: 'grader-crash', passed: false, detail: String(e.message).slice(0, 200) }] })); })
