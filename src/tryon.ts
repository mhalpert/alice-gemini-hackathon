import { mediaRequest } from './media/client.ts';
import { logEvent } from './store/log.ts';
import type { Outfit } from './types.ts';

export async function tryOn(
  personJpeg: Buffer | null,
  outfit: Outfit,
  opts?: { label?: string },
): Promise<{ url: string; path: string; ms: number; id: string }> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? opts?.label ?? null;
  const piecesCount = Array.isArray(outfit?.pieces) ? outfit.pieces.length : 0;

  logEvent('tryon_start', { outfit: outfitTag, pieces: piecesCount });

  try {
    const res = await mediaRequest<{ url: string; path: string; ms: number; id: string }>(
      'tryOn',
      { personJpeg, outfit, opts },
      120_000,
    );
    logEvent('tryon_ready', {
      outfit: outfitTag,
      id: res.id,
      url: res.url,
      ms: res.ms,
    });
    return res;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logEvent('tryon_fail', {
      outfit: outfitTag,
      error: error.message,
      ms: Date.now() - t0,
    });
    throw error;
  }
}
