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

        // 4. GET only -> 405 on POST for all six browse routes
        for (const p of [
          '/api/storefront',
          '/api/product',
          '/api/search',
          '/api/looks',
          '/api/occasions',
          '/api/occasions/match',
        ]) {
          const postRes = await fetch(`${url}${p}`, { method: 'POST' });
          assert.equal(postRes.status, 405, `expected 405 for POST ${p}`);
          assert.equal(postRes.headers.get('allow'), 'GET');
        }
      },
    );
  });

  it('serves /api/looks across library present, missing, throwing, and slow fallback, plus occasion queries', async () => {
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

    const seenCalls: Array<{ gender: Gender; opts?: { limit?: number; occasion?: string } }> = [];

    try {
      // 1. Export present (no occasion, known keys/slugs, unknown text blocked, and bad_occasion 400)
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async (gender: Gender, opts?: { limit?: number; occasion?: string }) => {
              seenCalls.push({ gender, opts });
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

          // Known raw key, uppercase key, and slug all pass the set key ('rooftop-birthday')
          for (const rawParam of [
            ' rooftop-birthday ',
            'ROOFTOP-BIRTHDAY',
            'a-friends-rooftop-birthday-party',
          ]) {
            const beforeCalls = seenCalls.length;
            const occRes = await fetch(
              `${url}/api/looks?department=men&limit=3&occasion=${encodeURIComponent(rawParam)}`,
            );
            assert.equal(occRes.status, 200);
            assert.equal(occRes.headers.get('cache-control'), 'no-store');
            const occBody = (await occRes.json()) as {
              department: string;
              occasion: string | null;
              looks: Outfit[];
              source: string;
            };
            assert.equal(occBody.department, 'men');
            assert.equal(occBody.occasion, rawParam.trim());
            assert.equal(occBody.source, 'library');
            assert.equal(occBody.looks.length, 2);
            assert.equal(seenCalls.length, beforeCalls + 1);
            assert.deepEqual(seenCalls[seenCalls.length - 1], {
              gender: 'men',
              opts: { limit: 3, occasion: 'rooftop-birthday' },
            });
          }

          // Unknown text returns empty library answer WITHOUT calling libraryLooks
          for (const unknownText of ['nonsense xyz', 'rooftop birthday', 'beach']) {
            const callsBeforeUnknown = seenCalls.length;
            const emptyOccRes = await fetch(
              `${url}/api/looks?department=men&occasion=${encodeURIComponent(unknownText)}`,
            );
            assert.equal(emptyOccRes.status, 200);
            assert.equal(emptyOccRes.headers.get('cache-control'), 'no-store');
            const emptyOccBody = (await emptyOccRes.json()) as {
              department: string;
              occasion: string | null;
              looks: Outfit[];
              source: string;
            };
            assert.equal(emptyOccBody.department, 'men');
            assert.equal(emptyOccBody.occasion, unknownText);
            assert.equal(emptyOccBody.source, 'library');
            assert.deepEqual(emptyOccBody.looks, []);
            assert.equal(
              seenCalls.length,
              callsBeforeUnknown,
              `libraryLooks must not be called for unknown occasion "${unknownText}"`,
            );
          }

          // Over-120-character occasion -> 400 bad_occasion
          const longOcc = await fetch(`${url}/api/looks?occasion=${'a'.repeat(121)}`);
          assert.equal(longOcc.status, 400);
          assert.equal(longOcc.headers.get('cache-control'), 'no-store');
          assert.deepEqual(await longOcc.json(), { error: 'bad_occasion' });
        },
      );

      // 2. Export missing -> fixture fallback when no occasion; empty library for a known key
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
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
          // Menswear fixture must never leak onto the women's page
          assert.deepEqual(womenBody.looks, []);

          const knownMissing = await fetch(
            `${url}/api/looks?department=men&occasion=rooftop-birthday`,
          );
          assert.equal(knownMissing.status, 200);
          assert.deepEqual(await knownMissing.json(), {
            department: 'men',
            occasion: 'rooftop-birthday',
            looks: [],
            source: 'library',
          });
        },
      );

      // 3. Export throws -> fixture fallback when no occasion, empty library when known key given
      let throwCalls = 0;
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async () => {
              throwCalls += 1;
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

          const beforeThrow = throwCalls;
          const occThrow = await fetch(
            `${url}/api/looks?department=men&occasion=rooftop-birthday`,
          );
          assert.equal(occThrow.status, 200);
          const occThrowBody = (await occThrow.json()) as {
            occasion: string | null;
            source: string;
            looks: Outfit[];
          };
          assert.equal(occThrowBody.occasion, 'rooftop-birthday');
          assert.equal(occThrowBody.source, 'library');
          assert.deepEqual(occThrowBody.looks, []);
          assert.equal(throwCalls, beforeThrow + 1);
        },
      );

      // 4. GET /api/occasions across libraryOccasions present, sets.json fallback (missing/throws), and none
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
            occasionMenu: async (gender: Gender) =>
              gender === 'men'
                ? [{ key: 'rooftop-birthday', keyword: 'Birthday Party' }]
                : [{ key: 'brunch', keyword: 'Brunch' }],
          }),
        },
        async (url) => {
          const menOcc = await fetch(`${url}/api/occasions?department=men`);
          assert.equal(menOcc.status, 200);
          assert.equal(menOcc.headers.get('cache-control'), 'no-store');
          assert.equal(menOcc.headers.get('x-content-type-options'), 'nosniff');
          assert.deepEqual(await menOcc.json(), {
            department: 'men',
            occasions: [
              {
                key: 'rooftop-birthday',
                occasion: "a friend's rooftop birthday party",
                label: 'Rooftop birthday',
              },
            ],
            menu: [{ key: 'rooftop-birthday', keyword: 'Birthday Party' }],
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
            menu: [{ key: 'brunch', keyword: 'Brunch' }],
            source: 'library',
          });
        },
      );

      // Missing export -> falls back to sets.json with source: 'sets' and slug/capitalised label;
      // and /api/looks?occasion=<slug> maps the slug to the set's rawKey before calling libraryLooks.
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
            menu: Array<{ key: string; keyword: string }>;
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
            menu: [],
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
            occasion: 'rooftop-birthday',
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
            menu: [],
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
            menu: [],
            source: 'none',
          });
        },
      );

      // 5. Memoisation of sets.json reloads when mtime or size changes
      const memoSeen: Array<string | undefined> = [];
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async (gender: Gender, opts?: { occasion?: string }) => {
              memoSeen.push(opts?.occasion);
              return [sampleOutfit(gender)];
            },
          }),
        },
        async (url) => {
          const first = await fetch(`${url}/api/looks?department=men&occasion=rooftop-birthday`);
          assert.equal(first.status, 200);
          assert.equal(((await first.json()) as { looks: Outfit[] }).looks.length, 1);

          const second = await fetch(`${url}/api/looks?department=men&occasion=rooftop-birthday`);
          assert.equal(second.status, 200);
          assert.equal(((await second.json()) as { looks: Outfit[] }).looks.length, 1);
          assert.deepEqual(memoSeen, ['rooftop-birthday', 'rooftop-birthday']);

          // Rewrite sets file with a different key (and bump mtime + change size)
          fs.writeFileSync(
            tmpSetsFile,
            JSON.stringify({
              version: 1,
              sets: [
                {
                  key: 'gallery-opening-night',
                  gender: 'men',
                  occasion: 'a late evening contemporary art gallery opening',
                  outfits: [sampleOutfit('men')],
                },
                {
                  gender: 'men',
                  occasion: 'casual coffee walk',
                  outfits: [sampleOutfit('men')],
                },
              ],
            }),
          );
          const future = new Date(Date.now() + 2000);
          fs.utimesSync(tmpSetsFile, future, future);

          const newKeyRes = await fetch(
            `${url}/api/looks?department=men&occasion=gallery-opening-night`,
          );
          assert.equal(newKeyRes.status, 200);
          assert.equal(((await newKeyRes.json()) as { looks: Outfit[] }).looks.length, 1);
          assert.equal(memoSeen[memoSeen.length - 1], 'gallery-opening-night');

          // Entry without rawKey falls back to passing matched.occasion
          const noRawKeyRes = await fetch(
            `${url}/api/looks?department=men&occasion=casual-coffee-walk`,
          );
          assert.equal(noRawKeyRes.status, 200);
          assert.equal(((await noRawKeyRes.json()) as { looks: Outfit[] }).looks.length, 1);
          assert.equal(memoSeen[memoSeen.length - 1], 'casual coffee walk');

          // Old key is now unknown and must not invoke libraryLooks
          const countBeforeOld = memoSeen.length;
          const oldKeyRes = await fetch(
            `${url}/api/looks?department=men&occasion=rooftop-birthday`,
          );
          assert.equal(oldKeyRes.status, 200);
          assert.deepEqual(await oldKeyRes.json(), {
            department: 'men',
            occasion: 'rooftop-birthday',
            looks: [],
            source: 'library',
          });
          assert.equal(memoSeen.length, countBeforeOld);
        },
      );

      // 6. In-flight sharing deduplicates concurrent identical /api/looks calls without caching results
      let inFlightCalls = 0;
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async (gender: Gender) => {
              inFlightCalls += 1;
              const callNum = inFlightCalls;
              await new Promise((resolve) => setTimeout(resolve, 150));
              return [{ ...sampleOutfit(gender), name: `Call ${callNum}` }];
            },
          }),
        },
        async (url) => {
          const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
              fetch(`${url}/api/looks?department=men&occasion=gallery-opening-night`),
            ),
          );
          const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
            department: string;
            occasion: string;
            looks: Outfit[];
            source: string;
          }>;
          for (const res of responses) {
            assert.equal(res.status, 200);
          }
          assert.equal(inFlightCalls, 1);
          for (const b of bodies) {
            assert.equal(b.source, 'library');
            assert.deepEqual(b.looks, bodies[0].looks);
            assert.equal(b.looks[0].name, 'Call 1');
          }

          // A 6th request after the batch settles starts a fresh libraryLooks call (nothing cached)
          const sixth = await fetch(
            `${url}/api/looks?department=men&occasion=gallery-opening-night`,
          );
          assert.equal(sixth.status, 200);
          const sixthBody = (await sixth.json()) as { looks: Outfit[] };
          assert.equal(inFlightCalls, 2);
          assert.equal(sixthBody.looks[0].name, 'Call 2');
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

        // Run all five slow-fake budget checks in parallel (default /api/looks uses 4 s; others <= 1.4 s)
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
        assert.ok(lks.ms >= 3800 && lks.ms < 4500, `/api/looks default budget unexpected: ${lks.ms}ms`);

        assert.equal(occ.status, 200);
        assert.deepEqual(occ.body, { department: 'men', occasions: [], menu: [], source: 'none' });
        assert.ok(occ.ms < 1550, `/api/occasions exceeded budget: ${occ.ms}ms`);
      },
    );
  });

  it('gives default /api/looks 4 s (2.5 s library succeeds, concurrent share 1 call), keeps 1.4 s with occasion, keeps timed-out calls in flight, and filters fixture by department', async () => {
    const tmpSetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-looks-budget-'));
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
        ],
      }),
    );

    try {
      // 1. Default budgets: 2.5 s library succeeds for no-occasion (2 concurrent -> 1 call),
      //    while with-occasion times out at 1.4 s.
      let defaultCalls = 0;
      let occasionCalls = 0;
      await withServer(
        {
          env: { ALICE_LIBRARY_FILE: tmpSetsFile },
          loadLibrary: async () => ({
            libraryLooks: async (gender: Gender, opts?: { occasion?: string }) => {
              if (opts?.occasion) {
                occasionCalls += 1;
              } else {
                defaultCalls += 1;
              }
              await new Promise((resolve) => setTimeout(resolve, 2500));
              return [sampleOutfit(gender)];
            },
          }),
        },
        async (url) => {
          const tOcc0 = Date.now();
          const occPromise = fetch(`${url}/api/looks?department=men&occasion=rooftop-birthday`).then(
            async (r) => ({
              status: r.status,
              ms: Date.now() - tOcc0,
              body: (await r.json()) as { source: string; looks: Outfit[]; occasion: string | null },
            }),
          );

          const [def1Res, def2Res, occRes] = await Promise.all([
            fetch(`${url}/api/looks?department=women`),
            fetch(`${url}/api/looks?department=women`),
            occPromise,
          ]);

          assert.equal(def1Res.status, 200);
          assert.equal(def2Res.status, 200);
          const def1 = (await def1Res.json()) as {
            department: string;
            source: string;
            looks: Outfit[];
          };
          const def2 = (await def2Res.json()) as {
            department: string;
            source: string;
            looks: Outfit[];
          };
          assert.equal(defaultCalls, 1, 'two concurrent no-occasion requests must share one library call');
          assert.equal(def1.source, 'library');
          assert.equal(def1.looks.length, 1);
          assert.equal(def1.looks[0].pieces[0].item.department, 'women');
          assert.deepEqual(def2, def1);

          assert.equal(occasionCalls, 1);
          assert.equal(occRes.status, 200);
          assert.equal(occRes.body.source, 'library');
          assert.deepEqual(occRes.body.looks, []);
          assert.ok(
            occRes.ms >= 1300 && occRes.ms < 1900,
            `with-occasion request should keep 1.4 s budget, took ${occRes.ms}ms`,
          );
        },
      );

      // 2. When library exceeds budget: women get empty list with menswear fixture, timeout=true is logged,
      //    and the timed-out promise stays in flight so the next request joins it (still 1 library call).
      let slowWomenCalls = 0;
      let resolveSlowWomen!: (outfits: Outfit[]) => void;
      const slowWomenPromise = new Promise<Outfit[]>((resolve) => {
        resolveSlowWomen = resolve;
      });
      const loggedLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        loggedLines.push(args.map(String).join(' '));
      };

      try {
        await withServer(
          {
            budgets: { looksDefaultMs: 120 },
            loadLibrary: async () => ({
              libraryLooks: async (gender: Gender) => {
                if (gender === 'women') {
                  slowWomenCalls += 1;
                  return slowWomenPromise;
                }
                return new Promise<Outfit[]>(() => {});
              },
            }),
          },
          async (url) => {
            // Women timeout -> menswear fixture filtered to [] + timeout=true in log
            const womenTimedOut = await fetch(`${url}/api/looks?department=women`);
            assert.equal(womenTimedOut.status, 200);
            assert.deepEqual(await womenTimedOut.json(), {
              department: 'women',
              occasion: null,
              looks: [],
              source: 'fixture',
            });
            assert.equal(slowWomenCalls, 1);
            assert.ok(
              loggedLines.some(
                (line) =>
                  line.includes('GET /api/looks 200') &&
                  line.includes('dept=women source=fixture n=0 timeout=true'),
              ),
              `expected timeout=true in log, got: ${loggedLines.join('\n')}`,
            );

            // Second request joins the still-running promise instead of starting a second call
            const secondReq = fetch(`${url}/api/looks?department=women`);
            setTimeout(() => resolveSlowWomen([sampleOutfit('women')]), 25);
            const secondRes = await secondReq;
            assert.equal(secondRes.status, 200);
            const secondBody = (await secondRes.json()) as {
              source: string;
              looks: Outfit[];
            };
            assert.equal(slowWomenCalls, 1, 'timed-out library promise must stay in flight for joiners');
            assert.equal(secondBody.source, 'library');
            assert.equal(secondBody.looks.length, 1);

            // Men timeout -> gets men's looks from fixture
            const menTimedOut = await fetch(`${url}/api/looks?department=men`);
            assert.equal(menTimedOut.status, 200);
            const menBody = (await menTimedOut.json()) as { source: string; looks: Outfit[] };
            assert.equal(menBody.source, 'fixture');
            assert.ok(menBody.looks.length > 0);
            for (const look of menBody.looks) {
              assert.ok(look.pieces.every((p) => p.item.department === 'men'));
            }
          },
        );
      } finally {
        console.log = origLog;
      }

      // 3. Mixed fixture file: filters strictly by piece department (allowing untagged pieces)
      const mixedPublicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-mixed-fixture-'));
      try {
        const untaggedOutfit = sampleOutfit('women');
        delete (untaggedOutfit.pieces[0].item as Partial<Item>).department;
        fs.writeFileSync(
          path.join(mixedPublicDir, 'fixture.json'),
          JSON.stringify({
            brief: { gender: 'men' },
            outfits: [sampleOutfit('men'), sampleOutfit('women'), untaggedOutfit],
          }),
        );

        await withServer(
          {
            publicDir: mixedPublicDir,
            loadLibrary: async () => null,
          },
          async (url) => {
            const wRes = await fetch(`${url}/api/looks?department=women`);
            const wBody = (await wRes.json()) as { source: string; looks: Outfit[] };
            assert.equal(wBody.source, 'fixture');
            assert.equal(wBody.looks.length, 2);
            assert.ok(
              wBody.looks.every((o) =>
                o.pieces.every((p) => !p.item.department || p.item.department === 'women'),
              ),
            );
          },
        );
      } finally {
        fs.rmSync(mixedPublicDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpSetsDir, { recursive: true, force: true });
    }
  });

  it('serves /api/occasions menu and /api/occasions/match with validation, truncation, error handling, and zero looks calls', async () => {
    const matchCalls: Array<{ gender: Gender; text: string }> = [];
    let looksCalls = 0;
    let storeCalls = 0;

    // 1. Menu for both departments + match route behavior (valid, empty, >120 chars cut, bad department, no looks/store calls)
    await withServer(
      {
        store: {
          storefront: async () => {
            storeCalls += 1;
            throw new Error('storefront must not be called');
          },
          search: async () => {
            storeCalls += 1;
            throw new Error('search must not be called');
          },
          searchMixed: async () => {
            storeCalls += 1;
            throw new Error('searchMixed must not be called');
          },
          getProduct: async () => {
            storeCalls += 1;
            throw new Error('getProduct must not be called');
          },
        },
        loadLibrary: async () => ({
          libraryLooks: async () => {
            looksCalls += 1;
            throw new Error('libraryLooks must not be called by /api/occasions/match');
          },
          libraryOccasions: async (gender: Gender) => [
            {
              key: gender === 'men' ? 'rooftop-birthday' : 'gala',
              occasion: gender === 'men' ? 'rooftop birthday' : 'black tie gala',
              label: gender === 'men' ? 'Rooftop birthday' : 'Black tie gala',
            },
          ],
          occasionMenu: async (gender: Gender) =>
            gender === 'men'
              ? [
                  { key: 'rooftop-birthday', keyword: 'Birthday Party' },
                  { key: 'festival', keyword: 'Festival' },
                ]
              : [
                  { key: 'gala', keyword: 'Gala' },
                  { key: 'brunch', keyword: 'Brunch' },
                ],
          matchOccasionWords: async (gender: Gender, text: string) => {
            matchCalls.push({ gender, text });
            if (text === 'bday dinner') {
              return { key: 'rooftop-birthday', label: 'Rooftop birthday', score: 0.92 };
            }
            if (text === 'zzzz') {
              return null;
            }
            return { key: 'festival', label: 'Festival', score: 0.75 };
          },
        }),
      },
      async (url) => {
        // Menu present for both departments
        const menOcc = await fetch(`${url}/api/occasions?department=men`);
        assert.equal(menOcc.status, 200);
        const menBody = (await menOcc.json()) as {
          department: string;
          menu: Array<{ key: string; keyword: string }>;
        };
        assert.deepEqual(menBody.menu, [
          { key: 'rooftop-birthday', keyword: 'Birthday Party' },
          { key: 'festival', keyword: 'Festival' },
        ]);

        const womenOcc = await fetch(`${url}/api/occasions?department=women`);
        assert.equal(womenOcc.status, 200);
        const womenBody = (await womenOcc.json()) as {
          department: string;
          menu: Array<{ key: string; keyword: string }>;
        };
        assert.deepEqual(womenBody.menu, [
          { key: 'gala', keyword: 'Gala' },
          { key: 'brunch', keyword: 'Brunch' },
        ]);

        // Match returns function result with nosniff + no-store
        const matchRes = await fetch(`${url}/api/occasions/match?department=men&q=bday+dinner`);
        assert.equal(matchRes.status, 200);
        assert.equal(matchRes.headers.get('cache-control'), 'no-store');
        assert.equal(matchRes.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(await matchRes.json(), {
          match: { key: 'rooftop-birthday', label: 'Rooftop birthday', score: 0.92 },
        });

        // Unmatched query -> { match: null }
        const missRes = await fetch(`${url}/api/occasions/match?department=women&q=zzzz`);
        assert.equal(missRes.status, 200);
        assert.deepEqual(await missRes.json(), { match: null });

        // Empty / whitespace q -> { match: null } without invoking matchOccasionWords
        const callsBeforeEmpty = matchCalls.length;
        const emptyRes = await fetch(`${url}/api/occasions/match?department=men&q=%20%20%20`);
        assert.equal(emptyRes.status, 200);
        assert.deepEqual(await emptyRes.json(), { match: null });
        assert.equal(matchCalls.length, callsBeforeEmpty);

        // q longer than 120 chars is trimmed and cut to 120 before calling matchOccasionWords
        const longQuery = `  ${'x'.repeat(145)}  `;
        const longRes = await fetch(
          `${url}/api/occasions/match?department=women&q=${encodeURIComponent(longQuery)}`,
        );
        assert.equal(longRes.status, 200);
        assert.equal(matchCalls[matchCalls.length - 1].gender, 'women');
        assert.equal(matchCalls[matchCalls.length - 1].text.length, 120);
        assert.equal(matchCalls[matchCalls.length - 1].text, 'x'.repeat(120));

        // Missing or bad department -> 400 { error: 'bad_department' }
        for (const badPath of [
          '/api/occasions/match?q=tux',
          '/api/occasions/match?department=&q=tux',
          '/api/occasions/match?department=kids&q=tux',
        ]) {
          const badRes = await fetch(`${url}${badPath}`);
          assert.equal(badRes.status, 400, `expected 400 for ${badPath}`);
          assert.equal(badRes.headers.get('cache-control'), 'no-store');
          assert.equal(badRes.headers.get('x-content-type-options'), 'nosniff');
          assert.deepEqual(await badRes.json(), { error: 'bad_department' });
        }

        // Must never touch looks/embedding or store dependencies
        assert.equal(looksCalls, 0);
        assert.equal(storeCalls, 0);
      },
    );

    // 2. Throwing occasionMenu leaves rest of /api/occasions intact with menu: []; throwing matchOccasionWords -> { match: null }
    await withServer(
      {
        loadLibrary: async () => ({
          libraryOccasions: async () => [
            { key: 'brunch', occasion: 'sunday brunch', label: 'Sunday brunch' },
          ],
          occasionMenu: async () => {
            throw new Error('menu exploded');
          },
          matchOccasionWords: async () => {
            throw new Error('matcher exploded');
          },
        }),
      },
      async (url) => {
        const occRes = await fetch(`${url}/api/occasions?department=women`);
        assert.equal(occRes.status, 200);
        assert.deepEqual(await occRes.json(), {
          department: 'women',
          occasions: [{ key: 'brunch', occasion: 'sunday brunch', label: 'Sunday brunch' }],
          menu: [],
          source: 'library',
        });

        const matchRes = await fetch(`${url}/api/occasions/match?department=women&q=brunch`);
        assert.equal(matchRes.status, 200);
        assert.equal(matchRes.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await matchRes.json(), { match: null });
      },
    );
  });

  it('enforces a shared 90 requests/minute rate limit across all browse routes including /api/occasions/match', async () => {
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
        loadLibrary: async () => ({
          matchOccasionWords: async () => null,
        }),
      },
      async (url) => {
        const routes = [
          '/api/storefront',
          '/api/search?q=hat',
          '/api/looks',
          '/api/product?variant_id=gid%3A%2F%2Fshopify%2FProductVariant%2F1',
          '/api/occasions/match?department=men&q=tux',
        ];
        for (let i = 0; i < 90; i += 1) {
          const res = await fetch(`${url}${routes[i % routes.length]}`);
          assert.notEqual(res.status, 429, `unexpected 429 on request #${i + 1}`);
        }
        const blocked = await fetch(`${url}/api/occasions/match?department=men&q=tux`);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get('cache-control'), 'no-store');
        assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
        assert.deepEqual(await blocked.json(), { error: 'slow_down' });
      },
    );
  });
});

