import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import { getProduct } from '../store/catalog.ts';
import type { Item } from '../types.ts';
import {
  collectImageUrls,
  decideCrop,
  parsePickReply,
  publicUrl,
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
const PICKER_TIMEOUT_MS = 6000;

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
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain')) {
    throw new Error(`Non-image content-type "${ct}" for ${url}`);
  }
  const arr = await res.arrayBuffer();
  if (arr.byteLength === 0) {
    throw new Error(`Empty response for ${url}`);
  }
  return Buffer.from(arr);
}

async function downloadThumb(origUrl: string): Promise<ThumbEntry | null> {
  try {
    const rawBuf = await fetchImageBuffer(withWidth(origUrl, 384), DOWNLOAD_TIMEOUT_MS);
    const jpegBuf = await sharp(rawBuf)
      .rotate()
      .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
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
    'Image 0 shows the exact colourway being bought.',
    'Pick the ONE image showing this exact item, fully visible, in the same colour as Image 0 (never another colourway).',
    'Strongly prefer an image with NO person (flat lay, ghost mannequin, or packshot).',
    'Avoid fabric close-ups, back views, and lifestyle scenes.',
    'If every image shows a person, pick the clearest front view; the box must contain only the item: no face, no head, no beard; start below the chin (for shoes, just the shoes).',
    'Also return chin_y: the y coordinate (0-1000) of the lowest point of the chin or beard of any person in the chosen image, or null if no head is visible.',
    'Return JSON with keys: {"index": <integer>, "has_person": <boolean>, "box_2d": [ymin, xmin, ymax, xmax], "chin_y": <number|null>} on a 0-1000 scale, where has_person is true if any part of a human is visible.',
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

  // 1-2. Run getProduct and Image 0 thumbnail download concurrently
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
  const candidates = collectImageUrls(item.image, extraUrls, 8);
  if (candidates.length === 0) {
    return fallback;
  }

  // 3. Download remaining 384 px thumbnails in parallel
  const tRestThumbs = Date.now();
  const restEntries =
    candidates.length > 1
      ? await Promise.all(candidates.slice(1).map((origUrl) => downloadThumb(origUrl)))
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

  // Speculatively download 1000 px Image 0 in parallel with Flash Lite picker
  const specFull0Promise: Promise<Buffer | null> = fetchImageBuffer(
    withWidth(thumbs[0].origUrl, 1000),
    DOWNLOAD_TIMEOUT_MS,
  ).catch(() => null);

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
    if (parsed && parsed.index >= 0 && parsed.index < thumbs.length) {
      chosenIndex = parsed.index;
      hasPerson = parsed.has_person;
      box2d = parsed.box_2d;
      chinY = parsed.chin_y;
    } else {
      chosenIndex = 0;
      hasPerson = true;
      box2d = null;
      chinY = null;
    }
  } catch (err) {
    console.error(`[media] shot-pick failed for "${item.title.slice(0, 40)}":`, (err as Error)?.message);
    chosenIndex = 0;
    hasPerson = true;
    box2d = null;
    chinY = null;
  }
  const pickMs = Date.now() - tPick;

  // 4. Fetch chosen image at 1000 px (reusing speculative Image 0 fetch when chosenIndex === 0)
  const tFetch = Date.now();
  const chosen = thumbs[chosenIndex];
  let fullBuf: Buffer | null = null;
  if (chosenIndex === 0) {
    fullBuf = await specFull0Promise;
  }
  if (!fullBuf) {
    try {
      fullBuf = await fetchImageBuffer(withWidth(chosen.origUrl, 1000), DOWNLOAD_TIMEOUT_MS);
    } catch {
      try {
        fullBuf = await fetchImageBuffer(chosen.origUrl, DOWNLOAD_TIMEOUT_MS);
      } catch {
        fullBuf = chosen.rawBuf;
      }
    }
  }
  const fetchMs = Date.now() - tFetch;

  // 5-6. Orient, crop below chin, whiten background, fit 800x800 white square
  const tProcess = Date.now();
  const orientedPng = await sharp(fullBuf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const meta = await sharp(orientedPng).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW <= 0 || imgH <= 0) {
    return fallback;
  }

  const crop = decideCrop(imgW, imgH, hasPerson, box2d, { chinY, slot });
  let pipeline = sharp(orientedPng);
  if (crop) {
    pipeline = pipeline.extract(crop);
  }

  const { data: rawRgb, info } = await pipeline
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels === 3) {
    whitenBackground(rawRgb, info.width, info.height);
  }

  const finalBuf = await sharp(rawRgb, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels as 1 | 2 | 3 | 4,
    },
  })
    .resize(768, 768, { fit: 'contain', background: '#ffffff' })
    .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer();

  await writeFileAtomic(filePath, finalBuf);
  const processMs = Date.now() - tProcess;

  const source: ShotSource = crop ? 'cropped' : 'product-only';
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
