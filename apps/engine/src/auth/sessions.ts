import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiTokens, memberships, sessions, users } from '../db/schema.ts';
import { newToken, sha256 } from '../ids.ts';

/** Absolute session lifetime and idle timeout. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;

export type Role = 'owner' | 'member';

export interface SessionAuth {
  kind: 'session';
  sessionId: string;
  userId: string;
  email: string;
  workspaceId: string | null;
  role: Role | null;
  csrfToken: string;
}

export interface TokenAuth {
  kind: 'token';
  tokenId: string;
  workspaceId: string;
  scope: 'read' | 'write';
}

export type Auth = SessionAuth | TokenAuth;

export function createSession(
  db: Db,
  userId: string,
  workspaceId: string | null,
  now: number,
): { token: string; csrfToken: string } {
  const token = newToken('le_sess');
  const csrfToken = newToken('csrf');
  db.insert(sessions)
    .values({
      id: sha256(token),
      userId,
      workspaceId,
      csrfToken,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
    })
    .run();
  return { token, csrfToken };
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, sha256(token)))
    .run();
}

export function lookupSession(db: Db, token: string, now: number): SessionAuth | null {
  const id = sha256(token);
  const row = db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      workspaceId: sessions.workspaceId,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;
  if (row.expiresAt <= now || row.lastSeenAt + SESSION_IDLE_MS <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  // Touch at most once a minute to keep writes down.
  if (now - row.lastSeenAt > 60_000) {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();
  }

  let role: Role | null = null;
  let workspaceId = row.workspaceId;
  if (workspaceId) {
    const m = db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, row.userId), eq(memberships.workspaceId, workspaceId)))
      .get();
    if (m) role = m.role;
    else workspaceId = null; // membership was removed
  }
  return {
    kind: 'session',
    sessionId: row.id,
    userId: row.userId,
    email: row.email,
    workspaceId,
    role,
    csrfToken: row.csrfToken,
  };
}

export function setSessionWorkspace(db: Db, sessionId: string, workspaceId: string | null): void {
  db.update(sessions).set({ workspaceId }).where(eq(sessions.id, sessionId)).run();
}

export function lookupApiToken(db: Db, token: string, now: number): TokenAuth | null {
  const row = db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
    .get();
  if (!row) return null;
  if (!row.lastUsedAt || now - row.lastUsedAt > 60_000) {
    db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).run();
  }
  return { kind: 'token', tokenId: row.id, workspaceId: row.workspaceId, scope: row.scope };
}
