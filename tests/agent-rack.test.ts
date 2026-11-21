import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Gender,
  Item,
  PageActionName,
  PageActionReply,
  PageActions,
  SearchResult,
} from '../src/types.ts';
import type { SearchOpts } from '../src/store/catalog.ts';
import type { PageSender } from '../src/agent/page.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import {
  DEFAULT_RACK_QUERY_TIMEOUT_MS,
  MAX_RACK_ITEMS,
  SLOW_TOOL_NOTES,
  createAgentTools,
  resolveSearchByPhoto,
  type TimerLike,
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

const fakeToolOpts = (id = 'rack-1') => ({
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

function createFakeClock(start = 50_000) {
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

function makeRackItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    variant_id: `var-${id}`,
    title: `Item ${id}`,
    price: 68,
    url: `https://shop.example.com/products/${id}`,
    image: `https://cdn.shopify.com/${id}.jpg`,
    store: 'Kith',
    store_domain: 'kith.myshopify.com',
    rating: 4.7,
    rating_count: 19,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: `var-${id}-s`, M: `var-${id}-m`, L: `var-${id}-l` },
    description: 'Heavyweight cotton fleece.',
    department: 'men',
    ...overrides,
  };
}

test('show_rack happy path interleaves queries, drops id/url dupes and imageless items, caps at 12, sends rack payload, logs, and skips slow-work/state mutation', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-rack-happy', log: () => {} });
  const slowEvents: string[] = [];
  const workingNotes: string[] = [];
  let nowMs = 1_000;

  const queryCalls: Array<{ query: string; gender: Gender; opts?: SearchOpts }> = [];
  const byQuery: Record<string, Item[]> = {
    'oversized grey hoodie': [
      makeRackItem('a1'),
      makeRackItem('no-img', { image: '' }),
      makeRackItem('a2', { url: 'https://shop.example.com/shared-url' }),
      makeRackItem('a3'),
      makeRackItem('a4'),
      makeRackItem('a5'),
    ],
    'washed cargo pants': [
      makeRackItem('b1'),
      makeRackItem('a1', { url: 'https://shop.example.com/different-url-same-id' }), // dup by id
      makeRackItem('b2-dup-url', { url: 'HTTPS://SHOP.EXAMPLE.COM/SHARED-URL' }), // dup by url
      makeRackItem('b2'),
      makeRackItem('b3'),
      makeRackItem('b4'),
      makeRackItem('b5'),
    ],
    'retro low sneakers': [
      makeRackItem('c1'),
      makeRackItem('c2'),
      makeRackItem('c3'),
      makeRackItem('c4'),
      makeRackItem('c5'),
    ],
  };

  assert.equal('show_rack' in SLOW_TOOL_NOTES, false, 'show_rack must not be a slow tool');

  const tools = createAgentTools({
    room: 'r-rack-happy',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => nowMs,
    page,
    state,
    onSlowToolStart: (ev) => slowEvents.push(`start:${ev.name}`),
    onSlowToolEnd: (ev) => slowEvents.push(`end:${ev.name}`),
    sendWorkingNote: (params) => {
      workingNotes.push(params.name);
      return true;
    },
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(query, gender, opts): Promise<SearchResult> {
            queryCalls.push({ query, gender, opts });
            nowMs += 40;
            return { items: byQuery[query] ?? [], source: 'live', ms: 40 };
          },
        };
      },
    },
  });

  const result = await tools.show_rack.execute(
    {
      style: 'relaxed streetwear',
      queries: ['oversized grey hoodie', 'washed cargo pants', 'retro low sneakers'],
      department: 'men',
    },
    fakeToolOpts('rk1'),
  );

  // Uses searchMixed in parallel for all 3 queries with the given department.
  assert.equal(queryCalls.length, 3);
  assert.deepEqual(
    queryCalls.map((c) => [c.query, c.gender]),
    [
      ['oversized grey hoodie', 'men'],
      ['washed cargo pants', 'men'],
      ['retro low sneakers', 'men'],
    ],
  );

  // Page payload has title, rack: true, query: style, capped at 12, interleaved, deduped, all with images.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, 'showSearch');
  const payload = calls[0]!.payload as PageActions['showSearch'];
  assert.equal(payload.query, 'relaxed streetwear');
  assert.equal(payload.title, 'On the racks for you');
  assert.equal(payload.rack, true);
  assert.equal(payload.items.length, MAX_RACK_ITEMS);
  assert.deepEqual(
    payload.items.map((i) => i.id),
    ['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3', 'a4', 'b4', 'c4'],
  );
  for (const item of payload.items) {
    assert.ok(item.image.startsWith('https://'), `item ${item.id} must have a valid image`);
  }

  // Tool result string matches contract.
  assert.equal(
    result,
    'Rack is on screen: 12 items in relaxed streetwear. Say one short line that you pulled a few things off the racks that go with what they have on (never say "they\'re in"), then ask: dressing for an occasion, or hunting for one specific item? If you already said this line or asked that question, stay silent and do not repeat it.',
  );

  // Department is NOT written to flow state.
  assert.equal(state.get().department, null);

  // No filler/working note for show_rack.
  assert.deepEqual(slowEvents, []);
  assert.deepEqual(workingNotes, []);

  // Logs rack_start and rack_done with expected fields.
  const startLog = logs.find((l) => l.ev === 'rack_start');
  assert.deepEqual(startLog?.data, {
    style: 'relaxed streetwear',
    queries: ['oversized grey hoodie', 'washed cargo pants', 'retro low sneakers'],
    department: 'men',
    photo: false,
  });

  const doneLog = logs.find((l) => l.ev === 'rack_done');
  assert.ok(doneLog);
  assert.equal(doneLog!.data?.items, 12);
  assert.equal(typeof doneLog!.data?.ms, 'number');
  assert.deepEqual(doneLog!.data?.per_query, [6, 7, 5]);
  assert.equal(doneLog!.data?.photo_items, 0);
});

