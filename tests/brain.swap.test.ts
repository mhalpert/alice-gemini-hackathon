// The live swap against a fake store: colour-true, cheaper, keep-type, honest when nothing fits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapLive, readRequest } from '../src/brain/swap.ts';
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
