import crypto from 'node:crypto';
import type { BagLine, BagOut, CartResult } from '../types.ts';
import type { ShopMcpClient } from './shopmcp.ts';
import { isPurchaseEnabled, shopMcp, ShopMcpError } from './shopmcp.ts';
import type { AuthManager } from './auth.ts';
import { defaultAuth, redactSecrets } from './auth.ts';
import { getCallRoom, logEvent } from './log.ts';
import { COMPLETE_CHECKOUT_GUARD } from './purchase-guard.ts';

export type OrderStoreStatus = 'review' | 'placing' | 'placed' | 'handoff' | 'failed';

export interface OrderStore {
  store: string;
  items: BagLine[];
  total: number;
  payment_label: string;
  ready: boolean;
  status?: OrderStoreStatus;
  order_number?: string;
  continue_url?: string;
  note?: string;
}

export interface OrderReview {
  order_id: string;
  stores: OrderStore[];
  total: number;
  address_label?: string;
  needs_sign_in?: boolean;
  sign_in?: { url: string; code?: string };
}

export interface PrepareOrderResult extends OrderReview {
  disabled?: boolean;
}

export interface PlaceOrderOptions {
  idempotencyKey: string;
  confirmedByTap: boolean;
  /** Ignored for security (M1): room is read strictly from getCallRoom(). */
  room?: string;
}

export interface PlacedStoreItems {
  variantTitles: Map<string, string>;
  productTitles: Map<string, string>;
}

export interface PurchaseDeps {
  mcp?: ShopMcpClient;
  auth?: AuthManager;
  now?: () => number;
  isPurchaseEnabled?: () => boolean;
  maxUsd?: () => number | null;
  sessionMaxUsd?: () => number | null;
  getRoom?: () => string | null;
  isHarnessEnv?: () => boolean;
  randomId?: () => string;
  reconcileDelaysMs?: number[];
  sentCartIds?: Set<string>;
  sentCheckoutIds?: Set<string>;
  unclearStores?: Set<string>;
  placedItemsByStore?: Map<string, PlacedStoreItems>;
}

export interface PurchaseClient {
  prepareOrder(bag: BagOut): Promise<PrepareOrderResult>;
  placeOrder(orderId: string, opts: PlaceOrderOptions): Promise<OrderReview>;
  endCall(): void;
  _debugStats(): {
    pendingReviews: number;
    rawInstrumentCount: number;
    sentCarts: number;
    sentCheckouts: number;
    unclearStores: number;
    placedStores: number;
    sessionSpentCents: number;
  };
}

const CHECKOUT_TIMEOUT_MS = 6000;
const COMPLETE_TIMEOUT_MS = 12_000;
const ORDER_REVIEW_MAX_AGE_MS = 2 * 60 * 1000;
const DEFAULT_RECONCILE_DELAYS_MS = [2000, 3000, 3000, 3000, 4000];
const VALID_ROOM_RE = /^alice-[0-9a-f]{10}$/;
const loggedInvalidCapVars = new Set<string>();

const TOTAL_NOT_FINAL_NOTE = 'Total not final yet; finish on the store page.';
const UNKNOWN_COMPLETION_NOTE =
  'Payment may still be processing. Check your Shop app or email before trying again.';
const ALREADY_SENT_NOTE = "This store's order was already sent. Check your Shop app or email.";

// Process-wide sets for the default purchase client; intentionally outlive signOut() and endCall().
const PROCESS_SENT_CART_IDS = new Set<string>();
const PROCESS_SENT_CHECKOUT_IDS = new Set<string>();
const PROCESS_UNCLEAR_STORES = new Set<string>();
const PROCESS_PLACED_ITEMS = new Map<string, PlacedStoreItems>();

const DEFINITE_REFUSAL_STATUSES = new Set([
  'failed',
  'declined',
  'canceled',
  'cancelled',
  'rejected',
  'expired',
  'incomplete',
  'requires_escalation',
]);

function normalizeStoreDomain(domain: string | undefined | null): string {
  return typeof domain === 'string' ? domain.trim().toLowerCase() : '';
}

function buildStoreUnclearNote(storeName: string): string {
  return `A payment for this store may still be processing. Check your Shop app or email before ordering from ${storeName} again.`;
}

function buildAlreadyOrderedNote(title: string): string {
  return `You already ordered ${title} in this call.`;
}

