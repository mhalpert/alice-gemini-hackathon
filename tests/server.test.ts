import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hasOpenSsl, makeCert } from '../scripts/make-cert.mjs';
import { getCallLogPath } from '../src/calllog.ts';
import type { Gender, Item, Outfit } from '../src/types.ts';
import type { ProductDetail } from '../src/store/catalog.ts';
import {
  createAliceHandler,
  createAliceHttpsServer,
  createAliceServer,
} from '../server.ts';

interface RawResponse {
  status: number;
  headers: string;
  body: string;
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestServer(opts: {
  scheme: 'http' | 'https';
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  ca?: Buffer;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }

    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    };

    const req =
      opts.scheme === 'https'
        ? https.request(
            {
              host: '127.0.0.1',
              port: opts.port,
              path: opts.path,
              method,
              headers,
              ca: opts.ca,
              rejectUnauthorized: true,
            },
            onResponse,
          )
        : http.request(
            {
              host: '127.0.0.1',
              port: opts.port,
              path: opts.path,
              method,
              headers,
            },
            onResponse,
          );

    req.on('error', reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
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
  let logDir: string;
  let prevLogDir: string | undefined;
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const env: Record<string, string | undefined> = {};

  before(async () => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-public-'));
    tryonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-tryon-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-logs-'));
    prevLogDir = process.env.ALICE_LOG_DIR;
    process.env.ALICE_LOG_DIR = logDir;

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
    if (prevLogDir === undefined) {
      delete process.env.ALICE_LOG_DIR;
    } else {
      process.env.ALICE_LOG_DIR = prevLogDir;
    }
    fs.rmSync(publicDir, { recursive: true, force: true });
    fs.rmSync(tryonDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
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
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, fakeJpg);

    const badExt = await fetch(`${baseUrl}/tryon/notes.txt`);
    assert.equal(badExt.status, 404);
  });

  it('supports byte ranges for /tryon/<name> (200 Accept-Ranges, 206 slices, 416, multiple-range fallback, HEAD, video/mp4)', async () => {
    // 64-byte deterministic fake mp4 fixture
    const fakeMp4 = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
    fs.writeFileSync(path.join(tryonDir, 'clip1.mp4'), fakeMp4);

    // 1. Full file 200 with Accept-Ranges and video/mp4
    const full = await fetch(`${baseUrl}/tryon/clip1.mp4`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), '64');
    assert.equal(full.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(full.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), fakeMp4);

    // 2. Closed range bytes=0-9 -> 206 with exactly 10 bytes
    const rClosed = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(rClosed.status, 206);
    assert.equal(rClosed.headers.get('content-type'), 'video/mp4');
    assert.equal(rClosed.headers.get('accept-ranges'), 'bytes');
    assert.equal(rClosed.headers.get('content-range'), 'bytes 0-9/64');
    assert.equal(rClosed.headers.get('content-length'), '10');
    assert.equal(rClosed.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(rClosed.headers.get('access-control-allow-origin'), null);
    const closedBytes = Buffer.from(await rClosed.arrayBuffer());
    assert.equal(closedBytes.length, 10);
    assert.deepEqual(closedBytes, fakeMp4.subarray(0, 10));

    // 3. Open-ended range bytes=50- -> 206 with bytes 50..63 (14 bytes)
    const rOpen = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
      headers: { Range: 'bytes=50-' },
    });
    assert.equal(rOpen.status, 206);
    assert.equal(rOpen.headers.get('content-range'), 'bytes 50-63/64');
    assert.equal(rOpen.headers.get('content-length'), '14');
    assert.deepEqual(Buffer.from(await rOpen.arrayBuffer()), fakeMp4.subarray(50, 64));

