import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BuildResult,
  Item,
  Outfit,
  PageActionName,
  PageActionReply,
  PageActions,
  Piece,
} from '../src/types.ts';
import type { TimerHandle } from '../src/agent/context.ts';
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  createAgentTools,
  type TimerLike,
  type ToolDeps,
  type TryOnExtrasResult,
} from '../src/agent/tools.ts';
import {
  DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS,
  DEFAULT_WALKTHROUGH_MIN_PIECE_MS,
  WALKTHROUGH_END_QUESTION,
  buildPieceNote,
  buildPieceWalkthroughLine,
  createWalkthroughController,
  isExpressModeState,
  pointForDetail,
  selectWalkthroughPieces,
} from '../src/agent/walkthrough.ts';

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
  responder?: (action: PageActionName, payload: unknown) => PageActionReply | Promise<PageActionReply>,
): { page: PageSender; calls: PageCall[] } {
  const calls: PageCall[] = [];
  const page: PageSender = {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageActionReply> {
      calls.push({ action, payload });
      if (responder) {
        return await responder(action, payload);
      }
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
    title: 'Tropical Wool Blazer - Navy',
    price: 220,
    url: 'https://example.com/blazer',
    image: 'https://cdn.shopify.com/blazer.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.8,
    rating_count: 55,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'var-s', M: 'var-m', L: 'var-l' },
    description: 'Notch lapel tropical wool blazer that holds its shape without the stiffness.',
    department: 'men',
    ...overrides,
  };
}

function makeFivePieceOutfit(number = 1): Outfit {
  const pieces: Piece[] = [
    {
      slot: 'shoes',
      why: 'Polished penny loafer anchors the look.',
      item: makeItem({
        id: `sh-${number}`,
        variant_id: `v-sh-${number}`,
        title: 'Italian Leather Loafer - Espresso',
        price: 165,
        image: 'https://cdn.shopify.com/loafer.jpg',
        description: 'Stacked leather heel with almond toe and hand-stitched apron.',
        sizes: ['9', '10', '11'],
      }),
    },
    {
      slot: 'accessory',
      why: 'Subtle finish.',
      item: makeItem({
        id: `acc-${number}`,
        variant_id: `v-acc-${number}`,
        title: 'Woven Leather Belt - Brown',
        price: 55,
        image: 'https://cdn.shopify.com/belt.jpg',
        description: 'Brushed brass buckle with braided calfskin strap.',
        sizes: ['32', '34'],
      }),
    },
    {
      slot: 'bottom',
      why: 'Clean drape.',
      item: makeItem({
        id: `bot-${number}`,
        variant_id: `v-bot-${number}`,
        title: 'Pleated Wool Trouser - Charcoal',
        price: 130,
        image: 'https://cdn.shopify.com/trouser.jpg',
        description: 'Single front pleat and sharp crease in lightweight twill.',
        sizes: ['30', '32', '34'],
      }),
    },
    {
      slot: 'top',
      why: 'Crisp base.',
      item: makeItem({
        id: `top-${number}`,
        variant_id: `v-top-${number}`,
        title: 'Fine Merino Polo - Ivory',
        price: 88,
        image: 'https://cdn.shopify.com/polo.jpg',
        description: 'Open knit collar in breathable extra-fine merino wool.',
        sizes: ['S', 'M', 'L'],
      }),
    },
    {
      slot: 'layer',
      why: 'Hero structure.',
      item: makeItem({
        id: `lay-${number}`,
        variant_id: `v-lay-${number}`,
        title: 'Structured Wool Blazer - Navy',
        price: 220,
        image: 'https://cdn.shopify.com/blazer.jpg',
        description: 'Notch lapel tropical wool blazer that holds its shape cleanly.',
        sizes: ['S', 'M', 'L'],
      }),
    },
  ];
  return {
    number,
    name: 'SoHo Tailored',
    difference: 'Crisp blazer over knit polo and pleated trousers.',
    story: 'Sharp gallery-opening tailoring.',
    pieces,
    total: pieces.reduce((s, p) => s + p.item.price, 0),
  };
}

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const outfits = [makeFivePieceOutfit(1), makeFivePieceOutfit(2)];
  return {
    async buildOutfits(_brief, opts): Promise<BuildResult> {
      const cloned = structuredClone(outfits);
      cloned.forEach((o, i) => opts?.onOutfit?.(o, i));
      return {
        outfits: cloned,
        source: 'library',
        timing: { first_outfit_ms: 40, total_ms: 80 },
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
        ms: 30,
        id: `st-${outfit.number ?? 1}`,
      };
    },
    async swapPiece(outfit, slot) {
      const replacement: Piece = {
        slot,
        why: 'Fresh suede option.',
        item: makeItem({
          id: 'sw-shoe',
          variant_id: 'v-sw-shoe',
          title: 'Suede Chelsea Boot - Espresso',
          price: 190,
          image: 'https://cdn.shopify.com/boot.jpg',
          description: 'Water-resistant Italian suede with stacked heel.',
          sizes: ['9', '10', '11'],
        }),
      };
      const pieces = outfit.pieces.map((p) => (p.slot === slot ? replacement : p));
      return { outfit: { ...outfit, pieces, total: outfit.total + 25 }, piece: replacement };
    },
    async addToBag(outfit, sizes) {
      return {
        carts: [
          {
            store: 'Everlane',
            store_domain: 'everlane.myshopify.com',
            cart_id: 'cart-1',
            continue_url: 'https://everlane.example/cart/1',
            total_usd: outfit.total,
            added: outfit.pieces.map((p) => ({
              variant_id: p.item.variant_id,
              title: p.item.title,
              size: sizes[p.slot.toLowerCase()] ?? 'M',
            })),
            not_added: [],
            ms: 10,
          },
        ],
        summary: 'Added to bag.',
        total_usd: outfit.total,
      };
    },
    async loadStoreModule() {
      return null;
    },
    prewarmScene: null,
    tryOnExtras: null,
    ...overrides,
  };
}