test('show_rack falls back from searchMixed to search when store only exports search', async () => {
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-rack-fallback', log: () => {} });
  let searchCalls = 0;

  const tools = createAgentTools({
    room: 'r-rack-fallback',
    log: () => {},
    page,
    state,
    deps: {
      async loadStoreModule() {
        return {
          async search(query, gender): Promise<SearchResult> {
            searchCalls += 1;
            return {
              items: [makeRackItem(`s-${searchCalls}`, { department: gender, title: query })],
              source: 'live',
              ms: 20,
            };
          },
        };
      },
    },
  });

  const res = await tools.show_rack.execute(
    {
      style: 'minimal tailoring',
      queries: ['structured blazer', 'pleated trousers'],
      department: 'women',
    },
    fakeToolOpts('rk-fb'),
  );

  assert.equal(searchCalls, 2);
  assert.match(res, /^Rack is on screen: 2 items in minimal tailoring\./);
  assert.equal(calls.length, 1);
  assert.equal(state.get().department, null);
});

test('show_rack uses searchByPhoto when exported and frame is available, putting photo items first and deduping against text', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  let capturedPhotoCall: { jpeg: Uint8Array; gender: Gender; opts?: SearchOpts } | null = null;

  assert.equal(resolveSearchByPhoto(null), undefined);
  assert.equal(resolveSearchByPhoto({}), undefined);
  assert.equal(typeof resolveSearchByPhoto({ searchByPhoto: async () => ({ items: [], source: 'empty', ms: 0 }) }), 'function');

  const tools = createAgentTools({
    room: 'r-rack-photo',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    getLatestFrameJpeg: () => fakeJpeg,
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(query): Promise<SearchResult> {
            if (query === 'cropped jacket') {
              return {
                items: [makeRackItem('p1'), makeRackItem('t1'), makeRackItem('t2')],
                source: 'live',
                ms: 30,
              };
            }
            return {
              items: [makeRackItem('t3'), makeRackItem('t4')],
              source: 'live',
              ms: 30,
            };
          },
          async searchByPhoto(jpeg, gender, opts): Promise<SearchResult> {
            capturedPhotoCall = { jpeg, gender, opts };
            return {
              items: [makeRackItem('p1'), makeRackItem('p2')],
              source: 'live',
              ms: 50,
            };
          },
        };
      },
    },
  });

  const res = await tools.show_rack.execute(
    {
      style: 'downtown chic',
      queries: ['cropped jacket', 'wide leg denim'],
      department: 'women',
    },
    fakeToolOpts('rk-photo-1'),
  );

  assert.ok(capturedPhotoCall);
  assert.equal(capturedPhotoCall!.jpeg, fakeJpeg);
  assert.equal(capturedPhotoCall!.gender, 'women');
  assert.deepEqual(capturedPhotoCall!.opts, { limit: 12 });

  const payload = calls[0]!.payload as PageActions['showSearch'];
  assert.deepEqual(
    payload.items.map((i) => i.id),
    ['p1', 'p2', 't1', 't3', 't2', 't4'],
  );
  assert.match(res, /^Rack is on screen: 6 items in downtown chic\./);

  const startLog = logs.find((l) => l.ev === 'rack_start');
  assert.equal(startLog?.data?.photo, true);

  const doneLog = logs.find((l) => l.ev === 'rack_done');
  assert.equal(doneLog?.data?.photo_items, 2);
  assert.deepEqual(doneLog?.data?.per_query, [3, 2]);
  assert.equal(doneLog?.data?.items, 6);
});

