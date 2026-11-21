import { llm } from '@livekit/agents';
import { z } from 'zod';
import { buildOutfits as defaultBuildOutfits, swapPiece as defaultSwapPiece } from '../brain/index.ts';
import type { BuildOptions, SwapOptions, SwapResult } from '../brain/index.ts';
import { calllog } from '../calllog.ts';
import * as defaultMediaModule from '../media/index.ts';
import type { SearchOpts } from '../store/catalog.ts';
import type { BagLineAdded, BagLineNotAdded } from '../store/index.ts';
import { tryOn as defaultTryOn } from '../tryon.ts';
import type {
  BagLine,
  BagLink,
  BagOut,
  BagStore,
  Brief,
  BuildResult,
  CartResult,
  Gender,
  Item,
  Outfit,
  PageActionName,
  PageActionReply,
  PageActions,
  Piece,
  SearchResult,
} from '../types.ts';
import type { PageSender } from './page.ts';
import {
  type BagNotAdded,
  type CallStateStore,
  createCallStateStore,
  normalizeSlotKey,
  outfitToStateLook,
} from './state.ts';

export const DUPLICATE_WINDOW_MS = 15_000;
export const MAX_BUDGET_USD = 10_000;
export const DEFAULT_TRYON_WAIT_MS = 45_000;
export const DEFAULT_HIGHLIGHT_WALK_MS = 2_200;
export const DEFAULT_WEATHER_TIMEOUT_MS = 2_500;

export const SLOW_TOOL_NOTES: Readonly<Record<string, string>> = {
  build_outfits: 'Working on building three outfits now.',
  show_on_me: 'Working on rendering your try-on now.',
  swap_piece: 'Working on finding a replacement piece now.',
};

export const TOOL_ERROR_FALLBACK =
  'That step could not be completed right now. Carry on smoothly without mentioning any error or technical issue.';

export type ToolLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface WorkingNoteParams {
  callId: string;
  name: string;
  note: string;
}

export interface CameraSnapshot {
  jpeg: Buffer;
  width: number;
  height: number;
  at: number;
}

export interface TimerLike {
  unref?: () => unknown;
}

export interface StoreModuleLike {
  searchMixed?: (
    query: string,
    gender: Gender,
    opts?: SearchOpts,
  ) => Promise<SearchResult>;
  search?: (
    query: string,
    gender: Gender,
    opts?: SearchOpts,
  ) => Promise<SearchResult>;
  addToBag?: (
    outfit: Outfit,
    sizes: Record<string, string>,
    gender: Gender,
  ) => Promise<BagOut>;
  productImages?: (item: Item) => Promise<string[]>;
  setCallRoom?: (room: string | null) => void;
}

export interface WeatherResultLike {
  ok?: boolean;
  line?: string;
  ms?: number;
}

export interface WeatherModuleLike {
  forecast?: (where: string, when?: string) => Promise<WeatherResultLike>;
}

export interface ToolDeps {
  buildOutfits?: (brief: Brief, opts?: BuildOptions) => Promise<BuildResult>;
  swapPiece?: (
    outfit: Outfit,
    slot: string,
    request: string,
    brief: Brief,
    opts?: SwapOptions,
  ) => Promise<SwapResult>;
  outfitCollage?: (outfit: Outfit, label?: string) => Promise<string | null>;
  productImages?: (item: Item) => Promise<string[]>;
  tryOn?: (
    personJpeg: Buffer | null,
    outfit: Outfit,
    opts?: { label?: string },
  ) => Promise<{ url: string; path: string; ms: number; id: string }>;
  searchProducts?: (
    query: string,
    gender: Gender,
    opts?: SearchOpts,
  ) => Promise<SearchResult>;
  addToBag?: (
    outfit: Outfit,
    sizes: Record<string, string>,
    gender: Gender,
  ) => Promise<BagOut>;
  loadStoreModule?: () => Promise<StoreModuleLike | null>;
  forecast?: (where: string, when?: string) => Promise<WeatherResultLike>;
  loadWeatherModule?: () => Promise<WeatherModuleLike | null>;
}

export interface ToolRuntimeOptions {
  room: string;
  log?: ToolLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerLike;
  clearTimeoutFn?: (handle: TimerLike) => void;
  duplicateWindowMs?: number;
  tryOnTimeoutMs?: number;
  walkIntervalMs?: number;
  weatherTimeoutMs?: number;
  sendWorkingNote?: (params: WorkingNoteParams) => boolean | void;
  getSnapshot?: () => CameraSnapshot | null;
  page?: PageSender;
  state?: CallStateStore;
  deps?: ToolDeps;
  signal?: AbortSignal;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${stableStringify(val)}`);
  }
  return `{${entries.join(',')}}`;
}

function formatPrice(amount: number): string {
  if (!Number.isFinite(amount)) return '$0';
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Accepts only HTTP(S) URLs or server-relative `/tryon/...` URLs so a local
 * filesystem path (e.g. `res.path`, `/tmp/...`, `file://...`) can never be sent
 * to the call page.
 */
export function sanitizePageMediaUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\\')) return null;

