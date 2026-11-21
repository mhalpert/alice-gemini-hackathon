import fs from 'node:fs';
import { logEvent } from '../store/log.ts';
import type { BoardBoxes, Item, Outfit } from '../types.ts';
import { mediaRequest } from './client.ts';
import { boardBuildKey, shotCacheKey } from './pure.ts';

export { productImages, setCallRoom } from '../store/index.ts';

export type ProductShotResult = {
  buf: Buffer | null;
  url: string;
  source: 'product-only' | 'cropped' | 'original';
};

export interface OutfitBoardResult {
  url: string;
  boxes: BoardBoxes;
}

interface ChildShotReply {
  filePath: string | null;
  url: string;
  source: 'product-only' | 'cropped' | 'original';
}

interface ChildCollageReply {
  url?: unknown;
  path?: unknown;
  boxes?: unknown;
}

const shotCache = new Map<string, ProductShotResult>();
const shotInFlight = new Map<string, Promise<ProductShotResult>>();
const boardInFlight = new Map<string, Promise<OutfitBoardResult | null>>();

export async function warmMedia(): Promise<void> {
  try {
    await mediaRequest('ping', undefined, 5_000);
  } catch {
    // Never throws
  }
}

export async function productShot(item: Item, slot: string): Promise<ProductShotResult | null> {
  const t0 = Date.now();
  try {
    if (!item || typeof item.image !== 'string' || item.image.length === 0) {
      return null;
    }

    if (process.env.ALICE_CLEAN_SHOTS === 'off') {
      const out: ProductShotResult = { buf: null, url: item.image, source: 'original' };
      logEvent('media_shot', { slot, title: item.title, source: out.source, ms: Date.now() - t0 });
      return out;
    }

    const key = shotCacheKey(item);
    const cached = shotCache.get(key);
    if (cached) {
      logEvent('media_shot', { slot, title: item.title, source: cached.source, ms: Date.now() - t0 });
      return cached;
    }

    const inflight = shotInFlight.get(key);
    if (inflight) {
      const res = await inflight;
      logEvent('media_shot', { slot, title: item.title, source: res.source, ms: Date.now() - t0 });
      return res;
    }

    const promise = (async (): Promise<ProductShotResult> => {
      try {
        const res = await mediaRequest<ChildShotReply>('productShot', { item, slot }, 12_000);
        if (!res || typeof res.url !== 'string' || res.url.length === 0) {
          return { buf: null, url: item.image, source: 'original' };
        }

        let buf: Buffer | null = null;
        if (typeof res.filePath === 'string' && res.filePath.length > 0) {
          try {
            buf = await fs.promises.readFile(res.filePath);
          } catch {
            buf = null;
          }
        }

        const out: ProductShotResult = {
          buf,
          url: res.url,
          source: res.source === 'product-only' || res.source === 'cropped' ? res.source : 'original',
        };

        if (out.source !== 'original') {
          shotCache.set(key, out);
        }
        return out;
      } catch {
        return { buf: null, url: item.image, source: 'original' };
      } finally {
        shotInFlight.delete(key);
      }
    })();

    shotInFlight.set(key, promise);
    const out = await promise;
    logEvent('media_shot', { slot, title: item.title, source: out.source, ms: Date.now() - t0 });
    return out;
  } catch {
    if (item && typeof item.image === 'string' && item.image.length > 0) {
      logEvent('media_shot', { slot, title: item.title, source: 'original', ms: Date.now() - t0 });
      return { buf: null, url: item.image, source: 'original' };
    }
    return null;
  }
}

function normalizeBoardBoxes(raw: unknown): BoardBoxes {
  const out: BoardBoxes = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [slot, val] of Object.entries(raw as Record<string, unknown>)) {
    if (
      Array.isArray(val) &&
      val.length === 4 &&
      val.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      out[slot] = [val[0], val[1], val[2], val[3]];
    }
  }
  return out;
}

async function buildOutfitBoard(
  outfit: Outfit,
  label?: string,
): Promise<OutfitBoardResult | null> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? label ?? null;

  if (!outfit || !Array.isArray(outfit.pieces) || outfit.pieces.length === 0) {
    logEvent('media_board', { outfit: outfitTag, ok: false, ms: Date.now() - t0 });
    return null;
  }

  const key = boardBuildKey(outfit, label);
  const existing = boardInFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<OutfitBoardResult | null> => {
    try {
      const reply = await mediaRequest<ChildCollageReply | string | null>(
        'collage',
        { outfit, label },
        15_000,
      );

      let out: OutfitBoardResult | null = null;
      if (typeof reply === 'string' && reply.length > 0) {
        out = { url: reply, boxes: {} };
      } else if (
        reply &&
        typeof reply === 'object' &&
        typeof reply.url === 'string' &&
        reply.url.length > 0
      ) {
        out = { url: reply.url, boxes: normalizeBoardBoxes(reply.boxes) };
      }

      logEvent('media_board', { outfit: outfitTag, ok: Boolean(out), ms: Date.now() - t0 });
      return out;
    } catch {
      logEvent('media_board', { outfit: outfitTag, ok: false, ms: Date.now() - t0 });
      return null;
    } finally {
      if (boardInFlight.get(key) === promise) {
        boardInFlight.delete(key);
      }
    }
  })();

  boardInFlight.set(key, promise);
  return promise;
}

export async function outfitBoard(
  outfit: Outfit,
  label?: string,
): Promise<OutfitBoardResult | null> {
  try {
    return await buildOutfitBoard(outfit, label);
  } catch {
    return null;
  }
}

export async function outfitCollage(outfit: Outfit, label?: string): Promise<string | null> {
  try {
    const board = await buildOutfitBoard(outfit, label);
    return board ? board.url : null;
  } catch {
    return null;
  }
}
