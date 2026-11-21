// Ready-made outfit library: matches a shopper's occasion by embedding, verifies live
// price and stock in one batched lookup, swaps sold-out pieces when possible, and also
// supplies storefront looks.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Brief, BuildResult, Gender, Item, Outfit, Piece } from '../types.ts';
import { calllog } from '../calllog.ts';
import { lookup as defaultLookup } from '../store/index.ts';
import { swapLive as defaultSwap } from '../brain/swap.ts';
import { breaksDressCode, wrongSlot } from '../brain/words.ts';
import { embed as defaultEmbed, cosine, occasionText } from './embed.ts';
import { DEMO_OCCASION_KEY, OCCASIONS, type LibraryOccasion } from './occasions.ts';
import type { GradesFile, OutfitGrade, SetGrade } from './grade.ts';

export interface LibraryMatch {
  key: string;
  occasion: string;
  similarity: number;
}

export interface LibrarySet {
  key: string;
  gender: Gender;
  occasion: string;
  budget_usd: number;
  outfits: Outfit[];
  vectors: number[][];
  built_ms: number;
  improved_at?: string;
}

export interface LibraryFile {
  version: number;
  built_at: string;
  sets: LibrarySet[];
}

export interface LookupEntry {
  item: Item | null;
  available: boolean;
  price: number | null;
}

export interface SwapResult {
  outfit: Outfit;
  piece: Piece;
  note?: string;
}

export interface LibraryDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  lookup: (ids: string[]) => Promise<Map<string, LookupEntry>>;
  swap: (outfit: Outfit, slot: string, request: string, brief: Brief) => Promise<SwapResult>;
}

export interface ServeLibraryOptions {
  onOutfit?(o: Outfit, i: number): void;
  room?: string;
  anyMatch?: boolean;
}

const DEFAULT_THRESHOLD = 0.78;
const DEFAULT_MIN_SCORE = 6;
const DEFAULT_MAX_BUDGET_RATIO = 3;
const TIER_BUDGET_TOLERANCE = 1.2;
const SERVE_MAX_OUTFITS = 3;
const SERVE_MAX_SPARES = 2;
const DEFAULT_SETS_PATH = path.resolve(import.meta.dirname, 'sets.json');
const DROP_ON_MISSING_SLOTS = new Set(['shoes', 'bottom', 'dress']);
const OPTIONAL_SLOTS = new Set(['accessory', 'bag', 'jewelry', 'layer']);
const NOT_SWAPPED_RE = /nothing was swapped|\bkept\b|no .+ in stock/i;

export const PREMIUM_TIER_SUFFIX = '@premium';

