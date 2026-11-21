// Word lists the brain uses to read a shopper's request and a product title.

// Colour a shopper might say -> title words that count as that colour.
export const COLOUR_WORDS: Record<string, string[]> = {
  black: ['black', 'onyx', 'jet', 'charcoal'],
  white: ['white', 'ivory', 'cream', 'bone', 'off-white', 'ecru'],
  brown: ['brown', 'tan', 'cognac', 'chocolate', 'camel', 'taupe', 'mocha', 'espresso', 'chestnut', 'coffee', 'walnut', 'whiskey', 'saddle'],
  tan: ['tan', 'camel', 'cognac', 'sand', 'khaki', 'beige'],
  navy: ['navy', 'midnight'],
  blue: ['blue', 'navy', 'denim', 'indigo', 'cobalt', 'sky'],
  grey: ['grey', 'gray', 'charcoal', 'heather', 'slate'],
  gray: ['grey', 'gray', 'charcoal', 'heather', 'slate'],
  green: ['green', 'olive', 'sage', 'khaki', 'forest', 'emerald'],
  olive: ['olive', 'khaki', 'army'],
  red: ['red', 'burgundy', 'wine', 'maroon', 'crimson', 'cherry'],
  burgundy: ['burgundy', 'wine', 'maroon', 'oxblood'],
  beige: ['beige', 'sand', 'khaki', 'stone', 'oatmeal', 'cream', 'nude'],
  cream: ['cream', 'ivory', 'ecru', 'off-white', 'bone'],
  silver: ['silver', 'chrome', 'steel'],
  gold: ['gold', 'brass'],
  pink: ['pink', 'blush', 'rose', 'fuchsia', 'coral', 'peach'],
  purple: ['purple', 'lavender', 'lilac', 'plum'],
  yellow: ['yellow', 'mustard', 'lemon'],
  orange: ['orange', 'rust', 'terracotta', 'coral', 'peach'],
  teal: ['teal', 'turquoise', 'aqua', 'mint'],
};

// The colour asked for: in "swap the black boots for brown boots" it is the last one named.
export function wantedColour(request: string): { word: string; matches: string[] } | null {
  const ws = (request ?? '').toLowerCase().match(/[a-z-]+/g) ?? [];
  for (let i = ws.length - 1; i >= 0; i--) {
    if (COLOUR_WORDS[ws[i]]) return { word: ws[i], matches: COLOUR_WORDS[ws[i]] };
  }
  return null;
}

