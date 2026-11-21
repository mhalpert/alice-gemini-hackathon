import { calllog } from '../calllog.ts';
import type { BagLink, BagStore, Gender, Outfit, TryOnState } from '../types.ts';
import type { CameraStatusValue } from './context.ts';

export type StateLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface StateLook {
  number: number;
  name: string;
  total: number;
  slots: string[];
}

export interface LookCritique {
  score: number;
  presentable: boolean;
  issues: string[];
  weakPiece: { slot: string; reason: string; ask: string } | null;
  error?: string;
}

export function isLowCritique(critique: LookCritique | undefined): critique is LookCritique {
  if (!critique) return false;
  if (critique.error || !Number.isFinite(critique.score) || critique.score <= 0) return false;
  return !critique.presentable || critique.score < 7;
}

export interface TryOnInfo {
  status: TryOnState;
  url?: string;
  error?: string;
}

export interface TryOnExtrasInfo {
  scene?: string;
  video?: string;
}

export interface BagNotAdded {
  store: string;
  title: string;
  reason: string;
}

export interface BagState {
  stores: BagStore[];
  total: number;
  links: BagLink[];
  notAdded: BagNotAdded[];
}

export interface OrderReviewState {
  order_id: string;
  bagFingerprint: string;
  reviewedAt: number;
}

export interface CallState {
  shopperName: string | null;
  department: Gender | null;
  occasion: string | null;
  where: string | null;
  when: string | null;
  weather: string | null;
  budget: { asked: boolean; given: number | null };
  ownPiece: string | null;
  looks: StateLook[];
  pickedLook: number | null;
  tryOn: Record<number, TryOnInfo>;
  tryOnExtras: Record<number, TryOnExtrasInfo>;
  critiques: Record<number, LookCritique>;
  revealsDone: number[];
  sizes: Record<string, string>;
  bag: BagState | null;
  orderReview: OrderReviewState | null;
  secondOutfitOffered: boolean;
  camera: CameraStatusValue;
  facts: string[];
  usedBitIds: string[];
}

export type CallStateAction =
  | { type: 'set_shopper_name'; name: string | null }
  | { type: 'set_department'; department: Gender }
  | {
      type: 'set_brief';
      occasion?: string | null;
      where?: string | null;
      when?: string | null;
      weather?: string | null;
      budgetAsked?: boolean;
      budgetGiven?: number | null;
      ownPiece?: string | null;
    }
  | { type: 'set_budget_asked'; asked: boolean }
  | { type: 'set_looks'; looks: StateLook[]; replace?: boolean }
  | { type: 'update_look'; look: StateLook }
  | { type: 'pick_look'; look: number | null }
  | { type: 'set_tryon'; look: number; status: TryOnState; url?: string; error?: string }
  | { type: 'set_tryon_extra'; look: number; kind: 'scene' | 'video'; url: string }
  | { type: 'set_critique'; look: number; critique: LookCritique }
  | { type: 'mark_revealed'; look: number }
  | { type: 'merge_sizes'; sizes: Record<string, string> }
  | { type: 'set_bag'; bag: BagState }
  | { type: 'set_order_review'; review: OrderReviewState | null }
  | { type: 'set_second_outfit_offered'; offered: boolean }
  | { type: 'set_camera'; camera: CameraStatusValue }
  | { type: 'add_fact'; fact: string }
  | { type: 'record_bit_used'; bitId: string };

const MAX_FACTS = 20;

export function createInitialCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    shopperName: null,
    department: null,
    occasion: null,
    where: null,
    when: null,
    weather: null,
    budget: { asked: false, given: null },
    ownPiece: null,
    looks: [],
    pickedLook: null,
    tryOn: {},
    tryOnExtras: {},
    critiques: {},
    revealsDone: [],
    sizes: {},
    bag: null,
    orderReview: null,
    secondOutfitOffered: false,
    camera: 'off',
    facts: [],
    usedBitIds: [],
    ...overrides,
  };
}

export function outfitToStateLook(outfit: Outfit, fallbackNumber?: number): StateLook {
  const num =
    typeof outfit.number === 'number' && Number.isFinite(outfit.number)
      ? outfit.number
      : (fallbackNumber ?? 1);
  return {
    number: num,
    name: outfit.name,
    total: outfit.total,
    slots: (outfit.pieces ?? []).map((p) => p.slot),
  };
}

