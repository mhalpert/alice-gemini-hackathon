import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

export interface AliceServerOptions {
  publicDir?: string;
  tryonDir?: string;
  env?: Record<string, string | undefined>;
}

const TOKEN_TTL_SECONDS = 1800;
const MAX_TOKEN_BODY_BYTES = 4096;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const TRYON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(jpg|jpeg|png|webp|mp4)$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;

    req.on('data', (chunk: Buffer | string) => {
      if (overflow) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > MAX_TOKEN_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (overflow || chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          resolve({});
        }
      } catch {
        resolve({});
      }
    });

    req.on('error', () => {
      resolve({});
    });
  });
}

async function serveFile(
  res: ServerResponse,
  method: string,
  filePath: string,
  extraHeaders: Record<string, string>,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(stat.size),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };

  if (method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(filePath);
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    stream.once('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });

    stream.once('error', () => {
      if (!res.headersSent) {
        sendText(res, 404, 'Not Found');
      } else {
        res.destroy();
      }
      done();
    });

    res.once('finish', done);
    res.once('close', () => {
      stream.destroy();
      done();
    });
  });
}

function timingSafeMatches(supplied: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createAliceServer(opts: AliceServerOptions = {}): http.Server {
  const startedAt = Date.now();
  const rateBuckets = new Map<string, number[]>();

  function checkRateLimit(remoteAddr: string): { allowed: boolean; retryAfterS: number } {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;

    if (rateBuckets.size > 1000) {
      for (const [key, timestamps] of rateBuckets) {
        const recent = timestamps.filter((t) => t > cutoff);
        if (recent.length === 0) {
          rateBuckets.delete(key);
        } else {
          rateBuckets.set(key, recent);
        }
      }
    }

    const existing = rateBuckets.get(remoteAddr) ?? [];
    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= RATE_LIMIT_MAX) {
      rateBuckets.set(remoteAddr, recent);
      const retryAfterS = Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
      return { allowed: false, retryAfterS };
    }

    recent.push(now);
    rateBuckets.set(remoteAddr, recent);
    return { allowed: true, retryAfterS: 0 };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startMs = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const qIdx = rawUrl.indexOf('?');
    const rawPathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const isApi = rawPathname.startsWith('/api/');
    let logExtra = '';

    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isApi) {
      res.once('finish', () => {
        const elapsed = Date.now() - startMs;
        const suffix = logExtra ? ` ${logExtra}` : '';
        console.log(`[server] ${method} ${rawPathname} ${res.statusCode} ${elapsed}ms${suffix}`);
      });
    }

    try {
      const env = opts.env ?? process.env;
      const agent = env.ALICE_AGENT_NAME || 'alice';
      const livekitConfigured = Boolean(
        env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET,
      );
      const passcodeRequired = Boolean(env.ALICE_PASSCODE);

      if (!rawPathname.startsWith('/')) {
        if (isApi) {
          sendJson(res, 404, { error: 'not_found' });
        } else {
          sendText(res, 404, 'Not Found');
        }
        return;
      }

      // 1. GET /healthz
      if (rawPathname === '/healthz') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          agent,
          livekit_configured: livekitConfigured,
          passcode_required: passcodeRequired,
        });
        return;
      }

      // 2. GET /api/config
      if (rawPathname === '/api/config') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }
        sendJson(
          res,
          200,
          { passcode_required: passcodeRequired, agent },
          { 'Cache-Control': 'no-store' },
        );
        return;
      }

      // 3. POST|GET /api/token
      if (rawPathname === '/api/token') {
        if (method !== 'POST' && method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
          return;
        }

        const remoteAddr = req.socket.remoteAddress ?? 'unknown';
        const limit = checkRateLimit(remoteAddr);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': String(limit.retryAfterS), 'Cache-Control': 'no-store' },
          );
          return;
        }

        const body = method === 'POST' ? await readOptionalJsonBody(req) : {};

        const headerVal = req.headers['x-alice-passcode'];
        const headerPasscode =
          typeof headerVal === 'string'
            ? headerVal
            : Array.isArray(headerVal)
              ? headerVal[0]
              : undefined;
        const bodyPasscode = typeof body.passcode === 'string' ? body.passcode : undefined;
        const suppliedPasscode =
          headerPasscode !== undefined && headerPasscode !== '' ? headerPasscode : bodyPasscode;

        const expectedPasscode = env.ALICE_PASSCODE;
        if (expectedPasscode) {
          if (!suppliedPasscode) {
            sendJson(
              res,
              401,
              { error: 'passcode_required', passcode_required: true },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }
          if (!timingSafeMatches(suppliedPasscode, expectedPasscode)) {
            sendJson(
              res,
              401,
              { error: 'bad_passcode', passcode_required: true },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }
        }

        const url = env.LIVEKIT_URL;
        const apiKey = env.LIVEKIT_API_KEY;
        const apiSecret = env.LIVEKIT_API_SECRET;
        if (!url || !apiKey || !apiSecret) {
          sendJson(
            res,
            503,
            { error: 'livekit_not_configured' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        const room = `alice-${crypto.randomBytes(5).toString('hex')}`;
        const identity = `shopper-${crypto.randomBytes(4).toString('hex')}`;
        const trimmedName = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        const displayName = trimmedName || 'Shopper';

        const at = new AccessToken(apiKey, apiSecret, {
          identity,
          name: displayName,
          ttl: TOKEN_TTL_SECONDS,
        });
        at.addGrant({
          roomJoin: true,
          room,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canUpdateOwnMetadata: true,
        });
        at.roomConfig = new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: agent })],
        });

        const token = await at.toJwt();
        logExtra = `room=${room}`;

        sendJson(
          res,
          200,
          {
            token,
            url,
            room,
            identity,
            agent,
            expires_in_s: TOKEN_TTL_SECONDS,
            serverUrl: url,
            participantToken: token,
            roomName: room,
            participantName: identity,
          },
          { 'Cache-Control': 'no-store' },
        );
        return;
      }

      // Unknown /api/* routes
      if (isApi) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      // 4. GET|HEAD /tryon/<name>
      if (rawPathname.startsWith('/tryon/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
          return;
        }

        const rawName = rawPathname.slice('/tryon/'.length);
        let decodedName: string;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          sendText(res, 404, 'Not Found');
          return;
        }

        if (!TRYON_NAME_RE.test(decodedName)) {
          sendText(res, 404, 'Not Found');
          return;
        }

        const tryonRoot = path.resolve(
          opts.tryonDir || env.ALICE_TRYON_DIR || path.join(import.meta.dirname, 'data', 'tryon'),
        );
        const filePath = path.resolve(tryonRoot, decodedName);
        if (!filePath.startsWith(tryonRoot + path.sep)) {
          sendText(res, 404, 'Not Found');
          return;
        }

        await serveFile(res, method, filePath, {
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        });
        return;
      }

      // 5. Static files from publicDir (GET|HEAD only)
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPathname);
      } catch {
        sendText(res, 404, 'Not Found');
        return;
      }

      if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
        sendText(res, 404, 'Not Found');
        return;
      }

      const relPath = decodedPath === '/' ? '/index.html' : decodedPath;
      const segments = relPath.split('/');
      if (segments.some((seg) => seg.startsWith('.'))) {
        sendText(res, 404, 'Not Found');
        return;
      }

      const stripped = relPath.replace(/^\/+/, '');
      if (!stripped) {
        sendText(res, 404, 'Not Found');
        return;
      }

      const publicRoot = path.resolve(opts.publicDir ?? path.join(import.meta.dirname, 'public'));
      const filePath = path.resolve(publicRoot, stripped);
      if (!filePath.startsWith(publicRoot + path.sep)) {
        sendText(res, 404, 'Not Found');
        return;
      }

      await serveFile(res, method, filePath, {
        'Cache-Control': 'no-cache',
      });
    } catch (err) {
      console.error('[server] error', method, rawPathname, (err as Error)?.message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error' });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  }

  return http.createServer((req, res) => {
    void handleRequest(req, res);
  });
}

if (import.meta.main) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may be missing
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createAliceServer();
  server.listen(port, host, () => {
    const livekitConfigured = Boolean(
      process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
    );
    const passcodeRequired = Boolean(process.env.ALICE_PASSCODE);
    console.log(
      `[server] listening on http://${host}:${port} livekit=${livekitConfigured} passcode=${passcodeRequired}`,
    );
  });
}
