import { logEvent } from './log.ts';
import { defaultAuth, isAllowedAuthTargetUrl, redactSecrets } from './auth.ts';
import { COMPLETE_CHECKOUT_GUARD } from './purchase-guard.ts';

export class ShopMcpError extends Error {
  code: string;
  status?: number;
  retryAfterMs?: number;
  upstreamCode?: string;
  continueUrl?: string;

  constructor(
    code: string,
    message: string,
    opts?: {
      status?: number;
      retryAfterMs?: number;
      upstreamCode?: string;
      continueUrl?: string;
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ShopMcpError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts?.upstreamCode !== undefined) this.upstreamCode = opts.upstreamCode;
    if (opts?.continueUrl !== undefined) this.continueUrl = opts.continueUrl;
  }
}

export interface ShopMcpOptions {
  url?: string;
  fetch?: typeof fetch;
  maxInFlight?: number;
  timeoutMs?: number;
  now?: () => number;
  isPurchaseEnabled?: () => boolean;
  getAuthToken?: () => string | null;
  onInvalidToken?: () => void;
  getSecretsForRedaction?: () => string[];
}

export interface ShopMcpCallOptions {
  timeoutMs?: number;
  authenticated?: boolean;
  [COMPLETE_CHECKOUT_GUARD]?: boolean;
}

export interface ShopMcpClient {
  call(tool: string, args: Record<string, unknown>, o?: ShopMcpCallOptions): Promise<any>;
  blockedUntil(): number;
}

export function isPurchaseEnabled(): boolean {
  return process.env.ALICE_PURCHASE === 'on';
}

const BASE_ALLOWED_TOOLS = new Set([
  'search_catalog',
  'lookup_catalog',
  'get_product',
  'create_cart',
  'get_cart',
  'update_cart',
]);

const PURCHASE_ALLOWED_TOOLS = new Set([
  'get_account',
  'create_checkout',
  'update_checkout',
  'get_checkout',
  'complete_checkout',
]);

const ALWAYS_DENIED_TOOLS = new Set([
  'complete_spend_request',
  'create_spend_request',
  'get_spend_request',
  'update_spend_request',
  'cancel_spend_request',
]);

const DENIED_TOOL_RE = /checkout|spend|payment|pay|order/i;

const PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_URL = 'https://mcp.shop.com/';
const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_RETRY_AFTER_MS = 2000;

function parseRetryAfterMs(headerValue: string | null, nowMs: number): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = headerValue.trim();
  if (!trimmed) return DEFAULT_RETRY_AFTER_MS;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }

  return DEFAULT_RETRY_AFTER_MS;
}

function parseSseLastData(rawText: string): string {
  const lines = rawText.split(/\r?\n/);
  let lastData: string | null = null;
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        lastData = payload;
      }
    }
  }
  if (lastData === null) {
    throw new ShopMcpError('parse', 'No data line in SSE response');
  }
  return lastData;
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function hasImageArg(args: Record<string, unknown>): boolean {
  const catalog = args?.catalog as { like?: unknown } | undefined;
  const like = catalog?.like;
  if (!Array.isArray(like)) return false;
  return like.some(
    (entry) => Boolean(entry && typeof entry === 'object' && (entry as { image?: unknown }).image),
  );
}

function extractImageDataSecrets(args: Record<string, unknown>): string[] {
  const catalog = args?.catalog as { like?: unknown } | undefined;
  const like = catalog?.like;
  if (!Array.isArray(like)) return [];
  const out: string[] = [];
  for (const entry of like) {
    const data = (entry as { image?: { data?: unknown } } | null)?.image?.data;
    if (typeof data === 'string' && data.length > 0) {
      out.push(data);
    }
  }
  return out;
}

