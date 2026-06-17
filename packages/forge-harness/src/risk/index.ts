import type { DomainManifest, RepoMap, RiskSeverity, TaskRiskAssessment } from '@forge/types'

/**
 * High-risk engineering areas per AGENTS.md. A hit on any of these (via task
 * text, selected-domain risk profiles, or risk-sensitive repo areas) raises the
 * task's risk level and the verification/approval requirements that follow.
 */
const HIGH_RISK_KEYWORDS: { pattern: RegExp; area: string; severity: RiskSeverity }[] = [
  { pattern: /\b(auth|authoriz|permission|role|rbac|access control|sso)\b/i, area: 'auth/permissions', severity: 'high' },
  { pattern: /\b(billing|payment|invoice|charge|subscription|stripe)\b/i, area: 'billing/payments', severity: 'critical' },
  { pattern: /\b(migration|migrate|schema change|drop table|alter table)\b/i, area: 'database migration', severity: 'high' },
  { pattern: /\b(delete|destroy|purge|wipe|truncate)\b/i, area: 'data deletion', severity: 'high' },
  { pattern: /\b(crypto|encrypt|secret|token|credential|password|hash)\b/i, area: 'security/secrets', severity: 'high' },
  { pattern: /\b(concurren|race condition|lock|mutex|transaction)\b/i, area: 'concurrency', severity: 'medium' },
  { pattern: /\b(public api|breaking change|api version|backward compat)\b/i, area: 'public API', severity: 'high' },
  { pattern: /\b(multi-tenant|tenant|privacy|pii|gdpr|compliance)\b/i, area: 'privacy/compliance', severity: 'critical' },
  { pattern: /\b(deploy|infra|terraform|kubernetes|ci\/cd|pipeline)\b/i, area: 'deployment/infra', severity: 'medium' },
]

const SEVERITY_RANK: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

export interface AssessRiskInput {
  task: string
  selectedDomains: string[]
  manifests: DomainManifest[]
  repoMap?: RepoMap
}

/**
 * Classify a task's risk and derive the discipline it demands. Higher risk →
 * more evidence, more verification, conservative edits, more checkpoints, and
 * (at critical) explicit human approval — exactly what AGENTS.md's risk model
 * uses to gate completion.
 */
export function assessTaskRisk(input: AssessRiskInput): TaskRiskAssessment {
  const { task, selectedDomains, manifests, repoMap } = input
  let level: RiskSeverity = 'low'
  const notes: string[] = []

  for (const kw of HIGH_RISK_KEYWORDS) {
    if (kw.pattern.test(task)) {
      level = maxSeverity(level, kw.severity)
      notes.push(`Task touches ${kw.area} (${kw.severity})`)
    }
  }

  for (const domain of selectedDomains) {
    const manifest = manifests.find((m) => m.domain === domain)
    if (!manifest) continue
    if (manifest.reviewSensitivity === 'critical' || manifest.reviewSensitivity === 'high') {
      level = maxSeverity(level, manifest.reviewSensitivity)
      notes.push(`Domain '${domain}' has ${manifest.reviewSensitivity} review sensitivity`)
    }
    for (const risk of manifest.riskProfile) {
      if (/security|permission|billing|payment|data|privacy|compliance/i.test(risk)) {
        level = maxSeverity(level, 'high')
        notes.push(`Domain '${domain}' risk profile includes '${risk}'`)
      }
    }
  }

  // Repo-wide risk-sensitive areas are surfaced as context but do NOT by
  // themselves raise task risk — the repo merely *having* sensitive areas
  // shouldn't make every task critical. They become actionable once the task
  // text or selected domains indicate overlap (handled above).
  const sensitiveNames = (repoMap?.riskSensitiveAreas ?? [])
    .filter((a) => a.severity === 'high' || a.severity === 'critical')
    .map((a) => a.name)
  if (sensitiveNames.length > 0 && SEVERITY_RANK[level] >= SEVERITY_RANK.high) {
    notes.push(`Repo has sensitive areas to watch: ${sensitiveNames.join(', ')}`)
  }

  const high = SEVERITY_RANK[level] >= SEVERITY_RANK.high
  const critical = level === 'critical'

  return {
    level,
    requiresMoreEvidence: high,
    requiresMoreVerification: high,
    requiresConservativeEdits: high,
    requiresMoreCheckpoints: high,
    requiresExplicitHumanApproval: critical,
    requiresClearerWarnings: high,
    requiresStrongerReviewGuidance: high,
    notes: notes.length > 0 ? [...new Set(notes)] : ['No elevated risk indicators detected.'],
  }
}
