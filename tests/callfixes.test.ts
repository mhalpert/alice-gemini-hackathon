// Unit tests for Mike's 3:11 call fixes:
// 1. Men's formal wedding detection in isMenBlackTie
// 2. All-caps Steve Madden model-name rejection in accessory / jewelry slots
// 3. spendUp budget utilization + gate-passing ordering in build.ts + pick.ts budget prompt
// 4. Men's white dress shirt allowed at weddings (DRESS_CODE, repairPlan, breaksDressCode)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMenBlackTie } from '../src/brain/formal.ts';
import { breaksDressCode, wrongSlot } from '../src/brain/words.ts';
import { compareJudged, pickRest, spendUp } from '../src/brain/build.ts';
import { DRESS_CODE, repairPlan, type Slot } from '../src/brain/plan.ts';
import type { Brief, Item, Piece } from '../src/types.ts';

let seq = 0;
function makeItem(title: string, price: number, extra: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `cf-prod-${seq}`,
    variant_id: `cf-var-${seq}`,
    title,
    price,
    url: `https://example.com/cf/${seq}`,
    image: `https://cdn.example.com/cf-${seq}.jpg`,
    store: 'Fashion Nova',
    store_domain: 'fnova.myshopify.com',
    rating: 4.5,
    rating_count: 20,
    sizes: ['M', 'L'],
    variants_by_size: {},
    description: title,
    department: 'men',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Men's formal wedding -> formal plan
// ---------------------------------------------------------------------------

test('isMenBlackTie matches formal wedding phrasings and keeps casual/outdoor weddings out', () => {
  for (const occasion of [
    'formal wedding',
    'black tie wedding',
    'cocktail attire wedding',
    'evening wedding',
    'tuxedo',
  ]) {
    assert.equal(isMenBlackTie({ gender: 'men', occasion }), true, `expected men "${occasion}" to match`);
    assert.equal(isMenBlackTie({ gender: 'women', occasion }), false, `expected women "${occasion}" not to match`);
  }

  for (const occasion of [
    'summer wedding',
    'beach wedding',
    'outdoor wedding',
    'semi-formal wedding',
  ]) {
    assert.equal(isMenBlackTie({ gender: 'men', occasion }), false, `expected men "${occasion}" NOT to match`);
  }
});

// ---------------------------------------------------------------------------
// 2. All-caps model-name titles rejected in accessory / jewelry
// ---------------------------------------------------------------------------

test('wrongSlot rejects all-caps model names in accessory/jewelry while allowing shoes and named accessories', () => {
  assert.equal(wrongSlot('YARDLY BLACK VELVET', 'accessory'), true);
  assert.equal(wrongSlot('YARDLY BLACK VELVET', 'jewelry'), true);
  assert.equal(wrongSlot('YARDLY BLACK VELVET', 'shoes'), false);
  assert.equal(wrongSlot('Leather Belt - Brown', 'accessory'), false);
  assert.equal(wrongSlot('LENNON BELT', 'accessory'), false);
  assert.equal(wrongSlot('LENNON WALLET', 'accessory'), false);
  assert.equal(wrongSlot('GOLD NECKLACE', 'jewelry'), false);
  assert.equal(wrongSlot('CLASSIC SILK TIE', 'accessory'), false);
  assert.equal(wrongSlot('TIE FRONT TOP', 'accessory'), true);
});

// ---------------------------------------------------------------------------
// 3a. spendUp
// ---------------------------------------------------------------------------

test('spendUp is a no-op when outfit total is already at or above 60% of budget', () => {
  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 500 };
  const shoes = makeItem('Black Leather Loafer', 120);
  const top = makeItem('White Cotton Shirt', 80);
  const bottom = makeItem('Navy Wool Trousers', 100);
  const priceyShoes = makeItem('Black Leather Loafer', 220, { store: 'Steve Madden' });

  const pieces: Piece[] = [
    { slot: 'shoes', why: 'Shoes', item: shoes },
    { slot: 'top', why: 'Top', item: top },
    { slot: 'bottom', why: 'Bottom', item: bottom },
  ];
  const ranked = new Map<Slot, Item[]>([['shoes', [shoes, priceyShoes]]]);
  const problems: string[] = [];

  const result = spendUp(pieces, ranked, brief, new Set(), { problems });
  assert.equal(result.find((p) => p.slot === 'shoes')?.item.id, shoes.id);
  assert.deepEqual(problems, []);
});

