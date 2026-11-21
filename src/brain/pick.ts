// Step 3 of the stylist brain: a stylist model picks exactly one real product per slot for one
// outfit idea, from a short list of candidates referenced as s<slot>i<item>. It also writes the
// look's name, one-line difference, pairing story and a reason per piece.
import type { Brief, Item, Piece } from '../types.ts';
import { generateJson, MODELS } from './gemini.ts';
import { DRESS_CODE, pieceCeiling, type PlanIdea, type Slot } from './plan.ts';

export const CANDIDATES_SHOWN = 6;

export interface SlotCandidates { slot: Slot; query: string; items: Item[] }
export interface Picked { name: string; difference: string; story: string; pieces: Piece[]; model: string; ms: number }

const SYSTEM = `You are Alice, a top personal stylist, finishing one outfit for a real client from real products in stock right now.

You get the outfit idea, the client's brief and, for each slot, a short list of candidate products. Each candidate has a ref like s2i3 (slot 2, item 3), a price, a store, a rating and part of the store's description.

PICKING
- Pick exactly one product for every slot that has candidates. Never skip shoes. Never skip the bottom unless the outfit has a dress or jumpsuit. If the best fit for a slot is weak, still pick the closest real option.
- Read the descriptions: they reveal what titles hide (sheer, backless, lace, open toe, patent, cropped, slip-on, "bride"). Reject anything that breaks the dress code.
- A suit jacket needs the suit trousers in the same colour and fabric.
- The accessory must show in a head-to-toe photo: tie, belt, watch, bag, jewelry, sunglasses or a hat.
- Stay within the outfit budget (add the prices up). Use the budget: aim for 70-100% of it. A look at a third of the budget is underselling the client. When it fits, prefer better-made pieces for shoes, trousers and the layer (Everlane basics, Steve Madden leather).
- Everything works together at the occasion's level of dressiness, in one colour story, for the season. Keep this look distinct from the other looks listed.

WRITING
- Name every piece by its real type and colour from its title: lace-up boots are not "Chelsea boots", a camo top is not "neon".
- name: 2-3 evocative words that still describe the final pieces (if the idea's colour changed, rename it).
- difference: one sentence, for the client, on how this look differs from the others.
- story: 2-3 sentences on how the pieces pair, with one specific detail, for the occasion.
- why: one short sentence per piece on its job in the look.

${DRESS_CODE}`;

function describe(item: Item): string {
  const desc = (item.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const rating = item.rating ? ` · ${item.rating}★${item.rating_count ? ` (${item.rating_count})` : ''}` : '';
  return `${item.title} · $${item.price} · ${item.store}${rating}${desc ? ` · ${desc}` : ''}`;
}

function userPrompt(idea: PlanIdea, slots: SlotCandidates[], brief: Brief, others: PlanIdea[], ownPiece?: string): string {
  const lines = [
    `Client: ${brief.gender === 'women' ? "women's" : "men's"} · occasion: ${brief.occasion} · outfit budget $${brief.budget_usd} (no piece over $${pieceCeiling(brief.budget_usd)})`,
  ];
  if (brief.weather) lines.push(`Forecast: ${brief.weather}`);
  if (brief.notes) lines.push(`Client's notes: ${brief.notes}`);
  if (ownPiece) lines.push(`The client's own piece is part of this outfit (no pick needed): ${ownPiece}`);
  lines.push(`This idea: ${idea.name}: ${idea.difference}`);
  if (others.length) lines.push(`Other looks being shown: ${others.map((o) => `${o.name} (${o.difference})`).join('; ')}`);
  lines.push('', 'CANDIDATES');
  slots.forEach((s, si) => {
    lines.push(`Slot ${si + 1}: ${s.slot} (searched "${s.query}")`);
    s.items.slice(0, CANDIDATES_SHOWN).forEach((item, ii) => lines.push(`  s${si + 1}i${ii + 1}: ${describe(item)}`));
  });
  return lines.join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    difference: { type: 'string' },
    story: { type: 'string' },
    picks: {
      type: 'array',
      items: { type: 'object', properties: { ref: { type: 'string' }, why: { type: 'string' } }, required: ['ref', 'why'] },
    },
  },
  required: ['name', 'difference', 'story', 'picks'],
};

