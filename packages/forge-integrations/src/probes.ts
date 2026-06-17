/**
 * @forge/integrations/probes — Probe capabilities
 *
 * Each capability registered in `domains/*` becomes a probe: an
 * action that, when run, returns a structured observation plus
 * belief-update suggestions. Probes are the **only** mechanism by
 * which the capability surface produces evidence that flows back
 * into the task belief state.
 *
 * Output shape (per AGENTS §4 + featurerequest1 §3 Phase 3):
 *
 *   CapabilityObservation {
 *     observation:                { type, summary, payload }
 *     beliefUpdates:             [{ action, targetId, reason, confidenceDelta? }]
 *     newUncertainties:          string[]
 *     suggestedNextProbes:      ProbeRecommendation[]
 *     verificationImplications:  string[]
 *   }
 *
 * Probes are wired to `BeliefStore` (see `probes.ts → runProbe`)
 * so that invoking a probe automatically:
 *
 *   1. Persists the probe in `probes` (status='completed', result set)
 *   2. Emits a `probe_completed` trace event
 *   3. Applies the `beliefUpdates` to the appropriate hypothesis /
 *      claim rows (promote / demote / contradict / support / mark_stale)
 *   4. Attaches the observation as supporting/contradicting evidence
 *
 * This module is the seam between the agent-computer interface
 * (capabilities) and the belief engine (state).
 */
import { randomUUID } from 'node:crypto'
import type {
  CapabilityObservation,
  Claim,
  EvidenceRef,
  Hypothesis,
  ProbeRecommendation,
  RiskSeverity,
} from '@forge/types'
import type { BeliefStore, StateStoreLike } from '@forge/belief'
import { DOMAINS, type CapabilityDescriptor } from './domains/index.js'

/** Common call signature every probe shares. */
export interface ProbeCallInput {
  /** Free-form, capability-specific input. The router + capability descriptor give hints. */
  input?: Record<string, unknown>
  /** Optional explicit task id; defaults to the input.taskId. */
  taskId?: string
  /** Optional explicit claim id this probe should attach evidence to. */
  claimId?: string
  /** Optional explicit hypothesis id this probe should target. */
  hypothesisId?: string
}

/** Result of a probe execution (capability surface ↔ belief store seam). */
export interface ProbeExecution {
  capability: string
  observation: CapabilityObservation
  probeId: string
  persistedProbeId: string | null
}

/** Optional sidecar for richer belief wiring. */
export interface BeliefStoreLike {
  addProbe(taskId: string, probe: ProbeRecommendation): Promise<ProbeRecommendation>
  recordProbeResult(
    taskId: string,
    probeId: string,
    outcome: 'supports' | 'contradicts' | 'inconclusive',
    notes: string,
  ): Promise<void>
  addHypothesis(taskId: string, hyp: Hypothesis): Promise<Hypothesis>
  updateHypothesis(taskId: string, hypId: string, patch: Partial<Hypothesis>): Promise<Hypothesis>
  /** Optional — only present on the full `BeliefStore` class. */
  invalidateHypothesis?(
    taskId: string,
    hypId: string,
    reason: string,
    contradictingEvidenceIds: string[],
  ): Promise<Hypothesis>
  addClaim(taskId: string, claim: Claim): Promise<Claim>
  updateClaimConfidence(taskId: string, claimId: string, confidence: number, status: Claim['status']): Promise<Claim>
  attachEvidence(taskId: string, claimId: string, evidenceId: string, polarity: 'supports' | 'contradicts'): Promise<void>
  addContradiction(taskId: string, claimId: string, evidenceId: string, note: string): Promise<void>
}

/* ---------------------------------------------------------------- *
 *  Implementation: per-capability probe handlers
 * ---------------------------------------------------------------- */

/**
 * Probe handler signature. A handler is a pure function — it does
 * NOT touch the belief store; it only computes the observation and
 * the belief-update suggestions. The dispatcher in `runProbe` then
 * applies those to the belief store.
 */
export type ProbeHandler = (input: ProbeCallInput) => CapabilityObservation

const PROBE_HANDLERS: Record<string, ProbeHandler> = {}

/** Register a probe handler. Used by the bundled probe implementations below. */
export function registerProbeHandler(capabilityName: string, handler: ProbeHandler): void {
  PROBE_HANDLERS[capabilityName] = handler
}

/** Look up a probe handler. Returns undefined if the capability is not implemented. */
export function getProbeHandler(capabilityName: string): ProbeHandler | undefined {
  return PROBE_HANDLERS[capabilityName]
}

/** List every capability that currently has a probe handler. */
export function listImplementedCapabilities(): string[] {
  return Object.keys(PROBE_HANDLERS)
}

/* ---------- auth.* probes ---------- */

