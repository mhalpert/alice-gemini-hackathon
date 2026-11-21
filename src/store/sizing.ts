import type { Gender } from '../types.ts';

export type ShoeWidth = 'wide' | 'narrow' | 'medium';
export type ShoeSystem = 'US' | 'EU' | 'UK';

export interface ParsedShoeWidth {
  sizeText: string;
  width: ShoeWidth | null;
  widthWord: string | null;
}

export interface ParsedWaistInseam {
  waist: number;
  inseam: number;
  waistStr: string;
  inseamStr: string;
}

export interface MatchSizeOptions {
  slot?: string;
  gender?: Gender;
  available?: Iterable<string>;
}

export interface MatchSizeDetail {
  label: string | null;
  note?: string;
  convertedSystem?: ShoeSystem;
  targetValue?: number;
  nearest?: string | null;
  soldOutReason?: string;
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

// Standard US <-> EU shoe charts
const MEN_US_TO_EU: Array<[number, number]> = [
  [6, 39],
  [6.5, 39.5],
  [7, 40],
  [7.5, 40.5],
  [8, 41],
  [8.5, 42],
  [9, 42.5],
  [9.5, 43],
  [10, 44],
  [10.5, 44.5],
  [11, 45],
  [11.5, 45.5],
  [12, 46],
  [12.5, 46.5],
  [13, 47.5],
  [14, 48.5],
  [15, 49.5],
  [16, 50],
];

const WOMEN_US_TO_EU: Array<[number, number]> = [
  [4, 34.5],
  [4.5, 35],
  [5, 35.5],
  [5.5, 36],
  [6, 36.5],
  [6.5, 37],
  [7, 37.5],
  [7.5, 38],
  [8, 38.5],
  [8.5, 39],
  [9, 39.5],
  [9.5, 40],
  [10, 40.5],
  [10.5, 41],
  [11, 41.5],
  [11.5, 42],
  [12, 42.5],
];

export function compact(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

export function trimTrailingZero(s: string): string {
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

export function normalizeSpokenSize(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^size\b[\s:.-]*/i, '').trim();
  if (!s) return '';

  // "ten and a half", "10 and a half", "10 and half", "10 half" (optionally followed by width word)
  const halfWord = s.match(/^([a-z]+|\d+)\s+(?:and\s+(?:a\s+)?)?half(?:\s+(.+))?$/i);
  if (halfWord) {
    const base = parseWordOrInt(halfWord[1]);
    if (base !== null) {
      return halfWord[2] ? `${base}.5 ${halfWord[2].trim()}` : `${base}.5`;
    }
  }

  // "10 1/2", "10-1/2", "ten 1/2", "10½" (optionally followed by width word)
  const halfFrac = s.match(/^([a-z]+|\d+)(?:[\s-]+1\/2|\s*½)(?:\s+(.+))?$/i);
  if (halfFrac) {
    const base = parseWordOrInt(halfFrac[1]);
    if (base !== null) {
      return halfFrac[2] ? `${base}.5 ${halfFrac[2].trim()}` : `${base}.5`;
    }
  }

  // Standalone number word like "ten"
  const lower = s.toLowerCase();
  if (lower in NUMBER_WORDS) {
    return String(NUMBER_WORDS[lower]);
  }

  return trimTrailingZero(s);
}

export function parseShoeWidth(raw: string, allowShortWidth = true): ParsedShoeWidth {
  const normalized = normalizeSpokenSize(raw);
  if (!normalized) return { sizeText: '', width: null, widthWord: null };

  // Match full width words (always safe) or short width codes (W, E, EE, 2E, 4E, N, D, M) when allowShortWidth
  const fullRe =
    /^(.+?)\s+(extra\s*wide|xx-?wide|x-?wide|wide|narrow|medium|regular|standard)$/i;
  const fullMatch = normalized.match(fullRe);
  if (fullMatch && /\d/.test(fullMatch[1])) {
    const token = fullMatch[2].toLowerCase().replace(/\s+/g, ' ');
    if (token.includes('wide')) {
      return { sizeText: fullMatch[1].trim(), width: 'wide', widthWord: 'wide' };
    }
    if (token === 'narrow') {
      return { sizeText: fullMatch[1].trim(), width: 'narrow', widthWord: 'narrow' };
    }
    return { sizeText: fullMatch[1].trim(), width: 'medium', widthWord: 'regular' };
  }

  if (allowShortWidth) {
    // Only strip trailing width letter(s) after a shoe-like number (e.g. "8.5 W", "8.5W", "8.5 E", "11 D", "10 N", "11 M")
    const shortRe = /^((?:(?:US|EU|UK)\s+)?\d+(?:\.\d+)?)\s*(2E|4E|EE|EW|XW|W|E|N|D|M)$/i;
    const shortMatch = normalized.match(shortRe);
    if (shortMatch) {
      const code = shortMatch[2].toUpperCase();
      if (['W', 'E', 'EE', '2E', '4E', 'EW', 'XW'].includes(code)) {
        return { sizeText: shortMatch[1].trim(), width: 'wide', widthWord: 'wide' };
      }
      if (code === 'N') {
        return { sizeText: shortMatch[1].trim(), width: 'narrow', widthWord: 'narrow' };
      }
      return { sizeText: shortMatch[1].trim(), width: 'medium', widthWord: 'regular' };
    }
  }

  return { sizeText: normalized, width: null, widthWord: null };
}

export function parseWaistInseam(text: string): ParsedWaistInseam | null {
  const cleaned = trimTrailingZero(normalizeSpokenSize(text));
  if (!cleaned) return null;

  // "30x34", "30 x 34", "30×34", "30/34", "30W x 34L", "30W/34L"
  let m = cleaned.match(/^(\d+(?:\.\d+)?)\s*W?\s*[x×/]\s*(\d+(?:\.\d+)?)\s*L?$/i);
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  // "30W 34L"
  m = cleaned.match(/^(\d+(?:\.\d+)?)\s*W\s+(\d+(?:\.\d+)?)\s*L$/i);
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  // "W30 L34", "W30/L34", "W30-L34"
  m = cleaned.match(/^W\s*(\d+(?:\.\d+)?)\s*[\s/x×,-]*L\s*(\d+(?:\.\d+)?)$/i);
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  // "30 by 34"
  m = cleaned.match(/^(\d+(?:\.\d+)?)\s+by\s+(\d+(?:\.\d+)?)$/i);
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  // "30 waist 34 inseam", "30 waist, 34 inseam", "30 waist 34 length"
  m = cleaned.match(
    /^(\d+(?:\.\d+)?)\s*waist[\s,]+(\d+(?:\.\d+)?)\s*(?:inseam|length|in)?$/i,
  );
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  // "waist 30, inseam 34", "waist 30 length 34"
  m = cleaned.match(
    /^waist\s*(\d+(?:\.\d+)?)[\s,]+(?:inseam|length)\s*(\d+(?:\.\d+)?)$/i,
  );
  if (m) {
    return { waist: Number(m[1]), inseam: Number(m[2]), waistStr: m[1], inseamStr: m[2] };
  }

  return null;
}

export function toCanonicalLetter(cleaned: string): string | null {
  const key = cleaned.trim().toLowerCase().replace(/\s+/g, ' ');
  return WORD_TO_LETTER[key] ?? null;
}

export function labelLetterCode(label: string): string | null {
  const trimmed = label.trim();
  const direct = toCanonicalLetter(trimmed);
  if (direct) return direct;

  const paren = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    const fromCode = toCanonicalLetter(paren[2]);
    if (fromCode) return fromCode;
    const fromWord = toCanonicalLetter(paren[1]);
    if (fromWord) return fromWord;
  }

  return null;
}

function extractLeadingNumber(label: string): number | null {
  if (labelLetterCode(label) !== null) return null;
  const norm = trimTrailingZero(label.trim());
  const m = norm.match(
    /^(?:(?:US|UK|EU|M|W|MEN'?S?|WOMEN'?S?)\s+(?:US\s+)?(?:[MW]\s+)?)?(\d+(?:\.\d+)?)(?!\d|\.\d)(?=$|\s|[^0-9.])/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parsePlainNumber(text: string): number | null {
  const trimmed = trimTrailingZero(text.trim());
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function usToEuShoe(us: number, gender?: Gender): number | null {
  const table = gender === 'women' ? WOMEN_US_TO_EU : MEN_US_TO_EU;
  for (let i = 0; i < table.length; i += 1) {
    if (table[i][0] === us) return table[i][1];
    if (i > 0 && table[i - 1][0] < us && us < table[i][0]) {
      const frac = (us - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
      return Math.round((table[i - 1][1] + frac * (table[i][1] - table[i - 1][1])) * 2) / 2;
    }
  }
  return null;
}

export function euToUsShoe(eu: number, gender?: Gender): number | null {
  const table = gender === 'women' ? WOMEN_US_TO_EU : MEN_US_TO_EU;
  let bestUs: number | null = null;
  let bestDist = Infinity;
  for (const [usVal, euVal] of table) {
    const dist = Math.abs(euVal - eu);
    if (dist < bestDist) {
      bestDist = dist;
      bestUs = usVal;
    }
  }
  return bestDist <= 1.0 ? bestUs : null;
}

export function usToUkShoe(us: number, gender?: Gender): number {
  return gender === 'women' ? us - 2 : us - 1;
}

export function ukToUsShoe(uk: number, gender?: Gender): number {
  return gender === 'women' ? uk + 2 : uk + 1;
}

interface ParsedShoeLabel {
  label: string;
  num: number;
  system: ShoeSystem | null;
  width: ShoeWidth | null;
}

function parseShoeLabel(label: string): ParsedShoeLabel | null {
  const trimmed = trimTrailingZero(label.trim());
  const num = extractLeadingNumber(trimmed);
  if (num === null) return null;

  let system: ShoeSystem | null = null;
  if (/\bEU\b/i.test(trimmed)) system = 'EU';
  else if (/\bUK\b/i.test(trimmed)) system = 'UK';
  else if (/\bUS\b/i.test(trimmed)) system = 'US';

  let width: ShoeWidth | null = null;
  if (/\b(?:WIDE|EW|XW|EE|2E|4E|W|E)\b/i.test(trimmed.replace(/^(?:W|WOMEN'?S?)\s+/i, ''))) {
    // Only treat W/E as width when it follows the number (not leading gender "W 8")
    const afterNum = trimmed.replace(/^.*?\d+(?:\.\d+)?\s*/, '');
    if (/^(?:EXTRA\s*WIDE|XX?-?WIDE|WIDE|EW|XW|EE|2E|4E|W|E)\b/i.test(afterNum)) {
      width = 'wide';
    }
  }
  if (!width) {
    const afterNum = trimmed.replace(/^.*?\d+(?:\.\d+)?\s*/, '');
    if (/^(?:NARROW|N|AA|2A)\b/i.test(afterNum)) width = 'narrow';
    else if (/^(?:MEDIUM|MED|REGULAR|REG|STANDARD|STD|M|D)\b/i.test(afterNum)) width = 'medium';
  }

  return { label, num, system, width };
}

export function detectShoeLabelSystem(labels: readonly string[]): ShoeSystem | null {
  const parsed = labels.map(parseShoeLabel).filter((p): p is ParsedShoeLabel => p !== null);
  if (parsed.length === 0) return null;

  const hasExplicitEu = parsed.some((p) => p.system === 'EU');
  const hasExplicitUk = parsed.some((p) => p.system === 'UK');
  const hasExplicitUs = parsed.some((p) => p.system === 'US');

  if (hasExplicitUs) return 'US';
  if (hasExplicitUk && !hasExplicitEu) return 'UK';
  if (hasExplicitEu && !hasExplicitUs) return 'EU';

  // All numeric labels between 34 and 50 -> EU shoe sizes!
  if (parsed.every((p) => p.num >= 34 && p.num <= 50)) return 'EU';
  // All numeric labels between 3 and 17 -> US shoe sizes!
  if (parsed.every((p) => p.num >= 3 && p.num <= 17)) return 'US';

  return null;
}

function parseRequestedShoe(
  raw: string,
): { num: number; system: ShoeSystem | null; width: ShoeWidth | null; widthWord: string | null } | null {
  const { sizeText, width, widthWord } = parseShoeWidth(raw, true);
  if (!sizeText) return null;

  let system: ShoeSystem | null = null;
  let numStr = sizeText;

  const prefixSys = sizeText.match(/^(US|EU|UK)\s+(\d+(?:\.\d+)?)$/i);
  const suffixSys = sizeText.match(/^(\d+(?:\.\d+)?)\s+(US|EU|UK)$/i);
  if (prefixSys) {
    system = prefixSys[1].toUpperCase() as ShoeSystem;
    numStr = prefixSys[2];
  } else if (suffixSys) {
    numStr = suffixSys[1];
    system = suffixSys[2].toUpperCase() as ShoeSystem;
  }

  const num = parsePlainNumber(numStr);
  if (num === null) return null;
  return { num, system, width, widthWord };
}

function pickShoeCandidateByWidth(
  matches: ParsedShoeLabel[],
  requestedWidth: ShoeWidth | null,
  widthWord: string | null,
  isAvailable: (l: string) => boolean,
): { label: string; note?: string } {
  const sorted = [...matches].sort((a, b) => {
    const availDiff = (isAvailable(a.label) ? 0 : 1) - (isAvailable(b.label) ? 0 : 1);
    if (availDiff !== 0) return availDiff;
    const usDiff = (a.system === 'US' ? 0 : 1) - (b.system === 'US' ? 0 : 1);
    return usDiff;
  });

  if (requestedWidth === 'wide') {
    const wideMatch = sorted.find((m) => m.width === 'wide');
    if (wideMatch) return { label: wideMatch.label };
    const regularMatch = sorted.find((m) => m.width === 'medium' || m.width === null) ?? sorted[0];
    return {
      label: regularMatch.label,
      note: `${widthWord ?? 'wide'} width isn't offered; added regular ${regularMatch.label.trim()}`,
    };
  }

  if (requestedWidth === 'narrow') {
    const narrowMatch = sorted.find((m) => m.width === 'narrow');
    if (narrowMatch) return { label: narrowMatch.label };
    const regularMatch = sorted.find((m) => m.width === 'medium' || m.width === null) ?? sorted[0];
    return {
      label: regularMatch.label,
      note: `${widthWord ?? 'narrow'} width isn't offered; added regular ${regularMatch.label.trim()}`,
    };
  }

  if (requestedWidth === 'medium') {
    const medMatch = sorted.find((m) => m.width === 'medium') ?? sorted.find((m) => m.width === null) ?? sorted[0];
    return { label: medMatch.label };
  }

  // No width requested: prefer plain or medium width over wide/narrow
  const stdMatch =
    sorted.find((m) => m.width === null) ??
    sorted.find((m) => m.width === 'medium') ??
    sorted[0];
  return { label: stdMatch.label };
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

function matchSlashLetterLabel(
  canonicalLetter: string,
  labels: readonly string[],
  isAvailable: (l: string) => boolean,
): string | null {
  const aliases = new Set(LETTER_ALIASES[canonicalLetter] ?? [canonicalLetter]);
  const matches: string[] = [];
  for (const label of labels) {
    const parts = label.split(/\s*[/–-]\s*/).map((p) => toCanonicalLetter(p));
    if (
      parts.length >= 2 &&
      parts.every((p) => p !== null) &&
      parts.some((p) => p !== null && aliases.has(p))
    ) {
      matches.push(label);
    }
  }
  if (matches.length === 0) return null;
  const avail = matches.find((m) => isAvailable(m));
  return avail ?? matches[0];
}

export function matchSizeDetail(
  raw: string,
  labels: readonly string[],
  opts?: MatchSizeOptions,
): MatchSizeDetail {
  if (!raw || !Array.isArray(labels) || labels.length === 0) return { label: null };

  const slotLower = (opts?.slot ?? '').trim().toLowerCase();
  const isShoes = slotLower === 'shoes' || slotLower === 'shoe';
  const availSet = opts?.available
    ? new Set(Array.from(opts.available, (l) => compact(l)))
    : null;
  const isAvailable = (label: string): boolean => !availSet || availSet.has(compact(label));

  // Shoe-specific handling: widths + EU/UK/US conversion
  const labelSystem = isShoes ? detectShoeLabelSystem(labels) : null;
  const reqShoe = isShoes ? parseRequestedShoe(raw) : null;
  if (isShoes && reqShoe) {
    const parsedLabels = labels
      .map(parseShoeLabel)
      .filter((p): p is ParsedShoeLabel => p !== null);

    // Filter out wrong gender-prefixed labels (e.g. W 8 for men)
    const genderFiltered = parsedLabels.filter((p) => {
      const trimmed = p.label.trim();
      if (opts?.gender === 'men' && /^(?:US\s+)?(?:WOMEN'?S?|W)\s+/i.test(trimmed)) return false;
      if (opts?.gender === 'women' && /^(?:US\s+)?(?:MEN'?S?|M)\s+/i.test(trimmed)) return false;
      return true;
    });

    const reqSystem: ShoeSystem =
      reqShoe.system ?? (reqShoe.num >= 34 && reqShoe.num <= 50 ? 'EU' : 'US');

    // Case A: Same system (US -> US, EU -> EU, UK -> UK)
    if (!labelSystem || labelSystem === reqSystem) {
      const exactNumMatches = genderFiltered.filter(
        (p) => p.num === reqShoe.num && (!p.system || p.system === reqSystem),
      );
      if (exactNumMatches.length > 0) {
        const picked = pickShoeCandidateByWidth(
          exactNumMatches,
          reqShoe.width,
          reqShoe.widthWord,
          isAvailable,
        );
        return { label: picked.label, ...(picked.note ? { note: picked.note } : {}) };
      }
      // If shopper passed a width word (e.g. "8.5 wide") and no label matched at all, don't fall through to string mismatch
      if (labelSystem === 'US' && reqSystem === 'US') {
        return { label: null };
      }
    }

    // Case B: US shopper -> EU labels
    if (reqSystem === 'US' && labelSystem === 'EU' && reqShoe.num >= 4 && reqShoe.num <= 16) {
      const targetEu = usToEuShoe(reqShoe.num, opts?.gender);
      if (targetEu !== null) {
        // Exact EU match first
        const exactEu = genderFiltered.filter((p) => p.num === targetEu);
        if (exactEu.length > 0) {
          const picked = pickShoeCandidateByWidth(
            exactEu,
            reqShoe.width,
            reqShoe.widthWord,
            isAvailable,
          );
          return {
            label: picked.label,
            convertedSystem: 'EU',
            targetValue: targetEu,
            ...(picked.note ? { note: picked.note } : {}),
          };
        }
        // Nearest label AT OR ABOVE targetEu within 1.0
        const aboveWithin1 = genderFiltered
          .filter((p) => p.num >= targetEu && p.num - targetEu <= 1.0)
          .sort((a, b) => a.num - b.num);
        if (aboveWithin1.length > 0) {
          const minNum = aboveWithin1[0].num;
          const tier = aboveWithin1.filter((p) => p.num === minNum);
          const picked = pickShoeCandidateByWidth(
            tier,
            reqShoe.width,
            reqShoe.widthWord,
            isAvailable,
          );
          return {
            label: picked.label,
            convertedSystem: 'EU',
            targetValue: targetEu,
            ...(picked.note ? { note: picked.note } : {}),
          };
        }
        // Out of range / sold out -> compute nearest available EU label
        const availPool = genderFiltered.filter((p) => isAvailable(p.label));
        const nearestPool = availPool.length > 0 ? availPool : genderFiltered;
        let nearest: ParsedShoeLabel | null = null;
        let bestDist = Infinity;
        for (const p of nearestPool) {
          const d = Math.abs(p.num - targetEu);
          if (d < bestDist) {
            bestDist = d;
            nearest = p;
          }
        }
        return {
          label: null,
          convertedSystem: 'EU',
          targetValue: targetEu,
          nearest: nearest?.label ?? null,
          soldOutReason: nearest
            ? `${reqShoe.num} (EU ${targetEu}) is sold out; nearest ${nearest.label.trim()}`
            : `${reqShoe.num} (EU ${targetEu}) is sold out`,
        };
      }
    }

    // Case C: EU shopper -> US labels
    if (reqSystem === 'EU' && labelSystem === 'US' && reqShoe.num >= 34 && reqShoe.num <= 50) {
      const targetUs = euToUsShoe(reqShoe.num, opts?.gender);
      if (targetUs !== null) {
        const exactUs = genderFiltered.filter((p) => p.num === targetUs);
        if (exactUs.length > 0) {
          const picked = pickShoeCandidateByWidth(
            exactUs,
            reqShoe.width,
            reqShoe.widthWord,
            isAvailable,
          );
          return {
            label: picked.label,
            convertedSystem: 'US',
            targetValue: targetUs,
            ...(picked.note ? { note: picked.note } : {}),
          };
        }
        const above = genderFiltered
          .filter((p) => p.num >= targetUs && p.num - targetUs <= 0.5)
          .sort((a, b) => a.num - b.num);
        if (above.length > 0) {
          const picked = pickShoeCandidateByWidth(
            above.filter((p) => p.num === above[0].num),
            reqShoe.width,
            reqShoe.widthWord,
            isAvailable,
          );
          return {
            label: picked.label,
            convertedSystem: 'US',
            targetValue: targetUs,
            ...(picked.note ? { note: picked.note } : {}),
          };
        }
      }
    }

    // Case D: US shopper -> UK labels (men UK = US - 1, women UK = US - 2)
    if (reqSystem === 'US' && labelSystem === 'UK' && reqShoe.num >= 4 && reqShoe.num <= 16) {
      const targetUk = usToUkShoe(reqShoe.num, opts?.gender);
      const exactUk = genderFiltered.filter((p) => p.num === targetUk);
      if (exactUk.length > 0) {
        const picked = pickShoeCandidateByWidth(
          exactUk,
          reqShoe.width,
          reqShoe.widthWord,
          isAvailable,
        );
        return {
          label: picked.label,
          convertedSystem: 'UK',
          targetValue: targetUk,
          ...(picked.note ? { note: picked.note } : {}),
        };
      }
      const aboveUk = genderFiltered
        .filter((p) => p.num >= targetUk && p.num - targetUk <= 0.5)
        .sort((a, b) => a.num - b.num);
      if (aboveUk.length > 0) {
        const picked = pickShoeCandidateByWidth(
          aboveUk.filter((p) => p.num === aboveUk[0].num),
          reqShoe.width,
          reqShoe.widthWord,
          isAvailable,
        );
        return {
          label: picked.label,
          convertedSystem: 'UK',
          targetValue: targetUk,
          ...(picked.note ? { note: picked.note } : {}),
        };
      }
    }

    // Case E: UK shopper -> US labels (men US = UK + 1, women US = UK + 2)
    if (reqSystem === 'UK' && labelSystem === 'US') {
      const targetUs = ukToUsShoe(reqShoe.num, opts?.gender);
      const exactUs = genderFiltered.filter((p) => p.num === targetUs);
      if (exactUs.length > 0) {
        const picked = pickShoeCandidateByWidth(
          exactUs,
          reqShoe.width,
          reqShoe.widthWord,
          isAvailable,
        );
        return {
          label: picked.label,
          convertedSystem: 'US',
          targetValue: targetUs,
          ...(picked.note ? { note: picked.note } : {}),
        };
      }
    }
  }

  // Strip width words even when slot wasn't explicitly set to 'shoes' (e.g. direct sizeVariant("8.5 wide"))
  const widthParsed = parseShoeWidth(raw, isShoes);
  const cleaned = widthParsed.sizeText || normalizeSpokenSize(raw);
  if (!cleaned) return { label: null };

  const canonicalLetter = toCanonicalLetter(cleaned);
  const effective = canonicalLetter ?? cleaned;
  const effectiveCompact = compact(effective);
  const cleanedCompact = compact(cleaned);

  // 1. Exact label match (case-insensitive, ignoring spaces, trimming trailing .0)
  for (const label of labels) {
    const labelCompact = compact(trimTrailingZero(label));
    if (labelCompact === effectiveCompact || labelCompact === cleanedCompact) {
      return {
        label,
        ...(widthParsed.width === 'wide' || widthParsed.width === 'narrow'
          ? { note: `${widthParsed.widthWord} width isn't offered; added regular ${label.trim()}` }
          : {}),
      };
    }
  }

  // Waist x inseam shopper input (e.g. "30x34", "30 waist, 34 inseam", "30 by 34", "W30 L34")
  const reqWxL = parseWaistInseam(cleaned);
  if (reqWxL) {
    const wxMatches = labels
      .map((label) => ({ label, parsed: parseWaistInseam(label) }))
      .filter(
        (entry): entry is { label: string; parsed: ParsedWaistInseam } =>
          entry.parsed !== null && entry.parsed.waist === reqWxL.waist,
      );

    if (wxMatches.length > 0) {
      // Exact waist + inseam match
      const exact = wxMatches.find((m) => m.parsed.inseam === reqWxL.inseam);
      if (exact) return { label: exact.label };

      // Same waist with nearest available inseam
      const availMatches = wxMatches.filter((m) => isAvailable(m.label));
      const pool = availMatches.length > 0 ? availMatches : wxMatches;
      let best = pool[0];
      let bestDist = Math.abs(best.parsed.inseam - reqWxL.inseam);
      for (let i = 1; i < pool.length; i += 1) {
        const dist = Math.abs(pool[i].parsed.inseam - reqWxL.inseam);
        if (dist < bestDist) {
          best = pool[i];
          bestDist = dist;
        }
      }
      return {
        label: best.label,
        note: `${reqWxL.inseamStr} inseam isn't offered; used ${best.parsed.inseamStr}`,
      };
    }

    // Labels are waist-only (separate Waist + Length options on product): match the waist number!
    const waistRes = matchSizeDetail(reqWxL.waistStr, labels, opts);
    if (waistRes.label) return waistRes;
  }

  // 2. Canonical letter match ("Large (L)", "Medium", "8 (M)", "2X" <-> "XXL", "1X" <-> "XL", "M/L")
  if (canonicalLetter) {
    const aliases = LETTER_ALIASES[canonicalLetter] ?? [canonicalLetter];
    for (const alias of aliases) {
      const match = labels.find((label) => labelLetterCode(label) === alias);
      if (match) return { label: match };
    }
    const slashMatch = matchSlashLetterLabel(canonicalLetter, labels, isAvailable);
    if (slashMatch) return { label: slashMatch };
  }

  // 3. Waist-only shopper input against waist x inseam labels (e.g. "32" or "32W")
  const waistOnlyMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*W?$/i);
  if (waistOnlyMatch) {
    const waistNum = Number(waistOnlyMatch[1]);
    const wxMatches = labels
      .map((label) => ({ label, parsed: parseWaistInseam(label) }))
      .filter(
        (entry): entry is { label: string; parsed: ParsedWaistInseam } =>
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
      return { label: best.label };
    }
  }

  // 4. Prefix / region-prefixed match
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
      if (widthParsed.width === 'wide' && /\b(?:W|WIDE|EE|2E|E)\b/i.test(label)) return -1;
      if (widthParsed.width === 'narrow' && /\b(?:N|NARROW)\b/i.test(label)) return -1;
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

    const chosen = prefixCandidates[0];
    const hasWide = /\b(?:W|WIDE|EE|2E|E)\b/i.test(chosen);
    const hasNarrow = /\b(?:N|NARROW)\b/i.test(chosen);
    const widthNote =
      widthParsed.width === 'wide' && !hasWide
        ? `wide width isn't offered; added regular ${chosen.trim()}`
        : widthParsed.width === 'narrow' && !hasNarrow
          ? `narrow width isn't offered; added regular ${chosen.trim()}`
          : undefined;

    return { label: chosen, ...(widthNote ? { note: widthNote } : {}) };
  }

  const plainNum = parsePlainNumber(cleaned);

  // 5. Women's letter -> US numeric dress sizes
  if (canonicalLetter && opts?.gender === 'women' && !isShoes) {
    const labelNums = labels
      .map((l) => extractLeadingNumber(l))
      .filter((n): n is number => n !== null);
    const looksLikeUsDressSizes =
      labelNums.length >= 2 && labelNums.some((n) => n >= 0 && n <= 16 && n % 2 === 0);
    if (looksLikeUsDressSizes) {
      const targets = womenLetterToUsNumbers(canonicalLetter);
      for (const t of targets) {
        const found = matchSizeDetail(t, labels, { ...opts, gender: undefined });
        if (found.label) return found;
      }
    }
  }

  // 6. Women's numeric conversions
  if (plainNum !== null && opts?.gender === 'women' && !isShoes) {
    const hasLetterLabels = labels.some((label) => {
      const code = labelLetterCode(label);
      return code !== null && ALL_LETTER_CODES.has(code);
    });
    if (hasLetterLabels) {
      const mappedLetter = womenNumberToLetter(plainNum);
      if (mappedLetter) {
        const found = matchSizeDetail(mappedLetter, labels, { ...opts, gender: undefined });
        if (found.label) return found;
      }
    }

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
          const found = matchSizeDetail(String(waist), labels, { ...opts, gender: undefined });
          if (found.label) return found;
        }
      }

      const oddCount = labelNums.filter((n) => n >= 1 && n <= 15 && n % 2 === 1).length;
      const evenCount = labelNums.filter((n) => n >= 2 && n <= 16 && n % 2 === 0).length;
      if (oddCount >= 3 && evenCount === 0) {
        const juniors = womenToJuniorsOdd(plainNum);
        if (juniors !== null) {
          const found = matchSizeDetail(String(juniors), labels, { ...opts, gender: undefined });
          if (found.label) return found;
        }
      }
    }
  }

  // 7. Men's bottom waist (28-42) -> letter sizes ONLY for slot 'bottom' and letter-only labels
  if (plainNum !== null && opts?.gender === 'men' && slotLower === 'bottom') {
    const allLetters = labels.every((l) => labelLetterCode(l) !== null);
    if (allLetters) {
      const mappedLetter = menWaistToLetter(plainNum);
      if (mappedLetter) {
        return matchSizeDetail(mappedLetter, labels, { ...opts, gender: undefined });
      }
    }
  }

  return { label: null };
}

export function matchSizeLabel(
  raw: string,
  labels: readonly string[],
  opts?: MatchSizeOptions,
): string | null {
  return matchSizeDetail(raw, labels, opts).label;
}

export function isSizeConverted(
  asked: string | null | undefined,
  matched: string | null | undefined,
): boolean {
  if (!asked || !matched) return false;
  const widthStripped = parseShoeWidth(asked, true).sizeText;
  const cleanedAsked = widthStripped || normalizeSpokenSize(asked);
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
  if (askedWxL && !matchedWxL) {
    // Separate Waist option: matched label is just waist (e.g. "30" from "30x34") -> not converted if waist matches
    const matchedNum = extractLeadingNumber(cleanedMatched);
    if (matchedNum !== null) {
      return matchedNum !== askedWxL.waist;
    }
    return true;
  }

  const askedSysMatch = cleanedAsked.match(/^(US|EU|UK)\s+(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s+(US|EU|UK)$/i);
  const askedSystem = askedSysMatch
    ? ((askedSysMatch[1] ?? askedSysMatch[4]).toUpperCase() as ShoeSystem)
    : null;
  const askedNumPart = askedSysMatch ? (askedSysMatch[2] ?? askedSysMatch[3]) : cleanedAsked;

  const askedWaistOrNum = askedNumPart.match(/^(\d+(?:\.\d+)?)\s*W?$/i);
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
      if (matchedNum !== askedNum) return true;
      // Same number but different explicit system (e.g. US 10 vs UK 10)
      const matchedIsUk = /\bUK\b/i.test(cleanedMatched);
      const matchedIsEu = /\bEU\b/i.test(cleanedMatched);
      if (matchedIsUk && askedSystem !== 'UK') return true;
      if (matchedIsEu && askedSystem !== 'EU' && askedNum < 34) return true;
      return false;
    }
    return true;
  }

  return false;
}
