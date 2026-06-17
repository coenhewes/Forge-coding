/**
 * Baseline comparison task set for the Forge harness.
 *
 * Each task is a structured engineering scenario that the eval harness can
 * run against both arms (Forge full harness vs flat baseline). Tasks are
 * organized by the eval task classes called out in AGENTS.md §33 (Baseline
 * Comparison Harness) and feature_requests/featurerequest1.md §Evaluation
 * Design / featurerequest3.md §Evaluation Plan:
 *
 *   - multi-file feature implementation
 *   - auth / permissions bug
 *   - database migration plus API change
 *   - frontend plus backend feature
 *   - review comment resolution
 *   - CI failure repair
 *   - test failure repair
 *   - resume after interruption
 *   - production bug investigation
 *   - cross-domain regression / monorepo framework upgrade
 *
 * A task definition is intentionally richer than the AGENTS.md demo task
 * because the comparison harness needs to:
 *
 *   1. seed the fixture with the broken state (so both arms start equal),
 *   2. describe what "verified completion" looks like (acceptance contract),
 *   3. declare which metric categories should dominate the scoring for this
 *      task class (e.g. a CI failure task weighs recovery_rate higher).
 *
 * Tasks are pure data; execution lives in `./baseline.ts`.
 */

export type EvalTaskClass =
  | 'auth_permission_bug'
  | 'ci_failure_repair'
  | 'test_failure_repair'
  | 'migration_plus_api'
  | 'frontend_plus_backend'
  | 'review_comment_resolution'
  | 'monorepo_framework_upgrade'
  | 'production_bug_investigation'

/**
 * A single verification check the eval can perform on the post-run repo.
 * These are intentionally coarse (filesystem + exit code based) so they
 * can run without a live LLM and so the same checks apply to both arms.
 */
export interface EvalAcceptanceCheck {
  /** Stable id, used in the report. */
  id: string
  /** Human-readable description shown in the summary table. */
  description: string
  /** Files that must exist for this check to be meaningful. */
  expectedFiles?: string[]
  /** Path patterns the agent should have modified. */
  expectedTouchedPatterns?: string[]
  /** Command to run; non-zero exit code = failure. */
  command?: string
  /** Working dir for `command`; defaults to the worktree root. */
  cwd?: 'worktree'
  /** True if the worktree is expected to contain a matching diff (git). */
  expectGitChanges?: boolean
  /** Tags used to bucket this check (e.g. "test", "permission", "migration"). */
  tags?: string[]
}

/**
 * What we seed the fixture with to create a deterministic starting state.
 * - `applyPatch` is an inline unified diff (or "create" + content) to apply
 *   to the fixture before the agent runs.
 * - `brokenFile` lets us overwrite an existing file with broken content.
 */
export interface EvalSeed {
  /** Inline diff hunks in `--- a/path +++ b/path @@ ... @@` form. */
  applyPatch?: string
  /** Overwrite an existing file with broken content before the run. */
  brokenFile?: { path: string; content: string }
  /** Create a new file before the run (used for failing CI fixtures). */
  createFile?: { path: string; content: string }
  /** Optional reviewer comment dropped into a virtual `.forge/reviews/<task>.md`. */
  reviewerComment?: string
}

export interface EvalMetricWeights {
  /** How much weight this task class gives to verified completion (0..1). */
  verified_completion_rate?: number
  /** Cost per completed task. */
  cost_per_completed_task?: number
  /** Wall-clock runtime per completed task. */
  runtime_per_completed_task?: number
  /** Penalty for files edited that fall outside `expectedTouchedPatterns`. */
  irrelevant_files_edited?: number
  /** Penalty for repeated identical (hypothesis, action) attempts. */
  repeated_failed_attempts?: number
  /** Penalty for explicitly asking the human for clarification. */
  human_interventions?: number
  /** Bonus / penalty for resume success (relevant to resume tasks). */
  resume_success_rate?: number
}