test('spendUp upgrades in slot order (shoes, layer, bottom, top, bag, accessory), stops at 70%, and logs each swap', () => {
  const brief: Brief = { gender: 'men', occasion: 'upscale dinner date', budget_usd: 500 };
  const cheapShoes = makeItem('Black Leather Loafers', 40);
  const midShoes = makeItem('Black Leather Loafers', 120, { store: 'Steve Madden' });
  const bestShoes = makeItem('Black Leather Loafers', 150, { store: 'Steve Madden' });
  const overBudgetShoes = makeItem('Black Leather Loafers', 490, { store: 'Steve Madden' });

  const cheapLayer = makeItem('Navy Wool Blazer', 50);
  const priceyLayer = makeItem('Navy Wool Blazer', 180, { store: 'Everlane' });

  const cheapBottom = makeItem('Navy Wool Trousers', 35);
  const priceyBottom = makeItem('Navy Wool Trousers', 140, { store: 'Everlane' });

  const cheapTop = makeItem('White Cotton Shirt', 25);

  // Starting total = 40 + 50 + 35 + 25 = $150 (30% of $500, under 60% = $300)
  const pieces: Piece[] = [
    { slot: 'top', why: 'Top', item: cheapTop },
    { slot: 'bottom', why: 'Bottom', item: cheapBottom },
    { slot: 'layer', why: 'Layer', item: cheapLayer },
    { slot: 'shoes', why: 'Shoes', item: cheapShoes },
  ];
  const ranked = new Map<Slot, Item[]>([
    ['shoes', [cheapShoes, midShoes, bestShoes, overBudgetShoes]],
    ['layer', [cheapLayer, priceyLayer]],
    ['bottom', [cheapBottom, priceyBottom]],
  ]);
  const queries = new Map<Slot, string>([
    ['shoes', "men's black leather loafers"],
    ['layer', "men's navy wool blazer"],
    ['bottom', "men's navy wool trousers"],
    ['top', "men's white cotton shirt"],
  ]);
  const problems: string[] = [];
  const taken = new Set<string>();

  const result = spendUp(pieces, ranked, brief, taken, { queries, problems });

  // Original pieces array is not mutated
  assert.equal(pieces.find((p) => p.slot === 'shoes')?.item.id, cheapShoes.id);
  // Shoes upgraded first: $40 -> $150 (total $260, still < $350 = 70%)
  assert.equal(result.find((p) => p.slot === 'shoes')?.item.id, bestShoes.id);
  // Layer upgraded second: $50 -> $180 (total $390 >= $350 = 70% -> stop!)
  assert.equal(result.find((p) => p.slot === 'layer')?.item.id, priceyLayer.id);
  // Bottom untouched because 70% threshold was reached
  assert.equal(result.find((p) => p.slot === 'bottom')?.item.id, cheapBottom.id);
  assert.deepEqual(problems, [
    'spent up: shoes $40 -> $150',
    'spent up: layer $50 -> $180',
  ]);
});

