// TaskFlow reference implementation — validates the spec + acceptance suite are well-formed.
// node:sqlite + real Stripe + working server-rendered UI forms (no client JS needed).
import express from 'express'
import cookieParser from 'cookie-parser'
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing')
const PRICE_ID = process.env.STRIPE_PRICE_ID || ''
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''

const db = new DatabaseSync(process.env.DB_FILE || 'data.sqlite')
db.exec('PRAGMA journal_mode = WAL;')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT, plan TEXT DEFAULT 'free', createdAt TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT);
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, userId TEXT, name TEXT, createdAt TEXT);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, projectId TEXT, title TEXT, status TEXT DEFAULT 'todo', dueDate TEXT, createdAt TEXT);
`)
const id = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const app = express()
app.use(cookieParser())
app.post('/api/billing/webhook', express.raw({ type: '*/*' }), (req, res) => {
  let event
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET) }
  catch { return res.status(400).json({ error: 'bad signature' }) }
  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') {
    const uid = event.data.object.client_reference_id
    if (uid) db.prepare('UPDATE users SET plan=? WHERE id=?').run('pro', uid)
  }
  res.json({ received: true })
})
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

function auth(req, res, next) {
  const tok = req.cookies.sid
  const s = tok && db.prepare('SELECT userId FROM sessions WHERE token=?').get(tok)
  if (!s) return res.status(401).json({ error: 'unauthenticated' })
  req.user = db.prepare('SELECT * FROM users WHERE id=?').get(s.userId)
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' })
  next()
}
const pub = (u) => ({ id: u.id, email: u.email, plan: u.plan })

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !/.+@.+\..+/.test(email) || !password || password.length < 8) return res.status(422).json({ error: 'invalid' })
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'exists' })
  const u = { id: id(), email, passwordHash: bcrypt.hashSync(password, 8), plan: 'free', createdAt: now() }
  db.prepare('INSERT INTO users (id,email,passwordHash,plan,createdAt) VALUES (?,?,?,?,?)').run(u.id, u.email, u.passwordHash, u.plan, u.createdAt)
  const tok = id(); db.prepare('INSERT INTO sessions (token,userId) VALUES (?,?)').run(tok, u.id)
  res.cookie('sid', tok, { httpOnly: true }).status(201).json(pub(u))
})
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {}
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '')
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: 'bad creds' })
  const tok = id(); db.prepare('INSERT INTO sessions (token,userId) VALUES (?,?)').run(tok, u.id)
  res.cookie('sid', tok, { httpOnly: true }).status(200).json(pub(u))
})
app.post('/api/auth/logout', (req, res) => { if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.cookies.sid); res.clearCookie('sid').status(204).end() })
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)))

app.get('/api/projects', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM projects WHERE userId=? ORDER BY createdAt').all(req.user.id)
  res.json(rows.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, taskCount: db.prepare('SELECT count(*) c FROM tasks WHERE projectId=?').get(p.id).c })))
})
app.post('/api/projects', auth, (req, res) => {
  const { name } = req.body || {}
  if (!name || !String(name).trim()) return res.status(422).json({ error: 'name required' })
  if (req.user.plan === 'free' && db.prepare('SELECT count(*) c FROM projects WHERE userId=?').get(req.user.id).c >= 3) return res.status(402).json({ error: 'free plan limit' })
  const p = { id: id(), userId: req.user.id, name, createdAt: now() }
  db.prepare('INSERT INTO projects (id,userId,name,createdAt) VALUES (?,?,?,?)').run(p.id, p.userId, p.name, p.createdAt)
  res.status(201).json({ id: p.id, name: p.name })
})
function ownProject(req, res) { const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id); if (!p) { res.status(404).json({ error: 'not found' }); return null } if (p.userId !== req.user.id) { res.status(403).json({ error: 'forbidden' }); return null } return p }
app.patch('/api/projects/:id', auth, (req, res) => { const p = ownProject(req, res); if (!p) return; const { name } = req.body || {}; if (!name || !String(name).trim()) return res.status(422).json({ error: 'name required' }); db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, p.id); res.json({ id: p.id, name }) })
app.delete('/api/projects/:id', auth, (req, res) => { const p = ownProject(req, res); if (!p) return; db.prepare('DELETE FROM tasks WHERE projectId=?').run(p.id); db.prepare('DELETE FROM projects WHERE id=?').run(p.id); res.status(204).end() })
app.get('/api/projects/:id/tasks', auth, (req, res) => { const p = ownProject(req, res); if (!p) return; res.json(db.prepare('SELECT id,title,status,dueDate,createdAt FROM tasks WHERE projectId=? ORDER BY createdAt').all(p.id)) })
app.post('/api/projects/:id/tasks', auth, (req, res) => {
  const p = ownProject(req, res); if (!p) return
  const { title, dueDate } = req.body || {}
  if (!title || !String(title).trim()) return res.status(422).json({ error: 'title required' })
  if (req.user.plan === 'free' && db.prepare('SELECT count(*) c FROM tasks WHERE projectId=?').get(p.id).c >= 20) return res.status(402).json({ error: 'free task limit' })
  const t = { id: id(), projectId: p.id, title, status: 'todo', dueDate: dueDate || null, createdAt: now() }
  db.prepare('INSERT INTO tasks (id,projectId,title,status,dueDate,createdAt) VALUES (?,?,?,?,?,?)').run(t.id, t.projectId, t.title, t.status, t.dueDate, t.createdAt)
  res.status(201).json({ id: t.id, title: t.title, status: t.status })
})
function ownTask(req, res) { const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id); if (!t) { res.status(404).json({ error: 'not found' }); return null } const p = db.prepare('SELECT * FROM projects WHERE id=?').get(t.projectId); if (!p || p.userId !== req.user.id) { res.status(403).json({ error: 'forbidden' }); return null } return t }
app.patch('/api/tasks/:id', auth, (req, res) => {
  const t = ownTask(req, res); if (!t) return
  const { title, status, dueDate } = req.body || {}
  if (status !== undefined && !['todo', 'doing', 'done'].includes(status)) return res.status(422).json({ error: 'bad status' })
  const nt = { title: title ?? t.title, status: status ?? t.status, dueDate: dueDate !== undefined ? dueDate : t.dueDate }
  db.prepare('UPDATE tasks SET title=?,status=?,dueDate=? WHERE id=?').run(nt.title, nt.status, nt.dueDate, t.id)
  res.json({ id: t.id, title: nt.title, status: nt.status, dueDate: nt.dueDate })
})
app.delete('/api/tasks/:id', auth, (req, res) => { const t = ownTask(req, res); if (!t) return; db.prepare('DELETE FROM tasks WHERE id=?').run(t.id); res.status(204).end() })
app.post('/api/billing/checkout', auth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: PRICE_ID, quantity: 1 }], client_reference_id: req.user.id, customer_email: req.user.email, success_url: 'http://localhost/success', cancel_url: 'http://localhost/cancel' })
    res.json({ url: session.url, sessionId: session.id })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// --- UI (working server-rendered forms) ---
const page = (body) => `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><title>TaskFlow</title></head><body>${body}</body></html>`
const sessUser = (req) => { const tok = req.cookies.sid; const s = tok && db.prepare('SELECT userId FROM sessions WHERE token=?').get(tok); return s ? s.userId : null }
function setSession(res, userId) { const tok = id(); db.prepare('INSERT INTO sessions (token,userId) VALUES (?,?)').run(tok, userId); res.cookie('sid', tok, { httpOnly: true }) }
const authPage = (kind, err) => page(`<h1>${kind}</h1><form method=post action="/ui/${kind}"><input data-testid="email" name=email type=email placeholder=email><input data-testid="password" name=password type=password placeholder=password><button data-testid="submit" type=submit>${kind}</button></form>${err ? `<div data-testid="error">${err}</div>` : ''}`)
app.get('/signup', (req, res) => res.type('html').send(authPage('signup', req.query.error ? 'Sign-up failed' : '')))
app.get('/login', (req, res) => res.type('html').send(authPage('login', req.query.error ? 'Invalid email or password' : '')))
app.post('/ui/signup', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !/.+@.+\..+/.test(email) || !password || password.length < 8 || db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.redirect(302, '/signup?error=1')
  const u = { id: id(), email, passwordHash: bcrypt.hashSync(password, 8) }
  db.prepare('INSERT INTO users (id,email,passwordHash,plan,createdAt) VALUES (?,?,?,?,?)').run(u.id, u.email, u.passwordHash, 'free', now())
  setSession(res, u.id); res.redirect(302, '/dashboard')
})
app.post('/ui/login', (req, res) => {
  const { email, password } = req.body || {}
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '')
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) return res.redirect(302, '/login?error=1')
  setSession(res, u.id); res.redirect(302, '/dashboard')
})
app.post('/ui/logout', (req, res) => { if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.cookies.sid); res.clearCookie('sid').redirect(302, '/login') })
app.get('/dashboard', (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const ps = db.prepare('SELECT * FROM projects WHERE userId=?').all(uid)
  res.type('html').send(page(`<h1>Dashboard</h1><form method=post action="/ui/logout"><button data-testid="logout" type=submit>Logout</button></form><form method=post action="/ui/checkout"><button data-testid="upgrade" type=submit>Upgrade to Pro</button></form><form method=post action="/ui/projects"><input data-testid="new-project-name" name=name><button data-testid="create-project" type=submit>Create</button></form><ul>${ps.map((p) => `<li data-testid="project-item"><a href="/projects/${p.id}">${p.name}</a></li>`).join('')}</ul>`))
})
app.post('/ui/projects', (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const name = (req.body?.name || '').trim()
  if (name) { const u = db.prepare('SELECT plan FROM users WHERE id=?').get(uid); const c = db.prepare('SELECT count(*) c FROM projects WHERE userId=?').get(uid).c; if (u.plan === 'pro' || c < 3) db.prepare('INSERT INTO projects (id,userId,name,createdAt) VALUES (?,?,?,?)').run(id(), uid, name, now()) }
  res.redirect(302, '/dashboard')
})
app.post('/ui/checkout', async (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid)
  try { const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: PRICE_ID, quantity: 1 }], client_reference_id: uid, customer_email: u.email, success_url: 'http://localhost/success', cancel_url: 'http://localhost/cancel' }); res.redirect(303, session.url) }
  catch { res.redirect(302, '/dashboard') }
})
app.get('/projects/:id', (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)
  if (!p || p.userId !== uid) return res.redirect(302, '/dashboard')
  const tsk = db.prepare('SELECT * FROM tasks WHERE projectId=?').all(p.id)
  res.type('html').send(page(`<h1>Tasks</h1><form method=post action="/ui/projects/${p.id}/tasks"><input data-testid="new-task-title" name=title><button data-testid="add-task" type=submit>Add</button></form><ul>${tsk.map((t) => `<li data-testid="task-item">${t.title} (${t.status}) <form style="display:inline" method=post action="/ui/tasks/${t.id}/done"><button data-testid="task-done" type=submit>done</button></form></li>`).join('')}</ul>`))
})
app.post('/ui/projects/:id/tasks', (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)
  if (p && p.userId === uid) { const title = (req.body?.title || '').trim(); if (title) db.prepare('INSERT INTO tasks (id,projectId,title,status,dueDate,createdAt) VALUES (?,?,?,?,?,?)').run(id(), p.id, title, 'todo', null, now()) }
  res.redirect(302, '/projects/' + req.params.id)
})
app.post('/ui/tasks/:id/done', (req, res) => {
  const uid = sessUser(req); if (!uid) return res.redirect(302, '/login')
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id)
  if (t) { const p = db.prepare('SELECT * FROM projects WHERE id=?').get(t.projectId); if (p && p.userId === uid) db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', t.id) }
  res.redirect(302, '/projects/' + (t ? t.projectId : ''))
})

const port = process.env.PORT || 3000
app.listen(port, '0.0.0.0', () => console.log(`TaskFlow reference on ${port}`))
