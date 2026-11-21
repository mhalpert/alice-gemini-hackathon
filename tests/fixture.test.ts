// Checks that the call page's fixture matches the shared types, field by field.
// Node runs this file directly; there is no build step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Brief, Item, Outfit } from '../src/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../public/fixture.json', import.meta.url), 'utf8')) as {
  brief: Brief;
  outfits: Outfit[];
};

const SLOTS = ['top', 'bottom', 'dress', 'layer', 'shoes', 'accessory', 'bag', 'jewelry'];
const STORES = ['Fashion Nova', 'Everlane', 'Steve Madden', 'Kith'];

function assertItem(item: Item, where: string) {
  for (const key of ['id', 'variant_id', 'title', 'url', 'image', 'store', 'store_domain', 'description'] as const) {
    assert.equal(typeof item[key], 'string', `${where}: ${key} must be a string`);
    assert.ok(item[key].length > 0 || key === 'description', `${where}: ${key} must not be empty`);
  }
  assert.equal(typeof item.price, 'number', `${where}: price must be a number`);
  assert.ok(item.price > 0 && item.price < 10000, `${where}: price must be in dollars, not cents`);
  assert.ok(item.rating === null || typeof item.rating === 'number', `${where}: rating`);
  assert.ok(item.rating_count === null || typeof item.rating_count === 'number', `${where}: rating_count`);
  assert.ok(Array.isArray(item.sizes), `${where}: sizes must be a list`);
  assert.equal(typeof item.variants_by_size, 'object', `${where}: variants_by_size`);
  assert.ok(STORES.includes(item.store), `${where}: unknown store "${item.store}"`);
  assert.ok(item.image.startsWith('https://'), `${where}: image must be an https URL`);
  assert.ok(!/[?&]width=/.test(item.image), `${where}: image must not carry a width parameter`);
  assert.ok(['men', 'women'].includes(item.department), `${where}: department`);
}

test('the fixture has a brief and exactly three looks', () => {
  assert.equal(typeof fixture.brief.occasion, 'string');
  assert.equal(typeof fixture.brief.budget_usd, 'number');
  assert.equal(fixture.outfits.length, 3);
  assert.deepEqual(fixture.outfits.map((o) => o.number), [1, 2, 3]);
});

test('every look is complete and its pieces match the Item type', () => {
  for (const outfit of fixture.outfits) {
    const where = `look ${outfit.number}`;
    for (const key of ['name', 'difference', 'story'] as const) {
      assert.ok(typeof outfit[key] === 'string' && outfit[key].length > 0, `${where}: ${key}`);
    }
    const slots = outfit.pieces.map((p) => p.slot);
    assert.ok(slots.includes('shoes'), `${where}: needs shoes`);
    assert.ok(slots.includes('dress') || (slots.includes('top') && slots.includes('bottom')), `${where}: needs a top and bottom, or a dress`);
    assert.equal(new Set(slots).size, slots.length, `${where}: a slot appears twice`);
    for (const piece of outfit.pieces) {
      assert.ok(SLOTS.includes(piece.slot), `${where}: unknown slot "${piece.slot}"`);
      assert.ok(piece.why.length > 0, `${where}: ${piece.slot} needs a why`);
      assertItem(piece.item, `${where} ${piece.slot}`);
    }
  }
});

test('each total is the sum of its pieces and fits the budget', () => {
  for (const outfit of fixture.outfits) {
    const sum = Math.round(outfit.pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
    assert.equal(outfit.total, sum, `look ${outfit.number}: total`);
    assert.ok(outfit.total <= fixture.brief.budget_usd, `look ${outfit.number}: $${outfit.total} is over the $${fixture.brief.budget_usd} budget`);
  }
});

test('no product appears in two looks', () => {
  const ids = fixture.outfits.flatMap((o) => o.pieces.map((p) => p.item.id));
  assert.equal(new Set(ids).size, ids.length);
});
