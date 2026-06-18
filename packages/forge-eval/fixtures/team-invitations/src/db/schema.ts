// Database schema for the team-invitations fixture. Mirrors the sample-saas
// pattern but pre-declares the `Invitation` type so the agent's job is to
// implement route behavior, not invent the storage shape.

export interface User {
  id: string
  email: string
  name: string
  createdAt: string
}

export interface Organization {
  id: string
  name: string
  ownerId: string
}

export type Role = 'owner' | 'admin' | 'member'

export interface Membership {
  userId: string
  orgId: string
  role: Role
}

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

export interface Invitation {
  id: string
  token: string
  orgId: string
  inviteeEmail: string
  role: Role
  invitedBy: string
  createdAt: string
  expiresAt: string
  acceptedAt?: string
  revokedAt?: string
  status: InvitationStatus
}

/** In-memory tables standing in for a real database. */
export const db = {
  users: new Map<string, User>(),
  organizations: new Map<string, Organization>(),
  memberships: [] as Membership[],
  invitations: new Map<string, Invitation>(),
}
