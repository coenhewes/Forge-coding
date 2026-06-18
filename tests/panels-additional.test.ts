/**
 * t51 — 6 additional TUI panels snapshot tests.
 *
 * 12 snapshot tests across the 6 panels (2 per panel: empty fixture,
 * populated fixture). Matches the structural-invariants style of
 * tests/tui-panels.test.ts — assert on labels, badges, and presence of
 * fixture entries, not full string equality, so layout tweaks don't break
 * tests.
 *
 * Type names mirror the contract t53 left on disk: Probe / Contradiction /
 * StaleClaim / Decision / PatchCandidate / PrChecklistItem / PrCheckStatus /
 * CostStage. Same for the Fixture type names.
 */

import { describe, it, expect } from 'vitest'

import {
  ProbePanel,
  type ProbePanelFixture,
} from '../packages/forge-tui/src/panels/ProbePanel.js'
import {
  ContradictionPanel,
  type ContradictionPanelFixture,
} from '../packages/forge-tui/src/panels/ContradictionPanel.js'
import {
  DecisionPanel,
  type DecisionPanelFixture,
} from '../packages/forge-tui/src/panels/DecisionPanel.js'
import {
  CheckpointPanel,
  type CheckpointPanelFixture,
} from '../packages/forge-tui/src/panels/CheckpointPanel.js'
import {
  PrReadinessPanel,
  type PrReadinessPanelFixture,
} from '../packages/forge-tui/src/panels/PrReadinessPanel.js'
import {
  CostPanel,
  type CostPanelFixture,
} from '../packages/forge-tui/src/panels/CostPanel.js'

const W = 80
const H = 24

// ─── Fixtures ────────────────────────────────────────────────────────────

const probeFixture: ProbePanelFixture = {
  probes: [
    {
      id: 'p1',
      claimId: 'c_invite_permission',
      rationale: 'Run auth regression to confirm SSO role mapping still rejects non-admin invites.',
      expectedEvidenceKind: 'integration_test',
      priorityScore: 0.85,
      blocked: false,
    },
    {
      id: 'p2',
      claimId: 'c_invite_expiry',
      rationale: 'Probe expired invite returns 410 Gone.',
      expectedEvidenceKind: 'direct_api_probe',
      priorityScore: 0.62,
      blocked: false,
    },
    {
      id: 'p3',
      claimId: 'c_migration_preserves_column',
      rationale: 'psql \\d+ users should still show role column after migration 0042.',
      expectedEvidenceKind: 'observed_fact',
      priorityScore: 0.4,
      blocked: true,
    },
  ],
}

const contradictionFixture: ContradictionPanelFixture = {
  contradictions: [
    {
      id: 'cx1',
      claimId: 'c_role_mapping',
      evidenceId: 'ev_session_admin',
      note: 'Session trace shows role=admin but invite route requires org_admin',
      raisedAt: '2026-06-17T21:30:00Z',
    },
    {
      id: 'cx2',
      claimId: 'c_invite_expiry',
      evidenceId: 'ev_invite_test_pass',
      note: 'Unit test passes but API test fails on expired invite path',
      raisedAt: '2026-06-17T21:45:00Z',
    },
  ],
  staleClaims: [
    {
      claimId: 'c_role_mapping',
      taskId: 'task_demo',
      lastEvidenceAt: '2026-06-10T12:00:00Z',
      reason: 'auth role mapping refactored since evidence was collected',
    },
    {
      claimId: 'c_invite_count',
      taskId: 'task_demo',
      lastEvidenceAt: '2026-06-05T08:00:00Z',
      reason: 'data freshness — invite counts stale across migration',
    },
  ],
}

const decisionFixture: DecisionPanelFixture = {
  decisions: [
    {
      id: 'd1',
      taskId: 'task_demo',
      summary: 'Normalize SSO role aliases in auth layer, not invite route',
      rationale:
        'Invite route should not know provider-specific role names. Pushing normalization to the auth layer keeps the invite policy simple and reusable.',
      alternativesRejected: [
        'patch frontend role check',
        'special-case invite route',
        'backfill database only',
      ],
      verificationRequired: [
        'old org_admin users can still invite',
        'new SSO admin users can invite',
        'non-admin users are still blocked',
      ],
      madeAt: '2026-06-17T22:00:00Z',
    },
    {
      id: 'd2',
      taskId: 'task_demo',
      summary: 'Use 410 Gone for expired invites instead of 404',
      rationale: '410 distinguishes expired from never-existed, helping clients show a clearer message.',
      alternativesRejected: ['use 404 (less informative)', 'use 403 (overloaded semantics)'],
      verificationRequired: ['expired invite unit test', 'expired invite API test'],
      madeAt: '2026-06-17T22:15:00Z',
    },
  ],
}

