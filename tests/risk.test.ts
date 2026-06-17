import { describe, it, expect } from 'vitest'
import { assessTaskRisk, getDomainManifests } from '@forge/harness'

const manifests = getDomainManifests()

describe('assessTaskRisk', () => {
  it('rates a billing/payment task as critical', () => {
    const r = assessTaskRisk({ task: 'Replace the Stripe billing provider for subscription charges', selectedDomains: [], manifests })
    expect(r.level).toBe('critical')
    expect(r.requiresExplicitHumanApproval).toBe(true)
  })

  it('rates an auth/permission task as at least high', () => {
    const r = assessTaskRisk({ task: 'Fix the permission check so org admins can invite users', selectedDomains: [], manifests })
    expect(['high', 'critical']).toContain(r.level)
    expect(r.requiresMoreVerification).toBe(true)
  })

  it('rates a trivial copy change as low', () => {
    const r = assessTaskRisk({ task: 'Update the footer copyright year', selectedDomains: [], manifests })
    expect(r.level).toBe('low')
    expect(r.requiresExplicitHumanApproval).toBe(false)
  })
})
