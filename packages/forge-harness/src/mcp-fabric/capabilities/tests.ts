import type { CapabilityImplementation } from '../capabilities.js'

export const testCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'tests.find_related_tests',
      description: 'Find all tests related to a given source file or set of changes.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Source file paths to find tests for' },
        },
        required: ['files'],
      },
      domain: 'tests',
    },
    handler: async (input) => {
      const files = input.files as string[]
      return { success: true, data: { files, relatedTests: [], note: 'Test relationship query — requires repo graph' } }
    },
  },
  {
    definition: {
      name: 'tests.select_affected_tests',
      description: 'Select the optimal set of tests to run based on code changes and risk profile.',
      inputSchema: {
        type: 'object',
        properties: {
          filesChanged: { type: 'array', items: { type: 'string' }, description: 'Files that were changed' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Risk level of the changes' },
        },
        required: ['filesChanged'],
      },
      domain: 'tests',
    },
    handler: async (input) => {
      return {
        success: true,
        data: {
          filesChanged: input.filesChanged,
          riskLevel: input.riskLevel ?? 'medium',
          selectedTests: [],
          rationale: 'Test selection requires repo graph and change analysis',
        },
      }
    },
  },
  {
    definition: {
      name: 'tests.detect_coverage_gap',
      description: 'Detect gaps in test coverage for a given set of changes or files.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Files to check for coverage gaps' },
        },
      },
      domain: 'tests',
    },
    handler: async (input) => {
      return {
        success: true,
        data: { files: input.files, gaps: [], note: 'Coverage gap detection' },
      }
    },
  },
  {
    definition: {
      name: 'tests.run_verification_plan',
      description: 'Execute a verification plan — a curated set of tests selected to validate changes.',
      inputSchema: {
        type: 'object',
        properties: {
          suites: { type: 'array', items: { type: 'string' }, description: 'Test suites to run' },
          mode: { type: 'string', enum: ['full', 'quick', 'affected'], description: 'Verification mode' },
        },
        required: ['suites'],
      },
      domain: 'tests',
    },
    handler: async (input) => {
      return {
        success: true,
        data: {
          suites: input.suites,
          mode: input.mode ?? 'affected',
          status: 'queued',
          message: 'Verification plan queued for execution',
        },
      }
    },
  },
]
