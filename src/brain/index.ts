// Outfits track: the public entry points other tracks import.
// For now this is a MOCK that serves the three looks in public/fixture.json with
// believable timing, so the agent and the page can be built before the real stylist lands.
// The real buildOutfits / swapPiece will keep these exact signatures.
//
// Pace is set by ALICE_MOCK_PACE:
//   library (default)  first look after ~0.45 s, all three by ~0.6 s (a ready-made match)
//   live               first look after ~15 s, all three by ~21 s (a custom live build)
//   0                  no delays (tests)
import { readFileSync } from 'node:fs';
import type { Brief, BuildResult, Outfit, Piece } from '../types.ts';

type Pace = 'library' | 'live' | '0';

interface Fixture { brief: Brief; outfits: Outfit[] }

const FIXTURE_URL = new URL('../../public/fixture.json', import.meta.url);
let fixtureCache: Fixture | null = null;

function fixture(): Fixture {
  if (!fixtureCache) fixtureCache = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as Fixture;
  return fixtureCache;
}

function pace(): Pace {
  const p = (process.env.ALICE_MOCK_PACE ?? 'library').trim().toLowerCase();
  return p === 'live' || p === '0' ? p : 'library';
}

// Milliseconds after the start at which each of the three looks is ready.
const SCHEDULE: Record<Pace, number[]> = {
  library: [450, 520, 600],
  live: [15000, 18000, 21000],
  '0': [0, 0, 0],
};
const SWAP_MS: Record<Pace, number> = { library: 1500, live: 1500, '0': 0 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clone = <T>(x: T): T => structuredClone(x);
const sum = (pieces: Piece[]) => Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;

export interface BuildOptions { onOutfit?(outfit: Outfit, index: number): void }

export async function buildOutfits(brief: Brief, opts: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const schedule = SCHEDULE[pace()];
  const problems: string[] = ['mock: these are the fixture looks, not a build for this brief'];
  if (brief?.gender && brief.gender !== fixture().brief.gender) {
    problems.push(`mock: the fixture only has ${fixture().brief.gender}'s looks`);
  }

  const outfits: Outfit[] = [];
  let firstMs = 0;
  for (const [index, look] of fixture().outfits.entries()) {
    const wait = schedule[index] - (performance.now() - started);
    if (wait > 0) await sleep(wait);
    const outfit = clone(look);
    outfit.number = index + 1;
    if (brief?.budget_usd && outfit.total > brief.budget_usd) {
      problems.push(`look ${outfit.number} is $${outfit.total}, over the $${brief.budget_usd} budget`);
    }
    outfits.push(outfit);
    if (index === 0) firstMs = Math.round(performance.now() - started);
    try {
      opts.onOutfit?.(clone(outfit), index);
    } catch (err) {
      problems.push(`onOutfit threw for look ${outfit.number}: ${(err as Error)?.message ?? err}`);
    }
  }

  return {
    outfits,
    source: 'library',
    timing: { first_outfit_ms: firstMs, total_ms: Math.round(performance.now() - started) },
    problems,
  };
}

// Colour words a shopper might say, with the title words that count as a match.
const COLOURS: Record<string, string[]> = {
  black: ['black', 'onyx', 'jet', 'charcoal'],
  white: ['white', 'ivory', 'cream', 'bone', 'off-white', 'ecru'],
  brown: ['brown', 'tan', 'cognac', 'chocolate', 'camel', 'taupe', 'mocha', 'espresso', 'chestnut', 'coffee'],
  navy: ['navy', 'midnight'],
  blue: ['blue', 'navy', 'denim', 'indigo', 'cobalt'],
  grey: ['grey', 'gray', 'charcoal', 'heather', 'slate'],
  gray: ['grey', 'gray', 'charcoal', 'heather', 'slate'],
  green: ['green', 'olive', 'sage', 'khaki', 'forest'],
  red: ['red', 'burgundy', 'wine', 'maroon', 'crimson'],
  beige: ['beige', 'sand', 'khaki', 'stone', 'oatmeal', 'cream'],
  silver: ['silver', 'chrome', 'steel'],
  gold: ['gold', 'brass'],
  pink: ['pink', 'blush', 'rose'],
};

function wantedColour(request: string): { word: string; matches: string[] } | null {
  const words = request.toLowerCase().match(/[a-z-]+/g) ?? [];
  // "swap the black boots for brown boots": the colour asked for is the last one named.
  for (let i = words.length - 1; i >= 0; i--) {
    if (COLOURS[words[i]]) return { word: words[i], matches: COLOURS[words[i]] };
  }
  return null;
}

const titleHas = (title: string, words: string[]) => {
  const t = title.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(t));
};

export interface SwapResult { outfit: Outfit; piece: Piece; note?: string }

export async function swapPiece(outfit: Outfit, slot: string, request: string, brief: Brief): Promise<SwapResult> {
  await sleep(SWAP_MS[pace()]);
  const look = clone(outfit);
  const at = look.pieces.findIndex((p) => p.slot === slot);
  if (at < 0) {
    const fallback = look.pieces[0];
    return { outfit: look, piece: fallback, note: `This look has no ${slot}; nothing was swapped.` };
  }
  const current = look.pieces[at];
  const req = (request ?? '').toLowerCase();

  // Candidates: the same slot from the other fixture looks, never the piece already in it.
  let candidates = fixture().outfits
    .flatMap((o) => o.pieces)
    .filter((p) => p.slot === slot && p.item.id !== current.item.id);

  const colour = wantedColour(req);
  if (colour) candidates = candidates.filter((p) => titleHas(p.item.title, colour.matches));
  const cheaper = /\b(cheap|cheaper|less|budget|affordable|lower)\b/.test(req);
  if (cheaper) {
    candidates = candidates.filter((p) => p.item.price < current.item.price).sort((a, b) => a.item.price - b.item.price);
  }

  if (candidates.length === 0) {
    const why = colour ? `in ${colour.word}` : cheaper ? 'for less' : 'to swap in';
    return { outfit: look, piece: clone(current), note: `No ${slot} ${why} in stock right now; kept the ${current.item.title}.` };
  }

  const piece = clone(candidates[0]);
  look.pieces[at] = piece;
  look.total = sum(look.pieces);
  const notes: string[] = [];
  if (brief?.budget_usd && look.total > brief.budget_usd) {
    notes.push(`The look is now $${look.total}, over the $${brief.budget_usd} budget.`);
  }
  return { outfit: look, piece, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
