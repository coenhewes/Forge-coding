import type { DomainManifest } from '@forge/types'
import type { CapabilityDescriptor, DomainEntry } from './schema.js'

const manifest: DomainManifest = {
  domain: 'email',
  owns: [
    'apps/api/src/email/**',
    'apps/api/src/services/email/**',
    'apps/api/src/services/notifications/**',
    'apps/api/src/templates/**',
  ],
  allowedReads: [
    'apps/api/src/email/**',
    'apps/api/src/services/email/**',
    'apps/api/src/templates/**',
    'tests/email/**',
  ],
  allowedWrites: [
    'apps/api/src/email/**',
    'apps/api/src/services/email/**',
    'apps/api/src/templates/**',
    'tests/email/**',
  ],
  relatedDomains: ['backend', 'auth', 'security'],
  forbiddenByDefault: [
    'apps/web/**',
    'billing/**',
    'secrets/**',
  ],
  riskProfile: [
    'email deliverability',
    'PII handling',
    'template injection',
    'link integrity',
  ],
  verification: [
    'email template tests',
    'invite email tests',
    'deliverability smoke tests',
  ],
  graphNodeIds: [
    'domain:email',
    'service:EmailService',
    'template:invite',
  ],
  graphEdgeIds: [
    'edge:InviteService→EmailService',
  ],
  reviewSensitivity: 'high',
}

const capabilities: CapabilityDescriptor[] = [
  {
    name: 'email.find_invite_template',
    domain: 'email',
    category: 'general',
    risk: 'low',
    cost: 'low',
    gain: 'medium',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Locate the invite email template and the variables it expects.',
    inputHints: ['template'],
    tags: ['email', 'template', 'invite'],
    suggestedFollowUps: ['security.find_sensitive_paths', 'tests.find_related_tests'],
  },
  {
    name: 'email.check_link_integrity',
    domain: 'email',
    category: 'security',
    risk: 'low',
    cost: 'low',
    gain: 'high',
    requiredPermissions: ['read_repo_graph', 'read_source'],
    description: 'Verify that invite / verification links are single-use, signed, and time-bounded.',
    inputHints: ['link'],
    tags: ['email', 'link', 'security', 'token'],
    suggestedFollowUps: ['security.check_audit_logs', 'auth.explain_role_mapping'],
  },
  {
    name: 'email.run_email_regression_tests',
    domain: 'email',
    category: 'verification',
    risk: 'medium',
    cost: 'medium',
    gain: 'high',
    requiredPermissions: ['run_test', 'run_command'],
    description: 'Run the email regression suite (template rendering, link integrity, deliverability).',
    inputHints: ['scope'],
    tags: ['test', 'email', 'regression'],
    suggestedFollowUps: ['tests.select_affected_tests'],
  },
]

export const emailDomain: DomainEntry = Object.freeze({ manifest, capabilities })