export function baseKeyOf(key: string): string {
  const at = key.indexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

export function isTierKey(key: string): boolean {
  return baseKeyOf(key) !== key;
}

export function chooseTier(tiers: LibrarySet[], budgetUsd: number): LibrarySet | null {
  if (tiers.length === 0) return null;
  if (tiers.length === 1) return tiers[0];

  const cap = budgetUsd * TIER_BUDGET_TOLERANCE + 1e-9;
  const within = tiers.filter((s) => s.budget_usd <= cap);
  if (within.length > 0) {
    return within.reduce((best, cur) => {
      if (cur.budget_usd !== best.budget_usd) {
        return cur.budget_usd > best.budget_usd ? cur : best;
      }
      return !isTierKey(cur.key) && isTierKey(best.key) ? cur : best;
    });
  }

  return tiers.reduce((best, cur) => {
    if (cur.budget_usd !== best.budget_usd) {
      return cur.budget_usd < best.budget_usd ? cur : best;
    }
    return !isTierKey(cur.key) && isTierKey(best.key) ? cur : best;
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sumPieces = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));

let deps: LibraryDeps = {
  embed: defaultEmbed,
  lookup: defaultLookup,
  swap: defaultSwap,
};

let loadedPath: string | null = null;
let loadedSets: LibrarySet[] | null = null;
let loadedGradesPath: string | null = null;
let loadedGrades: Record<string, SetGrade> | null = null;
const queryEmbedCache = new Map<string, number[]>();

export function _setDeps(overrides: Partial<LibraryDeps> | null): void {
  if (!overrides) {
    deps = {
      embed: defaultEmbed,
      lookup: defaultLookup,
      swap: defaultSwap,
    };
  } else {
    deps = {
      embed: overrides.embed ?? deps.embed,
      lookup: overrides.lookup ?? deps.lookup,
      swap: overrides.swap ?? deps.swap,
    };
  }
  loadedPath = null;
  loadedSets = null;
  loadedGradesPath = null;
  loadedGrades = null;
  queryEmbedCache.clear();
}

function libraryFilePath(): string {
  const override = process.env.ALICE_LIBRARY_FILE;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return DEFAULT_SETS_PATH;
}

function gradesFilePath(): string {
  return path.join(path.dirname(libraryFilePath()), 'grades.json');
}

function threshold(): number {
  const raw = process.env.ALICE_LIBRARY_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
}

function minServeScore(): number {
  const raw = process.env.ALICE_LIBRARY_MIN_SCORE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_SCORE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MIN_SCORE;
}

function maxBudgetRatio(): number {
  const raw = process.env.ALICE_LIBRARY_MAX_BUDGET_RATIO;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BUDGET_RATIO;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BUDGET_RATIO;
}

function log(room: string | undefined, ev: string, data: Record<string, unknown>): void {
  if (!room) return;
  try {
    calllog(room, ev, data);
  } catch {
    /* logging must never break serving */
  }
}

async function loadSets(): Promise<LibrarySet[]> {
  const filePath = libraryFilePath();
  if (loadedSets !== null && loadedPath === filePath) {
    return loadedSets;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LibraryFile>;
    const sets = Array.isArray(parsed?.sets) ? parsed.sets : [];
    loadedPath = filePath;
    loadedSets = sets;
    return sets;
  } catch {
    loadedPath = filePath;
    loadedSets = [];
    return [];
  }
}

async function loadGrades(): Promise<Record<string, SetGrade>> {
  const filePath = gradesFilePath();
  if (loadedGrades !== null && loadedGradesPath === filePath) {
    return loadedGrades;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GradesFile>;
    const grades =
      parsed?.grades && typeof parsed.grades === 'object' && !Array.isArray(parsed.grades)
        ? parsed.grades
        : {};
    loadedGradesPath = filePath;
    loadedGrades = grades;
    return grades;
  } catch {
    loadedGradesPath = filePath;
    loadedGrades = {};
    return {};
  }
}

function sameOutfitNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((name, i) => name === sb[i]);
}

function hasMatchingGrade(set: LibrarySet, grade: SetGrade | undefined): grade is SetGrade {
  if (!grade || !Array.isArray(grade.outfits)) return false;
  return sameOutfitNames(
    set.outfits.map((o) => o.name),
    grade.outfits.map((o) => o.name),
  );
}

function outfitBreaksDressCode(outfit: Outfit, brief: { occasion: string; gender: string }): boolean {
  return outfit.pieces.some((piece) => breaksDressCode(piece.item, piece.slot, brief));
}

function outfitHasWrongSlot(outfit: Outfit): boolean {
  return outfit.pieces.some((piece) => wrongSlot(piece.item.title, piece.slot));
}

function outfitNotServable(outfit: Outfit, brief: { occasion: string; gender: string }): boolean {
  return outfitBreaksDressCode(outfit, brief) || outfitHasWrongSlot(outfit);
}

function selectOutfitsForSet(
  set: LibrarySet,
  grades: Record<string, SetGrade>,
  brief: { occasion: string; gender: string },
): { outfits: Outfit[]; graded: boolean; failedGrade: boolean } {
  const cloned = structuredClone(set.outfits);
  const grade = grades[`${set.key}|${set.gender}`];

  if (hasMatchingGrade(set, grade)) {
    const minScore = minServeScore();
    const byName = new Map<string, OutfitGrade[]>();
    for (const og of grade.outfits) {
      const list = byName.get(og.name) ?? [];
      list.push(og);
      byName.set(og.name, list);
    }

    const ranked: { outfit: Outfit; score: number; index: number }[] = [];
    for (let i = 0; i < cloned.length; i++) {
      const outfit = cloned[i];
      const og = byName.get(outfit.name)?.shift();
      if (!og || og.score < minScore) continue;
      if (outfitNotServable(outfit, brief)) continue;
      ranked.push({ outfit, score: og.score, index: i });
    }

    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const outfits = ranked.map((r) => r.outfit);
    return { outfits, graded: true, failedGrade: outfits.length < 2 };
  }

  const outfits = cloned.filter((o) => !outfitNotServable(o, brief));
  return { outfits, graded: false, failedGrade: false };
}

export async function warmLibrary(): Promise<void> {
  await Promise.all([loadSets(), loadGrades()]);
}

async function queryVector(gender: Gender, occasion: string): Promise<number[] | null> {
  const text = occasionText(gender, occasion);
  const cached = queryEmbedCache.get(text);
  if (cached) return cached;
  const vectors = await deps.embed([text]);
  const vec = vectors?.[0];
  if (!Array.isArray(vec) || vec.length === 0) return null;
  queryEmbedCache.set(text, vec);
  return vec;
}

async function findMatch(
  brief: Brief,
  anyMatch = false,
): Promise<{ match: LibraryMatch; set: LibrarySet; baseKey: string; tierCount: number } | null> {
  const sets = await loadSets();
  const candidates = sets.filter((s) => s.gender === brief.gender && Array.isArray(s.vectors) && s.vectors.length > 0);
  if (candidates.length === 0) return null;

  const vec = await queryVector(brief.gender, brief.occasion);
  if (!vec) return null;

  let bestSet: LibrarySet | null = null;
  let bestSim = -Infinity;

  for (const set of candidates) {
    let setMax = -Infinity;
    for (const v of set.vectors) {
      const sim = cosine(vec, v);
      if (sim > setMax) setMax = sim;
    }
    if (setMax > bestSim) {
      bestSim = setMax;
      bestSet = set;
    }
  }

  if (!bestSet) return null;
  if (!anyMatch && bestSim < threshold()) return null;

  const baseKey = baseKeyOf(bestSet.key);
  const tierCandidates = sets.filter(
    (s) => s.gender === brief.gender && baseKeyOf(s.key) === baseKey,
  );
  const chosen = chooseTier(tierCandidates, brief.budget_usd) ?? bestSet;

  return {
    match: {
      key: chosen.key,
      occasion: chosen.occasion,
      similarity: bestSim,
    },
    set: chosen,
    baseKey,
    tierCount: tierCandidates.length,
  };
}

export async function matchLibrary(brief: Brief): Promise<LibraryMatch | null> {
  try {
    const found = await findMatch(brief, false);
    if (!found) return null;
    const grades = await loadGrades();
    const selected = selectOutfitsForSet(found.set, grades, brief);
    if (selected.failedGrade || selected.outfits.length < 2) return null;
    return found.match;
  } catch {
    return null;
  }
}

function lookupEntryFor(stock: Map<string, LookupEntry>, item: Item): LookupEntry | undefined {
  return stock.get(item.variant_id) ?? stock.get(item.id);
}

function collectIds(outfits: Outfit[]): string[] {
  const ids = new Set<string>();
  for (const outfit of outfits) {
    for (const piece of outfit.pieces) {
      const id = piece.item.variant_id || piece.item.id;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function livePriceOf(entry: LookupEntry): number | null {
  const p = entry.price ?? entry.item?.price ?? null;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

export async function serveLibrary(
  brief: Brief,
  opts: ServeLibraryOptions = {},
): Promise<BuildResult | null> {
  if ((process.env.ALICE_LIBRARY ?? '').trim().toLowerCase() === 'off') {
    return null;
  }

  try {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    const found = await findMatch(brief, Boolean(opts.anyMatch));
    if (!found) return null;

    const { match, set, baseKey, tierCount } = found;
    if (tierCount > 1 || isTierKey(set.key)) {
      log(opts.room, 'library_tier', {
        base: baseKey,
        key: set.key,
        budget: brief.budget_usd,
        set_budget: set.budget_usd,
      });
    }

    const grades = await loadGrades();
    const selected = selectOutfitsForSet(set, grades, brief);
    const minOutfits = opts.anyMatch ? 1 : 2;
    if (selected.failedGrade || selected.outfits.length < minOutfits) {
      return null;
    }

    if (!opts.anyMatch && set.budget_usd > 0 && brief.budget_usd > set.budget_usd * maxBudgetRatio()) {
      log(opts.room, 'library_skip', {
        key: match.key,
        reason: 'budget',
        brief_budget: brief.budget_usd,
        set_budget: set.budget_usd,
      });
      return null;
    }

    const matchMs = elapsed();
    log(opts.room, 'library_match', {
      key: match.key,
      similarity: Math.round(match.similarity * 10000) / 10000,
      ms: matchMs,
    });

    const candidates = selected.outfits.slice(0, SERVE_MAX_OUTFITS + SERVE_MAX_SPARES);
    const stock = await deps.lookup(collectIds(candidates));
    const problems: string[] = [
      `library: matched ${match.key} (similarity ${match.similarity.toFixed(3)})`,
    ];

    const enforceBudget = brief.budget_usd < set.budget_usd * 0.85;
    const surviving: Outfit[] = [];

    for (const rawOutfit of candidates) {
      if (surviving.length >= SERVE_MAX_OUTFITS) break;
      let outfit = rawOutfit;
      const unavailable: Piece[] = [];

      // First pass: update prices for available pieces and record unavailable ones.
      for (const piece of outfit.pieces) {
        const entry = lookupEntryFor(stock, piece.item);
        if (entry?.available) {
          const livePrice = livePriceOf(entry);
          if (livePrice !== null && livePrice !== piece.item.price) {
            piece.item.price = livePrice;
          }
        } else {
          unavailable.push(piece);
        }
      }
      outfit.total = sumPieces(outfit.pieces);

      // Second pass: attempt live swap for unavailable pieces.
      let dropped = false;
      for (const piece of unavailable) {
        let swapped: SwapResult | null = null;
        try {
          swapped = await deps.swap(outfit, piece.slot, 'similar', brief);
        } catch (err) {
          swapped = {
            outfit,
            piece,
            note: `nothing was swapped (${(err as Error)?.message ?? 'swap failed'})`,
          };
        }

        const sameItem =
          swapped.piece?.item?.variant_id === piece.item.variant_id &&
          swapped.piece?.item?.id === piece.item.id;
        const notSwapped = Boolean(swapped.note && NOT_SWAPPED_RE.test(swapped.note)) || sameItem;

        if (notSwapped) {
          if (DROP_ON_MISSING_SLOTS.has(piece.slot)) {
            problems.push(`${outfit.name}: dropped (sold-out ${piece.slot}; ${swapped.note ?? 'nothing was swapped'})`);
            dropped = true;
            break;
          }
          if (OPTIONAL_SLOTS.has(piece.slot)) {
            outfit.pieces = outfit.pieces.filter((p) => p.slot !== piece.slot || p.item.variant_id !== piece.item.variant_id);
          }
          problems.push(`${outfit.name}: could not swap sold-out ${piece.slot}`);
        } else {
          outfit = swapped.outfit;
          problems.push(`${outfit.name}: swapped sold-out ${piece.slot} for ${swapped.piece.item.title}`);
        }
      }

      if (dropped) continue;
      outfit.total = sumPieces(outfit.pieces);
      if (enforceBudget && outfit.total > brief.budget_usd) continue;
      surviving.push(outfit);
    }

    const finalOutfits = surviving;

    if (finalOutfits.length < minOutfits) return null;

    let firstMs = 0;
    for (let i = 0; i < finalOutfits.length; i++) {
      const outfit = finalOutfits[i];
      outfit.number = i + 1;
      if (i === 0) firstMs = elapsed();
      try {
        opts.onOutfit?.(structuredClone(outfit), i);
      } catch (err) {
        problems.push(`onOutfit threw for look ${outfit.number}: ${(err as Error)?.message ?? err}`);
      }
    }

    const timing = { first_outfit_ms: firstMs, total_ms: elapsed() };
    const result: BuildResult = {
      outfits: finalOutfits,
      source: 'library',
      timing,
      problems,
    };

    log(opts.room, 'build_done', {
      source: 'library',
      key: match.key,
      similarity: Math.round(match.similarity * 10000) / 10000,
      outfits: finalOutfits.length,
      timing,
      problems,
      totals: finalOutfits.map((o) => o.total),
    });

    return result;
  } catch {
    return null;
  }
}

function pickSetForBase(
  genderSets: LibrarySet[],
  baseKey: string,
  budget?: number,
): LibrarySet | undefined {
  const tiers = genderSets.filter((s) => baseKeyOf(s.key) === baseKey);
  if (tiers.length === 0) return undefined;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
    return chooseTier(tiers, budget) ?? undefined;
  }
  return tiers.find((s) => s.key === baseKey) ?? chooseTier(tiers, 0) ?? tiers[0];
}

export async function libraryLooks(
  gender: Gender,
  opts: { limit?: number; occasion?: string; budget?: number } = {},
): Promise<Outfit[]> {
  try {
    const limit = opts.limit ?? 6;
    if (limit <= 0) return [];

    const allGenderSets = (await loadSets()).filter((s) => s.gender === gender);
    if (allGenderSets.length === 0) return [];

    const grades = await loadGrades();
    const hasBudget = typeof opts.budget === 'number' && Number.isFinite(opts.budget) && opts.budget > 0;
    const occasionQuery = opts.occasion?.trim();
    if (occasionQuery) {
      let matchedSet: LibrarySet | undefined;
      if (isTierKey(occasionQuery)) {
        matchedSet = allGenderSets.find((s) => s.key === occasionQuery);
      } else if (allGenderSets.some((s) => baseKeyOf(s.key) === occasionQuery)) {
        matchedSet = pickSetForBase(allGenderSets, occasionQuery, opts.budget);
      }
      let occasionBrief = { gender, occasion: matchedSet ? matchedSet.occasion : occasionQuery };
      if (!matchedSet) {
        const found = await findMatch(
          { gender, occasion: occasionQuery, budget_usd: hasBudget ? opts.budget! : 0 },
          false,
        );
        if (!found) return [];
        matchedSet = hasBudget
          ? found.set
          : pickSetForBase(allGenderSets, found.baseKey);
        if (!matchedSet) return [];
        occasionBrief = { gender, occasion: occasionQuery };
      }

      const selected = selectOutfitsForSet(matchedSet, grades, occasionBrief);
      if (selected.failedGrade || selected.outfits.length === 0) return [];

      const cloned = selected.outfits;
      const stock = await deps.lookup(collectIds(cloned));
      const ok: Outfit[] = [];
      for (const outfit of cloned) {
        let allAvailable = true;
        for (const piece of outfit.pieces) {
          const entry = lookupEntryFor(stock, piece.item);
          if (!entry?.available) {
            allAvailable = false;
            break;
          }
          const livePrice = livePriceOf(entry);
          if (livePrice !== null && livePrice !== piece.item.price) {
            piece.item.price = livePrice;
          }
        }
        if (allAvailable) {
          outfit.total = sumPieces(outfit.pieces);
          ok.push(outfit);
        }
      }
      const limited = ok.slice(0, limit);
      for (let i = 0; i < limited.length; i++) {
        limited[i].number = i + 1;
      }
      return limited;
    }

    const baseKeysSeen = new Set<string>();
    const dedupedGenderSets: LibrarySet[] = [];
    for (const s of allGenderSets) {
      const baseKey = baseKeyOf(s.key);
      if (baseKeysSeen.has(baseKey)) continue;
      baseKeysSeen.add(baseKey);
      const picked = pickSetForBase(allGenderSets, baseKey, opts.budget);
      if (picked) dedupedGenderSets.push(picked);
    }

    const clonedSets = dedupedGenderSets.map((s) => {
      const selected = selectOutfitsForSet(s, grades, { gender: s.gender, occasion: s.occasion });
      return {
        key: s.key,
        baseKey: baseKeyOf(s.key),
        outfits: selected.failedGrade ? [] : selected.outfits,
      };
    });

    const allOutfits = clonedSets.flatMap((s) => s.outfits);
    if (allOutfits.length === 0) return [];
    const stock = await deps.lookup(collectIds(allOutfits));

    const checkedBySet = clonedSets.map((s) => {
      const ok: Outfit[] = [];
      for (const outfit of s.outfits) {
        let allAvailable = true;
        for (const piece of outfit.pieces) {
          const entry = lookupEntryFor(stock, piece.item);
          if (!entry?.available) {
            allAvailable = false;
            break;
          }
          const livePrice = livePriceOf(entry);
          if (livePrice !== null && livePrice !== piece.item.price) {
            piece.item.price = livePrice;
          }
        }
        if (allAvailable) {
          outfit.total = sumPieces(outfit.pieces);
          ok.push(outfit);
        }
      }
      return { key: s.key, baseKey: s.baseKey, outfits: ok };
    });

    const demoSets = checkedBySet.filter((s) => s.baseKey === DEMO_OCCASION_KEY);
    const otherSets = checkedBySet.filter((s) => s.baseKey !== DEMO_OCCASION_KEY);

    const ordered: Outfit[] = [];
    for (const demo of demoSets) {
      for (const o of demo.outfits) {
        ordered.push(o);
      }
    }

    const maxOther = otherSets.reduce((m, s) => Math.max(m, s.outfits.length), 0);
    for (let i = 0; i < maxOther; i++) {
      for (const s of otherSets) {
        if (i < s.outfits.length) {
          ordered.push(s.outfits[i]);
        }
      }
    }

    const limited = ordered.slice(0, limit);
    for (let i = 0; i < limited.length; i++) {
      limited[i].number = i + 1;
    }
    return limited;
  } catch {
    return [];
  }
}

let cachedExtraOccasions: LibraryOccasion[] | null = null;

async function loadAllOccasions(): Promise<LibraryOccasion[]> {
  if (cachedExtraOccasions === null) {
    try {
      const mod = (await import('./occasions-extra.ts')) as { EXTRA_OCCASIONS?: unknown };
      cachedExtraOccasions = Array.isArray(mod?.EXTRA_OCCASIONS)
        ? (mod.EXTRA_OCCASIONS as LibraryOccasion[])
        : [];
    } catch {
      cachedExtraOccasions = [];
    }
  }

  const seen = new Set<string>();
  const combined: LibraryOccasion[] = [];
  for (const occ of [...OCCASIONS, ...cachedExtraOccasions]) {
    if (!occ?.key || seen.has(occ.key)) continue;
    seen.add(occ.key);
    combined.push(occ);
  }
  return combined;
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

export async function libraryOccasions(
  gender: Gender,
): Promise<{ key: string; occasion: string; label: string }[]> {
  try {
    const [sets, grades, occasions] = await Promise.all([
      loadSets(),
      loadGrades(),
      loadAllOccasions(),
    ]);

    const servableByKey = new Map<string, LibrarySet>();
    for (const set of sets) {
      if (set.gender !== gender) continue;
      const selected = selectOutfitsForSet(set, grades, {
        gender: set.gender,
        occasion: set.occasion,
      });
      if (selected.failedGrade || selected.outfits.length < 2) continue;
      const baseKey = baseKeyOf(set.key);
      const existing = servableByKey.get(baseKey);
      if (!existing || (isTierKey(existing.key) && !isTierKey(set.key))) {
        servableByKey.set(baseKey, set);
      }
    }

    const result: { key: string; occasion: string; label: string }[] = [];
    const emitted = new Set<string>();

    for (const occ of occasions) {
      const set = servableByKey.get(occ.key);
      if (!set) continue;
      emitted.add(occ.key);
      const firstWording = occ.wordings?.[0]?.trim();
      const label = firstWording ? capitalizeFirst(firstWording) : set.occasion;
      result.push({ key: occ.key, occasion: set.occasion, label });
    }

    for (const [baseKey, set] of servableByKey) {
      if (emitted.has(baseKey)) continue;
      result.push({ key: baseKey, occasion: set.occasion, label: set.occasion });
    }

    return result;
  } catch {
    return [];
  }
}