    // 4. Suffix range bytes=-12 -> 206 with last 12 bytes (52..63)
    const rSuffix = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
      headers: { Range: 'bytes=-12' },
    });
    assert.equal(rSuffix.status, 206);
    assert.equal(rSuffix.headers.get('content-range'), 'bytes 52-63/64');
    assert.equal(rSuffix.headers.get('content-length'), '12');
    assert.deepEqual(Buffer.from(await rSuffix.arrayBuffer()), fakeMp4.subarray(52, 64));

    // 5. Unsatisfiable & malformed ranges -> 416 with Content-Range: bytes */64
    for (const badRange of ['bytes=64-', 'bytes=100-200', 'bytes=20-10', 'bytes=-0', 'bytes=abc', 'items=0-5']) {
      const res416 = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
        headers: { Range: badRange },
      });
      assert.equal(res416.status, 416, `expected 416 for Range: ${badRange}`);
      assert.equal(res416.headers.get('content-range'), 'bytes */64');
      assert.equal(res416.headers.get('accept-ranges'), 'bytes');
      assert.equal(res416.headers.get('cache-control'), 'private, max-age=3600');
      assert.equal(res416.headers.get('access-control-allow-origin'), null);
    }

    // 6. Multiple ranges -> ignore Range header and send 200 with full file
    const rMulti = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
      headers: { Range: 'bytes=0-3, 10-15' },
    });
    assert.equal(rMulti.status, 200);
    assert.equal(rMulti.headers.get('accept-ranges'), 'bytes');
    assert.equal(rMulti.headers.get('content-range'), null);
    assert.equal(rMulti.headers.get('content-length'), '64');
    assert.deepEqual(Buffer.from(await rMulti.arrayBuffer()), fakeMp4);

    // 7. HEAD with Range -> 206 with matching Content-Range & Content-Length and empty body
    const rHead = await fetch(`${baseUrl}/tryon/clip1.mp4`, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(rHead.status, 206);
    assert.equal(rHead.headers.get('content-type'), 'video/mp4');
    assert.equal(rHead.headers.get('accept-ranges'), 'bytes');
    assert.equal(rHead.headers.get('content-range'), 'bytes 0-9/64');
    assert.equal(rHead.headers.get('content-length'), '10');
    assert.equal(rHead.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(rHead.headers.get('access-control-allow-origin'), null);
    assert.equal((await rHead.arrayBuffer()).byteLength, 0);

    // 8. Static files from public/ stay unaffected (no 206 on Range)
    const staticRange = await fetch(`${baseUrl}/app.css`, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(staticRange.status, 200);
    assert.equal(staticRange.headers.get('accept-ranges'), null);
    assert.equal(await staticRange.text(), 'body { margin: 0; }');
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

    const res2 = await fetch(`${baseUrl}/api/token`, { method: 'POST' });
    assert.equal(res2.status, 200);
    const data2 = (await res2.json()) as Record<string, unknown>;
    assert.notEqual(data2.room, data1.room);
  });

  it('rejects non-POST methods on /api/token with 405 and Allow: POST', async () => {
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'x'.repeat(40);
    env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    delete env.ALICE_PASSCODE;

    const getRes = await fetch(`${baseUrl}/api/token`, { method: 'GET' });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get('allow'), 'POST');
    assert.deepEqual(await getRes.json(), { error: 'method_not_allowed' });

    const headRes = await fetch(`${baseUrl}/api/token`, { method: 'HEAD' });
    assert.equal(headRes.status, 405);
    assert.equal(headRes.headers.get('allow'), 'POST');

    const putRes = await fetch(`${baseUrl}/api/token`, { method: 'PUT' });
    assert.equal(putRes.status, 405);
    assert.equal(putRes.headers.get('allow'), 'POST');
    assert.deepEqual(await putRes.json(), { error: 'method_not_allowed' });
  });

  it('refuses non-loopback /api/token callers when ALICE_PASSCODE is empty', async () => {
    const lkEnv: Record<string, string | undefined> = {
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'x'.repeat(40),
      LIVEKIT_URL: 'wss://example.livekit.cloud',
    };

    const runWithAddr = async (
      addr: string | undefined,
      serverEnv: Record<string, string | undefined>,
      headers: Record<string, string> = {},
    ) => {
      const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
      const srv = createAliceServer({
        publicDir,
        tryonDir,
        env: serverEnv,
        remoteAddress: () => addr,
        calllog: (room, ev, data) => {
          events.push({ room, ev, data });
        },
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      try {
        const srvPort = (srv.address() as AddressInfo).port;
        const res = await fetch(`http://127.0.0.1:${srvPort}/api/token`, {
          method: 'POST',
          headers,
        });
        const body = (await res.json()) as Record<string, unknown>;
        return { status: res.status, headers: res.headers, body, events };
      } finally {
        await new Promise<void>((resolve, reject) =>
          srv.close((err) => (err ? reject(err) : resolve())),
        );
      }
    };

    // Non-loopback caller with empty ALICE_PASSCODE -> 403 + token_refused log with remote_addr
    const refused = await runWithAddr('192.168.1.50', { ...lkEnv });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.deepEqual(refused.body, { error: 'passcode_not_configured' });
    assert.equal(refused.events.length, 1);
    assert.equal(refused.events[0].room, '_server');
    assert.equal(refused.events[0].ev, 'token_refused');
    assert.deepEqual(refused.events[0].data, {
      reason: 'passcode_not_configured',
      remote_addr: '192.168.1.50',
    });

    // Same non-loopback caller with ALICE_PASSCODE set + right passcode -> 200
    const allowedWithPass = await runWithAddr(
      '192.168.1.50',
      { ...lkEnv, ALICE_PASSCODE: 'lan-secret' },
      { 'x-alice-passcode': 'lan-secret' },
    );
    assert.equal(allowedWithPass.status, 200);
    assert.equal(typeof allowedWithPass.body.token, 'string');
    assert.equal(allowedWithPass.events.length, 1);
    assert.equal(allowedWithPass.events[0].ev, 'token');
    assert.equal(allowedWithPass.events[0].data?.remote_addr, '192.168.1.50');

    // Loopback addresses with empty ALICE_PASSCODE -> 200
    for (const loopback of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const ok = await runWithAddr(loopback, { ...lkEnv });
      assert.equal(ok.status, 200, `expected 200 for loopback ${loopback}`);
      assert.equal(typeof ok.body.token, 'string');
      assert.equal(ok.events[0]?.ev, 'token');
      assert.equal(ok.events[0]?.data?.remote_addr, loopback);
    }

    // Unknown / empty remote address with empty ALICE_PASSCODE -> 403
    for (const missingAddr of [undefined, '']) {
      const denied = await runWithAddr(missingAddr, { ...lkEnv });
      assert.equal(denied.status, 403, `expected 403 for remoteAddress=${JSON.stringify(missingAddr)}`);
      assert.deepEqual(denied.body, { error: 'passcode_not_configured' });
    }
  });

  it('caps POST /api/token bodies at 4096 bytes for Content-Length and chunked uploads', async () => {
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const capServer = createAliceServer({
      publicDir,
      tryonDir,
      env: {
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'x'.repeat(40),
        LIVEKIT_URL: 'wss://example.livekit.cloud',
      },
      calllog: (room, ev, data) => {
        events.push({ room, ev, data });
      },
    });
    await new Promise<void>((resolve) => capServer.listen(0, '127.0.0.1', () => resolve()));
    try {
      const capPort = (capServer.address() as AddressInfo).port;

      // 1. 10,000-byte JSON body with Content-Length -> 413 body_too_large, no token
      const bigBody = JSON.stringify({ pad: 'a'.repeat(9990) });
      assert.equal(Buffer.byteLength(bigBody), 10000);
      const clRes = await requestServer({
        scheme: 'http',
        port: capPort,
        path: '/api/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bigBody,
      });
      assert.equal(clRes.status, 413);
      assert.equal(clRes.headers['cache-control'], 'no-store');
      assert.equal(clRes.headers.connection, 'close');
      const clJson = JSON.parse(clRes.body.toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(clJson, { error: 'body_too_large' });
      assert.equal(clJson.token, undefined);
      assert.deepEqual(events[events.length - 1], {
        room: '_server',
        ev: 'token_refused',
        data: { reason: 'body_too_large', remote_addr: '127.0.0.1' },
      });

      // 2. Chunked POST (no Content-Length) streaming > 4096 bytes -> 413 body_too_large
      const chunkedRes = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        let settled = false;
        const req = http.request(
          {
            host: '127.0.0.1',
            port: capPort,
            path: '/api/token',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer | string) => {
              chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
            });
            res.on('end', () => {
              if (!settled) {
                settled = true;
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                });
              }
            });
            res.on('error', () => {
              // Tolerate socket close once response has been received
            });
          },
        );
        req.on('error', (err) => {
          if (!settled) {
            // Tolerate EPIPE/ECONNRESET while streaming after the server replies 413 and closes
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ECONNRESET' && code !== 'EPIPE') {
              settled = true;
              reject(err);
            }
          }
        });
        req.write('{"pad":"' + 'b'.repeat(2048));
        req.write('c'.repeat(2048));
        req.write('d'.repeat(1024));
      });
      assert.equal(chunkedRes.status, 413);
      assert.equal(chunkedRes.headers['cache-control'], 'no-store');
      assert.equal(chunkedRes.headers.connection, 'close');
      const chunkedJson = JSON.parse(chunkedRes.body) as Record<string, unknown>;
      assert.deepEqual(chunkedJson, { error: 'body_too_large' });
      assert.equal(chunkedJson.token, undefined);
      assert.deepEqual(events[events.length - 1], {
        room: '_server',
        ev: 'token_refused',
        data: { reason: 'body_too_large', remote_addr: '127.0.0.1' },
      });

      // 3. Exact 4096-byte valid JSON body -> 200
      const exactBody = JSON.stringify({ name: 'Sam', pad: 'x'.repeat(4096 - 23) });
      assert.equal(Buffer.byteLength(exactBody), 4096);
      const okRes = await fetch(`http://127.0.0.1:${capPort}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: exactBody,
      });
      assert.equal(okRes.status, 200);
      const okData = (await okRes.json()) as Record<string, unknown>;
      assert.equal(typeof okData.token, 'string');
      assert.equal(events[events.length - 1].ev, 'token');
      assert.equal(events[events.length - 1].data?.remote_addr, '127.0.0.1');

      // 4. Invalid JSON body -> 200 (treated as {})
      const badJsonRes = await fetch(`http://127.0.0.1:${capPort}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });
      assert.equal(badJsonRes.status, 200);
      const badJsonData = (await badJsonRes.json()) as Record<string, unknown>;
      assert.equal(typeof badJsonData.token, 'string');
    } finally {
      await new Promise<void>((resolve, reject) =>
        capServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
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

  it('writes token and refusal events to server log without writing to the room log or leaking secrets', async () => {
    const dedicatedLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-calllog-test-'));
    const savedLogDir = process.env.ALICE_LOG_DIR;
    process.env.ALICE_LOG_DIR = dedicatedLogDir;

    const secretPasscode = 'super-secret-pass-999';
    const wrongPasscode = 'wrong-secret-pass-000';
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'x'.repeat(40);
    env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    env.ALICE_PASSCODE = secretPasscode;
    delete env.ALICE_AGENT_NAME;

    try {
      // Refusal 1: missing passcode
      const missingRes = await fetch(`${baseUrl}/api/token`, { method: 'POST' });
      assert.equal(missingRes.status, 401);

      // Refusal 2: wrong passcode
      const badRes = await fetch(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: { 'x-alice-passcode': wrongPasscode },
      });
      assert.equal(badRes.status, 401);

      // Refusal 3: LiveKit not configured
      const savedUrl = env.LIVEKIT_URL;
      delete env.LIVEKIT_URL;
      const unconfRes = await fetch(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: { 'x-alice-passcode': secretPasscode },
      });
      assert.equal(unconfRes.status, 503);
      env.LIVEKIT_URL = savedUrl;

      // Success: valid token issued
      const res = await fetch(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-alice-passcode': secretPasscode,
        },
        body: JSON.stringify({ name: 'Taylor' }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as Record<string, unknown>;
      const room = String(data.room);
      const token = String(data.token);

      // Room log must NOT be created or written to by the server
      const roomLogFile = path.join(dedicatedLogDir, `${room}.jsonl`);
      assert.equal(fs.existsSync(roomLogFile), false, 'server must not write to the room call log');

      // Server log (calllog('_server', ...) -> getCallLogPath('_server')) receives refusals and token
      const serverLogFile = getCallLogPath('_server');
      assert.ok(fs.existsSync(serverLogFile), `expected server log file at ${serverLogFile}`);

      const rawLog = fs.readFileSync(serverLogFile, 'utf8');
      assert.ok(!rawLog.includes(token), 'server log must never contain the JWT token');
      assert.ok(!rawLog.includes(secretPasscode), 'server log must never contain the passcode');
      assert.ok(!rawLog.includes(wrongPasscode), 'server log must never contain supplied passcode');

      const records = rawLog
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(records.length, 4);

      assert.equal(records[0].ev, 'token_refused');
      assert.equal(records[0].reason, 'passcode_required');
      assert.equal(records[0].remote_addr, '127.0.0.1');
      assert.equal(records[1].ev, 'token_refused');
      assert.equal(records[1].reason, 'bad_passcode');
      assert.equal(records[1].remote_addr, '127.0.0.1');
      assert.equal(records[2].ev, 'token_refused');
      assert.equal(records[2].reason, 'livekit_not_configured');
      assert.equal(records[2].remote_addr, '127.0.0.1');

      assert.equal(records[3].ev, 'token');
      assert.equal(records[3].room, room);
      assert.equal(records[3].identity, data.identity);
      assert.equal(records[3].agent, data.agent);
      assert.equal(records[3].remote_addr, '127.0.0.1');
      assert.equal(typeof records[3].t, 'string');
      assert.equal(typeof records[3].ms, 'number');
      assert.equal(typeof records[3].pid, 'number');
    } finally {
      delete env.ALICE_PASSCODE;
      if (savedLogDir === undefined) {
        delete process.env.ALICE_LOG_DIR;
      } else {
        process.env.ALICE_LOG_DIR = savedLogDir;
      }
      fs.rmSync(dedicatedLogDir, { recursive: true, force: true });
    }

    // Verify slow_down refusal is logged to '_server'
    const rlEvents: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const rlLogServer = createAliceServer({
      publicDir,
      tryonDir,
      env: {
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'x'.repeat(40),
        LIVEKIT_URL: 'wss://example.livekit.cloud',
      },
      calllog: (r, ev, d) => {
        rlEvents.push({ room: r, ev, data: d });
      },
    });
    await new Promise<void>((resolve) => {
      rlLogServer.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const rlPort = (rlLogServer.address() as AddressInfo).port;
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`http://127.0.0.1:${rlPort}/api/token`, { method: 'POST' });
        assert.equal(res.status, 200);
      }
      const blocked = await fetch(`http://127.0.0.1:${rlPort}/api/token`, { method: 'POST' });
      assert.equal(blocked.status, 429);
      const last = rlEvents[rlEvents.length - 1];
      assert.equal(last.room, '_server');
      assert.equal(last.ev, 'token_refused');
      assert.deepEqual(last.data, { reason: 'slow_down', remote_addr: '127.0.0.1' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        rlLogServer.close((err) => (err ? reject(err) : resolve()));
      });
    }

    // Verify calllog failure never affects /api/token response.
    const failingLogServer = createAliceServer({
      publicDir,
      tryonDir,
      env: {
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'x'.repeat(40),
        LIVEKIT_URL: 'wss://example.livekit.cloud',
      },
      calllog: () => {
        throw new Error('simulated log failure');
      },
    });
    await new Promise<void>((resolve) => {
      failingLogServer.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const fPort = (failingLogServer.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${fPort}/api/token`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(typeof body.token, 'string');
    } finally {
      await new Promise<void>((resolve, reject) => {
        failingLogServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('serves /healthz and static files over TLS using makeCert(dir)', async (t) => {
    if (!hasOpenSsl()) {
      t.skip('openssl is not installed; skipping HTTPS TLS test');
      return;
    }

    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-certs-'));
    let httpsServer: https.Server | undefined;

    try {
      const { certPath, keyPath } = makeCert(certDir);
      assert.ok(fs.existsSync(certPath), 'expected alice.crt to be generated');
      assert.ok(fs.existsSync(keyPath), 'expected alice.key to be generated');
      const keyMode = fs.statSync(keyPath).mode & 0o777;
      assert.equal(keyMode, 0o600, `expected alice.key mode 0600, got 0${keyMode.toString(8)}`);

      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);

      httpsServer = createAliceHttpsServer({
        publicDir,
        tryonDir,
        env: { ALICE_AGENT_NAME: 'alice' },
        cert,
        key,
      });
      await new Promise<void>((resolve) => {
        httpsServer!.listen(0, '127.0.0.1', () => resolve());
      });
      const httpsPort = (httpsServer.address() as AddressInfo).port;

      const healthRes = await requestServer({
        scheme: 'https',
        port: httpsPort,
        path: '/healthz',
        ca: cert,
      });
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');
      const healthBody = JSON.parse(healthRes.body.toString('utf8')) as Record<string, unknown>;
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.agent, 'alice');
      assert.equal(healthBody.livekit_configured, false);
      assert.equal(healthBody.passcode_required, false);

      const indexRes = await requestServer({
        scheme: 'https',
        port: httpsPort,
        path: '/',
        ca: cert,
      });
      assert.equal(indexRes.status, 200);
      assert.match(String(indexRes.headers['content-type'] ?? ''), /^text\/html/);
      assert.equal(indexRes.headers['cache-control'], 'no-cache');
      assert.equal(indexRes.body.toString('utf8'), '<!doctype html><h1>Alice</h1>');

      const cssRes = await requestServer({
        scheme: 'https',
        port: httpsPort,
        path: '/app.css',
        ca: cert,
      });
      assert.equal(cssRes.status, 200);
      assert.match(String(cssRes.headers['content-type'] ?? ''), /^text\/css/);
      assert.equal(cssRes.body.toString('utf8'), 'body { margin: 0; }');
    } finally {
      if (httpsServer) {
        await new Promise<void>((resolve, reject) => {
          httpsServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('createAliceHandler behaves identically on HTTP and HTTPS', async (t) => {
    if (!hasOpenSsl()) {
      t.skip('openssl is not installed; skipping HTTP vs HTTPS parity test');
      return;
    }

    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-parity-certs-'));
    const sharedEnv: Record<string, string | undefined> = {
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'x'.repeat(40),
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      ALICE_AGENT_NAME: 'alice',
    };
    const loggedEvents: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const sink = (room: string, ev: string, data?: Record<string, unknown>): void => {
      loggedEvents.push({ room, ev, data });
    };

    let httpSrv: http.Server | undefined;
    let httpsSrv: https.Server | undefined;

    try {
      const { certPath, keyPath } = makeCert(certDir);
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);

      httpSrv = http.createServer(
        createAliceHandler({ publicDir, tryonDir, env: sharedEnv, calllog: sink }),
      );
      httpsSrv = https.createServer(
        { cert, key },
        createAliceHandler({ publicDir, tryonDir, env: sharedEnv, calllog: sink }),
      );

      await Promise.all([
        new Promise<void>((resolve) => httpSrv!.listen(0, '127.0.0.1', () => resolve())),
        new Promise<void>((resolve) => httpsSrv!.listen(0, '127.0.0.1', () => resolve())),
      ]);

      const httpPort = (httpSrv.address() as AddressInfo).port;
      const httpsPort = (httpsSrv.address() as AddressInfo).port;

      const pathsToCompare = [
        '/healthz',
        '/api/config',
        '/app.css',
        '/.secret',
        '/tryon/look1.jpg',
      ];
      for (const reqPath of pathsToCompare) {
        const [httpRes, httpsRes] = await Promise.all([
          requestServer({ scheme: 'http', port: httpPort, path: reqPath }),
          requestServer({ scheme: 'https', port: httpsPort, path: reqPath, ca: cert }),
        ]);

        assert.equal(httpsRes.status, httpRes.status, `status mismatch for ${reqPath}`);
        assert.equal(
          httpsRes.headers['content-type'],
          httpRes.headers['content-type'],
          `content-type mismatch for ${reqPath}`,
        );
        assert.equal(
          httpsRes.headers['cache-control'],
          httpRes.headers['cache-control'],
          `cache-control mismatch for ${reqPath}`,
        );
        assert.equal(
          httpsRes.headers['x-content-type-options'],
          httpRes.headers['x-content-type-options'],
          `x-content-type-options mismatch for ${reqPath}`,
        );

        if (reqPath === '/healthz') {
          const a = JSON.parse(httpRes.body.toString('utf8')) as Record<string, unknown>;
          const b = JSON.parse(httpsRes.body.toString('utf8')) as Record<string, unknown>;
          assert.equal(b.ok, a.ok);
          assert.equal(b.agent, a.agent);
          assert.equal(b.livekit_configured, a.livekit_configured);
          assert.equal(b.passcode_required, a.passcode_required);
        } else {
          assert.deepEqual(httpsRes.body, httpRes.body, `body mismatch for ${reqPath}`);
        }
      }

      const [httpTok, httpsTok] = await Promise.all([
        requestServer({
          scheme: 'http',
          port: httpPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alex' }),
        }),
        requestServer({
          scheme: 'https',
          port: httpsPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alex' }),
          ca: cert,
        }),
      ]);

      assert.equal(httpTok.status, 200);
      assert.equal(httpsTok.status, 200);
      assert.equal(httpsTok.headers['cache-control'], httpTok.headers['cache-control']);
      assert.equal(httpsTok.headers['content-type'], httpTok.headers['content-type']);

      const httpData = JSON.parse(httpTok.body.toString('utf8')) as Record<string, unknown>;
      const httpsData = JSON.parse(httpsTok.body.toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(httpsData).sort(), Object.keys(httpData).sort());
      assert.equal(httpsData.url, httpData.url);
      assert.equal(httpsData.agent, httpData.agent);
      assert.equal(httpsData.expires_in_s, httpData.expires_in_s);
      assert.equal(loggedEvents.length, 2);
      assert.equal(loggedEvents[0].room, '_server');
      assert.equal(loggedEvents[0].ev, 'token');
      assert.equal(loggedEvents[1].room, '_server');
      assert.equal(loggedEvents[1].ev, 'token');
      assert.deepEqual(
        loggedEvents.map((e) => e.data?.room).sort(),
        [httpData.room, httpsData.room].sort(),
      );
    } finally {
      await Promise.all([
        httpSrv
          ? new Promise<void>((resolve, reject) =>
              httpSrv!.close((err) => (err ? reject(err) : resolve())),
            )
          : Promise.resolve(),
        httpsSrv
          ? new Promise<void>((resolve, reject) =>
              httpsSrv!.close((err) => (err ? reject(err) : resolve())),
            )
          : Promise.resolve(),
      ]);
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });
});

describe('Storefront, product, search, and looks API', () => {
  function sampleItem(id: string, department: Gender = 'women'): Item {
    return {
      id,
      variant_id: `gid://shopify/ProductVariant/${id.replace(/\W+/g, '')}`,
      title: `Piece ${id}`,
      price: 58,
      url: `https://www.everlane.com/products/${id}?variant=101&_gsid=origToken&utm_source=shopify&utm_medium=catalog`,
      image: `https://cdn.shopify.com/s/files/1/0623/files/${id}.jpg`,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      rating: 4.5,
      rating_count: 19,
      sizes: ['S', 'M', 'L'],
      variants_by_size: { S: 'gid://shopify/ProductVariant/101' },
      description: 'Organic cotton blend tailored piece for day or evening wear. '.repeat(5).trim(),
      department,
    };
  }

  function sampleProductDetail(): ProductDetail {
    return {
      id: 'gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC',
      title: 'NAXOS BLACK LEATHER',
      description: 'Leather slip-on loafer with lug sole. Cushioned insole for comfort.',
      description_html: '<ul><li>1.5 inch heel height</li><li>Leather upper</li></ul>',
      images: [
        'https://cdn.shopify.com/s/files/1/2170/8465/files/naxos-1.jpg',
        'https://cdn.shopify.com/s/files/1/2170/8465/files/naxos-2.jpg',
      ],
      options: [
        {
          name: 'Numeric shoe size',
          values: [
            { label: '9', available: true, exists: true },
            { label: '10', available: false, exists: true },
          ],
        },
      ],
      selected: [{ name: 'Numeric shoe size', label: '9' }],
      variant: {
        id: 'gid://shopify/ProductVariant/41356358090885',
        price: 149.95,
        available: true,
        options: [{ name: 'Numeric shoe size', label: '9' }],
        url: 'https://www.stevemadden.com/products/naxos-black-leather?variant=41356358090885&_gsid=keep_me&utm_source=shopify&utm_medium=catalog',
      },
    };
  }

  function sampleOutfit(department: Gender): Outfit {
    const it = sampleItem(`look-${department}`, department);
    return {
      number: 1,
      name: `${department} Library Look`,
      difference: 'Clean silhouette',
      story: 'Curated from library',
      pieces: [{ slot: 'top', why: 'Great drape', item: it }],
      total: it.price,
    };
  }

  async function withServer(
    opts: Parameters<typeof createAliceServer>[0],
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const srv = createAliceServer(opts);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const srvPort = (srv.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${srvPort}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it('serves /api/storefront, /api/product, /api/search with exact shapes, headers, and validation', async () => {
    const detail = sampleProductDetail();
    const dup = sampleItem('dup-item', 'women');

    await withServer(
      {
        env: {},
        store: {
          searchMixed: async (query, gender) => {
            if (query === 'black loafer') {
              return {
                items: Array.from({ length: 10 }, (_, i) => sampleItem(`search-${i}`, gender)),
                source: 'live',
                ms: 4,
              };
            }
            return { items: [], source: 'empty', ms: 4 };
          },
          search: async (query, gender, opts) => {
            if (query === "women's trousers") {
              return {
                items: [
                  dup,
                  sampleItem('tr-2', gender),
                  sampleItem('tr-3', gender),
                  sampleItem('tr-4', gender),
                ],
                source: 'live',
                ms: 4,
              };
            }
            if (query === "women's dress") {
              return {
                items: [
                  sampleItem('dress-1', gender),
                  sampleItem('dress-2', gender),
                  sampleItem('dress-3', gender),
                  sampleItem('dress-4', gender),
                ],
                source: 'live',
                ms: 4,
              };
            }
            if (opts?.shops?.length === 1 && opts.shops[0] === 'everlane.com') {
              return { items: [sampleItem('ev-1', gender)], source: 'live', ms: 4 };
            }
            return { items: [], source: 'empty', ms: 4 };
          },
          getProduct: async (id) => {
            if (id === detail.variant.id || id === detail.id) return detail;
            return null;
          },
        },
      },
      async (url) => {
        // 1. GET /api/storefront (defaults to women)
        const sfRes = await fetch(`${url}/api/storefront`);
        assert.equal(sfRes.status, 200);
        assert.equal(sfRes.headers.get('cache-control'), 'no-store');
        assert.equal(sfRes.headers.get('x-content-type-options'), 'nosniff');
        const sf = (await sfRes.json()) as {
          department: string;
          sections: Array<{ id: string; title: string; items: Item[] }>;
          ms: number;
          storefront: { searches: number; shared: boolean };
          partial?: boolean;
        };
        assert.equal(sf.department, 'women');
        assert.equal(typeof sf.ms, 'number');
        assert.equal(typeof sf.storefront.searches, 'number');
        assert.equal(sf.storefront.shared, false);
        assert.equal(sf.partial, undefined);
        // Empty sections dropped -> only dresses, trousers, from-everlane remain
        assert.deepEqual(
          sf.sections.map((s) => s.id),
          ['dresses', 'trousers', 'from-everlane'],
        );
        const tr = sf.sections.find((s) => s.id === 'trousers')!;
        assert.equal(tr.items.filter((i) => i.id === 'dup-item').length, 1);
        assert.equal(tr.items[0].url, dup.url);
        assert.ok(tr.items[0].description.length <= 160);
        assert.deepEqual(tr.items[0].variants_by_size, {});

        // 2. GET /api/product (by variant_id and by id)
        const prodRes = await fetch(
          `${url}/api/product?variant_id=${encodeURIComponent(detail.variant.id)}&department=men`,
        );
        assert.equal(prodRes.status, 200);
        assert.equal(prodRes.headers.get('cache-control'), 'no-store');
        assert.equal(prodRes.headers.get('x-content-type-options'), 'nosniff');
        const prod = (await prodRes.json()) as Record<string, unknown>;
        assert.deepEqual(Object.keys(prod).sort(), [
          'description',
          'details',
          'images',
          'item',
          'sizes',
          'sizes_detail',
          'slot',
          'why',
        ]);
        const prodItem = prod.item as Item;
        assert.equal(prodItem.url, detail.variant.url);
        assert.equal(prodItem.department, 'men');
        assert.equal(prodItem.store, 'Steve Madden');
        assert.deepEqual(prod.sizes, ['9']);
        assert.deepEqual(prod.sizes_detail, [
          { label: '9', available: true },
          { label: '10', available: false },
        ]);

        const prodById = await fetch(`${url}/api/product?id=${encodeURIComponent(detail.id)}`);
        assert.equal(prodById.status, 200);

        // /api/product 400 and 404
        const badId = await fetch(`${url}/api/product?variant_id=not-a-gid`);
        assert.equal(badId.status, 400);
        assert.deepEqual(await badId.json(), { error: 'bad_id' });

        const missingId = await fetch(`${url}/api/product`);
        assert.equal(missingId.status, 400);
        assert.deepEqual(await missingId.json(), { error: 'bad_id' });

        const notFound = await fetch(
          `${url}/api/product?variant_id=${encodeURIComponent('gid://shopify/ProductVariant/999999')}`,
        );
        assert.equal(notFound.status, 404);
        assert.deepEqual(await notFound.json(), { error: 'not_found' });

        // 3. GET /api/search
        const searchRes = await fetch(`${url}/api/search?q=black+loafer&department=men`);
        assert.equal(searchRes.status, 200);
        assert.equal(searchRes.headers.get('cache-control'), 'no-store');
        const searchBody = (await searchRes.json()) as { query: string; items: Item[] };
        assert.deepEqual(Object.keys(searchBody).sort(), ['items', 'query']);
        assert.equal(searchBody.query, 'black loafer');
        assert.equal(searchBody.items.length, 8);
        assert.ok(searchBody.items[0].url.includes('_gsid=origToken'));

        const emptyQ = await fetch(`${url}/api/search?q=`);
        assert.equal(emptyQ.status, 400);
        assert.deepEqual(await emptyQ.json(), { error: 'bad_query' });

        const longQ = await fetch(`${url}/api/search?q=${'a'.repeat(81)}`);
        assert.equal(longQ.status, 400);
        assert.deepEqual(await longQ.json(), { error: 'bad_query' });

        // 4. GET only -> 405 on POST for all five browse routes
        for (const p of ['/api/storefront', '/api/product', '/api/search', '/api/looks', '/api/occasions']) {
          const postRes = await fetch(`${url}${p}`, { method: 'POST' });
          assert.equal(postRes.status, 405, `expected 405 for POST ${p}`);
          assert.equal(postRes.headers.get('allow'), 'GET');
        }
      },
    );
  });

  it('serves /api/looks across library present, missing, throwing, and slow fallback, plus occasion queries', async () => {
    const seenCalls: Array<{ gender: Gender; opts?: { limit?: number; occasion?: string } }> = [];

    // 1. Export present (with and without occasion, empty occasion match, and bad_occasion 400)
    await withServer(
      {
        loadLibrary: async () => ({
          libraryLooks: async (gender: Gender, opts?: { limit?: number; occasion?: string }) => {
            seenCalls.push({ gender, opts });
            if (opts?.occasion === 'nonsense xyz') {
              return [];
            }
            return [
              sampleOutfit(gender),
              { ...sampleOutfit(gender), number: 2, name: `Second ${opts?.limit ?? 6}` },
            ];
          },
        }),
      },
      async (url) => {
        const res = await fetch(`${url}/api/looks?department=women&limit=1`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as {
          department: string;
          occasion: string | null;
          looks: Outfit[];
          source: string;
        };
        assert.equal(body.department, 'women');
        assert.equal(body.occasion, null);
        assert.equal(body.source, 'library');
        assert.equal(body.looks.length, 1);

        // Occasion passed through and echoed back
        const occRes = await fetch(
          `${url}/api/looks?department=men&limit=3&occasion=%20rooftop%20birthday%20`,
        );
        assert.equal(occRes.status, 200);
        const occBody = (await occRes.json()) as {
          department: string;
          occasion: string | null;
          looks: Outfit[];
          source: string;
        };
        assert.equal(occBody.department, 'men');
        assert.equal(occBody.occasion, 'rooftop birthday');
        assert.equal(occBody.source, 'library');
        assert.equal(occBody.looks.length, 2);
        assert.deepEqual(seenCalls[1], {
          gender: 'men',
          opts: { limit: 3, occasion: 'rooftop birthday' },
        });

        // Empty match for an occasion stays empty with source: 'library' (NO fixture fallback)
        const emptyOccRes = await fetch(
          `${url}/api/looks?department=men&occasion=${encodeURIComponent('nonsense xyz')}`,
        );
        assert.equal(emptyOccRes.status, 200);
        const emptyOccBody = (await emptyOccRes.json()) as {
          department: string;
          occasion: string | null;
          looks: Outfit[];
          source: string;
        };
        assert.equal(emptyOccBody.department, 'men');
        assert.equal(emptyOccBody.occasion, 'nonsense xyz');
        assert.equal(emptyOccBody.source, 'library');
        assert.deepEqual(emptyOccBody.looks, []);

        // Over-120-character occasion -> 400 bad_occasion
        const longOcc = await fetch(`${url}/api/looks?occasion=${'a'.repeat(121)}`);
        assert.equal(longOcc.status, 400);
        assert.equal(longOcc.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await longOcc.json(), { error: 'bad_occasion' });
      },
    );

    // 2. Export missing -> fixture fallback (filters to men; falls back to all when none match women)
    await withServer(
      {
        loadLibrary: async () => null,
      },
      async (url) => {
        const menRes = await fetch(`${url}/api/looks?department=men&limit=2`);
        assert.equal(menRes.status, 200);
        const menBody = (await menRes.json()) as {
          department: string;
          occasion: string | null;
          looks: Outfit[];
          source: string;
        };
        assert.equal(menBody.department, 'men');
        assert.equal(menBody.occasion, null);
        assert.equal(menBody.source, 'fixture');
        assert.equal(menBody.looks.length, 2);

        const womenRes = await fetch(`${url}/api/looks?department=women&limit=6`);
        assert.equal(womenRes.status, 200);
        const womenBody = (await womenRes.json()) as {
          department: string;
          occasion: string | null;
          looks: Outfit[];
          source: string;
        };
        assert.equal(womenBody.department, 'women');
        assert.equal(womenBody.occasion, null);
        assert.equal(womenBody.source, 'fixture');
        assert.ok(womenBody.looks.length > 0);
      },
    );

    // 3. Export throws -> fixture fallback when no occasion, empty library when occasion given
    await withServer(
      {
        loadLibrary: async () => ({
          libraryLooks: async () => {
            throw new Error('library crashed');
          },
        }),
      },
      async (url) => {
        const res = await fetch(`${url}/api/looks?department=men`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          occasion: string | null;
          source: string;
          looks: Outfit[];
        };
        assert.equal(body.occasion, null);
        assert.equal(body.source, 'fixture');
        assert.ok(body.looks.length > 0);

        const occThrow = await fetch(`${url}/api/looks?department=men&occasion=beach`);
        assert.equal(occThrow.status, 200);
        const occThrowBody = (await occThrow.json()) as {
          occasion: string | null;
          source: string;
          looks: Outfit[];
        };
        assert.equal(occThrowBody.occasion, 'beach');
        assert.equal(occThrowBody.source, 'library');
        assert.deepEqual(occThrowBody.looks, []);
      },
    );

    // 4. GET /api/occasions across libraryOccasions present, sets.json fallback (missing/throws), and none
    const tmpSetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-sets-'));
    const tmpSetsFile = path.join(tmpSetsDir, 'sets.json');
    fs.writeFileSync(
      tmpSetsFile,
      JSON.stringify({
        version: 1,
        sets: [
          {
            key: 'rooftop-birthday',
            gender: 'men',
            occasion: "a friend's rooftop birthday party",
            outfits: [sampleOutfit('men')],
          },
          {
            key: 'brunch',
            gender: 'women',
            occasion: 'sunday brunch with friends',
            outfits: [sampleOutfit('women')],
          },
        ],
      }),
    );

    try {
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryOccasions: async (gender: Gender) =>
              gender === 'men'
                ? [
                    {
                      key: 'rooftop-birthday',
                      occasion: "a friend's rooftop birthday party",
                      label: 'Rooftop birthday',
                    },
                  ]
                : [
                    {
                      key: 'brunch',
                      occasion: 'Sunday brunch with friends',
                      label: 'Sunday brunch',
                    },
                  ],
          }),
        },
        async (url) => {
          const menOcc = await fetch(`${url}/api/occasions?department=men`);
          assert.equal(menOcc.status, 200);
          assert.equal(menOcc.headers.get('cache-control'), 'no-store');
          assert.deepEqual(await menOcc.json(), {
            department: 'men',
            occasions: [
              {
                key: 'rooftop-birthday',
                occasion: "a friend's rooftop birthday party",
                label: 'Rooftop birthday',
              },
            ],
            source: 'library',
          });

          const womenOcc = await fetch(`${url}/api/occasions?department=women`);
          assert.equal(womenOcc.status, 200);
          assert.deepEqual(await womenOcc.json(), {
            department: 'women',
            occasions: [
              {
                key: 'brunch',
                occasion: 'Sunday brunch with friends',
                label: 'Sunday brunch',
              },
            ],
            source: 'library',
          });
        },
      );

      // Missing export -> falls back to sets.json with source: 'sets' and slug/capitalised label;
      // and /api/looks?occasion=<slug> maps the slug back to the occasion text before calling libraryLooks.
      const mappedSeen: Array<{ gender: Gender; occasion?: string }> = [];
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async (gender: Gender, opts?: { occasion?: string }) => {
              mappedSeen.push({ gender, occasion: opts?.occasion });
              return [sampleOutfit(gender)];
            },
          }),
        },
        async (url) => {
          const res = await fetch(`${url}/api/occasions?department=men`);
          assert.equal(res.status, 200);
          const body = (await res.json()) as {
            department: string;
            occasions: Array<{ key: string; occasion: string; label: string }>;
            source: string;
          };
          assert.deepEqual(body, {
            department: 'men',
            occasions: [
              {
                key: 'a-friends-rooftop-birthday-party',
                occasion: "a friend's rooftop birthday party",
                label: "A friend's rooftop birthday party",
              },
            ],
            source: 'sets',
          });

          const slugKey = body.occasions[0].key;
          const looksRes = await fetch(
            `${url}/api/looks?department=men&occasion=${encodeURIComponent(slugKey)}`,
          );
          assert.equal(looksRes.status, 200);
          const looksBody = (await looksRes.json()) as {
            occasion: string;
            source: string;
            looks: Outfit[];
          };
          assert.equal(looksBody.source, 'library');
          assert.equal(looksBody.looks.length, 1);
          assert.deepEqual(mappedSeen[0], {
            gender: 'men',
            occasion: "a friend's rooftop birthday party",
          });
        },
      );

      // Export throws -> falls back to sets.json with source: 'sets'
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryOccasions: async () => {
              throw new Error('occasions crashed');
            },
          }),
        },
        async (url) => {
          const res = await fetch(`${url}/api/occasions?department=women`);
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), {
            department: 'women',
            occasions: [
              {
                key: 'sunday-brunch-with-friends',
                occasion: 'sunday brunch with friends',
                label: 'Sunday brunch with friends',
              },
            ],
            source: 'sets',
          });
        },
      );

      // Missing export AND missing sets.json -> source: 'none', occasions: []
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: path.join(tmpSetsDir, 'missing.json') },
          loadLibrary: async () => ({}),
        },
        async (url) => {
          const res = await fetch(`${url}/api/occasions?department=men`);
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), {
            department: 'men',
            occasions: [],
            source: 'none',
          });
        },
      );
    } finally {
      fs.rmSync(tmpSetsDir, { recursive: true, force: true });
    }
  });

  it('clamps /api/storefront wait=<ms> to 500..6000 with 4000ms default', async () => {
    const seenBudgets: Array<number | undefined> = [];
    await withServer(
      {
        store: {
          storefront: async (department, opts) => {
            seenBudgets.push(opts?.budgetMs);
            return {
              department,
              sections: [],
              ms: 1,
              storefront: { searches: 0, shared: false },
            };
          },
        },
      },
      async (url) => {
        await fetch(`${url}/api/storefront`);
        await fetch(`${url}/api/storefront?wait=100`);
        await fetch(`${url}/api/storefront?wait=2200`);
        await fetch(`${url}/api/storefront?wait=99999`);
        assert.deepEqual(seenBudgets, [4000, 500, 2200, 6000]);
      },
    );
  });

  it('enforces the timing budgets on all browse routes with slow fakes', async () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => {});

    await withServer(
      {
        env: { ALICE_LIBRARY_FILE: path.join(os.tmpdir(), 'alice-nonexistent-sets.json') },
        store: {
          searchMixed: () => never(),
          search: async (query, gender) => {
            if (query === "women's dress") {
              return {
                items: [
                  sampleItem('fast-dress-1', gender),
                  sampleItem('fast-dress-2', gender),
                  sampleItem('fast-dress-3', gender),
                  sampleItem('fast-dress-4', gender),
                ],
                source: 'live',
                ms: 5,
              };
            }
            return never();
          },
          getProduct: () => never(),
        },
        loadLibrary: async () => ({
          libraryLooks: () => never(),
          libraryOccasions: () => never(),
        }),
      },
      async (url) => {
        const timedFetch = async (p: string) => {
          const t0 = Date.now();
          const res = await fetch(`${url}${p}`);
          const ms = Date.now() - t0;
          const body = (await res.json()) as Record<string, unknown>;
          return { status: res.status, ms, body };
        };

        // Run all five slow-fake budget checks in parallel (~1.4s total; storefront uses wait=500)
        const [sf, prod, srch, lks, occ] = await Promise.all([
          timedFetch('/api/storefront?department=women&wait=500'),
          timedFetch('/api/product?variant_id=gid%3A%2F%2Fshopify%2FProductVariant%2F41356358090885'),
          timedFetch('/api/search?q=linen+blazer&department=women'),
          timedFetch('/api/looks?department=men'),
          timedFetch('/api/occasions?department=men'),
        ]);

        assert.equal(sf.status, 200);
        assert.equal(sf.body.partial, true);
        assert.equal((sf.body.sections as unknown[]).length, 1);
        assert.ok(sf.ms < 800, `/api/storefront wait=500 exceeded budget: ${sf.ms}ms`);

        assert.equal(prod.status, 504);
        assert.deepEqual(prod.body, { error: 'slow_store' });
        assert.ok(prod.ms < 1500, `/api/product exceeded budget: ${prod.ms}ms`);

        assert.equal(srch.status, 200);
        assert.deepEqual(srch.body, { query: 'linen blazer', items: [] });
        assert.ok(srch.ms < 1500, `/api/search exceeded budget: ${srch.ms}ms`);

        assert.equal(lks.status, 200);
        assert.equal(lks.body.source, 'fixture');
        assert.ok((lks.body.looks as unknown[]).length > 0);
        assert.ok(lks.ms < 1550, `/api/looks exceeded budget: ${lks.ms}ms`);

        assert.equal(occ.status, 200);
        assert.deepEqual(occ.body, { department: 'men', occasions: [], source: 'none' });
        assert.ok(occ.ms < 1550, `/api/occasions exceeded budget: ${occ.ms}ms`);
      },
    );
  });

  it('enforces a shared 90 requests/minute rate limit across all four browse routes', async () => {
    await withServer(
      {
        store: {
          storefront: async (department) => ({
            department,
            sections: [],
            ms: 1,
            storefront: { searches: 0, shared: false },
          }),
          searchMixed: async () => ({ items: [], source: 'empty', ms: 1 }),
          getProduct: async () => null,
        },
        loadLibrary: async () => null,
      },
      async (url) => {
        const routes = [
          '/api/storefront',
          '/api/search?q=hat',
          '/api/looks',
          '/api/product?variant_id=gid%3A%2F%2Fshopify%2FProductVariant%2F1',
        ];
        for (let i = 0; i < 90; i += 1) {
          const res = await fetch(`${url}${routes[i % routes.length]}`);
          assert.notEqual(res.status, 429, `unexpected 429 on request #${i + 1}`);
        }
        const blocked = await fetch(`${url}/api/storefront`);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get('cache-control'), 'no-store');
        assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
        assert.deepEqual(await blocked.json(), { error: 'slow_down' });
      },
    );
  });
});
