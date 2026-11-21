import fs from 'node:fs';
import { logEvent } from '../store/log.ts';
import type { Item, Outfit } from '../types.ts';
import { mediaRequest } from './client.ts';
import { shotCacheKey } from './pure.ts';

export { productImages, setCallRoom } from '../store/index.ts';

export type ProductShotResult = {
  buf: Buffer | null;
  url: string;
  source: 'product-only' | 'cropped' | 'original';
};

interface ChildShotReply {
  filePath: string | null;
  url: string;
  source: 'product-only' | 'cropped' | 'original';
}

const shotCache = new Map<string, ProductShotResult>();
const shotInFlight = new Map<string, Promise<ProductShotResult>>();

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

export async function outfitCollage(outfit: Outfit, label?: string): Promise<string | null> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? label ?? null;
  try {
    if (!outfit || !Array.isArray(outfit.pieces) || outfit.pieces.length === 0) {
      logEvent('media_board', { outfit: outfitTag, ok: false, ms: Date.now() - t0 });
      return null;
    }
    const url = await mediaRequest<string | null>('collage', { outfit, label }, 15_000);
    const out = typeof url === 'string' && url.length > 0 ? url : null;
    logEvent('media_board', { outfit: outfitTag, ok: Boolean(out), ms: Date.now() - t0 });
    return out;
  } catch {
    logEvent('media_board', { outfit: outfitTag, ok: false, ms: Date.now() - t0 });
    return null;
  }
}
