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
import type { SearchOpts } from '../src/store/catalog.ts';
import type { BagLineAdded, BagLineNotAdded } from '../src/store/index.ts';
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  DUPLICATE_WINDOW_MS,
  TOOL_ERROR_FALLBACK,
  createAgentTools,
  createToolWrapper,
  deriveProductDetails,
  sanitizePageMediaUrl,
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

test('createAgentTools builds 11 anonymous tools accepted by LiveKit ToolContext', () => {
  const tools = createAgentTools({ room: 'test-room', log: () => {} });
  const expectedNames = [
    'remember',
    'set_department',
    'build_outfits',
    'pick_outfit',
    'show_on_me',
    'swap_piece',
    'add_to_bag',
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

  // Slow working note sent immediately.
  assert.equal(notes.filter((n) => n.name === 'build_outfits').length, 2);
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
  assert.match(picked, /Knit texture elevates the neckline/);
  assert.match(picked, /Try-on is ready/i);

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
  // Provide only top -> NOT DONE naming shoes, and top size is remembered in state!
  const notDone = await tools.add_to_bag.execute({ sizes: { top: 'M' } }, fakeToolOpts('bag1'));
  assert.equal(notDone.startsWith('NOT DONE:'), true);
  assert.match(notDone, /\bshoes\b/);
  assert.doesNotMatch(notDone, /\btop\b/);
  assert.doesNotMatch(notDone, /\bbottom\b/);
  assert.equal(state.get().sizes.top, 'M');
  assert.equal(storeAddCalls, 0);

  // Next call supplies ONLY shoes -> merges with remembered top=M and succeeds!
  const added = await tools.add_to_bag.execute({ sizes: { shoes: '10' } }, fakeToolOpts('bag2'));
  assert.equal(storeAddCalls, 1);
  assert.match(added, /^Added 2 pieces, total \$105/);
  assert.match(added, /Everlane:.*Merino Knit Polo - Espresso \(size M\)/);
  assert.match(added, /Not added \(1\):.*Minimal Leather Sneaker - White.*Size 10 is sold out/);
  assert.match(added, /Checkout link is on the page \(Everlane\)/);

  const bagCall = calls.find((c) => c.action === 'bagReady');
  assert.ok(bagCall);
  const bagPayload = bagCall!.payload as PageActions['bagReady'];
  assert.equal(bagPayload.total, 105);
  assert.deepEqual(bagPayload.links, [{ store: 'Everlane', url: 'https://everlane.com/cart/1' }]);
  assert.equal(bagPayload.stores.length, 2);
  assert.equal(bagPayload.stores[1]!.not_added[0]!.reason, 'Size 10 is sold out.');

  const bagLog = logs.find((l) => l.ev === 'bag');
  assert.ok(bagLog);
  assert.equal(bagLog!.data?.total, 105);

  // Advance past 15s wrapper duplicate window -> bag dedupe STILL catches exact same look+sizes!
  clockNow += DUPLICATE_WINDOW_MS + 1_000;
  const deduped = await tools.add_to_bag.execute(
    { outfit: 1, sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('bag3'),
  );
  assert.equal(storeAddCalls, 1, 'bag dedupe must not call addToBag a second time');
  assert.match(deduped, /^Already in the bag\./);
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

test('add_to_bag honors store NOT DONE missing-size response without sending bagReady or marking state done', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-bag-notdone', log: () => {} });
  let storeAddCalls = 0;

  const tools = createAgentTools({
    room: 'r-bag-notdone',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
      async loadStoreModule() {
        return {
          async addToBag(_outfit, sizes): Promise<BagOut> {
            storeAddCalls++;
            // Simulate store discovering bottom (whose Item.sizes was []) actually needs a size.
            if (!sizes.bottom) {
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
            return {
              carts: [
                {
                  store: 'Everlane',
                  store_domain: 'everlane.myshopify.com',
                  cart_id: 'cart-ev-real',
                  continue_url: 'https://everlane.com/cart/c/real',
                  total_usd: 105,
                  added: [topAdded, bottomAdded],
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
              summary: 'Everlane: 2 added, $105.00. Minimal Leather Sneaker - White: 10 is sold out; nearest 10.5. 1 checkout link ready.',
              total_usd: 105,
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

  // First call supplies top + shoes; store discovers bottom still needs a size.
  const firstRes = await tools.add_to_bag.execute(
    { sizes: { top: 'M', shoes: '10' } },
    fakeToolOpts('bag-nd-1'),
  );
  assert.equal(storeAddCalls, 1);
  assert.equal(firstRes.startsWith('NOT DONE:'), true);
  assert.match(firstRes, /Pleated Wool Trouser - Charcoal \(bottom\)/);
  assert.equal(
    calls.some((c) => c.action === 'bagReady'),
    false,
    'bagReady must NOT be sent when store returns NOT DONE',
  );
  assert.equal(state.get().bag, null, 'flow state must NOT record bag as done');

  // Second call supplies missing bottom size -> real cart created -> done!
  const secondRes = await tools.add_to_bag.execute(
    { sizes: { bottom: '32' } },
    fakeToolOpts('bag-nd-2'),
  );
  assert.equal(storeAddCalls, 2);
  assert.equal(secondRes.startsWith('NOT DONE:'), false);
  assert.match(secondRes, /^Added 2 pieces, total \$105/);
  assert.match(secondRes, /Checkout link is on the page \(Everlane\)/);
  assert.ok(state.get().bag, 'flow state must record bag once a real cart exists');

  const bagCall = calls.find((c) => c.action === 'bagReady');
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

test('add_to_bag result leads with added count and total, then not-added pieces with reasons, then checkout links on the page', async () => {
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

  const addedIdx = res.indexOf('Added 3 pieces, total $155');
  const notAddedIdx = res.indexOf('Not added (2):');
  const sandalIdx = res.indexOf('Strappy Sandal at Fashion Nova (Size 8 is out of stock)');
  const clutchIdx = res.indexOf('Mini Clutch at Fashion Nova (Size could not be selected)');
  const linkIdx = res.indexOf('Checkout link is on the page (Fashion Nova)');

  assert.equal(addedIdx, 0, `expected result to lead with added count and total, got: ${res}`);
  assert.ok(notAddedIdx > addedIdx, 'not-added section must come after added count and total');
  assert.ok(sandalIdx > notAddedIdx && clutchIdx > notAddedIdx, 'each not-added piece and reason must be listed');
  assert.ok(linkIdx > clutchIdx, 'checkout link location must follow the not-added pieces');
  assert.match(res, /never say the bag is processing/i);
  assert.match(res, /never pitch a different look/i);
  assert.match(res, /offer to swap those pieces or try another size/i);
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
