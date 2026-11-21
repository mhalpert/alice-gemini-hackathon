import { calllog } from '../calllog.ts';
import type { Outfit, Piece } from '../types.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';
import type { PageSender } from './page.ts';
import { normalizeSlotKey } from './state.ts';

export const DEFAULT_WALKTHROUGH_MIN_PIECE_MS = 4_000;
export const DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS = 6_000;
export const MAX_WALKTHROUGH_PIECES = 4;

export const WALKTHROUGH_LEAD_INS: readonly string[] = [
  'First, the',
  'Then the',
  'Down to the',
  'And to finish, the',
];

export const WALKTHROUGH_END_QUESTION = 'Want to see it on you?';

export type WalkthroughLogFn = (
  room: string,
  ev: string,
  data?: Record<string, unknown>,
) => void;

export interface Point2D {
  x: number;
  y: number;
}

export interface WalkthroughStartOptions {
  detailBySlot?: Record<string, string>;
  express?: boolean;
}

export interface WalkthroughControllerOptions {
  room: string;
  page: PageSender;
  generateReply: (opts: { instructions: string }) => unknown;
  minPieceMs?: number;
  maxPieceWaitMs?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  isExpress?: () => boolean;
  log?: WalkthroughLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface WalkthroughController {
  start(outfit: Outfit, opts?: WalkthroughStartOptions): boolean;
  stop(reason?: string): void;
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  onShopperSpoke(): void;
  dispose(): void;
  readonly isActive: boolean;
  readonly usingHighlightFallback: boolean;
}

const SLOT_ORDER: Readonly<Record<string, number>> = {
  layer: 0,
  dress: 1,
  top: 2,
  bottom: 3,
  shoes: 4,
  accessory: 5,
  bag: 5,
  jewelry: 5,
};

const SLOT_DEFAULT_POINTS: Readonly<Record<string, Point2D>> = {
  layer: { x: 0.42, y: 0.36 },
  dress: { x: 0.5, y: 0.42 },
  top: { x: 0.5, y: 0.36 },
  bottom: { x: 0.5, y: 0.32 },
  shoes: { x: 0.55, y: 0.6 },
  accessory: { x: 0.5, y: 0.5 },
  bag: { x: 0.5, y: 0.5 },
  jewelry: { x: 0.5, y: 0.5 },
};

const SLOT_NOUNS: Readonly<Record<string, string>> = {
  layer: 'jacket',
  dress: 'dress',
  top: 'top',
  bottom: 'trousers',
  shoes: 'shoes',
  accessory: 'accessory',
  bag: 'bag',
  jewelry: 'jewelry',
};

const DETAIL_POINT_RULES: ReadonlyArray<{ re: RegExp; point: Point2D }> = [
  { re: /\blapels?\b/i, point: { x: 0.38, y: 0.3 } },
  {
    re: /\b(?:collars?|necklines?|v-neck|crew\s?neck|mock\s?neck|turtleneck)\b/i,
    point: { x: 0.5, y: 0.14 },
  },
  {
    re: /\b(?:buttons?|buttoned|plackets?|double[- ]breasted|single[- ]breasted)\b/i,
    point: { x: 0.5, y: 0.5 },
  },
  { re: /\b(?:cuffs?|sleeves?)\b/i, point: { x: 0.18, y: 0.62 } },
  { re: /\bpockets?\b/i, point: { x: 0.34, y: 0.58 } },
  { re: /\b(?:waistbands?|waists?|high[- ]rise|mid[- ]rise)\b/i, point: { x: 0.5, y: 0.12 } },
  { re: /\b(?:pleats?|pleated|creases?|creased)\b/i, point: { x: 0.42, y: 0.4 } },
  { re: /\b(?:hems?|hemlines?)\b/i, point: { x: 0.5, y: 0.9 } },
  {
    re: /\b(?:toes?|toebox|almond[- ]toe|pointed[- ]toe|round[- ]toe|square[- ]toe)\b/i,
    point: { x: 0.72, y: 0.62 },
  },
  {
    re: /\b(?:soles?|cupsoles?|outsoles?|lug[- ]sole|heels?|stilettos?|footbeds?)\b/i,
    point: { x: 0.3, y: 0.8 },
  },
  { re: /\b(?:laces?|laced|lace[- ]up|eyelets?)\b/i, point: { x: 0.5, y: 0.42 } },
  { re: /\b(?:buckles?|straps?|strappy|clasps?)\b/i, point: { x: 0.5, y: 0.5 } },
  {
    re: /\b(?:fabric|weave|woven|texture|textured|silk|wool|merino|cashmere|linen|cotton|leather|suede|satin|velvet|denim|tweed|crepe|chiffon|knit|ribbed|poplin|twill|jersey|chambray|boucl[eé]|gabardine|canvas|corduroy|flannel|herringbone|jacquard|full[- ]grain|pebbled|brushed|drape|bias)\b/i,
    point: { x: 0.5, y: 0.45 },
  },
];

const DETAIL_SIGNAL_RE =
  /%|\b(?:silk|wool|merino|cashmere|linen|cotton|leather|suede|satin|velvet|denim|tweed|crepe|chiffon|knit|ribbed|poplin|twill|jersey|chambray|nylon|viscose|modal|tencel|lyocell|spandex|elastane|polyester|faux|patent|mesh|lace|sequin|pleat(?:ed)?|tailored|drape|bias|cropped|oversized|relaxed|slim|structured|double-breasted|lapel|collar|cuff|hem|heel|sole|footbed|strap|buckle|zip|button|pocket|lined|embroid\w*|braided|woven|quilted|stitch\w*|full-grain|stretch|breathable|lightweight|heavyweight|high-rise|wide-leg|tapered|midi|maxi|mini|wrap|v-neck|crewneck|mock-neck|cupsole|lug|loafer|oxford|chelsea|stiletto)\b/i;

const DETAIL_BOILERPLATE_RE =
  /^(?:model\s+is\b|imported\b|machine\s+wash\b|dry\s+clean\b|hand\s+wash\b|style\s*(?:#|no\.?)?\b|sku\b|free\s+shipping\b|item\s*#)/i;

const NOTE_LEADING_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'in',
  'with',
  'from',
  'of',
  'crafted',
  'made',
  'cut',
  'features',
  'featuring',
  'designed',
  'finished',
  '100%',
]);

const TRAILING_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'in',
  'at',
  'of',
  'on',
  'for',
  'with',
  'to',
  'by',
  'and',
  'or',
  'so',
  'that',
  'it',
  'its',
  'without',
  'from',
]);

