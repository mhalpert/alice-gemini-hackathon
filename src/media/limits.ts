import net from 'node:net';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MiB
export const MAX_IMAGE_REDIRECTS = 3;

const DEFAULT_MAX_IN_FLIGHT = 6;
const DEFAULT_MAX_IMAGES_TOTAL = 150;
const DEFAULT_MAX_VIDEOS_TOTAL = 12;

export class RenderCeilingError extends Error {
  readonly kind: 'image' | 'video';
  readonly limit: number;

  constructor(kind: 'image' | 'video', limit: number) {
    super(`render ceiling reached (${kind} limit ${limit})`);
    this.name = 'RenderCeilingError';
    this.kind = kind;
    this.limit = limit;
  }
}

function parseExtraHosts(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

function isIpLiteral(hostname: string): boolean {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(unbracketed) !== 0) return true;
  if (/^\d+$/.test(unbracketed)) return true;
  return false;
}

/**
 * Pure URL safety check for store product image fetches:
 * - https: only
 * - no userinfo (blocks https://cdn.shopify.com@evil.example/x.jpg)
 * - no localhost or IP-literal hosts
 * - host must be cdn.shopify.com, *.shopifycdn.com, *.myshopify.com, or in ALICE_IMAGE_HOSTS
 */
export function isAllowedImageUrl(rawUrl: string, extraHostsEnv?: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false;

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }

  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isIpLiteral(host)) return false;

  if (
    host === 'cdn.shopify.com' ||
    (host.endsWith('.shopifycdn.com') && host.length > '.shopifycdn.com'.length) ||
    (host.endsWith('.myshopify.com') && host.length > '.myshopify.com'.length)
  ) {
    return true;
  }

  const extras = parseExtraHosts(extraHostsEnv ?? process.env.ALICE_IMAGE_HOSTS);
  for (const allowed of extras) {
    if (allowed.startsWith('.')) {
      if (host.endsWith(allowed) && host.length > allowed.length) {
        return true;
      }
    } else if (host === allowed) {
      return true;
    }
  }

  return false;
}

export interface SafeFetchImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  extraHostsEnv?: string;
  fetchFn?: typeof fetch;
}

