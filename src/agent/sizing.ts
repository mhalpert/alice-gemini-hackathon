import type { Gender, Outfit, Piece } from '../types.ts';
import { normalizeSlotKey } from './state.ts';

export type CoreSizeSlot = 'top' | 'bottom' | 'shoes';

export const CORE_SIZE_SLOTS: readonly CoreSizeSlot[] = ['top', 'bottom', 'shoes'];

const ONE_SIZE_LABEL_RE =
  /^(?:one\s*si?ze?(?:\s*fits\s*(?:all|most))?|one\s*sz|onesz|1\s*sz|1\s*size|o\.?\/?s\.?|osfa|osfm|free\s*size|no\s*size|nosize|n\/a|uni(?:sex)?|standard|default(?:\s*title)?)$/i;

const LETTER_SCALE = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;

const WORD_TO_CANONICAL_LETTER: Readonly<Record<string, string>> = {
  'double extra small': 'XXS',
  'extra extra small': 'XXS',
  'xx-small': 'XXS',
  'xx small': 'XXS',
  '2xs': 'XXS',
  xxs: 'XXS',
  'extra small': 'XS',
  'x-small': 'XS',
  'x small': 'XS',
  xs: 'XS',
  small: 'S',
  sm: 'S',
  s: 'S',
  medium: 'M',
  med: 'M',
  md: 'M',
  m: 'M',
  large: 'L',
  lg: 'L',
  l: 'L',
  'extra large': 'XL',
  'x-large': 'XL',
  'x large': 'XL',
  xl: 'XL',
  '1x': 'XL',
  'double extra large': 'XXL',
  'extra extra large': 'XXL',
  'double xl': 'XXL',
  'xx-large': 'XXL',
  'xx large': 'XXL',
  '2xl': 'XXL',
  '2x': 'XXL',
  xxl: 'XXL',
  'triple extra large': 'XXXL',
  'triple xl': 'XXXL',
  'xxx-large': 'XXXL',
  'xxx large': 'XXXL',
  '3xl': 'XXXL',
  '3x': 'XXXL',
  xxxl: 'XXXL',
};

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

const ONES_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const CORE_OR_APPAREL_SLOTS = new Set(['top', 'bottom', 'shoes', 'layer', 'dress']);

export function isLayerPiece(piece: Pick<Piece, 'slot'>): boolean {
  return normalizeSlotKey(piece.slot) === 'layer';
}

export function isBeltPiece(piece: Pick<Piece, 'slot' | 'item'>): boolean {
  const slotLower = piece.slot.trim().toLowerCase();
  if (slotLower === 'belt' || slotLower === 'belts') return true;
  const slotNorm = normalizeSlotKey(piece.slot);
  if (CORE_OR_APPAREL_SLOTS.has(slotNorm)) return false;
  return /\bbelts?\b/i.test(piece.item.title);
}

export function isCoreSlot(slot: string): slot is CoreSizeSlot {
  const norm = normalizeSlotKey(slot);
  return norm === 'top' || norm === 'bottom' || norm === 'shoes';
}

export function canonicalLetter(raw: string): string | null {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/^size\s+/, '')
    .replace(/\s+/g, ' ');
  return WORD_TO_CANONICAL_LETTER[clean] ?? null;
}

function letterIndex(letter: string): number {
  return LETTER_SCALE.indexOf(letter as (typeof LETTER_SCALE)[number]);
}

