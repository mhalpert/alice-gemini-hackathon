import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeToolsVersion,
  ensureEnvironment,
  readEnvironmentState,
  warmCapsule,
  type CapsuleApiClient,
} from '../src/capsule/environment.ts';
import {
  DEFAULT_CAPSULE_MODEL,
  isCapsuleCriticEnabled,
  isCapsuleEnabled,
  mapPipelineToCapsuleResult,
  packCapsule,
  parseAgentOutput,
  repackCapsule,
  resolveCapsuleModel,
  type CapsuleBrief,
  type CapsuleStep,
  type CapsuleStoreLayer,
  type CritiqueAllFn,
  type RawPipelineOutput,
} from '../src/capsule/index.ts';
import { setCallLogSink, setCallRoom } from '../src/store/log.ts';
import type { LookupEntry, ProductDetail } from '../src/store/catalog.ts';
import type { Item } from '../src/types.ts';

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-capsule-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function makeFakeToolsDir(root: string): string {
  const toolsDir = path.join(root, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'README.md'), '# Tools\n', 'utf8');
  fs.writeFileSync(path.join(toolsDir, 'capsule.py'), 'print("ok")\n', 'utf8');
  return toolsDir;
}

const SAMPLE_BRIEF: CapsuleBrief = {
  gender: 'men',
  plans: 'four days in Lisbon: two city days, one beach day, one dinner',
  sizes: { top: 'M', bottom: '32', shoes: 'US 10' },
  budget_usd: 450,
  owned: ['navy linen suit', 'brown leather loafers', 'white dress shirt'],
  max_stores: 2,
};

const SAMPLE_PIPELINE: RawPipelineOutput = {
  ok: true,
  pieces: [
    {
      slot: 'top',
      title: 'Organic Linen Camp Shirt - Ecru',
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      price_usd: 78,
      url: 'https://www.everlane.com/products/linen-camp-shirt?utm_source=shopify',
      id: 'gid://shopify/Product/1001',
      variant_id: 'gid://shopify/ProductVariant/2001',
      size_label: 'M',
    },
    {
      slot: 'bottom',
      title: 'Performance Chino - Khaki',
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      price_usd: 88,
      url: 'https://www.everlane.com/products/performance-chino?utm_source=shopify',
      id: 'gid://shopify/Product/1002',
      variant_id: 'gid://shopify/ProductVariant/2002',
      size_label: '32x30',
    },
    {
      slot: 'shoes',
      title: 'Court Leather Sneaker - White',
      store: 'Steve Madden',
      store_domain: 'stevemadden.myshopify.com',
      price_usd: 99,
      url: 'https://www.stevemadden.com/products/court-sneaker?utm_source=shopify',
      id: 'gid://shopify/Product/1003',
      variant_id: 'gid://shopify/ProductVariant/2003',
      size_label: '10',
    },
  ],
  owned_pieces_used: [
    {
      id: 'owned:navy_linen_suit_jacket',
      slot: 'layer',
      title: 'Navy Linen Suit Jacket (Owned)',
      size_label: 'M',
    },
    {
      id: 'owned:white_dress_shirt',
      slot: 'top',
      title: 'White Dress Shirt (Owned)',
      size_label: 'M',
    },
  ],
  outfits: [
    {
      day: 'Day 1 - Daytime City',
      dress_code: 'casual',
      notes: 'city walk',
      piece_ids: ['gid://shopify/Product/1001', 'gid://shopify/Product/1002', 'gid://shopify/Product/1003'],
      total_new_usd: 265,
    },
    {
      day: 'Day 2 - Dinner',
      dress_code: 'smart_casual',
      notes: 'dinner',
      piece_ids: ['owned:white_dress_shirt', 'gid://shopify/Product/1002', 'gid://shopify/Product/1003', 'owned:navy_linen_suit_jacket'],
      total_new_usd: 187,
    },
  ],
  total_usd: 265,
  stores: ['Everlane', 'Steve Madden'],
  mix_and_match_count: 6,
  certificate: {
    all_sizes_in_stock: true,
    within_budget: true,
    checks: [
      { name: 'live_stock_and_price', ok: true },
      { name: 'within_budget', ok: true },
    ],
  },
  searched: 245,
  timings: { fetch_s: 2.1, size_check_s: 4.3, solve_s: 0.2, verify_s: 0.9, total_s: 7.5 },
};