/**
 * Checks whether an optional per-call `express` flag is active in flow/call state.
 */
export function isExpressModeState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const obj = state as Record<string, unknown>;
  if (obj.express === true) return true;
  if (
    obj.flow &&
    typeof obj.flow === 'object' &&
    (obj.flow as Record<string, unknown>).express === true
  ) {
    return true;
  }
  return false;
}

/**
 * Pure deterministic mapping from piece slot + detail text to a 0..1 pointer coordinate
 * on a product image. Checks specific garment features first, then fabric/texture words,
 * falling back to a per-slot default.
 */
export function pointForDetail(slot: string, text: string): Point2D {
  const cleanText = typeof text === 'string' ? text : '';
  for (const rule of DETAIL_POINT_RULES) {
    if (rule.re.test(cleanText)) {
      return { x: rule.point.x, y: rule.point.y };
    }
  }
  const slotNorm = normalizeSlotKey(slot || '');
  const fallback = SLOT_DEFAULT_POINTS[slotNorm] ?? { x: 0.5, y: 0.5 };
  return { x: fallback.x, y: fallback.y };
}

function slotRank(slot: string): number {
  const norm = normalizeSlotKey(slot);
  return SLOT_ORDER[norm] ?? 5;
}

function pickHeroPiecesForWalkthrough(pieces: readonly Piece[]): Piece[] {
  if (pieces.length === 0) return [];
  const first =
    pieces.find((p) => normalizeSlotKey(p.slot) === 'layer') ??
    pieces.find((p) => normalizeSlotKey(p.slot) === 'dress') ??
    pieces.find((p) => normalizeSlotKey(p.slot) === 'top') ??
    pieces[0]!;
  const remaining = pieces.filter((p) => p !== first);
  if (remaining.length === 0) return [first];

  const shoes = remaining.find((p) => normalizeSlotKey(p.slot) === 'shoes');
  if (shoes) return [first, shoes];

  let priciest = remaining[0]!;
  let bestPrice = Number.isFinite(priciest.item.price) ? priciest.item.price : -Infinity;
  for (let i = 1; i < remaining.length; i++) {
    const candidate = remaining[i]!;
    const price = Number.isFinite(candidate.item.price) ? candidate.item.price : -Infinity;
    if (price > bestPrice) {
      bestPrice = price;
      priciest = candidate;
    }
  }
  return [first, priciest];
}

