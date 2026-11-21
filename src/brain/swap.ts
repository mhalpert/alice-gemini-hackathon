// The live swap: one piece of a look replaced by the nearest real piece in the same slot.
// "brown boots" must come back brown (title colour words, with synonyms); "cheaper" must lower
// the total; "same shirt in white" keeps the type. If nothing fits, the piece stays and the note
// says so plainly, so Alice never pitches something that is not in the look.
import type { Brief, Gender, Item, Outfit, Piece, SearchResult } from '../types.ts';
import { scoreItem, NEVER } from './build.ts';
import { breaksDressCode, wrongSlot } from './words.ts';
import { pieceCeiling, type Slot } from './plan.ts';
import { generateJson, MODELS } from './gemini.ts';
import { COLOUR_WORDS, TYPES, wantedColour, titleHas, colourOf, typeIn, SLOT_NOUN, type TypeMatch } from './words.ts';

// Slots where a title must name one of the slot's own product types (shoes stay shoes).
const STRICT_SLOTS = new Set(['shoes', 'bottom', 'dress', 'bag', 'layer']);
const inSlot = (title: string, slot: string) =>
  !STRICT_SLOTS.has(slot) || titleHas(title, (TYPES[slot] ?? []).flatMap(([, m]) => m));

type Search = (query: string, gender: Gender, opts: { limit?: number; maxPrice?: number }) => Promise<SearchResult>;

export interface LiveSwapOptions {
  search?: Search;               // tests pass a fake store
  rewrite?: boolean;             // name / story refresh with the fast model (default on)
}

export interface SwapOut { outfit: Outfit; piece: Piece; note?: string; query?: string; tried?: string[] }

const round2 = (n: number) => Math.round(n * 100) / 100;
const total = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));
const short = (title: string) => title.split(/\s[-|]\s/)[0].trim();
const CHEAPER = /\b(cheap|cheaper|less|budget|affordable|lower|save|inexpensive)\b/i;

export interface SwapAsk {
  colour: { word: string; matches: string[] } | null;
  type: TypeMatch | null;        // the type to look for
  typeAsked: boolean;            // the shopper named the type (enforced), or it was kept from the piece (preferred)
  cheaper: boolean;
}

// Reads the request against the piece being replaced.
export function readRequest(request: string, current: Item, slot: string): SwapAsk {
  const req = request ?? '';
  const colour = wantedColour(req);
  // "swap the black boots for brown boots": the type after "for"/"to"/"with" is the one wanted.
  const tail = req.split(/\b(?:for|to|with|into)\b/i).pop() ?? req;
  const asked = typeIn(tail, slot, true) ?? typeIn(req, slot, true);
  const generic = asked && asked.word === SLOT_NOUN[slot] && slot !== 'dress' && slot !== 'bag';
  const kept = typeIn(current.title, slot);
  // "different shoes" names only the slot: any type will do, but the current one is preferred.
  const typeAsked = !!asked && !generic;
  return { colour, type: typeAsked ? asked : kept, typeAsked, cheaper: CHEAPER.test(req) };
}

function department(g: Gender) { return g === 'women' ? "women's" : "men's"; }

async function defaultSearch(): Promise<Search> {
  const { searchMixed } = await import('../store/index.ts');
  return searchMixed as Search;
}