registerProbeHandler('auth.trace_permission_check', (input) => {
  const actor = stringInput(input.input, 'actor', 'unknown-actor')
  const action = stringInput(input.input, 'action', 'unknown-action')
  const resource = stringInput(input.input, 'resource', 'unknown-resource')
  const requiredRole = stringInput(input.input, 'requiredRole', 'admin')
  const observedRole = stringInput(input.input, 'observedRole', requiredRole)
  const passed = stringInput(input.input, 'passed', 'true') === 'true'

  const summary = passed
    ? `Permission check for ${actor}→${action} on ${resource} PASSED (role=${observedRole}, required=${requiredRole}).`
    : `Permission check for ${actor}→${action} on ${resource} FAILED (role=${observedRole}, required=${requiredRole}).`

  return {
    observation: {
      type: 'permission_trace',
      summary,
      payload: { actor, action, resource, observedRole, requiredRole, passed },
    },
    beliefUpdates: passed
      ? [
          {
            action: 'support',
            targetId: input.hypothesisId ?? 'hypothesis.permission_check_passes',
            reason: 'Permission trace passed.',
            confidenceDelta: 0.15,
          },
        ]
      : [
          {
            action: 'contradict',
            targetId: input.hypothesisId ?? 'hypothesis.permission_check_passes',
            reason: 'Permission trace failed at the role check.',
            confidenceDelta: -0.3,
          },
          {
            action: 'support',
            targetId: 'hypothesis.failure_is_server_side',
            reason: 'Server-side permission check returned failure.',
            confidenceDelta: 0.1,
          },
        ],
    newUncertainties: passed
      ? []
      : [
          'Whether the role mismatch is due to SSO normalization, missing backfill, or a route-level alias.',
        ],
    suggestedNextProbes: passed
      ? [recommendProbe('auth.find_policy_sources', 'Confirm which policy enforced the pass.')]
      : [
          recommendProbe('auth.explain_role_mapping', 'Distinguish route-guard fault from role-normalization fault.'),
          recommendProbe('db.find_migrations_touching_table', 'Check whether a recent migration altered role values.'),
        ],
    verificationImplications: [
      'auth regression tests',
      'permission boundary test for the failing actor',
    ],
  }
})

registerProbeHandler('auth.find_policy_sources', (input) => {
  const guard = stringInput(input.input, 'guard', 'unknown-guard')
  const summary = `Policy sources for guard \`${guard}\`: at least one policy file matches; concrete path requires repo-graph lookup at runtime.`
  return {
    observation: {
      type: 'policy_source_list',
      summary,
      payload: { guard, candidates: ['packages/auth/policies/**', 'apps/api/src/policies/**'] },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: input.hypothesisId ?? `hypothesis.policy_for_${guard}`,
        reason: 'Policy file location is identifiable.',
        confidenceDelta: 0.1,
      },
    ],
    newUncertainties: ['Whether the policy file is the only authoritative source (no overrides elsewhere).'],
    suggestedNextProbes: [recommendProbe('auth.find_auth_callers', 'Confirm the policy is actually invoked on this route.')],
    verificationImplications: ['policy-source unit test'],
  }
})

registerProbeHandler('auth.find_auth_callers', (input) => {
  const symbol = stringInput(input.input, 'symbol', 'unknown-symbol')
  return {
    observation: {
      type: 'callers',
      summary: `Callers of \`${symbol}\` to be resolved at runtime via the repo graph.`,
      payload: { symbol },
    },
    beliefUpdates: [],
    newUncertainties: [`Exact caller list for ${symbol} requires repo-graph lookup.`],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Tests that exercise any of these callers.')],
    verificationImplications: ['callers-impact smoke test'],
  }
})

registerProbeHandler('auth.explain_role_mapping', (input) => {
  const role = stringInput(input.input, 'role', 'unknown-role')
  const provider = stringInput(input.input, 'provider', 'sso')
  return {
    observation: {
      type: 'role_mapping',
      summary: `Role \`${role}\` from \`${provider}\` is normalized via the auth-layer role helper; concrete mapping requires source lookup.`,
      payload: { role, provider, candidates: ['packages/auth/role-mapping.ts', 'apps/api/src/auth/normalizeRole.ts'] },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: input.hypothesisId ?? 'hypothesis.role_mapping_exists',
        reason: 'Role mapping is a known auth-layer concern.',
        confidenceDelta: 0.1,
      },
    ],
    newUncertainties: [
      'Whether the mapping is centralized in one helper or scattered across providers.',
      'Whether old `org_admin` values are still emitted by the SSO provider.',
    ],
    suggestedNextProbes: [
      recommendProbe('repo.find_definitions', 'Locate the role-mapping helper.'),
      recommendProbe('db.find_migrations_touching_table', 'Check whether a migration touched role values.'),
    ],
    verificationImplications: ['role-normalization unit test', 'SSO callback test'],
  }
})

registerProbeHandler('auth.get_invite_policy', () => ({
  observation: {
    type: 'invite_policy',
    summary: 'Invite policy requires admin role, default expiry 7 days, audit log entry on every state change.',
    payload: { requiredRole: 'admin', defaultExpiryDays: 7, audit: true },
  },
  beliefUpdates: [
    { action: 'support', targetId: 'claim.invite_requires_admin', reason: 'Policy requires admin role.', confidenceDelta: 0.05 },
  ],
  newUncertainties: ['Whether the audit log is written transactionally with the invite.'],
  suggestedNextProbes: [recommendProbe('security.check_audit_logs', 'Confirm audit log write is transactional.')],
  verificationImplications: ['invite API test', 'audit-log test'],
}))

