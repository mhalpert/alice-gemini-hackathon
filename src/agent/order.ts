import { randomUUID } from 'node:crypto';
import { llm } from '@livekit/agents';
import { z } from 'zod';
import { calllog } from '../calllog.ts';
import type { BagOut, OrderReview, OrderStore } from '../types.ts';
import { DEFAULT_PURCHASE_MAX_USD } from './config.ts';
import type { PageSender } from './page.ts';
import type { CallStateStore } from './state.ts';

export const ORDER_REVIEW_TTL_MS = 120_000;
export const ORDER_CEILING_USD = 10_000;

export const ORDER_NOT_DONE_NO_BAG = 'NOT DONE: nothing is in the bag yet.';
export const ORDER_NOT_AVAILABLE = 'NOT AVAILABLE: hand over the store links as today.';
export const ORDER_NOT_READY_SIGN_IN =
  'NOT READY: they need to connect Shop Pay using the step on screen; offer the store links as the other way.';
export const ORDER_OVER_LIMIT =
  'NOT DONE: this order is over the in-call purchase limit; hand over the store links.';
export const ORDER_ALREADY_SENT_NOTE =
  "This store's order was already sent. Check your Shop app or email.";
export const ORDER_PAYMENT_PROCESSING_PREFIX = 'Payment may still be processing';
export const ORDER_PLACE_UNCONFIRMED_ERROR =
  'NOT DONE: the order could not be confirmed as placed; do not try again, point them to the store links on screen.';

export type OrderLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export type PrepareOrderResult = OrderReview & { disabled?: true };
export type PrepareOrderFn = (bag: BagOut) => Promise<PrepareOrderResult>;
export type PlaceOrderFn = (
  orderId: string,
  opts: { idempotencyKey: string; confirmedByTap: boolean },
) => Promise<OrderReview>;

export interface StoreOrderModuleLike {
  prepareOrder?: PrepareOrderFn;
  placeOrder?: PlaceOrderFn;
}

export interface OrderStoreDeps {
  prepareOrder?: PrepareOrderFn;
  placeOrder?: PlaceOrderFn;
  storeOrderModule?: StoreOrderModuleLike | null;
}

let defaultStoreOrderModule: StoreOrderModuleLike | null = null;
try {
  const modPath = '../store/index.ts';
  defaultStoreOrderModule = (await import(modPath)) as StoreOrderModuleLike;
} catch {
  defaultStoreOrderModule = null;
}

export function resolveOrderStoreFns(deps?: OrderStoreDeps): {
  prepareOrder?: PrepareOrderFn;
  placeOrder?: PlaceOrderFn;
} {
  const hasExplicitPrepare = deps !== undefined && 'prepareOrder' in deps;
  const hasExplicitPlace = deps !== undefined && 'placeOrder' in deps;
  const storeMod =
    deps !== undefined && 'storeOrderModule' in deps
      ? deps.storeOrderModule
      : defaultStoreOrderModule;

  const rawPrepare = hasExplicitPrepare ? deps?.prepareOrder : storeMod?.prepareOrder;
  const rawPlace = hasExplicitPlace ? deps?.placeOrder : storeMod?.placeOrder;

  return {
    ...(typeof rawPrepare === 'function' ? { prepareOrder: rawPrepare } : {}),
    ...(typeof rawPlace === 'function' ? { placeOrder: rawPlace } : {}),
  };
}

export function isPurchaseReady(opts: {
  purchaseEnabled: boolean;
  deps?: OrderStoreDeps;
}): boolean {
  if (!opts.purchaseEnabled) return false;
  const fns = resolveOrderStoreFns(opts.deps);
  return typeof fns.prepareOrder === 'function' && typeof fns.placeOrder === 'function';
}

export interface OrderReviewRecord {
  order_id: string;
  bagFingerprint: string;
  reviewedAt: number;
  idempotencyKey: string;
  order: OrderReview;
}

export interface OrderMachineState {
  settledBag: BagOut | null;
  settledBagFingerprint: string | null;
  activeReview: OrderReviewRecord | null;
  attemptedOrderIds: Readonly<Record<string, string>>;
}

