import type { DomainManifest } from '@forge/types'
import type { CapabilityDescriptor, DomainEntry } from './schema.js'

/**
 * The `repo` domain holds repo-graph capabilities that are not owned
 * by any single engineering domain. They are first-class citizens of
 * the capability fabric (AGENTS.md §4 strong capability surface), so
 * they get a manifest + descriptors.
 */
const manifest: DomainManifest = {
  domain: 'repo',
  owns: [
    'packages/repo-graph/**',
    'packages/forge-repo/**',
  ],
  allowedReads: [
    'apps/**',
    'packages/**',
    'tests/**',
  ],
  allowedWrites: [
    'packages/repo-graph/**',
    'packages/forge-repo/**',
  ],
  relatedDomains: ['backend', 'auth', 'database', 'frontend', 'tests', 'infra', 'billing', 'security'],
  forbiddenByDefault: [
    'billing/**',
    'secrets/**',
  ],
  riskProfile: [
    'repo graph accuracy',
    'stale graph nodes',
    'build-time cost',
  ],
  verification: [
    'repo-graph unit tests',
    'fixture snapshot tests',
  ],
  graphNodeIds: [
    'domain:repo',
  ],
  graphEdgeIds: [],
  reviewSensitivity: 'low',
}

const capabilities: CapabilityDescriptor[] = [
  {
    name: 'repo.find_definitions',
    domain: 'repo',
    category: 'repo_graph',
    risk: 'low',
    cost: 'low',
    gain: 'medium',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Find symbol definitions matching a query. Returns file:line + kind.',
    inputHints: ['symbol', 'kind'],
    tags: ['definitions', 'symbol', 'repo'],
    suggestedFollowUps: ['repo.find_callers', 'repo.find_cross_domain_edges'],
  },
  {
    name: 'repo.find_callers',
    domain: 'repo',
    category: 'repo_graph',
    risk: 'low',
    cost: 'low',
    gain: 'high',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Find every caller of a given symbol. Distinguishes direct vs transitive calls.',
    inputHints: ['symbol'],
    tags: ['callers', 'symbol', 'impact', 'repo'],
    suggestedFollowUps: ['repo.find_definitions', 'tests.find_related_tests'],
  },
  {
    name: 'repo.find_cross_domain_edges',
    domain: 'repo',
    category: 'repo_graph',
    risk: 'low',
    cost: 'low',
    gain: 'high',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'List cross-domain edges (auth → backend, backend → database, etc.) reachable from a given symbol.',
    inputHints: ['symbol', 'edgeType'],
    tags: ['cross-domain', 'edge', 'graph'],
    suggestedFollowUps: ['repo.find_ownership_boundary', 'repo.explain_dependency_path'],
  },
  {
    name: 'repo.explain_dependency_path',
    domain: 'repo',
    category: 'repo_graph',
    risk: 'low',
    cost: 'low',
    gain: 'medium',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Explain the import / call path between two symbols, including intermediate domains.',
    inputHints: ['from', 'to'],
    tags: ['dependency', 'path', 'graph'],
    suggestedFollowUps: ['repo.find_cross_domain_edges', 'repo.find_ownership_boundary'],
  },
  {
    name: 'repo.find_ownership_boundary',
    domain: 'repo',
    category: 'repo_graph',
    risk: 'low',
    cost: 'low',
    gain: 'medium',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Identify the domain that owns a given path or symbol, and what it may import from.',
    inputHints: ['path', 'symbol'],
    tags: ['ownership', 'domain', 'boundary'],
    suggestedFollowUps: ['repo.find_cross_domain_edges', 'auth.find_auth_callers'],
  },
]

export const repoDomain: DomainEntry = Object.freeze({ manifest, capabilities })
