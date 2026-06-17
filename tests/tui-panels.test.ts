/**
 * t50a — TUI panels snapshot tests.
 *
 * Each panel renders without throwing given a fixed fixture. We assert on
 * structural invariants (expected labels, the presence of at least one row per
 * fixture entry) rather than full string equality so layout tweaks don't break
 * tests. Headless: `useBlessed: false` so no TTY is required.
 */

import { describe, it, expect } from 'vitest'

import { TaskPanel, type TaskPanelFixture } from '../packages/forge-tui/src/panels/TaskPanel.js'
import { BeliefPanel } from '../packages/forge-tui/src/panels/BeliefPanel.js'
import { VerificationPanel } from '../packages/forge-tui/src/panels/VerificationPanel.js'
import { EvidencePanel } from '../packages/forge-tui/src/panels/EvidencePanel.js'
import { TracePanel } from '../packages/forge-tui/src/panels/TracePanel.js'
import { FailurePanel } from '../packages/forge-tui/src/panels/FailurePanel.js'
import { PanelsDashboard } from '../packages/forge-tui/src/panels-dashboard.js'

import type { Hypothesis, EvidenceEntry, TraceEvent, FailureEntry, ActiveVerificationPlan } from '@forge/types'

// ─── Fixtures ────────────────────────────────────────────────────────────

const taskFixture: TaskPanelFixture = {
  taskId: 'task_demo',
  status: 'implementing',
  originalRequest: 'Add team invitations with roles, expiry, and audit logs.',
  currentInterpretation: 'Touches auth, db, api, frontend, and tests. Blocked by SSO role mapping.',
  nextAction: 'Run recommended verification: run_auth_regression_tests',
  filesTouched: ['src/auth/invite.ts', 'src/db/migrations/0042_invites.sql'],
  commandsRun: ['pnpm migrate', 'pnpm test:auth'],
  testsRun: ['auth/invite.test.ts'],
  reviewBlockers: ['SSO role mapping ambiguity'],
  updatedAt: '2026-06-17T22:00:00Z',
}

const hypothesisFixture: Hypothesis[] = [
  {
    id: 'h1',
    claim: 'SSO role mapping regression breaks invite permission',
    status: 'active',
    confidence: 0.72,
    relevantDomains: ['auth', 'backend'],
    relevantGraphNodes: ['auth/sso.ts'],
    supportingEvidence: [{ id: 'ev1', summary: 'Stack trace shows role mapping' }],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: '2026-06-17T21:00:00Z',
    updatedAt: '2026-06-17T21:30:00Z',
  },
  {
    id: 'h2',
    claim: 'Invite route requires org_admin but session returns admin',
    status: 'inconclusive',
    confidence: 0.45,
    relevantDomains: ['auth', 'api'],
    relevantGraphNodes: ['api/invite.ts'],
    supportingEvidence: [],
    contradictingEvidence: [{ id: 'ev2', summary: 'Session trace shows admin role' }],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: '2026-06-17T21:10:00Z',
    updatedAt: '2026-06-17T21:30:00Z',
  },
  {
    id: 'h3',
    claim: 'Migration dropped role column',
    status: 'disproven',
    confidence: 0.05,
    relevantDomains: ['db'],
    relevantGraphNodes: [],
    supportingEvidence: [],
    contradictingEvidence: [{ id: 'ev3', summary: 'Migration preserves column' }],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: '2026-06-17T21:15:00Z',
    updatedAt: '2026-06-17T21:20:00Z',
  },
]

