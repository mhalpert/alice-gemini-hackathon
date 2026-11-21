import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from 'livekit-server-sdk';
import { calllog as defaultCalllog } from './src/calllog.ts';
import type { Gender, Item, Outfit, Piece, SearchResult } from './src/types.ts';
import type { ProductDetail, SearchOpts, SizeVariantOpts, SizeVariantResult } from './src/store/catalog.ts';
import { sizeVariant as defaultSizeVariant } from './src/store/catalog.ts';
import type { CartLineInput, CreateCartOpts, StoreCartResponse } from './src/store/cart.ts';
import { createCart as defaultCreateCart } from './src/store/cart.ts';
import { createBag } from './src/store/bag.ts';
import {
  bagToPagePayload,
  computeBagBuildHash,
  findAllowlistedStoreForDetail,
  isAllowlistedStoreDomain,
  pieceFromStoreDetail,
  placeholderPieceForUnknownId,
  validateBagRequest,
} from './src/store/bag-page.ts';
import { getProduct as defaultGetProduct, search as defaultSearch } from './src/store/catalog.ts';
import { searchMixed as defaultSearchMixed } from './src/store/index.ts';
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
  sizeVariant?: (variantId: string, size: string, opts?: SizeVariantOpts) => Promise<SizeVariantResult>;
  createCart?: (
    storeDomain: string,
    lines: CartLineInput[],
    opts?: CreateCartOpts,
  ) => Promise<StoreCartResponse>;
}

export type LibraryLoaderFn = () => Promise<{
  libraryLooks?: unknown;
  libraryOccasions?: unknown;
  occasionMenu?: unknown;
  matchOccasionWords?: unknown;
} | null>;

export interface LiveKitRoomInfo {
  name: string;
  numParticipants?: number;
}

export interface LiveKitParticipantInfo {
  identity: string;
  kind?: number | string;
}

export interface ActiveCallsClient {
  listRooms(): Promise<LiveKitRoomInfo[]>;
  listParticipants(roomName: string): Promise<LiveKitParticipantInfo[]>;
}

export interface AliceBudgetOptions {
  storefrontMs?: number;
  productMs?: number;
  searchMs?: number;
  looksMs?: number;
  looksDefaultMs?: number;
  bagMs?: number;
  activeCallsMs?: number;
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
  now?: () => number;
  activeCallsClient?: ActiveCallsClient;
}

export interface AliceHttpsServerOptions extends AliceServerOptions {
  cert: string | Buffer;
  key: string | Buffer;
}

const TOKEN_TTL_SECONDS = 1800;
const ROOM_PREFIX = 'alice-';
const SHOPPER_IDENTITY_PREFIX = 'shopper-';
const AGENT_PARTICIPANT_KIND = 4; // ParticipantInfo_Kind.AGENT in @livekit/protocol
const ACTIVE_CALLS_TIMEOUT_MS = 1500;
const ACTIVE_CALLS_CACHE_MS = 2000;
const ACTIVE_CALLS_RESERVATION_MS = 50_000;
const ACTIVE_CALLS_RETRY_AFTER_S = 20;
const ACTIVE_CALLS_FAIL_LOG_WINDOW_MS = 60_000;
const CALL_IN_PROGRESS_MESSAGE = "There's already someone talking to Alice. Please stand by.";
const MAX_TOKEN_BODY_BYTES = 4096;
const MAX_BAG_BODY_BYTES = 16 * 1024;
const BAG_RATE_LIMIT_MAX = 6;
const BAG_GLOBAL_RATE_LIMIT_MAX = 20;
const BAG_RATE_LIMIT_WINDOW_MS = 60_000;
const BAG_BUDGET_MS = 8000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BAD_PASSCODE_LIMIT_MAX = 5;
const BAD_PASSCODE_GLOBAL_MAX = 600;
const BAD_PASSCODE_WINDOW_MS = 60_000;
const MIN_PROXY_PASSCODE_LEN = 12;
const ORIGIN_MISMATCH_LOG_WINDOW_MS = 60_000;
const HOURLY_CAP_WINDOW_MS = 60 * 60 * 1000;
const BROWSE_RATE_LIMIT_MAX = 90;
const BROWSE_RATE_LIMIT_WINDOW_MS = 60_000;
const PROXY_GLOBAL_BROWSE_LIMIT_MAX = 30;
const PROXY_GLOBAL_BROWSE_WINDOW_MS = 60_000;
const PROXY_UNKNOWN_BUCKET = 'proxy-unknown';
const STOREFRONT_BUDGET_MS = 4000;
const STOREFRONT_WAIT_MIN_MS = 500;
const STOREFRONT_WAIT_MAX_MS = 6000;
const PRODUCT_BUDGET_MS = 1300;
const SEARCH_BUDGET_MS = 1300;
const LOOKS_BUDGET_MS = 1400;
const LOOKS_DEFAULT_BUDGET_MS = 4000;
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

type ReadStrictJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'body_too_large' | 'invalid_json' };

async function readStrictJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadStrictJsonBodyResult> {
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

    const finish = (result: ReadStrictJsonBodyResult): void => {
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
        finish({ ok: false, reason: 'invalid_json' });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finish({ ok: true, body: parsed as Record<string, unknown> });
        } else {
          finish({ ok: false, reason: 'invalid_json' });
        }
      } catch {
        finish({ ok: false, reason: 'invalid_json' });
      }
    };

    const onError = (): void => {
      finish({ ok: false, reason: 'invalid_json' });
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

const PROXY_HEADER_NAMES = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
]);

let warnedProxiedNoPasscode = false;
let warnedProxiedTrustOff = false;

export function isProxied(req: IncomingMessage): boolean {
  for (const key of Object.keys(req.headers)) {
    if (req.headers[key] === undefined) continue;
    const lower = key.toLowerCase();
    if (
      PROXY_HEADER_NAMES.has(lower) ||
      lower.startsWith('ngrok-') ||
      lower.startsWith('x-ngrok-')
    ) {
      return true;
    }
  }
  return false;
}

function isTrustProxyEnabled(env: Record<string, string | undefined>): boolean {
  return env.ALICE_TRUST_PROXY?.trim() === '1';
}

