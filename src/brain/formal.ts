// Men's black-tie / formal evening guardrails: fixed plan, strict formal slot filtering,
// suit jacket-to-trouser matching, quality preference at $500+, and tie-preserving budget repair.
import type { Brief, Gender, Item, Piece } from '../types.ts';
import type { PlanIdea, Slot } from './plan.ts';
import { searchMixed } from '../store/index.ts';
import { colourOf } from './words.ts';

export const MEN_BLACK_TIE_OCCASION =
  /black tie|gala|tux|white tie|formal (dinner|event|ball)|charity (dinner|ball)|opera|award/i;

export function isMenBlackTie(brief: Pick<Brief, 'gender' | 'occasion'>): boolean {
  return brief.gender === 'men' && MEN_BLACK_TIE_OCCASION.test(brief.occasion ?? '');
}

export function formalPlan(_brief: Brief): PlanIdea[] {
  return [
    {
      name: 'Classic Black Suit',
      difference: 'A sharp black suit and crisp white dress shirt with classic black leather oxfords and a solid silk tie.',
      slots: [
        { slot: 'layer', query: "men's black suit jacket" },
        { slot: 'top', query: "men's white dress shirt" },
        { slot: 'bottom', query: "men's black suit trousers" },
        { slot: 'shoes', query: "men's black leather oxford shoes" },
        { slot: 'accessory', query: "men's black silk tie" },
      ],
    },
    {
      name: 'Black Tuxedo',
      difference: 'Steps up to a true tuxedo silhouette with patent leather oxfords and a dark silk tie for traditional evening polish.',
      slots: [
        { slot: 'layer', query: "men's black tuxedo jacket" },
        { slot: 'top', query: "men's white dress shirt" },
        { slot: 'bottom', query: "men's black tuxedo trousers" },
        { slot: 'shoes', query: "men's black patent oxford shoes" },
        { slot: 'accessory', query: "men's black silk tie" },
      ],
    },
    {
      name: 'Midnight Navy',
      difference: 'Swaps black tailoring for dark navy wool paired with crisp white shirting, black leather dress shoes, and a dark silk tie.',
      slots: [
        { slot: 'layer', query: "men's navy wool blazer" },
        { slot: 'top', query: "men's white dress shirt" },
        { slot: 'bottom', query: "men's navy wool trousers" },
        { slot: 'shoes', query: "men's black leather dress shoes" },
        { slot: 'accessory', query: "men's navy silk tie" },
      ],
    },
    {
      name: 'Charcoal Evening',
      difference: 'Softens the monochrome palette into dark charcoal suiting grounded by sleek black leather derbies and a silk tie.',
      slots: [
        { slot: 'layer', query: "men's charcoal suit jacket" },
        { slot: 'top', query: "men's white dress shirt" },
        { slot: 'bottom', query: "men's charcoal suit trousers" },
        { slot: 'shoes', query: "men's black leather derby shoes" },
        { slot: 'accessory', query: "men's black silk tie" },
      ],
    },
  ];
}

const CASUAL_WORDS =
  /\b(chunky|lug|hiker|combat|cargo|drawstring|joggers?|sweat(shirt|pant|pants|er|s)?|hoodies?|denim|jeans?|sneakers?|trainers?|mules?|clogs?|slides?|sandals?|slip[- ]?on|puffer|bomber|coaches|harrington|zip jacket|fleece|cropped|distressed|graphic|baggy|wide[- ]leg|corduroy|cord|barn|chore|trucker|shacket|overshirt|windbreaker|varsity|parka|anorak|chinos?|shorts?)\b/i;

const FORMAL_SHOE = /\b(leather|patent|oxford|oxfords|derby|derbies|dress)\b/i;
const CASUAL_SHOE_TITLE = /\b(boots?|chelsea|chukka|velvet|suede|canvas|mesh|knit|platform|espadrille|moccasin|boat|black\/white|alvin)\b/i;
const CASUAL_SHOE_DESC = /\b(mule|clog|slide|sandal|lug sole|boat shoe|sneaker|trainer|western|dress boot|ankle boot|chelsea boot|casual shoe|lace[- ]?up dress loafer|penny strap|tassel|woven strap)\b/i;
const FORMAL_TOP = /\b(dress shirt|oxford shirt|tuxedo shirt|satin finish)\b/i;
const FORMAL_LAYER = /\b(suit|tuxedo|tux|blazer|dinner jacket|sport coat|tailored)\b/i;
const BAD_LAYER = /\b(trousers?|pants?|slacks|shirt|tee|polo|vest|waistcoat|linen|scarf|oversized|boxy|suede|velvet|embellished|zip[- ]?up|full[- ]?zip|tweed|relaxed|light\s+gr[ae]y)\b/i;
const FORMAL_LAYER_COLOURS = new Set(['black', 'navy', 'charcoal', 'grey', 'blue']);
const FORMAL_BOTTOM = /\b(trousers?|pants?|slacks)\b/i;
const BAD_BOTTOM = /\b(linen|parachute|easy pant|easy trouser|pull[- ]?on|relaxed|barrel|gurkha|striped|flare|wrapped|wrap|sash)\b/i;
const TIE_WORD = /\b(tie|necktie)\b/i;
const NOT_A_TIE = /tie[- ]?(dye|front|waist|up|back|strap)|hair tie/i;
const BAD_TIE_PATTERN = /\b(stripe|striped|pattern|patterned|print|printed)\b/i;

