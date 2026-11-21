import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Outfit } from '../src/types.ts';
import {
  areSizesEquivalent,
  extractLatestSizesFromTurns,
  extractSizesFromSpeech,
  inferAccessoryDefaultSize,
  inferBeltSize,
  isBeltPiece,
  parseSizesFromStoreReason,
  resolveOutfitSizes,
} from '../src/agent/sizing.ts';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    variant_id: 'var-1',
    title: 'Sample Item',
    price: 50,
    url: 'https://example.com/item',
    image: 'https://cdn.example.com/item.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.7,
    rating_count: 20,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description: 'Clean staple.',
    department: 'men',
    ...overrides,
  };
}

test('extractSizesFromSpeech parses real-call phrasings, spoken halves, widths, and by-forms', () => {
  assert.deepEqual(extractSizesFromSpeech('Medium top, 32 waist, shoes 10 and a half.'), {
    top: 'M',
    bottom: '32',
    shoes: '10.5',
  });

  assert.deepEqual(extractSizesFromSpeech('medium top'), { top: 'M' });
  assert.deepEqual(extractSizesFromSpeech('32 waist'), { bottom: '32' });
  assert.deepEqual(extractSizesFromSpeech('30 by 34'), { bottom: '30x34' });
  assert.deepEqual(extractSizesFromSpeech('thirty by thirty four'), { bottom: '30x34' });
  assert.deepEqual(extractSizesFromSpeech('thirty-two waist'), { bottom: '32' });
  assert.deepEqual(extractSizesFromSpeech('shoes 10 and a half'), { shoes: '10.5' });
  assert.deepEqual(extractSizesFromSpeech('ten and a half shoes'), { shoes: '10.5' });
  assert.deepEqual(extractSizesFromSpeech('shoes 10 1/2'), { shoes: '10.5' });
  assert.deepEqual(extractSizesFromSpeech('shoes 10½'), { shoes: '10.5' });
  assert.deepEqual(extractSizesFromSpeech('8.5 wide'), { shoes: '8.5 wide' });
  assert.deepEqual(extractSizesFromSpeech('eight and a half wide'), { shoes: '8.5 wide' });
  assert.deepEqual(extractSizesFromSpeech('size 12 shoe'), { shoes: '12' });
  assert.deepEqual(extractSizesFromSpeech("I'm a large"), { top: 'L' });
  assert.deepEqual(extractSizesFromSpeech('I wear an extra large'), { top: 'XL' });
  assert.deepEqual(extractSizesFromSpeech('W32 L30'), { bottom: '32x30' });
  assert.deepEqual(extractSizesFromSpeech('32 waist, 34 inseam'), { bottom: '32x34' });
  assert.deepEqual(extractSizesFromSpeech('EU 42 shoes'), { shoes: 'EU 42' });
  assert.deepEqual(extractSizesFromSpeech('medium, 32, 10.5'), {
    top: 'M',
    bottom: '32',
    shoes: '10.5',
  });
  assert.deepEqual(extractSizesFromSpeech('large, 30 by 34, 11'), {
    top: 'L',
    bottom: '30x34',
    shoes: '11',
  });
});

test('extractSizesFromSpeech ignores prices, budgets, ratings, times, and non-size words', () => {
  assert.deepEqual(extractSizesFromSpeech('400 dollars'), {});
  assert.deepEqual(extractSizesFromSpeech('under 300'), {});
  assert.deepEqual(extractSizesFromSpeech('My budget is 400 dollars, keep it under 300.'), {});
  assert.deepEqual(extractSizesFromSpeech('Something around 250 bucks or $200.'), {});
  assert.deepEqual(extractSizesFromSpeech('Spending 150 to 200 max.'), {});
  assert.deepEqual(extractSizesFromSpeech('I like look 2, maybe 8 out of 10 at 7 pm.'), {});
  assert.deepEqual(extractSizesFromSpeech("It's a small wedding with a large group."), {});
  assert.deepEqual(extractSizesFromSpeech("I'm a small business owner."), {});
  assert.deepEqual(extractSizesFromSpeech('Medium top, budget is under 300 dollars'), {
    top: 'M',
  });
  assert.deepEqual(extractSizesFromSpeech('Under 300 bucks, I wear a large, 34 waist, 11 shoes'), {
    top: 'L',
    bottom: '34',
    shoes: '11',
  });
});

test('extractLatestSizesFromTurns merges across turns preferring the most recent turn per slot', () => {
  const turns = [
    'My budget is 400 dollars.',
    'I wear a large top and 34 waist.',
    'Actually medium top, and shoes 10 and a half.',
  ];
  assert.deepEqual(extractLatestSizesFromTurns(turns), {
    top: 'M',
    bottom: '34',
    shoes: '10.5',
  });
});

test('areSizesEquivalent recognizes equivalent spellings and flags real differences', () => {
  assert.equal(areSizesEquivalent('top', 'medium', 'M'), true);
  assert.equal(areSizesEquivalent('top', 'extra large', 'XL'), true);
  assert.equal(areSizesEquivalent('top', 'L', 'M'), false);

  assert.equal(areSizesEquivalent('bottom', '30 by 34', '30x34'), true);
  assert.equal(areSizesEquivalent('bottom', '32 waist', '32'), true);
  assert.equal(areSizesEquivalent('bottom', '32', '34'), false);
  assert.equal(areSizesEquivalent('bottom', '30x34', '30x32'), false);

  assert.equal(areSizesEquivalent('shoes', '10 and a half', '10.5'), true);
  assert.equal(areSizesEquivalent('shoes', '8.5 W', '8.5 wide'), true);
  assert.equal(areSizesEquivalent('shoes', '10.5', '11'), false);
  assert.equal(areSizesEquivalent('shoes', '8.5', '8.5 wide'), false);
});

