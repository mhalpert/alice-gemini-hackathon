// The live swap against a fake store: colour-true, cheaper, keep-type, honest when nothing fits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapLive, readRequest } from '../src/brain/swap.ts';
import { swapPiece } from '../src/brain/index.ts';
import { breaksDressCode } from '../src/brain/words.ts';
import type { Brief, Item, Outfit, SearchResult } from '../src/types.ts';

const brief: Brief = { gender: 'men', occasion: "a friend's rooftop birthday", budget_usd: 150 };

let n = 0;
function item(title: string, price: number, extra: Partial<Item> = {}): Item {
  n += 1;
  return {
    id: `p${n}`, variant_id: `v${n}`, title, price, url: 'https://example.com', image: 'https://cdn.shopify.com/x.jpg',
    store: 'Steve Madden', store_domain: 'stevemadden.myshopify.com', rating: 4.5, rating_count: 20,
    sizes: ['10', '11'], variants_by_size: {}, description: '', department: 'men', ...extra,
  };
}

const boots = item('Chelsea Boot - Black Leather', 60);
const look: Outfit = {
  number: 2, name: 'Midnight Roof', difference: 'All dark', story: 'The Chelsea Boot keeps it sharp.',
  pieces: [
    { slot: 'top', why: '', item: item('Linen Shirt - Navy', 40, { store: 'Everlane' }) },
    { slot: 'bottom', why: '', item: item('Slim Chino - Black', 35) },
    { slot: 'shoes', why: '', item: boots },
  ],
  total: 135,
};

const stock = [
  item('Hayes Lace-Up Boot - Black', 55),
  item('Hayes Lace-Up Boot - Cognac Leather', 58),
  item('Court Sneaker - Brown Suede', 45),
  item('Penny Loafer - Tan', 50),
  item('Runner Sneaker - White', 30),
  item('Womens Heeled Boot - Brown', 40, { department: 'women' }),
];

function fakeSearch(calls: string[]) {
  return async (q: string, _g: string, opts: { maxPrice?: number }): Promise<SearchResult> => {
    calls.push(q);
    return { items: stock.filter((i) => i.price <= (opts.maxPrice ?? Infinity)), source: 'live', ms: 1 };
  };
}

test('reads the request: colour, the type after "for", cheaper', () => {
  const a = readRequest('swap the black boots for brown boots', boots, 'shoes');
  assert.equal(a.colour?.word, 'brown');
  assert.equal(a.type?.word, 'boots');
  assert.equal(a.typeAsked, true);
  const b = readRequest('something cheaper', boots, 'shoes');
  assert.equal(b.cheaper, true);
  assert.equal(b.type?.word, 'boots');
  assert.equal(b.typeAsked, false);
  assert.equal(readRequest('different shoes', boots, 'shoes').typeAsked, false);
});

test('"black boots for brown boots" returns brown boots and searches for them', async () => {
  const calls: string[] = [];
  const out = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, { search: fakeSearch(calls), rewrite: false });
  assert.equal(out.piece.item.title, 'Hayes Lace-Up Boot - Cognac Leather');
  assert.equal(calls[0], "men's brown boots");
  assert.equal(out.outfit.total, 133);
  assert.equal(out.outfit.pieces.find((p) => p.slot === 'shoes')!.item.id, out.piece.item.id);
  assert.equal(out.note, undefined);
});

test('"something cheaper" lowers the total and keeps the type', async () => {
  const out = await swapLive(look, 'shoes', 'something cheaper', brief, { search: fakeSearch([]), rewrite: false });
  assert.ok(out.outfit.total < look.total);
  assert.match(out.piece.item.title, /Boot/);
  assert.match(out.note ?? '', /Saves \$/);
});

test('an impossible colour keeps the piece and says so', async () => {
  const out = await swapLive(look, 'shoes', 'purple boots', brief, { search: fakeSearch([]), rewrite: false });
  assert.equal(out.piece.item.id, boots.id);
  assert.equal(out.outfit.total, look.total);
  assert.match(out.note ?? '', /No purple boots in stock/);
});

test('a store failure keeps the piece instead of throwing', async () => {
  const out = await swapLive(look, 'shoes', 'brown boots', brief, { search: async () => { throw new Error('429'); }, rewrite: false });
  assert.equal(out.piece.item.id, boots.id);
  assert.ok(out.note);
});

test('never the other department, never a piece already in the look', async () => {
  const out = await swapLive(look, 'shoes', 'brown', brief, { search: fakeSearch([]), rewrite: false });
  assert.equal(out.piece.item.department, 'men');
  assert.notEqual(out.piece.item.id, boots.id);
  assert.match(out.piece.item.title, /Brown|Cognac|Tan/);
});