export type OrderMachineAction =
  | { type: 'bag_settled'; bag: BagOut }
  | { type: 'bag_cleared' }
  | { type: 'invalidate_review' }
  | { type: 'review_recorded'; review: OrderReviewRecord }
  | { type: 'order_attempt_recorded'; order_id: string; result: string };

export function createInitialOrderMachineState(): OrderMachineState {
  return {
    settledBag: null,
    settledBagFingerprint: null,
    activeReview: null,
    attemptedOrderIds: {},
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${stableJson(val)}`);
  }
  return `{${entries.join(',')}}`;
}

function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) return '$0';
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Deterministic fingerprint covering cart ids, added items, sizes, and totals.
 */
export function computeBagFingerprint(bag: BagOut): string {
  const carts = (Array.isArray(bag.carts) ? bag.carts : [])
    .map((cart) => {
      const items = (Array.isArray(cart.added) ? cart.added : [])
        .map((line) => ({
          variant_id: line.variant_id,
          title: line.title ?? null,
          size: line.size ?? null,
        }))
        .sort((a, b) =>
          `${a.variant_id}\0${a.size ?? ''}\0${a.title ?? ''}`.localeCompare(
            `${b.variant_id}\0${b.size ?? ''}\0${b.title ?? ''}`,
          ),
        );
      return {
        store: cart.store,
        store_domain: cart.store_domain,
        cart_id: cart.cart_id ?? null,
        total_usd:
          typeof cart.total_usd === 'number' && Number.isFinite(cart.total_usd)
            ? roundMoney(cart.total_usd)
            : null,
        items,
      };
    })
    .sort((a, b) =>
      `${a.store_domain}\0${a.store}\0${a.cart_id ?? ''}`.localeCompare(
        `${b.store_domain}\0${b.store}\0${b.cart_id ?? ''}`,
      ),
    );

  return stableJson({
    total_usd:
      typeof bag.total_usd === 'number' && Number.isFinite(bag.total_usd)
        ? roundMoney(bag.total_usd)
        : null,
    carts,
  });
}

export function generateOrderIdempotencyKey(): string {
  return randomUUID();
}

export function reduceOrderState(
  state: OrderMachineState,
  action: OrderMachineAction,
): OrderMachineState {
  switch (action.type) {
    case 'bag_settled':
      return {
        ...state,
        settledBag: action.bag,
        settledBagFingerprint: computeBagFingerprint(action.bag),
        activeReview: null,
      };

    case 'bag_cleared':
      return {
        ...state,
        settledBag: null,
        settledBagFingerprint: null,
        activeReview: null,
      };

    case 'invalidate_review':
      if (state.activeReview === null) return state;
      return {
        ...state,
        activeReview: null,
      };

    case 'review_recorded':
      return {
        ...state,
        activeReview: action.review,
      };

    case 'order_attempt_recorded':
      if (Object.prototype.hasOwnProperty.call(state.attemptedOrderIds, action.order_id)) {
        return state;
      }
      return {
        ...state,
        attemptedOrderIds: {
          ...state.attemptedOrderIds,
          [action.order_id]: action.result,
        },
      };
  }
}

export function resolveOrderTotalUsd(order: OrderReview, bag: BagOut | null): number | null {
  if (typeof order.total === 'number' && Number.isFinite(order.total) && order.total >= 0) {
    return roundMoney(order.total);
  }
  const stores = Array.isArray(order.stores) ? order.stores : [];
  if (
    stores.length > 0 &&
    stores.every((s) => typeof s.total === 'number' && Number.isFinite(s.total) && s.total >= 0)
  ) {
    return roundMoney(stores.reduce((sum, s) => sum + (s.total as number), 0));
  }
  if (bag && typeof bag.total_usd === 'number' && Number.isFinite(bag.total_usd) && bag.total_usd >= 0) {
    return roundMoney(bag.total_usd);
  }
  return null;
}

export type OrderGateResult =
  | { ok: true; order_id: string; idempotencyKey: string; totalUsd: number }
  | {
      ok: false;
      reason: string;
      message: string;
      order_id?: string;
      existingResult?: string;
    };

export function evaluatePlaceOrderGates(params: {
  state: OrderMachineState;
  purchaseEnabled: boolean;
  hasStoreFns: boolean;
  spokenConfirmation: boolean;
  nowMs: number;
  requestedOrderId?: string;
  maxUsd?: number;
  ceilingUsd?: number;
  ttlMs?: number;
}): OrderGateResult {
  const { state, purchaseEnabled, hasStoreFns, spokenConfirmation, nowMs } = params;
  const ttlMs = params.ttlMs ?? ORDER_REVIEW_TTL_MS;
  const maxUsd =
    typeof params.maxUsd === 'number' && Number.isFinite(params.maxUsd) && params.maxUsd > 0
      ? params.maxUsd
      : DEFAULT_PURCHASE_MAX_USD;
  const ceilingUsd =
    typeof params.ceilingUsd === 'number' &&
    Number.isFinite(params.ceilingUsd) &&
    params.ceilingUsd > 0
      ? params.ceilingUsd
      : ORDER_CEILING_USD;

  if (!purchaseEnabled || !hasStoreFns) {
    return {
      ok: false,
      reason: 'purchase_disabled',
      message: 'NOT DONE: in-call purchasing is not enabled.',
    };
  }

  const review = state.activeReview;
  if (!review || !review.order_id.trim()) {
    return {
      ok: false,
      reason: 'no_review',
      message: 'NOT DONE: there is no current order review; call review_order first.',
    };
  }

  const orderId = review.order_id;
  const requested =
    typeof params.requestedOrderId === 'string' && params.requestedOrderId.trim().length > 0
      ? params.requestedOrderId.trim()
      : undefined;
  if (requested !== undefined && requested !== orderId) {
    return {
      ok: false,
      reason: 'review_superseded',
      order_id: requested,
      message:
        'NOT DONE: a newer order review replaced that order; check the latest review before placing.',
    };
  }

  if (Object.prototype.hasOwnProperty.call(state.attemptedOrderIds, orderId)) {
    const existingResult = state.attemptedOrderIds[orderId]!;
    return {
      ok: false,
      reason: 'already_attempted',
      order_id: orderId,
      message: existingResult,
      existingResult,
    };
  }

  const ageMs = nowMs - review.reviewedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ttlMs) {
    return {
      ok: false,
      reason: 'review_stale',
      order_id: orderId,
      message: 'NOT DONE: the order review expired; call review_order again before placing the order.',
    };
  }

  if (
    !state.settledBag ||
    !state.settledBagFingerprint ||
    state.settledBagFingerprint !== review.bagFingerprint
  ) {
    return {
      ok: false,
      reason: 'bag_changed',
      order_id: orderId,
      message: 'NOT DONE: the bag changed since the order review; call review_order again.',
    };
  }

  if (spokenConfirmation !== true) {
    return {
      ok: false,
      reason: 'no_spoken_confirmation',
      order_id: orderId,
      message: 'NOT DONE: the shopper has not clearly said yes to placing this exact order.',
    };
  }

  const totalUsd = resolveOrderTotalUsd(review.order, state.settledBag);
  if (totalUsd === null) {
    return {
      ok: false,
      reason: 'invalid_total',
      order_id: orderId,
      message: 'NOT DONE: the order total could not be verified; point them to the store links on screen.',
    };
  }

  const effectiveMax = Math.min(ceilingUsd, maxUsd);
  if (totalUsd > effectiveMax) {
    return {
      ok: false,
      reason: 'over_max_usd',
      order_id: orderId,
      message: ORDER_OVER_LIMIT,
    };
  }

  return {
    ok: true,
    order_id: orderId,
    idempotencyKey: review.idempotencyKey,
    totalUsd,
  };
}

function isAlreadySentNote(note: unknown): boolean {
  return typeof note === 'string' && note === ORDER_ALREADY_SENT_NOTE;
}

function isPaymentProcessingNote(note: unknown): boolean {
  return typeof note === 'string' && note.startsWith(ORDER_PAYMENT_PROCESSING_PREFIX);
}

export function formatOrderReviewResult(order: OrderReview): string {
  const stores = Array.isArray(order.stores) ? order.stores : [];
  const lines: string[] = [];

  for (const store of stores) {
    const itemsText = (Array.isArray(store.items) ? store.items : [])
      .map((item) => (item.size ? `${item.title} (size ${item.size})` : item.title))
      .join(', ');
    const totalText =
      typeof store.total === 'number' && Number.isFinite(store.total)
        ? formatMoney(store.total)
        : 'total unavailable';
    const itemSegment = itemsText ? `: ${itemsText}` : '';

    if (isAlreadySentNote(store.note)) {
      lines.push(
        `- ${store.store}${itemSegment} — ${totalText} (Say verbatim: "${ORDER_ALREADY_SENT_NOTE}" Do not offer another try or a link for ${store.store}.).`,
      );
      continue;
    }

    const extras: string[] = [];
    if (store.ready === false) {
      const noteText = typeof store.note === 'string' ? store.note.trim() : '';
      if (noteText.length > 0) {
        extras.push(`${store.store} will be a hand-off link instead — ${noteText}`);
      } else {
        extras.push(`${store.store} will be a hand-off link instead`);
      }
    }
    if (typeof store.payment_label === 'string' && store.payment_label.length > 0) {
      extras.push(`Payment: ${store.payment_label}`);
    }
    const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : '';
    lines.push(`- ${store.store}${itemSegment} — ${totalText}${suffix}.`);
  }

  const summaryParts: string[] = [];
  if (typeof order.total === 'number' && Number.isFinite(order.total)) {
    summaryParts.push(`Grand total: ${formatMoney(order.total)}.`);
  }
  if (typeof order.address_label === 'string' && order.address_label.length > 0) {
    summaryParts.push(`Address: ${order.address_label}.`);
  }
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(' '));
  }

  const hasReadyStore = stores.some((s) => s.ready === true && !isAlreadySentNote(s.note));
  const allAlreadySent = stores.length > 0 && stores.every((s) => isAlreadySentNote(s.note));

  if (hasReadyStore) {
    lines.push(
      'Read back these store checkout items and totals, not earlier bag numbers. Ask them to check the order on screen, tap Confirm, and tell you yes.',
    );
  } else if (allAlreadySent) {
    lines.push(
      'Say the already-sent sentence verbatim; do not offer another try or a link for those stores.',
    );
  } else {
    lines.push(
      'Read back these store checkout items and totals, not earlier bag numbers. No stores are ready for in-call checkout; hand over the store links.',
    );
  }

  return lines.join('\n');
}

function normalizedStoreStatus(store: OrderStore): string {
  if (store.status) return store.status;
  if (store.order_number) return 'placed';
  if (store.ready === false) return 'handoff';
  return 'failed';
}

export function formatOrderPlacedResult(orderId: string, stores: OrderStore[]): string {
  if (!Array.isArray(stores) || stores.length === 0) {
    return `Order ${orderId}: no store statuses returned.`;
  }
  const parts = stores.map((store) => {
    const status = normalizedStoreStatus(store);
    const noteText = typeof store.note === 'string' ? store.note.trim() : '';
    const noteSuffix = noteText ? ` — ${noteText}` : '';

    if (isAlreadySentNote(store.note)) {
      return `${store.store}: ${ORDER_ALREADY_SENT_NOTE} (Say verbatim; do not offer another try or a link for ${store.store}.)`;
    }
    if (status === 'placed') {
      const numPart = store.order_number ? ` (order ${store.order_number})` : '';
      return `${store.store}: placed${numPart}${noteSuffix}`;
    }
    if (status === 'handoff') {
      return `${store.store}: hand-off link on screen${noteSuffix}`;
    }
    if (status === 'failed' && isPaymentProcessingNote(store.note)) {
      return `${store.store}: failed — ${noteText}. Tell the shopper to check their Shop app; do not offer the store link or a retry for ${store.store}`;
    }
    return `${store.store}: ${status}${noteSuffix}`;
  });
  return `Order ${orderId}: ${parts.join('; ')}.`;
}

/**
 * Safe log payload for `order_review` — strictly excludes payment, address, and sign-in details.
 */
export function buildOrderReviewLogData(order: OrderReview): Record<string, unknown> {
  return {
    order_id: order.order_id,
    stores: (Array.isArray(order.stores) ? order.stores : []).map((s) => ({
      store: s.store,
      items: Array.isArray(s.items) ? s.items.length : 0,
      total: s.total,
      ready: s.ready,
    })),
    total: order.total,
    needs_sign_in: Boolean(order.needs_sign_in),
  };
}

/**
 * Safe log payload for `order_placed` — strictly `{ order_id, stores: [{ store, status }] }`.
 */
export function buildOrderPlacedLogData(
  orderId: string,
  stores: OrderStore[],
): Record<string, unknown> {
  return {
    order_id: orderId,
    stores: (Array.isArray(stores) ? stores : []).map((s) => ({
      store: s.store,
      status: normalizedStoreStatus(s),
    })),
  };
}

export interface OrderToolsOptions {
  room: string;
  purchaseEnabled: boolean;
  purchaseMaxUsd?: number;
  page: PageSender;
  stateStore: CallStateStore;
  deps?: OrderStoreDeps;
  log?: OrderLogFn;
  now?: () => number;
  generateIdempotencyKey?: () => string;
  onToolStart?: (params: { name: string; callId: string }) => void;
  onToolEnd?: (params: { name: string; callId: string }) => void;
  onToolResult?: (params: { name: string; callId: string; text: string }) => void;
}

export interface OrderToolMap {
  review_order?: llm.FunctionTool<any, any, any>;
  place_order?: llm.FunctionTool<any, any, any>;
}

export interface OrderController {
  readonly purchaseReady: boolean;
  onBagSettled(bag: BagOut): void;
  onBagFailed(): void;
  invalidateReview(): void;
  getState(): OrderMachineState;
  tools: OrderToolMap;
}

export function createOrderController(options: OrderToolsOptions): OrderController {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const generateKeyFn = options.generateIdempotencyKey ?? generateOrderIdempotencyKey;
  const purchaseMaxUsd = options.purchaseMaxUsd ?? DEFAULT_PURCHASE_MAX_USD;
  const fns = resolveOrderStoreFns(options.deps);
  const hasStoreFns =
    typeof fns.prepareOrder === 'function' && typeof fns.placeOrder === 'function';
  const purchaseReady = options.purchaseEnabled && hasStoreFns;

  let machine = createInitialOrderMachineState();
  const inFlightByOrderId = new Map<string, Promise<string>>();

  function onBagSettled(bag: BagOut): void {
    machine = reduceOrderState(machine, { type: 'bag_settled', bag });
    options.stateStore.dispatch({ type: 'set_order_review', review: null });
  }

  function onBagFailed(): void {
    machine = reduceOrderState(machine, { type: 'bag_cleared' });
    options.stateStore.dispatch({ type: 'set_order_review', review: null });
  }

  function invalidateReview(): void {
    machine = reduceOrderState(machine, { type: 'invalidate_review' });
    options.stateStore.dispatch({ type: 'set_order_review', review: null });
  }

  function wrapOrderTool<TArgs extends Record<string, unknown>>(
    name: string,
    handler: (args: TArgs) => Promise<string>,
  ) {
    return async (args: TArgs, opts?: { toolCallId?: string }): Promise<string> => {
      const callId = opts?.toolCallId ?? '';
      const startedAt = nowFn();
      // Args contain only {} or { spoken_confirmation, order_id? }, never payment/address labels.
      logFn(options.room, 'tool_call', {
        name,
        args: args ?? {},
        call_id: callId,
      });
      options.onToolStart?.({ name, callId });
      try {
        const text = await handler(args ?? ({} as TArgs));
        const durationMs = Math.max(0, nowFn() - startedAt);
        // Deliberately omit `text` from tool_result log so masked payment/address labels never appear in logs.
        logFn(options.room, 'tool_result', {
          name,
          call_id: callId,
          duration_ms: durationMs,
        });
        options.onToolResult?.({ name, callId, text });
        return text;
      } finally {
        options.onToolEnd?.({ name, callId });
      }
    };
  }

  if (!purchaseReady) {
    return {
      purchaseReady: false,
      onBagSettled,
      onBagFailed,
      invalidateReview,
      getState: () => machine,
      tools: {},
    };
  }

  const prepareOrderFn = fns.prepareOrder!;
  const placeOrderFn = fns.placeOrder!;

  const reviewOrderTool = llm.tool({
    description:
      'Prepare an in-call order review for the current settled shopping bag and display it on screen so the shopper can check totals, payment, and address before confirming. No money moves.',
    execute: wrapOrderTool('review_order', async () => {
      if (!machine.settledBag) {
        return ORDER_NOT_DONE_NO_BAG;
      }

      const bagSnapshot = machine.settledBag;
      const bagFingerprint = computeBagFingerprint(bagSnapshot);

      let order: PrepareOrderResult;
      try {
        order = await prepareOrderFn(bagSnapshot);
      } catch {
        invalidateReview();
        logFn(options.room, 'order_blocked', { reason: 'prepare_failed' });
        return 'NOT DONE: could not prepare the order right now; offer the store links on screen instead.';
      }

      if (order?.disabled === true) {
        invalidateReview();
        logFn(options.room, 'order_blocked', { reason: 'store_disabled' });
        return ORDER_NOT_AVAILABLE;
      }

      try {
        await options.page.send('showOrderReview', { order });
      } catch {
        // Page display error must not leak labels or crash review_order.
      }

      logFn(options.room, 'order_review', buildOrderReviewLogData(order));

      if (order.needs_sign_in) {
        invalidateReview();
        return ORDER_NOT_READY_SIGN_IN;
      }

      if (typeof order.order_id !== 'string' || order.order_id.trim().length === 0) {
        invalidateReview();
        logFn(options.room, 'order_blocked', { reason: 'invalid_review' });
        return 'NOT DONE: could not prepare the order right now; offer the store links on screen instead.';
      }

      const reviewedAt = nowFn();
      const idempotencyKey = generateKeyFn();
      machine = reduceOrderState(machine, {
        type: 'review_recorded',
        review: {
          order_id: order.order_id,
          bagFingerprint,
          reviewedAt,
          idempotencyKey,
          order,
        },
      });
      options.stateStore.dispatch({
        type: 'set_order_review',
        review: {
          order_id: order.order_id,
          bagFingerprint,
          reviewedAt,
        },
      });

      return formatOrderReviewResult(order);
    }),
  });

  const placeOrderTool = llm.tool({
    description:
      'Place the reviewed order with Shop Pay after the shopper has checked the order on screen, tapped Confirm, and clearly said yes.',
    parameters: z.object({
      spoken_confirmation: z
        .boolean()
        .describe('true only if the shopper just clearly said yes to placing this exact order'),
      order_id: z
        .string()
        .optional()
        .describe('optional order_id from the latest review_order; omit to place the latest review'),
    }),
    execute: wrapOrderTool('place_order', async ({ spoken_confirmation, order_id }) => {
      const initialGate = evaluatePlaceOrderGates({
        state: machine,
        purchaseEnabled: options.purchaseEnabled,
        hasStoreFns,
        spokenConfirmation: spoken_confirmation,
        requestedOrderId: order_id,
        nowMs: nowFn(),
        maxUsd: purchaseMaxUsd,
        ceilingUsd: ORDER_CEILING_USD,
        ttlMs: ORDER_REVIEW_TTL_MS,
      });

      if (!initialGate.ok) {
        logFn(options.room, 'order_blocked', {
          reason: initialGate.reason,
          ...(initialGate.order_id ? { order_id: initialGate.order_id } : {}),
        });
        return initialGate.existingResult ?? initialGate.message;
      }

      const orderId = initialGate.order_id;
      const inFlight = inFlightByOrderId.get(orderId);
      if (inFlight) {
        logFn(options.room, 'order_blocked', {
          reason: 'already_attempted',
          order_id: orderId,
        });
        return await inFlight;
      }

      let confirmedByTap = false;
      try {
        const reply = await options.page.send('confirmOrder', { order_id: orderId });
        confirmedByTap =
          Boolean(reply) &&
          reply.ok === true &&
          reply.confirmed === true &&
          (reply.order_id === undefined || reply.order_id === orderId);
      } catch {
        confirmedByTap = false;
      }

      if (confirmedByTap !== true) {
        logFn(options.room, 'order_blocked', {
          reason: 'page_not_confirmed',
          order_id: orderId,
        });
        return 'NOT DONE: the shopper has not tapped Confirm on screen for this order yet.';
      }

      // Re-check gates and in-flight status after awaiting page RPC to prevent races,
      // mid-RPC bag edits, or a newer review_order superseding this one.
      const inFlightAfterRpc = inFlightByOrderId.get(orderId);
      if (inFlightAfterRpc) {
        logFn(options.room, 'order_blocked', {
          reason: 'already_attempted',
          order_id: orderId,
        });
        return await inFlightAfterRpc;
      }

      const postRpcGate = evaluatePlaceOrderGates({
        state: machine,
        purchaseEnabled: options.purchaseEnabled,
        hasStoreFns,
        spokenConfirmation: spoken_confirmation,
        requestedOrderId: orderId,
        nowMs: nowFn(),
        maxUsd: purchaseMaxUsd,
        ceilingUsd: ORDER_CEILING_USD,
        ttlMs: ORDER_REVIEW_TTL_MS,
      });
      if (!postRpcGate.ok || postRpcGate.order_id !== orderId) {
        const reason = postRpcGate.ok ? 'review_superseded' : postRpcGate.reason;
        logFn(options.room, 'order_blocked', {
          reason,
          order_id: orderId,
        });
        return !postRpcGate.ok
          ? (postRpcGate.existingResult ?? postRpcGate.message)
          : 'NOT DONE: a newer order review replaced that order; check the latest review before placing.';
      }

      const idempotencyKey = postRpcGate.idempotencyKey;

      const attemptPromise = (async (): Promise<string> => {
        logFn(options.room, 'order_place_attempt', {
          order_id: orderId,
          idempotency_key: idempotencyKey,
          total: postRpcGate.totalUsd,
        });

        let placed: OrderReview;
        try {
          placed = await placeOrderFn(orderId, {
            idempotencyKey,
            confirmedByTap,
          });
        } catch {
          machine = reduceOrderState(machine, {
            type: 'order_attempt_recorded',
            order_id: orderId,
            result: ORDER_PLACE_UNCONFIRMED_ERROR,
          });
          return ORDER_PLACE_UNCONFIRMED_ERROR;
        }

        const placedOrderId =
          typeof placed?.order_id === 'string' && placed.order_id.trim().length > 0
            ? placed.order_id
            : orderId;
        const stores = Array.isArray(placed?.stores) ? placed.stores : [];

        try {
          await options.page.send('orderPlaced', {
            order_id: placedOrderId,
            stores,
          });
        } catch {
          // Order was already placed; never report a page RPC error as a failed placement.
        }

        logFn(options.room, 'order_placed', buildOrderPlacedLogData(placedOrderId, stores));

        const resultText = formatOrderPlacedResult(placedOrderId, stores);
        machine = reduceOrderState(machine, {
          type: 'order_attempt_recorded',
          order_id: orderId,
          result: resultText,
        });
        if (placedOrderId !== orderId) {
          machine = reduceOrderState(machine, {
            type: 'order_attempt_recorded',
            order_id: placedOrderId,
            result: resultText,
          });
        }
        return resultText;
      })();

      inFlightByOrderId.set(orderId, attemptPromise);
      try {
        return await attemptPromise;
      } finally {
        inFlightByOrderId.delete(orderId);
      }
    }),
  });

  return {
    purchaseReady: true,
    onBagSettled,
    onBagFailed,
    invalidateReview,
    getState: () => machine,
    tools: {
      review_order: reviewOrderTool,
      place_order: placeOrderTool,
    },
  };
}