test('inferBeltSize maps numeric waist to closest numeric belt, cm belt, and S/M/L belts', () => {
  // Exact numeric waist -> numeric belt
  assert.equal(inferBeltSize('32', ['30', '32', '34', '36'], 'men'), '32');
  assert.equal(inferBeltSize('30x34', ['30', '32', '34', '36'], 'men'), '30');
  // In-between numeric waist rounds up on tie
  assert.equal(inferBeltSize('33', ['30', '32', '34', '36'], 'men'), '34');
  // EU cm belts (32 in * 2.54 = 81.28 cm -> closest is 80 cm; 34 in * 2.54 = 86.36 -> 85 cm)
  assert.equal(inferBeltSize('34', ['80 cm', '85 cm', '90 cm', '95 cm'], 'men'), '85 cm');
  // Numeric waist -> S/M/L
  assert.equal(inferBeltSize('30', ['S', 'M', 'L', 'XL'], 'men'), 'S');
  assert.equal(inferBeltSize('32', ['S', 'M', 'L', 'XL'], 'men'), 'M');
  assert.equal(inferBeltSize('35', ['S', 'M', 'L', 'XL'], 'men'), 'L');
  // Combo labels
  assert.equal(inferBeltSize('32', ['S/M', 'L/XL'], 'men'), 'S/M');
  assert.equal(inferBeltSize('36', ['S/M', 'L/XL'], 'men'), 'L/XL');
  // Women's numeric bottom size -> S/M/L
  assert.equal(inferBeltSize('6', ['XS', 'S', 'M', 'L'], 'women'), 'S');
  assert.equal(inferBeltSize('8', ['XS', 'S', 'M', 'L'], 'women'), 'M');
  // Letter bottom -> numeric belt
  assert.equal(inferBeltSize('M', ['30', '32', '34', '36'], 'men'), '32');
});

test('inferAccessoryDefaultSize prefers one-size option and otherwise picks the middle size', () => {
  assert.equal(inferAccessoryDefaultSize(['S', 'M', 'L']), 'M');
  assert.equal(inferAccessoryDefaultSize(['S', 'M', 'L', 'XL']), 'M');
  assert.equal(inferAccessoryDefaultSize(['Small', 'One Size', 'Large']), 'One Size');
  assert.equal(inferAccessoryDefaultSize(['OSFA']), 'OSFA');
  assert.equal(inferAccessoryDefaultSize([]), null);
});

test('resolveOutfitSizes infers jacket from top, belt from bottom, and accessory default; only reports top/bottom/shoes missing', () => {
  const outfit: Outfit = {
    number: 1,
    name: 'Layered City',
    difference: 'Full layered look with belt and hat.',
    story: 'Sharp layers.',
    total: 350,
    pieces: [
      { slot: 'top', why: 'Base.', item: makeItem({ id: 't1', title: 'Cotton Tee', sizes: ['S', 'M', 'L'] }) },
      { slot: 'bottom', why: 'Trouser.', item: makeItem({ id: 'b1', title: 'Wool Trouser', sizes: ['30', '32', '34'] }) },
      { slot: 'layer', why: 'Outerwear.', item: makeItem({ id: 'l1', title: 'Suede Bomber Jacket', sizes: ['S', 'M', 'L'] }) },
      { slot: 'shoes', why: 'Footwear.', item: makeItem({ id: 's1', title: 'Leather Loafer', sizes: ['9', '10', '11'] }) },
      { slot: 'accessory', why: 'Waist finish.', item: makeItem({ id: 'a1', title: 'Braided Leather Belt', sizes: ['30', '32', '34', '36'] }) },
      { slot: 'bag', why: 'Carry.', item: makeItem({ id: 'a2', title: 'Canvas Tote', sizes: ['Small', 'Medium', 'Large'] }) },
    ],
  };

  assert.equal(isBeltPiece(outfit.pieces[4]!), true);
  assert.equal(isBeltPiece(outfit.pieces[2]!), false);

  // With nothing given yet: missingSlots is ONLY top, bottom, shoes (never layer, accessory, belt, bag).
  const empty = resolveOutfitSizes(outfit, {}, 'men');
  assert.deepEqual(empty.missingSlots, ['top', 'bottom', 'shoes']);

  // With top, bottom, shoes given: layer->M, belt->32, bag->Medium inferred!
  const full = resolveOutfitSizes(outfit, { top: 'M', bottom: '32', shoes: '10' }, 'men');
  assert.deepEqual(full.missingSlots, []);
  assert.equal(full.resolvedSizes.layer, 'M');
  assert.equal(full.resolvedSizes.accessory, '32');
  assert.equal(full.resolvedSizes.bag, 'Medium');
  assert.deepEqual(full.inferred, { layer: 'M', belt: '32', bag: 'Medium' });
  assert.equal(full.inferredJacket, true);
  assert.equal(full.inferredBelt, true);
});

test('parseSizesFromStoreReason extracts available size labels from store missing-size reason', () => {
  assert.deepEqual(
    parseSizesFromStoreReason('no accessory size given (sizes: S, M, L)'),
    ['S', 'M', 'L'],
  );
  assert.deepEqual(parseSizesFromStoreReason('sold out'), []);
});