function parseMaxActiveCalls(env: Record<string, string | undefined>): number | null {
  const raw = env.ALICE_MAX_ACTIVE_CALLS;
  if (raw === undefined) {
    return env.AVATAR?.trim().toLowerCase() === 'tavus' ? 1 : null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function toLiveKitHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

function isNonAgentParticipant(p: LiveKitParticipantInfo): boolean {
  const id = typeof p?.identity === 'string' ? p.identity : '';
  if (id.startsWith(SHOPPER_IDENTITY_PREFIX)) return true;
  if (p?.kind === AGENT_PARTICIPANT_KIND || p?.kind === 'AGENT') return false;
  const lower = id.toLowerCase();
  if (lower.startsWith('agent-') || lower.startsWith('tavus')) return false;
  return id.length > 0;
}

function parseMaxCallsPerHour(env: Record<string, string | undefined>): number | null {
  const raw = env.ALICE_MAX_CALLS_PER_HOUR;
  if (!raw || !raw.trim()) return null;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseValidIp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return net.isIP(unbracketed) !== 0 ? unbracketed.toLowerCase() : null;
}

function parseHostHeader(
  raw: string | string[] | undefined,
): { host: string; port: string | null; bracketed: boolean } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const ipv6Match = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(trimmed);
  if (ipv6Match) {
    const port = ipv6Match[2] ?? null;
    if (port !== null) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    }
    return { host: ipv6Match[1].toLowerCase(), port, bracketed: true };
  }

  const hostMatch = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!hostMatch) return null;
  const port = hostMatch[2] ?? null;
  if (port !== null) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  }
  return { host: hostMatch[1].toLowerCase(), port, bracketed: false };
}

function isLocalHostHeader(raw: string | string[] | undefined): boolean {
  const parsed = parseHostHeader(raw);
  if (!parsed) return false;
  if (parsed.bracketed) {
    return parsed.host === '::1';
  }
  return parsed.host === 'localhost' || parsed.host === '127.0.0.1';
}

function originMatchesHost(
  originHeader: string | string[] | undefined,
  hostHeader: string | string[] | undefined,
): boolean {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string') return false;
  const trimmedOrigin = originHeader.trim();
  if (!trimmedOrigin) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(trimmedOrigin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false;
  }

  const parsedHost = parseHostHeader(hostHeader);
  if (!parsedHost) return false;

  const defaultPort = originUrl.protocol === 'https:' ? '443' : '80';
  const normalizedHostPort =
    parsedHost.port && parsedHost.port !== defaultPort ? `:${parsedHost.port}` : '';
  const normalizedHostName = parsedHost.bracketed ? `[${parsedHost.host}]` : parsedHost.host;
  const normalizedHost = `${normalizedHostName}${normalizedHostPort}`;

  return originUrl.host.toLowerCase() === normalizedHost;
}

export function clientAddress(
  req: IncomingMessage,
  opts?: {
    env?: Record<string, string | undefined>;
    remoteAddress?: (req: IncomingMessage) => string | undefined;
  },
): string {
  const socketAddr =
    (opts?.remoteAddress ? opts.remoteAddress(req) : req.socket?.remoteAddress) ?? 'unknown';
  const env = opts?.env ?? process.env;
  if (!isTrustProxyEnabled(env) || !isLoopbackHost(socketAddr)) {
    return socketAddr;
  }

  const rawCf = req.headers['cf-connecting-ip'];
  const cfCandidate =
    typeof rawCf === 'string'
      ? rawCf
      : Array.isArray(rawCf) && rawCf.length > 0
        ? rawCf[rawCf.length - 1]
        : '';
  const cfIp = parseValidIp(cfCandidate);
  if (cfIp) {
    return cfIp;
  }

  const rawXff = req.headers['x-forwarded-for'];
  const xffStr =
    typeof rawXff === 'string' ? rawXff : Array.isArray(rawXff) ? rawXff.join(',') : '';
  if (xffStr) {
    const parts = xffStr
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) {
      const rightmostIp = parseValidIp(parts[parts.length - 1]);
      if (rightmostIp) {
        return rightmostIp;
      }
    }
  }

  return PROXY_UNKNOWN_BUCKET;
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
        if (outfit.pieces.length > 0) {
          return outfit.pieces.every((p) => {
            const dept = p?.item?.department;
            return dept === department || dept === undefined || dept === null || (dept as string) === '';
          });
        }
        return parsed.brief?.gender === department;
      });

      return matching.slice(0, limit);
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

interface OccasionMenuItem {
  key: string;
  keyword: string;
}

interface OccasionWordMatch {
  key: string;
  label: string;
  score: number;
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

function normalizeOccasionMenu(raw: unknown): OccasionMenuItem[] {
  if (!Array.isArray(raw)) return [];
  const out: OccasionMenuItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as { key?: unknown; keyword?: unknown };
    const key = typeof obj.key === 'string' ? obj.key.trim() : '';
    const keyword = typeof obj.keyword === 'string' ? obj.keyword.trim() : '';
    if (key && keyword) {
      out.push({ key, keyword });
    }
  }
  return out;
}

function normalizeOccasionWordMatch(raw: unknown): OccasionWordMatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as { key?: unknown; label?: unknown; score?: unknown };
  const key = typeof obj.key === 'string' ? obj.key.trim() : '';
  const label = typeof obj.label === 'string' ? obj.label.trim() : '';
  const score = typeof obj.score === 'number' && Number.isFinite(obj.score) ? obj.score : NaN;
  if (!key || !label || !Number.isFinite(score)) return null;
  return { key, label, score };
}

interface MemoizedSetsOccasions {
  mtimeMs: number;
  size: number;
  entries: SetsOccasionEntry[];
}

const setsOccasionsMemo = new Map<string, MemoizedSetsOccasions>();

async function readLibraryOccasionsFromSets(
  department: Gender,
  env: Record<string, string | undefined>,
): Promise<SetsOccasionEntry[]> {
  const override = env.ALICE_LIBRARY_FILE;
  const filePath =
    override && override.trim().length > 0
      ? path.resolve(override)
      : path.join(import.meta.dirname, 'src', 'library', 'sets.json');
  const cacheKey = `${filePath}\0${department}`;

  try {
    const stat = await fs.promises.stat(filePath);
    const cached = setsOccasionsMemo.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries;
    }

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      sets?: Array<{ key?: unknown; gender?: unknown; occasion?: unknown; outfits?: unknown }>;
    };
    if (!Array.isArray(parsed?.sets)) {
      setsOccasionsMemo.delete(cacheKey);
      return [];
    }

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
    setsOccasionsMemo.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, entries: out });
    return out;
  } catch {
    setsOccasionsMemo.delete(cacheKey);
    return [];
  }
}

function defaultLoadLibrary(): Promise<{
  libraryLooks?: unknown;
  libraryOccasions?: unknown;
  occasionMenu?: unknown;
  matchOccasionWords?: unknown;
} | null> {
  return import('./src/library/index.ts').catch(() => null);
}

