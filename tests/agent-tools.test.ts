import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llm } from '@livekit/agents';
import type {
  BagOut,
  Brief,
  BuildResult,
  Item,
  Outfit,
  PageActionName,
  PageActionReply,
  PageActions,
  SearchResult,
} from '../src/types.ts';
import type { BuildOptions, SwapOptions } from '../src/brain/index.ts';
import type { Critique } from '../src/brain/critic.ts';
import type { SearchOpts } from '../src/store/catalog.ts';
import type { BagLineAdded, BagLineNotAdded } from '../src/store/index.ts';
import type { PageSender } from '../src/agent/page.ts';
import type { OrderController } from '../src/agent/order.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  DUPLICATE_WINDOW_MS,
  FAST_BUILD_RESULT_PREFIX,
  SLOW_TOOL_NOTES,
  TOOL_ERROR_FALLBACK,
  createAgentTools,
  createToolWrapper,
  deriveProductDetails,
  resolveOutfitBoard,
  extractHeroFact,
  sanitizePageMediaUrl,
  selectHeroPieces,
  stableStringify,
  type CameraSnapshot,
  type TimerLike,
  type ToolDeps,
  type WorkingNoteParams,
} from '../src/agent/tools.ts';

interface RecordedLog {
  room: string;
  ev: string;
  data?: Record<string, unknown>;
}

interface PageCall {
  action: PageActionName;
  payload: unknown;
}

const fakeToolOpts = (id = 'call-1') => ({
  toolCallId: id,
  ctx: {} as never,
  abortSignal: new AbortController().signal,
});

function createFakePage(
  responder: (action: PageActionName, payload: unknown) => PageActionReply = () => ({ ok: true }),
): { page: PageSender; calls: PageCall[] } {
  const calls: PageCall[] = [];
  const page: PageSender = {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageActionReply> {
      calls.push({ action, payload });
      return responder(action, payload);
    },
  };
  return { page, calls };
}

function createFakeClock(start = 10_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  const setTimeoutFn = (fn: () => void, ms: number): TimerLike => {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, fn });
    return { id } as unknown as TimerLike;
  };

  const clearTimeoutFn = (handle: TimerLike): void => {
    timers.delete((handle as unknown as { id: number }).id);
  };

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    while (true) {
      let nextKey: number | undefined;
      let nextAt = Infinity;
      for (const [k, entry] of timers.entries()) {
        if (entry.fireAt <= now && entry.fireAt < nextAt) {
          nextAt = entry.fireAt;
          nextKey = k;
        }
      }
      if (nextKey === undefined) break;
      const entry = timers.get(nextKey)!;
      timers.delete(nextKey);
      entry.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeoutFn, clearTimeoutFn, advance, activeTimers: () => timers.size };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-top',
    variant_id: 'var-top-default',
    title: 'Merino Knit Polo - Espresso',
    price: 45,
    url: 'https://example.com/polo',
    image: 'https://cdn.shopify.com/polo.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.8,
    rating_count: 52,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'var-top-s', M: 'var-top-m', L: 'var-top-l' },
    description: '100% extra-fine merino wool. Relaxed collar. Ribbed hem and cuffs.',
    department: 'men',
    ...overrides,
  };
}

function makeSampleOutfits(): Outfit[] {
  const top1 = makeItem();
  const bottom1 = makeItem({
    id: 'item-bottom-1',
    variant_id: 'var-bottom-1',
    title: 'Pleated Wool Trouser - Charcoal',
    price: 60,
    image: 'https://cdn.shopify.com/trouser.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    sizes: [],
    variants_by_size: {},
    description: 'Tailored drape in lightweight wool blend.',
  });
  const shoes1 = makeItem({
    id: 'item-shoes-1',
    variant_id: 'var-shoes-1',
    title: 'Minimal Leather Sneaker - White',
    price: 55,
    image: 'https://cdn.shopify.com/sneaker.jpg',
    store: 'Steve Madden',
    store_domain: 'stevemadden.myshopify.com',
    sizes: ['9', '10', '11'],
    variants_by_size: { '9': 'var-sh-9', '10': 'var-sh-10', '11': 'var-sh-11' },
    description: 'Full-grain leather upper. Cushioned footbed. Rubber cupsole.',
  });

  const top2 = makeItem({
    id: 'item-top-2',
    variant_id: 'var-top-2',
    title: 'Cream Crewneck Sweater',
    price: 35,
    image: 'https://cdn.shopify.com/sweater.jpg',
    store: 'Fashion Nova',
    store_domain: 'fnova.myshopify.com',
    sizes: ['S', 'M', 'L'],
  });
  const shoes2 = makeItem({
    id: 'item-shoes-2',
    variant_id: 'var-shoes-2',
    title: 'Chelsea Boot - Dark Brown',
    price: 75,
    image: 'https://cdn.shopify.com/boot.jpg',
    store: 'Steve Madden',
    store_domain: 'stevemadden.myshopify.com',
    sizes: ['9', '10', '11'],
  });

  return [
    {
      number: 1,
      name: 'Skyline Knit',
      difference: 'Polished knit polo with dark tailored trousers.',
      story: 'Sharp without needing a blazer.',
      pieces: [
        { slot: 'top', why: 'Knit texture elevates the neckline.', item: top1 },
        { slot: 'bottom', why: 'Dark tailored leg anchors the polo.', item: bottom1 },
        { slot: 'shoes', why: 'Crisp white leather keeps it effortless.', item: shoes1 },
      ],
      total: 160,
    },
    {
      number: 2,
      name: 'Warm Neutrals',
      difference: 'Cream knit paired with rich brown boots.',
      story: 'Warm sunset palette.',
      pieces: [
        { slot: 'top', why: 'Cream softens the whole look.', item: top2 },
        { slot: 'shoes', why: 'Brown boots ground the sweater.', item: shoes2 },
      ],
      total: 110,
    },
  ];
}

function makeFakeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const sampleOutfits = makeSampleOutfits();
  return {
    async buildOutfits(_brief, opts): Promise<BuildResult> {
      const cloned = structuredClone(sampleOutfits);
      cloned.forEach((o, i) => opts?.onOutfit?.(o, i));
      return {
        outfits: cloned,
        source: 'library',
        timing: { first_outfit_ms: 120, total_ms: 250 },
        problems: ['minor sizing gap on accessory'],
      };
    },
    async swapPiece(outfit, slot, request): Promise<{ outfit: Outfit; piece: Outfit['pieces'][0]; note?: string }> {
      const updated = structuredClone(outfit);
      const idx = updated.pieces.findIndex((p) => p.slot === slot);
      const replacementItem = makeItem({
        id: 'item-swapped',
        variant_id: 'var-swapped',
        title: `Swapped ${slot} (${request})`,
        price: 40,
        store: 'Kith',
        store_domain: 'kith.myshopify.com',
        sizes: ['9', '10', '11'],
      });
      const replacementPiece = { slot, why: 'Matches request.', item: replacementItem };
      if (idx >= 0) updated.pieces[idx] = replacementPiece;
      updated.total = Math.round(updated.pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
      return { outfit: updated, piece: replacementPiece, note: 'Saved $15 on the swap.' };
    },
    async outfitCollage(outfit) {
      return `https://media.local/collage-${outfit.number ?? 1}.jpg`;
    },
    async productImages(item) {
      return [item.image, `${item.image}?angle=2`];
    },
    async tryOn(_jpeg, outfit) {
      return {
        url: `https://media.local/tryon-${outfit.number ?? 1}.jpg`,
        path: `/tmp/tryon-${outfit.number ?? 1}.jpg`,
        ms: 50,
        id: `tryon-${outfit.number ?? 1}`,
      };
    },
    tryOnExtras: null,
    async loadStoreModule() {
      return null;
    },
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

test('createAgentTools builds 13 anonymous tools accepted by LiveKit ToolContext', () => {
  const tools = createAgentTools({ room: 'test-room', log: () => {} });
  const expectedNames = [
    'remember',
    'show_rack',
    'set_department',
    'build_outfits',
    'pick_outfit',
    'show_on_me',
    'swap_piece',
    'add_to_bag',
    'remove_from_bag',
    'show_product',
    'hide_product',
    'show_all_looks',
    'search_products',
  ];

  assert.deepEqual(Object.keys(tools).sort(), [...expectedNames].sort());

  for (const [key, entry] of Object.entries(tools)) {
    assert.equal('name' in entry, false, `tool "${key}" must be anonymous (no name property)`);
    assert.equal('id' in entry, false, `tool "${key}" must be anonymous (no id property)`);
  }

  const toolCtx = new llm.ToolContext(tools);
  assert.equal(Object.keys(toolCtx.functionTools).length, expectedNames.length);
  for (const name of expectedNames) {
    assert.equal(toolCtx.hasTool(name), true);
  }
});

test('duplicate-call guard returns the first promise within 15s and logs tool_duplicate', async () => {
  const logs: RecordedLog[] = [];
  let now = 1_000;
  let executions = 0;

  const wrapper = createToolWrapper({
    room: 'dup-room',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => now,
  });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const fn = wrapper.wrap('pick_outfit', async (args: { outfit: number; note?: string }) => {
    executions++;
    if (executions === 1) await firstGate;
    return `picked ${args.outfit} (#${executions})`;
  });

  const p1 = fn({ outfit: 2, note: 'a' }, { toolCallId: 'call-1' });
  now += 2_000;
  const p2 = fn({ note: 'a', outfit: 2 }, { toolCallId: 'call-2' });

  assert.strictEqual(p1, p2);
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'picked 2 (#1)');
  assert.equal(r2, 'picked 2 (#1)');
  assert.equal(executions, 1);

  const dupLogs = logs.filter((l) => l.ev === 'tool_duplicate');
  assert.equal(dupLogs.length, 1);
  assert.equal(dupLogs[0]!.data?.call_id, 'call-2');
  assert.equal(dupLogs[0]!.data?.original_call_id, 'call-1');

  now += DUPLICATE_WINDOW_MS;
  const r3 = await fn({ outfit: 2, note: 'a' }, { toolCallId: 'call-3' });
  assert.equal(r3, 'picked 2 (#2)');
  assert.equal(executions, 2);
});

test('tool wrapper never throws, logs tool_error, and returns carry-on text', async () => {
  const logs: RecordedLog[] = [];
  const wrapper = createToolWrapper({
    room: 'err-room',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const failing = wrapper.wrap('swap_piece', async () => {
    throw new Error('upstream store unavailable');
  });

  const result = await failing({ outfit: 1, slot: 'shoes', request: 'boots' }, { toolCallId: 'c-err' });
  assert.equal(result, TOOL_ERROR_FALLBACK);

  const errLog = logs.find((l) => l.ev === 'tool_error');
  assert.ok(errLog);
  assert.equal(errLog!.data?.name, 'swap_piece');
  assert.equal((errLog!.data?.error as Error).message, 'upstream store unavailable');
});

test('stableStringify produces identical output regardless of object key order', () => {
  assert.equal(
    stableStringify({ b: 2, a: { y: 1, x: 0 } }),
    stableStringify({ a: { x: 0, y: 1 }, b: 2 }),
  );
});

test('remember and set_department update state and extract shopper name', async () => {
  const logs: RecordedLog[] = [];
  const state = createCallStateStore({
    roomName: 'r-rem',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });
  const tools = createAgentTools({
    room: 'r-rem',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    state,
    deps: makeFakeDeps(),
  });

  const remRes = await tools.remember.execute({ fact: "Shopper's name is Elena" }, fakeToolOpts('c1'));
  assert.match(remRes, /Elena/);
  assert.equal(state.get().shopperName, 'Elena');
  assert.deepEqual(state.get().facts, ["Shopper's name is Elena"]);

  const deptRes = await tools.set_department.execute({ department: 'women' }, fakeToolOpts('c2'));
  assert.match(deptRes, /women/);
  assert.equal(state.get().department, 'women');
});

test('build_outfits requires department, caps budget at $10000, streams looks, starts background media, and logs', async () => {
  const logs: RecordedLog[] = [];
  const notes: WorkingNoteParams[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({
    roomName: 'r-build',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  let capturedBrief: Brief | null = null;
  let capturedBuildOpts: BuildOptions | undefined;
  let tryOnReceivedJpeg: Buffer | null = null;
  const fakeSnap: CameraSnapshot = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    at: 9_000,
  };

  const tools = createAgentTools({
    room: 'r-build',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    sendWorkingNote: (n) => {
      notes.push(n);
      return true;
    },
    getSnapshot: () => fakeSnap,
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(brief, opts) {
        capturedBrief = brief;
        capturedBuildOpts = opts;
        return makeFakeDeps().buildOutfits!(brief, opts);
      },
      async tryOn(jpeg, outfit) {
        tryOnReceivedJpeg = jpeg;
        return {
          url: `https://media.local/tryon-${outfit.number}.jpg`,
          path: '',
          ms: 10,
          id: `t-${outfit.number}`,
        };
      },
    }),
  });

  // Without department set, tells model to set department first.
  const noDept = await tools.build_outfits.execute(
    { occasion: 'gala', budget_usd: 25_000 },
    fakeToolOpts('b0'),
  );
  assert.match(noDept, /set_department/i);
  assert.equal(calls.length, 0);

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));

  const res = await tools.build_outfits.execute(
    { occasion: 'gala', budget_usd: 25_000, notes: 'sleek', own_piece: 'gold watch' },
    fakeToolOpts('b1'),
  );

  // Fast library result (< 2s) and missing-department early return skip working notes / bits.
  assert.equal(notes.filter((n) => n.name === 'build_outfits').length, 0);
  // Budget capped at 10000 and room forwarded to buildOutfits alongside onOutfit.
  assert.equal(capturedBrief!.budget_usd, 10_000);
  assert.equal(capturedBuildOpts?.room, 'r-build');
  assert.equal(typeof capturedBuildOpts?.onOutfit, 'function');
  assert.equal(state.get().budget.given, 10_000);
  assert.match(res, /capped at \$10000/i);
  assert.match(res, /now on screen/i);
  assert.match(res, /Look 1 — Skyline Knit \(\$160\)/);
  assert.match(res, /Look 2 — Warm Neutrals \(\$110\)/);
  assert.match(res, /Merino Knit Polo - Espresso/);
  assert.match(res, /Internal notes \(do not read aloud\): minor sizing gap on accessory/);

  // Streamed showOutfits one by one with replace: index === 0.
  const showCalls = calls.filter((c) => c.action === 'showOutfits');
  assert.equal(showCalls.length, 2);
  assert.equal((showCalls[0]!.payload as PageActions['showOutfits']).replace, true);
  assert.equal((showCalls[0]!.payload as PageActions['showOutfits']).outfits.length, 1);
  assert.equal((showCalls[1]!.payload as PageActions['showOutfits']).replace, false);
  assert.equal((showCalls[1]!.payload as PageActions['showOutfits']).outfits.length, 1);

  await flushMicrotasks();

  // Background tryOn & collage ran without blocking build_outfits.
  assert.strictEqual(tryOnReceivedJpeg, fakeSnap.jpeg);
  assert.equal(state.get().tryOn[1]?.status, 'ready');
  assert.equal(state.get().tryOn[1]?.url, 'https://media.local/tryon-1.jpg');
  assert.ok(calls.some((c) => c.action === 'tryOnStatus'));
  assert.ok(calls.some((c) => c.action === 'tryOnReady'));
  assert.ok(calls.some((c) => c.action === 'collageReady'));

  assert.equal(logs.filter((l) => l.ev === 'build_progress').length, 2);
  assert.equal(logs.filter((l) => l.ev === 'build_done').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'tryon').length, 2);
  assert.equal(logs.filter((l) => l.ev === 'collage').length, 2);
});

