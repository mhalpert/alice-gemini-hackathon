// Step 1 of the stylist brain: turn a brief into four outfit ideas, each with one store search per slot.
// Hydrogen plans; if it has not answered by the hedge time, Flash Lite plans too and the first
// usable plan wins. Whatever comes back is repaired so every idea is a complete outfit.
import type { Brief } from '../types.ts';
import { generateJson, MODELS } from './gemini.ts';

export const SLOTS = ['top', 'bottom', 'dress', 'layer', 'shoes', 'accessory', 'bag', 'jewelry'] as const;
export type Slot = (typeof SLOTS)[number];

export interface PlanSlot { slot: Slot; query: string; own?: boolean }
export interface PlanIdea { name: string; difference: string; slots: PlanSlot[] }
export interface Plan {
  ideas: PlanIdea[];
  own_slot: Slot | null;
  model: string;
  ms: number;
  repairs: string[];   // what the repair step had to fix, for the call log and the eval
}

const IDEAS_WANTED = 4;
const MIN_USABLE = 3;

export function pieceCeiling(budget: number): number {
  return Math.max(25, Math.round(budget * 0.45));
}

function todayInNewYork(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const DRESS_CODE = `DRESS CODE (hard rules; getting formality wrong is the most common way a look fails)
- All four outfits sit at exactly the dressiness the occasion calls for. Never make one look "more casual" or "edgier" to create variety.
- Black tie / black tie optional. Men: a dark suit or tuxedo jacket (layer) with its matching trousers (bottom), a white or black dress shirt, a solid dark silk tie (no prints, logos or novelty; the stores carry no bow ties), leather dress shoes, no patent in daytime. Women: a floor-length or elegant midi gown or a dressy jumpsuit, heels or dressy flats, an evening bag.
- Job interviews are polished and conservative: closed-toe shoes only (no sandals, mules, open toes), nothing sheer, cropped, backless or lace, no graphic prints, no ripped denim, no flashy or iced-out jewelry. A bank is more formal than a creative agency.
- Wedding guests: women never wear white, ivory, cream or anything bridal; men never wear a white or ivory suit or jacket, but a white dress shirt under a suit is classic and correct. Daytime or outdoor weddings: no patent leather, no tuxedos, breathable fabrics, block heels or flats rather than stilettos on grass.
- Dress for the season and climate: hot weather means linen, cotton and light colours, never velvet, wool or heavy knits; fall and winter mean knits, layers, boots and a jacket or coat.
- Belt and shoes share a colour family; leathers never clash.
- Nothing that reads as lingerie (lace bralettes, sheer bodysuits, slip dresses that look like nightwear), except a sleek club look.
- Festivals and beach: practical shoes, sun-ready accessories. Clubs: dark or bold colours, sleek fits. Brunch and casual plans: elevated casual, never gym wear.`;

function systemPrompt(): string {
  return `You are Alice, a top personal stylist. You dress real clients from the live inventory of four online stores, and you plan outfits that a search engine will then fill with real products.

THE STORES
- Fashion Nova: trendy and cheap, most pieces $10-60.
- Everlane: well-made basics, $30-150. Best for trousers, knits, shirts and outer layers.
- Steve Madden: shoes and bags, $60-150, mostly leather.
- Kith: premium New York streetwear, usually over budget.

WHAT TO RETURN
Four outfit ideas. Each idea is a complete outfit described as store searches, one search per slot, 4 or 5 slots:
- top + bottom, or a dress (a jumpsuit counts as a dress), or for a suit a layer (the jacket) + a bottom whose search names the same colour and fabric as the jacket;
- shoes, always;
- at least one accessory slot that shows in a head-to-toe photo: accessory (belt, tie, watch, sunglasses, hat), bag or jewelry. Never socks or underwear;
- a layer only when the occasion or the weather calls for one.
Slot names: top, bottom, dress, layer, shoes, accessory, bag, jewelry. Each slot at most once per idea.

HOW TO WRITE A SEARCH
- Start with "men's" or "women's" to match the client's department.
- Name exactly one product type with its key colour and material, 3 to 7 words, in the plain words a product title would use: "men's navy wool blazer", "women's black leather ankle boots", "men's tan suede belt".
- No brand names, prices, sizes or vague adjectives like "stylish", "trendy" or "nice".
- Keep it realistic for the per-piece ceiling.

MAKING FOUR DIFFERENT IDEAS
Vary colour story, silhouette and texture across the four; never vary formality, so no idea is described as edgier, more casual or dressier than the others. Give each idea a short evocative name (2-3 words) and a one-sentence difference that says how it differs from the others, written for the client.

${DRESS_CODE}

The client's notes override your style defaults but never the dress code. If the client has their own piece, every idea is built around it: set own_slot to its slot and do not include that slot in any idea's searches.`;
}

function userPrompt(brief: Brief): string {
  const dept = brief.gender === 'women' ? "women's" : "men's";
  const lines = [
    `Department: ${dept}`,
    `Occasion: ${brief.occasion}`,
    `Budget for one whole outfit: $${brief.budget_usd}. No single piece over $${pieceCeiling(brief.budget_usd)}.`,
    `Today is ${todayInNewYork()} in New York. If the occasion names no season, dress for the coming weeks.`,
  ];
  if (brief.weather) lines.push(`Forecast for the event: ${brief.weather}`);
  if (brief.notes) lines.push(`Client's notes: ${brief.notes}`);
  if (brief.own_piece) lines.push(`Client's own piece, in every outfit: ${brief.own_piece}`);
  return lines.join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    own_slot: { type: 'string', enum: [...SLOTS, 'none'] },
    ideas: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          difference: { type: 'string' },
          slots: {
            type: 'array',
            minItems: 3,
            maxItems: 6,
            items: {
              type: 'object',
              properties: { slot: { type: 'string', enum: [...SLOTS] }, query: { type: 'string' } },
              required: ['slot', 'query'],
            },
          },
        },
        required: ['name', 'difference', 'slots'],
      },
    },
  },
  required: ['own_slot', 'ideas'],
};