test('pointForDetail maps all garment, shoe, hardware, and fabric keywords with per-slot defaults in [0, 1]', () => {
  assert.deepEqual(pointForDetail('layer', 'Double-breasted blazer with notch lapel'), { x: 0.38, y: 0.3 });
  assert.deepEqual(pointForDetail('top', 'Crisp point collar in cotton poplin'), { x: 0.5, y: 0.14 });
  assert.deepEqual(pointForDetail('top', 'Concealed button placket front'), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointForDetail('layer', 'Turned cuff and tapered sleeve'), { x: 0.18, y: 0.62 });
  assert.deepEqual(pointForDetail('bottom', 'Deep slash pocket detailing'), { x: 0.34, y: 0.58 });
  assert.deepEqual(pointForDetail('bottom', 'High-rise tailored waistband'), { x: 0.5, y: 0.12 });
  assert.deepEqual(pointForDetail('bottom', 'Single front pleat and pressed crease'), { x: 0.42, y: 0.4 });
  assert.deepEqual(pointForDetail('dress', 'Flared midi hem that sways'), { x: 0.5, y: 0.9 });
  assert.deepEqual(pointForDetail('shoes', 'Sleek almond toe silhouette'), { x: 0.72, y: 0.62 });
  assert.deepEqual(pointForDetail('shoes', 'Chunky lug sole and block heel'), { x: 0.3, y: 0.8 });
  assert.deepEqual(pointForDetail('shoes', 'Waxed cotton lace front'), { x: 0.5, y: 0.42 });
  assert.deepEqual(pointForDetail('accessory', 'Polished silver buckle strap'), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointForDetail('layer', '100% tropical wool weave with soft texture'), { x: 0.5, y: 0.45 });

  // Per-slot defaults when no keyword matches.
  for (const slot of ['layer', 'dress', 'top', 'bottom', 'shoes', 'accessory', 'bag', 'jewelry']) {
    const pt = pointForDetail(slot, 'Clean minimal silhouette');
    assert.ok(pt.x >= 0 && pt.x <= 1, `x out of bounds for ${slot}: ${pt.x}`);
    assert.ok(pt.y >= 0 && pt.y <= 1, `y out of bounds for ${slot}: ${pt.y}`);
  }
  assert.notDeepEqual(pointForDetail('layer', 'Clean minimal look'), pointForDetail('shoes', 'Clean minimal look'));
});

