# The Semantic MCP Fabric

Forge does not hand the model a flat filesystem and a pile of tools. It first
understands the repository as a mapped software system, then exposes
*purpose-built, repo-aware capabilities* to the agent. That capability surface
is the **Semantic MCP Fabric**.

This document explains how the fabric works and how you can add your own:

- a **capability** — a single scoped tool the agent can call (e.g.
  `repo.find_callers`, `db.get_table_schema`, `tests.find_related_tests`)
- a **domain** — a slice of the repo with ownership, permissions, and a risk
  profile (e.g. `frontend`, `auth`, `database`)

Extending the fabric is the intended way to teach Forge about your stack. It is
also the on-ramp to shared/domain capability packs.

---

## Mental model

```text
Repo
  → Repo Intelligence maps it (packages, routes, services, schema, tests, graph)
  → Domains slice it (who owns what, what is risky, what must be verified)
  → Capabilities expose it (scoped tools the agent can call, not raw file access)
  → Router sends the task to the relevant domains/capabilities
  → Bounded context keeps the model fed only what it needs
```

The agent operates *through* capabilities, not by grepping the whole tree. That
is what keeps context small and PRs reviewable (see the token numbers in the
[README](../README.md#benchmarks)).

---

## Capabilities

A capability is one unit of agent-accessible functionality. Shape
(`packages/forge-harness/src/mcp-fabric/capabilities.ts`):

```ts
type CapabilityImplementation = {
  definition: {
    name: string          // e.g. "repo.find_callers"
    description: string
    inputSchema: JSONSchema  // validated before the handler runs
    domain: string          // which domain owns it
  }
  handler: (input: any, context: CapabilityContext) => Promise<CapabilityResult>
}
```

Built-in capabilities live in
`packages/forge-harness/src/mcp-fabric/capabilities/{repo,db,auth,tests}.ts`.

### Add your own capability

1. Create `packages/forge-harness/src/mcp-fabric/capabilities/my-stack.ts`:

```ts
import type { CapabilityImplementation } from './capabilities.js'

export const myStackCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'cache.invalidate',
      description: 'Invalidate a cache key or prefix in the Redis layer.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or prefix to invalidate' },
        },
        required: ['key'],
      },
      domain: 'my-stack',
    },
    handler: async (input, context) => {
      const key = input.key as string
      if (!key) return { success: false, error: 'No key provided' }
      // ... do the work, return structured data ...
      return { success: true, data: { invalidated: key } }
    },
  },
]
```

2. Register it in `packages/forge-harness/src/mcp-fabric/index.ts`:

```ts
export { myStackCapabilities } from './capabilities/my-stack.js'
```

3. Wire it into the registry where `buildCapabilityRegistry` is assembled
   (`packages/forge-harness/src/mcp-fabric/real-capabilities.ts`):

```ts
import { myStackCapabilities } from './capabilities/my-stack.js'
// add myStackCapabilities to the array passed to the CapabilityRegistry
```

The agent can now call `cache.invalidate` and see it in its capability list.

---

## Domains

A domain declares ownership of files, what the agent may read/write there, what
it relates to, and how risky changes are. Shape
(`packages/forge-harness/src/domains/manifests.ts`):

```ts
type DomainManifest = {
  domain: string
  owns: string[]            // globs this domain owns
  allowedReads: string[]
  allowedWrites: string[]
  relatedDomains: string[]
  forbiddenByDefault: string[]   // cross-domain writes blocked unless expanded
  riskProfile: string[]         // feeds the risk model
  verification: string[]         // which checks to run
  reviewSensitivity: 'low' | 'medium' | 'high' | 'critical'
}
```

`DEFAULT_DOMAINS` ships `frontend`, `backend`, `auth`, `database`, `tests`,
and more.

### Add your own domain

1. Extend `DEFAULT_DOMAINS` in `packages/forge-harness/src/domains/manifests.ts`:

```ts
{
  domain: 'infra',
  owns: ['infra/**', 'terraform/**', 'k8s/**', 'deploy/**'],
  allowedReads: ['infra/**', 'terraform/**', 'k8s/**', 'deploy/**', '**/*.yaml'],
  allowedWrites: ['infra/**', 'terraform/**', 'k8s/**', 'deploy/**'],
  relatedDomains: ['backend', 'database'],
  forbiddenByDefault: ['frontend/**', 'app/**', 'src/**'],
  riskProfile: ['infra_changes', 'deploys'],
  verification: ['plan_check', 'drift_check'],
  reviewSensitivity: 'critical',
},
```

2. `generateCapabilitiesFromManifests` (in `generator.ts`) automatically creates
   `infra.read_files` and `infra.search_code` for the new domain — no extra
   wiring needed.

When a task touches `infra/**`, the router (`domains/router.ts`, `routeTask`)
adds the `infra` domain to the active set, and `requestDomainExpansion` widens
scope if evidence shows the change is cross-domain.

---

## The router

`routeTask` (in `packages/forge-harness/src/domains/router.ts`) maps a task
string to the domains it likely touches. The risk model (`risk/index.ts`) then
uses each domain's `riskProfile` and `reviewSensitivity` to decide how much
verification and (in team setups) human approval a change needs.

---

## Why this matters for packaging

The fabric is what lets Forge be taught new stacks without retraining the model:
add a domain + capabilities and the agent immediately has scoped, reviewable
access to that part of your system. Shared capability packs — first-party or
community — are a natural distribution and (later) monetization surface. See
the [README](../README.md) for the product direction.
