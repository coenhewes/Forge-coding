// Real browser UI-flow checks (headless chromium). Drives the ACTUAL forms a user would —
// fill by data-testid, click submit, assert the real effect. Catches "API works but UI is broken".
import { chromium } from 'playwright'

export async function runUiFlows(BASE) {
  const checks = []
  const add = (name, passed, detail) => checks.push({ name, passed, detail: detail || (passed ? 'ok' : 'failed') })
  const T = 7000
  const email = `ui_${Math.random().toString(36).slice(2, 10)}@t.dev`
  const pw = 'password123'
  let browser
  try { browser = await chromium.launch() } catch (e) { add('UI: browser launch', false, String(e.message).slice(0, 150)); return checks }
  const page = await (await browser.newContext()).newPage()
  const step = async (name, fn) => { try { await fn(); add(name, true) } catch (e) { add(name, false, String(e.message).split('\n')[0].slice(0, 140)) } }

  await step('UI: signup form creates account → /dashboard', async () => {
    await page.goto(`${BASE}/signup`, { timeout: T, waitUntil: 'domcontentloaded' })
    await page.fill('[data-testid=email]', email, { timeout: T })
    await page.fill('[data-testid=password]', pw, { timeout: T })
    await Promise.all([page.waitForURL('**/dashboard', { timeout: T }), page.click('[data-testid=submit]', { timeout: T })])
  })
  await step('UI: dashboard shows project controls', async () => {
    await page.waitForSelector('[data-testid=create-project]', { timeout: T })
    await page.waitForSelector('[data-testid=logout]', { timeout: T })
  })
  await step('UI: create-project adds a visible project', async () => {
    await page.fill('[data-testid=new-project-name]', 'UI Project', { timeout: T })
    await page.click('[data-testid=create-project]', { timeout: T })
    await page.waitForSelector('[data-testid=project-item]', { timeout: T })
  })
  await step('UI: open project + add-task adds a visible task', async () => {
    const link = page.locator('[data-testid=project-item] a').first()
    const target = (await link.count()) ? link : page.locator('[data-testid=project-item]').first()
    await Promise.all([page.waitForURL('**/projects/**', { timeout: T }), target.click({ timeout: T })])
    await page.fill('[data-testid=new-task-title]', 'UI Task', { timeout: T })
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.click('[data-testid=add-task]', { timeout: T })])
    await page.waitForSelector('[data-testid=task-item]', { timeout: T })
  })
  await step('UI: logout returns to /login', async () => {
    await page.goto(`${BASE}/dashboard`, { timeout: T, waitUntil: 'domcontentloaded' })
    await Promise.all([page.waitForURL('**/login', { timeout: T }), page.click('[data-testid=logout]', { timeout: T })])
  })
  await step('UI: wrong-password login shows error', async () => {
    await page.goto(`${BASE}/login`, { timeout: T, waitUntil: 'domcontentloaded' })
    await page.fill('[data-testid=email]', email, { timeout: T })
    await page.fill('[data-testid=password]', 'definitely-wrong', { timeout: T })
    await page.click('[data-testid=submit]', { timeout: T })
    await page.waitForSelector('[data-testid=error]', { timeout: T, state: 'visible' })
  })
  await step('UI: login form logs in → /dashboard', async () => {
    await page.goto(`${BASE}/login`, { timeout: T, waitUntil: 'domcontentloaded' })
    await page.fill('[data-testid=email]', email, { timeout: T })
    await page.fill('[data-testid=password]', pw, { timeout: T })
    await Promise.all([page.waitForURL('**/dashboard', { timeout: T }), page.click('[data-testid=submit]', { timeout: T })])
  })

  await browser.close().catch(() => {})
  return checks
}