function nonEmptyStr(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface LineIdRef {
  variant_id: string | null;
  product_id: string | null;
  title: string;
}

function extractCartLineRefs(cart: CartResult): LineIdRef[] {
  const added = Array.isArray(cart?.added) ? cart.added : [];
  const refs: LineIdRef[] = [];
  for (const line of added as any[]) {
    const variant_id = nonEmptyStr(line?.variant_id);
    const product_id = nonEmptyStr(line?.item_id) ?? nonEmptyStr(line?.product_id);
    const title = nonEmptyStr(line?.title) ?? variant_id ?? product_id ?? 'this item';
    if (variant_id || product_id) {
      refs.push({ variant_id, product_id, title });
    }
  }
  return refs;
}

function extractCheckoutLineRefs(checkout: any, fallbackRefs: readonly LineIdRef[]): LineIdRef[] {
  const lines = Array.isArray(checkout?.line_items) ? checkout.line_items : [];
  const byVariant = new Map<string, LineIdRef>();
  for (const r of fallbackRefs) {
    if (r.variant_id && !byVariant.has(r.variant_id)) {
      byVariant.set(r.variant_id, r);
    }
  }
  const refs: LineIdRef[] = [];
  for (const l of lines) {
    const variant_id = nonEmptyStr(l?.item?.id) ?? nonEmptyStr(l?.variant_id);
    const fallback = variant_id ? byVariant.get(variant_id) : undefined;
    const product_id =
      nonEmptyStr(l?.item?.product_id) ??
      nonEmptyStr(l?.product_id) ??
      nonEmptyStr(l?.item?.item_id) ??
      fallback?.product_id ??
      null;
    const title =
      nonEmptyStr(l?.item?.title) ?? fallback?.title ?? variant_id ?? product_id ?? 'this item';
    if (variant_id || product_id) {
      refs.push({ variant_id, product_id, title });
    }
  }
  return refs;
}

function mergeLineRefs(a: readonly LineIdRef[], b: readonly LineIdRef[]): LineIdRef[] {
  const out: LineIdRef[] = [...a];
  const seen = new Set(a.map((r) => `${r.variant_id ?? ''}|${r.product_id ?? ''}`));
  for (const r of b) {
    const key = `${r.variant_id ?? ''}|${r.product_id ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function recordPlacedItems(
  placedItemsByStore: Map<string, PlacedStoreItems>,
  storeKey: string,
  refs: readonly LineIdRef[],
): void {
  if (!storeKey || refs.length === 0) return;
  let entry = placedItemsByStore.get(storeKey);
  if (!entry) {
    entry = { variantTitles: new Map(), productTitles: new Map() };
    placedItemsByStore.set(storeKey, entry);
  }
  for (const ref of refs) {
    if (ref.variant_id && !entry.variantTitles.has(ref.variant_id)) {
      entry.variantTitles.set(ref.variant_id, ref.title);
    }
    if (ref.product_id && !entry.productTitles.has(ref.product_id)) {
      entry.productTitles.set(ref.product_id, ref.title);
    }
  }
}

function findAlreadyOrderedTitle(
  placedItemsByStore: Map<string, PlacedStoreItems>,
  storeKey: string,
  refs: readonly LineIdRef[],
): string | null {
  if (!storeKey) return null;
  const entry = placedItemsByStore.get(storeKey);
  if (!entry) return null;
  for (const ref of refs) {
    if (ref.variant_id && entry.variantTitles.has(ref.variant_id)) {
      return ref.title || entry.variantTitles.get(ref.variant_id) || 'this item';
    }
    if (ref.product_id && entry.productTitles.has(ref.product_id)) {
      return ref.title || entry.productTitles.get(ref.product_id) || 'this item';
    }
  }
  return null;
}

export function deriveCheckoutIdempotencyUuid(
  idempotencyKey: string,
  storeDomain: string,
  checkoutId: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${idempotencyKey}|${storeDomain}|${checkoutId}`)
    .digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface ReviewedStoreRecord {
  store: string;
  store_domain: string;
  store_domain_key: string;
  cart_id: string | null;
  items: BagLine[];
  line_refs: LineIdRef[];
  total: number;
  reviewed_total_cents: number;
  reviewed_items_key: string;
  reviewed_price_items_key: string;
  payment_label: string;
  ready: boolean;
  already_sent: boolean;
  store_unclear: boolean;
  already_ordered_title: string | null;
  note?: string;
  checkout_id: string | null;
  cart_continue_url: string | null;
  checkout_continue_url: string | null;
  // Raw payment instrument object kept strictly in memory; never returned or logged, purged on L3.
  raw_instrument: Record<string, unknown> | null;
}

interface ReviewedOrderRecord {
  order_id: string;
  room: string | null;
  createdAtMs: number;
  total: number;
  totalCents: number;
  address_label?: string;
  stores: ReviewedStoreRecord[];
}

function parseOptionalCapUsd(envName: string, raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    if (!loggedInvalidCapVars.has(envName)) {
      loggedInvalidCapVars.add(envName);
      console.log(`[store] ignoring invalid ${envName}`);
    }
    return null;
  }
  return n;
}

export function _resetInvalidCapLogForTests(): void {
  loggedInvalidCapVars.clear();
}

export function parseMaxUsd(
  raw: string | undefined = process.env.ALICE_PURCHASE_MAX_USD,
): number | null {
  return parseOptionalCapUsd('ALICE_PURCHASE_MAX_USD', raw);
}

export function parseSessionMaxUsd(
  raw: string | undefined = process.env.ALICE_PURCHASE_SESSION_MAX_USD,
): number | null {
  return parseOptionalCapUsd('ALICE_PURCHASE_SESSION_MAX_USD', raw);
}

function roundUsd(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cartAddedToBagLines(cart: CartResult): BagLine[] {
  const added = Array.isArray(cart?.added) ? cart.added : [];
  return added.map((line: any) => ({
    title: typeof line?.title === 'string' && line.title ? line.title : String(line?.variant_id ?? ''),
    slot: typeof line?.slot === 'string' ? line.slot : 'item',
    image: typeof line?.image === 'string' ? line.image : '',
    price: Number.isFinite(Number(line?.price)) ? Number(line.price) : 0,
    ...(line?.size !== undefined ? { size: line.size } : {}),
  }));
}

function checkoutLinesToBagLines(checkout: any, cart: CartResult): BagLine[] {
  const lines = Array.isArray(checkout?.line_items) ? checkout.line_items : [];
  const bagByVariant = new Map<string, any>();
  for (const a of Array.isArray(cart?.added) ? cart.added : []) {
    const vid = typeof a?.variant_id === 'string' ? a.variant_id.trim() : '';
    if (vid && !bagByVariant.has(vid)) {
      bagByVariant.set(vid, a);
    }
  }

  const out: BagLine[] = [];
  for (const l of lines) {
    const vid = String(l?.item?.id ?? l?.variant_id ?? '').trim();
    const bagMatch = vid ? bagByVariant.get(vid) : undefined;
    const qty = Math.max(1, Math.round(Number(l?.quantity ?? 1)));
    const rawUnitCents =
      l?.item?.price !== undefined && l?.item?.price !== null ? Number(l.item.price) : NaN;
    let unitUsd = Number.isFinite(rawUnitCents) ? roundUsd(rawUnitCents / 100) : NaN;
    if (!Number.isFinite(unitUsd)) {
      const lineTotals = Array.isArray(l?.totals) ? l.totals : [];
      const lineTotalEntry =
        lineTotals.find((t: any) => t?.type === 'total') ??
        lineTotals.find((t: any) => t?.type === 'subtotal');
      const rawLineAmt =
        lineTotalEntry?.amount !== undefined && lineTotalEntry?.amount !== null
          ? Number(lineTotalEntry.amount)
          : NaN;
      unitUsd = Number.isFinite(rawLineAmt) ? roundUsd(rawLineAmt / 100 / qty) : 0;
    }

    const title =
      (typeof l?.item?.title === 'string' && l.item.title.trim()) ||
      (typeof bagMatch?.title === 'string' && bagMatch.title.trim()) ||
      vid;
    const image =
      (typeof l?.item?.image_url === 'string' && l.item.image_url.trim()) ||
      (typeof bagMatch?.image === 'string' ? bagMatch.image : '');
    const slot = typeof bagMatch?.slot === 'string' ? bagMatch.slot : 'item';
    const size = bagMatch?.size;

    for (let q = 0; q < qty; q += 1) {
      out.push({
        title,
        slot,
        image,
        price: unitUsd,
        ...(size !== undefined ? { size } : {}),
      });
    }
  }
  return out;
}

function buildBagVariantQtyKey(cart: CartResult): string {
  const added = Array.isArray(cart?.added) ? cart.added : [];
  if (added.length === 0) return '';
  const counts = new Map<string, number>();
  for (const line of added as any[]) {
    const vid = typeof line?.variant_id === 'string' ? line.variant_id.trim() : '';
    const qty =
      line?.quantity !== undefined && line?.quantity !== null
        ? Math.round(Number(line.quantity))
        : 1;
    if (!vid || !Number.isFinite(qty) || qty <= 0) return '';
    counts.set(vid, (counts.get(vid) ?? 0) + qty);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vid, qty]) => `${vid}|${qty}`)
    .join(';;');
}

function buildCheckoutVariantQtyKey(checkout: any): string {
  const lines = Array.isArray(checkout?.line_items) ? checkout.line_items : [];
  if (lines.length === 0) return '';
  const counts = new Map<string, number>();
  for (const l of lines) {
    const vid = String(l?.item?.id ?? l?.variant_id ?? '').trim();
    const qty = Math.round(Number(l?.quantity ?? 0));
    if (!vid || !Number.isFinite(qty) || qty <= 0) return '';
    counts.set(vid, (counts.get(vid) ?? 0) + qty);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vid, qty]) => `${vid}|${qty}`)
    .join(';;');
}

function buildCheckoutPriceItemsKey(checkout: any): string {
  const lines = Array.isArray(checkout?.line_items) ? checkout.line_items : [];
  if (lines.length === 0) return '';
  const parts: string[] = [];
  for (const l of lines) {
    const vid = String(l?.item?.id ?? l?.variant_id ?? '').trim();
    const qty = Math.round(Number(l?.quantity ?? 0));
    if (!vid || !Number.isFinite(qty) || qty <= 0) return '';
    const unitCents =
      l?.item?.price !== undefined && l?.item?.price !== null
        ? Math.round(Number(l.item.price))
        : '';
    parts.push(`${vid}|${qty}|${unitCents}`);
  }
  return parts.sort().join(';;');
}

interface CheckoutTotalCheck {
  finalTotalCents: number | null;
  displayCents: number | null;
  hasFinalTotal: boolean;
  currencyIsUsd: boolean;
}

function isUsdCode(val: unknown): boolean {
  return typeof val === 'string' && val.trim().toUpperCase() === 'USD';
}

function inspectCheckoutTotal(checkout: any): CheckoutTotalCheck {
  const totals = Array.isArray(checkout?.totals) ? checkout.totals : [];
  const totalEntry = totals.find((t: any) => t?.type === 'total');
  const subtotalEntry = totals.find((t: any) => t?.type === 'subtotal');

  const checkoutCurrencyOk = isUsdCode(checkout?.currency);
  const totalEntryCurrencyOk =
    totalEntry?.currency === undefined ||
    totalEntry?.currency === null ||
    isUsdCode(totalEntry.currency);
  const allTotalsCurrencyOk = totals.every(
    (t: any) => t?.currency === undefined || t?.currency === null || isUsdCode(t.currency),
  );
  const currencyIsUsd = checkoutCurrencyOk && totalEntryCurrencyOk && allTotalsCurrencyOk;

  const rawTotal = totalEntry?.amount;
  const parsedTotal = rawTotal !== undefined && rawTotal !== null ? Number(rawTotal) : NaN;
  const hasFinalTotal = Number.isFinite(parsedTotal) && parsedTotal >= 0;
  const finalTotalCents = hasFinalTotal ? Math.round(parsedTotal) : null;

  const rawSub = subtotalEntry?.amount;
  const parsedSub = rawSub !== undefined && rawSub !== null ? Number(rawSub) : NaN;
  const displayCents =
    finalTotalCents !== null
      ? finalTotalCents
      : Number.isFinite(parsedSub) && parsedSub >= 0
        ? Math.round(parsedSub)
        : null;

  return {
    finalTotalCents,
    displayCents,
    hasFinalTotal,
    currencyIsUsd,
  };
}

