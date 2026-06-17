import type { DomainManifest, DomainSelection, RepoGraph, RepoMap } from '@forge/types'
import { matchDomainsByTask, getDomainManifests } from './manifests.js'

export interface RouterOptions {
  /**
   * Additional domain hints beyond what keyword matching finds.
   */
  hintDomains?: string[]
  /**
   * Domains to explicitly exclude from selection.
   */
  excludeDomains?: string[]
}

export function routeTask(
  task: string,
  repoMap?: RepoMap,
  repoGraph?: RepoGraph,
  options?: RouterOptions,
): DomainSelection {
  const manifests = getDomainManifests(repoMap)

  // Phase 1: Keyword match domains from task
  const matchedDomains = matchDomainsByTask(task, manifests)
  const hintSet = new Set(options?.hintDomains ?? [])
  const excludeSet = new Set(options?.excludeDomains ?? [])

  // All domains present in repo
  const allRepoDomains = manifests.map((m) => m.domain)

  // Selected: matched + hinted - excluded
  const selected = new Set([...matchedDomains, ...hintSet])
  for (const ex of excludeSet) selected.delete(ex)

  // Withheld: everything in repo not selected
  const withheld = allRepoDomains.filter((d) => !selected.has(d) && !excludeSet.has(d))

  // Adjacent: related to selected domains but not themselves selected
  const adjacent = new Set<string>()
  for (const sel of selected) {
    const manifest = manifests.find((m) => m.domain === sel)
    if (manifest) {
      for (const rel of manifest.relatedDomains) {
        if (!selected.has(rel)) adjacent.add(rel)
      }
    }
  }

  // Selected graph regions: map selected domains to graph regions
  const selectedGraphRegions: string[] = []
  if (repoGraph) {
    for (const sel of selected) {
      const region = repoGraph.regions.find((r) => r.domain === sel)
      if (region) selectedGraphRegions.push(region.id)
    }
  }

  // Selected capabilities: derive from domain manifests
  const selectedCapabilities = deriveCapabilities(selected, manifests)

  return {
    selectedDomains: Array.from(selected),
    possibleAdjacentDomains: Array.from(adjacent).filter((d) => !selected.has(d)),
    withheldDomains: withheld,
    selectedGraphRegions,
    selectedCapabilities,
  }
}

function deriveCapabilities(
  selectedDomains: Set<string>,
  manifests: DomainManifest[],
): string[] {
  const capabilities: string[] = []

  for (const domain of selectedDomains) {
    const manifest = manifests.find((m) => m.domain === domain)
    if (!manifest) continue

    const capPrefix = domain

    capabilities.push(`${capPrefix}.read_files`)
    capabilities.push(`${capPrefix}.search_code`)

    if (manifest.riskProfile.length > 0) {
      capabilities.push(`${capPrefix}.assess_risk`)
    }
    if (manifest.verification.length > 0) {
      capabilities.push(`${capPrefix}.run_tests`)
    }
    if (manifest.relatedDomains.length > 0) {
      capabilities.push(`${capPrefix}.find_related_domains`)
    }
  }

  return capabilities
}
