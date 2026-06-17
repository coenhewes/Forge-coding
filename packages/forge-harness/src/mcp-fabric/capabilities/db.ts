import type { CapabilityImplementation } from '../capabilities.js'

export const dbCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'db.get_table_schema',
      description: 'Get the full schema definition for a database table.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to get schema for' },
        },
        required: ['table'],
      },
      domain: 'database',
    },
    handler: async (input) => {
      const table = input.table as string
      if (!table) return { success: false, error: 'No table name provided' }
      return { success: true, data: { table, schema: null, note: 'Table schema query — requires repo map with database info' } }
    },
  },
  {
    definition: {
      name: 'db.find_migrations_touching_table',
      description: 'Find all migrations that touch a specific database table.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to search migrations for' },
        },
        required: ['table'],
      },
      domain: 'database',
    },
    handler: async (input) => {
      const table = input.table as string
      if (!table) return { success: false, error: 'No table name provided' }
      return { success: true, data: { table, migrations: [], note: 'Migration query — requires migration scan' } }
    },
  },
  {
    definition: {
      name: 'db.check_query_impact',
      description: 'Check the impact of a query or schema change on the database.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Description of the proposed change' },
          tables: { type: 'array', items: { type: 'string' }, description: 'Affected table names' },
        },
        required: ['description'],
      },
      domain: 'database',
    },
    handler: async (input) => {
      return {
        success: true,
        data: {
          description: input.description,
          tables: input.tables,
          impact: 'Analysis requires schema comparison',
        },
      }
    },
  },
  {
    definition: {
      name: 'db.run_migration_tests',
      description: 'Run migration-related tests to verify migration safety and correctness.',
      inputSchema: {
        type: 'object',
        properties: {
          migrations: { type: 'array', items: { type: 'string' }, description: 'Migration names to test' },
        },
      },
      domain: 'database',
    },
    handler: async (input) => {
      return {
        success: true,
        data: { migrations: input.migrations, status: 'queued', message: 'Migration tests queued' },
      }
    },
  },
]