/**
 * Selects up to `maxPieces` (default 4) pieces from a look, keeping hero pieces first
 * when capping, and orders them in slideshow order:
 * layer (jacket), dress, top, bottom, shoes, accessory.
 */
export function selectWalkthroughPieces(
  pieces: readonly Piece[],
  maxPieces: number = MAX_WALKTHROUGH_PIECES,
): Piece[] {
  if (!Array.isArray(pieces) || pieces.length === 0 || maxPieces <= 0) return [];

  const originalIndex = new Map<Piece, number>();
  pieces.forEach((p, i) => originalIndex.set(p, i));

  const bySlotOrder = (a: Piece, b: Piece): number => {
    const diff = slotRank(a.slot) - slotRank(b.slot);
    if (diff !== 0) return diff;
    return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
  };

  if (pieces.length <= maxPieces) {
    return [...pieces].sort(bySlotOrder);
  }

  const heroes = pickHeroPiecesForWalkthrough(pieces);
  const chosen: Piece[] = [];
  const chosenSet = new Set<Piece>();

  for (const h of heroes) {
    if (chosen.length >= maxPieces) break;
    if (!chosenSet.has(h)) {
      chosen.push(h);
      chosenSet.add(h);
    }
  }

  const rest = pieces.filter((p) => !chosenSet.has(p)).sort(bySlotOrder);
  for (const p of rest) {
    if (chosen.length >= maxPieces) break;
    chosen.push(p);
    chosenSet.add(p);
  }

  return chosen.sort(bySlotOrder);
}

/**
 * Extracts a concise concrete detail string for a piece from its description,
 * stylist note (`why`), or title.
 */
export function extractPieceDetail(piece: Piece): string {
  const desc =
    typeof piece.item.description === 'string'
      ? piece.item.description.replace(/\s+/g, ' ').trim()
      : '';

  if (desc.length > 0) {
    const clauses = desc
      .split(/(?:\.\s+|;\s+|\|\s+|\s+[•·]\s+|\n+)/)
      .map((c) => c.trim().replace(/[.!?]+$/, '').trim())
      .filter((c) => c.length >= 4);

    const nonBoilerplate = clauses.filter((c) => !DETAIL_BOILERPLATE_RE.test(c));
    const pool = nonBoilerplate.length > 0 ? nonBoilerplate : clauses;
    const preferred = pool.find((c) => DETAIL_SIGNAL_RE.test(c)) ?? pool[0] ?? desc;
    return preferred.replace(/[.!?]+$/, '').trim();
  }

  const why = typeof piece.why === 'string' ? piece.why.replace(/\s+/g, ' ').trim() : '';
  if (why.length > 0) {
    return why.replace(/[.!?]+$/, '').trim();
  }

  return stripTitleColor(piece.item.title) || piece.slot;
}