const verificationFixture: ActiveVerificationPlan = {
  taskId: 'task_demo',
  recommendedAction: {
    id: 'a1',
    taskId: 'task_demo',
    actionType: 'integration_test',
    command: 'pnpm test:auth --run',
    targetClaims: ['c1', 'c2'],
    targetAcceptanceCriteria: ['ac1'],
    targetHypotheses: ['h1'],
    targetRisks: ['auth'],
    expectedEvidenceValue: 0.8,
    selectionReason: 'High claim importance + auth risk + unverified invite permission claim.',
    status: 'selected',
  },
  candidateActions: [
    {
      id: 'a1',
      taskId: 'task_demo',
      actionType: 'integration_test',
      command: 'pnpm test:auth --run',
      targetClaims: ['c1'],
      targetAcceptanceCriteria: ['ac1'],
      targetHypotheses: ['h1'],
      targetRisks: ['auth'],
      expectedEvidenceValue: 0.8,
      selectionReason: 'covers auth regression',
      status: 'selected',
    },
    {
      id: 'a2',
      taskId: 'task_demo',
      actionType: 'direct_api_probe',
      command: 'curl /api/invite',
      targetClaims: ['c2'],
      targetAcceptanceCriteria: [],
      targetHypotheses: ['h2'],
      targetRisks: [],
      expectedEvidenceValue: 0.4,
      selectionReason: 'quick smoke',
      status: 'candidate',
    },
  ],
  scores: [
    {
      actionId: 'a1',
      totalScore: 0.85,
      components: {
        claimImportance: 0.3, expectedConfidenceShift: 0.25, riskWeight: 0.2,
        hypothesisDiscrimination: 0.1, evidenceQuality: 0.05, reviewUsefulness: 0.05,
        runtimePenalty: 0.05, flakinessPenalty: 0.03, setupPenalty: 0.02, contextPenalty: 0.0,
      },
      explanation: 'High claim importance + auth risk.',
    },
    {
      actionId: 'a2',
      totalScore: 0.4,
      components: {
        claimImportance: 0.1, expectedConfidenceShift: 0.15, riskWeight: 0.05,
        hypothesisDiscrimination: 0.05, evidenceQuality: 0.05, reviewUsefulness: 0.0,
        runtimePenalty: 0.0, flakinessPenalty: 0.0, setupPenalty: 0.0, contextPenalty: 0.0,
      },
      explanation: 'Quick probe.',
    },
  ],
  claimGaps: [
    {
      claimId: 'c1',
      text: 'Non-admin cannot invite',
      status: 'unverified',
      confidence: 0.3,
      riskLevel: 'high',
      supportingEvidence: [],
      contradictingEvidence: [],
      missingEvidence: ['integration test', 'permission boundary check'],
      requiredActions: ['run integration test'],
      candidateActions: ['a1'],
    },
    {
      claimId: 'c2',
      text: 'Invite expiry rejects expired invites',
      status: 'partially_verified',
      confidence: 0.65,
      riskLevel: 'medium',
      supportingEvidence: ['ev1'],
      contradictingEvidence: [],
      missingEvidence: ['migration test'],
      requiredActions: [],
      candidateActions: [],
    },
  ],
  warnings: ['High-risk task: require security review before completion'],
  generatedAt: '2026-06-17T22:00:00Z',
}

const evidenceFixture: EvidenceEntry[] = [
  {
    id: 'ev1',
    claim: 'SSO mapping returns admin',
    evidence: ['stack trace 2026-06-17T21:30:00Z', 'role=admin from /sso/callback'],
    unverified: [],
    status: 'verified',
    kind: 'observed_fact',
    timestamp: '2026-06-17T21:30:00Z',
    referencableId: 'ev1',
  },
  {
    id: 'ev2',
    claim: 'Invite route requires org_admin',
    evidence: [],
    unverified: ['exact role string from middleware'],
    status: 'unverified',
    kind: 'inferred_fact',
    timestamp: '2026-06-17T21:35:00Z',
    referencableId: 'ev2',
  },
  {
    id: 'ev3',
    claim: 'Migration preserves role column',
    evidence: ['migration diff line 12', 'psql \\d+ users'],
    unverified: [],
    status: 'verified',
    kind: 'code_change',
    timestamp: '2026-06-17T21:40:00Z',
    referencableId: 'ev3',
  },
]

const traceFixture: TraceEvent[] = [
  { id: 't1', type: 'file_read', timestamp: '2026-06-17T21:00:00Z', description: 'read auth/sso.ts', taskId: 'task_demo' },
  { id: 't2', type: 'tool_called', timestamp: '2026-06-17T21:05:00Z', description: 'auth.trace_permission_check', taskId: 'task_demo', durationMs: 120 },
  { id: 't3', type: 'failure_observed', timestamp: '2026-06-17T21:10:00Z', description: 'integration test failed: 403 on /api/invite', taskId: 'task_demo' },
  { id: 't4', type: 'checkpoint_created', timestamp: '2026-06-17T21:15:00Z', description: 'candidate patch #1', taskId: 'task_demo' },
  { id: 't5', type: 'verification_result', timestamp: '2026-06-17T21:20:00Z', description: 'integration test passed after patch #2', taskId: 'task_demo', durationMs: 4500 },
]