test('a slot the look does not have changes nothing', async () => {
  const out = await swapLive(look, 'bag', 'a black bag', brief, { search: fakeSearch([]), rewrite: false });
  assert.equal(out.outfit.total, look.total);
  assert.match(out.note ?? '', /no bag/);
});

test('breaksDressCode rejects novelty/printed ties at formal occasions and interviews regardless of slot', () => {
  const gala = { occasion: 'black tie optional gala', gender: 'men' };
  const interview = { occasion: 'investment bank interview', gender: 'women' };
  const birthday = { occasion: "a friend's rooftop birthday party", gender: 'men' };

  // Knicks tie at a gala is rejected in any slot
  assert.equal(
    breaksDressCode({ title: 'Kith for the New York Knicks Silk Tie' }, 'accessory', gala),
    true,
  );
  assert.equal(
    breaksDressCode({ title: 'Kith for the New York Knicks Silk Tie' }, 'top', gala),
    true,
  );

  // Printed tie at a gala is rejected (via title or description)
  assert.equal(
    breaksDressCode({ title: 'Kith Printed Silk Neck Tie - Sage' }, 'accessory', gala),
    true,
  );
  assert.equal(
    breaksDressCode({ title: 'Classic Silk Necktie', description: 'Features an allover paisley pattern' }, 'accessory', interview),
    true,
  );

  // "Solid Silk Tie - Black" at a gala passes
  assert.equal(
    breaksDressCode({ title: 'Solid Silk Tie - Black' }, 'accessory', gala),
    false,
  );

  // A printed tie at a rooftop birthday passes
  assert.equal(
    breaksDressCode({ title: 'Kith Printed Silk Neck Tie - Sage' }, 'accessory', birthday),
    false,
  );

  // "Tie Front Blouse" at an interview passes
  assert.equal(
    breaksDressCode({ title: 'Tie Front Blouse', description: 'Printed floral blouse' }, 'top', interview),
    false,
  );

  // Existing wedding guest white rule still works alongside formal tie rule
  const formalWedding = { occasion: 'formal wedding reception', gender: 'women' };
  assert.equal(breaksDressCode({ title: 'Ivory Satin Dress' }, 'dress', formalWedding), true);
  assert.equal(
    breaksDressCode({ title: 'Striped Silk Tie' }, 'accessory', { occasion: 'formal wedding', gender: 'men' }),
    true,
  );
});

function fakeSearchFrom(items: Item[], calls: string[] = []) {
  return async (q: string, _g: string, opts: { maxPrice?: number }): Promise<SearchResult> => {
    calls.push(q);
    return { items: items.filter((i) => i.price <= (opts.maxPrice ?? Infinity)), source: 'live', ms: 1 };
  };
}

test('"brown boots" with sizes.shoes 11 picks the in-size boot over a higher-scored out-of-size one', async () => {
  const highScoredNo11 = item('Chelsea Boot - Brown Leather', 55, {
    rating: 5.0, rating_count: 500, sizes: ['9', '10'],
  });
  const lowerScoredHas11 = item('Work Boot - Brown', 65, {
    rating: 3.5, rating_count: 2, sizes: ['10.0', '11.0'],
  });
  const catalog = [highScoredNo11, lowerScoredHas11];

  // Without sizes: the higher-scored boot wins (identical to today).
  const withoutSizes = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, {
    search: fakeSearchFrom(catalog), rewrite: false,
  });
  assert.equal(withoutSizes.piece.item.id, highScoredNo11.id);
  assert.equal(withoutSizes.note, undefined);

  // With sizes.shoes '11': the in-size boot wins (11 matches 11.0 via matchSizeLabel).
  const withSizes = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, {
    search: fakeSearchFrom(catalog), rewrite: false, sizes: { shoes: '11' },
  });
  assert.equal(withSizes.piece.item.id, lowerScoredHas11.id);
  assert.equal(withSizes.note, undefined);
});

test('when no candidate has the requested size, returns the best candidate with an honest note', async () => {
  const highScored = item('Chelsea Boot - Brown Leather', 55, {
    rating: 5.0, rating_count: 500, sizes: ['8', '9', '10'],
  });
  const lowerScored = item('Work Boot - Brown', 65, {
    rating: 3.5, rating_count: 2, sizes: ['7', '8'],
  });
  const out = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, {
    search: fakeSearchFrom([highScored, lowerScored]), rewrite: false, sizes: { shoes: '11' },
  });
  assert.equal(out.piece.item.id, highScored.id);
  assert.equal(
    out.note,
    'Heads up: no shoes like that in size 11; this one is in 8, 9, 10.',
  );
});

