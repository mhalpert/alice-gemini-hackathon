// Tests for the premium budget tier of the ready-made outfit library (no network, fakes).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Brief, Gender, Item, Outfit, Piece } from '../src/types.ts';
import {
  _setDeps,
  baseKeyOf,
  chooseTier,
  isTierKey,
  libraryLooks,
  libraryOccasions,
  matchLibrary,
  serveLibrary,
  type LibraryFile,
  type LookupEntry,
} from '../src/library/index.ts';
import {
  parseArgs as parseBuildArgs,
  premiumBudget,
  runBuild,
  tierBudget,
  tierKey,
} from '../src/library/build.ts';
import { OCCASIONS } from '../src/library/occasions.ts';
import { gradeKey, runGrading, type GradesFile } from '../src/library/grade.ts';
import { getCallLogPath } from '../src/calllog.ts';

let seq = 0;
function makeItem(title: string, price: number, gender: Gender): Item {
  seq += 1;
  return {
    id: `tier-prod-${seq}`,
    variant_id: `tier-var-${seq}`,
    title,
    price,
    url: `https://example.com/p/${seq}`,
    image: `https://cdn.example.com/${seq}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.6,
    rating_count: 20,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description: title,
    department: gender,
  };
}

function makeOutfit(name: string, gender: Gender, prices: [number, number, number]): Outfit {
  const pieces: Piece[] = [
    { slot: 'top', why: 'Top', item: makeItem(`${name} Shirt`, prices[0], gender) },
    { slot: 'bottom', why: 'Bottom', item: makeItem(`${name} Pants`, prices[1], gender) },
    { slot: 'shoes', why: 'Shoes', item: makeItem(`${name} Shoes`, prices[2], gender) },
  ];
  const total = Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    name,
    difference: `Distinct ${name}`,
    story: `Built around ${name}.`,
    pieces,
    total,
  };
}

const tempDirs: string[] = [];

function createTempLibrary(file: LibraryFile): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-tiers-'));
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
  delete process.env.ALICE_LIBRARY_MIN_SCORE;
  delete process.env.ALICE_LIBRARY_MAX_BUDGET_RATIO;
  delete process.env.ALICE_LIBRARY_STOP_AT;
  delete process.env.ALICE_LIBRARY_ATTEMPTS;
  delete process.env.ALICE_LOG_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tier key helpers parse base and @premium keys cleanly', () => {
  assert.equal(baseKeyOf('first-date'), 'first-date');
  assert.equal(baseKeyOf('first-date@premium'), 'first-date');
  assert.equal(isTierKey('first-date'), false);
  assert.equal(isTierKey('first-date@premium'), true);
  assert.equal(tierKey('first-date', 'base'), 'first-date');
  assert.equal(tierKey('first-date', 'premium'), 'first-date@premium');
});

test('serveLibrary picks base vs @premium according to budget B * 1.2 and logs library_tier', async () => {
  const baseOutfits = [
    makeOutfit('Base Date 1', 'men', [45, 50, 50]),
    makeOutfit('Base Date 2', 'men', [40, 50, 55]),
    makeOutfit('Base Date 3', 'men', [45, 45, 50]),
  ];
  const premOutfits = [
    makeOutfit('Prem Date 1', 'men', [140, 150, 150]),
    makeOutfit('Prem Date 2', 'men', [130, 150, 160]),
    makeOutfit('Prem Date 3', 'men', [140, 140, 155]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'first-date',
        gender: 'men',
        occasion: 'first date at a cocktail bar',
        budget_usd: 150,
        outfits: baseOutfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
      {
        key: 'first-date@premium',
        gender: 'men',
        occasion: 'first date at a cocktail bar',
        budget_usd: 450,
        outfits: premOutfits,
        vectors: [[1, 0, 0]],
        built_ms: 600,
      },
    ],
  });

  const stock = allAvailableLookup([...baseOutfits, ...premOutfits]);
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
  });

  const logDir = mkdtempSync(path.join(tmpdir(), 'alice-tiers-log-'));
  tempDirs.push(logDir);
  process.env.ALICE_LOG_DIR = logDir;

  // B=150 -> base ($150 <= 180; $450 > 180)
  const res150 = await serveLibrary(
    { gender: 'men', occasion: 'cocktail bar first date', budget_usd: 150 },
    { room: 'room-b150' },
  );
  assert.ok(res150);
  assert.deepEqual(res150.outfits.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // B=500 -> @premium ($450 <= 600)
  const res500 = await serveLibrary(
    { gender: 'men', occasion: 'cocktail bar first date', budget_usd: 500 },
    { room: 'room-b500' },
  );
  assert.ok(res500);
  assert.deepEqual(res500.outfits.map((o) => o.name), ['Prem Date 1', 'Prem Date 2', 'Prem Date 3']);

  // B=300 -> base ($450 > 300 * 1.2 = 360)
  const res300 = await serveLibrary(
    { gender: 'men', occasion: 'cocktail bar first date', budget_usd: 300 },
    { room: 'room-b300' },
  );
  assert.ok(res300);
  assert.deepEqual(res300.outfits.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // B=400 -> @premium ($450 <= 400 * 1.2 = 480)
  const res400 = await serveLibrary(
    { gender: 'men', occasion: 'cocktail bar first date', budget_usd: 400 },
    { room: 'room-b400' },
  );
  assert.ok(res400);
  assert.deepEqual(res400.outfits.map((o) => o.name), ['Prem Date 1', 'Prem Date 2', 'Prem Date 3']);

  // B=100 (smaller than all tiers) -> picks smallest tier (base $150), then budget rescaling applies
  const pickedLow = chooseTier(
    [
      { key: 'first-date@premium', gender: 'men', occasion: 'date', budget_usd: 450, outfits: [], vectors: [], built_ms: 1 },
      { key: 'first-date', gender: 'men', occasion: 'date', budget_usd: 150, outfits: [], vectors: [], built_ms: 1 },
    ],
    100,
  );
  assert.equal(pickedLow?.key, 'first-date');

  // Verify library_tier call log event on both base and premium choices.
  const events500 = readFileSync(getCallLogPath('room-b500'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const tierEv500 = events500.find((e) => e.ev === 'library_tier');
  assert.ok(tierEv500);
  assert.equal(tierEv500.base, 'first-date');
  assert.equal(tierEv500.key, 'first-date@premium');
  assert.equal(tierEv500.budget, 500);

  const events300 = readFileSync(getCallLogPath('room-b300'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const tierEv300 = events300.find((e) => e.ev === 'library_tier');
  assert.ok(tierEv300);
  assert.equal(tierEv300.base, 'first-date');
  assert.equal(tierEv300.key, 'first-date');
  assert.equal(tierEv300.budget, 300);

  // matchLibrary also resolves the chosen tier key for the brief budget.
  const m150 = await matchLibrary({ gender: 'men', occasion: 'cocktail bar first date', budget_usd: 150 });
  const m500 = await matchLibrary({ gender: 'men', occasion: 'cocktail bar first date', budget_usd: 500 });
  assert.equal(m150?.key, 'first-date');
  assert.equal(m500?.key, 'first-date@premium');

  // 3x ratio rule applies against the chosen tier's budget ($450 * 3 = $1350): $1500 skips.
  const skipped = await serveLibrary({ gender: 'men', occasion: 'cocktail bar first date', budget_usd: 1500 });
  assert.equal(skipped, null);
});

test('serveLibrary tier choice works even when @premium appears before base in sets.json', async () => {
  const baseOutfits = [
    makeOutfit('Base First 1', 'women', [40, 40, 40]),
    makeOutfit('Base First 2', 'women', [40, 40, 40]),
    makeOutfit('Base First 3', 'women', [40, 40, 40]),
  ];
  const premOutfits = [
    makeOutfit('Prem First 1', 'women', [140, 140, 140]),
    makeOutfit('Prem First 2', 'women', [140, 140, 140]),
    makeOutfit('Prem First 3', 'women', [140, 140, 140]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'first-date@premium',
        gender: 'women',
        occasion: 'first date at a cocktail bar',
        budget_usd: 450,
        outfits: premOutfits,
        vectors: [[1, 0, 0]],
        built_ms: 600,
      },
      {
        key: 'first-date',
        gender: 'women',
        occasion: 'first date at a cocktail bar',
        budget_usd: 150,
        outfits: baseOutfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  const stock = allAvailableLookup([...baseOutfits, ...premOutfits]);
  _setDeps({
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    lookup: async () => stock,
  });

  const resBase = await serveLibrary({ gender: 'women', occasion: 'first date drinks', budget_usd: 150 });
  assert.ok(resBase);
  assert.deepEqual(resBase.outfits.map((o) => o.name), ['Base First 1', 'Base First 2', 'Base First 3']);

  const resPrem = await serveLibrary({ gender: 'women', occasion: 'first date drinks', budget_usd: 450 });
  assert.ok(resPrem);
  assert.deepEqual(resPrem.outfits.map((o) => o.name), ['Prem First 1', 'Prem First 2', 'Prem First 3']);
});

test('libraryOccasions shows no @premium keys and dedupes tiered sets', async () => {
  const baseDate = [
    makeOutfit('Date B1', 'men', [40, 40, 40]),
    makeOutfit('Date B2', 'men', [40, 40, 40]),
    makeOutfit('Date B3', 'men', [40, 40, 40]),
  ];
  const premDate = [
    makeOutfit('Date P1', 'men', [140, 140, 140]),
    makeOutfit('Date P2', 'men', [140, 140, 140]),
    makeOutfit('Date P3', 'men', [140, 140, 140]),
  ];
  const premGalaOnly = [
    makeOutfit('Gala P1', 'men', [200, 200, 200]),
    makeOutfit('Gala P2', 'men', [200, 200, 200]),
    makeOutfit('Gala P3', 'men', [200, 200, 200]),
  ];
  const premCustomOnly = [
    makeOutfit('Custom P1', 'men', [150, 150, 150]),
    makeOutfit('Custom P2', 'men', [150, 150, 150]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      { key: 'first-date', gender: 'men', occasion: 'first date at a cocktail bar', budget_usd: 150, outfits: baseDate, vectors: [[1, 0, 0]], built_ms: 500 },
      { key: 'first-date@premium', gender: 'men', occasion: 'first date at a cocktail bar', budget_usd: 450, outfits: premDate, vectors: [[1, 0, 0]], built_ms: 500 },
      { key: 'gala@premium', gender: 'men', occasion: 'black tie optional gala', budget_usd: 630, outfits: premGalaOnly, vectors: [[0, 1, 0]], built_ms: 500 },
      { key: 'custom-event@premium', gender: 'men', occasion: 'private yacht dinner', budget_usd: 600, outfits: premCustomOnly, vectors: [[0, 0, 1]], built_ms: 500 },
    ],
  });

  const occs = await libraryOccasions('men');
  assert.deepEqual(
    occs.map((o) => o.key),
    ['first-date', 'gala', 'custom-event'],
  );
  assert.ok(occs.every((o) => !o.key.includes('@premium')));
});

test('libraryLooks with base key returns base tier by default and uses tier rule when budget is given', async () => {
  const baseDate = [
    makeOutfit('Base Date 1', 'men', [40, 40, 40]),
    makeOutfit('Base Date 2', 'men', [40, 40, 40]),
    makeOutfit('Base Date 3', 'men', [40, 40, 40]),
  ];
  const premDate = [
    makeOutfit('Prem Date 1', 'men', [140, 140, 140]),
    makeOutfit('Prem Date 2', 'men', [140, 140, 140]),
    makeOutfit('Prem Date 3', 'men', [140, 140, 140]),
  ];

  createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      { key: 'first-date@premium', gender: 'men', occasion: 'first date at a cocktail bar', budget_usd: 450, outfits: premDate, vectors: [[1, 0, 0]], built_ms: 500 },
      { key: 'first-date', gender: 'men', occasion: 'first date at a cocktail bar', budget_usd: 150, outfits: baseDate, vectors: [[1, 0, 0]], built_ms: 500 },
    ],
  });

  const stock = allAvailableLookup([...baseDate, ...premDate]);
  let embedCalls = 0;
  _setDeps({
    embed: async (texts) => {
      embedCalls += 1;
      return texts.map(() => [1, 0, 0]);
    },
    lookup: async () => stock,
  });

  // Base key without budget -> base tier, no embed call
  const baseLooks = await libraryLooks('men', { occasion: 'first-date' });
  assert.equal(embedCalls, 0);
  assert.deepEqual(baseLooks.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // Base key with budget=300 -> base tier (450 > 360)
  const looks300 = await libraryLooks('men', { occasion: 'first-date', budget: 300 });
  assert.equal(embedCalls, 0);
  assert.deepEqual(looks300.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // Base key with budget=400 -> @premium tier (450 <= 480)
  const looks400 = await libraryLooks('men', { occasion: 'first-date', budget: 400 });
  assert.equal(embedCalls, 0);
  assert.deepEqual(looks400.map((o) => o.name), ['Prem Date 1', 'Prem Date 2', 'Prem Date 3']);

  // Storefront browse without occasion dedupes base/@premium (returns only base looks)
  const browse = await libraryLooks('men', { limit: 6 });
  assert.deepEqual(browse.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // Free-text occasion without budget returns base tier (not @premium)
  const freeBase = await libraryLooks('men', { occasion: 'cocktail bar drinks' });
  assert.deepEqual(freeBase.map((o) => o.name), ['Base Date 1', 'Base Date 2', 'Base Date 3']);

  // Free-text occasion with budget=500 returns @premium tier
  const freePrem = await libraryLooks('men', { occasion: 'cocktail bar drinks', budget: 500 });
  assert.deepEqual(freePrem.map((o) => o.name), ['Prem Date 1', 'Prem Date 2', 'Prem Date 3']);
});

test('build.ts --tier premium computes expected budgets and caps at 1500', () => {
  const firstDate = OCCASIONS.find((o) => o.key === 'first-date')!;
  const summerWedding = OCCASIONS.find((o) => o.key === 'summer-wedding')!;
  const gala = OCCASIONS.find((o) => o.key === 'gala')!;

  // first-date men 150 -> max(450, round(375/10)*10=380) = 450
  assert.equal(premiumBudget(firstDate, 'men'), 450);
  assert.equal(tierBudget(firstDate, 'men', 'premium'), 450);
  assert.equal(tierBudget(firstDate, 'men', 'base'), 150);

  // summer-wedding men 200 -> max(450, round(500/10)*10=500) = 500
  assert.equal(premiumBudget(summerWedding, 'men'), 500);

  // gala women 250 -> max(450, round(625/10)*10=630) = 630
  assert.equal(premiumBudget(gala, 'women'), 630);

  // cap at 1500
  assert.equal(premiumBudget({ budget: { men: 700, women: 700 } }, 'men'), 1500);

  // CLI arg parsing
  const parsed = parseBuildArgs(['--tier', 'premium', '--only', 'first-date,gala', '--gender', 'men', '--resume']);
  assert.equal(parsed.tier, 'premium');
  assert.deepEqual([...parsed.only!], ['first-date', 'gala']);
  assert.deepEqual(parsed.genders, ['men']);
  assert.equal(parsed.resume, true);

  const parsedEq = parseBuildArgs(['--tier=premium', '--rebuild']);
  assert.equal(parsedEq.tier, 'premium');
  assert.equal(parsedEq.resume, false);

  assert.throws(() => parseBuildArgs(['--tier', 'ultra']), /Invalid --tier/);
});

test('runBuild --tier premium saves <base>@premium with premium budget, reuses base vectors, and resumes cleanly', async () => {
  const existingBaseVector = [[0.6, 0.8, 0]];
  const setsPath = createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'first-date',
        gender: 'men',
        occasion: 'first date at a cocktail bar',
        budget_usd: 150,
        outfits: [
          makeOutfit('Base 1', 'men', [40, 40, 40]),
          makeOutfit('Base 2', 'men', [40, 40, 40]),
          makeOutfit('Base 3', 'men', [40, 40, 40]),
        ],
        vectors: existingBaseVector,
        built_ms: 400,
      },
    ],
  });

  process.env.ALICE_LIBRARY_STOP_AT = 'off';

  const seenBriefs: Brief[] = [];
  let embedCalls = 0;

  const args = parseBuildArgs(['--tier', 'premium', '--only', 'first-date,summer-wedding', '--gender', 'men']);
  const summary = await runBuild(args, {
    buildLive: async (brief) => {
      seenBriefs.push(brief);
      const each = Math.floor(brief.budget_usd / 3) - 10;
      return {
        outfits: [
          makeOutfit(`${brief.occasion} 1`, brief.gender, [each, each, each]),
          makeOutfit(`${brief.occasion} 2`, brief.gender, [each, each, each]),
          makeOutfit(`${brief.occasion} 3`, brief.gender, [each, each, each]),
        ],
        source: 'live',
        timing: { first_outfit_ms: 10, total_ms: 20 },
        problems: [],
      };
    },
    embed: async (texts) => {
      embedCalls += 1;
      return texts.map(() => [0, 1, 0]);
    },
    log: () => {},
  });

  assert.equal(summary.total, 2);
  assert.equal(summary.kept, 2);
  assert.equal(summary.failed, 0);
  // first-date reused base vectors, summer-wedding had no base set so embedded once
  assert.equal(embedCalls, 1);

  const byOcc = new Map(seenBriefs.map((b) => [b.occasion, b.budget_usd]));
  assert.equal(byOcc.get('first date at a cocktail bar'), 450);
  assert.equal(byOcc.get('outdoor summer wedding guest'), 500);

  const saved = JSON.parse(readFileSync(setsPath, 'utf8')) as LibraryFile;
  const premFirstDate = saved.sets.find((s) => s.key === 'first-date@premium' && s.gender === 'men');
  const premWedding = saved.sets.find((s) => s.key === 'summer-wedding@premium' && s.gender === 'men');
  assert.ok(premFirstDate);
  assert.equal(premFirstDate.budget_usd, 450);
  assert.deepEqual(premFirstDate.vectors, existingBaseVector);
  assert.ok(premWedding);
  assert.equal(premWedding.budget_usd, 500);
  assert.ok(premWedding.vectors.length > 0);

  // Resume skips existing @premium sets without invoking buildLive.
  let resumeCalls = 0;
  const resumeSummary = await runBuild(args, {
    buildLive: async () => {
      resumeCalls += 1;
      throw new Error('should not rebuild existing @premium sets on resume');
    },
    log: () => {},
  });
  assert.equal(resumeCalls, 0);
  assert.equal(resumeSummary.total, 0);
  assert.equal(resumeSummary.skipped, 2);
});

test('grade.ts grades @premium sets under "<key>@premium|<gender>" and emits --tier premium rebuild command on fail', async () => {
  const outfits = [
    makeOutfit('Prem Gala 1', 'women', [200, 200, 200]),
    makeOutfit('Prem Gala 2', 'women', [200, 200, 200]),
    makeOutfit('Prem Gala 3', 'women', [200, 200, 200]),
  ];
  const setsPath = createTempLibrary({
    version: 1,
    built_at: new Date().toISOString(),
    sets: [
      {
        key: 'gala@premium',
        gender: 'women',
        occasion: 'black tie optional gala',
        budget_usd: 630,
        outfits,
        vectors: [[1, 0, 0]],
        built_ms: 500,
      },
    ],
  });

  const summary = await runGrading(
    { only: new Set(['gala@premium']), genders: ['women'], regrade: false },
    {
      critiqueAll: async (list) =>
        list.map((_, i) => ({
          score: i === 0 ? 8 : 4,
          presentable: i === 0,
          issues: i === 0 ? [] : ['too casual'],
          weak_piece: null,
        })),
      log: () => {},
    },
  );

  assert.equal(summary.total, 1);
  assert.equal(summary.failed, 1);
  assert.ok(
    summary.lines.includes(
      'node --env-file-if-exists=.env.local src/library/build.ts --tier premium --rebuild --only gala --gender women',
    ),
  );

  const gradesPath = path.join(path.dirname(setsPath), 'grades.json');
  const gradesFile = JSON.parse(readFileSync(gradesPath, 'utf8')) as GradesFile;
  assert.ok(gradesFile.grades[gradeKey('gala@premium', 'women')]);
  assert.equal(gradesFile.grades[gradeKey('gala@premium', 'women')].pass, false);
});
