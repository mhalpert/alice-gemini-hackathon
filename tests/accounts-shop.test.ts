import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createAliceServer } from '../server.ts';
import { openAccountsDb } from '../src/accounts/db.ts';
import { createAccounts } from '../src/accounts/index.ts';
import {
  createShopSignIn,
  isShopSignInEnabled,
  isShopVerificationUrl,
  SHOP_ISSUER,
  SHOP_SIGNIN_CLIENT_ID,
  type ShopSignIn,
} from '../src/accounts/shop-signin.ts';

// A stand-in for Shop's sign-in service: its own signing key, a device endpoint, a token
// endpoint that answers from a script, and the published key set. Nothing here touches
// the network.
function makeFakeShop(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const calls: { url: string; body: string }[] = [];
  const tokenScript: Array<Record<string, unknown>> = [];
  let deviceReply: Record<string, unknown> = {
    device_code: 'device-code-secret',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://accounts.shop.app/activate',
    verification_uri_complete: 'https://accounts.shop.app/activate?user_code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  };
  let keys: Record<string, unknown>[] = [jwk];

  function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid, typ: 'JWT' }, key = privateKey): string {
    const head = Buffer.from(JSON.stringify(header)).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${signature}`;
  }

  function idToken(overrides: Record<string, unknown> = {}): string {
    const nowS = Math.floor(now() / 1000);
    return sign({
      iss: SHOP_ISSUER,
      aud: SHOP_SIGNIN_CLIENT_ID,
      sub: 'shop-user-123',
      email: 'Priya@Example.com',
      email_verified: true,
      given_name: 'Priya',
      iat: nowS,
      exp: nowS + 300,
      ...overrides,
    });
  }

  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/oauth/device')) return json(200, deviceReply);
    if (url.endsWith('/auth/jwks')) return json(200, { keys });
    if (url.endsWith('/oauth/token')) {
      const next = tokenScript.shift() ?? { error: 'authorization_pending' };
      if (next.__throw) throw new Error('network down');
      if (typeof next.__status === 'number') {
        return new Response(typeof next.__body === 'string' ? next.__body : '{}', { status: next.__status });
      }
      return json(next.error ? 400 : 200, next);
    }
    return json(404, {});
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    tokenScript,
    idToken,
    sign,
    kid,
    setDeviceReply: (reply: Record<string, unknown>) => { deviceReply = reply; },
    setKeys: (next: Record<string, unknown>[]) => { keys = next; },
    approve: (overrides?: Record<string, unknown>) => tokenScript.push({ access_token: 'access-token-secret', token_type: 'Bearer', expires_in: 3600, id_token: idToken(overrides) }),
    tokenCalls: () => calls.filter((c) => c.url.endsWith('/oauth/token')).length,
    jwksCalls: () => calls.filter((c) => c.url.endsWith('/auth/jwks')).length,
  };
}

describe('sign in with Shop: the flow', () => {
  it('is off unless ALICE_ACCOUNTS_SHOP is on, and only hands out links to Shop itself', () => {
    assert.equal(isShopSignInEnabled({}), false);
    assert.equal(isShopSignInEnabled({ ALICE_ACCOUNTS_SHOP: 'off' }), false);
    assert.equal(isShopSignInEnabled({ ALICE_ACCOUNTS_SHOP: ' On ' }), true);
    for (const good of ['https://accounts.shop.app/activate?user_code=AB', 'https://shop.app/x', 'https://shop.com/activate']) {
      assert.equal(isShopVerificationUrl(good), true, good);
    }
    for (const bad of ['http://accounts.shop.app/activate', 'https://accounts.shop.app.evil.example/x', 'https://evilshop.app/x', 'https://user:pw@accounts.shop.app/x', 'javascript:alert(1)', '', null, 7]) {
      assert.equal(isShopVerificationUrl(bad), false, String(bad));
    }
  });

  it('starts, waits at Shop\'s pace, and signs in when the shopper approves', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const logs: unknown[] = [];
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t, log: (ev, data) => logs.push({ ev, data }) });

    const started = await flow.start();
    assert.ok(started.ok);
    if (!started.ok) return;
    assert.equal(started.url, 'https://accounts.shop.app/activate?user_code=ABCD-EFGH');
    assert.equal(started.code, 'ABCD-EFGH');
    assert.equal(started.interval_s, 5);
    assert.match(started.flow_id, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(started).includes('device-code-secret'), 'the device code never leaves the server');
    const deviceCall = new URLSearchParams(shop.calls[0]!.body);
    assert.equal(deviceCall.get('client_id'), SHOP_SIGNIN_CLIENT_ID);
    assert.equal(deviceCall.get('scope'), 'openid email personal_agent');
    assert.equal(deviceCall.get('resource'), 'https://mcp.shop.com');

    // Asked again too soon: we answer "pending" ourselves and do not bother Shop.
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'pending', interval_s: 5 });
    assert.equal(shop.tokenCalls(), 0);

    t += 5_000;
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'pending', interval_s: 5 });
    assert.equal(shop.tokenCalls(), 1);

    shop.tokenScript.push({ error: 'slow_down' });
    t += 5_000;
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'pending', interval_s: 10 });
    t += 5_000;
    await flow.poll(started.flow_id);
    assert.equal(shop.tokenCalls(), 2, 'the longer wait Shop asked for is respected');

    shop.approve();
    t += 5_000;
    const done = await flow.poll(started.flow_id);
    assert.deepEqual(done, {
      status: 'signed_in',
      identity: { sub: 'shop-user-123', email: 'priya@example.com', email_verified: true, name: 'Priya' },
    });
    assert.equal(flow.pendingCount(), 0);
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'unknown_flow' }, 'a sign-in can be used once');

    const dump = JSON.stringify(logs);
    for (const secret of ['device-code-secret', 'access-token-secret', 'priya', 'shop-user-123']) {
      assert.ok(!dump.includes(secret), `log must not contain ${secret}`);
    }
  });

  it('shares one request to Shop between two polls made at the same moment', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    const started = await flow.start();
    assert.ok(started.ok);
    if (!started.ok) return;
    shop.approve();
    t += 5_000;
    const [a, b] = await Promise.all([flow.poll(started.flow_id), flow.poll(started.flow_id)]);
    assert.equal(a.status, 'signed_in');
    assert.deepEqual(a, b);
    assert.equal(shop.tokenCalls(), 1);
  });

  it('ends cleanly when the shopper says no, the code runs out, or it is cancelled', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });

    const denied = await flow.start();
    assert.ok(denied.ok);
    if (!denied.ok) return;
    shop.tokenScript.push({ error: 'access_denied' });
    t += 5_000;
    assert.deepEqual(await flow.poll(denied.flow_id), { status: 'denied' });
    assert.deepEqual(await flow.poll(denied.flow_id), { status: 'unknown_flow' });

    const expiredAtShop = await flow.start();
    assert.ok(expiredAtShop.ok);
    if (!expiredAtShop.ok) return;
    shop.tokenScript.push({ error: 'expired_token' });
    t += 5_000;
    assert.deepEqual(await flow.poll(expiredAtShop.flow_id), { status: 'expired' });

    const timedOut = await flow.start();
    assert.ok(timedOut.ok);
    if (!timedOut.ok) return;
    const before = shop.tokenCalls();
    t += 600_000;
    assert.deepEqual(await flow.poll(timedOut.flow_id), { status: 'expired' });
    assert.equal(shop.tokenCalls(), before, 'an expired sign-in is not sent to Shop');

    const cancelled = await flow.start();
    assert.ok(cancelled.ok);
    if (!cancelled.ok) return;
    flow.cancel(cancelled.flow_id);
    assert.deepEqual(await flow.poll(cancelled.flow_id), { status: 'unknown_flow' });
    for (const odd of [undefined, null, '', 42, {}]) assert.deepEqual(await flow.poll(odd), { status: 'unknown_flow' });
  });

  it('keeps waiting through a network hiccup', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    const started = await flow.start();
    assert.ok(started.ok);
    if (!started.ok) return;
    shop.tokenScript.push({ __throw: true });
    t += 5_000;
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'pending', interval_s: 5 });
    shop.approve();
    t += 5_000;
    assert.equal((await flow.poll(started.flow_id)).status, 'signed_in');
  });

  it('keeps waiting when Shop itself has a bad moment', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const logs: string[] = [];
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t, log: (_ev, data) => logs.push(String(data?.result ?? '')) });
    const started = await flow.start();
    assert.ok(started.ok);
    if (!started.ok) return;
    const badMoments = [
      { __status: 502, __body: '<html>Bad Gateway</html>' },
      { __status: 503 },
      { __status: 429 },
      { __status: 200, __body: 'not json at all' },
    ];
    for (const moment of badMoments) {
      shop.tokenScript.push(moment);
      t += 5_000;
      assert.deepEqual(await flow.poll(started.flow_id), { status: 'pending', interval_s: 5 }, JSON.stringify(moment));
      assert.equal(flow.pendingCount(), 1, 'the sign-in is still alive');
    }
    assert.equal(logs.filter((r) => r === 'retry').length, badMoments.length);
    // The shopper's approval, a moment later, still lands.
    shop.approve();
    t += 5_000;
    assert.equal((await flow.poll(started.flow_id)).status, 'signed_in');
  });

  it('refuses an identity it cannot verify', async () => {
    let t = 1_000_000_000_000;
    const nowS = () => Math.floor(t / 1000);
    const shop = makeFakeShop({ now: () => t });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: shop.kid })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ iss: SHOP_ISSUER, aud: SHOP_SIGNIN_CLIENT_ID, sub: 'attacker', exp: nowS() + 300 }),
    ).toString('base64url')}.`;
    const hs256 = (() => {
      const head = Buffer.from(JSON.stringify({ alg: 'HS256', kid: shop.kid })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: SHOP_ISSUER, aud: SHOP_SIGNIN_CLIENT_ID, sub: 'attacker', exp: nowS() + 300 })).toString('base64url');
      const mac = crypto.createHmac('sha256', 'guess').update(`${head}.${body}`).digest('base64url');
      return `${head}.${body}.${mac}`;
    })();
    const goodClaims = { iss: SHOP_ISSUER, aud: SHOP_SIGNIN_CLIENT_ID, sub: 'attacker', exp: nowS() + 300 };

    const cases: Array<[string, Record<string, unknown>]> = [
      ['no id token at all', { access_token: 'x' }],
      ['not a token', { id_token: 'garbage' }],
      ['unsigned (alg none)', { id_token: unsigned }],
      ['shared-secret algorithm', { id_token: hs256 }],
      ['signed by someone else', { id_token: shop.sign(goodClaims, { alg: 'RS256', kid: shop.kid }, other.privateKey) }],
      ['unknown key id', { id_token: shop.sign(goodClaims, { alg: 'RS256', kid: 'nope' }) }],
      ['wrong issuer', { id_token: shop.idToken({ iss: 'https://accounts.evil.example' }) }],
      ['meant for another app', { id_token: shop.idToken({ aud: 'some-other-client' }) }],
      ['expired', { id_token: shop.idToken({ exp: nowS() - 3600 }) }],
      ['issued in the future', { id_token: shop.idToken({ iat: nowS() + 3600 }) }],
      ['no subject', { id_token: shop.idToken({ sub: '' }) }],
      ['huge token', { id_token: 'a'.repeat(20_000) }],
    ];
    for (const [label, tokenReply] of cases) {
      const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
      const started = await flow.start();
      assert.ok(started.ok);
      if (!started.ok) return;
      shop.tokenScript.push(tokenReply);
      t += 5_000;
      assert.deepEqual(await flow.poll(started.flow_id), { status: 'failed' }, label);
      assert.equal(flow.pendingCount(), 0, `${label}: the sign-in is over`);
    }

    // Tampering with a real token's contents breaks its signature.
    const real = shop.idToken();
    const [h, , s] = real.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: SHOP_ISSUER, aud: SHOP_SIGNIN_CLIENT_ID, sub: 'someone-else', exp: nowS() + 300 })).toString('base64url')}.${s}`;
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    const started = await flow.start();
    assert.ok(started.ok);
    if (!started.ok) return;
    shop.tokenScript.push({ id_token: forged });
    t += 5_000;
    assert.deepEqual(await flow.poll(started.flow_id), { status: 'failed' });
  });

  it('fetches Shop\'s keys once, and again only when a new key id shows up', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    for (let i = 0; i < 3; i += 1) {
      const started = await flow.start();
      assert.ok(started.ok);
      if (!started.ok) return;
      shop.approve({ sub: `user-${i}` });
      t += 5_000;
      assert.equal((await flow.poll(started.flow_id)).status, 'signed_in');
    }
    assert.equal(shop.jwksCalls(), 1);
    t += 61 * 60_000;
    const later = await flow.start();
    assert.ok(later.ok);
    if (!later.ok) return;
    shop.approve();
    t += 5_000;
    await flow.poll(later.flow_id);
    assert.equal(shop.jwksCalls(), 2, 'refreshed after an hour');
  });

  it('refuses to start when Shop answers oddly or too many sign-ins are waiting', async () => {
    const shop = makeFakeShop();
    const flow = createShopSignIn({ fetch: shop.fetchImpl, maxPending: 2 });
    shop.setDeviceReply({ device_code: 'x', verification_uri: 'https://evil.example/activate', expires_in: 600 });
    assert.deepEqual(await flow.start(), { ok: false, reason: 'unavailable' });
    shop.setDeviceReply({ verification_uri: 'https://accounts.shop.app/activate' });
    assert.deepEqual(await flow.start(), { ok: false, reason: 'unavailable' });
    shop.setDeviceReply({ device_code: 'x', verification_uri: 'https://accounts.shop.app/activate', user_code: 'AB-CD', expires_in: 99999, interval: 0 });
    const a = await flow.start();
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(a.expires_in_s, 900, 'an absurd lifetime is capped');
    assert.equal(a.interval_s, 1);
    assert.ok((await flow.start()).ok);
    assert.deepEqual(await flow.start(), { ok: false, reason: 'busy' });
    const broken = createShopSignIn({ fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    assert.deepEqual(await broken.start(), { ok: false, reason: 'unavailable' });
  });
});

describe('sign in with Shop: accounts', () => {
  it('creates the account once, then finds it again by Shop\'s id', () => {
    let t = 500;
    const accounts = createAccounts({ db: openAccountsDb({ path: ':memory:' }), now: () => t });
    const first = accounts.signInWithShop({ sub: 'shop-user-123', email: 'Priya@Example.com', name: 'Priya' });
    assert.ok(first.ok && first.created);
    if (!first.ok) return;
    assert.equal(first.account.provider, 'shop');
    assert.equal(first.account.email, 'priya@example.com');
    assert.equal(first.account.display_name, 'Priya');
    accounts.saveMemory(first.account.id, { facts: ['Likes green'] });
    accounts.setDisplayName(first.account.id, 'Pri');

    t = 900;
    const again = accounts.signInWithShop({ sub: 'shop-user-123', email: 'new@example.com', name: 'Priyanka' });
    assert.ok(again.ok && !again.created);
    if (!again.ok) return;
    assert.equal(again.account.id, first.account.id);
    assert.equal(again.account.email, 'new@example.com', 'the address follows Shop');
    assert.equal(again.account.display_name, 'Pri', 'a name the shopper set with Alice is kept');
    assert.deepEqual(accounts.getMemory(again.account.id).facts, ['Likes green']);
    assert.ok(accounts.sessionAccount(first.session.token));
    assert.ok(accounts.sessionAccount(again.session.token));
    assert.equal(accounts.countAccounts(), 1);
  });

  it('keeps a Shop account apart from a password account with the same address', async () => {
    const accounts = createAccounts({ db: openAccountsDb({ path: ':memory:' }), scrypt: { N: 1024, r: 8, p: 1 } });
    const password = await accounts.signUp({ email: 'priya@example.com', password: 'correct horse battery' });
    const shop = accounts.signInWithShop({ sub: 'shop-user-123', email: 'priya@example.com' });
    assert.ok(password.ok && shop.ok);
    if (!password.ok || !shop.ok) return;
    assert.notEqual(shop.account.id, password.account.id);
    assert.equal(accounts.countAccounts(), 2);
    // A Shop account has no password, so the password form can never open it.
    const tryPassword = await accounts.signIn({ email: 'priya@example.com', password: 'correct horse battery' });
    assert.ok(tryPassword.ok);
    if (tryPassword.ok) assert.equal(tryPassword.account.id, password.account.id);
  });

  it('refuses an unusable identity and respects the account cap', () => {
    const accounts = createAccounts({ db: openAccountsDb({ path: ':memory:' }) });
    for (const sub of ['', '   ', 'x'.repeat(300)]) {
      assert.deepEqual(accounts.signInWithShop({ sub }), { ok: false, code: 'invalid_identity' });
    }
    assert.ok(accounts.signInWithShop({ sub: 'a' }, { maxAccounts: 1 }).ok);
    assert.deepEqual(accounts.signInWithShop({ sub: 'b' }, { maxAccounts: 1 }), { ok: false, code: 'accounts_full' });
    assert.ok(accounts.signInWithShop({ sub: 'a' }, { maxAccounts: 1 }).ok, 'someone who already has an account still gets in');
    const noEmail = accounts.signInWithShop({ sub: 'c', email: 'not-an-address', name: `Zed${String.fromCodePoint(0)}` });
    assert.ok(noEmail.ok);
    if (noEmail.ok) assert.deepEqual([noEmail.account.email, noEmail.account.display_name], [null, 'Zed']);
  });
});

describe('sign in with Shop: the routes', () => {
  interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }

  async function withServer(
    env: Record<string, string | undefined>,
    shopSignIn: ShopSignIn | undefined,
    fn: (call: (method: string, pathname: string, opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }) => Promise<Reply>, accounts: ReturnType<typeof createAccounts>) => Promise<void>,
  ): Promise<void> {
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-shop-public-'));
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html>');
    const accounts = createAccounts({ db: openAccountsDb({ path: ':memory:' }) });
    const server = createAliceServer({ publicDir, tryonDir: publicDir, env, calllog: () => {}, accounts, ...(shopSignIn ? { shopSignIn } : {}) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, pathname: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
      new Promise<Reply>((resolve, reject) => {
        const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        if (payload !== undefined) {
          headers['Content-Type'] ??= 'application/json';
          headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        if (opts.cookie) headers.Cookie = opts.cookie;
        const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let json: any = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
          });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    try {
      await fn(call, accounts);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(publicDir, { recursive: true, force: true });
    }
  }

  const cookiePair = (reply: Reply, name: string): string | undefined =>
    (reply.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));

  it('do not exist unless both switches are on', async () => {
    const shop = makeFakeShop();
    const flow = createShopSignIn({ fetch: shop.fetchImpl });
    await withServer({ ALICE_ACCOUNTS: 'on' }, flow, async (call) => {
      assert.equal((await call('POST', '/api/account/shop/start', { body: {} })).status, 404);
      assert.equal((await call('GET', '/api/account')).json.shop_sign_in, false);
    });
    await withServer({ ALICE_ACCOUNTS_SHOP: 'on' }, flow, async (call) => {
      assert.equal((await call('POST', '/api/account/shop/start', { body: {} })).status, 404);
    });
    assert.equal(shop.calls.length, 0, 'Shop was never contacted');
  });

  it('sign a shopper in end to end, and the same shopper lands in the same account next time', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    await withServer({ ALICE_ACCOUNTS: 'on', ALICE_ACCOUNTS_SHOP: 'on' }, flow, async (call, accounts) => {
      assert.equal((await call('GET', '/api/account')).json.shop_sign_in, true);

      const started = await call('POST', '/api/account/shop/start', { body: {} });
      assert.equal(started.status, 200);
      assert.deepEqual(started.json, {
        status: 'pending',
        url: 'https://accounts.shop.app/activate?user_code=ABCD-EFGH',
        code: 'ABCD-EFGH',
        expires_in_s: 600,
        interval_s: 5,
      });
      const flowSet = started.headers['set-cookie']![0]!;
      assert.match(flowSet, /^alice_shop_flow=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
      const flowCookie = flowSet.split(';')[0]!;

      // Another browser, without the marker cookie, cannot collect this sign-in.
      t += 5_000;
      shop.approve();
      const stranger = await call('POST', '/api/account/shop/poll', { body: {} });
      assert.deepEqual(stranger.json, { status: 'unknown_flow' });
      assert.equal(cookiePair(stranger, 'alice_session'), undefined);

      const done = await call('POST', '/api/account/shop/poll', { body: {}, cookie: flowCookie });
      assert.equal(done.status, 200);
      assert.equal(done.json.status, 'signed_in');
      assert.equal(done.json.account.email, 'priya@example.com');
      assert.equal(done.json.account.name, 'Priya');
      assert.equal(done.json.account.provider, 'shop');
      assert.ok(!JSON.stringify(done.json).includes('shop-user-123'), 'Shop\'s id stays on the server');
      const session = cookiePair(done, 'alice_session');
      assert.ok(session);
      assert.equal(cookiePair(done, 'alice_shop_flow'), 'alice_shop_flow=', 'the spent marker is cleared');

      const signedIn = accounts.sessionAccount(session.split('=')[1]);
      assert.ok(signedIn);
      accounts.saveMemory(signedIn.id, { facts: ['Likes green'] });
      await call('POST', '/api/account/signout', { cookie: session, body: {} });

      // Second visit: same Shop shopper, same account, memory intact.
      const again = await call('POST', '/api/account/shop/start', { body: {} });
      const againCookie = again.headers['set-cookie']![0]!.split(';')[0]!;
      t += 5_000;
      shop.approve();
      const back = await call('POST', '/api/account/shop/poll', { body: {}, cookie: againCookie });
      assert.equal(back.json.status, 'signed_in');
      assert.deepEqual(back.json.memory.facts, ['Likes green']);
      assert.equal(accounts.countAccounts(), 1);
    });
  });

  it('use host-only cookies over HTTPS for both the pending sign-in and the session', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    await withServer({ ALICE_ACCOUNTS: 'on', ALICE_ACCOUNTS_SHOP: 'on' }, flow, async (call) => {
      const https = { 'X-Forwarded-Proto': 'https' };
      const started = await call('POST', '/api/account/shop/start', { body: {}, headers: https });
      const flowSet = started.headers['set-cookie']![0]!;
      assert.match(flowSet, /^__Host-alice_shop_flow=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
      const flowCookie = flowSet.split(';')[0]!;
      shop.approve();
      t += 5_000;
      // The same id under the plain name (which another subdomain could plant) is ignored.
      const planted = await call('POST', '/api/account/shop/poll', { body: {}, headers: https, cookie: flowCookie.replace('__Host-', '') });
      assert.deepEqual(planted.json, { status: 'unknown_flow' });
      const done = await call('POST', '/api/account/shop/poll', { body: {}, headers: https, cookie: flowCookie });
      assert.equal(done.json.status, 'signed_in');
      assert.ok(cookiePair(done, '__Host-alice_session'));
      assert.equal(cookiePair(done, '__Host-alice_shop_flow'), '__Host-alice_shop_flow=');
    });
  });

  it('report waiting, refusal and cancel, and guard against cross-site requests', async () => {
    let t = 1_000_000_000_000;
    const shop = makeFakeShop({ now: () => t });
    const flow = createShopSignIn({ fetch: shop.fetchImpl, now: () => t });
    await withServer({ ALICE_ACCOUNTS: 'on', ALICE_ACCOUNTS_SHOP: 'on' }, flow, async (call, accounts) => {
      assert.equal((await call('POST', '/api/account/shop/start', { body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await call('POST', '/api/account/shop/poll', { body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await call('GET', '/api/account/shop/start')).status, 405);

      const started = await call('POST', '/api/account/shop/start', { body: {} });
      const cookie = started.headers['set-cookie']![0]!.split(';')[0]!;
      assert.deepEqual((await call('POST', '/api/account/shop/poll', { body: {}, cookie })).json, { status: 'pending', interval_s: 5 });

      shop.tokenScript.push({ error: 'access_denied' });
      t += 5_000;
      const denied = await call('POST', '/api/account/shop/poll', { body: {}, cookie });
      assert.deepEqual(denied.json, { status: 'denied' });
      assert.equal(cookiePair(denied, 'alice_shop_flow'), 'alice_shop_flow=');

      const second = await call('POST', '/api/account/shop/start', { body: {} });
      const secondCookie = second.headers['set-cookie']![0]!.split(';')[0]!;
      const cancelled = await call('POST', '/api/account/shop/cancel', { body: {}, cookie: secondCookie });
      assert.equal(cancelled.status, 200);
      assert.deepEqual((await call('POST', '/api/account/shop/poll', { body: {}, cookie: secondCookie })).json, { status: 'unknown_flow' });
      assert.equal(accounts.countAccounts(), 0);
    });
  });

  it('limit how often one address can start a sign-in, and say so when Shop is unreachable', async () => {
    const shop = makeFakeShop();
    const flow = createShopSignIn({ fetch: shop.fetchImpl });
    await withServer({ ALICE_ACCOUNTS: 'on', ALICE_ACCOUNTS_SHOP: 'on' }, flow, async (call) => {
      for (let i = 0; i < 6; i += 1) assert.equal((await call('POST', '/api/account/shop/start', { body: {} })).status, 200);
      assert.equal((await call('POST', '/api/account/shop/start', { body: {} })).status, 429);
    });
    const offline = createShopSignIn({ fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    await withServer({ ALICE_ACCOUNTS: 'on', ALICE_ACCOUNTS_SHOP: 'on' }, offline, async (call) => {
      const reply = await call('POST', '/api/account/shop/start', { body: {} });
      assert.equal(reply.status, 503);
      assert.equal(reply.json.error, 'shop_unavailable');
    });
  });
});
