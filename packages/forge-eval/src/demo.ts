/**
 * The headline eval task from AGENTS.md: organization invitations across auth,
 * database, api, frontend, and tests. It is deliberately multi-domain and
 * security-sensitive (role checks, expiry) so the harness must localize,
 * coordinate cross-domain changes, verify, and recover — not just emit code.
 */
export const DEMO_TASK = `Add organization invitations to this SaaS app.

Requirements:
- An admin or owner can invite a user to an organization by email with a role (admin or member).
- Invitations expire after a configurable duration; expired invitations cannot be accepted.
- A non-admin cannot create invitations (enforce with the existing permission helpers in src/auth/permissions.ts).
- Accepting an invitation creates the membership with the assigned role.
- Add unit tests covering: an admin creating an invite, a non-admin being forbidden, and an expired invite being rejected.

Follow the existing code style. Use the permission helpers in src/auth/permissions.ts and the models in src/db/schema.ts. Verify your work by running the test suite, then finish.`
