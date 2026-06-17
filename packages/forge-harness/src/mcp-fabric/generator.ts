import type { DomainManifest, ToolDefinition } from '@forge/types'
import { CapabilityRegistry, type CapabilityImplementation } from './capabilities.js'

/**
 * Generates capability implementations from domain manifests.
 * Each manifest's risk profile and verification entries become capabilities.
 */
export function generateCapabilitiesFromManifests(
  manifests: DomainManifest[],
): CapabilityImplementation[] {
  const impls: CapabilityImplementation[] = []
  const seen = new Set<string>()

  for (const manifest of manifests) {
    // read_files capability
    const readName = `${manifest.domain}.read_files`
    if (!seen.has(readName)) {
      seen.add(readName)
      impls.push({
        definition: {
          name: readName,
          description: `Read files in the ${manifest.domain} domain. Only paths in allowedReads are accessible.`,
          inputSchema: {
            type: 'object',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'File paths to read (relative to repo root)' },
            },
            required: ['paths'],
          },
          domain: manifest.domain,
        },
        handler: async (input) => {
          const paths = input.paths as string[] | undefined
          if (!paths || paths.length === 0) return { success: false, error: 'No paths provided' }
          return { success: true, data: { allowed: true, paths, restrictedToPatterns: manifest.allowedReads } }
        },
      })
    }

    // search_code capability
    const searchName = `${manifest.domain}.search_code`
    if (!seen.has(searchName)) {
      seen.add(searchName)
      impls.push({
        definition: {
          name: searchName,
          description: `Search code within the ${manifest.domain} domain.`,
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Search pattern (regex)' },
              scope: { type: 'string', enum: ['domain', 'all'], description: 'Search scope' },
            },
            required: ['pattern'],
          },
          domain: manifest.domain,
        },
        handler: async (input) => {
          const pattern = input.pattern as string | undefined
          if (!pattern) return { success: false, error: 'No pattern provided' }
          return { success: true, data: { pattern, scope: input.scope ?? 'domain' } }
        },
      })
    }

    // assess_risk capability
    if (manifest.riskProfile.length > 0) {
      const riskName = `${manifest.domain}.assess_risk`
      if (!seen.has(riskName)) {
        seen.add(riskName)
        impls.push({
          definition: {
            name: riskName,
            description: `Assess risk for changes in the ${manifest.domain} domain. Risk areas: ${manifest.riskProfile.join(', ')}`,
            inputSchema: {
              type: 'object',
              properties: {
                changes: { type: 'array', items: { type: 'string' }, description: 'Description of proposed changes' },
              },
              required: ['changes'],
            },
            domain: manifest.domain,
          },
          handler: async (input) => {
            return {
              success: true,
              data: {
                domain: manifest.domain,
                riskProfile: manifest.riskProfile,
                sensitivity: manifest.reviewSensitivity,
                assessment: 'Provide specific changes for detailed risk assessment',
              },
            }
          },
        })
      }
    }

    // run_tests capability
    if (manifest.verification.length > 0) {
      const testName = `${manifest.domain}.run_tests`
      if (!seen.has(testName)) {
        seen.add(testName)
        impls.push({
          definition: {
            name: testName,
            description: `Run verification tests for the ${manifest.domain} domain. Available suites: ${manifest.verification.join(', ')}`,
            inputSchema: {
              type: 'object',
              properties: {
                suite: { type: 'string', enum: manifest.verification, description: 'Test suite to run' },
              },
              required: ['suite'],
            },
            domain: manifest.domain,
          },
          handler: async (input) => {
            return {
              success: true,
              data: {
                domain: manifest.domain,
                suite: input.suite,
                status: 'pending',
                message: `Test suite '${input.suite}' queued for ${manifest.domain}`,
              },
            }
          },
        })
      }
    }

    // find_related_domains capability
    if (manifest.relatedDomains.length > 0) {
      const relName = `${manifest.domain}.find_related_domains`
      if (!seen.has(relName)) {
        seen.add(relName)
        impls.push({
          definition: {
            name: relName,
            description: `Find domains related to ${manifest.domain}. Related: ${manifest.relatedDomains.join(', ')}`,
            inputSchema: {
              type: 'object',
              properties: {},
            },
            domain: manifest.domain,
          },
          handler: async () => {
            return {
              success: true,
              data: {
                domain: manifest.domain,
                relatedDomains: manifest.relatedDomains,
              },
            }
          },
        })
      }
    }
  }

  return impls
}

/**
 * Converts a set of domain manifests and capability names
 * into tool definitions suitable for the LLM provider.
 */
export function generateToolDefinitions(
  selectedDomains: string[],
  selectedCapabilities: string[],
  registry: CapabilityRegistry,
): ToolDefinition[] {
  const domainTools = registry.toToolDefinitionsForDomains(selectedDomains)

  // Filter to only selected capabilities (if provided)
  if (selectedCapabilities.length > 0) {
    return domainTools.filter((tool) =>
      selectedCapabilities.some((cap) =>
        tool.name === cap || tool.name.startsWith(cap),
      ),
    )
  }

  return domainTools
}
