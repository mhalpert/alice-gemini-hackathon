import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brief, BuildResult, Gender, Item, Outfit } from '../src/types.ts';
import type { Critique } from '../src/brain/critic.ts';
import type { CallLogSink } from '../src/store/log.ts';
import { EVAL_OCCASIONS, type EvalOccasion } from '../eval/occasions.ts';
import { baselineBuild, type BaselineReply } from '../eval/baseline.ts';
import { runEval, type EvalResultsFile } from '../eval/run.ts';
import { buildReport, generateReports, median, percentile, WHAT_WE_CHANGED } from '../eval/report.ts';

function makeItem(overrides: Partial<Item> & { id: string; title: string }): Item {
  return {
    variant_id: `var-${overrides.id}`,
    price: 40,
    url: `https://store.test/p/${overrides.id}`,
    image: `https://cdn.test/${overrides.id}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 10,
    sizes: ['M'],
    variants_by_size: { M: `var-${overrides.id}` },
    description: 'Clean test item.',
    department: 'men',
    ...overrides,
  };
}

function makeOutfit(number: number, name: string, pieces: Outfit['pieces']): Outfit {
  const total = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
  return { number, name, difference: '', story: '', pieces, total };
}

function makeCritique(score: number, presentable: boolean, issues: string[] = []): Critique {
  return {
    score,
    presentable,
    occasion_fit: score,
    cohesion: score,
    completeness: score,
    issues,
    weak_piece: null,
    model: 'gemini-4-argon',
    ms: 120,
  };
}

describe('eval/occasions', () => {
  test('contains 20 test-kit briefs, 2 demo briefs, and 5 team-written messy briefs', () => {
    const testKit = EVAL_OCCASIONS.filter((o) => o.source === 'test-kit');
    const messy = EVAL_OCCASIONS.filter((o) => o.source === 'messy');

    assert.equal(testKit.length, 22);
    assert.equal(messy.length, 5);
    assert.ok(testKit.every((o) => o.occasion.trim().length > 0));
    assert.ok(messy.every((o) => o.occasion.trim().length > 0));
    assert.deepEqual(
      messy.map((h) => [h.id, h.gender, h.budget_usd]),
      [
        ['hacker-1', 'men', 200],
        ['hacker-2', 'women', 250],
        ['hacker-3', 'men', 120],
        ['hacker-4', 'women', 180],
        ['hacker-5', 'women', 100],
      ],
    );

    const ids = new Set(EVAL_OCCASIONS.map((o) => o.id));
    assert.equal(ids.size, EVAL_OCCASIONS.length);
    assert.ok(ids.has('rooftop-men'));
    assert.ok(ids.has('rooftop-women'));
    assert.ok(ids.has('gala-men'));
    assert.ok(ids.has('gala-women'));
  });
});

describe('eval/baseline', () => {
  test('maps a fake Flash Lite reply and fake store searches into Outfits', async () => {
    const brief: Brief = {
      gender: 'men',
      occasion: "a friend's rooftop birthday",
      budget_usd: 150,
    };

    const calls: { query: string; gender: Gender; limit?: number }[] = [];
    let genCallArgs: { model: string; temperature?: number; user: string } | null = null;

    const fakeReply: BaselineReply = {
      outfits: [
        {
          name: 'Rooftop Smart',
          pieces: [
            { slot: 'top', query: 'mens navy knit polo' },
            { slot: 'bottom', query: 'mens black chinos' },
            { slot: 'shoes', query: 'mens white leather sneakers' },
            { slot: 'accessory', query: 'mens silver watch' },
          ],
        },
        {
          name: 'Warm Evening',
          pieces: [
            { slot: 'top', query: 'mens olive overshirt' },
            { slot: 'bottom', query: 'mens dark jeans' },
            { slot: 'shoes', query: 'mens brown boots' },
            { slot: 'accessory', query: 'mens brown belt' },
          ],
        },
        {
          name: 'Crisp Minimal',
          pieces: [
            { slot: 'top', query: 'mens white oxford shirt' },
            { slot: 'bottom', query: 'mens grey trousers' },
            { slot: 'shoes', query: 'mens black loafers' },
            { slot: 'accessory', query: 'mens black sunglasses' },
          ],
        },
      ],
    };

    const result = await baselineBuild(brief, {
      generateJson: async (call) => {
        genCallArgs = { model: call.model, temperature: call.temperature, user: call.user };
        return {
          data: fakeReply as unknown as any,
          model: 'gemini-3.5-flash-lite',
          ms: 42,
          tokens: { in: 1000, out: 400 },
        };
      },
      search: async (query, gender, opts) => {
        calls.push({ query, gender, limit: opts?.limit });
        if (query === 'mens navy knit polo') {
          return {
            source: 'live',
            ms: 10,
            items: [
              // Wrong department first: must be skipped
              makeItem({ id: 'w-polo', title: 'Womens Navy Polo', price: 30, department: 'women' }),
              // First valid men's item: must be chosen
              makeItem({ id: 'm-polo', title: 'Mens Navy Knit Polo', price: 45, department: 'men' }),
              makeItem({ id: 'm-polo-2', title: 'Second Polo', price: 25, department: 'men' }),
            ],
          };
        }
        return {
          source: 'live',
          ms: 10,
          items: [
            makeItem({
              id: query.replace(/\s+/g, '-'),
              title: query,
              price: 30,
              department: gender,
            }),
          ],
        };
      },
    });

    assert.equal(genCallArgs!.temperature, 0.7);
    assert.ok(genCallArgs!.user.includes("men's"));
    assert.ok(genCallArgs!.user.includes('$150'));
    assert.equal(calls.length, 12);
    assert.ok(calls.every((c) => c.limit === 5 && c.gender === 'men'));

    assert.equal(result.outfits.length, 3);
    assert.equal(result.outfits[0].number, 1);
    assert.equal(result.outfits[0].name, 'Rooftop Smart');
    assert.equal(result.outfits[0].pieces.length, 4);
    assert.equal(result.outfits[0].pieces[0].item.id, 'm-polo');
    assert.equal(result.outfits[0].pieces[0].why, '');
    assert.equal(result.outfits[0].total, 135); // 45 + 30 + 30 + 30
    assert.ok(result.ms >= 0);
    assert.ok(result.first_ms >= 0 && result.first_ms <= result.ms);

    // 1000 * 0.3 / 1e6 + 400 * 2.5 / 1e6 = 0.0003 + 0.001 = 0.0013
    assert.ok(Math.abs(result.usd - 0.0013) < 1e-9);
  });

  test('continues gracefully when a search returns empty or throws', async () => {
    const brief: Brief = { gender: 'women', occasion: 'Sunday brunch', budget_usd: 120 };
    const result = await baselineBuild(brief, {
      generateJson: async () => ({
        data: {
          outfits: [
            {
              name: 'Sunny Brunch',
              pieces: [
                { slot: 'dress', query: 'womens floral midi dress' },
                { slot: 'shoes', query: 'failing query' },
                { slot: 'bag', query: 'empty query' },
              ],
            },
          ],
        } as any,
        model: 'custom-fast-model',
        ms: 15,
        tokens: { in: 500, out: 200 },
      }),
      search: async (query, gender) => {
        if (query === 'failing query') throw new Error('network boom');
        if (query === 'empty query') return { items: [], source: 'empty', ms: 5 };
        return {
          items: [makeItem({ id: 'd1', title: 'Floral Midi Dress', price: 65, department: gender })],
          source: 'live',
          ms: 5,
        };
      },
    });

    assert.equal(result.outfits.length, 1);
    assert.equal(result.outfits[0].pieces.length, 1);
    assert.equal(result.outfits[0].total, 65);
    assert.ok(Math.abs(result.usd - (500 * 0.3 + 200 * 2.5) / 1_000_000) < 1e-9);
  });
});

describe('eval/run', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alice-eval-test-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skips empty occasions, records metrics and dress-code hits, and handles side errors without throwing', async () => {
    const occasions: EvalOccasion[] = [
      { id: 'wedding-women', gender: 'women', occasion: 'outdoor summer wedding guest', budget_usd: 150, source: 'test-kit' },
      { id: 'hacker-1', gender: 'men', occasion: '', budget_usd: 200, source: 'messy' },
      { id: 'hacker-2', gender: 'women', occasion: '   ', budget_usd: 250, source: 'messy' },
      { id: 'gala-men', gender: 'men', occasion: 'black tie optional gala', budget_usd: 250, source: 'test-kit' },
    ];

    const outPath = join(tmpDir, 'latest.json');
    const seenIds: string[] = [];
    let roomSet: string | null = null;

    const weddingOutfits: Outfit[] = [
      makeOutfit(1, 'Sage Midi', [
        { slot: 'dress', why: '', item: makeItem({ id: 'd1', title: 'Sage Midi Dress', price: 70, department: 'women' }) },
        { slot: 'shoes', why: '', item: makeItem({ id: 's1', title: 'Tan Block Heel', price: 50, department: 'women' }) },
      ]),
      makeOutfit(2, 'Ivory Slip', [
        { slot: 'dress', why: '', item: makeItem({ id: 'd2', title: 'Ivory Satin Dress', price: 90, department: 'women' }) },
        { slot: 'shoes', why: '', item: makeItem({ id: 's2', title: 'Gold Sandal', price: 80, department: 'women' }) },
      ]),
      makeOutfit(3, 'Navy Jumpsuit', [
        { slot: 'dress', why: '', item: makeItem({ id: 'd3', title: 'Navy Jumpsuit', price: 85, department: 'women' }) },
        // Missing shoes on purpose + wrong department bag
        { slot: 'bag', why: '', item: makeItem({ id: 'b3', title: 'Mens Leather Pouch', price: 30, department: 'men' }) },
      ]),
    ];

    const payload = await runEval(
      { occasions, outPath, concurrency: 1 },
      {
        setCallRoom: (r) => { roomSet = r; },
        setCallLogSink: () => {},
        gitCommit: () => 'abc1234',
        now: () => new Date('2026-11-21T15:00:00.000Z'),
        readLedgerFile: async () => '',
        log: () => {},
        buildLive: async (brief): Promise<BuildResult> => {
          seenIds.push(brief.occasion);
          if (brief.occasion.includes('gala')) {
            throw new Error('planner exploded');
          }
          return {
            outfits: weddingOutfits,
            source: 'live',
            timing: { first_outfit_ms: 2100, total_ms: 4800 },
            problems: [],
          };
        },
        baselineBuild: async () => ({
          outfits: weddingOutfits.slice(0, 2),
          first_ms: 900,
          ms: 1400,
          usd: 0.002,
        }),
        critiqueAll: async (outfits) =>
          outfits.map((_, i) =>
            i === 0
              ? makeCritique(8, true, [])
              : i === 1
                ? makeCritique(4, false, ['white dress at wedding'])
                : makeCritique(7, true, ['no shoes']),
          ),
      },
    );

    assert.equal(roomSet, 'eval');
    assert.deepEqual(seenIds, ['outdoor summer wedding guest', 'black tie optional gala']);
    assert.equal(payload.git_commit, 'abc1234');
    assert.equal(payload.results.length, 2);

    const wedding = payload.results.find((r) => r.id === 'wedding-women')!;
    assert.ok(wedding.pipeline);
    assert.deepEqual(wedding.pipeline.scores, [8, 4, 7]);
    assert.equal(wedding.pipeline.presentable_count, 2);
    assert.equal(wedding.pipeline.presentable, true);
    assert.equal(wedding.pipeline.avg, 6.33);
    assert.equal(wedding.pipeline.min, 4);
    assert.equal(wedding.pipeline.dress_code_hits.length, 1);
    assert.equal(wedding.pipeline.dress_code_hits[0].title, 'Ivory Satin Dress');
    assert.equal(wedding.pipeline.over_budget, 1); // look 2 total 170 > 150
    assert.equal(wedding.pipeline.missing_shoes_or_bottom, 1); // look 3 has no shoes
    assert.equal(wedding.pipeline.other_department_items, 1); // look 3 men's bag
    assert.equal(wedding.pipeline.usd, 0.08);
    assert.equal(wedding.pipeline.usd_source, 'estimate');

    assert.ok(wedding.baseline);
    assert.equal(wedding.baseline.presentable_count, 1);
    assert.equal(wedding.baseline.presentable, false);

    const gala = payload.results.find((r) => r.id === 'gala-men')!;
    assert.equal(gala.pipeline?.error, 'planner exploded');
    assert.equal(gala.pipeline?.presentable, false);
    assert.ok(gala.baseline && !gala.baseline.error);

    const saved = JSON.parse(readFileSync(outPath, 'utf8')) as EvalResultsFile;
    assert.equal(saved.results.length, 2);
  });

  test('stops starting new occasions on store_error rate_limited', async () => {
    const occasions: EvalOccasion[] = [
      { id: 'occ-1', gender: 'men', occasion: 'Sunday brunch', budget_usd: 120, source: 'test-kit' },
      { id: 'occ-2', gender: 'men', occasion: 'desert music festival', budget_usd: 120, source: 'test-kit' },
      { id: 'occ-3', gender: 'men', occasion: 'night out at a club', budget_usd: 150, source: 'test-kit' },
    ];
    let sink: CallLogSink | null = null;
    const ran: string[] = [];

    const payload = await runEval(
      { occasions, outPath: join(tmpDir, 'rl.json'), concurrency: 1, skipBaseline: true },
      {
        setCallRoom: () => {},
        setCallLogSink: (fn) => { sink = fn; },
        readLedgerFile: async () => '',
        log: () => {},
        buildLive: async (brief) => {
          ran.push(brief.occasion);
          sink?.('eval', 'store_error', { code: 'rate_limited' });
          return { outfits: [], source: 'live', timing: { first_outfit_ms: 100, total_ms: 200 }, problems: [] };
        },
        critiqueAll: async () => [],
      },
    );

    assert.deepEqual(ran, ['Sunday brunch']);
    assert.equal(payload.stopped_reason, 'rate_limited');
    assert.equal(payload.results.length, 1);
  });

  test('--only merges into an existing latest.json without overwriting earlier occasions', async () => {
    const outPath = join(tmpDir, 'merge.json');
    const existing: EvalResultsFile = {
      version: 1,
      run_at: '2026-11-21T15:00:00.000Z',
      git_commit: 'old1234',
      results: [
        {
          id: 'rooftop-men',
          gender: 'men',
          occasion: "a friend's rooftop birthday",
          budget_usd: 150,
          source: 'test-kit',
        },
      ],
    };
    writeFileSync(outPath, JSON.stringify(existing), 'utf8');

    const occasions: EvalOccasion[] = [
      { id: 'rooftop-men', gender: 'men', occasion: "a friend's rooftop birthday", budget_usd: 150, source: 'test-kit' },
      { id: 'hacker-1', gender: 'men', occasion: 'fancy Italian dinner', budget_usd: 200, source: 'messy' },
    ];

    const payload = await runEval(
      { occasions, only: new Set(['hacker-1']), outPath, concurrency: 1, skipBaseline: true },
      {
        setCallRoom: () => {},
        setCallLogSink: () => {},
        readLedgerFile: async () => '',
        log: () => {},
        buildLive: async () => ({
          outfits: [],
          source: 'live',
          timing: { first_outfit_ms: 100, total_ms: 200 },
          problems: [],
        }),
        critiqueAll: async () => [],
      },
    );

    assert.deepEqual(payload.results.map((r) => r.id), ['rooftop-men', 'hacker-1']);
    assert.equal(payload.results[1].source, 'messy');
  });
});

describe('eval/report', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alice-report-test-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('computes exact headline stats (presentable rule, medians, p90) and renders RESULTS.md + README-snippet.md', () => {
    assert.equal(median([1000, 3000, 2000]), 2000);
    assert.equal(median([1000, 2000, 3000, 4000]), 2500);
    assert.equal(percentile([1000, 2000, 3000, 4000, 5000], 90), 5000);

    const fake: EvalResultsFile = {
      version: 1,
      run_at: '2026-11-21T16:00:00.000Z',
      git_commit: 'deadbee',
      results: [
        {
          id: 'rooftop-men',
          gender: 'men',
          occasion: "a friend's rooftop birthday",
          budget_usd: 150,
          source: 'test-kit',
          pipeline: {
            scores: [8, 8, 7],
            presentable_count: 3,
            presentable: true,
            avg: 7.67,
            min: 7,
            issues: [],
            outfit_issues: [[], [], []],
            outfit_names: ['A', 'B', 'C'],
            outfit_totals: [130, 140, 120],
            dress_code_hits: [],
            over_budget: 0,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 3000,
            total_ms: 6000,
            usd: 0.05,
            usd_source: 'ledger',
            outfit_count: 3,
          },
          baseline: {
            scores: [7, 5, 4],
            presentable_count: 1, // < 2 -> NOT presentable
            presentable: false,
            avg: 5.33,
            min: 4,
            issues: ['belt clashes with shoes'],
            outfit_issues: [[], ['belt clashes with shoes'], []],
            outfit_names: ['X', 'Y', 'Z'],
            outfit_totals: [160, 140, 175],
            dress_code_hits: [],
            over_budget: 2,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 1000,
            total_ms: 2000,
            usd: 0.002,
            usd_source: 'tokens',
            outfit_count: 3,
          },
        },
        {
          id: 'gala-men',
          gender: 'men',
          occasion: 'black tie optional gala',
          budget_usd: 250,
          source: 'test-kit',
          pipeline: {
            scores: [7, 7, 5],
            presentable_count: 2, // >= 2 -> presentable
            presentable: true,
            avg: 6.33,
            min: 5,
            issues: ['casual loafer at black tie'],
            outfit_issues: [[], [], ['casual loafer at black tie']],
            outfit_names: ['D', 'E', 'F'],
            outfit_totals: [220, 230, 210],
            dress_code_hits: [],
            over_budget: 0,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 5000,
            total_ms: 8000,
            usd: 0.07,
            usd_source: 'ledger',
            outfit_count: 3,
          },
          baseline: {
            scores: [4, 3, 5],
            presentable_count: 0,
            presentable: false,
            avg: 4,
            min: 3,
            issues: ['graphic tie at black tie'],
            outfit_issues: [['graphic tie at black tie'], [], []],
            outfit_names: ['P', 'Q', 'R'],
            outfit_totals: [280, 200, 190],
            dress_code_hits: [{ outfit_index: 1, outfit_name: 'P', slot: 'accessory', title: 'Knicks Tie' }],
            over_budget: 1,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 2000,
            total_ms: 3000,
            usd: 0.004,
            usd_source: 'tokens',
            outfit_count: 3,
          },
        },
        {
          id: 'wedding-women',
          gender: 'women',
          occasion: 'outdoor summer wedding guest',
          budget_usd: 150,
          source: 'test-kit',
          pipeline: {
            scores: [6, 5, 5],
            presentable_count: 1, // < 2 -> NOT presentable
            presentable: false,
            avg: 5.33,
            min: 5,
            issues: ['heavy fabric for summer wedding'],
            outfit_issues: [[], ['heavy fabric for summer wedding'], []],
            outfit_names: ['G', 'H', 'I'],
            outfit_totals: [160, 140, 130],
            dress_code_hits: [{ outfit_index: 1, outfit_name: 'G', slot: 'dress', title: 'White Slip Dress' }],
            over_budget: 1,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 4000,
            total_ms: 7000,
            usd: 0.06,
            usd_source: 'ledger',
            outfit_count: 3,
          },
          baseline: {
            scores: [7, 7, 6],
            presentable_count: 2, // >= 2 -> presentable
            presentable: true,
            avg: 6.67,
            min: 6,
            issues: [],
            outfit_issues: [[], [], []],
            outfit_names: ['S', 'T', 'U'],
            outfit_totals: [120, 110, 130],
            dress_code_hits: [],
            over_budget: 0,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 1500,
            total_ms: 2500,
            usd: 0.003,
            usd_source: 'tokens',
            outfit_count: 3,
          },
        },
        {
          id: 'hacker-1',
          gender: 'men',
          occasion: "my girlfriend's parents are taking us to a fancy-ish Italian place, don't want to look like I'm trying too hard",
          budget_usd: 200,
          source: 'messy',
          pipeline: {
            scores: [9, 9, 9],
            presentable_count: 3,
            presentable: true,
            avg: 9,
            min: 9,
            issues: [],
            outfit_issues: [[], [], []],
            outfit_names: ['M1', 'M2', 'M3'],
            outfit_totals: [180, 175, 190],
            dress_code_hits: [],
            over_budget: 0,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 9000,
            total_ms: 12000,
            usd: 0.2,
            usd_source: 'ledger',
            outfit_count: 3,
          },
          baseline: {
            scores: [2, 2, 2],
            presentable_count: 0,
            presentable: false,
            avg: 2,
            min: 2,
            issues: ['too casual'],
            outfit_issues: [['too casual'], [], []],
            outfit_names: ['BM1', 'BM2', 'BM3'],
            outfit_totals: [220, 210, 230],
            dress_code_hits: [],
            over_budget: 3,
            missing_shoes_or_bottom: 0,
            other_department_items: 0,
            first_ms: 500,
            total_ms: 800,
            usd: 0.001,
            usd_source: 'tokens',
            outfit_count: 3,
          },
        },
      ],
    };

    const report = buildReport(fake);

    // Headline MUST exclude source='messy' (hacker-1 with 9s/2s must not skew headline).
    // Pipeline: scores [8,8,7,7,7,5,6,5,5] sum=58 / 9 = 6.44
    assert.equal(report.pipeline.count, 3);
    assert.equal(report.pipeline.avg_score, 6.44);
    assert.equal(report.pipeline.presentable_sets, 2);
    assert.equal(report.pipeline.weakest_set_id, 'wedding-women');
    assert.equal(report.pipeline.weakest_set_avg, 5.33);
    assert.equal(report.pipeline.dress_code_breaks, 1);
    assert.equal(report.pipeline.over_budget_outfits, 1);
    assert.equal(report.pipeline.median_first_ms, 4000);
    assert.equal(report.pipeline.p90_first_ms, 5000);
    assert.equal(report.pipeline.median_total_ms, 7000);
    assert.ok(Math.abs((report.pipeline.avg_usd ?? 0) - 0.06) < 1e-9);

    // Baseline: scores [7,5,4,4,3,5,7,7,6] sum=48 / 9 = 5.33
    assert.equal(report.baseline.count, 3);
    assert.equal(report.baseline.avg_score, 5.33);
    assert.equal(report.baseline.presentable_sets, 1);
    assert.equal(report.baseline.weakest_set_id, 'gala-men');
    assert.equal(report.baseline.weakest_set_avg, 4);
    assert.equal(report.baseline.dress_code_breaks, 1);
    assert.equal(report.baseline.over_budget_outfits, 3);
    assert.equal(report.baseline.median_first_ms, 1500);
    assert.equal(report.baseline.p90_first_ms, 2000);
    assert.equal(report.baseline.median_total_ms, 2500);
    assert.ok(Math.abs((report.baseline.avg_usd ?? 0) - 0.003) < 1e-9);

    // Separate messy summary
    assert.equal(report.messyPipeline.count, 1);
    assert.equal(report.messyPipeline.avg_score, 9);
    assert.equal(report.messyPipeline.presentable_sets, 1);
    assert.equal(report.messyBaseline.count, 1);
    assert.equal(report.messyBaseline.avg_score, 2);
    assert.equal(report.messyBaseline.presentable_sets, 0);

    // Weakest ordering: wedding-women (5.33), gala-men (6.33), rooftop-men (7.67)
    assert.deepEqual(
      report.weakest.map((w) => w.id),
      ['wedding-women', 'gala-men', 'rooftop-men'],
    );
    assert.equal(report.weakest[0].issue, 'heavy fabric for summer wedding');

    for (const line of WHAT_WE_CHANGED) {
      assert.ok(report.resultsMd.includes(line), `RESULTS.md missing: ${line}`);
    }
    assert.ok(report.resultsMd.includes('| wedding-women | 5.33 | no | 6.67 | yes |'));
    assert.ok(report.resultsMd.includes('## Team-written messy briefs'));
    assert.ok(report.resultsMd.includes('| hacker-1 | 9.00 | yes | 2.00 | no |'));

    const snippetNonEmptyLines = report.readmeSnippetMd.trim().split('\n');
    assert.ok(
      snippetNonEmptyLines.length >= 6 && snippetNonEmptyLines.length <= 8,
      `Expected 6-8 lines in README-snippet.md, got ${snippetNonEmptyLines.length}`,
    );
    assert.ok(report.readmeSnippetMd.includes('eval/run.ts'));

    // Also verify disk write roundtrip
    const inputPath = join(tmpDir, 'latest.json');
    const reportPath = join(tmpDir, 'RESULTS.md');
    const snippetPath = join(tmpDir, 'README-snippet.md');
    writeFileSync(inputPath, JSON.stringify(fake), 'utf8');
    generateReports(inputPath, reportPath, snippetPath);
    assert.equal(readFileSync(reportPath, 'utf8'), report.resultsMd);
    assert.equal(readFileSync(snippetPath, 'utf8'), report.readmeSnippetMd);
  });
});
