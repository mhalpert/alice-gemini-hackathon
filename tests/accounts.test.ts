import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate, openAccountsDb, resolveDbPath, SCHEMA_VERSION } from '../src/accounts/db.ts';
import {
  createAccounts,
  hashSessionToken,
  normalizeEmail,
  type Accounts,
} from '../src/accounts/index.ts';
import { createAttemptLimiter } from '../src/accounts/limiter.ts';
import {
  cleanFacts,
  cleanName,
  cleanSizes,
  cleanText,
  emptyMemory,
  isEmptyMemory,
  MAX_FACT_LENGTH,
  MAX_FACTS,
  MAX_SIZES,
  mergeMemory,
  parseStoredMemory,
} from '../src/accounts/memory.ts';
import {
  checkPassword,
  createHashGate,
  HashBusyError,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  needsRehash,
  verifyPassword,
} from '../src/accounts/passwords.ts';

// Small scrypt cost so the suite stays fast. Production uses DEFAULT_SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 };
const GOOD_PASSWORD = 'correct horse battery';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alice-accounts-'));
}

function makeAccounts(extra?: { now?: () => number; sessionTtlMs?: number; maxSessionsPerAccount?: number }): {
  accounts: Accounts;
  raw: DatabaseSync;
} {
  const handle = openAccountsDb({ path: ':memory:' });
  const accounts = createAccounts({ db: handle, scrypt: FAST, ...extra });
  return { accounts, raw: handle.db };
}

describe('accounts db', () => {
  it('opens an in-memory database at the current schema version', () => {
    const handle = openAccountsDb({ path: ':memory:' });
    const row = handle.db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(row.user_version, SCHEMA_VERSION);
    const tables = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.deepEqual(tables, ['accounts', 'memory', 'sessions']);
    handle.close();
    handle.close(); // closing twice is harmless
  });

  it('creates the file and its folder, keeps data across reopen, and does not migrate twice', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'alice.db');
    const first = openAccountsDb({ path: file });
    first.db
      .prepare(
        "INSERT INTO accounts (id, provider, email, password_hash, created_at, updated_at) VALUES ('a1', 'password', 'a@b.co', 'x', 1, 1)",
      )
      .run();
    first.close();

    const second = openAccountsDb({ path: file });
    const row = second.db.prepare('SELECT email FROM accounts WHERE id = ?').get('a1') as { email: string };
    assert.equal(row.email, 'a@b.co');
    assert.equal(migrate(second.db), SCHEMA_VERSION);
    second.close();

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a database written by newer code', () => {
    const dir = tempDir();
    const file = path.join(dir, 'alice.db');
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    assert.throws(() => openAccountsDb({ path: file }), /newer than this code/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enforces the schema rules: one password account per email, valid departments, cascade', () => {
    const { db } = openAccountsDb({ path: ':memory:' });
    const insert = db.prepare(
      "INSERT INTO accounts (id, provider, email, password_hash, created_at, updated_at) VALUES (?, 'password', ?, 'h', 1, 1)",
    );
    insert.run('a1', 'a@b.co');
    assert.throws(() => insert.run('a2', 'a@b.co'), /UNIQUE/);
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO accounts (id, provider, created_at, updated_at) VALUES ('a3', 'password', 1, 1)")
          .run(),
      /CHECK/,
    );
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO memory (account_id, department, updated_at) VALUES ('a1', 'kids', 1)")
          .run(),
      /CHECK/,
    );
    db.prepare("INSERT INTO memory (account_id, department, updated_at) VALUES ('a1', 'men', 1)").run();
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES ('t', 'a1', 1, 2, 1)",
    ).run();
    db.prepare('DELETE FROM accounts WHERE id = ?').run('a1');
    assert.equal((db.prepare('SELECT count(*) AS n FROM memory').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
    db.close();
  });

  it('resolves the path from the environment value, with a default', () => {
    assert.equal(resolveDbPath(undefined), path.join('data', 'alice.db'));
    assert.equal(resolveDbPath('   '), path.join('data', 'alice.db'));
    assert.equal(resolveDbPath(' /var/alice/a.db '), '/var/alice/a.db');
  });
});

