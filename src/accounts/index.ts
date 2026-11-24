// Shopper accounts: sign up, sign in, sessions, and the memory Alice keeps per shopper.
//
// This module has no HTTP in it. server.ts turns requests into calls here and owns the
// cookie; tests drive it directly with an in-memory database and a fake clock.
import crypto from 'node:crypto';
import { openAccountsDb, type AccountsDb } from './db.ts';
import {
  cleanName,
  emptyMemory,
  mergeMemory,
  parseStoredMemory,
  type MemoryPatch,
  type ShopperMemory,
} from './memory.ts';
import {
  checkPassword,
  createHashGate,
  DEFAULT_SCRYPT,
  getDecoyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
  type PasswordProblem,
  type ScryptParams,
} from './passwords.ts';

export type { ShopperMemory, MemoryPatch, Department } from './memory.ts';
export { emptyMemory, isEmptyMemory } from './memory.ts';
export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './passwords.ts';
export { createAttemptLimiter, type AttemptLimiter } from './limiter.ts';

export type AccountProvider = 'password' | 'shop';

export interface PublicAccount {
  id: string;
  provider: AccountProvider;
  email: string | null;
  display_name: string | null;
  created_at: number;
}

export interface SessionGrant {
  /** The secret that goes in the cookie. Only its SHA-256 is stored. */
  token: string;
  expires_at: number;
}

export type SignUpFailure =
  | { ok: false; code: 'invalid_email' }
  | { ok: false; code: 'weak_password'; problem: PasswordProblem }
  | { ok: false; code: 'email_taken' };

export type SignUpResult = { ok: true; account: PublicAccount; session: SessionGrant } | SignUpFailure;

export type SignInResult =
  | { ok: true; account: PublicAccount; session: SessionGrant }
  | { ok: false; code: 'bad_credentials' };

export interface AccountsOptions {
  db?: AccountsDb;
  now?: () => number;
  sessionTtlMs?: number;
  maxSessionsPerAccount?: number;
  scrypt?: ScryptParams;
  hashConcurrency?: number;
}

export interface Accounts {
  signUp(input: { email: unknown; password: unknown; display_name?: unknown }): Promise<SignUpResult>;
  signIn(input: { email: unknown; password: unknown }): Promise<SignInResult>;
  sessionAccount(token: unknown): PublicAccount | null;
  signOut(token: unknown): boolean;
  signOutEverywhere(accountId: string): number;
  deleteAccount(accountId: string): boolean;
  setDisplayName(accountId: string, name: unknown): PublicAccount | null;
  getMemory(accountId: string): ShopperMemory;
  saveMemory(accountId: string, patch: MemoryPatch): ShopperMemory;
  clearMemory(accountId: string): void;
  countAccounts(): number;
  pruneExpired(): number;
  close(): void;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_ACCOUNT = 10;
export const MAX_EMAIL_LENGTH = 254;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Lowercased, trimmed email, or null when it does not look like one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  // One @, no spaces or control characters, a dot in the domain. Deliberately loose:
  // the address is a sign-in name here and is never mailed.
  if (!/^[^\s@\u0000-\u001f\u007f]{1,64}@[^\s@\u0000-\u001f\u007f]{1,251}$/.test(email)) return null;
  const domain = email.slice(email.indexOf('@') + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return null;
  }
  return email;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errcode?: unknown; message?: unknown };
  // 2067 = SQLITE_CONSTRAINT_UNIQUE, 1555 = SQLITE_CONSTRAINT_PRIMARYKEY
  if (e.errcode === 2067 || e.errcode === 1555) return true;
  return typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message);
}

interface AccountRow {
  id: string;
  provider: AccountProvider;
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  created_at: number;
}

