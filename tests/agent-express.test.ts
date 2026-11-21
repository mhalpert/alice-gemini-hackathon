import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppContextSender, type TimerHandle } from '../src/agent/context.ts';
import {
  EXPRESS_OFF_INSTRUCTION,
  EXPRESS_ON_INSTRUCTION,
  isHurryPhrase,
  isSlowDownPhrase,
} from '../src/agent/express.ts';
import {
  BUILD_OUTFITS_FILLER_DELAY_MS,
  DEFAULT_FILLER_INITIAL_DELAY_MS,
  createToolFiller,
} from '../src/agent/filler.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import { createAgentTools, type WorkingNoteParams } from '../src/agent/tools.ts';
import type { PageActionName, PageActionReply, PageActions } from '../src/types.ts';

function createFakeClock(start = 10_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  const setTimeoutFn = (fn: () => void, ms: number): TimerHandle => {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, fn });
    return { id } as unknown as TimerHandle;
  };

  const clearTimeoutFn = (handle: TimerHandle): void => {
    timers.delete((handle as unknown as { id: number }).id);
  };

  const advance = (ms: number): void => {
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
    }
  };

  return { now: () => now, setTimeoutFn, clearTimeoutFn, advance, activeTimers: () => timers.size };
}

test('isHurryPhrase detects hurry/express phrases and rejects negatives like "no hurry"', () => {
  const positives = [
    "I'm in a hurry",
    'Im in a hurry, wedding under 300',
    'in a rush',
    "I'm in a big rush right now",
    "I'm short on time",
    'short on time today',
    'make it quick',
    'can we make it quick please',
    'express',
    'let us do express mode',
    'turbo',
    'go turbo',
    'speed round',
    'let us do a speed round',
    'I only have a minute',
    'only have two minutes',
  ];
  for (const phrase of positives) {
    assert.equal(isHurryPhrase(phrase), true, `expected hurry match for: "${phrase}"`);
  }

  const negatives = [
    'no hurry',
    'no hurry at all',
    'no rush',
    "I'm not in a hurry",
    "I'm not in a rush",
    "don't rush",
    'take your time',
    'slow down',
    'I want to express myself with bold colors',
    'Do they offer express shipping?',
    'I have an American Express card',
    'Wedding in Chicago, budget $300',
    'Medium top, 32 pants, size 10 shoes',
    '',
  ];
  for (const phrase of negatives) {
    assert.equal(isHurryPhrase(phrase), false, `must NOT match hurry for: "${phrase}"`);
  }

  assert.equal(isSlowDownPhrase('take your time'), true);
  assert.equal(isSlowDownPhrase('slow down'), true);
  assert.equal(isSlowDownPhrase('no rush'), true);
  assert.equal(isSlowDownPhrase('no hurry'), true);
  assert.equal(isSlowDownPhrase("I'm in a hurry"), false);
  assert.equal(isSlowDownPhrase('make it quick'), false);
});

