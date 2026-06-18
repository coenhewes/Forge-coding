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
import { ProbePanel, type ProbePanelFixture } from '../packages/forge-tui/src/panels/ProbePanel.js'
import { ContradictionPanel, type ContradictionPanelFixture } from '../packages/forge-tui/src/panels/ContradictionPanel.js'
import { DecisionPanel, type DecisionPanelFixture } from '../packages/forge-tui/src/panels/DecisionPanel.js'
import { CheckpointPanel, type CheckpointPanelFixture } from '../packages/forge-tui/src/panels/CheckpointPanel.js'
import { PrReadinessPanel, type PrReadinessPanelFixture } from '../packages/forge-tui/src/panels/PrReadinessPanel.js'
import { CostPanel, type CostPanelFixture } from '../packages/forge-tui/src/panels/CostPanel.js'
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

// ─── t51: fixtures for the 6 additional panels ────────────────────────

const probeFixture: ProbePanelFixture = {
  probes: [
    {
      id: 'p1',
      claimId: 'c1',
      rationale: 'Run auth regression suite to verify non-admin is blocked',
      expectedEvidenceKind: 'integration_test',
      priorityScore: 0.85,
      blocked: false,
    },
    {
      id: 'p2',
      claimId: 'c2',
      rationale: 'Smoke probe invite API directly with curl',
      expectedEvidenceKind: 'direct_api_probe',
      priorityScore: 0.4,
      blocked: false,
    },
  ],
}

const contradictionFixture: ContradictionPanelFixture = {
  contradictions: [
    {
      id: 'co1',
      claimId: 'c1',
      evidenceId: 'ev1',
      note: 'Session says admin but invite policy expects org_admin',
      raisedAt: '2026-06-17T21:35:00Z',
    },
  ],
  staleClaims: [
    {
      claimId: 'c2',
      taskId: 'task_demo',
      lastEvidenceAt: '2026-06-15T10:00:00Z',
      reason: 'high',
    },
  ],
}

const decisionFixture: DecisionPanelFixture = {
  decisions: [
    {
      id: 'd1',
      taskId: 'task_demo',
      summary: 'Normalize SSO role aliases in auth layer',
      rationale: 'Invite route should not know provider-specific role names.',
      alternativesRejected: ['patch frontend role check', 'special-case invite route'],
      verificationRequired: ['old org_admin users can still invite', 'new SSO admin users can invite'],
      madeAt: '2026-06-17T21:50:00Z',
    },
  ],
}

const checkpointFixture: CheckpointPanelFixture = {
  candidates: [
    {
      id: 'pc1',
      hypothesis: 'Patch sso role mapping normalizer',
      filesChanged: ['src/auth/sso.ts'],
      reason: 'First attempt',
      testResult: 'fail',
      verificationStatus: 'failed',
      promoted: false,
    },
    {
      id: 'pc2',
      hypothesis: 'Patch sso role mapping normalizer (v2)',
      filesChanged: ['src/auth/sso.ts', 'tests/auth/sso.test.ts'],
      reason: 'Added test for old org_admin alias',
      testResult: 'pass',
      verificationStatus: 'verified',
      promoted: true,
    },
  ],
}

const prReadinessFixture: PrReadinessPanelFixture = {
  checklist: [
    { item: 'auth regression tests', status: 'pass' },
    { item: 'migration up/down', status: 'pass' },
    { item: 'typecheck', status: 'pass' },
    { item: 'security review', status: 'pending', note: 'Auth changes flagged high-risk' },
  ],
  unresolvedReviewComments: 2,
  riskAreas: ['auth', 'permissions', 'role_mapping'],
}