describe('passwords', () => {
  it('applies length rules only', () => {
    assert.equal(checkPassword('short'), 'too_short');
    assert.equal(checkPassword('123456789'), 'too_short');
    assert.equal(checkPassword('1234567890'), null);
    assert.equal(checkPassword('a'.repeat(MAX_PASSWORD_LENGTH)), null);
    assert.equal(checkPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)), 'too_long');
    assert.equal(checkPassword(12345678901), 'not_text');
    assert.equal(checkPassword(undefined), 'not_text');
  });

  it('hashes with a fresh salt and verifies only the right password', async () => {
    const a = await hashPassword(GOOD_PASSWORD, FAST);
    const b = await hashPassword(GOOD_PASSWORD, FAST);
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.ok(!a.includes(GOOD_PASSWORD));
    assert.equal(await verifyPassword(GOOD_PASSWORD, a), true);
    assert.equal(await verifyPassword(GOOD_PASSWORD, b), true);
    assert.equal(await verifyPassword('correct horse batterx', a), false);
    assert.equal(await verifyPassword('', a), false);
  });

  it('treats composed and decomposed forms of the same text as one password', async () => {
    const composed = `caf${String.fromCodePoint(0xe9)}-au-lait-please`;
    const decomposed = `cafe${String.fromCodePoint(0x301)}-au-lait-please`;
    const stored = await hashPassword(composed, FAST);
    assert.equal(await verifyPassword(decomposed, stored), true);
  });

  it('never throws on a malformed stored hash or odd input', async () => {
    for (const stored of [null, undefined, '', 'plaintext', 'scrypt$1024$8$1$abc', 'scrypt$3$8$1$YWJjZGVmZ2g$YQ', 'bcrypt$1$2$3$4$5', 'x'.repeat(2000)]) {
      assert.equal(await verifyPassword(GOOD_PASSWORD, stored), false);
    }
    const stored = await hashPassword(GOOD_PASSWORD, FAST);
    assert.equal(await verifyPassword(null, stored), false);
    assert.equal(await verifyPassword({ toString: () => GOOD_PASSWORD }, stored), false);
    assert.equal(await verifyPassword('a'.repeat(MAX_PASSWORD_LENGTH * 4 + 1), stored), false);
    // A stored hash that asks for absurd memory is refused, not attempted.
    assert.equal(await verifyPassword(GOOD_PASSWORD, `scrypt$${2 ** 24}$8$1$YWJjZGVmZ2hpams$${'A'.repeat(43)}`), false);
  });

  it('flags hashes made with weaker parameters', async () => {
    const weak = await hashPassword(GOOD_PASSWORD, FAST);
    assert.equal(needsRehash(weak, { N: 2048, r: 8, p: 1 }), true);
    assert.equal(needsRehash(weak, FAST), false);
    assert.equal(needsRehash('garbage', FAST), true);
  });

  it('runs no more than the allowed number of hashes at once', async () => {
    const gate = createHashGate(2);
    let running = 0;
    let peak = 0;
    const job = () =>
      gate(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return 'done';
      });
    const results = await Promise.all([job(), job(), job(), job(), job(), job()]);
    assert.equal(peak, 2);
    assert.deepEqual(results, Array(6).fill('done'));
    // A failing job still frees its slot.
    await assert.rejects(gate(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await gate(async () => 'after'), 'after');
  });
});