function extractWaistNumber(bottomSize: string): number | null {
  const clean = bottomSize.trim();
  const wxl = clean.match(
    /^(?:size\s+)?(?:W\s*)?(\d{2}(?:\.\d+)?)\s*W?\s*(?:[x×/]|by)\s*(\d{2}(?:\.\d+)?)\s*L?$/i,
  );
  if (wxl) {
    const n = Number(wxl[1]);
    return Number.isFinite(n) ? n : null;
  }
  const waistTagged = clean.match(
    /^(?:size\s+|waist\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:W|waist|in|inches|")?$/i,
  );
  if (waistTagged) {
    const n = Number(waistTagged[1]);
    return Number.isFinite(n) ? n : null;
  }
  const leading = clean.match(/(\d{2})/);
  if (leading) {
    const n = Number(leading[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function letterToApproxWaist(letter: string, gender?: Gender): number {
  if (gender === 'women') {
    const map: Record<string, number> = {
      XXS: 24,
      XS: 25,
      S: 27,
      M: 29,
      L: 32,
      XL: 35,
      XXL: 38,
      XXXL: 41,
    };
    return map[letter] ?? 29;
  }
  const map: Record<string, number> = {
    XXS: 27,
    XS: 28,
    S: 30,
    M: 32,
    L: 35,
    XL: 38,
    XXL: 41,
    XXXL: 44,
  };
  return map[letter] ?? 32;
}

function waistToLetter(waist: number, gender?: Gender): string {
  if (gender === 'women') {
    if (waist < 23) {
      // US numeric dress/pant size (0, 2, 4, 6, 8, 10, 12, 14, 16+)
      if (waist <= 2) return 'XS';
      if (waist <= 6) return 'S';
      if (waist <= 10) return 'M';
      if (waist <= 14) return 'L';
      if (waist <= 18) return 'XL';
      return 'XXL';
    }
    if (waist <= 25) return 'XS';
    if (waist <= 27) return 'S';
    if (waist <= 30) return 'M';
    if (waist <= 33) return 'L';
    if (waist <= 36) return 'XL';
    return 'XXL';
  }
  if (waist <= 28) return 'XS';
  if (waist <= 30) return 'S';
  if (waist <= 33) return 'M';
  if (waist <= 36) return 'L';
  if (waist <= 39) return 'XL';
  return 'XXL';
}

function womenNumericToWaistInches(num: number): number {
  const map: Record<number, number> = {
    0: 24,
    2: 25,
    4: 26,
    6: 27,
    8: 28,
    10: 30,
    12: 31,
    14: 33,
    16: 35,
    18: 37,
    20: 39,
  };
  if (num in map) return map[num]!;
  return Math.round(24 + num * 0.75);
}

interface ParsedBeltOption {
  label: string;
  numValue: number | null;
  isCm: boolean;
  letters: string[];
}

function parseBeltOption(label: string): ParsedBeltOption {
  const trimmed = label.trim();
  const isCmExplicit = /\bcm\b/i.test(trimmed);

  // Range like "30-32" or "32/34" (numeric)
  const numRange = trimmed.match(/(\d+(?:\.\d+)?)\s*[-–/]\s*(\d+(?:\.\d+)?)/);
  if (numRange) {
    const lo = Number(numRange[1]);
    const hi = Number(numRange[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const mid = (lo + hi) / 2;
      return { label, numValue: mid, isCm: isCmExplicit || mid >= 65, letters: [] };
    }
  }

  // Combo letter like "S/M", "M/L", "L/XL", "XS/S"
  const comboMatch = trimmed.match(/^([A-Za-z0-9]+)\s*[/\-]\s*([A-Za-z0-9]+)(?:\s*\(.*\))?$/);
  if (comboMatch) {
    const a = canonicalLetter(comboMatch[1]!);
    const b = canonicalLetter(comboMatch[2]!);
    if (a && b) {
      return { label, numValue: null, isCm: false, letters: [a, b] };
    }
  }

  // Single letter or "Medium (M)"
  const directLetter = canonicalLetter(trimmed);
  if (directLetter) {
    return { label, numValue: null, isCm: false, letters: [directLetter] };
  }
  const parenLetter = trimmed.match(/^([A-Za-z\s-]+)\s*\(([^)]+)\)$/);
  if (parenLetter) {
    const l1 = canonicalLetter(parenLetter[2]!);
    const l2 = canonicalLetter(parenLetter[1]!);
    if (l1 || l2) {
      return { label, numValue: null, isCm: false, letters: [(l1 ?? l2)!] };
    }
  }

  // Single number like "32", "34\"", "32 in", "85 cm", "90"
  const singleNum = trimmed.match(/(?:^|\b)(\d+(?:\.\d+)?)(?:\s*(?:cm|in|inches|"))?(?:\b|$)/i);
  if (singleNum) {
    const n = Number(singleNum[1]);
    if (Number.isFinite(n)) {
      return { label, numValue: n, isCm: isCmExplicit || n >= 65, letters: [] };
    }
  }

  return { label, numValue: null, isCm: false, letters: [] };
}

/**
 * Picks a sensible default size for a non-belt accessory:
 * prefers any one-size option, otherwise picks the middle size listed.
 */
export function inferAccessoryDefaultSize(availableSizes: readonly string[]): string | null {
  const clean = availableSizes.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0]!;

  const oneSize = clean.find((s) => ONE_SIZE_LABEL_RE.test(s));
  if (oneSize) return oneSize;

  return clean[Math.floor((clean.length - 1) / 2)]!;
}

/**
 * Derives a belt size from the shopper's bottom (waist) size by picking the
 * closest size the item actually lists (numeric waist -> numeric belt in inches
 * or cm, or letter size S/M/L when that is what the item lists).
 */
export function inferBeltSize(
  bottomSize: string,
  availableSizes: readonly string[],
  gender?: Gender,
): string {
  const cleanOptions = availableSizes.map((s) => s.trim()).filter(Boolean);
  const rawBottom = bottomSize.trim();

  if (cleanOptions.length === 0) {
    const waist = extractWaistNumber(rawBottom);
    return waist !== null ? String(waist) : rawBottom;
  }
  if (cleanOptions.length === 1) {
    return cleanOptions[0]!;
  }

  const parsed = cleanOptions.map(parseBeltOption);
  const numericOptions = parsed.filter((o) => o.numValue !== null);
  const letterOptions = parsed.filter((o) => o.letters.length > 0);

  const bottomLetter = canonicalLetter(rawBottom);
  const rawNumeric = bottomLetter ? null : extractWaistNumber(rawBottom);
  const targetWaistInches =
    rawNumeric !== null
      ? gender === 'women' && rawNumeric < 23
        ? womenNumericToWaistInches(rawNumeric)
        : rawNumeric
      : bottomLetter
        ? letterToApproxWaist(bottomLetter, gender)
        : null;
  const targetLetter =
    bottomLetter ?? (rawNumeric !== null ? waistToLetter(rawNumeric, gender) : null);

  if (numericOptions.length > 0 && targetWaistInches !== null) {
    const isCmBelt = numericOptions.every((o) => o.isCm);
    const targetNum = isCmBelt ? targetWaistInches * 2.54 : targetWaistInches;
    let best = numericOptions[0]!;
    let bestDist = Math.abs(best.numValue! - targetNum);
    for (let i = 1; i < numericOptions.length; i++) {
      const opt = numericOptions[i]!;
      const dist = Math.abs(opt.numValue! - targetNum);
      // On exact tie (e.g. waist 33 with sizes 32 and 34), round up so the belt fits comfortably.
      if (dist < bestDist || (dist === bestDist && opt.numValue! > best.numValue!)) {
        best = opt;
        bestDist = dist;
      }
    }
    return best.label;
  }

  if (letterOptions.length > 0 && targetLetter !== null) {
    const targetIdx = letterIndex(targetLetter);
    // Prefer exact single-letter match first.
    const exact = letterOptions.find((o) => o.letters.length === 1 && o.letters[0] === targetLetter);
    if (exact) return exact.label;

    // Next, prefer combo label that includes the target letter (e.g. "S/M" for "M").
    const containing = letterOptions.find((o) => o.letters.includes(targetLetter));
    if (containing) return containing.label;

    // Otherwise nearest letter on the scale (tie-break larger).
    let best = letterOptions[0]!;
    let bestDist = Infinity;
    let bestAvg = -1;
    for (const opt of letterOptions) {
      const indices = opt.letters.map(letterIndex).filter((idx) => idx >= 0);
      if (indices.length === 0) continue;
      const avg = indices.reduce((a, b) => a + b, 0) / indices.length;
      const dist = Math.abs(avg - targetIdx);
      if (dist < bestDist || (dist === bestDist && avg > bestAvg)) {
        best = opt;
        bestDist = dist;
        bestAvg = avg;
      }
    }
    return best.label;
  }

  return inferAccessoryDefaultSize(cleanOptions) ?? cleanOptions[0]!;
}

export interface OutfitSizeResolution {
  resolvedSizes: Record<string, string>;
  missingSlots: CoreSizeSlot[];
  inferred: Record<string, string>;
  inferredJacket: boolean;
  inferredBelt: boolean;
}

/**
 * Resolves sizes for every piece in an outfit using only the three shopper
 * slots (top, bottom, shoes). Never reports layer/jacket, belt, or accessory
 * slots as missing.
 */
export function resolveOutfitSizes(
  outfit: Outfit,
  rememberedSizes: Record<string, string>,
  gender?: Gender,
): OutfitSizeResolution {
  const resolvedSizes: Record<string, string> = { ...rememberedSizes };
  const missingSet = new Set<CoreSizeSlot>();
  const inferred: Record<string, string> = {};
  let inferredJacket = false;
  let inferredBelt = false;

  const hasBottomPiece = outfit.pieces.some((p) => normalizeSlotKey(p.slot) === 'bottom');

  function recordInferred(key: string, value: string): void {
    inferred[key] = value;
  }

  for (const piece of outfit.pieces) {
    const slotLower = piece.slot.trim().toLowerCase();
    const slotNorm = normalizeSlotKey(piece.slot);
    const sizesList = Array.isArray(piece.item.sizes) ? piece.item.sizes : [];
    const multiSized = sizesList.length > 1;
    const singleSized = sizesList.length === 1;

    // 1. Core slots: top, bottom, shoes
    if (slotNorm === 'top' || slotNorm === 'bottom' || slotNorm === 'shoes') {
      const heard = rememberedSizes[slotLower] ?? rememberedSizes[slotNorm];
      if (heard) {
        resolvedSizes[slotLower] = heard;
        resolvedSizes[slotNorm] = heard;
      } else if (multiSized) {
        missingSet.add(slotNorm);
      }
      continue;
    }

    // 2. Dress: uses dress size if explicitly remembered, else top size; missing reports 'top'
    if (slotNorm === 'dress') {
      const direct = rememberedSizes[slotLower] ?? rememberedSizes.dress;
      const heard = direct ?? rememberedSizes.top;
      if (heard) {
        resolvedSizes[slotLower] = heard;
        if (!direct && rememberedSizes.top) {
          recordInferred(slotLower, heard);
        }
      } else if (multiSized) {
        missingSet.add('top');
      }
      continue;
    }

    // 3. Layer / outerwear / jacket: uses top size (never asks for jacket/layer size)
    if (slotNorm === 'layer') {
      const direct = rememberedSizes[slotLower] ?? rememberedSizes.layer;
      const fromTop = rememberedSizes.top;
      if (direct) {
        resolvedSizes[slotLower] = direct;
      } else if (fromTop) {
        resolvedSizes[slotLower] = fromTop;
        recordInferred(slotLower, fromTop);
        inferredJacket = true;
      } else if (multiSized) {
        missingSet.add('top');
      }
      continue;
    }

    // 4. Belt: derive from bottom (waist) size; never asks for belt/accessory size
    if (isBeltPiece(piece)) {
      const direct = rememberedSizes[slotLower] ?? rememberedSizes.belt;
      if (direct) {
        resolvedSizes[slotLower] = direct;
        continue;
      }
      if (singleSized) {
        resolvedSizes[slotLower] = sizesList[0]!;
        continue;
      }
      const bottomSize = rememberedSizes.bottom;
      if (bottomSize) {
        const chosen = inferBeltSize(bottomSize, sizesList, gender);
        if (chosen) {
          resolvedSizes[slotLower] = chosen;
          recordInferred(slotLower === 'accessory' ? 'belt' : slotLower, chosen);
          inferredBelt = true;
        }
        continue;
      }
      // No bottom size yet: if outfit has a bottom piece, wait for bottom (never ask for belt!).
      if (hasBottomPiece && multiSized) {
        missingSet.add('bottom');
        continue;
      }
      // Outfit has no bottom piece (e.g. dress + belt): derive from top/dress if available, else default.
      const fallbackRef = rememberedSizes.dress ?? rememberedSizes.top;
      if (fallbackRef && multiSized) {
        const chosen = inferBeltSize(fallbackRef, sizesList, gender);
        resolvedSizes[slotLower] = chosen;
        recordInferred(slotLower === 'accessory' ? 'belt' : slotLower, chosen);
        inferredBelt = true;
      } else if (multiSized) {
        const chosen = inferAccessoryDefaultSize(sizesList);
        if (chosen) {
          resolvedSizes[slotLower] = chosen;
          recordInferred(slotLower === 'accessory' ? 'belt' : slotLower, chosen);
        }
      }
      continue;
    }

    // 5. Any other accessory (bag, jewelry, hat, sunglasses, etc.): sensible default when multi-sized
    const direct = rememberedSizes[slotLower] ?? rememberedSizes[slotNorm];
    if (direct) {
      resolvedSizes[slotLower] = direct;
      continue;
    }
    if (multiSized) {
      const chosen = inferAccessoryDefaultSize(sizesList);
      if (chosen) {
        resolvedSizes[slotLower] = chosen;
        recordInferred(slotLower, chosen);
      }
    }
  }

  // Keep deterministic order: top, bottom, shoes
  const missingSlots = CORE_SIZE_SLOTS.filter((slot) => missingSet.has(slot));
  return {
    resolvedSizes,
    missingSlots,
    inferred,
    inferredJacket,
    inferredBelt,
  };
}

/**
 * Extracts available sizes from a store missing-size reason like
 * `"no accessory size given (sizes: S, M, L)"`.
 */
export function parseSizesFromStoreReason(reason: string): string[] {
  const m = reason.match(/\(sizes:\s*([^)]+)\)/i);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Deterministic speech / typed-turn size parser (Requirement 2)
// ---------------------------------------------------------------------------

function normalizeSpokenNumbers(input: string): string {
  let text = input;

  // Compound tens + ones like "thirty two", "thirty-four", "twenty eight"
  text = text.replace(
    /\b(twenty|thirty|forty|fifty)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, tens: string, ones: string) =>
      String(TENS_WORDS[tens.toLowerCase()]! + ONES_WORDS[ones.toLowerCase()]!),
  );

  // Standalone tens words ("twenty", "thirty", "forty")
  text = text.replace(
    /\b(twenty|thirty|forty|fifty)\b/gi,
    (w) => String(TENS_WORDS[w.toLowerCase()]!),
  );

  // Spoken halves with word base: "ten and a half", "eight and half", "nine half"
  text = text.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s+(?:and\s+(?:a\s+)?)?half\b/gi,
    (_, base: string) => `${SMALL_NUMBER_WORDS[base.toLowerCase()]!}.5`,
  );

  // Spoken halves with numeric base: "10 and a half", "10 and half", "10 half", "10 1/2", "10-1/2", "10½"
  text = text.replace(
    /\b(\d{1,2})\s+(?:and\s+(?:a\s+)?)?half\b/gi,
    (_, base: string) => `${base}.5`,
  );
  text = text.replace(/\b(\d{1,2})(?:[\s-]+1\/2|\s*½)/gi, (_, base: string) => `${base}.5`);

  // Standalone number words when paired with size/slot context:
  // e.g. "size ten", "shoes nine", "nine wide", "ten shoes", "eight in shoes"
  text = text.replace(
    /\b(four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)\b(?=\s+(?:shoes?|sneakers?|boots?|footwear|wide|narrow|extra\s+wide|in\s+shoes?|pants?|jeans?|bottoms?|top|dress))/gi,
    (w) => String(SMALL_NUMBER_WORDS[w.toLowerCase()]!),
  );
  text = text.replace(
    /(\b(?:size|shoes?|sneakers?|boots?|footwear|waist|pants?|trousers?|jeans?|bottoms?)(?:\s+(?:is|are|a))*\s+)(zero|two|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)\b/gi,
    (_, prefix: string, w: string) => `${prefix}${SMALL_NUMBER_WORDS[w.toLowerCase()]!}`,
  );

  return text;
}

function maskNonSizeSpans(text: string): string {
  let s = text;
  const blank = (m: string) => ' '.repeat(m.length);

  // Dollar signs & explicit currency: "$400", "$150.50", "400 dollars", "300 bucks", "250 usd"
  s = s.replace(/\$\s*\d+(?:,\d{3})*(?:\.\d+)?/g, blank);
  s = s.replace(/\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:dollars?|bucks?|usd)\b/gi, blank);

  // Budget / price phrases: "under 300", "budget is 400", "budget of 300", "up to 500", "max 200", "spend 300"
  s = s.replace(
    /\b(?:under|below|up\s+to|less\s+than|no\s+more\s+than|over|max(?:imum)?|budget(?:\s+(?:is|of|around|about|under))?|spend(?:ing)?(?:\s+(?:around|about|under|up\s+to))?|costs?|price(?:\s+of)?)\s+\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:to|-|–)\s*\d+(?:,\d{3})*(?:\.\d+)?)?\b/gi,
    blank,
  );
  // "around 250", "about 300", "roughly 150" -> only mask budget-scale numbers (>= 50)
  s = s.replace(
    /\b(?:around|about|roughly)\s+(?:[5-9]\d|\d{3,})(?:,\d{3})*(?:\.\d+)?(?:\s*(?:to|-|–)\s*\d+(?:,\d{3})*(?:\.\d+)?)?\b/gi,
    blank,
  );

  // Look / option numbers & ratings: "look 1", "look 2", "option 3", "8 out of 10", "7/10"
  s = s.replace(/\b(?:look|outfit|option|choice|number)\s*#?\s*\d+\b/gi, blank);
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:out\s+of|\/)\s*10\b/gi, blank);

  // Times & percentages: "7 pm", "8:30", "50%", "50 percent", "10 minutes"
  s = s.replace(/\b\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\b/gi, blank);
  s = s.replace(/\b\d{1,2}\s*[ap]\.?m\.?\b/gi, blank);
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|years?|months?|pounds?|lbs?|kg|feet|ft|inches?)\b/gi, blank);

  return s;
}

