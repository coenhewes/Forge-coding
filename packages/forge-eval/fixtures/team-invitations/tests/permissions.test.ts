/**
 * Permission regression tests — these must remain green across any
 * invitation-related changes. They exercise the role helpers the
 * invitation API depends on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db/schema.js'
import { canManageMembers, getRole, requireRole } from '../src/auth/permissions.js'

test('owner and admin can manage members; member cannot', () => {
  db.memberships.length = 0
  db.memberships.push({ userId: 'u-owner', orgId: 'o1', role: 'owner' })
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })
  db.memberships.push({ userId: 'u-member', orgId: 'o1', role: 'member' })

  assert.equal(canManageMembers('u-owner', 'o1'), true)
  assert.equal(canManageMembers('u-admin', 'o1'), true)
  assert.equal(canManageMembers('u-member', 'o1'), false)
  assert.equal(canManageMembers('u-stranger', 'o1'), false)
})

test('requireRole throws for missing or wrong role', () => {
  db.memberships.length = 0
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  assert.doesNotThrow(() => requireRole('u-admin', 'o1', ['admin', 'owner']))
  assert.throws(() => requireRole('u-admin', 'o1', ['owner']), /Forbidden/)
  assert.throws(() => requireRole('u-stranger', 'o1', ['admin']), /Forbidden/)
})

test('getRole returns undefined for non-members', () => {
  db.memberships.length = 0
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })
  assert.equal(getRole('u-admin', 'o1'), 'admin')
  assert.equal(getRole('u-stranger', 'o1'), undefined)
})
