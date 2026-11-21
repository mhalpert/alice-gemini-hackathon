// Ready-made outfit library: matches a shopper's occasion by embedding, verifies live
// price and stock in one batched lookup, swaps sold-out pieces when possible, and also
// supplies storefront looks.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Brief, BuildResult, Gender, Item, Outfit, Piece } from '../types.ts';
import { calllog } from '../calllog.ts';
import { lookup as defaultLookup } from '../store/index.ts';
import { swapLive as defaultSwap } from '../brain/swap.ts';
import { embed as defaultEmbed, cosine, occasionText } from './embed.ts';
import { DEMO_OCCASION_KEY } from './occasions.ts';

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
const DEFAULT_SETS_PATH = path.resolve(import.meta.dirname, 'sets.json');
const DROP_ON_MISSING_SLOTS = new Set(['shoes', 'bottom', 'dress']);
const OPTIONAL_SLOTS = new Set(['accessory', 'bag', 'jewelry', 'layer']);
const NOT_SWAPPED_RE = /nothing was swapped|\bkept\b|no .+ in stock/i;

const round2 = (n: number) => Math.round(n * 100) / 100;
const sumPieces = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));

let deps: LibraryDeps = {
  embed: defaultEmbed,
  lookup: defaultLookup,
  swap: defaultSwap,
};

let loadedPath: string | null = null;
let loadedSets: LibrarySet[] | null = null;
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
  queryEmbedCache.clear();
}

function libraryFilePath(): string {
  const override = process.env.ALICE_LIBRARY_FILE;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return DEFAULT_SETS_PATH;
}

function threshold(): number {
  const raw = process.env.ALICE_LIBRARY_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
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

export async function warmLibrary(): Promise<void> {
  await loadSets();
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
): Promise<{ match: LibraryMatch; set: LibrarySet } | null> {
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

  return {
    match: {
      key: bestSet.key,
      occasion: bestSet.occasion,
      similarity: bestSim,
    },
    set: bestSet,
  };
}

export async function matchLibrary(brief: Brief): Promise<LibraryMatch | null> {
  try {
    const found = await findMatch(brief, false);
    return found ? found.match : null;
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

    const { match, set } = found;
    const matchMs = elapsed();
    log(opts.room, 'library_match', {
      key: match.key,
      similarity: Math.round(match.similarity * 10000) / 10000,
      ms: matchMs,
    });

    const cloned = structuredClone(set.outfits);
    const stock = await deps.lookup(collectIds(cloned));
    const problems: string[] = [
      `library: matched ${match.key} (similarity ${match.similarity.toFixed(3)})`,
    ];

    const surviving: Outfit[] = [];

    for (const rawOutfit of cloned) {
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
      surviving.push(outfit);
    }

    let finalOutfits = surviving;
    if (brief.budget_usd < set.budget_usd * 0.85) {
      finalOutfits = finalOutfits.filter((o) => o.total <= brief.budget_usd);
    }

    const minOutfits = opts.anyMatch ? 1 : 2;
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

export async function libraryLooks(
  gender: Gender,
  opts: { limit?: number; occasion?: string } = {},
): Promise<Outfit[]> {
  try {
    const limit = opts.limit ?? 6;
    if (limit <= 0) return [];

    const allGenderSets = (await loadSets()).filter((s) => s.gender === gender);
    if (allGenderSets.length === 0) return [];

    const occasionQuery = opts.occasion?.trim();
    if (occasionQuery) {
      const match = await matchLibrary({ gender, occasion: occasionQuery, budget_usd: 1e9 });
      if (!match) return [];
      const matchedSet = allGenderSets.find((s) => s.key === match.key);
      if (!matchedSet) return [];

      const cloned = structuredClone(matchedSet.outfits);
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

    const clonedSets = allGenderSets.map((s) => ({
      key: s.key,
      outfits: structuredClone(s.outfits),
    }));

    const allOutfits = clonedSets.flatMap((s) => s.outfits);
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
      return { key: s.key, outfits: ok };
    });

    const demoSets = checkedBySet.filter((s) => s.key === DEMO_OCCASION_KEY);
    const otherSets = checkedBySet.filter((s) => s.key !== DEMO_OCCASION_KEY);

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
