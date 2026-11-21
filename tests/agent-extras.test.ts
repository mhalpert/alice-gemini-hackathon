import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BuildResult,
  Item,
  Outfit,
  PageActionName,
  PageActionReply,
  PageActions,
} from '../src/types.ts';
import type { TimerHandle } from '../src/agent/context.ts';
import {
  DEFAULT_EXTRA_ANNOUNCE_MAX_WAIT_MS,
  buildExtraAnnounceInstruction,
  createExtraAnnouncer,
  shortenSettingPhrase,
} from '../src/agent/extras.ts';
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  DEFAULT_SCENE_REVEAL_DELAY_MS,
  DEFAULT_VIDEO_REVEAL_DELAY_MS,
  createAgentTools,
  resolveTryOnExtras,
  type TimerLike,
  type ToolDeps,
  type TryOnExtrasOptions,
  type TryOnExtrasResult,
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

function createFakePage(): { page: PageSender; calls: PageCall[] } {
  const calls: PageCall[] = [];
  const page: PageSender = {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageActionReply> {
      calls.push({ action, payload });
      return { ok: true };
    },
  };
  return { page, calls };
}

function createFakeClock(start = 10_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  const setTimeoutFn = (fn: () => void, ms: number): TimerLike & TimerHandle => {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, fn });
    return { id } as unknown as TimerLike & TimerHandle;
  };

  const clearTimeoutFn = (handle: TimerLike | TimerHandle): void => {
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    variant_id: 'var-1',
    title: 'Silk Midi Dress - Navy',
    price: 120,
    url: 'https://example.com/dress',
    image: 'https://cdn.shopify.com/dress.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.8,
    rating_count: 42,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'var-s', M: 'var-m', L: 'var-l' },
    description: '100% silk midi dress with bias drape.',
    department: 'women',
    ...overrides,
  };
}

function makeThreeOutfits(): Outfit[] {
  return [
    {
      number: 1,
      name: 'Rooftop Silk',
      difference: 'Bias-cut silk midi with strappy heels.',
      story: 'Effortless rooftop polish.',
      pieces: [{ slot: 'dress', why: 'Moves cleanly in the breeze.', item: makeItem() }],
      total: 120,
    },
    {
      number: 2,
      name: 'SoHo Tailored',
      difference: 'Crisp linen vest and wide trousers.',
      story: 'Sharp gallery line.',
      pieces: [
        {
          slot: 'top',
          why: 'Structured waist.',
          item: makeItem({ id: 'item-2', variant_id: 'var-2', title: 'Linen Vest - Ivory' }),
        },
      ],
      total: 140,
    },
    {
      number: 3,
      name: 'West Village Knit',
      difference: 'Ribbed knit set with loafers.',
      story: 'Relaxed dinner look.',
      pieces: [
        {
          slot: 'top',
          why: 'Soft texture.',
          item: makeItem({ id: 'item-3', variant_id: 'var-3', title: 'Ribbed Knit Top' }),
        },
      ],
      total: 110,
    },
  ];
}

function makeBaseDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const outfits = makeThreeOutfits();
  return {
    async buildOutfits(_brief, opts): Promise<BuildResult> {
      const cloned = structuredClone(outfits);
      cloned.forEach((o, i) => opts?.onOutfit?.(o, i));
      return {
        outfits: cloned,
        source: 'library',
        timing: { first_outfit_ms: 50, total_ms: 100 },
        problems: [],
      };
    },
    async outfitCollage(outfit) {
      return `https://media.local/collage-${outfit.number ?? 1}.jpg`;
    },
    async tryOn(_jpeg, outfit) {
      return {
        url: `https://media.local/studio-${outfit.number ?? 1}.jpg`,
        path: `/tmp/studio-${outfit.number ?? 1}.jpg`,
        ms: 40,
        id: `studio-${outfit.number ?? 1}`,
      };
    },
    async loadStoreModule() {
      return null;
    },
    ...overrides,
  };
}

