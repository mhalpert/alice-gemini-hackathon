import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { calllog as defaultCalllog } from './src/calllog.ts';
import type { Gender, Item, Outfit, SearchResult } from './src/types.ts';
import type { ProductDetail, SearchOpts } from './src/store/catalog.ts';
import {
  getProduct as defaultGetProduct,
  search as defaultSearch,
  searchMixed as defaultSearchMixed,
} from './src/store/index.ts';
import type { StorefrontResult } from './src/store/storefront.ts';
import {
  buildProductPayload,
  createStorefront,
  isValidShopifyGid,
} from './src/store/storefront.ts';

export type CallLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface AliceStoreDeps {
  storefront?: (gender: Gender, opts?: { budgetMs?: number }) => Promise<StorefrontResult>;
  searchMixed?: (query: string, gender: Gender, opts?: SearchOpts) => Promise<SearchResult>;
  search?: (query: string, gender: Gender, opts?: SearchOpts) => Promise<SearchResult>;
  getProduct?: (id: string) => Promise<ProductDetail | null>;
}

export type LibraryLoaderFn = () => Promise<{
  libraryLooks?: unknown;
  libraryOccasions?: unknown;
} | null>;

export interface AliceBudgetOptions {
  storefrontMs?: number;
  productMs?: number;
  searchMs?: number;
  looksMs?: number;
}

export interface AliceServerOptions {
  publicDir?: string;
  tryonDir?: string;
  env?: Record<string, string | undefined>;
  calllog?: CallLogFn;
  store?: AliceStoreDeps;
  loadLibrary?: LibraryLoaderFn;
  budgets?: AliceBudgetOptions;
  remoteAddress?: (req: IncomingMessage) => string | undefined;
}

export interface AliceHttpsServerOptions extends AliceServerOptions {
  cert: string | Buffer;
  key: string | Buffer;
}

const TOKEN_TTL_SECONDS = 1800;
const MAX_TOKEN_BODY_BYTES = 4096;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BROWSE_RATE_LIMIT_MAX = 90;
const BROWSE_RATE_LIMIT_WINDOW_MS = 60_000;
const STOREFRONT_BUDGET_MS = 4000;
const STOREFRONT_WAIT_MIN_MS = 500;
const STOREFRONT_WAIT_MAX_MS = 6000;
const PRODUCT_BUDGET_MS = 1300;
const SEARCH_BUDGET_MS = 1300;
const LOOKS_BUDGET_MS = 1400;
const SEARCH_QUERY_MAX_LEN = 80;
const OCCASION_MAX_LEN = 120;
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

type ReadJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'body_too_large' };

async function readOptionalJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_TOKEN_BODY_BYTES,
): Promise<ReadJsonBodyResult> {
  const rawContentLength = req.headers['content-length'];
  if (rawContentLength !== undefined) {
    const contentLength = Number(rawContentLength);
    if (contentLength > maxBytes) {
      return { ok: false, reason: 'body_too_large' };
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: ReadJsonBodyResult): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        chunks.length = 0;
        req.pause();
        finish({ ok: false, reason: 'body_too_large' });
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (chunks.length === 0) {
        finish({ ok: true, body: {} });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finish({ ok: true, body: parsed as Record<string, unknown> });
        } else {
          finish({ ok: true, body: {} });
        }
      } catch {
        finish({ ok: true, body: {} });
      }
    };

    const onError = (): void => {
      finish({ ok: true, body: {} });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'ignore' }
  | { kind: 'invalid' }
  | { kind: 'range'; start: number; end: number };

function parseSingleByteRange(rangeHeader: string | undefined, totalSize: number): ParsedByteRange {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { kind: 'none' };
  }
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return { kind: 'invalid' };
  }
  const spec = trimmed.slice(6).trim();
  if (!spec) {
    return { kind: 'invalid' };
  }
  if (spec.includes(',')) {
    return { kind: 'ignore' };
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '')) {
    return { kind: 'invalid' };
  }
  if (totalSize <= 0) {
    return { kind: 'invalid' };
  }

  const rawStart = match[1];
  const rawEnd = match[2];

  // Suffix range: bytes=-suffix
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: 'invalid' };
    }
    const start = Math.max(0, totalSize - suffix);
    return { kind: 'range', start, end: totalSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
    return { kind: 'invalid' };
  }

  // Open-ended range: bytes=start-
  if (rawEnd === '') {
    return { kind: 'range', start, end: totalSize - 1 };
  }

  // Closed range: bytes=start-end
  const requestedEnd = Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return { kind: 'invalid' };
  }
  const end = Math.min(requestedEnd, totalSize - 1);
  return { kind: 'range', start, end };
}

