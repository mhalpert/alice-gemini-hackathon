import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createAliceServer } from '../server.ts';
import { decodeCallMemory } from '../src/accounts/call-memory.ts';
import { openAccountsDb } from '../src/accounts/db.ts';
import { clearedCookieHeader, isAccountsEnabled, readCookie, sessionCookieHeader } from '../src/accounts/http.ts';
import { createAccounts, type Accounts } from '../src/accounts/index.ts';

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const EMAIL = 'priya@example.com';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  text: string;
}

interface Harness {
  baseUrl: string;
  port: number;
  accounts: Accounts;
  logs: { room: string; ev: string; data: unknown }[];
  /** Mints a call token as this signed-in browser and returns the save ticket inside it. */
  ticket(cookie: string): Promise<string>;
  call(
    method: string,
    pathname: string,
    opts?: { body?: unknown; rawBody?: string; headers?: Record<string, string>; cookie?: string },
  ): Promise<Reply>;
}

function cookieFrom(reply: Reply): string {
  const set = reply.headers['set-cookie'];
  assert.ok(Array.isArray(set) && set.length === 1, 'expected exactly one Set-Cookie header');
  return set[0]!.split(';')[0]!;
}

async function withAccountsServer(
  options: {
    env?: Record<string, string | undefined>;
    injectAccounts?: boolean;
    now?: () => number;
    hashConcurrency?: number;
    hashQueue?: number;
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-acct-public-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><h1>Alice</h1>');
  const logs: Harness['logs'] = [];
  const accounts = createAccounts({
    db: openAccountsDb({ path: ':memory:' }),
    scrypt: FAST,
    now: options.now,
    hashConcurrency: options.hashConcurrency,
    hashQueue: options.hashQueue,
  });
  const env = { ALICE_ACCOUNTS: 'on', ...LIVEKIT_ENV, ...(options.env ?? {}) };
  const server = createAliceServer({
    publicDir,
    tryonDir: publicDir,
    env,
    now: options.now,
    // Tests pick the visitor's network address with a header; default is the real socket.
    remoteAddress: (req) => (typeof req.headers['x-test-ip'] === 'string' ? req.headers['x-test-ip'] : req.socket.remoteAddress),
    calllog: (room: string, ev: string, data?: unknown) => {
      logs.push({ room, ev, data });
    },
    ...(options.injectAccounts === false ? {} : { accounts }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const call: Harness['call'] = (method, pathname, opts = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (payload !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
      if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
      if (opts.cookie) headers.Cookie = opts.cookie;
      const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const ticket = async (cookie: string): Promise<string> => {
    const minted = await call('POST', '/api/token', { body: {}, cookie });
    assert.equal(minted.status, 200, 'token mint for a ticket');
    const note = decodeCallMemory(decodeJwtPayload(minted.json.token).roomConfig.agents[0].metadata);
    assert.ok(note?.ticket, 'a signed-in call gets a save ticket');
    return note.ticket;
  };

  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, port, accounts, logs, call, ticket });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
}

function decodeJwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

const LIVEKIT_ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'APItestkey',
  LIVEKIT_API_SECRET: 'x'.repeat(40),
};

describe('account cookie helpers', () => {
  it('parses the switch like the other on/off settings', () => {
    for (const on of ['on', ' ON ', '1', 'true', 'yes']) assert.equal(isAccountsEnabled({ ALICE_ACCOUNTS: on }), true);
    for (const off of [undefined, '', 'off', '0', 'no', 'maybe']) assert.equal(isAccountsEnabled({ ALICE_ACCOUNTS: off }), false);
  });

  it('reads one cookie out of a header and ignores odd input', () => {
    assert.equal(readCookie('a=1; alice_session=tok; b=2', 'alice_session'), 'tok');
    assert.equal(readCookie('alice_session_other=x; alice_session=tok', 'alice_session'), 'tok');
    assert.equal(readCookie('alice_session=', 'alice_session'), undefined);
    assert.equal(readCookie('nonsense', 'alice_session'), undefined);
    assert.equal(readCookie(undefined, 'alice_session'), undefined);
    assert.equal(readCookie(`alice_session=tok; pad=${'x'.repeat(9000)}`, 'alice_session'), undefined);
  });

  it('builds session and cleared cookies with the right attributes', () => {
    const set = sessionCookieHeader({ token: 'tok', expires_at: 61_000 }, 1_000, false);
    assert.equal(set, 'alice_session=tok; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    assert.match(sessionCookieHeader({ token: 'tok', expires_at: 61_000 }, 1_000, true), /; Secure$/);
    assert.equal(clearedCookieHeader(false), 'alice_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });
});

describe('/api/account routes', () => {
  it('do not exist unless ALICE_ACCOUNTS is on', async () => {
    await withAccountsServer({ env: { ALICE_ACCOUNTS: undefined } }, async ({ call }) => {
      assert.equal((await call('GET', '/api/account')).status, 404);
      assert.equal((await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } })).status, 404);
      assert.equal((await call('PUT', '/api/account/memory', { body: {} })).status, 404);
    });
    await withAccountsServer({ env: { ALICE_ACCOUNTS: 'off' } }, async ({ call }) => {
      assert.equal((await call('GET', '/api/account')).status, 404);
    });
  });

  it('report a signed-out visitor, then sign up and report the account', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const before = await call('GET', '/api/account');
      assert.equal(before.status, 200);
      assert.equal(before.headers['cache-control'], 'no-store');
      assert.deepEqual(before.json, { enabled: true, account: null, min_password_length: 10, shop_sign_in: false });

      const up = await call('POST', '/api/account/signup', {
        body: { email: ' Priya@Example.com ', password: PASSWORD, name: ' Priya ' },
      });
      assert.equal(up.status, 201);
      assert.equal(up.json.account.email, EMAIL);
      assert.equal(up.json.account.name, 'Priya');
      assert.deepEqual(up.json.memory, { department: null, sizes: {}, facts: [], updated_at: null });
      assert.ok(!JSON.stringify(up.json).includes(PASSWORD));
      assert.ok(!JSON.stringify(up.json).includes('password_hash'));
      assert.equal(up.json.account.provider, 'password');
      assert.ok(!('id' in up.json.account));

      const setCookie = up.headers['set-cookie']![0]!;
      assert.match(setCookie, /^alice_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);

      const me = await call('GET', '/api/account', { cookie: cookieFrom(up) });
      assert.equal(me.json.account.email, EMAIL);

      const stranger = await call('GET', '/api/account', { cookie: `alice_session=${'A'.repeat(43)}` });
      assert.equal(stranger.json.account, null);
    });
  });

  it('mark the cookie Secure when the browser came over HTTPS through a proxy', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const up = await call('POST', '/api/account/signup', {
        body: { email: EMAIL, password: PASSWORD },
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.match(up.headers['set-cookie']![0]!, /^__Host-alice_session=[A-Za-z0-9_-]{43}; Path=\/; .*; Secure$/);
      // Over HTTPS only the "__Host-" cookie counts: one without the prefix, which a page
      // on a sibling subdomain could have planted, is ignored.
      const token = up.headers['set-cookie']![0]!.split(';')[0]!.split('=')[1]!;
      const https = { 'X-Forwarded-Proto': 'https' };
      assert.equal((await call('GET', '/api/account', { cookie: `__Host-alice_session=${token}`, headers: https })).json.account.email, EMAIL);
      assert.equal((await call('GET', '/api/account', { cookie: `alice_session=${token}`, headers: https })).json.account, null);
    });
  });

  it('treat any host that is not this machine as HTTPS, so the session never travels in the clear', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const up = await call('POST', '/api/account/signup', {
        body: { email: EMAIL, password: PASSWORD },
        headers: { Host: 'alice.example' },
      });
      assert.equal(up.status, 201);
      assert.match(up.headers['set-cookie']![0]!, /^__Host-alice_session=.*; Secure$/);
    });
  });

  it('refuse bad sign-ups with a reason the page can show', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const bad = await call('POST', '/api/account/signup', { body: { email: 'nope', password: PASSWORD } });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'invalid_email');
      const weak = await call('POST', '/api/account/signup', { body: { email: EMAIL, password: 'short' } });
      assert.equal(weak.status, 400);
      assert.deepEqual(weak.json, { error: 'weak_password', problem: 'too_short', min_length: 10 });
      assert.equal(weak.headers['set-cookie'], undefined);
      assert.equal((await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } })).status, 201);
      const taken = await call('POST', '/api/account/signup', { body: { email: 'PRIYA@example.com', password: PASSWORD } });
      assert.equal(taken.status, 409);
      assert.equal(taken.json.error, 'email_taken');
    });
  });

  it('sign in, replace the old session, and sign out', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const up = await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      const first = cookieFrom(up);

      const wrong = await call('POST', '/api/account/signin', { body: { email: EMAIL, password: 'wrong password here' } });
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.json, { error: 'bad_credentials' });
      const unknown = await call('POST', '/api/account/signin', { body: { email: 'nobody@example.com', password: PASSWORD } });
      assert.deepEqual([unknown.status, unknown.json], [wrong.status, wrong.json]);

      const inReply = await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD }, cookie: first });
      assert.equal(inReply.status, 200);
      const second = cookieFrom(inReply);
      assert.notEqual(second, first);
      assert.equal((await call('GET', '/api/account', { cookie: first })).json.account, null);
      assert.equal((await call('GET', '/api/account', { cookie: second })).json.account.email, EMAIL);

      const out = await call('POST', '/api/account/signout', { body: {}, cookie: second });
      assert.equal(out.status, 200);
      assert.match(out.headers['set-cookie']![0]!, /^alice_session=; Path=\/; Max-Age=0;/);
      assert.equal((await call('GET', '/api/account', { cookie: second })).json.account, null);
      // Signing out twice, or with no session, is not an error.
      assert.equal((await call('POST', '/api/account/signout', { body: {} })).status, 200);
    });
  });

  it('refuse requests a cross-site page could make', async () => {
    await withAccountsServer({}, async ({ call, port, ticket }) => {
      const up = await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      const cookie = cookieFrom(up);
      const saveTicket = await ticket(cookie);
      const body = { ticket: saveTicket, facts: ['planted by another site'] };

      const foreignOrigin = await call('PUT', '/api/account/memory', { body, cookie, headers: { Origin: 'https://evil.example' } });
      assert.equal(foreignOrigin.status, 403);
      assert.equal(foreignOrigin.json.error, 'bad_origin');

      const crossSite = await call('PUT', '/api/account/memory', { body, cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(crossSite.status, 403);
      const sameSite = await call('DELETE', '/api/account', { body: {}, cookie, headers: { 'Sec-Fetch-Site': 'same-site' } });
      assert.equal(sameSite.status, 403);

      // A plain HTML form cannot send JSON, so anything else is turned away.
      const form = await call('PUT', '/api/account/memory', {
        rawBody: 'facts=planted',
        cookie,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(form.status, 415);
      const text = await call('POST', '/api/account/signout', { rawBody: '{}', cookie, headers: { 'Content-Type': 'text/plain' } });
      assert.equal(text.status, 415);

      // Nothing above changed anything, and the session is still alive.
      const me = await call('GET', '/api/account', { cookie });
      assert.deepEqual(me.json.memory.facts, []);

      // The page's own requests pass: same origin, with or without a proxy rewriting Host.
      const own = await call('PUT', '/api/account/memory', {
        body: { ticket: saveTicket, facts: ['Likes green'] },
        cookie,
        headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(own.status, 200);
      const proxied = await call('PUT', '/api/account/memory', {
        body: { ticket: saveTicket, facts: ['Hates wool'] },
        cookie: `__Host-${cookie}`,
        headers: { Origin: 'https://alice.example', 'X-Forwarded-Host': 'alice.example', 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(proxied.status, 200);
      const spoofed = await call('PUT', '/api/account/memory', {
        body: { ticket: saveTicket, facts: ['planted'] },
        cookie,
        headers: { Origin: 'https://evil.example', 'X-Forwarded-Host': 'alice.example' },
      });
      assert.equal(spoofed.status, 403);
    });
  });

  it('save, merge, show and forget what Alice remembers, for the signed-in shopper only', async () => {
    await withAccountsServer({}, async ({ call, ticket }) => {
      assert.equal((await call('PUT', '/api/account/memory', { body: { facts: ['x'] } })).status, 401);
      assert.equal((await call('DELETE', '/api/account/memory', { body: {} })).status, 401);
      assert.equal((await call('DELETE', '/api/account', { body: {} })).status, 401);

      const a = cookieFrom(await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } }));
      const b = cookieFrom(await call('POST', '/api/account/signup', { body: { email: 'sam@example.com', password: PASSWORD } }));

      const ticketA = await ticket(a);
      const saved = await call('PUT', '/api/account/memory', {
        cookie: a,
        body: { ticket: ticketA, name: 'Priya', department: 'women', sizes: { Top: 'M', shoes: 8 }, facts: ['Likes green', '  '] },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.account.name, 'Priya');
      assert.equal(saved.json.memory.department, 'women');
      assert.deepEqual(saved.json.memory.sizes, { top: 'M', shoes: '8' });
      assert.deepEqual(saved.json.memory.facts, ['Likes green']);

      const merged = await call('PUT', '/api/account/memory', {
        cookie: a,
        body: { ticket: ticketA, name: '', department: 'kids', sizes: { bottom: '30' }, facts: ['Hates wool', 'likes green'] },
      });
      assert.equal(merged.json.account.name, 'Priya');
      // Alice fills in a missing name but never replaces one: a note about someone else
      // ("her name is Maya") must not rename the account.
      const renamed = await call('PUT', '/api/account/memory', { cookie: a, body: { ticket: ticketA, name: 'Maya' } });
      assert.equal(renamed.json.account.name, 'Priya');
      assert.equal(merged.json.memory.department, 'women');
      assert.deepEqual(merged.json.memory.sizes, { top: 'M', shoes: '8', bottom: '30' });
      assert.deepEqual(merged.json.memory.facts, ['Hates wool', 'likes green']);

      assert.deepEqual((await call('GET', '/api/account', { cookie: b })).json.memory.facts, []);

      const forgot = await call('DELETE', '/api/account/memory', { cookie: a, body: {} });
      assert.equal(forgot.status, 200);
      assert.deepEqual(forgot.json.memory, { department: null, sizes: {}, facts: [], updated_at: null });
      assert.equal((await call('GET', '/api/account', { cookie: a })).json.account.name, 'Priya');
    });
  });

  it('delete an account and everything stored with it', async () => {
    await withAccountsServer({}, async ({ call, accounts, ticket }) => {
      const cookie = cookieFrom(await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } }));
      await call('PUT', '/api/account/memory', { cookie, body: { ticket: await ticket(cookie), facts: ['Likes green'] } });
      const gone = await call('DELETE', '/api/account', { cookie, body: {} });
      assert.equal(gone.status, 200);
      assert.match(gone.headers['set-cookie']![0]!, /Max-Age=0/);
      assert.equal(accounts.countAccounts(), 0);
      assert.equal((await call('GET', '/api/account', { cookie })).json.account, null);
      assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD } })).status, 401);
    });
  });

  it('answer malformed requests without touching anything', async () => {
    await withAccountsServer({}, async ({ call, accounts }) => {
      assert.equal((await call('POST', '/api/account/signup', { rawBody: '{not json' })).status, 400);
      assert.equal((await call('POST', '/api/account/signup', { rawBody: '[]' })).status, 400);
      const huge = await call('POST', '/api/account/signup', { body: { email: EMAIL, password: 'p'.repeat(6000) } });
      assert.equal(huge.status, 413);
      const wrongMethod = await call('GET', '/api/account/signin');
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.allow, 'POST');
      assert.equal((await call('POST', '/api/account/memory', { body: {} })).headers.allow, 'PUT, DELETE');
      assert.equal((await call('GET', '/api/account/nope')).status, 404);
      assert.equal((await call('GET', '/api/accounts')).status, 404);
      assert.equal(accounts.countAccounts(), 0);
    });
  });

  it('slow down repeated sign-in failures for one address', async () => {
    await withAccountsServer({}, async ({ call }) => {
      await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      for (let i = 0; i < 8; i += 1) {
        const r = await call('POST', '/api/account/signin', { body: { email: EMAIL, password: `wrong password ${i}` } });
        assert.equal(r.status, 401, `attempt ${i + 1}`);
      }
      const blocked = await call('POST', '/api/account/signin', { body: { email: ' PRIYA@example.com', password: PASSWORD } });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error, 'slow_down');
      assert.ok(Number(blocked.headers['retry-after']) >= 1);
      // Another address is not affected.
      await call('POST', '/api/account/signup', { body: { email: 'sam@example.com', password: PASSWORD } });
      assert.equal((await call('POST', '/api/account/signin', { body: { email: 'sam@example.com', password: PASSWORD } })).status, 200);
    });
  });

  it('forget earlier failures after a successful sign-in, and unblock when the window ends', async () => {
    let t = 1_000_000;
    await withAccountsServer({ now: () => t }, async ({ call }) => {
      await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      for (let i = 0; i < 7; i += 1) await call('POST', '/api/account/signin', { body: { email: EMAIL, password: 'wrong password!' } });
      assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD } })).status, 200);
      for (let i = 0; i < 7; i += 1) {
        assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: 'wrong password!' } })).status, 401);
      }
      // 15 tries so far from this network address; its cap is 20 per 10 minutes.
      for (let i = 0; i < 5; i += 1) await call('POST', '/api/account/signin', { body: { email: `other${i}@example.com`, password: PASSWORD } });
      assert.equal((await call('POST', '/api/account/signin', { body: { email: 'sam@example.com', password: PASSWORD } })).status, 429);
      t += 15 * 60_000 + 1;
      assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD } })).status, 200);
    });
  });

  it('cap sign-ups per address and in total', async () => {
    await withAccountsServer({}, async ({ call }) => {
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await call('POST', '/api/account/signup', { body: { email: `s${i}@example.com`, password: PASSWORD } })).status, 201);
      }
      const sixth = await call('POST', '/api/account/signup', { body: { email: 's5@example.com', password: PASSWORD } });
      assert.equal(sixth.status, 429);
    });
    await withAccountsServer({ env: { ALICE_ACCOUNTS_MAX: '1' } }, async ({ call }) => {
      assert.equal((await call('POST', '/api/account/signup', { body: { email: 'one@example.com', password: PASSWORD } })).status, 201);
      const full = await call('POST', '/api/account/signup', { body: { email: 'two@example.com', password: PASSWORD } });
      assert.equal(full.status, 503);
      assert.equal(full.json.error, 'accounts_full');
    });
  });

  it('do not let typos use up the sign-up allowance, but do stop someone probing for addresses', async () => {
    await withAccountsServer({}, async ({ call }) => {
      await call('POST', '/api/account/signup', { body: { email: 'taken@example.com', password: PASSWORD } });
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await call('POST', '/api/account/signup', { body: { email: 'not-an-address', password: PASSWORD } })).status, 400);
      }
      assert.equal((await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } })).status, 201);
      // 8 refusals so far; 22 more "is this address taken?" probes reach the cap of 30 an hour.
      for (let i = 0; i < 22; i += 1) {
        assert.equal((await call('POST', '/api/account/signup', { body: { email: 'taken@example.com', password: PASSWORD } })).status, 409);
      }
      const probe = await call('POST', '/api/account/signup', { body: { email: 'taken@example.com', password: PASSWORD } });
      assert.equal(probe.status, 429);
      assert.ok(Number(probe.headers['retry-after']) >= 1);
    });
  });

  it('answer "busy" instead of queueing without end when sign-ins flood in', async () => {
    await withAccountsServer({ hashConcurrency: 1, hashQueue: 1 }, async ({ call }) => {
      await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD } })),
      );
      const statuses = replies.map((r) => r.status);
      assert.ok(statuses.includes(200), `some succeed: ${statuses}`);
      assert.ok(statuses.includes(503), `some are told busy: ${statuses}`);
      const busy = replies.find((r) => r.status === 503)!;
      assert.equal(busy.json.error, 'busy');
      assert.equal(busy.headers['retry-after'], '5');
      assert.ok(statuses.every((s) => s === 200 || s === 503));
    });
  });

  it('only accept a memory save from the call its own account started', async () => {
    await withAccountsServer({}, async ({ call, ticket }) => {
      const a = cookieFrom(await call('POST', '/api/account/signup', { body: { email: 'a@example.com', password: PASSWORD, name: 'Ana' } }));
      const b = cookieFrom(await call('POST', '/api/account/signup', { body: { email: 'b@example.com', password: PASSWORD, name: 'Bo' } }));
      const ticketA = await ticket(a);
      const fromAnasCall = { ticket: ticketA, department: 'women', sizes: { top: 'M' }, facts: ['Ana likes green'] };

      // Ana's call is still running in one tab; in another tab this browser is now Bo.
      const crossed = await call('PUT', '/api/account/memory', { cookie: b, body: fromAnasCall });
      assert.equal(crossed.status, 403);
      assert.equal(crossed.json.error, 'wrong_call');
      assert.deepEqual((await call('GET', '/api/account', { cookie: b })).json.memory.facts, []);

      // No ticket, a made-up one, or a stranger's room sending saves: all refused.
      for (const bad of [undefined, '', 'A'.repeat(32), 42, { ticket: ticketA }]) {
        const r = await call('PUT', '/api/account/memory', { cookie: a, body: { ticket: bad, facts: ['planted'] } });
        assert.equal(r.status, 403, `ticket ${JSON.stringify(bad)}`);
      }

      // The right pair works.
      assert.equal((await call('PUT', '/api/account/memory', { cookie: a, body: fromAnasCall })).status, 200);

      // "Forget everything" also stops the call in progress from saving it all back.
      assert.equal((await call('DELETE', '/api/account/memory', { cookie: a, body: {} })).status, 200);
      assert.equal((await call('PUT', '/api/account/memory', { cookie: a, body: fromAnasCall })).status, 403);
      assert.deepEqual((await call('GET', '/api/account', { cookie: a })).json.memory.facts, []);
      // Her next call gets a new ticket and saves normally.
      assert.equal((await call('PUT', '/api/account/memory', { cookie: a, body: { ...fromAnasCall, ticket: await ticket(a) } })).status, 200);
    });
  });

  it('keep a call\'s saves working across a server restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-acct-restart-'));
    const env = { ALICE_DB_PATH: path.join(dir, 'alice.db') };
    let cookie = '';
    let saveTicket = '';
    await withAccountsServer({ env, injectAccounts: false }, async ({ call, ticket }) => {
      cookie = cookieFrom(await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } }));
      saveTicket = await ticket(cookie);
    });
    // A new process on the same database file, as after a redeploy mid-call.
    await withAccountsServer({ env, injectAccounts: false }, async ({ call }) => {
      const saved = await call('PUT', '/api/account/memory', { cookie, body: { ticket: saveTicket, facts: ['Learned before the restart'] } });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json.memory.facts, ['Learned before the restart']);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('end the session a browser had when it creates a different account', async () => {
    await withAccountsServer({}, async ({ call }) => {
      const a = cookieFrom(await call('POST', '/api/account/signup', { body: { email: 'a@example.com', password: PASSWORD } }));
      const b = cookieFrom(await call('POST', '/api/account/signup', { body: { email: 'b@example.com', password: PASSWORD }, cookie: a }));
      assert.equal((await call('GET', '/api/account', { cookie: b })).json.account.email, 'b@example.com');
      assert.equal((await call('GET', '/api/account', { cookie: a })).json.account, null, 'the first session is over');
      // A refused sign-up leaves the current session alone.
      const refused = await call('POST', '/api/account/signup', { body: { email: 'b@example.com', password: PASSWORD }, cookie: b });
      assert.equal(refused.status, 409);
      assert.equal((await call('GET', '/api/account', { cookie: b })).json.account.email, 'b@example.com');
    });
  });

  it('do not let memory from a deleted account come back under the same address', async () => {
    await withAccountsServer({}, async ({ call, ticket }) => {
      const first = cookieFrom(await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } }));
      const oldTicket = await ticket(first);
      await call('DELETE', '/api/account', { cookie: first, body: {} });
      const second = cookieFrom(await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } }));
      const replay = await call('PUT', '/api/account/memory', { cookie: second, body: { ticket: oldTicket, facts: ['from the deleted account'] } });
      assert.equal(replay.status, 403);
      assert.deepEqual((await call('GET', '/api/account', { cookie: second })).json.memory.facts, []);
    });
  });

  it('do not let a stranger lock an owner out by guessing at their address', async () => {
    await withAccountsServer({}, async ({ call }) => {
      await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD } });
      const stranger = { 'X-Test-Ip': '203.0.113.9' };
      const owner = { 'X-Test-Ip': '198.51.100.7' };
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: `guess number ${i}` }, headers: stranger })).status, 401);
      }
      assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD }, headers: stranger })).status, 429, 'the guesser is stopped');
      assert.equal((await call('POST', '/api/account/signin', { body: { email: EMAIL, password: PASSWORD }, headers: owner })).status, 200, 'the owner still gets in');
    });
  });

  it('count guesses and sign-ups before the slow part, so a burst cannot outrun the limits', async () => {
    await withAccountsServer({}, async ({ call, accounts }) => {
      await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD }, headers: { 'X-Test-Ip': '192.0.2.1' } });
      const guesses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          call('POST', '/api/account/signin', { body: { email: EMAIL, password: `parallel guess ${i}` }, headers: { 'X-Test-Ip': '203.0.113.9' } }),
        ),
      );
      const checked = guesses.filter((r) => r.status === 401).length;
      assert.ok(checked <= 8, `at most 8 guesses reach the password check, got ${checked}`);
      assert.ok(guesses.every((r) => r.status === 401 || r.status === 429 || r.status === 503));

      const before = accounts.countAccounts();
      const signUps = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          call('POST', '/api/account/signup', { body: { email: `burst${i}@example.com`, password: PASSWORD }, headers: { 'X-Test-Ip': '203.0.113.50' } }),
        ),
      );
      assert.ok(accounts.countAccounts() - before <= 5, `at most 5 accounts an hour per address, got ${accounts.countAccounts() - before}`);
      assert.ok(signUps.every((r) => [201, 429, 503].includes(r.status)));
    });
    await withAccountsServer({ env: { ALICE_ACCOUNTS_MAX: '3' } }, async ({ call, accounts }) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call('POST', '/api/account/signup', { body: { email: `cap${i}@example.com`, password: PASSWORD }, headers: { 'X-Test-Ip': `192.0.2.${i + 10}` } }),
        ),
      );
      assert.ok(accounts.countAccounts() <= 3, `the total cap holds under a burst, got ${accounts.countAccounts()}`);
    });
  });

  it('never write an email address, a password or a session token to the server log', async () => {
    await withAccountsServer({}, async ({ call, logs, ticket }) => {
      const up = await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD, name: 'Priya' } });
      const cookie = cookieFrom(up);
      const saveTicket = await ticket(cookie);
      await call('POST', '/api/account/signin', { body: { email: EMAIL, password: 'wrong password here' } });
      const saved = await call('PUT', '/api/account/memory', { cookie, body: { ticket: saveTicket, facts: ['Likes green linen'] } });
      assert.equal(saved.status, 200);
      await call('DELETE', '/api/account', { cookie, body: {} });
      const dump = JSON.stringify(logs);
      assert.ok(logs.some((l) => l.ev === 'account'));
      for (const secret of [EMAIL, 'priya', PASSWORD, 'wrong password here', cookie.split('=')[1]!, 'Likes green linen', saveTicket]) {
        assert.ok(!dump.includes(secret), `log must not contain ${secret}`);
      }
    });
  });
});

