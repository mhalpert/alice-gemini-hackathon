import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppContextSender, type TimerHandle } from '../src/agent/context.ts';
import {
  createCallStateStore,
  createInitialCallState,
  extractNameFromFact,
  normalizeSlotKey,
  reduceCallState,
  summarize,
} from '../src/agent/state.ts';

function createFakeScheduler() {
  let now = 0;
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

  return { setTimeoutFn, clearTimeoutFn, advance };
}

test('reduceCallState tracks full call lifecycle purely and reports exact changed keys', () => {
  let state = createInitialCallState();
  assert.equal(state.camera, 'off');
  assert.equal(state.department, null);

  let step = reduceCallState(state, { type: 'set_camera', camera: 'on' });
  assert.deepEqual(step.changed, ['camera']);
  assert.equal(step.state.camera, 'on');
  assert.equal(state.camera, 'off', 'reducer must not mutate prior state');
  state = step.state;

  // Idempotent update reports no changes.
  step = reduceCallState(state, { type: 'set_camera', camera: 'on' });
  assert.deepEqual(step.changed, []);

  step = reduceCallState(state, { type: 'set_department', department: 'men' });
  assert.deepEqual(step.changed, ['department']);
  state = step.state;

  step = reduceCallState(state, {
    type: 'set_brief',
    occasion: 'rooftop birthday',
    budgetAsked: true,
    budgetGiven: 150,
    ownPiece: 'olive jacket',
  });
  assert.deepEqual(step.changed, ['occasion', 'budget', 'ownPiece']);
  state = step.state;

  step = reduceCallState(state, {
    type: 'set_looks',
    replace: true,
    looks: [{ number: 1, name: 'Skyline Knit', total: 104.98, slots: ['top', 'bottom', 'shoes'] }],
  });
  assert.deepEqual(step.changed, ['looks']);
  state = step.state;

  step = reduceCallState(state, {
    type: 'set_looks',
    replace: false,
    looks: [{ number: 2, name: 'Warm Neutrals', total: 111.96, slots: ['top', 'bottom', 'shoes'] }],
  });
  assert.deepEqual(step.changed, ['looks']);
  assert.equal(step.state.looks.length, 2);
  state = step.state;

  step = reduceCallState(state, { type: 'pick_look', look: 1 });
  assert.deepEqual(step.changed, ['pickedLook']);
  state = step.state;

  step = reduceCallState(state, {
    type: 'set_tryon',
    look: 1,
    status: 'ready',
    url: 'https://cdn/tryon-1.jpg',
  });
  assert.deepEqual(step.changed, ['tryOn']);
  state = step.state;

  step = reduceCallState(state, { type: 'mark_revealed', look: 1 });
  assert.deepEqual(step.changed, ['revealsDone']);
  state = step.state;

  // Updating look clears its try-on and reveal flag.
  step = reduceCallState(state, {
    type: 'update_look',
    look: { number: 1, name: 'Skyline Knit', total: 120, slots: ['top', 'bottom', 'shoes'] },
  });
  assert.deepEqual(step.changed, ['looks', 'tryOn', 'revealsDone']);
  assert.equal(step.state.tryOn[1], undefined);
  assert.deepEqual(step.state.revealsDone, []);
  state = step.state;

  // Merge sizes normalizes aliases and remembers earlier slots.
  step = reduceCallState(state, { type: 'merge_sizes', sizes: { Top: 'M', shoe: '10' } });
  assert.deepEqual(step.changed, ['sizes']);
  assert.deepEqual(step.state.sizes, { top: 'M', shoes: '10' });
  state = step.state;

  step = reduceCallState(state, { type: 'merge_sizes', sizes: { bottom: '32' } });
  assert.deepEqual(step.changed, ['sizes']);
  assert.deepEqual(step.state.sizes, { top: 'M', shoes: '10', bottom: '32' });
  state = step.state;

  // Bag + second outfit offered + facts with name extraction.
  step = reduceCallState(state, {
    type: 'set_bag',
    bag: {
      stores: [{ store: 'Everlane', added: [{ title: 'Chino', slot: 'bottom', image: '', price: 38, size: '32' }], not_added: [], subtotal: 38 }],
      total: 38,
      links: [{ store: 'Everlane', url: 'https://everlane.com/cart' }],
      notAdded: [],
    },
  });
  assert.deepEqual(step.changed, ['bag']);
  state = step.state;

  step = reduceCallState(state, { type: 'set_second_outfit_offered', offered: true });
  assert.deepEqual(step.changed, ['secondOutfitOffered']);
  state = step.state;

  step = reduceCallState(state, { type: 'add_fact', fact: "Shopper's name is Maya" });
  assert.deepEqual(step.changed, ['facts', 'shopperName']);
  assert.equal(step.state.shopperName, 'Maya');
  state = step.state;

  // Duplicate fact (case-insensitive) produces no change.
  step = reduceCallState(state, { type: 'add_fact', fact: "shopper's name is maya" });
  assert.deepEqual(step.changed, []);
});

