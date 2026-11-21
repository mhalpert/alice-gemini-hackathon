// Unit tests for men's black-tie planning, formal filtering, suit matching,
// quality preference at $500+, tie-preserving budget repair, and occasion budgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitFormalBudget,
  formalFilter,
  formalPlan,
  formalScoreBoost,
  isMenBlackTie,
  matchSuit,
} from '../src/brain/formal.ts';
import { dedupe, scoreItem } from '../src/brain/build.ts';
import { breaksDressCode } from '../src/brain/words.ts';
import { OCCASIONS } from '../src/library/occasions.ts';
import { EXTRA_OCCASIONS } from '../src/library/occasions-extra.ts';
import type { Slot } from '../src/brain/plan.ts';
import type { Brief, Item, Piece, SearchResult } from '../src/types.ts';

let seq = 0;
function makeItem(
  title: string,
  price: number,
  extra: Partial<Item> = {},
): Item {
  seq += 1;
  return {
    id: `formal-prod-${seq}`,
    variant_id: `formal-var-${seq}`,
    title,
    price,
    url: `https://example.com/formal/${seq}`,
    image: `https://cdn.example.com/formal-${seq}.jpg`,
    store: 'Fashion Nova',
    store_domain: 'fnova.myshopify.com',
    rating: 4.6,
    rating_count: 25,
    sizes: ['M', 'L'],
    variants_by_size: {},
    description: title,
    department: 'men',
    ...extra,
  };
}

const whyFor = (item: Item, slot: Slot) => `${slot}: ${item.title}`;

test('isMenBlackTie detects men formal evening events and excludes casual or women briefs', () => {
  assert.equal(isMenBlackTie({ gender: 'men', occasion: 'black tie optional gala' }), true);
  assert.equal(isMenBlackTie({ gender: 'men', occasion: 'black tie wedding' }), true);
  assert.equal(isMenBlackTie({ gender: 'men', occasion: 'charity ball' }), true);
  assert.equal(isMenBlackTie({ gender: 'men', occasion: 'opera opening night' }), true);
  assert.equal(isMenBlackTie({ gender: 'men', occasion: 'tailgate' }), false);
  assert.equal(isMenBlackTie({ gender: 'women', occasion: 'black tie optional gala' }), false);
});

test('formalPlan returns 4 fixed black-tie ideas with one-sentence differences and expected slots', () => {
  const ideas = formalPlan({ gender: 'men', occasion: 'black tie optional gala', budget_usd: 600 });
  assert.equal(ideas.length, 4);
  assert.deepEqual(
    ideas.map((i) => i.name),
    ['Classic Black Suit', 'Black Tuxedo', 'Midnight Navy', 'Charcoal Evening'],
  );
  for (const idea of ideas) {
    assert.ok(idea.difference.length > 20);
    assert.deepEqual(
      idea.slots.map((s) => s.slot),
      ['layer', 'top', 'bottom', 'shoes', 'accessory'],
    );
  }
});