async function serveFile(
  res: ServerResponse,
  method: string,
  filePath: string,
  extraHeaders: Record<string, string>,
  rangeOpts?: { enableRange: boolean; rangeHeader?: string },
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

  const enableRange = Boolean(rangeOpts?.enableRange);
  let status = 200;
  let start: number | undefined;
  let end: number | undefined;
  let contentLength = stat.size;
  const rangeHeaders: Record<string, string> = {};

  if (enableRange) {
    rangeHeaders['Accept-Ranges'] = 'bytes';
    const parsed = parseSingleByteRange(rangeOpts?.rangeHeader, stat.size);
    if (parsed.kind === 'invalid') {
      const headers416: Record<string, string> = {
        'Content-Range': `bytes */${stat.size}`,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
      };
      if (method === 'HEAD') {
        res.writeHead(416, { ...headers416, 'Content-Length': '0' });
        res.end();
      } else {
        sendText(res, 416, 'Range Not Satisfiable', headers416);
      }
      return;
    }
    if (parsed.kind === 'range') {
      status = 206;
      start = parsed.start;
      end = parsed.end;
      contentLength = end - start + 1;
      rangeHeaders['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(contentLength),
    'X-Content-Type-Options': 'nosniff',
    ...rangeHeaders,
    ...extraHeaders,
  };

  if (method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stream =
      start !== undefined && end !== undefined
        ? fs.createReadStream(filePath, { start, end })
        : fs.createReadStream(filePath);
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    stream.once('open', () => {
      res.writeHead(status, headers);
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
    ipv4,
  );
}

const TIMEOUT_SENTINEL = Symbol('timeout');

async function raceWithBudget<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), budgetMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  promise.catch(() => {});

  try {
    const winner = await Promise.race([promise, timeoutPromise]);
    if (winner === TIMEOUT_SENTINEL) {
      return { timedOut: true };
    }
    return { timedOut: false, value: winner };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function parseDepartment(raw: string | null): Gender {
  return raw?.trim().toLowerCase() === 'men' ? 'men' : 'women';
}

function parseLooksLimit(raw: string | null): number {
  if (!raw || !raw.trim()) return 6;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 6;
  return Math.min(12, Math.max(1, Math.floor(n)));
}

function parseStorefrontWaitMs(raw: string | null, defaultMs: number): number {
  if (!raw || !raw.trim()) return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultMs;
  return Math.min(STOREFRONT_WAIT_MAX_MS, Math.max(STOREFRONT_WAIT_MIN_MS, Math.floor(n)));
}

function loadFixtureOutfits(
  publicRoot: string,
  department: Gender,
  limit: number,
): Outfit[] {
  const candidates = [
    path.join(publicRoot, 'fixture.json'),
    path.join(import.meta.dirname, 'public', 'fixture.json'),
  ];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        brief?: { gender?: unknown };
        outfits?: unknown;
      };
      if (!Array.isArray(parsed?.outfits)) continue;
      const allOutfits = parsed.outfits.filter(
        (o): o is Outfit => Boolean(o) && typeof o === 'object' && Array.isArray((o as Outfit).pieces),
      );
      if (allOutfits.length === 0) return [];

      const matching = allOutfits.filter((outfit) => {
        if (outfit.pieces.length > 0 && outfit.pieces.every((p) => p?.item?.department === department)) {
          return true;
        }
        if (outfit.pieces.length === 0 && parsed.brief?.gender === department) {
          return true;
        }
        return false;
      });

      const chosen = matching.length > 0 ? matching : allOutfits;
      return chosen.slice(0, limit);
    } catch {
      // try next candidate
    }
  }

  return [];
}

interface OccasionChoice {
  key: string;
  occasion: string;
  label: string;
}

interface SetsOccasionEntry extends OccasionChoice {
  rawKey?: string;
}

function slugifyOccasion(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function capitalizeFirst(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeOccasionChoices(raw: unknown): OccasionChoice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OccasionChoice[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as { key?: unknown; occasion?: unknown; label?: unknown };
    const key = typeof obj.key === 'string' ? obj.key.trim() : '';
    const occasion = typeof obj.occasion === 'string' ? obj.occasion.trim() : '';
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    if (key && occasion && label) {
      out.push({ key, occasion, label });
    }
  }
  return out;
}

async function readLibraryOccasionsFromSets(
  department: Gender,
  env: Record<string, string | undefined>,
): Promise<SetsOccasionEntry[]> {
  const override = env.ALICE_LIBRARY_FILE;
  const filePath =
    override && override.trim().length > 0
      ? path.resolve(override)
      : path.join(import.meta.dirname, 'src', 'library', 'sets.json');

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      sets?: Array<{ key?: unknown; gender?: unknown; occasion?: unknown; outfits?: unknown }>;
    };
    if (!Array.isArray(parsed?.sets)) return [];

    const matching = parsed.sets.filter(
      (s) =>
        s &&
        s.gender === department &&
        typeof s.occasion === 'string' &&
        s.occasion.trim().length > 0 &&
        Array.isArray(s.outfits) &&
        s.outfits.length > 0,
    );

    matching.sort((a, b) => {
      const aDemo = a.key === 'rooftop-birthday' ? 0 : 1;
      const bDemo = b.key === 'rooftop-birthday' ? 0 : 1;
      return aDemo - bDemo;
    });

    const seen = new Set<string>();
    const out: SetsOccasionEntry[] = [];
    for (const s of matching) {
      const text = (s.occasion as string).trim();
      const key = slugifyOccasion(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        occasion: text,
        label: capitalizeFirst(text),
        ...(typeof s.key === 'string' && s.key.trim() ? { rawKey: s.key.trim() } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function defaultLoadLibrary(): Promise<{
  libraryLooks?: unknown;
  libraryOccasions?: unknown;
} | null> {
  return import('./src/library/index.ts').catch(() => null);
}

export function createAliceHandler(opts: AliceServerOptions = {}): RequestListener {
  const startedAt = Date.now();
  const rateBuckets = new Map<string, number[]>();
  const browseRateBuckets = new Map<string, number[]>();
  const logSink = opts.calllog ?? defaultCalllog;
  const loadLibraryFn = opts.loadLibrary ?? defaultLoadLibrary;
  const storefrontBudgetMs = opts.budgets?.storefrontMs ?? STOREFRONT_BUDGET_MS;
  const productBudgetMs = opts.budgets?.productMs ?? PRODUCT_BUDGET_MS;
  const searchBudgetMs = opts.budgets?.searchMs ?? SEARCH_BUDGET_MS;
  const looksBudgetMs = opts.budgets?.looksMs ?? LOOKS_BUDGET_MS;

  const searchMixedFn = opts.store?.searchMixed ?? defaultSearchMixed;
  const searchFn = opts.store?.search ?? defaultSearch;
  const getProductFn = opts.store?.getProduct ?? defaultGetProduct;
  const storefrontFn =
    opts.store?.storefront ??
    createStorefront({
      search: searchFn,
      budgetMs: storefrontBudgetMs,
      env: opts.env,
    });

  function logServerEvent(ev: string, data?: Record<string, unknown>): void {
    try {
      logSink('_server', ev, data);
    } catch {
      // calllog must never affect the response
    }
  }

  function checkBucketRateLimit(
    buckets: Map<string, number[]>,
    remoteAddr: string,
    maxRequests: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterS: number } {
    const now = Date.now();
    const cutoff = now - windowMs;

    if (buckets.size > 1000) {
      for (const [key, timestamps] of buckets) {
        const recent = timestamps.filter((t) => t > cutoff);
        if (recent.length === 0) {
          buckets.delete(key);
        } else {
          buckets.set(key, recent);
        }
      }
    }

    const existing = buckets.get(remoteAddr) ?? [];
    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= maxRequests) {
      buckets.set(remoteAddr, recent);
      const retryAfterS = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      return { allowed: false, retryAfterS };
    }

    recent.push(now);
    buckets.set(remoteAddr, recent);
    return { allowed: true, retryAfterS: 0 };
  }

  function checkRateLimit(remoteAddr: string): { allowed: boolean; retryAfterS: number } {
    return checkBucketRateLimit(rateBuckets, remoteAddr, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  }

  function checkBrowseRateLimit(remoteAddr: string): { allowed: boolean; retryAfterS: number } {
    return checkBucketRateLimit(
      browseRateBuckets,
      remoteAddr,
      BROWSE_RATE_LIMIT_MAX,
      BROWSE_RATE_LIMIT_WINDOW_MS,
    );
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

      // 3. POST /api/token
      if (rawPathname === '/api/token') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return;
        }

        const remoteAddr =
          (opts.remoteAddress ? opts.remoteAddress(req) : req.socket.remoteAddress) ?? 'unknown';
        const limit = checkRateLimit(remoteAddr);
        if (!limit.allowed) {
          logServerEvent('token_refused', { reason: 'slow_down', remote_addr: remoteAddr });
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': String(limit.retryAfterS), 'Cache-Control': 'no-store' },
          );
          return;
        }

        const expectedPasscode = env.ALICE_PASSCODE;
        if (!expectedPasscode && !isLoopbackHost(remoteAddr)) {
          logServerEvent('token_refused', {
            reason: 'passcode_not_configured',
            remote_addr: remoteAddr,
          });
          sendJson(
            res,
            403,
            { error: 'passcode_not_configured' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        const bodyResult = await readOptionalJsonBody(req);
        if (!bodyResult.ok) {
          logServerEvent('token_refused', { reason: 'body_too_large', remote_addr: remoteAddr });
          res.once('finish', () => req.destroy());
          sendJson(
            res,
            413,
            { error: 'body_too_large' },
            { Connection: 'close', 'Cache-Control': 'no-store' },
          );
          return;
        }
        const body = bodyResult.body;

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

        if (expectedPasscode) {
          if (!suppliedPasscode) {
            logServerEvent('token_refused', {
              reason: 'passcode_required',
              remote_addr: remoteAddr,
            });
            sendJson(
              res,
              401,
              { error: 'passcode_required', passcode_required: true },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }
          if (!timingSafeMatches(suppliedPasscode, expectedPasscode)) {
            logServerEvent('token_refused', { reason: 'bad_passcode', remote_addr: remoteAddr });
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
          logServerEvent('token_refused', {
            reason: 'livekit_not_configured',
            remote_addr: remoteAddr,
          });
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
        logServerEvent('token', { room, identity, agent, remote_addr: remoteAddr });

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

      // 3b. Storefront, product, search, looks, and occasions browse routes (GET only, shared 90/min limit)
      if (
        rawPathname === '/api/storefront' ||
        rawPathname === '/api/product' ||
        rawPathname === '/api/search' ||
        rawPathname === '/api/looks' ||
        rawPathname === '/api/occasions'
      ) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }

        const remoteAddr = req.socket.remoteAddress ?? 'unknown';
        const browseLimit = checkBrowseRateLimit(remoteAddr);
        if (!browseLimit.allowed) {
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': String(browseLimit.retryAfterS), 'Cache-Control': 'no-store' },
          );
          return;
        }

        const parsedUrl = new URL(rawUrl, 'http://localhost');

        // GET /api/storefront?department=men|women&wait=<500..6000, default 4000>
        if (rawPathname === '/api/storefront') {
          const department = parseDepartment(parsedUrl.searchParams.get('department'));
          const waitMs = parseStorefrontWaitMs(
            parsedUrl.searchParams.get('wait'),
            storefrontBudgetMs,
          );
          const t0 = Date.now();
          let result: StorefrontResult;
          try {
            const raced = await raceWithBudget(
              storefrontFn(department, { budgetMs: waitMs }),
              waitMs + 50,
            );
            if (raced.timedOut) {
              result = {
                department,
                sections: [],
                ms: Math.max(0, Date.now() - t0),
                storefront: { searches: 0, shared: false },
                partial: true,
              };
            } else {
              result = raced.value;
            }
          } catch {
            result = {
              department,
              sections: [],
              ms: Math.max(0, Date.now() - t0),
              storefront: { searches: 0, shared: false },
            };
          }
          logExtra = `dept=${department} sections=${result.sections.length}${result.storefront ? ` searches=${result.storefront.searches} shared=${result.storefront.shared}` : ''}${result.partial ? ' partial=true' : ''}`;
          sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
          return;
        }

        // GET /api/product?variant_id=<gid> (also accept id)
        if (rawPathname === '/api/product') {
          const rawId = (
            parsedUrl.searchParams.get('variant_id') ??
            parsedUrl.searchParams.get('id') ??
            ''
          ).trim();
          if (!isValidShopifyGid(rawId)) {
            sendJson(res, 400, { error: 'bad_id' }, { 'Cache-Control': 'no-store' });
            return;
          }

          const department = parseDepartment(parsedUrl.searchParams.get('department'));
          let detail: ProductDetail | null = null;
          try {
            const raced = await raceWithBudget(getProductFn(rawId), productBudgetMs);
            if (raced.timedOut) {
              logExtra = 'timeout=true';
              sendJson(res, 504, { error: 'slow_store' }, { 'Cache-Control': 'no-store' });
              return;
            }
            detail = raced.value;
          } catch {
            detail = null;
          }

          if (!detail) {
            sendJson(res, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' });
            return;
          }

          const payload = buildProductPayload(detail, department);
          sendJson(res, 200, payload, { 'Cache-Control': 'no-store' });
          return;
        }

        // GET /api/search?q=<text>&department=men|women
        if (rawPathname === '/api/search') {
          const query = (parsedUrl.searchParams.get('q') ?? '').trim();
          if (query.length === 0 || query.length > SEARCH_QUERY_MAX_LEN) {
            sendJson(res, 400, { error: 'bad_query' }, { 'Cache-Control': 'no-store' });
            return;
          }

          const department = parseDepartment(parsedUrl.searchParams.get('department'));
          let items: Item[] = [];
          try {
            const raced = await raceWithBudget(
              searchMixedFn(query, department, { limit: 8 }),
              searchBudgetMs,
            );
            if (!raced.timedOut && raced.value && Array.isArray(raced.value.items)) {
              items = raced.value.items.slice(0, 8);
            }
          } catch {
            items = [];
          }

          logExtra = `dept=${department} n=${items.length}`;
          sendJson(res, 200, { query, items }, { 'Cache-Control': 'no-store' });
          return;
        }

        // GET /api/looks?department=men|women&limit=<1-12, default 6>&occasion=<text>
        if (rawPathname === '/api/looks') {
          const department = parseDepartment(parsedUrl.searchParams.get('department'));
          const limit = parseLooksLimit(parsedUrl.searchParams.get('limit'));
          const rawOccasion = parsedUrl.searchParams.get('occasion');
          const trimmedOccasion = rawOccasion !== null ? rawOccasion.trim() : '';
          if (trimmedOccasion.length > OCCASION_MAX_LEN) {
            sendJson(res, 400, { error: 'bad_occasion' }, { 'Cache-Control': 'no-store' });
            return;
          }
          const occasion: string | null = trimmedOccasion.length > 0 ? trimmedOccasion : null;
          let queryOccasion = occasion;
          if (occasion !== null) {
            const lower = occasion.toLowerCase();
            const setsOccasions = await readLibraryOccasionsFromSets(department, env);
            const matched = setsOccasions.find(
              (entry) =>
                entry.key === lower ||
                (entry.rawKey !== undefined && entry.rawKey.toLowerCase() === lower),
            );
            if (matched) {
              queryOccasion = matched.occasion;
            }
          }

          let libraryOutfits: Outfit[] | null = null;
          let libraryAnsweredEmpty = false;
          try {
            const runLibrary = async (): Promise<Outfit[] | null> => {
              const mod = await loadLibraryFn();
              if (mod && typeof mod.libraryLooks === 'function') {
                const fn = mod.libraryLooks as (
                  g: Gender,
                  o?: { limit?: number; occasion?: string },
                ) => Promise<Outfit[]>;
                const callOpts = queryOccasion !== null ? { limit, occasion: queryOccasion } : { limit };
                const resOutfits = await fn(department, callOpts);
                if (Array.isArray(resOutfits)) {
                  return resOutfits.slice(0, limit);
                }
              }
              return null;
            };

            const raced = await raceWithBudget(runLibrary(), looksBudgetMs);
            if (!raced.timedOut && raced.value !== null) {
              if (raced.value.length > 0) {
                libraryOutfits = raced.value;
              } else {
                libraryAnsweredEmpty = true;
              }
            }
          } catch {
            libraryOutfits = null;
          }

          if (libraryOutfits) {
            logExtra = `dept=${department} source=library n=${libraryOutfits.length}`;
            sendJson(
              res,
              200,
              { department, occasion, looks: libraryOutfits, source: 'library' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          // For an occasion query, never fall back to wrong-occasion fixture looks.
          if (occasion !== null) {
            logExtra = `dept=${department} source=library n=0${libraryAnsweredEmpty ? '' : ' timeout_or_err=true'}`;
            sendJson(
              res,
              200,
              { department, occasion, looks: [], source: 'library' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          const publicRoot = path.resolve(opts.publicDir ?? path.join(import.meta.dirname, 'public'));
          const fixtureLooks = loadFixtureOutfits(publicRoot, department, limit);
          logExtra = `dept=${department} source=fixture n=${fixtureLooks.length}`;
          sendJson(
            res,
            200,
            { department, occasion: null, looks: fixtureLooks, source: 'fixture' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        // GET /api/occasions?department=men|women
        if (rawPathname === '/api/occasions') {
          const department = parseDepartment(parsedUrl.searchParams.get('department'));
          let occasions: OccasionChoice[] | null = null;
          try {
            const runOccasions = async (): Promise<OccasionChoice[] | null> => {
              const mod = await loadLibraryFn();
              if (mod && typeof mod.libraryOccasions === 'function') {
                const fn = mod.libraryOccasions as (g: Gender) => Promise<unknown> | unknown;
                const list = await fn(department);
                return normalizeOccasionChoices(list);
              }
              return null;
            };
            const raced = await raceWithBudget(runOccasions(), looksBudgetMs);
            if (!raced.timedOut && raced.value !== null) {
              occasions = raced.value;
            }
          } catch {
            occasions = null;
          }

          if (occasions !== null) {
            logExtra = `dept=${department} source=library n=${occasions.length}`;
            sendJson(
              res,
              200,
              { department, occasions, source: 'library' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          const setsEntries = await readLibraryOccasionsFromSets(department, env);
          if (setsEntries.length > 0) {
            const fallbackOccasions: OccasionChoice[] = setsEntries.map(
              ({ key, occasion, label }) => ({ key, occasion, label }),
            );
            logExtra = `dept=${department} source=sets n=${fallbackOccasions.length}`;
            sendJson(
              res,
              200,
              { department, occasions: fallbackOccasions, source: 'sets' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          logExtra = `dept=${department} source=none n=0`;
          sendJson(
            res,
            200,
            { department, occasions: [], source: 'none' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }
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

        const rawRange = req.headers.range;
        const rangeHeader =
          typeof rawRange === 'string'
            ? rawRange
            : Array.isArray(rawRange)
              ? rawRange[0]
              : undefined;

        await serveFile(
          res,
          method,
          filePath,
          {
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
          },
          { enableRange: true, rangeHeader },
        );
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

  return (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res);
  };
}

export function createAliceServer(opts: AliceServerOptions = {}): http.Server {
  return http.createServer(createAliceHandler(opts));
}

export function createAliceHttpsServer(opts: AliceHttpsServerOptions): https.Server {
  const { cert, key, ...handlerOpts } = opts;
  return https.createServer({ cert, key }, createAliceHandler(handlerOpts));
}

if (import.meta.main) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may be missing
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const certPath = process.env.ALICE_TLS_CERT;
  const keyPath = process.env.ALICE_TLS_KEY;

  let scheme: 'http' | 'https' = 'http';
  let server: http.Server | https.Server;

  if (certPath && keyPath) {
    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      server = createAliceHttpsServer({ cert, key });
      scheme = 'https';
    } catch (err) {
      console.warn(
        `[server] TLS cert/key unreadable (${(err as Error)?.message ?? String(err)}); falling back to HTTP`,
      );
      server = createAliceServer();
    }
  } else {
    if (certPath || keyPath) {
      console.warn(
        '[server] TLS requires both ALICE_TLS_CERT and ALICE_TLS_KEY; falling back to HTTP',
      );
    }
    server = createAliceServer();
  }

  server.listen(port, host, () => {
    const livekitConfigured = Boolean(
      process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
    );
    const passcodeRequired = Boolean(process.env.ALICE_PASSCODE);
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    console.log(
      `[server] listening on ${scheme}://${displayHost}:${port} livekit=${livekitConfigured} passcode=${passcodeRequired}`,
    );
    if (!isLoopbackHost(host) && !passcodeRequired) {
      console.warn(
        `[server] WARNING: bound to non-loopback host ${host} with empty ALICE_PASSCODE — /api/token is OPEN to the network! Set ALICE_PASSCODE in .env.local.`,
      );
    }
  });
}
