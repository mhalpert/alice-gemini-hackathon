// The live outfit builder: plan -> search every slot at once -> pick -> repair -> stream.
// Each idea is picked as soon as its own searches are back, so the first look reaches the
// page before the others are done. The pick here is a fast scoring heuristic; the Hydrogen
// pick and the Decisions gate slot in on top of it.
import type { Brief, BuildResult, Item, Outfit, Piece } from '../types.ts';
import { searchMixed, setCallRoom } from '../store/index.ts';
import { planOutfits, pieceCeiling, type PlanIdea, type PlanSlot, type Slot } from './plan.ts';
import { calllog } from '../calllog.ts';

const SHOWN = 3;
const CANDIDATES_PER_SLOT = 12;

export interface LiveBuildOptions { onOutfit?(outfit: Outfit, index: number): void; room?: string }

function log(room: string | undefined, ev: string, data: Record<string, unknown>) {
  if (!room) return;
  try { calllog(room, ev, data); } catch { /* never break a build */ }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const total = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const NEVER = /\b(socks?|underwear|boxers?|briefs|thong|bra|bralette|lingerie|pajamas?|pyjamas?|robe|swim trunks|gift card|insoles?|shoe care|laces)\b/i;
const COLOURS = ['black', 'white', 'cream', 'ivory', 'navy', 'blue', 'grey', 'gray', 'charcoal', 'brown', 'tan', 'camel', 'beige', 'olive', 'green', 'burgundy', 'red', 'pink', 'blush', 'gold', 'silver', 'cognac', 'chocolate', 'khaki', 'sage', 'emerald', 'yellow', 'orange', 'purple', 'lavender', 'denim', 'taupe', 'stone', 'oatmeal'];
const MATERIALS = ['leather', 'suede', 'wool', 'linen', 'cotton', 'silk', 'satin', 'denim', 'knit', 'cashmere', 'corduroy', 'velvet', 'canvas', 'chiffon', 'patent'];

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];
const stem = (w: string) => w.replace(/(es|s)$/, '');

function queryParts(query: string) {
  const ws = words(query).filter((w) => !['men', 'women', 's'].includes(w));
  return {
    colours: ws.filter((w) => COLOURS.includes(w)),
    materials: ws.filter((w) => MATERIALS.includes(w)),
    type: stem(ws[ws.length - 1] ?? ''),       // "black leather chelsea boots" -> "boot"
    rest: ws.filter((w) => !COLOURS.includes(w) && !MATERIALS.includes(w)).map(stem),
  };
}

export function scoreItem(item: Item, query: string, slot: Slot): number {
  const title = words(`${item.title}`).map(stem);
  const text = `${item.title} ${item.description}`.toLowerCase();
  const q = queryParts(query);
  let score = 0;
  if (q.type && title.includes(q.type)) score += 4;
  score += q.rest.filter((w) => title.includes(w)).length;
  if (q.colours.length) score += q.colours.some((c) => text.includes(c)) ? 3 : -2;
  for (const m of q.materials) if (text.includes(m)) score += 1;
  if (q.materials.includes('leather') && /\bsuede\b/.test(item.title.toLowerCase())) score -= 2;
  if (item.rating && item.rating >= 4 && (item.rating_count ?? 0) >= 5) score += 0.5;
  // Better-made pieces where they show most.
  if (['shoes', 'bottom', 'layer', 'bag'].includes(slot) && ['Everlane', 'Steve Madden'].includes(item.store)) score += 0.75;
  return score;
}

interface Candidates { slot: PlanSlot; items: Item[] }

function usable(item: Item, brief: Brief, ceiling: number): boolean {
  return item.department === brief.gender && item.price > 0 && item.price <= ceiling && !NEVER.test(item.title);
}

// ---------------------------------------------------------------------------
// Pick one outfit from its candidates
// ---------------------------------------------------------------------------