function buildShortAddressLabel(address: any): string | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const city =
    typeof address.address_locality === 'string' ? address.address_locality.trim() : '';
  const region =
    typeof address.address_region === 'string' ? address.address_region.trim() : '';
  const country =
    typeof address.address_country === 'string' ? address.address_country.trim() : '';

  if (city && region) return `${city}, ${region}`;
  if (city) return city;
  if (region && country) return `${region}, ${country}`;
  if (country) return country;
  return undefined;
}

function getSelectedCheckoutDestination(checkout: any): Record<string, unknown> | null {
  const methods = checkout?.fulfillment?.methods;
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const method = methods[0];
  const selectedId =
    typeof method?.selected_destination_id === 'string' && method.selected_destination_id.trim()
      ? method.selected_destination_id.trim()
      : null;
  if (!selectedId) return null;
  const destinations = Array.isArray(method?.destinations) ? method.destinations : [];
  const found = destinations.find(
    (d: any) => d && typeof d === 'object' && String(d.id ?? '').trim() === selectedId,
  );
  return found ?? null;
}

function normAddrField(val: unknown): string {
  return typeof val === 'string' ? val.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function destinationMatchesDefaultAddress(
  selectedDest: Record<string, unknown> | null,
  defaultAddress: Record<string, unknown> | null,
): boolean {
  if (!selectedDest || !defaultAddress) return false;
  const destId = normAddrField(selectedDest.id);
  const defId = normAddrField(defaultAddress.id);
  if (!destId || !defId || destId !== defId) return false;

  for (const field of [
    'street_address',
    'address_locality',
    'address_region',
    'postal_code',
    'address_country',
  ]) {
    const a = normAddrField(selectedDest[field]);
    const b = normAddrField(defaultAddress[field]);
    if ((a || b) && a !== b) {
      return false;
    }
  }
  return true;
}

function isShopPayInstrument(inst: any): boolean {
  if (!inst || typeof inst !== 'object') return false;
  const type = String(inst.type ?? '').toLowerCase();
  const handlerId = String(inst.handler_id ?? '').toLowerCase();
  return type === 'shop_pay' || handlerId === 'shop_pay';
}

function selectShopPayIfAlreadyChosen(
  checkout: any,
  preferredInstrumentId: string | null,
): { instrument: Record<string, unknown> | null; paymentLabel: string; note?: string } {
  const instruments = Array.isArray(checkout?.payment?.instruments)
    ? checkout.payment.instruments.filter((i: any) => i && typeof i === 'object')
    : [];

  if (instruments.length === 0) {
    return {
      instrument: null,
      paymentLabel: '',
      note: 'No saved payment method is offered for this store; finish on the store page.',
    };
  }

  // Never choose between instruments: use Shop Pay ONLY if it is already selected/default
  // (or the sole offered instrument without a conflicting preference).
  const explicitlySelected = instruments.filter(
    (i: any) => i.selected === true || i.default === true || i.is_default === true,
  );
  if (explicitlySelected.length === 1) {
    const chosen = explicitlySelected[0];
    if (isShopPayInstrument(chosen)) {
      return { instrument: { ...chosen }, paymentLabel: 'Shop Pay' };
    }
    return {
      instrument: null,
      paymentLabel: '',
      note: 'Selected payment method is not Shop Pay; finish on the store page.',
    };
  }
  if (explicitlySelected.length > 1) {
    return {
      instrument: null,
      paymentLabel: '',
      note: 'Multiple payment methods are marked; choose one on the store page.',
    };
  }

  if (preferredInstrumentId) {
    const preferred = instruments.find((i: any) => i.id === preferredInstrumentId);
    if (preferred) {
      if (isShopPayInstrument(preferred)) {
        return { instrument: { ...preferred }, paymentLabel: 'Shop Pay' };
      }
      return {
        instrument: null,
        paymentLabel: '',
        note: 'Default payment method is not Shop Pay; finish on the store page.',
      };
    }
  }

  if (instruments.length === 1) {
    if (isShopPayInstrument(instruments[0])) {
      return { instrument: { ...instruments[0] }, paymentLabel: 'Shop Pay' };
    }
    return {
      instrument: null,
      paymentLabel: '',
      note: 'Shop Pay is not available for this store; finish on the store page.',
    };
  }

  return {
    instrument: null,
    paymentLabel: '',
    note: 'Multiple payment methods are available; choose one on the store page.',
  };
}

function cloneCheckoutForUpdate(checkout: any): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(checkout ?? {})) as Record<string, any>;
  // Per checkout.md & tools.md: remove root next, signals, and attribution before update_checkout.
  delete copy.next;
  delete copy.signals;
  delete copy.attribution;
  return copy;
}

function applySavedAddressToCheckout(
  checkout: any,
  savedAddress: Record<string, unknown>,
): Record<string, any> {
  const doc = cloneCheckoutForUpdate(checkout);
  const addressId = String(savedAddress.id ?? '');
  if (!doc.fulfillment || typeof doc.fulfillment !== 'object') {
    doc.fulfillment = { methods: [] };
  }
  if (!Array.isArray(doc.fulfillment.methods) || doc.fulfillment.methods.length === 0) {
    doc.fulfillment.methods = [{ type: 'shipping', destinations: [] }];
  }

  const method = doc.fulfillment.methods[0];
  if (!Array.isArray(method.destinations)) {
    method.destinations = [];
  }
  const alreadyPresent = method.destinations.some(
    (d: any) => d && typeof d === 'object' && String(d.id ?? '') === addressId && addressId !== '',
  );
  if (!alreadyPresent) {
    // Copy saved address unchanged per checkout.md; never alter fields or copy buyer.email.
    method.destinations.push(JSON.parse(JSON.stringify(savedAddress)));
  }
  if (addressId) {
    method.selected_destination_id = addressId;
  }
  return doc;
}

function trySelectSingleDeliveryOption(checkout: any): Record<string, any> | null {
  const methods = checkout?.fulfillment?.methods;
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const groups = methods[0]?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;

  let changed = false;
  const doc = cloneCheckoutForUpdate(checkout);
  const docGroups = doc.fulfillment.methods[0].groups;
  for (const group of docGroups) {
    if (!group?.selected_option_id && Array.isArray(group?.options) && group.options.length === 1) {
      const optId = group.options[0]?.id;
      if (typeof optId === 'string' && optId) {
        group.selected_option_id = optId;
        changed = true;
      }
    }
  }
  return changed ? doc : null;
}

function extractCheckoutNote(checkout: any): string | undefined {
  const msgs = Array.isArray(checkout?.messages) ? checkout.messages : [];
  const text = msgs
    .map((m: any) => String(m?.content ?? m?.message ?? m?.text ?? '').trim())
    .filter(Boolean)
    .join('; ');
  return text ? text.slice(0, 200) : undefined;
}

function extractOrderNumber(checkout: any): string | undefined {
  const order = checkout?.order;
  const candidates = [
    order && typeof order === 'object' ? order.order_number : undefined,
    order && typeof order === 'object' ? order.number : undefined,
    order && typeof order === 'object' ? order.name : undefined,
    order && typeof order === 'object' ? order.confirmation_number : undefined,
    order && typeof order === 'object' ? order.id : undefined,
    checkout?.confirmation_number,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (s.length > 0) return s;
  }
  return undefined;
}

function hasOrderProof(doc: any): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (extractOrderNumber(doc)) return true;
  if (doc.order && typeof doc.order === 'object' && Object.keys(doc.order).length > 0) return true;
  return false;
}

function isDefiniteRefusalDoc(doc: any): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (hasOrderProof(doc)) return false;
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  return DEFINITE_REFUSAL_STATUSES.has(status);
}