test('build_outfits reports when page did not confirm and survives failing background tryOn/collage', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage((action) =>
    action === 'showOutfits' ? { ok: false, error: 'disconnected' } : { ok: true },
  );
  const state = createCallStateStore({ roomName: 'r-bg-fail', log: () => {} });

  const tools = createAgentTools({
    room: 'r-bg-fail',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async tryOn() {
        throw new Error('gpu out of memory');
      },
      async outfitCollage() {
        throw new Error('collage timeout');
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  const res = await tools.build_outfits.execute(
    { occasion: 'dinner', budget_usd: 200 },
    fakeToolOpts('b1'),
  );

  assert.match(res, /page did not confirm/i);
  assert.doesNotMatch(res, /now on screen/i);

  await flushMicrotasks();

  assert.equal(state.get().tryOn[1]?.status, 'failed');
  const failedStatus = calls.find(
    (c) =>
      c.action === 'tryOnStatus' &&
      (c.payload as PageActions['tryOnStatus']).status === 'failed',
  );
  assert.ok(failedStatus, 'must send tryOnStatus failed on error');

  const tryOnFailLogs = logs.filter((l) => l.ev === 'tryon' && l.data?.status === 'failed');
  assert.equal(tryOnFailLogs.length, 2);
  assert.match(String(tryOnFailLogs[0]!.data?.error), /gpu out of memory/);
  assert.equal(tryOnFailLogs[0]!.data?.had_snapshot, false);

  const collageFailLogs = logs.filter((l) => l.ev === 'collage' && l.data?.ok === false);
  assert.equal(collageFailLogs.length, 2);
});

test('pick_outfit validates look, highlights pieces every 2.2s, and cancels walk on show_all_looks', async () => {
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-pick', log: () => {} });

  const tools = createAgentTools({
    room: 'r-pick',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    deps: makeFakeDeps(),
  });

  const missing = await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p0'));
  assert.match(missing, /does not exist/i);

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  calls.length = 0;

  const picked = await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(state.get().pickedLook, 1);
  assert.match(picked, /HERO \(top\): Merino Knit Polo - Espresso.*100% extra-fine merino wool/);
  assert.match(picked, /HERO \(shoes\): Minimal Leather Sneaker - White.*Full-grain leather upper/);
  assert.match(picked, /Other pieces already on screen \(do not list them\): bottom: Pleated Wool Trouser - Charcoal/);
  assert.match(picked, /Try-on is ready/i);
  assert.match(picked, /about ten seconds/i);
  assert.match(picked, /Never invent materials/i);
  assert.match(picked, /ask about seeing it on them/i);
  assert.doesNotMatch(picked, /four or five sentences/i);

  // Initial highlight with piece: null.
  assert.deepEqual(calls, [{ action: 'highlight', payload: { outfit: 1, piece: null } }]);

  // Advance 2.2s -> highlights top; another 2.2s -> highlights bottom.
  await clock.advance(2_200);
  assert.deepEqual(calls.at(-1), { action: 'highlight', payload: { outfit: 1, piece: 'top' } });

  await clock.advance(2_200);
  assert.deepEqual(calls.at(-1), { action: 'highlight', payload: { outfit: 1, piece: 'bottom' } });

  // show_all_looks cancels the remaining walk (shoes never highlighted).
  const allRes = await tools.show_all_looks.execute({}, fakeToolOpts('sa1'));
  assert.match(allRes, /all looks/i);
  assert.equal(state.get().pickedLook, null);
  assert.equal(clock.activeTimers(), 0);

  await clock.advance(5_000);
  const shoeHighlights = calls.filter(
    (c) => c.action === 'highlight' && (c.payload as PageActions['highlight']).piece === 'shoes',
  );
  assert.equal(shoeHighlights.length, 0);
});

test('show_on_me reveals ready try-on, waits for rendering try-on, times out at 45s, and flags missing snapshot', async () => {
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-tryon', log: () => {} });

  let resolveLook1!: (val: { url: string; path: string; ms: number; id: string }) => void;
  const look1Gate = new Promise<{ url: string; path: string; ms: number; id: string }>((r) => {
    resolveLook1 = r;
  });
  // Look 2 never finishes (tests 45s timeout).
  const look2Never = new Promise<{ url: string; path: string; ms: number; id: string }>(() => {});

  const tools = createAgentTools({
    room: 'r-tryon',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    getSnapshot: () => null, // No camera snapshot
    page,
    state,
    deps: makeFakeDeps({
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 1) return look1Gate;
        return look2Never;
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'party', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // 1) Rendering -> waits, resolves before 45s, reveals, notes missing snapshot.
  const show1Promise = tools.show_on_me.execute({}, fakeToolOpts('s1'));
  await flushMicrotasks();
  assert.equal(state.get().tryOn[1]?.status, 'rendering');

  resolveLook1({ url: 'https://media.local/on-me-1.jpg', path: '', ms: 200, id: 'ok1' });
  const show1Res = await show1Promise;
  assert.match(show1Res, /revealed on screen on a model/i);
  assert.match(show1Res, /turning the camera on lets you show it on them/i);
  assert.match(show1Res, /never say you cannot overlay it/i);
  assert.deepEqual(state.get().revealsDone, [1]);
  assert.ok(
    calls.some(
      (c) =>
        c.action === 'reveal' &&
        (c.payload as PageActions['reveal']).outfit === 1 &&
        (c.payload as PageActions['reveal']).url === 'https://media.local/on-me-1.jpg',
    ),
  );

  // 2) Rendering -> times out at 45s with fake timers -> fitting room jammed.
  const show2Promise = tools.show_on_me.execute({ outfit: 2 }, fakeToolOpts('s2'));
  await flushMicrotasks();
  await clock.advance(44_999);
  await clock.advance(1);

  const show2Res = await show2Promise;
  assert.match(show2Res, /fitting room is jammed/i);
  assert.match(show2Res, /flat-lay/i);
  assert.match(show2Res, /camera is off/i);
});

test('swap_piece updates state, sends updateOutfit, restarts try-on & collage, and logs swap', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-swap', log: () => {} });
  let tryOnCalls = 0;
  let collageCalls = 0;
  let capturedSwapOpts: SwapOptions | undefined;

  const tools = createAgentTools({
    room: 'r-swap',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async swapPiece(outfit, slot, request, brief, opts) {
        capturedSwapOpts = opts;
        return makeFakeDeps().swapPiece!(outfit, slot, request, brief, opts);
      },
      async tryOn(_jpeg, outfit) {
        tryOnCalls++;
        return { url: `https://media.local/tryon-${outfit.number}-v${tryOnCalls}.jpg`, path: '', ms: 5, id: `id-${tryOnCalls}` };
      },
      async outfitCollage(outfit) {
        collageCalls++;
        return `https://media.local/collage-${outfit.number}-v${collageCalls}.jpg`;
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;
  const beforeTryOn = tryOnCalls;
  const beforeCollage = collageCalls;

  const swapRes = await tools.swap_piece.execute(
    { slot: 'shoes', request: 'brown boots' },
    fakeToolOpts('sw1'),
  );
  await flushMicrotasks();

  assert.match(swapRes, /Swapped shoes \(brown boots\)/);
  assert.match(swapRes, /\$40/);
  assert.match(swapRes, /Kith/);
  assert.match(swapRes, /\$145/);
  assert.match(swapRes, /Saved \$15 on the swap/);

  assert.equal(capturedSwapOpts?.room, 'r-swap', 'swapPiece must receive { room }');
  assert.ok(calls.some((c) => c.action === 'updateOutfit'));
  assert.equal(tryOnCalls, beforeTryOn + 1, 'swap must restart tryOn');
  assert.equal(collageCalls, beforeCollage + 1, 'swap must restart collage');

  const swapLog = logs.find((l) => l.ev === 'swap');
  assert.ok(swapLog);
  assert.equal(swapLog!.data?.outfit, 1);
  assert.equal(swapLog!.data?.slot, 'shoes');
  assert.equal(swapLog!.data?.price, 40);
  assert.equal(swapLog!.data?.note, 'Saved $15 on the swap.');
});

test('show_product and hide_product send page actions, fallback image, and return exact description', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-prod', log: () => {} });

  const tools = createAgentTools({
    room: 'r-prod',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async productImages() {
        return []; // Forces fallback to [item.image]
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  const res = await tools.show_product.execute({ slot: 'top' }, fakeToolOpts('sp1'));
  assert.match(res, /Merino Knit Polo - Espresso/);
  assert.match(res, /\$45/);
  assert.match(res, /Everlane/);
  assert.match(res, /S, M, L/);
  assert.match(res, /100% extra-fine merino wool/);

  const showProd = calls.find((c) => c.action === 'showProduct');
  assert.ok(showProd);
  const payload = showProd!.payload as PageActions['showProduct'];
  assert.deepEqual(payload.images, ['https://cdn.shopify.com/polo.jpg']);
  assert.deepEqual(payload.details, [
    '100% extra-fine merino wool',
    'Relaxed collar',
    'Ribbed hem and cuffs',
  ]);

  const hideRes = await tools.hide_product.execute({}, fakeToolOpts('hp1'));
  assert.match(hideRes, /closed/i);
  assert.ok(calls.some((c) => c.action === 'hideProduct'));

  assert.deepEqual(deriveProductDetails('Single short phrase'), []);
});

test('search_products handles missing store module gracefully and displays results when store module exists', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-search', log: () => {} });

  const toolsNoStore = createAgentTools({
    room: 'r-search',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return null;
      },
    }),
  });

  const unavail = await toolsNoStore.search_products.execute(
    { query: 'linen shirt', max_price: 80 },
    fakeToolOpts('sr0'),
  );
  assert.match(unavail, /not available yet/i);
  assert.equal(calls.length, 0);

  const foundItem = makeItem({ title: 'Breezy Linen Shirt', price: 62 });
  const toolsWithStore = createAgentTools({
    room: 'r-search',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async search(_q, _g, _opts): Promise<SearchResult> {
            return { items: [foundItem], source: 'live', ms: 35 };
          },
        };
      },
    }),
  });

  const avail = await toolsWithStore.search_products.execute(
    { query: 'linen shirt', max_price: 80 },
    fakeToolOpts('sr1'),
  );
  assert.match(avail, /Breezy Linen Shirt/);
  assert.ok(calls.some((c) => c.action === 'showSearch'));
});

test('add_to_bag enforces heard-sizes NOT DONE check, remembers sizes across calls, dedupes, and converts BagOut to bagReady', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag', log: () => {} });
  let clockNow = 1_000;
  let storeAddCalls = 0;

  const tools = createAgentTools({
    room: 'r-bag',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => clockNow,
    page,
    state,
    deps: makeFakeDeps({
      async addToBag(_outfit, sizes): Promise<BagOut> {
        storeAddCalls++;
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: 'cart-ev-1',
              continue_url: 'https://everlane.com/cart/1',
              total_usd: 105,
              added: [
                { variant_id: 'var-top-m', title: 'Merino Knit Polo - Espresso', size: sizes.top },
                { variant_id: 'var-bottom-1', title: 'Pleated Wool Trouser - Charcoal', size: null },
              ],
              not_added: [],
              ms: 40,
            },
            {
              store: 'Steve Madden',
              store_domain: 'stevemadden.myshopify.com',
              cart_id: 'cart-sm-1',
              continue_url: null,
              total_usd: 0,
              added: [],
              not_added: [
                {
                  variant_id: 'var-shoes-1',
                  title: 'Minimal Leather Sneaker - White',
                  reason: 'Size 10 is sold out.',
                },
              ],
              ms: 50,
            },
          ],
          summary: 'Added 2 items; 1 sold out.',
          total_usd: 105,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'rooftop', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // Look 1 has top (sizes: S,M,L), bottom (sizes: [] -> not required), shoes (sizes: 9,10,11).
  // Provide NO sizes at all -> NOT DONE naming top and shoes without calling addToBag.
  const notDoneEmpty = await tools.add_to_bag.execute({ sizes: {} }, fakeToolOpts('bag0'));
  assert.equal(notDoneEmpty.startsWith('NOT DONE:'), true);
  assert.match(notDoneEmpty, /\btop\b/);
  assert.match(notDoneEmpty, /\bshoes\b/);
  assert.doesNotMatch(notDoneEmpty, /\bbottom\b/);
  assert.equal(storeAddCalls, 0);

  // Provide only top -> bags what can be bagged (top + bottom), remembers top=M, and reports shoes as NOT ADDED!
  const partialFirst = await tools.add_to_bag.execute({ sizes: { top: 'M' } }, fakeToolOpts('bag1'));
  assert.equal(state.get().sizes.top, 'M');
  assert.equal(storeAddCalls, 1);
  assert.match(partialFirst, /^PARTLY DONE: NOT ADDED \(.*\):.*Minimal Leather Sneaker - White/);
  assert.match(partialFirst, /no shoes size given/i);
  assert.match(partialFirst, /Added 2 pieces, total \$105/);

  // Next call supplies ONLY shoes -> merges with remembered top=M and sends full look!
  const added = await tools.add_to_bag.execute({ sizes: { shoes: '10' } }, fakeToolOpts('bag2'));
  assert.equal(storeAddCalls, 2);
  assert.match(added, /^PARTLY DONE: NOT ADDED \(1\):.*Minimal Leather Sneaker - White.*Size 10 is sold out/);
  assert.match(added, /Added 2 pieces, total \$105/);
  assert.match(added, /Everlane:.*Merino Knit Polo - Espresso \(size M\)/);
  assert.match(added, /Checkout link is on the page \(Everlane\)/);
  assert.match(added, /never say a not-added piece is in the bag/i);
  assert.match(state.summarize(), /NOT_ADDED=\[Minimal Leather Sneaker - White \(Size 10 is sold out\)\]/);

  const bagCall = calls.filter((c) => c.action === 'bagReady').at(-1);
  assert.ok(bagCall);
  const bagPayload = bagCall!.payload as PageActions['bagReady'];
  assert.equal(bagPayload.total, 105);
  assert.deepEqual(bagPayload.links, [{ store: 'Everlane', url: 'https://everlane.com/cart/1' }]);
  assert.equal(bagPayload.stores.length, 2);
  assert.equal(bagPayload.stores[1]!.not_added[0]!.reason, 'Size 10 is sold out.');

  const bagLog = logs.filter((l) => l.ev === 'bag').at(-1);
  assert.ok(bagLog);
  assert.equal(bagLog!.data?.total, 105);

  // Advance past 15s wrapper duplicate window -> bag dedupe STILL catches exact same look+sizes
  // and keeps PARTLY DONE prefix rather than claiming everything is already in the bag!
  clockNow += DUPLICATE_WINDOW_MS + 1_000;
  const deduped = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('bag3'),
  );
  assert.equal(storeAddCalls, 2, 'bag dedupe must not call addToBag a second time');
  assert.match(deduped, /^PARTLY DONE:/);
  assert.doesNotMatch(deduped, /^Already in the bag\./);
});

test('add_to_bag falls back to local mock when store module is missing', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-mock', log: () => {} });

  const tools = createAgentTools({
    room: 'r-bag-mock',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return null;
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'rooftop', budget_usd: 200 }, fakeToolOpts('b1'));

  const res = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'L', shoes: '11' } },
    fakeToolOpts('bm1'),
  );
  assert.match(res, /mocked/i);
  assert.match(res, /\$160/);

  const bagCall = calls.find((c) => c.action === 'bagReady');
  assert.ok(bagCall);
  const bagPayload = bagCall!.payload as PageActions['bagReady'];
  assert.deepEqual(bagPayload.links, [], 'mock cart must have continue_url null (no links)');
  assert.equal(bagPayload.total, 160);
});

test('search_products prefers searchMixed when exported and falls back to search otherwise', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-search-mixed', log: () => {} });

  let mixedCalls = 0;
  let searchCalls = 0;
  let capturedArgs: { query: string; gender: string; opts?: SearchOpts } | null = null;
  const mixedItem = makeItem({ title: 'Mixed Linen Overshirt', price: 78, store: 'Kith' });

  const toolsMixed = createAgentTools({
    room: 'r-search-mixed',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async searchMixed(query, gender, opts): Promise<SearchResult> {
            mixedCalls++;
            capturedArgs = { query, gender, opts };
            return { items: [mixedItem], source: 'live', ms: 22 };
          },
          async search(): Promise<SearchResult> {
            searchCalls++;
            return { items: [], source: 'empty', ms: 5 };
          },
        };
      },
    }),
  });

  await toolsMixed.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  const resMixed = await toolsMixed.search_products.execute(
    { query: 'linen overshirt', max_price: 90 },
    fakeToolOpts('sm1'),
  );

  assert.equal(mixedCalls, 1);
  assert.equal(searchCalls, 0);
  assert.deepEqual(capturedArgs, {
    query: 'linen overshirt',
    gender: 'men',
    opts: { limit: 8, maxPrice: 90 },
  });
  assert.match(resMixed, /Mixed Linen Overshirt/);
  assert.ok(calls.some((c) => c.action === 'showSearch'));

  // Without searchMixed, falls back to search.
  const searchOnlyItem = makeItem({ title: 'Plain Cotton Tee', price: 28, store: 'Everlane' });
  const toolsSearchOnly = createAgentTools({
    room: 'r-search-only',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async search(_q, _g, _opts): Promise<SearchResult> {
            searchCalls++;
            return { items: [searchOnlyItem], source: 'live', ms: 18 };
          },
        };
      },
    }),
  });

  const resFallback = await toolsSearchOnly.search_products.execute(
    { query: 'cotton tee' },
    fakeToolOpts('sr1'),
  );
  assert.equal(searchCalls, 1);
  assert.match(resFallback, /Plain Cotton Tee/);
});