const costFixture: CostPanelFixture = {
  stages: [
    { name: 'explore', inputTokens: 1200, outputTokens: 800, runtimeMs: 4200, costUsd: 0.012 },
    { name: 'implement', inputTokens: 3000, outputTokens: 1800, runtimeMs: 15000, costUsd: 0.038 },
    { name: 'verify', inputTokens: 800, outputTokens: 400, runtimeMs: 12000, costUsd: 0.009 },
  ],
  totals: { inputTokens: 5000, outputTokens: 3000, runtimeMs: 31200, costUsd: 0.059 },
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

describe('PanelsDashboard — 3x2 grid host (legacy, now 12-panel)', () => {
  it('builds without blessed and renders all 6 legacy panels', () => {
    const dash = new PanelsDashboard({
      useBlessed: false,
      fixtures: allFixtures(),
    })
    try {
      const out = dash.renderAll(120, 24)
      const rows = out.split('\n')
      // 3x4 grid → at least 4 rows of width-3 columns worth of content
      expect(rows.length).toBeGreaterThanOrEqual(4)
      // Each rendered row should be at least ~3 columns wide
      for (const row of rows) {
        expect(row.length).toBeGreaterThanOrEqual(60)
      }
      // Spot-check that each legacy panel contributed
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
      fixtures: emptyFixtures() as any,
    })
    try {
      dash.update(allFixtures() as any)
      const out = dash.renderAll(200, 30)
      expect(out).toContain('task_demo')
      // hypothesis claim string must appear somewhere in the joined output
      // (column widths truncate in 3x4 grid, so check substring)
      expect(out).toContain('SSO role mapping')
    } finally {
      dash.destroy()
    }
  })

  it('destroy() is safe to call on headless instance', () => {
    const dash = new PanelsDashboard({
      useBlessed: false,
      fixtures: allFixtures(),
    })
    expect(() => dash.destroy()).not.toThrow()
    expect(() => dash.destroy()).not.toThrow() // idempotent
  })
})

// ─── t53: 3×4 grid + 2×6 compact fallback + renderRow helper ─────────

function allFixtures() {
  return {
    task: taskFixture,
    belief: hypothesisFixture,
    verification: verificationFixture,
    evidence: evidenceFixture,
    trace: traceFixture,
    failures: failureFixture,
    probe: probeFixture,
    contradiction: contradictionFixture,
    decision: decisionFixture,
    checkpoint: checkpointFixture,
    prReadiness: prReadinessFixture,
    cost: costFixture,
  }
}

function emptyFixtures() {
  return {
    task: { ...taskFixture, taskId: 'task_empty', status: 'idle', originalRequest: '', currentInterpretation: '', nextAction: '' },
    belief: [] as Hypothesis[],
    verification: { ...verificationFixture, recommendedAction: verificationFixture.recommendedAction, candidateActions: [], claimGaps: [], scores: [] },
    evidence: [] as EvidenceEntry[],
    trace: [] as TraceEvent[],
    failures: { ledger: [] as FailureEntry[], disproven: [] },
    probe: { probes: [] },
    contradiction: { contradictions: [], staleClaims: [] },
    decision: { decisions: [] },
    checkpoint: { candidates: [] },
    prReadiness: { checklist: [], unresolvedReviewComments: 0, riskAreas: [] },
    cost: { stages: [], totals: { inputTokens: 0, outputTokens: 0, runtimeMs: 0, costUsd: 0 } },
  }
}