function toHandoffOrderReview(
  record: ReviewedOrderRecord,
  note: string,
  status: 'handoff' | 'failed' = 'handoff',
  includeLinks = true,
): OrderReview {
  return {
    order_id: record.order_id,
    stores: record.stores.map((s) => ({
      store: s.store,
      items: s.items,
      total: s.total,
      payment_label: s.payment_label,
      ready: false,
      status,
      ...(includeLinks && !s.already_sent && !s.store_unclear && (s.cart_continue_url || s.checkout_continue_url)
        ? { continue_url: s.cart_continue_url ?? s.checkout_continue_url ?? undefined }
        : {}),
      note: s.already_sent
        ? ALREADY_SENT_NOTE
        : s.store_unclear
          ? buildStoreUnclearNote(s.store)
          : s.already_ordered_title
            ? buildAlreadyOrderedNote(s.already_ordered_title)
            : note,
    })),
    total: record.total,
    ...(record.address_label ? { address_label: record.address_label } : {}),
  };
}

function bagToHandoffReview(bag: BagOut, note: string): PrepareOrderResult {
  const stores: OrderStore[] = (Array.isArray(bag?.carts) ? bag.carts : []).map((cart) => {
    const items = cartAddedToBagLines(cart);
    const total =
      typeof cart.total_usd === 'number' && Number.isFinite(cart.total_usd)
        ? roundUsd(cart.total_usd)
        : roundUsd(items.reduce((s, l) => s + l.price, 0));
    return {
      store: cart.store,
      items,
      total,
      payment_label: '',
      ready: false,
      status: 'handoff',
      ...(cart.continue_url ? { continue_url: cart.continue_url } : {}),
      note,
    };
  });
  return {
    order_id: '',
    stores,
    total: roundUsd(stores.reduce((s, st) => s + st.total, 0)),
  };
}