test('resolveTryOnExtras guards missing export and absent function is a clean no-op with zero extra logs', async () => {
  assert.equal(resolveTryOnExtras({}), undefined);
  assert.equal(resolveTryOnExtras(null), undefined);
  const fakeFn = async () => ({ scene: null, video: null, setting: '' });
  assert.equal(resolveTryOnExtras({ tryOnExtras: fakeFn }), fakeFn);

  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-absent', log: () => {} });

  const tools = createAgentTools({
    room: 'r-absent',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeBaseDeps({ tryOnExtras: null }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'rooftop wedding', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();

  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await flushMicrotasks();

  const revealRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(revealRes, /revealed on screen/i);
  assert.doesNotMatch(revealRes, /on-location|video/i);

  assert.equal(
    logs.some((l) => l.ev === 'tryon_extras_start' || l.ev === 'tryon_extra' || l.ev === 'extra_announce'),
    false,
    'absent tryOnExtras must log nothing per call',
  );
  const extraPageCalls = calls.filter(
    (c) =>
      (c.action === 'tryOnReady' && (c.payload as PageActions['tryOnReady']).kind !== undefined) ||
      (c.action === 'reveal' && (c.payload as PageActions['reveal']).kind !== undefined),
  );
  assert.equal(extraPageCalls.length, 0);
});

test('tryOnExtras starts once on pick when studio is done, on studio completion when pending, never for unpicked looks, and passes brief + weather', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-start', log: () => {} });

  let resolveStudio2!: (v: { url: string; path: string; ms: number; id: string }) => void;
  const studio2Gate = new Promise<{ url: string; path: string; ms: number; id: string }>((r) => {
    resolveStudio2 = r;
  });

  const startedCalls: Array<{ studioPath: string; outfitNum: number; opts: TryOnExtrasOptions }> = [];
  const neverExtras = new Promise<TryOnExtrasResult>(() => {});

  const tools = createAgentTools({
    room: 'r-start',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    duplicateWindowMs: 1_000,
    page,
    state,
    deps: makeBaseDeps({
      async forecast() {
        return { ok: true, line: '72F and clear in Brooklyn Saturday evening' };
      },
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 2) return studio2Gate;
        return {
          url: `https://media.local/studio-${outfit.number}.jpg`,
          path: `/tmp/studio-${outfit.number}.jpg`,
          ms: 25,
          id: `st-${outfit.number}`,
        };
      },
      async tryOnExtras(studio, outfit, opts) {
        startedCalls.push({ studioPath: studio.path, outfitNum: outfit.number ?? 0, opts });
        return neverExtras;
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'rooftop birthday', budget_usd: 300, where: 'Brooklyn', when: 'Saturday' },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();

  // Studio finished for Look 1 and Look 3, still pending for Look 2; nothing picked -> zero extras started.
  assert.equal(startedCalls.length, 0, 'must never start extras for unpicked looks');

  // 1) Pick Look 1 (studio already done) -> starts immediately without blocking pick_outfit.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(startedCalls.length, 1);
  assert.equal(startedCalls[0]!.outfitNum, 1);
  assert.equal(startedCalls[0]!.studioPath, '/tmp/studio-1.jpg');
  assert.equal(startedCalls[0]!.opts.occasion, 'rooftop birthday');
  assert.equal(startedCalls[0]!.opts.where, 'Brooklyn');
  assert.equal(startedCalls[0]!.opts.when, 'Saturday');
  assert.equal(startedCalls[0]!.opts.weather, '72F and clear in Brooklyn Saturday evening');

  // Picking Look 1 again later (past duplicate window) must NOT start extras a second time.
  await clock.advance(2_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1-again'));
  assert.equal(startedCalls.length, 1, 'must start extras at most once per picked look');

  // 2) Pick Look 2 while studio try-on is still rendering -> does NOT start yet, does NOT block pick_outfit.
  await tools.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p2'));
  assert.equal(startedCalls.length, 1, 'must wait for Look 2 studio try-on to finish');

  // Complete Look 2 studio try-on -> extras start immediately for Look 2.
  resolveStudio2({
    url: 'https://media.local/studio-2.jpg',
    path: '/tmp/studio-2.jpg',
    ms: 3000,
    id: 'st-2',
  });
  await flushMicrotasks();

  assert.equal(startedCalls.length, 2);
  assert.equal(startedCalls[1]!.outfitNum, 2);
  assert.equal(startedCalls[1]!.studioPath, '/tmp/studio-2.jpg');

  // Look 3 was never picked -> never started.
  assert.equal(
    startedCalls.some((c) => c.outfitNum === 3),
    false,
    'unpicked Look 3 must never start extras',
  );

  const startLogs = logs.filter((l) => l.ev === 'tryon_extras_start');
  assert.deepEqual(
    startLogs.map((l) => l.data),
    [{ outfit: 1 }, { outfit: 2 }],
  );
});

test('pre-reveal extras send tryOnReady with kind, stay silent before studio reveal, appear in show_on_me result, and reveal at +6s and +8s', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-pre', log: () => {} });

  const announcer = createExtraAnnouncer({
    room: 'r-pre',
    initialAgentState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-pre',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    onExtraLanded: (ev) => announcer.announce(ev),
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'SoHo gallery opening', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // Scene and video both land BEFORE show_on_me.
  capturedOnRender!({
    kind: 'scene',
    ok: true,
    url: 'https://media.local/scene-1.jpg',
    ms: 12_000,
  });
  capturedOnRender!({
    kind: 'video',
    ok: true,
    url: 'https://media.local/video-1.mp4',
    ms: 28_000,
  });
  await flushMicrotasks();

  // Only tryOnReady sent (with kind); NO reveal, NO spoken announce before studio reveal.
  assert.deepEqual(calls, [
    {
      action: 'tryOnReady',
      payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' },
    },
    {
      action: 'tryOnReady',
      payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' },
    },
  ]);
  assert.equal(replies.length, 0, 'nothing spoken before studio reveal');

  // Recorded in state and summarized as short flags without URLs.
  assert.equal(state.get().tryOnExtras[1]?.scene, 'https://media.local/scene-1.jpg');
  assert.equal(state.get().tryOnExtras[1]?.video, 'https://media.local/video-1.mp4');
  const summary = state.summarize();
  assert.match(summary, /scene ready/);
  assert.match(summary, /video ready/);
  assert.doesNotMatch(summary, /media\.local/);

  // Logged tryon_extra for both renders.
  const extraLogs = logs.filter((l) => l.ev === 'tryon_extra');
  assert.deepEqual(
    extraLogs.map((l) => l.data),
    [
      { outfit: 1, kind: 'scene', ok: true, ms: 12_000 },
      { outfit: 1, kind: 'video', ok: true, ms: 28_000 },
    ],
  );

  // Now show_on_me reveals studio -> result mentions both ready extras, then reveals scene at +6s and video +8s after scene.
  calls.length = 0;
  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(showRes, /on-location still and a short video/i);
  assert.match(showRes, /bringing up the on-location shot/i);

  // Immediately after show_on_me: only studio reveal was sent.
  const reveals = () => calls.filter((c) => c.action === 'reveal');
  assert.deepEqual(reveals(), [
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/studio-1.jpg' } },
  ]);

  // At 5.999s: scene not revealed yet.
  await clock.advance(DEFAULT_SCENE_REVEAL_DELAY_MS - 1);
  assert.equal(reveals().length, 1);

  // At 6.000s: scene revealed with kind: 'scene'.
  await clock.advance(1);
  assert.deepEqual(reveals().at(-1), {
    action: 'reveal',
    payload: { outfit: 1, kind: 'scene' },
  });

  // 7.999s after scene: video not revealed yet.
  await clock.advance(DEFAULT_VIDEO_REVEAL_DELAY_MS - 1);
  assert.equal(reveals().length, 2);

  // 8.000s after scene: video revealed with kind: 'video'.
  await clock.advance(1);
  assert.deepEqual(reveals().at(-1), {
    action: 'reveal',
    payload: { outfit: 1, kind: 'video' },
  });
  assert.equal(replies.length, 0, 'pre-ready reveals rely on show_on_me tool result');
});

test('show_on_me mentions only scene when video has not landed yet (never promises unlanded video)', async () => {
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-scene-only', log: () => {} });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-scene-only',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'rooftop cocktails', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  capturedOnRender!({
    kind: 'scene',
    ok: true,
    url: 'https://media.local/scene-1.jpg',
    ms: 11_000,
  });
  await flushMicrotasks();
  calls.length = 0;

  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(showRes, /on-location still/i);
  assert.doesNotMatch(showRes, /video/i, 'must never promise a video before it lands');

  await clock.advance(DEFAULT_SCENE_REVEAL_DELAY_MS);
  assert.deepEqual(calls.at(-1), { action: 'reveal', payload: { outfit: 1, kind: 'scene' } });

  // No video reveal fires after 8s because video never landed.
  await clock.advance(DEFAULT_VIDEO_REVEAL_DELAY_MS + 5_000);
  assert.equal(
    calls.some((c) => c.action === 'reveal' && (c.payload as PageActions['reveal']).kind === 'video'),
    false,
  );
});

test('late-landing extra after studio reveal sends tryOnReady, reveal, and announces once when idle, or waits/skips while speaking', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-late', log: () => {} });

  const announcer = createExtraAnnouncer({
    room: 'r-late',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  let resolveExtras!: (res: TryOnExtrasResult) => void;
  const extrasGate = new Promise<TryOnExtrasResult>((r) => {
    resolveExtras = r;
  });

  const tools = createAgentTools({
    room: 'r-late',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    onToolStart: (ev) => announcer.onToolStart(ev.callId),
    onToolEnd: (ev) => announcer.onToolEnd(ev.callId),
    onExtraLanded: (ev) => announcer.announce(ev),
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return extrasGate;
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'sunset rooftop bar', budget_usd: 300, where: 'Manhattan' },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));

  // Studio reveal happens BEFORE extras land.
  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.doesNotMatch(showRes, /Also ready:/);
  calls.length = 0;

  // 1) Scene lands while idle -> tryOnReady, then reveal, then ONE spoken announce!
  capturedOnRender!({
    kind: 'scene',
    ok: true,
    url: 'https://media.local/scene-1.jpg',
    ms: 13_000,
  });
  await flushMicrotasks();

  assert.deepEqual(calls, [
    {
      action: 'tryOnReady',
      payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' },
    },
    {
      action: 'reveal',
      payload: { outfit: 1, kind: 'scene' },
    },
  ]);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /on-location shot/i);
  assert.match(replies[0]!.instructions, /Manhattan sunset rooftop bar/i);
  assert.match(replies[0]!.instructions, /do not ask a question/i);
  assert.deepEqual(
    logs.filter((l) => l.ev === 'extra_announce').map((l) => l.data),
    [{ outfit: 1, kind: 'scene', spoken: true }],
  );

  // 2) Video lands while Alice is speaking -> still sends tryOnReady + reveal, NO announce while speaking!
  calls.length = 0;
  announcer.onAgentStateChanged('speaking');
  capturedOnRender!({
    kind: 'video',
    ok: true,
    url: 'https://media.local/video-1.mp4',
    ms: 30_000,
  });
  resolveExtras({
    scene: { url: 'https://media.local/scene-1.jpg', path: '/tmp/scene-1.jpg', ms: 13_000 },
    video: { url: 'https://media.local/video-1.mp4', path: '/tmp/video-1.mp4', ms: 30_000 },
    setting: 'a candlelit Manhattan rooftop terrace at dusk',
  });
  await flushMicrotasks();

  assert.deepEqual(calls, [
    {
      action: 'tryOnReady',
      payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' },
    },
    {
      action: 'reveal',
      payload: { outfit: 1, kind: 'video' },
    },
  ]);
  assert.equal(replies.length, 1, 'must not announce while Alice is speaking');

  // Still speaking for the entire 10s window -> skips spoken line and logs spoken: false.
  await clock.advance(DEFAULT_EXTRA_ANNOUNCE_MAX_WAIT_MS);
  assert.equal(replies.length, 1, 'must skip speech after 10s timeout');
  assert.deepEqual(
    logs.filter((l) => l.ev === 'extra_announce').map((l) => l.data),
    [
      { outfit: 1, kind: 'scene', spoken: true },
      { outfit: 1, kind: 'video', spoken: false },
    ],
  );

  // Even when Alice later returns to listening, expired announce must not fire.
  announcer.onAgentStateChanged('listening');
  await clock.advance(5_000);
  assert.equal(replies.length, 1);
});

test('extraAnnouncer retries while shopper speaks or a tool runs, speaks once idle within 10s, and disposes cleanly', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];

  const announcer = createExtraAnnouncer({
    room: 'r-ann',
    initialAgentState: 'listening',
    initialUserState: 'speaking',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Shopper is speaking -> queued, not spoken yet.
  announcer.announce({
    outfit: 1,
    kind: 'video',
    setting: 'a warm candlelit trattoria in SoHo',
  });
  assert.equal(replies.length, 0);
  assert.equal(announcer.hasPending, true);

  // 3s later shopper stops speaking, but a tool is running -> still waits.
  announcer.onToolStart('call-swap');
  await clock.advance(3_000);
  announcer.onUserStateChanged('listening');
  assert.equal(replies.length, 0, 'must not speak while a tool is running');

  // 2s later tool finishes (5s total < 10s) -> speaks once!
  await clock.advance(2_000);
  announcer.onToolEnd('call-swap');
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /short video/i);
  assert.match(replies[0]!.instructions, /warm candlelit trattoria/i);
  assert.equal(announcer.hasPending, false);
  assert.deepEqual(logs.at(-1)?.data, { outfit: 1, kind: 'video', spoken: true });

  // Disposing clears pending timers and suppresses future announcements.
  announcer.onAgentStateChanged('speaking');
  announcer.announce({ outfit: 2, kind: 'scene', setting: 'Brooklyn loft party' });
  assert.equal(clock.activeTimers(), 1);
  announcer.dispose();
  assert.equal(clock.activeTimers(), 0);
  assert.equal(announcer.hasPending, false);
  await clock.advance(15_000);
  assert.equal(replies.length, 1);
});

test('failed extra part produces no page action, no state entry, and no speech; empty studio path skips extras', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-fail', log: () => {} });

  const announcer = createExtraAnnouncer({
    room: 'r-fail',
    initialAgentState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  let extrasCalls = 0;
  const tools = createAgentTools({
    room: 'r-fail',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    onExtraLanded: (ev) => announcer.announce(ev),
    deps: makeBaseDeps({
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 2) {
          // Simulates camera-off / no local studio path produced.
          return { url: 'https://media.local/studio-2.jpg', path: '', ms: 20, id: 'st-2' };
        }
        return {
          url: `https://media.local/studio-${outfit.number}.jpg`,
          path: `/tmp/studio-${outfit.number}.jpg`,
          ms: 20,
          id: `st-${outfit.number}`,
        };
      },
      async tryOnExtras(_studio, _outfit, opts) {
        extrasCalls += 1;
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();

  // Picking Look 2 (empty studio path) does not start extras.
  await tools.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p2'));
  assert.equal(extrasCalls, 0);

  // Pick Look 1 and reveal studio first.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(extrasCalls, 1);
  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  calls.length = 0;

  // Both parts fail.
  capturedOnRender!({ kind: 'scene', ok: false, ms: 9_000 });
  capturedOnRender!({ kind: 'video', ok: true, url: '/local/bad/path.mp4', ms: 15_000 });
  await flushMicrotasks();

  assert.equal(calls.length, 0, 'failed part must produce no page action');
  assert.equal(replies.length, 0, 'failed part must produce no speech');
  assert.equal(state.get().tryOnExtras[1], undefined, 'failed part must not be stored in state');
  assert.deepEqual(
    logs.filter((l) => l.ev === 'tryon_extra').map((l) => l.data),
    [
      { outfit: 1, kind: 'scene', ok: false, ms: 9_000 },
      { outfit: 1, kind: 'video', ok: false, ms: 15_000 },
    ],
  );
});

test('aborting session signal disposes pending scene/video reveal timers cleanly', async () => {
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-abort', log: () => {} });
  const abort = new AbortController();

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-abort',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    signal: abort.signal,
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'rooftop', budget_usd: 300 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  // Let the 1-piece highlight walk finish so only the extra reveal timer remains after show_on_me.
  await clock.advance(3_000);

  capturedOnRender!({
    kind: 'scene',
    ok: true,
    url: 'https://media.local/scene-1.jpg',
    ms: 10_000,
  });
  await flushMicrotasks();

  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  calls.length = 0;

  assert.equal(clock.activeTimers(), 1, 'scene reveal timer must be armed');
  abort.abort();
  assert.equal(clock.activeTimers(), 0, 'abort must clear all pending extra reveal timers');

  await clock.advance(30_000);
  assert.equal(calls.length, 0);
});

test('shortenSettingPhrase and buildExtraAnnounceInstruction format concise setting without questions', () => {
  assert.equal(shortenSettingPhrase('a candlelit Italian trattoria in SoHo'), 'candlelit Italian trattoria');
  assert.equal(shortenSettingPhrase('rooftop bar at sunset'), 'rooftop bar at sunset');
  assert.equal(shortenSettingPhrase(''), '');

  const sceneInstr = buildExtraAnnounceInstruction('scene', 'a candlelit Italian trattoria in SoHo');
  assert.match(sceneInstr, /on-location shot/i);
  assert.match(sceneInstr, /candlelit Italian trattoria/);
  assert.match(sceneInstr, /do not ask a question/i);
  assert.equal(sceneInstr.includes('?'), false);

  const videoInstr = buildExtraAnnounceInstruction('video', 'rooftop bar at sunset');
  assert.match(videoInstr, /short video/i);
  assert.match(videoInstr, /rooftop bar at sunset/);
  assert.equal(videoInstr.includes('?'), false);
});
