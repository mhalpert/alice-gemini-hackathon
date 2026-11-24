// "Sign in with Shop" for shopper accounts: a second way in, next to email and password.
//
// It runs Shop's OAuth device flow on the web server. The shopper opens a link on Shop's
// own site and approves; Shop then tells us who they are in a signed ID token. We keep
// only that identity (Shop's subject id, the email address, a first name). The access
// token Shop sends along is never stored, logged or used: the purchase flow in a call
// has its own sign-in (src/store/auth.ts) and does not share anything with this file.
//
// This uses Shop's public prototype client (shop.dev/docs/authentication). Shop's docs
// say an app that is distributed needs its own registered client, so this stays behind
// ALICE_ACCOUNTS_SHOP and is off by default.
import crypto from 'node:crypto';
import { cleanName, cleanText } from './memory.ts';

export const SHOP_ISSUER = 'https://accounts.shop.app';
export const SHOP_SIGNIN_DEVICE_ENDPOINT = 'https://accounts.shop.app/oauth/device';
export const SHOP_SIGNIN_TOKEN_ENDPOINT = 'https://accounts.shop.app/oauth/token';
export const SHOP_SIGNIN_JWKS_URI = 'https://accounts.shop.app/auth/jwks';
export const SHOP_SIGNIN_CLIENT_ID = '5c733ab2-1903-400a-891e-7ba20c09e2a3';
export const SHOP_SIGNIN_RESOURCE = 'https://mcp.shop.com';
export const SHOP_SIGNIN_SCOPE = 'openid email personal_agent';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
const DEFAULT_EXPIRES_S = 600;
const MAX_EXPIRES_S = 900;
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 8192;

export interface ShopIdentity {
  /** Shop's stable id for this shopper. The account is keyed on it. */
  sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
}

export type ShopStartResult =
  | { ok: true; flow_id: string; url: string; code: string | null; expires_in_s: number; interval_s: number }
  | { ok: false; reason: 'busy' | 'unavailable' };

export type ShopPollResult =
  | { status: 'pending'; interval_s: number }
  | { status: 'signed_in'; identity: ShopIdentity }
  | { status: 'denied' | 'expired' | 'unknown_flow' | 'failed' };

export interface ShopSignInOptions {
  fetch?: typeof fetch;
  now?: () => number;
  deviceEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  issuer?: string;
  clientId?: string;
  deviceName?: string;
  /** Sign-ins that may be waiting for approval at once. */
  maxPending?: number;
  log?: (ev: string, data?: Record<string, unknown>) => void;
}

export interface ShopSignIn {
  start(): Promise<ShopStartResult>;
  poll(flowId: unknown): Promise<ShopPollResult>;
  cancel(flowId: unknown): void;
  pendingCount(): number;
}

interface Flow {
  deviceCode: string;
  expiresAtMs: number;
  intervalS: number;
  nextPollAtMs: number;
  inFlight: Promise<ShopPollResult> | null;
}

export function isShopSignInEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.ALICE_ACCOUNTS_SHOP?.trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

