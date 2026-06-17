/**
 * Shared types for the PR generator. Lives in its own module so the markdown
 * template (`templates/pr-body.ts`) and the section builder (`pr-generator.ts`)
 * can both depend on it without creating a circular import.
 */
import type { PatchCandidate } from '@forge/types'
import type { TaskRiskAssessment } from '@forge/types'

export interface ArtifactRef {
  id: string
  kind:
    | 'test_output'
    | 'command_output'
    | 'screenshot'
    | 'log'
    | 'diff'
    | 'reviewer_comment'
    | 'human_decision'
    | 'state_dump'
    | 'other'
  path: string
  title?: string
  summary?: string
}

export interface PRGeneratorSection {
  id: string
  title: string
  markdown: string
}

export interface PRGeneratorOutput {
  title: string
  summary: string
  sections: PRGeneratorSection[]
  body: string
  promotedPatch?: PatchCandidate
  meta: PRGeneratorMeta
}

export interface PRGeneratorMeta {
  acceptedCount: number
  totalCriteria: number
  topHypothesisConfidence: number
  riskLevel: TaskRiskAssessment['level']
  riskFlags: {
    requiresMoreEvidence: boolean
    requiresMoreVerification: boolean
    requiresConservativeEdits: boolean
    requiresMoreCheckpoints: boolean
    requiresExplicitHumanApproval: boolean
    requiresClearerWarnings: boolean
    requiresStrongerReviewGuidance: boolean
  }
  hasHumanReviewItems: boolean
  hasStaleClaims: boolean
  hasContradictedClaims: boolean
  hasNeedsHumanReviewClaims: boolean
  artifactCount: number
}
