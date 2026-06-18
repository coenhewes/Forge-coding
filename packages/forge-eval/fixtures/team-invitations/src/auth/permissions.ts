import { db, type Role } from '../db/schema.js'

/** Get a user's role within an organization, or undefined if not a member. */
export function getRole(userId: string, orgId: string): Role | undefined {
  return db.memberships.find((m) => m.userId === userId && m.orgId === orgId)?.role
}

/** Roles permitted to manage members (invite/remove). */
const MANAGER_ROLES: Role[] = ['owner', 'admin']

/** Whether a user may manage members of an organization. */
export function canManageMembers(userId: string, orgId: string): boolean {
  const role = getRole(userId, orgId)
  return role !== undefined && MANAGER_ROLES.includes(role)
}

/** Throw if the user lacks the required role in the organization. */
export function requireRole(userId: string, orgId: string, allowed: Role[]): void {
  const role = getRole(userId, orgId)
  if (!role || !allowed.includes(role)) {
    throw new Error('Forbidden: insufficient role')
  }
}

/** Default invitation lifetime: 7 days in milliseconds. */
export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