function normalizeWidth(rawWidth: string | undefined): string | null {
  if (!rawWidth) return null;
  const w = rawWidth.trim().toLowerCase().replace(/\s+/g, ' ');
  if (w === 'extra wide' || w === 'x-wide' || w === 'xwide' || w === 'ee' || w === '2e' || w === '4e') {
    return 'extra wide';
  }
  if (w === 'wide' || w === 'w') return 'wide';
  if (w === 'narrow' || w === 'n') return 'narrow';
  if (w === 'regular' || w === 'd') return 'regular';
  return null;
}

function formatShoeValue(numStr: string, system?: string, width?: string): string | null {
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  const sys = system ? system.trim().toUpperCase() : '';
  if (sys === 'EU') {
    if (n < 34 || n > 50) return null;
  } else if (sys === 'UK') {
    if (n < 2 || n > 16) return null;
  } else {
    // Allow US 3..17 or EU 34..50 (integers or .5)
    const validUs = n >= 3 && n <= 17;
    const validEu = n >= 34 && n <= 50;
    if (!validUs && !validEu) return null;
  }
  const cleanNum = numStr.replace(/\.0$/, '');
  const normW = normalizeWidth(width);
  const parts: string[] = [];
  if (sys) parts.push(sys);
  parts.push(cleanNum);
  if (normW) parts.push(normW);
  return parts.join(' ');
}

