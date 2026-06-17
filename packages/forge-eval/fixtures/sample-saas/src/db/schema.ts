// Database schema for the sample SaaS app (plain TS models, no ORM).

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

/** In-memory tables standing in for a real database. */
export const db = {
  users: new Map<string, User>(),
  organizations: new Map<string, Organization>(),
  memberships: [] as Membership[],
}
