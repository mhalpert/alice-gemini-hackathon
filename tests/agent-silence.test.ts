import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TimerHandle } from '../src/agent/context.ts';
import {
  DEFAULT_FILLER_INITIAL_DELAY_MS,
  createToolFiller,
} from '../src/agent/filler.ts';
import {
  DEFAULT_RESULT_NUDGE_DELAY_MS,
  createToolResultNudger,
} from '../src/agent/nudge.ts';
import {
  DEFAULT_SILENCE_FIRST_MS,
  DEFAULT_SILENCE_SECOND_MS,
  createSilenceCheckIn,
  isGoodbyeMessage,
} from '../src/agent/silence.ts';

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

test('fires check-in at 7s, second check-in in different words after another 10s, then stops quietly', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const silence = createSilenceCheckIn({
    room: 'silence-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Does not fire before Alice has spoken.
  clock.advance(20_000);
  assert.equal(replies.length, 0);

  // Alice asks a question and finishes speaking -> arms 7s timer.
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('What occasion are we shopping for?');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, true);

  clock.advance(DEFAULT_SILENCE_FIRST_MS - 1);
  assert.equal(replies.length, 0);

  // At 7s -> check-in #1 fires and logs silence_checkin with count: 1.
  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.equal(silence.checkInCount, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'silence_checkin');
  assert.equal(logs[0]!.data?.count, 1);

  // Alice speaks check-in #1, then finishes -> arms 10s timer.
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  assert.equal(replies.length, 1);
  silence.onAgentStateChanged('listening');

  clock.advance(DEFAULT_SILENCE_SECOND_MS - 1);
  assert.equal(replies.length, 1);

  // At +10s -> check-in #2 fires in different wording and logs count: 2.
  clock.advance(1);
  assert.equal(replies.length, 2);
  assert.equal(silence.checkInCount, 2);
  assert.notEqual(replies[0]!.instructions, replies[1]!.instructions);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.ev, 'silence_checkin');
  assert.equal(logs[1]!.data?.count, 2);

  // Alice speaks check-in #2, then finishes -> waits quietly (NO 3rd prompt).
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  silence.onAgentStateChanged('listening');
  clock.advance(60_000);
  assert.equal(replies.length, 2, 'must never fire a third check-in before shopper speaks');
  assert.equal(clock.activeTimers(), 0);
});

test('resets on shopper speech (both mid-wait and after 2 check-ins) and typed shopper activity', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const silence = createSilenceCheckIn({
    room: 'silence-reset',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Shopper speaks at 5s -> cancels pending 7s check-in; never fires while shopper speaks.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(5_000);
  silence.onUserStateChanged('speaking');
  clock.advance(15_000);
  assert.equal(replies.length, 0, 'must never fire while shopper is speaking');

  // Shopper finishes and Alice responds -> fresh 7s cycle starts after Alice finishes.
  silence.onUserStateChanged('listening');
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');

  // Let both check-ins fire (7s then 10s, even without intermediate speaking events).
  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 1);
  assert.equal(logs[0]!.data?.count, 1);

  clock.advance(DEFAULT_SILENCE_SECOND_MS);
  assert.equal(replies.length, 2);
  assert.equal(logs[1]!.data?.count, 2);
  assert.equal(silence.checkInCount, 2);

  // Quiet after 2 check-ins.
  clock.advance(30_000);
  assert.equal(replies.length, 2);

  // Shopper speaks again -> resets count to 0!
  silence.onUserStateChanged('speaking');
  assert.equal(silence.checkInCount, 0);
  silence.onUserStateChanged('listening');
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');

  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 3);
  assert.equal(logs[2]!.data?.count, 1);
  // Rotated wording on new first check-in.
  assert.notEqual(replies[2]!.instructions, replies[0]!.instructions);

  // Typed shopper activity cancels armed timer and resets count.
  silence.onShopperActivity();
  assert.equal(silence.checkInCount, 0);
  clock.advance(30_000);
  assert.equal(replies.length, 3);
});