const FULL_LETTER_WORD_SRC =
  'double\\s+extra\\s+small|extra\\s+extra\\s+small|xx-?small|2xs|xxs|extra\\s+small|x-?small|xs|small|medium|med|large|extra\\s+large|x-?large|xl|double\\s+extra\\s+large|extra\\s+extra\\s+large|double\\s+xl|xx-?large|2xl|xxl|triple\\s+extra\\s+large|triple\\s+xl|xxx-?large|3xl|xxxl|1x|2x|3x';

const ANY_LETTER_SRC = `${FULL_LETTER_WORD_SRC}|sm|md|lg|s|m|l`;

const NON_CLOTHING_NOUN_AFTER_LETTER_RE =
  /^\s+(?:budget|wedding|party|event|group|crowd|gathering|dinner|venue|place|room|space|city|town|trip|vacation|business|company|family|amount|number|deal|part|bit|change|difference|rare|well|format|box|bag|clutch|purse|heel|heels)\b/i;

const BOTTOM_OR_SHOE_AFTER_LETTER_RE =
  /^\s+(?:in\s+|for\s+)?(?:bottoms?|pants?|trousers?|jeans?|skirt|shorts?|chinos?|waist|shoes?|sneakers?|boots?|footwear)\b/i;

const SHOE_WIDTH_SRC = '(?:extra\\s+wide|x-?wide|wide|narrow)';
const SHOE_NUM_SRC = '(?:(US|EU|UK)\\s+)?(\\d{1,2}(?:\\.5)?)(?:\\s+(' + SHOE_WIDTH_SRC + '))?';

