// Outfits track: the public entry points other tracks import.
// buildOutfits serves the mock (the three looks in public/fixture.json with believable timing)
// unless ALICE_BRAIN=live, which runs the real builder in build.ts and the real swap in swap.ts.
// Signatures stay fixed either way.
//
// Pace is set by ALICE_MOCK_PACE:
//   library (default)  first look after ~0.45 s, all three by ~0.6 s (a ready-made match)
//   live               first look after ~15 s, all three by ~21 s (a custom live build)
//   0                  no delays (tests)
import { readFileSync } from 'node:fs';
import type { Brief, BuildResult, Outfit, Piece } from '../types.ts';
import type { Critique } from './critic.ts';
import { calllog } from '../calllog.ts';
import { wantedColour, titleHas } from './words.ts';

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

// Writes to the shared per-call log when the caller passes its room; never throws.
function log(room: string | undefined, ev: string, data: Record<string, unknown>) {
  if (!room) return;
  try { calllog(room, ev, data); } catch { /* logging must never break a build */ }
}

export interface BuildOptions { onOutfit?(outfit: Outfit, index: number): void; onCritique?(number: number, critique: Critique): void; room?: string }

// ALICE_BRAIN=live runs the real builder (plan + store search + pick); anything else serves the mock.
export async function buildOutfits(brief: Brief, opts: BuildOptions = {}): Promise<BuildResult> {
  if ((process.env.ALICE_BRAIN ?? '').toLowerCase() === 'live') {
    const { buildLive } = await import('./build.ts');
    return buildLive(brief, opts);
  }
  return buildMock(brief, opts);
}

async function buildMock(brief: Brief, opts: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const schedule = SCHEDULE[pace()];
  log(opts.room, 'build_start', { brief, mock: true, pace: pace() });
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
    log(opts.room, 'build_outfit', { index, number: outfit.number, name: outfit.name, total: outfit.total, build_ms: Math.round(performance.now() - started) });
    try {
      opts.onOutfit?.(clone(outfit), index);
    } catch (err) {
      problems.push(`onOutfit threw for look ${outfit.number}: ${(err as Error)?.message ?? err}`);
    }
  }

  const result: BuildResult = {
    outfits,
    source: 'library',
    timing: { first_outfit_ms: firstMs, total_ms: Math.round(performance.now() - started) },
    problems,
  };
  log(opts.room, 'build_done', { source: result.source, timing: result.timing, problems, totals: outfits.map((o) => o.total) });
  return result;
}

export interface SwapResult { outfit: Outfit; piece: Piece; note?: string }
export interface SwapOptions { room?: string }

export async function swapPiece(outfit: Outfit, slot: string, request: string, brief: Brief, opts: SwapOptions = {}): Promise<SwapResult> {
  const started = performance.now();
  const live = (process.env.ALICE_BRAIN ?? '').toLowerCase() === 'live';
  log(opts.room, 'swap_start', { outfit: outfit?.number, slot, request, mock: !live });
  let result: SwapResult;
  let extra: Record<string, unknown> = {};
  if (live) {
    try {
      const { swapLive } = await import('./swap.ts');
      const out = await swapLive(outfit, slot, request, brief);
      extra = { query: out.query, tried: out.tried, price: out.piece?.item?.price, store: out.piece?.item?.store };
      result = { outfit: out.outfit, piece: out.piece, ...(out.note ? { note: out.note } : {}) };
    } catch (err) {
      // Never throw to the agent: keep the look as it was and say so.
      const look = clone(outfit);
      const kept = look.pieces.find((p) => p.slot === slot) ?? look.pieces[0];
      result = { outfit: look, piece: kept, note: `Couldn't reach the stores for a new ${slot}; kept the current one.` };
      extra = { error: (err as Error)?.message ?? String(err) };
    }
  } else {
    result = await swapInner(outfit, slot, request, brief);
  }
  log(opts.room, 'swap_done', {
    outfit: result.outfit.number, slot, request, piece: result.piece?.item?.title,
    total: result.outfit.total, note: result.note, swap_ms: Math.round(performance.now() - started), ...extra,
  });
  return result;
}

async function swapInner(outfit: Outfit, slot: string, request: string, brief: Brief): Promise<SwapResult> {
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
