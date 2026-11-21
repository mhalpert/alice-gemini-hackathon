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
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  DUPLICATE_WINDOW_MS,
  TOOL_ERROR_FALLBACK,
  createAgentTools,
  createToolWrapper,
  deriveProductDetails,
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
  // Budget capped at 10000.
  assert.equal(capturedBrief!.budget_usd, 10_000);
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
  assert.match(show1Res, /revealed on screen/i);
  assert.match(show1Res, /no camera snapshot/i);
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
  assert.match(show2Res, /no camera snapshot/i);
});

test('swap_piece updates state, sends updateOutfit, restarts try-on & collage, and logs swap', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-swap', log: () => {} });
  let tryOnCalls = 0;
  let collageCalls = 0;

  const tools = createAgentTools({
    room: 'r-swap',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeFakeDeps({
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
  assert.match(added, /Bag is ready on screen/i);
  assert.match(added, /Everlane:.*Merino Knit Polo - Espresso \(size M\)/);
  assert.match(added, /Size 10 is sold out/);
  assert.match(added, /\$105/);

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