// Turns the model's refs back into pieces; drops bad refs and second picks for a slot.
function resolve(raw: any, slots: SlotCandidates[]): { pieces: Piece[]; bad: string[] } {
  const pieces: Piece[] = [];
  const bad: string[] = [];
  for (const p of Array.isArray(raw?.picks) ? raw.picks : []) {
    const m = /^s(\d+)i(\d+)$/i.exec(String(p?.ref ?? '').trim());
    const slot = m ? slots[Number(m[1]) - 1] : undefined;
    const item = slot?.items.slice(0, CANDIDATES_SHOWN)[Number(m?.[2]) - 1];
    if (!slot || !item) { bad.push(`unknown ref ${p?.ref}`); continue; }
    if (pieces.some((x) => x.slot === slot.slot)) { bad.push(`second pick for ${slot.slot}`); continue; }
    pieces.push({ slot: slot.slot, why: String(p?.why ?? '').trim() || 'Rounds out the look.', item });
  }
  return { pieces, bad };
}

async function pickWith(model: string, idea: PlanIdea, slots: SlotCandidates[], brief: Brief, others: PlanIdea[], ownPiece: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Picked> {
  const thinking = ((model === MODELS.stylist() ? process.env.ALICE_PICK_THINKING : undefined) || 'low').toLowerCase() as 'low';
  const reply = await generateJson<any>({
    job: 'brain_pick',
    model, system: SYSTEM, user: userPrompt(idea, slots, brief, others, ownPiece), schema: SCHEMA,
    temperature: 0.7, thinkingLevel: thinking, timeoutMs, signal,
  });
  const { pieces } = resolve(reply.data, slots);
  const missing = slots.filter((s) => s.items.length && !pieces.some((p) => p.slot === s.slot)).map((s) => s.slot);
  // A pick that skips a required slot is not usable; the caller falls back.
  if (missing.includes('shoes') || (missing.includes('bottom') && !pieces.some((p) => p.slot === 'dress'))) {
    throw new Error(`${model} skipped ${missing.join(', ')}`);
  }
  return {
    name: String(reply.data?.name ?? '').trim() || idea.name,
    difference: String(reply.data?.difference ?? '').trim() || idea.difference,
    story: String(reply.data?.story ?? '').trim(),
    pieces, model, ms: reply.ms,
  };
}

// Stylist first; the fast model joins at the hedge time (or at once if the stylist fails),
// and the first usable pick wins. Rejects if both fail, so the caller can use its heuristic.
export async function stylistPick(idea: PlanIdea, slots: SlotCandidates[], brief: Brief, others: PlanIdea[], ownPiece?: string): Promise<Picked> {
  const started = performance.now();
  const hedgeMs = Number(process.env.ALICE_PICK_HEDGE_MS ?? 9000);
  const stop = new AbortController();
  const errors: string[] = [];
  const run = (model: string, timeoutMs: number) =>
    pickWith(model, idea, slots, brief, others, ownPiece, timeoutMs, stop.signal).catch((e) => { errors.push(String(e?.message ?? e)); throw e; });
  try {
    const stylist = run(MODELS.stylist(), 20000);
    const fast = new Promise<Picked>((resolve, reject) => {
      let go = false;
      const start = () => { if (go) return; go = true; run(MODELS.fast(), 8000).then(resolve, reject); };
      const timer = setTimeout(start, hedgeMs);
      stylist.then(() => clearTimeout(timer), () => { clearTimeout(timer); start(); });
    });
    const picked = await Promise.any([stylist, fast]);
    return { ...picked, ms: Math.round(performance.now() - started) };
  } catch {
    throw new Error(`pick failed: ${errors.join(' | ')}`);
  } finally {
    stop.abort();
  }
}
