// MOCK until the media process lands; signatures are the contract.
import type { Item, Outfit } from '../types.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function productShot(
  item: Item,
  _slot: string,
): Promise<{ buf: Buffer | null; url: string; source: 'product-only' | 'cropped' | 'original' } | null> {
  try {
    await sleep(300);
    if (!item || typeof item.image !== 'string') {
      return null;
    }
    return { buf: null, url: item.image, source: 'original' };
  } catch {
    return null;
  }
}

export async function outfitCollage(outfit: Outfit, _label?: string): Promise<string | null> {
  try {
    await sleep(400);
    const firstImage = outfit?.pieces?.[0]?.item?.image;
    return typeof firstImage === 'string' && firstImage.length > 0 ? firstImage : null;
  } catch {
    return null;
  }
}

export async function productImages(item: Item): Promise<string[]> {
  try {
    if (!item || typeof item.image !== 'string' || item.image.length === 0) {
      return [];
    }
    return [item.image];
  } catch {
    return [];
  }
}