export function createShopMcp(opts?: ShopMcpOptions): ShopMcpClient {
  const getTargetUrl = () => opts?.url || process.env.SHOP_MCP_URL || DEFAULT_URL;
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const maxInFlight = Math.max(1, opts?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts?.now ?? (() => Date.now());
  const purchaseOn = opts?.isPurchaseEnabled ?? isPurchaseEnabled;
  const getAuthToken = opts?.getAuthToken ?? (() => defaultAuth.getToken());
  const onInvalidToken = opts?.onInvalidToken ?? (() => defaultAuth.invalidateToken('invalid'));
  const getSecrets = opts?.getSecretsForRedaction ?? (() => defaultAuth.getSecretsForRedaction());

  let nextId = 1;
  let blockedUntilMs = 0;
  let inFlight = 0;
  const waiters: (() => void)[] = [];

  function sanitize(msg: string, extraSecrets?: readonly string[]): string {
    const secrets = extraSecrets?.length ? [...getSecrets(), ...extraSecrets] : getSecrets();
    return redactSecrets(msg, secrets);
  }

  function acquire(): Promise<void> {
    if (inFlight < maxInFlight) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      inFlight -= 1;
    }
  }

  function assertNotRateLimited(): void {
    const current = now();
    if (current < blockedUntilMs) {
      const remaining = blockedUntilMs - current;
      throw new ShopMcpError('rate_limited', `Shop MCP rate limited for ${remaining}ms`, {
        status: 429,
        retryAfterMs: remaining,
      });
    }
  }

  function assertToolAllowed(tool: string, o?: ShopMcpCallOptions): void {
    if (typeof tool !== 'string' || ALWAYS_DENIED_TOOLS.has(tool)) {
      throw new ShopMcpError('denied', `Tool "${String(tool)}" is denied`);
    }

    if (BASE_ALLOWED_TOOLS.has(tool)) {
      return;
    }

    if (PURCHASE_ALLOWED_TOOLS.has(tool)) {
      if (!purchaseOn()) {
        throw new ShopMcpError('denied', `Tool "${tool}" is denied (ALICE_PURCHASE is not on)`);
      }
      if (tool === 'complete_checkout' && o?.[COMPLETE_CHECKOUT_GUARD] !== true) {
        throw new ShopMcpError(
          'denied',
          'Tool "complete_checkout" may only be called from placeOrder',
        );
      }
      return;
    }

    if (DENIED_TOOL_RE.test(tool)) {
      throw new ShopMcpError('denied', `Tool "${tool}" is denied`);
    }

    throw new ShopMcpError('denied', `Tool "${tool}" is denied`);
  }

  async function callInner(
    tool: string,
    args: Record<string, unknown>,
    o?: ShopMcpCallOptions,
    argSecrets: readonly string[] = [],
  ): Promise<any> {
    assertToolAllowed(tool, o);

    const url = getTargetUrl();
    const wantsAuth = o?.authenticated === true || PURCHASE_ALLOWED_TOOLS.has(tool);
    let authHeader: string | null = null;

    if (wantsAuth) {
      const token = getAuthToken();
      if (token) {
        if (!isAllowedAuthTargetUrl(url)) {
          throw new ShopMcpError(
            'denied',
            'Refused to send Authorization header to a non-mcp.shop.com host',
          );
        }
        authHeader = `Bearer ${token}`;
      } else if (tool === 'get_account') {
        throw new ShopMcpError('auth', 'Sign-in required for get_account', { status: 401 });
      }
    }

    assertNotRateLimited();

    await acquire();
    try {
      assertNotRateLimited();

      const id = nextId++;
      const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'alice', version: '0.1.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': tool,
      };
      // Final structural check: NEVER attach Authorization to any host other than https://mcp.shop.com
      const hasAuthHeader = Boolean(authHeader && isAllowedAuthTargetUrl(url));
      if (hasAuthHeader && authHeader) {
        headers.Authorization = authHeader;
      }
      const refuseRedirects = hasAuthHeader || hasImageArg(args);

      let res: Response;
      let rawText: string;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers,
          body,
          ...(refuseRedirects ? { redirect: 'error' as const } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 401) {
          if (hasAuthHeader) {
            onInvalidToken();
            throw new ShopMcpError('auth', 'Shop MCP authentication required (HTTP 401)', {
              status: 401,
            });
          }
          throw new ShopMcpError('http', 'Shop MCP HTTP 401', { status: 401 });
        }

        if (res.status === 403) {
          const wwwAuth = res.headers.get('www-authenticate') ?? '';
          if (hasAuthHeader && /insufficient_scope/i.test(wwwAuth)) {
            onInvalidToken();
            throw new ShopMcpError('auth', 'Shop MCP insufficient scope (HTTP 403)', {
              status: 403,
            });
          }
          throw new ShopMcpError('http', 'Shop MCP HTTP 403', { status: 403 });
        }

        if (res.status === 429) {
          const current = now();
          const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), current);
          blockedUntilMs = Math.max(blockedUntilMs, current + retryAfterMs);
          throw new ShopMcpError(
            'rate_limited',
            `Shop MCP HTTP 429; retry after ${retryAfterMs}ms`,
            { status: 429, retryAfterMs },
          );
        }

        if (res.status !== 200) {
          throw new ShopMcpError('http', `Shop MCP HTTP ${res.status}`, { status: res.status });
        }

        rawText = await res.text();
      } catch (err) {
        if (err instanceof ShopMcpError) throw err;
        if (isTimeoutError(err)) {
          throw new ShopMcpError('timeout', `Shop MCP ${tool} timed out after ${timeoutMs}ms`);
        }
        throw new ShopMcpError(
          'network',
          sanitize(err instanceof Error ? err.message : String(err), argSecrets),
        );
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      let payload: any;
      try {
        const jsonText = contentType.includes('text/event-stream')
          ? parseSseLastData(rawText)
          : rawText;
        payload = JSON.parse(jsonText);
      } catch (err) {
        if (err instanceof ShopMcpError) throw err;
        throw new ShopMcpError(
          'parse',
          sanitize(
            `Invalid JSON from Shop MCP: ${err instanceof Error ? err.message : String(err)}`,
            argSecrets,
          ),
        );
      }

      if (payload?.error) {
        const msg =
          typeof payload.error.message === 'string'
            ? payload.error.message
            : JSON.stringify(payload.error);
        throw new ShopMcpError('rpc', sanitize(msg, argSecrets));
      }

      const result = payload?.result;
      if (!result || typeof result !== 'object') {
        throw new ShopMcpError('rpc', 'Missing JSON-RPC result');
      }

      if (result.isError) {
        const shopErr = result._meta?.['com.shopify/error'];
        const upstreamCode =
          typeof shopErr?.code === 'string' ? shopErr.code : undefined;
        const continueUrl =
          typeof shopErr?.continue_url === 'string' ? shopErr.continue_url : undefined;

        if (upstreamCode === 'sign_in_required') {
          throw new ShopMcpError('auth', 'Sign-in required', {
            status: 401,
            upstreamCode,
            continueUrl,
          });
        }

        const text = Array.isArray(result.content)
          ? result.content
              .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join('\n') || 'Shop MCP tool error'
          : 'Shop MCP tool error';
        throw new ShopMcpError('tool', sanitize(text, argSecrets), { upstreamCode, continueUrl });
      }

      if (result.structuredContent !== undefined && result.structuredContent !== null) {
        return result.structuredContent;
      }

      const firstText = result.content?.[0]?.text;
      if (typeof firstText === 'string') {
        try {
          return JSON.parse(firstText);
        } catch (err) {
          throw new ShopMcpError(
            'parse',
            sanitize(
              `Invalid tool content JSON: ${err instanceof Error ? err.message : String(err)}`,
              argSecrets,
            ),
          );
        }
      }

      return result;
    } finally {
      release();
    }
  }

  function summarizeErrorForLog(message: string, extraSecrets?: readonly string[]): string {
    const cleaned = sanitize(message, extraSecrets).trim();
    if (cleaned.startsWith('{')) {
      try {
        const parsed = JSON.parse(cleaned) as {
          messages?: Array<{ code?: string; content?: string; message?: string }>;
        };
        if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
          const parts = parsed.messages
            .map((m) => {
              const text = m?.content ?? m?.message ?? '';
              return m?.code && text ? `${m.code}: ${text}` : text || m?.code || '';
            })
            .filter(Boolean);
          if (parts.length > 0) {
            return sanitize(parts.join('; '), extraSecrets).slice(0, 300);
          }
        }
      } catch {
        // fall through
      }
    }
    return cleaned.slice(0, 300);
  }

  async function call(
    tool: string,
    args: Record<string, unknown>,
    o?: ShopMcpCallOptions,
  ): Promise<any> {
    const argSecrets = extractImageDataSecrets(args);
    try {
      return await callInner(tool, args, o, argSecrets);
    } catch (err) {
      if (err instanceof ShopMcpError) {
        logEvent('store_error', {
          tool,
          code: err.code,
          message: summarizeErrorForLog(err.message, argSecrets),
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.retryAfterMs !== undefined ? { retry_after_ms: err.retryAfterMs } : {}),
          ...(err.upstreamCode ? { upstream_code: err.upstreamCode } : {}),
        });
      }
      throw err;
    }
  }

  return {
    call,
    blockedUntil: () => blockedUntilMs,
  };
}

export const shopMcp: ShopMcpClient = createShopMcp();