const checkpointFixture: CheckpointPanelFixture = {
  candidates: [
    {
      id: 'pc1',
      hypothesis: 'Frontend role check is the cause',
      filesChanged: ['web/src/InviteForm.tsx'],
      reason: 'Quickest patch to test SSO role mapping hypothesis',
      testResult: 'fail',
      verificationStatus: 'failed',
      promoted: false,
    },
    {
      id: 'pc2',
      hypothesis: 'Normalize role in auth layer',
      filesChanged: ['packages/auth/src/sso.ts', 'packages/auth/src/roles.ts'],
      reason: 'Centralize SSO role normalization',
      testResult: 'pass',
      verificationStatus: 'passed',
      promoted: true,
    },
    {
      id: 'pc3',
      hypothesis: 'Backfill role column with org_admin alias',
      filesChanged: ['packages/db/migrations/0043_backfill.sql'],
      reason: 'DBA-approved rollback path',
      testResult: 'pending',
      verificationStatus: 'not_run',
      promoted: false,
    },
  ],
}

const prReadinessFixture: PrReadinessPanelFixture = {
  checklist: [
    { item: 'Acceptance criteria verified', status: 'pass' },
    { item: 'Tests added for new behaviour', status: 'pass' },
    { item: 'Migration up/down tested', status: 'pending', note: 'waiting on CI slot' },
    { item: 'Auth regression suite', status: 'pass' },
    { item: 'Security review for SSO role change', status: 'fail', note: 'reviewer not assigned' },
    { item: 'Docs updated', status: 'na' },
  ],
  unresolvedReviewComments: 3,
  riskAreas: ['auth', 'permissions', 'migrations'],
}

const costFixture: CostPanelFixture = {
  stages: [
    { name: 'task_understanding', inputTokens: 1240, outputTokens: 380, runtimeMs: 2200, costUsd: 0.0124 },
    { name: 'localization', inputTokens: 3400, outputTokens: 720, runtimeMs: 4800, costUsd: 0.0273 },
    { name: 'patch_search', inputTokens: 8900, outputTokens: 1500, runtimeMs: 12300, costUsd: 0.0712 },
    { name: 'verification', inputTokens: 2100, outputTokens: 480, runtimeMs: 6700, costUsd: 0.0188 },
  ],
  totals: {
    inputTokens: 15640,
    outputTokens: 3080,
    runtimeMs: 26000,
    costUsd: 0.1297,
  },
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('t51 — ProbePanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new ProbePanel({ probes: [] })
    const out = panel.render(W, H)
    expect(typeof out).toBe('string')
    expect(out).toContain('Probes — 0 (0 open, 0 blocked)')
    expect(out).toContain('(no probes queued)')
  })

  it('renders populated fixture with priority bars + blocked dim', () => {
    const panel = new ProbePanel(probeFixture)
    const out = panel.render(W, H)
    expect(out).toMatch(/Probes — \d+ \(\d+ open, \d+ blocked\)/)
    expect(out).toContain('kind: integration_test')
    expect(out).toMatch(/\[#+\-+\]/) // priority bar present
    expect(out).toContain('c_invite_permission')
    expect(out).toContain('[·]') // blocked marker
  })
})

describe('t51 — ContradictionPanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new ContradictionPanel({ contradictions: [], staleClaims: [] })
    const out = panel.render(W, H)
    expect(out).toContain('Contradictions — 0 open, 0 stale claims')
    expect(out).toContain('Open contradictions:')
    expect(out).toContain('Stale claims:')
    expect(out).toContain('(none)')
  })

  it('renders populated fixture with newest-first contradictions + severity tags', () => {
    const panel = new ContradictionPanel(contradictionFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Contradictions — 2 open, 2 stale claims')
    // newest contradiction (raisedAt 21:45) appears before 21:30
    const idx1 = out.indexOf('cx2')
    const idx2 = out.indexOf('cx1')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx2).toBeGreaterThan(-1)
    expect(idx1).toBeLessThan(idx2)
    expect(out).toContain('[!]') // contradiction marker
    expect(out).toContain('c_role_mapping')
    expect(out).toContain('reason: auth role mapping')
  })
})

