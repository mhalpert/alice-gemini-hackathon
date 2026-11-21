import crypto from 'node:crypto';
import path from 'node:path';
import type { Item, Outfit, Piece } from '../types.ts';

export const TRYON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(jpg|jpeg|png|webp|mp4)$/;

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export function tryonDir(): string {
  return process.env.ALICE_TRYON_DIR
    ? path.resolve(process.env.ALICE_TRYON_DIR)
    : path.join(REPO_ROOT, 'data', 'tryon');
}

export function publicUrl(name: string): string {
  const base = (process.env.ALICE_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/tryon/${name}`;
}

export function shotCacheKey(item: Pick<Item, 'id' | 'variant_id'>): string {
  return `${item.id}|${item.variant_id}`;
}

export function shotFileName(item: Pick<Item, 'id' | 'variant_id'>): string {
  const hash = crypto.createHash('sha1').update(shotCacheKey(item)).digest('hex').slice(0, 16);
  return `shot-${hash}.jpg`;
}

export function sanitizeNamePart(input: string, fallback = 'look'): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function boardFileName(outfit: Pick<Outfit, 'number'>, label?: string): string {
  const rawTag =
    typeof label === 'string' && label.trim().length > 0
      ? label.trim()
      : outfit.number !== undefined
        ? String(outfit.number)
        : 'look';
  const tag = sanitizeNamePart(rawTag, 'look');
  const rand = crypto.randomBytes(4).toString('hex');
  return `board-${tag}-${rand}.jpg`;
}

export function tryonFileName(id: string): string {
  return `tryon-${id}.jpg`;
}

export function newTryonId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function withWidth(url: string, w: number): string {
  const widthStr = String(Math.max(1, Math.round(w)));
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('width', widthStr);
    return parsed.toString();
  } catch {
    const hashIdx = url.indexOf('#');
    const base = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}width=${widthStr}${hash}`;
  }
}

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;

export function isShopifyOrImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'cdn.shopify.com' || u.hostname.endsWith('.cdn.shopify.com')) {
      return true;
    }
    return IMAGE_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function urlKeyWithoutQuery(url: string): string {
  const idx = url.search(/[?#]/);
  return idx === -1 ? url : url.slice(0, idx);
}

export function collectImageUrls(primaryImage: string, extraUrls: string[], limit = 8): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (raw: string, allowAnyHttp: boolean): void => {
    if (result.length >= limit) return;
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!allowAnyHttp && !isShopifyOrImageUrl(trimmed)) return;
    if (allowAnyHttp) {
      try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      } catch {
        return;
      }
    }
    const key = urlKeyWithoutQuery(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };

  tryAdd(primaryImage, true);
  for (const u of extraUrls) {
    tryAdd(u, false);
  }
  return result;
}

export interface PickReply {
  index: number;
  has_person: boolean;
  box_2d: [number, number, number, number] | null;
  chin_y: number | null;
  product_only: number[];
  back_view: number[];
}

export interface ResolvedPick {
  index: number;
  has_person: boolean;
  box_2d: [number, number, number, number] | null;
  chin_y: number | null;
}

function parseBox2d(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [ymin, xmin, ymax, xmax] = nums;
  if (ymax <= ymin || xmax <= xmin) return null;
  return [ymin, xmin, ymax, xmax];
}

function parseChinY(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1000) return null;
  return raw;
}

function parseIndexArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      const idx = Math.trunc(v);
      if (!seen.has(idx)) {
        seen.add(idx);
        out.push(idx);
      }
    }
  }
  return out;
}

