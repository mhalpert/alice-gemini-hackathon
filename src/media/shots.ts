import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import { getProduct } from '../store/catalog.ts';
import type { Item } from '../types.ts';
import { safeFetchImageBuffer } from './limits.ts';
import {
  classifyShotSource,
  collectImageUrls,
  cropRawRgb,
  decideCrop,
  parsePickReply,
  publicUrl,
  resolvePick,
  shotCacheKey,
  shotFileName,
  tryonDir,
  whitenBackground,
  withWidth,
} from './pure.ts';

export type ShotSource = 'product-only' | 'cropped' | 'original';

export interface ChildShotResult {
  filePath: string | null;
  url: string;
  source: ShotSource;
}

interface ThumbEntry {
  origUrl: string;
  jpegB64: string;
  rawBuf: Buffer;
}

const DISK_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5000;
const PICKER_TIMEOUT_MS = 4000;
const MAX_PICKER_IMAGES = 6;
const CANDIDATE_FETCH_WIDTH = 800;
const THUMB_SIZE = 256;

const shotCache = new Map<string, ChildShotResult>();
const shotInFlight = new Map<string, Promise<ChildShotResult>>();

let aiClient: GoogleGenAI | null = null;

export function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GOOGLE_TRYON_API_KEY || process.env.GOOGLE_API_KEY,
    });
  }
  return aiClient;
}

export async function writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, filePath);
}

