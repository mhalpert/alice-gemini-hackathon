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

  return {
    index: Math.trunc(rawIdx),
    has_person: hasPerson,
    box_2d: box2d,
    chin_y: chinY,
  };
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

export function decideCrop(
  imgWidth: number,
  imgHeight: number,
  hasPerson: boolean,
  box2d: [number, number, number, number] | null,
  opts?: DecideCropOptions,
): CropRegion | null {
  if (imgWidth <= 0 || imgHeight <= 0) return null;

  const chinY =
    typeof opts?.chinY === 'number' && Number.isFinite(opts.chinY)
      ? Math.max(0, Math.min(1000, opts.chinY))
      : null;
  const chinFloorNorm = hasPerson && chinY !== null ? Math.min(999, chinY + 15) : null;
  const slot = (opts?.slot ?? '').trim().toLowerCase();

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
    if (rawW >= 40 && rawH >= 40) {
      usableBox = true;
    }
  }

  if (usableBox) {
    const boxAreaRatio = ((rawRight - rawLeft) * (rawBottom - rawTop)) / (imgWidth * imgHeight);
    if (!hasPerson && boxAreaRatio >= 0.8) {
      return null;
    }
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

  if (hasPerson) {
    const baseFrac = slot === 'shoes' || slot === 'bottom' ? 0.45 : 0.2;
    let top = Math.round(imgHeight * baseFrac);
    if (chinFloorNorm !== null) {
      top = Math.max(top, Math.ceil((chinFloorNorm / 1000) * imgHeight - 1e-9));
    }
    top = Math.max(0, Math.min(imgHeight - 1, top));
    const height = imgHeight - top;
    if (height >= 1) {
      return { left: 0, top, width: imgWidth, height };
    }
  }

  return null;
}

function medianByte(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

/**
 * Flood-fill near-border-colour pixels inward from the edges on a raw
 * 3-channel RGB buffer (mutated in place).
 * Skips dark borders (luma < 150) and already near-white borders (all channels >= 238).
 * Returns true if whitening ran, false if skipped.
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

  if (br >= 238 && bg >= 238 && bb >= 238) {
    return false;
  }

  const total = width * height;
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
