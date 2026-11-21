import type { BagOut, CartResult, Gender, Outfit, Piece } from '../types.ts';
import type { ProductDetail, SizeVariantOpts, SizeVariantResult } from './catalog.ts';
import type { CartLineInput, StoreCartResponse } from './cart.ts';
import { getProduct, sizeVariant } from './catalog.ts';
import { createCart } from './cart.ts';
import { storeNameForDomain } from './stores.ts';
import { logEvent } from './log.ts';

export interface BagLineAdded {
  variant_id: string;
  title?: string;
  size?: string | null;
  asked_size?: string | null;
  size_converted?: boolean;
  slot: string;
  image: string;
  price: number;
  item_id: string;
}

export interface BagLineNotAdded {
  variant_id: string;
  title?: string;
  size?: string | null;
  asked_size?: string | null;
  size_converted?: boolean;
  reason: string;
  slot: string;
  image: string;
  price: number;
  item_id: string;
}

export interface MatchSizeOptions {
  slot?: string;
  gender?: Gender;
  available?: Iterable<string>;
}

export interface BagStoreDeps {
  getProduct(id: string): Promise<ProductDetail | null>;
  sizeVariant(variantId: string, size: string, opts?: SizeVariantOpts): Promise<SizeVariantResult>;
  createCart(storeDomain: string, lines: CartLineInput[]): Promise<StoreCartResponse>;
  now?: () => number;
}