test('express flag is set on hurry turn, logs express_on, injects instruction, and clears on slow-down phrases', () => {
  const sentContext: string[] = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const appContext = new AppContextSender({
    send: (text) => sentContext.push(text),
    initialState: 'listening',
  });

  const transitions: boolean[] = [];
  const state = createCallStateStore({
    roomName: 'express-room',
    appContext,
    onExpressChange: (v) => transitions.push(v),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(state.get().express, false);

  // Negated phrase must NOT turn express on.
  state.recordShopperTurn('No hurry at all, just browsing', 'u-1');
  assert.equal(state.get().express, false);
  assert.equal(logs.some((l) => l.ev === 'express_on'), false);

  // Hurry phrase sets flag, logs express_on, includes express=on in CALL STATE, and injects instruction.
  state.recordShopperTurn("I'm in a hurry, wedding under $300", 'u-2');
  assert.equal(state.get().express, true);
  assert.deepEqual(transitions, [true]);
  assert.match(state.summarize(), /express=on/);
  assert.equal(
    logs.filter((l) => l.ev === 'express_on').length,
    1,
    'must log express_on once',
  );
  assert.ok(
    sentContext.includes(EXPRESS_ON_INSTRUCTION),
    'must inject EXPRESS_ON_INSTRUCTION via appContext',
  );

  // Duplicate event for same turn or another hurry turn while already on must not re-log.
  state.recordShopperTurn("I'm in a hurry, wedding under $300", 'u-2');
  state.recordShopperTurn('make it quick', 'u-3');
  assert.equal(logs.filter((l) => l.ev === 'express_on').length, 1);

  // Saying "take your time" / "slow down" / "no rush" turns express off.
  state.recordShopperTurn('Actually, slow down, no rush', 'u-4');
  assert.equal(state.get().express, false);
  assert.deepEqual(transitions, [true, false]);
  assert.doesNotMatch(state.summarize(), /express=on/);
  assert.equal(logs.filter((l) => l.ev === 'express_off').length, 1);
  assert.ok(
    sentContext.includes(EXPRESS_OFF_INSTRUCTION),
    'must inject EXPRESS_OFF_INSTRUCTION when turned off',
  );

  // Can turn back on and off with "take your time".
  state.recordShopperTurn('turbo', 'u-5');
  assert.equal(state.get().express, true);
  state.recordShopperTurn('take your time', 'u-6');
  assert.equal(state.get().express, false);
});

test('express mode suppresses tool fillers (and cancels queued fillers) and skips show_rack when not yet called', async () => {
  const clock = createFakeClock();
  const workingNotes: WorkingNoteParams[] = [];
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  let fillerRef: ReturnType<typeof createToolFiller> | null = null;
  const state = createCallStateStore({
    roomName: 'express-filler-room',
    onExpressChange: (express) => {
      if (express) fillerRef?.cancelAll();
    },
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const filler = createToolFiller({
    room: 'express-filler-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => state.get().express,
    sendWorkingNote: (n) => {
      workingNotes.push(n);
      return true;
    },
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  fillerRef = filler;

  // 1) Turning express on while a build_outfits filler is queued cancels it immediately.
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'b-mid',
    baseNote: 'Pulling three killer outfits together now.',
  });
  clock.advance(2_000);
  state.recordShopperTurn('speed round', 'u-mid');
  clock.advance(10_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(filler.isRunning, false);

  // 2) New slow tools while express is on never queue or speak fillers.
  filler.onToolStart({
    name: 'show_on_me',
    callId: 's-exp',
    baseNote: 'Spinning up the try-on reveal now.',
  });
  clock.advance(BUILD_OUTFITS_FILLER_DELAY_MS + 10_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);

  // 3) Turning express off re-enables normal fillers.
  state.recordShopperTurn('no rush', 'u-off');
  filler.onToolStart({
    name: 'show_on_me',
    callId: 's-normal',
    baseNote: 'Spinning up the try-on reveal now.',
  });
  clock.advance(DEFAULT_FILLER_INITIAL_DELAY_MS);
  assert.equal(workingNotes.length, 1);
  filler.onToolResult({ callId: 's-normal', name: 'show_on_me' });

  // 4) In express mode, show_rack is skipped without searching or touching the page, and tools' beginSlowWork is suppressed.
  state.recordShopperTurn("I only have a minute", 'u-on2');
  let searchCalled = 0;
  const pageCalls: Array<{ action: PageActionName; payload: unknown }> = [];
  const fakePage = {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageActionReply> {
      pageCalls.push({ action, payload });
      return { ok: true };
    },
  };

  let resolveSearch!: () => void;
  const searchGate = new Promise<void>((r) => {
    resolveSearch = r;
  });

  const tools = createAgentTools({
    room: 'express-tools-room',
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendWorkingNote: (n) => {
      workingNotes.push(n);
      return true;
    },
    page: fakePage,
    state,
    deps: {
      async searchProducts() {
        searchCalled += 1;
        await searchGate;
        return { items: [], source: 'live', ms: 10 };
      },
    },
  });

  const rackRes = await tools.show_rack.execute(
    { style: 'minimal chic', queries: ['black blazer'], department: 'women' },
    { toolCallId: 'rack-exp' } as never,
  );
  assert.match(rackRes, /express mode.*skipped the rack/i);
  assert.equal(searchCalled, 0, 'show_rack must not search when express is on');
  assert.equal(pageCalls.length, 0, 'show_rack must not send showSearch when express is on');

  // Even a slow search_products emits zero working notes while express is on.
  const notesBefore = workingNotes.length;
  const searchPromise = tools.search_products.execute(
    { query: 'white tee' },
    { toolCallId: 'sr-exp' } as never,
  );
  clock.advance(10_000);
  resolveSearch();
  await searchPromise;
  assert.equal(workingNotes.length, notesBefore, 'tools beginSlowWork must suppress fillers in express mode');
});