test('add_to_bag bags remaining pieces when store refuses whole cart over one missing size, then bags all once missing size is given', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-notdone', log: () => {} });
  let storeAddCalls = 0;
  const storeReceivedSlots: string[][] = [];

  const tools = createAgentTools({
    room: 'r-bag-notdone',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async addToBag(bagOutfit, sizes): Promise<BagOut> {
            storeAddCalls++;
            storeReceivedSlots.push(bagOutfit.pieces.map((p) => p.slot));
            const hasBottomPiece = bagOutfit.pieces.some((p) => p.slot === 'bottom');
            // Simulate src/store/bag.ts refusing the whole cart whenever a piece lacks a size.
            if (hasBottomPiece && !sizes.bottom) {
              const addedLine: BagLineAdded = {
                variant_id: 'var-top-m-live',
                title: 'Merino Knit Polo - Espresso',
                size: sizes.top ?? 'M',
                slot: 'top',
                image: 'https://cdn.shopify.com/polo.jpg',
                price: 45,
                item_id: 'item-top',
              };
              const missingLine: BagLineNotAdded = {
                variant_id: 'var-bottom-1',
                title: 'Pleated Wool Trouser - Charcoal',
                size: null,
                reason: 'no bottom size given (sizes: 30, 32, 34)',
                slot: 'bottom',
                image: 'https://cdn.shopify.com/trouser.jpg',
                price: 60,
                item_id: 'item-bottom-1',
              };
              return {
                carts: [
                  {
                    store: 'Everlane',
                    store_domain: 'everlane.myshopify.com',
                    cart_id: null,
                    continue_url: null,
                    total_usd: null,
                    added: [addedLine],
                    not_added: [missingLine],
                    ms: 0,
                  },
                ],
                summary: 'NOT DONE: Pleated Wool Trouser - Charcoal (bottom) still need a size.',
                total_usd: 0,
              };
            }

            const topAdded: BagLineAdded = {
              variant_id: 'var-top-m-resolved',
              title: 'Merino Knit Polo - Espresso',
              size: sizes.top,
              slot: 'top',
              image: 'https://cdn.shopify.com/polo-store.jpg',
              price: 45,
              item_id: 'item-top',
            };
            const bottomAdded: BagLineAdded = {
              variant_id: 'var-bottom-32-resolved',
              title: 'Pleated Wool Trouser - Charcoal',
              size: sizes.bottom,
              slot: 'bottom',
              image: 'https://cdn.shopify.com/trouser-store.jpg',
              price: 60,
              item_id: 'item-bottom-1',
            };
            const shoesNotAdded: BagLineNotAdded = {
              variant_id: 'var-shoes-10-resolved',
              title: 'Minimal Leather Sneaker - White',
              size: sizes.shoes,
              reason: '10 is sold out; nearest 10.5',
              slot: 'shoes',
              image: 'https://cdn.shopify.com/sneaker-store.jpg',
              price: 55,
              item_id: 'item-shoes-1',
            };
            const everlaneAdded = hasBottomPiece ? [topAdded, bottomAdded] : [topAdded];
            const everlaneTotal = hasBottomPiece ? 105 : 45;
            return {
              carts: [
                {
                  store: 'Everlane',
                  store_domain: 'everlane.myshopify.com',
                  cart_id: 'cart-ev-real',
                  continue_url: 'https://everlane.com/cart/c/real',
                  total_usd: everlaneTotal,
                  added: everlaneAdded,
                  not_added: [],
                  ms: 42,
                },
                {
                  store: 'Steve Madden',
                  store_domain: 'stevemadden.myshopify.com',
                  cart_id: null,
                  continue_url: null,
                  total_usd: null,
                  added: [],
                  not_added: [shoesNotAdded],
                  ms: 15,
                },
              ],
              summary: `Everlane: ${everlaneAdded.length} added, $${everlaneTotal}.00. Minimal Leather Sneaker - White: 10 is sold out; nearest 10.5. 1 checkout link ready.`,
              total_usd: everlaneTotal,
            };
          },
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // First call supplies top + shoes; store refuses whole cart because bottom (whose Item.sizes was [])
  // needs a size. Agent MUST retry with just [top, shoes], bag the top, send bagReady, and report
  // both the unavailable shoes AND the missing-size bottom as NOT ADDED with their reasons!
  const firstRes = await tools.add_to_bag.execute(
    { sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('bag-nd-1'),
  );
  assert.equal(storeAddCalls, 2);
  assert.deepEqual(storeReceivedSlots[0], ['top', 'bottom', 'shoes']);
  assert.deepEqual(storeReceivedSlots[1], ['top', 'shoes']);
  assert.equal(firstRes.startsWith('PARTLY DONE:'), true);
  assert.match(firstRes, /Pleated Wool Trouser - Charcoal at Everlane \(no bottom size given \(sizes: 30, 32, 34\)\)/);
  assert.match(firstRes, /Minimal Leather Sneaker - White at Steve Madden \(10 is sold out; nearest 10\.5\)/);
  assert.match(firstRes, /Added 1 piece, total \$45/);
  assert.equal(calls.filter((c) => c.action === 'bagReady').length, 1);
  assert.ok(state.get().bag, 'flow state must record bag once a real cart exists for baggable pieces');

  // Second call supplies missing bottom size -> real cart created for top + bottom (shoes still sold out)!
  const secondRes = await tools.add_to_bag.execute(
    { sizes: { bottom: '32' } },
    fakeToolOpts('bag-nd-2'),
  );
  assert.equal(storeAddCalls, 3);
  assert.equal(secondRes.startsWith('NOT DONE:'), false);
  assert.equal(secondRes.startsWith('PARTLY DONE:'), true);
  assert.match(secondRes, /NOT ADDED \(1\):.*Minimal Leather Sneaker - White/);
  assert.match(secondRes, /Added 2 pieces, total \$105/);
  assert.match(secondRes, /Checkout link is on the page \(Everlane\)/);
  assert.ok(state.get().bag, 'flow state must record bag once a real cart exists');

  const bagCall = calls.filter((c) => c.action === 'bagReady').at(-1);
  assert.ok(bagCall);
  const payload = bagCall!.payload as PageActions['bagReady'];
  assert.equal(payload.stores[0]!.added[0]!.image, 'https://cdn.shopify.com/polo-store.jpg');
  assert.equal(payload.stores[0]!.added[1]!.slot, 'bottom');
  assert.equal(payload.stores[0]!.added[1]!.size, '32');
  assert.equal(payload.stores[1]!.not_added[0]!.size, '10');
  assert.equal(payload.stores[1]!.not_added[0]!.image, 'https://cdn.shopify.com/sneaker-store.jpg');
  assert.deepEqual(payload.links, [{ store: 'Everlane', url: 'https://everlane.com/cart/c/real' }]);
});

test('add_to_bag does not count as done when store creates no real cart (all sold out or cart failure)', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-nocart', log: () => {} });

  const tools = createAgentTools({
    room: 'r-bag-nocart',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async addToBag(): Promise<BagOut> {
            return {
              carts: [
                {
                  store: 'Everlane',
                  store_domain: 'everlane.myshopify.com',
                  cart_id: null,
                  continue_url: null,
                  total_usd: null,
                  added: [],
                  not_added: [
                    {
                      variant_id: 'var-top-m',
                      title: 'Merino Knit Polo - Espresso',
                      reason: 'M is sold out; nearest L',
                    },
                  ],
                  ms: 25,
                },
              ],
              summary: 'Merino Knit Polo - Espresso: M is sold out; nearest L. 0 checkout links ready.',
              total_usd: 0,
            };
          },
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  const res = await tools.add_to_bag.execute(
    { sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('bag-nc-1'),
  );
  assert.equal(res.startsWith('NOT DONE:'), true);
  assert.match(res, /M is sold out; nearest L/);
  assert.equal(calls.some((c) => c.action === 'bagReady'), false);
  assert.equal(state.get().bag, null);
});

test('show_product falls back to store productImages when media version is absent or returns empty', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-prod-store', log: () => {} });
  let storeImgCalls = 0;

  // 1) Media productImages returns empty -> uses store productImages.
  const toolsEmptyMedia = createAgentTools({
    room: 'r-prod-store',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async productImages() {
        return [];
      },
      async loadStoreModule() {
        return {
          async productImages(item) {
            storeImgCalls++;
            return [item.image, 'https://store.cdn/polo-back.jpg'];
          },
        };
      },
    }),
  });

  await toolsEmptyMedia.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await toolsEmptyMedia.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await toolsEmptyMedia.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  await toolsEmptyMedia.show_product.execute({ slot: 'top' }, fakeToolOpts('sp-store-1'));
  assert.equal(storeImgCalls, 1);
  const firstPayload = calls.find((c) => c.action === 'showProduct')!.payload as PageActions['showProduct'];
  assert.deepEqual(firstPayload.images, [
    'https://cdn.shopify.com/polo.jpg',
    'https://store.cdn/polo-back.jpg',
  ]);

  // 2) Media productImages is absent (undefined) -> uses store productImages.
  const toolsAbsentMedia = createAgentTools({
    room: 'r-prod-absent',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      productImages: undefined,
      async loadStoreModule() {
        return {
          async productImages() {
            storeImgCalls++;
            return ['https://store.cdn/polo-front.jpg', 'https://store.cdn/polo-detail.jpg'];
          },
        };
      },
    }),
  });

  await toolsAbsentMedia.set_department.execute({ department: 'men' }, fakeToolOpts('d2'));
  await toolsAbsentMedia.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b2'));
  await toolsAbsentMedia.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p2'));
  calls.length = 0;

  await toolsAbsentMedia.show_product.execute({ slot: 'top' }, fakeToolOpts('sp-store-2'));
  assert.equal(storeImgCalls, 2);
  const secondPayload = calls.find((c) => c.action === 'showProduct')!.payload as PageActions['showProduct'];
  assert.deepEqual(secondPayload.images, [
    'https://store.cdn/polo-front.jpg',
    'https://store.cdn/polo-detail.jpg',
  ]);
});