function makeFakeStore(): CapsuleStoreLayer {
  const item1: Item = {
    id: 'gid://shopify/Product/1001',
    variant_id: 'gid://shopify/ProductVariant/2001',
    title: 'Organic Linen Camp Shirt - Ecru',
    price: 78,
    url: 'https://www.everlane.com/products/linen-camp-shirt?utm_source=shopify',
    image: 'https://cdn.shopify.com/s/files/linen.jpg?width=800&v=1',
    store: 'Everlane',
    store_domain: 'm34kzg-ke.myshopify.com',
    rating: 4.8,
    rating_count: 142,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { M: 'gid://shopify/ProductVariant/2001' },
    description: 'Breathable 100% linen camp collar shirt.',
    department: 'men',
  };
  const item2: Item = {
    id: 'gid://shopify/Product/1002',
    variant_id: 'gid://shopify/ProductVariant/2002',
    title: 'Performance Chino - Khaki',
    price: 88,
    url: 'https://www.everlane.com/products/performance-chino?utm_source=shopify',
    image: 'https://cdn.shopify.com/s/files/chino.jpg',
    store: 'Everlane',
    store_domain: 'm34kzg-ke.myshopify.com',
    rating: 4.7,
    rating_count: 310,
    sizes: ['30x30', '32x30', '34x30'],
    variants_by_size: { '32x30': 'gid://shopify/ProductVariant/2002' },
    description: 'Four-way stretch tailored chino.',
    department: 'men',
  };

  return {
    async lookup(ids: string[]) {
      const m = new Map<string, LookupEntry>();
      if (ids.includes(item1.variant_id)) {
        m.set(item1.variant_id, { item: item1, available: true, price: 78 });
      }
      if (ids.includes(item2.variant_id)) {
        m.set(item2.variant_id, { item: item2, available: true, price: 88 });
      }
      return m;
    },
    async getProduct(id: string): Promise<ProductDetail | null> {
      if (id === 'gid://shopify/ProductVariant/2003') {
        return {
          id: 'gid://shopify/Product/1003',
          title: 'Court Leather Sneaker - White',
          description: 'Clean white leather court sneaker.',
          description_html: '<p>Clean white leather court sneaker.</p>',
          images: ['https://cdn.shopify.com/s/files/sneaker.jpg?height=1000&v=2'],
          options: [
            {
              name: 'Size',
              values: [
                { label: '9', available: true, exists: true },
                { label: '10', available: true, exists: true },
              ],
            },
          ],
          selected: [{ name: 'Size', label: '10' }],
          variant: {
            id: 'gid://shopify/ProductVariant/2003',
            price: 99,
            available: true,
            options: [{ name: 'Size', label: '10' }],
            url: 'https://www.stevemadden.com/products/court-sneaker?utm_source=shopify',
          },
        };
      }
      return null;
    },
  };
}

const okCritiqueAll: CritiqueAllFn = async (outfits) =>
  outfits.map(() => ({
    score: 8,
    presentable: true,
    occasion_fit: 8,
    cohesion: 8,
    completeness: 8,
    issues: [],
    weak_piece: null,
    model: 'gemini-4-argon',
    ms: 120,
  }));

