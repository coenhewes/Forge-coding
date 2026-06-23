# Long-horizon benchmark — Forge vs opencode

A blank-repo, single-prompt **"build a complete SaaS"** benchmark. It exists to test the harness, not
the model: both agents run the **same model** (MiniMax-M3), the **same machine**, and the **same
spec**, so any difference is the harness.

- **`longhorizon/`** — *TaskFlow*: a mid-size SaaS (auth, projects, tasks, Stripe billing).
- **`longhorizon2/`** — *Forgeflow*: a deliberately larger multi-tenant SaaS (orgs/RBAC, seat-based
  billing the agent provisions itself, API tokens + rate limiting, outgoing webhooks, audit log) —
  scoped to exceed a single model session, to probe long-horizon sustainability.

## How a run works

```
blank git repo  →  agent builds (Forge loop, or `opencode run`)  →  install + build + start
                →  blind acceptance grader  →  result-<agent>-<ts>.json
```

```bash
node longhorizon-runner.mjs --agent forge      # or: --agent opencode
```

The runner writes the agent's working copy **outside** the repo, drops a `.env` with Stripe
**test-mode** keys for *both* agents up front (so billing is testable without any agent-specific
protocol), runs the agent, then grades the running app.

## Grading (`acceptance/`) — three independent dimensions

1. **Works** — real browser flows (Playwright): sign up, log in, create, etc. actually clicked through.
2. **Complete** — the exact REST contract + a **real Stripe signed webhook** (HMAC over the raw body)
   that must flip the user/org to a paid plan.
3. **Designed** — key pages screenshotted and scored 0–10 by a **local vision model**
   (`llama3.2-vision` via Ollama) — unmetered, no main-model cost.

The grader is **fail-soft**: a connection error or a thrown check counts as a failed check, never a
crash. Because both agents hit the identical grader, any systematic grader quirk penalizes both
equally — the *comparison* stays fair even where absolute scores are imperfect.

## Requirements

- Node 20+ (the apps use the built-in `node:sqlite`, so Node 26 is fine)
- Postgres on `:54329` (Forge state) and Ollama (`llama3.2-vision` for design scoring)
- MiniMax configured for Forge; `opencode` on PATH for the baseline
- Stripe **test-mode** secrets in `.secrets/stripe.env` (gitignored — never committed)

## Reproducing the head-to-head

```bash
./run-fair-gauntlet.sh        # 3 runs/agent, sequential, results in runs/
```

Run artifacts (`runs/`, working copies, logs) are gitignored — they are reproducible outputs, not
source. See the repo root `README.md` → **Benchmarks** for current results.