export function createAliceHandler(opts: AliceServerOptions = {}): RequestListener {
  const nowFn = opts.now ?? (() => Date.now());
  const startedAt = nowFn();
  type BagBuildOutcome =
    | { kind: 'ok'; payload: ReturnType<typeof bagToPagePayload> }
    | { kind: 'bad_request'; problems: string[] }
    | { kind: 'store_error' };

  const rateBuckets = new Map<string, number[]>();
  const browseRateBuckets = new Map<string, number[]>();
  const bagRateBuckets = new Map<string, number[]>();
  const bagInFlight = new Map<string, { hash: string; promise: Promise<BagBuildOutcome> }>();
  let bagGlobalTimestamps: number[] = [];
  const badPasscodeBuckets = new Map<string, number[]>();
  let globalBadPasscodeTimestamps: number[] = [];
  let hourlyTokenTimestamps: number[] = [];
  let proxyGlobalBrowseTimestamps: number[] = [];
  let lastOriginMismatchLogMs = -Infinity;
  const activeCallReservations = new Map<string, number>();
  let cachedLiveRooms: { fetchedAt: number; rooms: Set<string> } | null = null;
  let inFlightLiveLookup: Promise<Set<string> | null> | null = null;
  let lastActiveCallsFailLogMs = -Infinity;
  let cachedRoomServiceKey = '';
  let cachedRoomServiceClient: ActiveCallsClient | null = null;
  const inFlightLooks = new Map<string, Promise<Outfit[] | null>>();
  const logSink = opts.calllog ?? defaultCalllog;
  const loadLibraryFn = opts.loadLibrary ?? defaultLoadLibrary;
  const storefrontBudgetMs = opts.budgets?.storefrontMs ?? STOREFRONT_BUDGET_MS;
  const productBudgetMs = opts.budgets?.productMs ?? PRODUCT_BUDGET_MS;
  const searchBudgetMs = opts.budgets?.searchMs ?? SEARCH_BUDGET_MS;
  const looksBudgetMs = opts.budgets?.looksMs ?? LOOKS_BUDGET_MS;
  const looksDefaultBudgetMs = opts.budgets?.looksDefaultMs ?? LOOKS_DEFAULT_BUDGET_MS;
  const bagBudgetMs = opts.budgets?.bagMs ?? BAG_BUDGET_MS;
  const activeCallsTimeoutMs = opts.budgets?.activeCallsMs ?? ACTIVE_CALLS_TIMEOUT_MS;

  const searchMixedFn = opts.store?.searchMixed ?? defaultSearchMixed;
  const searchFn = opts.store?.search ?? defaultSearch;
  const getProductFn = opts.store?.getProduct ?? defaultGetProduct;
  const sizeVariantFn = opts.store?.sizeVariant ?? defaultSizeVariant;
  const createCartFn = opts.store?.createCart ?? defaultCreateCart;
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

  function sweepBucketMap(buckets: Map<string, number[]>, cutoff: number): void {
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
  }

  function checkBucketRateLimit(
    buckets: Map<string, number[]>,
    remoteAddr: string,
    maxRequests: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterS: number } {
    const now = nowFn();
    const cutoff = now - windowMs;
    sweepBucketMap(buckets, cutoff);

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

  function checkProxyGlobalBrowseLimit(): { allowed: boolean; retryAfterS: number } {
    const now = nowFn();
    const cutoff = now - PROXY_GLOBAL_BROWSE_WINDOW_MS;
    proxyGlobalBrowseTimestamps = proxyGlobalBrowseTimestamps.filter((t) => t > cutoff);
    if (proxyGlobalBrowseTimestamps.length >= PROXY_GLOBAL_BROWSE_LIMIT_MAX) {
      const retryAfterS = Math.max(
        1,
        Math.ceil((proxyGlobalBrowseTimestamps[0] + PROXY_GLOBAL_BROWSE_WINDOW_MS - now) / 1000),
      );
      return { allowed: false, retryAfterS };
    }
    proxyGlobalBrowseTimestamps.push(now);
    return { allowed: true, retryAfterS: 0 };
  }

  function checkBagRateLimit(remoteAddr: string): { allowed: boolean; retryAfterS: number } {
    const now = nowFn();
    const cutoff = now - BAG_RATE_LIMIT_WINDOW_MS;
    sweepBucketMap(bagRateBuckets, cutoff);

    const clientRecent = (bagRateBuckets.get(remoteAddr) ?? []).filter((t) => t > cutoff);
    if (clientRecent.length >= BAG_RATE_LIMIT_MAX) {
      bagRateBuckets.set(remoteAddr, clientRecent);
      const retryAfterS = Math.max(
        1,
        Math.ceil((clientRecent[0] + BAG_RATE_LIMIT_WINDOW_MS - now) / 1000),
      );
      return { allowed: false, retryAfterS };
    }

    bagGlobalTimestamps = bagGlobalTimestamps.filter((t) => t > cutoff);
    if (bagGlobalTimestamps.length >= BAG_GLOBAL_RATE_LIMIT_MAX) {
      if (clientRecent.length > 0) {
        bagRateBuckets.set(remoteAddr, clientRecent);
      } else {
        bagRateBuckets.delete(remoteAddr);
      }
      const retryAfterS = Math.max(
        1,
        Math.ceil((bagGlobalTimestamps[0] + BAG_RATE_LIMIT_WINDOW_MS - now) / 1000),
      );
      return { allowed: false, retryAfterS };
    }

    clientRecent.push(now);
    bagRateBuckets.set(remoteAddr, clientRecent);
    bagGlobalTimestamps.push(now);
    return { allowed: true, retryAfterS: 0 };
  }

  function checkPasscodeLockout(remoteAddr: string): { locked: boolean; retryAfterS: number } {
    const now = nowFn();
    const cutoff = now - BAD_PASSCODE_WINDOW_MS;
    sweepBucketMap(badPasscodeBuckets, cutoff);

    const clientRecent = (badPasscodeBuckets.get(remoteAddr) ?? []).filter((t) => t > cutoff);
    if (clientRecent.length === 0) {
      badPasscodeBuckets.delete(remoteAddr);
    } else {
      badPasscodeBuckets.set(remoteAddr, clientRecent);
    }

    globalBadPasscodeTimestamps = globalBadPasscodeTimestamps.filter((t) => t > cutoff);

    let retryAfterS = 0;
    if (clientRecent.length >= BAD_PASSCODE_LIMIT_MAX) {
      retryAfterS = Math.max(
        retryAfterS,
        Math.max(1, Math.ceil((clientRecent[0] + BAD_PASSCODE_WINDOW_MS - now) / 1000)),
      );
    }
    if (globalBadPasscodeTimestamps.length >= BAD_PASSCODE_GLOBAL_MAX) {
      retryAfterS = Math.max(
        retryAfterS,
        Math.max(
          1,
          Math.ceil((globalBadPasscodeTimestamps[0] + BAD_PASSCODE_WINDOW_MS - now) / 1000),
        ),
      );
    }

    return retryAfterS > 0 ? { locked: true, retryAfterS } : { locked: false, retryAfterS: 0 };
  }

  function recordBadPasscodeAttempt(remoteAddr: string): void {
    const now = nowFn();
    const cutoff = now - BAD_PASSCODE_WINDOW_MS;
    sweepBucketMap(badPasscodeBuckets, cutoff);
    const clientRecent = (badPasscodeBuckets.get(remoteAddr) ?? []).filter((t) => t > cutoff);
    clientRecent.push(now);
    badPasscodeBuckets.set(remoteAddr, clientRecent);
    globalBadPasscodeTimestamps = globalBadPasscodeTimestamps.filter((t) => t > cutoff);
    globalBadPasscodeTimestamps.push(now);
  }

  function checkHourlyCap(maxPerHour: number | null): { allowed: boolean; retryAfterS: number } {
    const now = nowFn();
    const cutoff = now - HOURLY_CAP_WINDOW_MS;
    hourlyTokenTimestamps = hourlyTokenTimestamps.filter((t) => t > cutoff);
    if (maxPerHour !== null && hourlyTokenTimestamps.length >= maxPerHour) {
      const retryAfterS = Math.max(
        1,
        Math.ceil((hourlyTokenTimestamps[0] + HOURLY_CAP_WINDOW_MS - now) / 1000),
      );
      return { allowed: false, retryAfterS };
    }
    return { allowed: true, retryAfterS: 0 };
  }

  function recordSuccessfulMint(): void {
    const now = nowFn();
    const cutoff = now - HOURLY_CAP_WINDOW_MS;
    hourlyTokenTimestamps = hourlyTokenTimestamps.filter((t) => t > cutoff);
    hourlyTokenTimestamps.push(now);
  }

  function getActiveCallsClient(
    livekitUrl: string,
    apiKey: string,
    apiSecret: string,
  ): ActiveCallsClient {
    if (opts.activeCallsClient) {
      return opts.activeCallsClient;
    }
    const httpUrl = toLiveKitHttpUrl(livekitUrl);
    const key = `${httpUrl}\0${apiKey}\0${apiSecret}`;
    if (!cachedRoomServiceClient || cachedRoomServiceKey !== key) {
      const rsc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      cachedRoomServiceClient = {
        listRooms: () => rsc.listRooms(),
        listParticipants: (roomName: string) => rsc.listParticipants(roomName),
      };
      cachedRoomServiceKey = key;
    }
    return cachedRoomServiceClient;
  }

  async function lookupLiveActiveRooms(
    livekitUrl: string,
    apiKey: string,
    apiSecret: string,
  ): Promise<Set<string> | null> {
    const now = nowFn();
    if (cachedLiveRooms && now - cachedLiveRooms.fetchedAt < ACTIVE_CALLS_CACHE_MS) {
      return cachedLiveRooms.rooms;
    }
    if (inFlightLiveLookup) {
      return inFlightLiveLookup;
    }

    const logLookupFailure = (reason: string): void => {
      const failNow = nowFn();
      if (failNow - lastActiveCallsFailLogMs >= ACTIVE_CALLS_FAIL_LOG_WINDOW_MS) {
        lastActiveCallsFailLogMs = failNow;
        logServerEvent('active_calls_lookup_failed', { reason });
      }
    };

    const run = (async (): Promise<Set<string> | null> => {
      try {
        const client = getActiveCallsClient(livekitUrl, apiKey, apiSecret);
        const query = (async (): Promise<Set<string>> => {
          const rooms = await client.listRooms();
          const candidateNames = (Array.isArray(rooms) ? rooms : [])
            .filter(
              (r) =>
                r &&
                typeof r.name === 'string' &&
                r.name.startsWith(ROOM_PREFIX) &&
                (typeof r.numParticipants !== 'number' || r.numParticipants >= 1),
            )
            .map((r) => r.name);

          const activeNames = new Set<string>();
          if (candidateNames.length > 0) {
            const participantLists = await Promise.all(
              candidateNames.map(async (roomName) => ({
                roomName,
                participants: await client.listParticipants(roomName),
              })),
            );
            for (const { roomName, participants } of participantLists) {
              if (Array.isArray(participants) && participants.some(isNonAgentParticipant)) {
                activeNames.add(roomName);
              }
            }
          }
          return activeNames;
        })();

        const raced = await raceWithBudget(query, activeCallsTimeoutMs);
        if (raced.timedOut) {
          logLookupFailure('timeout');
          return null;
        }
        cachedLiveRooms = { fetchedAt: nowFn(), rooms: raced.value };
        return raced.value;
      } catch (err) {
        logLookupFailure(err instanceof Error ? err.message.slice(0, 120) : 'error');
        return null;
      } finally {
        if (inFlightLiveLookup === run) {
          inFlightLiveLookup = null;
        }
      }
    })();

    inFlightLiveLookup = run;
    return run;
  }

  function pruneReservations(liveRooms: Set<string> | null): void {
    const now = nowFn();
    for (const [roomName, expiresAt] of activeCallReservations) {
      if (expiresAt <= now || (liveRooms !== null && liveRooms.has(roomName))) {
        activeCallReservations.delete(roomName);
      }
    }
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
          uptime_s: Math.max(0, Math.floor((nowFn() - startedAt) / 1000)),
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

        const socketAddr =
          (opts.remoteAddress ? opts.remoteAddress(req) : req.socket.remoteAddress) ?? 'unknown';
        const trustProxy = isTrustProxyEnabled(env);
        const proxied = isProxied(req);
        if (proxied && !trustProxy && !warnedProxiedTrustOff) {
          warnedProxiedTrustOff = true;
          console.warn(
            '[server] WARNING: proxied request received with ALICE_TRUST_PROXY off — visitors share one rate-limit bucket; set ALICE_TRUST_PROXY=1 if behind a local proxy/tunnel.',
          );
        }

        const remoteAddr = clientAddress(req, { env, remoteAddress: opts.remoteAddress });
        const addrLog: Record<string, unknown> = trustProxy
          ? { remote_addr: remoteAddr, socket_addr: socketAddr }
          : { remote_addr: remoteAddr };

        const limit = checkRateLimit(remoteAddr);
        if (!limit.allowed) {
          logServerEvent('token_refused', { reason: 'slow_down', ...addrLog });
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': String(limit.retryAfterS), 'Cache-Control': 'no-store' },
          );
          return;
        }

        if (!originMatchesHost(req.headers.origin, req.headers.host)) {
          if (!trustProxy) {
            logServerEvent('token_refused', { reason: 'bad_origin', ...addrLog });
            sendJson(res, 403, { error: 'bad_origin' }, { 'Cache-Control': 'no-store' });
            return;
          }
          const now = nowFn();
          if (now - lastOriginMismatchLogMs >= ORIGIN_MISMATCH_LOG_WINDOW_MS) {
            lastOriginMismatchLogMs = now;
            logServerEvent('origin_mismatch', { ...addrLog });
          }
        }

        const expectedPasscode = env.ALICE_PASSCODE;
        const isDirectLocal =
          isLoopbackHost(socketAddr) && !proxied && isLocalHostHeader(req.headers.host);
        const isLocalCaller = !trustProxy && isDirectLocal;
        if (!expectedPasscode && !isLocalCaller) {
          if (proxied && !warnedProxiedNoPasscode) {
            warnedProxiedNoPasscode = true;
            console.warn(
              '[server] WARNING: proxy detected in front of Alice with ALICE_PASSCODE unset — refusing /api/token; set ALICE_PASSCODE in .env.local.',
            );
          }
          logServerEvent('token_refused', {
            reason: 'passcode_not_configured',
            ...addrLog,
          });
          sendJson(
            res,
            403,
            { error: 'passcode_not_configured' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        if (trustProxy && expectedPasscode && expectedPasscode.length < MIN_PROXY_PASSCODE_LEN) {
          logServerEvent('token_refused', {
            reason: 'passcode_too_short',
            ...addrLog,
          });
          sendJson(
            res,
            403,
            { error: 'passcode_too_short' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        if (expectedPasscode) {
          const lockout = checkPasscodeLockout(remoteAddr);
          if (lockout.locked) {
            logServerEvent('token_refused', { reason: 'passcode_locked', ...addrLog });
            sendJson(
              res,
              429,
              { error: 'passcode_locked' },
              { 'Retry-After': String(lockout.retryAfterS), 'Cache-Control': 'no-store' },
            );
            return;
          }
        }

        const bodyResult = await readOptionalJsonBody(req);
        if (!bodyResult.ok) {
          logServerEvent('token_refused', { reason: 'body_too_large', ...addrLog });
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
          const lockoutAfterBody = checkPasscodeLockout(remoteAddr);
          if (lockoutAfterBody.locked) {
            logServerEvent('token_refused', { reason: 'passcode_locked', ...addrLog });
            sendJson(
              res,
              429,
              { error: 'passcode_locked' },
              { 'Retry-After': String(lockoutAfterBody.retryAfterS), 'Cache-Control': 'no-store' },
            );
            return;
          }
          if (!suppliedPasscode) {
            logServerEvent('token_refused', {
              reason: 'passcode_required',
              ...addrLog,
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
            recordBadPasscodeAttempt(remoteAddr);
            logServerEvent('token_refused', { reason: 'bad_passcode', ...addrLog });
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
            ...addrLog,
          });
          sendJson(
            res,
            503,
            { error: 'livekit_not_configured' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        const maxCallsPerHour = parseMaxCallsPerHour(env);
        let bypassedHourlyCap = false;
        const hourlyBefore = checkHourlyCap(maxCallsPerHour);
        if (!hourlyBefore.allowed) {
          if (isDirectLocal) {
            bypassedHourlyCap = true;
            logServerEvent('hourly_cap_bypass_local', { ...addrLog });
          } else {
            logServerEvent('token_refused', { reason: 'hourly_cap', ...addrLog });
            sendJson(
              res,
              429,
              { error: 'busy', retry_after_s: hourlyBefore.retryAfterS },
              { 'Retry-After': String(hourlyBefore.retryAfterS), 'Cache-Control': 'no-store' },
            );
            return;
          }
        }

        const room = `${ROOM_PREFIX}${crypto.randomBytes(5).toString('hex')}`;
        const maxActiveCalls = parseMaxActiveCalls(env);
        let reservedRoom = false;

        if (maxActiveCalls !== null) {
          if (isDirectLocal) {
            logServerEvent('active_calls_bypass_local', { ...addrLog });
            // Still reserve the slot synchronously so tunnel callers cannot interrupt the local operator's call.
            pruneReservations(null);
            activeCallReservations.set(room, nowFn() + ACTIVE_CALLS_RESERVATION_MS);
            reservedRoom = true;
          } else {
            const liveRooms = await lookupLiveActiveRooms(url, apiKey, apiSecret);
            // Synchronous check-and-reserve critical section (no await between check and set).
            pruneReservations(liveRooms);
            const liveCount = liveRooms ? liveRooms.size : 0;
            const activeCount = liveCount + activeCallReservations.size;
            if (activeCount >= maxActiveCalls) {
              logServerEvent('token_refused', { reason: 'call_in_progress', ...addrLog });
              sendJson(
                res,
                429,
                {
                  error: 'busy',
                  reason: 'call_in_progress',
                  message: CALL_IN_PROGRESS_MESSAGE,
                  retry_after_s: ACTIVE_CALLS_RETRY_AFTER_S,
                },
                {
                  'Retry-After': String(ACTIVE_CALLS_RETRY_AFTER_S),
                  'Cache-Control': 'no-store',
                },
              );
              return;
            }
            activeCallReservations.set(room, nowFn() + ACTIVE_CALLS_RESERVATION_MS);
            reservedRoom = true;
          }
        }

        const identity = `${SHOPPER_IDENTITY_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
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

        let token: string;
        try {
          token = await at.toJwt();
        } catch (err) {
          if (reservedRoom) {
            activeCallReservations.delete(room);
          }
          throw err;
        }

        const hourlyAfter = checkHourlyCap(maxCallsPerHour);
        if (!hourlyAfter.allowed) {
          if (isDirectLocal) {
            if (!bypassedHourlyCap) {
              logServerEvent('hourly_cap_bypass_local', { ...addrLog });
            }
          } else {
            if (reservedRoom) {
              activeCallReservations.delete(room);
            }
            logServerEvent('token_refused', { reason: 'hourly_cap', ...addrLog });
            sendJson(
              res,
              429,
              { error: 'busy', retry_after_s: hourlyAfter.retryAfterS },
              { 'Retry-After': String(hourlyAfter.retryAfterS), 'Cache-Control': 'no-store' },
            );
            return;
          }
        }
        recordSuccessfulMint();

        logExtra = `room=${room}`;
        logServerEvent('token', { room, identity, agent, ...addrLog });

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

      // 3a. POST /api/bag — direct storefront bag creation (no model, no purchase, no sign-in)
      if (rawPathname === '/api/bag') {
        if (method !== 'POST') {
          logExtra = 'pieces=0 added=0 not_added=0 carts=0';
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return;
        }

        const socketAddr =
          (opts.remoteAddress ? opts.remoteAddress(req) : req.socket.remoteAddress) ?? 'unknown';
        const trustProxy = isTrustProxyEnabled(env);
        const proxied = isProxied(req);
        if (proxied && !trustProxy && !warnedProxiedTrustOff) {
          warnedProxiedTrustOff = true;
          console.warn(
            '[server] WARNING: proxied request received with ALICE_TRUST_PROXY off — visitors share one rate-limit bucket; set ALICE_TRUST_PROXY=1 if behind a local proxy/tunnel.',
          );
        }

        const remoteAddr = clientAddress(req, { env, remoteAddress: opts.remoteAddress });
        const addrLog: Record<string, unknown> = trustProxy
          ? { remote_addr: remoteAddr, socket_addr: socketAddr }
          : { remote_addr: remoteAddr };

        if (!originMatchesHost(req.headers.origin, req.headers.host)) {
          if (!trustProxy) {
            logExtra = 'pieces=0 added=0 not_added=0 carts=0';
            logServerEvent('bag', {
              status: 403,
              reason: 'bad_origin',
              pieces: 0,
              added: 0,
              not_added: 0,
              carts: 0,
              ...addrLog,
            });
            sendJson(res, 403, { error: 'bad_origin' }, { 'Cache-Control': 'no-store' });
            return;
          }
          const now = nowFn();
          if (now - lastOriginMismatchLogMs >= ORIGIN_MISMATCH_LOG_WINDOW_MS) {
            lastOriginMismatchLogMs = now;
            logServerEvent('origin_mismatch', { ...addrLog });
          }
        }

        const rawCt = req.headers['content-type'];
        const ct = typeof rawCt === 'string' ? rawCt : Array.isArray(rawCt) ? (rawCt[0] ?? '') : '';
        const mediaType = ct.split(';')[0]?.trim().toLowerCase() ?? '';
        if (mediaType !== 'application/json') {
          logExtra = 'pieces=0 added=0 not_added=0 carts=0';
          logServerEvent('bag', {
            status: 415,
            reason: 'json_only',
            pieces: 0,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(res, 415, { error: 'json_only' }, { 'Cache-Control': 'no-store' });
          return;
        }

        const bodyResult = await readStrictJsonBody(req, MAX_BAG_BODY_BYTES);
        if (!bodyResult.ok) {
          logExtra = 'pieces=0 added=0 not_added=0 carts=0';
          if (bodyResult.reason === 'body_too_large') {
            logServerEvent('bag', {
              status: 413,
              reason: 'body_too_large',
              pieces: 0,
              added: 0,
              not_added: 0,
              carts: 0,
              ...addrLog,
            });
            res.once('finish', () => req.destroy());
            sendJson(
              res,
              413,
              { error: 'body_too_large' },
              { Connection: 'close', 'Cache-Control': 'no-store' },
            );
            return;
          }
          logServerEvent('bag', {
            status: 400,
            reason: 'invalid_json',
            pieces: 0,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(
            res,
            400,
            { error: 'bad_request', problems: ['body must be a valid JSON object'] },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        const validated = validateBagRequest(bodyResult.body);
        if (!validated.ok) {
          logExtra = 'pieces=0 added=0 not_added=0 carts=0';
          logServerEvent('bag', {
            status: 400,
            reason: 'validation_failed',
            pieces: 0,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(
            res,
            400,
            { error: 'bad_request', problems: validated.problems },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        const { department, pieces: pieceInputs, sizes } = validated.value;
        const pieceCount = pieceInputs.length;
        const buildHash = computeBagBuildHash(validated.value);

        const existingFlight = bagInFlight.get(remoteAddr);
        if (existingFlight && existingFlight.hash !== buildHash) {
          logExtra = `pieces=${pieceCount} added=0 not_added=0 carts=0`;
          logServerEvent('bag', {
            status: 429,
            reason: 'in_flight',
            pieces: pieceCount,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': '2', 'Cache-Control': 'no-store' },
          );
          return;
        }

        const bagLimit = checkBagRateLimit(remoteAddr);
        if (!bagLimit.allowed) {
          logExtra = `pieces=${pieceCount} added=0 not_added=0 carts=0`;
          logServerEvent('bag', {
            status: 429,
            reason: 'slow_down',
            pieces: pieceCount,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(
            res,
            429,
            { error: 'slow_down' },
            { 'Retry-After': String(bagLimit.retryAfterS), 'Cache-Control': 'no-store' },
          );
          return;
        }

        let buildPromise: Promise<BagBuildOutcome>;
        if (existingFlight && existingFlight.hash === buildHash) {
          buildPromise = existingFlight.promise;
        } else {
          const runBagBuild = async (): Promise<BagBuildOutcome> => {
            try {
              const detailCache = new Map<string, ProductDetail | null>();
              const fetched = await Promise.all(
                pieceInputs.map(async (p) => {
                  const detail = await getProductFn(p.lookupId);
                  detailCache.set(p.lookupId, detail);
                  if (detail) {
                    detailCache.set(detail.id, detail);
                    detailCache.set(detail.variant.id, detail);
                  }
                  return { input: p, detail };
                }),
              );

              const disallowProblems: string[] = [];
              const sanitisedPieces: Piece[] = [];

              for (const { input, detail } of fetched) {
                if (!detail) {
                  sanitisedPieces.push(
                    placeholderPieceForUnknownId(input.slot, input.lookupId, department),
                  );
                  continue;
                }
                const allowlistedStore = findAllowlistedStoreForDetail(detail);
                if (!allowlistedStore) {
                  disallowProblems.push(
                    `piece[${input.index}]: product store is not in the allowlisted stores`,
                  );
                  continue;
                }
                sanitisedPieces.push(
                  pieceFromStoreDetail(input.slot, detail, allowlistedStore, department),
                );
              }

              if (disallowProblems.length > 0) {
                return { kind: 'bad_request', problems: disallowProblems };
              }

              const sanitisedOutfit: Outfit = {
                name: 'Bag',
                difference: '',
                story: '',
                pieces: sanitisedPieces,
                total: 0,
              };

              let storeThrew = false;
              let disallowedCartDomain = false;
              const bagRunner = createBag({
                getProduct: async (id: string) => {
                  if (detailCache.has(id)) {
                    return detailCache.get(id) ?? null;
                  }
                  try {
                    return await getProductFn(id);
                  } catch (err) {
                    storeThrew = true;
                    throw err;
                  }
                },
                sizeVariant: async (variantId, size, svOpts) => {
                  try {
                    return await sizeVariantFn(variantId, size, svOpts);
                  } catch (err) {
                    storeThrew = true;
                    throw err;
                  }
                },
                createCart: async (storeDomain, lines, cartOpts) => {
                  if (!isAllowlistedStoreDomain(storeDomain)) {
                    disallowedCartDomain = true;
                    throw new Error('store_not_allowlisted');
                  }
                  // Force quantity 1 per line regardless of any client input
                  const fixedLines = lines.map((l) => ({ variant_id: l.variant_id, quantity: 1 }));
                  try {
                    return await createCartFn(storeDomain, fixedLines, cartOpts);
                  } catch (err) {
                    storeThrew = true;
                    throw err;
                  }
                },
                now: nowFn,
              });

              const bagOut = await bagRunner.addToBag(sanitisedOutfit, sizes, department);
              if (disallowedCartDomain) {
                return {
                  kind: 'bad_request',
                  problems: ['product store is not in the allowlisted stores'],
                };
              }
              if (storeThrew && bagOut.carts.length === 0) {
                return { kind: 'store_error' };
              }

              const payload = bagToPagePayload(bagOut, sanitisedOutfit, sizes, {
                onLinkDropped: ({ store }) => {
                  logServerEvent('bag_link_dropped', { store, ...addrLog });
                },
              });
              return { kind: 'ok', payload };
            } catch {
              return { kind: 'store_error' };
            }
          };

          const created = runBagBuild();
          const flightEntry = { hash: buildHash, promise: created };
          bagInFlight.set(remoteAddr, flightEntry);
          const cleanupFlight = (): void => {
            if (bagInFlight.get(remoteAddr) === flightEntry) {
              bagInFlight.delete(remoteAddr);
            }
          };
          created.then(cleanupFlight, cleanupFlight);
          buildPromise = created;
        }

        const raced = await raceWithBudget(buildPromise, bagBudgetMs);
        if (raced.timedOut) {
          if (bagInFlight.get(remoteAddr)?.promise === buildPromise) {
            bagInFlight.delete(remoteAddr);
          }
          logExtra = `pieces=${pieceCount} added=0 not_added=0 carts=0`;
          logServerEvent('bag', {
            status: 504,
            reason: 'timeout',
            pieces: pieceCount,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(res, 504, { error: 'timeout' }, { 'Cache-Control': 'no-store' });
          return;
        }

        const outcome = raced.value;
        if (outcome.kind === 'bad_request') {
          logExtra = `pieces=${pieceCount} added=0 not_added=0 carts=0`;
          logServerEvent('bag', {
            status: 400,
            reason: 'store_not_allowlisted',
            pieces: pieceCount,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(
            res,
            400,
            { error: 'bad_request', problems: outcome.problems },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        if (outcome.kind === 'store_error') {
          logExtra = `pieces=${pieceCount} added=0 not_added=0 carts=0`;
          logServerEvent('bag', {
            status: 502,
            reason: 'store_unavailable',
            pieces: pieceCount,
            added: 0,
            not_added: 0,
            carts: 0,
            ...addrLog,
          });
          sendJson(res, 502, { error: 'store_unavailable' }, { 'Cache-Control': 'no-store' });
          return;
        }

        const { payload } = outcome;
        const addedCount = payload.stores.reduce((sum, s) => sum + s.added.length, 0);
        const notAddedCount = payload.stores.reduce((sum, s) => sum + s.not_added.length, 0);
        const cartsCount = payload.links.length;
        logExtra = `pieces=${pieceCount} added=${addedCount} not_added=${notAddedCount} carts=${cartsCount}`;
        logServerEvent('bag', {
          status: 200,
          pieces: pieceCount,
          added: addedCount,
          not_added: notAddedCount,
          carts: cartsCount,
          ...addrLog,
        });
        sendJson(res, 200, payload, { 'Cache-Control': 'no-store' });
        return;
      }

      // 3b. Storefront, product, search, looks, and occasions browse routes (GET only, shared 90/min limit)
      if (
        rawPathname === '/api/storefront' ||
        rawPathname === '/api/product' ||
        rawPathname === '/api/search' ||
        rawPathname === '/api/looks' ||
        rawPathname === '/api/occasions' ||
        rawPathname === '/api/occasions/match'
      ) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }

        const trustProxy = isTrustProxyEnabled(env);
        if (isProxied(req) && !trustProxy && !warnedProxiedTrustOff) {
          warnedProxiedTrustOff = true;
          console.warn(
            '[server] WARNING: proxied request received with ALICE_TRUST_PROXY off — visitors share one rate-limit bucket; set ALICE_TRUST_PROXY=1 if behind a local proxy/tunnel.',
          );
        }

        const remoteAddr = clientAddress(req, { env, remoteAddress: opts.remoteAddress });
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

        if (
          trustProxy &&
          (rawPathname === '/api/storefront' ||
            (rawPathname === '/api/looks' &&
              (parsedUrl.searchParams.get('occasion') ?? '').trim().length === 0))
        ) {
          const globalLimit = checkProxyGlobalBrowseLimit();
          if (!globalLimit.allowed) {
            sendJson(
              res,
              429,
              { error: 'slow_down' },
              { 'Retry-After': String(globalLimit.retryAfterS), 'Cache-Control': 'no-store' },
            );
            return;
          }
        }

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
          let queryOccasion: string | null = null;
          if (occasion !== null) {
            const lower = occasion.toLowerCase();
            const setsOccasions = await readLibraryOccasionsFromSets(department, env);
            const matched = setsOccasions.find(
              (entry) =>
                entry.key === lower ||
                (entry.rawKey !== undefined && entry.rawKey.toLowerCase() === lower),
            );
            if (!matched) {
              logExtra = `dept=${department} source=library n=0 unknown_occasion=true`;
              sendJson(
                res,
                200,
                { department, occasion, looks: [], source: 'library' },
                { 'Cache-Control': 'no-store' },
              );
              return;
            }
            queryOccasion = matched.rawKey ?? matched.occasion;
          }

          const effectiveLooksBudgetMs = occasion !== null ? looksBudgetMs : looksDefaultBudgetMs;
          let libraryOutfits: Outfit[] | null = null;
          let libraryAnsweredEmpty = false;
          let timedOut = false;
          try {
            const inFlightKey = `${department}|${limit}|${queryOccasion ?? ''}`;
            let looksPromise = inFlightLooks.get(inFlightKey);
            if (!looksPromise) {
              const created = (async (): Promise<Outfit[] | null> => {
                const mod = await loadLibraryFn();
                if (mod && typeof mod.libraryLooks === 'function') {
                  const fn = mod.libraryLooks as (
                    g: Gender,
                    o?: { limit?: number; occasion?: string },
                  ) => Promise<Outfit[]>;
                  const callOpts =
                    queryOccasion !== null ? { limit, occasion: queryOccasion } : { limit };
                  const resOutfits = await fn(department, callOpts);
                  if (Array.isArray(resOutfits)) {
                    return resOutfits.slice(0, limit);
                  }
                }
                return null;
              })();
              inFlightLooks.set(inFlightKey, created);
              const cleanup = (): void => {
                if (inFlightLooks.get(inFlightKey) === created) {
                  inFlightLooks.delete(inFlightKey);
                }
              };
              created.then(cleanup, cleanup);
              looksPromise = created;
            }

            const raced = await raceWithBudget(looksPromise, effectiveLooksBudgetMs);
            if (raced.timedOut) {
              timedOut = true;
            } else if (raced.value !== null) {
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
            logExtra = `dept=${department} source=library n=0${timedOut ? ' timeout=true' : libraryAnsweredEmpty ? '' : ' timeout_or_err=true'}`;
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
          logExtra = `dept=${department} source=fixture n=${fixtureLooks.length}${timedOut ? ' timeout=true' : ''}`;
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
          const modPromise = Promise.resolve()
            .then(() => loadLibraryFn())
            .catch(() => null);

          const occasionsPromise = (async (): Promise<OccasionChoice[] | null> => {
            const mod = await modPromise;
            if (mod && typeof mod.libraryOccasions === 'function') {
              const fn = mod.libraryOccasions as (g: Gender) => Promise<unknown> | unknown;
              const list = await fn(department);
              return normalizeOccasionChoices(list);
            }
            return null;
          })().catch(() => null);

          const menuPromise = (async (): Promise<OccasionMenuItem[]> => {
            const mod = await modPromise;
            if (mod && typeof mod.occasionMenu === 'function') {
              const fn = mod.occasionMenu as (g: Gender) => Promise<unknown> | unknown;
              const list = await fn(department);
              return normalizeOccasionMenu(list);
            }
            return [];
          })().catch(() => []);

          const [occasionsRaced, menuRaced] = await Promise.all([
            raceWithBudget(occasionsPromise, looksBudgetMs),
            raceWithBudget(menuPromise, looksBudgetMs),
          ]);

          const occasions =
            !occasionsRaced.timedOut && occasionsRaced.value !== null
              ? occasionsRaced.value
              : null;
          const menu = !menuRaced.timedOut ? menuRaced.value : [];

          if (occasions !== null) {
            logExtra = `dept=${department} source=library n=${occasions.length} menu=${menu.length}`;
            sendJson(
              res,
              200,
              { department, occasions, menu, source: 'library' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          const setsEntries = await readLibraryOccasionsFromSets(department, env);
          if (setsEntries.length > 0) {
            const fallbackOccasions: OccasionChoice[] = setsEntries.map(
              ({ key, occasion, label }) => ({ key, occasion, label }),
            );
            logExtra = `dept=${department} source=sets n=${fallbackOccasions.length} menu=${menu.length}`;
            sendJson(
              res,
              200,
              { department, occasions: fallbackOccasions, menu, source: 'sets' },
              { 'Cache-Control': 'no-store' },
            );
            return;
          }

          logExtra = `dept=${department} source=none n=0 menu=${menu.length}`;
          sendJson(
            res,
            200,
            { department, occasions: [], menu, source: 'none' },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }

        // GET /api/occasions/match?department=men|women&q=<text>
        if (rawPathname === '/api/occasions/match') {
          const rawDept = parsedUrl.searchParams.get('department')?.trim().toLowerCase();
          if (rawDept !== 'men' && rawDept !== 'women') {
            sendJson(res, 400, { error: 'bad_department' }, { 'Cache-Control': 'no-store' });
            return;
          }
          const department: Gender = rawDept;
          const query = (parsedUrl.searchParams.get('q') ?? '').trim().slice(0, OCCASION_MAX_LEN);
          if (query.length === 0) {
            logExtra = `dept=${department} match=none`;
            sendJson(res, 200, { match: null }, { 'Cache-Control': 'no-store' });
            return;
          }

          let match: OccasionWordMatch | null = null;
          try {
            const runMatch = async (): Promise<OccasionWordMatch | null> => {
              const mod = await loadLibraryFn();
              if (mod && typeof mod.matchOccasionWords === 'function') {
                const fn = mod.matchOccasionWords as (
                  g: Gender,
                  text: string,
                ) => Promise<unknown> | unknown;
                const found = await fn(department, query);
                return normalizeOccasionWordMatch(found);
              }
              return null;
            };
            const raced = await raceWithBudget(runMatch(), looksBudgetMs);
            if (!raced.timedOut) {
              match = raced.value;
            }
          } catch {
            match = null;
          }

          logExtra = `dept=${department} match=${match ? match.key : 'none'}`;
          sendJson(res, 200, { match }, { 'Cache-Control': 'no-store' });
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
            'Cache-Control': 'private, max-age=3600',
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
    const passcode = process.env.ALICE_PASSCODE ?? '';
    const passcodeRequired = Boolean(passcode);
    const trustProxy = isTrustProxyEnabled(process.env);
    const maxCallsPerHour = parseMaxCallsPerHour(process.env);
    const callsPerHourLabel = maxCallsPerHour !== null ? String(maxCallsPerHour) : 'none';
    const maxActiveCalls = parseMaxActiveCalls(process.env);
    const maxActiveCallsLabel = maxActiveCalls !== null ? String(maxActiveCalls) : 'none';
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    console.log(
      `[server] listening on ${scheme}://${displayHost}:${port} livekit=${livekitConfigured} passcode=${passcodeRequired} trust_proxy=${trustProxy} calls_per_hour=${callsPerHourLabel} max_active_calls=${maxActiveCallsLabel}`,
    );
    if (trustProxy && !passcodeRequired) {
      console.error(
        `[server] ERROR: ALICE_TRUST_PROXY=1 with empty ALICE_PASSCODE — every /api/token request will be refused (403 passcode_not_configured); set ALICE_PASSCODE (at least ${MIN_PROXY_PASSCODE_LEN} characters) in .env.local.`,
      );
    } else if (trustProxy && passcode.length < MIN_PROXY_PASSCODE_LEN) {
      console.error(
        `[server] ERROR: ALICE_TRUST_PROXY=1 with ALICE_PASSCODE shorter than ${MIN_PROXY_PASSCODE_LEN} characters — every /api/token request will be refused (403 passcode_too_short); the passcode must be at least ${MIN_PROXY_PASSCODE_LEN} characters behind a public link.`,
      );
    } else if (!isLoopbackHost(host) && !passcodeRequired) {
      console.warn(
        `[server] WARNING: bound to non-loopback host ${host} with empty ALICE_PASSCODE — /api/token is OPEN to the network! Set ALICE_PASSCODE in .env.local.`,
      );
    }
  });
}