const NUMBER_WORDS: Record<string, number> = {
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

const WORD_TO_LETTER: Record<string, string> = {
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
  '1x': '1X',
  'double extra large': 'XXL',
  'extra extra large': 'XXL',
  'double xl': 'XXL',
  'xx-large': 'XXL',
  'xx large': 'XXL',
  '2xl': 'XXL',
  xxl: 'XXL',
  '2x': '2X',
  'triple extra large': 'XXXL',
  'triple xl': 'XXXL',
  'xxx-large': 'XXXL',
  'xxx large': 'XXXL',
  '3xl': 'XXXL',
  xxxl: 'XXXL',
  '3x': '3X',
};

const LETTER_ALIASES: Record<string, string[]> = {
  XXS: ['XXS', '2XS'],
  XS: ['XS'],
  S: ['S', 'SM'],
  M: ['M', 'MED'],
  L: ['L', 'LG'],
  XL: ['XL', '1X'],
  '1X': ['1X', 'XL'],
  XXL: ['XXL', '2XL', '2X'],
  '2X': ['2X', 'XXL', '2XL'],
  XXXL: ['XXXL', '3XL', '3X'],
  '3X': ['3X', 'XXXL', '3XL'],
};

const ALL_LETTER_CODES = new Set([
  'XXS',
  '2XS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  '1X',
  'XXL',
  '2XL',
  '2X',
  'XXXL',
  '3XL',
  '3X',
]);

function compact(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

function trimTrailingZero(s: string): string {
  return s.replace(/(\d+)\.0\b/g, '$1');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseWordOrInt(token: string): number | null {
  const lower = token.trim().toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
  if (/^\d+$/.test(lower)) return Number(lower);
  return null;
}

function normalizeSpokenSize(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^size\b[\s:.-]*/i, '').trim();
  if (!s) return '';

  // "ten and a half", "10 and a half", "10 and half", "10 half"
  const halfWord = s.match(/^([a-z]+|\d+)\s+(?:and\s+(?:a\s+)?)?half$/i);
  if (halfWord) {
    const base = parseWordOrInt(halfWord[1]);
    if (base !== null) return `${base}.5`;
  }

  // "10 1/2", "10-1/2", "ten 1/2", "10½"
  const halfFrac = s.match(/^([a-z]+|\d+)(?:[\s-]+1\/2|\s*½)$/i);
  if (halfFrac) {
    const base = parseWordOrInt(halfFrac[1]);
    if (base !== null) return `${base}.5`;
  }

  // Standalone number word like "ten"
  const lower = s.toLowerCase();
  if (lower in NUMBER_WORDS) {
    return String(NUMBER_WORDS[lower]);
  }

  return trimTrailingZero(s);
}

function toCanonicalLetter(cleaned: string): string | null {
  const key = cleaned.trim().toLowerCase().replace(/\s+/g, ' ');
  return WORD_TO_LETTER[key] ?? null;
}

function labelLetterCode(label: string): string | null {
  const trimmed = label.trim();
  const direct = toCanonicalLetter(trimmed);
  if (direct) return direct;

  // Parenthetical like "Large (L)" or "Double extra small (XXS)"
  const paren = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    const fromCode = toCanonicalLetter(paren[2]);
    if (fromCode) return fromCode;
    const fromWord = toCanonicalLetter(paren[1]);
    if (fromWord) return fromWord;
  }

  return null;
}

function parseWaistInseam(text: string): { waist: number; inseam: number } | null {
  const cleaned = trimTrailingZero(text.trim());
  let m = cleaned.match(/^(\d+(?:\.\d+)?)\s*W?\s*[x×/]\s*(\d+(?:\.\d+)?)\s*L?$/i);
  if (m) return { waist: Number(m[1]), inseam: Number(m[2]) };

  m = cleaned.match(/^(\d+(?:\.\d+)?)\s*W\s+(\d+(?:\.\d+)?)\s*L$/i);
  if (m) return { waist: Number(m[1]), inseam: Number(m[2]) };

  m = cleaned.match(/^W\s*(\d+(?:\.\d+)?)\s*[\s/x×-]*L\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { waist: Number(m[1]), inseam: Number(m[2]) };

  return null;
}

function parsePlainNumber(text: string): number | null {
  const trimmed = trimTrailingZero(text.trim());
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

const ONE_SIZE_LABEL_RE =
  /^(?:one\s*size(?:\s*fits\s*(?:all|most))?|o\.?\/?s\.?|osfa|osfm|free\s*size|uni(?:sex)?|standard|default(?:\s*title)?)$/i;

function isOneSizeOption(
  sizeOption: { name: string; values: { label: string }[] } | undefined,
): boolean {
  if (!sizeOption || sizeOption.values.length === 0) return true;
  if (sizeOption.values.length === 1) {
    return ONE_SIZE_LABEL_RE.test(sizeOption.values[0].label.trim());
  }
  return false;
}

function womenNumberToLetter(n: number): string | null {
  if (n >= 0 && n <= 2) return 'XS';
  if (n >= 4 && n <= 6) return 'S';
  if (n >= 8 && n <= 10) return 'M';
  if (n >= 12 && n <= 14) return 'L';
  if (n === 16) return 'XL';
  return null;
}

function womenLetterToUsNumbers(letter: string): string[] {
  switch (letter) {
    case 'XXS':
      return ['00', '0'];
    case 'XS':
      return ['0', '2'];
    case 'S':
      return ['4', '6'];
    case 'M':
      return ['8', '6', '10'];
    case 'L':
      return ['12', '10', '14'];
    case 'XL':
    case '1X':
      return ['16', '14'];
    case 'XXL':
    case '2X':
      return ['18', '20'];
    default:
      return [];
  }
}

function womenDressToDenimWaist(n: number): number | null {
  const map: Record<number, number> = {
    0: 24,
    2: 26,
    4: 27,
    6: 28,
    8: 29,
    10: 30,
    12: 31,
    14: 32,
    16: 33,
  };
  return map[n] ?? null;
}

function womenToJuniorsOdd(n: number): number | null {
  // Misses even size -> Juniors odd size
  const evenMap: Record<number, number> = {
    0: 1,
    2: 3,
    4: 5,
    6: 7,
    8: 9,
    10: 11,
    12: 13,
    14: 15,
  };
  if (n in evenMap) return evenMap[n];
  // Denim waist (24..33) -> Juniors odd size
  const waistMap: Record<number, number> = {
    24: 1,
    25: 3,
    26: 3,
    27: 5,
    28: 7,
    29: 9,
    30: 11,
    31: 13,
    32: 15,
    33: 15,
  };
  return waistMap[n] ?? null;
}

function menWaistToLetter(n: number): string | null {
  if (n >= 28 && n <= 29) return 'XS';
  if (n >= 30 && n <= 31) return 'S';
  if (n >= 32 && n <= 33) return 'M';
  if (n >= 34 && n <= 35) return 'L';
  if (n >= 36 && n <= 38) return 'XL';
  if (n >= 39 && n <= 42) return 'XXL';
  return null;
}

function extractLeadingNumber(label: string): number | null {
  if (labelLetterCode(label) !== null) return null;
  const norm = trimTrailingZero(label.trim());
  const m = norm.match(/^(?:(?:US|UK|EU|M|W)\s+)?(\d+(?:\.\d+)?)(?!\d|\.\d)(?=$|\s|[^0-9.])/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function matchSlashLetterLabel(
  canonicalLetter: string,
  labels: readonly string[],
  isAvailable: (l: string) => boolean,
): string | null {
  const aliases = new Set(LETTER_ALIASES[canonicalLetter] ?? [canonicalLetter]);
  const matches: string[] = [];
  for (const label of labels) {
    const parts = label.split(/\s*[/–-]\s*/).map((p) => toCanonicalLetter(p));
    if (parts.length >= 2 && parts.every((p) => p !== null) && parts.some((p) => p !== null && aliases.has(p))) {
      matches.push(label);
    }
  }
  if (matches.length === 0) return null;
  const avail = matches.find((m) => isAvailable(m));
  return avail ?? matches[0];
}

export function matchSizeLabel(
  raw: string,
  labels: readonly string[],
  opts?: MatchSizeOptions,
): string | null {
  if (!raw || !Array.isArray(labels) || labels.length === 0) return null;

  const cleaned = normalizeSpokenSize(raw);
  if (!cleaned) return null;

  const availSet = opts?.available
    ? new Set(Array.from(opts.available, (l) => compact(l)))
    : null;
  const isAvailable = (label: string): boolean => !availSet || availSet.has(compact(label));

  const canonicalLetter = toCanonicalLetter(cleaned);
  const effective = canonicalLetter ?? cleaned;
  const effectiveCompact = compact(effective);
  const cleanedCompact = compact(cleaned);

  // 1. Exact label match (case-insensitive, ignoring spaces, trimming trailing .0)
  for (const label of labels) {
    const labelCompact = compact(trimTrailingZero(label));
    if (labelCompact === effectiveCompact || labelCompact === cleanedCompact) {
      return label;
    }
  }

  // Exact waist x inseam match when shopper gave both waist and inseam (e.g. "32x30", "W34 L32", "34/32")
  const reqWxL = parseWaistInseam(cleaned);
  if (reqWxL) {
    for (const label of labels) {
      const parsed = parseWaistInseam(label);
      if (parsed && parsed.waist === reqWxL.waist && parsed.inseam === reqWxL.inseam) {
        return label;
      }
    }
  }

  // 2. Canonical letter match (handles "Large (L)", "Medium", "8 (M)", "2X" <-> "XXL", "1X" <-> "XL", "M/L")
  if (canonicalLetter) {
    const aliases = LETTER_ALIASES[canonicalLetter] ?? [canonicalLetter];
    for (const alias of aliases) {
      const match = labels.find((label) => labelLetterCode(label) === alias);
      if (match) return match;
    }
    const slashMatch = matchSlashLetterLabel(canonicalLetter, labels, isAvailable);
    if (slashMatch) return slashMatch;
  }

  // 3. Waist-only shopper input against waist x inseam labels (e.g. "32" or "32W" against "32x32", "W34 L32", "34/32")
  const waistOnlyMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*W?$/i);
  if (waistOnlyMatch) {
    const waistNum = Number(waistOnlyMatch[1]);
    const wxMatches = labels
      .map((label) => ({ label, parsed: parseWaistInseam(label) }))
      .filter(
        (entry): entry is { label: string; parsed: { waist: number; inseam: number } } =>
          entry.parsed !== null && entry.parsed.waist === waistNum,
      );

    if (wxMatches.length > 0) {
      const targetInseam = opts?.gender === 'women' ? 30 : 32;
      const availMatches = wxMatches.filter((m) => isAvailable(m.label));
      const pool = availMatches.length > 0 ? availMatches : wxMatches;

      let best = pool[0];
      let bestDist = Math.abs(best.parsed.inseam - targetInseam);
      for (let i = 1; i < pool.length; i += 1) {
        const dist = Math.abs(pool[i].parsed.inseam - targetInseam);
        if (dist < bestDist) {
          best = pool[i];
          bestDist = dist;
        }
      }
      return best.label;
    }
  }

  // 4. Prefix / region-prefixed match:
  //    - labels that START with value followed by non-digit (e.g. "34 US", "34W", "11 M", "8 (M)")
  //    - labels prefixed by US / M / W (e.g. "US 11", "M 11", "W 8"), respecting gender when M/W is used
  //    Prefer US over EU/UK, standard width (M/D) over W/N, and available over unavailable.
  const prefixCandidates: string[] = [];
  const isLetterOnly = /^[A-Z]+$/i.test(effective);
  const prefixRe = isLetterOnly
    ? new RegExp(`^${escapeRegExp(effective)}(?=$|[^a-z0-9])`, 'i')
    : new RegExp(`^${escapeRegExp(effective)}(?!\\d|\\.\\d)(?=$|[^0-9.])`, 'i');

  const regionPrefixRe = !isLetterOnly
    ? new RegExp(
        `^(?:US\\s+(?:[MW]\\s+)?|(?:MEN'?S?|M)\\s+|(?:WOMEN'?S?|W)\\s+)${escapeRegExp(effective)}(?!\\d|\\.\\d)(?=$|\\s|[^0-9.])`,
        'i',
      )
    : null;

  for (const label of labels) {
    const normLabel = trimTrailingZero(label.trim());
    if (prefixRe.test(normLabel)) {
      prefixCandidates.push(label);
    } else if (regionPrefixRe && regionPrefixRe.test(normLabel)) {
      // Avoid matching W-prefixed shoe/size for men or M-prefixed for women
      if (opts?.gender === 'men' && /^(?:US\s+)?(?:WOMEN'?S?|W)\s+/i.test(normLabel)) continue;
      if (opts?.gender === 'women' && /^(?:US\s+)?(?:MEN'?S?|M)\s+/i.test(normLabel)) continue;
      prefixCandidates.push(label);
    }
  }

  if (prefixCandidates.length > 0) {
    const scoreRegion = (label: string): number => {
      if (/\bUS\b/i.test(label)) return 0;
      if (/\b(?:EU|UK)\b/i.test(label)) return 2;
      return 1;
    };
    const scoreWidth = (label: string): number => {
      if (/\b(?:M|D|R|STD|REGULAR)\b/i.test(label)) return 0;
      if (/\b(?:W|EE|2E|N|XW)\b/i.test(label)) return 2;
      return 1;
    };

    prefixCandidates.sort((a, b) => {
      const regionDiff = scoreRegion(a) - scoreRegion(b);
      if (regionDiff !== 0) return regionDiff;
      const availDiff = (isAvailable(a) ? 0 : 1) - (isAvailable(b) ? 0 : 1);
      if (availDiff !== 0) return availDiff;
      return scoreWidth(a) - scoreWidth(b);
    });

    return prefixCandidates[0];
  }

  const slotLower = (opts?.slot ?? '').trim().toLowerCase();
  const plainNum = parsePlainNumber(cleaned);

  // 5. Women's letter -> US numeric dress sizes (e.g. "Medium" -> "8 US" on Everlane dresses)
  if (
    canonicalLetter &&
    opts?.gender === 'women' &&
    slotLower !== 'shoes' &&
    slotLower !== 'shoe'
  ) {
    const labelNums = labels
      .map((l) => extractLeadingNumber(l))
      .filter((n): n is number => n !== null);
    const looksLikeUsDressSizes =
      labelNums.length >= 2 && labelNums.some((n) => n >= 0 && n <= 16 && n % 2 === 0);
    if (looksLikeUsDressSizes) {
      const targets = womenLetterToUsNumbers(canonicalLetter);
      for (const t of targets) {
        const found = matchSizeLabel(t, labels, { ...opts, gender: undefined });
        if (found) return found;
      }
    }
  }

  // 6. Women's numeric conversions
  if (
    plainNum !== null &&
    opts?.gender === 'women' &&
    slotLower !== 'shoes' &&
    slotLower !== 'shoe'
  ) {
    // 6a. Number -> letter labels (0-2 XS, 4-6 S, 8-10 M, 12-14 L, 16 XL)
    const hasLetterLabels = labels.some((label) => {
      const code = labelLetterCode(label);
      return code !== null && ALL_LETTER_CODES.has(code);
    });
    if (hasLetterLabels) {
      const mappedLetter = womenNumberToLetter(plainNum);
      if (mappedLetter) {
        const found = matchSizeLabel(mappedLetter, labels, { ...opts, gender: undefined });
        if (found) return found;
      }
    }

    // 6b. Women's bottoms: dress size -> denim waist (23..36) OR misses/waist -> juniors odd (1,3,5,7,9,11,13,15)
    if (slotLower === 'bottom') {
      const labelNums = labels
        .map((l) => extractLeadingNumber(l))
        .filter((n): n is number => n !== null);

      const hasDenimWaists =
        labelNums.length >= 2 &&
        labelNums.some((n) => n >= 23 && n <= 36) &&
        !labelNums.some((n) => n >= 2 && n <= 16);

      if (hasDenimWaists && plainNum >= 0 && plainNum <= 16) {
        const waist = womenDressToDenimWaist(plainNum);
        if (waist !== null) {
          const found = matchSizeLabel(String(waist), labels, { ...opts, gender: undefined });
          if (found) return found;
        }
      }

      const oddCount = labelNums.filter((n) => n >= 1 && n <= 15 && n % 2 === 1).length;
      const evenCount = labelNums.filter((n) => n >= 2 && n <= 16 && n % 2 === 0).length;
      if (oddCount >= 3 && evenCount === 0) {
        const juniors = womenToJuniorsOdd(plainNum);
        if (juniors !== null) {
          const found = matchSizeLabel(String(juniors), labels, { ...opts, gender: undefined });
          if (found) return found;
        }
      }
    }
  }

  // 7. Men's bottom waist (28-42) -> letter sizes ONLY when slot is 'bottom' and labels are letter-only.
  // Never for 'top' and never for 'layer' (chest sizes 34-52 stay numeric).
  if (plainNum !== null && opts?.gender === 'men' && slotLower === 'bottom') {
    const allLetters = labels.every((l) => labelLetterCode(l) !== null);
    if (allLetters) {
      const mappedLetter = menWaistToLetter(plainNum);
      if (mappedLetter) {
        return matchSizeLabel(mappedLetter, labels, { ...opts, gender: undefined });
      }
    }
  }

  return null;
}

export function isSizeConverted(
  asked: string | null | undefined,
  matched: string | null | undefined,
): boolean {
  if (!asked || !matched) return false;
  const cleanedAsked = normalizeSpokenSize(asked);
  const cleanedMatched = trimTrailingZero(matched.trim());
  if (!cleanedAsked || !cleanedMatched) return false;

  if (compact(cleanedAsked) === compact(cleanedMatched)) return false;

  const askedLetter = toCanonicalLetter(cleanedAsked);
  const matchedLetter = labelLetterCode(cleanedMatched);
  if (askedLetter) {
    if (matchedLetter) {
      const aliases = LETTER_ALIASES[askedLetter] ?? [askedLetter];
      return !aliases.includes(matchedLetter);
    }
    const slashParts = cleanedMatched.split(/\s*[/–-]\s*/).map((p) => toCanonicalLetter(p));
    if (slashParts.length >= 2 && slashParts.every((p) => p !== null)) {
      const aliases = new Set(LETTER_ALIASES[askedLetter] ?? [askedLetter]);
      return !slashParts.some((p) => p !== null && aliases.has(p));
    }
    return true;
  }

  const askedWxL = parseWaistInseam(cleanedAsked);
  const matchedWxL = parseWaistInseam(cleanedMatched);
  if (askedWxL && matchedWxL) {
    return askedWxL.waist !== matchedWxL.waist || askedWxL.inseam !== matchedWxL.inseam;
  }

  const askedWaistOrNum = cleanedAsked.match(/^(\d+(?:\.\d+)?)\s*W?$/i);
  if (askedWaistOrNum) {
    const askedNum = Number(askedWaistOrNum[1]);
    if (matchedWxL) {
      return matchedWxL.waist !== askedNum;
    }
    const matchedNumMatch = cleanedMatched.match(
      /^(?:(?:US|UK|EU|M|W|MEN'?S?|WOMEN'?S?)\s+(?:US\s+)?(?:[MW]\s+)?)?(\d+(?:\.\d+)?)(?!\d|\.\d)(?=$|\s|[^0-9.])/i,
    );
    if (matchedNumMatch && !/^\d+X[SL]?$/i.test(cleanedMatched)) {
      const matchedNum = Number(matchedNumMatch[1]);
      return matchedNum !== askedNum;
    }
    return true;
  }

  return false;
}

function pickSize(sizes: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!sizes || typeof sizes !== 'object') return undefined;
  const lowered = new Map<string, string>();
  for (const [k, v] of Object.entries(sizes)) {
    if (typeof v === 'string' && v.trim()) {
      lowered.set(k.trim().toLowerCase(), v.trim());
    }
  }
  for (const key of keys) {
    const val = lowered.get(key.toLowerCase());
    if (val) return val;
  }
  return undefined;
}

function sizeForSlot(slot: string, sizes: Record<string, string>): string | undefined {
  const s = slot.trim().toLowerCase();
  if (s === 'top') return pickSize(sizes, 'top');
  if (s === 'bottom') return pickSize(sizes, 'bottom');
  if (s === 'shoes' || s === 'shoe') return pickSize(sizes, 'shoes', 'shoe');
  if (s === 'dress') return pickSize(sizes, 'dress', 'top');
  if (s === 'layer') return pickSize(sizes, 'layer', 'top');
  return pickSize(sizes, s);
}

interface ResolvedPiece {
  piece: Piece;
  status: 'added' | 'not_added';
  missingSize: boolean;
  lineAdded?: BagLineAdded;
  lineNotAdded?: BagLineNotAdded;
}

function formatSizesPreview(values: { label: string; available: boolean }[]): string {
  const avail = values.filter((v) => v.available).map((v) => v.label);
  const source = avail.length > 0 ? avail : values.map((v) => v.label);
  return source.slice(0, 12).join(', ');
}

function extractMessageText(msg: any): string {
  if (typeof msg === 'string') return msg;
  if (!msg || typeof msg !== 'object') return 'item unavailable';
  return String(msg.content ?? msg.message ?? msg.text ?? 'item unavailable');
}

function isLineBlockingMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const type = String(msg.type ?? '').toLowerCase();
  if (type === 'error') return true;
  if (type === 'warning') {
    const text = `${extractMessageText(msg)} ${String(msg.code ?? '')}`;
    return /stock|unavail|sold\s*out|out\s*of|invent|quantity|insufficient/i.test(text);
  }
  return false;
}

function findFlaggedLineIndices(
  msg: any,
  added: BagLineAdded[],
  cartLineItems: any[],
): number[] {
  const matched = new Set<number>();
  const pathStr = typeof msg?.path === 'string' ? msg.path : '';
  const pathMatch = pathStr.match(/line_items\[(\d+)\]/i);
  if (pathMatch) {
    const idx = Number(pathMatch[1]);
    if (idx >= 0 && idx < added.length) {
      matched.add(idx);
      return [idx];
    }
  }

  const text = extractMessageText(msg).toLowerCase();
  const dataStr = msg?.data ? JSON.stringify(msg.data).toLowerCase() : '';
  const combined = `${text} ${dataStr}`;

  added.forEach((line, idx) => {
    if (
      (line.variant_id && combined.includes(line.variant_id.toLowerCase())) ||
      (line.title && line.title.length >= 4 && combined.includes(line.title.toLowerCase()))
    ) {
      matched.add(idx);
    }
  });

  if (matched.size === 0 && Array.isArray(cartLineItems) && cartLineItems.length > 0) {
    const presentIds = new Set(
      cartLineItems
        .map((li) => (typeof li?.item?.id === 'string' ? li.item.id : ''))
        .filter(Boolean),
    );
    added.forEach((line, idx) => {
      if (!presentIds.has(line.variant_id)) {
        matched.add(idx);
      }
    });
  }

  return Array.from(matched);
}

export function createBag(deps?: Partial<BagStoreDeps>): {
  addToBag(outfit: Outfit, sizes: Record<string, string>, gender: Gender): Promise<BagOut>;
} {
  const getProductFn = deps?.getProduct ?? getProduct;
  const sizeVariantFn = deps?.sizeVariant ?? sizeVariant;
  const createCartFn = deps?.createCart ?? createCart;
  const now = deps?.now ?? (() => Date.now());

  async function resolvePiece(
    piece: Piece,
    sizes: Record<string, string>,
    gender: Gender,
  ): Promise<ResolvedPiece> {
    const { item, slot } = piece;
    const baseFields = {
      title: item.title,
      slot,
      image: item.image,
      price: item.price,
      item_id: item.id,
    };

    const rawSize = sizeForSlot(slot, sizes);
    const asked_size = rawSize ?? null;

    const detail = await getProductFn(item.variant_id);
    if (!detail) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size,
          reason: 'could not check product availability',
        },
      };
    }

    const sizeOption =
      detail.options.find((o) => /size/i.test(o.name)) ??
      detail.options.find((o) => /waist/i.test(o.name));

    // No size option or true one-size option (e.g. One Size / OS / O/S)
    if (isOneSizeOption(sizeOption)) {
      const singleSize = sizeOption?.values[0]?.label ?? null;
      if (detail.variant.available) {
        return {
          piece,
          status: 'added',
          missingSize: false,
          lineAdded: {
            ...baseFields,
            variant_id: item.variant_id,
            size: singleSize,
            asked_size,
          },
        };
      }
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: singleSize,
          asked_size,
          reason: 'sold out',
        },
      };
    }

    const preview = formatSizesPreview(sizeOption!.values);

    if (!rawSize) {
      return {
        piece,
        status: 'not_added',
        missingSize: true,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size: null,
          reason: `no ${slot} size given (sizes: ${preview})`,
        },
      };
    }

    const allLabels = sizeOption!.values.map((v) => v.label);
    const availLabels = sizeOption!.values.filter((v) => v.available).map((v) => v.label);
    const matched = matchSizeLabel(rawSize, allLabels, {
      slot,
      gender,
      available: availLabels,
    });

    if (!matched) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size,
          reason: `${rawSize} isn't in stock (sizes left: ${preview})`,
        },
      };
    }

    const sv = await sizeVariantFn(item.variant_id, matched, { gender });
    const resolvedSize = sv.size ?? matched;
    const converted = isSizeConverted(rawSize, resolvedSize);
    if (!sv.ok || !sv.variant_id) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: sv.variant_id ?? item.variant_id,
          size: resolvedSize,
          asked_size,
          ...(converted ? { size_converted: true } : {}),
          reason: sv.reason ?? `${matched} is unavailable`,
        },
      };
    }

    return {
      piece,
      status: 'added',
      missingSize: false,
      lineAdded: {
        ...baseFields,
        variant_id: sv.variant_id,
        size: resolvedSize,
        asked_size,
        ...(converted ? { size_converted: true } : {}),
      },
    };
  }

  async function addToBag(
    outfit: Outfit,
    sizes: Record<string, string>,
    gender: Gender,
  ): Promise<BagOut> {
    const t0 = now();
    try {
      const pieces = Array.isArray(outfit?.pieces) ? outfit.pieces : [];
      const resolvedList = await Promise.all(
        pieces.map((piece) => resolvePiece(piece, sizes ?? {}, gender)),
      );

      // Group by store_domain preserving order
      const storeGroups = new Map<
        string,
        {
          store: string;
          store_domain: string;
          added: BagLineAdded[];
          not_added: BagLineNotAdded[];
        }
      >();

      const missingPieces: Piece[] = [];

      for (const res of resolvedList) {
        const domain = res.piece.item.store_domain || 'unknown';
        const displayStore =
          res.piece.item.store || storeNameForDomain(domain);
        let group = storeGroups.get(domain);
        if (!group) {
          group = {
            store: displayStore,
            store_domain: domain,
            added: [],
            not_added: [],
          };
          storeGroups.set(domain, group);
        }

        if (res.missingSize) {
          missingPieces.push(res.piece);
        }

        if (res.status === 'added' && res.lineAdded) {
          group.added.push(res.lineAdded);
        } else if (res.lineNotAdded) {
          group.not_added.push(res.lineNotAdded);
        }
      }

      const groups = Array.from(storeGroups.values());

      // If ANY piece is missing a size, create NO carts
      if (missingPieces.length > 0) {
        const carts: CartResult[] = groups.map((g) => ({
          store: g.store,
          store_domain: g.store_domain,
          cart_id: null,
          continue_url: null,
          total_usd: null,
          added: g.added,
          not_added: g.not_added,
          ms: 0,
        }));

        const missingDesc = missingPieces
          .map((p) => `${p.item.title} (${p.slot})`)
          .join(', ');
        const summary = `NOT DONE: ${missingDesc} still need a size.`;
        const ms = Math.max(0, now() - t0);
        const reasons = carts.flatMap((c) => c.not_added.map((x) => x.reason));
        console.log(
          `[store] bag ${pieces.length} pieces missing_sizes=${missingPieces.length} carts=0 ${ms}ms`,
        );
        logEvent('store_bag', {
          added: 0,
          not_added: reasons.length,
          missing_sizes: missingPieces.length,
          carts: 0,
          total_usd: 0,
          ms,
          reasons,
        });
        return { carts, summary, total_usd: 0 };
      }

      // Create one cart per store with resolvable lines, in parallel
      const carts: CartResult[] = await Promise.all(
        groups.map(async (g): Promise<CartResult> => {
          if (g.added.length === 0) {
            return {
              store: g.store,
              store_domain: g.store_domain,
              cart_id: null,
              continue_url: null,
              total_usd: null,
              added: [],
              not_added: g.not_added,
              ms: 0,
            };
          }

          const cartRes = await createCartFn(
            g.store_domain,
            g.added.map((line) => ({ variant_id: line.variant_id, quantity: 1 })),
          );

          if (cartRes.error || (!cartRes.cart_id && !cartRes.continue_url)) {
            const moved: BagLineNotAdded[] = g.added.map((line) => ({
              ...line,
              reason: 'the store did not answer; try again in a moment',
            }));
            return {
              store: g.store,
              store_domain: g.store_domain,
              cart_id: null,
              continue_url: null,
              total_usd: null,
              added: [],
              not_added: [...g.not_added, ...moved],
              ms: cartRes.ms,
            };
          }

          const finalAdded: BagLineAdded[] = [...g.added];
          const finalNotAdded: BagLineNotAdded[] = [...g.not_added];
          const flaggedReasons = new Map<number, string>();

          for (const msg of cartRes.messages ?? []) {
            if (!isLineBlockingMessage(msg)) continue;
            const text = extractMessageText(msg);
            const indices = findFlaggedLineIndices(msg, finalAdded, cartRes.line_items ?? []);
            for (const idx of indices) {
              if (!flaggedReasons.has(idx)) {
                flaggedReasons.set(idx, text);
              }
            }
          }

          if (flaggedReasons.size > 0) {
            const kept: BagLineAdded[] = [];
            finalAdded.forEach((line, idx) => {
              const reason = flaggedReasons.get(idx);
              if (reason) {
                finalNotAdded.push({ ...line, reason });
              } else {
                kept.push(line);
              }
            });
            return {
              store: g.store,
              store_domain: g.store_domain,
              cart_id: cartRes.cart_id,
              continue_url: cartRes.continue_url,
              total_usd: cartRes.total_usd,
              added: kept,
              not_added: finalNotAdded,
              ms: cartRes.ms,
            };
          }

          return {
            store: g.store,
            store_domain: g.store_domain,
            cart_id: cartRes.cart_id,
            continue_url: cartRes.continue_url,
            total_usd: cartRes.total_usd,
            added: finalAdded,
            not_added: finalNotAdded,
            ms: cartRes.ms,
          };
        }),
      );

      const rawTotal = carts.reduce(
        (sum, c) => sum + (typeof c.total_usd === 'number' && Number.isFinite(c.total_usd) ? c.total_usd : 0),
        0,
      );
      const total_usd = Math.round(rawTotal * 100) / 100;

      const parts: string[] = [];
      for (const cart of carts) {
        if (cart.added.length > 0) {
          const priceStr =
            cart.total_usd !== null ? `$${cart.total_usd.toFixed(2)}` : 'total pending';
          parts.push(`${cart.store}: ${cart.added.length} added, ${priceStr}.`);
        }
        for (const item of cart.added) {
          const line = item as BagLineAdded;
          if (line.size_converted && line.size && line.asked_size) {
            parts.push(
              `${line.title ?? line.variant_id} went in as ${line.size} (you said ${line.asked_size}).`,
            );
          }
        }
        for (const item of cart.not_added) {
          parts.push(`${item.title ?? item.variant_id}: ${item.reason}.`);
        }
      }

      const linksReady = carts.filter((c) => Boolean(c.continue_url)).length;
      parts.push(
        `${linksReady} checkout ${linksReady === 1 ? 'link' : 'links'} ready.`,
      );
      const summary = parts.join(' ');

      const totalAdded = carts.reduce((n, c) => n + c.added.length, 0);
      const totalNotAdded = carts.reduce((n, c) => n + c.not_added.length, 0);
      const reasons = carts.flatMap((c) => c.not_added.map((x) => x.reason));
      const ms = Math.max(0, now() - t0);
      console.log(
        `[store] bag ${pieces.length} pieces added=${totalAdded} not_added=${totalNotAdded} carts=${linksReady} total=$${total_usd.toFixed(2)} ${ms}ms`,
      );
      logEvent('store_bag', {
        added: totalAdded,
        not_added: totalNotAdded,
        missing_sizes: 0,
        carts: linksReady,
        total_usd,
        ms,
        reasons,
      });

      return { carts, summary, total_usd };
    } catch {
      const ms = Math.max(0, now() - t0);
      console.log(`[store] bag error ${ms}ms`);
      logEvent('store_bag', {
        added: 0,
        not_added: Array.isArray(outfit?.pieces) ? outfit.pieces.length : 0,
        missing_sizes: 0,
        carts: 0,
        total_usd: 0,
        ms,
        reasons: ['bag error'],
      });
      return {
        carts: [],
        summary: 'Could not build the shopping bag right now. 0 checkout links ready.',
        total_usd: 0,
      };
    }
  }

  return { addToBag };
}

const defaultBag = createBag();

export const addToBag = defaultBag.addToBag;
