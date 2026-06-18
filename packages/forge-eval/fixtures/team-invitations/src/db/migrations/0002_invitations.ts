// Migration 0002: invitations table.
// The agent's job is to make this table do something — the schema is pre-declared
// so the harness can route, verify, and surface evidence against stable column
// names. The agent must NOT modify this migration; it adds application code in
// src/api/invitations.ts and acceptance logic in src/auth/permissions.ts.

export const up = `
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  invitee_email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_org ON invitations(org_id);
`

export const down = `
DROP TABLE invitations;
`
