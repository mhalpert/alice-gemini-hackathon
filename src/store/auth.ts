import { getCallRoom, logEvent, onCallRoomChange } from './log.ts';

export type SignInState = 'none' | 'pending' | 'signed_in' | 'expired' | 'denied';

export interface StartSignInResult {
  url: string;
  code?: string;
  expires_in_s: number;
  error?: string;
}

export interface AuthManagerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  deviceEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  deviceName?: string;
  mcpUrl?: () => string;
  isPurchaseEnabled?: () => boolean;
  getRoom?: () => string | null;
  subscribeRoomChange?: boolean;
}

export interface AuthManager {
  startSignIn(): Promise<StartSignInResult>;
  signInStatus(): SignInState;
  signOut(): void;
  getToken(): string | null;
  getSignedInRoom(): string | null;
  invalidateToken(reason?: 'expired' | 'invalid'): void;
  onSignOut(listener: () => void): () => void;
  getSecretsForRedaction(): string[];
}

export const SHOP_DEVICE_ENDPOINT = 'https://accounts.shop.app/oauth/device';
export const SHOP_TOKEN_ENDPOINT = 'https://accounts.shop.app/oauth/token';
export const SHOP_PUBLIC_CLIENT_ID = '5c733ab2-1903-400a-891e-7ba20c09e2a3';
export const SHOP_OAUTH_SCOPE = 'openid email personal_agent';
export const SHOP_OAUTH_RESOURCE = 'https://mcp.shop.com';
export const SHOP_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEFAULT_DEVICE_NAME = 'Alice Stylist';
const DEFAULT_MCP_URL = 'https://mcp.shop.com/';
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_DEVICE_EXPIRES_S = 600;
const DEFAULT_TOKEN_EXPIRES_S = 3600;
const OAUTH_HTTP_TIMEOUT_MS = 15_000;

export function isAllowedAuthTargetUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'mcp.shop.com';
  } catch {
    return false;
  }
}