test('real media layer shapes: /tryon URLs only (never file paths), slow 25s tryOn, null collage, and deduped productImages', async () => {
  assert.equal(sanitizePageMediaUrl('/tryon/tryon-abc123.jpg'), '/tryon/tryon-abc123.jpg');
  assert.equal(sanitizePageMediaUrl('https://alice.example/tryon/board-1.jpg'), 'https://alice.example/tryon/board-1.jpg');
  assert.equal(sanitizePageMediaUrl('/tmp/tryon-1.jpg'), null);
  assert.equal(sanitizePageMediaUrl('/Users/alice/data/tryon/tryon-1.jpg'), null);
  assert.equal(sanitizePageMediaUrl('file:///tmp/tryon-1.jpg'), null);
  assert.equal(sanitizePageMediaUrl('/tryon/../etc/passwd'), null);
  assert.equal(sanitizePageMediaUrl(null), null);

  const logs: RecordedLog[] = [];
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-real-media', log: () => {} });

  let resolveSlowTryOn!: (val: { url: string; path: string; ms: number; id: string }) => void;
  const slowTryOnGate = new Promise<{ url: string; path: string; ms: number; id: string }>((r) => {
    resolveSlowTryOn = r;
  });

  let sharedProductImagesCalls = 0;
  const sharedProductImages = async (_item: Item): Promise<string[]> => {
    sharedProductImagesCalls += 1;
    return [];
  };

  const tools = createAgentTools({
    room: 'r-real-media',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    deps: makeFakeDeps({
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 1) {
          return slowTryOnGate;
        }
        // Look 2 erroneously puts a local filesystem path in url -> must NEVER reach the page.
        return {
          url: '/tmp/secret/tryon-2.jpg',
          path: '/tmp/secret/tryon-2.jpg',
          ms: 20,
          id: 'bad-2',
        };
      },
      async outfitCollage(outfit) {
        // Look 1 collage degrades to null; Look 2 returns real relative /tryon/ URL.
        return outfit.number === 1 ? null : '/tryon/board-look-2-a1b2c3d4.jpg';
      },
      productImages: sharedProductImages,
      async loadStoreModule() {
        return { productImages: sharedProductImages };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();

  // Look 1 collage returned null -> no collageReady for look 1, logged ok:false; look 2 sent /tryon/ URL.
  const collageCalls = calls.filter((c) => c.action === 'collageReady');
  assert.equal(collageCalls.length, 1);
  assert.deepEqual(collageCalls[0]!.payload, {
    outfit: 2,
    url: '/tryon/board-look-2-a1b2c3d4.jpg',
  });
  const collageLogs = logs.filter((l) => l.ev === 'collage');
  assert.equal(collageLogs.find((l) => l.data?.outfit === 1)?.data?.ok, false);
  assert.equal(collageLogs.find((l) => l.data?.outfit === 2)?.data?.ok, true);

  // Look 2 had a filesystem path in url -> rejected, never sent via tryOnReady, marked failed.
  assert.equal(state.get().tryOn[2]?.status, 'failed');
  assert.equal(
    calls.some(
      (c) => c.action === 'tryOnReady' && (c.payload as PageActions['tryOnReady']).outfit === 2,
    ),
    false,
  );

  // Look 1 tryOn takes 25s -> show_on_me waits and reveals ONLY the /tryon/ url, never `path`.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  const showPromise = tools.show_on_me.execute({}, fakeToolOpts('s1'));
  await flushMicrotasks();
  await clock.advance(25_000);

  resolveSlowTryOn({
    url: '/tryon/tryon-real123.jpg',
    path: '/Users/alice/data/tryon/tryon-real123.jpg',
    ms: 25_000,
    id: 'real123',
  });
  const showRes = await showPromise;
  assert.match(showRes, /revealed on screen/i);

  const ready1 = calls.find(
    (c) => c.action === 'tryOnReady' && (c.payload as PageActions['tryOnReady']).outfit === 1,
  );
  assert.deepEqual(ready1?.payload, { outfit: 1, url: '/tryon/tryon-real123.jpg' });

  const reveal1 = calls.find((c) => c.action === 'reveal');
  assert.deepEqual(reveal1?.payload, { outfit: 1, url: '/tryon/tryon-real123.jpg' });

  // Verify no page payload anywhere contains a filesystem path.
  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes('/Users/alice/'), false);
  assert.equal(serializedCalls.includes('/tmp/secret/'), false);

  // show_product must not invoke store.productImages a second time when it is the same function.
  await tools.show_product.execute({ slot: 'top' }, fakeToolOpts('sp-dedupe'));
  assert.equal(sharedProductImagesCalls, 1);
});

test('add_to_bag partial result starts with PARTLY DONE, lists NOT ADDED first with reasons, then added pieces and total, then links and one instruction', async () => {
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-order', log: () => {} });

  const fivePieceOutfit: Outfit = {
    number: 1,
    name: 'Full Night Out',
    difference: 'Complete five-piece evening look.',
    story: 'Sharp head to toe.',
    pieces: [
      { slot: 'top', why: 'Clean base.', item: makeItem({ id: 'p1', variant_id: 'v1', title: 'Satin Shirt', price: 40, store: 'Fashion Nova', store_domain: 'fn.myshopify.com', sizes: ['S', 'M'] }) },
      { slot: 'bottom', why: 'Tailored drape.', item: makeItem({ id: 'p2', variant_id: 'v2', title: 'Wide-Leg Trouser', price: 50, store: 'Fashion Nova', store_domain: 'fn.myshopify.com', sizes: ['S', 'M'] }) },
      { slot: 'layer', why: 'Evening structure.', item: makeItem({ id: 'p3', variant_id: 'v3', title: 'Cropped Blazer', price: 65, store: 'Fashion Nova', store_domain: 'fn.myshopify.com', sizes: ['S', 'M'] }) },
      { slot: 'shoes', why: 'Adds height.', item: makeItem({ id: 'p4', variant_id: 'v4', title: 'Strappy Sandal', price: 45, store: 'Fashion Nova', store_domain: 'fn.myshopify.com', sizes: ['8', '9'] }) },
      { slot: 'bag', why: 'Finishes the look.', item: makeItem({ id: 'p5', variant_id: 'v5', title: 'Mini Clutch', price: 30, store: 'Fashion Nova', store_domain: 'fn.myshopify.com', sizes: [] }) },
    ],
    total: 230,
  };

  const tools = createAgentTools({
    room: 'r-bag-order',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        opts?.onOutfit?.(fivePieceOutfit, 0);
        return { outfits: [fivePieceOutfit], source: 'live', timing: { first_outfit_ms: 50, total_ms: 50 }, problems: [] };
      },
      async addToBag(): Promise<BagOut> {
        return {
          carts: [
            {
              store: 'Fashion Nova',
              store_domain: 'fn.myshopify.com',
              cart_id: 'cart-fn-1',
              continue_url: 'https://fashionnova.com/cart/abc',
              total_usd: 155,
              added: [
                { variant_id: 'v1', title: 'Satin Shirt', size: 'M' },
                { variant_id: 'v2', title: 'Wide-Leg Trouser', size: 'M' },
                { variant_id: 'v3', title: 'Cropped Blazer', size: 'M' },
              ],
              not_added: [
                { variant_id: 'v4', title: 'Strappy Sandal', reason: 'Size 8 is out of stock.' },
                { variant_id: 'v5', title: 'Mini Clutch', reason: 'Size could not be selected.' },
              ],
              ms: 60,
            },
          ],
          summary: '3 added, 2 not added.',
          total_usd: 155,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 250 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  const res = await tools.add_to_bag.execute(
    { sizes: { top: 'M', bottom: 'M', shoes: '8' } },
    fakeToolOpts('bag-ord-1'),
  );

  const partlyIdx = res.indexOf('PARTLY DONE: NOT ADDED (2):');
  const sandalIdx = res.indexOf('Strappy Sandal at Fashion Nova (Size 8 is out of stock)');
  const clutchIdx = res.indexOf('Mini Clutch at Fashion Nova (Size could not be selected)');
  const sayOnlyIdx = res.indexOf(
    'Say only these are in the bag: Satin Shirt, Wide-Leg Trouser, Cropped Blazer.',
  );
  const addedIdx = res.indexOf('Added 3 pieces, total $155');
  const linkIdx = res.indexOf('Checkout link is on the page (Fashion Nova)');

  assert.equal(partlyIdx, 0, `expected result to start with PARTLY DONE and NOT ADDED, got: ${res}`);
  assert.ok(sandalIdx > partlyIdx && clutchIdx > partlyIdx, 'each not-added piece and reason must be listed first');
  assert.ok(sayOnlyIdx > clutchIdx, 'Say only these are in the bag instruction must immediately follow NOT ADDED list');
  assert.ok(addedIdx > sayOnlyIdx, 'added pieces and total must follow Say only these are in the bag instruction');
  assert.ok(linkIdx > addedIdx, 'checkout link location must follow added pieces');
  assert.match(res, /say exactly which pieces are not in the bag/i);
  assert.match(res, /offer a swap or another size/i);
  assert.match(res, /never say a not-added piece is in the bag/i);
  assert.match(res, /never say the bag is processing/i);
  assert.match(res, /never pitch a different look/i);

  const summary = state.summarize();
  assert.match(summary, /NOT_ADDED=\[Strappy Sandal \(Size 8 is out of stock\); Mini Clutch \(Size could not be selected\)\]/);
});

test('show_on_me distinguishes camera-off stand-in model render from camera-on render', async () => {
  const { page } = createFakePage();
  const stateOff = createCallStateStore({ roomName: 'r-cam-off', log: () => {} });
  const toolsOff = createAgentTools({
    room: 'r-cam-off',
    log: () => {},
    getSnapshot: () => null,
    page,
    state: stateOff,
    deps: makeFakeDeps(),
  });

  await toolsOff.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await toolsOff.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await toolsOff.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  const resOff = await toolsOff.show_on_me.execute({}, fakeToolOpts('s-off'));
  assert.match(resOff, /on screen on a model/i);
  assert.match(resOff, /turning the camera on lets you show it on them/i);
  assert.match(resOff, /never say you cannot overlay it/i);

  // With a camera snapshot present, show_on_me reveals on the shopper without model-stand-in wording.
  const stateOn = createCallStateStore({ roomName: 'r-cam-on', log: () => {} });
  const snap: CameraSnapshot = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    at: 1_000,
  };
  const toolsOn = createAgentTools({
    room: 'r-cam-on',
    log: () => {},
    getSnapshot: () => snap,
    page,
    state: stateOn,
    deps: makeFakeDeps(),
  });

  await toolsOn.set_department.execute({ department: 'men' }, fakeToolOpts('d2'));
  await toolsOn.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b2'));
  await flushMicrotasks();
  await toolsOn.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p2'));

  const resOn = await toolsOn.show_on_me.execute({}, fakeToolOpts('s-on'));
  assert.match(resOn, /revealed on screen/i);
  assert.doesNotMatch(resOn, /on a model/i);
  assert.doesNotMatch(resOn, /camera is off/i);
});

test('build_outfits looks up weather when where and when are given, injects brief.weather, logs weather event, and skips otherwise', async () => {
  const logs: RecordedLog[] = [];
  const clock = createFakeClock(50_000);
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-weather', log: () => {} });

  const capturedBriefs: Brief[] = [];
  let capturedSwapBrief: Brief | null = null;
  const weatherCalls: Array<{ where: string; when?: string }> = [];
  const forecastLine = 'Saturday in Chicago: about 52°F in the evening, light rain, 60% chance of rain; high 58, low 46.';

  const tools = createAgentTools({
    room: 'r-weather',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    deps: makeFakeDeps({
      async loadWeatherModule() {
        return {
          async forecast(where, when) {
            weatherCalls.push({ where, when });
            await clock.advance(120);
            return { ok: true, line: forecastLine, ms: 120 };
          },
        };
      },
      async buildOutfits(brief, opts) {
        capturedBriefs.push(structuredClone(brief));
        return makeFakeDeps().buildOutfits!(brief, opts);
      },
      async swapPiece(outfit, slot, request, brief, opts) {
        capturedSwapBrief = structuredClone(brief);
        return makeFakeDeps().swapPiece!(outfit, slot, request, brief, opts);
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));

  // 1) Only `where` without `when` -> skips weather lookup.
  await tools.build_outfits.execute(
    { occasion: 'dinner', budget_usd: 200, where: 'Chicago' },
    fakeToolOpts('b-only-where'),
  );
  assert.equal(weatherCalls.length, 0);
  assert.equal(capturedBriefs[0]!.weather, undefined);
  assert.equal(logs.filter((l) => l.ev === 'weather').length, 0);

  // 2) Both `where` and `when` -> looks up weather, sets brief.weather, logs event, returns weather line.
  const res = await tools.build_outfits.execute(
    { occasion: 'rooftop party', budget_usd: 250, where: 'Chicago', when: 'Saturday' },
    fakeToolOpts('b-weather'),
  );
  assert.deepEqual(weatherCalls, [{ where: 'Chicago', when: 'Saturday' }]);
  assert.equal(capturedBriefs[1]!.weather, forecastLine);
  assert.match(res, /Weather.*Saturday in Chicago: about 52°F/);

  const weatherLogs = logs.filter((l) => l.ev === 'weather');
  assert.equal(weatherLogs.length, 1);
  assert.deepEqual(weatherLogs[0]!.data, {
    where: 'Chicago',
    when: 'Saturday',
    line: forecastLine,
    ms: 120,
  });

  // Subsequent swap_piece receives the brief with weather preserved.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await tools.swap_piece.execute({ slot: 'shoes', request: 'waterproof boots' }, fakeToolOpts('sw1'));
  assert.equal(capturedSwapBrief!.weather, forecastLine);
});

test('build_outfits caps weather lookup at 2.5s and never fails when weather import or forecast errors', async () => {
  // 1) Hanging forecast times out at 2500ms without delaying buildOutfits beyond that.
  const logsTimeout: RecordedLog[] = [];
  const clock = createFakeClock(100_000);
  const { page } = createFakePage();
  const stateTimeout = createCallStateStore({ roomName: 'r-w-timeout', log: () => {} });
  let timeoutBrief: Brief | null = null;
  let resolveHungForecast!: (v: { ok: boolean; line: string; ms: number }) => void;
  const hungForecast = new Promise<{ ok: boolean; line: string; ms: number }>((r) => {
    resolveHungForecast = r;
  });

  const toolsTimeout = createAgentTools({
    room: 'r-w-timeout',
    log: (room, ev, data) => logsTimeout.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state: stateTimeout,
    deps: makeFakeDeps({
      async loadWeatherModule() {
        return {
          async forecast() {
            return hungForecast;
          },
        };
      },
      async buildOutfits(brief, opts) {
        timeoutBrief = structuredClone(brief);
        return makeFakeDeps().buildOutfits!(brief, opts);
      },
    }),
  });

  await toolsTimeout.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  const buildPromise = toolsTimeout.build_outfits.execute(
    { occasion: 'wedding', budget_usd: 300, where: 'Miami', when: 'tomorrow' },
    fakeToolOpts('b-timeout'),
  );
  await flushMicrotasks();
  assert.equal(timeoutBrief, null, 'buildOutfits waits while within 2.5s weather cap');

  await clock.advance(2_499);
  assert.equal(timeoutBrief, null, 'weather cap must not fire before 2500ms');

  await clock.advance(1);
  const timeoutRes = await buildPromise;
  assert.match(timeoutRes, /Built 2 looks and they are now on screen/i);
  assert.equal(timeoutBrief!.weather, undefined);

  const timeoutLog = logsTimeout.find((l) => l.ev === 'weather');
  assert.ok(timeoutLog);
  assert.equal(timeoutLog!.data?.where, 'Miami');
  assert.equal(timeoutLog!.data?.when, 'tomorrow');
  assert.equal(timeoutLog!.data?.ms, 2_500);
  assert.match(String(timeoutLog!.data?.error), /timeout/i);

  // Resolving the hung promise later must not throw or log a second weather event.
  resolveHungForecast({ ok: true, line: 'late line', ms: 5000 });
  await flushMicrotasks();
  assert.equal(logsTimeout.filter((l) => l.ev === 'weather').length, 1);

  // 2) Dynamic import failure never breaks build_outfits and logs error.
  const logsImportErr: RecordedLog[] = [];
  const stateErr = createCallStateStore({ roomName: 'r-w-err', log: () => {} });
  let errBrief: Brief | null = null;

  const toolsImportErr = createAgentTools({
    room: 'r-w-err',
    log: (room, ev, data) => logsImportErr.push({ room, ev, data }),
    page,
    state: stateErr,
    deps: makeFakeDeps({
      async loadWeatherModule() {
        throw new Error('weather module failed to load');
      },
      async buildOutfits(brief, opts) {
        errBrief = structuredClone(brief);
        return makeFakeDeps().buildOutfits!(brief, opts);
      },
    }),
  });

  await toolsImportErr.set_department.execute({ department: 'women' }, fakeToolOpts('d2'));
  const errRes = await toolsImportErr.build_outfits.execute(
    { occasion: 'brunch', budget_usd: 150, where: 'Austin', when: 'Sunday' },
    fakeToolOpts('b-err'),
  );
  assert.match(errRes, /Built 2 looks and they are now on screen/i);
  assert.equal(errBrief!.weather, undefined);

  const errLog = logsImportErr.find((l) => l.ev === 'weather');
  assert.ok(errLog);
  assert.equal(errLog!.data?.where, 'Austin');
  assert.equal(errLog!.data?.when, 'Sunday');
  assert.equal(typeof errLog!.data?.ms, 'number');
  assert.match(String(errLog!.data?.error), /weather module failed to load/);
});

test('show_on_me size prompt adapts to flow state: none known, partial known, and all known', async () => {
  const { page } = createFakePage();
  const snap: CameraSnapshot = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    at: 1_000,
  };

  // 1) No sizes known yet for Look 1 (top, bottom, shoes) -> asks for top, bottom, and shoe sizes.
  const clock = createFakeClock();
  const stateNone = createCallStateStore({ roomName: 'r-sz-none', log: () => {} });
  const toolsNone = createAgentTools({
    room: 'r-sz-none',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    getSnapshot: () => snap,
    page,
    state: stateNone,
    deps: makeFakeDeps(),
  });
  await toolsNone.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await toolsNone.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await toolsNone.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  const resNone = await toolsNone.show_on_me.execute({}, fakeToolOpts('s-none'));
  assert.match(resNone, /ask for their top, bottom, and shoe sizes in one question/i);

  // 2) Partial sizes known (top only) -> asks only for missing bottom and shoe sizes.
  await clock.advance(DUPLICATE_WINDOW_MS + 1_000);
  stateNone.dispatch({ type: 'merge_sizes', sizes: { top: 'medium' } });
  const resPartial = await toolsNone.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s-partial'));
  assert.match(resPartial, /already have top medium/i);
  assert.match(resPartial, /ask only for their bottom and shoe sizes in one question/i);
  assert.doesNotMatch(resPartial, /ask.*top.*bottom.*shoe/i);

  // 3) All sizes known for Look 1 -> offers to bag in known sizes without asking again.
  await clock.advance(DUPLICATE_WINDOW_MS + 1_000);
  stateNone.dispatch({ type: 'merge_sizes', sizes: { bottom: '30x34', shoes: '8.5 wide' } });
  const resAll = await toolsNone.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s-all'));
  assert.match(resAll, /already have all sizes needed/i);
  assert.match(resAll, /top medium, bottom 30x34, shoes 8\.5 wide/);
  assert.match(resAll, /do not ask for sizes again/i);
  assert.match(resAll, /offer to add it to their bag/i);

  // 4) Look 2 only has top and shoes -> all needed sizes known even without bottom, and works with camera off.
  const stateLook2 = createCallStateStore({ roomName: 'r-sz-l2', log: () => {} });
  stateLook2.dispatch({ type: 'merge_sizes', sizes: { top: 'M', shoes: '10' } });
  const toolsLook2 = createAgentTools({
    room: 'r-sz-l2',
    log: () => {},
    getSnapshot: () => null,
    page,
    state: stateLook2,
    deps: makeFakeDeps(),
  });
  await toolsLook2.set_department.execute({ department: 'men' }, fakeToolOpts('d2'));
  await toolsLook2.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b2'));
  await flushMicrotasks();
  await toolsLook2.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p2'));

  const resLook2 = await toolsLook2.show_on_me.execute({}, fakeToolOpts('s-l2'));
  assert.match(resLook2, /on screen on a model/i);
  assert.match(resLook2, /already have all sizes needed.*top M, shoes 10/i);
  assert.match(resLook2, /do not ask for sizes again/i);
});

test('add_to_bag schema allows exact sizes and explicit corrections replace earlier noisy sizes', async () => {
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-sz-corr', log: () => {} });
  let clockNow = 1_000;
  const receivedSizes: Array<Record<string, string>> = [];

  const tools = createAgentTools({
    room: 'r-sz-corr',
    log: () => {},
    now: () => clockNow,
    page,
    state,
    deps: makeFakeDeps({
      async addToBag(_outfit, sizes): Promise<BagOut> {
        receivedSizes.push({ ...sizes });
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-${receivedSizes.length}`,
              continue_url: `https://everlane.com/cart/${receivedSizes.length}`,
              total_usd: 160,
              added: [
                { variant_id: 'var-top-m', title: 'Merino Knit Polo - Espresso', size: sizes.top ?? null },
                { variant_id: 'var-bottom-1', title: 'Pleated Wool Trouser - Charcoal', size: sizes.bottom ?? null },
                { variant_id: 'var-shoes-1', title: 'Minimal Leather Sneaker - White', size: sizes.shoes ?? null },
              ],
              not_added: [],
              ms: 25,
            },
          ],
          summary: 'Added 3 items.',
          total_usd: 160,
        };
      },
    }),
  });

  // Schema description explicitly permits half sizes, widths, and waist x inseam.
  const sizesField = (tools.add_to_bag.parameters as unknown as { shape: Record<string, { description?: string }> }).shape.sizes;
  assert.ok(sizesField?.description);
  assert.match(sizesField!.description!, /half sizes/i);
  assert.match(sizesField!.description!, /8\.5 wide/i);
  assert.match(sizesField!.description!, /30x34/i);

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // First call with noisy room sizes.
  const first = await tools.add_to_bag.execute(
    { sizes: { top: 'L', bottom: '36', shoes: '12' } },
    fakeToolOpts('bag-c1'),
  );
  assert.match(first, /^Added 3 pieces, total \$160/);
  assert.doesNotMatch(first, /^PARTLY DONE:/);
  assert.deepEqual(state.get().sizes, { top: 'L', bottom: '36', shoes: '12' });

  // Shopper explicitly corrects all three slots with exact values -> replaces remembered sizes and re-bags.
  const second = await tools.add_to_bag.execute(
    { sizes: { top: 'medium', bottom: '30x34', shoes: '8.5 wide' } },
    fakeToolOpts('bag-c2'),
  );
  assert.equal(receivedSizes.length, 2);
  assert.equal(receivedSizes[1]!.top, 'medium');
  assert.equal(receivedSizes[1]!.bottom, '30x34');
  assert.equal(receivedSizes[1]!.shoes, '8.5 wide');
  assert.deepEqual(state.get().sizes, { top: 'medium', bottom: '30x34', shoes: '8.5 wide' });
  assert.match(second, /size medium/);
  assert.match(second, /size 30x34/);
  assert.match(second, /size 8\.5 wide/);

  // Clean full-bag dedupe after duplicate window still returns "Already in the bag.".
  clockNow += DUPLICATE_WINDOW_MS + 1_000;
  const dedupedClean = await tools.add_to_bag.execute(
    { sizes: { top: 'medium', bottom: '30x34', shoes: '8.5 wide' } },
    fakeToolOpts('bag-c3'),
  );
  assert.equal(receivedSizes.length, 2);
  assert.match(dedupedClean, /^Already in the bag\./);
});

test('show_on_me and add_to_bag never ask for jacket, belt, or accessory sizes and log inferred sizes', async () => {
  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-infer', log: () => {} });
  const receivedSizes: Array<Record<string, string>> = [];

  const layeredOutfit: Outfit = {
    number: 1,
    name: 'SoHo Evening',
    difference: 'Jacket, trouser, belt, and cap.',
    story: 'Sharp city look.',
    total: 290,
    pieces: [
      {
        slot: 'top',
        why: 'Clean base.',
        item: makeItem({ id: 'i-top', variant_id: 'v-top', title: 'Heavyweight Tee', price: 40, sizes: ['S', 'M', 'L'] }),
      },
      {
        slot: 'bottom',
        why: 'Tailored drape.',
        item: makeItem({ id: 'i-bot', variant_id: 'v-bot', title: 'Relaxed Chino', price: 65, sizes: ['30', '32', '34'] }),
      },
      {
        slot: 'layer',
        why: 'Structure.',
        item: makeItem({ id: 'i-lay', variant_id: 'v-lay', title: 'Suede Overshirt Jacket', price: 95, sizes: ['S', 'M', 'L'] }),
      },
      {
        slot: 'shoes',
        why: 'Finishes the stance.',
        item: makeItem({ id: 'i-sho', variant_id: 'v-sho', title: 'Suede Derby', price: 50, sizes: ['9', '10', '11'] }),
      },
      {
        slot: 'accessory',
        why: 'Pulls waist together.',
        item: makeItem({ id: 'i-belt', variant_id: 'v-belt', title: 'Italian Leather Belt', price: 25, sizes: ['30', '32', '34', '36'] }),
      },
      {
        slot: 'bag',
        why: 'Everyday carry.',
        item: makeItem({ id: 'i-bag', variant_id: 'v-bag', title: 'Nylon Crossbody Bag', price: 15, sizes: ['Small', 'Medium', 'Large'] }),
      },
    ],
  };

  const tools = createAgentTools({
    room: 'r-infer',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        opts?.onOutfit?.(layeredOutfit, 0);
        return {
          outfits: [layeredOutfit],
          source: 'live',
          timing: { first_outfit_ms: 40, total_ms: 40 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        receivedSizes.push({ ...sizes });
        const total = bagOutfit.pieces.reduce((s, p) => s + p.item.price, 0);
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-infer-${receivedSizes.length}`,
              continue_url: `https://everlane.com/cart/infer-${receivedSizes.length}`,
              total_usd: total,
              added: bagOutfit.pieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? null,
              })),
              not_added: [],
              ms: 30,
            },
          ],
          summary: `Added ${bagOutfit.pieces.length} items.`,
          total_usd: total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 350 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // 1) show_on_me asks ONLY for top, bottom, and shoe sizes (never jacket/layer/belt/accessory/bag).
  const showRes = await tools.show_on_me.execute({}, fakeToolOpts('s1'));
  assert.match(showRes, /top, bottom, and shoe sizes/i);
  assert.doesNotMatch(showRes, /jacket|layer|belt|accessory|bag size/i);

  // 2) add_to_bag with zero sizes -> reports ONLY top, bottom, shoes missing (never layer/accessory/belt/bag).
  const notDone = await tools.add_to_bag.execute({ sizes: {} }, fakeToolOpts('bag-0'));
  assert.equal(notDone.startsWith('NOT DONE:'), true);
  assert.match(notDone, /Still need sizes for: top, bottom, shoes\./);
  assert.doesNotMatch(notDone, /\b(?:layer|jacket|belt|accessory|bag)\b/i);

  // 3) add_to_bag with only top -> bags top + inferred layer + bag right away, reports bottom/shoes/belt as NOT ADDED.
  const partialTop = await tools.add_to_bag.execute({ sizes: { top: 'M' } }, fakeToolOpts('bag-1'));
  assert.equal(partialTop.startsWith('PARTLY DONE:'), true);
  assert.match(partialTop, /Added 3 pieces, total \$150/);
  assert.match(partialTop, /Relaxed Chino at Everlane \(no bottom size given/);
  assert.match(partialTop, /Suede Derby at Everlane \(no shoes size given/);

  // 4) add_to_bag with bottom + shoes -> infers layer=M, accessory(belt)=32, bag=Medium, logs inferred, adds note!
  const done = await tools.add_to_bag.execute(
    { sizes: { bottom: '32', shoes: '10' } },
    fakeToolOpts('bag-2'),
  );
  assert.equal(receivedSizes.length, 2);
  const fullSizes = receivedSizes[1]!;
  assert.equal(fullSizes.top, 'M');
  assert.equal(fullSizes.bottom, '32');
  assert.equal(fullSizes.shoes, '10');
  assert.equal(fullSizes.layer, 'M');
  assert.equal(fullSizes.accessory, '32');
  assert.equal(fullSizes.bag, 'Medium');
  assert.match(done, /matched the jacket to their top size and the belt to their waist/i);

  // Inferred sizes must be logged in the bag event, without polluting state.sizes.
  const bagLog = logs.filter((l) => l.ev === 'bag').at(-1);
  assert.ok(bagLog);
  assert.deepEqual(bagLog!.data?.inferred, { layer: 'M', belt: '32', bag: 'Medium' });
  assert.deepEqual(state.get().sizes, { top: 'M', bottom: '32', shoes: '10' });
});

test('add_to_bag auto-infers multi-size belt or accessory discovered by store when Item.sizes was empty', async () => {
  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-store-infer', log: () => {} });
  let storeCalls = 0;

  const outfit: Outfit = {
    number: 1,
    name: 'City Crisp',
    difference: 'Clean trouser look with belt and cuff.',
    story: 'Effortless.',
    total: 180,
    pieces: [
      { slot: 'top', why: 'Base.', item: makeItem({ id: 't1', variant_id: 'vt', title: 'Cotton Polo', price: 60, sizes: ['S', 'M', 'L'] }) },
      { slot: 'bottom', why: 'Leg.', item: makeItem({ id: 'b1', variant_id: 'vb', title: 'Tailored Pant', price: 80, sizes: ['30', '32', '34'] }) },
      { slot: 'accessory', why: 'Finish.', item: makeItem({ id: 'a1', variant_id: 'va', title: 'Woven Belt', price: 40, sizes: [] }) },
    ],
  };

  const tools = createAgentTools({
    room: 'r-store-infer',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        opts?.onOutfit?.(outfit, 0);
        return { outfits: [outfit], source: 'live', timing: { first_outfit_ms: 20, total_ms: 20 }, problems: [] };
      },
      async addToBag(_outfit, sizes): Promise<BagOut> {
        storeCalls++;
        // First call: store has S/M/L on the belt (Item.sizes was empty) and refuses raw "32" or missing accessory.
        if (storeCalls === 1) {
          return {
            carts: [
              {
                store: 'Everlane',
                store_domain: 'everlane.myshopify.com',
                cart_id: null,
                continue_url: null,
                total_usd: null,
                added: [],
                not_added: [
                  {
                    variant_id: 'va',
                    title: 'Woven Belt',
                    slot: 'accessory',
                    reason: 'no accessory size given (sizes: S, M, L)',
                  } as BagLineNotAdded,
                ],
                ms: 10,
              },
            ],
            summary: 'NOT DONE: Woven Belt (accessory) still need a size.',
            total_usd: 0,
          };
        }
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: 'cart-si-1',
              continue_url: 'https://everlane.com/cart/si-1',
              total_usd: 180,
              added: [
                { variant_id: 'vt', title: 'Cotton Polo', size: sizes.top },
                { variant_id: 'vb', title: 'Tailored Pant', size: sizes.bottom },
                { variant_id: 'va', title: 'Woven Belt', size: sizes.accessory },
              ],
              not_added: [],
              ms: 15,
            },
          ],
          summary: 'Added 3 items.',
          total_usd: 180,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 250 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  const res = await tools.add_to_bag.execute(
    { sizes: { top: 'M', bottom: '32' } },
    fakeToolOpts('bag-si-1'),
  );
  assert.equal(storeCalls, 2);
  assert.match(res, /^Added 3 pieces, total \$180/);
  assert.match(res, /Woven Belt \(size M\)/);
  assert.match(res, /matched the belt to their waist/i);
  const bagLog = logs.find((l) => l.ev === 'bag');
  assert.deepEqual(bagLog?.data?.inferred, { belt: 'M' });
});

test('add_to_bag recovers omitted sizes from recent shopper turns and logs size_mismatch without overriding', async () => {
  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-speech-net', log: () => {} });
  const receivedSizes: Array<Record<string, string>> = [];

  const tools = createAgentTools({
    room: 'r-speech-net',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async addToBag(_outfit, sizes): Promise<BagOut> {
        receivedSizes.push({ ...sizes });
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: 'cart-net-1',
              continue_url: 'https://everlane.com/cart/net-1',
              total_usd: 160,
              added: [
                { variant_id: 'var-top-m', title: 'Merino Knit Polo - Espresso', size: sizes.top },
                { variant_id: 'var-bottom-1', title: 'Pleated Wool Trouser - Charcoal', size: sizes.bottom },
                { variant_id: 'var-shoes-1', title: 'Minimal Leather Sneaker - White', size: sizes.shoes },
              ],
              not_added: [],
              ms: 20,
            },
          ],
          summary: 'Added 3 items.',
          total_usd: 160,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 250 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // Exact real-call failure: shopper typed all 3 sizes, model only passed top and bottom!
  state.recordShopperTurn('Medium top, 32 waist, shoes 10 and a half.', 'typed-1');

  const res = await tools.add_to_bag.execute(
    { sizes: { top: 'medium', bottom: '32' } },
    fakeToolOpts('bag-net-1'),
  );
  assert.match(res, /^Added 3 pieces, total \$160/);
  assert.equal(receivedSizes.length, 1);
  assert.equal(receivedSizes[0]!.top, 'medium');
  assert.equal(receivedSizes[0]!.bottom, '32');
  assert.equal(receivedSizes[0]!.shoes, '10.5');
  assert.equal(state.get().sizes.shoes, '10.5');
  // Equivalent spellings ("medium" vs "M", "32" vs "32") must NOT log size_mismatch.
  assert.equal(logs.filter((l) => l.ev === 'size_mismatch').length, 0);

  // If model passes a size differing from what the most recent shopper turn states,
  // do NOT override the model's value, but log size_mismatch with both values.
  state.recordShopperTurn('Actually 30 by 34 pants and large top.', 'typed-2');
  await tools.add_to_bag.execute(
    { sizes: { top: 'S', bottom: '30x34', shoes: '10.5' } },
    fakeToolOpts('bag-net-2'),
  );
  assert.equal(receivedSizes.length, 2);
  assert.equal(receivedSizes[1]!.top, 'S', 'model value must NOT be overridden on mismatch');
  assert.equal(receivedSizes[1]!.bottom, '30x34');

  const mismatches = logs.filter((l) => l.ev === 'size_mismatch');
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0]!.data, {
    slot: 'top',
    model: 'S',
    shopper: 'L',
  });
});

test('createAgentTools invokes onToolResult callback when build_outfits, show_on_me, and add_to_bag finish', async () => {
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-onresult', log: () => {} });
  const results: Array<{ name: string; callId: string; text: string }> = [];

  const tools = createAgentTools({
    room: 'r-onresult',
    log: () => {},
    page,
    state,
    onToolResult: (ev) => results.push(ev),
    deps: makeFakeDeps(),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'date', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await tools.show_on_me.execute({}, fakeToolOpts('s1'));
  await tools.add_to_bag.execute({ sizes: { top: 'M', shoes: '10' } }, fakeToolOpts('bag1'));

  const names = results.map((r) => r.name);
  assert.ok(names.includes('build_outfits'));
  assert.ok(names.includes('show_on_me'));
  assert.ok(names.includes('add_to_bag'));
  assert.equal(results.find((r) => r.name === 'build_outfits')?.callId, 'b1');
});

test('build_outfits enforces single active build: skips same-brief passing remark and supersedes on materially different brief', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-single-build', log: () => {} });
  let clockNow = 1_000;
  let buildInvocations = 0;

  // Deferred controls for Run 1 (still running 16s later when shopper says "I prefer classic").
  let finishRun1!: () => void;
  let emitRun1Look2!: () => void;
  const run1Gate = new Promise<void>((r) => {
    finishRun1 = r;
  });

  // Deferred controls for Run 2 (materially different brief: different occasion/budget).
  let finishRun2!: () => void;
  const run2Gate = new Promise<void>((r) => {
    finishRun2 = r;
  });

  const setA = makeSampleOutfits();
  const setB: Outfit[] = [
    {
      number: 1,
      name: 'Beach Linen',
      difference: 'Airy linen shirt and espadrilles.',
      story: 'Breezy coastal look.',
      pieces: [
        { slot: 'top', why: 'Cool linen.', item: makeItem({ id: 'b-top', variant_id: 'vb-top', title: 'Linen Camp Shirt', price: 85 }) },
        { slot: 'shoes', why: 'Easy slip-on.', item: makeItem({ id: 'b-sho', variant_id: 'vb-sho', title: 'Canvas Espadrille', price: 65 }) },
      ],
      total: 150,
    },
  ];

  const tools = createAgentTools({
    room: 'r-single-build',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => clockNow,
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(brief, opts): Promise<BuildResult> {
        buildInvocations += 1;
        const idx = buildInvocations;
        if (idx === 1) {
          opts?.onOutfit?.(structuredClone(setA[0]!), 0);
          emitRun1Look2 = () => opts?.onOutfit?.(structuredClone(setA[1]!), 1);
          await run1Gate;
          return { outfits: structuredClone(setA), source: 'live', timing: { first_outfit_ms: 200, total_ms: 18_000 }, problems: [] };
        }
        if (idx === 2) {
          opts?.onOutfit?.(structuredClone(setA[0]!), 0);
          emitRun1Look2 = () => opts?.onOutfit?.(structuredClone(setA[1]!), 1);
          await run2Gate;
          return { outfits: structuredClone(setA), source: 'live', timing: { first_outfit_ms: 200, total_ms: 18_000 }, problems: [] };
        }
        opts?.onOutfit?.(structuredClone(setB[0]!), 0);
        return { outfits: structuredClone(setB), source: 'live', timing: { first_outfit_ms: 150, total_ms: 200 }, problems: [] };
      },
    }),
  });

  // Tool description documents single-build and passing-remark rules.
  assert.match(tools.build_outfits.description, /only one build may run at a time/i);
  assert.match(tools.build_outfits.description, /once looks are on screen/i);
  assert.match(tools.build_outfits.description, /swap_piece/i);

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));

  // 1) Start Run 1, advance 16s (past 15s dedupe window!), call again with "I prefer classic" notes.
  const run1Promise = tools.build_outfits.execute(
    { occasion: 'wedding', budget_usd: 300 },
    fakeToolOpts('b-run1'),
  );
  await flushMicrotasks();
  assert.equal(buildInvocations, 1);

  clockNow += 16_000;
  const skippedRes = await tools.build_outfits.execute(
    { occasion: 'wedding', budget_usd: 300, notes: 'I prefer classic' },
    fakeToolOpts('b-classic'),
  );
  assert.equal(buildInvocations, 1, 'must NOT start a second build while first is running for same occasion/budget');
  assert.match(skippedRes, /already on their way/i);
  assert.match(skippedRes, /I prefer classic/);

  const skipLog = logs.find((l) => l.ev === 'build_skipped' && l.data?.reason === 'build_in_progress');
  assert.ok(skipLog, 'must log build_skipped with reason build_in_progress');

  // Finish Run 1 -> page received only Run 1's two looks.
  emitRun1Look2();
  finishRun1();
  const run1Res = await run1Promise;
  assert.match(run1Res, /Built 2 looks and they are now on screen/i);
  assert.equal(calls.filter((c) => c.action === 'showOutfits').length, 2);

  // 2) Now test superseding: start a build for "wedding" ($300), then call with materially different
  //    occasion ("beach party", $200) before it finishes -> first run's remaining output is ignored!
  calls.length = 0;
  const oldRunPromise = tools.build_outfits.execute(
    { occasion: 'wedding', budget_usd: 300 },
    fakeToolOpts('b-old'),
  );
  await flushMicrotasks();
  assert.equal(buildInvocations, 2);

  const newRunRes = await tools.build_outfits.execute(
    { occasion: 'beach party', budget_usd: 200 },
    fakeToolOpts('b-new'),
  );
  assert.equal(buildInvocations, 3);
  assert.match(newRunRes, /Beach Linen/);

  // Late look + completion from superseded build must be ignored completely!
  const showsBeforeLate = calls.filter((c) => c.action === 'showOutfits').length;
  emitRun1Look2();
  finishRun2();
  const oldRunRes = await oldRunPromise;
  assert.match(oldRunRes, /superseded/i);
  assert.equal(
    calls.filter((c) => c.action === 'showOutfits').length,
    showsBeforeLate,
    'superseded build must NOT emit remaining looks to the page',
  );
  assert.deepEqual(
    state.get().looks.map((l) => l.name),
    ['Beach Linen'],
  );

  const supersedeLog = logs.find((l) => l.ev === 'build_skipped' && l.data?.reason === 'superseded_by_new_brief');
  assert.ok(supersedeLog, 'must log build_skipped when a build is superseded');
});