function stripTitleColor(title: string): string {
  if (typeof title !== 'string') return '';
  return title
    .split(/\s+[-–—|]\s+/)[0]!
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeFirst(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cleanToken(word: string): string {
  return word.replace(/^[,;:("'“”]+|[,;:.)"'“”!?]+$/g, '');
}

/**
 * Builds a 2 to 4 word detail caption for `showPiece.note` (e.g. "Notch lapel",
 * "Tropical wool", "Full-grain leather upper").
 */
export function buildPieceNote(piece: Piece, detailText: string): string {
  const raw = (detailText || '').replace(/\s+/g, ' ').trim();
  const tokens = raw
    .split(/\s+/)
    .map(cleanToken)
    .filter((w) => w.length > 0);

  // If a concrete detail keyword appears in the text, take up to 2 words around it (preferring modifier + keyword).
  for (const rule of DETAIL_POINT_RULES) {
    const matchIdx = tokens.findIndex((t) => rule.re.test(t));
    if (matchIdx !== -1) {
      let start = Math.max(0, matchIdx - 1);
      while (
        start < matchIdx &&
        (NOTE_LEADING_STOPWORDS.has(tokens[start]!.toLowerCase()) ||
          TRAILING_STOPWORDS.has(tokens[start]!.toLowerCase()))
      ) {
        start += 1;
      }
      let end = matchIdx + 1;
      if (end - start < 2 && end < tokens.length) {
        const nextTok = tokens[end]!;
        if (!TRAILING_STOPWORDS.has(nextTok.toLowerCase())) {
          end += 1;
        }
      }
      if (end - start < 2 && start > 0) {
        const prevTok = tokens[start - 1]!;
        if (!NOTE_LEADING_STOPWORDS.has(prevTok.toLowerCase())) {
          start -= 1;
        }
      }
      const phrase = tokens.slice(start, Math.min(end, start + 4));
      if (phrase.length >= 2) {
        return capitalizeFirst(phrase.join(' ').toLowerCase());
      }
    }
  }

  // Otherwise take the first 2 to 4 meaningful words from the detail clause.
  const filtered: string[] = [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (filtered.length === 0 && NOTE_LEADING_STOPWORDS.has(lower)) {
      continue;
    }
    filtered.push(tok);
    if (filtered.length >= 4) break;
  }
  while (
    filtered.length > 2 &&
    TRAILING_STOPWORDS.has(filtered[filtered.length - 1]!.toLowerCase())
  ) {
    filtered.pop();
  }
  if (filtered.length >= 2) {
    return capitalizeFirst(filtered.slice(0, 4).join(' ').toLowerCase());
  }

  // Fallback to piece title (2-4 words) or slot + "detail".
  const titleWords = stripTitleColor(piece.item.title)
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean)
    .slice(0, 3);
  if (titleWords.length >= 2) {
    return capitalizeFirst(titleWords.join(' ').toLowerCase());
  }

  const slotNoun = SLOT_NOUNS[normalizeSlotKey(piece.slot)] ?? (piece.slot.trim() || 'piece');
  return capitalizeFirst(`${slotNoun} detail`);
}

function pieceDisplayName(piece: Piece): string {
  const baseTitle = stripTitleColor(piece.item.title);
  const words = baseTitle.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return SLOT_NOUNS[normalizeSlotKey(piece.slot)] ?? 'piece';
  }
  if (words.length <= 2) {
    return words.join(' ').toLowerCase();
  }
  return words.slice(-2).join(' ').toLowerCase();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Builds one sentence (at most 16 words) naming the piece and one concrete detail,
 * using the rotating lead-ins:
 * "First, the ...", "Then the ...", "Down to the ...", "And to finish, the ...".
 */
export function buildPieceWalkthroughLine(
  piece: Piece,
  detailText: string,
  index: number,
): string {
  const leadIn = WALKTHROUGH_LEAD_INS[index % WALKTHROUGH_LEAD_INS.length]!;
  const name = pieceDisplayName(piece);
  const rawDetail = (detailText || extractPieceDetail(piece))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep a single sentence (stop at first sentence boundary if multiple sentences exist).
  const firstClause = rawDetail.split(/[.!?](?:\s+|$)/)[0]!.trim().replace(/[,;:]+$/, '');
  const detail = firstClause
    ? firstClause.charAt(0).toLowerCase() + firstClause.slice(1)
    : 'clean finish';

  const prefix = `${leadIn} ${name}:`;
  const prefixWords = countWords(prefix);
  const maxDetailWords = Math.max(2, 16 - prefixWords);

  const detailWords = detail.split(/\s+/).filter(Boolean);
  const clipped = detailWords.slice(0, maxDetailWords);
  while (
    clipped.length > 2 &&
    TRAILING_STOPWORDS.has(cleanToken(clipped[clipped.length - 1]!).toLowerCase())
  ) {
    clipped.pop();
  }

  const detailPart = clipped.join(' ').replace(/[,;:!?]+$/, '');
  return `${prefix} ${detailPart}.`;
}

/**
 * Fixed-speech instruction for speaking one piece's walkthrough line.
 */
export function buildPieceWalkthroughInstruction(
  line: string,
  piece?: Piece,
  note?: string,
  index = 0,
): string {
  if (!piece) {
    return `The next piece slide just came up on screen. Say this line in your voice as Alice: "${line}" Keep it to that one sentence, never invent materials, and do not ask a question.`;
  }
  const leadIn = WALKTHROUGH_LEAD_INS[index % WALKTHROUGH_LEAD_INS.length]!;
  const title = stripTitleColor(piece.item.title) || piece.slot;
  const why = typeof piece.why === 'string' ? piece.why.replace(/\s+/g, ' ').trim() : '';
  const facts = [note ? `the pointer is on: ${note}` : '', why ? `stylist note: ${why}` : '']
    .filter(Boolean)
    .join('; ');
  return `The slide for the ${piece.slot} piece "${title}" just came up on screen${facts ? ` (${facts})` : ''}. Say ONE natural spoken sentence of at most 14 words in your voice as Alice, starting "${leadIn} ...", naming the piece in plain words and the one detail the pointer is on. Never read out fabric percentages, product codes, sizes or a spec list, never invent materials, and do not ask a question.`;
}

/**
 * Fixed-speech instruction for asking the closing question once the walkthrough ends.
 */
export function buildWalkthroughQuestionInstruction(): string {
  return `The piece walkthrough just finished and the full look is back on screen. Ask in your voice as Alice: "${WALKTHROUGH_END_QUESTION}" Say nothing else.`;
}

/**
 * Tool-result instruction appended to `pick_outfit` when the walkthrough is active.
 */
export function buildWalkthroughPickInstruction(): string {
  return `A piece-by-piece walkthrough of the pieces is now playing on screen with its own narration. Say nothing until it ends, then nothing more than the question "${WALKTHROUGH_END_QUESTION}" (the walkthrough asks it; do not repeat it).`;
}

function sanitizeImageUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\\')) return '';
  if (trimmed.startsWith('/tryon/')) {
    return trimmed.length > '/tryon/'.length && !trimmed.includes('..') ? trimmed : '';
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    return '';
  }
  return '';
}

interface ActiveWalkthrough {
  gen: number;
  outfitNumber: number;
  pieces: Piece[];
  details: string[];
  currentIndex: number;
  piecesShown: number;
  pieceStartedAt: number;
  speechStarted: boolean;
  speechDone: boolean;
  sending: boolean;
}

/**
 * Runs a piece-by-piece slideshow walkthrough after `pick_outfit`:
 * - Selects up to 4 pieces (hero pieces first) in layer, dress, top, bottom, shoes, accessory order.
 * - Sends `showPiece` per piece (falling back per call to `highlight { outfit, piece }` if refused)
 *   and narrates each piece via `generateReply`.
 * - Moves on after each line finishes (~4-6s per piece), then sends `hidePiece` and asks
 *   "Want to see it on you?".
 * - Stops immediately (sending `hidePiece`) if the shopper speaks or another action interrupts.
 */
export function createWalkthroughController(
  options: WalkthroughControllerOptions,
): WalkthroughController {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const minPieceMs = Math.max(0, options.minPieceMs ?? DEFAULT_WALKTHROUGH_MIN_PIECE_MS);
  const maxPieceWaitMs = Math.max(
    minPieceMs,
    options.maxPieceWaitMs ?? DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS,
  );
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let useHighlightFallback = false;
  let pieceVisible = false;
  let runGen = 0;
  let timer: TimerHandle | null = null;
  let active: ActiveWalkthrough | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function armTimer(delayMs: number): void {
    cancelTimer();
    if (disposed || !active) return;
    const ms = Math.max(0, Math.ceil(delayMs));
    timer = setTimeoutFn(() => {
      timer = null;
      evaluate();
    }, ms);
    timer.unref?.();
  }

  function safeHidePiece(): void {
    if (!pieceVisible) return;
    pieceVisible = false;
    try {
      void Promise.resolve(options.page.send('hidePiece', {})).catch(() => {});
    } catch {
      // Never throw on page send failure.
    }
  }

  function stopInternal(reason: string): void {
    cancelTimer();
    if (!active) {
      safeHidePiece();
      return;
    }
    const stopped = active;
    active = null;
    runGen += 1;
    safeHidePiece();
    logFn(options.room, 'walkthrough_end', {
      outfit: stopped.outfitNumber,
      reason,
      pieces_shown: stopped.piecesShown,
    });
  }

  function finishCompleted(run: ActiveWalkthrough): void {
    cancelTimer();
    active = null;
    runGen += 1;

    if (pieceVisible) {
      safeHidePiece();
    } else if (useHighlightFallback) {
      try {
        void Promise.resolve(
          options.page.send('highlight', { outfit: run.outfitNumber, piece: null }),
        ).catch(() => {});
      } catch {
        // Never throw on page send failure.
      }
    }

    logFn(options.room, 'walkthrough_end', {
      outfit: run.outfitNumber,
      reason: 'completed',
      pieces_shown: run.piecesShown,
    });

    if (disposed || userState === 'speaking') return;
    try {
      options.generateReply({ instructions: buildWalkthroughQuestionInstruction() });
    } catch (err) {
      logFn(options.room, 'session_error', {
        source: 'walkthrough_question',
        outfit: run.outfitNumber,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  function showCurrentPiece(run: ActiveWalkthrough): void {
    const idx = run.currentIndex;
    const piece = run.pieces[idx];
    if (!piece) {
      finishCompleted(run);
      return;
    }

    const detail = run.details[idx] ?? extractPieceDetail(piece);
    const note = buildPieceNote(piece, detail);
    const point = pointForDetail(piece.slot, detail);
    const line = buildPieceWalkthroughLine(piece, detail, idx);
    const image = sanitizeImageUrl(piece.item.image) || piece.item.image || '';
    const myGen = run.gen;

    run.sending = true;
    run.speechStarted = false;
    run.speechDone = false;

    void (async () => {
      let usedPage: 'showPiece' | 'highlight' = 'showPiece';

      if (!useHighlightFallback) {
        let ok = false;
        try {
          const reply = await options.page.send('showPiece', {
            outfit: run.outfitNumber,
            slot: piece.slot,
            item: piece.item,
            image,
            index: idx,
            count: run.pieces.length,
            note,
            point,
          });
          ok = Boolean(reply?.ok);
        } catch {
          ok = false;
        }

        if (disposed || active !== run || run.gen !== myGen) {
          if (ok) {
            pieceVisible = true;
            safeHidePiece();
          }
          return;
        }

        if (ok) {
          pieceVisible = true;
          usedPage = 'showPiece';
        } else {
          useHighlightFallback = true;
          usedPage = 'highlight';
          try {
            await options.page.send('highlight', {
              outfit: run.outfitNumber,
              piece: piece.slot,
            });
          } catch {
            // Never throw on fallback send error.
          }
        }
      } else {
        usedPage = 'highlight';
        try {
          await options.page.send('highlight', {
            outfit: run.outfitNumber,
            piece: piece.slot,
          });
        } catch {
          // Never throw on fallback send error.
        }
      }

      if (disposed || active !== run || run.gen !== myGen) {
        return;
      }

      run.sending = false;
      run.piecesShown = idx + 1;
      run.pieceStartedAt = nowFn();

      logFn(options.room, 'walkthrough_piece', {
        outfit: run.outfitNumber,
        slot: piece.slot,
        index: idx,
        count: run.pieces.length,
        note,
        point,
        page: usedPage,
      });

      try {
        options.generateReply({ instructions: buildPieceWalkthroughInstruction(line, piece, note, idx) });
      } catch (err) {
        logFn(options.room, 'session_error', {
          source: 'walkthrough_piece',
          outfit: run.outfitNumber,
          slot: piece.slot,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      evaluate();
    })();
  }

  function evaluate(): void {
    cancelTimer();
    if (disposed || !active) return;
    const run = active;
    if (run.sending) return;

    const now = nowFn();
    const elapsed = now - run.pieceStartedAt;

    if (run.speechDone) {
      if (elapsed < minPieceMs) {
        armTimer(minPieceMs - elapsed);
        return;
      }
      advance(run);
      return;
    }

    if (run.speechStarted && agentState === 'speaking') {
      // Wait for Alice to finish her piece sentence.
      return;
    }

    // Speech has not started yet (or test does not drive agent states): advance after maxPieceWaitMs.
    if (elapsed >= maxPieceWaitMs) {
      advance(run);
      return;
    }
    armTimer(maxPieceWaitMs - elapsed);
  }

  function advance(run: ActiveWalkthrough): void {
    if (disposed || active !== run) return;
    const nextIdx = run.currentIndex + 1;
    if (nextIdx >= run.pieces.length) {
      finishCompleted(run);
      return;
    }
    run.currentIndex = nextIdx;
    showCurrentPiece(run);
  }

  return {
    get isActive(): boolean {
      return active !== null;
    },

    get usingHighlightFallback(): boolean {
      return useHighlightFallback;
    },

    start(outfit: Outfit, opts?: WalkthroughStartOptions): boolean {
      if (disposed) return false;
      if (opts?.express === true || options.isExpress?.() === true) {
        return false;
      }

      if (active) {
        stopInternal('pick_outfit');
      }

      const pieces = selectWalkthroughPieces(outfit.pieces ?? [], MAX_WALKTHROUGH_PIECES);
      if (pieces.length === 0) return false;

      const outfitNumber = outfit.number ?? 1;
      const details = pieces.map((piece) => {
        const provided = opts?.detailBySlot?.[piece.slot]?.trim();
        return provided && provided.length > 0 ? provided : extractPieceDetail(piece);
      });

      runGen += 1;
      const run: ActiveWalkthrough = {
        gen: runGen,
        outfitNumber,
        pieces,
        details,
        currentIndex: 0,
        piecesShown: 0,
        pieceStartedAt: nowFn(),
        speechStarted: false,
        speechDone: false,
        sending: false,
      };
      active = run;

      logFn(options.room, 'walkthrough_start', {
        outfit: outfitNumber,
        count: pieces.length,
        slots: pieces.map((p) => p.slot),
      });

      showCurrentPiece(run);
      return true;
    },

    stop(reason = 'stopped'): void {
      if (disposed) return;
      stopInternal(reason);
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (!active || active.sending) return;

      if (nextState === 'speaking') {
        active.speechStarted = true;
        cancelTimer();
        return;
      }

      if (prevState === 'speaking' && active.speechStarted) {
        active.speechDone = true;
        evaluate();
      }
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;
      if (nextState === 'speaking' && active) {
        stopInternal('shopper_spoke');
      }
    },

    onShopperSpoke(): void {
      if (disposed || !active) return;
      stopInternal('shopper_spoke');
    },

    dispose(): void {
      if (disposed) return;
      stopInternal('disposed');
      disposed = true;
    },
  };
}