test('spendUp enforces score floor, taken set, wrongSlot, breaksDressCode, and formalFilter', () => {
  const brief: Brief = { gender: 'men', occasion: 'formal wedding', budget_usd: 500 };

  const curShoes = makeItem('Black Leather Oxford Shoes', 40);
  const takenShoes = makeItem('Black Leather Oxford Shoes', 180, { store: 'Steve Madden' });
  const casualBoot = makeItem('Black Leather Chelsea Boots', 170, { store: 'Steve Madden' }); // fails formalFilter
  const lowScoreShoe = makeItem('Brown Suede Slip On', 160); // fails formalFilter + low score
  const validShoes = makeItem('Black Patent Oxford Shoes', 130, { store: 'Steve Madden' });

  const curLayer = makeItem('Black Suit Jacket', 45);
  const whiteJacket = makeItem('White Suit Jacket', 190, { store: 'Everlane' }); // fails breaksDressCode
  const wrongColourJacket = makeItem('Green Cotton Jacket', 185); // fails scoreItem >= cur - 1 & formalFilter

  const curBottom = makeItem('Black Suit Trousers', 35);
  const curTop = makeItem('White Dress Shirt', 25);
  const curAcc = makeItem('Black Silk Tie', 30);
  const allCapsShoeInAcc = makeItem('YARDLY BLACK VELVET', 120, { store: 'Steve Madden' }); // fails wrongSlot & formalFilter

  // Starting total = $175 (< $300 = 60% of $500)
  const pieces: Piece[] = [
    { slot: 'layer', why: 'Jacket', item: curLayer },
    { slot: 'top', why: 'Shirt', item: curTop },
    { slot: 'bottom', why: 'Trousers', item: curBottom },
    { slot: 'shoes', why: 'Shoes', item: curShoes },
    { slot: 'accessory', why: 'Tie', item: curAcc },
  ];
  const ranked = new Map<Slot, Item[]>([
    ['shoes', [curShoes, takenShoes, casualBoot, lowScoreShoe, validShoes]],
    ['layer', [curLayer, whiteJacket, wrongColourJacket]],
    ['accessory', [curAcc, allCapsShoeInAcc]],
  ]);
  const queries = new Map<Slot, string>([
    ['shoes', "men's black leather oxford shoes"],
    ['layer', "men's black suit jacket"],
    ['accessory', "men's black silk tie"],
  ]);
  const taken = new Set<string>([takenShoes.id]);
  const problems: string[] = [];

  const result = spendUp(pieces, ranked, brief, taken, { queries, problems });
  assert.equal(result.find((p) => p.slot === 'shoes')?.item.id, validShoes.id);
  assert.equal(result.find((p) => p.slot === 'layer')?.item.id, curLayer.id);
  assert.equal(result.find((p) => p.slot === 'accessory')?.item.id, curAcc.id);
  assert.deepEqual(problems, ['spent up: shoes $40 -> $130']);
});

// ---------------------------------------------------------------------------
// 3b. Best-of-the-rest gate-passing ordering
// ---------------------------------------------------------------------------

test('compareJudged and pickRest always place failing gate looks last and only show them if < 3 passing looks exist', () => {
  const mkCand = (name: string, total: number, pass: boolean, fits: number, cohesion: number) => ({
    outfit: { name, total },
    gate: { pass, fits, cohesion, score: fits * (cohesion / 4) },
  });

  const failingInBudget = mkCand('Classic Navy Tailoring', 420, false, 0.2, 2);
  const passingOverBudget = mkCand('Midnight Navy', 510, true, 0.85, 3);
  const passingA = mkCand('Classic Black Suit', 460, true, 0.9, 4);
  const passingB = mkCand('Black Tuxedo', 440, true, 0.8, 3);

  // Passing over-budget still ranks ahead of failing in-budget
  assert.ok(compareJudged(passingOverBudget, failingInBudget, 500) < 0);

  // When 3 passing looks exist, failing look is dropped and never shown
  const shownWith3: string[] = [];
  const problems3: string[] = [];
  pickRest(
    [failingInBudget, passingB, passingOverBudget, passingA],
    500,
    0,
    (c) => { shownWith3.push(c.outfit.name); return true; },
    problems3,
  );
  assert.deepEqual(shownWith3, ['Classic Black Suit', 'Black Tuxedo', 'Midnight Navy']);
  assert.ok(problems3.some((p) => p.includes('dropped "Classic Navy Tailoring"')));

  // When only 2 passing looks exist, failing look goes last and logs a problems line
  const shownWith2: string[] = [];
  const problems2: string[] = [];
  pickRest(
    [failingInBudget, passingB, passingA],
    500,
    0,
    (c) => { shownWith2.push(c.outfit.name); return true; },
    problems2,
  );
  assert.deepEqual(shownWith2, ['Classic Black Suit', 'Black Tuxedo', 'Classic Navy Tailoring']);
  assert.ok(problems2.some((p) => p.includes('Classic Navy Tailoring') && p.includes('failing gate')));
});