export function parsePickReply(text: string | undefined | null): PickReply | null {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const rec = obj as Record<string, unknown>;
  const rawIdx = rec.index;
  if (typeof rawIdx !== 'number' || !Number.isFinite(rawIdx) || rawIdx < 0) {
    return null;
  }

  const hasPerson = typeof rec.has_person === 'boolean' ? rec.has_person : true;
  const box2d = parseBox2d(rec.box_2d);
  const chinY = parseChinY(rec.chin_y);
  const productOnly = parseIndexArray(rec.product_only);
  const backView = parseIndexArray(rec.back_view);

  return {
    index: Math.trunc(rawIdx),
    has_person: hasPerson,
    box_2d: box2d,
    chin_y: chinY,
    product_only: productOnly,
    back_view: backView,
  };
}

/**
 * Prompt-independent post-rule for the Flash Lite pick:
 * - Never choose any index listed in back_view (unless all images are back views).
 * - If Image 0 has no person (and is not a back view), always choose Image 0 with no crop.
 * - If any valid non-back product_only index exists, prefer it with no crop.
 * - When every image shows a person, keep the chosen non-back index; if the model picked
 *   a back_view index, fall back to Image 0 (or first non-back image) with box/chin cleared.
 */
export function resolvePick(reply: PickReply | null, imageCount: number): ResolvedPick {
  if (!reply || imageCount <= 0) {
    return { index: 0, has_person: true, box_2d: null, chin_y: null };
  }

  const backSet = new Set(reply.back_view.filter((i) => i >= 0 && i < imageCount));
  const validProductOnly = reply.product_only.filter(
    (i) => i >= 0 && i < imageCount && !backSet.has(i),
  );
  const indexInBounds = reply.index >= 0 && reply.index < imageCount;
  const pickedIsBack = backSet.has(reply.index);

  // Rule 2: Image 0 first when Image 0 has no person
  if (validProductOnly.includes(0) || (reply.index === 0 && !reply.has_person && !pickedIsBack)) {
    return { index: 0, has_person: false, box_2d: null, chin_y: null };
  }

  // Model picked an in-bounds non-back product-only image -> use whole image, ignore box
  if (indexInBounds && !reply.has_person && !pickedIsBack) {
    return { index: reply.index, has_person: false, box_2d: null, chin_y: null };
  }

  // Model picked a person image (or back view / out-of-bounds) while product-only candidates exist
  if (validProductOnly.length > 0) {
    return { index: validProductOnly[0], has_person: false, box_2d: null, chin_y: null };
  }

  // Every image has a person: keep non-back pick, otherwise exclude back_view and prefer Image 0
  if (indexInBounds && !pickedIsBack) {
    return {
      index: reply.index,
      has_person: true,
      box_2d: reply.box_2d,
      chin_y: reply.chin_y,
    };
  }

  for (let i = 0; i < imageCount; i++) {
    if (!backSet.has(i)) {
      return { index: i, has_person: true, box_2d: null, chin_y: null };
    }
  }

  return { index: 0, has_person: true, box_2d: null, chin_y: null };
}

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DecideCropOptions {
  chinY?: number | null;
  slot?: string;
}

const SMALL_ITEM_SLOTS = new Set(['shoes', 'bag', 'accessory', 'jewelry']);

function minBoxAreaRatio(slot: string): number {
  return SMALL_ITEM_SLOTS.has(slot) ? 0.06 : 0.25;
}

export function classifyShotSource(hasPerson: boolean): 'product-only' | 'cropped' {
  return hasPerson ? 'cropped' : 'product-only';
}