// ---------------------------------------------------------------------------
// Repair: make every idea a complete, searchable outfit
// ---------------------------------------------------------------------------

const SLOT_ALIASES: Record<string, Slot> = {
  shirt: 'top', blouse: 'top', sweater: 'top', knit: 'top', tee: 'top', polo: 'top',
  pants: 'bottom', trousers: 'bottom', trouser: 'bottom', jeans: 'bottom', skirt: 'bottom', shorts: 'bottom', chinos: 'bottom',
  jumpsuit: 'dress', gown: 'dress',
  jacket: 'layer', blazer: 'layer', coat: 'layer', outerwear: 'layer', cardigan: 'layer', suit: 'layer',
  shoe: 'shoes', footwear: 'shoes', boots: 'shoes', sneakers: 'shoes', heels: 'shoes',
  belt: 'accessory', tie: 'accessory', watch: 'accessory', hat: 'accessory', sunglasses: 'accessory', accessories: 'accessory',
  handbag: 'bag', clutch: 'bag', purse: 'bag', necklace: 'jewelry', earrings: 'jewelry', bracelet: 'jewelry', jewellery: 'jewelry',
};

function toSlot(raw: unknown): Slot | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if ((SLOTS as readonly string[]).includes(s)) return s as Slot;
  return SLOT_ALIASES[s] ?? null;
}

const BANNED_WORDS = /\b(stylish|trendy|nice|cute|chic|fashionable|cheap|affordable|premium|luxury|designer|under|size|sized|\$\d+)\b/gi;
const BRANDS = /\b(fashion nova|everlane|steve madden|kith)\b/gi;