const failureFixture = {
  ledger: [
    {
      id: 'f1',
      hypothesis: 'Frontend invite form is blocking SSO admins',
      action: 'Changed frontend role check from org_admin to admin',
      result: 'Invite still fails with 403 — failure is server-side',
      lesson: 'Failure is server-side; do not blame the frontend.',
      nextHypothesis: 'SSO role mapping changed from org_admin to admin',
      evidenceRefs: ['ev1'],
      timestamp: '2026-06-17T20:00:00Z',
    },
    {
      id: 'f2',
      hypothesis: 'Migration dropped role column',
      action: 'Inspected migration sql and re-ran psql \\d+ users',
      result: 'Column is preserved; rule out migration',
      lesson: 'Migration is not the cause; pivot to session normalization.',
      evidenceRefs: ['ev3'],
      timestamp: '2026-06-17T20:30:00Z',
    },
  ] satisfies FailureEntry[],
  disproven: [hypothesisFixture[2]!],
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('TUI panels — render with fixed fixtures (headless)', () => {
  const W = 80
  const H = 24

  it('TaskPanel renders status + next action without throwing', () => {
    const panel = new TaskPanel(taskFixture)
    const out = panel.render(W, H)
    expect(typeof out).toBe('string')
    expect(out).toContain('task_demo')
    expect(out).toContain('Next:')
    expect(out).toContain('implementing')
    expect(out.length).toBeGreaterThan(40)
  })

  it('BeliefPanel renders top hypotheses with confidence bars', () => {
    const panel = new BeliefPanel(hypothesisFixture)
    const out = panel.render(W, H)
    expect(out).toMatch(/Belief — top \d+ hypotheses/)
    expect(out).toContain('SSO role mapping regression')
    // bar characters present
    expect(out).toMatch(/\[#+\-+\]/)
    // disproven h3 must be filtered out
    expect(out).not.toContain('Migration dropped role column')
  })

  it('VerificationPanel renders recommended action + claim gaps', () => {
    const panel = new VerificationPanel(verificationFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Recommended:')
    expect(out).toContain('integration_test')
    expect(out).toContain('Claim gaps (2):')
    expect(out).toContain('Warnings:')
  })

  it('EvidencePanel renders last 10 entries with status tags', () => {
    const panel = new EvidencePanel(evidenceFixture)
    const out = panel.render(W, H)
    expect(out).toMatch(/Evidence — last \d+\/3/)
    expect(out).toContain('[V]') // verified tag
    expect(out).toContain('SSO mapping')
  })

  it('TracePanel renders timeline with separators', () => {
    const panel = new TracePanel(traceFixture)
    const out = panel.render(W, H)
    expect(out).toMatch(/Trace — last \d+\/5/)
    // at least one timeline connector (top, middle, bottom)
    expect(out).toMatch(/[┌│└]/)
    expect(out).toContain('file_read')
    expect(out).toContain('verification_result')
  })

  it('FailurePanel renders attempts + disproven hypotheses', () => {
    const panel = new FailurePanel(failureFixture)
    const out = panel.render(W, H)
    expect(out).toContain('Recent attempts:')
    expect(out).toContain('Disproven hypotheses')
    expect(out).toContain('Migration dropped role column')
    expect(out).toContain('next:')
  })

  it('handleKey records last key (no-op for read-only panels)', () => {
    const panel = new TaskPanel(taskFixture)
    panel.handleKey('j')
    expect(panel.getLastKey()).toBe('j')
    panel.handleKey('enter')
    expect(panel.getLastKey()).toBe('enter')
  })

  it('render handles small dimensions without throwing', () => {
    const panel = new TaskPanel(taskFixture)
    expect(() => panel.render(20, 5)).not.toThrow()
    const panel2 = new BeliefPanel(hypothesisFixture)
    expect(() => panel2.render(20, 5)).not.toThrow()
  })
})

describe('PanelsDashboard — 3x2 grid host', () => {
  it('builds without blessed and renders all 6 panels', () => {
    const dash = new PanelsDashboard({
      useBlessed: false,
      fixtures: {
        task: taskFixture,
        belief: hypothesisFixture,
        verification: verificationFixture,
        evidence: evidenceFixture,
        trace: traceFixture,
        failures: failureFixture,
      },
    })
    try {
      const out = dash.renderAll(120, 24)
      const rows = out.split('\n')
      // 3x2 grid → at least 2 rows of width-3 columns worth of content
      expect(rows.length).toBeGreaterThanOrEqual(2)
      // Each rendered row should be at least ~3 columns wide
      for (const row of rows) {
        expect(row.length).toBeGreaterThanOrEqual(60)
      }
      // Spot-check that each panel contributed
      expect(out).toContain('Next:')
      expect(out).toContain('Belief — top')
      expect(out).toContain('Recommended:')
      expect(out).toContain('Evidence — last')
      expect(out).toContain('Trace — last')
      expect(out).toContain('Recent attempts:')
    } finally {
      dash.destroy()
    }
  })

  it('update() replaces fixtures', () => {
    const dash = new PanelsDashboard({
      useBlessed: false,
      fixtures: {
        task: taskFixture,
        belief: [],
        verification: verificationFixture,
        evidence: [],
        trace: [],
        failures: { ledger: [] },
      },
    })
    try {
      dash.update({
        task: { ...taskFixture, taskId: 'task_after' },
        belief: hypothesisFixture,
        verification: verificationFixture,
        evidence: evidenceFixture,
        trace: traceFixture,
        failures: failureFixture,
      })
      const out = dash.renderAll(200, 30)
      expect(out).toContain('task_after')
      // hypothesis claim string must appear somewhere in the joined output
      // (column widths truncate in 3x2 grid, so check substring)
      expect(out).toContain('SSO role mapping')
    } finally {
      dash.destroy()
    }
  })

  it('destroy() is safe to call on headless instance', () => {
    const dash = new PanelsDashboard({
      useBlessed: false,
      fixtures: {
        task: taskFixture,
        belief: hypothesisFixture,
        verification: verificationFixture,
        evidence: evidenceFixture,
        trace: traceFixture,
        failures: failureFixture,
      },
    })
    expect(() => dash.destroy()).not.toThrow()
    expect(() => dash.destroy()).not.toThrow() // idempotent
  })
})