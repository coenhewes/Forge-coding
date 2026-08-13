# Build your own domain capability

Forge's semantic MCP fabric is repo-aware and domain-routed. You can add your own domains and capabilities without touching the core. This is the on-ramp for that — and the seed for a future capability marketplace.

## What a domain is

A domain is a bounded slice of the repo with:

- a name
- what files/paths it owns
- a risk profile (billing, auth, data deletion, security, etc.)
- a set of capabilities (tools) the agent can use inside that domain
- optionally, probes that help the agent understand the domain

Domains let Forge constrain the model to the right context and the right tools, instead of giving it the whole repo as a flat pile.

## Where things live

- Domain manifests and the base domain model: `packages/forge-harness/src/domains/` and `packages/forge-harness/src/repo-map/domains.ts`
- Integration domains (the repo-facing capability set): `packages/forge-integrations/src/domains/`
- Probes and routing: `packages/forge-integrations/src/probes.ts` and `packages/forge-integrations/src/router.ts`
- Risk profiles and classification: `packages/forge-harness/src/risk/` and `packages/forge-harness/src/domains/manifests.ts`

## How to add a domain

1. **Define ownership.** Add a manifest entry that says what paths belong to the domain and what risk profile it carries. Follow the pattern in the existing manifests.

2. **Define capabilities.** For each capability, give it a name, a description, and a parameter schema. The name is the interface the model sees; the implementation is the code behind it.

3. **Implement the capability.** Write the function that does the work — reading files, running a query, inspecting a schema, generating a report, etc. Keep it scoped to the domain. Return structured, decision-relevant output, not raw dumps.

4. **Register a probe.** Probes are lightweight inspections the agent can run to understand a domain before acting. Add a probe that returns the signal the agent needs (structure, boundaries, current state, relevant files).

5. **Wire it into the fabric.** Make sure the domain and its capabilities are discoverable through the router/probe layer. The agent should be able to find the domain and its tools when the task touches that part of the repo.

6. **Add tests.** Domains are product surface. Test the manifest, the capabilities, and the probes like real code.

## Capability naming and schema

- Capability names should be stable and descriptive.
- Parameter schemas should be tight — the model should know what it can and cannot pass.
- Outputs should preserve signal and drop noise. The agent operates on signal, not raw context.

## MCP server integration

If you want to expose a domain through an external MCP server rather than in-process code:

1. Build the MCP server with the tools your domain needs.
2. Make sure the server's tool names and schemas are compatible with what Forge expects (tool names matter; schemas must be clean).
3. Configure Forge to use that server as a provider for the relevant domain or capability set.
4. Keep the server's output scoped and reviewable — Forge is built around evidence and verification, so pasted-in outputs should be traceable.

## Example: a billing domain

A billing domain would:

- own `billing*`, `invoice*`, `payment*`, stripe-related paths
- carry a "billing" risk profile so the risk model escalates verification
- expose capabilities like "read current plan/usage," "list invoices," "simulate a plan change," "check Stripe state"
- have probes that report the current billing surface and any outstanding webhooks/subscriptions

That's the shape. The risk profile is what makes the domain matter to the harness, not just to the model.

## Why this matters for monetization

Domains are how Forge becomes useful on a specific stack, and how other people can sell or share capability. A domain pack for "Rails billing with Stripe" or "Next.js auth with Clerk" is a sellable artifact later, once the core is sticky. For now, the point is to show that the fabric is extensible — that's the "repo-aware fabric, not just another tool list" story.