test('summarize renders a compact one-paragraph CALL STATE string covering all populated fields', () => {
  let state = createInitialCallState();
  const initial = summarize(state);
  assert.equal(initial.startsWith('CALL STATE: '), true);
  assert.equal(initial.includes('\n'), false);
  assert.match(initial, /dept=unset/);
  assert.match(initial, /camera=off/);
  assert.match(initial, /looks=none/);

  state = reduceCallState(state, { type: 'set_shopper_name', name: 'Alex' }).state;
  state = reduceCallState(state, { type: 'set_department', department: 'women' }).state;
  state = reduceCallState(state, { type: 'set_camera', camera: 'on' }).state;
  state = reduceCallState(state, {
    type: 'set_brief',
    occasion: 'gallery opening',
    budgetAsked: true,
    budgetGiven: 300,
    ownPiece: 'black trench',
  }).state;
  state = reduceCallState(state, {
    type: 'set_looks',
    replace: true,
    looks: [{ number: 1, name: 'SoHo Sharp', total: 245.5, slots: ['dress', 'shoes'] }],
  }).state;
  state = reduceCallState(state, { type: 'pick_look', look: 1 }).state;
  state = reduceCallState(state, { type: 'set_tryon', look: 1, status: 'ready', url: 'https://img/1.jpg' }).state;
  state = reduceCallState(state, { type: 'mark_revealed', look: 1 }).state;
  state = reduceCallState(state, { type: 'merge_sizes', sizes: { dress: 'S', shoes: '8' } }).state;
  state = reduceCallState(state, { type: 'add_fact', fact: 'hates neon' }).state;

  const text = summarize(state);
  assert.equal(text.startsWith('CALL STATE: '), true);
  assert.equal(text.includes('\n'), false);
  assert.match(text, /shopper=Alex/);
  assert.match(text, /dept=women/);
  assert.match(text, /camera=on/);
  assert.match(text, /occasion=gallery opening/);
  assert.match(text, /budget=\$300/);
  assert.match(text, /own_piece=black trench/);
  assert.match(text, /#1 SoHo Sharp \(\$245\.50: dress,shoes tryon=ready revealed\)/);
  assert.match(text, /picked=Look 1/);
  assert.match(text, /sizes=\{dress:S, shoes:8\}/);
  assert.match(text, /notes=\[hates neon\]/);
});

test('extractNameFromFact extracts clear names and ignores unrelated facts', () => {
  assert.equal(extractNameFromFact("Shopper's name is Priya"), 'Priya');
  assert.equal(extractNameFromFact('Name: Jordan'), 'Jordan');
  assert.equal(extractNameFromFact('called Sam.'), 'Sam');
  assert.equal(extractNameFromFact('loves earth tones'), null);
  assert.equal(extractNameFromFact('Name: Shopper'), null);
});

test('createCallStateStore logs call_state changed keys and holds/coalesces through AppContextSender', () => {
  const sent: string[] = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const clock = createFakeScheduler();

  const appContext = new AppContextSender({
    send: (text) => sent.push(text),
    initialState: 'speaking',
    flushDelayMs: 300,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const store = createCallStateStore({
    roomName: 'state-room',
    appContext,
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  store.dispatch({ type: 'set_department', department: 'men' });
  store.dispatch({ type: 'set_camera', camera: 'on' });

  // Nothing sent while speaking.
  assert.equal(sent.length, 0);
  assert.deepEqual(
    logs.map((l) => ({ ev: l.ev, changed: l.data?.changed })),
    [
      { ev: 'call_state', changed: ['department'] },
      { ev: 'call_state', changed: ['camera'] },
    ],
  );

  // Returning to listening flushes only the newest CALL STATE (without double prefix).
  appContext.setAgentState('listening');
  clock.advance(300);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.startsWith('CALL STATE: '), true);
  assert.equal(sent[0]!.startsWith('CALL STATE: CALL STATE:'), false);
  assert.match(sent[0]!, /dept=men/);
  assert.match(sent[0]!, /camera=on/);
});

test('summarize includes NOT_ADDED piece titles and reasons in CALL STATE and clears them once bagged', () => {
  let state = createInitialCallState();
  state = reduceCallState(state, {
    type: 'set_bag',
    bag: {
      stores: [
        {
          store: 'Everlane',
          added: [{ title: 'Merino Knit Polo', slot: 'top', image: '', price: 45, size: 'M' }],
          not_added: [],
          subtotal: 45,
        },
        {
          store: 'Steve Madden',
          added: [],
          not_added: [
            {
              title: 'Minimal Leather Sneaker',
              slot: 'shoes',
              image: '',
              price: 55,
              reason: 'EU sizes only.\n',
            },
          ],
          subtotal: 0,
        },
      ],
      total: 45,
      links: [{ store: 'Everlane', url: 'https://everlane.com/cart/1' }],
      notAdded: [
        {
          store: 'Steve Madden',
          title: 'Minimal Leather Sneaker',
          reason: 'EU sizes only.\n',
        },
      ],
    },
  }).state;

  const partialSummary = summarize(state);
  assert.equal(partialSummary.includes('\n'), false, 'CALL STATE must remain single-line');
  assert.match(partialSummary, /NOT_ADDED=\[Minimal Leather Sneaker \(EU sizes only\)\]/);

  // Subsequent clean bag clears NOT_ADDED from CALL STATE.
  state = reduceCallState(state, {
    type: 'set_bag',
    bag: {
      stores: [
        {
          store: 'Everlane',
          added: [{ title: 'Merino Knit Polo', slot: 'top', image: '', price: 45, size: 'M' }],
          not_added: [],
          subtotal: 45,
        },
      ],
      total: 45,
      links: [{ store: 'Everlane', url: 'https://everlane.com/cart/2' }],
      notAdded: [],
    },
  }).state;

  const cleanSummary = summarize(state);
  assert.doesNotMatch(cleanSummary, /NOT_ADDED=/);
});

test('merge_sizes replaces previously remembered sizes on explicit correction and preserves exact strings', () => {
  let state = createInitialCallState();
  state = reduceCallState(state, {
    type: 'merge_sizes',
    sizes: { top: 'L', pants: '36', sneakers: '12' },
  }).state;
  assert.deepEqual(state.sizes, { top: 'L', bottom: '36', shoes: '12' });

  // Later explicit correction replaces remembered values and preserves half sizes, widths, and waist x inseam.
  const corrected = reduceCallState(state, {
    type: 'merge_sizes',
    sizes: { top: 'medium', bottom: '30x34', shoes: '8.5 wide' },
  });
  assert.deepEqual(corrected.changed, ['sizes']);
  assert.deepEqual(corrected.state.sizes, {
    top: 'medium',
    bottom: '30x34',
    shoes: '8.5 wide',
  });
});

test('CallStateStore keeps recent shopper turns deduplicated and capped without emitting call_state updates', () => {
  const sent: string[] = [];
  const logs: Array<{ room: string; ev: string }> = [];
  const appContext = new AppContextSender({
    send: (text) => sent.push(text),
    initialState: 'listening',
  });
  const store = createCallStateStore({
    roomName: 'turns-room',
    appContext,
    log: (room, ev) => logs.push({ room, ev }),
  });

  store.recordShopperTurn('Medium top, 32 waist, shoes 10 and a half.', 'item-1');
  // Duplicate by itemId (e.g. both UserInputTranscribed and ConversationItemAdded) does not double-store.
  store.recordShopperTurn('Medium top, 32 waist, shoes 10 and a half.', 'item-1');
  // Consecutive identical text without itemId is also deduplicated.
  store.recordShopperTurn('Medium top, 32 waist, shoes 10 and a half.');
  assert.deepEqual(store.getRecentShopperTurns(), [
    'Medium top, 32 waist, shoes 10 and a half.',
  ]);
  assert.equal(sent.length, 0, 'recording shopper turns must not spam CALL STATE');
  assert.equal(logs.length, 0);

  // Caps at last 10 turns.
  for (let i = 2; i <= 12; i++) {
    store.recordShopperTurn(`turn ${i}`, `item-${i}`);
  }
  const recent = store.getRecentShopperTurns();
  assert.equal(recent.length, 10);
  assert.equal(recent[0], 'turn 3');
  assert.equal(recent[9], 'turn 12');

  // normalizeSlotKey maps outerwear/blazer/jacket to layer.
  assert.equal(normalizeSlotKey('outerwear'), 'layer');
  assert.equal(normalizeSlotKey('blazer'), 'layer');
  assert.equal(normalizeSlotKey('jacket'), 'layer');
});