test('set_department returns bare factual confirmation and other tool results avoid duplicating prompt-arc questions', async () => {
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-norepeat', log: () => {} });

  const tools = createAgentTools({
    room: 'r-norepeat',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps(),
  });

  const deptRes = await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  assert.equal(deptRes, 'Department set to men.');
  assert.doesNotMatch(deptRes, /ask occasion and budget/i);

  const buildRes = await tools.build_outfits.execute(
    { occasion: 'dinner', budget_usd: 250 },
    fakeToolOpts('b1'),
  );
  assert.match(buildRes, /Built 2 looks and they are now on screen\./);
  assert.doesNotMatch(buildRes, /ask which catches their eye/i);

  const pickRes = await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.match(pickRes, /HERO \(top\):/);
  assert.match(pickRes, /HERO \(shoes\):/);
  assert.match(pickRes, /ask about seeing it on them/i);

  const swapRes = await tools.swap_piece.execute(
    { slot: 'shoes', request: 'loafers' },
    fakeToolOpts('sw1'),
  );
  assert.doesNotMatch(swapRes, /Name only the replacement piece/i);
});

test('selectHeroPieces and extractHeroFact choose layer/dress/top + shoes/priciest and pull facts strictly from item data or why', async () => {
  // 1) Layer + shoes wins over top/bottom/accessory.
  const layerPiece = {
    slot: 'layer',
    why: 'Sharpens the shoulder line.',
    item: makeItem({
      id: 'l1',
      title: 'Structured Wool Blazer',
      price: 180,
      description: 'Machine wash cold. Double-breasted Italian wool-blend twill with peak lapels.',
    }),
  };
  const topPiece = {
    slot: 'top',
    why: 'Clean base layer.',
    item: makeItem({ id: 't1', title: 'Cotton Tee', price: 30, description: '100% organic cotton jersey.' }),
  };
  const bottomPiece = {
    slot: 'bottom',
    why: 'Relaxed leg.',
    item: makeItem({ id: 'b1', title: 'Tailored Trouser', price: 95, description: '' }),
  };
  const shoesPiece = {
    slot: 'shoes',
    why: 'Polished leather finish.',
    item: makeItem({ id: 's1', title: 'Penny Loafer', price: 110, description: '' }),
  };
  const bagPiece = {
    slot: 'bag',
    why: 'Holds essentials.',
    item: makeItem({ id: 'a1', title: 'Structured Leather Tote', price: 220, description: 'Pebbled calfskin tote with magnetic clasp.' }),
  };

  const withLayerAndShoes = selectHeroPieces([topPiece, bottomPiece, layerPiece, shoesPiece, bagPiece]);
  assert.deepEqual(withLayerAndShoes.map((p) => p.slot), ['layer', 'shoes']);

  // Fact skips boilerplate ("Machine wash cold") and grabs the real fabric/cut sentence.
  assert.equal(
    extractHeroFact(layerPiece),
    'Double-breasted Italian wool-blend twill with peak lapels',
  );
  // Empty description falls back to stylist note (`why`).
  assert.equal(extractHeroFact(shoesPiece), 'Polished leather finish');

  // 2) Dress + most expensive remaining piece when shoes are absent.
  const dressPiece = {
    slot: 'dress',
    why: 'Bias cut catches the light.',
    item: makeItem({
      id: 'd1',
      title: 'Satin Slip Dress',
      price: 150,
      description: 'Bias-cut hammered satin with adjustable spaghetti straps.',
    }),
  };
  const dressLookHeroes = selectHeroPieces([dressPiece, bottomPiece, bagPiece]);
  assert.deepEqual(dressLookHeroes.map((p) => p.slot), ['dress', 'bag']);
  assert.equal(
    extractHeroFact(dressPiece),
    'Bias-cut hammered satin with adjustable spaghetti straps',
  );
  assert.equal(
    extractHeroFact(bagPiece),
    'Pebbled calfskin tote with magnetic clasp',
  );

  // 3) No layer or dress, no shoes -> top + most expensive remaining piece.
  const topNoShoes = selectHeroPieces([topPiece, bottomPiece, bagPiece]);
  assert.deepEqual(topNoShoes.map((p) => p.slot), ['top', 'bag']);

  // 4) Single-piece look -> single hero piece.
  const singleHero = selectHeroPieces([dressPiece]);
  assert.deepEqual(singleHero.map((p) => p.slot), ['dress']);
});

test('onCritique wires background critic into call state, logs critique_seen, never blocks build_outfits, and surfaces swap offer on pick_outfit without mentioning scores or critic', async () => {
  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-critic', log: () => {} });
  let capturedOnCritique: ((number: number, critique: Critique) => void) | undefined;

  const tools = createAgentTools({
    room: 'r-critic',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(brief, opts) {
        capturedOnCritique = opts?.onCritique;
        // Return immediately without firing onCritique yet (critic runs in background after build_outfits returns).
        return makeFakeDeps().buildOutfits!(brief, opts);
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  const buildRes = await tools.build_outfits.execute(
    { occasion: 'bank interview', budget_usd: 300 },
    fakeToolOpts('b1'),
  );
  assert.match(buildRes, /Built 2 looks and they are now on screen/);
  assert.equal(typeof capturedOnCritique, 'function', 'buildOutfits must receive onCritique callback');

  // Fire critiques asynchronously in the background after build_outfits has already returned.
  capturedOnCritique!(1, {
    score: 5,
    presentable: false,
    occasion_fit: 5,
    cohesion: 6,
    completeness: 7,
    issues: ['sneakers too casual for a bank interview'],
    weak_piece: {
      slot: 'shoes',
      reason: 'sneakers are too casual for a bank interview',
      ask: 'black leather oxford shoes',
    },
    model: 'gemini-4-argon',
    ms: 1200,
  });

  capturedOnCritique!(2, {
    score: 8,
    presentable: true,
    occasion_fit: 8,
    cohesion: 8,
    completeness: 8,
    issues: [],
    weak_piece: null,
    model: 'gemini-4-argon',
    ms: 1100,
  });

  // Both logged via critique_seen and stored in state.
  const critLogs = logs.filter((l) => l.ev === 'critique_seen');
  assert.equal(critLogs.length, 2);
  assert.equal(critLogs[0]!.data?.outfit, 1);
  assert.equal(critLogs[0]!.data?.score, 5);
  assert.equal(critLogs[0]!.data?.presentable, false);
  assert.equal(state.get().critiques[1]?.score, 5);
  assert.equal(state.get().critiques[2]?.score, 8);

  // CALL STATE includes swap_hint for Look 1 only, never mentioning scores or critic.
  const summary = state.summarize();
  assert.match(summary, /#1 Skyline Knit.*swap_hint=shoes.*black leather oxford shoes/);
  assert.doesNotMatch(summary, /#2 Warm Neutrals.*swap_hint/);
  assert.doesNotMatch(summary, /\bscore\b|\bcritic\b/i);

  // Picking Look 1 includes one short swap offer note without mentioning scores or critic.
  const pick1 = await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.match(pick1, /Stylist note: the shoes is the weakest piece.*black leather oxford shoes/i);
  assert.doesNotMatch(pick1, /\bscore\b|\bcritic\b/i);

  // Picking Look 2 (passing critique) has NO Stylist note.
  const pick2 = await tools.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p2'));
  assert.doesNotMatch(pick2, /Stylist note:/i);

  // Swapping shoes in Look 1 clears its critique and ignores any late pre-swap critique.
  await tools.swap_piece.execute({ outfit: 1, slot: 'shoes', request: 'black leather oxfords' }, fakeToolOpts('sw1'));
  assert.equal(state.get().critiques[1], undefined);
  capturedOnCritique!(1, {
    score: 4,
    presentable: false,
    occasion_fit: 4,
    cohesion: 4,
    completeness: 7,
    issues: ['stale issue'],
    weak_piece: { slot: 'shoes', reason: 'stale', ask: 'stale' },
    model: 'gemini-4-argon',
    ms: 2000,
  });
  assert.equal(state.get().critiques[1], undefined, 'stale pre-swap critique must be ignored');
});

test('add_to_bag enforces $10,000 running bag ceiling across the call without double-counting size corrections', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-cap', log: () => {} });
  let storeAddCalls = 0;
  let livePriceOverride: number | null = null;

  const luxuryOutfits: Outfit[] = [
    {
      number: 1,
      name: 'Couture One',
      difference: 'First luxury look.',
      story: 'Statement.',
      pieces: [
        { slot: 'top', why: 'Cashmere.', item: makeItem({ id: 'lux-1', variant_id: 'vl1', title: 'Cashmere Jacket', price: 6_000, sizes: ['M', 'L'] }) },
      ],
      total: 6_000,
    },
    {
      number: 2,
      name: 'Couture Two',
      difference: 'Second luxury look.',
      story: 'Evening.',
      pieces: [
        { slot: 'top', why: 'Silk.', item: makeItem({ id: 'lux-2', variant_id: 'vl2', title: 'Silk Gown', price: 4_500, sizes: ['M', 'L'] }) },
      ],
      total: 4_500,
    },
    {
      number: 3,
      name: 'Over-Cap Solo',
      difference: 'Single over-cap look.',
      story: 'Ultra luxury.',
      pieces: [
        { slot: 'top', why: 'Haute.', item: makeItem({ id: 'lux-3', variant_id: 'vl3', title: 'Diamond Coat', price: 11_000, sizes: ['M', 'L'] }) },
      ],
      total: 11_000,
    },
  ];

  const tools = createAgentTools({
    room: 'r-bag-cap',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        luxuryOutfits.forEach((o, i) => opts?.onOutfit?.(structuredClone(o), i));
        return { outfits: structuredClone(luxuryOutfits), source: 'live', timing: { first_outfit_ms: 10, total_ms: 20 }, problems: [] };
      },
      async addToBag(outfit, sizes): Promise<BagOut> {
        storeAddCalls += 1;
        const total = livePriceOverride ?? outfit.total;
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-${storeAddCalls}`,
              continue_url: `https://everlane.com/cart/${storeAddCalls}`,
              total_usd: total,
              added: outfit.pieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? 'M',
              })),
              not_added: [],
              ms: 10,
            },
          ],
          summary: `Added 1 item, $${total}.`,
          total_usd: total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'gala', budget_usd: 25_000 }, fakeToolOpts('b1'));
  calls.length = 0;

  // 1) Single look over $10,000 returns NOT DONE without calling addToBag or sending bagReady.
  const soloOver = await tools.add_to_bag.execute(
    { outfit: 3, sizes: { top: 'M' } },
    fakeToolOpts('bag-solo-over'),
  );
  assert.equal(soloOver.startsWith('NOT DONE:'), true);
  assert.match(soloOver, /\$10,000|\$10000/);
  assert.equal(storeAddCalls, 0);
  assert.equal(calls.some((c) => c.action === 'bagReady'), false);

  // 2) Bag Look 1 ($6,000) -> succeeds.
  const bag1 = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M' } },
    fakeToolOpts('bag-1'),
  );
  assert.match(bag1, /^Added 1 piece, total \$6000/);
  assert.equal(storeAddCalls, 1);

  // 3) Re-bagging Look 1 with corrected size (L instead of M) replaces Look 1 ($6,000, NOT $12,000) -> succeeds!
  const bag1Corrected = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'L' } },
    fakeToolOpts('bag-1-corr'),
  );
  assert.match(bag1Corrected, /^Added 1 piece, total \$6000/);
  assert.equal(storeAddCalls, 2);

  // 4) Adding Look 2 ($4,500) would bring running total to $10,500 > $10,000 -> NOT DONE!
  calls.length = 0;
  const bag2Over = await tools.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('bag-2-over'),
  );
  assert.equal(bag2Over.startsWith('NOT DONE:'), true);
  assert.match(bag2Over, /\$10500/);
  assert.match(bag2Over, /\$10000|\$10,000/);
  assert.equal(storeAddCalls, 2, 'must not call addToBag when estimated running total exceeds $10,000');
  assert.equal(calls.some((c) => c.action === 'bagReady'), false);

  // 5) Live store price jump pushing a normally-under-cap look over $10,000 -> NOT DONE without bagReady!
  livePriceOverride = 10_500;
  const bag1LiveJump = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'S' } },
    fakeToolOpts('bag-1-jump'),
  );
  assert.equal(bag1LiveJump.startsWith('NOT DONE:'), true);
  assert.match(bag1LiveJump, /\$10500/);
  assert.equal(calls.some((c) => c.action === 'bagReady'), false);
});

