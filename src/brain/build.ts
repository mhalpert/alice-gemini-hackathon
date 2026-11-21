// The live outfit builder: plan -> search every slot at once -> pick -> repair -> stream.
// Each idea is picked as soon as its own searches are back, so the first look reaches the
// page before the others are done. The pick here is a fast scoring heuristic; the Hydrogen
// pick and the Decisions gate slot in on top of it.
import type { Brief, BuildResult, Item, Outfit, Piece } from '../types.ts';
import { searchMixed, setCallRoom } from '../store/index.ts';
import { planOutfits, pieceCeiling, type PlanIdea, type PlanSlot, type Slot } from './plan.ts';
import { stylistPick, CANDIDATES_SHOWN, type SlotCandidates } from './pick.ts';
import { gateOutfit, prefetchThumbs, type GateResult } from './gate.ts';
import { critiqueOutfit, type Critique } from './critic.ts';
import { calllog } from '../calllog.ts';
import { breaksDressCode, fixNameColours, titleHas, typeIn, wrongSlot } from './words.ts';

const SHOWN = 3;
const CANDIDATES_PER_SLOT = 12;

export interface LiveBuildOptions { onOutfit?(outfit: Outfit, index: number): void; onCritique?(number: number, critique: Critique): void; room?: string }

function log(room: string | undefined, ev: string, data: Record<string, unknown>) {
  if (!room) return;
  try { calllog(room, ev, data); } catch { /* never break a build */ }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const total = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const NEVER = /\b(socks?|underwear|boxers?|briefs|thong|bra|bralette|lingerie|pajamas?|pyjamas?|robe|swim trunks|gift card|insoles?|shoe care|laces)\b/i;
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

// Ranks each slot's candidates by the heuristic score; the top few go to the stylist.
function rankSlots(idea: PlanIdea, cands: Candidates[], pool: Map<Slot, Item[]>, problems: string[]): Map<Slot, Item[]> {
  const ranked = new Map<Slot, Item[]>();
  for (const c of cands) {
    if (c.slot.own) continue;
    ranked.set(c.slot.slot, c.items
      .map((i) => ({ i, s: scoreItem(i, c.slot.query, c.slot.slot) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i));
  }
  // A required slot with nothing usable borrows from the other ideas' candidates.
  for (const need of ['shoes', idea.slots.some((s) => s.slot === 'dress') ? 'dress' : 'bottom'] as Slot[]) {
    if (idea.slots.some((s) => s.slot === need && s.own)) continue;
    if ((ranked.get(need)?.length ?? 0) > 0) continue;
    const borrowed = pool.get(need) ?? [];
    if (borrowed.length) { ranked.set(need, borrowed); problems.push(`${idea.name}: ${need} borrowed from another idea`); }
  }
  return ranked;
}

function heuristicPieces(idea: PlanIdea, ranked: Map<Slot, Item[]>, problems: string[]): Piece[] {
  const pieces: Piece[] = [];
  for (const [slot, list] of ranked) {
    if (list[0]) pieces.push({ slot, why: whyFor(list[0], slot), item: list[0] });
    else problems.push(`${idea.name}: nothing in stock for ${slot}`);
  }
  return pieces;
}

function wrongTypeOf(title: string): string {
  if (titleHas(title, ['oxford']) && titleHas(title, ['shirt', 'shirts', 'blouse', 'top', 'polo'])) {
    return typeIn(title, 'top')?.word ?? 'shirt';
  }
  return typeIn(title, '')?.word ?? 'wrong type';
}

// Drops any picked piece that fails wrongSlot and fills its slot from the ranked list.
export function repairWrongSlots(name: string, pieces: Piece[], ranked: Map<Slot, Item[]>, problems: string[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!wrongSlot(p.item.title, p.slot)) { out.push(p); continue; }
    const wrongType = wrongTypeOf(p.item.title);
    const list = ranked.get(p.slot as Slot) ?? [];
    const alt = list.find((i) => !wrongSlot(i.title, p.slot) && !out.some((x) => x.item.id === i.id))
      ?? list.find((i) => !wrongSlot(i.title, p.slot));
    if (alt) {
      out.push({ slot: p.slot, why: whyFor(alt, p.slot as Slot), item: alt });
      problems.push(`${name}: ${p.slot} pick was a ${wrongType}, replaced`);
    } else {
      problems.push(`${name}: ${p.slot} pick was a ${wrongType}, dropped`);
    }
  }
  return out;
}

// Budget repair: trade the priciest piece down within its slot; then drop optional slots.
function fitBudget(name: string, pieces: Piece[], ranked: Map<Slot, Item[]>, brief: Brief, taken: Set<string>, problems: string[]): Piece[] {
  const out = [...pieces];
  let guard = 12;
  while (total(out) > brief.budget_usd && guard-- > 0) {
    let changed = false;
    for (const p of [...out].sort((a, b) => b.item.price - a.item.price)) {
      const alt = (ranked.get(p.slot as Slot) ?? []).find((i) => i.price < p.item.price && !taken.has(i.id));
      if (!alt) continue;
      out[out.indexOf(p)] = { slot: p.slot, why: whyFor(alt, p.slot as Slot), item: alt };
      problems.push(`${name}: traded ${p.slot} down to fit the budget`);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  for (const optional of ['jewelry', 'bag', 'layer'] as Slot[]) {
    if (total(out) <= brief.budget_usd) break;
    const at = out.findIndex((p) => p.slot === optional);
    const accessories = out.filter((p) => ['accessory', 'bag', 'jewelry'].includes(p.slot)).length;
    if (at >= 0 && (optional === 'layer' || accessories > 1)) { out.splice(at, 1); problems.push(`${name}: dropped the ${optional} to fit the budget`); }
  }
  return out;
}

// No product in two looks: swap a taken piece for the next candidate in its slot.
function dedupe(name: string, pieces: Piece[], ranked: Map<Slot, Item[]>, taken: Set<string>, problems: string[]): Piece[] | null {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!taken.has(p.item.id)) { out.push(p); continue; }
    const alt = (ranked.get(p.slot as Slot) ?? []).find((i) => !taken.has(i.id) && !out.some((x) => x.item.id === i.id));
    if (alt) { out.push({ slot: p.slot, why: whyFor(alt, p.slot as Slot), item: alt }); problems.push(`${name}: ${p.slot} already in another look, used the next pick`); }
    else if (['shoes', 'bottom', 'dress'].includes(p.slot)) return null;
  }
  return out;
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

const SLOT_ORDER = ['dress', 'layer', 'top', 'bottom', 'shoes', 'accessory', 'bag', 'jewelry'];
const ordered = (pieces: Piece[]) => [...pieces].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface Candidate { outfit: Outfit; ranked: Map<Slot, Item[]>; gate: GateResult; picker: string }

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
    log(room, 'build_done', { mode: 'live', outfits: 0, problems, build_ms: ms() });
    return { outfits, source: 'live', timing: { first_outfit_ms: 0, total_ms: ms() }, problems };
  }
  problems.push(...plan.repairs.map((r) => `plan: ${r}`));
  log(room, 'build_plan', { model: plan.model, plan_ms: plan.ms, ideas: plan.ideas.map((i) => ({ name: i.name, slots: i.slots.map((s) => `${s.slot}: ${s.query}`) })) });

  const ceiling = pieceCeiling(brief.budget_usd);
  const taken = new Set<string>();         // products already in a look on screen
  const pool = new Map<Slot, Item[]>();     // every usable item seen per slot, for repairs

  const searches = new Map<string, Promise<Item[]>>();
  const searchSlot = (s: PlanSlot) => {
    if (s.own) return Promise.resolve([] as Item[]);
    const key = `${s.slot}\0${s.query}`;
    if (!searches.has(key)) {
      searches.set(key, searchMixed(s.query, brief.gender, { limit: CANDIDATES_PER_SLOT * 2, maxPrice: ceiling })
        .then((r) => r.items.filter((i) => usable(i, brief, ceiling) && !breaksDressCode(i, s.slot, brief) && !wrongSlot(i.title, s.slot)))
        .catch((err) => { problems.push(`search "${s.query}" failed: ${(err as Error).message}`); return [] as Item[]; }));
    }
    return searches.get(key)!.then((items) => {
      const have = pool.get(s.slot) ?? [];
      pool.set(s.slot, [...have, ...items.filter((i) => !have.some((x) => x.id === i.id))]);
      return items;
    });
  };

  const emit = (c: Candidate): boolean => {
    if (outfits.length >= SHOWN) return false;
    const name = c.outfit.name;
    let pieces = dedupe(name, c.outfit.pieces, c.ranked, taken, problems);
    if (!pieces || !complete(pieces)) { problems.push(`${name}: lost a required piece to another look`); return false; }
    pieces = fitBudget(name, pieces, c.ranked, brief, taken, problems);
    const outfit: Outfit = { ...c.outfit, number: outfits.length + 1, pieces: ordered(pieces), total: total(pieces) };
    for (const p of pieces) taken.add(p.item.id);
    outfits.push(outfit);
    if (outfits.length === 1) firstMs = ms();
    log(room, 'build_outfit', {
      number: outfit.number, name: outfit.name, total: outfit.total, picker: c.picker,
      gate: { fits: +c.gate.fits.toFixed(2), cohesion: +c.gate.cohesion.toFixed(2), pass: c.gate.pass, gate_ms: c.gate.ms, error: c.gate.error },
      slots: outfit.pieces.map((p) => `${p.slot}: ${p.item.title} $${p.item.price}`), build_ms: ms(),
    });
    try { opts.onOutfit?.(structuredClone(outfit), outfit.number - 1); } catch (err) { problems.push(`onOutfit threw: ${(err as Error).message}`); }
    if (process.env.ALICE_CRITIC !== 'off') {
      void critiqueOutfit(structuredClone(outfit), brief, { room }).then((c) => { try { opts.onCritique?.(outfit.number!, c); } catch {} });
    }
    return true;
  };

  // Each idea: search -> pick -> repair -> gate, independently. The first look that passes the
  // gate is shown at once; the best of the rest follow when all four are judged.
  const judged: Candidate[] = [];
  await Promise.all(plan.ideas.map(async (idea) => {
    const cands: Candidates[] = await Promise.all(idea.slots.map(async (slot) => ({ slot, items: await searchSlot(slot) })));
    const ranked = rankSlots(idea, cands, pool, problems);
    const slots: SlotCandidates[] = [...ranked].filter(([, items]) => items.length).map(([slot, items]) => ({
      slot, query: idea.slots.find((s) => s.slot === slot)?.query ?? slot, items: items.slice(0, CANDIDATES_SHOWN),
    }));

    prefetchThumbs(slots.flatMap((s) => s.items.map((i) => i.image)));
    let pieces: Piece[];
    let name = idea.name, difference = idea.difference, story = '';
    let picker = 'heuristic';
    try {
      const others = plan.ideas.filter((o) => o !== idea);
      const own = idea.slots.find((s) => s.own)?.query;
      const picked = await stylistPick(idea, slots, brief, others, own);
      ({ pieces, name, difference, story } = picked);
      picker = `${picked.model} ${picked.ms} ms`;
    } catch (err) {
      problems.push(`${idea.name}: ${(err as Error).message}; used the quick pick`);
      pieces = heuristicPieces(idea, ranked, problems);
    }
    pieces = repairWrongSlots(name, pieces, ranked, problems);
    pieces = fitBudget(name, pieces, ranked, brief, taken, problems);
    if (!complete(pieces)) { problems.push(`${name}: incomplete, skipped`); return; }
    const fixed = fixNameColours(name, pieces.map((p) => p.item.title));
    if (fixed !== name) { problems.push(`renamed "${name}" to "${fixed}": no piece has that colour`); name = fixed; }

    const outfit: Outfit = { name, difference, story: story || storyFor(idea, pieces), pieces: ordered(pieces), total: total(pieces) };
    const gate = await gateOutfit(outfit, brief);
    if (gate.error) problems.push(`${name}: gate unavailable (${gate.error})`);
    const c: Candidate = { outfit, ranked, gate, picker };
    log(room, 'build_gate', { name, fits: +gate.fits.toFixed(2), cohesion: +gate.cohesion.toFixed(2), pass: gate.pass, gate_ms: gate.ms, picker });
    if (outfits.length === 0 && gate.pass && outfit.total <= brief.budget_usd && emit(c)) return;
    judged.push(c);
  }));

  // Best of the rest: passing looks first, then by gate score; over-budget looks last.
  judged.sort((a, b) =>
    Number(b.outfit.total <= brief.budget_usd) - Number(a.outfit.total <= brief.budget_usd) ||
    Number(b.gate.pass) - Number(a.gate.pass) || b.gate.score - a.gate.score);
  for (const c of judged) {
    if (outfits.length >= SHOWN) { problems.push(`dropped "${c.outfit.name}" (gate ${c.gate.fits.toFixed(2)} / ${c.gate.cohesion.toFixed(1)})`); continue; }
    if (c.outfit.total > brief.budget_usd) problems.push(`${c.outfit.name}: $${c.outfit.total} over budget`);
    emit(c);
  }
  if (outfits.length < SHOWN) problems.push(`only ${outfits.length} complete outfits`);

  const result: BuildResult = { outfits, source: 'live', timing: { first_outfit_ms: firstMs, total_ms: ms() }, problems };
  log(room, 'build_done', { mode: 'live', outfits: outfits.length, timing: result.timing, problems });
  return result;
}
