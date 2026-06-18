// Migration 0001: initial schema (users, organizations, memberships).

export const up = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
`

export const down = `
DROP TABLE memberships;
DROP TABLE organizations;
DROP TABLE users;
`