test('show_rack handles absent searchByPhoto, missing frame, and throwing searchByPhoto silently', async () => {
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff]);

  // 1) searchByPhoto absent on store module even though frame exists -> photo: false, text results only.
  const logsAbsent: RecordedLog[] = [];
  const pageAbsent = createFakePage();
  const toolsAbsent = createAgentTools({
    room: 'r-rack-absent',
    log: (room, ev, data) => logsAbsent.push({ room, ev, data }),
    page: pageAbsent.page,
    getLatestFrameJpeg: () => fakeJpeg,
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(): Promise<SearchResult> {
            return { items: [makeRackItem('only-text')], source: 'live', ms: 10 };
          },
        };
      },
    },
  });

  const resAbsent = await toolsAbsent.show_rack.execute(
    { style: 'clean casual', queries: ['knit polo'], department: 'men' },
    fakeToolOpts('rk-abs'),
  );
  assert.match(resAbsent, /^Rack is on screen: 1 items in clean casual\./);
  assert.equal(logsAbsent.find((l) => l.ev === 'rack_start')?.data?.photo, false);
  assert.equal(logsAbsent.find((l) => l.ev === 'rack_done')?.data?.photo_items, 0);

  // 2) searchByPhoto present but no camera frame -> does not call searchByPhoto, photo: false.
  let photoCalledWhenNull = 0;
  const logsNoFrame: RecordedLog[] = [];
  const pageNoFrame = createFakePage();
  const toolsNoFrame = createAgentTools({
    room: 'r-rack-noframe',
    log: (room, ev, data) => logsNoFrame.push({ room, ev, data }),
    page: pageNoFrame.page,
    getLatestFrameJpeg: () => null,
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(): Promise<SearchResult> {
            return { items: [makeRackItem('text-no-frame')], source: 'live', ms: 10 };
          },
          async searchByPhoto(): Promise<SearchResult> {
            photoCalledWhenNull += 1;
            return { items: [makeRackItem('should-not-run')], source: 'live', ms: 10 };
          },
        };
      },
    },
  });
  await toolsNoFrame.show_rack.execute(
    { style: 'smart casual', queries: ['oxford shirt'], department: 'men' },
    fakeToolOpts('rk-nf'),
  );
  assert.equal(photoCalledWhenNull, 0);
  assert.equal(logsNoFrame.find((l) => l.ev === 'rack_start')?.data?.photo, false);

  // 3) searchByPhoto throws -> silent fallback to text results only (no tool_error).
  const logsThrow: RecordedLog[] = [];
  const pageThrow = createFakePage();
  const toolsThrow = createAgentTools({
    room: 'r-rack-throw',
    log: (room, ev, data) => logsThrow.push({ room, ev, data }),
    page: pageThrow.page,
    getLatestFrameJpeg: () => fakeJpeg,
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(): Promise<SearchResult> {
            return { items: [makeRackItem('survived-text')], source: 'live', ms: 15 };
          },
          async searchByPhoto(): Promise<SearchResult> {
            throw new Error('vision index unavailable');
          },
        };
      },
    },
  });

  const resThrow = await toolsThrow.show_rack.execute(
    { style: 'edgy layered', queries: ['leather moto jacket'], department: 'women' },
    fakeToolOpts('rk-thr'),
  );
  assert.match(resThrow, /^Rack is on screen: 1 items in edgy layered\./);
  assert.equal(pageThrow.calls.length, 1);
  assert.equal(logsThrow.some((l) => l.ev === 'tool_error'), false);
  assert.equal(logsThrow.find((l) => l.ev === 'rack_start')?.data?.photo, true);
  assert.equal(logsThrow.find((l) => l.ev === 'rack_done')?.data?.photo_items, 0);
  assert.equal(logsThrow.find((l) => l.ev === 'rack_done')?.data?.items, 1);
});