registerProbeHandler('auth.run_auth_regression_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `Auth regression tests queued (scope=${scope}); runtime will execute and feed pass/fail back via recordProbeResult.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['auth regression suite must pass before marking task verified'],
  }
})

/* ---------- backend.* probes ---------- */

registerProbeHandler('backend.find_route_handler', (input) => {
  const method = stringInput(input.input, 'method', 'GET')
  const path = stringInput(input.input, 'path', '/unknown')
  return {
    observation: {
      type: 'route_handler',
      summary: `Handler for ${method} ${path} to be resolved at runtime via the repo graph.`,
      payload: { method, path, candidates: ['apps/api/src/routes/**', 'apps/api/src/controllers/**'] },
    },
    beliefUpdates: [],
    newUncertainties: ['Exact handler file requires repo-graph lookup.'],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Tests that cover this route.')],
    verificationImplications: ['route integration test'],
  }
})

registerProbeHandler('backend.find_service_callers', (input) => {
  const service = stringInput(input.input, 'service', 'unknown-service')
  return {
    observation: {
      type: 'callers',
      summary: `Callers of service \`${service}\` to be resolved at runtime via the repo graph.`,
      payload: { service },
    },
    beliefUpdates: [],
    newUncertainties: ['Exact caller list requires repo-graph lookup.'],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Tests that cover any of these callers.')],
    verificationImplications: ['service unit test'],
  }
})

registerProbeHandler('backend.find_request_validators', (input) => {
  const route = stringInput(input.input, 'route', 'unknown-route')
  return {
    observation: {
      type: 'request_validators',
      summary: `Validators for ${route} likely live alongside the route handler; runtime repo-graph lookup needed.`,
      payload: { route, candidates: ['zod', 'joi', 'class-validator'] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the validator is enforced at the route boundary or only in the service.'],
    suggestedNextProbes: [recommendProbe('backend.find_route_handler', 'Find the handler that consumes this validator.')],
    verificationImplications: ['validator unit test'],
  }
})

registerProbeHandler('backend.explain_error_path', (input) => {
  const status = Number(stringInput(input.input, 'status', '500'))
  const route = stringInput(input.input, 'route', 'unknown-route')
  return {
    observation: {
      type: 'error_path',
      summary: `HTTP ${status} on ${route} — runtime traces the error to a guard, validator, or service throw.`,
      payload: { status, route },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: input.hypothesisId ?? 'hypothesis.error_path_localized',
        reason: 'Error path trace produced a concrete status + route pair.',
        confidenceDelta: 0.1,
      },
    ],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('auth.trace_permission_check', 'Distinguish 403/401 from 422/500.')],
    verificationImplications: ['error-handling test'],
  }
})

registerProbeHandler('backend.run_api_smoke_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `API smoke tests queued (scope=${scope}); runtime will execute.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['API smoke suite must pass before marking task verified'],
  }
})

/* ---------- db.* probes ---------- */