test('selectWalkthroughPieces caps at 4 hero-first pieces in layer -> dress -> top -> bottom -> shoes -> accessory order, and lines/notes obey limits', () => {
  const outfit = makeFivePieceOutfit(1);
  const selected = selectWalkthroughPieces(outfit.pieces);

  assert.equal(selected.length, 4, 'must cap at 4 pieces');
  assert.deepEqual(
    selected.map((p) => p.slot),
    ['layer', 'top', 'bottom', 'shoes'],
    'must keep hero pieces (layer, shoes) and order layer -> dress -> top -> bottom -> shoes -> accessory',
  );

  const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const expectedLeadIns = [/^First, the /, /^Then the /, /^Down to the /, /^And to finish, the /];

  selected.forEach((piece, idx) => {
    const note = buildPieceNote(piece, piece.item.description);
    const noteWords = countWords(note);
    assert.ok(noteWords >= 2 && noteWords <= 4, `note must be 2-4 words, got ${noteWords}: "${note}"`);

    const line = buildPieceWalkthroughLine(piece, piece.item.description, idx);
    assert.match(line, expectedLeadIns[idx]!, `unexpected lead-in at index ${idx}: "${line}"`);
    assert.ok(countWords(line) <= 16, `line must be <= 16 words, got ${countWords(line)}: "${line}"`);
    assert.equal(line.includes('?'), false);
  });
});