export function normalizeSlotKey(rawSlot: string): string {
  const clean = rawSlot.trim().toLowerCase();
  if (
    clean === 'shoe' ||
    clean === 'sneaker' ||
    clean === 'sneakers' ||
    clean === 'boot' ||
    clean === 'boots' ||
    clean === 'footwear'
  ) {
    return 'shoes';
  }
  if (clean === 'tops' || clean === 'shirt' || clean === 'sweater') return 'top';
  if (
    clean === 'bottoms' ||
    clean === 'pants' ||
    clean === 'trousers' ||
    clean === 'jeans' ||
    clean === 'waist'
  ) {
    return 'bottom';
  }
  if (clean === 'accessories') return 'accessory';
  if (clean === 'dresses') return 'dress';
  if (
    clean === 'layers' ||
    clean === 'jacket' ||
    clean === 'coat' ||
    clean === 'outerwear' ||
    clean === 'blazer' ||
    clean === 'cardigan'
  ) {
    return 'layer';
  }
  return clean;
}

/**
 * Extracts a shopper's first/display name from a remembered fact when it clearly
 * states their name (e.g., "Shopper's name is Maya", "Name: Alex", "called Sam").
 */
export function extractNameFromFact(fact: string): string | null {
  const trimmed = fact.trim().replace(/[.!]+$/, '');
  if (!trimmed) return null;

  const patterns: RegExp[] = [
    /^(?:the\s+)?(?:shopper|user|client|her|his|their)?(?:'s)?\s*name\s*(?:is|:|=|-)\s*([A-Za-z][A-Za-z' -]{0,29})$/i,
    /^(?:shopper|user|client)\s+is\s+(?:named|called)\s+([A-Za-z][A-Za-z' -]{0,29})$/i,
    /^(?:named|called)\s+([A-Za-z][A-Za-z' -]{0,29})$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const candidate = match[1].trim().replace(/^["']|["']$/g, '');
      if (candidate.length > 0 && candidate.length <= 30 && !/^shopper$/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function sameLook(a: StateLook, b: StateLook): boolean {
  if (a.number !== b.number || a.name !== b.name || a.total !== b.total) return false;
  if (a.slots.length !== b.slots.length) return false;
  for (let i = 0; i < a.slots.length; i++) {
    if (a.slots[i] !== b.slots[i]) return false;
  }
  return true;
}

function sameLooksArray(a: StateLook[], b: StateLook[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameLook(a[i]!, b[i]!)) return false;
  }
  return true;
}

export function reduceCallState(
  state: CallState,
  action: CallStateAction,
): { state: CallState; changed: string[] } {
  const changed: string[] = [];

  switch (action.type) {
    case 'set_shopper_name': {
      const next = action.name ? action.name.trim() : null;
      const normalized = next && next.length > 0 ? next : null;
      if (normalized === state.shopperName) return { state, changed };
      return {
        state: { ...state, shopperName: normalized },
        changed: ['shopperName'],
      };
    }

    case 'set_department': {
      if (action.department === state.department) return { state, changed };
      return {
        state: { ...state, department: action.department },
        changed: ['department'],
      };
    }

    case 'set_budget_asked': {
      if (state.budget.asked === action.asked) return { state, changed };
      return {
        state: { ...state, budget: { ...state.budget, asked: action.asked } },
        changed: ['budget'],
      };
    }

    case 'set_brief': {
      let nextOccasion = state.occasion;
      let nextWhere = state.where;
      let nextWhen = state.when;
      let nextWeather = state.weather;
      let nextBudget = state.budget;
      let nextOwnPiece = state.ownPiece;

      if (action.occasion !== undefined) {
        const clean = action.occasion ? action.occasion.trim() : null;
        if (clean !== state.occasion) {
          nextOccasion = clean;
          changed.push('occasion');
        }
      }

      if (action.where !== undefined) {
        const clean = action.where ? action.where.trim() : null;
        if (clean !== state.where) {
          nextWhere = clean;
          changed.push('where');
        }
      }

      if (action.when !== undefined) {
        const clean = action.when ? action.when.trim() : null;
        if (clean !== state.when) {
          nextWhen = clean;
          changed.push('when');
        }
      }

      if (action.weather !== undefined) {
        const clean = action.weather ? action.weather.trim() : null;
        if (clean !== state.weather) {
          nextWeather = clean;
          changed.push('weather');
        }
      }

      const nextAsked = action.budgetAsked ?? state.budget.asked;
      const nextGiven = action.budgetGiven !== undefined ? action.budgetGiven : state.budget.given;
      if (nextAsked !== state.budget.asked || nextGiven !== state.budget.given) {
        nextBudget = { asked: nextAsked, given: nextGiven };
        changed.push('budget');
      }

      if (action.ownPiece !== undefined) {
        const clean = action.ownPiece ? action.ownPiece.trim() : null;
        if (clean !== state.ownPiece) {
          nextOwnPiece = clean;
          changed.push('ownPiece');
        }
      }

      if (changed.length === 0) return { state, changed };
      return {
        state: {
          ...state,
          occasion: nextOccasion,
          where: nextWhere,
          when: nextWhen,
          weather: nextWeather,
          budget: nextBudget,
          ownPiece: nextOwnPiece,
        },
        changed,
      };
    }

    case 'set_looks': {
      const base = action.replace ? new Map<number, StateLook>() : new Map(state.looks.map((l) => [l.number, l]));
      for (const look of action.looks) {
        base.set(look.number, { ...look, slots: [...look.slots] });
      }
      const nextLooks = Array.from(base.values()).sort((a, b) => a.number - b.number);

      let nextPicked = state.pickedLook;
      let nextTryOn = state.tryOn;
      let nextTryOnExtras = state.tryOnExtras;
      let nextCritiques = state.critiques;
      let nextReveals = state.revealsDone;
      let nextOrderReview = state.orderReview;

      if (!sameLooksArray(state.looks, nextLooks)) {
        changed.push('looks');
      }
      if (action.replace) {
        if (state.pickedLook !== null) {
          nextPicked = null;
          changed.push('pickedLook');
        }
        if (Object.keys(state.tryOn).length > 0) {
          nextTryOn = {};
          changed.push('tryOn');
        }
        if (Object.keys(state.tryOnExtras).length > 0) {
          nextTryOnExtras = {};
          changed.push('tryOnExtras');
        }
        if (Object.keys(state.critiques).length > 0) {
          nextCritiques = {};
          changed.push('critiques');
        }
        if (state.revealsDone.length > 0) {
          nextReveals = [];
          changed.push('revealsDone');
        }
        if (state.orderReview !== null) {
          nextOrderReview = null;
          changed.push('orderReview');
        }
      }

      if (changed.length === 0) return { state, changed };
      return {
        state: {
          ...state,
          looks: nextLooks,
          pickedLook: nextPicked,
          tryOn: nextTryOn,
          tryOnExtras: nextTryOnExtras,
          critiques: nextCritiques,
          revealsDone: nextReveals,
          orderReview: nextOrderReview,
        },
        changed,
      };
    }

    case 'update_look': {
      const byNum = new Map(state.looks.map((l) => [l.number, l]));
      byNum.set(action.look.number, { ...action.look, slots: [...action.look.slots] });
      const nextLooks = Array.from(byNum.values()).sort((a, b) => a.number - b.number);

      const nextTryOn = { ...state.tryOn };
      let tryOnChanged = false;
      if (nextTryOn[action.look.number] !== undefined) {
        delete nextTryOn[action.look.number];
        tryOnChanged = true;
      }

      const nextTryOnExtras = { ...state.tryOnExtras };
      let tryOnExtrasChanged = false;
      if (nextTryOnExtras[action.look.number] !== undefined) {
        delete nextTryOnExtras[action.look.number];
        tryOnExtrasChanged = true;
      }

      const nextCritiques = { ...state.critiques };
      let critiquesChanged = false;
      if (nextCritiques[action.look.number] !== undefined) {
        delete nextCritiques[action.look.number];
        critiquesChanged = true;
      }

      const nextReveals = state.revealsDone.filter((n) => n !== action.look.number);
      const revealsChanged = nextReveals.length !== state.revealsDone.length;
      const orderReviewChanged = state.orderReview !== null;

      if (!sameLooksArray(state.looks, nextLooks)) changed.push('looks');
      if (tryOnChanged) changed.push('tryOn');
      if (tryOnExtrasChanged) changed.push('tryOnExtras');
      if (critiquesChanged) changed.push('critiques');
      if (revealsChanged) changed.push('revealsDone');
      if (orderReviewChanged) changed.push('orderReview');

      if (changed.length === 0) return { state, changed };
      return {
        state: {
          ...state,
          looks: nextLooks,
          tryOn: nextTryOn,
          tryOnExtras: nextTryOnExtras,
          critiques: nextCritiques,
          revealsDone: nextReveals,
          orderReview: null,
        },
        changed,
      };
    }

    case 'pick_look': {
      if (state.pickedLook === action.look) return { state, changed };
      return {
        state: { ...state, pickedLook: action.look },
        changed: ['pickedLook'],
      };
    }

    case 'set_tryon': {
      const prev = state.tryOn[action.look];
      const nextInfo: TryOnInfo = {
        status: action.status,
        ...(action.url ? { url: action.url } : {}),
        ...(action.error ? { error: action.error } : {}),
      };
      if (
        prev &&
        prev.status === nextInfo.status &&
        prev.url === nextInfo.url &&
        prev.error === nextInfo.error
      ) {
        return { state, changed };
      }
      return {
        state: {
          ...state,
          tryOn: { ...state.tryOn, [action.look]: nextInfo },
        },
        changed: ['tryOn'],
      };
    }

    case 'set_tryon_extra': {
      const url = action.url.trim();
      if (!url) return { state, changed };
      const prev = state.tryOnExtras[action.look];
      if (prev && prev[action.kind] === url) {
        return { state, changed };
      }
      return {
        state: {
          ...state,
          tryOnExtras: {
            ...state.tryOnExtras,
            [action.look]: { ...prev, [action.kind]: url },
          },
        },
        changed: ['tryOnExtras'],
      };
    }

    case 'set_critique': {
      const prev = state.critiques[action.look];
      const nextCritique: LookCritique = {
        score: action.critique.score,
        presentable: action.critique.presentable,
        issues: [...action.critique.issues],
        weakPiece: action.critique.weakPiece ? { ...action.critique.weakPiece } : null,
        ...(action.critique.error ? { error: action.critique.error } : {}),
      };
      if (
        prev &&
        prev.score === nextCritique.score &&
        prev.presentable === nextCritique.presentable &&
        prev.error === nextCritique.error &&
        prev.issues.length === nextCritique.issues.length &&
        prev.issues.every((item, idx) => item === nextCritique.issues[idx]) &&
        prev.weakPiece?.slot === nextCritique.weakPiece?.slot &&
        prev.weakPiece?.reason === nextCritique.weakPiece?.reason &&
        prev.weakPiece?.ask === nextCritique.weakPiece?.ask
      ) {
        return { state, changed };
      }
      return {
        state: {
          ...state,
          critiques: { ...state.critiques, [action.look]: nextCritique },
        },
        changed: ['critiques'],
      };
    }

    case 'mark_revealed': {
      if (state.revealsDone.includes(action.look)) return { state, changed };
      return {
        state: {
          ...state,
          revealsDone: [...state.revealsDone, action.look].sort((a, b) => a - b),
        },
        changed: ['revealsDone'],
      };
    }

    case 'merge_sizes': {
      const nextSizes = { ...state.sizes };
      let anyChanged = false;
      for (const [rawSlot, rawSize] of Object.entries(action.sizes)) {
        const slot = normalizeSlotKey(rawSlot);
        const size = typeof rawSize === 'string' ? rawSize.trim() : '';
        if (!slot || !size) continue;
        if (nextSizes[slot] !== size) {
          nextSizes[slot] = size;
          anyChanged = true;
        }
      }
      if (!anyChanged) return { state, changed };
      return {
        state: { ...state, sizes: nextSizes },
        changed: ['sizes'],
      };
    }

    case 'set_bag': {
      const nextChanged = ['bag'];
      if (state.orderReview !== null) {
        nextChanged.push('orderReview');
      }
      return {
        state: {
          ...state,
          bag: {
            stores: action.bag.stores,
            total: action.bag.total,
            links: action.bag.links,
            notAdded: action.bag.notAdded,
          },
          orderReview: null,
        },
        changed: nextChanged,
      };
    }

    case 'set_order_review': {
      const prev = state.orderReview;
      const next = action.review
        ? {
            order_id: action.review.order_id,
            bagFingerprint: action.review.bagFingerprint,
            reviewedAt: action.review.reviewedAt,
          }
        : null;
      if (
        prev === null && next === null ||
        (prev !== null &&
          next !== null &&
          prev.order_id === next.order_id &&
          prev.bagFingerprint === next.bagFingerprint &&
          prev.reviewedAt === next.reviewedAt)
      ) {
        return { state, changed };
      }
      return {
        state: { ...state, orderReview: next },
        changed: ['orderReview'],
      };
    }

    case 'set_second_outfit_offered': {
      if (state.secondOutfitOffered === action.offered) return { state, changed };
      return {
        state: { ...state, secondOutfitOffered: action.offered },
        changed: ['secondOutfitOffered'],
      };
    }

    case 'set_camera': {
      if (state.camera === action.camera) return { state, changed };
      return {
        state: { ...state, camera: action.camera },
        changed: ['camera'],
      };
    }

    case 'add_fact': {
      const clean = action.fact.trim().replace(/\s+/g, ' ');
      if (!clean) return { state, changed };
      const lower = clean.toLowerCase();
      let nextFacts = state.facts;
      if (!state.facts.some((f) => f.toLowerCase() === lower)) {
        nextFacts = [...state.facts, clean].slice(-MAX_FACTS);
        changed.push('facts');
      }

      let nextName = state.shopperName;
      const extracted = extractNameFromFact(clean);
      if (
        extracted &&
        (!state.shopperName || extracted.toLowerCase() !== state.shopperName.toLowerCase())
      ) {
        nextName = extracted;
        changed.push('shopperName');
      }

      let nextSecondOffered = state.secondOutfitOffered;
      if (
        !state.secondOutfitOffered &&
        /\bsecond\s+(?:outfit|look)\b.*\boffered\b|\boffered\b.*\bsecond\s+(?:outfit|look)\b/i.test(clean)
      ) {
        nextSecondOffered = true;
        changed.push('secondOutfitOffered');
      }

      if (changed.length === 0) return { state, changed };
      return {
        state: {
          ...state,
          facts: nextFacts,
          shopperName: nextName,
          secondOutfitOffered: nextSecondOffered,
        },
        changed,
      };
    }

    case 'record_bit_used': {
      const clean = action.bitId.trim();
      if (!clean || state.usedBitIds.includes(clean)) return { state, changed };
      return {
        state: {
          ...state,
          usedBitIds: [...state.usedBitIds, clean],
        },
        changed: ['usedBitIds'],
      };
    }
  }
}

function formatMoney(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function formatCritiqueStateTag(critique: LookCritique | undefined): string {
  if (!isLowCritique(critique)) return '';
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (critique.weakPiece) {
    const slot = clean(critique.weakPiece.slot);
    const reason = clean(critique.weakPiece.reason);
    const ask = clean(critique.weakPiece.ask);
    const detail = [reason, ask ? `try ${ask}` : ''].filter(Boolean).join('; ');
    return detail ? ` swap_hint=${slot} (${detail})` : ` swap_hint=${slot}`;
  }
  const firstIssue = critique.issues.map(clean).find(Boolean);
  if (firstIssue) {
    return ` swap_hint=(${firstIssue})`;
  }
  return ' swap_hint=consider swapping a piece';
}

/**
 * Renders a compact single-paragraph `CALL STATE: ...` summary for Gemini Live.
 */
export function summarize(state: CallState): string {
  const parts: string[] = [];

  if (state.shopperName) parts.push(`shopper=${state.shopperName}`);
  parts.push(`dept=${state.department ?? 'unset'}`);
  parts.push(`camera=${state.camera}`);

  if (state.occasion) parts.push(`occasion=${state.occasion}`);
  if (state.budget.given !== null) {
    parts.push(`budget=${formatMoney(state.budget.given)}`);
  } else if (state.budget.asked) {
    parts.push('budget=asked');
  }
  if (state.ownPiece) parts.push(`own_piece=${state.ownPiece}`);

  if (state.looks.length === 0) {
    parts.push('looks=none');
  } else {
    const lookStrs = state.looks.map((look) => {
      const tryOn = state.tryOn[look.number];
      const tryOnTag = tryOn ? ` tryon=${tryOn.status}` : '';
      const extras = state.tryOnExtras[look.number];
      const extraFlags: string[] = [];
      if (extras?.scene) extraFlags.push('scene ready');
      if (extras?.video) extraFlags.push('video ready');
      const extrasTag = extraFlags.length > 0 ? ` ${extraFlags.join(', ')}` : '';
      const revTag = state.revealsDone.includes(look.number) ? ' revealed' : '';
      const critTag = formatCritiqueStateTag(state.critiques[look.number]);
      return `#${look.number} ${look.name} (${formatMoney(look.total)}: ${look.slots.join(',')}${tryOnTag}${extrasTag}${revTag}${critTag})`;
    });
    parts.push(`looks=[${lookStrs.join('; ')}]`);
  }

  if (state.pickedLook !== null) {
    parts.push(`picked=Look ${state.pickedLook}`);
  }
  if (state.revealsDone.length > 0) {
    parts.push(`reveals=[${state.revealsDone.join(',')}]`);
  }

  const sizeEntries = Object.entries(state.sizes);
  if (sizeEntries.length > 0) {
    parts.push(`sizes={${sizeEntries.map(([k, v]) => `${k}:${v}`).join(', ')}}`);
  }

  if (state.bag) {
    const storeNames = state.bag.stores.map((s) => `${s.store}(${s.added.length})`).join(', ');
    const linkNote = state.bag.links.length > 0 ? `, links=${state.bag.links.length}` : '';
    const notAddedItems = state.bag.notAdded.map((na) => {
      const cleanTitle = na.title.replace(/\s+/g, ' ').trim();
      const cleanReason = na.reason.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
      return cleanReason ? `${cleanTitle} (${cleanReason})` : cleanTitle;
    });
    const notAddedNote =
      notAddedItems.length > 0 ? `, NOT_ADDED=[${notAddedItems.join('; ')}]` : '';
    parts.push(`bag=[${storeNames || 'empty'} total=${formatMoney(state.bag.total)}${linkNote}${notAddedNote}]`);
  }

  if (state.orderReview) {
    parts.push('order_review=ready');
  }

  if (state.secondOutfitOffered) {
    parts.push('second_outfit_offered=yes');
  }

  if (state.facts.length > 0) {
    parts.push(`notes=[${state.facts.join(' | ')}]`);
  }

  return `CALL STATE: ${parts.join('; ')}`;
}

export function stripCallStatePrefix(summary: string): string {
  return summary.replace(/^CALL STATE:\s*/i, '');
}

export interface CallStateAppContextLike {
  sendCallState(summary: string): void;
}

export interface CallStateStoreOptions {
  roomName: string;
  appContext?: CallStateAppContextLike;
  log?: StateLogFn;
  initial?: Partial<CallState>;
}

const MAX_SHOPPER_TURNS = 10;

export interface CallStateStore {
  get(): CallState;
  dispatch(action: CallStateAction): string[];
  summarize(): string;
  pushSummary(): string;
  recordShopperTurn(text: string, itemId?: string | null): void;
  getRecentShopperTurns(): readonly string[];
}

export function createCallStateStore(options: CallStateStoreOptions): CallStateStore {
  const logFn = options.log ?? calllog;
  let current = createInitialCallState(options.initial);
  const recentShopperTurns: Array<{ text: string; itemId?: string }> = [];

  function pushSummary(): string {
    const text = summarize(current);
    options.appContext?.sendCallState(stripCallStatePrefix(text));
    return text;
  }

  function dispatch(action: CallStateAction): string[] {
    const { state: next, changed } = reduceCallState(current, action);
    if (changed.length === 0) return [];
    current = next;
    logFn(options.roomName, 'call_state', { changed });
    if (changed.some((key) => key !== 'usedBitIds')) {
      pushSummary();
    }
    return changed;
  }

  function recordShopperTurn(text: string, itemId?: string | null): void {
    const clean = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    if (!clean) return;
    const cleanId = typeof itemId === 'string' && itemId.trim().length > 0 ? itemId.trim() : undefined;

    if (cleanId) {
      const existing = recentShopperTurns.find((entry) => entry.itemId === cleanId);
      if (existing) {
        if (clean.length > existing.text.length) {
          existing.text = clean;
        }
        return;
      }
    }

    const last = recentShopperTurns[recentShopperTurns.length - 1];
    if (last && last.text.toLowerCase() === clean.toLowerCase()) {
      if (cleanId && !last.itemId) {
        last.itemId = cleanId;
      }
      return;
    }

    recentShopperTurns.push({ text: clean, ...(cleanId ? { itemId: cleanId } : {}) });
    if (recentShopperTurns.length > MAX_SHOPPER_TURNS) {
      recentShopperTurns.splice(0, recentShopperTurns.length - MAX_SHOPPER_TURNS);
    }
  }

  function getRecentShopperTurns(): readonly string[] {
    return recentShopperTurns.map((entry) => entry.text);
  }

  return {
    get: () => current,
    dispatch,
    summarize: () => summarize(current),
    pushSummary,
    recordShopperTurn,
    getRecentShopperTurns,
  };
}
