import { listInvitations } from '../api/invitations.js'

/**
 * Frontend page for managing team invitations. Calls listInvitations()
 * to render pending invites; the eval task adds a "Revoke" button wired
 * to revokeInvitation and a "Create" form wired to createInvitation.
 */
export function InvitationsPage(props: { actingUserId: string; orgId: string }): string {
  const res = listInvitations(props.actingUserId, props.orgId)
  if (res.status !== 200) {
    return `<div class="error">Unable to load invitations</div>`
  }
  const items = res.body as Array<{ id: string; inviteeEmail: string; role: string; expiresAt: string }>
  const rows = items
    .map(
      (i) =>
        `<li data-id="${i.id}">${i.inviteeEmail} — ${i.role} — expires ${i.expiresAt}</li>`,
    )
    .join('')
  return `<ul class="invitations">${rows}</ul>`
}