describe('call token with accounts', () => {
  it('carries a signed-in shopper\'s name and memory to the agent, signed inside the token', async () => {
    await withAccountsServer({ env: LIVEKIT_ENV }, async ({ call, ticket }) => {
      const cookie = cookieFrom(
        await call('POST', '/api/account/signup', { body: { email: EMAIL, password: PASSWORD, name: 'Priya' } }),
      );
      const facts = Array.from({ length: 30 }, (_, i) => `note ${i}`);
      await call('PUT', '/api/account/memory', { cookie, body: { ticket: await ticket(cookie), department: 'women', sizes: { top: 'M' }, facts } });

      const minted = await call('POST', '/api/token', { body: {}, cookie });
      assert.equal(minted.status, 200);
      const payload = decodeJwtPayload(minted.json.token);
      assert.equal(payload.name, 'Priya');
      assert.equal(payload.roomConfig.agents[0].agentName, 'alice');
      const note = decodeCallMemory(payload.roomConfig.agents[0].metadata);
      assert.ok(note);
      assert.equal(note.accounts, true);
      assert.equal(note.shopper?.name, 'Priya');
      assert.equal(note.shopper?.department, 'women');
      assert.deepEqual(note.shopper?.sizes, { top: 'M' });
      // The agent keeps 20 notes per call, so the newest 20 travel.
      assert.equal(note.shopper?.facts.length, 20);
      assert.equal(note.shopper?.facts.at(-1), 'note 29');
      assert.match(note.ticket ?? '', /^[A-Za-z0-9_-]{32}$/, 'a ticket ties saves from this call to this account');
      // Nothing that identifies the account is in the token.
      assert.ok(!minted.json.token.includes(EMAIL));
      assert.ok(!JSON.stringify(payload).includes(EMAIL));
      assert.ok(!JSON.stringify(payload).includes('alice_session'));

      // A name typed on the call page still wins over the saved one.
      const typed = await call('POST', '/api/token', { body: { name: 'P' }, cookie });
      assert.equal(decodeJwtPayload(typed.json.token).name, 'P');
    });
  });

  it('tells the agent accounts are on but nobody is signed in', async () => {
    await withAccountsServer({ env: LIVEKIT_ENV }, async ({ call }) => {
      const minted = await call('POST', '/api/token', { body: {} });
      assert.equal(minted.status, 200);
      const payload = decodeJwtPayload(minted.json.token);
      assert.equal(payload.name, 'Shopper');
      assert.deepEqual(decodeCallMemory(payload.roomConfig.agents[0].metadata), { v: 1, accounts: true, shopper: null, ticket: null });

      const stale = await call('POST', '/api/token', { body: {}, cookie: `alice_session=${'B'.repeat(43)}` });
      assert.equal(decodeCallMemory(decodeJwtPayload(stale.json.token).roomConfig.agents[0].metadata)?.shopper, null);
    });
  });

  it('is unchanged when accounts are off', async () => {
    await withAccountsServer({ env: { ...LIVEKIT_ENV, ALICE_ACCOUNTS: undefined } }, async ({ call }) => {
      const minted = await call('POST', '/api/token', { body: {}, cookie: `alice_session=${'B'.repeat(43)}` });
      assert.equal(minted.status, 200);
      const agent = decodeJwtPayload(minted.json.token).roomConfig.agents[0];
      assert.equal(agent.agentName, 'alice');
      assert.ok(!agent.metadata, 'no dispatch metadata when accounts are off');
    });
  });

  it('still mints a call when the accounts database cannot be opened', async () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alice-acct-bad-')), 'a-file');
    fs.writeFileSync(blocker, 'not a folder');
    await withAccountsServer(
      { env: { ...LIVEKIT_ENV, ALICE_DB_PATH: path.join(blocker, 'alice.db') }, injectAccounts: false },
      async ({ call, logs }) => {
        const me = await call('GET', '/api/account');
        assert.equal(me.status, 503);
        assert.equal(me.json.error, 'accounts_unavailable');
        const minted = await call('POST', '/api/token', { body: {} });
        assert.equal(minted.status, 200);
        assert.equal(decodeCallMemory(decodeJwtPayload(minted.json.token).roomConfig.agents[0].metadata)?.shopper, null);
        assert.ok(logs.some((l) => l.ev === 'account_error'));
      },
    );
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  });

  it('creates the database file on first use when none is injected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-acct-file-'));
    const file = path.join(dir, 'alice.db');
    await withAccountsServer({ env: { ALICE_DB_PATH: file }, injectAccounts: false }, async ({ call }) => {
      assert.equal(fs.existsSync(file), false);
      assert.equal((await call('GET', '/api/account')).status, 200);
      assert.equal(fs.existsSync(file), true);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
