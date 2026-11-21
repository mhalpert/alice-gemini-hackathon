import crypto from 'node:crypto';
import path from 'node:path';
import type { BoardBoxes, Item, Outfit, Piece } from '../types.ts';

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

export function boardBuildKey(outfit: Pick<Outfit, 'number' | 'pieces'>, label?: string): string {
  const tag = typeof label === 'string' && label.trim().length > 0 ? label.trim() : '';
  const num = outfit.number !== undefined ? String(outfit.number) : '';
  const piecesKey = Array.isArray(outfit.pieces)
    ? outfit.pieces
        .map((p) => `${p?.slot ?? ''}:${p?.item?.id ?? ''}:${p?.item?.variant_id ?? ''}`)
        .join(',')
    : '';
  return `${num}|${tag}|${piecesKey}`;
}

export const BOARD_W = 1200;
export const BOARD_H = 900;
export const BOARD_GUTTER = 24;

export interface BoardCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedBoardPiece {
  slot: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function layoutBoardCells(
  pieceCount: number,
  boardW = BOARD_W,
  boardH = BOARD_H,
  gutter = BOARD_GUTTER,
): BoardCell[] {
  if (pieceCount <= 0) return [];
  if (pieceCount === 1) {
    return [
      {
        x: gutter,
        y: gutter,
        w: boardW - 2 * gutter,
        h: boardH - 2 * gutter,
      },
    ];
  }

  const halfW = Math.floor((boardW - 3 * gutter) / 2);
  const innerH = boardH - 2 * gutter;

  const cells: BoardCell[] = [
    {
      x: gutter,
      y: gutter,
      w: halfW,
      h: innerH,
    },
  ];

  const restCount = pieceCount - 1;
  const rightX = gutter + halfW + gutter;
  const rightW = boardW - gutter - rightX;
  const cols = restCount <= 2 ? 1 : 2;
  const rows = Math.ceil(restCount / cols);
  const cellW = Math.floor((rightW - (cols - 1) * gutter) / cols);
  const cellH = Math.floor((innerH - (rows - 1) * gutter) / rows);

  for (let i = 0; i < restCount; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = row === rows - 1 ? restCount - row * cols : cols;
    const rowWidth = itemsInRow * cellW + (itemsInRow - 1) * gutter;
    const rowStartX = rightX + Math.floor((rightW - rowWidth) / 2);
    cells.push({
      x: rowStartX + col * (cellW + gutter),
      y: gutter + row * (cellH + gutter),
      w: cellW,
      h: cellH,
    });
  }

  return cells;
}

export function placeInBoardCell(
  cell: BoardCell,
  imgWidth: number,
  imgHeight: number,
  scale = 0.92,
): { left: number; top: number; width: number; height: number } {
  const targetW = Math.max(1, Math.floor(cell.w * scale));
  const targetH = Math.max(1, Math.floor(cell.h * scale));
  const safeW = Math.max(1, imgWidth);
  const safeH = Math.max(1, imgHeight);
  const ratio = Math.min(targetW / safeW, targetH / safeH);
  const width = Math.max(1, Math.min(targetW, Math.round(safeW * ratio)));
  const height = Math.max(1, Math.min(targetH, Math.round(safeH * ratio)));
  const left = cell.x + Math.floor((cell.w - width) / 2);
  const top = cell.y + Math.floor((cell.h - height) / 2);
  return { left, top, width, height };
}

export function computeBoardBoxes(
  placements: PlacedBoardPiece[],
  boardW = BOARD_W,
  boardH = BOARD_H,
): BoardBoxes {
  const boxes: BoardBoxes = {};
  if (!Array.isArray(placements) || boardW <= 0 || boardH <= 0) {
    return boxes;
  }

  const slotCounts = new Map<string, number>();

  for (const p of placements) {
    if (!p || p.width <= 0 || p.height <= 0) continue;
    const baseSlot = typeof p.slot === 'string' && p.slot.trim().length > 0 ? p.slot.trim() : 'piece';
    const seen = (slotCounts.get(baseSlot) ?? 0) + 1;
    slotCounts.set(baseSlot, seen);

    let key = seen === 1 ? baseSlot : `${baseSlot}#${seen}`;
    let suffix = seen;
    while (key in boxes) {
      suffix += 1;
      key = `${baseSlot}#${suffix}`;
    }

    const x = round4(clamp01(p.left / boardW));
    const y = round4(clamp01(p.top / boardH));
    const w = round4(clamp01(Math.min(p.width / boardW, 1 - x)));
    const h = round4(clamp01(Math.min(p.height / boardH, 1 - y)));
    boxes[key] = [x, y, w, h];
  }

  return boxes;
}

export function placeBoardPieces(
  pieces: Array<{ slot: string; width: number; height: number }>,
  boardW = BOARD_W,
  boardH = BOARD_H,
  gutter = BOARD_GUTTER,
): { cells: BoardCell[]; placed: PlacedBoardPiece[]; boxes: BoardBoxes } {
  const cells = layoutBoardCells(pieces.length, boardW, boardH, gutter);
  const placed: PlacedBoardPiece[] = pieces.map((piece, idx) => {
    const rect = placeInBoardCell(cells[idx], piece.width, piece.height);
    return { slot: piece.slot, ...rect };
  });
  const boxes = computeBoardBoxes(placed, boardW, boardH);
  return { cells, placed, boxes };
}

export function tryonFileName(id: string): string {
  return `tryon-${id}.jpg`;
}

export function sceneFileName(id: string): string {
  return `scene-${id}.jpg`;
}

export function videoFileName(id: string): string {
  return `video-${id}.mp4`;
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

// ---------------------------------------------------------------------------
// Try-on gate, inspector parsing, scoring, and verify/redo loop (pure, no sharp)
// ---------------------------------------------------------------------------

export interface TryOnGateScores {
  same_person: number;
  all_pieces: number;
  no_extras: number;
  colours_match: number;
}

export type InspectorProblemKind =
  | 'face'
  | 'missing_piece'
  | 'extra_item'
  | 'colour'
  | 'body'
  | 'framing';

export interface InspectorProblem {
  kind: InspectorProblemKind;
  detail: string;
}

export interface TryOnInspectorResult {
  model: string;
  verdict: 'show' | 'redo';
  problems: InspectorProblem[];
  fix: string;
}

export type TryOnCheckPath = 'pass' | 'redo' | 'redo_skipped' | 'inspector_overruled';

export type ShopperPhotoStatus = 'camera' | 'none' | 'test';

export interface ShopperPhotoScores {
  person_visible: number;
  torso_visible: number;
  usable: number;
}

export interface ShopperPhotoCheckResult {
  scores: ShopperPhotoScores | null;
  ms: number;
  cached?: boolean;
  error?: string;
}

export interface ShopperPhotoDecision {
  useSnapshot: boolean;
  shopper_photo: ShopperPhotoStatus;
  shopper_notes?: string;
  scores: ShopperPhotoScores | null;
  ms: number;
  cached?: boolean;
}

export const SHOPPER_PHOTO_THRESHOLD = 0.5;
export const SHOPPER_PHOTO_FACE_ONLY_NOTE = 'only the face is visible';

export function hashImageBytes(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function evaluateShopperPhoto(
  scores: ShopperPhotoScores | null,
  ms: number,
  cached = false,
): ShopperPhotoDecision {
  if (!scores) {
    return {
      useSnapshot: true,
      shopper_photo: 'camera',
      scores: null,
      ms,
      cached,
    };
  }

  if (scores.person_visible < SHOPPER_PHOTO_THRESHOLD) {
    return {
      useSnapshot: false,
      shopper_photo: 'none',
      scores,
      ms,
      cached,
    };
  }

  return {
    useSnapshot: true,
    shopper_photo: 'camera',
    ...(scores.torso_visible < SHOPPER_PHOTO_THRESHOLD
      ? { shopper_notes: SHOPPER_PHOTO_FACE_ONLY_NOTE }
      : {}),
    scores,
    ms,
    cached,
  };
}

export interface ShopperPhotoCache {
  check(bytes: Uint8Array | Buffer): Promise<ShopperPhotoCheckResult>;
  clear(): void;
  size(): number;
}

export function createShopperPhotoCache(
  checkFn: (bytes: Buffer) => Promise<ShopperPhotoCheckResult>,
): ShopperPhotoCache {
  const cache = new Map<string, ShopperPhotoScores | null>();
  const inflight = new Map<string, Promise<ShopperPhotoCheckResult>>();

  async function check(bytes: Uint8Array | Buffer): Promise<ShopperPhotoCheckResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const key = hashImageBytes(buf);

    if (cache.has(key)) {
      return {
        scores: cache.get(key) ?? null,
        ms: 0,
        cached: true,
      };
    }

    const pending = inflight.get(key);
    if (pending) {
      const res = await pending;
      return {
        scores: res.scores,
        ms: 0,
        cached: true,
      };
    }

    const p = (async (): Promise<ShopperPhotoCheckResult> => {
      try {
        const res = await checkFn(buf);
        cache.set(key, res.scores);
        return res;
      } catch (err) {
        cache.set(key, null);
        return {
          scores: null,
          ms: 0,
          error: (err as Error)?.message ?? String(err),
        };
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, p);
    return p;
  }

  return {
    check,
    clear: () => {
      cache.clear();
      inflight.clear();
    },
    size: () => cache.size,
  };
}

export interface ResolveShopperPhotoDeps<TImage> {
  personInput: Uint8Array | Buffer | null;
  checkPhoto: (bytes: Uint8Array | Buffer) => Promise<ShopperPhotoCheckResult>;
  prepareSnapshot: (bytes: Uint8Array | Buffer) => Promise<TImage>;
  getTestShopper: () => Promise<TImage>;
}

export interface ResolveShopperPhotoResult<TImage> {
  shopper: TImage;
  shopper_photo: ShopperPhotoStatus;
  shopper_notes?: string;
  shopper_photo_scores?: ShopperPhotoScores | null;
  ms_shopper_photo: number;
}

export async function resolveShopperPhoto<TImage>(
  deps: ResolveShopperPhotoDeps<TImage>,
): Promise<ResolveShopperPhotoResult<TImage>> {
  if (!deps.personInput || deps.personInput.byteLength === 0) {
    const shopper = await deps.getTestShopper();
    return {
      shopper,
      shopper_photo: 'test',
      ms_shopper_photo: 0,
    };
  }

  let checkRes: ShopperPhotoCheckResult;
  try {
    checkRes = await deps.checkPhoto(deps.personInput);
  } catch (err) {
    checkRes = {
      scores: null,
      ms: 0,
      error: (err as Error)?.message ?? String(err),
    };
  }

  const decision = evaluateShopperPhoto(checkRes.scores, checkRes.ms, checkRes.cached);
  if (decision.useSnapshot) {
    const shopper = await deps.prepareSnapshot(deps.personInput);
    return {
      shopper,
      shopper_photo: decision.shopper_photo,
      ...(decision.shopper_notes ? { shopper_notes: decision.shopper_notes } : {}),
      shopper_photo_scores: decision.scores,
      ms_shopper_photo: decision.ms,
    };
  }

  const shopper = await deps.getTestShopper();
  return {
    shopper,
    shopper_photo: decision.shopper_photo,
    shopper_photo_scores: decision.scores,
    ms_shopper_photo: decision.ms,
  };
}

export interface TryOnCheck {
  gate: TryOnGateScores | null;
  inspector: TryOnInspectorResult | null;
  inspector_pending?: boolean;
  redo_skipped?: 'late' | 'cap';
  path: TryOnCheckPath;
  correction?: string;
  attempts: 1 | 2;
  passed: boolean;
  ms_gate: number;
  ms_inspector: number;
  ms_total: number;
  shopper_photo?: ShopperPhotoStatus;
  shopper_notes?: string;
  shopper_photo_scores?: ShopperPhotoScores | null;
  ms_shopper_photo?: number;
}

export const GATE_PASS_THRESHOLD = 0.6;
export const GATE_INSPECT_THRESHOLD = 0.7;
export const DEFAULT_TRYON_CAP_MS = 40_000;
export const DEFAULT_LATE_FIRST_IMAGE_MS = 26_000;

export function buildGateCorrection(gate: TryOnGateScores): string {
  const lines: string[] = [];
  if (gate.same_person < GATE_PASS_THRESHOLD) {
    lines.push(
      'The person must be exactly the shopper in Image 0: same face, hair, skin tone and build.',
    );
  }
  if (gate.all_pieces < GATE_PASS_THRESHOLD) {
    lines.push('Every listed piece must be clearly visible, including the shoes.');
  }
  if (gate.no_extras < GATE_PASS_THRESHOLD) {
    lines.push(
      'Remove anything worn or carried that is not in the list (no belts, hats, bags or jewellery unless listed).',
    );
  }
  if (gate.colours_match < GATE_PASS_THRESHOLD) {
    lines.push("Match each piece's colour to its product image and label exactly.");
  }
  return lines.join(' ');
}

const VALID_PROBLEM_KINDS = new Set<InspectorProblemKind>([
  'face',
  'missing_piece',
  'extra_item',
  'colour',
  'body',
  'framing',
]);

export function gatePassed(g: TryOnGateScores): boolean {
  return (
    g.same_person >= GATE_PASS_THRESHOLD &&
    g.all_pieces >= GATE_PASS_THRESHOLD &&
    g.no_extras >= GATE_PASS_THRESHOLD &&
    g.colours_match >= GATE_PASS_THRESHOLD
  );
}

export function needsInspector(g: TryOnGateScores): boolean {
  return (
    g.same_person < GATE_INSPECT_THRESHOLD ||
    g.all_pieces < GATE_INSPECT_THRESHOLD ||
    g.no_extras < GATE_INSPECT_THRESHOLD ||
    g.colours_match < GATE_INSPECT_THRESHOLD
  );
}

export function scoreGate(g: TryOnGateScores): number {
  const vals = [g.same_person, g.all_pieces, g.no_extras, g.colours_match];
  const minVal = Math.min(...vals);
  const avgVal = (vals[0] + vals[1] + vals[2] + vals[3]) / 4;
  return minVal * 0.6 + avgVal * 0.4;
}

export function parseInspectorReply(
  text: string | undefined | null,
  model: string,
): TryOnInspectorResult | null {
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
  const rawVerdict = typeof rec.verdict === 'string' ? rec.verdict.trim().toLowerCase() : '';
  if (rawVerdict !== 'show' && rawVerdict !== 'redo') {
    return null;
  }

  const problems: InspectorProblem[] = [];
  if (Array.isArray(rec.problems)) {
    for (const p of rec.problems) {
      if (!p || typeof p !== 'object') continue;
      const pr = p as Record<string, unknown>;
      const rawKind = typeof pr.kind === 'string' ? pr.kind.trim().toLowerCase() : '';
      const kind: InspectorProblemKind = VALID_PROBLEM_KINDS.has(rawKind as InspectorProblemKind)
        ? (rawKind as InspectorProblemKind)
        : 'extra_item';
      const detail = typeof pr.detail === 'string' ? pr.detail.trim() : '';
      if (detail) {
        problems.push({ kind, detail });
      }
    }
  }

  const fix = typeof rec.fix === 'string' ? rec.fix.trim() : '';

  return {
    model,
    verdict: rawVerdict,
    problems,
    fix,
  };
}

export interface VerifyLoopDeps<TImage> {
  generate: (correction: string | null) => Promise<TImage>;
  gate: (img: TImage) => Promise<{ scores: TryOnGateScores | null; ms: number }>;
  inspect: (
    img: TImage,
    gate: TryOnGateScores,
  ) => Promise<{ result: TryOnInspectorResult | null; ms: number }>;
  onBackgroundInspect?: (result: TryOnInspectorResult | null, ms: number) => void;
  verifyOff?: boolean;
  now?: () => number;
  startedAt?: number;
  capMs?: number;
  lateFirstMs?: number;
  minGateBudgetMs?: number;
}

export interface VerifyLoopOut<TImage> {
  image: TImage;
  check: TryOnCheck;
}

export async function runTryOnVerifyLoop<TImage>(
  deps: VerifyLoopDeps<TImage>,
): Promise<VerifyLoopOut<TImage>> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = deps.startedAt ?? now();
  const capMs = deps.capMs ?? DEFAULT_TRYON_CAP_MS;
  const lateFirstMs = deps.lateFirstMs ?? DEFAULT_LATE_FIRST_IMAGE_MS;
  const minGateBudgetMs = deps.minGateBudgetMs ?? 1_500;
  const msTotal = (): number => Math.max(0, now() - startedAt);
  const remaining = (): number => capMs - msTotal();

  const img1 = await deps.generate(null);
  const firstImgElapsed = msTotal();

  if (deps.verifyOff || remaining() < minGateBudgetMs) {
    return {
      image: img1,
      check: {
        gate: null,
        inspector: null,
        path: 'pass',
        attempts: 1,
        passed: true,
        ms_gate: 0,
        ms_inspector: 0,
        ms_total: msTotal(),
      },
    };
  }

  const g1Res = await deps.gate(img1);
  const g1 = g1Res.scores;
  const msGate1 = g1Res.ms;

  // Unknown gate (timeout/error) -> pass
  if (!g1) {
    return {
      image: img1,
      check: {
        gate: null,
        inspector: null,
        path: 'pass',
        attempts: 1,
        passed: true,
        ms_gate: msGate1,
        ms_inspector: 0,
        ms_total: msTotal(),
      },
    };
  }

  // Gate passed (>= 0.6 on all questions)
  if (gatePassed(g1)) {
    // Borderline (0.6..0.7): return immediately and run inspector in background for logging only
    if (needsInspector(g1)) {
      void deps
        .inspect(img1, g1)
        .then((res) => {
          deps.onBackgroundInspect?.(res.result, res.ms);
        })
        .catch(() => {});

      return {
        image: img1,
        check: {
          gate: g1,
          inspector: null,
          inspector_pending: true,
          path: 'pass',
          attempts: 1,
          passed: true,
          ms_gate: msGate1,
          ms_inspector: 0,
          ms_total: msTotal(),
        },
      };
    }

    return {
      image: img1,
      check: {
        gate: g1,
        inspector: null,
        path: 'pass',
        attempts: 1,
        passed: true,
        ms_gate: msGate1,
        ms_inspector: 0,
        ms_total: msTotal(),
      },
    };
  }

  // Gate failed (< 0.6 on at least one question)
  if (firstImgElapsed > lateFirstMs) {
    return {
      image: img1,
      check: {
        gate: g1,
        inspector: null,
        redo_skipped: 'late',
        path: 'redo_skipped',
        attempts: 1,
        passed: false,
        ms_gate: msGate1,
        ms_inspector: 0,
        ms_total: msTotal(),
      },
    };
  }

  const remForRedo = remaining();
  if (remForRedo <= 0) {
    return {
      image: img1,
      check: {
        gate: g1,
        inspector: null,
        redo_skipped: 'cap',
        path: 'redo_skipped',
        attempts: 1,
        passed: false,
        ms_gate: msGate1,
        ms_inspector: 0,
        ms_total: msTotal(),
      },
    };
  }

  // Start corrected re-render AND Neon inspector IN PARALLEL immediately
  const correction = buildGateCorrection(g1);

  return new Promise<VerifyLoopOut<TImage>>((resolve) => {
    let settled = false;
    let inspectSettled = false;
    let inspectResult: TryOnInspectorResult | null = null;
    let inspectMs = 0;
    let redoImg: TImage | null = null;
    let redoGate: TryOnGateScores | null = null;
    let redoGateMs = 0;

    const finish = (out: VerifyLoopOut<TImage>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      resolve(out);
    };

    const capTimer = setTimeout(() => {
      // At the hard cap, return the best image so far
      const haveRedo = redoImg !== null;
      const keepRedo = haveRedo && (!redoGate || scoreGate(redoGate) >= scoreGate(g1));
      const chosenImage = keepRedo && redoImg !== null ? redoImg : img1;
      const chosenGate = keepRedo ? (redoGate ?? g1) : g1;

      finish({
        image: chosenImage,
        check: {
          gate: chosenGate,
          inspector: inspectSettled ? inspectResult : null,
          ...(inspectSettled ? {} : { inspector_pending: true }),
          ...(haveRedo ? {} : { redo_skipped: 'cap' as const }),
          path: haveRedo ? 'redo' : 'redo_skipped',
          correction,
          attempts: haveRedo ? 2 : 1,
          passed: keepRedo && redoGate ? gatePassed(redoGate) : false,
          ms_gate: msGate1 + redoGateMs,
          ms_inspector: inspectSettled ? inspectMs : 0,
          ms_total: msTotal(),
        },
      });
    }, Math.max(1, remForRedo));

    // Branch 1: Inspector runs in parallel; if it says 'show' before redo finishes, overrule immediately
    void deps
      .inspect(img1, g1)
      .then((res) => {
        inspectSettled = true;
        inspectResult = res.result;
        inspectMs = res.ms;
        if (settled) {
          deps.onBackgroundInspect?.(res.result, res.ms);
          return;
        }
        if (res.result?.verdict === 'show') {
          finish({
            image: img1,
            check: {
              gate: g1,
              inspector: res.result,
              path: 'inspector_overruled',
              correction,
              attempts: 1,
              passed: true,
              ms_gate: msGate1,
              ms_inspector: res.ms,
              ms_total: msTotal(),
            },
          });
        }
      })
      .catch(() => {
        inspectSettled = true;
      });

    // Branch 2: Corrected re-render + second gate runs in parallel
    void (async () => {
      try {
        const img2 = await deps.generate(correction);
        if (settled) return;
        redoImg = img2;

        if (remaining() >= minGateBudgetMs) {
          const g2Res = await deps.gate(img2);
          if (settled) return;
          redoGate = g2Res.scores;
          redoGateMs = g2Res.ms;
        }

        const keepSecond = !redoGate || scoreGate(redoGate) >= scoreGate(g1);
        const chosenImage = keepSecond ? img2 : img1;
        const chosenGate = keepSecond ? (redoGate ?? g1) : g1;

        finish({
          image: chosenImage,
          check: {
            gate: chosenGate,
            inspector: inspectSettled ? inspectResult : null,
            ...(inspectSettled ? {} : { inspector_pending: true }),
            path: 'redo',
            correction,
            attempts: 2,
            passed: redoGate ? gatePassed(chosenGate) : true,
            ms_gate: msGate1 + redoGateMs,
            ms_inspector: inspectSettled ? inspectMs : 0,
            ms_total: msTotal(),
          },
        });
      } catch {
        if (settled) return;
        finish({
          image: img1,
          check: {
            gate: g1,
            inspector: inspectSettled ? inspectResult : null,
            ...(inspectSettled ? {} : { inspector_pending: true }),
            path: 'redo',
            correction,
            attempts: 2,
            passed: false,
            ms_gate: msGate1,
            ms_inspector: inspectSettled ? inspectMs : 0,
            ms_total: msTotal(),
          },
        });
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Try-on extras: setting builder & parallel scene + video orchestrator (pure)
// ---------------------------------------------------------------------------

export interface BuildSettingInput {
  occasion: string;
  where?: string;
  when?: string;
  weather?: string;
}

export function buildSetting(opts: BuildSettingInput): string {
  const occasion = (opts.occasion ?? '').trim() || 'a stylish outing';
  const where = (opts.where ?? '').trim();
  const rawWhen = (opts.when ?? '').trim();
  const weather = (opts.weather ?? '').trim();

  const parts: string[] = [occasion];

  if (where) {
    parts.push(/^in\s+/i.test(where) ? where : `in ${where}`);
  }

  if (weather && rawWhen) {
    const cleanWhen = rawWhen.replace(/^on\s+(?:a\s+|an\s+)?/i, '').trim();
    const article = /^[aeiou]/i.test(weather) ? 'an' : 'a';
    parts.push(`on ${article} ${weather} ${cleanWhen}`);
  } else if (rawWhen) {
    const hasPrep = /^(on|at|in|during|this|next|today|tonight|tomorrow)\b/i.test(rawWhen);
    parts.push(hasPrep ? rawWhen : `on ${rawWhen}`);
  } else if (weather) {
    parts.push(`in ${weather} weather`);
  }

  let sentence = parts.join(' ').replace(/\s+/g, ' ').trim();
  const lower = sentence.toLowerCase();

  if (lower.includes('rooftop') && !lower.includes('lights') && !lower.includes('skyline')) {
    const isNight = /evening|night|dinner|sunset|cocktail|tonight/i.test(lower);
    sentence += isNight ? ', city lights behind' : ', open city skyline behind';
  } else if (lower.includes('beach') && !lower.includes('ocean') && !lower.includes('shore')) {
    sentence += ', soft ocean light and shoreline behind';
  }

  return sentence;
}

export interface TryOnExtraRender {
  url: string;
  path: string;
  ms: number;
  id: string;
}

export interface TryOnExtraRenderEvent {
  kind: 'scene' | 'video';
  ok: boolean;
  url?: string;
  ms: number;
  reused?: boolean;
}

export interface TryOnExtrasResult {
  scene: { url: string; path: string; ms: number; reused?: boolean } | null;
  video: { url: string; path: string; ms: number } | null;
  setting: string;
}

export interface RunTryOnExtrasDeps {
  setting: string;
  sceneEnabled: boolean;
  videoEnabled: boolean;
  runScene: () => Promise<{ url: string; path: string; ms: number; reused?: boolean } | null>;
  runVideo: () => Promise<{ url: string; path: string; ms: number } | null>;
  onRender?: (r: TryOnExtraRenderEvent) => void;
  now?: () => number;
}

export const MAX_SCENE_PREWARM_ENTRIES = 12;

export function scenePrewarmKey(studioPath: string, setting: string): string {
  return `${studioPath}\0${setting.trim()}`;
}

export interface SceneRenderOutput {
  url: string;
  path: string;
  ms: number;
  id?: string;
  reused?: boolean;
}

export interface PrewarmSceneResult {
  ok: boolean;
  url?: string;
  duration_ms: number;
  reused?: boolean;
}

export interface ScenePrewarmCache {
  prewarm(
    key: string,
    render: () => Promise<SceneRenderOutput | null>,
  ): Promise<PrewarmSceneResult>;
  getOrRender(
    key: string,
    render: () => Promise<SceneRenderOutput | null>,
  ): Promise<SceneRenderOutput | null>;
  hasFinished(key: string): boolean;
  hasInFlight(key: string): boolean;
  size(): number;
  clear(): void;
}

export function createScenePrewarmCache(opts?: {
  maxEntries?: number;
  now?: () => number;
}): ScenePrewarmCache {
  const maxEntries = Math.max(1, opts?.maxEntries ?? MAX_SCENE_PREWARM_ENTRIES);
  const now = opts?.now ?? (() => Date.now());
  const finished = new Map<string, SceneRenderOutput>();
  const inFlight = new Map<string, Promise<SceneRenderOutput | null>>();

  const storeFinished = (key: string, value: SceneRenderOutput): void => {
    if (finished.has(key)) {
      finished.delete(key);
    } else if (finished.size >= maxEntries) {
      const oldest = finished.keys().next().value;
      if (oldest !== undefined) {
        finished.delete(oldest);
      }
    }
    finished.set(key, value);
  };

  const startRender = (
    key: string,
    render: () => Promise<SceneRenderOutput | null>,
  ): Promise<SceneRenderOutput | null> => {
    const p = (async (): Promise<SceneRenderOutput | null> => {
      try {
        const res = await render();
        if (res && typeof res.url === 'string' && res.url.length > 0) {
          storeFinished(key, {
            url: res.url,
            path: res.path,
            ms: res.ms,
            ...(res.id ? { id: res.id } : {}),
          });
          return res;
        }
        return null;
      } catch {
        return null;
      } finally {
        if (inFlight.get(key) === p) {
          inFlight.delete(key);
        }
      }
    })();
    inFlight.set(key, p);
    return p;
  };

  async function prewarm(
    key: string,
    render: () => Promise<SceneRenderOutput | null>,
  ): Promise<PrewarmSceneResult> {
    const cached = finished.get(key);
    if (cached) {
      return { ok: true, url: cached.url, duration_ms: 0, reused: true };
    }

    const pending = inFlight.get(key);
    if (pending) {
      const t0 = now();
      const res = await pending;
      const duration_ms = Math.max(0, now() - t0);
      if (res) {
        return { ok: true, url: res.url, duration_ms, reused: true };
      }
      return { ok: false, duration_ms };
    }

    const t0 = now();
    const res = await startRender(key, render);
    const duration_ms = Math.max(0, now() - t0);
    if (res) {
      return { ok: true, url: res.url, duration_ms };
    }
    return { ok: false, duration_ms };
  }

  async function getOrRender(
    key: string,
    render: () => Promise<SceneRenderOutput | null>,
  ): Promise<SceneRenderOutput | null> {
    const cached = finished.get(key);
    if (cached) {
      return { ...cached, ms: 0, reused: true };
    }

    const pending = inFlight.get(key);
    if (pending) {
      const t0 = now();
      const res = await pending;
      if (res) {
        return { ...res, ms: Math.max(0, now() - t0), reused: true };
      }
      return null;
    }

    return startRender(key, render);
  }

  return {
    prewarm,
    getOrRender,
    hasFinished: (key) => finished.has(key),
    hasInFlight: (key) => inFlight.has(key),
    size: () => finished.size,
    clear: () => {
      finished.clear();
      inFlight.clear();
    },
  };
}

export async function runTryOnExtrasLoop(deps: RunTryOnExtrasDeps): Promise<TryOnExtrasResult> {
  const now = deps.now ?? (() => Date.now());

  const notify = (ev: TryOnExtraRenderEvent): void => {
    try {
      deps.onRender?.(ev);
    } catch {
      // Never let a callback error break extras
    }
  };

  const scenePromise: Promise<{ url: string; path: string; ms: number; reused?: boolean } | null> =
    deps.sceneEnabled
      ? (async () => {
          const t0 = now();
          try {
            const res = await deps.runScene();
            const ms = res?.ms ?? Math.max(0, now() - t0);
            notify({
              kind: 'scene',
              ok: Boolean(res),
              ...(res ? { url: res.url } : {}),
              ...(res?.reused ? { reused: true } : {}),
              ms,
            });
            return res
              ? {
                  url: res.url,
                  path: res.path,
                  ms: res.ms,
                  ...(res.reused ? { reused: true } : {}),
                }
              : null;
          } catch {
            notify({ kind: 'scene', ok: false, ms: Math.max(0, now() - t0) });
            return null;
          }
        })()
      : Promise.resolve(null);

  const videoPromise: Promise<{ url: string; path: string; ms: number } | null> = deps.videoEnabled
    ? (async () => {
        const t0 = now();
        try {
          const res = await deps.runVideo();
          const ms = res?.ms ?? Math.max(0, now() - t0);
          notify({
            kind: 'video',
            ok: Boolean(res),
            ...(res ? { url: res.url } : {}),
            ms,
          });
          return res ? { url: res.url, path: res.path, ms: res.ms } : null;
        } catch {
          notify({ kind: 'video', ok: false, ms: Math.max(0, now() - t0) });
          return null;
        }
      })()
    : Promise.resolve(null);

  const [scene, video] = await Promise.all([scenePromise, videoPromise]);
  return { scene, video, setting: deps.setting };
}
