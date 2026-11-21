// MOCK until the media process lands; signatures are the contract.
import crypto from 'node:crypto';
import type { Outfit } from './types.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function tryOn(
  _personJpeg: Buffer | null,
  outfit: Outfit,
  _opts?: { label?: string },
): Promise<{ url: string; path: string; ms: number; id: string }> {
  const start = Date.now();
  try {
    const rawMs = Number(process.env.ALICE_MOCK_TRYON_MS ?? 3000);
    const delayMs = Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : 3000;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const firstImage = outfit?.pieces?.[0]?.item?.image;
    const url = typeof firstImage === 'string' ? firstImage : '';
    return {
      url,
      path: '',
      ms: Date.now() - start,
      id: crypto.randomBytes(8).toString('hex'),
    };
  } catch {
    return {
      url: '',
      path: '',
      ms: Date.now() - start,
      id: crypto.randomBytes(8).toString('hex'),
    };
  }
}