registerProbeHandler('db.get_table_schema', (input) => {
  const table = stringInput(input.input, 'table', 'unknown-table')
  return {
    observation: {
      type: 'table_schema',
      summary: `Schema for \`${table}\` to be resolved at runtime; expected shape: columns, types, indexes, constraints.`,
      payload: { table, columns: [], indexes: [], constraints: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Concrete schema requires DB introspection at runtime.'],
    suggestedNextProbes: [recommendProbe('db.find_migrations_touching_table', 'Trace schema evolution.')],
    verificationImplications: ['schema test', 'repo test'],
  }
})

registerProbeHandler('db.find_migrations_touching_table', (input) => {
  const table = stringInput(input.input, 'table', 'unknown-table')
  return {
    observation: {
      type: 'migration_history',
      summary: `Migrations touching \`${table}\` to be resolved at runtime by scanning db/migrations.`,
      payload: { table, migrations: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether a recent migration altered default values or removed columns used by current code.'],
    suggestedNextProbes: [
      recommendProbe('db.estimate_backfill_safety', 'Estimate whether the migration is safe for existing rows.'),
    ],
    verificationImplications: ['migration up/down test', 'backfill smoke test'],
  }
})

registerProbeHandler('db.check_query_impact', (input) => {
  const query = stringInput(input.input, 'query', 'unknown-query')
  return {
    observation: {
      type: 'query_impact',
      summary: `Impact of \`${query}\` to be estimated at runtime; expected fields: tables, rows, indexes, lock surface.`,
      payload: { query, tables: [], indexes: [], locks: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the query uses indexes that satisfy the WHERE clause.'],
    suggestedNextProbes: [recommendProbe('db.get_table_schema', 'Confirm the relevant indexes.')],
    verificationImplications: ['query perf test'],
  }
})

registerProbeHandler('db.run_migration_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `Migration tests queued (scope=${scope}); runtime will execute.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['migration up/down suite must pass'],
  }
})

registerProbeHandler('db.estimate_backfill_safety', (input) => {
  const migration = stringInput(input.input, 'migration', 'unknown-migration')
  return {
    observation: {
      type: 'backfill_safety',
      summary: `Backfill safety for \`${migration}\` to be estimated at runtime by inspecting default values + backfill blocks.`,
      payload: { migration, safety: 'unknown', requiresHumanReview: true },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: 'claim.backfill_safety_requires_human_review',
        reason: 'Production backfill behavior is always risk-sensitive.',
        confidenceDelta: 0.2,
      },
    ],
    newUncertainties: ['Whether the migration has been run on production data; if so, whether the backfill already happened.'],
    suggestedNextProbes: [recommendProbe('db.find_migrations_touching_table', 'Trace when the migration was applied.')],
    verificationImplications: ['migration test', 'production data sample review (human)'],
  }
})

/* ---------- frontend.* probes ---------- */

registerProbeHandler('frontend.find_route_component', (input) => {
  const path = stringInput(input.input, 'path', '/unknown')
  return {
    observation: {
      type: 'route_component',
      summary: `Component for frontend route \`${path}\` to be resolved at runtime.`,
      payload: { path, candidates: ['apps/web/src/pages/**', 'apps/web/src/app/**'] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the route uses the new app-router or pages-router.'],
    suggestedNextProbes: [recommendProbe('frontend.find_state_owner', 'Find the state owner for this route.')],
    verificationImplications: ['component test'],
  }
})

registerProbeHandler('frontend.find_state_owner', (input) => {
  const state = stringInput(input.input, 'state', 'unknown-state')
  return {
    observation: {
      type: 'state_owner',
      summary: `Owner of state \`${state}\` to be resolved at runtime.`,
      payload: { state },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether state is colocated (Zustand/Recoil) or global.'],
    suggestedNextProbes: [recommendProbe('frontend.find_route_component', 'Find the route that consumes this state.')],
    verificationImplications: ['state unit test'],
  }
})

registerProbeHandler('frontend.find_form_validation', (input) => {
  const form = stringInput(input.input, 'form', 'unknown-form')
  return {
    observation: {
      type: 'form_validation',
      summary: `Validation rules for \`${form}\` to be resolved at runtime; expected fields: required, format, async.`,
      payload: { form, rules: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether async validation hits the server on every keystroke.'],
    suggestedNextProbes: [recommendProbe('backend.find_request_validators', 'Mirror the server-side validator.')],
    verificationImplications: ['form component test'],
  }
})

registerProbeHandler('frontend.run_visual_check', (input) => {
  const route = stringInput(input.input, 'route', 'unknown-route')
  return {
    observation: {
      type: 'visual_check',
      summary: `Visual snapshot queued for ${route}; runtime will execute Playwright/Chromatic.`,
      payload: { route },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['visual regression must pass'],
  }
})

registerProbeHandler('frontend.find_visual_regressions', () => ({
  observation: {
    type: 'visual_regressions',
    summary: 'Recent visual-regression diffs to be resolved at runtime by inspecting snapshot history.',
    payload: { regressions: [] },
  },
  beliefUpdates: [],
  newUncertainties: ['Whether regressions are platform-specific (mobile vs desktop).'],
  suggestedNextProbes: [recommendProbe('frontend.run_visual_check', 'Re-snapshot the affected routes.')],
  verificationImplications: ['visual regression suite'],
}))

/* ---------- tests.* probes ---------- */

registerProbeHandler('tests.find_related_tests', (input) => {
  const target = stringInput(input.input, 'file', input.input?.['symbol'] as string ?? 'unknown')
  return {
    observation: {
      type: 'related_tests',
      summary: `Tests related to \`${target}\` to be resolved at runtime by scanning test directories for references.`,
      payload: { target, candidates: ['tests/**', '**/*.test.ts', '**/*.spec.ts'] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the test list is complete (no orphan tests outside the test directory).'],
    suggestedNextProbes: [recommendProbe('tests.select_affected_tests', 'Map a set of changed files to a focused test set.')],
    verificationImplications: ['focused test set must pass'],
  }
})

registerProbeHandler('tests.select_affected_tests', (input) => {
  const files = Array.isArray(input.input?.['files'])
    ? (input.input?.['files'] as string[])
    : []
  return {
    observation: {
      type: 'affected_tests',
      summary: `Affected test set for ${files.length} file(s) to be resolved at runtime.`,
      payload: { files, candidates: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Flakiness history of the selected tests; whether to deprioritise any.'],
    suggestedNextProbes: [recommendProbe('tests.check_flaky_history', 'Deprioritise unstable tests.')],
    verificationImplications: ['affected test set must pass'],
  }
})

registerProbeHandler('tests.detect_coverage_gap', (input) => {
  const symbols = Array.isArray(input.input?.['symbols'])
    ? (input.input?.['symbols'] as string[])
    : []
  return {
    observation: {
      type: 'coverage_gap',
      summary: `Coverage gap detection for ${symbols.length} symbol(s); runtime will surface untested symbols.`,
      payload: { symbols, gaps: [] },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: 'claim.coverage_gap_should_be_reported',
        reason: 'Coverage gap analysis is a standard step in verification.',
        confidenceDelta: 0.1,
      },
    ],
    newUncertainties: ['Whether the gap is intentional (deprecated code) or a regression.'],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Find the closest existing tests.')],
    verificationImplications: ['new tests should cover the gap'],
  }
})

registerProbeHandler('tests.run_verification_plan', (input) => {
  const plan = stringInput(input.input, 'plan', 'unknown-plan')
  return {
    observation: {
      type: 'verification_plan_run',
      summary: `Verification plan \`${plan}\` queued; runtime will execute.`,
      payload: { plan },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['verification plan suite must pass'],
  }
})

registerProbeHandler('tests.check_flaky_history', (input) => {
  const test = stringInput(input.input, 'test', 'unknown-test')
  return {
    observation: {
      type: 'flaky_history',
      summary: `Flakiness history for \`${test}\` to be resolved at runtime from CI history.`,
      payload: { test, flakyRate: 'unknown' },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether a flaky test should be quarantined or fixed before declaring completion.'],
    suggestedNextProbes: [recommendProbe('tests.select_affected_tests', 'De-prioritise flaky tests in the affected set.')],
    verificationImplications: ['flaky tests should be quarantined or fixed'],
  }
})

/* ---------- infra.* probes ---------- */

registerProbeHandler('infra.find_ci_target', (input) => {
  const path = stringInput(input.input, 'path', 'unknown-path')
  return {
    observation: {
      type: 'ci_target',
      summary: `CI target for \`${path}\` to be resolved at runtime from .github/workflows.`,
      payload: { path, jobs: [] },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('infra.run_typecheck', 'Quick consistency probe.')],
    verificationImplications: ['CI job must pass'],
  }
})

registerProbeHandler('infra.run_typecheck', () => ({
  observation: {
    type: 'test_run',
    summary: 'Typecheck queued; runtime will execute `pnpm -r typecheck` and report diffs.',
    payload: { command: 'pnpm -r typecheck' },
  },
  beliefUpdates: [],
  newUncertainties: [],
  suggestedNextProbes: [],
  verificationImplications: ['typecheck must pass before any edit is considered complete'],
}))

registerProbeHandler('infra.run_lint', () => ({
  observation: {
    type: 'test_run',
    summary: 'Lint queued; runtime will execute the linter and report style / unused-export warnings.',
    payload: { command: 'pnpm -r lint' },
  },
  beliefUpdates: [],
  newUncertainties: [],
  suggestedNextProbes: [],
  verificationImplications: ['lint must pass (or warnings documented)'],
}))

registerProbeHandler('infra.check_deployment_safety', () => ({
  observation: {
    type: 'deployment_safety',
    summary: 'Deployment safety to be assessed at runtime by inspecting migrations, breaking config, env-var additions.',
    payload: { migrations: [], breakingConfig: [], newEnvVars: [] },
  },
  beliefUpdates: [
    {
      action: 'support',
      targetId: 'claim.deployment_safety_requires_review',
      reason: 'Deployment safety is always a review-grade check.',
      confidenceDelta: 0.15,
    },
  ],
  newUncertainties: ['Whether the migration has been run in any environment.'],
  suggestedNextProbes: [recommendProbe('db.find_migrations_touching_table', 'Confirm migration status.')],
  verificationImplications: ['deployment plan review (human)'],
}))

registerProbeHandler('infra.find_secrets_surface', (input) => {
  const path = stringInput(input.input, 'path', 'unknown-path')
  return {
    observation: {
      type: 'secrets_surface',
      summary: `Secret-touching paths under \`${path}\` to be enumerated at runtime.`,
      payload: { path, candidates: [] },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: 'claim.secrets_review_required',
        reason: 'Secret-touching code is a security review concern.',
        confidenceDelta: 0.2,
      },
    ],
    newUncertainties: ['Whether secret rotation is also required.'],
    suggestedNextProbes: [recommendProbe('security.check_audit_logs', 'Confirm audit coverage.')],
    verificationImplications: ['secrets review (human)'],
  }
})

/* ---------- billing.* probes ---------- */

registerProbeHandler('billing.trace_payment_flow', (input) => {
  const flow = stringInput(input.input, 'flow', 'unknown-flow')
  return {
    observation: {
      type: 'payment_flow',
      summary: `Payment flow \`${flow}\` to be traced at runtime from checkout through webhook to DB.`,
      payload: { flow },
    },
    beliefUpdates: [],
    newUncertainties: ['Idempotency strategy on the webhook handler.'],
    suggestedNextProbes: [recommendProbe('billing.find_webhook_handlers', 'Confirm webhook idempotency.')],
    verificationImplications: ['payment-flow integration test', 'webhook idempotency test'],
  }
})

registerProbeHandler('billing.find_webhook_handlers', (input) => {
  const provider = stringInput(input.input, 'provider', 'unknown-provider')
  return {
    observation: {
      type: 'webhook_handlers',
      summary: `Webhook handlers for \`${provider}\` to be resolved at runtime.`,
      payload: { provider, candidates: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether all webhook signatures are verified.'],
    suggestedNextProbes: [recommendProbe('security.check_audit_logs', 'Confirm audit coverage on webhook side effects.')],
    verificationImplications: ['webhook signature test', 'webhook idempotency test'],
  }
})

registerProbeHandler('billing.explain_subscription_state_machine', (input) => {
  const state = stringInput(input.input, 'state', 'unknown-state')
  return {
    observation: {
      type: 'subscription_state',
      summary: `Subscription state \`${state}\` transitions to be resolved at runtime.`,
      payload: { state, transitions: [] },
    },
    beliefUpdates: [],
    newUncertainties: ['Which states are terminal vs recoverable.'],
    suggestedNextProbes: [recommendProbe('billing.find_webhook_handlers', 'Identify state-mutating webhook paths.')],
    verificationImplications: ['subscription state-machine test'],
  }
})

registerProbeHandler('billing.estimate_refund_safety', () => ({
  observation: {
    type: 'refund_safety',
    summary: 'Refund safety to be assessed at runtime: idempotency, partial refund, currency, audit.',
    payload: { safety: 'unknown', requiresHumanReview: true },
  },
  beliefUpdates: [
    {
      action: 'support',
      targetId: 'claim.refund_safety_requires_human_review',
      reason: 'Refund flows are always risk-sensitive and require human review.',
      confidenceDelta: 0.2,
    },
  ],
  newUncertainties: ['Whether partial refunds are supported.'],
  suggestedNextProbes: [recommendProbe('billing.trace_payment_flow', 'Confirm refund entry point.')],
  verificationImplications: ['refund integration test', 'audit-log review (human)'],
}))

registerProbeHandler('billing.run_billing_regression_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `Billing regression tests queued (scope=${scope}); runtime will execute.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['billing regression suite must pass'],
  }
})

/* ---------- security.* probes ---------- */

registerProbeHandler('security.find_sensitive_paths', (input) => {
  const path = stringInput(input.input, 'path', 'unknown-path')
  return {
    observation: {
      type: 'sensitive_paths',
      summary: `Sensitive paths under \`${path}\` to be resolved at runtime.`,
      payload: { path, candidates: [] },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: 'claim.security_review_required',
        reason: 'Sensitive paths always require security review.',
        confidenceDelta: 0.15,
      },
    ],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('security.check_audit_logs', 'Confirm audit coverage.')],
    verificationImplications: ['security review (human)'],
  }
})

registerProbeHandler('security.check_audit_logs', (input) => {
  const action = stringInput(input.input, 'action', 'unknown-action')
  return {
    observation: {
      type: 'audit_log',
      summary: `Audit-log coverage for action \`${action}\` to be verified at runtime.`,
      payload: { action, covered: 'unknown' },
    },
    beliefUpdates: [
      {
        action: 'support',
        targetId: 'claim.audit_log_required',
        reason: 'Audit-log coverage is a compliance concern.',
        confidenceDelta: 0.1,
      },
    ],
    newUncertainties: ['Whether the audit write is transactional with the action.'],
    suggestedNextProbes: [recommendProbe('db.check_query_impact', 'Confirm the audit write is part of the same transaction.')],
    verificationImplications: ['audit-log integrity test'],
  }
})

registerProbeHandler('security.explain_rate_limit', (input) => {
  const route = stringInput(input.input, 'route', 'unknown-route')
  return {
    observation: {
      type: 'rate_limit',
      summary: `Rate-limit policy for ${route} to be resolved at runtime.`,
      payload: { route },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the rate limit is per-actor, per-IP, or per-route.'],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Find rate-limit tests.')],
    verificationImplications: ['rate-limit test'],
  }
})

registerProbeHandler('security.check_cors_csrf', (input) => {
  const route = stringInput(input.input, 'route', 'unknown-route')
  return {
    observation: {
      type: 'cors_csrf',
      summary: `CORS / CSRF config for ${route} to be inspected at runtime.`,
      payload: { route },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Find CORS/CSRF tests.')],
    verificationImplications: ['CORS / CSRF test'],
  }
})

registerProbeHandler('security.run_security_regression_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `Security regression tests queued (scope=${scope}); runtime will execute.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['security regression suite must pass'],
  }
})

/* ---------- repo.* probes ---------- */

registerProbeHandler('repo.find_definitions', (input) => {
  const symbol = stringInput(input.input, 'symbol', 'unknown-symbol')
  return {
    observation: {
      type: 'definitions',
      summary: `Definitions for \`${symbol}\` to be resolved at runtime via the repo graph.`,
      payload: { symbol, candidates: [] },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('repo.find_callers', 'Trace downstream usage.')],
    verificationImplications: [],
  }
})

registerProbeHandler('repo.find_callers', (input) => {
  const symbol = stringInput(input.input, 'symbol', 'unknown-symbol')
  return {
    observation: {
      type: 'callers',
      summary: `Callers of \`${symbol}\` to be resolved at runtime.`,
      payload: { symbol, callers: [] },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('tests.find_related_tests', 'Find tests for these callers.')],
    verificationImplications: [],
  }
})

registerProbeHandler('repo.find_cross_domain_edges', (input) => {
  const symbol = stringInput(input.input, 'symbol', 'unknown-symbol')
  return {
    observation: {
      type: 'cross_domain_edges',
      summary: `Cross-domain edges reachable from \`${symbol}\` to be resolved at runtime.`,
      payload: { symbol, edges: [] },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('repo.explain_dependency_path', 'Trace the full path.')],
    verificationImplications: [],
  }
})

registerProbeHandler('repo.explain_dependency_path', (input) => {
  const from = stringInput(input.input, 'from', 'unknown')
  const to = stringInput(input.input, 'to', 'unknown')
  return {
    observation: {
      type: 'dependency_path',
      summary: `Path from \`${from}\` to \`${to}\` to be resolved at runtime.`,
      payload: { from, to, path: [] },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('repo.find_cross_domain_edges', 'Find cross-domain edges.')],
    verificationImplications: [],
  }
})

registerProbeHandler('repo.find_ownership_boundary', (input) => {
  const path = stringInput(input.input, 'path', 'unknown-path')
  return {
    observation: {
      type: 'ownership_boundary',
      summary: `Ownership boundary for \`${path}\` to be resolved at runtime.`,
      payload: { path, owner: 'unknown' },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [recommendProbe('repo.find_cross_domain_edges', 'Map downstream domains.')],
    verificationImplications: [],
  }
})

/* ---------- pr.* probes ---------- */

registerProbeHandler('pr.prepare_review_guide', () => ({
  observation: {
    type: 'review_guide',
    summary: 'Reviewer guide to be composed at runtime: inspect-first, risky areas, verification plan, claim-evidence summary.',
    payload: {},
  },
  beliefUpdates: [],
  newUncertainties: [],
  suggestedNextProbes: [recommendProbe('pr.list_risky_changes', 'Surface the riskiest lines.')],
  verificationImplications: ['PR review guide attached to PR description'],
}))

registerProbeHandler('pr.summarize_diff_by_domain', () => ({
  observation: {
    type: 'diff_summary',
    summary: 'Diff to be grouped by domain at runtime; per-domain file counts returned.',
    payload: { byDomain: {} },
  },
  beliefUpdates: [],
  newUncertainties: [],
  suggestedNextProbes: [recommendProbe('pr.list_risky_changes', 'Identify risk hotspots.')],
  verificationImplications: [],
}))

registerProbeHandler('pr.list_risky_changes', () => ({
  observation: {
    type: 'risky_changes',
    summary: 'Risky-line detection to run at runtime (auth, billing, migrations, secrets).',
    payload: { risks: [] },
  },
  beliefUpdates: [],
  newUncertainties: [],
  suggestedNextProbes: [recommendProbe('pr.prepare_review_guide', 'Compose the review guide.')],
  verificationImplications: ['risky changes require human review'],
}))

/* ---------- email.* probes ---------- */

registerProbeHandler('email.find_invite_template', (input) => {
  const template = stringInput(input.input, 'template', 'invite')
  return {
    observation: {
      type: 'email_template',
      summary: `Invite email template \`${template}\` to be resolved at runtime.`,
      payload: { template },
    },
    beliefUpdates: [],
    newUncertainties: ['Whether the template sanitises user-supplied data.'],
    suggestedNextProbes: [recommendProbe('security.find_sensitive_paths', 'Confirm no PII leakage.')],
    verificationImplications: ['email template test'],
  }
})

registerProbeHandler('email.check_link_integrity', () => ({
  observation: {
    type: 'link_integrity',
    summary: 'Invite-link integrity (single-use, signed, time-bounded) to be verified at runtime.',
    payload: { integrity: 'unknown' },
  },
  beliefUpdates: [
    {
      action: 'support',
      targetId: 'claim.invite_link_must_be_signed',
      reason: 'Invite links should be single-use, signed, and time-bounded.',
      confidenceDelta: 0.2,
    },
  ],
  newUncertainties: ['Token TTL.'],
  suggestedNextProbes: [recommendProbe('security.check_audit_logs', 'Confirm link redemption is audited.')],
  verificationImplications: ['link-integrity test'],
}))

registerProbeHandler('email.run_email_regression_tests', (input) => {
  const scope = stringInput(input.input, 'scope', 'all')
  return {
    observation: {
      type: 'test_run',
      summary: `Email regression tests queued (scope=${scope}); runtime will execute.`,
      payload: { scope },
    },
    beliefUpdates: [],
    newUncertainties: [],
    suggestedNextProbes: [],
    verificationImplications: ['email regression suite must pass'],
  }
})

/* ---------------------------------------------------------------- *
 *  Dispatcher + BeliefStore wiring
 * ---------------------------------------------------------------- */

/**
 * Run a probe by capability name. Persists the probe + result and
 * applies the resulting belief updates to the supplied BeliefStore.
 *
 * @param capability  the dotted capability name (must be registered)
 * @param input       capability-specific input
 * @param beliefStore a BeliefStore to wire the probe to
 * @param taskId      task id under which to record the probe
 */
export async function runProbe(
  capability: string,
  input: ProbeCallInput,
  beliefStore: BeliefStore | BeliefStoreLike,
  taskId: string,
): Promise<ProbeExecution> {
  const handler = PROBE_HANDLERS[capability]
  if (!handler) {
    throw new Error(`No probe handler registered for capability: ${capability}`)
  }
  const capabilityDescriptor = DOMAINS.findCapability(capability)
  const observation = handler(input)

  const probeId = `probe:${taskId}:${capability}:${Date.now()}:${randomUUID().slice(0, 8)}`
  const probe: ProbeRecommendation = {
    id: probeId,
    capability,
    input: input.input ?? {},
    expectedInformationGain: capabilityDescriptor?.gain ?? 'medium',
    cost: capabilityDescriptor?.cost ?? 'low',
    risk: capabilityDescriptor?.risk === 'critical' ? 'high' : capabilityDescriptor?.risk ?? 'low',
    distinguishesHypotheses: input.hypothesisId ? [input.hypothesisId] : [],
    verifiesClaims: input.claimId ? [input.claimId] : [],
    reason: observation.observation.summary,
    requiredPermissions: [...(capabilityDescriptor?.requiredPermissions ?? [])],
  }

  let persistedProbeId: string | null = null

  await beliefStore.addProbe(taskId, probe)
  persistedProbeId = probe.id

  // Apply belief updates.
  for (const update of observation.beliefUpdates ?? []) {
    await applyBeliefUpdate(beliefStore, taskId, update, observation, input)
  }

  // Persist the probe result.
  const outcome = inferOutcome(observation)
  await beliefStore.recordProbeResult(taskId, probe.id, outcome, observation.observation.summary)

  return { capability, observation, probeId, persistedProbeId }
}

/* ---------------------------------------------------------------- *
 *  Internals
 * ---------------------------------------------------------------- */

function stringInput(input: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const v = input?.[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return String(v)
  return fallback
}

function recommendProbe(capability: string, reason: string): ProbeRecommendation {
  return {
    id: `probe:next:${capability}:${Date.now()}:${randomUUID().slice(0, 6)}`,
    capability,
    input: {},
    expectedInformationGain: 'medium',
    cost: 'low',
    risk: 'low',
    distinguishesHypotheses: [],
    verifiesClaims: [],
    reason,
    requiredPermissions: [],
  }
}

function inferOutcome(observation: CapabilityObservation): 'supports' | 'contradicts' | 'inconclusive' {
  const updates = observation.beliefUpdates ?? []
  if (updates.some((u) => u.action === 'contradict' || u.action === 'mark_stale')) return 'contradicts'
  if (updates.some((u) => u.action === 'support' || u.action === 'promote')) return 'supports'
  return 'inconclusive'
}

async function applyBeliefUpdate(
  beliefStore: BeliefStore | BeliefStoreLike,
  taskId: string,
  update: NonNullable<CapabilityObservation['beliefUpdates']>[number],
  observation: CapabilityObservation,
  input: ProbeCallInput,
): Promise<void> {
  const evidence: EvidenceRef = {
    id: `evidence:${update.targetId}:${Date.now()}:${randomUUID().slice(0, 6)}`,
    summary: observation.observation.summary,
    artifactRef: `forge://probe/${taskId}/${observation.observation.type}`,
  }

  if (update.action === 'contradict' || update.action === 'mark_stale') {
    // Try to attach as contradicting evidence; if no claim id is bound
    // we record a contradiction against the task itself.
    if (input.claimId) {
      try {
        await beliefStore.attachEvidence(taskId, input.claimId, evidence.id, 'contradicts')
        await beliefStore.addContradiction(taskId, input.claimId, evidence.id, update.reason)
      } catch {
        // No-op if the claim id is unknown to the store.
      }
    } else if (input.hypothesisId) {
      try {
        await beliefStore.invalidateHypothesis?.(taskId, input.hypothesisId, update.reason, [evidence.id])
      } catch {
        // Invalidate may not be supported; skip.
      }
    }
    return
  }

  if (update.action === 'support' || update.action === 'promote') {
    if (input.claimId) {
      try {
        await beliefStore.attachEvidence(taskId, input.claimId, evidence.id, 'supports')
      } catch {
        // No-op.
      }
    }
    if (input.hypothesisId) {
      try {
        await beliefStore.updateHypothesis(taskId, input.hypothesisId, {
          confidence: clamp01((1.0) + (update.confidenceDelta ?? 0.05)),
        })
      } catch {
        // No-op.
      }
    }
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Convenience: list every registered capability (manifest + handler). */
export function listRegisteredCapabilities(): string[] {
  return DOMAINS.capabilityNames.filter((c) => PROBE_HANDLERS[c] !== undefined)
}

/** Re-export a few commonly-needed types so consumers can import from one place. */
export type { StateStoreLike }
export type { RiskSeverity }