describe('password check queue', () => {
  it('refuses new work at once when the line is full, and recovers when it drains', async () => {
    const gate = createHashGate(1, 2);
    let release: (() => void) | null = null;
    const blocker = gate(() => new Promise<string>((resolve) => { release = () => resolve('first'); }));
    const queuedA = gate(async () => 'a');
    const queuedB = gate(async () => 'b');
    await assert.rejects(gate(async () => 'overflow'), HashBusyError);
    release!();
    assert.deepEqual(await Promise.all([blocker, queuedA, queuedB]), ['first', 'a', 'b']);
    assert.equal(await gate(async () => 'after'), 'after');
  });

  it('surfaces as HashBusyError from sign-in when the service is flooded', async () => {
    const accounts = createAccounts({ db: openAccountsDb({ path: ':memory:' }), scrypt: FAST, hashConcurrency: 1, hashQueue: 1 });
    await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => accounts.signIn({ email: 'a@b.co', password: GOOD_PASSWORD })),
    );
    const busy = results.filter((r) => r.status === 'rejected' && r.reason instanceof HashBusyError).length;
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
    assert.ok(busy >= 1, 'some sign-ins are refused as busy');
    assert.ok(ok >= 1, 'the ones that got a place still succeed');
    assert.equal(busy + ok, 6);
    assert.equal((await accounts.signIn({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, true);
  });
});

describe('shopper memory rules', () => {
  it('cleans text: control characters out, whitespace collapsed, length capped on code points', () => {
    const messy = `  likes\n\tgreen ${String.fromCodePoint(0)} linen${String.fromCodePoint(0x202e, 0x2028, 0x85)}  `;
    assert.equal(cleanText(messy, 50), 'likes green linen');
    assert.equal(cleanText(42, 50), '');
    assert.equal(cleanText('abcdef', 3), 'abc');
    assert.equal(cleanText('👗👗👗', 2), '👗👗');
    assert.equal(cleanName('   '), null);
    assert.equal(cleanName(' Priya '), 'Priya');
  });

  it('cleans sizes: plain keys, capped count and lengths, numbers accepted', () => {
    const sizes = cleanSizes({ ' Top ': ' M ', shoes: 9.5, 'in<script>seam': '32', '': 'x', bottom: '', __proto__: 'evil' });
    assert.deepEqual(sizes, { top: 'M', shoes: '9.5', inscriptseam: '32' });
    assert.deepEqual(cleanSizes(null), {});
    assert.deepEqual(cleanSizes(['M']), {});
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) many[`slot${i}`] = 'M';
    assert.equal(Object.keys(cleanSizes(many)).length, MAX_SIZES);
  });

  it('cleans facts: no blanks, no repeats, newest kept, each capped', () => {
    assert.deepEqual(cleanFacts(['Likes green', ' ', 'likes GREEN', 5, 'Hates wool']), ['likes GREEN', 'Hates wool']);
    assert.deepEqual(cleanFacts('not a list'), []);
    const many = Array.from({ length: MAX_FACTS + 15 }, (_, i) => `fact ${i}`);
    const kept = cleanFacts(many);
    assert.equal(kept.length, MAX_FACTS);
    assert.equal(kept[0], 'fact 15');
    assert.equal(kept.at(-1), `fact ${MAX_FACTS + 14}`);
    assert.equal(cleanFacts(['x'.repeat(MAX_FACT_LENGTH + 50)])[0]!.length, MAX_FACT_LENGTH);
  });

  it('merges a patch without losing what was stored', () => {
    const start = { department: 'women' as const, sizes: { top: 'M' }, facts: ['Likes green'], updated_at: 7 };
    const merged = mergeMemory(start, { sizes: { shoes: '8', top: 'L' }, facts: ['Hates wool', 'likes green'] });
    assert.equal(merged.department, 'women');
    assert.deepEqual(merged.sizes, { top: 'L', shoes: '8' });
    assert.deepEqual(merged.facts, ['Hates wool', 'likes green']);
    // Unusable fields change nothing.
    const same = mergeMemory(start, { department: 'kids', sizes: 'M', facts: null });
    assert.deepEqual(same, start);
    assert.equal(mergeMemory(start, { department: 'men' }).department, 'men');
  });

  it('reads stored rows defensively', () => {
    assert.deepEqual(parseStoredMemory(null), emptyMemory());
    const parsed = parseStoredMemory({ department: 'men', sizes_json: '{not json', facts_json: '["a","a"]', updated_at: 3 });
    assert.deepEqual(parsed, { department: 'men', sizes: {}, facts: ['a'], updated_at: 3 });
    assert.equal(isEmptyMemory(emptyMemory()), true);
    assert.equal(isEmptyMemory(parsed), false);
  });
});

