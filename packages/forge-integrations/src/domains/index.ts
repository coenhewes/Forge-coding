/**
 * @forge/integrations/domains — frozen manifest collection
 *
 * Exports the single `DOMAINS` handle the rest of Forge consumes.
 * The handle is built once at module load, then frozen so callers
 * cannot mutate it. Adding a new domain = dropping a new file in
 * this directory and importing it below.
 */
import type { CapabilityDescriptor, DomainEntry, DomainManifests } from './schema.js'

import { authDomain } from './auth.js'
import { backendDomain } from './backend.js'
import { billingDomain } from './billing.js'
import { databaseDomain } from './database.js'
import { emailDomain } from './email.js'
import { frontendDomain } from './frontend.js'
import { infraDomain } from './infra.js'
import { prDomain } from './pr.js'
import { repoDomain } from './repo.js'
import { securityDomain } from './security.js'
import { testsDomain } from './tests.js'

const ALL_DOMAINS: readonly DomainEntry[] = Object.freeze([
  authDomain,
  backendDomain,
  databaseDomain,
  frontendDomain,
  testsDomain,
  infraDomain,
  billingDomain,
  securityDomain,
  repoDomain,
  prDomain,
  emailDomain,
])

function buildHandle(entries: readonly DomainEntry[]): DomainManifests {
  const byName: Record<string, DomainEntry> = {}
  const capabilities: string[] = []
  for (const entry of entries) {
    byName[entry.manifest.domain] = entry
    for (const cap of entry.capabilities) {
      capabilities.push(cap.name)
    }
  }
  const capabilityIndex: Record<string, CapabilityDescriptor> = {}
  for (const entry of entries) {
    for (const cap of entry.capabilities) {
      capabilityIndex[cap.name] = cap
    }
  }
  return Object.freeze({
    byName: Object.freeze(byName),
    all: entries,
    capabilityNames: Object.freeze(capabilities),
    findCapability: (name: string) => capabilityIndex[name],
    capabilitiesFor: (domain: string) => byName[domain]?.capabilities ?? [],
  })
}

/** The single, frozen handle that downstream code consumes. */
export const DOMAINS: DomainManifests = buildHandle(ALL_DOMAINS)

/** Convenience: every domain name in registration order. */
export const DOMAIN_NAMES: readonly string[] = Object.freeze(DOMAINS.all.map((d) => d.manifest.domain))

export type { CapabilityDescriptor, DomainEntry, DomainManifests } from './schema.js'
export type {
  CapabilityCategory,
  CapabilityCost,
  CapabilityGain,
  CapabilityPermission,
  CapabilityRiskLevel,
} from './schema.js'
export type { DomainManifest, DomainAccess, DomainSelection, DomainExpansionRecord } from '@forge/types'