export function createPurchaseClient(deps?: PurchaseDeps): PurchaseClient {
  const mcp = deps?.mcp ?? shopMcp;
  const auth = deps?.auth ?? defaultAuth;
  const now = deps?.now ?? (() => Date.now());
  const purchaseOn = deps?.isPurchaseEnabled ?? isPurchaseEnabled;
  const getMaxUsd = (): number | null => {
    const raw = deps?.maxUsd ? deps.maxUsd() : parseMaxUsd();
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  };
  const getSessionMaxUsd = (): number | null => {
    const raw = deps?.sessionMaxUsd ? deps.sessionMaxUsd() : parseSessionMaxUsd();
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  };
  const getRoom = deps?.getRoom ?? getCallRoom;
  const isHarnessEnv =
    deps?.isHarnessEnv ??
    (() => Boolean(process.env.ALICE_HARNESS && process.env.ALICE_HARNESS.trim()));
  const randomId = deps?.randomId ?? (() => crypto.randomUUID());
  const reconcileDelaysMs = deps?.reconcileDelaysMs ?? DEFAULT_RECONCILE_DELAYS_MS;

  // Sent cart/checkout sets, unclear stores, and placed items survive signOut() and endCall() (H1, H2, M2, R1, R2).
  const sentCartIds = deps?.sentCartIds ?? new Set<string>();
  const sentCheckoutIds = deps?.sentCheckoutIds ?? new Set<string>();
  const unclearStores = deps?.unclearStores ?? new Set<string>();
  const placedItemsByStore = deps?.placedItemsByStore ?? new Map<string, PlacedStoreItems>();

  // Pending reviews hold raw instruments temporarily and are purged on place, supersede, expiry, or signOut (L3).
  const reviewedOrders = new Map<string, ReviewedOrderRecord>();
  // Safe finalized results (no raw instruments/secrets) for one-attempt-ever idempotency.
  const placedResults = new Map<string, OrderReview>();
  const inProgressAttempts = new Map<string, Promise<OrderReview>>();
  const supersededOrderIds = new Set<string>();
  let sessionSpentCents = 0;

  function purgeOrderRecord(orderId: string): void {
    const rec = reviewedOrders.get(orderId);
    if (!rec) return;
    for (const s of rec.stores) {
      s.raw_instrument = null;
    }
    rec.stores = [];
    reviewedOrders.delete(orderId);
  }

  function purgeAllReviews(): void {
    for (const id of [...reviewedOrders.keys()]) {
      purgeOrderRecord(id);
    }
  }

  function purgeExpiredOrders(exceptOrderId?: string): void {
    const current = now();
    for (const [id, rec] of [...reviewedOrders.entries()]) {
      if (id === exceptOrderId) continue;
      if (current - rec.createdAtMs >= ORDER_REVIEW_MAX_AGE_MS) {
        purgeOrderRecord(id);
      }
    }
  }

  // M2 & L3: signOut clears every reviewed order and resets per-sign-in spend,
  // while sentCartIds / sentCheckoutIds intentionally remain.
  auth.onSignOut(() => {
    purgeAllReviews();
    sessionSpentCents = 0;
  });

  function endCall(): void {
    auth.signOut();
    purgeAllReviews();
    supersededOrderIds.clear();
    sessionSpentCents = 0;
  }

  function safeMessage(msg: string): string {
    return redactSecrets(msg, auth.getSecretsForRedaction());
  }

  // The SINGLE function authorized to call `complete_checkout`.
  async function executeCompleteCheckoutOnce(
    storeDomain: string,
    checkoutId: string,
    rawInstrument: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<any> {
    // Per checkout.md ("Send complete_checkout once, with the chosen instrument copied
    // exactly as returned and selected set to true."): copy verbatim and set selected: true.
    const instrumentWithSelected = {
      ...JSON.parse(JSON.stringify(rawInstrument)),
      selected: true,
    };
    return mcp.call(
      'complete_checkout',
      {
        shop: storeDomain,
        id: checkoutId,
        checkout: {
          payment: {
            instruments: [instrumentWithSelected],
          },
        },
        meta: {
          'idempotency-key': idempotencyKey,
        },
      },
      {
        timeoutMs: COMPLETE_TIMEOUT_MS,
        authenticated: true,
        [COMPLETE_CHECKOUT_GUARD]: true,
      },
    );
  }

  async function buildSignInResponse(): Promise<PrepareOrderResult> {
    const started = await auth.startSignIn();
    if (started.error || !started.url) {
      return {
        order_id: '',
        stores: [],
        total: 0,
        needs_sign_in: true,
      };
    }
    return {
      order_id: '',
      stores: [],
      total: 0,
      needs_sign_in: true,
      sign_in: {
        url: started.url,
        ...(started.code ? { code: started.code } : {}),
      },
    };
  }

  async function prepareOrder(bag: BagOut): Promise<PrepareOrderResult> {
    const t0 = now();
    purgeExpiredOrders();

    if (!purchaseOn()) {
      return {
        order_id: '',
        stores: [],
        total: 0,
        disabled: true,
      };
    }

    const currentRoom = getRoom();
    if (auth.signInStatus() !== 'signed_in' || !auth.getToken()) {
      return buildSignInResponse();
    }

    // M2: sign-in is tied to the call room; refuse from any other room.
    const signedInRoom = auth.getSignedInRoom();
    if (!currentRoom || !signedInRoom || signedInRoom !== currentRoom) {
      logEvent('order_refused', { order_id: '', reason: 'room_mismatch' });
      return bagToHandoffReview(
        bag,
        'Shop sign-in belongs to another call; finish on the store page.',
      );
    }

    // H1: supersede every earlier unplaced reviewed order that shares any cart_id with this bag.
    const carts = Array.isArray(bag?.carts) ? bag.carts : [];
    const incomingCartIds = new Set(
      carts
        .map((c) => (typeof c?.cart_id === 'string' ? c.cart_id.trim() : ''))
        .filter(Boolean),
    );
    if (incomingCartIds.size > 0) {
      for (const [oldId, oldRec] of [...reviewedOrders.entries()]) {
        const sharesCart = oldRec.stores.some(
          (st) => st.cart_id !== null && incomingCartIds.has(st.cart_id),
        );
        if (sharesCart) {
          supersededOrderIds.add(oldId);
          purgeOrderRecord(oldId);
        }
      }
    }

    // Skip all MCP calls if every cart is already blocked (sent cart, unclear store, or already-ordered item).
    const anyActionableCart = carts.some((c) => {
      const cid = typeof c?.cart_id === 'string' ? c.cart_id.trim() : '';
      if (!cid || sentCartIds.has(cid)) return false;
      const storeKey = normalizeStoreDomain(c?.store_domain);
      if (storeKey && unclearStores.has(storeKey)) return false;
      const cartRefs = extractCartLineRefs(c);
      if (storeKey && findAlreadyOrderedTitle(placedItemsByStore, storeKey, cartRefs)) return false;
      return true;
    });

    let account: any = null;
    if (anyActionableCart) {
      try {
        account = await mcp.call(
          'get_account',
          {},
          { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
        );
      } catch (err) {
        if (err instanceof ShopMcpError && (err.code === 'auth' || err.status === 401)) {
          auth.invalidateToken('invalid');
          return buildSignInResponse();
        }
        return bagToHandoffReview(
          bag,
          'Could not read your Shop account; finish on the store page.',
        );
      }
    }

    const addresses: any[] = Array.isArray(account?.addresses) ? account.addresses : [];
    const preferredAddressId =
      typeof account?.preferred_address_id === 'string' && account.preferred_address_id
        ? account.preferred_address_id
        : null;
    const defaultAddress: Record<string, unknown> | null = preferredAddressId
      ? (addresses.find((a) => a && a.id === preferredAddressId) ?? null)
      : addresses.length === 1
        ? addresses[0]
        : null;
    const preferredInstrumentId =
      typeof account?.preferred_instrument_id === 'string' && account.preferred_instrument_id
        ? account.preferred_instrument_id
        : null;

    const storeRecords: ReviewedStoreRecord[] = [];
    let derivedAddressLabel: string | undefined;

    for (const cart of carts) {
      const bagItems = cartAddedToBagLines(cart);
      const cartLineRefs = extractCartLineRefs(cart);
      const bagItemsKey = buildBagVariantQtyKey(cart);
      const storeDomainKey = normalizeStoreDomain(cart.store_domain);
      const fallbackTotal =
        typeof cart.total_usd === 'number' && Number.isFinite(cart.total_usd)
          ? roundUsd(cart.total_usd)
          : roundUsd(bagItems.reduce((s, l) => s + l.price, 0));
      const cartId = typeof cart.cart_id === 'string' && cart.cart_id.trim() ? cart.cart_id.trim() : null;

      // H1 & H2: never create a second checkout for a cart whose complete_checkout was already sent.
      if (cartId && sentCartIds.has(cartId)) {
        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: cartId,
          items: bagItems,
          line_refs: cartLineRefs,
          total: fallbackTotal,
          reviewed_total_cents: Math.round(fallbackTotal * 100),
          reviewed_items_key: '',
          reviewed_price_items_key: '',
          payment_label: '',
          ready: false,
          already_sent: true,
          store_unclear: false,
          already_ordered_title: null,
          note: ALREADY_SENT_NOTE,
          checkout_id: null,
          cart_continue_url: null,
          checkout_continue_url: null,
          raw_instrument: null,
        });
        continue;
      }

      // R1: store has an UNKNOWN payment outcome in this call -> refuse ANY cart for this store with NO link.
      if (storeDomainKey && unclearStores.has(storeDomainKey)) {
        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: cartId,
          items: bagItems,
          line_refs: cartLineRefs,
          total: fallbackTotal,
          reviewed_total_cents: Math.round(fallbackTotal * 100),
          reviewed_items_key: '',
          reviewed_price_items_key: '',
          payment_label: '',
          ready: false,
          already_sent: false,
          store_unclear: true,
          already_ordered_title: null,
          note: buildStoreUnclearNote(cart.store),
          checkout_id: null,
          cart_continue_url: null,
          checkout_continue_url: null,
          raw_instrument: null,
        });
        continue;
      }

      // R2: cart contains a variant or product already placed at this store in this call -> hand off with store link.
      const alreadyOrderedTitle = findAlreadyOrderedTitle(
        placedItemsByStore,
        storeDomainKey,
        cartLineRefs,
      );
      if (alreadyOrderedTitle) {
        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: cartId,
          items: bagItems,
          line_refs: cartLineRefs,
          total: fallbackTotal,
          reviewed_total_cents: Math.round(fallbackTotal * 100),
          reviewed_items_key: '',
          reviewed_price_items_key: '',
          payment_label: '',
          ready: false,
          already_sent: false,
          store_unclear: false,
          already_ordered_title: alreadyOrderedTitle,
          note: buildAlreadyOrderedNote(alreadyOrderedTitle),
          checkout_id: null,
          cart_continue_url: cart.continue_url ?? null,
          checkout_continue_url: null,
          raw_instrument: null,
        });
        continue;
      }

      if (!cartId) {
        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: null,
          items: bagItems,
          line_refs: cartLineRefs,
          total: fallbackTotal,
          reviewed_total_cents: Math.round(fallbackTotal * 100),
          reviewed_items_key: '',
          reviewed_price_items_key: '',
          payment_label: '',
          ready: false,
          already_sent: false,
          store_unclear: false,
          already_ordered_title: null,
          note: 'No cart ID available; finish on the store page.',
          checkout_id: null,
          cart_continue_url: cart.continue_url ?? null,
          checkout_continue_url: null,
          raw_instrument: null,
        });
        continue;
      }

      try {
        // Per checkout.md & tools.md: create checkout from cart_id with required line_items: []
        let checkout = await mcp.call(
          'create_checkout',
          {
            shop: cart.store_domain,
            checkout: {
              cart_id: cartId,
              line_items: [],
            },
            meta: {
              'idempotency-key': randomId(),
            },
          },
          { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
        );

        const checkoutId = typeof checkout?.id === 'string' && checkout.id ? checkout.id : null;
        if (!checkoutId) {
          storeRecords.push({
            store: cart.store,
            store_domain: cart.store_domain,
            store_domain_key: storeDomainKey,
            cart_id: cartId,
            items: bagItems,
            line_refs: cartLineRefs,
            total: fallbackTotal,
            reviewed_total_cents: Math.round(fallbackTotal * 100),
            reviewed_items_key: '',
            reviewed_price_items_key: '',
            payment_label: '',
            ready: false,
            already_sent: false,
            store_unclear: false,
            already_ordered_title: null,
            note: 'Could not open store checkout; finish on the store page.',
            checkout_id: null,
            cart_continue_url: cart.continue_url ?? null,
            checkout_continue_url: null,
            raw_instrument: null,
          });
          continue;
        }

        // H1: if the store returned a checkout id already sent earlier, refuse with no link.
        if (sentCheckoutIds.has(checkoutId)) {
          storeRecords.push({
            store: cart.store,
            store_domain: cart.store_domain,
            store_domain_key: storeDomainKey,
            cart_id: cartId,
            items: bagItems,
            line_refs: cartLineRefs,
            total: fallbackTotal,
            reviewed_total_cents: Math.round(fallbackTotal * 100),
            reviewed_items_key: '',
            reviewed_price_items_key: '',
            payment_label: '',
            ready: false,
            already_sent: true,
            store_unclear: false,
            already_ordered_title: null,
            note: ALREADY_SENT_NOTE,
            checkout_id: checkoutId,
            cart_continue_url: null,
            checkout_continue_url: null,
            raw_instrument: null,
          });
          continue;
        }

        // Apply saved default address unchanged if checkout needs delivery details
        const hasDestination = Boolean(getSelectedCheckoutDestination(checkout));
        if (defaultAddress && (checkout.status === 'incomplete' || !hasDestination)) {
          const edited = applySavedAddressToCheckout(checkout, defaultAddress);
          checkout = await mcp.call(
            'update_checkout',
            {
              shop: cart.store_domain,
              id: checkoutId,
              checkout: edited,
              meta: {
                'idempotency-key': randomId(),
              },
            },
            { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
          );
        }

        // If still incomplete only because a single unambiguous shipping option isn't selected
        if (checkout?.status === 'incomplete') {
          const withOption = trySelectSingleDeliveryOption(checkout);
          if (withOption) {
            checkout = await mcp.call(
              'update_checkout',
              {
                shop: cart.store_domain,
                id: checkoutId,
                checkout: withOption,
                meta: {
                  'idempotency-key': randomId(),
                },
              },
              { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
            );
          }
        }

        // M3 & M4: build review items & total from the CHECKOUT and require exact match with bag.
        const checkoutItems = checkoutLinesToBagLines(checkout, cart);
        const checkoutItemsKey = buildCheckoutVariantQtyKey(checkout);
        const checkoutPriceItemsKey = buildCheckoutPriceItemsKey(checkout);
        const itemsNonEmpty = checkoutItemsKey.length > 0 && checkoutPriceItemsKey.length > 0;
        const itemsMatchBag = itemsNonEmpty && bagItemsKey.length > 0 && checkoutItemsKey === bagItemsKey;

        const totalCheck = inspectCheckoutTotal(checkout);
        const displayCents = totalCheck.displayCents ?? Math.round(fallbackTotal * 100);
        const totalUsd = roundUsd(displayCents / 100);
        const checkoutContinueUrl =
          typeof checkout?.continue_url === 'string' && checkout.continue_url
            ? checkout.continue_url
            : null;

        // M7: derive address_label strictly from the checkout's actual selected destination,
        // and verify it matches the shopper's saved default address.
        const selectedDest = getSelectedCheckoutDestination(checkout);
        const destLabel = buildShortAddressLabel(selectedDest);
        if (!derivedAddressLabel && destLabel) {
          derivedAddressLabel = destLabel;
        }
        const addressOk = destinationMatchesDefaultAddress(selectedDest, defaultAddress);

        const paymentPick = selectShopPayIfAlreadyChosen(checkout, preferredInstrumentId);
        const isReadyStatus = checkout?.status === 'ready_for_complete';
        const finalTotalValid =
          totalCheck.hasFinalTotal &&
          totalCheck.finalTotalCents !== null &&
          totalCheck.currencyIsUsd;

        const mergedLineRefs = mergeLineRefs(
          cartLineRefs,
          extractCheckoutLineRefs(checkout, cartLineRefs),
        );
        const checkoutAlreadyOrderedTitle = findAlreadyOrderedTitle(
          placedItemsByStore,
          storeDomainKey,
          mergedLineRefs,
        );

        const ready =
          !checkoutAlreadyOrderedTitle &&
          isReadyStatus &&
          itemsNonEmpty &&
          itemsMatchBag &&
          finalTotalValid &&
          addressOk &&
          paymentPick.instrument !== null;

        let note: string | undefined;
        if (!ready) {
          if (checkoutAlreadyOrderedTitle) {
            note = buildAlreadyOrderedNote(checkoutAlreadyOrderedTitle);
          } else if (!isReadyStatus) {
            if (!defaultAddress && checkout?.status === 'incomplete') {
              note = 'No default saved shipping address; finish on the store page.';
            } else if (checkout?.status === 'requires_escalation') {
              note =
                extractCheckoutNote(checkout) ||
                'Store requires confirmation on its checkout page.';
            } else {
              note =
                extractCheckoutNote(checkout) ||
                'Checkout is not ready for one-tap purchase; finish on the store page.';
            }
          } else if (!itemsNonEmpty) {
            note = 'Checkout has no items; finish on the store page.';
          } else if (!itemsMatchBag) {
            note = "Store checkout items don't match your bag; finish on the store page.";
          } else if (!finalTotalValid) {
            note = TOTAL_NOT_FINAL_NOTE;
          } else if (!addressOk) {
            note = "Checkout shipping address doesn't match your default address; finish on the store page.";
          } else {
            note = paymentPick.note;
          }
        }

        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: cartId,
          items: checkoutItems.length > 0 ? checkoutItems : bagItems,
          line_refs: mergedLineRefs,
          total: totalUsd,
          reviewed_total_cents: totalCheck.finalTotalCents ?? displayCents,
          reviewed_items_key: checkoutItemsKey,
          reviewed_price_items_key: checkoutPriceItemsKey,
          payment_label: paymentPick.paymentLabel,
          ready,
          already_sent: false,
          store_unclear: false,
          already_ordered_title: checkoutAlreadyOrderedTitle,
          ...(note ? { note: safeMessage(note) } : {}),
          checkout_id: checkoutId,
          cart_continue_url: cart.continue_url ?? null,
          checkout_continue_url: checkoutContinueUrl,
          raw_instrument: ready ? paymentPick.instrument : null,
        });
      } catch (err) {
        if (err instanceof ShopMcpError && (err.code === 'auth' || err.status === 401)) {
          auth.invalidateToken('invalid');
          return buildSignInResponse();
        }
        storeRecords.push({
          store: cart.store,
          store_domain: cart.store_domain,
          store_domain_key: storeDomainKey,
          cart_id: cartId,
          items: bagItems,
          line_refs: cartLineRefs,
          total: fallbackTotal,
          reviewed_total_cents: Math.round(fallbackTotal * 100),
          reviewed_items_key: '',
          reviewed_price_items_key: '',
          payment_label: '',
          ready: false,
          already_sent: false,
          store_unclear: false,
          already_ordered_title: null,
          note: 'Could not prepare checkout; finish on the store page.',
          checkout_id: null,
          cart_continue_url: cart.continue_url ?? null,
          checkout_continue_url: null,
          raw_instrument: null,
        });
      }
    }

    const totalCents = storeRecords.reduce((s, r) => s + r.reviewed_total_cents, 0);
    const total = roundUsd(totalCents / 100);
    const orderId = randomId();

    const record: ReviewedOrderRecord = {
      order_id: orderId,
      room: currentRoom,
      createdAtMs: now(),
      total,
      totalCents,
      ...(derivedAddressLabel ? { address_label: derivedAddressLabel } : {}),
      stores: storeRecords,
    };
    reviewedOrders.set(orderId, record);

    const reviewStores: OrderStore[] = storeRecords.map((s) => ({
      store: s.store,
      items: s.items,
      total: s.total,
      payment_label: s.payment_label,
      ready: s.ready,
      status: s.ready ? 'review' : 'handoff',
      ...(!s.already_sent && !s.store_unclear && (s.checkout_continue_url || s.cart_continue_url)
        ? { continue_url: s.checkout_continue_url ?? s.cart_continue_url ?? undefined }
        : {}),
      ...(s.note ? { note: s.note } : {}),
    }));

    const ms = Math.max(0, now() - t0);
    logEvent('order_prepare', {
      order_id: orderId,
      stores: reviewStores.map((s) => ({ store: s.store, total: s.total, ready: s.ready })),
      ms,
    });

    return {
      order_id: orderId,
      stores: reviewStores,
      total,
      ...(derivedAddressLabel ? { address_label: derivedAddressLabel } : {}),
    };
  }

  async function placeOrder(orderId: string, opts: PlaceOrderOptions): Promise<OrderReview> {
    const t0 = now();
    purgeExpiredOrders(orderId);

    // 1. One attempt per order_id, ever: return the first call's result with zero new calls.
    const existingResult = placedResults.get(orderId);
    if (existingResult) {
      return existingResult;
    }
    const existingPromise = inProgressAttempts.get(orderId);
    if (existingPromise) {
      return existingPromise;
    }

    // H1: superseded by a newer prepareOrder sharing a cart_id
    if (supersededOrderIds.has(orderId)) {
      logEvent('order_refused', { order_id: orderId, reason: 'order_superseded' });
      return { order_id: orderId, stores: [], total: 0 };
    }

    const record = reviewedOrders.get(orderId);

    // Helper for pre-flight refusals (ZERO network calls)
    const refuse = (
      reason: string,
      note: string,
      status: 'handoff' | 'failed' = 'handoff',
      includeLinks = true,
    ): OrderReview => {
      logEvent('order_refused', { order_id: orderId, reason });
      if (!record) {
        return { order_id: orderId, stores: [], total: 0 };
      }
      return toHandoffOrderReview(record, note, status, includeLinks);
    };

    // 2. Switch must be strictly 'on' at call time.
    if (!purchaseOn()) {
      return refuse(
        'purchase_disabled',
        'In-call purchasing is turned off; finish on the store page.',
        'handoff',
      );
    }

    // 3. Reviewed order must exist.
    if (!record) {
      return refuse('order_not_found', 'Order review not found.');
    }

    // 4. Order review must be under 2 minutes old (L3: purge immediately if expired).
    if (now() - record.createdAtMs >= ORDER_REVIEW_MAX_AGE_MS) {
      const expiredReview = refuse(
        'order_expired',
        'Order review expired after 2 minutes; review again or finish on the store page.',
      );
      purgeOrderRecord(orderId);
      return expiredReview;
    }

    // 5. Must be explicitly confirmed by shopper tap.
    if (opts?.confirmedByTap !== true) {
      return refuse(
        'not_confirmed_by_tap',
        'Tap Confirm on the screen before placing the order.',
      );
    }

    // 6. Idempotency key required.
    const idempotencyKey =
      typeof opts?.idempotencyKey === 'string' ? opts.idempotencyKey.trim() : '';
    if (!idempotencyKey) {
      return refuse('missing_idempotency_key', 'Missing order confirmation key.');
    }

    // 7. M1: strict room gate — ONLY from getCallRoom() (ignore opts.room!), fail closed.
    if (isHarnessEnv()) {
      return refuse(
        'harness_env_set',
        'Real purchases are blocked while ALICE_HARNESS is set; finish on the store page.',
      );
    }
    const room = (getRoom() ?? '').trim();
    if (!room || !VALID_ROOM_RE.test(room)) {
      return refuse(
        'invalid_or_missing_room',
        'Real purchases are only allowed in a live shopper room; finish on the store page.',
      );
    }

    // 8. M2: must still be signed in with a valid unexpired token bound to THIS room.
    if (auth.signInStatus() !== 'signed_in' || !auth.getToken()) {
      return refuse(
        'not_signed_in',
        'Shop sign-in expired or missing; sign in again or finish on the store page.',
      );
    }
    if (auth.getSignedInRoom() !== room || record.room !== room) {
      return refuse(
        'room_mismatch',
        'Shop sign-in does not match this call; finish on the store page.',
      );
    }

    // 9. H1: refuse with zero network calls if any ready store's cart/checkout was already sent.
    const hasAlreadySentStore = record.stores.some(
      (s) =>
        s.already_sent ||
        (s.cart_id !== null && sentCartIds.has(s.cart_id)) ||
        (s.checkout_id !== null && sentCheckoutIds.has(s.checkout_id)),
    );
    if (hasAlreadySentStore) {
      for (const s of record.stores) {
        if (
          (s.cart_id !== null && sentCartIds.has(s.cart_id)) ||
          (s.checkout_id !== null && sentCheckoutIds.has(s.checkout_id))
        ) {
          s.already_sent = true;
        }
      }
      return refuse('already_sent', ALREADY_SENT_NOTE, 'handoff', false);
    }

    // 10. Optional spend caps (no default cap when unset; enforced when set to a positive number).
    const maxUsd = getMaxUsd();
    if (maxUsd !== null && record.totalCents > Math.round(maxUsd * 100)) {
      return refuse(
        'exceeds_max_usd',
        `Order total ($${record.total.toFixed(2)}) exceeds the $${maxUsd.toFixed(2)} in-call limit; finish on the store page.`,
      );
    }
    const sessionMaxUsd = getSessionMaxUsd();
    if (
      sessionMaxUsd !== null &&
      sessionSpentCents + record.totalCents > Math.round(sessionMaxUsd * 100)
    ) {
      return refuse(
        'exceeds_session_max_usd',
        `This order would exceed the $${sessionMaxUsd.toFixed(2)} session purchase limit; finish on the store page.`,
      );
    }

    // Snapshot store records and lock synchronously BEFORE first await.
    const storesSnapshot = record.stores.slice();
    const recordTotal = record.total;
    const recordAddressLabel = record.address_label;

    const placementPromise = (async (): Promise<OrderReview> => {
      const finalStores: OrderStore[] = [];
      const loggedStores: Array<{ store: string; status: string; order_number?: string }> = [];

      // Process stores sequentially (one after another, NEVER in parallel).
      for (const s of storesSnapshot) {
        const fallbackUrl = s.checkout_continue_url ?? s.cart_continue_url ?? undefined;

        if (
          s.already_sent ||
          (s.cart_id !== null && sentCartIds.has(s.cart_id)) ||
          (s.checkout_id !== null && sentCheckoutIds.has(s.checkout_id))
        ) {
          logEvent('order_refused', { order_id: orderId, reason: 'already_sent' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            note: ALREADY_SENT_NOTE,
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // R1: refuse any cart for a store with an UNKNOWN payment outcome before any store call (no link).
        if (s.store_unclear || (s.store_domain_key && unclearStores.has(s.store_domain_key))) {
          logEvent('order_refused', { order_id: orderId, reason: 'store_unclear' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            note: buildStoreUnclearNote(s.store),
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // R2: refuse any cart containing a variant or product already placed at this store in this call (keep store link).
        const preAlreadyOrderedTitle =
          s.already_ordered_title ??
          findAlreadyOrderedTitle(placedItemsByStore, s.store_domain_key, s.line_refs);
        if (preAlreadyOrderedTitle) {
          logEvent('order_refused', { order_id: orderId, reason: 'already_ordered' });
          const storeLink = s.cart_continue_url ?? s.checkout_continue_url ?? undefined;
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(storeLink ? { continue_url: storeLink } : {}),
            note: buildAlreadyOrderedNote(preAlreadyOrderedTitle),
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        if (!s.ready || !s.checkout_id || !s.raw_instrument) {
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(fallbackUrl ? { continue_url: fallbackUrl } : {}),
            note: s.note ?? 'Finish this store on its checkout page.',
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // Re-read checkout right now to verify non-empty items, exact items & final USD total, and status.
        let liveCheckout: any;
        try {
          liveCheckout = await mcp.call(
            'get_checkout',
            { shop: s.store_domain, id: s.checkout_id },
            { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
          );
        } catch {
          logEvent('order_refused', { order_id: orderId, reason: 'live_checkout_read_failed' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'failed',
            ...(fallbackUrl ? { continue_url: fallbackUrl } : {}),
            note: 'Could not verify the checkout before paying; finish on the store page.',
          });
          loggedStores.push({ store: s.store, status: 'failed' });
          continue;
        }

        const liveUrl =
          (typeof liveCheckout?.continue_url === 'string' && liveCheckout.continue_url) ||
          fallbackUrl;
        const liveTotals = inspectCheckoutTotal(liveCheckout);
        const liveItemsKey = buildCheckoutVariantQtyKey(liveCheckout);
        const livePriceItemsKey = buildCheckoutPriceItemsKey(liveCheckout);

        if (liveCheckout?.status !== 'ready_for_complete') {
          logEvent('order_refused', { order_id: orderId, reason: 'checkout_not_ready' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(liveUrl ? { continue_url: liveUrl } : {}),
            note: 'Checkout is no longer ready to complete; finish on the store page.',
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // M4: non-empty items key required at place too.
        if (!liveItemsKey || !livePriceItemsKey) {
          logEvent('order_refused', { order_id: orderId, reason: 'empty_checkout_items' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(liveUrl ? { continue_url: liveUrl } : {}),
            note: 'Checkout has no items; finish on the store page.',
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        if (
          !liveTotals.currencyIsUsd ||
          !liveTotals.hasFinalTotal ||
          liveTotals.finalTotalCents === null
        ) {
          logEvent('order_refused', {
            order_id: orderId,
            reason: !liveTotals.currencyIsUsd ? 'non_usd_currency' : 'missing_final_total',
          });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(liveUrl ? { continue_url: liveUrl } : {}),
            note: TOTAL_NOT_FINAL_NOTE,
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        if (
          liveTotals.finalTotalCents !== s.reviewed_total_cents ||
          liveItemsKey !== s.reviewed_items_key ||
          livePriceItemsKey !== s.reviewed_price_items_key
        ) {
          logEvent('order_refused', { order_id: orderId, reason: 'checkout_changed' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(liveUrl ? { continue_url: liveUrl } : {}),
            note: 'Items or total changed since you reviewed the order; finish on the store page.',
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // Synchronous race-closing re-checks right before dispatching complete_checkout.
        if (
          (s.cart_id !== null && sentCartIds.has(s.cart_id)) ||
          sentCheckoutIds.has(s.checkout_id)
        ) {
          logEvent('order_refused', { order_id: orderId, reason: 'already_sent' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            note: ALREADY_SENT_NOTE,
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }
        if (s.store_domain_key && unclearStores.has(s.store_domain_key)) {
          logEvent('order_refused', { order_id: orderId, reason: 'store_unclear' });
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            note: buildStoreUnclearNote(s.store),
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }
        const liveRefs = mergeLineRefs(
          s.line_refs,
          extractCheckoutLineRefs(liveCheckout, s.line_refs),
        );
        const liveAlreadyOrderedTitle = findAlreadyOrderedTitle(
          placedItemsByStore,
          s.store_domain_key,
          liveRefs,
        );
        if (liveAlreadyOrderedTitle) {
          logEvent('order_refused', { order_id: orderId, reason: 'already_ordered' });
          const storeLink = s.cart_continue_url ?? liveUrl;
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'handoff',
            ...(storeLink ? { continue_url: storeLink } : {}),
            note: buildAlreadyOrderedNote(liveAlreadyOrderedTitle),
          });
          loggedStores.push({ store: s.store, status: 'handoff' });
          continue;
        }

        // Mark cart_id, checkout_id, and store (fail-closed while in flight) as SENT and count
        // against session spend BEFORE dispatching complete_checkout (H1, H2, M5, R1).
        if (s.cart_id) sentCartIds.add(s.cart_id);
        sentCheckoutIds.add(s.checkout_id);
        if (s.store_domain_key) unclearStores.add(s.store_domain_key);
        sessionSpentCents += s.reviewed_total_cents;

        // Complete checkout EXACTLY ONCE with a deterministic UUID idempotency key.
        // NEVER retry complete_checkout.
        const storeIdemKey = deriveCheckoutIdempotencyUuid(
          idempotencyKey,
          s.store_domain,
          s.checkout_id,
        );
        let completeRes: any = null;
        let completeErr = false;
        try {
          completeRes = await executeCompleteCheckoutOnce(
            s.store_domain,
            s.checkout_id,
            s.raw_instrument,
            storeIdemKey,
          );
        } catch {
          completeErr = true;
        }

        // H3 & R2: status === 'completed' alone means placed; clear in-flight unclear mark and record bought items.
        if (!completeErr && completeRes?.status === 'completed') {
          if (s.store_domain_key) unclearStores.delete(s.store_domain_key);
          recordPlacedItems(
            placedItemsByStore,
            s.store_domain_key,
            mergeLineRefs(liveRefs, extractCheckoutLineRefs(completeRes, liveRefs)),
          );
          const directOrderNum = extractOrderNumber(completeRes);
          const placedUrl =
            (typeof completeRes?.continue_url === 'string' && completeRes.continue_url) ||
            liveUrl;
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: true,
            status: 'placed',
            ...(directOrderNum ? { order_number: directOrderNum } : {}),
            ...(placedUrl ? { continue_url: placedUrl } : {}),
          });
          loggedStores.push({
            store: s.store,
            status: 'placed',
            ...(directOrderNum ? { order_number: directOrderNum } : {}),
          });
          continue;
        }

        // Definite refusal from the store (clear failed/declined/canceled/incomplete status, no order):
        // clear in-flight unclear mark so a new cart for this store remains retryable.
        if (!completeErr && isDefiniteRefusalDoc(completeRes)) {
          if (s.store_domain_key) unclearStores.delete(s.store_domain_key);
          const refusalUrl =
            (typeof completeRes?.continue_url === 'string' && completeRes.continue_url) ||
            liveUrl;
          const refusalNote =
            extractCheckoutNote(completeRes) ||
            'Order was declined by the store; finish on the store page.';
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'failed',
            ...(refusalUrl ? { continue_url: refusalUrl } : {}),
            note: safeMessage(refusalNote),
          });
          loggedStores.push({ store: s.store, status: 'failed' });
          continue;
        }

        // L4: unclear outcome after complete_checkout was SENT:
        // poll get_checkout up to 5 times (~15s); NEVER call complete_checkout again.
        let confirmedCheckout: any = null;
        let definiteRefusalCheckout: any = null;
        for (const delayMs of reconcileDelaysMs) {
          await sleep(delayMs);
          try {
            const polled = await mcp.call(
              'get_checkout',
              { shop: s.store_domain, id: s.checkout_id },
              { timeoutMs: CHECKOUT_TIMEOUT_MS, authenticated: true },
            );
            if (polled?.status === 'completed') {
              confirmedCheckout = polled;
              break;
            }
            if (isDefiniteRefusalDoc(polled)) {
              definiteRefusalCheckout = polled;
              break;
            }
          } catch {
            // Read failure: continue polling remaining attempts
          }
        }

        if (confirmedCheckout) {
          if (s.store_domain_key) unclearStores.delete(s.store_domain_key);
          recordPlacedItems(
            placedItemsByStore,
            s.store_domain_key,
            mergeLineRefs(liveRefs, extractCheckoutLineRefs(confirmedCheckout, liveRefs)),
          );
          const checkedOrderNum = extractOrderNumber(confirmedCheckout);
          const confirmedUrl =
            (typeof confirmedCheckout?.continue_url === 'string' &&
              confirmedCheckout.continue_url) ||
            (typeof completeRes?.continue_url === 'string' && completeRes.continue_url) ||
            liveUrl;
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: true,
            status: 'placed',
            ...(checkedOrderNum ? { order_number: checkedOrderNum } : {}),
            ...(confirmedUrl ? { continue_url: confirmedUrl } : {}),
          });
          loggedStores.push({
            store: s.store,
            status: 'placed',
            ...(checkedOrderNum ? { order_number: checkedOrderNum } : {}),
          });
        } else if (definiteRefusalCheckout) {
          if (s.store_domain_key) unclearStores.delete(s.store_domain_key);
          const refusalUrl =
            (typeof definiteRefusalCheckout?.continue_url === 'string' &&
              definiteRefusalCheckout.continue_url) ||
            liveUrl;
          const refusalNote =
            extractCheckoutNote(definiteRefusalCheckout) ||
            'Order was declined by the store; finish on the store page.';
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'failed',
            ...(refusalUrl ? { continue_url: refusalUrl } : {}),
            note: safeMessage(refusalNote),
          });
          loggedStores.push({ store: s.store, status: 'failed' });
        } else {
          // R1: Unknown outcome after complete_checkout was sent -> store stays in unclearStores;
          // omit continue_url so we never invite double payment.
          finalStores.push({
            store: s.store,
            items: s.items,
            total: s.total,
            payment_label: s.payment_label,
            ready: false,
            status: 'failed',
            note: UNKNOWN_COMPLETION_NOTE,
          });
          loggedStores.push({ store: s.store, status: 'unknown' });
        }
      }

      const finalResult: OrderReview = {
        order_id: orderId,
        stores: finalStores,
        total: recordTotal,
        ...(recordAddressLabel ? { address_label: recordAddressLabel } : {}),
      };

      // L3: purge reviewed order and all raw instruments once placed; keep only safe finalResult.
      for (const s of storesSnapshot) {
        s.raw_instrument = null;
      }
      purgeOrderRecord(orderId);
      placedResults.set(orderId, finalResult);
      inProgressAttempts.delete(orderId);

      const ms = Math.max(0, now() - t0);
      logEvent('order_place', {
        order_id: orderId,
        stores: loggedStores,
        total: recordTotal,
        confirmed_by_tap: true,
        ms,
      });

      return finalResult;
    })();

    inProgressAttempts.set(orderId, placementPromise);
    return placementPromise;
  }

  return {
    prepareOrder,
    placeOrder,
    endCall,
    _debugStats: () => {
      let rawInstrumentCount = 0;
      for (const rec of reviewedOrders.values()) {
        for (const s of rec.stores) {
          if (s.raw_instrument !== null) rawInstrumentCount += 1;
        }
      }
      return {
        pendingReviews: reviewedOrders.size,
        rawInstrumentCount,
        sentCarts: sentCartIds.size,
        sentCheckouts: sentCheckoutIds.size,
        unclearStores: unclearStores.size,
        placedStores: placedItemsByStore.size,
        sessionSpentCents,
      };
    },
  };
}

const defaultPurchase = createPurchaseClient({
  sentCartIds: PROCESS_SENT_CART_IDS,
  sentCheckoutIds: PROCESS_SENT_CHECKOUT_IDS,
  unclearStores: PROCESS_UNCLEAR_STORES,
  placedItemsByStore: PROCESS_PLACED_ITEMS,
});

export const prepareOrder = defaultPurchase.prepareOrder;
export const placeOrder = defaultPurchase.placeOrder;
export const endCall = defaultPurchase.endCall;