test('walkthrough after pick_outfit sends showPiece per piece then hidePiece, speaks lines + closing question, logs events, and never delays tryOnExtras', async () => {
  const clock = createFakeClock(10_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-wt', log: () => {} });
  let extrasStartedAt: number | null = null;

  const walkthrough = createWalkthroughController({
    room: 'r-wt',
    page,
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const tools = createAgentTools({
    room: 'r-wt',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    page,
    state,
    walkthrough,
    deps: makeDeps({
      async tryOnExtras() {
        extrasStartedAt = clock.now();
        return new Promise<TryOnExtrasResult>(() => {});
      },
    }),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'gallery opening', budget_usd: 700 }, fakeToolOpts('b1'));
  await flushMicrotasks();
  calls.length = 0;

  const pickRes = await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await flushMicrotasks();

  // pick_outfit must start tryOnExtras immediately (not delayed by walkthrough) and instruct model to stay quiet.
  assert.equal(extrasStartedAt, clock.now(), 'walkthrough must not delay tryOnExtras');
  assert.match(pickRes, /walkthrough/i);
  assert.match(pickRes, /say nothing until it ends/i);
  assert.match(pickRes, /Want to see it on you\?/);
  assert.match(pickRes, /do not repeat it/i);
  assert.equal(walkthrough.isActive, true);

  // Piece 0 (layer) shown immediately with showPiece + spoken line.
  const showPieces = () =>
    calls.filter((c) => c.action === 'showPiece').map((c) => c.payload as PageActions['showPiece']);
  assert.equal(showPieces().length, 1);
  assert.equal(showPieces()[0]!.outfit, 1);
  assert.equal(showPieces()[0]!.slot, 'layer');
  assert.equal(showPieces()[0]!.index, 0);
  assert.equal(showPieces()[0]!.count, 4);
  assert.deepEqual(showPieces()[0]!.point, { x: 0.38, y: 0.3 });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /First, the /);

  // Alice speaks piece 0 for 2.5s -> holds until 4s minimum before moving to piece 1 (top).
  walkthrough.onAgentStateChanged('speaking');
  await clock.advance(2_500);
  walkthrough.onAgentStateChanged('listening');
  await clock.advance(DEFAULT_WALKTHROUGH_MIN_PIECE_MS - 2_501);
  assert.equal(showPieces().length, 1, 'piece 0 must hold for at least 4s');

  await clock.advance(1);
  await flushMicrotasks();
  assert.equal(showPieces().length, 2);
  assert.equal(showPieces()[1]!.slot, 'top');
  assert.equal(showPieces()[1]!.index, 1);
  assert.match(replies[1]!.instructions, /Then the /);

  // Piece 1 speaks for 5s (>4s) -> moves immediately on speech end to piece 2 (bottom).
  walkthrough.onAgentStateChanged('speaking');
  await clock.advance(5_000);
  assert.equal(showPieces().length, 2, 'must wait for Alice to finish piece 1 line');
  walkthrough.onAgentStateChanged('listening');
  await flushMicrotasks();
  assert.equal(showPieces().length, 3);
  assert.equal(showPieces()[2]!.slot, 'bottom');
  assert.equal(showPieces()[2]!.index, 2);
  assert.match(replies[2]!.instructions, /Down to the /);

  // Piece 2 silent fallback advances at 6s -> piece 3 (shoes).
  await clock.advance(DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS);
  await flushMicrotasks();
  assert.equal(showPieces().length, 4);
  assert.equal(showPieces()[3]!.slot, 'shoes');
  assert.equal(showPieces()[3]!.index, 3);
  assert.match(replies[3]!.instructions, /And to finish, the /);

  // Piece 3 finishes -> sends hidePiece and asks "Want to see it on you?".
  await clock.advance(DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS);
  await flushMicrotasks();

  assert.equal(walkthrough.isActive, false);
  assert.equal(calls.filter((c) => c.action === 'hidePiece').length, 1);
  assert.equal(replies.length, 5);
  assert.match(replies[4]!.instructions, new RegExp(WALKTHROUGH_END_QUESTION.replace('?', '\\?')));

  // Verify structured logs: walkthrough_start, 4x walkthrough_piece, walkthrough_end.
  const startLogs = logs.filter((l) => l.ev === 'walkthrough_start');
  const pieceLogs = logs.filter((l) => l.ev === 'walkthrough_piece');
  const endLogs = logs.filter((l) => l.ev === 'walkthrough_end');
  assert.equal(startLogs.length, 1);
  assert.equal(pieceLogs.length, 4);
  for (const pl of pieceLogs) {
    assert.equal(pl.data?.page, 'showPiece');
    assert.equal(typeof pl.data?.slot, 'string');
    assert.equal(typeof pl.data?.note, 'string');
    assert.ok(pl.data?.point && typeof (pl.data.point as { x: number }).x === 'number');
  }
  assert.equal(endLogs.length, 1);
  assert.equal(endLogs[0]!.data?.reason, 'completed');
});

test('walkthrough falls back per call to highlight when showPiece is refused or throws, still speaks lines, and never throws', async () => {
  const clock = createFakeClock(20_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  let showPieceAttempts = 0;

  const { page, calls } = createFakePage((action) => {
    if (action === 'showPiece') {
      showPieceAttempts += 1;
      return { ok: false, error: 'Unsupported method: showPiece' };
    }
    return { ok: true };
  });

  const walkthrough = createWalkthroughController({
    room: 'r-fallback',
    page,
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const outfit = makeFivePieceOutfit(1);
  assert.equal(walkthrough.start(outfit), true);
  await flushMicrotasks();

  assert.equal(showPieceAttempts, 1, 'should try showPiece once then remember fallback for the call');
  assert.equal(walkthrough.usingHighlightFallback, true);
  assert.deepEqual(
    calls.filter((c) => c.action === 'highlight'),
    [{ action: 'highlight', payload: { outfit: 1, piece: 'layer' } }],
  );
  assert.equal(replies.length, 1);

  // Advance through remaining 3 pieces: never calls showPiece again, highlights each piece, speaks every line + question.
  for (let i = 0; i < 4; i++) {
    await clock.advance(DEFAULT_WALKTHROUGH_MAX_PIECE_WAIT_MS);
    await flushMicrotasks();
  }

  assert.equal(showPieceAttempts, 1, 'must not retry showPiece after fallback in same call');
  assert.deepEqual(
    calls.filter((c) => c.action === 'highlight').map((c) => (c.payload as PageActions['highlight']).piece),
    ['layer', 'top', 'bottom', 'shoes', null],
  );
  assert.equal(replies.length, 5, 'must speak all 4 piece lines plus closing question');
  assert.equal(walkthrough.isActive, false);

  const pieceLogs = logs.filter((l) => l.ev === 'walkthrough_piece');
  assert.equal(pieceLogs.length, 4);
  assert.ok(pieceLogs.every((l) => l.data?.page === 'highlight'));

  // Second pick in same call stays on highlight without attempting showPiece again.
  walkthrough.start(makeFivePieceOutfit(2));
  await flushMicrotasks();
  assert.equal(showPieceAttempts, 1);
  walkthrough.dispose();

  // Throwing/rejecting showPiece also falls back cleanly and never throws.
  const throwReplies: Array<{ instructions: string }> = [];
  const { page: throwPage, calls: throwCalls } = createFakePage((action) => {
    if (action === 'showPiece') {
      return Promise.reject(new Error('Method not found: showPiece'));
    }
    return { ok: true };
  });
  const throwWt = createWalkthroughController({
    room: 'r-throw-fallback',
    page: throwPage,
    generateReply: (opts) => throwReplies.push(opts),
    initialAgentState: 'listening',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  assert.equal(throwWt.start(makeFivePieceOutfit(1)), true);
  await flushMicrotasks();
  assert.equal(throwWt.usingHighlightFallback, true);
  assert.deepEqual(
    throwCalls.filter((c) => c.action === 'highlight'),
    [{ action: 'highlight', payload: { outfit: 1, piece: 'layer' } }],
  );
  assert.equal(throwReplies.length, 1);
  throwWt.dispose();
});

test('walkthrough stops immediately (sends hidePiece) when shopper speaks or on show_on_me, swap_piece, add_to_bag, or another pick, and skips in express mode', async () => {
  const clock = createFakeClock(30_000);
  const logs: RecordedLog[] = [];
  const replies: Array<{ instructions: string }> = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-stop', log: () => {} });

  const walkthrough = createWalkthroughController({
    room: 'r-stop',
    page,
    generateReply: (opts) => replies.push(opts),
    initialAgentState: 'listening',
    initialUserState: 'listening',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const tools = createAgentTools({
    room: 'r-stop',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    duplicateWindowMs: 500,
    page,
    state,
    walkthrough,
    deps: makeDeps(),
  });

  await tools.set_department.execute({ department: 'men' }, fakeToolOpts('d1'));
  await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 700 }, fakeToolOpts('b1'));
  await flushMicrotasks();

  // 1) Stops when shopper speaks.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p1'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  const repliesBeforeSpeak = replies.length;

  walkthrough.onShopperSpoke();
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, false);
  assert.equal(calls.filter((c) => c.action === 'hidePiece').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'shopper_spoke');

  await clock.advance(30_000);
  assert.equal(replies.length, repliesBeforeSpeak, 'no further piece lines or question after shopper spoke');

  // 2) Stops on show_on_me.
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p2'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  await tools.show_on_me.execute({ outfit: 1 }, fakeToolOpts('s1'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, false);
  assert.equal(calls.filter((c) => c.action === 'hidePiece').length, 2);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'show_on_me');

  // 3) Stops on swap_piece.
  await clock.advance(1_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p3'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  await tools.swap_piece.execute({ slot: 'shoes', request: 'suede boots' }, fakeToolOpts('sw1'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, false);
  assert.equal(calls.filter((c) => c.action === 'hidePiece').length, 3);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'swap_piece');

  // 4) Stops on add_to_bag.
  await clock.advance(1_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p4'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  await tools.add_to_bag.execute({ outfit: 1, sizes: { top: 'M', bottom: '32', shoes: '10' } }, fakeToolOpts('bag1'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, false);
  assert.equal(calls.filter((c) => c.action === 'hidePiece').length, 4);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'add_to_bag');

  // 5) Stops previous walkthrough when another pick is called.
  await clock.advance(1_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p5'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  await tools.pick_outfit.execute({ outfit: 2 }, fakeToolOpts('p6'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'pick_outfit');
  walkthrough.stop('cleanup');

  // 6) Stops via onUserStateChanged('speaking') too.
  await clock.advance(1_000);
  await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('p7'));
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, true);
  walkthrough.onUserStateChanged('speaking');
  await flushMicrotasks();
  assert.equal(walkthrough.isActive, false);
  assert.equal(logs.filter((l) => l.ev === 'walkthrough_end').at(-1)?.data?.reason, 'shopper_spoke');
  walkthrough.onUserStateChanged('listening');

  // 7) Skips walkthrough in express mode (via flow state flag or isExpress callback).
  assert.equal(isExpressModeState({ express: true }), true);
  assert.equal(isExpressModeState({ flow: { express: true } }), true);
  assert.equal(isExpressModeState({ express: false }), false);

  const expressWalkthrough = createWalkthroughController({
    room: 'r-express',
    page,
    generateReply: (opts) => replies.push(opts),
    isExpress: () => true,
    log: () => {},
  });
  assert.equal(expressWalkthrough.start(makeFivePieceOutfit(1)), false);
  assert.equal(expressWalkthrough.isActive, false);

  // Express flag directly on call state skips walkthrough in pick_outfit.
  const expressState = createCallStateStore({ roomName: 'r-express-state', log: () => {} });
  (expressState.get() as unknown as Record<string, unknown>).express = true;
  const expressStateWt = createWalkthroughController({
    room: 'r-express-state',
    page,
    generateReply: () => {},
    log: () => {},
  });
  const expressTools = createAgentTools({
    room: 'r-express-state',
    log: () => {},
    page,
    state: expressState,
    walkthrough: expressStateWt,
    deps: makeDeps(),
  });
  await expressTools.set_department.execute({ department: 'men' }, fakeToolOpts('ed1'));
  await expressTools.build_outfits.execute({ occasion: 'dinner', budget_usd: 700 }, fakeToolOpts('eb1'));
  await flushMicrotasks();
  const expressPick = await expressTools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('ep1'));
  assert.equal(expressStateWt.isActive, false);
  assert.doesNotMatch(expressPick, /say nothing until it ends/i);
});