export function cropRawRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  channels: number,
  crop: CropRegion,
): Uint8Array {
  const out = new Uint8Array(crop.width * crop.height * channels);
  const rowBytes = crop.width * channels;
  const srcStride = width * channels;
  for (let y = 0; y < crop.height; y++) {
    const srcOff = (crop.top + y) * srcStride + crop.left * channels;
    out.set(rgb.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
  }
  return out;
}

export function decideCrop(
  imgWidth: number,
  imgHeight: number,
  hasPerson: boolean,
  box2d: [number, number, number, number] | null,
  opts?: DecideCropOptions,
): CropRegion | null {
  if (imgWidth <= 0 || imgHeight <= 0) return null;

  // Rule 1: product-only images are never cropped; ignore box_2d completely
  if (!hasPerson) {
    return null;
  }

  const chinY =
    typeof opts?.chinY === 'number' && Number.isFinite(opts.chinY)
      ? Math.max(0, Math.min(1000, opts.chinY))
      : null;
  const chinFloorNorm = chinY !== null ? Math.min(999, chinY + 15) : null;
  const slot = (opts?.slot ?? '').trim().toLowerCase();
  const minArea = minBoxAreaRatio(slot);

  let usableBox = false;
  let rawLeft = 0;
  let rawTop = 0;
  let rawRight = 0;
  let rawBottom = 0;

  if (box2d && box2d.length === 4 && box2d.every((n) => Number.isFinite(n))) {
    const ymin = Math.max(0, Math.min(1000, box2d[0]));
    const xmin = Math.max(0, Math.min(1000, box2d[1]));
    const ymax = Math.max(0, Math.min(1000, box2d[2]));
    const xmax = Math.max(0, Math.min(1000, box2d[3]));
    const effectiveYmin = chinFloorNorm !== null ? Math.max(ymin, chinFloorNorm) : ymin;
    rawLeft = (xmin / 1000) * imgWidth;
    rawTop = (effectiveYmin / 1000) * imgHeight;
    rawRight = (xmax / 1000) * imgWidth;
    rawBottom = (ymax / 1000) * imgHeight;
    const rawW = rawRight - rawLeft;
    const rawH = rawBottom - rawTop;
    const boxAreaRatio = (rawW * rawH) / (imgWidth * imgHeight);
    if (rawW >= 40 && rawH >= 40 && boxAreaRatio >= minArea) {
      usableBox = true;
    }
  }

  if (usableBox) {
    const padX = imgWidth * 0.03;
    const padY = imgHeight * 0.03;
    const left = Math.max(0, Math.floor(rawLeft - padX));
    const top =
      chinFloorNorm !== null
        ? Math.max(0, Math.ceil(rawTop - 1e-9))
        : Math.max(0, Math.floor(rawTop - padY));
    const right = Math.min(imgWidth, Math.ceil(rawRight + padX));
    const bottom = Math.min(imgHeight, Math.ceil(rawBottom + padY));
    const width = right - left;
    const height = bottom - top;
    if (width >= 1 && height >= 1) {
      return { left, top, width, height };
    }
  }

  // Fallback when no usable box:
  // - shoes / bottom: lower 55% (top >= 45%)
  // - otherwise: below chin if known, else top 20% off; full width to bottom
  let top: number;
  if (slot === 'shoes' || slot === 'bottom') {
    top = Math.round(imgHeight * 0.45);
    if (chinFloorNorm !== null) {
      top = Math.max(top, Math.ceil((chinFloorNorm / 1000) * imgHeight - 1e-9));
    }
  } else if (chinFloorNorm !== null) {
    top = Math.ceil((chinFloorNorm / 1000) * imgHeight - 1e-9);
  } else {
    top = Math.round(imgHeight * 0.2);
  }

  top = Math.max(0, Math.min(imgHeight - 1, top));
  const height = imgHeight - top;
  if (height >= 1) {
    return { left: 0, top, width: imgWidth, height };
  }

  return null;
}

function medianByte(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function applyBorderGain(
  rgb: Uint8Array,
  totalPixels: number,
  br: number,
  bg: number,
  bb: number,
): void {
  const gr = br >= 255 ? 1 : Math.min(255 / Math.max(br, 1), 1.7);
  const gg = bg >= 255 ? 1 : Math.min(255 / Math.max(bg, 1), 1.7);
  const gb = bb >= 255 ? 1 : Math.min(255 / Math.max(bb, 1), 1.7);
  if (gr === 1 && gg === 1 && gb === 1) return;

  for (let i = 0; i < totalPixels; i++) {
    const o = i * 3;
    const r = Math.round(rgb[o] * gr);
    const g = Math.round(rgb[o + 1] * gg);
    const b = Math.round(rgb[o + 2] * gb);
    rgb[o] = r > 255 ? 255 : r;
    rgb[o + 1] = g > 255 ? 255 : g;
    rgb[o + 2] = b > 255 ? 255 : b;
  }
}

/**
 * Clean light/mid studio backgrounds to pure white on a raw 3-channel RGB buffer (in place).
 * - Dark borders (luma < 150): skip untouched, return false.
 * - Light borders (every channel >= 225): skip flood fill and normalise levels with
 *   per-channel gain = 255 / border so the border becomes 255 while white garments stay intact.
 * - Mid borders (luma >= 150, at least one channel < 225): edge flood fill within tolerance 14
 *   of the border colour, then apply the same per-channel gain so near-background shades lift.
 */
export function whitenBackground(rgb: Uint8Array, width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || rgb.length < width * height * 3) {
    return false;
  }

  const pw = Math.min(8, width);
  const ph = Math.min(8, height);
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  const samplePatch = (x0: number, y0: number): void => {
    for (let y = y0; y < y0 + ph; y++) {
      for (let x = x0; x < x0 + pw; x++) {
        const o = (y * width + x) * 3;
        rs.push(rgb[o]);
        gs.push(rgb[o + 1]);
        bs.push(rgb[o + 2]);
      }
    }
  };

  samplePatch(0, 0);
  samplePatch(width - pw, 0);
  samplePatch(0, height - ph);
  samplePatch(width - pw, height - ph);

  const br = medianByte(rs);
  const bg = medianByte(gs);
  const bb = medianByte(bs);

  const luma = 0.299 * br + 0.587 * bg + 0.114 * bb;
  if (luma < 150) {
    return false;
  }

  const total = width * height;

  if (br >= 225 && bg >= 225 && bb >= 225) {
    applyBorderGain(rgb, total, br, bg, bb);
    return true;
  }

  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const isBg = (idx: number): boolean => {
    const o = idx * 3;
    const r = rgb[o];
    const g = rgb[o + 1];
    const b = rgb[o + 2];
    return Math.abs(r - br) <= 14 && Math.abs(g - bg) <= 14 && Math.abs(b - bb) <= 14;
  };

  const trySeed = (idx: number): void => {
    if (visited[idx] === 0 && isBg(idx)) {
      visited[idx] = 1;
      stack[sp++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    trySeed(x);
    trySeed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    trySeed(y * width);
    trySeed(y * width + (width - 1));
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const o = idx * 3;
    rgb[o] = 255;
    rgb[o + 1] = 255;
    rgb[o + 2] = 255;

    const x = idx % width;
    const y = (idx - x) / width;

    if (x > 0) trySeed(idx - 1);
    if (x + 1 < width) trySeed(idx + 1);
    if (y > 0) trySeed(idx - width);
    if (y + 1 < height) trySeed(idx + width);
  }

  applyBorderGain(rgb, total, br, bg, bb);
  return true;
}

const SLOT_ORDER: Record<string, number> = {
  dress: 0,
  suit: 1,
  top: 2,
  layer: 3,
  outerwear: 4,
  bottom: 5,
  shoes: 6,
  bag: 7,
  accessory: 8,
  jewelry: 9,
};

export function slotPriority(slot: string): number {
  const key = slot.trim().toLowerCase();
  return key in SLOT_ORDER ? SLOT_ORDER[key] : 100;
}

export function sortPiecesForTryOn(pieces: Piece[]): Piece[] {
  return pieces
    .map((piece, idx) => ({ piece, idx, prio: slotPriority(piece.slot) }))
    .sort((a, b) => (a.prio !== b.prio ? a.prio - b.prio : a.idx - b.idx))
    .map((entry) => entry.piece);
}

export function stripHtml(input: string | undefined | null, maxLen = 220): string {
  if (typeof input !== 'string' || !input) return '';
  const plain = input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).trimEnd() : plain;
}
