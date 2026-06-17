import type { RiskArea } from './repo-map.js'

export interface DomainManifest {
  domain: string
  owns: string[]
  allowedReads: string[]
  allowedWrites: string[]
  relatedDomains: string[]
  forbiddenByDefault: string[]
  riskProfile: string[]
  verification: string[]
  graphNodeIds?: string[]
  graphEdgeIds?: string[]
  reviewSensitivity: 'none' | 'low' | 'medium' | 'high' | 'critical'
}

export interface DomainAccess {
  domain: string
  reads: string[]
  writes: string[]
  commands: string[]
}

export interface DomainSelection {
  selectedDomains: string[]
  possibleAdjacentDomains: string[]
  withheldDomains: string[]
  selectedGraphRegions: string[]
  selectedCapabilities: string[]
}

export interface DomainExpansionRecord {
  initiator: string
  affectedDomains: string[]
  reason: string
  requiredChecks: string[]
  timestamp: string
}
