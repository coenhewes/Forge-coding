#!/usr/bin/env node
// Resource oracle / watcher for the long-horizon benchmark.
// Simulates a responsive human/PM who supplies things an AI genuinely cannot self-provision
// (real API keys/secrets). Agent-agnostic + unattended: both Forge and opencode use the same
// file channel, so the comparison is fair and the "did it ask correctly" behavior is observable.
//
// Usage: node resource-oracle.mjs <WORKDIR> <SECRETS_ENV>
//   Watches  <WORKDIR>/RESOURCE_REQUESTS.txt   for lines like  "REQUEST: <text>"
//   Fulfills by appending KEY=VALUE to  <WORKDIR>/.env  and a note to <WORKDIR>/RESOURCE_GRANTS.txt
//   Logs every request+grant to <WORKDIR>/.oracle-log.jsonl (for scoring the ask-capability).

import fs from 'node:fs'
import path from 'node:path'

const WORKDIR = process.argv[2]
const SECRETS = process.argv[3]
if (!WORKDIR || !SECRETS) { console.error('usage: resource-oracle.mjs <WORKDIR> <SECRETS_ENV>'); process.exit(1) }

function parseEnv(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
const secrets = parseEnv(SECRETS)

const ORACLE = [
  {
    match: /stripe|billing|payment|subscription|webhook|publishable|secret key|api key/i,
    grant: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'],
    label: 'Stripe test-mode credentials',
  },
]

const reqFile = path.join(WORKDIR, 'RESOURCE_REQUESTS.txt')
const envFile = path.join(WORKDIR, '.env')
const grantFile = path.join(WORKDIR, 'RESOURCE_GRANTS.txt')
const logFile = path.join(WORKDIR, '.oracle-log.jsonl')

let processed = 0
function envHas(key) {
  try { return fs.readFileSync(envFile, 'utf8').split('\n').some((l) => l.startsWith(key + '=')) } catch { return false }
}
function grant(reqText) {
  const hit = ORACLE.find((o) => o.match.test(reqText))
  const ts = new Date().toISOString()
  if (!hit) {
    fs.appendFileSync(grantFile, `[${ts}] REQUEST: ${reqText}\n  → NOT AVAILABLE. Use your best engineering judgment and proceed.\n`)
    fs.appendFileSync(logFile, JSON.stringify({ ts, request: reqText, granted: [], fulfilled: false }) + '\n')
    return
  }
  for (const key of hit.grant) {
    if (secrets[key] && !envHas(key)) fs.appendFileSync(envFile, `${key}=${secrets[key]}\n`)
  }
  fs.appendFileSync(grantFile, `[${ts}] REQUEST: ${reqText}\n  → GRANTED ${hit.label}: wrote ${hit.grant.join(', ')} to .env\n`)
  fs.appendFileSync(logFile, JSON.stringify({ ts, request: reqText, granted: hit.grant, fulfilled: true }) + '\n')
}

console.log(`[oracle] watching ${reqFile}`)
setInterval(() => {
  let lines
  try { lines = fs.readFileSync(reqFile, 'utf8').split('\n') } catch { return }
  for (; processed < lines.length; processed++) {
    const m = lines[processed].match(/^\s*REQUEST:\s*(.+?)\s*$/i)
    if (m) { console.log(`[oracle] fulfilling: ${m[1]}`); grant(m[1]) }
  }
}, 1500)
