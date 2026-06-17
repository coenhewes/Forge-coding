import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db/schema.js'
import { addMember, listMembers } from '../src/api/members.js'

test('admin can add a member; non-member is forbidden', () => {
  db.memberships.length = 0
  db.memberships.push({ userId: 'u-admin', orgId: 'o1', role: 'admin' })

  const ok = addMember('u-admin', 'o1', 'u-new', 'member')
  assert.equal(ok.status, 201)

  const forbidden = addMember('u-stranger', 'o1', 'u-x', 'member')
  assert.equal(forbidden.status, 403)

  const list = listMembers('u-admin', 'o1')
  assert.equal(list.status, 200)
})