export function redactSecrets(
  text: string,
  extraSecrets?: readonly (string | null | undefined)[],
): string {
  if (!text) return text;
  let out = text;

  if (extraSecrets) {
    for (const secret of extraSecrets) {
      if (typeof secret === 'string' && secret.length > 0) {
        out = out.split(secret).join('[REDACTED]');
      }
    }
  }

  // Authorization / Bearer tokens
  out = out.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',;}\]]+/gi, '$1[REDACTED]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{6,}=*/gi, '$1[REDACTED]');
  // JWT-shaped tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]');
  // Sensitive JSON / query fields
  out = out.replace(
    /("(?:access_token|refresh_token|device_code|id_token)"\s*:\s*")[^"]+(")/gi,
    '$1[REDACTED]$2',
  );
  out = out.replace(
    /(\b(?:access_token|refresh_token|device_code|id_token)=)[^&\s"']+/gi,
    '$1[REDACTED]',
  );

  return out;
}

export function createAuthManager(opts?: AuthManagerOptions): AuthManager {
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const now = opts?.now ?? (() => Date.now());
  const scheduleFn =
    opts?.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
      return t;
    });
  const clearScheduleFn =
    opts?.clearSchedule ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const deviceEndpoint = opts?.deviceEndpoint ?? SHOP_DEVICE_ENDPOINT;
  const tokenEndpoint = opts?.tokenEndpoint ?? SHOP_TOKEN_ENDPOINT;
  const clientId = opts?.clientId ?? SHOP_PUBLIC_CLIENT_ID;
  const deviceName = (opts?.deviceName ?? DEFAULT_DEVICE_NAME).slice(0, 64);
  const getMcpUrl = opts?.mcpUrl ?? (() => process.env.SHOP_MCP_URL || DEFAULT_MCP_URL);
  const purchaseOn = opts?.isPurchaseEnabled ?? (() => process.env.ALICE_PURCHASE === 'on');
  const getRoom = opts?.getRoom ?? getCallRoom;

  // Credentials live ONLY in this closure (process memory). Never persisted, returned, or logged.
  let accessToken: string | null = null;
  let tokenExpiresAtMs = 0;
  let activeDeviceCode: string | null = null;
  let boundRoom: string | null = null;
  let state: SignInState = 'none';
  let pollGen = 0;
  let pending: {
    url: string;
    code?: string;
    expiresAtMs: number;
    intervalS: number;
    timer: unknown;
  } | null = null;
  const signOutListeners = new Set<() => void>();

  function emitSignInStatus(next: SignInState): void {
    state = next;
    logEvent('order_sign_in', { status: next });
  }

  function notifySignOut(): void {
    for (const listener of signOutListeners) {
      try {
        listener();
      } catch {
        // never throw
      }
    }
  }

  function clearPendingTimer(): void {
    if (pending?.timer !== undefined && pending.timer !== null) {
      clearScheduleFn(pending.timer);
      pending.timer = null;
    }
  }

  function clearPending(): void {
    pollGen += 1;
    clearPendingTimer();
    pending = null;
    activeDeviceCode = null;
  }

  function checkExpiry(): void {
    const current = now();
    if (accessToken !== null && current >= tokenExpiresAtMs) {
      accessToken = null;
      tokenExpiresAtMs = 0;
      boundRoom = null;
      if (state === 'signed_in') {
        emitSignInStatus('expired');
      }
    }
    if (pending !== null && current >= pending.expiresAtMs) {
      clearPending();
      boundRoom = null;
      if (state === 'pending') {
        emitSignInStatus('expired');
      }
    }
  }

  function getToken(): string | null {
    checkExpiry();
    return accessToken;
  }

  function getSignedInRoom(): string | null {
    checkExpiry();
    return boundRoom;
  }

  function invalidateToken(reason: 'expired' | 'invalid' = 'invalid'): void {
    accessToken = null;
    tokenExpiresAtMs = 0;
    boundRoom = null;
    if (state === 'signed_in') {
      emitSignInStatus(reason === 'expired' ? 'expired' : 'none');
    }
  }

  function signInStatus(): SignInState {
    checkExpiry();
    return state;
  }

  function signOut(): void {
    clearPending();
    accessToken = null;
    tokenExpiresAtMs = 0;
    boundRoom = null;
    emitSignInStatus('none');
    notifySignOut();
  }

  function onSignOut(listener: () => void): () => void {
    signOutListeners.add(listener);
    return () => {
      signOutListeners.delete(listener);
    };
  }

  function getSecretsForRedaction(): string[] {
    const list: string[] = [];
    if (accessToken) list.push(accessToken);
    if (activeDeviceCode) list.push(activeDeviceCode);
    return list;
  }

  function scheduleNextPoll(gen: number): void {
    if (gen !== pollGen || !pending || !activeDeviceCode) return;
    const remainingMs = pending.expiresAtMs - now();
    if (remainingMs <= 0) {
      clearPending();
      boundRoom = null;
      if (state === 'pending') {
        emitSignInStatus('expired');
      }
      return;
    }
    const waitMs = Math.max(1, Math.min(pending.intervalS * 1000, remainingMs));
    pending.timer = scheduleFn(() => {
      void pollOnce(gen);
    }, waitMs);
  }

  async function pollOnce(gen: number): Promise<void> {
    if (gen !== pollGen || !pending || !activeDeviceCode) return;
    if (now() >= pending.expiresAtMs) {
      clearPending();
      boundRoom = null;
      if (state === 'pending') {
        emitSignInStatus('expired');
      }
      return;
    }

    const deviceCode = activeDeviceCode;
    try {
      // Per authentication.md: do NOT send `resource` again on the token endpoint.
      const form = new URLSearchParams({
        grant_type: SHOP_DEVICE_GRANT_TYPE,
        client_id: clientId,
        device_code: deviceCode,
      });

      const res = await fetchFn(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
      });

      if (gen !== pollGen) return;

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (typeof data?.access_token === 'string' && data.access_token.length > 0) {
        const expiresInS = Number(data.expires_in);
        const ttlS =
          Number.isFinite(expiresInS) && expiresInS > 0 ? expiresInS : DEFAULT_TOKEN_EXPIRES_S;
        accessToken = data.access_token;
        tokenExpiresAtMs = now() + Math.round(ttlS * 1000);
        clearPending();
        emitSignInStatus('signed_in');
        return;
      }

      const errCode = typeof data?.error === 'string' ? data.error : '';
      if (errCode === 'authorization_pending') {
        scheduleNextPoll(gen);
        return;
      }
      if (errCode === 'slow_down') {
        if (pending) pending.intervalS += 5;
        scheduleNextPoll(gen);
        return;
      }
      if (errCode === 'access_denied') {
        clearPending();
        boundRoom = null;
        emitSignInStatus('denied');
        return;
      }
      if (errCode === 'expired_token') {
        clearPending();
        boundRoom = null;
        emitSignInStatus('expired');
        return;
      }

      if (res.status >= 500) {
        scheduleNextPoll(gen);
        return;
      }

      clearPending();
      boundRoom = null;
      emitSignInStatus('denied');
    } catch {
      if (gen !== pollGen) return;
      // Transient network error: retry on next interval until expiry
      scheduleNextPoll(gen);
    }
  }

  async function startSignIn(): Promise<StartSignInResult> {
    checkExpiry();

    if (!purchaseOn()) {
      return {
        url: '',
        expires_in_s: 0,
        error: 'Refused to sign in: ALICE_PURCHASE is not on',
      };
    }

    if (!isAllowedAuthTargetUrl(getMcpUrl())) {
      return {
        url: '',
        expires_in_s: 0,
        error: 'Refused to sign in: SHOP_MCP_URL must point to https://mcp.shop.com/',
      };
    }

    const currentRoom = getRoom();
    if (state === 'pending' && pending && boundRoom === currentRoom) {
      const remainingS = Math.max(1, Math.ceil((pending.expiresAtMs - now()) / 1000));
      return {
        url: pending.url,
        ...(pending.code ? { code: pending.code } : {}),
        expires_in_s: remainingS,
      };
    }

    clearPending();

    try {
      const form = new URLSearchParams({
        client_id: clientId,
        resource: SHOP_OAUTH_RESOURCE,
        scope: SHOP_OAUTH_SCOPE,
        device_name: deviceName,
      });

      const res = await fetchFn(deviceEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
      });

      if (!res.ok) {
        return {
          url: '',
          expires_in_s: 0,
          error: `Device sign-in request failed (HTTP ${res.status})`,
        };
      }

      const data = (await res.json()) as {
        verification_uri_complete?: string;
        verification_uri?: string;
        user_code?: string;
        device_code?: string;
        expires_in?: number | string;
        interval?: number | string;
      };

      const url =
        (typeof data?.verification_uri_complete === 'string' &&
          data.verification_uri_complete.trim()) ||
        (typeof data?.verification_uri === 'string' && data.verification_uri.trim()) ||
        '';
      const code =
        typeof data?.user_code === 'string' && data.user_code.trim()
          ? data.user_code.trim()
          : undefined;
      const deviceCode =
        typeof data?.device_code === 'string' && data.device_code.trim()
          ? data.device_code.trim()
          : '';

      if (!url || !deviceCode) {
        return {
          url: '',
          expires_in_s: 0,
          error: 'Device sign-in response missing verification URL or device code',
        };
      }

      const rawExpires = Number(data?.expires_in);
      const expiresInS =
        Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : DEFAULT_DEVICE_EXPIRES_S;
      const rawInterval = Number(data?.interval);
      const intervalS =
        Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_POLL_INTERVAL_S;

      activeDeviceCode = deviceCode;
      boundRoom = currentRoom;
      const gen = ++pollGen;
      pending = {
        url,
        ...(code ? { code } : {}),
        expiresAtMs: now() + Math.round(expiresInS * 1000),
        intervalS,
        timer: null,
      };

      emitSignInStatus('pending');
      scheduleNextPoll(gen);

      return {
        url,
        ...(code ? { code } : {}),
        expires_in_s: Math.round(expiresInS),
      };
    } catch (err) {
      const msg = redactSecrets(
        err instanceof Error ? err.message : String(err),
        getSecretsForRedaction(),
      );
      return {
        url: '',
        expires_in_s: 0,
        error: `Device sign-in failed: ${msg}`,
      };
    }
  }

  if (opts?.subscribeRoomChange !== false) {
    onCallRoomChange((newRoom) => {
      if ((state === 'signed_in' || state === 'pending') && newRoom !== boundRoom) {
        signOut();
      }
    });
  }

  return {
    startSignIn,
    signInStatus,
    signOut,
    getToken,
    getSignedInRoom,
    invalidateToken,
    onSignOut,
    getSecretsForRedaction,
  };
}

export const defaultAuth: AuthManager = createAuthManager();

export const startSignIn = defaultAuth.startSignIn;
export const signInStatus = defaultAuth.signInStatus;
export const signOut = defaultAuth.signOut;