test('formalFilter rejects casual pieces and non-tie accessories, and accepts formal black-tie stock', () => {
  assert.equal(formalFilter(makeItem('Chunky Hiker Lace Up Oxford Shoes', 55), 'shoes'), false);
  assert.equal(formalFilter(makeItem('Baggy Pleated Regal Trouser', 42), 'bottom'), false);
  assert.equal(formalFilter(makeItem('Relaxed Barn Jacket', 120, { store: 'Everlane' }), 'layer'), false);
  assert.equal(formalFilter(makeItem('Floral Silk Scarf', 35), 'accessory'), false);
  assert.equal(formalFilter(makeItem('Velvet Loafer - Black', 85), 'accessory'), false);
  assert.equal(formalFilter(makeItem('Classic Leather Dress Belt - Black', 28), 'accessory'), false);
  assert.equal(formalFilter(makeItem('Open Back Mule - Black', 65), 'shoes'), false);
  assert.equal(
    formalFilter(
      makeItem('JOVIAN BLACK LEATHER', 129.95, {
        store: 'Steve Madden',
        description: 'This mule-style silhouette features a distinctive open back.',
      }),
      'shoes',
    ),
    false,
  );
  assert.equal(formalFilter(makeItem('Corduroy Slim Trouser - Black', 48), 'bottom'), false);
  assert.equal(formalFilter(makeItem('Maison Tailored Wrinkle Free Dress Shirt - Red', 30.99), 'top'), false);
  assert.equal(formalFilter(makeItem('Sorrento Single Breasted Blazer - Light Grey', 12.98), 'layer'), false);
  assert.equal(
    formalFilter(
      makeItem('TURBO BLACK LEATHER', 149.95, {
        store: 'Steve Madden',
        description: 'The TURBO BLACK LEATHER lace-up dress loafer combines refined craftsmanship.',
      }),
      'shoes',
    ),
    false,
  );

  assert.equal(
    formalFilter(
      makeItem('LELAND BLACK LEATHER', 129.95, {
        store: 'Steve Madden',
        description: 'The LELAND lace-up dress shoe combines classic style with expert construction.',
      }),
      'shoes',
    ),
    true,
  );
  assert.equal(
    formalFilter(makeItem('Faux Patent Leather Lace Up Oxford Shoes - Black', 34.99), 'shoes'),
    true,
  );
  assert.equal(formalFilter(makeItem('Luxe Stretch Dress Shirt - White', 16), 'top'), true);
  assert.equal(formalFilter(makeItem('Wrinkle Resistant Stretch Satin Finish Dress Shirt - White', 23.99), 'top'), true);
  assert.equal(formalFilter(makeItem('The Modern Stretch Slim Trouser - Black', 25), 'bottom'), true);
  assert.equal(formalFilter(makeItem('The Modern Stretch Suit Jacket - Black', 35), 'layer'), true);
  assert.equal(formalFilter(makeItem('Striped Silk Tie - Navy', 45), 'accessory'), false);
  assert.equal(
    formalFilter(
      makeItem('Classic Silk Tie - Black', 45, { description: 'Subtle tonal pattern woven into silk.' }),
      'accessory',
    ),
    false,
  );
  assert.equal(
    formalFilter(
      makeItem('Kith Silk Tie - Sage', 45, { description: 'All-over print artwork.' }),
      'accessory',
    ),
    false,
  );
  assert.equal(
    formalFilter(
      makeItem('Giorgio Armani & Kith Silk Tie - Nocturnal', 245, {
        store: 'Kith',
        description: 'Silk All-over stripes Giorgio Armani & Kith embroidery Blade: 6cm',
      }),
      'accessory',
    ),
    true,
  );
  assert.equal(
    breaksDressCode(
      {
        title: 'Giorgio Armani & Kith Silk Tie - Nocturnal',
        description: 'Silk All-over stripes Giorgio Armani & Kith embroidery Blade: 6cm',
      },
      'accessory',
      { occasion: 'black tie optional gala', gender: 'men' },
    ),
    false,
  );
});

test('matchSuit pairs the Modern Stretch black jacket with the Modern Stretch black trouser, not olive or corduroy', async () => {
  const jacket = makeItem('The Modern Stretch Suit Jacket - Black', 35);
  const oliveTrouser = makeItem('The Modern Stretch Slim Trouser - Olive', 25);
  const corduroyTrouser = makeItem('Corduroy Slim Trouser - Black', 30);
  const matchingBlackTrouser = makeItem('The Modern Stretch Slim Trouser - Black', 25);

  const calls: string[] = [];
  const fakeSearch = async (query: string): Promise<SearchResult> => {
    calls.push(query);
    return { items: [], source: 'live', ms: 1 };
  };

  const matched = await matchSuit(
    jacket,
    [corduroyTrouser, oliveTrouser, matchingBlackTrouser],
    { search: fakeSearch },
  );
  assert.ok(matched);
  assert.equal(matched.id, matchingBlackTrouser.id);
  assert.equal(calls.length, 0);
});

test('matchSuit runs one targeted search when the matching trouser is missing from initial candidates, then falls back to formal same-colour trousers', async () => {
  const tuxJacket = makeItem('Red Carpet Tuxedo Jacket - Black', 55.99);
  const tuxTrouser = makeItem('Red Carpet Tuxedo Trouser - Black', 34.99);
  const calls: string[] = [];

  const foundViaSearch = await matchSuit(
    tuxJacket,
    [makeItem('The Modern Stretch Slim Trouser - Olive', 25)],
    {
      search: async (query: string): Promise<SearchResult> => {
        calls.push(query);
        return { items: [tuxTrouser], source: 'live', ms: 1 };
      },
    },
  );
  assert.ok(foundViaSearch);
  assert.equal(foundViaSearch.id, tuxTrouser.id);
  assert.deepEqual(calls, ['red carpet trouser black']);

  const navyBlazer = makeItem('Tropical Wool Blazer | Dark Navy', 149, { store: 'Everlane' });
  const navySuitTrouser = makeItem('Tropical Wool Trouser | Dark Navy', 119, { store: 'Everlane' });
  const blackTrouser = makeItem('Tailored Suit Trouser - Black', 40);
  const fallback = await matchSuit(
    navyBlazer,
    [blackTrouser, navySuitTrouser],
    {
      search: async (): Promise<SearchResult> => ({ items: [], source: 'live', ms: 1 }),
    },
  );
  assert.ok(fallback);
  assert.equal(fallback.id, navySuitTrouser.id);
});