export function isTieItem(item: Pick<Item, 'title'>): boolean {
  const title = item.title ?? '';
  return TIE_WORD.test(title) && !NOT_A_TIE.test(title);
}

export function formalFilter(
  item: Pick<Item, 'title' | 'store' | 'description'>,
  slot: Slot | string,
): boolean {
  const title = item.title ?? '';
  const desc = item.description ?? '';
  if (CASUAL_WORDS.test(title)) return false;

  if (slot === 'shoes') {
    if (CASUAL_SHOE_TITLE.test(title) || CASUAL_SHOE_DESC.test(desc)) return false;
    const steveMaddenLeather = item.store === 'Steve Madden' && /\bLEATHER\b/i.test(title);
    if (!FORMAL_SHOE.test(title) && !steveMaddenLeather) return false;
    const c = colourOf(title);
    if (c && c !== 'black') return false;
    return true;
  }

  if (slot === 'top') {
    if (/\b(short[- ]sleeve|mandarin)\b/i.test(title)) return false;
    if (!FORMAL_TOP.test(title)) return false;
    const c = colourOf(title);
    if (c && c !== 'white') return false;
    return true;
  }

  if (slot === 'layer') {
    if (BAD_LAYER.test(title)) return false;
    if (!FORMAL_LAYER.test(title)) return false;
    const c = colourOf(title);
    if (c && !FORMAL_LAYER_COLOURS.has(c)) return false;
    return true;
  }

  if (slot === 'bottom') {
    if (BAD_BOTTOM.test(title)) return false;
    return FORMAL_BOTTOM.test(title);
  }

  if (slot === 'accessory') {
    if (!isTieItem(item)) return false;
    if (BAD_TIE_PATTERN.test(title) || BAD_TIE_PATTERN.test(desc)) return false;
    return true;
  }

  return true;
}

// Quality and formality score adjustments for men's black-tie candidate ranking.
export function formalScoreBoost(
  item: Pick<Item, 'title' | 'store' | 'description' | 'price'>,
  slot: Slot,
  query: string,
  brief: Pick<Brief, 'budget_usd'>,
): number {
  const title = item.title ?? '';
  const desc = item.description ?? '';
  const text = `${title} ${desc}`;
  const highBudget = brief.budget_usd >= 500;
  let boost = 0;

  if (slot === 'accessory') {
    if (/\bnocturnal\b/i.test(title)) boost += 6;
    else if (/\b(theory|black|navy|charcoal)\b/i.test(title)) boost += 4;
    else if (/\bconcrete\b/i.test(title)) boost += 2;
    if (/\b(canvas|cream|ivory|beige|white)\b/i.test(title)) boost -= 6;
  }

  if (slot === 'shoes') {
    const wantsPatent = /\bpatent\b/i.test(query);
    if (/\b(lace[- ]?up|oxford|derby|cap toe)\b/i.test(text)) boost += 3;
    if (/\b(slip[- ]?on|loafer|tassel)\b/i.test(text)) boost -= 3;
    if (highBudget && item.store === 'Steve Madden') {
      boost += wantsPatent && /\bpatent\b/i.test(title) ? 14 : 10;
    }
    if (/\bleland\b/i.test(title)) boost += 2;
    if (wantsPatent && /\bpatent\b/i.test(title)) boost += 4;
  }

  if (highBudget && (slot === 'layer' || slot === 'bottom')) {
    if (item.store === 'Everlane' && /tropical wool/i.test(title)) boost += 10;
    else if (item.store === 'Everlane') boost += 3;
  }

  if (slot === 'top') {
    if (/\b(dress shirt|tuxedo shirt|satin finish)\b/i.test(title)) boost += 5;
    if (/\boxford shirt\b/i.test(title)) boost -= 4;
    if (highBudget && /maison tailored|satin finish/i.test(title)) boost += 2;
  }

  return boost;
}

