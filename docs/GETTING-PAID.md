# Getting Paid: from free CLI to revenue

This is the concrete, build-order companion to [MONETIZATION.md](./MONETIZATION.md) — that doc sets the
strategy; this one is the action list. The domain mechanics behind the Team/Enterprise layer live in
[MCP-DOMAIN-HOWTO.md](./MCP-DOMAIN-HOWTO.md).

The whole play in one line: **give the CLI away (MIT), charge for running it for people (hosted runner),
then charge teams to run it safely at scale (Team/Enterprise).**

## 1. The free OSS CLI wedge

- Keep `forge` MIT and free for local/individual use. This is the adoption and feedback engine, **not** a
  revenue line. Do not put a paywall in front of it.
- The wedge's only job: stars, installs, real-repo feedback, and a credible "it works on my machine" story.
- Everything that makes the CLI good — verified PRs, evidence ledgers, verification matrix, token
  efficiency — is also what you later sell. Invest in the harness, not a separate paid fork.
- See "What stays free" in MONETIZATION.md.

## 2. Hosted runner = first revenue

The first thing anyone pays for: *"run Forge on my repo without me standing up Postgres/Ollama."*

**Pricing:** usage-based (per task / per token / per minute) or a flat subscription with a free tier. Lead
with the ~2.2x token-efficiency margin — "cheaper per reviewable PR than the alternatives." Do **not** lead
with output quality (it's a tie vs opencode).

**What the runtime owns (you provide, the user doesn't):**

- **State** — the Postgres durable store (`FORGE_DATABASE_URL`): task state, evidence/failure/decision
  ledgers, checkpoints, verification matrix. The user brings a repo + task; you own the memory.
- **Secrets** — GitHub tokens, model keys, and (later) Stripe keys. Scoped per run, never shipped to the
  user's machine.
- **Compute** — the agent loop, local-model accelerator, and verification runs execute on your infra.

**Billing:** reuse the Stripe integration already proven in-repo via Forgeflow. Don't build a second
billing path.

## 3. Team / Enterprise layer

Higher-ACV on top of hosted. Most of it maps onto primitives Forge already has:

- **Risk-model approval gates** — domains carry risk profiles (billing, auth, data deletion, security). A
  `billing` or `auth` domain escalates verification and requires a human gate before a PR merges. See the
  billing-domain example in MCP-DOMAIN-HOWTO.md.
- **Audit trails** — the ledgers (evidence / failure / decision) *are* the audit log. Surface them per org,
  per run, per user.
- **Slack / Linear** — notify on run status, approval requests, and failures.
- **GitHub App** — org-wide install, PRs opened under the App identity (see §4).
- **SSO / compliance** — seat-level auth, SCIM, audit export. This is the enterprise close, not the entry.
- **Org-wide usage** — shared task state and usage dashboards across a team.

Charge seats, orgs, or per-PR. Build this **after** the hosted runner works for one user.

## 4. GitHub App = distribution + revenue

- Ship a GitHub App that opens PRs on demand or from issue/comment triggers (`/forge this`).
- This is both the distribution channel (one click in the Marketplace) and a billing surface
  (per seat / per PR / per org).
- Hardening the App is Phase 1 work (MONETIZATION.md sequencing). It's what turns "I downloaded a CLI"
  into "my whole team uses Forge."

## 5. Pre-reqs before you can charge

Do not flip on billing until all of these are true:

- [ ] A real **"try it on your repo"** path that works for a stranger in < 10 minutes.
- [ ] **Real PRs** opening on real repos — not just PR-body files committed locally.
- [ ] **One honest case study** (a real task, real diff, real verification matrix). Benchmarks are not a
      case study.
- [ ] A **billing layer** live (Stripe, reused from Forgeflow) with a free tier and a paid tier.
- [ ] Forgeflow finished and published as the enterprise proof (MONETIZATION.md pre-reqs).

## 6. Sequencing — what to build first

```
Phase 0  Positioning + one-command demo + observability surface
           (ship "try it on your repo" hook — distribution is the real blocker)
Phase 1  Finish Forgeflow · more real-repo PR proof · harden GitHub App
Phase 2  Hosted runner + billing            ← first money
Phase 3  Team/Enterprise (gates, audit,     ← higher ACV
          Slack/Linear, SSO)
```

**Build first — the two things that unlock the first dollar:**

1. **Phase 0 "try it on your repo" hook** — one command a stranger runs in < 10 min. Distribution is the
   real blocker; ship this before anything else (MONETIZATION.md, Phase 0).
2. **Hosted-runner runtime** — own state (Postgres durable store), secrets (GitHub / model / Stripe keys,
   scoped per run), and compute (agent loop + verification) on your infra, with **Stripe reused from
   Forgeflow** for billing.

Everything in Team/Enterprise is mostly wiring primitives Forge already has (risk model, ledgers, domains)
to a billing seat — do it last, once one user is paying.

## Later (optional)

The domain fabric in MCP-DOMAIN-HOWTO.md is the seed of a future capability marketplace: sellable domain
packs (e.g. "Rails billing with Stripe", "Next.js auth with Clerk"). Not a near-term revenue line — it
only works once the core is sticky.
