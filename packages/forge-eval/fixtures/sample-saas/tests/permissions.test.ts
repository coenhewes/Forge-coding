import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db/schema.js'
import { canManageMembers, getRole } from '../src/auth/permissions.js'

test('owner and admin can manage members; member cannot', () => {
  db.memberships.length = 0
  db.memberships.push({ userId: 'u-owner', orgId: 'o1', role: 'owner' })
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })
  db.memberships.push({ userId: 'u-member', orgId: 'o1', role: 'member' })

  assert.equal(canManageMembers('u-owner', 'o1'), true)
  assert.equal(canManageMembers('u-admin', 'o1'), true)
  assert.equal(canManageMembers('u-member', 'o1'), false)
  assert.equal(getRole('u-nobody', 'o1'), undefined)
})
