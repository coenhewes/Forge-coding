import { canManageMembers, getRole } from '../auth/permissions.js'
import { db, type Role } from '../db/schema.js'

export interface ApiResponse {
  status: number
  body: unknown
}

/** GET /orgs/:orgId/members — list members of an organization. */
export function listMembers(actingUserId: string, orgId: string): ApiResponse {
  if (!getRole(actingUserId, orgId)) {
    return { status: 403, body: { error: 'Forbidden' } }
  }
  const members = db.memberships.filter((m) => m.orgId === orgId)
  return { status: 200, body: members }
}

/** POST /orgs/:orgId/members — add an existing user to an org with a role. */
export function addMember(
  actingUserId: string,
  orgId: string,
  targetUserId: string,
  role: Role,
): ApiResponse {
  if (!canManageMembers(actingUserId, orgId)) {
    return { status: 403, body: { error: 'Forbidden' } }
  }
  db.memberships.push({ userId: targetUserId, orgId, role })
  return { status: 201, body: { userId: targetUserId, orgId, role } }
}