export async function fetchImageBuffer(url: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Buffer> {
  return safeFetchImageBuffer(url, { timeoutMs });
}

async function downloadThumb(
  origUrl: string,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<ThumbEntry | null> {
  try {
    const rawBuf = await fetchImageBuffer(withWidth(origUrl, CANDIDATE_FETCH_WIDTH), timeoutMs);
    const jpegBuf = await sharp(rawBuf)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { origUrl, jpegB64: jpegBuf.toString('base64'), rawBuf };
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildPickerInstructions(title: string, slot: string): string {
  return [
    `Item: "${title}" (slot: ${slot}).`,
    'Image 0 shows the exact colourway being bought and is the store main front photo.',
    'Never choose a detail shot, close-up, or back view: the ENTIRE item must be fully inside the frame (for a shirt or top: both shoulders, both sleeves, and the hem; for shoes: the whole shoe from heel to toe).',
    'Rule for picking index:',
    '(1) If Image 0 shows NO person and shows the whole item, pick index 0.',
    '(2) Otherwise, if any other image shows NO person (flat lay, ghost mannequin, or packshot) and the whole item in the same colour as Image 0 (front/side view, never a back view), pick it.',
    '(3) When EVERY image shows a person, pick Image 0 (the store main front view) as long as the whole item is visible in Image 0; only fall back to another on-model front-view image when Image 0 cuts the item off or is a detail shot. NEVER pick a back view.',
    'When the chosen image shows a person, box the whole item (exclude face, head, and beard; start below the chin; exclude unrelated garments like trousers or bags).',
    'Also return product_only: an array of all image indexes that show NO person and the WHOLE item in the same colour as Image 0 (never back views).',
    'Also return back_view: an array of all image indexes that show the back of the garment or the back of a model.',
    'Also return chin_y: the y coordinate (0-1000) of the lowest point of the chin or beard of any person in the chosen image, or null if no head is visible.',
    'Return JSON: {"index": <integer>, "has_person": <boolean>, "box_2d": [ymin, xmin, ymax, xmax] | null, "chin_y": <number|null>, "product_only": [<integer>, ...], "back_view": [<integer>, ...]} on a 0-1000 scale, where has_person is true if any part of a human is visible.',
  ].join(' ');
}

async function computeProductShot(item: Item, slot: string): Promise<ChildShotResult> {
  const t0 = Date.now();
  const fallback: ChildShotResult = { filePath: null, url: item.image, source: 'original' };

  const name = shotFileName(item);
  const filePath = path.join(tryonDir(), name);

  // Check disk cache (< 6 hours old)
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && stat.size > 0 && Date.now() - stat.mtimeMs < DISK_CACHE_MAX_AGE_MS) {
      const cached: ChildShotResult = {
        filePath,
        url: publicUrl(name),
        source: 'product-only',
      };
      shotCache.set(shotCacheKey(item), cached);
      return cached;
    }
  } catch {
    // Not on disk yet
  }

  // 1-2. Run getProduct and Image 0 download (800px raw + 256px picker thumb) concurrently
  const tMedia = Date.now();
  const mediaPromise = getProduct(item.variant_id)
    .catch(() => null)
    .then((detail) => ({ detail, ms: Date.now() - tMedia }));
  const tThumb0 = Date.now();
  const thumb0Promise = downloadThumb(item.image).then((entry) => ({
    entry,
    ms: Date.now() - tThumb0,
  }));

  const [{ detail, ms: mediaMs }, { entry: thumb0, ms: thumb0Ms }] = await Promise.all([
    mediaPromise,
    thumb0Promise,
  ]);

  const extraUrls = Array.isArray(detail?.images) ? detail.images : [];
  const candidates = collectImageUrls(item.image, extraUrls, MAX_PICKER_IMAGES);
  if (candidates.length === 0) {
    return fallback;
  }

  // 3. Download remaining candidate thumbnails (at 800 px once, resized to 256 px for picker)
  const tRestThumbs = Date.now();
  const restEntries =
    candidates.length > 1
      ? await Promise.all(
          candidates.slice(1).map((origUrl) => downloadThumb(origUrl, DOWNLOAD_TIMEOUT_MS)),
        )
      : [];
  const thumbsMs = candidates.length > 1 ? Date.now() - tRestThumbs : thumb0Ms;

  const firstEntry = candidates[0] === item.image ? thumb0 : await downloadThumb(candidates[0]);
  const thumbs: ThumbEntry[] = [];
  if (firstEntry) thumbs.push(firstEntry);
  for (const entry of restEntries) {
    if (entry) thumbs.push(entry);
  }
  if (thumbs.length === 0) {
    return fallback;
  }

  // One Flash Lite call with consistent sequential labels Image 0..n
  let chosenIndex = 0;
  let hasPerson = true;
  let box2d: [number, number, number, number] | null = null;
  let chinY: number | null = null;

  const pickerModel = process.env.ALICE_MODEL_FAST || 'gemini-3.5-flash-lite';
  const tPick = Date.now();
  try {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    for (let i = 0; i < thumbs.length; i++) {
      parts.push({ text: `Image ${i}:` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: thumbs[i].jpegB64 } });
    }
    parts.push({ text: buildPickerInstructions(item.title, slot) });

    const r = await withTimeout(
      getGenAI().models.generateContent({
        model: pickerModel,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'MINIMAL' as never },
        },
      }),
      PICKER_TIMEOUT_MS,
      'shot-pick',
    );
    const callMs = Date.now() - tPick;

    void recordCost({
      model: pickerModel,
      job: 'shot-pick',
      input_tokens: r.usageMetadata?.promptTokenCount,
      output_tokens: r.usageMetadata?.candidatesTokenCount,
      ms: callMs,
    });

    const parsed = parsePickReply(r.text);
    const resolved = resolvePick(parsed, thumbs.length);
    chosenIndex = resolved.index;
    hasPerson = resolved.has_person;
    box2d = resolved.box_2d;
    chinY = resolved.chin_y;
  } catch (err) {
    console.error(`[media] shot-pick failed for "${item.title.slice(0, 40)}":`, (err as Error)?.message);
    chosenIndex = 0;
    hasPerson = true;
    box2d = null;
    chinY = null;
  }
  const pickMs = Date.now() - tPick;

  // 4. Reuse the already-downloaded 800 px buffer (0ms post-pick fetch!)
  const tFetch = Date.now();
  const chosen = thumbs[chosenIndex];
  const fullBuf = chosen.rawBuf;
  const fetchMs = Date.now() - tFetch;

  // 5-6. Decode directly to raw RGB (no intermediate PNG), crop below chin, whiten background, fit 800x800 white square
  const tProcess = Date.now();
  const { data: decodedRgb, info: decodedInfo } = await sharp(fullBuf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const imgW = decodedInfo.width;
  const imgH = decodedInfo.height;
  const channels = decodedInfo.channels;
  if (imgW <= 0 || imgH <= 0) {
    return fallback;
  }

  const crop = decideCrop(imgW, imgH, hasPerson, box2d, { chinY, slot });
  const rawRgb = crop
    ? cropRawRgb(decodedRgb, imgW, imgH, channels, crop)
    : decodedRgb;
  const outW = crop ? crop.width : imgW;
  const outH = crop ? crop.height : imgH;

  if (channels === 3) {
    whitenBackground(rawRgb, outW, outH);
  }

  const finalBuf = await sharp(rawRgb, {
    raw: {
      width: outW,
      height: outH,
      channels: channels as 1 | 2 | 3 | 4,
    },
  })
    .resize(768, 768, { fit: 'contain', background: '#ffffff' })
    .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer();

  await writeFileAtomic(filePath, finalBuf);
  const processMs = Date.now() - tProcess;

  const source: ShotSource = classifyShotSource(hasPerson);
  const result: ChildShotResult = {
    filePath,
    url: publicUrl(name),
    source,
  };

  shotCache.set(shotCacheKey(item), result);
  console.log(
    `[shot] ${slot} "${item.title.slice(0, 40)}" ${source} ${Date.now() - t0}ms (media=${mediaMs}ms thumbs=${thumbsMs}ms pick=${pickMs}ms fetch=${fetchMs}ms process=${processMs}ms)`,
  );
  return result;
}

export async function getProductShot(item: Item, slot: string): Promise<ChildShotResult> {
  if (!item || typeof item.image !== 'string' || item.image.length === 0) {
    return { filePath: null, url: '', source: 'original' };
  }

  const key = shotCacheKey(item);
  const mem = shotCache.get(key);
  if (mem && mem.filePath) {
    try {
      const stat = await fs.promises.stat(mem.filePath);
      if (stat.isFile() && stat.size > 0 && Date.now() - stat.mtimeMs < DISK_CACHE_MAX_AGE_MS) {
        return mem;
      }
      shotCache.delete(key);
    } catch {
      shotCache.delete(key);
    }
  }

  const existing = shotInFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = computeProductShot(item, slot)
    .catch((err): ChildShotResult => {
      console.error(`[media] productShot error for "${item.title.slice(0, 40)}":`, (err as Error)?.message);
      return { filePath: null, url: item.image, source: 'original' };
    })
    .finally(() => {
      shotInFlight.delete(key);
    });

  shotInFlight.set(key, promise);
  return promise;
}
