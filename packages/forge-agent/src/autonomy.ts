import type { AutonomyMode } from '@forge/types'

/**
 * Resolved operating posture for a run. Autonomy modes trade off cost, thorough-
 * ness, and human oversight — the AGENTS.md cost/autonomy modes. The agent uses
 * these to size its iteration budget, sampling temperature, verification depth,
 * and whether high-risk work pauses for human approval.
 */
export interface AutonomyProfile {
  maxIterations: number
  temperature: number
  /** How hard to push verification before declaring completion. */
  verificationDepth: 'minimal' | 'standard' | 'high'
  /** Pause for explicit human approval on high/critical-risk tasks. */
  requireApprovalOnHighRisk: boolean
  /** Disallow file writes (review/explore postures). */
  readOnly: boolean
}

const PROFILES: Record<AutonomyMode, AutonomyProfile> = {
  cheap: { maxIterations: 15, temperature: 0.1, verificationDepth: 'minimal', requireApprovalOnHighRisk: false, readOnly: false },
  fast: { maxIterations: 25, temperature: 0.2, verificationDepth: 'minimal', requireApprovalOnHighRisk: false, readOnly: false },
  balanced: { maxIterations: 40, temperature: 0.2, verificationDepth: 'standard', requireApprovalOnHighRisk: false, readOnly: false },
  thorough: { maxIterations: 80, temperature: 0.2, verificationDepth: 'high', requireApprovalOnHighRisk: false, readOnly: false },
  conservative: { maxIterations: 60, temperature: 0.1, verificationDepth: 'high', requireApprovalOnHighRisk: true, readOnly: false },
  autonomous: { maxIterations: 100, temperature: 0.2, verificationDepth: 'standard', requireApprovalOnHighRisk: false, readOnly: false },
  'review-only': { maxIterations: 30, temperature: 0.2, verificationDepth: 'standard', requireApprovalOnHighRisk: false, readOnly: true },
}

/** Resolve an autonomy mode into a concrete operating profile. */
export function resolveAutonomy(mode: AutonomyMode | undefined): AutonomyProfile {
  return PROFILES[mode ?? 'balanced'] ?? PROFILES.balanced
}