test('slow tools send working notes with bits after 2s, skip fast results and ready show_on_me, and notify slow hooks', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const notes: WorkingNoteParams[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-slow-bits', log: () => {} });

  let resolveSlowBuild!: (res: BuildResult) => void;
  const slowBuildGate = new Promise<BuildResult>((r) => {
    resolveSlowBuild = r;
  });
  let resolveTryOn2!: (res: { url: string; path: string; ms: number; id: string }) => void;
  const tryOn2Gate = new Promise<{ url: string; path: string; ms: number; id: string }>((r) => {
    resolveTryOn2 = r;
  });
  let resolveSwap!: (res: { outfit: Outfit; piece: Outfit['pieces'][0] }) => void;
  const swapGate = new Promise<{ outfit: Outfit; piece: Outfit['pieces'][0] }>((r) => {
    resolveSwap = r;
  });

  const sample = makeSampleOutfits();
  const tools = createAgentTools({
    room: 'r-slow-bits',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendWorkingNote: (n) => {
      notes.push(n);
      return true;
    },
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        const res = await slowBuildGate;
        res.outfits.forEach((o, i) => opts?.onOutfit?.(o, i));
        return res;
      },
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 1) {
          return { url: 'https://media.local/ready-1.jpg', path: '', ms: 5, id: 't1' };
        }
        return tryOn2Gate;
      },
      async swapPiece() {
        return swapGate;
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));

  // 1) Slow build_outfits (>= 4s with no look on screen) sends working note with bit and records usedBitIds in state.
  const buildPromise = tools.build_outfits.execute(
    { occasion: 'rooftop', budget_usd: 250 },
    fakeToolOpts('b-slow'),
  );
  await clock.advance(3_999);
  assert.equal(notes.length, 0, 'build_outfits must not send a working note before 4s');
  await clock.advance(1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.name, 'build_outfits');
  assert.match(notes[0]!.note, /While this runs, tell this in your own words:/);
  assert.equal(state.get().usedBitIds.length, 1);

  resolveSlowBuild({
    outfits: structuredClone(sample),
    source: 'live',
    timing: { first_outfit_ms: 4_100, total_ms: 4_500 },
    problems: [],
  });
  const slowBuildRes = await buildPromise;
  await flushMicrotasks();
  assert.equal(
    slowBuildRes.startsWith('The looks are ALREADY on screen.'),
    false,
    'slow build (>= 4s) must not get the fast-build ALREADY on screen prefix',
  );

  // 2) show_on_me when try-on is ALREADY ready (Look 1) sends NO working note / bit.
  const show1Res = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s-ready'));
  assert.match(show1Res, /revealed/i);
  await clock.advance(5_000);
  assert.equal(notes.length, 1, 'ready show_on_me must never send a working note or bit');

  // 3) show_on_me when try-on is STILL rendering (Look 2) sends a different bit after 2s.
  const show2Promise = tools.show_on_me.execute({ outfit: 2 }, fakeToolOpts('s-slow'));
  await flushMicrotasks();
  await clock.advance(2_000);
  assert.equal(notes.length, 2);
  assert.equal(notes[1]!.name, 'show_on_me');
  assert.match(notes[1]!.note, /While this runs, tell this in your own words:/);
  assert.equal(state.get().usedBitIds.length, 2);
  assert.notEqual(state.get().usedBitIds[0], state.get().usedBitIds[1]);

  resolveTryOn2({ url: 'https://media.local/ready-2.jpg', path: '', ms: 2_500, id: 't2' });
  await show2Promise;

  // 4) Fast swap_piece (< 2s) cancels working note and consumes NO bit.
  const swapPromise = tools.swap_piece.execute(
    { outfit: 1, slot: 'shoes', request: 'loafers' },
    fakeToolOpts('sw-fast'),
  );
  await clock.advance(1_000);
  resolveSwap({
    outfit: structuredClone(sample[0]!),
    piece: structuredClone(sample[0]!.pieces[2]!),
  });
  await swapPromise;
  await clock.advance(5_000);
  assert.equal(notes.length, 2, 'fast swap_piece must not send a working note or bit');
  assert.equal(state.get().usedBitIds.length, 2);

  // 5) onToolStart / onToolEnd / onSlowToolStart / onSlowToolEnd fire cleanly; add_to_bag has NO slow filler.
  const events: string[] = [];
  const hookedTools = createAgentTools({
    room: 'r-hooks',
    log: () => {},
    page,
    state: createCallStateStore({ roomName: 'r-hooks', log: () => {} }),
    onToolStart: (ev) => events.push(`start:${ev.name}`),
    onToolEnd: (ev) => events.push(`end:${ev.name}`),
    onSlowToolStart: (ev) => events.push(`slow_start:${ev.name}`),
    onSlowToolEnd: (ev) => events.push(`slow_end:${ev.name}`),
    deps: makeFakeDeps({
      async searchProducts() {
        return { items: [makeItem()], source: 'live', ms: 10 };
      },
    }),
  });

  await hookedTools.set_department.execute({ department: 'men' }, fakeToolOpts('hd1'));
  await hookedTools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('hb1'));
  await hookedTools.search_products.execute({ query: 'blazer' }, fakeToolOpts('hs1'));
  await hookedTools.add_to_bag.execute({ outfit: 1, sizes: { top: 'M', shoes: '10' } }, fakeToolOpts('hbag1'));

  assert.ok(events.includes('slow_start:build_outfits'));
  assert.ok(events.includes('slow_end:build_outfits'));
  assert.ok(events.includes('slow_start:search_products'));
  assert.ok(events.includes('slow_end:search_products'));
  assert.equal(events.includes('slow_start:add_to_bag'), false, 'add_to_bag must have no filler line');
  assert.equal(events.includes('slow_end:add_to_bag'), false, 'add_to_bag must have no filler line');
  assert.ok(events.includes('start:add_to_bag'));
  assert.ok(events.includes('end:add_to_bag'));
  assert.ok(events.includes('start:set_department'));
  assert.ok(events.includes('end:set_department'));
  assert.equal(events.includes('slow_start:set_department'), false);

  const fillerLogs = logs.filter((l) => l.ev === 'filler_bit');
  assert.equal(fillerLogs.length, 2);
  assert.equal(fillerLogs[0]!.data?.tool, 'build_outfits');
  assert.equal(fillerLogs[1]!.data?.tool, 'show_on_me');
});

test('outfitBoard sends collageReady with boxes when exported, and falls back to outfitCollage without boxes when absent or null', async () => {
  assert.equal(resolveOutfitBoard({}), undefined);
  assert.equal(resolveOutfitBoard(null), undefined);
  const sampleBoardFn = async () => ({ url: '/tryon/b.jpg', boxes: {} });
  assert.equal(resolveOutfitBoard({ outfitBoard: sampleBoardFn }), sampleBoardFn);

  // 1) outfitBoard returns { url, boxes } -> sends collageReady { outfit, url, boxes } without calling outfitCollage.
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-board', log: () => {} });
  let boardCalls = 0;
  let collageFallbackCalls = 0;

  const toolsWithBoard = createAgentTools({
    room: 'r-board',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async outfitBoard(outfit) {
        boardCalls += 1;
        if (outfit.number === 1) {
          return {
            url: '/tryon/board-look-1.jpg',
            boxes: {
              top: [0.05, 0.05, 0.4, 0.4],
              bottom: [0.05, 0.5, 0.4, 0.45],
              shoes: [0.55, 0.6, 0.35, 0.3],
            },
          };
        }
        // Look 2 returns null -> must fall back to outfitCollage with NO boxes.
        return null;
      },
      async outfitCollage(outfit) {
        collageFallbackCalls += 1;
        return `/tryon/collage-fallback-${outfit.number ?? 1}.jpg`;
      },
    }),
  });

  await toolsWithBoard.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await toolsWithBoard.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b1'));
  await flushMicrotasks();

  assert.equal(boardCalls, 2);
  assert.equal(collageFallbackCalls, 1, 'outfitCollage fallback runs only for look where outfitBoard returned null');

  const collageCalls = calls.filter((c) => c.action === 'collageReady');
  assert.equal(collageCalls.length, 2);

  const look1Ready = collageCalls.find(
    (c) => (c.payload as PageActions['collageReady']).outfit === 1,
  )?.payload as PageActions['collageReady'];
  assert.deepEqual(look1Ready, {
    outfit: 1,
    url: '/tryon/board-look-1.jpg',
    boxes: {
      top: [0.05, 0.05, 0.4, 0.4],
      bottom: [0.05, 0.5, 0.4, 0.45],
      shoes: [0.55, 0.6, 0.35, 0.3],
    },
  });

  const look2Ready = collageCalls.find(
    (c) => (c.payload as PageActions['collageReady']).outfit === 2,
  )?.payload as PageActions['collageReady'];
  assert.deepEqual(look2Ready, {
    outfit: 2,
    url: '/tryon/collage-fallback-2.jpg',
  });
  assert.equal('boxes' in look2Ready, false, 'fallback collageReady must not include boxes');

  // 2) outfitBoard explicitly absent (null) -> falls back to outfitCollage with no boxes.
  calls.length = 0;
  let absentFallbackCalls = 0;
  const toolsAbsentBoard = createAgentTools({
    room: 'r-board-absent',
    log: () => {},
    page,
    state: createCallStateStore({ roomName: 'r-board-absent', log: () => {} }),
    deps: makeFakeDeps({
      outfitBoard: null,
      async outfitCollage(outfit) {
        absentFallbackCalls += 1;
        return `/tryon/legacy-collage-${outfit.number ?? 1}.jpg`;
      },
    }),
  });

  await toolsAbsentBoard.set_department.execute({ department: 'men' }, fakeToolOpts('d2'));
  await toolsAbsentBoard.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('b2'));
  await flushMicrotasks();

  assert.equal(absentFallbackCalls, 2);
  const legacyCalls = calls.filter((c) => c.action === 'collageReady');
  assert.equal(legacyCalls.length, 2);
  for (const c of legacyCalls) {
    const p = c.payload as PageActions['collageReady'];
    assert.equal('boxes' in p, false);
  }
});

test('add_to_bag bags what can be bagged immediately when shopper gives large top + size 11 shoes (boots max 10, bottom unknown)', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-partial-now', log: () => {} });
  const baggedBatches: Array<{ slots: string[]; sizes: Record<string, string> }> = [];

  const bootLook: Outfit = {
    number: 1,
    name: 'Downtown Boots',
    difference: 'Oversized shirt, tailored trousers, leather boots.',
    story: 'Sharp downtown night out.',
    total: 230,
    pieces: [
      {
        slot: 'top',
        why: 'Relaxed drape.',
        item: makeItem({
          id: 'p-top',
          variant_id: 'v-top',
          title: 'Heavyweight Overshirt',
          price: 75,
          store: 'Everlane',
          store_domain: 'everlane.myshopify.com',
          sizes: ['S', 'M', 'L', 'XL'],
        }),
      },
      {
        slot: 'bottom',
        why: 'Clean leg.',
        item: makeItem({
          id: 'p-bot',
          variant_id: 'v-bot',
          title: 'Relaxed Wool Trouser',
          price: 85,
          store: 'Everlane',
          store_domain: 'everlane.myshopify.com',
          sizes: ['30', '32', '34'],
        }),
      },
      {
        slot: 'shoes',
        why: 'Sturdy ankle boot.',
        item: makeItem({
          id: 'p-boot',
          variant_id: 'v-boot',
          title: 'Chelsea Boot - Black',
          price: 70,
          store: 'Steve Madden',
          store_domain: 'stevemadden.myshopify.com',
          sizes: ['8', '9', '10'],
        }),
      },
    ],
  };

  const tools = createAgentTools({
    room: 'r-bag-partial-now',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        opts?.onOutfit?.(bootLook, 0);
        return {
          outfits: [bootLook],
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 10 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        baggedBatches.push({ slots: bagOutfit.pieces.map((p) => p.slot), sizes: { ...sizes } });
        // Top in L succeeds; boots in 11 unavailable (max 10).
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: 'cart-ev-boot',
              continue_url: 'https://everlane.com/cart/boot',
              total_usd: 75,
              added: [{ variant_id: 'v-top', title: 'Heavyweight Overshirt', size: sizes.top }],
              not_added: [],
              ms: 20,
            },
            {
              store: 'Steve Madden',
              store_domain: 'stevemadden.myshopify.com',
              cart_id: null,
              continue_url: null,
              total_usd: null,
              added: [],
              not_added: [
                {
                  variant_id: 'v-boot',
                  title: 'Chelsea Boot - Black',
                  reason: "11 isn't in stock (sizes left: 8, 9, 10)",
                },
              ],
              ms: 20,
            },
          ],
          summary: "Everlane: 1 added, $75.00. Chelsea Boot - Black: 11 isn't in stock (sizes left: 8, 9, 10). 1 checkout link ready.",
          total_usd: 75,
        };
      },
    }),
  });

  assert.match(tools.add_to_bag.description, /straight away/i);
  assert.match(tools.add_to_bag.description, /never hold back the whole bag/i);
  assert.match(tools.add_to_bag.description, /STOP and say nothing else until the tool result arrives/);
  assert.match(tools.add_to_bag.description, /never state what is in the bag, never state a total/i);
  assert.match(tools.add_to_bag.description, /never read out anything that looks like a tool call or tool output before the result/i);
  assert.match(tools.add_to_bag.description, /what is in the bag and the total come only from the result text/i);
  assert.match(
    tools.add_to_bag.description,
    /when the shopper gives a missing size after PARTLY DONE or NOT DONE, call add_to_bag again immediately with all known sizes, no question first/i,
  );

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'concert', budget_usd: 300 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // Regression: "large in tops, size 11 shoes, bag it" (no bottom size yet, boots max 10).
  const res = await tools.add_to_bag.execute(
    { sizes: { top: 'large', shoes: '11' } },
    fakeToolOpts('bag-now'),
  );

  // Must NOT hold back the whole bag! Sent only pieces with sizes (top + shoes), excluding unknown bottom.
  assert.equal(baggedBatches.length, 1);
  assert.deepEqual(baggedBatches[0]!.slots, ['top', 'shoes']);
  assert.equal(res.startsWith('PARTLY DONE: NOT ADDED (2):'), true);
  assert.match(res, /Chelsea Boot - Black at Steve Madden \(11 isn't in stock \(sizes left: 8, 9, 10\)\)/);
  assert.match(res, /Relaxed Wool Trouser at Everlane \(no bottom size given \(sizes: 30, 32, 34\)\)/);
  const sayOnlyIdx = res.indexOf('Say only these are in the bag: Heavyweight Overshirt.');
  const addedIdx = res.indexOf('Added 1 piece, total $75');
  assert.ok(sayOnlyIdx > 0 && sayOnlyIdx < addedIdx, `expected Say only instruction before Added sentence, got: ${res}`);
  assert.match(res, /Added 1 piece, total \$75/);
  assert.match(res, /Heavyweight Overshirt \(size large\)/);
  assert.match(res, /offer a swap or another size/i);

  const bagReady = calls.find((c) => c.action === 'bagReady');
  assert.ok(bagReady, 'bagReady must be sent for the piece that could be bagged');
  const payload = bagReady!.payload as PageActions['bagReady'];
  assert.equal(payload.total, 75);
  assert.deepEqual(payload.links, [{ store: 'Everlane', url: 'https://everlane.com/cart/boot' }]);
});