export interface EvalTask {
  /** Stable id, used in CLI (`--task <id>`) and JSON reports. */
  id: string
  /** Task class used for grouping reports. */
  cls: EvalTaskClass
  /** Short label shown in summary tables. */
  title: string
  /** Multi-line task description fed verbatim to the agent. */
  prompt: string
  /**
   * Optional fixture path override. When omitted the harness uses
   * `--repo` from the CLI (or the default sample-saas fixture).
   */
  fixture?: string
  /** Seed changes applied to the fixture before each arm runs. */
  seed?: EvalSeed
  /** Acceptance checks used to compute verified_completion_rate. */
  acceptance: EvalAcceptanceCheck[]
  /** Per-class metric weights; defaults are sensible averages. */
  weights?: EvalMetricWeights
  /** Optional advisory risk level — purely for reporting. */
  risk?: 'low' | 'medium' | 'high' | 'critical'
}

/**
 * Default weights applied when a task does not specify its own.
 * These reflect AGENTS.md §33 — equal weighting on completion, cost,
 * runtime, irrelevant files, repeated failures, and interventions.
 */
export const DEFAULT_METRIC_WEIGHTS: Required<EvalMetricWeights> = {
  verified_completion_rate: 0.30,
  cost_per_completed_task: 0.15,
  runtime_per_completed_task: 0.10,
  irrelevant_files_edited: 0.10,
  repeated_failed_attempts: 0.15,
  human_interventions: 0.10,
  resume_success_rate: 0.10,
}