test('fitFormalBudget trades down suit, shirt, and shoes first, always keeping the solid silk tie and reporting overage if still over budget', () => {
  const woolBlazer = makeItem('Tropical Wool Blazer | Dark Navy', 149, { store: 'Everlane' });
  const woolTrouser = makeItem('Tropical Wool Trouser | Dark Navy', 119, { store: 'Everlane' });
  const modernJacket = makeItem('The Modern Stretch Suit Jacket - Black', 35);
  const modernTrouser = makeItem('The Modern Stretch Slim Trouser - Black', 25);
  const priceyShirt = makeItem('Maison Tailored Wrinkle Free Dress Shirt - White', 30.99);
  const budgetShirt = makeItem('Luxe Stretch Dress Shirt - White', 16);
  const leland = makeItem('LELAND BLACK LEATHER', 129.95, { store: 'Steve Madden' });
  const patent = makeItem('Faux Patent Leather Lace Up Oxford Shoes - Black', 34.99);
  const tie = makeItem('Giorgio Armani & Kith Silk Tie - Nocturnal', 245, { store: 'Kith' });

  const initial: Piece[] = [
    { slot: 'layer', why: 'Blazer', item: woolBlazer },
    { slot: 'top', why: 'Shirt', item: priceyShirt },
    { slot: 'bottom', why: 'Trouser', item: woolTrouser },
    { slot: 'shoes', why: 'Shoes', item: leland },
    { slot: 'accessory', why: 'Tie', item: tie },
  ];

  const ranked = new Map<Slot, Item[]>([
    ['layer', [woolBlazer, modernJacket]],
    ['bottom', [woolTrouser, modernTrouser]],
    ['top', [priceyShirt, budgetShirt]],
    ['shoes', [leland, patent]],
    ['accessory', [tie]],
  ]);
  const pool = new Map(ranked);

  // At $400 budget, trading down suit + shoes + shirt fits under $400 while keeping the $245 tie!
  const problems400: string[] = [];
  const fitted400 = fitFormalBudget(
    'Midnight Navy',
    initial,
    ranked,
    pool,
    { gender: 'men', occasion: 'black tie optional gala', budget_usd: 400 },
    new Set(),
    problems400,
    whyFor,
  );
  assert.equal(fitted400.find((p) => p.slot === 'accessory')?.item.id, tie.id);
  assert.equal(fitted400.find((p) => p.slot === 'layer')?.item.id, modernJacket.id);
  assert.equal(fitted400.find((p) => p.slot === 'bottom')?.item.id, modernTrouser.id);
  const total400 = fitted400.reduce((s, p) => s + p.item.price, 0);
  assert.ok(total400 <= 400);

  // At $250 budget, even cheapest formal pieces + $245 tie exceed $250 -> keep the tie and report overage!
  const problems250: string[] = [];
  const fitted250 = fitFormalBudget(
    'Classic Black Suit',
    initial,
    ranked,
    pool,
    { gender: 'men', occasion: 'black tie optional gala', budget_usd: 250 },
    new Set(),
    problems250,
    whyFor,
  );
  assert.equal(fitted250.find((p) => p.slot === 'accessory')?.item.id, tie.id);
  assert.equal(fitted250.find((p) => p.slot === 'layer')?.item.id, modernJacket.id);
  assert.equal(fitted250.find((p) => p.slot === 'bottom')?.item.id, modernTrouser.id);
  assert.equal(fitted250.find((p) => p.slot === 'top')?.item.id, budgetShirt.id);
  assert.equal(fitted250.find((p) => p.slot === 'shoes')?.item.id, patent.id);
  assert.ok(problems250.some((p) => p.includes('over $250 budget') && p.includes('kept solid silk tie')));
});