export async function swapLive(outfit: Outfit, slot: string, request: string, brief: Brief, opts: LiveSwapOptions = {}): Promise<SwapOut> {
  const look = structuredClone(outfit);
  const at = look.pieces.findIndex((p) => p.slot === slot);
  if (at < 0) {
    return { outfit: look, piece: look.pieces[0], note: `This look has no ${slot}; nothing was swapped.` };
  }
  const current = look.pieces[at];
  const ask = readRequest(request, current.item, slot);
  const search = opts.search ?? await defaultSearch();

  const othersTotal = round2(look.total - current.item.price);
  const headroom = round2(brief.budget_usd - othersTotal);
  const maxPrice = ask.cheaper
    ? round2(current.item.price - 0.01)
    : Math.max(headroom, current.item.price, pieceCeiling(brief.budget_usd));
  if (maxPrice <= 0) {
    return { outfit: look, piece: current, note: `The ${short(current.item.title)} is already the cheapest option; kept it.` };
  }

  const inLook = new Set(look.pieces.map((p) => p.item.id));
  const keepColour = !ask.colour && ask.cheaper ? colourOf(current.item.title) : null;
  const dept = department(brief.gender);
  const typeWord = ask.type?.word ?? SLOT_NOUN[slot] ?? slot;
  const queries = [...new Set([
    [dept, ask.colour?.word ?? keepColour, typeWord].filter(Boolean).join(' '),
    // Colour first, type second: if the exact type is not in stock, the colour still holds.
    ...(ask.colour && !ask.typeAsked ? [[dept, ask.colour.word, SLOT_NOUN[slot] ?? slot].join(' ')] : []),
    ...(keepColour ? [[dept, typeWord].join(' ')] : []),
  ])];

  const fits = (i: Item) =>
    i.department === brief.gender && i.price > 0 && i.price <= maxPrice && !inLook.has(i.id) && !NEVER.test(i.title) &&
    (!ask.colour || titleHas(i.title, ask.colour.matches)) &&
    (!ask.typeAsked || !ask.type || titleHas(i.title, ask.type.matches)) &&
    (!ask.cheaper || i.price < current.item.price) &&
    inSlot(i.title, slot) &&
    !wrongSlot(i.title, slot) &&
    !breaksDressCode(i, slot, brief);

  const tried: string[] = [];
  let pick: Item | null = null;
  let query = queries[0];
  for (const q of queries) {
    tried.push(q);
    let items: Item[] = [];
    try { items = (await search(q, brief.gender, { limit: 24, maxPrice })).items ?? []; } catch { items = []; }
    const ok = items.filter(fits);
    if (!ok.length) continue;
    const rank = (i: Item) =>
      scoreItem(i, q, slot as Slot) +
      (ask.type && titleHas(i.title, ask.type.matches) ? 2 : 0) +
      (i.price + othersTotal <= brief.budget_usd ? 1.5 : 0) +
      (keepColour && titleHas(i.title, [keepColour, ...(COLOUR_WORDS[keepColour] ?? [])]) ? 4 : 0);
    pick = ok.map((i) => ({ i, s: rank(i) })).sort((a, b) => b.s - a.s)[0].i;
    query = q;
    break;
  }

  if (!pick) {
    const want = [ask.colour?.word, ask.typeAsked ? ask.type?.word : null].filter(Boolean).join(' ') || `different ${slot}`;
    const why = ask.cheaper ? `${want === `different ${slot}` ? slot : want} for less than $${current.item.price}` : want;
    return { outfit: look, piece: current, note: `No ${why} in stock right now; kept the ${short(current.item.title)}.`, query, tried };
  }

  const piece: Piece = { slot, why: `Swapped in: ${short(pick.title)}.`, item: pick };
  look.pieces[at] = piece;
  look.total = total(look.pieces);

  if (opts.rewrite !== false) {
    const fresh = await rewriteLook(look, current, piece, brief).catch(() => null);
    if (fresh) {
      piece.why = fresh.why || piece.why;
      // Rename only when the old name or story is stale: it names a colour or type the look lost.
      const lost = [colourOf(current.item.title), typeIn(current.item.title, slot)?.word]
        .filter((w): w is string => !!w && !titleHas(pick.title, [w]));
      const stale = lost.some((w) => titleHas(`${look.name} ${look.story}`, [w]));
      if (!stale) { fresh.name = ''; fresh.story = ''; fresh.difference = ''; }
      if (fresh.name) look.name = fresh.name;
      if (fresh.story) look.story = fresh.story;
      if (fresh.difference) look.difference = fresh.difference;
    }
  }
  if (!look.story.includes(short(pick.title))) {
    look.story = look.story.split(short(current.item.title)).join(short(pick.title));
  }

  const notes: string[] = [];
  if (ask.cheaper) notes.push(`Saves $${round2(current.item.price - pick.price)}.`);
  if (look.total > brief.budget_usd) notes.push(`The look is now $${look.total}, $${round2(look.total - brief.budget_usd)} over the $${brief.budget_usd} budget.`);
  return { outfit: look, piece, ...(notes.length ? { note: notes.join(' ') } : {}), query, tried };
}

// The fast model writes the new piece's line and refreshes the look's name and story only when
// they no longer fit (a look named for a colour it lost). 2.5 s cap; the swap never waits longer.
async function rewriteLook(look: Outfit, old: Piece, now: Piece, brief: Brief) {
  const pieces = look.pieces.map((p) => `- ${p.slot}: ${p.item.title} ($${p.item.price}, ${p.item.store})`).join('\n');
  const reply = await generateJson<{ why: string; name_still_fits: boolean; name: string; difference: string; story: string }>({
    model: MODELS.fast(),
    job: 'brain_swap',
    system: 'You are Alice, a New York personal stylist. A client just swapped one piece of an outfit. Write in plain, warm, specific language. Use only the product title words given; never invent materials or colours.',
    user: [
      `Occasion: ${brief.occasion}. Budget $${brief.budget_usd}.`,
      `Look name: "${look.name}". One-line difference: "${look.difference}". Story: "${look.story}"`,
      `Swapped out (${old.slot}): ${old.item.title}`,
      `Swapped in (${now.slot}): ${now.item.title}`,
      `The look now:\n${pieces}`,
      'Return: why = one sentence on why the new piece works with the others; name_still_fits is true by default; set it false only if the name or story names the swapped-out piece, or a colour or mood the look no longer has; if false, a new short evocative name, a one-sentence difference and a 2-3 sentence story naming how the pieces pair. If true, repeat name, difference and story unchanged.',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        why: { type: 'string' }, name_still_fits: { type: 'boolean' }, name: { type: 'string' }, difference: { type: 'string' }, story: { type: 'string' },
      },
      required: ['why', 'name_still_fits', 'name', 'difference', 'story'],
    },
    temperature: 0.4,
    timeoutMs: Number(process.env.ALICE_SWAP_REWRITE_MS ?? 2500),
  });
  const d = reply.data;
  const keep = d.name_still_fits !== false;
  return {
    why: String(d.why ?? '').trim(),
    name: keep ? '' : String(d.name ?? '').trim(),
    difference: keep ? '' : String(d.difference ?? '').trim(),
    story: keep ? '' : String(d.story ?? '').trim(),
  };
}