export function titleHas(title: string, words: string[]): boolean {
  const t = (title ?? '').toLowerCase();
  return words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/-/g, '\\-')}([^a-z]|$)`).test(t));
}

// First colour word found in a title, for keeping a look's colour story on a "cheaper" swap.
export function colourOf(title: string): string | null {
  const t = (title ?? '').toLowerCase();
  for (const [word, matches] of Object.entries(COLOUR_WORDS)) if (titleHas(t, [word, ...matches.slice(0, 1)])) return word;
  return null;
}

// Product types by slot: [canonical word, other title words that mean it].
export const TYPES: Record<string, [string, string[]][]> = {
  shoes: [
    ['boots', ['boot', 'boots', 'chelsea']], ['sneakers', ['sneaker', 'sneakers', 'trainer', 'trainers']],
    ['loafers', ['loafer', 'loafers']], ['heels', ['heel', 'heels', 'pump', 'pumps', 'stiletto', 'stilettos']],
    ['sandals', ['sandal', 'sandals', 'slide', 'slides']], ['mules', ['mule', 'mules']], ['flats', ['flat', 'flats', 'ballet']],
    ['oxfords', ['oxford', 'oxfords', 'derby', 'derbies', 'brogue', 'brogues']], ['dress shoes', ['dress shoe', 'dress shoes']],
  ],
  top: [
    ['t-shirt', ['t-shirt', 'tee', 'tees', 't-shirts']], ['polo', ['polo', 'polos']], ['sweater', ['sweater', 'sweaters', 'jumper', 'knit', 'pullover', 'crewneck']],
    ['blouse', ['blouse', 'blouses']], ['tank', ['tank', 'cami', 'camisole']], ['hoodie', ['hoodie', 'sweatshirt']],
    ['shirt', ['shirt', 'shirts', 'button-down', 'button down', 'oxford shirt']], ['bodysuit', ['bodysuit']],
    ['top', ['top', 'tops', 'crop top', 'corset']],
  ],
  bottom: [
    ['jeans', ['jean', 'jeans', 'denim']], ['chinos', ['chino', 'chinos']], ['shorts', ['short', 'shorts']],
    ['skirt', ['skirt', 'skirts']], ['trousers', ['trouser', 'trousers', 'pant', 'pants', 'slacks']],
  ],
  layer: [
    ['blazer', ['blazer', 'sport coat', 'suit jacket']], ['coat', ['coat', 'trench', 'overcoat', 'parka']],
    ['cardigan', ['cardigan']], ['overshirt', ['overshirt', 'shacket', 'shirt jacket']], ['vest', ['vest', 'waistcoat']],
    ['jacket', ['jacket', 'bomber']],
  ],
  dress: [['jumpsuit', ['jumpsuit', 'romper']], ['dress', ['dress', 'gown']]],
  bag: [['bag', ['bag', 'tote', 'clutch', 'crossbody', 'purse', 'handbag', 'shoulder bag', 'backpack']]],
  accessory: [
    ['belt', ['belt']], ['watch', ['watch']], ['sunglasses', ['sunglasses', 'shades']], ['hat', ['hat', 'cap', 'beanie', 'fedora']],
    ['tie', ['tie', 'necktie']], ['scarf', ['scarf']],
  ],
  jewelry: [
    ['necklace', ['necklace', 'chain', 'pendant']], ['bracelet', ['bracelet', 'cuff']], ['earrings', ['earring', 'earrings', 'hoops', 'studs']],
    ['ring', ['ring', 'rings']],
  ],
};

// What to call a slot in a search when nothing more specific is known.
export const SLOT_NOUN: Record<string, string> = {
  shoes: 'shoes', top: 'shirt', bottom: 'trousers', layer: 'jacket', dress: 'dress', bag: 'bag', accessory: 'belt', jewelry: 'necklace',
};

export interface TypeMatch { word: string; matches: string[] }

// The product type a text names for a slot (the last one named wins in a request).
export function typeIn(text: string, slot: string, last = false): TypeMatch | null {
  const list = TYPES[slot] ?? Object.values(TYPES).flat();
  const t = (text ?? '').toLowerCase();
  let best: { at: number; m: TypeMatch } | null = null;
  for (const [word, matches] of list) {
    for (const m of matches) {
      const re = new RegExp(`(^|[^a-z])${m}([^a-z]|$)`, 'g');
      for (const hit of t.matchAll(re)) {
        const at = hit.index ?? 0;
        if (!best || (last ? at > best.at : at < best.at)) best = { at, m: { word, matches } };
      }
    }
  }
  return best?.m ?? null;
}

// Every colour word the brain knows, for checking a look's name against its pieces.
const ALL_COLOURS = [...new Set([...Object.keys(COLOUR_WORDS), ...Object.values(COLOUR_WORDS).flat(), 'champagne', 'lilac', 'sage', 'emerald', 'mustard'])]
  .filter((w) => !['denim', 'khaki', 'stone', 'bone', 'jet', 'sky', 'army', 'nude', 'heather', 'flat'].includes(w));

// A colour in the name is real if some piece's title names it or a colour of the same family.
function colourPresent(word: string, titles: string): boolean {
  const family = new Set([word]);
  for (const [k, list] of Object.entries(COLOUR_WORDS)) if (k === word || list.includes(word)) { family.add(k); list.forEach((w) => family.add(w)); }
  return titleHas(titles, [...family]);
}

// "Coral Sunset Jumpsuit" over a sage jumpsuit -> "Sunset Jumpsuit". Returns the fixed name.
export function fixNameColours(name: string, titles: string[]): string {
  const all = titles.join(' | ');
  const wrong = ALL_COLOURS.filter((w) => titleHas(name, [w]) && !colourPresent(w, all));
  if (!wrong.length) return name;
  let out = name;
  for (const w of wrong) out = out.replace(new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'ig'), '$1$2');
  out = out.replace(/\s{2,}/g, ' ').replace(/^[\s&,-]+|[\s&,-]+$/g, '').trim();
  return out || name;
}

// Hard dress-code filters that a model must not be trusted with.
const BRIDAL = /\b(bride|bridal|bachelorette|wedding dress|veil|just married)\b/i;
const WHITES = ['white', 'ivory', 'off-white', 'cream', 'ecru', 'bone'];
export function isWeddingGuest(occasion: string): boolean {
  const o = (occasion ?? '').toLowerCase();
  return /wedding|reception|rehearsal dinner/.test(o) && !/\b(my|our) (own )?wedding\b|i'?m getting married|\bmy bridal\b/.test(o);
}
export function breaksDressCode(item: { title: string; description?: string }, slot: string, brief: { occasion: string; gender: string }): boolean {
  if (!isWeddingGuest(brief.occasion)) return false;
  if (BRIDAL.test(item.title) || BRIDAL.test(item.description ?? '')) return true;
  // Guests never wear white: anything visible for women, the jacket or trousers for men.
  const visible = brief.gender === 'women' ? ['dress', 'top', 'bottom', 'layer'] : ['layer', 'bottom'];
  return visible.includes(slot) && titleHas(item.title, WHITES);
}