export function cleanQuery(raw: string, dept: string): string {
  let q = String(raw ?? '').replace(/\$\s?\d+(\.\d+)?/g, ' ').replace(/(?<![\w-])\d+(?![\w-])/g, ' ').replace(BRANDS, ' ').replace(BANNED_WORDS, ' ').replace(/[^\p{L}\p{N}'\- ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  q = q.replace(/^(men'?s|women'?s|mens|womens|men|women)\b\s*/, '');
  const words = q.split(' ').filter(Boolean).slice(0, 6);
  return `${dept} ${words.join(' ')}`.trim();
}

function fallbackQuery(slot: Slot, brief: Brief): string {
  const dept = brief.gender === 'women' ? "women's" : "men's";
  const defaults: Record<Slot, string> = {
    top: brief.gender === 'women' ? 'black fitted top' : 'white cotton shirt',
    bottom: brief.gender === 'women' ? 'black tailored trousers' : 'navy chinos',
    dress: 'black midi dress',
    layer: brief.gender === 'women' ? 'black blazer' : 'navy blazer',
    shoes: brief.gender === 'women' ? 'black leather ankle boots' : 'brown leather shoes',
    accessory: brief.gender === 'women' ? 'gold hoop earrings' : 'brown leather belt',
    bag: 'black leather crossbody bag',
    jewelry: 'gold layered necklace',
  };
  return `${dept} ${defaults[slot]}`;
}

// Hard dress-code fixes applied to every search, whichever model planned it.
// Each returns the fixed query, or the same string when nothing applies.
const ACCENT_SLOTS: Slot[] = ['shoes', 'bag', 'accessory', 'jewelry'];
const GUARDS: { when: RegExp; why: string; fix: (q: string, slot: Slot, brief: Brief) => string }[] = [
  {
    when: /wedding/i,
    why: 'no white at a wedding',
    fix: (q, slot, brief) => {
      if (brief.gender === 'men' && slot === 'top') return q.replace(/\b(bridal|bride)\b/g, 'dress');
      return q.replace(/\b(white|off-white|ivory|cream|ecru|bridal|bride)\b/g, ACCENT_SLOTS.includes(slot) ? 'tan' : 'dusty blue');
    },
  },
  {
    when: /interview/i,
    why: 'closed-toe and covered for an interview',
    fix: (q) => q.replace(/\b(open[- ]toe|peep[- ]toe|strappy)\b/g, '').replace(/\bsandals?\b/g, 'pumps').replace(/\bmules?\b/g, 'loafers')
      .replace(/\b(sheer|cropped|crop|backless|lace|ripped|distressed|graphic)\b/g, ''),
  },
  {
    when: /^(?!.*\bclub\b).*/i,
    why: 'nothing that reads as lingerie',
    fix: (q) => q.replace(/\b(slip|bralette|bodysuit|lingerie|sheer)\b/g, ''),
  },
];

function guardQuery(query: string, slot: Slot, brief: Brief, where: string, repairs: string[]): string {
  let q = query;
  for (const g of GUARDS) {
    if (!g.when.test(brief.occasion)) continue;
    const fixed = g.fix(q, slot, brief).replace(/\s+/g, ' ').trim();
    if (fixed !== q) { repairs.push(`${where}: ${g.why} ("${q}" -> "${fixed}")`); q = fixed; }
  }
  return q;
}

export function repairPlan(raw: any, brief: Brief): { ideas: PlanIdea[]; own_slot: Slot | null; repairs: string[] } {
  const dept = brief.gender === 'women' ? "women's" : "men's";
  const repairs: string[] = [];
  const ownSlot = brief.own_piece ? toSlot(raw?.own_slot) : null;
  if (brief.own_piece && !ownSlot) repairs.push('own piece slot unknown; searching every slot');

  const ideas: PlanIdea[] = [];
  for (const [i, rawIdea] of (Array.isArray(raw?.ideas) ? raw.ideas : []).entries()) {
    const where = `idea ${i + 1}`;
    const slots: PlanSlot[] = [];
    for (const s of Array.isArray(rawIdea?.slots) ? rawIdea.slots : []) {
      const slot = toSlot(s?.slot);
      if (!slot) { repairs.push(`${where}: dropped unknown slot "${s?.slot}"`); continue; }
      if (slots.some((x) => x.slot === slot)) { repairs.push(`${where}: dropped a second ${slot}`); continue; }
      if (slot === ownSlot) continue;
      const query = guardQuery(cleanQuery(s?.query, dept), slot, brief, where, repairs);
      if (query.split(' ').length < 2) { repairs.push(`${where}: empty ${slot} search`); continue; }
      slots.push({ slot, query });
    }
    if (ownSlot) slots.unshift({ slot: ownSlot, query: brief.own_piece!, own: true });

    const has = (s: Slot) => slots.some((x) => x.slot === s);
    if (has('dress') && (has('top') || has('bottom')) && ownSlot !== 'top' && ownSlot !== 'bottom') {
      // A dress plus separates is two outfits in one; keep the dress.
      for (const s of ['top', 'bottom'] as Slot[]) {
        const at = slots.findIndex((x) => x.slot === s && !x.own);
        if (at >= 0) { slots.splice(at, 1); repairs.push(`${where}: dropped ${s} beside a dress`); }
      }
    }
    if (!has('dress')) {
      for (const s of ['top', 'bottom'] as Slot[]) {
        if (!has(s)) { slots.push({ slot: s, query: fallbackQuery(s, brief) }); repairs.push(`${where}: added missing ${s}`); }
      }
    }
    if (!has('shoes')) { slots.push({ slot: 'shoes', query: fallbackQuery('shoes', brief) }); repairs.push(`${where}: added missing shoes`); }
    if (!has('accessory') && !has('bag') && !has('jewelry')) {
      slots.push({ slot: 'accessory', query: fallbackQuery('accessory', brief) });
      repairs.push(`${where}: added missing accessory`);
    }

    const order: Slot[] = ['dress', 'layer', 'top', 'bottom', 'shoes', 'accessory', 'bag', 'jewelry'];
    slots.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    ideas.push({
      name: String(rawIdea?.name ?? '').trim() || `Look ${i + 1}`,
      difference: String(rawIdea?.difference ?? '').trim(),
      slots: slots.slice(0, 6),
    });
  }
  return { ideas: ideas.slice(0, IDEAS_WANTED), own_slot: ownSlot, repairs };
}

// ---------------------------------------------------------------------------
// Planning with a hedge
// ---------------------------------------------------------------------------

async function planWith(model: string, brief: Brief, signal: AbortSignal, timeoutMs: number): Promise<Plan> {
  const isStylist = model === MODELS.stylist();
  const level = ((isStylist ? process.env.ALICE_PLAN_THINKING : undefined) || 'low').toLowerCase() as 'low';
  const reply = await generateJson<any>({
    job: 'brain_plan',
    model,
    system: systemPrompt(),
    user: userPrompt(brief),
    schema: SCHEMA,
    temperature: 0.7,
    thinkingLevel: level,
    timeoutMs,
    signal,
  });
  const fixed = repairPlan(reply.data, brief);
  if (fixed.ideas.length < MIN_USABLE) throw new Error(`${model}: only ${fixed.ideas.length} usable ideas`);
  return { ...fixed, model, ms: reply.ms };
}

export async function planOutfits(brief: Brief): Promise<Plan> {
  const started = performance.now();
  const hedgeMs = Number(process.env.ALICE_PLAN_HEDGE_MS ?? 8000);
  const fastOnly = (process.env.ALICE_LIVE_PLANNER ?? '').toLowerCase() === 'fast';
  const stop = new AbortController();
  const errors: string[] = [];

  const run = (model: string, timeoutMs: number) =>
    planWith(model, brief, stop.signal, timeoutMs).catch((err) => { errors.push(String(err?.message ?? err)); throw err; });

  try {
    if (fastOnly) return finish(await run(MODELS.fast(), 15000));

    const stylist = run(MODELS.stylist(), 30000);
    // Start the fast planner at the hedge time, or at once if the stylist fails first.
    const fast = new Promise<Plan>((resolve, reject) => {
      let started = false;
      const go = () => { if (started) return; started = true; run(MODELS.fast(), 15000).then(resolve, reject); };
      const timer = setTimeout(go, hedgeMs);
      stylist.then(() => clearTimeout(timer), () => { clearTimeout(timer); go(); });
    });
    return finish(await Promise.any([stylist, fast]));
  } catch {
    throw new Error(`no usable plan: ${errors.join(' | ')}`);
  } finally {
    stop.abort();
  }

  function finish(plan: Plan): Plan {
    return { ...plan, ms: Math.round(performance.now() - started) };
  }
}
