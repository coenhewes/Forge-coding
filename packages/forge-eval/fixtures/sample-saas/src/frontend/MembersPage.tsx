import { listMembers } from '../api/members.js'

/** Renders the members list for an organization. */
export function MembersPage(props: { userId: string; orgId: string }): string {
  const res = listMembers(props.userId, props.orgId)
  if (res.status !== 200) {
    return `<div class="error">Unable to load members</div>`
  }
  const members = res.body as { userId: string; role: string }[]
  const rows = members.map((m) => `<li>${m.userId} — ${m.role}</li>`).join('')
  return `<ul class="members">${rows}</ul>`
}