export async function safeFetchImageBuffer(
  url: string,
  opts?: SafeFetchImageOptions,
): Promise<Buffer> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const maxBytes = opts?.maxBytes ?? MAX_IMAGE_BYTES;
  const maxRedirects = opts?.maxRedirects ?? MAX_IMAGE_REDIRECTS;
  const fetchFn = opts?.fetchFn ?? fetch;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedImageUrl(currentUrl, opts?.extraHostsEnv)) {
      throw new Error(`Disallowed image URL: ${currentUrl}`);
    }

    const remMs = deadline - Date.now();
    if (remMs <= 0) {
      throw new Error(`Image fetch timed out after ${timeoutMs}ms: ${currentUrl}`);
    }

    const res = await fetchFn(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(remMs),
    });

    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel?.().catch(() => {});
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (${maxRedirects}) fetching ${url}`);
      }
      const loc = res.headers.get('location');
      if (!loc) {
        throw new Error(`Redirect (${res.status}) missing Location header for ${currentUrl}`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(loc, currentUrl).toString();
      } catch {
        throw new Error(`Invalid redirect Location "${loc}" for ${currentUrl}`);
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!res.ok) {
      void res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status} fetching ${currentUrl}`);
    }

    const ct = (res.headers.get('content-type') || '').trim().toLowerCase();
    if (!ct.startsWith('image/')) {
      void res.body?.cancel?.().catch(() => {});
      throw new Error(`Non-image content-type "${ct}" for ${currentUrl}`);
    }

    const clRaw = res.headers.get('content-length');
    if (clRaw !== null && clRaw.trim() !== '') {
      const cl = Number(clRaw);
      if (Number.isFinite(cl) && cl > maxBytes) {
        void res.body?.cancel?.().catch(() => {});
        throw new Error(`Image Content-Length ${cl} exceeds ${maxBytes} bytes for ${currentUrl}`);
      }
    }

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Image body exceeded ${maxBytes} bytes for ${currentUrl}`);
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      if (total === 0) {
        throw new Error(`Empty response for ${currentUrl}`);
      }
      return Buffer.concat(chunks, total);
    }

    const arr = await res.arrayBuffer();
    if (arr.byteLength === 0) {
      throw new Error(`Empty response for ${currentUrl}`);
    }
    if (arr.byteLength > maxBytes) {
      throw new Error(`Image body ${arr.byteLength} exceeds ${maxBytes} bytes for ${currentUrl}`);
    }
    return Buffer.from(arr);
  }

  throw new Error(`Too many redirects fetching ${url}`);
}

// ---------------------------------------------------------------------------
// In-process paid render semaphore + per-child lifetime ceilings
// ---------------------------------------------------------------------------

export type RenderKind = 'image' | 'video';

export interface RenderLimiterOptions {
  maxInFlight?: number;
  maxImagesTotal?: number;
  maxVideosTotal?: number;
  onCeilingReached?: (kind: RenderKind, count: number, limit: number) => void;
}

export interface RenderLimiterStats {
  inFlight: number;
  queued: number;
  imagesTotal: number;
  videosTotal: number;
  maxInFlight: number;
  maxImagesTotal: number;
  maxVideosTotal: number;
}

export interface RenderLimiter {
  run<T>(kind: RenderKind, fn: () => Promise<T>): Promise<T>;
  stats(): RenderLimiterStats;
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function createRenderLimiter(opts?: RenderLimiterOptions): RenderLimiter {
  const maxInFlight = opts?.maxInFlight ?? positiveIntEnv('ALICE_MEDIA_MAX_RENDERS', DEFAULT_MAX_IN_FLIGHT);
  const maxImagesTotal =
    opts?.maxImagesTotal ?? positiveIntEnv('ALICE_MEDIA_MAX_RENDERS_TOTAL', DEFAULT_MAX_IMAGES_TOTAL);
  const maxVideosTotal =
    opts?.maxVideosTotal ?? positiveIntEnv('ALICE_MEDIA_MAX_VIDEOS_TOTAL', DEFAULT_MAX_VIDEOS_TOTAL);
  const onCeiling =
    opts?.onCeilingReached ??
    ((kind: RenderKind, count: number, limit: number) => {
      console.error(`[media] render ceiling reached (${kind}: ${count}/${limit})`);
    });

  let inFlight = 0;
  let imagesTotal = 0;
  let videosTotal = 0;
  const ceilingLogged: Record<RenderKind, boolean> = { image: false, video: false };
  const queue: Array<() => void> = [];

  async function run<T>(kind: RenderKind, fn: () => Promise<T>): Promise<T> {
    if (kind === 'image') {
      if (imagesTotal >= maxImagesTotal) {
        if (!ceilingLogged.image) {
          ceilingLogged.image = true;
          onCeiling('image', imagesTotal, maxImagesTotal);
        }
        throw new RenderCeilingError('image', maxImagesTotal);
      }
      imagesTotal += 1;
    } else {
      if (videosTotal >= maxVideosTotal) {
        if (!ceilingLogged.video) {
          ceilingLogged.video = true;
          onCeiling('video', videosTotal, maxVideosTotal);
        }
        throw new RenderCeilingError('video', maxVideosTotal);
      }
      videosTotal += 1;
    }

    if (inFlight < maxInFlight) {
      inFlight += 1;
    } else {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        inFlight -= 1;
      }
    }
  }

  function stats(): RenderLimiterStats {
    return {
      inFlight,
      queued: queue.length,
      imagesTotal,
      videosTotal,
      maxInFlight,
      maxImagesTotal,
      maxVideosTotal,
    };
  }

  return { run, stats };
}

let defaultLimiter: RenderLimiter | null = null;

export function getRenderLimiter(): RenderLimiter {
  if (!defaultLimiter) {
    defaultLimiter = createRenderLimiter();
  }
  return defaultLimiter;
}
