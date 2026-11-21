// Tests for the ready-made outfit library (no network).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Brief, Gender, Item, Outfit, Piece } from '../src/types.ts';
import {
  _setDeps,
  libraryLooks,
  matchLibrary,
  serveLibrary,
  warmLibrary,
  type LibraryFile,
  type LookupEntry,
} from '../src/library/index.ts';
import { cosine, occasionText } from '../src/library/embed.ts';
import { getCallLogPath } from '../src/calllog.ts';

let seq = 0;
function makeItem(title: string, price: number, gender: Gender, extra: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `prod-${seq}`,
    variant_id: `var-${seq}`,
    title,
    price,
    url: `https://example.com/p/${seq}`,
    image: `https://cdn.example.com/${seq}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 15,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description: title,
    department: gender,
    ...extra,
  };
}

function makeOutfit(name: string, gender: Gender, prices: [number, number, number]): Outfit {
  const pieces: Piece[] = [
    { slot: 'top', why: 'Great top', item: makeItem(`${name} Shirt`, prices[0], gender) },
    { slot: 'bottom', why: 'Great bottom', item: makeItem(`${name} Pants`, prices[1], gender) },
    { slot: 'shoes', why: 'Great shoes', item: makeItem(`${name} Boots`, prices[2], gender) },
  ];
  const total = Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    name,
    difference: `Distinct ${name} vibe`,
    story: `Built around the ${name} Shirt.`,
    pieces,
    total,
  };
}

const tempDirs: string[] = [];

function createTempLibrary(file: LibraryFile): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-lib-'));
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
  delete process.env.ALICE_LIBRARY;
  delete process.env.ALICE_LIBRARY_THRESHOLD;
  delete process.env.ALICE_LOG_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('occasionText and cosine helpers work as specified', () => {
  assert.equal(occasionText('men', 'rooftop party'), "Men's outfit for: rooftop party");
  assert.equal(occasionText('women', 'Sunday brunch'), "Women's outfit for: Sunday brunch");
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.ok(Math.abs(cosine([0.6, 0.8], [0.6, 0.8]) - 1) < 1e-9);
});

test('a matching occasion over the threshold serves 3 outfits with source library and logs events', async () => {
  const menDemo = [
    makeOutfit('Roof One', 'men', [40, 45, 50]),
    makeOutfit('Roof Two', 'men', [35, 50, 55]),
    makeOutfit('Roof Three', 'men', [30, 40, 45]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(menDemo);
  let lookupCalls = 0;
  let embedCalls = 0;
  _setDeps({
    embed: async (texts) => {
      embedCalls += 1;
      return texts.map(() => [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]);
    },
    lookup: async () => {
      lookupCalls += 1;
      return stock;
    },
    swap: async () => {
      throw new Error('swap should not be called');
    },
  });

  const logDir = mkdtempSync(path.join(tmpdir(), 'alice-lib-log-'));
  tempDirs.push(logDir);
  process.env.ALICE_LOG_DIR = logDir;

  const streamed: [number, number | undefined][] = [];
  const brief: Brief = { gender: 'men', occasion: "my buddy's birthday on a roof", budget_usd: 150 };
  const res = await serveLibrary(brief, {
    room: 'room-lib-1',
    onOutfit: (o, i) => streamed.push([i, o.number]),
  });

  assert.ok(res);
  assert.equal(res.source, 'library');
  assert.equal(res.outfits.length, 3);
  assert.deepEqual(streamed, [[0, 1], [1, 2], [2, 3]]);
  assert.equal(lookupCalls, 1);
  assert.equal(embedCalls, 1);
  assert.ok(res.problems.some((p) => p.includes('rooftop-birthday') && p.includes('0.95')));

  // Second call for the same query reuses the cached query embedding.
  const match = await matchLibrary(brief);
  assert.ok(match);
  assert.equal(match.key, 'rooftop-birthday');
  assert.equal(embedCalls, 1);

  const events = readFileSync(getCallLogPath('room-lib-1'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => e.ev), ['library_match', 'build_done']);
  assert.equal(events[0].key, 'rooftop-birthday');
  assert.equal(events[1].source, 'library');
});

test('an occasion under the threshold returns null (and anyMatch rescues it)', async () => {
  const menDemo = [
    makeOutfit('Roof A', 'men', [40, 45, 50]),
    makeOutfit('Roof B', 'men', [35, 50, 55]),
    makeOutfit('Roof C', 'men', [30, 40, 45]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(menDemo);
  _setDeps({
    embed: async (texts) => texts.map(() => [0.5, Math.sqrt(1 - 0.25), 0]),
    lookup: async () => stock,
  });

  const brief: Brief = { gender: 'men', occasion: 'a funeral', budget_usd: 150 };
  assert.equal(await matchLibrary(brief), null);
  assert.equal(await serveLibrary(brief), null);

  const rescue = await serveLibrary(brief, { anyMatch: true });
  assert.ok(rescue);
  assert.equal(rescue.outfits.length, 3);
  assert.equal(rescue.source, 'library');
});

test('a sold-out shoe with no swap drops that outfit; fewer than 2 surviving returns null', async () => {
  const menDemo = [
    makeOutfit('Keep One', 'men', [40, 40, 40]),
    makeOutfit('Drop Shoes', 'men', [40, 40, 40]),
    makeOutfit('Keep Two', 'men', [40, 40, 40]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(menDemo);
  const soldOutShoe = menDemo[1].pieces.find((p) => p.slot === 'shoes')!;
  stock.set(soldOutShoe.item.variant_id, { item: null, available: false, price: null });

  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
    swap: async (outfit, slot) => {
      const piece = outfit.pieces.find((p) => p.slot === slot)!;
      return {
        outfit,
        piece,
        note: `No different ${slot} in stock right now; kept the ${piece.item.title}.`,
      };
    },
  });

  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  const res = await serveLibrary(brief);
  assert.ok(res);
  assert.equal(res.outfits.length, 2);
  assert.deepEqual(res.outfits.map((o) => [o.number, o.name]), [[1, 'Keep One'], [2, 'Keep Two']]);

  // Now mark a second outfit's shoes sold out -> only 1 survives -> must return null.
  const soldOutShoe2 = menDemo[2].pieces.find((p) => p.slot === 'shoes')!;
  stock.set(soldOutShoe2.item.variant_id, { item: null, available: false, price: null });
  const res2 = await serveLibrary(brief);
  assert.equal(res2, null);
});

test('a sold-out piece that swaps cleanly stays in the result and updates the total', async () => {
  const menDemo = [
    makeOutfit('Swap One', 'men', [40, 40, 40]),
    makeOutfit('Swap Two', 'men', [40, 40, 40]),
    makeOutfit('Swap Three', 'men', [40, 40, 40]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(menDemo);
  const soldOutShoe = menDemo[0].pieces.find((p) => p.slot === 'shoes')!;
  stock.set(soldOutShoe.item.variant_id, { item: null, available: false, price: null });

  const replacement = makeItem('Replacement Loafer', 52.5, 'men');
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
    swap: async (outfit, slot, request) => {
      assert.equal(request, 'similar');
      const next = structuredClone(outfit);
      const idx = next.pieces.findIndex((p) => p.slot === slot);
      const piece: Piece = { slot, why: 'Fresh swap', item: replacement };
      next.pieces[idx] = piece;
      next.total = 132.5;
      return { outfit: next, piece };
    },
  });

  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  const res = await serveLibrary(brief);
  assert.ok(res);
  assert.equal(res.outfits.length, 3);
  assert.equal(res.outfits[0].pieces.find((p) => p.slot === 'shoes')!.item.title, 'Replacement Loafer');
  assert.equal(res.outfits[0].total, 132.5);
  assert.ok(res.problems.some((p) => p.includes('Replacement Loafer')));
});

test('a changed price updates the outfit total and respects budget rescaling', async () => {
  const menDemo = [
    makeOutfit('Priced One', 'men', [30, 30, 30]),
    makeOutfit('Priced Two', 'men', [40, 40, 40]),
    makeOutfit('Priced Three', 'men', [50, 50, 40]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(menDemo);
  const changedTop = menDemo[0].pieces[0];
  stock.set(changedTop.item.variant_id, {
    item: { ...changedTop.item, price: 37.45 },
    available: true,
    price: 37.45,
  });

  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
  });

  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  const res = await serveLibrary(brief);
  assert.ok(res);
  assert.equal(res.outfits[0].pieces[0].item.price, 37.45);
  assert.equal(res.outfits[0].total, 97.45);

  // Budget below 85% of 150 ($127.50): $120 keeps looks <= $120 (97.45 and 120), drops 140.
  const tight = await serveLibrary({ ...brief, budget_usd: 120 });
  assert.ok(tight);
  assert.equal(tight.outfits.length, 2);
  assert.deepEqual(tight.outfits.map((o) => o.name), ['Priced One', 'Priced Two']);
});

test('the other gender sets are never matched', async () => {
  const womenDemo = [
    makeOutfit('Women One', 'women', [40, 40, 40]),
    makeOutfit('Women Two', 'women', [40, 40, 40]),
    makeOutfit('Women Three', 'women', [40, 40, 40]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'women',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 150,
        outfits: womenDemo,
        vectors: [[1, 0, 0]],
        built_ms: 1000,
      },
    ],
  });

  const stock = allAvailableLookup(womenDemo);
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
  });

  const menBrief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  assert.equal(await matchLibrary(menBrief), null);
  assert.equal(await serveLibrary(menBrief), null);

  const womenBrief: Brief = { gender: 'women', occasion: 'rooftop birthday', budget_usd: 150 };
  const matched = await matchLibrary(womenBrief);
  assert.ok(matched);
  assert.equal(matched.key, 'rooftop-birthday');
});

test('libraryLooks returns demo first, interleaves others, drops sold-out, respects limit', async () => {
  const demo = [
    makeOutfit('Demo 1', 'men', [30, 30, 30]),
    makeOutfit('Demo 2', 'men', [30, 30, 30]),
    makeOutfit('Demo 3', 'men', [30, 30, 30]),
  ];
  const brunch = [
    makeOutfit('Brunch 1', 'men', [30, 30, 30]),
    makeOutfit('Brunch 2', 'men', [30, 30, 30]),
    makeOutfit('Brunch 3', 'men', [30, 30, 30]),
  ];
  const club = [
    makeOutfit('Club 1', 'men', [30, 30, 30]),
    makeOutfit('Club 2', 'men', [30, 30, 30]),
    makeOutfit('Club 3', 'men', [30, 30, 30]),
  ];
  const womenOnly = [
    makeOutfit('Women 1', 'women', [30, 30, 30]),
  ];

  // Put non-demo sets BEFORE demo in sets.json to prove demo is still returned first.
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      { key: 'brunch', gender: 'men', occasion: 'Sunday brunch', budget_usd: 120, outfits: brunch, vectors: [[1, 0, 0]], built_ms: 500 },
      { key: 'club', gender: 'men', occasion: 'night out at a club', budget_usd: 150, outfits: club, vectors: [[0, 1, 0]], built_ms: 500 },
      { key: 'rooftop-birthday', gender: 'men', occasion: 'rooftop birthday', budget_usd: 150, outfits: demo, vectors: [[0, 0, 1]], built_ms: 500 },
      { key: 'rooftop-birthday', gender: 'women', occasion: 'rooftop birthday', budget_usd: 150, outfits: womenOnly, vectors: [[0, 0, 1]], built_ms: 500 },
    ],
  });

  const stock = allAvailableLookup([...demo, ...brunch, ...club, ...womenOnly]);
  // Mark Demo 2 sold out to confirm it is dropped without swapping.
  stock.set(demo[1].pieces[0].item.variant_id, { item: null, available: false, price: null });

  let lookupCalls = 0;
  _setDeps({
    lookup: async () => {
      lookupCalls += 1;
      return stock;
    },
    swap: async () => {
      throw new Error('libraryLooks must never swap');
    },
  });

  const looks = await libraryLooks('men', { limit: 5 });
  assert.equal(lookupCalls, 1);
  assert.equal(looks.length, 5);
  assert.deepEqual(
    looks.map((o) => [o.number, o.name]),
    [
      [1, 'Demo 1'],
      [2, 'Demo 3'],
      [3, 'Brunch 1'],
      [4, 'Club 1'],
      [5, 'Brunch 2'],
    ],
  );
});

test('libraryLooks with occasion returns only the matched set outfits or [] below threshold', async () => {
  const demo = [
    makeOutfit('Demo 1', 'men', [30, 30, 30]),
    makeOutfit('Demo 2', 'men', [30, 30, 30]),
    makeOutfit('Demo 3', 'men', [30, 30, 30]),
  ];
  const brunch = [
    makeOutfit('Brunch 1', 'men', [25, 30, 35]),
    makeOutfit('Brunch 2', 'men', [25, 30, 35]),
    makeOutfit('Brunch 3', 'men', [25, 30, 35]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      { key: 'rooftop-birthday', gender: 'men', occasion: 'rooftop birthday', budget_usd: 150, outfits: demo, vectors: [[1, 0, 0]], built_ms: 500 },
      { key: 'brunch', gender: 'men', occasion: 'Sunday brunch with friends', budget_usd: 120, outfits: brunch, vectors: [[0, 1, 0]], built_ms: 500 },
    ],
  });

  const stock = allAvailableLookup([...demo, ...brunch]);
  // Mark Brunch 2 sold out to verify live-checking without swaps.
  stock.set(brunch[1].pieces[2].item.variant_id, { item: null, available: false, price: null });

  _setDeps({
    embed: async (texts) =>
      texts.map((t) => (t.includes('brunch') ? [0, 0.99, Math.sqrt(1 - 0.99 * 0.99)] : [0, 0, 1])),
    lookup: async () => stock,
    swap: async () => {
      throw new Error('libraryLooks must never swap');
    },
  });

  const matched = await libraryLooks('men', { occasion: 'weekend brunch', limit: 6 });
  assert.deepEqual(
    matched.map((o) => [o.number, o.name]),
    [
      [1, 'Brunch 1'],
      [2, 'Brunch 3'],
    ],
  );

  const limited = await libraryLooks('men', { occasion: 'weekend brunch', limit: 1 });
  assert.deepEqual(limited.map((o) => [o.number, o.name]), [[1, 'Brunch 1']]);

  const unmatched = await libraryLooks('men', { occasion: 'a funeral', limit: 6 });
  assert.deepEqual(unmatched, []);
});

test('a missing file returns null and [] without throwing', async () => {
  process.env.ALICE_LIBRARY_FILE = path.join(tmpdir(), `does-not-exist-${Date.now()}.json`);
  await warmLibrary();
  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  assert.equal(await matchLibrary(brief), null);
  assert.equal(await serveLibrary(brief), null);
  assert.deepEqual(await libraryLooks('men'), []);
});

test('ALICE_LIBRARY=off bypasses serveLibrary', async () => {
  const menDemo = [
    makeOutfit('Off 1', 'men', [30, 30, 30]),
    makeOutfit('Off 2', 'men', [30, 30, 30]),
    makeOutfit('Off 3', 'men', [30, 30, 30]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: 'rooftop birthday',
        budget_usd: 150,
        outfits: menDemo,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });
  process.env.ALICE_LIBRARY = 'off';
  const brief: Brief = { gender: 'men', occasion: 'rooftop birthday', budget_usd: 150 };
  assert.equal(await serveLibrary(brief), null);
});