  if (trimmed.startsWith('/tryon/')) {
    if (trimmed.length <= '/tryon/'.length || trimmed.includes('..')) {
      return null;
    }
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Derives up to 5 short bullet strings from a plain-text product description.
 */
export function deriveProductDetails(description: string): string[] {
  if (typeof description !== 'string') return [];
  const clean = description.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const rawParts = clean
    .split(/(?:\.\s+|;\s+|\|\s+|\s+[•·]\s+)/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length >= 4 && s.length <= 120);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of rawParts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
    if (unique.length >= 5) break;
  }

  return unique.length >= 2 ? unique : [];
}

/**
 * Local mock cart builder used only when `src/store/index.ts` is not merged yet.
 * Never touches checkout or payment; carts only.
 */
export function mockAddToBag(
  outfit: Outfit,
  sizes: Record<string, string>,
  _gender: Gender,
): BagOut {
  const byStore = new Map<string, { store: string; store_domain: string; pieces: Piece[] }>();
  for (const piece of outfit.pieces) {
    const key = piece.item.store_domain || piece.item.store;
    let bucket = byStore.get(key);
    if (!bucket) {
      bucket = {
        store: piece.item.store,
        store_domain: piece.item.store_domain,
        pieces: [],
      };
      byStore.set(key, bucket);
    }
    bucket.pieces.push(piece);
  }

  const carts: CartResult[] = [];
  let grandTotal = 0;

  for (const group of byStore.values()) {
    const added = group.pieces.map((piece) => {
      const slotKey = piece.slot.toLowerCase();
      const chosenSize = sizes[slotKey] ?? sizes[normalizeSlotKey(piece.slot)] ?? null;
      const variantId =
        (chosenSize && piece.item.variants_by_size?.[chosenSize]) || piece.item.variant_id;
      return {
        variant_id: variantId,
        title: piece.item.title,
        size: chosenSize,
      };
    });

    const storeTotal = roundMoney(group.pieces.reduce((sum, p) => sum + p.item.price, 0));
    grandTotal = roundMoney(grandTotal + storeTotal);

    carts.push({
      store: group.store,
      store_domain: group.store_domain,
      cart_id: null,
      continue_url: null,
      total_usd: storeTotal,
      added,
      not_added: [],
      ms: 0,
    });
  }

  return {
    carts,
    summary: 'Carts are mocked (store cart module not available yet).',
    total_usd: grandTotal,
  };
}

function findPieceForCartEntry(
  outfit: Outfit,
  variantId: string,
  title: string | undefined,
  store: string,
  itemId?: string,
): Piece | undefined {
  if (itemId) {
    const byId = outfit.pieces.find((p) => p.item.id === itemId);
    if (byId) return byId;
  }
  for (const p of outfit.pieces) {
    if (p.item.variant_id === variantId) return p;
    if (p.item.variants_by_size && Object.values(p.item.variants_by_size).includes(variantId)) {
      return p;
    }
  }
  if (title) {
    const lower = title.trim().toLowerCase();
    const byTitle = outfit.pieces.find(
      (p) => p.item.title.trim().toLowerCase() === lower && p.item.store === store,
    );
    if (byTitle) return byTitle;
    return outfit.pieces.find((p) => p.item.title.trim().toLowerCase() === lower);
  }
  return undefined;
}

/**
 * Returns true only when the store created at least one real cart (cart_id or continue_url)
 * containing at least one added line.
 */
export function hasRealCart(bagOut: BagOut): boolean {
  return (bagOut.carts ?? []).some(
    (cart) =>
      ((typeof cart.cart_id === 'string' && cart.cart_id.trim().length > 0) ||
        (typeof cart.continue_url === 'string' && cart.continue_url.trim().length > 0)) &&
      Array.isArray(cart.added) &&
      cart.added.length > 0,
  );
}

/**
 * Converts a store `BagOut` into the page's `bagReady` RPC payload.
 */
export function bagOutToPagePayload(
  bagOut: BagOut,
  outfit: Outfit,
  sizes: Record<string, string>,
): PageActions['bagReady'] {
  const stores: BagStore[] = [];
  const links: BagLink[] = [];

  for (const cart of bagOut.carts) {
    const added: BagLine[] = (cart.added ?? []).map((entry) => {
      const ext = entry as Partial<BagLineAdded>;
      const piece = findPieceForCartEntry(
        outfit,
        entry.variant_id,
        entry.title,
        cart.store,
        ext.item_id,
      );
      const slot = ext.slot || piece?.slot || '';
      const fallbackSize = slot
        ? (sizes[slot.toLowerCase()] ?? sizes[normalizeSlotKey(slot)] ?? null)
        : null;
      return {
        title: entry.title || piece?.item.title || 'Item',
        slot,
        image: ext.image || piece?.item.image || '',
        price:
          typeof ext.price === 'number' && Number.isFinite(ext.price)
            ? ext.price
            : (piece?.item.price ?? 0),
        size: entry.size !== undefined ? entry.size : fallbackSize,
      };
    });

    const not_added: BagLine[] = (cart.not_added ?? []).map((entry) => {
      const ext = entry as Partial<BagLineNotAdded>;
      const piece = findPieceForCartEntry(
        outfit,
        entry.variant_id,
        entry.title,
        cart.store,
        ext.item_id,
      );
      return {
        title: entry.title || piece?.item.title || 'Item',
        slot: ext.slot || piece?.slot || '',
        image: ext.image || piece?.item.image || '',
        price:
          typeof ext.price === 'number' && Number.isFinite(ext.price)
            ? ext.price
            : (piece?.item.price ?? 0),
        ...(ext.size !== undefined ? { size: ext.size } : {}),
        reason: entry.reason,
      };
    });

    stores.push({
      store: cart.store,
      added,
      not_added,
      subtotal: cart.total_usd,
    });

    if (typeof cart.continue_url === 'string' && cart.continue_url.trim().length > 0) {
      links.push({ store: cart.store, url: cart.continue_url.trim() });
    }
  }

  return {
    stores,
    links,
    total: bagOut.total_usd,
  };
}

async function defaultLoadStoreModule(): Promise<StoreModuleLike | null> {
  try {
    const modPath = '../store/index.ts';
    const mod = (await import(modPath)) as StoreModuleLike;
    return mod ?? null;
  } catch {
    return null;
  }
}

async function defaultLoadWeatherModule(): Promise<WeatherModuleLike | null> {
  const modPath = '../weather.ts';
  return ((await import(modPath)) as WeatherModuleLike) ?? null;
}

interface DuplicateEntry {
  startedAt: number;
  callId: string;
  promise: Promise<string>;
}

export interface ToolWrapperContext {
  wrap<TArgs extends Record<string, unknown>>(
    name: string,
    handler: (args: TArgs, opts: { toolCallId: string }) => Promise<string> | string,
  ): (args: TArgs, opts?: { toolCallId?: string }) => Promise<string>;
  invalidate(exceptToolName?: string): void;
}

export function createToolWrapper(options: ToolRuntimeOptions): ToolWrapperContext {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const windowMs = options.duplicateWindowMs ?? DUPLICATE_WINDOW_MS;
  const recentCalls = new Map<string, DuplicateEntry>();

  function pruneExpired(now: number): void {
    for (const [key, entry] of recentCalls.entries()) {
      if (now - entry.startedAt >= windowMs) {
        recentCalls.delete(key);
      }
    }
  }

  return {
    invalidate(exceptToolName?: string): void {
      if (!exceptToolName) {
        recentCalls.clear();
        return;
      }
      const prefix = `${exceptToolName}:`;
      for (const key of recentCalls.keys()) {
        if (!key.startsWith(prefix)) {
          recentCalls.delete(key);
        }
      }
    },
    wrap<TArgs extends Record<string, unknown>>(
      name: string,
      handler: (args: TArgs, opts: { toolCallId: string }) => Promise<string> | string,
    ) {
      return (args: TArgs, opts?: { toolCallId?: string }): Promise<string> => {
        const callId = opts?.toolCallId ?? '';
        const startedAt = nowFn();
        pruneExpired(startedAt);

        const dedupKey = `${name}:${stableStringify(args ?? {})}`;
        const existing = recentCalls.get(dedupKey);
        if (existing && startedAt - existing.startedAt < windowMs) {
          logFn(options.room, 'tool_duplicate', {
            name,
            args,
            call_id: callId,
            original_call_id: existing.callId,
          });
          return existing.promise;
        }

        logFn(options.room, 'tool_call', {
          name,
          args,
          call_id: callId,
        });

        const promise = (async (): Promise<string> => {
          try {
            const note = SLOW_TOOL_NOTES[name];
            if (note) {
              const sent = options.sendWorkingNote?.({ callId, name, note }) ?? false;
              logFn(options.room, 'tool_note', {
                name,
                call_id: callId,
                note,
                sent: Boolean(sent),
              });
            }

            const result = await handler(args, { toolCallId: callId });
            const text = typeof result === 'string' ? result : String(result);
            const durationMs = Math.max(0, nowFn() - startedAt);
            logFn(options.room, 'tool_result', {
              name,
              call_id: callId,
              text,
              duration_ms: durationMs,
            });
            return text;
          } catch (err) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            logFn(options.room, 'tool_error', {
              name,
              call_id: callId,
              error: errorObj,
              stack: errorObj.stack,
            });
            return TOOL_ERROR_FALLBACK;
          }
        })();

        recentCalls.set(dedupKey, { startedAt, callId, promise });
        return promise;
      };
    },
  };
}