describe('attempt limiter', () => {
  it('allows max tries per window, then blocks until the window ends', () => {
    let t = 1_000;
    const limiter = createAttemptLimiter({ max: 3, windowMs: 60_000, now: () => t });
    assert.equal(limiter.blocked('k'), false);
    assert.equal(limiter.hit('k'), true);
    assert.equal(limiter.hit('k'), true);
    assert.equal(limiter.retryAfterS('k'), 0);
    assert.equal(limiter.hit('k'), true);
    assert.equal(limiter.blocked('k'), true);
    assert.equal(limiter.hit('k'), false);
    assert.equal(limiter.retryAfterS('k'), 60);
    assert.equal(limiter.blocked('other'), false);
    t += 59_000;
    assert.equal(limiter.blocked('k'), true);
    assert.equal(limiter.retryAfterS('k'), 1);
    t += 1_000;
    assert.equal(limiter.blocked('k'), false);
    assert.equal(limiter.hit('k'), true);
  });

  it('gives a counted try back', () => {
    const limiter = createAttemptLimiter({ max: 2, windowMs: 1_000, now: () => 0 });
    limiter.hit('k');
    limiter.hit('k');
    assert.equal(limiter.blocked('k'), true);
    limiter.unhit('k');
    assert.equal(limiter.blocked('k'), false);
    limiter.unhit('k');
    limiter.unhit('k');
    limiter.unhit('never-seen');
    assert.equal(limiter.size(), 0);
    assert.equal(limiter.hit('k'), true);
  });

  it('can be reset for a key and never tracks more keys than its cap', () => {
    let t = 0;
    const limiter = createAttemptLimiter({ max: 1, windowMs: 1_000, now: () => t, maxKeys: 5 });
    limiter.hit('a');
    assert.equal(limiter.blocked('a'), true);
    limiter.reset('a');
    assert.equal(limiter.blocked('a'), false);
    for (let i = 0; i < 50; i += 1) limiter.hit(`key-${i}`);
    assert.ok(limiter.size() <= 5);
    t += 2_000;
    limiter.hit('fresh');
    assert.ok(limiter.size() <= 5);
  });
});