/** The link we hand the shopper must be Shop's own HTTPS page, whatever the response says. */
export function isShopVerificationUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (host === 'shop.app' || host.endsWith('.shop.app') || host === 'shop.com' || host.endsWith('.shop.com'))
    );
  } catch {
    return false;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createShopSignIn(options: ShopSignInOptions = {}): ShopSignIn {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const deviceEndpoint = options.deviceEndpoint ?? SHOP_SIGNIN_DEVICE_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? SHOP_SIGNIN_TOKEN_ENDPOINT;
  const jwksUri = options.jwksUri ?? SHOP_SIGNIN_JWKS_URI;
  const issuer = options.issuer ?? SHOP_ISSUER;
  const clientId = options.clientId ?? SHOP_SIGNIN_CLIENT_ID;
  const deviceName = cleanText(options.deviceName ?? 'Alice sign-in', 64) || 'Alice sign-in';
  const maxPending = Math.max(1, options.maxPending ?? 100);
  const log = options.log ?? (() => {});

  const flows = new Map<string, Flow>();
  let jwks: { fetchedAtMs: number; keys: Record<string, unknown>[] } | null = null;

  function prune(): void {
    const t = now();
    for (const [id, flow] of flows) {
      if (flow.expiresAtMs <= t) flows.delete(id);
    }
  }

  async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> | null }> {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let data: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  async function loadKeys(force: boolean): Promise<Record<string, unknown>[]> {
    if (!force && jwks && now() - jwks.fetchedAtMs < JWKS_TTL_MS) return jwks.keys;
    const res = await fetchFn(jwksUri, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`key set request failed (HTTP ${res.status})`);
    const body = (await res.json()) as { keys?: unknown };
    const keys = Array.isArray(body?.keys)
      ? body.keys.filter((k): k is Record<string, unknown> => Boolean(k) && typeof k === 'object')
      : [];
    jwks = { fetchedAtMs: now(), keys };
    return keys;
  }

  /** Checks the ID token's signature and claims. Returns who it is, or null. */
  async function identityFromIdToken(idToken: unknown): Promise<ShopIdentity | null> {
    if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH) return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const header = decodeSegment(parts[0]!);
    const claims = decodeSegment(parts[1]!);
    if (!header || !claims) return null;
    // Only the algorithm Shop publishes. In particular never "none", never a shared-secret one.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;

    const pick = (keys: Record<string, unknown>[]) =>
      keys.find((k) => k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'));
    let jwk = pick(await loadKeys(false));
    if (!jwk) jwk = pick(await loadKeys(true)); // Shop may have rotated its keys
    if (!jwk) return null;

    let verified = false;
    try {
      const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
        key,
        Buffer.from(parts[2]!, 'base64url'),
      );
    } catch {
      verified = false;
    }
    if (!verified) return null;

    const nowS = Math.floor(now() / 1000);
    const audience = claims.aud;
    const audienceOk = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
    if (claims.iss !== issuer || !audienceOk) return null;
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) return null;
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) return null;
    const sub = typeof claims.sub === 'string' ? claims.sub.trim() : typeof claims.sub === 'number' ? String(claims.sub) : '';
    if (!sub || sub.length > 255) return null;

    const email = typeof claims.email === 'string' ? cleanText(claims.email, 254).toLowerCase() : '';
    return {
      sub,
      email: email.includes('@') ? email : null,
      email_verified: claims.email_verified === true,
      name: cleanName(claims.given_name),
    };
  }

  async function start(): Promise<ShopStartResult> {
    prune();
    if (flows.size >= maxPending) return { ok: false, reason: 'busy' };
    try {
      const { status, data } = await postForm(deviceEndpoint, {
        client_id: clientId,
        resource: SHOP_SIGNIN_RESOURCE,
        scope: SHOP_SIGNIN_SCOPE,
        device_name: deviceName,
      });
      const deviceCode = typeof data?.device_code === 'string' ? data.device_code : '';
      const url = [data?.verification_uri_complete, data?.verification_uri].find(isShopVerificationUrl);
      if (status < 200 || status >= 300 || !deviceCode || !url) {
        log('shop_signin', { step: 'start', ok: false, http: status });
        return { ok: false, reason: 'unavailable' };
      }
      const expiresS = clampInt(data?.expires_in, DEFAULT_EXPIRES_S, 30, MAX_EXPIRES_S);
      const intervalS = clampInt(data?.interval, DEFAULT_INTERVAL_S, 1, MAX_INTERVAL_S);
      const userCode = typeof data?.user_code === 'string' ? cleanText(data.user_code, 32) : '';
      const flowId = crypto.randomBytes(32).toString('base64url');
      flows.set(flowId, {
        deviceCode,
        expiresAtMs: now() + expiresS * 1000,
        intervalS,
        nextPollAtMs: now() + intervalS * 1000,
        inFlight: null,
      });
      log('shop_signin', { step: 'start', ok: true });
      return { ok: true, flow_id: flowId, url, code: userCode || null, expires_in_s: expiresS, interval_s: intervalS };
    } catch (err) {
      log('shop_signin', { step: 'start', ok: false, error: (err as Error)?.name ?? 'error' });
      return { ok: false, reason: 'unavailable' };
    }
  }

  async function askShop(flowId: string, flow: Flow): Promise<ShopPollResult> {
    try {
      const { data } = await postForm(tokenEndpoint, {
        grant_type: DEVICE_GRANT,
        client_id: clientId,
        device_code: flow.deviceCode,
      });
      const error = typeof data?.error === 'string' ? data.error : '';
      if (error === 'authorization_pending') {
        flow.nextPollAtMs = now() + flow.intervalS * 1000;
        return { status: 'pending', interval_s: flow.intervalS };
      }
      if (error === 'slow_down') {
        flow.intervalS = Math.min(MAX_INTERVAL_S, flow.intervalS + 5);
        flow.nextPollAtMs = now() + flow.intervalS * 1000;
        return { status: 'pending', interval_s: flow.intervalS };
      }
      // Anything else ends this sign-in, one way or another.
      flows.delete(flowId);
      if (error === 'access_denied') {
        log('shop_signin', { step: 'poll', result: 'denied' });
        return { status: 'denied' };
      }
      if (error === 'expired_token') return { status: 'expired' };
      const identity = data && !error ? await identityFromIdToken(data.id_token) : null;
      if (!identity) {
        log('shop_signin', { step: 'poll', result: 'failed', had_id_token: typeof data?.id_token === 'string' });
        return { status: 'failed' };
      }
      log('shop_signin', { step: 'poll', result: 'signed_in' });
      return { status: 'signed_in', identity };
    } catch (err) {
      // A network hiccup: the sign-in is still alive, try again on the next poll.
      log('shop_signin', { step: 'poll', result: 'error', error: (err as Error)?.name ?? 'error' });
      if (!flows.has(flowId)) return { status: 'failed' };
      flow.nextPollAtMs = now() + flow.intervalS * 1000;
      return { status: 'pending', interval_s: flow.intervalS };
    }
  }

  async function poll(flowId: unknown): Promise<ShopPollResult> {
    if (typeof flowId !== 'string' || !flowId) return { status: 'unknown_flow' };
    const flow = flows.get(flowId);
    if (!flow) return { status: 'unknown_flow' };
    if (flow.expiresAtMs <= now()) {
      flows.delete(flowId);
      return { status: 'expired' };
    }
    // Two polls at once (two tabs, a double click) share one request to Shop.
    if (flow.inFlight) return flow.inFlight;
    // Never ask Shop sooner than it told us to, however often the page asks us.
    if (now() < flow.nextPollAtMs) return { status: 'pending', interval_s: flow.intervalS };
    flow.inFlight = askShop(flowId, flow).finally(() => {
      flow.inFlight = null;
    });
    return flow.inFlight;
  }

  function cancel(flowId: unknown): void {
    if (typeof flowId === 'string') flows.delete(flowId);
  }

  return {
    start,
    poll,
    cancel,
    pendingCount: () => {
      prune();
      return flows.size;
    },
  };
}