export const EVAL_TASKS: EvalTask[] = [
  // ─────────────────────────────────────────────────────────────────────
  // 1. auth_permission_bug — the AGENTS.md headline demo, formalized.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'auth-org-admin-invite',
    cls: 'auth_permission_bug',
    title: 'Restore org-admin invite after SSO migration',
    risk: 'high',
    prompt:
      'After the recent SSO migration, org admins cannot invite new users to their organization. ' +
      'Diagnose the auth layer (src/auth/**), fix the broken invite path so an admin (whether ' +
      'original owner or SSO-provisioned admin) can invite users again, and add regression ' +
      'tests covering: (a) admin invite succeeds, (b) non-admin invite is forbidden, ' +
      '(c) SSO-provisioned admin invite succeeds. Use the existing permission helpers and ' +
      'the role-mapping layer — do not special-case the invite route. Verify your work by ' +
      'running the test suite before finishing.',
    acceptance: [
      {
        id: 'auth-invite-test-passes',
        description: 'Invite permission test passes',
        command: 'pnpm test -- --run --reporter=basic auth tests/auth tests/permissions',
        tags: ['test', 'permission'],
      },
      {
        id: 'auth-permission-helper-untouched',
        description: 'Auth permission helper signature preserved',
        expectGitChanges: false,
        tags: ['contract'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      verified_completion_rate: 0.4,
      irrelevant_files_edited: 0.15,
      repeated_failed_attempts: 0.15,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 2. ci_failure_repair — given a failing CI log, repair it.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'ci-failure-build-repair',
    cls: 'ci_failure_repair',
    title: 'Repair a broken CI build (typecheck + lint)',
    risk: 'medium',
    prompt:
      'The main CI workflow is failing. Read `.forge/ci/failing-log.txt`, diagnose the root ' +
      'cause from the log + the changed files, repair the smallest credible set of files, and ' +
      'verify locally with `pnpm typecheck && pnpm lint`. Do not edit CI config unless the ' +
      'config itself is wrong. Avoid touching unrelated files.',
    seed: {
      brokenFile: {
        path: 'src/api/users.ts',
        content:
          '// Intentionally broken — typecheck must fail until the agent repairs it.\n' +
          'export function findUser(id: string): User | undefined {\n' +
          '  return db.query(`SELECT * FROM users WHERE id = ${id}`)\n' +
          '}\n',
      },
    },
    acceptance: [
      {
        id: 'typecheck-passes',
        description: 'pnpm typecheck exits 0',
        command: 'pnpm typecheck',
        tags: ['typecheck'],
      },
      {
        id: 'lint-passes',
        description: 'pnpm lint exits 0',
        command: 'pnpm lint',
        tags: ['lint'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      runtime_per_completed_task: 0.15,
      irrelevant_files_edited: 0.2,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 3. test_failure_repair — local test suite is broken.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'test-failure-permissions-repair',
    cls: 'test_failure_repair',
    title: 'Repair the permissions test suite',
    risk: 'medium',
    prompt:
      'The permissions test suite is failing locally. Diagnose the failing tests, repair the ' +
      'underlying bug, and verify the full suite passes. Do not weaken tests; fix the ' +
      'implementation. Use the test output as your primary evidence.',
    seed: {
      brokenFile: {
        path: 'src/auth/permissions.ts',
        content:
          '// Intentionally broken — required role check dropped.\n' +
          'export function canInvite(role: string): boolean { return role === "admin" || role === "member" }\n',
      },
    },
    acceptance: [
      {
        id: 'permissions-tests-pass',
        description: 'pnpm test passes (exit 0)',
        command: 'pnpm test -- --run --reporter=basic',
        tags: ['test'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      verified_completion_rate: 0.45,
      repeated_failed_attempts: 0.15,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 4. migration_plus_api — DB migration + new endpoint.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'migration-invites-table',
    cls: 'migration_plus_api',
    title: 'Add invitations table + accept endpoint',
    risk: 'high',
    prompt:
      'Add an `invitations` table to the database (migration under src/db/migrations/), a new ' +
      '`POST /orgs/:id/invites` API endpoint to create invitations, and a `POST /invites/:token/accept` ' +
      'endpoint that consumes an invitation token. Invitations must carry a role, an expiry, ' +
      'and must be revoked-able. Existing API tests must still pass. Add tests for the new ' +
      'endpoints covering happy path, expired token, and double-accept.',
    acceptance: [
      {
        id: 'migration-runs-up',
        description: 'Migration applies cleanly',
        command: 'pnpm db:migrate:up',
        tags: ['migration'],
      },
      {
        id: 'invite-api-tests-pass',
        description: 'Invite API tests pass',
        command: 'pnpm test -- --run --reporter=basic invite-api',
        tags: ['test', 'api'],
      },
      {
        id: 'expired-invite-rejected',
        description: 'Expired invite test passes',
        command: 'pnpm test -- --run --reporter=basic expired-invite',
        tags: ['test', 'api'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      verified_completion_rate: 0.35,
      irrelevant_files_edited: 0.15,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 5. frontend_plus_backend — coordinated UI + API change.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'frontend-team-settings-page',
    cls: 'frontend_plus_backend',
    title: 'Add team settings page + backend API',
    risk: 'medium',
    prompt:
      'Build a "Team Settings" page in the frontend (src/frontend/team/) that lists pending ' +
      'invitations, allows an admin to revoke them, and surfaces a CTA to invite a new member. ' +
      'Add the corresponding backend endpoints under src/api/teams/. Add component tests for the ' +
      'frontend page and integration tests for the new endpoints.',
    acceptance: [
      {
        id: 'frontend-team-page-renders',
        description: 'Frontend team page renders',
        expectedFiles: ['src/frontend/team/TeamSettings.tsx'],
        tags: ['frontend'],
      },
      {
        id: 'teams-api-tests-pass',
        description: 'Teams API tests pass',
        command: 'pnpm test -- --run --reporter=basic teams-api',
        tags: ['test', 'api'],
      },
      {
        id: 'frontend-component-tests-pass',
        description: 'Frontend component tests pass',
        command: 'pnpm test -- --run --reporter=basic frontend',
        tags: ['test', 'frontend'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      irrelevant_files_edited: 0.2,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 6. review_comment_resolution — respond to human review feedback.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'review-invite-expiry-handling',
    cls: 'review_comment_resolution',
    title: 'Address review: invite expiry handling',
    risk: 'medium',
    prompt:
      'A reviewer left the following comment on the open invite PR. Read the comment at ' +
      '.forge/reviews/review-1.md, apply the requested changes, add tests for any behavior you ' +
      'change, and produce a clean re-verified diff. Do not introduce new dependencies.',
    seed: {
      reviewerComment:
        '# Review comment\n\n' +
        '1. The invite expiry is stored as `expires_at` but the acceptance endpoint never reads ' +
        'it — please reject expired invitations.\n' +
        '2. Add a unit test that exercises expiry with a clock stub.\n' +
        '3. The migration default should be NULL, not 0 — please fix.\n',
      createFile: {
        path: '.forge/reviews/review-1.md',
        content:
          '# Review comment\n\n' +
          '1. The invite expiry is stored as `expires_at` but the acceptance endpoint never reads ' +
          'it — please reject expired invitations.\n' +
          '2. Add a unit test that exercises expiry with a clock stub.\n' +
          '3. The migration default should be NULL, not 0 — please fix.\n',
      },
    },
    acceptance: [
      {
        id: 'expired-invite-rejected-after-review',
        description: 'Expired invite rejection test passes',
        command: 'pnpm test -- --run --reporter=basic expired-invite',
        tags: ['test'],
      },
      {
        id: 'review-comment-acknowledged',
        description: 'No leftover review-comment annotations in diff',
        expectGitChanges: false,
        tags: ['process'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      repeated_failed_attempts: 0.15,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 7. monorepo_framework_upgrade — large repo navigation.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'monorepo-frontend-react-upgrade',
    cls: 'monorepo_framework_upgrade',
    title: 'Upgrade frontend framework across monorepo',
    risk: 'high',
    prompt:
      'Upgrade the frontend framework (the React version used by `apps/web`, `apps/admin`, ' +
      'and `packages/ui-kit`) to the next minor. Coordinate the changes across all three ' +
      'packages, fix any breaking changes the upgrade surfaces in shared components, and ' +
      'ensure every package\'s typecheck, lint, and test commands pass. Add a CHANGELOG entry ' +
      'describing the upgrade.',
    acceptance: [
      {
        id: 'monorepo-typecheck-passes',
        description: 'pnpm -r typecheck exits 0',
        command: 'pnpm -r typecheck',
        tags: ['typecheck', 'monorepo'],
      },
      {
        id: 'monorepo-tests-pass',
        description: 'pnpm -r test exits 0',
        command: 'pnpm -r test -- --run --reporter=basic',
        tags: ['test', 'monorepo'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      verified_completion_rate: 0.25,
      irrelevant_files_edited: 0.25,
      runtime_per_completed_task: 0.15,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 8. production_bug_investigation — log-driven diagnosis.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'prod-bug-403-after-migration',
    cls: 'production_bug_investigation',
    title: 'Investigate production 403 spike',
    risk: 'critical',
    prompt:
      'Production telemetry shows a sudden spike of HTTP 403 responses on the invite API since ' +
      'the last deploy. Read the sample log at `.forge/ops/prod-403.log`, correlate with the ' +
      'changed files in `.forge/ops/prod-diff.txt`, and produce a minimal patch that resolves ' +
      'the production issue. Add a regression test that would have caught this in CI.',
    seed: {
      createFile: {
        path: '.forge/ops/prod-403.log',
        content:
          '=== .forge/ops/prod-403.log ===\n' +
          '2026-06-17T03:14:02Z POST /orgs/123/invites 403 user_id=u_42 sso=true role=admin\n' +
          '2026-06-17T03:14:08Z POST /orgs/123/invites 403 user_id=u_42 sso=true role=admin\n' +
          '2026-06-17T03:14:14Z POST /orgs/123/invites 403 user_id=u_42 sso=true role=admin\n' +
          '\n=== .forge/ops/prod-diff.txt ===\n' +
          'diff --git a/src/auth/sso.ts b/src/auth/sso.ts\n' +
          '+++ b/src/auth/sso.ts\n' +
          '@@ -10,7 +10,7 @@\n' +
          '-export function normalizeRole(role: string): Role { return role as Role }\n' +
          '+export function normalizeRole(role: string): Role { return (role.toLowerCase()) as Role }\n',
      },
    },
    acceptance: [
      {
        id: 'prod-403-regression-test-passes',
        description: 'Regression test for production 403 passes',
        command: 'pnpm test -- --run --reporter=basic sso-403',
        tags: ['test', 'production'],
      },
      {
        id: 'auth-regression-suite-still-green',
        description: 'Full auth regression suite still passes',
        command: 'pnpm test -- --run --reporter=basic auth',
        tags: ['test', 'auth'],
      },
    ],
    weights: {
      ...DEFAULT_METRIC_WEIGHTS,
      verified_completion_rate: 0.35,
      irrelevant_files_edited: 0.15,
      human_interventions: 0.15,
    },
  },
]

/** Lookup helper used by the CLI and harness. */
export function findTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((t) => t.id === id)
}

/** Stable list of task ids — used by `--list` and documentation generation. */
export const EVAL_TASK_IDS: string[] = EVAL_TASKS.map((t) => t.id)