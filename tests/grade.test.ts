// Tests for src/library/grade.ts (no network).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Gender, Item, Outfit, Piece } from '../src/types.ts';
import type { Critique } from '../src/brain/critic.ts';
import type { LibraryFile, LibrarySet } from '../src/library/index.ts';
import {
  _setDeps,
  evaluateSetCritiques,
  gradeKey,
  parseArgs,
  poolBestOutfits,
  runGrading,
  runImprove,
  type GradesFile,
} from '../src/library/grade.ts';
import { logEvent } from '../src/store/log.ts';

let seq = 0;
function makeItem(title: string, price: number, gender: Gender, extra: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `g-prod-${seq}`,
    variant_id: `g-var-${seq}`,
    title,
    price,
    url: `https://example.com/p/${seq}`,
    image: `https://cdn.example.com/${seq}.jpg`,
    store: 'Kith',
    store_domain: 'kith.myshopify.com',
    rating: 4.5,
    rating_count: 10,
    sizes: ['M', 'L'],
    variants_by_size: {},
    description: title,
    department: gender,
    ...extra,
  };
}

function makeOutfit(name: string, gender: Gender, pieces: Piece[]): Outfit {
  const total = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
  return {
    name,
    difference: `Distinct ${name}`,
    story: `Story for ${name}`,
    pieces,
    total,
  };
}

function makeBasicOutfit(name: string, gender: Gender, accessoryTitle?: string): Outfit {
  const pieces: Piece[] = [
    { slot: 'top', why: 'Top', item: makeItem(`${name} Shirt`, 60, gender) },
    { slot: 'bottom', why: 'Bottom', item: makeItem(`${name} Trouser`, 80, gender) },
    { slot: 'shoes', why: 'Shoes', item: makeItem(`${name} Oxford`, 100, gender) },
  ];
  if (accessoryTitle) {
    pieces.push({ slot: 'accessory', why: 'Tie', item: makeItem(accessoryTitle, 50, gender) });
  }
  return makeOutfit(name, gender, pieces);
}

function makeCritique(score: number, presentable: boolean, extra: Partial<Critique> = {}): Critique {
  return {
    score,
    presentable,
    occasion_fit: score,
    cohesion: score,
    completeness: score,
    issues: [],
    weak_piece: null,
    model: 'gemini-4-argon',
    ms: 100,
    ...extra,
  };
}

const tempDirs: string[] = [];

function createTempSets(sets: LibrarySet[]): { dir: string; setsPath: string; gradesPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-grade-'));
  tempDirs.push(dir);
  const setsPath = path.join(dir, 'sets.json');
  const gradesPath = path.join(dir, 'grades.json');
  const payload: LibraryFile = {
    version: 1,
    built_at: '2026-11-21T12:00:00.000Z',
    sets,
  };
  writeFileSync(setsPath, JSON.stringify(payload), 'utf8');
  process.env.ALICE_LIBRARY_FILE = setsPath;
  return { dir, setsPath, gradesPath };
}

afterEach(() => {
  _setDeps(null);
  delete process.env.ALICE_LIBRARY_FILE;
  delete process.env.ALICE_LIBRARY_MAX_PAID;
  delete process.env.ALICE_LIBRARY_STOP_AT;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs parses --only, --gender, --regrade, --improve, --max-attempts, --keep, and --all', () => {
  assert.deepEqual(parseArgs([]), {
    only: null,
    genders: ['men', 'women'],
    regrade: false,
    improve: false,
    maxAttempts: 3,
    keep: 3,
    all: false,
  });
  const parsed = parseArgs([
    '--only', 'gala,interview-bank',
    '--gender', 'men',
    '--regrade',
    '--improve',
    '--max-attempts', '5',
    '--keep', '5',
    '--all',
  ]);
  assert.deepEqual([...parsed.only!], ['gala', 'interview-bank']);
  assert.deepEqual(parsed.genders, ['men']);
  assert.equal(parsed.regrade, true);
  assert.equal(parsed.improve, true);
  assert.equal(parsed.maxAttempts, 5);
  assert.equal(parsed.keep, 5);
  assert.equal(parsed.all, true);

  const eq = parseArgs(['--only=rooftop-birthday', '--gender=women', '--max-attempts=2', '--keep=6']);
  assert.deepEqual([...eq.only!], ['rooftop-birthday']);
  assert.deepEqual(eq.genders, ['women']);
  assert.equal(eq.maxAttempts, 2);
  assert.equal(eq.keep, 6);
  assert.equal(eq.all, false);

  assert.equal(parseArgs(['--keep', '3']).keep, 3);
  assert.throws(() => parseArgs(['--keep', '2']), /Invalid --keep/);
  assert.throws(() => parseArgs(['--keep', '7']), /Invalid --keep/);
  assert.throws(() => parseArgs(['--keep=4.5']), /Invalid --keep/);
  assert.throws(() => parseArgs(['--keep=abc']), /Invalid --keep/);
  assert.throws(() => parseArgs(['--keep']), /Invalid --keep/);
  assert.throws(() => parseArgs(['--keep=']), /Invalid --keep/);
});