test('no sizes option gives the identical result to today', async () => {
  const callsA: string[] = [];
  const callsB: string[] = [];
  const a = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, {
    search: fakeSearch(callsA), rewrite: false,
  });
  const b = await swapLive(look, 'shoes', 'swap the black boots for brown boots', brief, {
    search: fakeSearch(callsB), rewrite: false, sizes: undefined,
  });
  assert.deepEqual(b, a);
  assert.deepEqual(callsB, callsA);
});

test('a top swap uses sizes.top and matches canonical labels like L -> Large', async () => {
  const highScoredNoL = item('Oxford Shirt - White', 40, {
    rating: 5.0, rating_count: 300, sizes: ['Small', 'Medium'],
  });
  const inSizeL = item('Cotton Shirt - White', 45, {
    rating: 3.5, rating_count: 2, sizes: ['Medium', 'Large'],
  });
  const out = await swapLive(look, 'top', 'a white shirt', brief, {
    search: fakeSearchFrom([highScoredNoL, inSizeL]), rewrite: false, sizes: { top: 'L', shoes: '11' },
  });
  assert.equal(out.piece.item.id, inSizeL.id);
  assert.equal(out.note, undefined);
});

test('bottom swap uses sizes.bottom (34 matches 34x32), unknown sizes rank below known matches, and accessory ignores sizes', async () => {
  const no34 = item('Slim Chino - Navy', 35, { rating: 5.0, rating_count: 300, sizes: ['30x32', '32x32'] });
  const unknownSizes = item('Tailored Chino - Navy', 36, { rating: 5.0, rating_count: 400, sizes: [] });
  const has34 = item('Stretch Chino - Navy', 40, { rating: 3.5, rating_count: 2, sizes: ['32x32', '34x32'] });

  // Known match beats both out-of-size and unknown-size higher-scored items.
  const knownWins = await swapLive(look, 'bottom', 'navy chinos', brief, {
    search: fakeSearchFrom([no34, unknownSizes, has34]), rewrite: false, sizes: { bottom: '34' },
  });
  assert.equal(knownWins.piece.item.id, has34.id);
  assert.equal(knownWins.note, undefined);

  // When no known match exists, unknown-size candidate is treated as a match (no heads-up note).
  const unknownWins = await swapLive(look, 'bottom', 'navy chinos', brief, {
    search: fakeSearchFrom([no34, unknownSizes]), rewrite: false, sizes: { bottom: '34' },
  });
  assert.equal(unknownWins.piece.item.id, unknownSizes.id);
  assert.equal(unknownWins.note, undefined);

  // Accessory slot ignores sizes completely.
  const lookWithAcc: Outfit = {
    ...look,
    pieces: [...look.pieces, { slot: 'accessory', why: '', item: item('Leather Belt - Black', 15, { sizes: ['M'] }) }],
    total: 150,
  };
  const accItem = item('Leather Belt - Brown', 15, { sizes: ['S'] });
  const accOut = await swapLive(lookWithAcc, 'accessory', 'brown belt', brief, {
    search: fakeSearchFrom([accItem]), rewrite: false, sizes: { top: 'XL', bottom: '38', shoes: '13' },
  });
  assert.equal(accOut.piece.item.id, accItem.id);
  assert.equal(accOut.note, undefined);

  // Layer uses sizes.top.
  const lookWithLayer: Outfit = {
    ...look,
    pieces: [...look.pieces, { slot: 'layer', why: '', item: item('Bomber Jacket - Black', 15, { sizes: ['L'] }) }],
    total: 150,
  };
  const layerNoL = item('Denim Jacket - Navy', 15, { rating: 5.0, rating_count: 300, sizes: ['S', 'M'] });
  const layerHasL = item('Field Jacket - Navy', 15, { rating: 3.5, rating_count: 2, sizes: ['L', 'XL'] });
  const layerOut = await swapLive(lookWithLayer, 'layer', 'navy jacket', brief, {
    search: fakeSearchFrom([layerNoL, layerHasL]), rewrite: false, sizes: { top: 'L' },
  });
  assert.equal(layerOut.piece.item.id, layerHasL.id);
  assert.equal(layerOut.note, undefined);
});

test('mock swapPiece accepts sizes option and ignores it', async () => {
  const prevBrain = process.env.ALICE_BRAIN;
  const prevPace = process.env.ALICE_MOCK_PACE;
  process.env.ALICE_BRAIN = 'mock';
  process.env.ALICE_MOCK_PACE = '0';
  try {
    const a = await swapPiece(look, 'shoes', 'brown', brief);
    const b = await swapPiece(look, 'shoes', 'brown', brief, { sizes: { shoes: '15' } });
    assert.deepEqual(b, a);
  } finally {
    if (prevBrain === undefined) delete process.env.ALICE_BRAIN; else process.env.ALICE_BRAIN = prevBrain;
    if (prevPace === undefined) delete process.env.ALICE_MOCK_PACE; else process.env.ALICE_MOCK_PACE = prevPace;
  }
});