test('at $500+ budget, formalScoreBoost prefers Everlane Tropical Wool and Steve Madden leather shoes over cheapest pieces', () => {
  const brief: Brief = { gender: 'men', occasion: 'black tie optional gala', budget_usd: 600 };
  const leland = makeItem('LELAND BLACK LEATHER', 129.95, {
    store: 'Steve Madden',
    description: 'The LELAND lace-up dress shoe combines classic style.',
  });
  const cheapOxford = makeItem('Faux Patent Leather Lace Up Oxford Shoes - Black', 34.99);

  const lelandScore =
    scoreItem(leland, "men's black leather oxford shoes", 'shoes') +
    formalScoreBoost(leland, 'shoes', "men's black leather oxford shoes", brief);
  const cheapScore =
    scoreItem(cheapOxford, "men's black leather oxford shoes", 'shoes') +
    formalScoreBoost(cheapOxford, 'shoes', "men's black leather oxford shoes", brief);
  assert.ok(lelandScore > cheapScore, `expected Steve Madden (${lelandScore}) > cheap oxford (${cheapScore})`);

  const woolBlazer = makeItem('Tropical Wool Blazer | Dark Navy', 149, { store: 'Everlane' });
  const cheapBlazer = makeItem('The Modern Stretch Suit Jacket - Black', 35);
  const woolScore =
    scoreItem(woolBlazer, "men's navy wool blazer", 'layer') +
    formalScoreBoost(woolBlazer, 'layer', "men's navy wool blazer", brief);
  const cheapBlazerScore =
    scoreItem(cheapBlazer, "men's navy wool blazer", 'layer') +
    formalScoreBoost(cheapBlazer, 'layer', "men's navy wool blazer", brief);
  assert.ok(woolScore > cheapBlazerScore);
});

test('black-tie occasion budgets have realistic men budgets while keeping women budgets unchanged', () => {
  const gala = OCCASIONS.find((o) => o.key === 'gala')!;
  assert.deepEqual(gala.budget, { men: 600, women: 250 });

  const byKey = (k: string) => EXTRA_OCCASIONS.find((o) => o.key === k)!;
  assert.deepEqual(byKey('black-tie-wedding').budget, { men: 700, women: 285 });
  assert.deepEqual(byKey('formal-charity-dinner').budget, { men: 600, women: 265 });
  assert.deepEqual(byKey('opera-or-ballet-night').budget, { men: 500, women: 255 });
  assert.deepEqual(byKey('awards-ceremony').budget, { men: 500, women: 290 });
});

test('formal dedupe exempts the accessory slot so multiple black-tie looks can share the same solid tie', () => {
  const nocturnal = makeItem('Giorgio Armani & Kith Silk Tie - Nocturnal', 245, { store: 'Kith' });
  const altTie = makeItem('Giorgio Armani & Kith Silk Tie - Concrete', 245, { store: 'Kith' });
  const jacket2 = makeItem('Tropical Wool Blazer | Dark Navy', 149, { store: 'Everlane' });
  const trouser2 = makeItem('Tropical Wool Trouser | Dark Navy', 119, { store: 'Everlane' });
  const shirt1 = makeItem('Maison Tailored Wrinkle Free Dress Shirt - White', 30.99);
  const shirt2 = makeItem('Wrinkle Resistant Stretch Satin Finish Dress Shirt - White', 23.99);
  const shoes2 = makeItem('LELAND BLACK LEATHER', 129.95, { store: 'Steve Madden' });

  const pieces: Piece[] = [
    { slot: 'layer', why: 'Blazer', item: jacket2 },
    { slot: 'top', why: 'Shirt', item: shirt1 },
    { slot: 'bottom', why: 'Trouser', item: trouser2 },
    { slot: 'shoes', why: 'Shoes', item: shoes2 },
    { slot: 'accessory', why: 'Tie', item: nocturnal },
  ];
  const ranked = new Map<Slot, Item[]>([
    ['top', [shirt1, shirt2]],
    ['accessory', [nocturnal, altTie]],
  ]);
  const taken = new Set<string>([shirt1.id, nocturnal.id]);
  const problems: string[] = [];

  const result = dedupe('Midnight Navy', pieces, ranked, taken, problems, true);
  assert.ok(result);
  // Shirt is still deduped to shirt2, while the solid Nocturnal tie is kept despite being in taken.
  assert.equal(result.find((p) => p.slot === 'top')?.item.id, shirt2.id);
  assert.equal(result.find((p) => p.slot === 'accessory')?.item.id, nocturnal.id);
});