const outfitNumberSchema = z.number().int().min(1).max(3).describe('Look number: 1, 2, or 3');
const slotSchema = z
  .string()
  .describe('Piece slot name (top, bottom, dress, layer, shoes, accessory, bag, or jewelry)');

interface TryOnJob {
  version: number;
  hadSnapshot: boolean;
  promise: Promise<void>;
}

const NOOP_PAGE_SENDER: PageSender = {
  async send<K extends PageActionName>(
    _action: K,
    _payload: PageActions[K],
  ): Promise<PageActionReply> {
    return { ok: false, error: 'no page sender configured' };
  },
};

function findPieceInOutfit(outfit: Outfit, rawSlot: string): Piece | undefined {
  const clean = rawSlot.trim().toLowerCase();
  const exact = outfit.pieces.find((p) => p.slot.trim().toLowerCase() === clean);
  if (exact) return exact;
  const normalized = normalizeSlotKey(rawSlot);
  return outfit.pieces.find((p) => normalizeSlotKey(p.slot) === normalized);
}

/**
 * Returns an object map of anonymous function tools keyed by tool name.
 * IMPORTANT: Do NOT set `name` on any entry; @livekit/agents 1.10 rejects named entries in object maps.
 */
export function createAgentTools(options: ToolRuntimeOptions) {
  const wrapper = createToolWrapper(options);
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const setTimeoutFn: (fn: () => void, ms: number) => TimerLike =
    options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn: (handle: TimerLike) => void =
    options.clearTimeoutFn ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tryOnTimeoutMs = options.tryOnTimeoutMs ?? DEFAULT_TRYON_WAIT_MS;
  const walkIntervalMs = options.walkIntervalMs ?? DEFAULT_HIGHLIGHT_WALK_MS;
  const weatherTimeoutMs = options.weatherTimeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS;
  const page = options.page ?? NOOP_PAGE_SENDER;
  const stateStore =
    options.state ?? createCallStateStore({ roomName: options.room, log: logFn });

  const buildOutfitsFn = options.deps?.buildOutfits ?? defaultBuildOutfits;
  const swapPieceFn = options.deps?.swapPiece ?? defaultSwapPiece;
  const outfitCollageFn =
    options.deps?.outfitCollage ??
    (typeof defaultMediaModule.outfitCollage === 'function'
      ? defaultMediaModule.outfitCollage
      : async () => null);
  const mediaProductImagesFn =
    options.deps && 'productImages' in options.deps
      ? options.deps.productImages
      : typeof defaultMediaModule.productImages === 'function'
        ? defaultMediaModule.productImages
        : undefined;
  const tryOnFn = options.deps?.tryOn ?? defaultTryOn;
  const loadStoreModuleFn = options.deps?.loadStoreModule ?? defaultLoadStoreModule;
  const loadWeatherModuleFn = options.deps?.loadWeatherModule ?? defaultLoadWeatherModule;

  const outfitsByNumber = new Map<number, Outfit>();
  const mediaVersionByLook = new Map<number, number>();
  const tryOnJobs = new Map<number, TryOnJob>();
  const baggedResults = new Map<string, string>();
  let lastBriefNotes: string | undefined;
  let lastBriefWeather: string | undefined;

  let walkGen = 0;
  let activeWalkTimer: TimerLike | null = null;
  const activeTimers = new Set<TimerLike>();

  function cancelWalk(): void {
    walkGen += 1;
    if (activeWalkTimer !== null) {
      clearTimeoutFn(activeWalkTimer);
      activeTimers.delete(activeWalkTimer);
      activeWalkTimer = null;
    }
  }

  function scheduleTimer(fn: () => void, ms: number): TimerLike {
    const handle = setTimeoutFn(() => {
      activeTimers.delete(handle);
      fn();
    }, ms);
    handle.unref?.();
    activeTimers.add(handle);
    return handle;
  }

  if (options.signal) {
    options.signal.addEventListener(
      'abort',
      () => {
        cancelWalk();
        for (const handle of activeTimers) {
          clearTimeoutFn(handle);
        }
        activeTimers.clear();
      },
      { once: true },
    );
  }

  function nextLookMediaVersion(lookNumber: number): number {
    const next = (mediaVersionByLook.get(lookNumber) ?? 0) + 1;
    mediaVersionByLook.set(lookNumber, next);
    return next;
  }

  function isCurrentMediaVersion(lookNumber: number, version: number): boolean {
    return mediaVersionByLook.get(lookNumber) === version && !options.signal?.aborted;
  }

  function startTryOnForLook(outfit: Outfit, version: number): TryOnJob {
    const lookNumber = outfit.number ?? 1;
    const snap = options.getSnapshot?.() ?? null;
    const hadSnapshot = Boolean(snap?.jpeg && snap.jpeg.length > 0);
    const started = nowFn();

    stateStore.dispatch({ type: 'set_tryon', look: lookNumber, status: 'rendering' });
    void page.send('tryOnStatus', { outfit: lookNumber, status: 'rendering' });

    const promise = (async () => {
      try {
        const res = await tryOnFn(snap?.jpeg ?? null, outfit, { label: `look-${lookNumber}` });
        const ms = Math.max(0, Math.round(nowFn() - started));
        if (!isCurrentMediaVersion(lookNumber, version)) return;

        const url = sanitizePageMediaUrl(res?.url);
        if (url) {
          stateStore.dispatch({ type: 'set_tryon', look: lookNumber, status: 'ready', url });
          await page.send('tryOnReady', { outfit: lookNumber, url });
          logFn(options.room, 'tryon', {
            outfit: lookNumber,
            status: 'ready',
            ms,
            url,
            had_snapshot: hadSnapshot,
          });
        } else {
          const error = 'try-on returned invalid or empty image url';
          stateStore.dispatch({ type: 'set_tryon', look: lookNumber, status: 'failed', error });
          await page.send('tryOnStatus', { outfit: lookNumber, status: 'failed' });
          logFn(options.room, 'tryon', {
            outfit: lookNumber,
            status: 'failed',
            ms,
            error,
            had_snapshot: hadSnapshot,
          });
        }
      } catch (err) {
        const ms = Math.max(0, Math.round(nowFn() - started));
        if (!isCurrentMediaVersion(lookNumber, version)) return;

        const error = err instanceof Error ? err.message : String(err);
        stateStore.dispatch({ type: 'set_tryon', look: lookNumber, status: 'failed', error });
        await page.send('tryOnStatus', { outfit: lookNumber, status: 'failed' });
        logFn(options.room, 'tryon', {
          outfit: lookNumber,
          status: 'failed',
          ms,
          error,
          had_snapshot: hadSnapshot,
        });
      }
    })();

    const job: TryOnJob = { version, hadSnapshot, promise };
    tryOnJobs.set(lookNumber, job);
    return job;
  }

  function startCollageForLook(outfit: Outfit, version: number): void {
    const lookNumber = outfit.number ?? 1;
    const started = nowFn();

    void (async () => {
      try {
        const url = await outfitCollageFn(outfit, `look-${lookNumber}`);
        const ms = Math.max(0, Math.round(nowFn() - started));
        if (!isCurrentMediaVersion(lookNumber, version)) return;

        const cleanUrl = sanitizePageMediaUrl(url);
        if (cleanUrl) {
          await page.send('collageReady', { outfit: lookNumber, url: cleanUrl });
          logFn(options.room, 'collage', { outfit: lookNumber, ms, ok: true });
        } else {
          logFn(options.room, 'collage', { outfit: lookNumber, ms, ok: false });
        }
      } catch {
        const ms = Math.max(0, Math.round(nowFn() - started));
        if (!isCurrentMediaVersion(lookNumber, version)) return;
        logFn(options.room, 'collage', { outfit: lookNumber, ms, ok: false });
      }
    })();
  }

  function startBackgroundMediaForLook(outfit: Outfit): TryOnJob {
    const lookNumber = outfit.number ?? 1;
    const version = nextLookMediaVersion(lookNumber);
    const tryOnJob = startTryOnForLook(outfit, version);
    startCollageForLook(outfit, version);
    return tryOnJob;
  }

  function startHighlightWalk(outfit: Outfit): void {
    cancelWalk();
    if (options.signal?.aborted || outfit.pieces.length === 0) return;
    const lookNumber = outfit.number ?? 1;
    const myWalkGen = walkGen;
    const slots = outfit.pieces.map((p) => p.slot);
    let idx = 0;

    const scheduleNext = () => {
      if (myWalkGen !== walkGen || options.signal?.aborted || idx >= slots.length) {
        activeWalkTimer = null;
        return;
      }
      const slot = slots[idx]!;
      idx += 1;
      activeWalkTimer = scheduleTimer(() => {
        activeWalkTimer = null;
        if (myWalkGen !== walkGen || options.signal?.aborted) return;
        void page.send('highlight', { outfit: lookNumber, piece: slot }).then(() => {
          scheduleNext();
        });
      }, walkIntervalMs);
    };

    scheduleNext();
  }

  async function waitForJobWithTimeout(
    job: TryOnJob,
    timeoutMs: number,
  ): Promise<'settled' | 'timeout'> {
    if (timeoutMs <= 0) return 'timeout';
    return await new Promise<'settled' | 'timeout'>((resolve) => {
      let done = false;
      const timer = scheduleTimer(() => {
        if (done) return;
        done = true;
        resolve('timeout');
      }, timeoutMs);

      void job.promise.then(() => {
        if (done) return;
        done = true;
        clearTimeoutFn(timer);
        activeTimers.delete(timer);
        resolve('settled');
      });
    });
  }

  function resolveLook(explicitOutfit?: number): { lookNum: number; outfit: Outfit } | null {
    const target = explicitOutfit ?? stateStore.get().pickedLook;
    if (target === null || target === undefined) return null;
    const outfit = outfitsByNumber.get(target);
    if (!outfit) return null;
    return { lookNum: target, outfit };
  }

  function availableLookHint(): string {
    const nums = Array.from(outfitsByNumber.keys()).sort((a, b) => a - b);
    if (nums.length === 0) {
      return 'No outfits have been built yet. Call build_outfits first.';
    }
    return `Available looks are ${nums.join(', ')}. Ask which look they want or pick one first.`;
  }

  async function lookupWeatherForBrief(
    where: string,
    when: string,
  ): Promise<string | undefined> {
    const started = nowFn();
    const timeoutMs = weatherTimeoutMs;

    const runLookup = async (): Promise<
      { ok: true; line: string } | { ok: false; error: string }
    > => {
      try {
        let forecastFn = options.deps?.forecast;
        if (!forecastFn) {
          const mod = await loadWeatherModuleFn();
          if (typeof mod?.forecast === 'function') {
            forecastFn = mod.forecast;
          }
        }
        if (!forecastFn) {
          return { ok: false, error: 'weather module unavailable' };
        }
        const res = await forecastFn(where, when);
        const line = typeof res?.line === 'string' ? res.line.trim() : '';
        if (res?.ok && line.length > 0) {
          return { ok: true, line };
        }
        return { ok: false, error: 'forecast unavailable' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    };

    const outcome = await new Promise<
      { ok: true; line: string } | { ok: false; error: string }
    >((resolve) => {
      let settled = false;
      const timer = scheduleTimer(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      void runLookup().then((res) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        activeTimers.delete(timer);
        resolve(res);
      });
    });

    const ms = Math.max(0, Math.round(nowFn() - started));
    if (outcome.ok) {
      logFn(options.room, 'weather', {
        where,
        when,
        line: outcome.line,
        ms,
      });
      return outcome.line;
    }

    logFn(options.room, 'weather', {
      where,
      when,
      ms,
      error: outcome.error,
    });
    return undefined;
  }

  function currentBrief(): Brief {
    const st = stateStore.get();
    return {
      gender: st.department ?? 'women',
      occasion: st.occasion ?? '',
      budget_usd: st.budget.given ?? 0,
      ...(lastBriefNotes ? { notes: lastBriefNotes } : {}),
      ...(st.ownPiece ? { own_piece: st.ownPiece } : {}),
      ...(lastBriefWeather ? { weather: lastBriefWeather } : {}),
    };
  }

  return {
    remember: llm.tool({
      description: 'Remember a concise preference, size, name, or detail about the shopper.',
      parameters: z.object({
        fact: z.string().describe('Short fact to remember about the shopper'),
      }),
      execute: wrapper.wrap('remember', async ({ fact }) => {
        stateStore.dispatch({ type: 'add_fact', fact });
        return `Remembered: ${fact.trim()}. Continue naturally.`;
      }),
    }),

    set_department: llm.tool({
      description: "Set the shopper's department (men or women).",
      parameters: z.object({
        department: z.enum(['men', 'women']).describe('Shopper department'),
      }),
      execute: wrapper.wrap('set_department', async ({ department }) => {
        stateStore.dispatch({ type: 'set_department', department });
        wrapper.invalidate('set_department');
        return `Department set to ${department}. State your choice casually so they can correct you, then ask occasion and budget if still needed.`;
      }),
    }),

    build_outfits: llm.tool({
      description: 'Build three complete outfit looks for the shopper based on occasion and budget.',
      parameters: z.object({
        occasion: z.string().describe('The event or occasion the shopper is dressing for'),
        budget_usd: z.number().describe('Total budget in US dollars'),
        notes: z.string().optional().describe('Optional style, color, or fit notes'),
        own_piece: z.string().optional().describe('Optional piece the shopper already owns'),
        where: z
          .string()
          .optional()
          .describe('City or location for the occasion; fill only when the shopper explicitly gave a place'),
        when: z
          .string()
          .optional()
          .describe('Date or day for the occasion; fill only when the shopper explicitly gave a date or day'),
      }),
      execute: wrapper.wrap(
        'build_outfits',
        async ({ occasion, budget_usd, notes, own_piece, where, when }) => {
        const department = stateStore.get().department;
        if (!department) {
          return 'Department is not set yet. Decide men or women yourself, call set_department first, then call build_outfits.';
        }

        const budgetCapped = budget_usd > MAX_BUDGET_USD;
        const effectiveBudget = budgetCapped ? MAX_BUDGET_USD : budget_usd;
        lastBriefNotes = notes;

        const cleanWhere = typeof where === 'string' ? where.trim() : '';
        const cleanWhen = typeof when === 'string' ? when.trim() : '';
        const weatherLine =
          cleanWhere && cleanWhen
            ? await lookupWeatherForBrief(cleanWhere, cleanWhen)
            : undefined;
        lastBriefWeather = weatherLine;

        stateStore.dispatch({
          type: 'set_brief',
          occasion,
          budgetAsked: true,
          budgetGiven: effectiveBudget,
          ownPiece: own_piece ?? null,
        });

        const brief: Brief = {
          gender: department,
          occasion,
          budget_usd: effectiveBudget,
          ...(notes ? { notes } : {}),
          ...(own_piece ? { own_piece } : {}),
          ...(weatherLine ? { weather: weatherLine } : {}),
        };

        cancelWalk();
        const buildStarted = nowFn();
        const subtitle = `${occasion} · ${formatPrice(effectiveBudget)} budget`;
        const delivered = new Set<number>();
        const pageShowPromises: Promise<PageActionReply>[] = [];
        const shownOutfits: Outfit[] = [];

        const handleOutfit = (rawOutfit: Outfit, index: number) => {
          const lookNumber =
            typeof rawOutfit.number === 'number' && Number.isFinite(rawOutfit.number)
              ? rawOutfit.number
              : index + 1;
          if (delivered.has(lookNumber)) return;
          delivered.add(lookNumber);

          const numbered: Outfit = { ...rawOutfit, number: lookNumber };
          const replace = shownOutfits.length === 0 && index === 0;
          if (replace) {
            outfitsByNumber.clear();
            tryOnJobs.clear();
          }
          outfitsByNumber.set(lookNumber, numbered);
          shownOutfits.push(numbered);

          stateStore.dispatch({
            type: 'set_looks',
            looks: [outfitToStateLook(numbered, lookNumber)],
            replace,
          });

          logFn(options.room, 'build_progress', {
            index,
            name: numbered.name,
            total: numbered.total,
            ms: Math.max(0, Math.round(nowFn() - buildStarted)),
          });

          pageShowPromises.push(
            page.send('showOutfits', {
              outfits: [numbered],
              replace,
              subtitle,
            }),
          );

          startBackgroundMediaForLook(numbered);
        };

        const result = await buildOutfitsFn(brief, {
          onOutfit: handleOutfit,
          room: options.room,
        });

        for (const [idx, outfit] of (result.outfits ?? []).entries()) {
          handleOutfit(outfit, idx);
        }

        const pageReplies = await Promise.all(pageShowPromises);
        const pageConfirmed =
          pageReplies.length > 0 && pageReplies.every((reply) => reply.ok === true);

        logFn(options.room, 'build_done', {
          source: result.source,
          timing: result.timing,
          problems: result.problems,
        });
        wrapper.invalidate('build_outfits');

        const sorted = Array.from(outfitsByNumber.values()).sort(
          (a, b) => (a.number ?? 0) - (b.number ?? 0),
        );

        const headerLines: string[] = [];
        if (budgetCapped) {
          headerLines.push(
            `Budget was above $${MAX_BUDGET_USD} and was capped at $${MAX_BUDGET_USD}; mention the cap with attitude.`,
          );
        }
        if (pageConfirmed) {
          headerLines.push(
            `Built ${sorted.length} looks and they are now on screen. Give one tight sentence per look and ask which catches their eye.`,
          );
        } else {
          headerLines.push(
            `Built ${sorted.length} looks, but the page did not confirm displaying them yet. Do not claim they are live on screen; mention loading lightly.`,
          );
        }
        if (weatherLine) {
          headerLines.push(`Weather (you may mention in one short clause): ${weatherLine}`);
        }

        const lookLines = sorted.map((outfit) => {
          const num = outfit.number ?? 1;
          const piecesText = outfit.pieces
            .map((p) => `${p.slot}: ${p.item.title} (${formatPrice(p.item.price)}, ${p.item.store})`)
            .join('; ');
          return `Look ${num} — ${outfit.name} (${formatPrice(outfit.total)}): ${outfit.difference} Pieces: ${piecesText}`;
        });

        const footerLines: string[] = [];
        if (Array.isArray(result.problems) && result.problems.length > 0) {
          footerLines.push(`Internal notes (do not read aloud): ${result.problems.join('; ')}`);
        }

        return [...headerLines, ...lookLines, ...footerLines].join('\n');
      }),
    }),

    pick_outfit: llm.tool({
      description: 'Focus or highlight one of the three looks (1, 2, or 3) on screen.',
      parameters: z.object({
        outfit: outfitNumberSchema,
      }),
      execute: wrapper.wrap('pick_outfit', async ({ outfit: lookNumber }) => {
        const outfit = outfitsByNumber.get(lookNumber);
        if (!outfit) {
          return `Look ${lookNumber} does not exist. ${availableLookHint()}`;
        }

        stateStore.dispatch({ type: 'pick_look', look: lookNumber });
        wrapper.invalidate('pick_outfit');
        const reply = await page.send('highlight', { outfit: lookNumber, piece: null });
        startHighlightWalk(outfit);

        const tryOnInfo = stateStore.get().tryOn[lookNumber];
        let tryOnText = 'Try-on has not started yet.';
        if (tryOnInfo?.status === 'ready') {
          tryOnText = 'Try-on is ready to reveal.';
        } else if (tryOnInfo?.status === 'rendering') {
          tryOnText = 'Try-on is still rendering.';
        } else if (tryOnInfo?.status === 'failed') {
          tryOnText = 'Try-on failed for this look.';
        }

        const pieceLines = outfit.pieces.map(
          (p) =>
            `- ${p.slot}: ${p.item.title} (${formatPrice(p.item.price)}, ${p.item.store}) — ${p.why}`,
        );

        const statusLine = reply.ok
          ? `Look ${lookNumber} — ${outfit.name} (${formatPrice(outfit.total)}) is highlighted on screen.`
          : `Look ${lookNumber} — ${outfit.name} (${formatPrice(outfit.total)}) was selected, though the page did not confirm highlighting it.`;

        return [
          `${statusLine} ${tryOnText}`,
          ...pieceLines,
          'Walk through the pieces in four or five sentences using words from their titles, then ask if they want to see it on themselves.',
        ].join('\n');
      }),
    }),

    show_on_me: llm.tool({
      description: 'Reveal a virtual try-on of the chosen look (defaults to the picked look) on the shopper.',
      parameters: z.object({
        outfit: outfitNumberSchema.optional(),
      }),
      execute: wrapper.wrap('show_on_me', async ({ outfit: requestedOutfit }) => {
        const resolved = resolveLook(requestedOutfit);
        if (!resolved) {
          return `No look selected to try on. ${availableLookHint()}`;
        }

        const { lookNum, outfit } = resolved;
        let job = tryOnJobs.get(lookNum);
        let tryOnInfo = stateStore.get().tryOn[lookNum];

        if (!tryOnInfo && !job) {
          const version = nextLookMediaVersion(lookNum);
          job = startTryOnForLook(outfit, version);
          tryOnInfo = stateStore.get().tryOn[lookNum];
        }

        const currentSnap = options.getSnapshot?.() ?? null;
        const renderedOnModel = job ? !job.hadSnapshot : !currentSnap;
        const cameraOffFallbackNote = renderedOnModel
          ? ' Camera is off (stand-in model render); turning the camera on lets you show it on them.'
          : '';

        if (tryOnInfo?.status === 'rendering' && job) {
          const outcome = await waitForJobWithTimeout(job, tryOnTimeoutMs);
          if (outcome === 'timeout') {
            return `The fitting room is jammed right now for Look ${lookNum} (${outfit.name}) and the try-on timed out. Keep it light and offer the flat-lay and individual pieces instead.${cameraOffFallbackNote}`;
          }
          tryOnInfo = stateStore.get().tryOn[lookNum];
        }

        if (tryOnInfo?.status === 'ready' && tryOnInfo.url) {
          const reply = await page.send('reveal', { outfit: lookNum, url: tryOnInfo.url });
          if (reply.ok) {
            stateStore.dispatch({ type: 'mark_revealed', look: lookNum });
            if (renderedOnModel) {
              return `Look ${lookNum} (${outfit.name}) is now revealed on screen on a model because the camera is off. Say the look is on screen on a model and that turning the camera on lets you show it on them; never say you cannot overlay it. React like a friend in a line or two, then ask for top, bottom, and shoe sizes together in one question.`;
            }
            return `Try-on for Look ${lookNum} (${outfit.name}) is now revealed on screen. React like a friend in a line or two, then ask for top, bottom, and shoe sizes together in one question.`;
          }
          return renderedOnModel
            ? `Try-on for Look ${lookNum} (on a model because the camera is off) is ready, but the page did not confirm revealing it.`
            : `Try-on for Look ${lookNum} is ready, but the page did not confirm revealing it.`;
        }

        return `The fitting room is jammed right now for Look ${lookNum} (${outfit.name}). Keep it light and offer the flat-lay and individual pieces instead.${cameraOffFallbackNote}`;
      }),
    }),

    swap_piece: llm.tool({
      description: 'Swap a single piece in a look (defaults to the picked look) for something matching the request.',
      parameters: z.object({
        outfit: outfitNumberSchema.optional(),
        slot: slotSchema,
        request: z.string().describe('What the shopper wants instead for this piece'),
      }),
      execute: wrapper.wrap('swap_piece', async ({ outfit: requestedOutfit, slot, request }) => {
        const resolved = resolveLook(requestedOutfit);
        if (!resolved) {
          return `No look selected for a swap. ${availableLookHint()}`;
        }

        const { lookNum, outfit } = resolved;
        const existingPiece = findPieceInOutfit(outfit, slot);
        const targetSlot = existingPiece?.slot ?? slot;
        const started = nowFn();

        const swapResult = await swapPieceFn(outfit, targetSlot, request, currentBrief(), {
          room: options.room,
        });
        const ms = Math.max(0, Math.round(nowFn() - started));

        const updatedOutfit: Outfit = { ...swapResult.outfit, number: lookNum };
        outfitsByNumber.set(lookNum, updatedOutfit);
        stateStore.dispatch({
          type: 'update_look',
          look: outfitToStateLook(updatedOutfit, lookNum),
        });

        const reply = await page.send('updateOutfit', {
          outfit: lookNum,
          data: updatedOutfit,
          slot: targetSlot,
        });

        startBackgroundMediaForLook(updatedOutfit);
        wrapper.invalidate('swap_piece');

        const newItem = swapResult.piece?.item;
        logFn(options.room, 'swap', {
          outfit: lookNum,
          slot: targetSlot,
          request,
          ms,
          title: newItem?.title ?? null,
          price: newItem?.price ?? null,
          store: newItem?.store ?? null,
          total: updatedOutfit.total,
          ...(swapResult.note ? { note: swapResult.note } : {}),
        });

        const pieceDesc = newItem
          ? `${newItem.title} (${formatPrice(newItem.price)}, ${newItem.store})`
          : targetSlot;
        const screenStatus = reply.ok
          ? `Updated Look ${lookNum} on screen`
          : `Updated Look ${lookNum} (page did not confirm the visual update)`;
        const notePart = swapResult.note ? ` Note: ${swapResult.note}` : '';

        return `${screenStatus}: ${targetSlot} is now ${pieceDesc}. New look total: ${formatPrice(updatedOutfit.total)}.${notePart} Try-on and flat-lay are refreshing. Name only the replacement piece and new total.`;
      }),
    }),

    show_product: llm.tool({
      description: 'Open product details for a single piece in a look (defaults to the picked look).',
      parameters: z.object({
        outfit: outfitNumberSchema.optional(),
        slot: slotSchema,
      }),
      execute: wrapper.wrap('show_product', async ({ outfit: requestedOutfit, slot }) => {
        const resolved = resolveLook(requestedOutfit);
        if (!resolved) {
          return `No look selected to inspect. ${availableLookHint()}`;
        }

        const { lookNum, outfit } = resolved;
        const piece = findPieceInOutfit(outfit, slot);
        if (!piece) {
          const slots = outfit.pieces.map((p) => p.slot).join(', ');
          return `Look ${lookNum} does not have a ${slot} piece. Available slots in Look ${lookNum}: ${slots}.`;
        }

        let images: string[] = [];
        if (typeof mediaProductImagesFn === 'function') {
          try {
            const fetched = await mediaProductImagesFn(piece.item);
            if (Array.isArray(fetched)) {
              images = fetched
                .map((u) => sanitizePageMediaUrl(u))
                .filter((u): u is string => u !== null);
            }
          } catch {
            images = [];
          }
        }
        if (images.length === 0) {
          try {
            const storeMod = await loadStoreModuleFn();
            if (
              typeof storeMod?.productImages === 'function' &&
              storeMod.productImages !== mediaProductImagesFn
            ) {
              const storeFetched = await storeMod.productImages(piece.item);
              if (Array.isArray(storeFetched)) {
                images = storeFetched
                  .map((u) => sanitizePageMediaUrl(u))
                  .filter((u): u is string => u !== null);
              }
            }
          } catch {
            images = [];
          }
        }
        if (images.length === 0) {
          const fallbackImg = sanitizePageMediaUrl(piece.item.image);
          if (fallbackImg) {
            images = [fallbackImg];
          }
        }

        const details = deriveProductDetails(piece.item.description);
        const reply = await page.send('showProduct', {
          item: piece.item,
          images,
          slot: piece.slot,
          why: piece.why,
          sizes: piece.item.sizes,
          details,
          description: piece.item.description,
        });

        const sizesText =
          piece.item.sizes.length > 0 ? piece.item.sizes.join(', ') : 'sizes not listed';
        const descText = piece.item.description?.trim() || 'No store description provided.';
        const statusLine = reply.ok
          ? `Showing product page on screen for Look ${lookNum} ${piece.slot}:`
          : `Loaded product details for Look ${lookNum} ${piece.slot} (page did not confirm opening the drawer):`;

        return [
          `${statusLine} ${piece.item.title} — ${formatPrice(piece.item.price)} at ${piece.item.store}.`,
          `Sizes in stock: ${sizesText}.`,
          `Description (state materials/construction strictly from this text only): ${descText}`,
          `Why it works in the look: ${piece.why}`,
        ].join('\n');
      }),
    }),

    hide_product: llm.tool({
      description: 'Close the currently open product detail drawer.',
      execute: wrapper.wrap('hide_product', async () => {
        const reply = await page.send('hideProduct', {});
        return reply.ok
          ? 'Closed the product view on screen.'
          : 'Tried to close the product view, though the page did not confirm.';
      }),
    }),

    show_all_looks: llm.tool({
      description: 'Return the screen to showing all three looks side by side.',
      execute: wrapper.wrap('show_all_looks', async () => {
        cancelWalk();
        stateStore.dispatch({ type: 'pick_look', look: null });
        const reply = await page.send('showAll', {});
        return reply.ok
          ? 'Showing all looks side by side on screen.'
          : 'Switched back to all looks, though the page did not confirm.';
      }),
    }),

    search_products: llm.tool({
      description: 'Search the store catalog for standalone products.',
      parameters: z.object({
        query: z.string().describe('Product search query'),
        max_price: z.number().optional().describe('Optional maximum price in US dollars'),
      }),
      execute: wrapper.wrap('search_products', async ({ query, max_price }) => {
        let searchFn = options.deps?.searchProducts;
        if (!searchFn) {
          const storeMod = await loadStoreModuleFn();
          if (typeof storeMod?.searchMixed === 'function') {
            searchFn = storeMod.searchMixed;
          } else if (typeof storeMod?.search === 'function') {
            searchFn = storeMod.search;
          }
        }

        if (!searchFn) {
          return 'Standalone product search is not available yet. Steer back to the curated looks or offer to swap a piece in one of them.';
        }

        const gender: Gender = stateStore.get().department ?? 'women';
        const searchOpts: SearchOpts = { limit: 8 };
        if (max_price !== undefined) {
          searchOpts.maxPrice = max_price;
        }

        const res = await searchFn(query, gender, searchOpts);
        const items = Array.isArray(res?.items) ? res.items : [];
        const reply = await page.send('showSearch', { query, items });

        if (items.length === 0) {
          return `Nothing in stock matched "${query}"${max_price !== undefined ? ` under ${formatPrice(max_price)}` : ''}. Steer back to the curated looks.`;
        }

        const list = items
          .slice(0, 8)
          .map((item) => `${item.title} (${formatPrice(item.price)}, ${item.store})`)
          .join('; ');
        const screenNote = reply.ok
          ? `Shown ${items.length} results for "${query}" on screen:`
          : `Found ${items.length} results for "${query}" (page did not confirm displaying them):`;

        return `${screenNote} ${list}`;
      }),
    }),

    add_to_bag: llm.tool({
      description: 'Add a look (defaults to the picked look) to the shopping bag using a map of piece slot to size label. Carts only, never checkout or payment.',
      parameters: z.object({
        outfit: outfitNumberSchema.optional(),
        sizes: z
          .record(z.string(), z.string())
          .describe('Map of piece slot to size label, e.g. {"top": "M", "shoes": "10"}'),
      }),
      execute: wrapper.wrap('add_to_bag', async ({ outfit: requestedOutfit, sizes }) => {
        const resolved = resolveLook(requestedOutfit);
        if (!resolved) {
          return `NOT DONE: No look selected to add to the bag. ${availableLookHint()}`;
        }

        const { lookNum, outfit } = resolved;
        if (sizes && Object.keys(sizes).length > 0) {
          stateStore.dispatch({ type: 'merge_sizes', sizes });
        }

        const rememberedSizes = stateStore.get().sizes;
        const missingSlots: string[] = [];
        const resolvedSizes: Record<string, string> = { ...rememberedSizes };

        for (const piece of outfit.pieces) {
          const slotLower = piece.slot.toLowerCase();
          const slotNorm = normalizeSlotKey(piece.slot);
          const heard =
            rememberedSizes[slotLower] ??
            rememberedSizes[slotNorm] ??
            (slotNorm === 'dress' || slotNorm === 'layer' ? rememberedSizes.top : undefined);

          if (heard) {
            resolvedSizes[slotLower] = heard;
          }

          if (Array.isArray(piece.item.sizes) && piece.item.sizes.length > 1 && !heard) {
            if (!missingSlots.includes(piece.slot)) {
              missingSlots.push(piece.slot);
            }
          }
        }

        if (missingSlots.length > 0) {
          return `NOT DONE: Still need sizes for: ${missingSlots.join(', ')}. Ask for just those in one question, then call add_to_bag again.`;
        }

        const dedupeKey = stableStringify({
          outfit: lookNum,
          pieces: outfit.pieces.map((p) => ({
            slot: p.slot,
            id: p.item.id,
            variant_id: p.item.variant_id,
            size: resolvedSizes[p.slot.toLowerCase()] ?? null,
          })),
        });

        const earlier = baggedResults.get(dedupeKey);
        if (earlier) {
          return `Already in the bag. ${earlier}`;
        }

        let addToBagFn = options.deps?.addToBag;
        let usedMock = false;
        let storeImportFailed = false;
        if (!addToBagFn) {
          const storeMod = await loadStoreModuleFn();
          if (storeMod === null) {
            storeImportFailed = true;
          } else if (typeof storeMod.addToBag === 'function') {
            addToBagFn = storeMod.addToBag;
          }
        }

        const gender: Gender = stateStore.get().department ?? 'women';
        let bagOut: BagOut;
        if (addToBagFn) {
          bagOut = await addToBagFn(outfit, resolvedSizes, gender);
        } else if (storeImportFailed) {
          usedMock = true;
          bagOut = mockAddToBag(outfit, resolvedSizes, gender);
        } else {
          return 'NOT DONE: Store shopping bag is not available right now. Do not claim the bag is ready.';
        }

        const bagPayload = bagOutToPagePayload(bagOut, outfit, resolvedSizes);

        const notAdded: BagNotAdded[] = [];
        for (const store of bagPayload.stores) {
          for (const line of store.not_added) {
            notAdded.push({
              store: store.store,
              title: line.title,
              reason: line.reason ?? 'unavailable',
            });
          }
        }

        const rawSummary = typeof bagOut.summary === 'string' ? bagOut.summary.trim() : '';
        const isNotDoneSummary = /^NOT DONE:/i.test(rawSummary);

        if (!usedMock && isNotDoneSummary) {
          const afterPrefix = rawSummary.replace(/^NOT DONE:\s*/i, '').trim();
          const notAddedLines = bagPayload.stores.flatMap((store) =>
            store.not_added.map((line) => ({
              title: line.title,
              slot: line.slot,
              reason: line.reason ?? '',
            })),
          );
          const missingSizeLines = notAddedLines.filter((l) => /size/i.test(l.reason));
          const targetLines = missingSizeLines.length > 0 ? missingSizeLines : notAddedLines;
          const summaryMentionsAll =
            afterPrefix.length > 0 &&
            (targetLines.length === 0 ||
              targetLines.every((l) =>
                afterPrefix.toLowerCase().includes(l.title.toLowerCase()),
              ));

          if (summaryMentionsAll) {
            const sentence = afterPrefix.endsWith('.') ? afterPrefix : `${afterPrefix}.`;
            return `NOT DONE: ${sentence} Ask for just those in one question, then call add_to_bag again.`;
          }
          if (targetLines.length > 0) {
            const pieceList = targetLines
              .map((l) => (l.slot ? `${l.title} (${l.slot})` : l.title))
              .join(', ');
            return `NOT DONE: Still need sizes for: ${pieceList}. Ask for just those in one question, then call add_to_bag again.`;
          }
          return `NOT DONE: ${afterPrefix || 'Some pieces still need a size.'} Ask for the missing sizes in one question, then call add_to_bag again.`;
        }

        if (!usedMock && !hasRealCart(bagOut)) {
          const skippedSummaries = notAdded.map(
            (na) => `${na.title} at ${na.store} (${na.reason.replace(/\.$/, '')})`,
          );
          if (skippedSummaries.length > 0) {
            return `NOT DONE: Added 0 pieces, total $0. Not added (${notAdded.length}): ${skippedSummaries.join('; ')}. No checkout links are on the page. Name each piece that was not added with its reason in plain words, and offer to swap those pieces or try another size. Never say the bag is processing and never pitch a different look.`;
          }
          const reason = rawSummary ? ` ${rawSummary}` : '';
          return `NOT DONE: Added 0 pieces, total $0. No store cart could be created.${reason} No checkout links are on the page. Offer to try another size or swap a piece. Never say the bag is processing and never pitch a different look.`;
        }

        const reply = await page.send('bagReady', bagPayload);

        stateStore.dispatch({
          type: 'set_bag',
          bag: {
            stores: bagPayload.stores,
            total: bagPayload.total,
            links: bagPayload.links,
            notAdded,
          },
        });

        logFn(options.room, 'bag', {
          outfit: lookNum,
          stores: bagPayload.stores.map((s) => ({
            store: s.store,
            added: s.added.length,
            not_added: s.not_added.length,
            subtotal: s.subtotal,
          })),
          total: bagPayload.total,
          not_added: notAdded,
          mocked: usedMock,
        });

        const addedCount = bagPayload.stores.reduce((sum, s) => sum + s.added.length, 0);
        const storeSummaries = bagPayload.stores
          .filter((s) => s.added.length > 0)
          .map((s) => {
            const items = s.added
              .map((line) => `${line.title}${line.size ? ` (size ${line.size})` : ''}`)
              .join(', ');
            return `${s.store}: ${items}`;
          });

        const skippedSummaries = notAdded.map(
          (na) => `${na.title} at ${na.store} (${na.reason.replace(/\.$/, '')})`,
        );

        const lines: string[] = [];
        const pieceWord = addedCount === 1 ? 'piece' : 'pieces';
        const addedDetails = storeSummaries.length > 0 ? ` — ${storeSummaries.join(' | ')}` : '';
        lines.push(
          `Added ${addedCount} ${pieceWord}, total ${formatPrice(bagPayload.total)} for Look ${lookNum} (${outfit.name})${addedDetails}.`,
        );

        if (skippedSummaries.length > 0) {
          lines.push(`Not added (${notAdded.length}): ${skippedSummaries.join('; ')}.`);
        }

        if (reply.ok) {
          if (bagPayload.links.length > 0) {
            const linkStores = bagPayload.links.map((l) => l.store).join(', ');
            const linkPhrase =
              bagPayload.links.length === 1 ? 'Checkout link is' : 'Checkout links are';
            lines.push(`${linkPhrase} on the page (${linkStores}).`);
          } else {
            lines.push('Bag is on the page (no store checkout links).');
          }
        } else {
          lines.push(
            'Checkout links were prepared, though the page did not confirm displaying the bag yet.',
          );
        }

        if (usedMock || /mock/i.test(bagOut.summary)) {
          lines.push(`Note: ${bagOut.summary}`);
        }

        if (skippedSummaries.length > 0) {
          lines.push(
            'State plainly what is in the bag and the total, name each piece that was not added with its reason in plain words, and offer to swap those pieces or try another size. Never say the bag is processing and never pitch a different look.',
          );
        } else {
          lines.push(
            'State plainly what is in the bag, the total, and that the checkout links are on the page. Never say the bag is processing and never pitch a different look.',
          );
        }

        const resultText = lines.join(' ');
        baggedResults.set(dedupeKey, resultText);
        return resultText;
      }),
    }),
  };
}