describe('Public URL / reverse proxy hardening', () => {
  const lkEnv: Record<string, string | undefined> = {
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'x'.repeat(40),
    LIVEKIT_URL: 'wss://example.livekit.cloud',
  };

  async function withTestServer(
    opts: Parameters<typeof createAliceServer>[0],
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const srv = createAliceServer(opts);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const srvPort = (srv.address() as AddressInfo).port;
    try {
      await fn(srvPort);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it('fails closed for proxied or non-local-Host /api/token requests when ALICE_PASSCODE is unset, while direct loopback works', async () => {
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    let currentAddr: string | undefined = '127.0.0.1';
    const env: Record<string, string | undefined> = { ...lkEnv };

    await withTestServer(
      {
        env,
        remoteAddress: () => currentAddr,
        calllog: (room, ev, data) => events.push({ room, ev, data }),
      },
      async (srvPort) => {
        // Every proxy header family must be refused with 403 passcode_not_configured and no token minted
        const proxyHeaderCases: Array<Record<string, string>> = [
          { 'CF-Connecting-IP': '203.0.113.9' },
          { 'CF-Ray': '8a1b2c3d4e5f-EWR' },
          { 'X-Forwarded-For': '198.51.100.7' },
          { 'X-Forwarded-Host': 'alice.example.com' },
          { 'X-Forwarded-Proto': 'https' },
          { Forwarded: 'for=198.51.100.7;proto=https' },
          { 'X-Real-IP': '198.51.100.7' },
          { 'True-Client-IP': '198.51.100.7' },
          { 'ngrok-skip-browser-warning': '1' },
          { 'x-ngrok-edge': 'edghts_123' },
        ];

        for (const hdrs of proxyHeaderCases) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: hdrs,
          });
          assert.equal(res.status, 403, `expected 403 for headers ${JSON.stringify(hdrs)}`);
          const body = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
          assert.deepEqual(body, { error: 'passcode_not_configured' });
          assert.equal(body.token, undefined);
        }

        // Non-local Host header with NO proxy headers (header-less tunnel / DNS rebinding) -> 403
        for (const badHost of [
          'example.trycloudflare.com',
          'localhost.evil.com',
          '127.0.0.1.evil.com',
          '192.168.1.50:3000',
        ]) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { Host: badHost },
          });
          assert.equal(res.status, 403, `expected 403 for Host: ${badHost}`);
          assert.deepEqual(JSON.parse(res.body.toString('utf8')), {
            error: 'passcode_not_configured',
          });
        }

        // Direct loopback + local Host header (127.0.0.1, localhost, [::1]) + no proxy headers -> 200
        for (const [sock, hostHdr] of [
          ['127.0.0.1', `127.0.0.1:${srvPort}`],
          ['::1', `[::1]:${srvPort}`],
          ['::ffff:127.0.0.1', `localhost:${srvPort}`],
        ] as const) {
          currentAddr = sock;
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { Host: hostHdr },
          });
          assert.equal(res.status, 200, `expected 200 for direct ${sock} Host=${hostHdr}`);
          const body = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
          assert.equal(typeof body.token, 'string');
        }

        // ALICE_TRUST_PROXY=1 with empty ALICE_PASSCODE refuses EVERY token mint (even plain localhost)
        currentAddr = '127.0.0.1';
        env.ALICE_TRUST_PROXY = '1';
        const plainInProxyMode = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { Host: `localhost:${srvPort}` },
        });
        assert.equal(plainInProxyMode.status, 403);
        assert.deepEqual(JSON.parse(plainInProxyMode.body.toString('utf8')), {
          error: 'passcode_not_configured',
        });
        const lastEv = events[events.length - 1];
        assert.equal(lastEv.ev, 'token_refused');
        assert.equal(lastEv.data?.reason, 'passcode_not_configured');
        assert.equal(lastEv.data?.remote_addr, 'proxy-unknown');
        assert.equal(lastEv.data?.socket_addr, '127.0.0.1');
      },
    );
  });

  it('buckets clients accurately with ALICE_TRUST_PROXY on/off, rightmost XFF, shared fallback bucket, and non-loopback ignore', async () => {
    let nowMs = 1_000_000;
    let currentAddr = '127.0.0.1';
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

    // 1. Trust ON + loopback socket
    await withTestServer(
      {
        env: { ...lkEnv, ALICE_PASSCODE: 'test-pass-1234', ALICE_TRUST_PROXY: '1' },
        remoteAddress: () => currentAddr,
        now: () => nowMs,
        calllog: (room, ev, data) => events.push({ room, ev, data }),
      },
      async (srvPort) => {
        // Two visitors with different CF-Connecting-IP get separate 20/min buckets
        for (let i = 0; i < 20; i += 1) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { 'x-alice-passcode': 'test-pass-1234', 'CF-Connecting-IP': '203.0.113.10' },
          });
          assert.equal(res.status, 200);
        }
        const aBlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'test-pass-1234', 'CF-Connecting-IP': '203.0.113.10' },
        });
        assert.equal(aBlocked.status, 429);

        // Visitor B has its own fresh bucket and logs both remote_addr and socket_addr
        const bAllowed = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'test-pass-1234', 'CF-Connecting-IP': '203.0.113.11' },
        });
        assert.equal(bAllowed.status, 200);
        const lastTokenEv = events[events.length - 1];
        assert.equal(lastTokenEv.ev, 'token');
        assert.equal(lastTokenEv.data?.remote_addr, '203.0.113.11');
        assert.equal(lastTokenEv.data?.socket_addr, '127.0.0.1');

        // Forged left entry in X-Forwarded-For does NOT move the bucket (rightmost wins)
        for (let i = 0; i < 20; i += 1) {
          const forgedLeft = `198.51.100.${i + 1}, 203.0.113.50`;
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { 'x-alice-passcode': 'test-pass-1234', 'X-Forwarded-For': forgedLeft },
          });
          assert.equal(res.status, 200);
        }
        const xffBlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            'x-alice-passcode': 'test-pass-1234',
            'X-Forwarded-For': '198.51.100.250, 203.0.113.50',
          },
        });
        assert.equal(xffBlocked.status, 429);
        assert.equal(events[events.length - 1].data?.remote_addr, '203.0.113.50');

        // Missing or unparsable forwarded headers share ONE shared bucket (never loopback)
        for (let i = 0; i < 20; i += 1) {
          currentAddr = i % 2 === 0 ? '127.0.0.1' : '::1';
          const hdrs: Record<string, string> =
            i % 3 === 0
              ? { 'x-alice-passcode': 'test-pass-1234' }
              : i % 3 === 1
                ? { 'x-alice-passcode': 'test-pass-1234', 'CF-Connecting-IP': 'not-an-ip' }
                : { 'x-alice-passcode': 'test-pass-1234', 'X-Forwarded-For': `198.51.100.${i}, garbage` };
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: hdrs,
          });
          assert.equal(res.status, 200);
        }
        currentAddr = '127.0.0.1';
        const sharedFallbackBlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'test-pass-1234' },
        });
        assert.equal(sharedFallbackBlocked.status, 429);
        assert.equal(events[events.length - 1].data?.remote_addr, 'proxy-unknown');

        // Non-loopback socket + trust ON -> headers completely ignored
        currentAddr = '192.168.1.77';
        for (let i = 0; i < 20; i += 1) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: {
              'x-alice-passcode': 'test-pass-1234',
              'CF-Connecting-IP': `203.0.113.${100 + i}`,
            },
          });
          assert.equal(res.status, 200);
        }
        const lanBlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'test-pass-1234', 'CF-Connecting-IP': '203.0.113.222' },
        });
        assert.equal(lanBlocked.status, 429);
        assert.equal(events[events.length - 1].data?.remote_addr, '192.168.1.77');
      },
    );

    // 2. Trust OFF -> proxy headers NEVER change the bucket
    currentAddr = '127.0.0.1';
    await withTestServer(
      {
        env: { ...lkEnv, ALICE_PASSCODE: 'test-pass' },
        remoteAddress: () => currentAddr,
        now: () => nowMs,
      },
      async (srvPort) => {
        for (let i = 0; i < 20; i += 1) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: {
              'x-alice-passcode': 'test-pass',
              'CF-Connecting-IP': `203.0.113.${i + 1}`,
            },
          });
          assert.equal(res.status, 200);
        }
        const blocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'test-pass', 'CF-Connecting-IP': '203.0.113.99' },
        });
        assert.equal(blocked.status, 429);
      },
    );
  });

  it('enforces per-client (5/min) and global (600/min) bad passcode lockouts without oracle, and refuses passcodes < 12 chars in proxy mode', async () => {
    let nowMs = 2_000_000;
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const env: Record<string, string | undefined> = {
      ...lkEnv,
      ALICE_PASSCODE: 'short-11-ch',
      ALICE_TRUST_PROXY: '1',
    };

    await withTestServer(
      {
        env,
        remoteAddress: () => '127.0.0.1',
        now: () => nowMs,
        calllog: (room, ev, data) => events.push({ room, ev, data }),
      },
      async (srvPort) => {
        // Short passcode (< 12 chars) in proxy mode -> 403 passcode_too_short even with matching passcode
        const tooShort = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'short-11-ch', 'CF-Connecting-IP': '203.0.113.1' },
        });
        assert.equal(tooShort.status, 403);
        assert.deepEqual(JSON.parse(tooShort.body.toString('utf8')), {
          error: 'passcode_too_short',
        });
        assert.equal(events[events.length - 1].ev, 'token_refused');
        assert.equal(events[events.length - 1].data?.reason, 'passcode_too_short');

        // Outside proxy mode, short passcode is accepted as before
        env.ALICE_TRUST_PROXY = '0';
        const shortNonProxy = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'short-11-ch' },
        });
        assert.equal(shortNonProxy.status, 200);

        // Restore proxy mode with a >= 12 char passcode
        env.ALICE_TRUST_PROXY = '1';
        env.ALICE_PASSCODE = 'correct-horse-battery-staple';

        // 5 bad passcodes from client 1 -> 401
        for (let i = 0; i < 5; i += 1) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { 'x-alice-passcode': `wrong-${i}`, 'CF-Connecting-IP': '10.0.0.1' },
          });
          assert.equal(res.status, 401);
        }

        // 6th bad passcode -> 429 passcode_locked with Retry-After
        const sixthBad = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'wrong-6', 'CF-Connecting-IP': '10.0.0.1' },
        });
        assert.equal(sixthBad.status, 429);
        assert.ok(Number(sixthBad.headers['retry-after']) >= 1);
        assert.deepEqual(JSON.parse(sixthBad.body.toString('utf8')), { error: 'passcode_locked' });
        assert.equal(events[events.length - 1].ev, 'token_refused');
        assert.equal(events[events.length - 1].data?.reason, 'passcode_locked');

        // Correct passcode during lockout is STILL refused (no oracle)
        const rightDuringLock = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            'x-alice-passcode': 'correct-horse-battery-staple',
            'CF-Connecting-IP': '10.0.0.1',
          },
        });
        assert.equal(rightDuringLock.status, 429);
        assert.deepEqual(JSON.parse(rightDuringLock.body.toString('utf8')), {
          error: 'passcode_locked',
        });

        // 30 global failures across 6 distinct clients (client 1 already did 5; add clients 2..6)
        for (let client = 2; client <= 6; client += 1) {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const res = await requestServer({
              scheme: 'http',
              port: srvPort,
              path: '/api/token',
              method: 'POST',
              headers: {
                'x-alice-passcode': 'nope',
                'CF-Connecting-IP': `10.0.0.${client}`,
              },
            });
            assert.equal(res.status, 401);
          }
        }

        // After 30 failures elsewhere, a new visitor with the CORRECT passcode STILL works (200)
        const afterThirty = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            'x-alice-passcode': 'correct-horse-battery-staple',
            'CF-Connecting-IP': '10.0.9.1',
          },
        });
        assert.equal(afterThirty.status, 200);

        // Fill the remaining 570 failures to reach the global 600/min ceiling (clients 7..120 x 5 = 570)
        for (let batchStart = 7; batchStart <= 120; batchStart += 15) {
          const batchEnd = Math.min(120, batchStart + 14);
          await Promise.all(
            Array.from({ length: batchEnd - batchStart + 1 }, async (_, idx) => {
              const client = batchStart + idx;
              for (let attempt = 0; attempt < 5; attempt += 1) {
                const res = await requestServer({
                  scheme: 'http',
                  port: srvPort,
                  path: '/api/token',
                  method: 'POST',
                  headers: {
                    'x-alice-passcode': 'nope',
                    'CF-Connecting-IP': `10.0.0.${client}`,
                  },
                });
                assert.equal(res.status, 401);
              }
            }),
          );
        }

        // At 600 global failures, a brand-new visitor with the CORRECT passcode gets 429 passcode_locked
        const globalLocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            'x-alice-passcode': 'correct-horse-battery-staple',
            'CF-Connecting-IP': '10.0.9.2',
          },
        });
        assert.equal(globalLocked.status, 429);
        assert.ok(Number(globalLocked.headers['retry-after']) >= 1);
        assert.deepEqual(JSON.parse(globalLocked.body.toString('utf8')), {
          error: 'passcode_locked',
        });

        // After the 60 s window drains, both new and previously locked visitors succeed
        nowMs += 60_001;
        const unlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            'x-alice-passcode': 'correct-horse-battery-staple',
            'CF-Connecting-IP': '10.0.0.1',
          },
        });
        assert.equal(unlocked.status, 200);
      },
    );
  });

  it('enforces ALICE_MAX_CALLS_PER_HOUR on successful mints only, frees after 1 hour, and does not expose cap on /healthz', async () => {
    let nowMs = 3_000_000;
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const env: Record<string, string | undefined> = {
      ...lkEnv,
      ALICE_PASSCODE: 'secret-pass-1234',
      ALICE_TRUST_PROXY: '1',
      ALICE_MAX_CALLS_PER_HOUR: '2',
    };

    await withTestServer(
      {
        env,
        remoteAddress: () => '127.0.0.1',
        now: () => nowMs,
        calllog: (room, ev, data) => events.push({ room, ev, data }),
      },
      async (srvPort) => {
        // /healthz exposes nothing sensitive (no cap, no client address, no trust_proxy)
        const healthRes = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/healthz',
          headers: { 'CF-Connecting-IP': '203.0.113.42' },
        });
        assert.equal(healthRes.status, 200);
        const healthBody = JSON.parse(healthRes.body.toString('utf8')) as Record<string, unknown>;
        assert.deepEqual(Object.keys(healthBody).sort(), [
          'agent',
          'livekit_configured',
          'ok',
          'passcode_required',
          'uptime_s',
        ]);

        // Failed attempts (wrong passcode, missing LiveKit) must NOT count toward hourly cap
        const badPass = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'wrong', 'CF-Connecting-IP': '203.0.113.1' },
        });
        assert.equal(badPass.status, 401);

        const savedUrl = env.LIVEKIT_URL;
        delete env.LIVEKIT_URL;
        const noLk = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.1' },
        });
        assert.equal(noLk.status, 503);
        env.LIVEKIT_URL = savedUrl;

        // 2 successful mints across different visitors fill the global cap
        const mint1 = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.1' },
        });
        assert.equal(mint1.status, 200);

        nowMs += 10_000;
        const mint2 = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.2' },
        });
        assert.equal(mint2.status, 200);

        // 3rd attempt hits 429 busy with retry_after_s and Retry-After
        const capped = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.3' },
        });
        assert.equal(capped.status, 429);
        const retryHdr = Number(capped.headers['retry-after']);
        assert.ok(retryHdr >= 3580 && retryHdr <= 3600, `unexpected Retry-After: ${retryHdr}`);
        const cappedBody = JSON.parse(capped.body.toString('utf8')) as {
          error: string;
          retry_after_s: number;
        };
        assert.equal(cappedBody.error, 'busy');
        assert.equal(cappedBody.retry_after_s, retryHdr);
        assert.equal(events[events.length - 1].ev, 'token_refused');
        assert.equal(events[events.length - 1].data?.reason, 'hourly_cap');

        // Invalid / non-positive values disable the cap
        for (const invalidCap of ['0', '-3', 'abc', '']) {
          env.ALICE_MAX_CALLS_PER_HOUR = invalidCap;
          const okRes = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.4' },
          });
          assert.equal(okRes.status, 200, `invalid cap ${JSON.stringify(invalidCap)} should not cap`);
        }

        // Restore cap=2; advance clock past 1 hour so the earlier mints expire
        env.ALICE_MAX_CALLS_PER_HOUR = '2';
        nowMs += 60 * 60 * 1000 + 1;
        const freed = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: { 'x-alice-passcode': 'secret-pass-1234', 'CF-Connecting-IP': '203.0.113.5' },
        });
        assert.equal(freed.status, 200);
      },
    );
  });

  it('enforces Origin check when ALICE_TRUST_PROXY is off and allows (logging at most once/min) when ALICE_TRUST_PROXY=1', async () => {
    let nowMs = 3_500_000;
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const env: Record<string, string | undefined> = {
      ...lkEnv,
      ALICE_PASSCODE: 'origin-pass-1234',
    };

    await withTestServer(
      {
        env,
        now: () => nowMs,
        calllog: (room, ev, data) => events.push({ room, ev, data }),
      },
      async (srvPort) => {
        // Trust OFF: matching Origin -> 200
        const sameOrigin = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${srvPort}`,
            Origin: `http://127.0.0.1:${srvPort}`,
            'x-alice-passcode': 'origin-pass-1234',
          },
        });
        assert.equal(sameOrigin.status, 200);

        // Trust OFF: mismatched Origins -> 403 bad_origin
        for (const badOrigin of [
          'https://evil.example',
          `http://localhost:${srvPort}`,
          `http://127.0.0.1:${srvPort + 1}`,
          'null',
        ]) {
          const refused = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: '/api/token',
            method: 'POST',
            headers: {
              Host: `127.0.0.1:${srvPort}`,
              Origin: badOrigin,
              'x-alice-passcode': 'origin-pass-1234',
            },
          });
          assert.equal(refused.status, 403, `expected 403 for Origin: ${badOrigin}`);
          assert.deepEqual(JSON.parse(refused.body.toString('utf8')), { error: 'bad_origin' });
          assert.equal(events[events.length - 1].ev, 'token_refused');
          assert.equal(events[events.length - 1].data?.reason, 'bad_origin');
        }

        // Trust ON: mismatched Origin (e.g. host-header rewrite sending Host localhost) -> ALLOWED (200),
        // logs at most one origin_mismatch event per minute, does NOT refuse
        env.ALICE_TRUST_PROXY = '1';
        const beforeMismatchLogs = events.filter((e) => e.ev === 'origin_mismatch').length;

        const firstProxyMismatch = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            Host: `localhost:${srvPort}`,
            Origin: 'https://alice-demo.trycloudflare.com',
            'CF-Connecting-IP': '203.0.113.21',
            'x-alice-passcode': 'origin-pass-1234',
          },
        });
        assert.equal(firstProxyMismatch.status, 200);
        assert.equal(
          events.filter((e) => e.ev === 'origin_mismatch').length,
          beforeMismatchLogs + 1,
        );

        // Second mismatch within the same minute -> still allowed, no duplicate origin_mismatch log
        nowMs += 10_000;
        const secondProxyMismatch = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            Host: `localhost:${srvPort}`,
            Origin: 'https://alice-demo.trycloudflare.com',
            'CF-Connecting-IP': '203.0.113.22',
            'x-alice-passcode': 'origin-pass-1234',
          },
        });
        assert.equal(secondProxyMismatch.status, 200);
        assert.equal(
          events.filter((e) => e.ev === 'origin_mismatch').length,
          beforeMismatchLogs + 1,
        );

        // After 60 s, another mismatch logs one more origin_mismatch event
        nowMs += 60_001;
        const thirdProxyMismatch = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/token',
          method: 'POST',
          headers: {
            Host: `localhost:${srvPort}`,
            Origin: 'https://alice-demo.trycloudflare.com',
            'CF-Connecting-IP': '203.0.113.23',
            'x-alice-passcode': 'origin-pass-1234',
          },
        });
        assert.equal(thirdProxyMismatch.status, 200);
        assert.equal(
          events.filter((e) => e.ev === 'origin_mismatch').length,
          beforeMismatchLogs + 2,
        );
      },
    );
  });

  it('enforces a global 30/min proxy cap on /api/storefront and occasion-less /api/looks without capping other browse routes', async () => {
    let nowMs = 4_000_000;
    await withTestServer(
      {
        env: { ALICE_TRUST_PROXY: '1' },
        now: () => nowMs,
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
      async (srvPort) => {
        // 30 requests across 30 distinct visitors mixing /api/storefront and occasion-less /api/looks succeed
        for (let i = 0; i < 30; i += 1) {
          const reqPath = i % 2 === 0 ? '/api/storefront' : '/api/looks';
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: reqPath,
            headers: { 'CF-Connecting-IP': `203.0.113.${i + 1}` },
          });
          assert.equal(res.status, 200, `expected 200 on global request #${i + 1}`);
        }

        // 31st request from a brand-new visitor hits 429 with Retry-After
        const blockedSf = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/storefront',
          headers: { 'CF-Connecting-IP': '203.0.113.99' },
        });
        assert.equal(blockedSf.status, 429);
        assert.ok(Number(blockedSf.headers['retry-after']) >= 1);
        assert.deepEqual(JSON.parse(blockedSf.body.toString('utf8')), { error: 'slow_down' });

        const blockedLooks = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/looks',
          headers: { 'CF-Connecting-IP': '203.0.113.100' },
        });
        assert.equal(blockedLooks.status, 429);

        // Other browse routes (/api/search, /api/occasions, /api/looks?occasion=...) are NOT blocked by the 30/min global cap
        const searchOk = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/search?q=loafer',
          headers: { 'CF-Connecting-IP': '203.0.113.101' },
        });
        assert.equal(searchOk.status, 200);

        const looksWithOcc = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/looks?occasion=brunch',
          headers: { 'CF-Connecting-IP': '203.0.113.101' },
        });
        assert.equal(looksWithOcc.status, 200);

        const matchOk = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/occasions/match?department=women&q=rooftop+birthday',
          headers: { 'CF-Connecting-IP': '203.0.113.101' },
        });
        assert.equal(matchOk.status, 200);

        // /api/occasions and /api/occasions/match use clientAddress(req) for separate 90/min visitor buckets
        for (let i = 0; i < 90; i += 1) {
          const res = await requestServer({
            scheme: 'http',
            port: srvPort,
            path: i % 2 === 0 ? '/api/occasions' : '/api/occasions/match?department=women&q=brunch',
            headers: { 'CF-Connecting-IP': '203.0.113.201' },
          });
          assert.equal(res.status, 200);
        }
        const visitorABlocked = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/occasions/match?department=women&q=brunch',
          headers: { 'CF-Connecting-IP': '203.0.113.201' },
        });
        assert.equal(visitorABlocked.status, 429);

        const visitorBAllowed = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/occasions/match?department=women&q=brunch',
          headers: { 'CF-Connecting-IP': '203.0.113.202' },
        });
        assert.equal(visitorBAllowed.status, 200);

        // After 60 s window drains, /api/storefront succeeds again
        nowMs += 60_001;
        const sfAfter = await requestServer({
          scheme: 'http',
          port: srvPort,
          path: '/api/storefront',
          headers: { 'CF-Connecting-IP': '203.0.113.102' },
        });
        assert.equal(sfAfter.status, 200);
      },
    );
  });
});