describe('capsule environment lifecycle', () => {
  test('creates once, reuses warm env, rebuilds when env gone or tools version changes', async () => {
    await withTempDir(async (dir) => {
      const toolsDir = makeFakeToolsDir(dir);
      const statePath = path.join(dir, 'environment.json');

      let createCount = 0;
      let uploadCount = 0;
      let setupCount = 0;
      let envAlive = true;

      const fakeClient: CapsuleApiClient = {
        environments: {
          async create() {
            createCount += 1;
            return { id: `env-${createCount}` };
          },
          async get(id: string) {
            if (!envAlive) throw new Error('404 not found');
            return { id, state: 'ACTIVE' };
          },
          files: {
            async upload() {
              uploadCount += 1;
              return { ok: true };
            },
          },
        },
        interactions: {
          async create(params) {
            setupCount += 1;
            return { id: `setup-${setupCount}`, environment_id: params.environment, output_text: 'READY' };
          },
        },
      };

      const first = await ensureEnvironment({ client: fakeClient, toolsDir, statePath });
      assert.equal(first.rebuilt, true);
      assert.equal(first.state.environment_id, 'env-1');
      assert.equal(first.state.tools_version, computeToolsVersion(toolsDir));
      assert.equal(createCount, 1);
      assert.equal(uploadCount, 2);
      assert.equal(setupCount, 1);
      assert.ok(readEnvironmentState(statePath));

      const second = await ensureEnvironment({ client: fakeClient, toolsDir, statePath });
      assert.equal(second.rebuilt, false);
      assert.equal(second.state.environment_id, 'env-1');
      assert.equal(createCount, 1);

      envAlive = false;
      const third = await ensureEnvironment({ client: fakeClient, toolsDir, statePath });
      assert.equal(third.rebuilt, true);
      assert.equal(third.state.environment_id, 'env-2');
      assert.equal(createCount, 2);

      envAlive = true;
      fs.writeFileSync(path.join(toolsDir, 'capsule.py'), 'print("v2")\n', 'utf8');
      const fourth = await ensureEnvironment({ client: fakeClient, toolsDir, statePath });
      assert.equal(fourth.rebuilt, true);
      assert.equal(fourth.state.environment_id, 'env-3');
      assert.equal(createCount, 3);
    });
  });

  test('warmCapsule returns immediately in background, falls back on upload failure, and never throws', async () => {
    await withTempDir(async (dir) => {
      const toolsDir = makeFakeToolsDir(dir);
      const statePath = path.join(dir, 'environment.json');

      const fallbackClient: CapsuleApiClient = {
        environments: {
          async create() {
            throw new Error('upload endpoint disabled');
          },
          async get() {
            throw new Error('not found');
          },
          files: {
            async upload() {
              throw new Error('upload failed');
            },
          },
        },
        interactions: {
          async create() {
            return { id: 'fallback-int-1', environment_id: 'env-fallback-1', output_text: 'READY' };
          },
        },
      };

      const built = await ensureEnvironment({ client: fallbackClient, toolsDir, statePath });
      assert.equal(built.rebuilt, true);
      assert.equal(built.upload_mode, 'setup_interaction');
      assert.equal(built.state.environment_id, 'env-fallback-1');

      const brokenClient: CapsuleApiClient = {
        environments: {
          async create() {
            await new Promise((r) => setTimeout(r, 30));
            throw new Error('down');
          },
          async get() {
            throw new Error('down');
          },
          files: {
            async upload() {
              throw new Error('down');
            },
          },
        },
        interactions: {
          async create() {
            throw new Error('network error');
          },
        },
      };

      const t0 = Date.now();
      const handle = warmCapsule({
        client: brokenClient,
        toolsDir,
        statePath: path.join(dir, 'missing.json'),
      });
      // Must return immediately without blocking on remote setup
      assert.equal(handle.started, true);
      assert.ok(Date.now() - t0 < 25, 'warmCapsule should return immediately');

      const warm = await handle.ready;
      assert.equal(warm.ok, false);
      assert.match(warm.error ?? '', /network error/);
    });
  });
});