const GENERIC_SUIT_WORDS = new Set([
  'the', 'a', 'an', 'men', 'mens', 's',
  'jacket', 'blazer', 'suit', 'tuxedo', 'tux', 'coat', 'sport', 'dinner',
]);

export function suitCollectionWords(title: string): string[] {
  const head = (title ?? '').split(/\s+[-|]\s+/)[0] ?? '';
  const ws = head.toLowerCase().match(/[a-z]+/g) ?? [];
  return ws.filter((w) => !GENERIC_SUIT_WORDS.has(w));
}

const FORMAL_TROUSER_FALLBACK = /\b(suit|tuxedo|tux|dress|tailored|wool)\b/i;

function titleHeadWords(title: string): Set<string> {
  const head = (title ?? '').split(/\s+[-|]\s+/)[0] ?? '';
  return new Set(head.toLowerCase().match(/[a-z]+/g) ?? []);
}

export function pickSuitTrouserSync(
  jacket: Item,
  candidates: Item[],
  allowFallback = true,
): Item | null {
  const collection = suitCollectionWords(jacket.title);
  const jacketColour = colourOf(jacket.title);
  const valid = candidates.filter((t) => t.id !== jacket.id && formalFilter(t, 'bottom'));
  const sameColour = (t: Item) => (jacketColour ? colourOf(t.title) === jacketColour : true);
  const rankSameStore = (list: Item[]) => [
    ...list.filter((t) => t.store === jacket.store),
    ...list.filter((t) => t.store !== jacket.store),
  ];

  if (collection.length > 0) {
    const exact = valid.filter((t) => {
      if (!sameColour(t)) return false;
      const ws = titleHeadWords(t.title);
      return collection.every((w) => ws.has(w));
    });
    if (exact.length > 0) return rankSameStore(exact)[0];
  }

  if (!allowFallback) return null;

  const fallback = valid.filter((t) => sameColour(t) && FORMAL_TROUSER_FALLBACK.test(t.title));
  if (fallback.length === 0) return null;

  const scored = fallback.map((t) => {
    const ws = titleHeadWords(t.title);
    const shared = collection.filter((w) => ws.has(w)).length;
    const sameStore = t.store === jacket.store ? 1 : 0;
    return { t, score: shared * 4 + sameStore * 2 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}

export interface MatchSuitOptions {
  search?: typeof searchMixed;
  maxPrice?: number;
  gender?: Gender;
}

export async function matchSuit(
  jacket: Item,
  trousersCandidates: Item[],
  opts: MatchSuitOptions = {},
): Promise<Item | null> {
  const gender: Gender = opts.gender ?? jacket.department ?? 'men';
  const collection = suitCollectionWords(jacket.title);
  const jacketColour = colourOf(jacket.title);

  const inDept = (items: Item[]) =>
    items.filter((i) => i.department === gender && i.price > 0 && (opts.maxPrice == null || i.price <= opts.maxPrice));

  const initial = inDept(trousersCandidates);
  const firstHit = pickSuitTrouserSync(jacket, initial, false);
  if (firstHit) return firstHit;

  let merged = initial;
  if (collection.length > 0) {
    const queryParts = [...collection, 'trouser'];
    if (jacketColour) queryParts.push(jacketColour);
    const query = queryParts.join(' ');
    const searchFn = opts.search ?? searchMixed;
    try {
      const res = await searchFn(query, gender, {
        limit: 12,
        ...(opts.maxPrice != null ? { maxPrice: opts.maxPrice } : {}),
      });
      const extra = inDept(res.items);
      const seen = new Set(initial.map((i) => i.id));
      merged = [...initial, ...extra.filter((i) => !seen.has(i.id))];
    } catch {
      // Fall through to colour + formal-word fallback on existing candidates.
    }
  }

  return pickSuitTrouserSync(jacket, merged, true);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const totalOf = (pieces: Piece[]) => round2(pieces.reduce((s, p) => s + p.item.price, 0));

function mergedPool(slot: Slot, ranked: Map<Slot, Item[]>, pool: Map<Slot, Item[]>): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const list of [ranked.get(slot) ?? [], pool.get(slot) ?? []]) {
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

// Formal budget repair: ALWAYS keep the solid silk tie and the suit jacket.
// Trade down shoes, shirt, and suit pair (jacket + matching trousers together) first;
// only trade down the tie to a cheaper solid silk tie if still over budget.
// Never drop the tie — if still over budget, report the overage in `problems`.
export function fitFormalBudget(
  name: string,
  pieces: Piece[],
  ranked: Map<Slot, Item[]>,
  pool: Map<Slot, Item[]>,
  brief: Brief,
  taken: Set<string>,
  problems: string[],
  whyFor: (item: Item, slot: Slot) => string,
): Piece[] {
  const out = [...pieces];
  const allLayers = mergedPool('layer', ranked, pool);
  const allBottoms = mergedPool('bottom', ranked, pool);
  let guard = 16;

  while (totalOf(out) > brief.budget_usd && guard-- > 0) {
    let changed = false;

    // Try trading down non-accessory pieces first. At $500+, trade down shoes/top before breaking up
    // a quality matched suit (e.g. Everlane Tropical Wool); otherwise trade down priciest first.
    const slotTier = (slot: string) =>
      brief.budget_usd >= 500 && (slot === 'layer' || slot === 'bottom') ? 1 : 0;
    const nonAccessory = [...out]
      .filter((p) => p.slot !== 'accessory')
      .sort((a, b) => slotTier(a.slot) - slotTier(b.slot) || b.item.price - a.item.price);

    for (const p of nonAccessory) {
      if (p.slot === 'layer') {
        const curBottom = out.find((x) => x.slot === 'bottom');
        const curPairPrice = p.item.price + (curBottom?.item.price ?? 0);
        const cheaperLayers = allLayers
          .filter((i) => i.price < p.item.price && !taken.has(i.id) && i.id !== p.item.id)
          .sort((a, b) => b.price - a.price);

        let bestPair: { layer: Item; bottom: Item | null; savings: number } | null = null;
        for (const altLayer of cheaperLayers) {
          if (!curBottom) {
            bestPair = { layer: altLayer, bottom: null, savings: p.item.price - altLayer.price };
            break;
          }
          const untakenBottoms = allBottoms.filter((b) => !taken.has(b.id) && b.id !== altLayer.id);
          const matchedBottom = pickSuitTrouserSync(altLayer, untakenBottoms, true);
          if (!matchedBottom) continue;
          const pairPrice = altLayer.price + matchedBottom.price;
          if (pairPrice < curPairPrice) {
            bestPair = { layer: altLayer, bottom: matchedBottom, savings: curPairPrice - pairPrice };
            break;
          }
        }
        if (bestPair) {
          out[out.indexOf(p)] = { slot: 'layer', why: whyFor(bestPair.layer, 'layer'), item: bestPair.layer };
          if (curBottom && bestPair.bottom) {
            out[out.indexOf(curBottom)] = {
              slot: 'bottom',
              why: `Matching trousers for the ${bestPair.layer.title.split(/\s[-|]\s/)[0]}.`,
              item: bestPair.bottom,
            };
          }
          problems.push(`${name}: traded suit down to fit the budget`);
          changed = true;
          break;
        }
        continue;
      }

      if (p.slot === 'bottom') {
        const layer = out.find((x) => x.slot === 'layer');
        const layerColour = layer ? colourOf(layer.item.title) : null;
        const alt = allBottoms
          .filter(
            (i) =>
              i.price < p.item.price &&
              !taken.has(i.id) &&
              (!layerColour || colourOf(i.title) === layerColour),
          )
          .sort((a, b) => b.price - a.price)[0];
        if (!alt) continue;
        out[out.indexOf(p)] = { slot: 'bottom', why: whyFor(alt, 'bottom'), item: alt };
        problems.push(`${name}: traded bottom down to fit the budget`);
        changed = true;
        break;
      }

      const candidates = mergedPool(p.slot as Slot, ranked, pool);
      const alt = candidates
        .filter((i) => i.price < p.item.price && !taken.has(i.id))
        .sort((a, b) => b.price - a.price)[0];
      if (!alt) continue;
      out[out.indexOf(p)] = { slot: p.slot, why: whyFor(alt, p.slot as Slot), item: alt };
      problems.push(`${name}: traded ${p.slot} down to fit the budget`);
      changed = true;
      break;
    }

    if (changed) continue;

    // Only if non-accessory pieces cannot be traded down further, try a cheaper solid silk tie.
    const acc = out.find((p) => p.slot === 'accessory');
    if (acc) {
      const altTie = mergedPool('accessory', ranked, pool)
        .filter((i) => i.price < acc.item.price && !taken.has(i.id) && isTieItem(i))
        .sort((a, b) => b.price - a.price)[0];
      if (altTie) {
        out[out.indexOf(acc)] = { slot: 'accessory', why: whyFor(altTie, 'accessory'), item: altTie };
        problems.push(`${name}: traded accessory down to fit the budget`);
        changed = true;
      }
    }

    if (!changed) break;
  }

  const finalTotal = totalOf(out);
  if (finalTotal > brief.budget_usd) {
    const note = `${name}: $${finalTotal} over $${brief.budget_usd} budget (kept solid silk tie)`;
    if (!problems.includes(note)) problems.push(note);
  }

  return out;
}
