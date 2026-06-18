/**
 * Shared types for the PR generator. Lives in its own module so the markdown
 * template (`templates/pr-body.ts`) and the section builder (`pr-generator.ts`)
 * can both depend on it without creating a circular import.
 *
 * `ArtifactRef` was promoted to `@forge/types` so the belief graph, evidence
 * ledger, verification planner, MCP server, and eval harness can carry the
 * same shape. We re-export it from here for back-compat with any code that
 * still imports `ArtifactRef` from `@forge/pr`.
 */
import type { ArtifactRef as TypesArtifactRef, PatchCandidate, TaskRiskAssessment } from '@forge/types'

/** @deprecated Import `ArtifactRef` from `@forge/types` instead. */
export type ArtifactRef = TypesArtifactRef

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
