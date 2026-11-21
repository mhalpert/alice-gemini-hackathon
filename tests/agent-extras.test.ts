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
  DEFAULT_EXTRA_WAIT_TIMEOUT_MS,
  DEFAULT_SCENE_HOLD_MS,
  DEFAULT_SIZES_FALLBACK_MS,
  DEFAULT_STUDIO_HOLD_MS,
  SCENE_REVEAL_VARIANT_COUNT,
  STUDIO_REVEAL_VARIANT_COUNT,
  VIDEO_REVEAL_VARIANT_COUNT,
  buildSceneRevealInstruction,
  buildSceneRevealLine,
  buildStudioRevealInstruction,
  buildStudioRevealLine,
  buildSwapStudioRevealInstruction,
  buildVideoRevealInstruction,
  buildVideoRevealLine,
  createRevealSequencer,
  shortenSettingPhrase,
} from '../src/agent/extras.ts';
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  createAgentTools,
  resolvePrewarmScene,
  resolveTryOnExtras,
  type PrewarmSceneOptions,
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
    const target = now + ms;
    while (true) {
      let nextKey: number | undefined;
      let nextAt = Infinity;
      for (const [k, entry] of timers.entries()) {
        if (entry.fireAt <= target && entry.fireAt < nextAt) {
          nextAt = entry.fireAt;
          nextKey = k;
        }
      }
      if (nextKey === undefined) break;
      const entry = timers.get(nextKey)!;
      timers.delete(nextKey);
      now = Math.max(now, entry.fireAt);
      entry.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
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
      pieces: [
        { slot: 'dress', why: 'Moves cleanly in the breeze.', item: makeItem() },
        {
          slot: 'shoes',
          why: 'Strappy heel lengthens the leg.',
          item: makeItem({
            id: 'item-1-sh',
            variant_id: 'var-1-sh',
            title: 'Strappy Sandal - Gold',
            price: 90,
            sizes: ['7', '8', '9'],
          }),
        },
      ],
      total: 210,
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
  assert.match(revealRes, /ask for their top and shoe sizes in one question/i);
  assert.doesNotMatch(revealRes, /do not ask for sizes yet/i);

  assert.equal(
    logs.some((l) => l.ev === 'tryon_extras_start' || l.ev === 'tryon_extra'),
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

  assert.equal(startedCalls.length, 0, 'must never start extras for unpicked looks');

  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(startedCalls.length, 1);
  assert.equal(startedCalls[0]!.outfitNum, 1);
  assert.equal(startedCalls[0]!.studioPath, '/tmp/studio-1.jpg');
  assert.equal(startedCalls[0]!.opts.occasion, 'rooftop birthday');
  assert.equal(startedCalls[0]!.opts.where, 'Brooklyn');
  assert.equal(startedCalls[0]!.opts.when, 'Saturday');
  assert.equal(startedCalls[0]!.opts.weather, '72F and clear in Brooklyn Saturday evening');

  await clock.advance(2_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1-again'));
  assert.equal(startedCalls.length, 1, 'must start extras at most once per picked look');

  await tools.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p2'));
  assert.equal(startedCalls.length, 1, 'must wait for Look 2 studio try-on to finish');

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
  assert.equal(startedCalls.some((c) => c.outfitNum === 3), false);

  const startLogs = logs.filter((l) => l.ev === 'tryon_extras_start');
  assert.deepEqual(
    startLogs.map((l) => l.data),
    [{ outfit: 1 }, { outfit: 2 }],
  );
});

test('sequencer plays studio -> scene (>=5s & after studio line) -> video (>=6s & after scene line) -> sizes once', async () => {
  const clock = createFakeClock(10_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-seq-ready', log: () => {} });

  const sequencer = createRevealSequencer({
    room: 'r-seq-ready',
    sendTryOnReady: (payload) => page.send('tryOnReady', payload),
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-seq-ready',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    revealSequencer: sequencer,
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'beach wedding', where: 'Capri', budget_usd: 300 },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // Both scene and video land BEFORE show_on_me — held in memory, NEVER sent to page before studio reveal!
  capturedOnRender!({ kind: 'video', ok: true, url: 'https://media.local/video-1.mp4', ms: 10_000 });
  capturedOnRender!({ kind: 'scene', ok: true, url: 'https://media.local/scene-1.jpg', ms: 12_000 });
  await flushMicrotasks();

  assert.deepEqual(calls, [], 'scene and video must NOT be sent to page before studio is revealed');
  assert.equal(replies.length, 0);

  // Beat 1: studio reveal via show_on_me -> Mike's studio narration + ONE short line, do NOT ask for sizes yet.
  calls.length = 0;
  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(showRes, /Here's what the outfit looks like on you\./);
  assert.match(showRes, /ONE short line/i);
  assert.match(showRes, /do not ask for sizes yet/i);
  assert.equal(sequencer.isActive, true);

  const reveals = () => calls.filter((c) => c.action === 'reveal');
  assert.deepEqual(reveals(), [
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/studio-1.jpg' } },
  ]);

  // Alice speaks her studio line from +500ms to +6500ms (past the 5s minimum hold!).
  await clock.advance(500);
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(DEFAULT_STUDIO_HOLD_MS); // now at +5500ms, still speaking!
  assert.equal(reveals().length, 1, 'Beat 2 must wait until Alice finishes her studio line');
  assert.equal(replies.length, 0);

  // Alice finishes studio line at +6500ms -> Beat 2 (scene) sends tryOnReady(scene) then reveal(scene)!
  await clock.advance(1_000);
  sequencer.onAgentStateChanged('listening');
  await flushMicrotasks();

  assert.deepEqual(calls.slice(-2), [
    { action: 'tryOnReady', payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' } },
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' } },
  ]);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /beach wedding in Capri/i);
  assert.match(replies[0]!.instructions, /do not ask a question/i);
  assert.match(replies[0]!.instructions, /do not invent/i);

  // Alice speaks her scene line from +500ms to +2500ms (finishes BEFORE 6s scene hold).
  await clock.advance(500);
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(2_000);
  sequencer.onAgentStateChanged('listening');

  // At +5999ms after scene reveal: video must NOT fire yet (6s minimum hold).
  await clock.advance(DEFAULT_SCENE_HOLD_MS - 2_501);
  assert.equal(reveals().length, 2, 'Beat 3 must respect 6s minimum hold on scene');
  assert.equal(replies.length, 1);

  // At +6000ms after scene reveal: Beat 3 (video) sends tryOnReady(video) then reveal(video)!
  await clock.advance(1);
  await flushMicrotasks();
  assert.deepEqual(calls.slice(-2), [
    { action: 'tryOnReady', payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' } },
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' } },
  ]);
  assert.equal(replies.length, 2);
  assert.match(replies[1]!.instructions, /in motion/i);
  assert.match(replies[1]!.instructions, /do not ask a question/i);

  // Alice speaks her video line, then finishes -> sizes question fires ONCE!
  await clock.advance(400);
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(2_200);
  assert.equal(replies.length, 2, 'sizes prompt must wait until video line finishes');

  sequencer.onAgentStateChanged('listening');
  assert.equal(replies.length, 3, 'sizes prompt must fire once after last beat line');
  assert.match(replies[2]!.instructions, /top and shoe sizes in one question/i);
  assert.equal(sequencer.isActive, false);

  // Advancing further fires nothing else (sizes asked strictly once).
  await clock.advance(30_000);
  assert.equal(replies.length, 3);

  const beatLogs = logs.filter((l) => l.ev === 'reveal_beat').map((l) => l.data);
  assert.deepEqual(beatLogs, [
    { outfit: 1, kind: 'studio', spoken: true, waited_ms: 0 },
    { outfit: 1, kind: 'scene', spoken: true, waited_ms: 6_500 },
    { outfit: 1, kind: 'video', spoken: true, waited_ms: 6_000 },
  ]);
});

test('late-landing scene waits up to 20s and video landing 0.3s later still holds scene for 6s minimum', async () => {
  const clock = createFakeClock(20_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-late-hold', log: () => {} });

  const sequencer = createRevealSequencer({
    room: 'r-late-hold',
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-late-hold',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    revealSequencer: sequencer,
    deps: makeBaseDeps({
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'rooftop gala', where: 'Manhattan', budget_usd: 300 },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  // Extras are still rendering when show_on_me runs -> studio tells Alice NOT to ask for sizes yet.
  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(showRes, /do not ask for sizes yet/i);

  // Alice finishes studio line at +2.5s.
  await clock.advance(300);
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(2_200);
  sequencer.onAgentStateChanged('listening');

  // Scene lands late at +9s (past 5s studio hold, within 20s timeout) -> reveals immediately!
  await clock.advance(6_500); // total +9000ms
  capturedOnRender!({ kind: 'scene', ok: true, url: 'https://media.local/scene-1.jpg', ms: 9_000 });
  await flushMicrotasks();

  const reveals = () => calls.filter((c) => c.action === 'reveal');
  assert.equal(reveals().length, 2);
  assert.deepEqual(reveals().at(-1), {
    action: 'reveal',
    payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' },
  });
  assert.equal(replies.length, 1);

  // Video lands just 0.3s later (reproducing the real-call bug!) -> MUST NOT replace scene yet!
  await clock.advance(300);
  capturedOnRender!({ kind: 'video', ok: true, url: 'https://media.local/video-1.mp4', ms: 9_300 });
  await flushMicrotasks();
  assert.equal(reveals().length, 2, 'video landing 0.3s after scene must NOT replace scene early');

  // Even after Alice finishes her scene line at +2.5s, scene stays held until 6s total.
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(2_200);
  sequencer.onAgentStateChanged('listening');
  await clock.advance(DEFAULT_SCENE_HOLD_MS - 2_501);
  assert.equal(reveals().length, 2, 'scene still held at 5.999s');

  await clock.advance(1);
  assert.equal(reveals().length, 3);
  assert.deepEqual(reveals().at(-1), {
    action: 'reveal',
    payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' },
  });
  assert.equal(replies.length, 2);

  const beatLogs = logs.filter((l) => l.ev === 'reveal_beat').map((l) => l.data);
  assert.deepEqual(beatLogs, [
    { outfit: 1, kind: 'studio', spoken: true, waited_ms: 0 },
    { outfit: 1, kind: 'scene', spoken: true, waited_ms: 9_000 },
    { outfit: 1, kind: 'video', spoken: true, waited_ms: 6_000 },
  ]);
});

test('failed scene goes studio -> video cleanly without mentioning scene, and timed-out renders skip silently', async () => {
  const clock = createFakeClock(30_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const reveals: Array<{ outfit: number; kind: string }> = [];

  const seq = createRevealSequencer({
    room: 'r-fail-skip',
    sendReveal: (p) => reveals.push(p),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Scene fails while video is ready -> holds studio 5s, goes straight to video, then sizes once.
  seq.startStudio({
    outfit: 1,
    setting: 'cocktail party',
    scene: 'pending',
    video: 'ready',
    getSizesInstruction: () => 'Ask for their top and shoe sizes in one question.',
  });
  seq.onAgentStateChanged('speaking');
  await clock.advance(2_000);
  seq.onAgentStateChanged('listening');
  seq.onExtraFailed(1, 'scene');

  // Still inside 5s studio hold.
  await clock.advance(DEFAULT_STUDIO_HOLD_MS - 2_001);
  assert.equal(reveals.length, 0);

  // At 5s: video reveals straight after studio!
  await clock.advance(1);
  assert.deepEqual(reveals, [{ outfit: 1, kind: 'video' }]);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /in motion/i);
  assert.doesNotMatch(replies[0]!.instructions, /failed|missing|scene/i);

  // Even if Alice stays silent after video beat, fallback fires sizes instruction ONCE after 3s.
  await clock.advance(DEFAULT_SIZES_FALLBACK_MS);
  assert.equal(replies.length, 2);
  assert.match(replies[1]!.instructions, /top and shoe sizes/i);
  assert.equal(seq.isActive, false);

  // 2) Both pending and never arrive -> times out at 20s and asks sizes ONCE without mentioning missing renders.
  reveals.length = 0;
  replies.length = 0;
  seq.startStudio({
    outfit: 2,
    setting: 'rooftop dinner',
    scene: 'pending',
    video: 'pending',
    getSizesInstruction: () => 'Offer to add it to their bag in those sizes.',
  });
  seq.onAgentStateChanged('speaking');
  await clock.advance(2_000);
  seq.onAgentStateChanged('listening');

  await clock.advance(DEFAULT_EXTRA_WAIT_TIMEOUT_MS - 2_001);
  assert.equal(replies.length, 0, 'still waiting for pending renders before 20s');

  await clock.advance(1);
  assert.equal(reveals.length, 0, 'no scene or video reveals on timeout');
  assert.equal(replies.length, 1, 'sizes/bag instruction fires once on timeout');
  assert.match(replies[0]!.instructions, /offer to add it to their bag/i);
  assert.equal(seq.isActive, false);
});

test('both extras absent asks sizes once after studio line (and never duplicates if already prompted)', async () => {
  const clock = createFakeClock(40_000);
  const replies: Array<{ instructions: string }> = [];
  const reveals: Array<{ outfit: number; kind: string }> = [];

  const seq = createRevealSequencer({
    room: 'r-both-absent',
    sendReveal: (p) => reveals.push(p),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Case A: sizes not prompted in studio -> fires once after Alice finishes studio line.
  seq.startStudio({
    outfit: 1,
    setting: 'gallery opening',
    scene: 'absent',
    video: 'absent',
    getSizesInstruction: () => 'Ask for their top, bottom, and shoe sizes in one question.',
  });
  seq.onAgentStateChanged('speaking');
  await clock.advance(1_800);
  assert.equal(replies.length, 0);
  seq.onAgentStateChanged('listening');
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /top, bottom, and shoe sizes/i);
  assert.equal(reveals.length, 0);
  assert.equal(seq.isActive, false);

  // Case B: sizesAlreadyPrompted = true -> zero extra generateReply calls.
  seq.startStudio({
    outfit: 1,
    setting: 'gallery opening',
    scene: 'absent',
    video: 'absent',
    sizesAlreadyPrompted: true,
    getSizesInstruction: () => 'Should not fire.',
  });
  assert.equal(seq.isActive, false);
  await clock.advance(30_000);
  assert.equal(replies.length, 1);
});

test('shopper speaking during sequence keeps page reveals on schedule but skips remaining spoken lines', async () => {
  const clock = createFakeClock(50_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const reveals: Array<{ outfit: number; kind: string }> = [];

  const seq = createRevealSequencer({
    room: 'r-shopper-speaks',
    sendReveal: (p) => reveals.push(p),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  seq.startStudio({
    outfit: 1,
    setting: 'beach wedding in Capri',
    scene: 'ready',
    video: 'ready',
    getSizesInstruction: () => 'Ask for sizes.',
  });

  // Shopper speaks at +2s (e.g. gives sizes or asks a question).
  await clock.advance(2_000);
  seq.onUserStateChanged('speaking');
  seq.onShopperSpoke();
  await clock.advance(1_000);
  seq.onUserStateChanged('listening');
  // Alice starts answering the shopper.
  seq.onAgentStateChanged('speaking');

  // At +5s: scene page reveal STILL fires on schedule, with spoken: false!
  await clock.advance(2_000);
  assert.deepEqual(reveals, [{ outfit: 1, kind: 'scene' }]);
  assert.equal(replies.length, 0, 'must skip scene spoken line after shopper spoke');

  // At +11s (+6s after scene): video page reveal STILL fires on schedule, with spoken: false!
  await clock.advance(DEFAULT_SCENE_HOLD_MS);
  assert.deepEqual(reveals, [
    { outfit: 1, kind: 'scene' },
    { outfit: 1, kind: 'video' },
  ]);
  assert.equal(replies.length, 0, 'must skip video spoken line and sizes question after shopper spoke');
  assert.equal(seq.isActive, false);

  const beatLogs = logs.filter((l) => l.ev === 'reveal_beat').map((l) => l.data);
  assert.deepEqual(beatLogs, [
    { outfit: 1, kind: 'studio', spoken: true, waited_ms: 0 },
    { outfit: 1, kind: 'scene', spoken: false, waited_ms: 5_000 },
    { outfit: 1, kind: 'video', spoken: false, waited_ms: 6_000 },
  ]);
});

test('failed extra part produces no page action, no state entry, and empty studio path skips extras', async () => {
  const clock = createFakeClock();
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-fail', log: () => {} });

  const sequencer = createRevealSequencer({
    room: 'r-fail',
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
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
    revealSequencer: sequencer,
    deps: makeBaseDeps({
      async tryOn(_jpeg, outfit) {
        if (outfit.number === 2) {
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

  // Pick Look 1 and reveal studio first while extras are still rendering.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(extrasCalls, 1);
  const showRes = await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  assert.match(showRes, /do not ask for sizes yet/i);
  calls.length = 0;

  // Alice finishes studio line, then both parts fail -> zero extra page actions, sizes prompt fires once!
  sequencer.onAgentStateChanged('speaking');
  await clock.advance(1_500);
  sequencer.onAgentStateChanged('listening');

  capturedOnRender!({ kind: 'scene', ok: false, ms: 9_000 });
  capturedOnRender!({ kind: 'video', ok: true, url: '/local/bad/path.mp4', ms: 15_000 });
  await flushMicrotasks();

  assert.equal(calls.length, 0, 'failed part must produce no page action');
  assert.equal(state.get().tryOnExtras[1], undefined, 'failed part must not be stored in state');
  assert.equal(replies.length, 1, 'sizes prompt fires once after both extras fail');
  assert.match(replies[0]!.instructions, /top and shoe sizes/i);
  assert.deepEqual(
    logs.filter((l) => l.ev === 'tryon_extra').map((l) => l.data),
    [
      { outfit: 1, kind: 'scene', ok: false, ms: 9_000 },
      { outfit: 1, kind: 'video', ok: false, ms: 15_000 },
    ],
  );
});

test('aborting session signal cancels active sequencer and clears timers cleanly', async () => {
  const clock = createFakeClock();
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-abort', log: () => {} });
  const abort = new AbortController();

  const sequencer = createRevealSequencer({
    room: 'r-abort',
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: () => {},
    initialAgentState: 'listening',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

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
    revealSequencer: sequencer,
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
  await clock.advance(6_000);

  capturedOnRender!({ kind: 'scene', ok: true, url: 'https://media.local/scene-1.jpg', ms: 10_000 });
  await flushMicrotasks();

  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  calls.length = 0;

  assert.equal(sequencer.isActive, true);
  assert.equal(clock.activeTimers(), 1, 'scene reveal timer must be armed');
  abort.abort();
  assert.equal(sequencer.isActive, false);
  assert.equal(clock.activeTimers(), 0, 'abort must clear all pending sequencer timers');

  await clock.advance(30_000);
  assert.equal(calls.length, 0);
});

test('shortenSettingPhrase, buildSceneRevealInstruction, and buildVideoRevealInstruction format concisely without questions', () => {
  assert.equal(shortenSettingPhrase('a candlelit Italian trattoria in SoHo'), 'candlelit Italian trattoria');
  assert.equal(shortenSettingPhrase('a beach wedding in Capri'), 'beach wedding in Capri');
  assert.equal(shortenSettingPhrase('rooftop bar at sunset'), 'rooftop bar at sunset');
  assert.equal(shortenSettingPhrase(''), '');

  const sceneInstr = buildSceneRevealInstruction('a beach wedding in Capri');
  assert.match(sceneInstr, /on-location shot/i);
  assert.match(sceneInstr, /beach wedding in Capri/);
  assert.match(sceneInstr, /do not invent/i);
  assert.match(sceneInstr, /do not ask a question/i);
  assert.equal(sceneInstr.includes('?'), false);

  const videoInstr = buildVideoRevealInstruction('a beach wedding in Capri');
  assert.match(videoInstr, /short video/i);
  assert.match(videoInstr, /in motion/i);
  assert.match(videoInstr, /do not ask a question/i);
  assert.equal(videoInstr.includes('?'), false);
});

test('studio, scene, and video reveal lines have 3 varied <16-word lines in Alice voice carrying occasion and never repeating in one call', async () => {
  const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

  const studioLines = Array.from({ length: STUDIO_REVEAL_VARIANT_COUNT }, (_, i) =>
    buildStudioRevealLine(i),
  );
  const sceneLines = Array.from({ length: SCENE_REVEAL_VARIANT_COUNT }, (_, i) =>
    buildSceneRevealLine('a beach wedding in Capri', i),
  );
  const videoLines = Array.from({ length: VIDEO_REVEAL_VARIANT_COUNT }, (_, i) =>
    buildVideoRevealLine('a beach wedding in Capri', i),
  );

  assert.equal(new Set(studioLines).size, 3, 'studio beat must have 3 distinct lines');
  assert.equal(new Set(sceneLines).size, 3, 'scene beat must have 3 distinct lines');
  assert.equal(new Set(videoLines).size, 3, 'video beat must have 3 distinct lines');

  assert.equal(studioLines[0], "Here's what the outfit looks like on you.");
  assert.equal(videoLines[0], "And here's a video of you in the look.");
  assert.match(buildStudioRevealInstruction(0), /Here's what the outfit looks like on you\./);

  for (const line of [...studioLines, ...sceneLines, ...videoLines]) {
    assert.ok(countWords(line) < 16, `expected <16 words, got ${countWords(line)}: "${line}"`);
    assert.equal(line.includes('?'), false);
  }

  for (const line of sceneLines) {
    assert.match(line, /at the beach wedding in Capri/);
  }

  // When occasion is unknown, drop the occasion clause cleanly.
  for (let i = 0; i < 3; i++) {
    const sFallback = buildSceneRevealLine('', i);
    const vFallback = buildVideoRevealLine('', i);
    assert.ok(countWords(sFallback) < 16, `fallback scene line too long: "${sFallback}"`);
    assert.ok(countWords(vFallback) < 16, `fallback video line too long: "${vFallback}"`);
    assert.doesNotMatch(sFallback, /\bat the\b/i, `unknown occasion must drop "at the <occasion>": "${sFallback}"`);
  }

  // Rotation across 3 reveals in a single call never repeats studio, scene, or video lines.
  const clock = createFakeClock(60_000);
  const replies: string[] = [];
  const seq = createRevealSequencer({
    room: 'r-rotate',
    sendReveal: () => {},
    generateReply: (opts) => replies.push(opts.instructions),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const studioReplies: string[] = [];
  const sceneReplies: string[] = [];
  const videoReplies: string[] = [];
  for (let outfit = 1; outfit <= 3; outfit++) {
    replies.length = 0;
    const studioLine = seq.startStudio({
      outfit,
      setting: 'beach wedding in Capri',
      scene: 'ready',
      video: 'ready',
      sceneUrl: `https://media.local/scene-${outfit}.jpg`,
      videoUrl: `https://media.local/video-${outfit}.mp4`,
      sizesAlreadyPrompted: true,
      getSizesInstruction: () => '',
    });
    studioReplies.push(studioLine);
    await clock.advance(DEFAULT_STUDIO_HOLD_MS);
    sceneReplies.push(replies[0]!);
    await clock.advance(DEFAULT_SCENE_HOLD_MS);
    videoReplies.push(replies[1]!);
  }

  assert.equal(new Set(studioReplies).size, 3, 'studio reveal line must not repeat in one call');
  assert.equal(new Set(sceneReplies).size, 3, 'scene reveal instruction must not repeat in one call');
  assert.equal(new Set(videoReplies).size, 3, 'video reveal instruction must not repeat in one call');
});

test('swap on picked look instructs about twenty seconds, auto-reveals studio with one spoken line, skips auto scene/video, and allows show_on_me extras later', async () => {
  const clock = createFakeClock(70_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-swap-reveal', log: () => {} });

  let resolveSwapTryOn!: (v: { url: string; path: string; ms: number; id: string }) => void;
  let tryOnSeq = 0;
  let extrasCalls = 0;

  const sequencer = createRevealSequencer({
    room: 'r-swap-reveal',
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const tools = createAgentTools({
    room: 'r-swap-reveal',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    revealSequencer: sequencer,
    deps: makeBaseDeps({
      async tryOn(_jpeg, outfit) {
        tryOnSeq += 1;
        if (tryOnSeq <= 3) {
          return {
            url: `https://media.local/studio-${outfit.number}-initial.jpg`,
            path: `/tmp/studio-${outfit.number}-initial.jpg`,
            ms: 20,
            id: `init-${tryOnSeq}`,
          };
        }
        return new Promise((resolve) => {
          resolveSwapTryOn = resolve;
        });
      },
      async tryOnExtras() {
        extrasCalls += 1;
        return new Promise<TryOnExtrasResult>(() => {});
      },
      async swapPiece(outfit, slot, _request) {
        const replacement = {
          slot,
          why: 'Sleeker heel.',
          item: makeItem({
            id: 'shoe-new-swap',
            variant_id: 'var-shoe-new',
            title: 'Metallic Kitten Heel',
            price: 115,
            sizes: ['7', '8', '9'],
          }),
        };
        const pieces = outfit.pieces.map((p) => (p.slot === slot ? replacement : p));
        const total = pieces.reduce((s, p) => s + p.item.price, 0);
        return { outfit: { ...outfit, pieces, total }, piece: replacement };
      },
      async addToBag(bagOutfit, sizes) {
        return {
          carts: [
            {
              store: 'Everlane',
              store_domain: 'everlane.myshopify.com',
              cart_id: 'cart-1',
              continue_url: 'https://everlane.example/cart/1',
              total_usd: bagOutfit.total,
              added: bagOutfit.pieces.map((p) => ({
                variant_id: p.item.variant_id,
                title: p.item.title,
                size: sizes[p.slot.toLowerCase()] ?? 'M',
              })),
              not_added: [],
              ms: 10,
            },
          ],
          summary: 'Added look.',
          total_usd: bagOutfit.total,
        };
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'beach wedding', where: 'Capri', budget_usd: 350 },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  assert.equal(extrasCalls, 1, 'initial pick starts extras once');

  // Bag Look 1 so we also verify polish9 NOT IN THE BAG YET prefix is preserved!
  await tools.add_to_bag.execute({ outfit: 1, sizes: { top: 'M', shoes: '8' } }, fakeToolOpts('bag1'));

  calls.length = 0;
  replies.length = 0;
  const swapRes = await tools.swap_piece.execute(
    { slot: 'shoes', request: 'metallic kitten heels' },
    fakeToolOpts('sw1'),
  );

  // Result starts with NOT IN THE BAG YET (polish9), names exact product, and gives the ~20s instruction!
  assert.equal(swapRes.startsWith('NOT IN THE BAG YET:'), true);
  assert.match(swapRes, /Metallic Kitten Heel/);
  assert.match(swapRes, /about twenty seconds/i);
  assert.equal(calls.some((c) => c.action === 'reveal'), false, 'must not reveal before refreshed try-on is ready');
  assert.equal(extrasCalls, 1, 'swap must NOT auto-start tryOnExtras');

  // Refreshed try-on finishes -> auto-reveals studio on page + speaks one short line + still NO auto extras!
  resolveSwapTryOn({
    url: 'https://media.local/studio-1-swapped.jpg',
    path: '/tmp/studio-1-swapped.jpg',
    ms: 19_500,
    id: 'swap-1',
  });
  await flushMicrotasks();

  assert.deepEqual(
    calls.filter((c) => c.action === 'tryOnReady' || c.action === 'reveal'),
    [
      { action: 'tryOnReady', payload: { outfit: 1, url: 'https://media.local/studio-1-swapped.jpg' } },
      { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/studio-1-swapped.jpg' } },
    ],
  );
  assert.equal(state.get().revealsDone.includes(1), true);
  assert.equal(replies.length, 1, 'must speak exactly one short studio line after swap try-on finishes');
  assert.match(replies[0]!.instructions, /Metallic Kitten Heel/);
  assert.match(replies[0]!.instructions, /new piece is on/i);
  assert.equal(replies[0]!.instructions.includes('?'), false);
  assert.equal(extrasCalls, 1, '3b: swap try-on completion must NOT auto-make scene or video');

  // Advancing clock does not replay scene/video beats or sizes prompt.
  await clock.advance(30_000);
  assert.equal(replies.length, 1);

  // If shopper explicitly asks for show_on_me on the swapped look, extras may start then (3b).
  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('show-after-swap'));
  assert.equal(extrasCalls, 2, 'explicit show_on_me on swapped look may start scene/video extras');

  // Direct helper check.
  const swapInstr = buildSwapStudioRevealInstruction('Linen Shirt', 'top');
  assert.match(swapInstr, /Linen Shirt/);
  assert.equal(swapInstr.includes('?'), false);
});

test('prewarmScene runs once per look on try-on ready with brief/weather, swallows errors, logs scene_prewarm, and skips swaps', async () => {
  assert.equal(resolvePrewarmScene({}), undefined);
  assert.equal(resolvePrewarmScene(null), undefined);

  const logs: RecordedLog[] = [];
  const { page } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-prewarm', log: () => {} });
  const prewarmCalls: Array<{ studioPath: string; outfitNum: number; opts: PrewarmSceneOptions }> = [];

  const tools = createAgentTools({
    room: 'r-prewarm',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: makeBaseDeps({
      tryOnExtras: null,
      async forecast() {
        return { ok: true, line: '76F and sunny in Capri' };
      },
      async prewarmScene(studio, outfit, opts) {
        prewarmCalls.push({ studioPath: studio.path, outfitNum: outfit.number ?? 0, opts });
        if (outfit.number === 2) {
          throw new Error('prewarm boom should be swallowed');
        }
      },
      async swapPiece(outfit, slot) {
        const replacement = {
          slot,
          why: 'Fresh option.',
          item: makeItem({ id: 'sw-item', variant_id: 'v-sw', title: 'Swapped Heel', price: 95 }),
        };
        const pieces = outfit.pieces.map((p) => (p.slot === slot ? replacement : p));
        return { outfit: { ...outfit, pieces, total: 215 }, piece: replacement };
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'beach wedding', where: 'Capri', when: 'Saturday', budget_usd: 400 },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();

  assert.equal(prewarmCalls.length, 3, 'prewarmScene must run once per look when try-on becomes ready');
  assert.deepEqual(
    prewarmCalls.map((c) => c.outfitNum).sort(),
    [1, 2, 3],
  );
  assert.equal(prewarmCalls[0]!.studioPath, '/tmp/studio-1.jpg');
  assert.deepEqual(prewarmCalls[0]!.opts, {
    occasion: 'beach wedding',
    where: 'Capri',
    when: 'Saturday',
    weather: '76F and sunny in Capri',
  });
  assert.equal(logs.filter((l) => l.ev === 'scene_prewarm').length, 3);
  assert.equal(state.get().tryOn[2]?.status, 'ready', 'prewarm error must never break try-on ready state');

  // Swap on Look 1 must NOT call prewarmScene.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await tools.swap_piece.execute({ slot: 'shoes', request: 'gold heels' }, fakeToolOpts('sw1'));
  await flushMicrotasks();

  assert.equal(prewarmCalls.length, 3, 'prewarmScene must NOT run after swaps');
});

test('video arriving before scene after studio reveal never skips ahead of scene; strict order studio -> scene -> video', async () => {
  const clock = createFakeClock(80_000);
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-order', log: () => {} });

  const sequencer = createRevealSequencer({
    room: 'r-order',
    sendTryOnReady: (payload) => page.send('tryOnReady', payload),
    sendReveal: (payload) => page.send('reveal', payload),
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  let capturedOnRender: TryOnExtrasOptions['onRender'];
  const tools = createAgentTools({
    room: 'r-order',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    revealSequencer: sequencer,
    deps: makeBaseDeps({
      prewarmScene: null,
      async tryOnExtras(_studio, _outfit, opts) {
        capturedOnRender = opts.onRender;
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'women' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute(
    { occasion: 'cocktail party', where: 'SoHo', budget_usd: 300 },
    fakeToolOpts('b1'),
  );
  await flushMicrotasks();
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  calls.length = 0;

  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  const mediaCalls = () => calls.filter((c) => c.action === 'tryOnReady' || c.action === 'reveal');
  assert.deepEqual(mediaCalls(), [
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/studio-1.jpg' } },
  ]);

  // Video lands at +2s while scene is still pending -> MUST NOT send video to page yet!
  await clock.advance(2_000);
  capturedOnRender!({ kind: 'video', ok: true, url: 'https://media.local/video-1.mp4', ms: 2_000 });
  await flushMicrotasks();
  assert.equal(mediaCalls().length, 1, 'video must stay in memory while waiting for scene');

  // Even past the 5s studio hold, video still waits for pending scene.
  await clock.advance(4_000); // +6s
  assert.equal(mediaCalls().length, 1, 'video must not jump ahead of pending scene');

  // Scene lands at +7s -> scene sent immediately (tryOnReady + reveal), video still held >= 5s!
  await clock.advance(1_000); // +7s
  capturedOnRender!({ kind: 'scene', ok: true, url: 'https://media.local/scene-1.jpg', ms: 7_000 });
  await flushMicrotasks();
  assert.deepEqual(mediaCalls().slice(1), [
    { action: 'tryOnReady', payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' } },
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/scene-1.jpg', kind: 'scene' } },
  ]);

  // After scene hold -> video sent (tryOnReady + reveal).
  await clock.advance(DEFAULT_SCENE_HOLD_MS);
  await flushMicrotasks();
  assert.deepEqual(mediaCalls().slice(3), [
    { action: 'tryOnReady', payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' } },
    { action: 'reveal', payload: { outfit: 1, url: 'https://media.local/video-1.mp4', kind: 'video' } },
  ]);
});