function whyFor(item: Item, slot: Slot): string {
  const lead: Record<string, string> = {
    top: 'Sets the tone up top', bottom: 'A clean base that lets the rest talk', dress: 'Does the heavy lifting in one piece',
    layer: 'Adds structure and an extra texture', shoes: 'Grounds the look', accessory: 'The finishing detail',
    bag: 'Carries the colour story through', jewelry: 'One glint to finish it',
  };
  return `${lead[slot] ?? 'Rounds out the look'}: ${item.title.split(/\s[-|]\s/)[0]}.`;
}

function pickOutfit(idea: PlanIdea, cands: Candidates[], brief: Brief, used: Set<string>, extra: Map<Slot, Item[]>): { pieces: Piece[]; problems: string[] } {
  const problems: string[] = [];
  const pieces: Piece[] = [];
  const ranked = new Map<Slot, Item[]>();

  for (const c of cands) {
    if (c.slot.own) continue;
    const list = c.items
      .filter((i) => !used.has(i.id))
      .map((i) => ({ i, s: scoreItem(i, c.slot.query, c.slot.slot) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i);
    ranked.set(c.slot.slot, list);
  }

  // Repair: a required slot with nothing usable borrows from the other ideas' candidates.
  for (const need of ['shoes', idea.slots.some((s) => s.slot === 'dress') ? 'dress' : 'bottom'] as Slot[]) {
    if (idea.slots.some((s) => s.slot === need && s.own)) continue;
    if ((ranked.get(need)?.length ?? 0) > 0) continue;
    const borrowed = (extra.get(need) ?? []).filter((i) => !used.has(i.id));
    if (borrowed.length) { ranked.set(need, borrowed); problems.push(`${idea.name}: ${need} borrowed from another idea`); }
  }

  for (const s of idea.slots) {
    if (s.own) continue;
    const best = ranked.get(s.slot)?.[0];
    if (best) pieces.push({ slot: s.slot, why: whyFor(best, s.slot), item: best });
    else problems.push(`${idea.name}: nothing in stock for "${s.query}"`);
  }

  // Budget: while over, move the priciest piece to its cheapest acceptable alternative.
  let guard = 10;
  while (total(pieces) > brief.budget_usd && guard-- > 0) {
    const byPrice = [...pieces].sort((a, b) => b.item.price - a.item.price);
    let changed = false;
    for (const p of byPrice) {
      const cheaper = (ranked.get(p.slot as Slot) ?? []).filter((i) => i.price < p.item.price).slice(0, 3);
      if (!cheaper.length) continue;
      const alt = cheaper[0];
      pieces[pieces.indexOf(p)] = { slot: p.slot, why: whyFor(alt, p.slot as Slot), item: alt };
      changed = true;
      break;
    }
    if (!changed) break;
  }
  // Optional slots can go if the look is still over budget.
  for (const optional of ['jewelry', 'bag', 'layer'] as Slot[]) {
    if (total(pieces) <= brief.budget_usd) break;
    const at = pieces.findIndex((p) => p.slot === optional);
    const accessories = pieces.filter((p) => ['accessory', 'bag', 'jewelry'].includes(p.slot)).length;
    if (at >= 0 && (optional === 'layer' || accessories > 1)) { pieces.splice(at, 1); problems.push(`${idea.name}: dropped the ${optional} to fit the budget`); }
  }
  return { pieces, problems };
}

function complete(pieces: Piece[]): boolean {
  const slots = new Set(pieces.map((p) => p.slot));
  return slots.has('shoes') && (slots.has('dress') || (slots.has('top') && slots.has('bottom')) || (slots.has('bottom') && slots.has('layer')));
}

function storyFor(idea: PlanIdea, pieces: Piece[]): string {
  const name = (slot: string) => pieces.find((p) => p.slot === slot)?.item.title.split(/\s[-|]\s/)[0];
  const main = name('dress') ?? name('layer') ?? name('top');
  const shoes = name('shoes');
  return `${idea.difference} ${main ? `It starts with the ${main}` : 'It starts with the base'}${shoes ? ` and lands on the ${shoes}` : ''}.`.trim();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildLive(brief: Brief, opts: LiveBuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const room = opts.room;
  if (room) try { setCallRoom(room); } catch { /* optional */ }
  log(room, 'build_start', { brief, mode: 'live' });

  const problems: string[] = [];
  const outfits: Outfit[] = [];
  let firstMs = 0;

  let plan;
  try {
    plan = await planOutfits(brief);
  } catch (err) {
    problems.push(`plan failed: ${(err as Error).message}`);
    log(room, 'build_done', { mode: 'live', outfits: 0, problems, ms: ms() });
    return { outfits, source: 'live', timing: { first_outfit_ms: 0, total_ms: ms() }, problems };
  }
  problems.push(...plan.repairs.map((r) => `plan: ${r}`));
  log(room, 'build_plan', { model: plan.model, ms: plan.ms, ideas: plan.ideas.map((i) => ({ name: i.name, slots: i.slots.map((s) => `${s.slot}: ${s.query}`) })) });

  const ceiling = pieceCeiling(brief.budget_usd);
  const used = new Set<string>();
  const pool = new Map<Slot, Item[]>();     // every usable item seen per slot, for repairs

  // One search per distinct query; ideas share results when they ask for the same thing.
  const searches = new Map<string, Promise<Item[]>>();
  const searchSlot = (s: PlanSlot) => {
    if (s.own) return Promise.resolve([] as Item[]);
    if (!searches.has(s.query)) {
      searches.set(s.query, searchMixed(s.query, brief.gender, { limit: CANDIDATES_PER_SLOT * 2, maxPrice: ceiling })
        .then((r) => r.items.filter((i) => usable(i, brief, ceiling)))
        .catch((err) => { problems.push(`search "${s.query}" failed: ${(err as Error).message}`); return [] as Item[]; }));
    }
    return searches.get(s.query)!.then((items) => {
      pool.set(s.slot, [...(pool.get(s.slot) ?? []), ...items.filter((i) => !(pool.get(s.slot) ?? []).some((x) => x.id === i.id))]);
      return items;
    });
  };

  const emit = (outfit: Outfit) => {
    outfit.number = outfits.length + 1;
    outfits.push(outfit);
    if (outfits.length === 1) firstMs = ms();
    log(room, 'build_outfit', { number: outfit.number, name: outfit.name, total: outfit.total, slots: outfit.pieces.map((p) => `${p.slot}: ${p.item.title} $${p.item.price}`), ms: ms() });
    try { opts.onOutfit?.(structuredClone(outfit), outfit.number - 1); } catch (err) { problems.push(`onOutfit threw: ${(err as Error).message}`); }
  };

  // Every idea picks as soon as its own searches are back. JS runs each pick to completion,
  // so "used" stays consistent and no product appears in two looks.
  const spare: Outfit[] = [];
  await Promise.all(plan.ideas.map(async (idea) => {
    const cands: Candidates[] = await Promise.all(idea.slots.map(async (slot) => ({ slot, items: await searchSlot(slot) })));
    if (outfits.length >= SHOWN) return;
    const { pieces, problems: p } = pickOutfit(idea, cands, brief, used, pool);
    problems.push(...p);
    if (!complete(pieces)) { problems.push(`${idea.name}: incomplete, skipped`); return; }
    for (const piece of pieces) used.add(piece.item.id);
    const outfit: Outfit = { name: idea.name, difference: idea.difference, story: storyFor(idea, pieces), pieces, total: total(pieces) };
    if (outfit.total > brief.budget_usd) { problems.push(`${idea.name}: $${outfit.total} over budget`); spare.push(outfit); return; }
    emit(outfit);
  }));

  // If fewer than three fit the budget, show the closest over-budget ones rather than nothing.
  for (const o of spare.sort((a, b) => a.total - b.total)) if (outfits.length < SHOWN) emit(o);
  if (outfits.length < SHOWN) problems.push(`only ${outfits.length} complete outfits`);

  const result: BuildResult = { outfits, source: 'live', timing: { first_outfit_ms: firstMs, total_ms: ms() }, problems };
  log(room, 'build_done', { mode: 'live', outfits: outfits.length, timing: result.timing, problems });
  return result;
}
