import { logEvent } from './log.ts';

export class ShopMcpError extends Error {
  code: string;
  status?: number;
  retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    opts?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ShopMcpError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface ShopMcpOptions {
  url?: string;
  fetch?: typeof fetch;
  maxInFlight?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface ShopMcpCallOptions {
  timeoutMs?: number;
}

export interface ShopMcpClient {
  call(tool: string, args: Record<string, unknown>, o?: ShopMcpCallOptions): Promise<any>;
  blockedUntil(): number;
}

const ALLOWED_TOOLS = new Set([
  'search_catalog',
  'lookup_catalog',
  'get_product',
  'create_cart',
  'get_cart',
  'update_cart',
]);

const EXPLICITLY_DENIED_TOOLS = new Set([
  'complete_checkout',
  'create_checkout',
  'complete_spend_request',
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

export function createShopMcp(opts?: ShopMcpOptions): ShopMcpClient {
  const url = opts?.url || process.env.SHOP_MCP_URL || DEFAULT_URL;
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const maxInFlight = Math.max(1, opts?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts?.now ?? (() => Date.now());

  let nextId = 1;
  let blockedUntilMs = 0;
  let inFlight = 0;
  const waiters: (() => void)[] = [];

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

  async function callInner(
    tool: string,
    args: Record<string, unknown>,
    o?: ShopMcpCallOptions,
  ): Promise<any> {
    if (
      typeof tool !== 'string' ||
      EXPLICITLY_DENIED_TOOLS.has(tool) ||
      DENIED_TOOL_RE.test(tool) ||
      !ALLOWED_TOOLS.has(tool)
    ) {
      throw new ShopMcpError('denied', `Tool "${String(tool)}" is denied`);
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

      let res: Response;
      let rawText: string;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'MCP-Protocol-Version': PROTOCOL_VERSION,
            'Mcp-Method': 'tools/call',
            'Mcp-Name': tool,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

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
          throw new ShopMcpError('timeout', `Shop MCP ${tool} timed out after ${timeoutMs}ms`, {
            cause: err,
          });
        }
        throw new ShopMcpError(
          'network',
          err instanceof Error ? err.message : String(err),
          { cause: err },
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
          `Invalid JSON from Shop MCP: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (payload?.error) {
        const msg =
          typeof payload.error.message === 'string'
            ? payload.error.message
            : JSON.stringify(payload.error);
        throw new ShopMcpError('rpc', msg);
      }

      const result = payload?.result;
      if (!result || typeof result !== 'object') {
        throw new ShopMcpError('rpc', 'Missing JSON-RPC result');
      }

      if (result.isError) {
        const text = Array.isArray(result.content)
          ? result.content
              .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join('\n') || 'Shop MCP tool error'
          : 'Shop MCP tool error';
        throw new ShopMcpError('tool', text);
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
            `Invalid tool content JSON: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }

      return result;
    } finally {
      release();
    }
  }

  async function call(
    tool: string,
    args: Record<string, unknown>,
    o?: ShopMcpCallOptions,
  ): Promise<any> {
    try {
      return await callInner(tool, args, o);
    } catch (err) {
      if (err instanceof ShopMcpError) {
        logEvent('store_error', {
          tool,
          code: err.code,
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.retryAfterMs !== undefined ? { retry_after_ms: err.retryAfterMs } : {}),
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