describe('PanelsDashboard — 3x4 grid (12 panels) snapshot tests', () => {
  it('full 3x4 grid renders all 12 panels populated', () => {
    const dash = new PanelsDashboard({ useBlessed: false, fixtures: allFixtures() })
    try {
      const out = dash.renderAll(120, 48)
      const lines = out.split('\n')
      // 4 rows * 12-line rowH = at least 48 lines of grid content
      expect(lines.length).toBeGreaterThanOrEqual(20)
      // Each row of the joined grid should be ~3 columns wide
      for (const line of lines) {
        expect(line.length).toBeGreaterThanOrEqual(60)
      }
      // Spot-check each of the 12 panels contributed
      expect(out).toContain('Next:')                                  // row 0: Task
      expect(out).toContain('Belief — top')                           // row 0: Belief
      expect(out).toContain('Recommended:')                           // row 0: Verify
      expect(out).toContain('Evidence — last')                        // row 1: Evidence
      expect(out).toContain('Trace — last')                           // row 1: Trace
      expect(out).toContain('Recent attempts:')                       // row 1: Failures
      expect(out).toContain('Probes —')                               // row 2: Probe
      expect(out).toContain('Contradictions —')                       // row 2: Contradiction
      expect(out).toContain('Decisions —')                            // row 2: Decision
      expect(out).toContain('Checkpoints —')                          // row 3: Checkpoint
      expect(out).toContain('PR readiness')                           // row 3: PR Readiness
      expect(out).toContain('Cost —')                                 // row 3: Cost
    } finally {
      dash.destroy()
    }
  })

  it('empty fixtures still render all 12 panels (no crash, no content)', () => {
    const dash = new PanelsDashboard({ useBlessed: false, fixtures: emptyFixtures() as any })
    try {
      const out = dash.renderAll(120, 48)
      const lines = out.split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(20)
      // All 12 panels should still emit their headers (even if "(no ...)")
      expect(out).toContain('Probes —')
      expect(out).toContain('Contradictions —')
      expect(out).toContain('Decisions —')
      expect(out).toContain('Checkpoints —')
      expect(out).toContain('PR readiness')
      expect(out).toContain('Cost —')
      // Empty probe/decision/etc fixtures should show "0 queued" / "0 on file" markers
      expect(out).toContain('0 queued')
      expect(out).toContain('0 on file')
    } finally {
      dash.destroy()
    }
  })

  it('2x6 compact fallback renders correctly when height=20 (< 24 threshold)', () => {
    const dash = new PanelsDashboard({ useBlessed: false, fixtures: allFixtures() })
    try {
      const out = dash.renderAll(180, 20)
      const lines = out.split('\n')
      // Compact: 2 rows. Each row has 6 panels side-by-side (colW = 180/6 = 30).
      // The line length should be at least 6 columns wide.
      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) {
        expect(line.length).toBeGreaterThanOrEqual(120)
      }
      // Compact layout: row 0 contains the first 6 panels (Task..Failures)
      // row 1 contains the t51 panels (Probe..Cost).
      const top = lines[0] ?? ''
      const bottom = lines[lines.length - 1] ?? ''
      // Each compact row is wider than 3x2's per-row width (60), so any line
      // being at least 120 chars is itself the compact-fallback signature.
      expect(top.length).toBeGreaterThan(120)
      expect(bottom.length).toBeGreaterThan(120)
      // In compact mode, narrow columns truncate most panel content. The
      // distinct signature is the panel HEADERS from the t51 row appearing
      // alongside the t50a headers in the same wider lines. All 12 panel
      // headers should still be findable.
      expect(out).toContain('task_demo')            // row 0: Task
      expect(out).toContain('Probes —')             // row 1: Probe
      expect(out).toContain('Contradictions —')     // row 1: Contradiction
      expect(out).toContain('Decisions —')          // row 1: Decision
      expect(out).toContain('Checkpoints —')        // row 1: Checkpoint
      expect(out).toContain('PR readiness')         // row 1: PrReadiness
      expect(out).toContain('Cost —')               // row 1: Cost
    } finally {
      dash.destroy()
    }
  })

  it('renderRow(0..3) each returns a different single-row string', () => {
    const dash = new PanelsDashboard({ useBlessed: false, fixtures: allFixtures() })
    try {
      const r0 = dash.renderRow(0, 80, 12)
      const r1 = dash.renderRow(1, 80, 12)
      const r2 = dash.renderRow(2, 80, 12)
      const r3 = dash.renderRow(3, 80, 12)

      // Each row is 3 panels joined side-by-side, so its width is 3*colW ≈ 80.
      for (const row of [r0, r1, r2, r3]) {
        expect(row.length).toBeGreaterThanOrEqual(60)
      }
      // All four rows must be distinct (different panels -> different content).
      expect(r0).not.toBe(r1)
      expect(r0).not.toBe(r2)
      expect(r0).not.toBe(r3)
      expect(r1).not.toBe(r2)
      expect(r1).not.toBe(r3)
      expect(r2).not.toBe(r3)

      // Each row has its expected header.
      expect(r0).toContain('Next:')           // TaskPanel
      expect(r0).toContain('Belief — top')    // BeliefPanel
      expect(r0).toContain('Recommended:')    // VerificationPanel
      expect(r1).toContain('Evidence — last') // EvidencePanel
      expect(r1).toContain('Trace — last')    // TracePanel
      expect(r1).toContain('Recent attempts:')// FailurePanel
      expect(r2).toContain('Probes —')        // ProbePanel
      expect(r2).toContain('Contradictions —')// ContradictionPanel
      expect(r2).toContain('Decisions —')     // DecisionPanel
      expect(r3).toContain('Checkpoints —')   // CheckpointPanel
      expect(r3).toContain('PR readiness')    // PrReadinessPanel
      expect(r3).toContain('Cost —')          // CostPanel

      // Out-of-range rowIndex throws.
      expect(() => dash.renderRow(4 as any, 80, 12)).toThrow(/rowIndex/)
      expect(() => dash.renderRow(-1 as any, 80, 12)).toThrow(/rowIndex/)
    } finally {
      dash.destroy()
    }
  })
})