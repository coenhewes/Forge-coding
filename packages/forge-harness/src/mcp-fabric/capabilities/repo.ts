import type { CapabilityImplementation } from '../capabilities.js'

export const repoCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'repo.find_callers',
      description: 'Find all callers of a given function or symbol in the repository.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the function or symbol' },
          file: { type: 'string', description: 'Optional file to scope the search' },
        },
        required: ['symbol'],
      },
      domain: 'shared',
    },
    handler: async (input, context) => {
      const symbol = input.symbol as string
      if (!symbol) return { success: false, error: 'No symbol provided' }
      return { success: true, data: { symbol, callers: [], note: 'Call graph query — requires repo graph' } }
    },
  },
  {
    definition: {
      name: 'repo.find_definitions',
      description: 'Find all definitions of a symbol across the repository.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to find definitions for' },
        },
        required: ['symbol'],
      },
      domain: 'shared',
    },
    handler: async (input, context) => {
      const symbol = input.symbol as string
      if (!symbol) return { success: false, error: 'No symbol provided' }
      return { success: true, data: { symbol, definitions: [], note: 'Definition query — requires repo graph' } }
    },
  },
  {
    definition: {
      name: 'repo.find_cross_domain_edges',
      description: 'Find all cross-domain edges — files that cross domain boundaries.',
      inputSchema: {
        type: 'object',
        properties: {
          domains: { type: 'array', items: { type: 'string' }, description: 'Optional domains to filter by' },
        },
      },
      domain: 'shared',
    },
    handler: async (_input) => {
      return { success: true, data: { edges: [], note: 'Cross-domain edge query — requires repo graph' } }
    },
  },
  {
    definition: {
      name: 'repo.explain_dependency_path',
      description: 'Explain the dependency path between two packages or files.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source package or file' },
          to: { type: 'string', description: 'Target package or file' },
        },
        required: ['from', 'to'],
      },
      domain: 'shared',
    },
    handler: async (input) => {
      const from = input.from as string
      const to = input.to as string
      return { success: true, data: { from, to, path: [], note: 'Dependency path query' } }
    },
  },
  {
    definition: {
      name: 'repo.find_ownership_boundary',
      description: 'Find the ownership boundary for a given file or directory path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path' },
        },
        required: ['path'],
      },
      domain: 'shared',
    },
    handler: async (input) => {
      const filePath = input.path as string
      return { success: true, data: { path: filePath, ownership: [], note: 'Ownership boundary query' } }
    },
  },
]
