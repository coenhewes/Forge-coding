// Minimal session helper: maps a token to a user id.

const sessions = new Map<string, string>()

export function createSession(token: string, userId: string): void {
  sessions.set(token, userId)
}

export function currentUserId(token: string): string | undefined {
  return sessions.get(token)
}