describe('t51 — DecisionPanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new DecisionPanel({ decisions: [] })
    const out = panel.render(W, H)
    expect(out).toContain('Decisions — 0')
    expect(out).toContain('(no decisions recorded)')
  })

  it('renders populated fixture chronologically; expand via handleKey', () => {
    const panel = new DecisionPanel(decisionFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Decisions — 2')
    expect(out).toContain('Normalize SSO role aliases')
    expect(out).toContain('Use 410 Gone')
    // Both rows present with verify count
    expect(out).toMatch(/verify: \d+ required/)

    // Expand first decision — should reveal rationale + rejected alternatives + obligations.
    panel.handleKey('e')
    expect(panel.isExpanded()).toBe(true)
    const expandedOut = panel.render(W, H)
    expect(expandedOut).toContain('rejected alternatives:')
    expect(expandedOut).toContain('verification obligations:')
    expect(expandedOut).toContain('patch frontend role check')
    expect(expandedOut).toContain('non-admin users are still blocked')

    // Collapse again
    panel.handleKey('e')
    expect(panel.isExpanded()).toBe(false)
  })
})

describe('t51 — CheckpointPanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new CheckpointPanel({ candidates: [] })
    const out = panel.render(W, H)
    expect(out).toContain('Checkpoints — 0 candidates (0 promoted, 0 passed)')
    expect(out).toContain('(no patch candidates)')
  })

  it('renders populated fixture; promoted candidate highlighted', () => {
    const panel = new CheckpointPanel(checkpointFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Checkpoints — 3 candidates (1 promoted, 1 passed)')
    expect(out).toContain('[+]') // promoted badge
    expect(out).toContain('[x]') // failed badge
    expect(out).toContain('[?]') // not_run / pending badge
    expect(out).toContain('★ promoted')
    expect(out).toContain('Normalize role in auth layer')
    // The promoted line starts with '=' (our highlight marker)
    expect(out).toMatch(/^=\s+\[\+\]/m)
  })
})

describe('t51 — PrReadinessPanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new PrReadinessPanel({
      checklist: [],
      unresolvedReviewComments: 0,
      riskAreas: [],
    })
    const out = panel.render(W, H)
    expect(out).toContain('PR readiness — 0✓ 0✗ 0· 0n')
    expect(out).toContain('(no checklist items)')
  })

  it('renders populated fixture with status icons + unresolved comments + risk tags', () => {
    const panel = new PrReadinessPanel(prReadinessFixture)
    const out = panel.render(W, H)
    expect(out).toContain('PR readiness — 3✓ 1✗ 1· 1n')
    expect(out).toContain('3 unresolved comments')
    expect(out).toMatch(/\[✓]/)
    expect(out).toMatch(/\[✗]/)
    expect(out).toMatch(/\[·]/)
    expect(out).toMatch(/\[—]/) // na icon
    expect(out).toContain('Acceptance criteria verified')
    expect(out).toContain('Security review for SSO role change')
    expect(out).toContain('Risk areas: #auth #permissions #migrations')
  })
})

describe('t51 — CostPanel', () => {
  it('renders empty fixture without throwing', () => {
    const panel = new CostPanel({
      stages: [],
      totals: { inputTokens: 0, outputTokens: 0, runtimeMs: 0, costUsd: 0 },
    })
    const out = panel.render(W, H)
    expect(out).toContain('Cost — 0 stages')
    expect(out).toContain('(no stages recorded)')
    expect(out).toContain('TOTAL')
  })

  it('renders populated fixture; sort toggle via handleKey', () => {
    const panel = new CostPanel(costFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Cost — 4 stages  sort: name')
    expect(out).toContain('stage')
    expect(out).toContain('in_tok')
    expect(out).toContain('out_tok')
    expect(out).toContain('runtime_ms')
    expect(out).toContain('cost_usd')
    expect(out).toContain('TOTAL')
    // stage rows present
    expect(out).toContain('task_understanding')
    expect(out).toContain('localization')
    expect(out).toContain('patch_search')
    expect(out).toContain('verification')
    // Totals row sums the per-stage values
    expect(out).toContain('15,640')

    // Toggle to cost-desc sort
    panel.handleKey('s')
    expect(panel.getSortMode()).toBe('cost')
    const sortedOut = panel.render(W, H)
    expect(sortedOut).toContain('sort: cost')
    // patch_search (cost 0.0712) should appear before verification (0.0188)
    const patchIdx = sortedOut.indexOf('patch_search')
    const verifyIdx = sortedOut.indexOf('verification')
    expect(patchIdx).toBeGreaterThan(-1)
    expect(verifyIdx).toBeGreaterThan(-1)
    expect(patchIdx).toBeLessThan(verifyIdx)

    // Toggle back
    panel.handleKey('s')
    expect(panel.getSortMode()).toBe('name')
  })
})
