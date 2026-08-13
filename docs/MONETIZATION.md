# Forge monetization

Short version: keep Forge MIT and free as a local CLI (adoption + feedback), and build a hosted runner + team layer on top. Charge for the things the harness already does better than a chat tool: verified, reviewable PRs; token efficiency; audit trails; approval gates.

## Money model in one picture

```
FREE / OSS CLI  →  HOSTED RUNNER (usage or sub)  →  TEAM / ENTERPRISE (seats, audit, SSO)
     |                      |                              |
  local use, adopt       "run it on my repo"           collab, risk gates,
  feedback, stars       managed state/secrets/compute  compliance, support
```

Optional add-ons later: MCP/plugin marketplace (take a cut), API access, services/consulting.

## What we'd charge for, in priority order

1. **Hosted cloud runner** — the first revenue wedge. Users bring a repo and a task; Forge runs it and returns a reviewed PR or a clear status. This is the "run it on my repo without standing up Postgres/Ollama" story. Charge usage-based (per task, per token, per minute) or a flat subscription with a free tier. The ~2.2x token efficiency is the margin advantage — lead with "cheaper per reviewable PR than the alternatives."

2. **Team / Enterprise** — the higher-ACV layer on top of hosted. Shared task state, approval gates driven by the risk model, audit trails from the ledgers, Slack/Linear notifications, GitHub App, SSO, compliance, org-wide usage. Most of this maps onto primitives that already exist: durable state, ledgers, risk model, verification matrix.

3. **GitHub App** — install as a GitHub App that opens PRs on demand or from issues/comments. Charge per seat, per PR, or per org. This is distribution and revenue together.

4. **Later, optional** — MCP/plugin marketplace (take a cut), API access for other tools, services/consulting ("we run Forge for your team").

## What stays free

The MIT CLI for local/individual use. This is the adoption and feedback engine, not a revenue source. Don't pivot it into a paywall; it's the wedge.

## Honest gaps to name in marketing

- **Quality is a tie vs opencode** on the benchmark tasks; do NOT lead with "better output." Lead with reliability, token efficiency, and reviewable-PR quality (evidence ledgers, verification matrix).
- **Design quality is below bar for both agents** — say so.
- **Forgeflow benchmark is not yet published** — finish it before claiming it.
- **Distribution is the real blocker** — the repo is currently stale with low visibility. Phase 0 must ship a "try it on your repo" hook fast.

## Pre-requisites before first money

- A real "try it on your repo" path that works for a stranger in under 10 minutes.
- Forgeflow finished and published as the enterprise proof.
- Real PRs opening on real repos (not just PR-body files).
- One or two honest public case studies, not just benchmarks.
- A billing layer. Stripe is already proven in-repo via Forgeflow, so reuse it.

## Sequencing

Do Phase 0 first (positioning + one-command demo + observability surface), then Phase 1 (finish Forgeflow, more real-repo proof, GitHub App hardening), then Phase 2 (hosted runner with billing). Team/Enterprise pricing comes after the hosted runner works for one user.

See also: `forge-monetization-plan.md` at repo root for the full sequencing.
