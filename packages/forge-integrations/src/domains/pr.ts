import type { DomainManifest } from '@forge/types'
import type { CapabilityDescriptor, DomainEntry } from './schema.js'

const manifest: DomainManifest = {
  domain: 'pr',
  owns: [
    'packages/forge-pr/**',
  ],
  allowedReads: [
    'apps/**',
    'packages/**',
    '.github/**',
  ],
  allowedWrites: [
    'packages/forge-pr/**',
  ],
  relatedDomains: ['backend', 'tests', 'verification'],
  forbiddenByDefault: [
    'apps/api/src/**',
    'apps/web/src/**',
    'secrets/**',
  ],
  riskProfile: [
    'PR reviewability',
    'review comment resolution',
  ],
  verification: [
    'assurance-case generation tests',
    'review guide tests',
  ],
  graphNodeIds: ['domain:pr'],
  graphEdgeIds: [],
  reviewSensitivity: 'medium',
}

const capabilities: CapabilityDescriptor[] = [
  {
    name: 'pr.prepare_review_guide',
    domain: 'pr',
    category: 'pr',
    risk: 'low',
    cost: 'low',
    gain: 'high',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Compose a reviewer guide: what to inspect first, risky areas, verification plan, claim-evidence summary.',
    inputHints: ['diff', 'risk'],
    tags: ['pr', 'review', 'guide'],
    suggestedFollowUps: ['pr.summarize_diff_by_domain', 'pr.list_risky_changes'],
  },
  {
    name: 'pr.summarize_diff_by_domain',
    domain: 'pr',
    category: 'pr',
    risk: 'low',
    cost: 'low',
    gain: 'medium',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Group a diff by domain, count files changed per domain, and surface review-sensitivity hotspots.',
    inputHints: ['diff'],
    tags: ['pr', 'diff', 'domain'],
    suggestedFollowUps: ['pr.list_risky_changes', 'pr.prepare_review_guide'],
  },
  {
    name: 'pr.list_risky_changes',
    domain: 'pr',
    category: 'pr',
    risk: 'low',
    cost: 'low',
    gain: 'high',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Identify the riskiest lines in a diff (auth, billing, migrations, secrets) and the review sensitivity.',
    inputHints: ['diff'],
    tags: ['pr', 'risk', 'diff'],
    suggestedFollowUps: ['pr.prepare_review_guide', 'security.find_sensitive_paths'],
  },
]

export const prDomain: DomainEntry = Object.freeze({ manifest, capabilities })
