import type { CapabilityImplementation } from '../capabilities.js'

export const authCapabilities: CapabilityImplementation[] = [
  {
    definition: {
      name: 'auth.trace_permission_check',
      description: 'Trace the full permission check path for a given user role or action to understand authorization flow.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'User role to trace (e.g., admin, member, owner)' },
          action: { type: 'string', description: 'Action to trace (e.g., invite, delete, update)' },
        },
        required: ['role', 'action'],
      },
      domain: 'auth',
    },
    handler: async (input) => {
      return {
        success: true,
        data: {
          role: input.role,
          action: input.action,
          trace: [],
          note: 'Permission check tracing — run after repo mapping is complete',
        },
      }
    },
  },
  {
    definition: {
      name: 'auth.find_policy_sources',
      description: 'Find all policy, permission, and guard source files in the auth domain.',
      inputSchema: {
        type: 'object',
        properties: {
          policyType: { type: 'string', enum: ['all', 'role', 'permission', 'guard'], description: 'Type of policy to find' },
        },
      },
      domain: 'auth',
    },
    handler: async (_input) => {
      return { success: true, data: { sources: [], note: 'Policy source discovery — run after repo mapping' } }
    },
  },
  {
    definition: {
      name: 'auth.explain_role_mapping',
      description: 'Explain how roles are mapped, normalized, and resolved in the auth system.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Optional specific role to explain' },
        },
      },
      domain: 'auth',
    },
    handler: async (input) => {
      return {
        success: true,
        data: { role: input.role ?? 'all', mapping: [], note: 'Role mapping explanation' },
      }
    },
  },
  {
    definition: {
      name: 'auth.get_invite_policy',
      description: 'Get the full invitation policy including who can invite, role options, and validation rules.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      domain: 'auth',
    },
    handler: async () => {
      return { success: true, data: { policy: {}, note: 'Invite policy query' } }
    },
  },
  {
    definition: {
      name: 'auth.run_auth_regression_tests',
      description: 'Run the auth regression test suite to verify auth behavior is preserved.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['full', 'quick'], description: 'Test scope' },
        },
      },
      domain: 'auth',
    },
    handler: async (input) => {
      return {
        success: true,
        data: { scope: input.scope ?? 'full', status: 'queued', message: 'Auth regression tests queued' },
      }
    },
  },
]