test('add_to_bag closes budget ceiling holes: concurrent calls, partial re-bag with changed size, swap price rise, and null cart total', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-cap-holes', log: () => {} });
  let storeAddCalls = 0;
  let releaseSlowCart!: () => void;
  let slowMode = false;
  let returnNullTotal = false;

  const capOutfits: Outfit[] = [
    {
      number: 1,
      name: 'Atelier One',
      difference: 'Cashmere coat + designer boots.',
      story: 'Statement.',
      pieces: [
        {
          slot: 'top',
          why: 'Cashmere.',
          item: makeItem({ id: 'c1', variant_id: 'vc1', title: 'Cashmere Coat', price: 6_000, sizes: ['M', 'L'] }),
        },
        {
          slot: 'shoes',
          why: 'Boots.',
          item: makeItem({ id: 'c2', variant_id: 'vc2', title: 'Atelier Boots', price: 2_000, sizes: ['9', '10'] }),
        },
      ],
      total: 8_000,
    },
    {
      number: 2,
      name: 'Atelier Two',
      difference: 'Silk evening look.',
      story: 'Evening.',
      pieces: [
        {
          slot: 'top',
          why: 'Silk.',
          item: makeItem({ id: 'c3', variant_id: 'vc3', title: 'Silk Tuxedo', price: 4_500, sizes: ['M', 'L'] }),
        },
      ],
      total: 4_500,
    },
  ];

  const tools = createAgentTools({
    room: 'r-cap-holes',
    log: () => {},
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        capOutfits.forEach((o, i) => opts?.onOutfit?.(structuredClone(o), i));
        return {
          outfits: structuredClone(capOutfits),
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 10 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        storeAddCalls += 1;
        if (slowMode) {
          await new Promise<void>((resolve) => {
            releaseSlowCart = resolve;
          });
        }
        const addedPieces = bagOutfit.pieces.filter((p) => {
          if (p.slot === 'shoes' && sizes.shoes === '11') return false;
          return true;
        });
        const skippedPieces = bagOutfit.pieces.filter((p) => !addedPieces.includes(p));
        const total = addedPieces.reduce((s, p) => s + p.item.price, 0);
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-hole-${storeAddCalls}`,
              continue_url: `https://everlane.com/cart/hole-${storeAddCalls}`,
              total_usd: returnNullTotal ? null : total,
              added: addedPieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? 'M',
              })),
              not_added: skippedPieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                reason: "11 isn't in stock (sizes left: 9, 10)",
              })),
              ms: 10,
            },
          ],
          summary: `Added ${addedPieces.length} items.`,
          total_usd: returnNullTotal ? 0 : total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'gala', budget_usd: 10_000 }, fakeToolOpts('b1'));
  calls.length = 0;

  // Hole 1: Concurrent overlapping add_to_bag calls (Look 1 $6,000 top + Look 2 $4,500 = $10,500).
  // Without in-flight reservations, both see otherLooksTotal = 0 and both create carts!
  slowMode = true;
  const p1 = tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M' } },
    fakeToolOpts('conc-1'),
  );
  await flushMicrotasks();
  const p2Res = await tools.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('conc-2'),
  );
  assert.equal(p2Res.startsWith('NOT DONE:'), true);
  assert.match(p2Res, /\$10500/);
  assert.equal(storeAddCalls, 1, 'concurrent over-cap look must be blocked BEFORE creating a cart');
  releaseSlowCart();
  slowMode = false;
  const p1Res = await p1;
  assert.match(p1Res, /Added 1 piece, total \$6000/);

  // Hole 2: Look 1 was partially bagged ($6,000 Coat, boots size 11 unavailable).
  // Re-bagging Look 1 with changed size (shoes: '11' -> Coat $6,000, boots skipped) replaces Look 1 ($6,000).
  // Now bag Look 2 ($4,500) -> $6,000 + $4,500 = $10,500 > $10,000 -> blocked BEFORE cart creation!
  const look2Blocked = await tools.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('hole-l2'),
  );
  assert.equal(look2Blocked.startsWith('NOT DONE:'), true);
  assert.equal(storeAddCalls, 1);

  // Hole 3: Re-bagging Look 1 with changed size (L + boots 10 = $8,000) when Look 2 ($3,500) is also bagged:
  // Fresh tools instance with Look 1 ($6,000 + $2,000) and Look 2 ($3,500).
  const state2 = createCallStateStore({ roomName: 'r-cap-rebag', log: () => {} });
  let rebagStoreCalls = 0;
  const rebagOutfits = structuredClone(capOutfits);
  rebagOutfits[1]!.pieces[0]!.item.price = 3_500;
  rebagOutfits[1]!.total = 3_500;

  const tools2 = createAgentTools({
    room: 'r-cap-rebag',
    log: () => {},
    page,
    state: state2,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        rebagOutfits.forEach((o, i) => opts?.onOutfit?.(structuredClone(o), i));
        return {
          outfits: structuredClone(rebagOutfits),
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 10 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        rebagStoreCalls += 1;
        const addedPieces = bagOutfit.pieces.filter((p) => !(p.slot === 'shoes' && sizes.shoes === '11'));
        const skippedPieces = bagOutfit.pieces.filter((p) => !addedPieces.includes(p));
        const total = addedPieces.reduce((s, p) => s + p.item.price, 0);
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-rb-${rebagStoreCalls}`,
              continue_url: `https://everlane.com/cart/rb-${rebagStoreCalls}`,
              total_usd: total,
              added: addedPieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? 'M',
              })),
              not_added: skippedPieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                reason: "11 isn't in stock (sizes left: 9, 10)",
              })),
              ms: 10,
            },
          ],
          summary: `Added ${addedPieces.length} items.`,
          total_usd: total,
        };
      },
    }),
  });

  await tools2.set_department.execute({ department: 'women' }, fakeToolOpts('d2'));
  await tools2.build_outfits.execute({ occasion: 'gala', budget_usd: 10_000 }, fakeToolOpts('b2'));

  // Bag Look 1 partially ($6,000 coat, boots 11 unavailable) + Look 2 ($3,500) -> $9,500 running total.
  const l1Part = await tools2.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', shoes: '11' } },
    fakeToolOpts('rb-1'),
  );
  assert.match(l1Part, /Added 1 piece, total \$6000/);
  const l2Ok = await tools2.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('rb-2'),
  );
  assert.match(l2Ok, /Added 1 piece, total \$3500/);
  assert.equal(rebagStoreCalls, 2);

  // Re-bagging Look 1 with changed shoe size '10' ($8,000) would bring running total to $3,500 + $8,000 = $11,500 > $10,000.
  // Must be blocked BEFORE creating a new cart, and report true current bag total ($9,500)!
  const l1RebagOver = await tools2.add_to_bag.execute(
    { outfit: 1, sizes: { shoes: '10' } },
    fakeToolOpts('rb-3'),
  );
  assert.equal(l1RebagOver.startsWith('NOT DONE:'), true);
  assert.match(l1RebagOver, /\$11500/);
  assert.match(l1RebagOver, /current bag total is \$9500/);
  assert.equal(rebagStoreCalls, 2, 'over-cap re-bag must be rejected BEFORE creating a cart');

  // Hole 4: Store returns total_usd: null/0 while added items total $6,000 -> ceiling still counts $6,000!
  returnNullTotal = true;
  const state3 = createCallStateStore({ roomName: 'r-cap-null', log: () => {} });
  let nullStoreCalls = 0;
  const tools3 = createAgentTools({
    room: 'r-cap-null',
    log: () => {},
    page,
    state: state3,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        capOutfits.forEach((o, i) => opts?.onOutfit?.(structuredClone(o), i));
        return {
          outfits: structuredClone(capOutfits),
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 10 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        nullStoreCalls += 1;
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-null-${nullStoreCalls}`,
              continue_url: `https://everlane.com/cart/null-${nullStoreCalls}`,
              total_usd: null,
              added: bagOutfit.pieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? 'M',
              })),
              not_added: [],
              ms: 10,
            },
          ],
          summary: 'Added items (total pending).',
          total_usd: 0,
        };
      },
    }),
  });

  await tools3.set_department.execute({ department: 'women' }, fakeToolOpts('d3'));
  await tools3.build_outfits.execute({ occasion: 'gala', budget_usd: 10_000 }, fakeToolOpts('b3'));
  await tools3.add_to_bag.execute({ outfit: 1, sizes: { top: 'M' } }, fakeToolOpts('null-1'));
  assert.equal(nullStoreCalls, 1);

  const nullLook2 = await tools3.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('null-2'),
  );
  assert.equal(nullLook2.startsWith('NOT DONE:'), true);
  assert.match(nullLook2, /\$10500/);
  assert.equal(nullStoreCalls, 1, 'null cart total must fall back to added item prices so Look 2 is blocked before cart creation');
});

test('swap_piece on a partly or fully bagged look warns NOT IN THE BAG YET and allows immediate repeat add_to_bag with the new real bag', async () => {
  const clock = createFakeClock(50_000);
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-swap-after-bag', log: () => {} });
  let bagCalls = 0;
  let lastBaggedOutfit: Outfit | null = null;
  let lastBaggedSizes: Record<string, string> | null = null;

  const topItem = makeItem({
    id: 'top-1',
    variant_id: 'v-top-1',
    title: 'Merino Knit Polo',
    price: 100,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'v-top-s', M: 'v-top-m', L: 'v-top-l' },
  });
  const bottomItem = makeItem({
    id: 'bot-1',
    variant_id: 'v-bot-1',
    title: 'Pleated Wool Trouser',
    price: 150,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    sizes: ['30', '32', '34'],
    variants_by_size: { '30': 'v-bot-30', '32': 'v-bot-32', '34': 'v-bot-34' },
  });
  const soldOutShoes = makeItem({
    id: 'shoe-soldout',
    variant_id: 'v-shoe-soldout',
    title: 'Suede Chelsea Boot',
    price: 200,
    store: 'Kith',
    store_domain: 'kith.myshopify.com',
    sizes: ['9', '10', '11'],
    variants_by_size: { '9': 'v-shoe-9', '10': 'v-shoe-10', '11': 'v-shoe-11' },
  });
  const replacementShoes = makeItem({
    id: 'shoe-new',
    variant_id: 'v-shoe-new',
    title: 'Pebbled Leather Derby',
    price: 262.95,
    store: 'Kith',
    store_domain: 'kith.myshopify.com',
    sizes: ['9', '10', '11'],
    variants_by_size: { '9': 'v-new-9', '10': 'v-new-10', '11': 'v-new-11' },
  });

  const look1: Outfit = {
    number: 1,
    name: 'West Village Sharp',
    difference: 'Clean knit and tailored trouser.',
    story: 'Sharp dinner fit.',
    pieces: [
      { slot: 'top', why: 'Soft drape.', item: topItem },
      { slot: 'bottom', why: 'Clean leg.', item: bottomItem },
      { slot: 'shoes', why: 'Grounding boot.', item: soldOutShoes },
    ],
    total: 450,
  };
  const look2: Outfit = {
    number: 2,
    name: 'SoHo Relaxed',
    difference: 'Relaxed alternate.',
    story: 'Easy weekend fit.',
    pieces: [
      { slot: 'top', why: 'Easy knit.', item: topItem },
      { slot: 'shoes', why: 'Classic derby.', item: replacementShoes },
    ],
    total: 362.95,
  };

  let swapSeq = 0;
  const tools = createAgentTools({
    room: 'r-swap-after-bag',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        const outfits = [structuredClone(look1), structuredClone(look2)];
        outfits.forEach((o, i) => opts?.onOutfit?.(o, i));
        return {
          outfits,
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 15 },
          problems: [],
        };
      },
      async swapPiece(outfit, slot, _request) {
        swapSeq += 1;
        const newPiece =
          slot === 'shoes'
            ? { slot: 'shoes', why: 'In-stock replacement.', item: replacementShoes }
            : {
                slot,
                why: 'Refreshed piece.',
                item: makeItem({
                  ...topItem,
                  // Even if a swap kept the same id/variant_id, repeat add_to_bag must still run.
                  title: `Swapped Top #${swapSeq}`,
                  price: 110,
                }),
              };
        const pieces = outfit.pieces.map((p) => (p.slot === slot ? newPiece : p));
        const total = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
        return { outfit: { ...outfit, pieces, total }, piece: newPiece };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        bagCalls += 1;
        lastBaggedOutfit = structuredClone(bagOutfit);
        lastBaggedSizes = { ...sizes };
        const hasSoldOut = bagOutfit.pieces.some((p) => p.item.id === 'shoe-soldout');
        if (hasSoldOut) {
          return {
            carts: [
              {
                store: 'Everlane',
                store_domain: 'everlane.myshopify.com',
                cart_id: 'cart-ev-1',
                continue_url: 'https://everlane.example/cart/1',
                total_usd: 250,
                added: [
                  { variant_id: 'v-top-m', title: 'Merino Knit Polo', size: sizes.top ?? 'M' },
                  { variant_id: 'v-bot-32', title: 'Pleated Wool Trouser', size: sizes.bottom ?? '32' },
                ],
                not_added: [],
                ms: 15,
              },
              {
                store: 'Kith',
                store_domain: 'kith.myshopify.com',
                cart_id: null,
                continue_url: null,
                total_usd: 0,
                added: [],
                not_added: [
                  { variant_id: 'v-shoe-soldout', title: 'Suede Chelsea Boot', reason: 'sold out in size 10' },
                ],
                ms: 12,
              },
            ],
            summary: 'PARTLY DONE: Suede Chelsea Boot sold out in size 10.',
            total_usd: 250,
          };
        }
        const total =
          Math.round(bagOutfit.pieces.reduce((sum, p) => sum + p.item.price, 0) * 100) / 100;
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: `cart-ev-${bagCalls}`,
              continue_url: `https://everlane.example/cart/${bagCalls}`,
              total_usd: bagOutfit.pieces
                .filter((p) => p.item.store === 'Everlane')
                .reduce((s, p) => s + p.item.price, 0),
              added: bagOutfit.pieces
                .filter((p) => p.item.store === 'Everlane')
                .map((p) => ({
                  variant_id: p.item.variant_id,
                  title: p.item.title,
                  size: sizes[p.slot.toLowerCase()] ?? null,
                })),
              not_added: [],
              ms: 15,
            },
            {
              store: 'Kith',
              store_domain: 'kith.myshopify.com',
              cart_id: `cart-kith-${bagCalls}`,
              continue_url: `https://kith.example/cart/${bagCalls}`,
              total_usd: 262.95,
              added: [
                {
                  variant_id: 'v-new-10',
                  title: 'Pebbled Leather Derby',
                  size: sizes.shoes ?? '10',
                },
              ],
              not_added: [],
              ms: 18,
            },
          ],
          summary: `Added ${bagOutfit.pieces.length} pieces.`,
          total_usd: total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 600 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // 1) Initial add_to_bag is PARTLY DONE (shoes sold out).
  const firstBag = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } },
    fakeToolOpts('bag-1'),
  );
  assert.match(firstBag, /^PARTLY DONE:/);
  assert.match(firstBag, /Added 2 pieces, total \$250/);
  assert.equal(bagCalls, 1);

  // 2) Swapping on Look 2 (which has NO bag) does NOT warn NOT IN THE BAG YET.
  const unbaggedSwap = await tools.swap_piece.execute(
    { outfit: 2, slot: 'shoes', request: 'loafers' },
    fakeToolOpts('swap-unbagged'),
  );
  assert.equal(unbaggedSwap.startsWith('NOT IN THE BAG YET:'), false);

  // 3) Swapping sold-out shoes on partly-bagged Look 1 MUST begin with exact NOT IN THE BAG YET warning + instruction.
  await clock.advance(1_000);
  const swapAfterPartBag = await tools.swap_piece.execute(
    { outfit: 1, slot: 'shoes', request: 'leather derbies' },
    fakeToolOpts('swap-1'),
  );
  assert.equal(
    swapAfterPartBag.startsWith('NOT IN THE BAG YET: the new shoes is only on screen.'),
    true,
    `expected NOT IN THE BAG YET prefix, got: ${swapAfterPartBag}`,
  );
  assert.match(swapAfterPartBag, /call add_to_bag again now with the sizes already known/i);
  assert.match(swapAfterPartBag, /ask only for a size that is truly missing for the new piece/i);
  assert.match(swapAfterPartBag, /never say it is in the bag or give a bag total until add_to_bag returns/i);

  // 4) Immediate repeat add_to_bag (within 15s dedupe window, exact same sizes) MUST run and report the new real bag.
  await clock.advance(1_000);
  calls.length = 0;
  const secondBag = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } },
    fakeToolOpts('bag-2'),
  );
  assert.equal(bagCalls, 2, 'repeat add_to_bag after swap must NOT be refused as duplicate');
  assert.equal(secondBag.startsWith('Already in the bag.'), false);
  assert.equal(secondBag.startsWith('PARTLY DONE:'), false);
  assert.match(secondBag, /Added 3 pieces, total \$512\.95 for Look 1/);
  assert.match(secondBag, /Pebbled Leather Derby/);
  assert.ok(lastBaggedOutfit?.pieces.some((p) => p.item.id === 'shoe-new'));
  assert.deepEqual(lastBaggedSizes, { top: 'M', bottom: '32', shoes: '10' });
  assert.ok(calls.some((c) => c.action === 'bagReady'));
  assert.equal(state.get().bag?.total, 512.95);
  assert.equal(state.get().bag?.notAdded.length, 0);

  // 5) Swapping on the now-fully-bagged Look 1 ALSO warns NOT IN THE BAG YET, and repeat add_to_bag works even if item id stayed the same.
  await clock.advance(1_000);
  const swapAfterFullBag = await tools.swap_piece.execute(
    { outfit: 1, slot: 'top', request: 'cashmere polo' },
    fakeToolOpts('swap-2'),
  );
  assert.equal(
    swapAfterFullBag.startsWith('NOT IN THE BAG YET: the new top is only on screen.'),
    true,
    `expected NOT IN THE BAG YET prefix for top swap on fully bagged look, got: ${swapAfterFullBag}`,
  );

  await clock.advance(1_000);
  const thirdBag = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } },
    fakeToolOpts('bag-3'),
  );
  assert.equal(bagCalls, 3, 'repeat add_to_bag after second swap must run even with unchanged item id');
  assert.equal(thirdBag.startsWith('Already in the bag.'), false);
  assert.match(thirdBag, /Added 3 pieces, total \$522\.95 for Look 1/);
  assert.match(thirdBag, /Swapped Top #3/);
});

