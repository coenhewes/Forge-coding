/**
 * Invitation API route stubs — the agent's job is to fill these in.
 *
 * Each stub:
 *   - raises `NotImplementedError` so the eval can detect "did not finish"
 *   - documents the expected shape via the surrounding function signature
 *   - exports a function the agent can call without changing the surface
 *
 * The eval task `Add team invitations` requires the agent to:
 *   1. Implement `createInvitation` — `POST /orgs/:id/invites`
 *      enforce canManageMembers; insert Invitation row; return 201.
 *   2. Implement `acceptInvitation` — `POST /invites/:token/accept`
 *      reject expired (now > expires_at) and revoked (revoked_at != null);
 *      add Membership; mark accepted; return 200.
 *   3. Implement `revokeInvitation` — `DELETE /invites/:id`
 *      enforce canManageMembers; set revoked_at + status='revoked';
 *      return 200.
 *   4. Implement `listInvitations` — `GET /orgs/:id/invites`
 *      enforce canManageMembers; return pending invitations.
 */
import { canManageMembers, DEFAULT_INVITATION_TTL_MS } from '../auth/permissions.js'
import { db, type Invitation, type Role } from '../db/schema.js'
import { randomUUID } from 'node:crypto'

export interface ApiResponse {
  status: number
  body: unknown
}

export class NotImplementedError extends Error {
  constructor(name: string) {
    super(`Invitation API stub not implemented: ${name}`)
    this.name = 'NotImplementedError'
  }
}

export interface CreateInvitationInput {
  orgId: string
  inviteeEmail: string
  role: Role
  ttlMs?: number
}

export interface AcceptInvitationInput {
  token: string
  /** User id of the accept-er; must exist or 404. */
  actingUserId: string
}

export interface RevokeInvitationInput {
  invitationId: string
  actingUserId: string
}

/**
 * POST /orgs/:orgId/invites — create a pending invitation.
 * Returns 201 with the invitation body, 403 if acting user cannot manage
 * members, 400 if `inviteeEmail` is empty or `role` is not a valid Role.
 */
export function createInvitation(
  actingUserId: string,
  input: CreateInvitationInput,
): ApiResponse {
  if (!canManageMembers(actingUserId, input.orgId)) {
    return { status: 403, body: { error: 'Forbidden' } }
  }
  const id = randomUUID()
  const token = randomUUID().replace(/-/g, '')
  const now = new Date()
  const invitation: Invitation = {
    id,
    token,
    orgId: input.orgId,
    inviteeEmail: input.inviteeEmail,
    role: input.role,
    invitedBy: actingUserId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_INVITATION_TTL_MS)).toISOString(),
    status: 'pending',
  }
  db.invitations.set(id, invitation)
  return { status: 201, body: invitation }
}

/**
 * POST /invites/:token/accept — consume a pending invitation.
 * Returns 200 with the new membership body, 404 if the token is unknown,
 * 410 Gone if the invitation is expired or revoked, 409 Conflict if
 * already accepted.
 */
export function acceptInvitation(input: AcceptInvitationInput): ApiResponse {
  const invitation = [...db.invitations.values()].find((i) => i.token === input.token)
  if (!invitation) return { status: 404, body: { error: 'Unknown invitation token' } }
  const now = Date.now()
  if (invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= now) {
    return { status: 410, body: { error: 'Invitation expired' } }
  }
  if (invitation.status === 'revoked' || invitation.revokedAt) {
    return { status: 410, body: { error: 'Invitation revoked' } }
  }
  if (invitation.status === 'accepted' || invitation.acceptedAt) {
    return { status: 409, body: { error: 'Invitation already accepted' } }
  }
  invitation.acceptedAt = new Date(now).toISOString()
  invitation.status = 'accepted'
  db.invitations.set(invitation.id, invitation)
  db.memberships.push({ userId: input.actingUserId, orgId: invitation.orgId, role: invitation.role })
  return { status: 200, body: { userId: input.actingUserId, orgId: invitation.orgId, role: invitation.role } }
}

/**
 * DELETE /invites/:id — revoke a pending invitation.
 * Returns 200 with the revoked invitation, 403 if the acting user cannot
 * manage members, 404 if the id is unknown, 409 if the invitation is
 * already accepted.
 */
export function revokeInvitation(input: RevokeInvitationInput): ApiResponse {
  const invitation = db.invitations.get(input.invitationId)
  if (!invitation) return { status: 404, body: { error: 'Unknown invitation' } }
  if (!canManageMembers(input.actingUserId, invitation.orgId)) {
    return { status: 403, body: { error: 'Forbidden' } }
  }
  if (invitation.status === 'accepted') {
    return { status: 409, body: { error: 'Cannot revoke an accepted invitation' } }
  }
  invitation.revokedAt = new Date().toISOString()
  invitation.status = 'revoked'
  db.invitations.set(invitation.id, invitation)
  return { status: 200, body: invitation }
}

/**
 * GET /orgs/:orgId/invites — list pending invitations for an org.
 * Returns 200 with an array of pending invitations, 403 if the acting
 * user cannot manage members.
 */
export function listInvitations(actingUserId: string, orgId: string): ApiResponse {
  if (!canManageMembers(actingUserId, orgId)) {
    return { status: 403, body: { error: 'Forbidden' } }
  }
  const invitations = [...db.invitations.values()].filter(
    (i) => i.orgId === orgId && i.status === 'pending',
  )
  return { status: 200, body: invitations }
}
