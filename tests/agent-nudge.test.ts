import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TimerHandle } from '../src/agent/context.ts';
import {
  DEFAULT_RESULT_NUDGE_DELAY_MS,
  createToolResultNudger,
} from '../src/agent/nudge.ts';

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

test('nudges after 3s and logs result_nudge when build_outfits, show_on_me, or add_to_bag finishes while Alice is silent', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const nudger = createToolResultNudger({
    room: 'nudge-room',
    initialAgentState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) build_outfits finishes while Alice is idle after answering an in-between shopper turn.
  nudger.onToolResult({
    name: 'build_outfits',
    callId: 'c-build-1',
    text: 'Built 3 looks and they are now on screen.',
  });
  assert.equal(nudger.hasPending, true);

  clock.advance(DEFAULT_RESULT_NUDGE_DELAY_MS - 1);
  assert.equal(replies.length, 0);

  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /present the looks/i);
  assert.equal(nudger.hasPending, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'result_nudge');
  assert.deepEqual(logs[0]!.data, {
    tool: 'build_outfits',
    call_id: 'c-build-1',
    wait_ms: DEFAULT_RESULT_NUDGE_DELAY_MS,
  });

  // 2) show_on_me finishes while idle -> nudges after 3s.
  nudger.onToolResult({
    name: 'show_on_me',
    callId: 'c-show-1',
    text: 'Try-on for Look 1 is now revealed on screen.',
  });
  clock.advance(DEFAULT_RESULT_NUDGE_DELAY_MS);
  assert.equal(replies.length, 2);
  assert.match(replies[1]!.instructions, /try-on/i);
  assert.equal(logs[1]!.ev, 'result_nudge');
  assert.equal(logs[1]!.data?.tool, 'show_on_me');

  // 3) add_to_bag finishes while idle -> nudges after 3s.
  nudger.onToolResult({
    name: 'add_to_bag',
    callId: 'c-bag-1',
    text: 'Added 3 pieces, total $160.',
  });
  clock.advance(DEFAULT_RESULT_NUDGE_DELAY_MS);
  assert.equal(replies.length, 3);
  assert.match(replies[2]!.instructions, /bag/i);
  assert.equal(logs[2]!.ev, 'result_nudge');
  assert.equal(logs[2]!.data?.tool, 'add_to_bag');
});

test('never double-speaks when Alice starts speaking or emits an assistant message before 3s', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const nudger = createToolResultNudger({
    room: 'nudge-nodouble',
    initialAgentState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Case A: Agent transitions to speaking after 800ms -> cancels nudge.
  nudger.onToolResult({
    name: 'build_outfits',
    callId: 'c-1',
    text: 'Built 3 looks and they are now on screen.',
  });
  clock.advance(800);
  nudger.onAgentStateChanged('speaking');
  assert.equal(nudger.hasPending, false);
  clock.advance(10_000);
  assert.equal(replies.length, 0);
  assert.equal(logs.length, 0);

  // Return to listening; Case B: assistant message arrives before 3s -> cancels nudge.
  nudger.onAgentStateChanged('listening');
  nudger.onToolResult({
    name: 'show_on_me',
    callId: 'c-2',
    text: 'Try-on revealed.',
  });
  clock.advance(500);
  nudger.onAssistantMessage();
  clock.advance(10_000);
  assert.equal(replies.length, 0);
  assert.equal(logs.length, 0);
});

test('waits until in-progress agent speech ends before starting the 3s nudge window', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const nudger = createToolResultNudger({
    room: 'nudge-speaking',
    initialAgentState: 'speaking',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Tool finishes while Alice is mid-sentence answering an earlier shopper question.
  nudger.onToolResult({
    name: 'build_outfits',
    callId: 'c-mid',
    text: 'Built 3 looks and they are now on screen.',
  });

  // Even after 5 seconds while she's still finishing that earlier sentence, no nudge fires.
  clock.advance(5_000);
  assert.equal(replies.length, 0);
  assert.equal(nudger.hasPending, true);

  // She finishes that earlier turn -> now 3s window begins.
  nudger.onAgentStateChanged('listening');
  clock.advance(2_999);
  assert.equal(replies.length, 0);

  // If she stays silent for 3s -> nudge fires!
  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'result_nudge');

  // Repeat scenario, but this time Gemini auto-replies 600ms after she finishes -> NO double-speak!
  nudger.onAgentStateChanged('speaking');
  nudger.onToolResult({
    name: 'add_to_bag',
    callId: 'c-mid-2',
    text: 'Added 3 pieces, total $160.',
  });
  nudger.onAgentStateChanged('listening');
  clock.advance(600);
  nudger.onAgentStateChanged('speaking');
  clock.advance(10_000);
  assert.equal(replies.length, 1);
  assert.equal(logs.length, 1);
});

test('pauses while shopper is speaking, ignores non-watched tools, and disposes cleanly', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const nudger = createToolResultNudger({
    room: 'nudge-user',
    initialAgentState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Non-watched tool never arms a nudge.
  nudger.onToolResult({ name: 'remember', callId: 'r1', text: 'Remembered: likes navy.' });
  assert.equal(nudger.hasPending, false);
  clock.advance(10_000);
  assert.equal(replies.length, 0);

  // Watched tool finishes; shopper starts speaking at 1s -> timer pauses until shopper stops.
  nudger.onToolResult({ name: 'build_outfits', callId: 'b1', text: 'Built 3 looks.' });
  clock.advance(1_000);
  nudger.onUserStateChanged('speaking');
  clock.advance(5_000);
  assert.equal(replies.length, 0, 'must not interrupt active shopper speech');

  // Shopper stops speaking; Gemini still stays silent -> nudge fires 3s later.
  nudger.onUserStateChanged('listening');
  clock.advance(2_999);
  assert.equal(replies.length, 0);
  clock.advance(1);
  assert.equal(replies.length, 1);

  // Dispose cancels pending timers and ignores further events.
  nudger.onToolResult({ name: 'add_to_bag', callId: 'b2', text: 'Added 2 pieces.' });
  assert.equal(clock.activeTimers(), 1);
  nudger.dispose();
  assert.equal(clock.activeTimers(), 0);
  clock.advance(10_000);
  assert.equal(replies.length, 1);
});