test('remove_from_bag removes one slot, removes all, handles not bagged/not in bag, preserves screen look & other looks, and lets add_to_bag restore all', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-remove-bag', log: () => {} });
  let invalidateCount = 0;
  let bagSettledCalls = 0;
  let bagFailedCalls = 0;
  let addToBagCalls = 0;
  const addToBagInvocations: Array<{ pieces: string[]; sizes: Record<string, string> }> = [];

  const fakeOrderController: OrderController = {
    purchaseReady: false,
    onBagSettled() {
      bagSettledCalls += 1;
    },
    onBagFailed() {
      bagFailedCalls += 1;
    },
    invalidateReview() {
      invalidateCount += 1;
    },
    getState() {
      return {
        settledBag: null,
        settledBagFingerprint: null,
        activeReview: null,
        attemptedOrderIds: {},
      };
    },
    tools: {},
  };

  const outfits = makeSampleOutfits();
  const tools = createAgentTools({
    room: 'r-remove-bag',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    orderController: fakeOrderController,
    deps: makeFakeDeps({
      tryOnExtras: null,
      async buildOutfits(_brief, opts) {
        const cloned = structuredClone(outfits);
        cloned.forEach((o, i) => opts?.onOutfit?.(o, i));
        return {
          outfits: cloned,
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 15 },
          problems: [],
        };
      },
      async addToBag(bagOutfit, sizes): Promise<BagOut> {
        addToBagCalls += 1;
        addToBagInvocations.push({
          pieces: bagOutfit.pieces.map((p) => p.slot),
          sizes: { ...sizes },
        });
        const byStore = new Map<string, typeof bagOutfit.pieces>();
        for (const p of bagOutfit.pieces) {
          const list = byStore.get(p.item.store) ?? [];
          list.push(p);
          byStore.set(p.item.store, list);
        }
        const carts = Array.from(byStore.entries()).map(([store, pieces]) => {
          const subtotal = Math.round(pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;
          return {
            store,
            store_domain: pieces[0]!.item.store_domain,
            cart_id: `cart-${store.toLowerCase()}-${addToBagCalls}`,
            continue_url: `https://${store.toLowerCase()}.example/cart/${addToBagCalls}`,
            total_usd: subtotal,
            added: pieces.map((p) => ({
              variant_id: p.item.variant_id,
              title: p.item.title,
              size: sizes[p.slot.toLowerCase()] ?? null,
            })),
            not_added: [],
            ms: 10,
          };
        });
        const total = Math.round(carts.reduce((s, c) => s + (c.total_usd ?? 0), 0) * 100) / 100;
        return {
          carts,
          summary: `Added ${bagOutfit.pieces.length} pieces.`,
          total_usd: total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 300 }, fakeToolOpts('b1'));
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // 1) Remove when look is NOT bagged -> NOT DONE, no store call, no bagReady.
  const notBagged = await tools.remove_from_bag.execute({ slot: 'shoes' }, fakeToolOpts('rm0'));
  assert.match(notBagged, /^NOT DONE:/);
  assert.match(notBagged, /not in the bag/i);
  assert.equal(addToBagCalls, 0);
  assert.equal(calls.some((c) => c.action === 'bagReady'), false);

  // 2) Bag Look 1 (top $45, bottom $60, shoes $55 = $160).
  const initialBag = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } },
    fakeToolOpts('bag1'),
  );
  assert.match(initialBag, /Added 3 pieces, total \$160/);
  assert.equal(addToBagCalls, 1);
  const look1SlotsBefore = [...state.get().looks.find((l) => l.number === 1)!.slots];

  // 3) Remove a slot not in the bag -> NOT DONE, no store call.
  const missingSlot = await tools.remove_from_bag.execute({ slot: 'layer' }, fakeToolOpts('rm-miss'));
  assert.match(missingSlot, /^NOT DONE:/);
  assert.match(missingSlot, /not in the bag/i);
  assert.equal(addToBagCalls, 1);

  // 4) Remove one slot (shoes): rebuilds cart with [top, bottom] & same sizes, updates bagReady, preserves look on screen, invalidates review.
  calls.length = 0;
  const invBefore = invalidateCount;
  const rmShoes = await tools.remove_from_bag.execute({ slot: 'shoes' }, fakeToolOpts('rm-shoes'));
  assert.match(rmShoes, /^REMOVED:/);
  assert.match(rmShoes, /Merino Knit Polo - Espresso/);
  assert.match(rmShoes, /Pleated Wool Trouser - Charcoal/);
  assert.match(rmShoes, /\$105/);
  assert.equal(addToBagCalls, 2);
  assert.deepEqual(addToBagInvocations[1]!.pieces, ['top', 'bottom']);
  assert.deepEqual(addToBagInvocations[1]!.sizes, { top: 'M', bottom: '32', shoes: '10' });
  assert.equal(invalidateCount, invBefore + 1, 'remove_from_bag must invalidate order review');
  assert.equal(calls.some((c) => c.action === 'updateOutfit'), false, 'look on screen must not change');
  assert.deepEqual(
    state.get().looks.find((l) => l.number === 1)!.slots,
    look1SlotsBefore,
    'state look slots must remain unchanged',
  );
  const bagAfterShoes = calls.filter((c) => c.action === 'bagReady').at(-1)!.payload as PageActions['bagReady'];
  assert.equal(bagAfterShoes.total, 105);
  assert.equal(
    bagAfterShoes.stores.flatMap((s) => s.added).length,
    2,
    'bagReady must contain only the 2 remaining pieces',
  );

  // 5) Remove 'all' on Look 1: does NOT call store, sends empty bagReady with total 0.
  calls.length = 0;
  const failBefore = bagFailedCalls;
  const rmAll = await tools.remove_from_bag.execute({ slot: 'all' }, fakeToolOpts('rm-all'));
  assert.match(rmAll, /^REMOVED:/);
  assert.match(rmAll, /empty|\$0/i);
  assert.equal(addToBagCalls, 2, 'removing all must NOT call store addToBag');
  assert.equal(bagFailedCalls, failBefore + 1);
  const emptyBag = calls.filter((c) => c.action === 'bagReady').at(-1)!.payload as PageActions['bagReady'];
  assert.deepEqual(emptyBag, { stores: [], links: [], total: 0 });
  assert.equal(state.get().bag?.total, 0);

  // 6) Later add_to_bag for Look 1 puts all 3 pieces back (clears removed set, even within 15s dedupe window).
  const reAdded = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } },
    fakeToolOpts('bag-again'),
  );
  assert.match(reAdded, /Added 3 pieces, total \$160/);
  assert.equal(addToBagCalls, 3);
  assert.deepEqual(addToBagInvocations[2]!.pieces, ['top', 'bottom', 'shoes']);

  // 7) Multi-look bag: add Look 2 as well, then remove all of Look 2 -> Look 1 stays in bagReady payload.
  const look2Total = outfits[1]!.total;
  const bag2 = await tools.add_to_bag.execute(
    { outfit: 2, sizes: { top: 'M' } },
    fakeToolOpts('bag-look2'),
  );
  assert.match(bag2, new RegExp(`Added ${outfits[1]!.pieces.length} pieces, total \\$${look2Total}`));
  assert.equal(addToBagCalls, 4);

  calls.length = 0;
  const settledBefore = bagSettledCalls;
  const rmLook2 = await tools.remove_from_bag.execute({ outfit: 2, slot: 'all' }, fakeToolOpts('rm-look2'));
  assert.match(rmLook2, /^REMOVED:/);
  assert.match(rmLook2, /\$160/);
  assert.equal(addToBagCalls, 4, 'removing all of Look 2 must not call store');
  assert.equal(bagSettledCalls, settledBefore + 1, 'Look 1 remains a settled real bag');
  const afterRemoveLook2 = calls.filter((c) => c.action === 'bagReady').at(-1)!.payload as PageActions['bagReady'];
  assert.equal(afterRemoveLook2.total, 160);
  assert.equal(afterRemoveLook2.stores.flatMap((s) => s.added).length, 3);
});

test('search_products numbers results and swap_piece supports exact pick (without calling brain swap) and rejects out-of-range pick', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-pick-swap', log: () => {} });
  let brainSwapCalls = 0;
  let tryOnCalls = 0;
  let collageCalls = 0;

  const linenShirt = makeItem({
    id: 'shirt-linen-1',
    variant_id: 'var-linen-1',
    title: 'Crisp White Linen Shirt',
    price: 78,
    store: 'Buck Mason',
    store_domain: 'buckmason.myshopify.com',
  });
  const oxfordShirt = makeItem({
    id: 'shirt-ox-2',
    variant_id: 'var-ox-2',
    title: 'Washed Oxford Shirt',
    price: 64,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
  });

  const tools = createAgentTools({
    room: 'r-pick-swap',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      tryOnExtras: null,
      async searchProducts(): Promise<SearchResult> {
        return { items: [linenShirt, oxfordShirt], source: 'live', ms: 20 };
      },
      async swapPiece(outfit, slot, request, brief, opts) {
        brainSwapCalls += 1;
        return makeFakeDeps().swapPiece!(outfit, slot, request, brief, opts);
      },
      async tryOn(_jpeg, outfit) {
        tryOnCalls += 1;
        return { url: `https://media.local/tryon-${outfit.number}-v${tryOnCalls}.jpg`, path: `/tmp/t-${tryOnCalls}.jpg`, ms: 10, id: `t-${tryOnCalls}` };
      },
      async outfitCollage(outfit) {
        collageCalls += 1;
        return `https://media.local/collage-${outfit.number}-v${collageCalls}.jpg`;
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'beach dinner', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // 1) Pick before any search -> NOT DONE telling to search first; zero brain swaps.
  const noSearch = await tools.swap_piece.execute({ slot: 'top', pick: 1 }, fakeToolOpts('sw-nosearch'));
  assert.match(noSearch, /^NOT DONE:/);
  assert.match(noSearch, /search_products/i);
  assert.equal(brainSwapCalls, 0);

  // 2) search_products returns numbered results.
  const searchRes = await tools.search_products.execute({ query: 'white linen shirt' }, fakeToolOpts('sr1'));
  assert.match(searchRes, /1\. Crisp White Linen Shirt \(\$78, Buck Mason\)/);
  assert.match(searchRes, /2\. Washed Oxford Shirt \(\$64, Everlane\)/);

  // 3) Out-of-range picks (0 and 5) -> NOT DONE, zero brain swaps.
  const pickZero = await tools.swap_piece.execute({ slot: 'top', pick: 0 }, fakeToolOpts('sw-zero'));
  assert.match(pickZero, /^NOT DONE:/);
  assert.match(pickZero, /search_products/i);
  const pickHigh = await tools.swap_piece.execute({ slot: 'top', pick: 5 }, fakeToolOpts('sw-high'));
  assert.match(pickHigh, /^NOT DONE:/);
  assert.match(pickHigh, /out of range/i);
  assert.equal(brainSwapCalls, 0);

  // 4) Valid pick: 1 -> replaces top with exact linenShirt ($78), recomputes total (78+60+55=193), does NOT call brain swap!
  calls.length = 0;
  const tryOnBefore = tryOnCalls;
  const collageBefore = collageCalls;
  const pickRes = await tools.swap_piece.execute({ slot: 'top', pick: 1 }, fakeToolOpts('sw-pick1'));
  await flushMicrotasks();

  assert.equal(brainSwapCalls, 0, 'swap_piece with pick must NOT call brain swapPiece');
  assert.match(pickRes, /Crisp White Linen Shirt/);
  assert.match(pickRes, /Say the exact product name "Crisp White Linen Shirt"/);
  assert.match(pickRes, /\$193/);
  assert.equal(tryOnCalls, tryOnBefore + 1);
  assert.equal(collageCalls, collageBefore + 1);

  const updateCall = calls.find((c) => c.action === 'updateOutfit');
  assert.ok(updateCall, 'updateOutfit must be sent on pick swap');
  const updatedData = (updateCall!.payload as PageActions['updateOutfit']).data;
  assert.equal(updatedData.total, 193);
  assert.equal(updatedData.pieces.find((p) => p.slot === 'top')?.item.id, 'shirt-linen-1');
  assert.equal(updatedData.pieces.find((p) => p.slot === 'bottom')?.item.price, 60);
  assert.equal(updatedData.pieces.find((p) => p.slot === 'shoes')?.item.price, 55);

  const swapLog = logs.find((l) => l.ev === 'swap');
  assert.ok(swapLog);
  assert.equal(swapLog!.data?.pick, 1);
  assert.equal(swapLog!.data?.title, 'Crisp White Linen Shirt');
  assert.equal(swapLog!.data?.total, 193);

  // 5) Free-text swap path ALSO includes exact new product name and instructs her to say it.
  const freeRes = await tools.swap_piece.execute(
    { slot: 'shoes', request: 'brown suede loafers' },
    fakeToolOpts('sw-free'),
  );
  assert.equal(brainSwapCalls, 1);
  assert.match(freeRes, /Swapped shoes \(brown suede loafers\)/);
  assert.match(freeRes, /Say the exact product name "Swapped shoes \(brown suede loafers\)"/);
});

test('polish11: fast build_outfits (<4s) begins with ALREADY on screen prefix, look-on-screen cancels filler before 4s, add_to_bag has no filler, and swap_piece passes known sizes', async () => {
  const { page } = createFakePage();
  const clock = createFakeClock();
  const notes: WorkingNoteParams[] = [];
  const state = createCallStateStore({ roomName: 'r-p11', log: () => {} });
  const sample = makeSampleOutfits();

  assert.equal('add_to_bag' in SLOW_TOOL_NOTES, false, 'add_to_bag must be removed from SLOW_TOOL_NOTES');

  // 1) Fast build (< 4s, e.g. 1s library): begins with exact ALREADY on screen prefix and sends zero fillers.
  const fastTools = createAgentTools({
    room: 'r-p11-fast',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendWorkingNote: (n) => {
      notes.push(n);
      return true;
    },
    page,
    state,
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        await new Promise<void>((r) => clock.setTimeoutFn(r, 1_000));
        sample.forEach((o, i) => opts?.onOutfit?.(structuredClone(o), i));
        return {
          outfits: structuredClone(sample),
          source: 'library',
          timing: { first_outfit_ms: 450, total_ms: 1_000 },
          problems: [],
        };
      },
      async addToBag(outfit, sizes, gender) {
        await new Promise<void>((r) => clock.setTimeoutFn(r, 5_000));
        return makeFakeDeps().addToBag!(outfit, sizes, gender);
      },
    }),
  });

  await fastTools.set_department.execute({ department: 'men' }, fakeToolOpts('p11-d1'));
  const fastPromise = fastTools.build_outfits.execute(
    { occasion: 'dinner', budget_usd: 250 },
    fakeToolOpts('p11-b1'),
  );
  await clock.advance(1_000);
  const fastRes = await fastPromise;
  await clock.advance(6_000);

  assert.equal(
    fastRes.startsWith(
      'The looks are ALREADY on screen. Do not say you are pulling or building anything and do not say they are finally in: present them now.',
    ),
    true,
    `fast build_outfits (<4s) must begin with ALREADY on screen prefix, got: ${fastRes}`,
  );
  assert.equal(notes.length, 0, 'fast build_outfits (<4s) must emit zero filler/working notes');

  // 2) add_to_bag never sends a filler/working note even if it takes 5s.
  const bagPromise = fastTools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('p11-bag1'),
  );
  await clock.advance(5_000);
  await bagPromise;
  assert.equal(notes.length, 0, 'add_to_bag must never speak a filler/working note');

  // 3) build_outfits where first look lands at 2.5s (before 4s) and rest finish at 5.5s: ZERO fillers because a look is already on screen!
  let resolveRest!: () => void;
  const restGate = new Promise<void>((r) => {
    resolveRest = r;
  });
  let triggerFirstLook!: () => void;
  const firstLookGate = new Promise<void>((r) => {
    triggerFirstLook = r;
  });

  const partialTools = createAgentTools({
    room: 'r-p11-partial',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendWorkingNote: (n) => {
      notes.push(n);
      return true;
    },
    page,
    state: createCallStateStore({ roomName: 'r-p11-partial', log: () => {} }),
    deps: makeFakeDeps({
      async buildOutfits(_brief, opts) {
        await firstLookGate;
        opts?.onOutfit?.(structuredClone(sample[0]!), 0);
        await restGate;
        opts?.onOutfit?.(structuredClone(sample[1]!), 1);
        return {
          outfits: structuredClone(sample),
          source: 'live',
          timing: { first_outfit_ms: 2_500, total_ms: 5_500 },
          problems: [],
        };
      },
    }),
  });
  await partialTools.set_department.execute({ department: 'men' }, fakeToolOpts('p11-d2'));
  const partialPromise = partialTools.build_outfits.execute(
    { occasion: 'wedding', budget_usd: 300 },
    fakeToolOpts('p11-b2'),
  );
  await clock.advance(2_500);
  triggerFirstLook();
  await flushMicrotasks();
  await clock.advance(3_000); // now at 5.5s total, past 4s, with Look 1 already on screen
  assert.equal(notes.length, 0, 'once a look is on screen before 4s, no build_outfits filler may fire');
  resolveRest();
  await partialPromise;

  // 4) swap_piece passes { room, sizes } with ONLY the known sizes (top/bottom/shoes) from call state.
  const capturedOpts: Array<SwapOptions | undefined> = [];
  const swapState = createCallStateStore({ roomName: 'r-p11-swap', log: () => {} });
  const swapTools = createAgentTools({
    room: 'r-p11-swap',
    log: () => {},
    page,
    state: swapState,
    deps: makeFakeDeps({
      async swapPiece(outfit, slot, request, brief, opts) {
        capturedOpts.push(opts);
        return makeFakeDeps().swapPiece!(outfit, slot, request, brief, opts);
      },
    }),
  });
  await swapTools.set_department.execute({ department: 'men' }, fakeToolOpts('sw-d1'));
  await swapTools.build_outfits.execute({ occasion: 'dinner', budget_usd: 250 }, fakeToolOpts('sw-b1'));
  await swapTools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('sw-p1'));

  // Before any sizes are known: sizes omitted.
  await swapTools.swap_piece.execute({ slot: 'shoes', request: 'loafers' }, fakeToolOpts('sw-1'));
  assert.equal(capturedOpts[0]?.room, 'r-p11-swap');
  assert.equal(capturedOpts[0]?.sizes, undefined);

  // After top and shoes are known (bottom still unknown): passes only { top, shoes }.
  swapState.dispatch({ type: 'merge_sizes', sizes: { top: 'M', shoes: '10.5' } });
  await swapTools.swap_piece.execute({ slot: 'shoes', request: 'brown boots' }, fakeToolOpts('sw-2'));
  assert.deepEqual(capturedOpts[1], {
    room: 'r-p11-swap',
    sizes: { top: 'M', shoes: '10.5' },
  });
  assert.equal('bottom' in (capturedOpts[1]?.sizes ?? {}), false);

  // After bottom is also known: passes all three.
  swapState.dispatch({ type: 'merge_sizes', sizes: { bottom: '32x30' } });
  await swapTools.swap_piece.execute({ slot: 'bottom', request: 'dark chinos' }, fakeToolOpts('sw-3'));
  assert.deepEqual(capturedOpts[2], {
    room: 'r-p11-swap',
    sizes: { top: 'M', bottom: '32x30', shoes: '10.5' },
  });
});