describe('capsule packing, download-first, critic, dress-code repack, and switch', () => {
  test('default model is gemini-4-hydrogen and ALICE_CAPSULE defaults off with exact problem string', async () => {
    const prevSwitch = process.env.ALICE_CAPSULE;
    const prevModel = process.env.ALICE_MODEL_CAPSULE;
    delete process.env.ALICE_CAPSULE;
    delete process.env.ALICE_MODEL_CAPSULE;
    try {
      assert.equal(DEFAULT_CAPSULE_MODEL, 'gemini-4-hydrogen');
      assert.equal(resolveCapsuleModel(), 'gemini-4-hydrogen');
      assert.equal(isCapsuleEnabled(), false);
      assert.equal(isCapsuleEnabled('on'), true);

      let apiCalled = false;
      const spyClient: CapsuleApiClient = {
        environments: {
          async create() {
            apiCalled = true;
            return { id: 'x' };
          },
          async get() {
            apiCalled = true;
            return { id: 'x' };
          },
          files: {
            async upload() {
              apiCalled = true;
            },
          },
        },
        interactions: {
          async create() {
            apiCalled = true;
            return {};
          },
        },
      };

      const res = await packCapsule(SAMPLE_BRIEF, { client: spyClient });
      assert.equal(apiCalled, false);
      assert.equal(res.ok, false);
      assert.deepEqual(res.problems, ['capsule is switched off']);

      const repacked = await repackCapsule(res, 'dinner is now black tie optional', { client: spyClient });
      assert.equal(apiCalled, false);
      assert.equal(repacked.ok, false);
      assert.deepEqual(repacked.problems, ['capsule is switched off']);
    } finally {
      if (prevSwitch !== undefined) process.env.ALICE_CAPSULE = prevSwitch;
      if (prevModel !== undefined) process.env.ALICE_MODEL_CAPSULE = prevModel;
    }
  });

  test('maps pipeline JSON into full Outfit[] and Item objects via store layer', async () => {
    const { pipeline, explanation } = parseAgentOutput(
      `\`\`\`json\n${JSON.stringify(SAMPLE_PIPELINE)}\n\`\`\`\nPacked 3 quality pieces from Everlane and Steve Madden totaling $265.`,
    );
    assert.ok(pipeline);
    assert.match(explanation, /Packed 3 quality pieces/);

    const mapped = await mapPipelineToCapsuleResult(
      pipeline!,
      SAMPLE_BRIEF,
      {
        explanation,
        totalMs: 12000,
        interactionMs: 11000,
        model: 'gemini-4-hydrogen',
        environmentId: 'env-1',
        interactionId: 'int-1',
        costUsd: 0.02,
      },
      makeFakeStore(),
    );

    assert.equal(mapped.ok, true);
    assert.equal(mapped.pieces.length, 3);
    assert.equal(mapped.outfits.length, 2);
    assert.equal(mapped.total_usd, 265);
    assert.deepEqual(mapped.stores, ['Everlane', 'Steve Madden']);
    assert.equal(mapped.timings.tools_ms, 7500);
    assert.equal(mapped.timings.agent_ms, 3500);

    const shirt = mapped.pieces[0]!.item;
    assert.equal(shirt.url, 'https://www.everlane.com/products/linen-camp-shirt?utm_source=shopify');
    assert.equal(shirt.image, 'https://cdn.shopify.com/s/files/linen.jpg?v=1');
    assert.deepEqual(shirt.sizes, ['S', 'M', 'L']);
    assert.equal(shirt.rating, 4.8);
    assert.equal(shirt.department, 'men');

    const sneaker = mapped.pieces[2]!.item;
    assert.equal(sneaker.image, 'https://cdn.shopify.com/s/files/sneaker.jpg?v=2');
    assert.deepEqual(sneaker.sizes, ['9', '10']);
    assert.equal(sneaker.store, 'Steve Madden');

    assert.equal(mapped.outfits[1]!.total, 187);
    assert.equal(mapped.outfits[1]!.pieces.length, 4);
    assert.equal(mapped.outfits[1]!.pieces[0]!.item.store, 'Owned');
  });

  test('downloads final_output.json when agent replies DONE + explanation, attaches critic scores, and repacks on same env', async () => {
    await withTempDir(async (dir) => {
      const toolsDir = makeFakeToolsDir(dir);
      const statePath = path.join(dir, 'environment.json');
      const capturedInputs: Array<Record<string, unknown>> = [];
      const downloadedPaths: string[] = [];
      const loggedEvents: Array<{ ev: string; data?: Record<string, unknown> }> = [];
      const steps: CapsuleStep[] = [];

      setCallRoom('test-capsule-room');
      setCallLogSink((_room, ev, data) => {
        loggedEvents.push({ ev, data });
      });

      const fakeClient: CapsuleApiClient = {
        environments: {
          async create() {
            return { id: 'env-stream-1' };
          },
          async get(id: string) {
            return { id, state: 'ACTIVE' };
          },
          files: {
            async upload() {
              return { ok: true };
            },
            async download(params) {
              downloadedPaths.push(params.path);
              return Buffer.from(JSON.stringify(SAMPLE_PIPELINE), 'utf8');
            },
          },
        },
        interactions: {
          async create(params) {
            capturedInputs.push(params);
            if (!params.stream) {
              return { id: 'setup-1', environment_id: params.environment, output_text: 'READY' };
            }
            const callNum = capturedInputs.filter((p) => p.stream).length;
            async function* gen() {
              yield {
                event_type: 'step.delta',
                delta: {
                  type: 'code_execution_call',
                  arguments: 'python3 /workspace/capsule/capsule.py run /workspace/spec.json',
                },
              };
              yield {
                event_type: 'step.delta',
                delta: {
                  type: 'code_execution_result',
                  result:
                    'STEP: searched 245 products (9 queries, 2.1s)\nSTEP: verified 2 of 2 checks (0.9s)\n',
                },
              };
              yield {
                event_type: 'interaction.completed',
                interaction: {
                  id: `int-run-${callNum}`,
                  environment_id: params.environment,
                  output_text:
                    'DONE\nBuilt a versatile Lisbon capsule within budget. Every piece is verified in stock.',
                  usage: { total_input_tokens: 1200, total_output_tokens: 60, total_thought_tokens: 40 },
                },
              };
            }
            return gen();
          },
        },
      };

      const prevEnv = process.env.ALICE_CAPSULE;
      const prevCritic = process.env.ALICE_CAPSULE_CRITIC;
      process.env.ALICE_CAPSULE = 'on';
      delete process.env.ALICE_CAPSULE_CRITIC;
      let criticCalls = 0;
      const countingCritic: CritiqueAllFn = async (outfits, brief, opts) => {
        criticCalls += 1;
        return okCritiqueAll(outfits, brief, opts);
      };
      try {
        assert.equal(isCapsuleCriticEnabled(), false);
        assert.equal(isCapsuleCriticEnabled({ critic: true }), true);
        assert.equal(isCapsuleCriticEnabled(undefined, 'on'), true);

        // Critic off by default -> criticAll is NOT called and nothing is waited for
        const packedDefault = await packCapsule(SAMPLE_BRIEF, {
          client: fakeClient,
          toolsDir,
          statePath,
          store: makeFakeStore(),
          critiqueAll: countingCritic,
          onStep: (s) => steps.push(s),
        });
        assert.equal(packedDefault.ok, true);
        assert.equal(criticCalls, 0, 'critic must not run when opt-in is off');
        assert.equal(packedDefault.critic, undefined);
        assert.equal(
          packedDefault.certificate.checks.some((c) => c.name === 'critic_all_6_plus'),
          false,
        );

        // Opt-in via opts.critic: true -> critic runs and adds advisory check
        const packed = await packCapsule(SAMPLE_BRIEF, {
          client: fakeClient,
          toolsDir,
          statePath,
          store: makeFakeStore(),
          critiqueAll: countingCritic,
          critic: true,
        });
        assert.equal(packed.ok, true);
        assert.equal(criticCalls, 1);
        assert.equal(packed.interaction_id, 'int-run-2');
        assert.equal(downloadedPaths[0], 'workspace/capsule_state/final_output.json');
        assert.equal(
          packed.explanation,
          'Built a versatile Lisbon capsule within budget. Every piece is verified in stock.',
        );
        assert.equal(packed.critic?.length, 2);
        assert.equal(packed.critic?.[0]?.score, 8);
        assert.ok(
          packed.certificate.checks.some(
            (c) => c.name === 'critic_all_6_plus' && c.ok === true && c.advisory === true,
          ),
        );
        assert.deepEqual(packed.dress_code_notes, []);
        assert.ok(steps.some((s) => s.text.includes('searched 245 products')));
        assert.ok(loggedEvents.some((e) => e.ev === 'capsule_start'));
        assert.ok(loggedEvents.some((e) => e.ev === 'capsule_step'));
        assert.ok(loggedEvents.some((e) => e.ev === 'capsule_done'));

        const streamCallsBeforeRepack = capturedInputs.filter((p) => p.stream).length;
        const repacked = await repackCapsule(packed, 'the dinner is now black tie optional', {
          client: fakeClient,
          toolsDir,
          statePath,
          store: makeFakeStore(),
          critiqueAll: countingCritic,
          critic: true,
        });
        assert.equal(repacked.ok, true);
        assert.equal(criticCalls, 2);
        const streamCallsAfterRepack = capturedInputs.filter((p) => p.stream).length;
        assert.equal(
          streamCallsAfterRepack - streamCallsBeforeRepack,
          1,
          'repackCapsule must make exactly ONE agent interaction',
        );
        const lastReq = capturedInputs[capturedInputs.length - 1]!;
        assert.equal(lastReq.environment, 'env-stream-1');
        assert.equal(lastReq.previous_interaction_id, 'int-run-2');
      } finally {
        setCallLogSink(null);
        setCallRoom(null);
        if (prevEnv === undefined) delete process.env.ALICE_CAPSULE;
        else process.env.ALICE_CAPSULE = prevEnv;
        if (prevCritic === undefined) delete process.env.ALICE_CAPSULE_CRITIC;
        else process.env.ALICE_CAPSULE_CRITIC = prevCritic;
      }
    });
  });

  test('dress-code notes and low critic scores are report-only and never trigger a second sandbox run', async () => {
    await withTempDir(async (dir) => {
      const toolsDir = makeFakeToolsDir(dir);
      const statePath = path.join(dir, 'environment.json');

      const printedTiePipeline: RawPipelineOutput = {
        ...SAMPLE_PIPELINE,
        pieces: [
          ...SAMPLE_PIPELINE.pieces!,
          {
            slot: 'tie',
            title: 'Kith Printed Silk Neck Tie - Sage',
            store: 'Kith',
            store_domain: 'kithnyc.myshopify.com',
            price_usd: 45,
            url: 'https://kith.com/products/tie',
            id: 'gid://shopify/Product/9999',
            variant_id: 'gid://shopify/ProductVariant/9999',
            size_label: 'OS',
          },
        ],
        outfits: [
          SAMPLE_PIPELINE.outfits![0]!,
          {
            day: 'Day 2 - Dinner',
            dress_code: 'black_tie_optional',
            notes: 'black tie optional',
            piece_ids: [
              'owned:white_dress_shirt',
              'gid://shopify/Product/1002',
              'gid://shopify/Product/1003',
              'gid://shopify/Product/9999',
            ],
            total_new_usd: 232,
          },
        ],
      };

      let streamCalls = 0;

      const fakeClient: CapsuleApiClient = {
        environments: {
          async create() {
            return { id: 'env-dc-1' };
          },
          async get(id: string) {
            return { id, state: 'ACTIVE' };
          },
          files: {
            async upload() {
              return { ok: true };
            },
            async download() {
              return Buffer.from(JSON.stringify(printedTiePipeline), 'utf8');
            },
          },
        },
        interactions: {
          async create(params) {
            if (!params.stream) {
              return { id: 'setup-1', environment_id: params.environment, output_text: 'READY' };
            }
            streamCalls += 1;
            return {
              id: `int-${streamCalls}`,
              environment_id: params.environment,
              output_text: 'DONE\nSolved capsule cleanly.',
            };
          },
        },
      };

      const lowCritic: CritiqueAllFn = async (outfits) =>
        outfits.map(() => ({
          score: 4,
          presentable: false,
          occasion_fit: 4,
          cohesion: 4,
          completeness: 5,
          issues: ['missing belt'],
          weak_piece: null,
          model: 'gemini-4-argon',
          ms: 90,
        }));

      const res = await packCapsule(SAMPLE_BRIEF, {
        client: fakeClient,
        toolsDir,
        statePath,
        store: makeFakeStore(),
        critiqueAll: lowCritic,
        critic: true,
        force: true,
      });

      assert.equal(streamCalls, 1, 'dress-code note must NEVER trigger a second sandbox run');
      assert.equal(res.ok, true, 'advisory critic_all_6_plus fail must NOT make ok false');
      assert.deepEqual(res.dress_code_notes, [
        {
          day: 'Day 2 - Dinner',
          title: 'Kith Printed Silk Neck Tie - Sage',
          reason: 'breaks the dress code for Day 2 - Dinner',
        },
      ]);
      assert.equal(res.critic?.length, 2);
      assert.equal(res.critic?.[0]?.score, 4);
      const criticCheck = res.certificate.checks.find((c) => c.name === 'critic_all_6_plus');
      assert.deepEqual(criticCheck, { name: 'critic_all_6_plus', ok: false, advisory: true });

      // Repack with dress-code note also makes strictly ONE interaction and survives critic failure
      const failingCritic: CritiqueAllFn = async () => {
        throw new Error('critic timeout');
      };
      const repacked = await repackCapsule(res, 'dinner is now black tie optional', {
        client: fakeClient,
        toolsDir,
        statePath,
        store: makeFakeStore(),
        critiqueAll: failingCritic,
        critic: true,
        force: true,
      });
      assert.equal(streamCalls, 2, 'repack must make strictly ONE agent interaction');
      assert.equal(repacked.ok, true);
      assert.equal(repacked.critic, undefined, 'critic field must be absent when critic fails');
      assert.equal(repacked.dress_code_notes?.length, 1);
    });
  });

  test('packCapsule never throws when interactions client rejects', async () => {
    const brokenClient: CapsuleApiClient = {
      environments: {
        async create() {
          throw new Error('boom');
        },
        async get() {
          throw new Error('boom');
        },
        files: {
          async upload() {
            throw new Error('boom');
          },
        },
      },
      interactions: {
        async create() {
          throw new Error('sandbox unavailable');
        },
      },
    };

    const res = await packCapsule(SAMPLE_BRIEF, {
      client: brokenClient,
      force: true,
      statePath: path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`),
    });
    assert.equal(res.ok, false);
    assert.ok(res.problems.length > 0);
  });

  test('Python solver self-test passes locally when ortools is installed', (t) => {
    try {
      execFileSync('python3', ['-c', 'import ortools'], { stdio: 'ignore' });
    } catch {
      t.skip('ortools not installed in local python3');
      return;
    }
    const solverPath = path.resolve(import.meta.dirname, '..', 'src', 'capsule', 'tools', 'solver.py');
    const out = execFileSync('python3', ['-B', solverPath, '--self-test'], { encoding: 'utf8' });
    const parsed = JSON.parse(out) as { self_test?: string };
    assert.equal(parsed.self_test, 'ok');
  });
});