test('never fires while a tool is running, when suppressed, or right after a goodbye', () => {
  assert.equal(isGoodbyeMessage('Thanks so much, have a great night!'), true);
  assert.equal(isGoodbyeMessage('Bye, enjoy the wedding!'), true);
  assert.equal(isGoodbyeMessage('See you next time!'), true);
  assert.equal(isGoodbyeMessage('What is your budget for the wedding?'), false);
  assert.equal(isGoodbyeMessage('Have a great night planned—what are we dressing for?'), false);

  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  let suppressed = false;

  const silence = createSilenceCheckIn({
    room: 'silence-guard',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => suppressed,
    generateReply: (opts) => replies.push(opts),
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Never fires while a tool is running.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(3_000);
  silence.onToolStart('call-build-1');
  clock.advance(30_000);
  assert.equal(replies.length, 0, 'must never fire while a tool is running');

  // Even right after tool ends, waits until Alice actually finishes presenting the result.
  silence.onToolEnd('call-build-1');
  clock.advance(15_000);
  assert.equal(replies.length, 0);

  // 2) Respects external suppression (e.g. pending result nudge).
  suppressed = true;
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(15_000);
  assert.equal(replies.length, 0);
  suppressed = false;

  // 3) Never fires right after a goodbye (transcript arriving AFTER listening).
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(50);
  silence.onAssistantMessage('You are all set, have a great evening and bye!');
  clock.advance(30_000);
  assert.equal(replies.length, 0, 'must not check in after goodbye (late transcript)');

  // 4) Never fires right after a goodbye (transcript arriving BEFORE listening).
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Take care, see you soon!');
  silence.onAgentStateChanged('listening');
  clock.advance(30_000);
  assert.equal(replies.length, 0, 'must not check in after goodbye (early transcript)');

  // 5) Shopper speaks again after goodbye -> re-enables check-in on next Alice turn.
  silence.onUserStateChanged('speaking');
  silence.onUserStateChanged('listening');
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Oh wait, want a second look?');
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 1);

  // 6) Dispose clears timers and ignores further events.
  silence.dispose();
  assert.equal(clock.activeTimers(), 0);
  clock.advance(30_000);
  assert.equal(replies.length, 1);
});

test('filler timer, result nudger, and silence check-in coordinate without overlapping across a full slow-tool turn', () => {
  const clock = createFakeClock();
  const workingNotes: string[] = [];
  const replies: Array<{ source: string; instructions: string }> = [];
  const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];

  const nudger = createToolResultNudger({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push({ source: 'nudge', instructions: opts.instructions }),
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const filler = createToolFiller({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    sendWorkingNote: (params) => {
      workingNotes.push(params.note);
      return true;
    },
    generateReply: (opts) => replies.push({ source: 'filler', instructions: opts.instructions }),
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const silence = createSilenceCheckIn({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => nudger.hasPending || filler.isRunning,
    generateReply: (opts) => replies.push({ source: 'silence', instructions: opts.instructions }),
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const setAgent = (state: 'speaking' | 'listening') => {
    nudger.onAgentStateChanged(state);
    filler.onAgentStateChanged(state);
    silence.onAgentStateChanged(state);
  };

  // Slow build_outfits starts -> silence is disabled, filler sends bit #1 at 2s.
  silence.onToolStart('b-coord');
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'b-coord',
    baseNote: 'Working on building three outfits now.',
  });

  clock.advance(DEFAULT_FILLER_INITIAL_DELAY_MS);
  assert.equal(workingNotes.length, 1);

  // Alice speaks bit #1; tool finishes mid-bit at +3s.
  setAgent('speaking');
  clock.advance(3_000);
  filler.onToolEnd('b-coord');
  silence.onToolEnd('b-coord');
  nudger.onToolResult({
    name: 'build_outfits',
    callId: 'b-coord',
    text: 'Built 3 looks and they are now on screen.',
  });

  // Alice finishes bit sentence -> nudger arms 3s window; filler does NOT fire; silence stays suppressed.
  setAgent('listening');
  nudger.onAssistantMessage('Kevin owns one outfit, a beige fleece vest.');
  clock.advance(DEFAULT_RESULT_NUDGE_DELAY_MS);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.source, 'nudge');

  // Alice presents the looks and finishes asking which catches their eye -> 7s later silence check-in fires once.
  setAgent('speaking');
  clock.advance(4_000);
  setAgent('listening');
  nudger.onAssistantMessage('Look 1 is crisp, Look 2 is relaxed, Look 3 is sharp—which catches your eye?');
  silence.onAssistantMessage('Look 1 is crisp, Look 2 is relaxed, Look 3 is sharp—which catches your eye?');

  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 2);
  assert.equal(replies[1]!.source, 'silence');
  assert.equal(logs.filter((l) => l.ev === 'filler_bit').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'result_nudge').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'silence_checkin').length, 1);
});
