import crypto from 'node:crypto';
import type { ShopMcpClient } from './shopmcp.ts';
import { shopMcp } from './shopmcp.ts';
import { logEvent } from './log.ts';

export interface CartLineInput {
  variant_id: string;
  quantity?: number;
}

export interface StoreCartResponse {
  cart_id: string | null;
  continue_url: string | null;
  total_usd: number | null;
  line_items: any[];
  messages: any[];
  ms: number;
  error?: string;
}

export interface CartClient {
  createCart(storeDomain: string, lines: CartLineInput[]): Promise<StoreCartResponse>;
  getCart(storeDomain: string, id: string): Promise<StoreCartResponse>;
  updateCart(storeDomain: string, id: string, lines: CartLineInput[]): Promise<StoreCartResponse>;
}

const CART_TIMEOUT_MS = 4000;

function mapLines(lines: CartLineInput[]): { item: { id: string }; quantity: number }[] {
  return lines.map((l) => ({
    item: { id: l.variant_id },
    quantity: l.quantity ?? 1,
  }));
}

function parseCartPayload(data: any, ms: number): StoreCartResponse {
  const candidate = data?.cart ?? data;
  const isCart =
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    (typeof candidate.id === 'string' || typeof candidate.continue_url === 'string');

  if (!isCart) {
    return {
      cart_id: null,
      continue_url: null,
      total_usd: null,
      line_items: [],
      messages: Array.isArray(data?.messages) ? data.messages : [],
      ms,
      error: 'Missing cart in Shop MCP response',
    };
  }

  const cart = candidate;
  const totals = Array.isArray(cart.totals) ? cart.totals : [];
  const totalEntry =
    totals.find((t: any) => t?.type === 'total') ??
    totals.find((t: any) => t?.type === 'subtotal');
  const rawAmount = totalEntry?.amount;
  const amountNum = rawAmount !== undefined && rawAmount !== null ? Number(rawAmount) : NaN;
  const total_usd = Number.isFinite(amountNum) ? amountNum / 100 : null;

  return {
    cart_id: typeof cart.id === 'string' ? cart.id : null,
    continue_url: typeof cart.continue_url === 'string' ? cart.continue_url : null,
    total_usd,
    line_items: Array.isArray(cart.line_items) ? cart.line_items : [],
    messages: Array.isArray(cart.messages)
      ? cart.messages
      : Array.isArray(data?.messages)
        ? data.messages
        : [],
    ms,
  };
}

function errorResponse(err: unknown, ms: number): StoreCartResponse {
  return {
    cart_id: null,
    continue_url: null,
    total_usd: null,
    line_items: [],
    messages: [],
    ms,
    error: err instanceof Error ? err.message : String(err),
  };
}

export function createCartClient(deps?: {
  mcp?: ShopMcpClient;
  now?: () => number;
}): CartClient {
  const mcp = deps?.mcp ?? shopMcp;
  const now = deps?.now ?? (() => Date.now());

  async function createCart(
    storeDomain: string,
    lines: CartLineInput[],
  ): Promise<StoreCartResponse> {
    const t0 = now();
    try {
      const data = await mcp.call(
        'create_cart',
        {
          shop: storeDomain,
          cart: {
            line_items: mapLines(lines),
          },
          meta: {
            'idempotency-key': crypto.randomUUID(),
          },
        },
        { timeoutMs: CART_TIMEOUT_MS },
      );
      const ms = Math.max(0, now() - t0);
      const res = parseCartPayload(data, ms);
      const ok = Boolean(res.cart_id || res.continue_url) && !res.error;
      console.log(`[store] create_cart ${storeDomain} ${ok ? 'ok' : 'err'} ${ms}ms`);
      logEvent('store_cart', {
        store: storeDomain,
        ok,
        n_lines: lines.length,
        total_usd: res.total_usd,
        ms,
        ...(res.error ? { error: res.error } : {}),
      });
      return res;
    } catch (err) {
      const ms = Math.max(0, now() - t0);
      const res = errorResponse(err, ms);
      console.log(`[store] create_cart ${storeDomain} err ${ms}ms`);
      logEvent('store_cart', {
        store: storeDomain,
        ok: false,
        n_lines: lines.length,
        total_usd: null,
        ms,
        ...(res.error ? { error: res.error } : {}),
      });
      return res;
    }
  }

  async function getCart(storeDomain: string, id: string): Promise<StoreCartResponse> {
    const t0 = now();
    try {
      const data = await mcp.call(
        'get_cart',
        { shop: storeDomain, id },
        { timeoutMs: CART_TIMEOUT_MS },
      );
      const ms = Math.max(0, now() - t0);
      const res = parseCartPayload(data, ms);
      console.log(`[store] get_cart ${storeDomain} ${res.cart_id ? 'ok' : 'err'} ${ms}ms`);
      return res;
    } catch (err) {
      const ms = Math.max(0, now() - t0);
      const res = errorResponse(err, ms);
      console.log(`[store] get_cart ${storeDomain} err ${ms}ms`);
      return res;
    }
  }

  async function updateCart(
    storeDomain: string,
    id: string,
    lines: CartLineInput[],
  ): Promise<StoreCartResponse> {
    const t0 = now();
    try {
      const data = await mcp.call(
        'update_cart',
        {
          shop: storeDomain,
          id,
          cart: {
            line_items: mapLines(lines),
          },
        },
        { timeoutMs: CART_TIMEOUT_MS },
      );
      const ms = Math.max(0, now() - t0);
      const res = parseCartPayload(data, ms);
      console.log(`[store] update_cart ${storeDomain} ${res.cart_id ? 'ok' : 'err'} ${ms}ms`);
      return res;
    } catch (err) {
      const ms = Math.max(0, now() - t0);
      const res = errorResponse(err, ms);
      console.log(`[store] update_cart ${storeDomain} err ${ms}ms`);
      return res;
    }
  }

  return {
    createCart,
    getCart,
    updateCart,
  };
}

const defaultCart = createCartClient();

export const createCart = defaultCart.createCart;
export const getCart = defaultCart.getCart;
export const updateCart = defaultCart.updateCart;