test('evaluateSetCritiques applies breaksDressCode and pass rule', () => {
  const set: LibrarySet = {
    key: 'gala',
    gender: 'men',
    occasion: 'black tie optional gala',
    budget_usd: 400,
    outfits: [
      makeBasicOutfit('Knicks Look', 'men', 'Kith for the New York Knicks Silk Tie'),
      makeBasicOutfit('Printed Look', 'men', 'Kith Printed Silk Neck Tie - Sage'),
      makeBasicOutfit('Classic Look', 'men', 'Solid Silk Tie - Black'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 12345,
  };

  // Even if Argon marks all 3 presentable with score 8, breaksDressCode must fail the first two.
  const res = evaluateSetCritiques(
    set,
    [makeCritique(8, true), makeCritique(8, true), makeCritique(8, true)],
    '2026-11-21T12:00:00.000Z',
  );
  assert.equal(res.hadError, false);
  assert.ok(res.grade);
  assert.equal(res.grade.set_built_at, 12345);
  assert.equal(res.grade.outfits[0].presentable, false);
  assert.ok(res.grade.outfits[0].issues.some((i) => i.includes('Knicks')));
  assert.equal(res.grade.outfits[1].presentable, false);
  assert.equal(res.grade.outfits[2].presentable, true);
  assert.equal(res.grade.presentable_count, 1);
  assert.equal(res.grade.pass, false);

  // Two presentable outfits with scores 8 and 7 plus one non-presentable score 3 must PASS (min >= 5 among presentable).
  const set2: LibrarySet = {
    ...set,
    outfits: [
      makeBasicOutfit('Good One', 'men', 'Solid Silk Tie - Black'),
      makeBasicOutfit('Good Two', 'men', 'Solid Silk Tie - Navy'),
      makeBasicOutfit('Bad Three', 'men', 'Kith for the New York Knicks Silk Tie'),
    ],
  };
  const res2 = evaluateSetCritiques(
    set2,
    [makeCritique(8, true), makeCritique(7, true), makeCritique(3, false, { issues: ['mismatch'] })],
    '2026-11-21T12:00:00.000Z',
  );
  assert.ok(res2.grade);
  assert.equal(res2.grade.presentable_count, 2);
  assert.equal(res2.grade.pass, true);
});

test('runGrading writes grades.json atomically, never modifies sets.json, skips cached, and emits rebuild commands', async () => {
  const galaMen: LibrarySet = {
    key: 'gala',
    gender: 'men',
    occasion: 'black tie optional gala',
    budget_usd: 400,
    outfits: [
      makeBasicOutfit('Gala M1', 'men', 'Kith for the New York Knicks Silk Tie'),
      makeBasicOutfit('Gala M2', 'men', 'Kith Printed Silk Neck Tie - Sage'),
      makeBasicOutfit('Gala M3', 'men', 'Solid Silk Tie - Black'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 1111,
  };
  const galaWomen: LibrarySet = {
    key: 'gala',
    gender: 'women',
    occasion: 'black tie optional gala',
    budget_usd: 400,
    outfits: [
      makeBasicOutfit('Gala W1', 'women'),
      makeBasicOutfit('Gala W2', 'women'),
      makeBasicOutfit('Gala W3', 'women'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 2222,
  };
  const birthdayMen: LibrarySet = {
    key: 'rooftop-birthday',
    gender: 'men',
    occasion: "a friend's rooftop birthday party",
    budget_usd: 150,
    outfits: [
      makeBasicOutfit('Roof M1', 'men', 'Kith Printed Silk Neck Tie - Sage'),
      makeBasicOutfit('Roof M2', 'men'),
      makeBasicOutfit('Roof M3', 'men'),
    ],
    vectors: [[0, 1, 0]],
    built_ms: 3333,
  };

  const { setsPath, gradesPath } = createTempSets([galaMen, galaWomen, birthdayMen]);
  const originalSetsContent = readFileSync(setsPath, 'utf8');

  let calls = 0;
  const summary = await runGrading(
    { only: null, genders: ['men', 'women'], regrade: false },
    {
      critiqueAll: async (outfits, brief) => {
        calls += 1;
        if (brief.gender === 'women' && brief.occasion.includes('gala')) {
          return [
            makeCritique(4, false, { issues: ['too casual'] }),
            makeCritique(5, false, { issues: ['wrong shoes'] }),
            makeCritique(8, true),
          ];
        }
        return outfits.map(() => makeCritique(8, true));
      },
      log: () => {},
    },
  );

  // sets.json must be untouched.
  assert.equal(readFileSync(setsPath, 'utf8'), originalSetsContent);
  assert.equal(calls, 3);
  assert.equal(summary.graded, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.failedByGender, { men: ['gala'], women: ['gala'] });

  // Last two lines should be the per-gender rebuild commands.
  assert.equal(
    summary.lines[summary.lines.length - 2],
    'node --env-file-if-exists=.env.local src/library/build.ts --rebuild --only gala --gender men',
  );
  assert.equal(
    summary.lines[summary.lines.length - 1],
    'node --env-file-if-exists=.env.local src/library/build.ts --rebuild --only gala --gender women',
  );

  const saved = JSON.parse(readFileSync(gradesPath, 'utf8')) as GradesFile;
  assert.equal(saved.version, 1);
  assert.equal(saved.grades[gradeKey('gala', 'men')].pass, false);
  assert.equal(saved.grades[gradeKey('gala', 'women')].pass, false);
  assert.equal(saved.grades[gradeKey('rooftop-birthday', 'men')].pass, true);

  // Second run without --regrade skips all 3 sets.
  let calls2 = 0;
  const summary2 = await runGrading(
    { only: null, genders: ['men', 'women'], regrade: false },
    {
      critiqueAll: async () => {
        calls2 += 1;
        return [];
      },
      log: () => {},
    },
  );
  assert.equal(calls2, 0);
  assert.equal(summary2.skipped, 3);
  assert.equal(summary2.graded, 0);

  // Changing outfit names in sets.json triggers regrading of only that set.
  const updatedSets: LibraryFile = JSON.parse(originalSetsContent);
  updatedSets.sets[0].outfits[0].name = 'Gala M1 Rebuilt';
  writeFileSync(setsPath, JSON.stringify(updatedSets), 'utf8');

  let calls3 = 0;
  const summary3 = await runGrading(
    { only: null, genders: ['men', 'women'], regrade: false },
    {
      critiqueAll: async (outfits) => {
        calls3 += 1;
        return outfits.map(() => makeCritique(8, true));
      },
      log: () => {},
    },
  );
  assert.equal(calls3, 1);
  assert.equal(summary3.graded, 1);
  assert.equal(summary3.skipped, 2);
});

test('critic errors (score 0 with error) do not mark the set failed and are retried on the next run', async () => {
  const interviewMen: LibrarySet = {
    key: 'interview-bank',
    gender: 'men',
    occasion: 'bank job interview',
    budget_usd: 300,
    outfits: [
      makeBasicOutfit('Bank 1', 'men'),
      makeBasicOutfit('Bank 2', 'men'),
      makeBasicOutfit('Bank 3', 'men'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 4444,
  };

  const { gradesPath } = createTempSets([interviewMen]);

  let attempt = 0;
  const run1 = await runGrading(
    { only: null, genders: ['men'], regrade: false },
    {
      critiqueAll: async () => {
        attempt += 1;
        if (attempt === 1) {
          return [
            makeCritique(8, true),
            makeCritique(0, false, { error: '429 rate limited' }),
            makeCritique(7, true),
          ];
        }
        return [makeCritique(8, true), makeCritique(7, true), makeCritique(7, true)];
      },
      log: () => {},
    },
  );

  assert.equal(run1.failed, 0);
  assert.equal(run1.errored, 1);
  assert.deepEqual(run1.failedByGender.men, []);
  // No rebuild command emitted because it errored, not failed.
  assert.ok(!run1.lines.some((l) => l.includes('--rebuild')));

  // Next run retries it and succeeds.
  const run2 = await runGrading(
    { only: null, genders: ['men'], regrade: false },
    {
      critiqueAll: async () => [makeCritique(8, true), makeCritique(7, true), makeCritique(7, true)],
      log: () => {},
    },
  );
  assert.equal(run2.graded, 1);
  assert.equal(run2.passed, 1);
  assert.equal(run2.errored, 0);
  const saved = JSON.parse(readFileSync(gradesPath, 'utf8')) as GradesFile;
  assert.equal(saved.grades[gradeKey('interview-bank', 'men')].pass, true);
});

test('poolBestOutfits ranks clean outfits ahead of dress-code hits, then by score, fewer issues, dedupes, and renumbers 1..3', () => {
  const existing1 = makeBasicOutfit('Old Best', 'men', 'Solid Silk Tie - Black');
  const existing2 = makeBasicOutfit('Old Mid Many Issues', 'men', 'Solid Silk Tie - Navy');
  const duplicateOfBest = structuredClone(existing1);
  duplicateOfBest.name = 'Duplicate Of Best';
  // Reverse piece order to confirm variant_id SET comparison (order-independent).
  duplicateOfBest.pieces.reverse();
  const incomingTieCleaner = makeBasicOutfit('New Mid Cleaner', 'men', 'Solid Silk Tie - Charcoal');
  const incomingTop = makeBasicOutfit('New Top', 'men', 'Solid Silk Tie - Black');
  const incomingDressCodeHit = makeBasicOutfit('Knicks High Score', 'men', 'Kith for the New York Knicks Silk Tie');
  const galaBrief = { occasion: 'black tie optional gala', gender: 'men' };

  const pooled = poolBestOutfits(
    [
      { outfit: existing1, grade: { name: existing1.name, score: 8, presentable: true, issues: [], weak_piece: null } },
      { outfit: existing2, grade: { name: existing2.name, score: 7, presentable: true, issues: ['issue1', 'issue2'], weak_piece: null } },
    ],
    [
      { outfit: duplicateOfBest, grade: { name: duplicateOfBest.name, score: 8, presentable: true, issues: ['extra'], weak_piece: null } },
      { outfit: incomingTieCleaner, grade: { name: incomingTieCleaner.name, score: 7, presentable: true, issues: ['only1'], weak_piece: null } },
      { outfit: incomingTop, grade: { name: incomingTop.name, score: 9, presentable: true, issues: [], weak_piece: null } },
      { outfit: incomingDressCodeHit, grade: { name: incomingDressCodeHit.name, score: 10, presentable: false, issues: ['dress code: Kith for the New York Knicks Silk Tie (accessory)'], weak_piece: null } },
    ],
    3,
    galaBrief,
  );

  assert.deepEqual(
    pooled.map((p) => [p.outfit.number, p.outfit.name, p.grade.score]),
    [
      [1, 'New Top', 9],
      [2, 'Old Best', 8],
      [3, 'New Mid Cleaner', 7],
    ],
  );
});

test('runImprove pools best 3 across attempts, stops early on pass, updates sets.json + grades.json, and preserves other sets', async () => {
  const galaOld1 = makeBasicOutfit('Gala Old 1', 'men', 'Solid Silk Tie - Black');
  const galaOld2 = makeBasicOutfit('Gala Old 2', 'men', 'Kith for the New York Knicks Silk Tie');
  const galaOld3 = makeBasicOutfit('Gala Old 3', 'men', 'Solid Silk Tie - Charcoal');

  const galaSet: LibrarySet = {
    key: 'gala',
    gender: 'men',
    occasion: 'black tie optional gala',
    budget_usd: 400,
    outfits: [galaOld1, galaOld2, galaOld3],
    vectors: [[1, 0, 0]],
    built_ms: 1000,
  };
  const keepSet: LibrarySet = {
    key: 'rooftop-birthday',
    gender: 'men',
    occasion: "a friend's rooftop birthday party",
    budget_usd: 150,
    outfits: [
      makeBasicOutfit('Roof 1', 'men'),
      makeBasicOutfit('Roof 2', 'men'),
      makeBasicOutfit('Roof 3', 'men'),
    ],
    vectors: [[0, 1, 0]],
    built_ms: 2000,
  };

  const { setsPath, gradesPath } = createTempSets([galaSet, keepSet]);
  process.env.ALICE_LIBRARY_STOP_AT = 'off';

  // Seed grades.json: gala fails (only 1 presentable: score 7), rooftop-birthday passes (should be skipped).
  writeFileSync(
    gradesPath,
    JSON.stringify({
      version: 1,
      graded_at: '2026-11-21T12:00:00.000Z',
      grades: {
        'gala|men': {
          graded_at: '2026-11-21T12:00:00.000Z',
          set_built_at: 1000,
          outfits: [
            { name: 'Gala Old 1', score: 7, presentable: true, issues: [], weak_piece: null },
            { name: 'Gala Old 2', score: 4, presentable: false, issues: ['novelty tie'], weak_piece: null },
            { name: 'Gala Old 3', score: 5, presentable: false, issues: ['casual shoes'], weak_piece: null },
          ],
          min: 4,
          avg: 5.33,
          presentable_count: 1,
          pass: false,
        },
        'rooftop-birthday|men': {
          graded_at: '2026-11-21T12:00:00.000Z',
          set_built_at: 2000,
          outfits: [
            { name: 'Roof 1', score: 8, presentable: true, issues: [], weak_piece: null },
            { name: 'Roof 2', score: 8, presentable: true, issues: [], weak_piece: null },
            { name: 'Roof 3', score: 7, presentable: true, issues: [], weak_piece: null },
          ],
          min: 7,
          avg: 7.67,
          presentable_count: 3,
          pass: true,
        },
      },
    }),
    'utf8',
  );

  // Attempt 1 produces one duplicate of Gala Old 1, one bad tie (caught by breaksDressCode), and one score-6.
  // Attempt 2 produces a score-9 presentable look -> pooled top 3 is [9, 7, 6] with 2 presentable -> passes & stops early (no attempt 3).
  const dupOfOld1 = structuredClone(galaOld1);
  dupOfOld1.name = 'Gala Dup 1';
  const knicksNew = makeBasicOutfit('Gala Knicks New', 'men', 'Kith for the New York Knicks Silk Tie');
  const decentNew = makeBasicOutfit('Gala Six New', 'men', 'Solid Silk Tie - Navy');
  const greatNew = makeBasicOutfit('Gala Nine New', 'men', 'Solid Silk Tie - Black');
  const weakNew = makeBasicOutfit('Gala Four New', 'men', 'Solid Silk Tie - Black');

  let buildCalls = 0;
  _setDeps({
    buildLive: async () => {
      buildCalls += 1;
      if (buildCalls === 1) {
        return {
          outfits: [dupOfOld1, knicksNew, decentNew],
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 20 },
          problems: [],
        };
      }
      return {
        outfits: [greatNew, weakNew],
        source: 'live',
        timing: { first_outfit_ms: 10, total_ms: 20 },
        problems: [],
      };
    },
    critiqueAll: async (outfits) =>
      outfits.map((o) => {
        if (o.name === 'Gala Dup 1') return makeCritique(7, true, { issues: ['duplicate'] });
        if (o.name === 'Gala Knicks New') return makeCritique(8, true); // breaksDressCode must mark not presentable
        if (o.name === 'Gala Six New') return makeCritique(6, false, { issues: ['minor'] });
        if (o.name === 'Gala Nine New') return makeCritique(9, true);
        return makeCritique(4, false, { issues: ['weak'] });
      }),
    log: () => {},
  });

  const summary = await runImprove({ only: null, genders: ['men'], maxAttempts: 3 });

  assert.equal(buildCalls, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.improved, 1);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.estimatedSpend, 0.24);
  assert.ok(
    summary.lines.some((l) => l === 'gala men attempts=2 scores before=[7,4,5] after=[9,7,6] pass'),
    `Unexpected lines: ${summary.lines.join('\n')}`,
  );

  // Verify sets.json kept rooftop-birthday untouched and updated gala with improved_at, built_ms, and renumbered 1..3.
  const updatedLib = JSON.parse(readFileSync(setsPath, 'utf8')) as LibraryFile;
  assert.equal(updatedLib.sets.length, 2);
  const updatedGala = updatedLib.sets.find((s) => s.key === 'gala' && s.gender === 'men')!;
  const untouchedRoof = updatedLib.sets.find((s) => s.key === 'rooftop-birthday' && s.gender === 'men')!;
  assert.ok(updatedGala.improved_at);
  assert.equal(typeof updatedGala.built_ms, 'number');
  assert.deepEqual(
    updatedGala.outfits.map((o) => [o.number, o.name]),
    [
      [1, 'Gala Nine New'],
      [2, 'Gala Old 1'],
      [3, 'Gala Six New'],
    ],
  );
  assert.deepEqual(untouchedRoof.outfits.map((o) => o.name), ['Roof 1', 'Roof 2', 'Roof 3']);

  const updatedGrades = JSON.parse(readFileSync(gradesPath, 'utf8')) as GradesFile;
  const galaGrade = updatedGrades.grades['gala|men'];
  assert.equal(galaGrade.pass, true);
  assert.equal(galaGrade.presentable_count, 2);
  assert.equal(galaGrade.set_built_at, updatedGala.built_ms);
  assert.equal(galaGrade.outfits[2].presentable, false);
});

test('runImprove respects ALICE_LIBRARY_MAX_PAID spend cap and store rate_limited stop signal', async () => {
  const failingSet: LibrarySet = {
    key: 'interview-bank',
    gender: 'men',
    occasion: 'job interview at a bank',
    budget_usd: 200,
    outfits: [
      makeBasicOutfit('Bank 1', 'men'),
      makeBasicOutfit('Bank 2', 'men'),
      makeBasicOutfit('Bank 3', 'men'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 500,
  };
  const { gradesPath } = createTempSets([failingSet]);
  writeFileSync(
    gradesPath,
    JSON.stringify({
      version: 1,
      graded_at: '2026-11-21T12:00:00.000Z',
      grades: {
        'interview-bank|men': {
          graded_at: '2026-11-21T12:00:00.000Z',
          set_built_at: 500,
          outfits: [
            { name: 'Bank 1', score: 4, presentable: false, issues: ['bad'], weak_piece: null },
            { name: 'Bank 2', score: 4, presentable: false, issues: ['bad'], weak_piece: null },
            { name: 'Bank 3', score: 4, presentable: false, issues: ['bad'], weak_piece: null },
          ],
          min: 4,
          avg: 4,
          presentable_count: 0,
          pass: false,
        },
      },
    }),
    'utf8',
  );

  // Spend cap of $0.15 allows only 1 attempt ($0.12) out of maxAttempts=3.
  process.env.ALICE_LIBRARY_STOP_AT = 'off';
  process.env.ALICE_LIBRARY_MAX_PAID = '0.15';
  let calls = 0;
  const capRes = await runImprove(
    { only: null, genders: ['men'], maxAttempts: 3 },
    {
      buildLive: async () => {
        calls += 1;
        return {
          outfits: [makeBasicOutfit(`Try ${calls}`, 'men')],
          source: 'live',
          timing: { first_outfit_ms: 5, total_ms: 10 },
          problems: [],
        };
      },
      critiqueAll: async (outfits) => outfits.map(() => makeCritique(5, false, { issues: ['meh'] })),
      log: () => {},
    },
  );
  assert.equal(calls, 1);
  assert.equal(capRes.stopReason, 'spend cap');

  // Rate-limit event during attempt 1 prevents attempt 2.
  process.env.ALICE_LIBRARY_MAX_PAID = '15';
  let rlCalls = 0;
  const rlRes = await runImprove(
    { only: null, genders: ['men'], maxAttempts: 3 },
    {
      buildLive: async () => {
        rlCalls += 1;
        logEvent('store_error', { code: 'rate_limited' });
        return {
          outfits: [makeBasicOutfit(`RL ${rlCalls}`, 'men')],
          source: 'live',
          timing: { first_outfit_ms: 5, total_ms: 10 },
          problems: [],
        };
      },
      critiqueAll: async (outfits) => outfits.map(() => makeCritique(5, false, { issues: ['meh'] })),
      log: () => {},
    },
  );
  assert.equal(rlCalls, 1);
  assert.equal(rlRes.stopReason, 'rate_limited');
});

test('poolBestOutfits keeps up to 5 outfits numbered 1..5 when limit=5', () => {
  const existing = [
    makeBasicOutfit('Old 1', 'men'),
    makeBasicOutfit('Old 2', 'men'),
    makeBasicOutfit('Old 3', 'men'),
  ];
  const incoming = [
    makeBasicOutfit('New 1', 'men'),
    makeBasicOutfit('New 2', 'men'),
    makeBasicOutfit('New 3', 'men'),
  ];
  const pooled = poolBestOutfits(
    [
      { outfit: existing[0], grade: { name: 'Old 1', score: 8, presentable: true, issues: [], weak_piece: null } },
      { outfit: existing[1], grade: { name: 'Old 2', score: 6, presentable: true, issues: ['minor'], weak_piece: null } },
      { outfit: existing[2], grade: { name: 'Old 3', score: 5, presentable: false, issues: ['weak'], weak_piece: null } },
    ],
    [
      { outfit: incoming[0], grade: { name: 'New 1', score: 9, presentable: true, issues: [], weak_piece: null } },
      { outfit: incoming[1], grade: { name: 'New 2', score: 7, presentable: true, issues: [], weak_piece: null } },
      { outfit: incoming[2], grade: { name: 'New 3', score: 8, presentable: true, issues: ['small'], weak_piece: null } },
    ],
    5,
    { occasion: 'rooftop birthday', gender: 'men' },
  );

  assert.equal(pooled.length, 5);
  assert.deepEqual(
    pooled.map((p) => [p.outfit.number, p.outfit.name, p.grade.score]),
    [
      [1, 'New 1', 9],
      [2, 'Old 1', 8],
      [3, 'New 3', 8],
      [4, 'New 2', 7],
      [5, 'Old 2', 6],
    ],
  );
});

test('runImprove with --all and --keep 5 gives a passing 3-look set one improve attempt, keeps 5, and skips passing sets already at 5', async () => {
  const roofSet: LibrarySet = {
    key: 'rooftop-birthday',
    gender: 'men',
    occasion: "a friend's rooftop birthday party",
    budget_usd: 150,
    outfits: [
      makeBasicOutfit('Roof 1', 'men'),
      makeBasicOutfit('Roof 2', 'men'),
      makeBasicOutfit('Roof 3', 'men'),
    ],
    vectors: [[1, 0, 0]],
    built_ms: 1000,
  };
  const brunchSet: LibrarySet = {
    key: 'brunch',
    gender: 'men',
    occasion: 'Sunday brunch with friends',
    budget_usd: 120,
    outfits: [
      makeBasicOutfit('Brunch 1', 'men'),
      makeBasicOutfit('Brunch 2', 'men'),
      makeBasicOutfit('Brunch 3', 'men'),
      makeBasicOutfit('Brunch 4', 'men'),
      makeBasicOutfit('Brunch 5', 'men'),
    ],
    vectors: [[0, 1, 0]],
    built_ms: 2000,
  };

  const { setsPath, gradesPath } = createTempSets([roofSet, brunchSet]);
  process.env.ALICE_LIBRARY_STOP_AT = 'off';

  writeFileSync(
    gradesPath,
    JSON.stringify({
      version: 1,
      graded_at: '2026-11-21T12:00:00.000Z',
      grades: {
        'rooftop-birthday|men': {
          graded_at: '2026-11-21T12:00:00.000Z',
          set_built_at: 1000,
          outfits: [
            { name: 'Roof 1', score: 8, presentable: true, issues: [], weak_piece: null },
            { name: 'Roof 2', score: 7, presentable: true, issues: [], weak_piece: null },
            { name: 'Roof 3', score: 7, presentable: true, issues: [], weak_piece: null },
          ],
          min: 7,
          avg: 7.33,
          presentable_count: 3,
          pass: true,
        },
        'brunch|men': {
          graded_at: '2026-11-21T12:00:00.000Z',
          set_built_at: 2000,
          outfits: [
            { name: 'Brunch 1', score: 9, presentable: true, issues: [], weak_piece: null },
            { name: 'Brunch 2', score: 8, presentable: true, issues: [], weak_piece: null },
            { name: 'Brunch 3', score: 8, presentable: true, issues: [], weak_piece: null },
            { name: 'Brunch 4', score: 7, presentable: true, issues: [], weak_piece: null },
            { name: 'Brunch 5', score: 7, presentable: true, issues: [], weak_piece: null },
          ],
          min: 7,
          avg: 7.8,
          presentable_count: 5,
          pass: true,
        },
      },
    }),
    'utf8',
  );

  // Without --all, both passing sets are skipped even when keep=5.
  let withoutAllCalls = 0;
  const skippedRes = await runImprove(
    { only: null, genders: ['men'], maxAttempts: 3, keep: 5, all: false },
    {
      buildLive: async () => {
        withoutAllCalls += 1;
        throw new Error('should not build passing sets without --all');
      },
      log: () => {},
    },
  );
  assert.equal(withoutAllCalls, 0);
  assert.equal(skippedRes.skipped, 2);
  assert.equal(skippedRes.improved, 0);

  // With --all and keep=5, rooftop-birthday (3 looks) gets 1 improve attempt and stops once it holds 5 looks;
  // brunch (already 5 passing looks) is skipped.
  let buildCalls = 0;
  const allRes = await runImprove(
    { only: null, genders: ['men'], maxAttempts: 3, keep: 5, all: true },
    {
      buildLive: async (brief) => {
        buildCalls += 1;
        assert.equal(brief.occasion, roofSet.occasion);
        return {
          outfits: [
            makeBasicOutfit('Roof New A', 'men'),
            makeBasicOutfit('Roof New B', 'men'),
            makeBasicOutfit('Roof New C', 'men'),
          ],
          source: 'live',
          timing: { first_outfit_ms: 5, total_ms: 10 },
          problems: [],
        };
      },
      critiqueAll: async (outfits) =>
        outfits.map((o) => {
          if (o.name === 'Roof New A') return makeCritique(9, true);
          if (o.name === 'Roof New B') return makeCritique(8, true);
          return makeCritique(6, true);
        }),
      log: () => {},
    },
  );

  assert.equal(buildCalls, 1);
  assert.equal(allRes.attempts, 1);
  assert.equal(allRes.improved, 1);
  assert.equal(allRes.skipped, 1);
  assert.equal(allRes.passed, 2);
  assert.equal(allRes.failed, 0);

  const updatedLib = JSON.parse(readFileSync(setsPath, 'utf8')) as LibraryFile;
  const updatedRoof = updatedLib.sets.find((s) => s.key === 'rooftop-birthday' && s.gender === 'men')!;
  assert.equal(updatedRoof.outfits.length, 5);
  assert.deepEqual(
    updatedRoof.outfits.map((o) => [o.number, o.name]),
    [
      [1, 'Roof New A'],
      [2, 'Roof 1'],
      [3, 'Roof New B'],
      [4, 'Roof 2'],
      [5, 'Roof 3'],
    ],
  );

  const updatedGrades = JSON.parse(readFileSync(gradesPath, 'utf8')) as GradesFile;
  const roofGrade = updatedGrades.grades['rooftop-birthday|men'];
  assert.equal(roofGrade.pass, true);
  assert.equal(roofGrade.outfits.length, 5);
  assert.equal(roofGrade.presentable_count, 5);
  assert.deepEqual(
    roofGrade.outfits.map((o) => [o.name, o.score]),
    [
      ['Roof New A', 9],
      ['Roof 1', 8],
      ['Roof New B', 8],
      ['Roof 2', 7],
      ['Roof 3', 7],
    ],
  );
});
