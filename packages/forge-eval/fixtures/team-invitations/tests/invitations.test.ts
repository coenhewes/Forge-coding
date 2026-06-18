/**
 * Invitation API tests — the agent must turn these green as part of the
 * `Add team invitations` eval task. The tests cover the four required
 * behaviors (create, accept, expire, revoke) and the two cross-cutting
 * permission checks (non-admin forbidden, accepted invitation immutable).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db/schema.js'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from '../src/api/invitations.js'

function reset() {
  db.memberships.length = 0
  db.invitations.clear()
}

test('admin can create an invitation; non-admin is forbidden', () => {
  reset()
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  const ok = createInvitation('u-admin', {
    orgId: 'o1',
    inviteeEmail: 'invitee@example.com',
    role: 'member',
  })
  assert.equal(ok.status, 201)
  assert.equal((ok.body as { role: string }).role, 'member')

  const forbidden = createInvitation('u-stranger', {
    orgId: 'o1',
    inviteeEmail: 'evil@example.com',
    role: 'member',
  })
  assert.equal(forbidden.status, 403)
})

test('accepting a pending invitation creates a membership', () => {
  reset()
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  const created = createInvitation('u-admin', {
    orgId: 'o1',
    inviteeEmail: 'invitee@example.com',
    role: 'member',
  })
  const token = (created.body as { token: string }).token

  const accepted = acceptInvitation({ token, actingUserId: 'u-new' })
  assert.equal(accepted.status, 200)
  assert.equal(
    (accepted.body as { userId: string; orgId: string }).userId,
    'u-new',
  )
  assert.equal(
    db.memberships.find((m) => m.userId === 'u-new' && m.orgId === 'o1')?.role,
    'member',
  )
})

test('expired invitation cannot be accepted (410 Gone)', () => {
  reset()
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  // Create with a TTL of 1ms so it is already expired by the time we accept.
  const created = createInvitation('u-admin', {
    orgId: 'o1',
    inviteeEmail: 'invitee@example.com',
    role: 'member',
    ttlMs: -1000,
  })
  const token = (created.body as { token: string }).token

  const rejected = acceptInvitation({ token, actingUserId: 'u-new' })
  assert.equal(rejected.status, 410)
})

test('revoked invitation cannot be accepted (410 Gone)', () => {
  reset()
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  const created = createInvitation('u-admin', {
    orgId: 'o1',
    inviteeEmail: 'invitee@example.com',
    role: 'member',
  })
  const invitation = created.body as { id: string; token: string }

  const revoked = revokeInvitation({ invitationId: invitation.id, actingUserId: 'u-admin' })
  assert.equal(revoked.status, 200)

  const rejected = acceptInvitation({ token: invitation.token, actingUserId: 'u-new' })
  assert.equal(rejected.status, 410)
})

test('listInvitations only returns pending entries for the org', () => {
  reset()
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })
  db.memberships.push({ userId: 'u-admin', orgId: 'o2', role: 'admin' })

  const a = createInvitation('u-admin', { orgId: 'o1', inviteeEmail: 'a@x.com', role: 'member' })
  createInvitation('u-admin', { orgId: 'o2', inviteeEmail: 'b@x.com', role: 'member' })
  const revoked = createInvitation('u-admin', { orgId: 'o1', inviteeEmail: 'c@x.com', role: 'member' })
  revokeInvitation({ invitationId: (revoked.body as { id: string }).id, actingUserId: 'u-admin' })

  const list = listInvitations('u-admin', 'o1')
  assert.equal(list.status, 200)
  const items = list.body as Array<{ id: string }>
  assert.equal(items.length, 1)
  assert.equal(items[0].id, (a.body as { id: string }).id)
})