/**
 * Pure deterministic parser that extracts `top`, `bottom`, and `shoes` sizes
 * from plain spoken or typed shopper text, while ignoring prices, budgets,
 * look numbers, ratings, and times.
 */
export function extractSizesFromSpeech(text: string): Partial<Record<CoreSizeSlot, string>> {
  if (typeof text !== 'string' || !text.trim()) return {};

  const normalized = maskNonSizeSpans(normalizeSpokenNumbers(text));
  const out: Partial<Record<CoreSizeSlot, string>> = {};

  // Track character ranges already consumed by bottom/shoes so bare fallbacks don't double-count.
  let remaining = normalized;
  const consume = (match: RegExpMatchArray) => {
    if (match.index === undefined) return;
    remaining =
      remaining.slice(0, match.index) +
      ' '.repeat(match[0].length) +
      remaining.slice(match.index + match[0].length);
  };

  // -------------------------------------------------------------------------
  // 1. BOTTOM: waist x inseam ("30 by 34", "30x34", "W30 L34", "30 waist 34 inseam")
  // -------------------------------------------------------------------------
  const wxlPatterns: RegExp[] = [
    /\b(?:(?:bottoms?|pants?|trousers?|jeans?|chinos?)\s+(?:is|are|size|in|a)?\s*)?W?\s*(\d{2})\s*W?\s*(?:by|x|×|\/)\s*(\d{2})\s*L?\b/i,
    /\bW\s*(\d{2})\s*[\s/x×,-]*L\s*(\d{2})\b/i,
    /\b(\d{2})\s*waist[\s,]+(?:and\s+)?(\d{2})\s*(?:inseam|length|long)\b/i,
    /\bwaist\s*(?:is\s+|of\s+)?(\d{2})[\s,]+(?:and\s+)?(?:inseam|length)\s*(?:is\s+|of\s+)?(\d{2})\b/i,
  ];
  for (const re of wxlPatterns) {
    const m = remaining.match(re);
    if (m) {
      const w = Number(m[1]);
      const l = Number(m[2]);
      if (w >= 22 && w <= 54 && l >= 24 && l <= 38) {
        out.bottom = `${w}x${l}`;
        consume(m);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. SHOES: keyword + number/width, or unambiguous half-size / width forms
  // -------------------------------------------------------------------------
  const shoeAfterKeywordRe = new RegExp(
    `\\b(?:shoes?|shoe\\s+size|sneakers?|boots?|footwear)(?:\\s+(?:is|are|size|in|a))*\\s*[:=-]?\\s*(?:size\\s+)?${SHOE_NUM_SRC}\\b`,
    'i',
  );
  const shoeBeforeKeywordRe = new RegExp(
    `\\b(?:size\\s+)?${SHOE_NUM_SRC}\\s+(?:in\\s+|for\\s+)?(?:shoes?|shoe\\s+size|sneakers?|boots?|footwear)\\b`,
    'i',
  );
  const shoeWidthOnlyRe = new RegExp(
    `\\b(?:size\\s+)?(US|EU|UK)?\\s*(\\d{1,2}(?:\\.5)?)\\s+(${SHOE_WIDTH_SRC})\\b`,
    'i',
  );
  const shoeHalfOnlyRe = /\b(?:size\s+)?(?:(US|EU|UK)\s+)?(\d{1,2}\.5)\b/i;
  const shoeEuExplicitRe = /\b(EU)\s+(\d{2}(?:\.5)?)\b|\b(\d{2}(?:\.5)?)\s+(EU)\b/i;

  for (const re of [shoeAfterKeywordRe, shoeBeforeKeywordRe]) {
    const m = remaining.match(re);
    if (m) {
      const val = formatShoeValue(m[2]!, m[1], m[3]);
      if (val) {
        out.shoes = val;
        consume(m);
        break;
      }
    }
  }

  if (!out.shoes) {
    const mWidth = remaining.match(shoeWidthOnlyRe);
    if (mWidth) {
      const n = Number(mWidth[2]);
      if (n >= 3 && n <= 17) {
        const val = formatShoeValue(mWidth[2]!, mWidth[1], mWidth[3]);
        if (val) {
          out.shoes = val;
          consume(mWidth);
        }
      }
    }
  }

  if (!out.shoes) {
    const mHalf = remaining.match(shoeHalfOnlyRe);
    if (mHalf) {
      const n = Number(mHalf[2]);
      if (n >= 3.5 && n <= 16.5) {
        const val = formatShoeValue(mHalf[2]!, mHalf[1], undefined);
        if (val) {
          out.shoes = val;
          consume(mHalf);
        }
      }
    }
  }

  if (!out.shoes) {
    const mEu = remaining.match(shoeEuExplicitRe);
    if (mEu) {
      const numStr = mEu[2] ?? mEu[3]!;
      const val = formatShoeValue(numStr, 'EU', undefined);
      if (val) {
        out.shoes = val;
        consume(mEu);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. BOTTOM: single waist or bottom keyword ("32 waist", "waist 32", "pants medium")
  // -------------------------------------------------------------------------
  if (!out.bottom) {
    const bottomBeforeRe = new RegExp(
      `\\b(?:size\\s+)?(\\d{1,2}|${ANY_LETTER_SRC})\\s+(?:in\\s+(?:the\\s+)?|for\\s+)?(?:waist|bottoms?|pants?|trousers?|jeans?|skirt|shorts?|chinos?)\\b`,
      'i',
    );
    const bottomAfterRe = new RegExp(
      `\\b(?:waist|bottoms?|pants?|trousers?|jeans?|skirt|shorts?|chinos?)(?:\\s+size)?(?:\\s+(?:is|are|in|a))*\\s*[:=-]?\\s*(?:size\\s+)?(\\d{1,2}|${ANY_LETTER_SRC})\\b`,
      'i',
    );
    const waistCodeRe = /\b(\d{2})W\b/;

    for (const re of [bottomBeforeRe, bottomAfterRe]) {
      const m = remaining.match(re);
      if (m) {
        const token = m[1]!;
        const letter = canonicalLetter(token);
        if (letter) {
          out.bottom = letter;
          consume(m);
          break;
        }
        const n = Number(token);
        if (Number.isInteger(n) && ((n >= 0 && n <= 20) || (n >= 22 && n <= 54))) {
          out.bottom = String(n);
          consume(m);
          break;
        }
      }
    }

    if (!out.bottom) {
      const mW = remaining.match(waistCodeRe);
      if (mW) {
        const n = Number(mW[1]);
        if (n >= 22 && n <= 54) {
          out.bottom = String(n);
          consume(mW);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. TOP: explicit top keyword ("medium top", "top is L", "large shirt")
  // -------------------------------------------------------------------------
  const topBeforeRe = new RegExp(
    `\\b(?:size\\s+)?(${ANY_LETTER_SRC}|\\d{1,2})\\s+(?:in\\s+|for\\s+)?(?:tops?|shirts?|tees?|sweaters?|blouses?|jackets?|coats?|blazers?|dresses?)\\b`,
    'i',
  );
  const topAfterRe = new RegExp(
    `\\b(?:tops?|shirts?|tees?|sweaters?|blouses?|jackets?|coats?|blazers?|dresses?)(?:\\s+size)?(?:\\s+(?:is|are|in|a))*\\s*[:=-]?\\s*(?:size\\s+)?(${ANY_LETTER_SRC}|\\d{1,2})\\b`,
    'i',
  );

  for (const re of [topBeforeRe, topAfterRe]) {
    const m = remaining.match(re);
    if (m) {
      const token = m[1]!;
      const letter = canonicalLetter(token);
      if (letter) {
        out.top = letter;
        consume(m);
        break;
      }
      const n = Number(token);
      if (Number.isInteger(n) && n >= 0 && n <= 20) {
        out.top = String(n);
        consume(m);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. TOP fallback: "I'm a large", "I wear a medium", "size XL", or bare letter
  //    in a multi-size answer ("medium, 32, 10.5")
  // -------------------------------------------------------------------------
  if (!out.top) {
    const selfSizeRe = new RegExp(
      `\\b(?:i(?:'m|\\s+am)|i\\s+wear|usually|normally|wear)\\s+(?:an?\\s+)?(?:size\\s+)?(${FULL_LETTER_WORD_SRC}|(?:size\\s+)?[SML])\\b`,
      'i',
    );
    const mSelf = remaining.match(selfSizeRe);
    if (mSelf && mSelf.index !== undefined) {
      const after = remaining.slice(mSelf.index + mSelf[0].length);
      if (
        !NON_CLOTHING_NOUN_AFTER_LETTER_RE.test(after) &&
        !BOTTOM_OR_SHOE_AFTER_LETTER_RE.test(after)
      ) {
        const letter = canonicalLetter(mSelf[1]!);
        if (letter) {
          out.top = letter;
          consume(mSelf);
        }
      }
    }
  }

  if (!out.top) {
    // Explicit "size medium" / "size M" / "size XL"
    const sizeLetterRe = new RegExp(`\\bsize\\s+(${ANY_LETTER_SRC})\\b`, 'i');
    const mSize = remaining.match(sizeLetterRe);
    if (mSize && mSize.index !== undefined) {
      const after = remaining.slice(mSize.index + mSize[0].length);
      if (!BOTTOM_OR_SHOE_AFTER_LETTER_RE.test(after)) {
        const letter = canonicalLetter(mSize[1]!);
        if (letter) {
          out.top = letter;
          consume(mSize);
        }
      }
    }
  }

  // Compact comma-separated size triple like "medium, 32, 10" or "M, 32, 10.5"
  if (!out.top && (out.bottom || out.shoes)) {
    const bareLetterRe = new RegExp(`\\b(${FULL_LETTER_WORD_SRC})\\b`, 'i');
    const mBare = remaining.match(bareLetterRe);
    if (mBare && mBare.index !== undefined) {
      const after = remaining.slice(mBare.index + mBare[0].length);
      if (
        !NON_CLOTHING_NOUN_AFTER_LETTER_RE.test(after) &&
        !BOTTOM_OR_SHOE_AFTER_LETTER_RE.test(after)
      ) {
        const letter = canonicalLetter(mBare[1]!);
        if (letter) {
          out.top = letter;
          consume(mBare);
        }
      }
    }
  }

  // Comma-separated triple without keywords: "medium, 32, 10" or "large, 34, 11"
  if (!out.bottom || !out.shoes) {
    const tripleRe = new RegExp(
      `^\\s*(${ANY_LETTER_SRC})\\s*[,;]\\s*(\\d{2}(?:\\s*(?:x|×|by|\\/)\\s*\\d{2})?)\\s*[,;]\\s*(\\d{1,2}(?:\\.5)?(?:\\s+${SHOE_WIDTH_SRC})?)\\s*[.!]?\\s*$`,
      'i',
    );
    const mTriple = normalized.match(tripleRe);
    if (mTriple) {
      const topL = canonicalLetter(mTriple[1]!);
      if (topL && !out.top) out.top = topL;
      const midRaw = mTriple[2]!.trim();
      const midWxL = midRaw.match(/^(\d{2})\s*(?:x|×|by|\/)\s*(\d{2})$/i);
      if (!out.bottom) {
        if (midWxL) {
          const w = Number(midWxL[1]);
          const l = Number(midWxL[2]);
          if (w >= 22 && w <= 54 && l >= 24 && l <= 38) out.bottom = `${w}x${l}`;
        } else {
          const w = Number(midRaw);
          if (w >= 22 && w <= 54) out.bottom = String(w);
        }
      }
      if (!out.shoes) {
        const shoeParts = mTriple[3]!.trim().match(/^(\d{1,2}(?:\.5)?)(?:\s+(.+))?$/);
        if (shoeParts) {
          const val = formatShoeValue(shoeParts[1]!, undefined, shoeParts[2]);
          if (val) out.shoes = val;
        }
      }
    }
  }

  return out;
}

/**
 * Scans recent shopper turns from newest to oldest and returns the most recent
 * size stated for each of `top`, `bottom`, and `shoes`.
 */
export function extractLatestSizesFromTurns(
  turns: readonly string[],
): Partial<Record<CoreSizeSlot, string>> {
  const found: Partial<Record<CoreSizeSlot, string>> = {};
  for (let i = turns.length - 1; i >= 0; i--) {
    const parsed = extractSizesFromSpeech(turns[i]!);
    for (const slot of CORE_SIZE_SLOTS) {
      if (found[slot] === undefined && parsed[slot] !== undefined) {
        found[slot] = parsed[slot];
      }
    }
    if (found.top && found.bottom && found.shoes) break;
  }
  return found;
}

function canonicalizeForCompare(slot: CoreSizeSlot, raw: string): string {
  const pre = normalizeSpokenNumbers(raw.trim()).replace(/^size\s+/i, '').trim();
  const letter = canonicalLetter(pre);
  if (letter) return letter;

  if (slot === 'bottom') {
    const wxl = pre.match(
      /^(?:W\s*)?(\d{1,2}(?:\.\d+)?)\s*W?\s*(?:[x×/]|by)\s*(\d{1,2}(?:\.\d+)?)\s*L?$/i,
    );
    if (wxl) {
      return `${wxl[1]!.replace(/\.0$/, '')}x${wxl[2]!.replace(/\.0$/, '')}`;
    }
    const wOnly = pre.match(/^(?:waist\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:W|waist|in|inches|")?$/i);
    if (wOnly) {
      return wOnly[1]!.replace(/\.0$/, '');
    }
  }

  if (slot === 'shoes') {
    const m = pre.match(
      /^(?:(US|EU|UK)\s+)?(\d{1,2}(?:\.\d+)?)(?:\s*(extra\s*wide|x-?wide|wide|narrow|regular|W|N|D|EE|2E|4E))?$/i,
    );
    if (m) {
      const val = formatShoeValue(m[2]!, m[1], m[3]);
      if (val) return val.toLowerCase();
    }
  }

  return pre.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Returns true when two size strings represent the same size for a given core slot
 * (e.g. "medium" === "M", "30 by 34" === "30x34", "10 and a half" === "10.5").
 */
export function areSizesEquivalent(slot: CoreSizeSlot, a: string, b: string): boolean {
  return canonicalizeForCompare(slot, a) === canonicalizeForCompare(slot, b);
}
