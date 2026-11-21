// Tests for weather-fit parsing, outfit filtering, and serveLibrary integration (no network).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Brief, Gender, Item, Outfit, Piece } from '../src/types.ts';
import { readWeather, weatherFit, type WeatherSignals } from '../src/library/weather-fit.ts';
import {
  _setDeps,
  libraryLooks,
  serveLibrary,
  type LibraryFile,
  type LookupEntry,
} from '../src/library/index.ts';
import { getCallLogPath } from '../src/calllog.ts';

let seq = 0;
function makeItem(
  title: string,
  price: number,
  gender: Gender,
  description = title,
): Item {
  seq += 1;
  return {
    id: `wf-prod-${seq}`,
    variant_id: `wf-var-${seq}`,
    title,
    price,
    url: `https://example.com/p/${seq}`,
    image: `https://cdn.example.com/${seq}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 10,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description,
    department: gender,
  };
}

function makeOutfit(name: string, pieces: Piece[]): Outfit {
  const total = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
  return {
    name,
    difference: `Distinct ${name} look`,
    story: `Built for ${name}.`,
    pieces,
    total,
  };
}

const tempDirs: string[] = [];

function createTempLibrary(file: LibraryFile): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-wf-'));
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
  delete process.env.ALICE_LOG_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readWeather
// ---------------------------------------------------------------------------

test('readWeather parses the three real forecast lines and rain chance threshold', () => {
  const ny = readWeather(
    'Today in New York: about 52°F in the evening, overcast; high 66, low 47.',
  );
  assert.deepEqual(ny, {
    tempF: 52,
    rain: false,
    snow: false,
    cold: true, // tempF <= 55
    hot: false,
  });

  const miami = readWeather(
    'Saturday in Miami: about 79°F in the evening, light drizzle, 33% chance of rain; high 79, low 76.',
  );
  assert.deepEqual(miami, {
    tempF: 79,
    rain: true, // "drizzle" makes rain true despite 33% < 50%
    snow: false,
    cold: false,
    hot: false,
  });

  const miamiDry = readWeather(
    'Saturday in Miami: about 79°F in the evening, partly cloudy, 33% chance of rain; high 79, low 76.',
  );
  assert.equal(miamiDry.rain, false);

  const miamiFifty = readWeather(
    'Saturday in Miami: about 79°F in the evening, overcast, 50% chance of rain; high 79, low 76.',
  );
  assert.equal(miamiFifty.rain, true);

  const chicago = readWeather(
    'Tomorrow in Chicago: about 40°F in the evening, light rain, 95% chance of rain; high 55, low 33.',
  );
  assert.deepEqual(chicago, {
    tempF: 40,
    rain: true,
    snow: false,
    cold: true,
    hot: false,
  });
});

test('readWeather handles temperature boundaries, seasonal fallbacks, and snow', () => {
  assert.equal(readWeather('Today: about 55°F in the evening, clear.').cold, true);
  assert.equal(readWeather('Today: about 56°F in the evening, clear.').cold, false);
  assert.equal(readWeather('Today: about 56°F in the evening, clear.').hot, false);
  assert.equal(readWeather('Today: about 81°F in the evening, clear.').hot, false);
  assert.equal(readWeather('Today: about 82°F in the evening, clear.').hot, true);

  const seasonalCold = readWeather(
    "That's too far out for a forecast; December in New York is usually cold and grey.",
  );
  assert.deepEqual(seasonalCold, {
    tempF: null,
    rain: false,
    snow: false,
    cold: true,
    hot: false,
  });

  const seasonalHot = readWeather(
    "That's too far out for a forecast; mid-August in Miami is usually hot and humid.",
  );
  assert.deepEqual(seasonalHot, {
    tempF: null,
    rain: false,
    snow: false,
    cold: false,
    hot: true,
  });

  const snowLine = readWeather('Tomorrow in Denver: around 31°F, snow flurries; high 35, low 22.');
  assert.deepEqual(snowLine, {
    tempF: 31,
    rain: false,
    snow: true,
    cold: true,
    hot: false,
  });

  const stormLine = readWeather('Friday in Austin: about 72°F in the evening, thunderstorms.');
  assert.equal(stormLine.rain, true);
});

// ---------------------------------------------------------------------------
// weatherFit
// ---------------------------------------------------------------------------

test('weatherFit cold rejects shorts or no-layer tee, accepts warm layer or warm top', () => {
  const cold: WeatherSignals = { tempF: 40, rain: false, snow: false, cold: true, hot: false };

  const teeOnly = makeOutfit('Summer Tee', [
    { slot: 'top', why: 'Tee', item: makeItem('Cotton Crewneck Tee', 30, 'men') },
    { slot: 'bottom', why: 'Jeans', item: makeItem('Slim Fit Jeans', 60, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Leather Chelsea Boot', 80, 'men') },
  ]);
  assert.equal(weatherFit(teeOnly, cold).ok, false);

  const withShorts = makeOutfit('Jacket And Shorts', [
    { slot: 'layer', why: 'Jacket', item: makeItem('Bomber Jacket', 90, 'men') },
    { slot: 'top', why: 'Top', item: makeItem('Cotton Shirt', 40, 'men') },
    { slot: 'bottom', why: 'Shorts', item: makeItem('Everyday Chino Short', 45, 'men') },
    { slot: 'shoes', why: 'Sneakers', item: makeItem('Leather Sneaker', 80, 'men') },
  ]);
  assert.equal(weatherFit(withShorts, cold).ok, false);

  const withLayer = makeOutfit('Layered Night', [
    { slot: 'layer', why: 'Coat', item: makeItem('Wool Car Coat', 150, 'men') },
    { slot: 'top', why: 'Tee', item: makeItem('Cotton Crewneck Tee', 30, 'men') },
    { slot: 'bottom', why: 'Jeans', item: makeItem('Slim Fit Jeans', 60, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Leather Chelsea Boot', 80, 'men') },
  ]);
  assert.equal(weatherFit(withLayer, cold).ok, true);

  const warmSweaterOnly = makeOutfit('Sweater Look', [
    { slot: 'top', why: 'Sweater', item: makeItem('Ribbed Crewneck Sweater', 70, 'men') },
    { slot: 'bottom', why: 'Jeans', item: makeItem('Slim Fit Jeans', 60, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Leather Chelsea Boot', 80, 'men') },
  ]);
  assert.equal(weatherFit(warmSweaterOnly, cold).ok, true);

  const linenLook = makeOutfit('Linen Shirt + Jacket', [
    { slot: 'layer', why: 'Jacket', item: makeItem('Leather Moto Jacket', 120, 'women') },
    { slot: 'top', why: 'Shirt', item: makeItem('Breezy Linen Shirt', 50, 'women') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Wide Leg Jeans', 60, 'women') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Ankle Boots', 80, 'women') },
  ]);
  assert.equal(weatherFit(linenLook, cold).ok, false);
});

test('weatherFit hot rejects wool blazer and heavy layers, allows lightweight linen/cotton layers', () => {
  const hot: WeatherSignals = { tempF: 88, rain: false, snow: false, cold: false, hot: true };

  const woolBlazer = makeOutfit('Wool Blazer Look', [
    { slot: 'layer', why: 'Blazer', item: makeItem('Tailored Wool Blazer', 180, 'men') },
    { slot: 'top', why: 'Shirt', item: makeItem('Poplin Shirt', 50, 'men') },
    { slot: 'bottom', why: 'Trousers', item: makeItem('Relaxed Trousers', 70, 'men') },
    { slot: 'shoes', why: 'Loafers', item: makeItem('Leather Loafers', 90, 'men') },
  ]);
  assert.equal(weatherFit(woolBlazer, hot).ok, false);

  const leatherLayer = makeOutfit('Leather Jacket Look', [
    { slot: 'layer', why: 'Jacket', item: makeItem('Vegan Leather Moto Jacket', 110, 'women') },
    { slot: 'top', why: 'Top', item: makeItem('Cotton Tank Top', 25, 'women') },
    { slot: 'bottom', why: 'Jeans', item: makeItem('Straight Jeans', 60, 'women') },
    { slot: 'shoes', why: 'Sandals', item: makeItem('Leather Sandals', 70, 'women') },
  ]);
  assert.equal(weatherFit(leatherLayer, hot).ok, false);

  const linenBlazer = makeOutfit('Linen Blazer Look', [
    { slot: 'layer', why: 'Blazer', item: makeItem('Relaxed Linen Blazer', 120, 'men') },
    { slot: 'top', why: 'Tee', item: makeItem('Cotton Tee', 30, 'men') },
    { slot: 'bottom', why: 'Trousers', item: makeItem('Chino Pants', 60, 'men') },
    { slot: 'shoes', why: 'Loafers', item: makeItem('Leather Loafers', 90, 'men') },
  ]);
  assert.equal(weatherFit(linenBlazer, hot).ok, true);
});

test('weatherFit rain rejects suede loafers and wet-sensitive shoes only in shoes slot', () => {
  const rain: WeatherSignals = { tempF: 65, rain: true, snow: false, cold: false, hot: false };

  const suedeLoafers = makeOutfit('Suede Loafers', [
    { slot: 'top', why: 'Shirt', item: makeItem('Oxford Shirt', 50, 'men') },
    { slot: 'bottom', why: 'Chinos', item: makeItem('Slim Chinos', 60, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Tan Suede Loafers', 95, 'men') },
  ]);
  assert.equal(weatherFit(suedeLoafers, rain).ok, false);

  const canvasSneakers = makeOutfit('Canvas Sneakers', [
    { slot: 'top', why: 'Shirt', item: makeItem('Oxford Shirt', 50, 'men') },
    { slot: 'bottom', why: 'Chinos', item: makeItem('Slim Chinos', 60, 'men') },
    {
      slot: 'shoes',
      why: 'Shoes',
      item: makeItem('Low Top Lace Up Sneakers', 70, 'men', 'Durable black canvas upper sneaker'),
    },
  ]);
  assert.equal(weatherFit(canvasSneakers, rain).ok, false);

  const leatherBootsWithCanvasBag = makeOutfit('Rain Ready', [
    { slot: 'top', why: 'Shirt', item: makeItem('Oxford Shirt', 50, 'men') },
    { slot: 'bottom', why: 'Chinos', item: makeItem('Slim Chinos', 60, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Black Leather Chelsea Boots', 110, 'men') },
    { slot: 'bag', why: 'Bag', item: makeItem('Canvas Boat Tote', 45, 'men') },
  ]);
  assert.equal(weatherFit(leatherBootsWithCanvasBag, rain).ok, true);
});

test('weatherFit snow rejects heels/stilettos in shoes slot while mild weather accepts all', () => {
  const snow: WeatherSignals = { tempF: 28, rain: false, snow: true, cold: true, hot: false };
  const mild: WeatherSignals = { tempF: 68, rain: false, snow: false, cold: false, hot: false };

  const stilettoLook = makeOutfit('Snow Heels', [
    { slot: 'layer', why: 'Coat', item: makeItem('Wool Trench Coat', 160, 'women') },
    { slot: 'dress', why: 'Dress', item: makeItem('Knit Midi Dress', 80, 'women') },
    { slot: 'shoes', why: 'Heels', item: makeItem('Black Satin Stiletto Heels', 90, 'women') },
  ]);
  assert.equal(weatherFit(stilettoLook, snow).ok, false);
  assert.equal(weatherFit(stilettoLook, mild).ok, true);

  const chelseaBootLook = makeOutfit('Snow Boots', [
    { slot: 'layer', why: 'Coat', item: makeItem('Wool Trench Coat', 160, 'women') },
    { slot: 'dress', why: 'Dress', item: makeItem('Knit Midi Dress', 80, 'women') },
    {
      slot: 'shoes',
      why: 'Boots',
      item: makeItem('Leather Chelsea Boots', 110, 'women', 'Round toe 1.5" low heel boot'),
    },
  ]);
  assert.equal(weatherFit(chelseaBootLook, snow).ok, true);
});

// ---------------------------------------------------------------------------
// serveLibrary integration
// ---------------------------------------------------------------------------

test('serveLibrary with cold weather drops no-layer looks, logs problems line, and returns null if < 2 remain', async () => {
  const warmOne = makeOutfit('Warm One', [
    { slot: 'layer', why: 'Coat', item: makeItem('Camel Car Coat', 90, 'men') },
    { slot: 'top', why: 'Top', item: makeItem('Black Turtleneck Sweater', 45, 'men') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Charcoal Slim Trousers', 55, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Black Leather Chelsea Boots', 80, 'men') },
  ]);
  const summerOne = makeOutfit('Summer Tee One', [
    { slot: 'top', why: 'Tee', item: makeItem('Cotton Crewneck Tee', 25, 'men') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Slim Jeans', 55, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Leather Sneakers', 70, 'men') },
  ]);
  const warmTwo = makeOutfit('Warm Two', [
    { slot: 'layer', why: 'Jacket', item: makeItem('Olive Bomber Jacket', 85, 'men') },
    { slot: 'top', why: 'Top', item: makeItem('Crewneck Sweater', 45, 'men') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Dark Wash Jeans', 55, 'men') },
    { slot: 'shoes', why: 'Boots', item: makeItem('Brown Leather Boots', 80, 'men') },
  ]);
  const outfits = [warmOne, summerOne, warmTwo];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'rooftop-birthday',
        gender: 'men',
        occasion: "a friend's rooftop birthday party",
        budget_usd: 300,
        outfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  const stock = allAvailableLookup(outfits);
  const lookedUpIds: string[][] = [];
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async (ids) => {
      lookedUpIds.push(ids);
      return stock;
    },
    swap: async () => {
      throw new Error('swap should not be called');
    },
  });

  const coldBrief: Brief = {
    gender: 'men',
    occasion: 'rooftop birthday',
    budget_usd: 300,
    weather: 'Tomorrow in Chicago: about 40°F in the evening, light rain, 95% chance of rain; high 55, low 33.',
  };

  const res = await serveLibrary(coldBrief);
  assert.ok(res);
  assert.equal(res.source, 'library');
  assert.deepEqual(
    res.outfits.map((o) => o.name),
    ['Warm One', 'Warm Two'],
  );
  assert.ok(
    res.problems.some((p) => p.includes('1') && p.toLowerCase().includes('weather')),
    `expected weather drop problem line, got: ${JSON.stringify(res.problems)}`,
  );
  // Dropped summer outfit's pieces should not have been passed to stock lookup.
  const summerVariantId = summerOne.pieces[0].item.variant_id;
  assert.equal(lookedUpIds.length, 1);
  assert.equal(lookedUpIds[0].includes(summerVariantId), false);

  // Now test fewer than 2 remaining: returns null, skips lookup, logs library_skip {key, reason: 'weather', weather}.
  const onlyOneWarm = [
    warmOne,
    summerOne,
    makeOutfit('Summer Tee Two', [
      { slot: 'top', why: 'Tee', item: makeItem('Short Sleeve Polo', 35, 'men') },
      { slot: 'bottom', why: 'Shorts', item: makeItem('Everyday Chino Shorts', 45, 'men') },
      { slot: 'shoes', why: 'Sneakers', item: makeItem('White Leather Sneakers', 70, 'men') },
    ]),
  ];
  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'beach',
        gender: 'men',
        occasion: 'beach day',
        budget_usd: 300,
        outfits: onlyOneWarm,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  let lookupCalls = 0;
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => {
      lookupCalls += 1;
      return allAvailableLookup(onlyOneWarm);
    },
  });

  const logDir = mkdtempSync(path.join(tmpdir(), 'alice-wf-log-'));
  tempDirs.push(logDir);
  process.env.ALICE_LOG_DIR = logDir;

  const skipped = await serveLibrary(
    {
      gender: 'men',
      occasion: 'beach day',
      budget_usd: 300,
      weather: coldBrief.weather,
    },
    { room: 'room-weather-skip' },
  );
  assert.equal(skipped, null);
  assert.equal(lookupCalls, 0);

  const events = readFileSync(getCallLogPath('room-weather-skip'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'library_skip');
  assert.equal(events[0].key, 'beach');
  assert.equal(events[0].reason, 'weather');
  assert.equal(events[0].weather, coldBrief.weather);

  // Storefront libraryLooks is unaffected by weather filtering and still returns all 3.
  const looks = await libraryLooks('men', { occasion: 'beach', limit: 6 });
  assert.equal(looks.length, 3);
});

test('serveLibrary without brief.weather behaves unchanged', async () => {
  const outfits = [
    makeOutfit('Tee One', [
      { slot: 'top', why: 'Tee', item: makeItem('Cotton Tee', 25, 'men') },
      { slot: 'bottom', why: 'Shorts', item: makeItem('Chino Shorts', 40, 'men') },
      { slot: 'shoes', why: 'Sandals', item: makeItem('Leather Sandals', 50, 'men') },
    ]),
    makeOutfit('Tee Two', [
      { slot: 'top', why: 'Tee', item: makeItem('Linen Shirt', 35, 'men') },
      { slot: 'bottom', why: 'Shorts', item: makeItem('Cargo Shorts', 45, 'men') },
      { slot: 'shoes', why: 'Sandals', item: makeItem('Slide Sandals', 40, 'men') },
    ]),
    makeOutfit('Tee Three', [
      { slot: 'top', why: 'Tee', item: makeItem('Tank Top', 20, 'men') },
      { slot: 'bottom', why: 'Shorts', item: makeItem('Denim Shorts', 50, 'men') },
      { slot: 'shoes', why: 'Shoes', item: makeItem('Suede Loafers', 75, 'men') },
    ]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'beach',
        gender: 'men',
        occasion: 'beach day',
        budget_usd: 200,
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

  const res = await serveLibrary({ gender: 'men', occasion: 'beach day', budget_usd: 200 });
  assert.ok(res);
  assert.equal(res.outfits.length, 3);
  assert.equal(
    res.problems.some((p) => p.toLowerCase().includes('weather')),
    false,
  );
});

// ---------------------------------------------------------------------------
// Exact variant_id stock check (addendum)
// ---------------------------------------------------------------------------

test('missing variant_id is treated as sold out in serveLibrary and libraryLooks even when product id is available', async () => {
  const deadShirt = makeItem(
    'Wrinkle Resistant Stretch Satin Finish Dress Shirt - Light Blue',
    35,
    'men',
  );
  const outfitDeadVariant = makeOutfit('Dead Variant Look', [
    { slot: 'top', why: 'Shirt', item: deadShirt },
    { slot: 'bottom', why: 'Pants', item: makeItem('Slim Dress Pants', 60, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Black Leather Loafers', 80, 'men') },
  ]);
  const outfitHealthyOne = makeOutfit('Healthy One', [
    { slot: 'top', why: 'Shirt', item: makeItem('Crisp Oxford Shirt', 40, 'men') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Charcoal Trousers', 60, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Brown Leather Boots', 85, 'men') },
  ]);
  const outfitHealthyTwo = makeOutfit('Healthy Two', [
    { slot: 'top', why: 'Shirt', item: makeItem('Navy Dress Shirt', 42, 'men') },
    { slot: 'bottom', why: 'Pants', item: makeItem('Black Slim Trousers', 58, 'men') },
    { slot: 'shoes', why: 'Shoes', item: makeItem('Black Chelsea Boots', 90, 'men') },
  ]);
  const outfits = [outfitDeadVariant, outfitHealthyOne, outfitHealthyTwo];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'date-night',
        gender: 'men',
        occasion: 'date night dinner',
        budget_usd: 250,
        outfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  // Remove the dead shirt's variant_id from stock, but keep an available entry under its product id (another colour).
  const stock = allAvailableLookup(outfits);
  stock.delete(deadShirt.variant_id);
  const otherColourVariant: Item = {
    ...deadShirt,
    variant_id: 'other-colour-variant-id',
    title: 'Wrinkle Resistant Stretch Satin Finish Dress Shirt - Black',
  };
  stock.set(deadShirt.id, { item: otherColourVariant, available: true, price: 35 });

  // Also verify product-id price fallback works ONLY when prodEntry.item.variant_id matches ours.
  const priceFallbackTop = outfitHealthyOne.pieces[0].item;
  stock.set(priceFallbackTop.variant_id, { item: null, available: true, price: null });
  stock.set(priceFallbackTop.id, {
    item: { ...priceFallbackTop, price: 48 },
    available: true,
    price: 48,
  });

  const mismatchedPriceTop = outfitHealthyTwo.pieces[0].item;
  stock.set(mismatchedPriceTop.variant_id, { item: null, available: true, price: null });
  stock.set(mismatchedPriceTop.id, {
    item: { ...mismatchedPriceTop, variant_id: 'different-variant', price: 99 },
    available: true,
    price: 99,
  });

  const swappedSlots: string[] = [];
  const replacementShirt = makeItem('Replacement Poplin Dress Shirt - White', 38, 'men');

  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
    swap: async (outfit, slot) => {
      swappedSlots.push(`${outfit.name}:${slot}`);
      const newPiece: Piece = { slot, why: 'Fresh in-stock shirt', item: replacementShirt };
      const nextPieces = outfit.pieces.map((p) => (p.slot === slot ? newPiece : p));
      return {
        outfit: { ...outfit, pieces: nextPieces },
        piece: newPiece,
      };
    },
  });

  // 1. serveLibrary treats the missing-variant shirt as sold out and swaps it.
  const served = await serveLibrary({ gender: 'men', occasion: 'date night dinner', budget_usd: 250 });
  assert.ok(served);
  assert.deepEqual(swappedSlots, ['Dead Variant Look:top']);
  assert.equal(served.outfits[0].pieces[0].item.variant_id, replacementShirt.variant_id);
  // Matching product-id entry updated price (40 -> 48); mismatched variant_id product entry did NOT (kept 42).
  assert.equal(served.outfits[1].pieces[0].item.price, 48);
  assert.equal(served.outfits[2].pieces[0].item.price, 42);

  // 2. libraryLooks (with and without occasion) excludes the dead-variant outfit completely.
  const looksWithOccasion = await libraryLooks('men', { occasion: 'date-night', limit: 6 });
  assert.deepEqual(
    looksWithOccasion.map((o) => o.name),
    ['Healthy One', 'Healthy Two'],
  );
  assert.equal(looksWithOccasion[0].pieces[0].item.price, 48);
  assert.equal(looksWithOccasion[1].pieces[0].item.price, 42);

  const looksAll = await libraryLooks('men', { limit: 6 });
  assert.deepEqual(
    looksAll.map((o) => o.name),
    ['Healthy One', 'Healthy Two'],
  );
});
