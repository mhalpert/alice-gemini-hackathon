// Slot integrity guards: keep every piece in its own slot across words, build, swap, and library.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrongSlot } from '../src/brain/words.ts';
import { repairWrongSlots } from '../src/brain/build.ts';
import { swapLive } from '../src/brain/swap.ts';
import {
  _setDeps,
  libraryLooks,
  serveLibrary,
  type LibraryFile,
  type LookupEntry,
} from '../src/library/index.ts';
import type { Slot } from '../src/brain/plan.ts';
import type { Brief, Gender, Item, Outfit, Piece, SearchResult } from '../src/types.ts';

let seq = 0;
function makeItem(title: string, price: number, gender: Gender = 'men', extra: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `slot-prod-${seq}`,
    variant_id: `slot-var-${seq}`,
    title,
    price,
    url: `https://example.com/slot/${seq}`,
    image: `https://cdn.example.com/slot-${seq}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.6,
    rating_count: 18,
    sizes: ['M', 'L'],
    variants_by_size: {},
    description: title,
    department: gender,
    ...extra,
  };
}

function makeOutfit(name: string, gender: Gender, extraPieces: Piece[] = []): Outfit {
  const pieces: Piece[] = [
    { slot: 'top', why: 'Top', item: makeItem(`${name} Dress Shirt`, 60, gender) },
    { slot: 'bottom', why: 'Bottom', item: makeItem(`${name} Wool Trouser`, 80, gender) },
    { slot: 'shoes', why: 'Shoes', item: makeItem(`${name} Leather Oxford`, 100, gender) },
    ...extraPieces,
  ];
  const total = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
  return {
    name,
    difference: `Distinct ${name} look`,
    story: `Built around the ${name} Dress Shirt.`,
    pieces,
    total,
  };
}

const tempDirs: string[] = [];

function createTempLibrary(file: LibraryFile): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-slots-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'sets.json');
  writeFileSync(filePath, JSON.stringify(file), 'utf8');
  process.env.ALICE_LIBRARY_FILE = filePath;
  return filePath;
}

function allAvailableLookup(outfits: Outfit[]): Map<string, LookupEntry> {
  const map = new Map<string, LookupEntry>();
  for (const o of outfits) {
    for (const p of o.pieces) {
      map.set(p.item.variant_id, { item: p.item, available: true, price: p.item.price });
    }
  }
  return map;
}

afterEach(() => {
  _setDeps(null);
  delete process.env.ALICE_LIBRARY_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrongSlot catches mismatched pieces and allows valid slot titles', () => {
  assert.equal(wrongSlot('Velvet Loafer - Black', 'accessory'), true);
  assert.equal(wrongSlot('Velvet Loafer', 'accessory'), true);
  assert.equal(wrongSlot('Solid Silk Tie - Black', 'accessory'), false);
  assert.equal(wrongSlot('Leather Belt - Brown', 'accessory'), false);
  assert.equal(wrongSlot('Tie Front Blouse', 'top'), false);
  assert.equal(wrongSlot('Chelsea Boot', 'shoes'), false);
  assert.equal(wrongSlot('Linen Shirt', 'shoes'), true);
  assert.equal(wrongSlot('Slim Chino - Navy', 'bottom'), false);
  assert.equal(wrongSlot('Oxford Shirt', 'bottom'), true);

  // Real-library cases: model-only shoe names, "shoes"/"lace up", knit beanie, pants in bag
  assert.equal(wrongSlot('SHAY BLACK LEATHER', 'shoes'), false);
  assert.equal(wrongSlot('Chunky Lace Up Shoes - Black', 'shoes'), false);
  assert.equal(wrongSlot('Knit With Love Beanie - Black', 'accessory'), false);
  assert.equal(wrongSlot('Slim Flare Pants', 'bag'), true);

  // Additional cross-group and edge cases
  assert.equal(wrongSlot('Oxford Shirt', 'top'), false);
  assert.equal(wrongSlot('Oxford Shirt', 'shoes'), true);
  assert.equal(wrongSlot('Leather Oxford - Black', 'shoes'), false);
  assert.equal(wrongSlot('Leather Oxford - Black', 'accessory'), true);
  assert.equal(wrongSlot('Tie Front Blouse', 'accessory'), true);
  assert.equal(wrongSlot('Tailored Blazer - Navy', 'bottom'), true);
  assert.equal(wrongSlot('Satin Midi Dress - Black', 'bag'), true);
  assert.equal(wrongSlot('Cashmere Sweater - Navy', 'jewelry'), true);
  assert.equal(wrongSlot('Velvet Loafer - Black', 'top'), true);
  assert.equal(wrongSlot('Leather Tote Bag', 'top'), true);
  assert.equal(wrongSlot('Leather Tote Bag', 'shoes'), true);
  assert.equal(wrongSlot('Leather Tote Bag', 'bag'), false);
});

test('repairWrongSlots replaces a wrong-slot pick from the ranked list and logs a problem line', () => {
  const badLoafer = makeItem('Velvet Loafer - Black', 95, 'men');
  const silkTie = makeItem('Solid Silk Tie - Black', 45, 'men');
  const pieces: Piece[] = [
    { slot: 'top', why: 'Shirt', item: makeItem('Crisp Dress Shirt - White', 60, 'men') },
    { slot: 'bottom', why: 'Trousers', item: makeItem('Tailored Trouser - Black', 90, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Patent Leather Oxford - Black', 110, 'men') },
    { slot: 'accessory', why: 'Finishing touch', item: badLoafer },
  ];
  const ranked = new Map<Slot, Item[]>([
    ['accessory', [silkTie]],
  ]);
  const problems: string[] = [];

  const repaired = repairWrongSlots('Midnight Gala', pieces, ranked, problems);
  const acc = repaired.find((p) => p.slot === 'accessory');
  assert.ok(acc);
  assert.equal(acc.item.id, silkTie.id);
  assert.deepEqual(problems, ['Midnight Gala: accessory pick was a loafers, replaced']);
});

test('swapLive never swaps a shoe or clothing item into an accessory slot', async () => {
  const brief: Brief = { gender: 'men', occasion: 'black tie optional gala', budget_usd: 350 };
  const currentTie = makeItem('Classic Silk Tie - Navy', 45, 'men');
  const outfit = makeOutfit('Gala Look', 'men', [
    { slot: 'accessory', why: 'Tie', item: currentTie },
  ]);
  const stock = [
    makeItem('Velvet Loafer - Black', 40, 'men'),
    makeItem('Linen Shirt - Black', 35, 'men'),
    makeItem('Leather Belt - Black', 42, 'men'),
  ];
  const fakeSearch = async (): Promise<SearchResult> => ({ items: stock, source: 'live', ms: 1 });

  const out = await swapLive(outfit, 'accessory', 'something black', brief, {
    search: fakeSearch,
    rewrite: false,
  });
  assert.equal(out.piece.item.title, 'Leather Belt - Black');
});

test('a library outfit with a loafer in the accessory slot is not served', async () => {
  const badGala = makeOutfit('Loafer Accessory Gala', 'men', [
    { slot: 'accessory', why: 'Finishing touch', item: makeItem('Black Velvet Loafers', 110, 'men') },
  ]);
  const goodOne = makeOutfit('Classic Gala 1', 'men', [
    { slot: 'accessory', why: 'Tie', item: makeItem('Solid Silk Tie - Black', 55, 'men') },
  ]);
  const goodTwo = makeOutfit('Classic Gala 2', 'men', [
    { slot: 'accessory', why: 'Belt', item: makeItem('Leather Belt - Black', 50, 'men') },
  ]);

  const outfits = [badGala, goodOne, goodTwo];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'gala',
        gender: 'men',
        occasion: 'black tie optional gala',
        budget_usd: 400,
        outfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  const stock = allAvailableLookup(outfits);
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
  });

  const brief: Brief = { gender: 'men', occasion: 'black tie optional gala', budget_usd: 400 };
  const served = await serveLibrary(brief);
  assert.ok(served);
  assert.deepEqual(served.outfits.map((o) => o.name), ['Classic Gala 1', 'Classic Gala 2']);

  const looks = await libraryLooks('men', { occasion: 'black tie optional gala' });
  assert.deepEqual(looks.map((o) => o.name), ['Classic Gala 1', 'Classic Gala 2']);
});