// ---------------------------------------------------------------------------
// 3c & 4. Prompt copy + wedding white dress shirt rule
// ---------------------------------------------------------------------------

test('pick.ts prompt includes strengthened budget instruction', () => {
  const src = readFileSync(new URL('../src/brain/pick.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('Use the budget: aim for 70-100% of it. A look at a third of the budget is underselling the client.'));
});

test('wedding-guest white rule allows men white dress shirts while blocking women white and men white suits', () => {
  assert.ok(
    DRESS_CODE.includes(
      'Wedding guests: women never wear white, ivory, cream or anything bridal; men never wear a white or ivory suit or jacket, but a white dress shirt under a suit is classic and correct.',
    ),
  );
  assert.ok(DRESS_CODE.includes('Daytime or outdoor weddings:'));

  const criticSrc = readFileSync(new URL('../src/brain/critic.ts', import.meta.url), 'utf8');
  assert.ok(
    criticSrc.includes(
      'Wedding guests: women never wear white, ivory, cream or anything bridal; men never wear a white or ivory suit or jacket, but a white dress shirt under a suit is classic and correct.',
    ),
  );

  // breaksDressCode allows men's white dress shirt at a wedding
  assert.equal(
    breaksDressCode({ title: 'Dress Shirt - White' }, 'top', { gender: 'men', occasion: 'formal wedding' }),
    false,
  );
  assert.equal(
    breaksDressCode({ title: 'Dress Shirt - White' }, 'top', { gender: 'men', occasion: 'summer wedding' }),
    false,
  );
  // Still rejects men's white jacket/trousers and women's white dress/top
  assert.equal(
    breaksDressCode({ title: 'Suit Jacket - White' }, 'layer', { gender: 'men', occasion: 'formal wedding' }),
    true,
  );
  assert.equal(
    breaksDressCode({ title: 'Satin Dress - White' }, 'dress', { gender: 'women', occasion: 'formal wedding' }),
    true,
  );
  assert.equal(
    breaksDressCode({ title: 'Silk Blouse - White' }, 'top', { gender: 'women', occasion: 'summer wedding' }),
    true,
  );

  // repairPlan preserves men's white dress shirt query at a wedding, while guarding men's white blazer and women's white dress
  const menPlan = repairPlan(
    {
      own_slot: 'none',
      ideas: [
        {
          name: 'Classic Navy',
          difference: 'Navy tailoring with a crisp white shirt.',
          slots: [
            { slot: 'layer', query: "men's white linen blazer" },
            { slot: 'top', query: "men's white dress shirt" },
            { slot: 'bottom', query: "men's navy trousers" },
            { slot: 'shoes', query: "men's brown leather loafers" },
            { slot: 'accessory', query: "men's brown leather belt" },
          ],
        },
      ],
    },
    { gender: 'men', occasion: 'summer wedding', budget_usd: 300 },
  );
  const topQuery = menPlan.ideas[0].slots.find((s) => s.slot === 'top')?.query;
  const layerQuery = menPlan.ideas[0].slots.find((s) => s.slot === 'layer')?.query;
  assert.equal(topQuery, "men's white dress shirt");
  assert.equal(layerQuery, "men's dusty blue linen blazer");
});
