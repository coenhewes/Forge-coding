import type { DomainExpansionRecord, DomainManifest, RepoGraph } from '@forge/types'
import { getDomainManifests } from './manifests.js'

export interface CrossDomainChange {
  initiator: string
  affectedFiles: string[]
}

/**
 * Detect whether a set of file changes cross domain boundaries.
 * Returns expansion records if cross-domain changes are detected.
 */
export function detectCrossDomainChanges(
  changes: CrossDomainChange[],
  graph?: RepoGraph,
): DomainExpansionRecord[] {
  const records: DomainExpansionRecord[] = []
  const manifests = getDomainManifests()

  for (const change of changes) {
    const initiatorManifest = manifests.find((m) => m.domain === change.initiator)
    if (!initiatorManifest) continue

    for (const file of change.affectedFiles) {
      for (const manifest of manifests) {
        if (manifest.domain === change.initiator) continue

        // Check if file is owned by another domain
        const isOwned = manifest.owns.some((pattern) => matchesPattern(pattern, file))
        if (isOwned) {
          // Check if this domain is already in the expansion
          const existing = records.find(
            (r) => r.initiator === change.initiator && r.affectedDomains.includes(manifest.domain),
          )
          if (existing) {
            // Check if this check is already added
            for (const check of manifest.verification) {
              if (!existing.requiredChecks.includes(check)) {
                existing.requiredChecks.push(check)
              }
            }
          } else {
            records.push({
              initiator: change.initiator,
              affectedDomains: [manifest.domain],
              reason: `${change.initiator} change in ${file} affects ${manifest.domain} domain`,
              requiredChecks: [...manifest.verification],
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }
  }

  return records
}

/**
 * Request domain expansion. Validates that the expansion is needed
 * and returns a full expansion record.
 */
export function requestDomainExpansion(
  initiator: string,
  requestedDomains: string[],
  reason: string,
): DomainExpansionRecord {
  const manifests = getDomainManifests()
  const affectedDomains: string[] = []
  const requiredChecks: string[] = []

  for (const domain of requestedDomains) {
    const manifest = manifests.find((m) => m.domain === domain)
    if (manifest) {
      affectedDomains.push(domain)
      requiredChecks.push(...manifest.verification)
    }
  }

  return {
    initiator,
    affectedDomains,
    reason,
    requiredChecks: [...new Set(requiredChecks)],
    timestamp: new Date().toISOString(),
  }
}

function matchesPattern(pattern: string, filePath: string): boolean {
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${regexStr}$`).test(filePath)
}
