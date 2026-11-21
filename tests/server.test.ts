import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAliceServer } from '../server.ts';

interface RawResponse {
  status: number;
  headers: string;
  body: string;
}

function rawHttpGet(port: number, rawPath: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const sep = raw.indexOf('\r\n\r\n');
      const headerPart = sep === -1 ? raw : raw.slice(0, sep);
      const body = sep === -1 ? '' : raw.slice(sep + 4);
      const statusLine = headerPart.split('\r\n')[0] ?? '';
      const match = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
      resolve({
        status: match ? Number(match[1]) : 0,
        headers: headerPart,
        body,
      });
    });
  });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  assert.equal(parts.length, 3, 'JWT must have 3 segments');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Alice server', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let publicDir: string;
  let tryonDir: string;
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const env: Record<string, string | undefined> = {};

  before(async () => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-public-'));
    tryonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-tryon-'));

    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><h1>Alice</h1>');
    fs.writeFileSync(path.join(publicDir, 'app.css'), 'body { margin: 0; }');
    fs.writeFileSync(path.join(publicDir, '.secret'), 'SUPER_SECRET_DOTFILE');

    fs.writeFileSync(path.join(tryonDir, 'look1.jpg'), fakeJpg);
    fs.writeFileSync(path.join(tryonDir, 'notes.txt'), 'not an image');

    server = createAliceServer({ publicDir, tryonDir, env });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(publicDir, { recursive: true, force: true });
    fs.rmSync(tryonDir, { recursive: true, force: true });
  });

  it('serves GET /healthz', async () => {
    delete env.LIVEKIT_URL;
    delete env.LIVEKIT_API_KEY;
    delete env.LIVEKIT_API_SECRET;
    delete env.ALICE_PASSCODE;
    delete env.ALICE_AGENT_NAME;

    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptime_s, 'number');
    assert.ok((body.uptime_s as number) >= 0);
    assert.equal(body.agent, 'alice');
    assert.equal(body.livekit_configured, false);
    assert.equal(body.passcode_required, false);
  });

  it('serves GET /api/config', async () => {
    delete env.ALICE_PASSCODE;
    const res1 = await fetch(`${baseUrl}/api/config`);
    assert.equal(res1.status, 200);
    assert.deepEqual(await res1.json(), { passcode_required: false, agent: 'alice' });

    env.ALICE_PASSCODE = 'demo-pass';
    const res2 = await fetch(`${baseUrl}/api/config`);
    assert.equal(res2.status, 200);
    assert.deepEqual(await res2.json(), { passcode_required: true, agent: 'alice' });
    delete env.ALICE_PASSCODE;
  });

  it('serves static index.html and css with content types', async () => {
    const resIndex = await fetch(`${baseUrl}/`);
    assert.equal(resIndex.status, 200);
    assert.match(resIndex.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(resIndex.headers.get('cache-control'), 'no-cache');
    assert.equal(resIndex.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await resIndex.text(), '<!doctype html><h1>Alice</h1>');

    const resCss = await fetch(`${baseUrl}/app.css`);
    assert.equal(resCss.status, 200);
    assert.match(resCss.headers.get('content-type') ?? '', /^text\/css/);
    assert.equal(await resCss.text(), 'body { margin: 0; }');

    const resHead = await fetch(`${baseUrl}/app.css`, { method: 'HEAD' });
    assert.equal(resHead.status, 200);
    assert.equal(await resHead.text(), '');
  });

  it('returns 404 for dotfiles', async () => {
    const res = await fetch(`${baseUrl}/.secret`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!text.includes('SUPER_SECRET_DOTFILE'));
  });

  it('blocks path traversal attempts with 404', async () => {
    const paths = [
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/../../package.json',
      '/tryon/..%2f..%2fpackage.json',
      '/tryon/%2e%2e%2fx.jpg',
    ];
    for (const p of paths) {
      const res = await rawHttpGet(port, p);
      assert.equal(res.status, 404, `expected 404 for ${p}, got ${res.status}`);
      assert.ok(!res.body.includes('livekit-server-sdk'), `leaked package.json for ${p}`);
      assert.ok(!res.body.includes('SUPER_SECRET_DOTFILE'), `leaked dotfile for ${p}`);
    }
  });

  it('serves valid tryon image and rejects wrong extension', async () => {
    const res = await fetch(`${baseUrl}/tryon/look1.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, fakeJpg);

    const badExt = await fetch(`${baseUrl}/tryon/notes.txt`);
    assert.equal(badExt.status, 404);
  });

  it('returns 503 on /api/token when LiveKit env is missing', async () => {
    delete env.LIVEKIT_URL;
    delete env.LIVEKIT_API_KEY;
    delete env.LIVEKIT_API_SECRET;
    delete env.ALICE_PASSCODE;

    const res = await fetch(`${baseUrl}/api/token`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'livekit_not_configured' });
  });

  it('mints valid LiveKit JWT tokens with explicit agent dispatch and distinct rooms', async () => {
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'x'.repeat(40);
    env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    delete env.ALICE_PASSCODE;

    const res1 = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jordan' }),
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('cache-control'), 'no-store');
    const data1 = (await res1.json()) as Record<string, unknown>;

    assert.equal(data1.url, 'wss://example.livekit.cloud');
    assert.equal(data1.agent, 'alice');
    assert.equal(data1.expires_in_s, 1800);
    assert.equal(data1.serverUrl, data1.url);
    assert.equal(data1.participantToken, data1.token);
    assert.equal(data1.roomName, data1.room);
    assert.equal(data1.participantName, data1.identity);
    assert.match(String(data1.room), /^alice-[0-9a-f]{10}$/);
    assert.match(String(data1.identity), /^shopper-[0-9a-f]{8}$/);

    const payload = decodeJwtPayload(String(data1.token));
    const video = payload.video as Record<string, unknown>;
    assert.equal(video.room, data1.room);
    assert.equal(video.roomJoin, true);
    assert.equal(video.canPublish, true);
    assert.equal(video.canSubscribe, true);
    assert.equal(video.canPublishData, true);
    assert.equal(video.canUpdateOwnMetadata, true);
    assert.equal(payload.sub, data1.identity);
    assert.equal(payload.name, 'Jordan');

    const exp = payload.exp as number;
    const nbf = payload.nbf as number;
    assert.equal(typeof exp, 'number');
    assert.equal(typeof nbf, 'number');
    assert.ok(Math.abs(exp - nbf - 1800) <= 5, `expected exp - nbf ~1800, got ${exp - nbf}`);

    const roomConfig = payload.roomConfig as { agents?: Array<{ agentName?: string }> };
    assert.ok(roomConfig && Array.isArray(roomConfig.agents));
    assert.equal(roomConfig.agents[0]?.agentName, 'alice');

    const res2 = await fetch(`${baseUrl}/api/token`, { method: 'GET' });
    assert.equal(res2.status, 200);
    const data2 = (await res2.json()) as Record<string, unknown>;
    assert.notEqual(data2.room, data1.room);
  });

  it('enforces passcode via header or JSON body and ignores query string', async () => {
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'x'.repeat(40);
    env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    env.ALICE_PASSCODE = 'top-secret-42';

    const missing = await fetch(`${baseUrl}/api/token`, { method: 'POST' });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'passcode_required', passcode_required: true });

    const wrong = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'x-alice-passcode': 'wrong-code' },
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: 'bad_passcode', passcode_required: true });

    const queryOnly = await fetch(`${baseUrl}/api/token?passcode=top-secret-42`, {
      method: 'POST',
    });
    assert.equal(queryOnly.status, 401);
    assert.deepEqual(await queryOnly.json(), { error: 'passcode_required', passcode_required: true });

    const withHeader = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'x-alice-passcode': 'top-secret-42' },
    });
    assert.equal(withHeader.status, 200);

    const withBody = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'top-secret-42' }),
    });
    assert.equal(withBody.status, 200);
  });

  it('rate limits /api/token after 20 requests per minute', async () => {
    const rlServer = createAliceServer({
      publicDir,
      tryonDir,
      env: {
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'x'.repeat(40),
        LIVEKIT_URL: 'wss://example.livekit.cloud',
      },
    });
    await new Promise<void>((resolve) => {
      rlServer.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const rlPort = (rlServer.address() as AddressInfo).port;
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`http://127.0.0.1:${rlPort}/api/token`, { method: 'POST' });
        assert.equal(res.status, 200);
      }
      const blocked = await fetch(`http://127.0.0.1:${rlPort}/api/token`, { method: 'POST' });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
      assert.deepEqual(await blocked.json(), { error: 'slow_down' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        rlServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
