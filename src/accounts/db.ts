// Shopper accounts: the SQLite file and its schema.
//
// One file, opened by the web server only. The voice agent never opens it: it gets a
// shopper's memory in its job metadata (written by the server when it mints the call
// token) and hands changes back through the page. See docs in README "Shopper accounts".
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = path.join('data', 'alice.db');
export const SCHEMA_VERSION = 1;

export interface AccountsDb {
  readonly db: DatabaseSync;
  readonly path: string;
  close(): void;
}

export interface OpenDbOptions {
  /** File path, or ':memory:' for tests. Defaults to ALICE_DB_PATH, then data/alice.db. */
  path?: string;
}

export function resolveDbPath(raw: string | undefined = process.env.ALICE_DB_PATH): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || DEFAULT_DB_PATH;
}

// Each entry moves the schema up by exactly one version. Never edit an entry that has
// shipped; add a new one.
const MIGRATIONS: readonly string[] = [
  // v1: accounts, sessions, memory.
  `
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL CHECK (provider IN ('password', 'shop')),
    email         TEXT,
    provider_sub  TEXT,
    password_hash TEXT,
    display_name  TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    CHECK (provider <> 'password' OR (email IS NOT NULL AND password_hash IS NOT NULL)),
    CHECK (provider <> 'shop' OR provider_sub IS NOT NULL)
  ) STRICT;
  CREATE UNIQUE INDEX accounts_password_email ON accounts (email) WHERE provider = 'password';
  CREATE UNIQUE INDEX accounts_provider_sub ON accounts (provider, provider_sub)
    WHERE provider_sub IS NOT NULL;

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_account ON sessions (account_id, created_at);
  CREATE INDEX sessions_expires ON sessions (expires_at);

  CREATE TABLE memory (
    account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    department TEXT CHECK (department IS NULL OR department IN ('men', 'women')),
    sizes_json TEXT NOT NULL DEFAULT '{}',
    facts_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
];

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const v = row?.user_version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db);
  if (version > MIGRATIONS.length) {
    throw new Error(
      `accounts db is at schema v${version}, newer than this code (v${MIGRATIONS.length}); refusing to open it`,
    );
  }
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]!);
      // PRAGMA takes no bound parameters; `next` is a loop counter, never input.
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = next;
  }
  return version;
}

export function openAccountsDb(opts?: OpenDbOptions): AccountsDb {
  const target = opts?.path?.trim() || resolveDbPath();
  const inMemory = target === ':memory:';

  if (!inMemory) {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  }

  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (!inMemory) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  if (!inMemory) {
    // The file holds password hashes and session hashes: owner read/write only.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(`${target}${suffix}`, 0o600);
      } catch {
        // The side files may not exist yet, and some volumes ignore chmod.
      }
    }
  }

  let closed = false;
  return {
    db,
    path: target,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