describe('accounts service', () => {
  it('normalizes and validates email addresses', () => {
    assert.equal(normalizeEmail('  Priya@Example.COM '), 'priya@example.com');
    // Surrounding whitespace, a trailing newline included, is trimmed before the check.
    assert.equal(normalizeEmail('a@b.co\n'), 'a@b.co');
    for (const bad of ['', 'no-at-sign', 'a@b', 'a@@b.co', 'a b@c.co', 'a@.co', 'a@b..co', 'a@b.co.', `${'x'.repeat(250)}@b.co`, 'a@b\n.co', 'a\tb@c.co', null, 5]) {
      assert.equal(normalizeEmail(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('signs up, signs in, and resolves a session to the account', async () => {
    const { accounts, raw } = makeAccounts();
    const up = await accounts.signUp({ email: 'Priya@Example.com', password: GOOD_PASSWORD, display_name: ' Priya ' });
    assert.equal(up.ok, true);
    if (!up.ok) return;
    assert.equal(up.account.email, 'priya@example.com');
    assert.equal(up.account.display_name, 'Priya');
    assert.equal(up.account.provider, 'password');
    assert.ok(!('password_hash' in up.account));
    assert.match(up.session.token, /^[A-Za-z0-9_-]{43}$/);

    // The database never holds the password or the session token itself.
    const dump = JSON.stringify([
      raw.prepare('SELECT * FROM accounts').all(),
      raw.prepare('SELECT * FROM sessions').all(),
    ]);
    assert.ok(!dump.includes(GOOD_PASSWORD));
    assert.ok(!dump.includes(up.session.token));
    assert.ok(dump.includes(hashSessionToken(up.session.token)));

    assert.deepEqual(accounts.sessionAccount(up.session.token), up.account);

    const inResult = await accounts.signIn({ email: ' PRIYA@example.com', password: GOOD_PASSWORD });
    assert.equal(inResult.ok, true);
    if (!inResult.ok) return;
    assert.equal(inResult.account.id, up.account.id);
    assert.notEqual(inResult.session.token, up.session.token);
    accounts.close();
  });

  it('rejects bad sign-ups with a reason', async () => {
    const { accounts } = makeAccounts();
    assert.deepEqual(await accounts.signUp({ email: 'nope', password: GOOD_PASSWORD }), { ok: false, code: 'invalid_email' });
    assert.deepEqual(await accounts.signUp({ email: 'a@b.co', password: 'short' }), { ok: false, code: 'weak_password', problem: 'too_short' });
    assert.deepEqual(await accounts.signUp({ email: 'a@b.co', password: undefined }), { ok: false, code: 'weak_password', problem: 'not_text' });
    assert.equal((await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, true);
    assert.deepEqual(await accounts.signUp({ email: 'A@B.co', password: 'another long password' }), { ok: false, code: 'email_taken' });
  });

  it('holds the account cap even when sign-ups are hashing at the same time', async () => {
    const { accounts } = makeAccounts();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => accounts.signUp({ email: `cap${i}@example.com`, password: GOOD_PASSWORD, max_accounts: 2 })),
    );
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'accounts_full'));
    assert.equal(accounts.countAccounts(), 2);
  });

  it('lets exactly one of two simultaneous sign-ups for the same address win', async () => {
    const { accounts, raw } = makeAccounts();
    const results = await Promise.all([
      accounts.signUp({ email: 'race@example.com', password: GOOD_PASSWORD }),
      accounts.signUp({ email: 'race@example.com', password: GOOD_PASSWORD }),
      accounts.signUp({ email: 'race@example.com', password: GOOD_PASSWORD }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'email_taken'));
    assert.equal((raw.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n, 1);
    assert.equal((raw.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 1);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const { accounts } = makeAccounts();
    await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    const wrong = await accounts.signIn({ email: 'a@b.co', password: 'wrong password here' });
    const unknown = await accounts.signIn({ email: 'nobody@b.co', password: GOOD_PASSWORD });
    const garbage = await accounts.signIn({ email: 17, password: null });
    assert.deepEqual(wrong, { ok: false, code: 'bad_credentials' });
    assert.deepEqual(unknown, wrong);
    assert.deepEqual(garbage, wrong);
  });

  it('expires sessions, signs out, and ignores malformed tokens', async () => {
    let t = 1_000_000;
    const { accounts, raw } = makeAccounts({ now: () => t, sessionTtlMs: 10_000 });
    const up = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(up.ok);
    if (!up.ok) return;
    const token = up.session.token;
    assert.equal(up.session.expires_at, 1_010_000);

    for (const bad of [null, undefined, '', 'short', `${token}x`, token.slice(1), { token }, "' OR 1=1 --"]) {
      assert.equal(accounts.sessionAccount(bad), null);
      assert.equal(accounts.signOut(bad), false);
    }

    t += 9_999;
    assert.ok(accounts.sessionAccount(token));
    t += 1;
    assert.equal(accounts.sessionAccount(token), null);
    assert.equal((raw.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);

    const again = await accounts.signIn({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.equal(accounts.signOut(again.session.token), true);
    assert.equal(accounts.sessionAccount(again.session.token), null);
    assert.equal(accounts.signOut(again.session.token), false);
  });

  it('prunes expired sessions and records last-seen at most once a minute', async () => {
    let t = 0;
    const { accounts, raw } = makeAccounts({ now: () => t, sessionTtlMs: 600_000 });
    const up = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(up.ok);
    if (!up.ok) return;
    const lastSeen = () => (raw.prepare('SELECT last_seen_at FROM sessions').get() as { last_seen_at: number }).last_seen_at;
    t = 30_000;
    accounts.sessionAccount(up.session.token);
    assert.equal(lastSeen(), 0);
    t = 61_000;
    accounts.sessionAccount(up.session.token);
    assert.equal(lastSeen(), 61_000);
    assert.equal(accounts.pruneExpired(), 0);
    t = 600_000;
    assert.equal(accounts.pruneExpired(), 1);
  });

  it('keeps only the newest sessions per account', async () => {
    let t = 0;
    const { accounts } = makeAccounts({ now: () => (t += 10), maxSessionsPerAccount: 3 });
    const up = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(up.ok);
    if (!up.ok) return;
    const tokens = [up.session.token];
    for (let i = 0; i < 4; i += 1) {
      const r = await accounts.signIn({ email: 'a@b.co', password: GOOD_PASSWORD });
      assert.ok(r.ok);
      if (r.ok) tokens.push(r.session.token);
    }
    const alive = tokens.map((token) => accounts.sessionAccount(token) !== null);
    assert.deepEqual(alive, [false, false, true, true, true]);
    assert.equal(accounts.signOutEverywhere(up.account.id), 3);
    assert.equal(accounts.sessionAccount(tokens[4]), null);
  });

  it('upgrades a weak stored hash on the next successful sign-in', async () => {
    const handle = openAccountsDb({ path: ':memory:' });
    const weak = createAccounts({ db: handle, scrypt: { N: 512, r: 8, p: 1 } });
    await weak.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    const hashOf = () => (handle.db.prepare('SELECT password_hash FROM accounts').get() as { password_hash: string }).password_hash;
    assert.match(hashOf(), /^scrypt\$512\$/);
    const strong = createAccounts({ db: handle, scrypt: FAST });
    assert.equal((await strong.signIn({ email: 'a@b.co', password: 'wrong password here' })).ok, false);
    assert.match(hashOf(), /^scrypt\$512\$/);
    assert.equal((await strong.signIn({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, true);
    assert.match(hashOf(), /^scrypt\$1024\$/);
    assert.equal((await strong.signIn({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, true);
  });

  it('stores, merges, clears and isolates memory per account', async () => {
    let t = 500;
    const { accounts } = makeAccounts({ now: () => t });
    const a = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    const b = await accounts.signUp({ email: 'b@b.co', password: GOOD_PASSWORD });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    assert.deepEqual(accounts.getMemory(a.account.id), emptyMemory());
    const saved = accounts.saveMemory(a.account.id, { department: 'women', sizes: { top: 'M' }, facts: ['Likes green'] });
    assert.deepEqual(saved, { department: 'women', sizes: { top: 'M' }, facts: ['Likes green'], updated_at: 500 });

    t = 900;
    const merged = accounts.saveMemory(a.account.id, { sizes: { shoes: '8' }, facts: [`Hates wool${String.fromCodePoint(0)}`] });
    assert.deepEqual(merged, {
      department: 'women',
      sizes: { top: 'M', shoes: '8' },
      facts: ['Likes green', 'Hates wool'],
      updated_at: 900,
    });
    assert.deepEqual(accounts.getMemory(a.account.id), merged);
    assert.deepEqual(accounts.getMemory(b.account.id), emptyMemory());

    accounts.clearMemory(a.account.id);
    assert.deepEqual(accounts.getMemory(a.account.id), emptyMemory());
    assert.throws(() => accounts.saveMemory('no-such-account', { facts: ['x'] }), /no such account/);
    assert.deepEqual(accounts.getMemory("x' OR '1'='1"), emptyMemory());
  });

  it('deletes an account with its sessions and memory, and frees the address', async () => {
    const { accounts, raw } = makeAccounts();
    const up = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(up.ok);
    if (!up.ok) return;
    accounts.saveMemory(up.account.id, { facts: ['Likes green'] });
    assert.equal(accounts.deleteAccount(up.account.id), true);
    assert.equal(accounts.deleteAccount(up.account.id), false);
    assert.equal(accounts.sessionAccount(up.session.token), null);
    assert.equal((await accounts.signIn({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, false);
    for (const table of ['accounts', 'sessions', 'memory']) {
      assert.equal((raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
    assert.equal((await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD })).ok, true);
  });

  it('updates the display name through the same cleaning rules', async () => {
    const { accounts } = makeAccounts();
    const up = await accounts.signUp({ email: 'a@b.co', password: GOOD_PASSWORD });
    assert.ok(up.ok);
    if (!up.ok) return;
    assert.equal(accounts.setDisplayName(up.account.id, '  Priya\n ')?.display_name, 'Priya');
    assert.equal(accounts.setDisplayName(up.account.id, '')?.display_name, null);
    assert.equal(accounts.setDisplayName('missing', 'x'), null);
  });
});