test('show_rack per-query timeout keeps partial results from fast queries and drops hung queries', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();

  const tools = createAgentTools({
    room: 'r-rack-timeout',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    rackTimeoutMs: 40,
    page,
    getLatestFrameJpeg: () => new Uint8Array([0xff, 0xd8]),
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(query): Promise<SearchResult> {
            if (query === 'fast query') {
              return { items: [makeRackItem('fast-1'), makeRackItem('fast-2')], source: 'live', ms: 50 };
            }
            // Never resolves (hung store call).
            return await new Promise<SearchResult>(() => {});
          },
          async searchByPhoto(): Promise<SearchResult> {
            // Also hangs past timeout.
            return await new Promise<SearchResult>(() => {});
          },
        };
      },
    },
  });

  const pending = tools.show_rack.execute(
    {
      style: 'relaxed knitwear',
      queries: ['fast query', 'hung query'],
      department: 'women',
    },
    fakeToolOpts('rk-to'),
  );

  // Flush initial promise setup, then advance past per-query timeout.

  const res = await pending;
  assert.match(res, /^Rack is on screen: 2 items in relaxed knitwear\./);
  assert.equal(calls.length, 1);
  const payload = calls[0]!.payload as PageActions['showSearch'];
  assert.deepEqual(
    payload.items.map((i) => i.id),
    ['fast-1', 'fast-2'],
  );

  const doneLog = logs.find((l) => l.ev === 'rack_done');
  assert.equal(doneLog?.data?.items, 2);
  assert.deepEqual(doneLog?.data?.per_query, [2, 0]);
  assert.equal(doneLog?.data?.photo_items, 0);
});

test('show_rack sends nothing to the page when zero usable items come back and returns NOT DONE', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-rack-zero', log: () => {} });

  const tools = createAgentTools({
    room: 'r-rack-zero',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(): Promise<SearchResult> {
            // Only an item without a valid image comes back.
            return { items: [makeRackItem('bad-img', { image: '' })], source: 'live', ms: 15 };
          },
        };
      },
    },
  });

  const res = await tools.show_rack.execute(
    {
      style: 'vintage workwear',
      queries: ['canvas chore coat', 'carpenter pants'],
      department: 'men',
    },
    fakeToolOpts('rk-zero'),
  );

  assert.equal(res, 'NOT DONE: nothing came back. Skip the rack and ask what the occasion is.');
  assert.equal(calls.length, 0, 'nothing should be sent to the page on zero items');
  assert.equal(state.get().department, null);

  const doneLog = logs.find((l) => l.ev === 'rack_done');
  assert.equal(doneLog?.data?.items, 0);
  assert.deepEqual(doneLog?.data?.per_query, [1, 1]);
  assert.equal(doneLog?.data?.photo_items, 0);
});

test('show_rack runs only once per call; second call returns Rack already shown without searching or sending to page', async () => {
  const logs: RecordedLog[] = [];
  const { page, calls } = createFakePage();
  const state = createCallStateStore({ roomName: 'r-rack-once', log: () => {} });
  let searchCalls = 0;
  let photoCalls = 0;

  const tools = createAgentTools({
    room: 'r-rack-once',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    page,
    state,
    getLatestFrameJpeg: () => new Uint8Array([0xff, 0xd8]),
    deps: {
      async loadStoreModule() {
        return {
          async searchMixed(): Promise<SearchResult> {
            searchCalls += 1;
            return { items: [makeRackItem(`item-${searchCalls}`)], source: 'live', ms: 10 };
          },
          async searchByPhoto(): Promise<SearchResult> {
            photoCalls += 1;
            return { items: [makeRackItem(`photo-${photoCalls}`)], source: 'live', ms: 10 };
          },
        };
      },
    },
  });

  const first = await tools.show_rack.execute(
    { style: 'coastal casual', queries: ['linen overshirt', 'canvas sneakers'], department: 'men' },
    fakeToolOpts('rk-1'),
  );
  assert.match(first, /^Rack is on screen: 3 items in coastal casual\./);
  assert.equal(searchCalls, 2);
  assert.equal(photoCalls, 1);
  assert.equal(calls.length, 1);

  // Second call with identical args within 15s window still returns "Rack already shown." without searching.
  const secondSame = await tools.show_rack.execute(
    { style: 'coastal casual', queries: ['linen overshirt', 'canvas sneakers'], department: 'men' },
    fakeToolOpts('rk-2'),
  );
  assert.equal(secondSame, 'Rack already shown.');
  assert.equal(searchCalls, 2);
  assert.equal(photoCalls, 1);
  assert.equal(calls.length, 1);

  // Third call with different args also returns "Rack already shown." without searching.
  const thirdDiff = await tools.show_rack.execute(
    { style: 'evening sharp', queries: ['black blazer'], department: 'women' },
    fakeToolOpts('rk-3'),
  );
  assert.equal(thirdDiff, 'Rack already shown.');
  assert.equal(searchCalls, 2);
  assert.equal(photoCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(state.get().department, null);

  // Only one rack_start and one rack_done were logged.
  assert.equal(logs.filter((l) => l.ev === 'rack_start').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'rack_done').length, 1);
});