function toPublic(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export function createAccounts(opts?: AccountsOptions): Accounts {
  const handle = opts?.db ?? openAccountsDb();
  const db = handle.db;
  const now = opts?.now ?? (() => Date.now());
  const sessionTtlMs = opts?.sessionTtlMs ?? SESSION_TTL_MS;
  const maxSessions = Math.max(1, opts?.maxSessionsPerAccount ?? MAX_SESSIONS_PER_ACCOUNT);
  const scrypt = opts?.scrypt ?? DEFAULT_SCRYPT;
  const gate = createHashGate(opts?.hashConcurrency ?? 2);

  const q = {
    accountByEmail: db.prepare(
      "SELECT id, provider, email, display_name, password_hash, created_at FROM accounts WHERE provider = 'password' AND email = ?",
    ),
    accountById: db.prepare(
      'SELECT id, provider, email, display_name, password_hash, created_at FROM accounts WHERE id = ?',
    ),
    insertPasswordAccount: db.prepare(
      "INSERT INTO accounts (id, provider, email, password_hash, display_name, created_at, updated_at) VALUES (?, 'password', ?, ?, ?, ?, ?)",
    ),
    updateHash: db.prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?'),
    updateName: db.prepare('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?'),
    deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionByHash: db.prepare(
      'SELECT account_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?',
    ),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionsFor: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    trimSessions: db.prepare(
      `DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (
         SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ),
    memoryFor: db.prepare(
      'SELECT department, sizes_json, facts_json, updated_at FROM memory WHERE account_id = ?',
    ),
    upsertMemory: db.prepare(
      `INSERT INTO memory (account_id, department, sizes_json, facts_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET
         department = excluded.department,
         sizes_json = excluded.sizes_json,
         facts_json = excluded.facts_json,
         updated_at = excluded.updated_at`,
    ),
    deleteMemory: db.prepare('DELETE FROM memory WHERE account_id = ?'),
    countAccounts: db.prepare('SELECT count(*) AS n FROM accounts'),
  };

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function createSession(accountId: string): SessionGrant {
    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const t = now();
    const expiresAt = t + sessionTtlMs;
    q.insertSession.run(hashSessionToken(token), accountId, t, expiresAt, t);
    q.trimSessions.run(accountId, accountId, maxSessions);
    return { token, expires_at: expiresAt };
  }

  async function signUp(input: {
    email: unknown;
    password: unknown;
    display_name?: unknown;
  }): Promise<SignUpResult> {
    const email = normalizeEmail(input.email);
    if (!email) return { ok: false, code: 'invalid_email' };
    const problem = checkPassword(input.password);
    if (problem) return { ok: false, code: 'weak_password', problem };
    if (q.accountByEmail.get(email)) return { ok: false, code: 'email_taken' };

    const passwordHash = await gate(() => hashPassword(input.password as string, scrypt));
    const id = crypto.randomUUID();
    const displayName = cleanName(input.display_name);
    const t = now();

    try {
      const session = transaction(() => {
        q.insertPasswordAccount.run(id, email, passwordHash, displayName, t, t);
        return createSession(id);
      });
      const row = q.accountById.get(id) as AccountRow | undefined;
      if (!row) throw new Error('account vanished after insert');
      return { ok: true, account: toPublic(row), session };
    } catch (err) {
      // Two sign-ups for the same address can both pass the check above while the
      // password is being hashed. The unique index decides; the loser lands here.
      if (isUniqueViolation(err)) return { ok: false, code: 'email_taken' };
      throw err;
    }
  }

  async function signIn(input: { email: unknown; password: unknown }): Promise<SignInResult> {
    const email = normalizeEmail(input.email);
    const row = email ? (q.accountByEmail.get(email) as AccountRow | undefined) : undefined;
    const stored = row?.password_hash ?? (await getDecoyHash(scrypt));
    // Always spend one hash, so an unknown address is not faster than a wrong password.
    const matches = await gate(() => verifyPassword(input.password, stored));
    if (!row || !matches) return { ok: false, code: 'bad_credentials' };

    if (needsRehash(row.password_hash, scrypt)) {
      const upgraded = await gate(() => hashPassword(input.password as string, scrypt));
      q.updateHash.run(upgraded, now(), row.id);
    }
    const session = transaction(() => createSession(row.id));
    return { ok: true, account: toPublic(row), session };
  }

  function sessionAccount(token: unknown): PublicAccount | null {
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return null;
    const tokenHash = hashSessionToken(token);
    const session = q.sessionByHash.get(tokenHash) as
      | { account_id: string; expires_at: number; last_seen_at: number }
      | undefined;
    if (!session) return null;
    const t = now();
    if (session.expires_at <= t) {
      q.deleteSession.run(tokenHash);
      return null;
    }
    const row = q.accountById.get(session.account_id) as AccountRow | undefined;
    if (!row) return null;
    if (t - session.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
      q.touchSession.run(t, tokenHash);
    }
    return toPublic(row);
  }

  function signOut(token: unknown): boolean {
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return false;
    return Number(q.deleteSession.run(hashSessionToken(token)).changes) > 0;
  }

  function signOutEverywhere(accountId: string): number {
    return Number(q.deleteSessionsFor.run(accountId).changes);
  }

  function deleteAccount(accountId: string): boolean {
    // Sessions and memory go with it (ON DELETE CASCADE).
    return Number(q.deleteAccount.run(accountId).changes) > 0;
  }

  function setDisplayName(accountId: string, name: unknown): PublicAccount | null {
    q.updateName.run(cleanName(name), now(), accountId);
    const row = q.accountById.get(accountId) as AccountRow | undefined;
    return row ? toPublic(row) : null;
  }

  function getMemory(accountId: string): ShopperMemory {
    const row = q.memoryFor.get(accountId) as Record<string, unknown> | undefined;
    return row ? parseStoredMemory(row) : emptyMemory();
  }

  function saveMemory(accountId: string, patch: MemoryPatch): ShopperMemory {
    return transaction(() => {
      if (!q.accountById.get(accountId)) throw new Error('no such account');
      const merged = mergeMemory(getMemory(accountId), patch ?? {});
      const t = now();
      q.upsertMemory.run(
        accountId,
        merged.department,
        JSON.stringify(merged.sizes),
        JSON.stringify(merged.facts),
        t,
      );
      return { ...merged, updated_at: t };
    });
  }

  function clearMemory(accountId: string): void {
    q.deleteMemory.run(accountId);
  }

  function countAccounts(): number {
    return Number((q.countAccounts.get() as { n: number } | undefined)?.n ?? 0);
  }

  function pruneExpired(): number {
    return Number(q.deleteExpired.run(now()).changes);
  }

  return {
    signUp,
    signIn,
    sessionAccount,
    signOut,
    signOutEverywhere,
    deleteAccount,
    setDisplayName,
    getMemory,
    saveMemory,
    clearMemory,
    countAccounts,
    pruneExpired,
    close: () => handle.close(),
  };
}
