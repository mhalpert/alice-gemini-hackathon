import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TimerHandle } from '../src/agent/context.ts';
import { createExtraAnnouncer } from '../src/agent/extras.ts';
import {
  DEFAULT_FILLER_INITIAL_DELAY_MS,
  createToolFiller,
} from '../src/agent/filler.ts';
import {
  DEFAULT_RESULT_NUDGE_DELAY_MS,
  createToolResultNudger,
} from '../src/agent/nudge.ts';
import {
  DEFAULT_SILENCE_COOLDOWN_MS,
  DEFAULT_SILENCE_FIRST_MS,
  DEFAULT_SILENCE_SECOND_MS,
  MAX_SILENCE_CHECKINS_PER_CALL,
  createSilenceCheckIn,
  endsWithQuestionMark,
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

test('fires first check-in at 9s, second check-in 12s later in different words, then stops quietly', () => {
  assert.equal(DEFAULT_SILENCE_FIRST_MS, 9_000);
  assert.equal(DEFAULT_SILENCE_SECOND_MS, 12_000);
  assert.equal(DEFAULT_SILENCE_COOLDOWN_MS, 30_000);
  assert.equal(MAX_SILENCE_CHECKINS_PER_CALL, 4);

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

  // Alice asks a question and finishes speaking -> arms 9s timer.
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('What occasion are we shopping for?');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, true);

  clock.advance(DEFAULT_SILENCE_FIRST_MS - 1);
  assert.equal(replies.length, 0);

  // At 9s -> check-in #1 fires and logs silence_checkin with count: 1.
  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.equal(silence.checkInCount, 1);
  assert.equal(silence.totalCheckInCount, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'silence_checkin');
  assert.equal(logs[0]!.data?.count, 1);
  assert.equal(logs[0]!.data?.total_count, 1);

  // Alice speaks check-in #1 (even if check-in line ends in '!' not '?'), then finishes -> arms 12s timer.
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  assert.equal(replies.length, 1);
  silence.onAgentStateChanged('listening');
  silence.onAssistantMessage('Hit me with that a little louder!');

  clock.advance(DEFAULT_SILENCE_SECOND_MS - 1);
  assert.equal(replies.length, 1);

  // At +12s -> check-in #2 fires in different wording and logs count: 2.
  clock.advance(1);
  assert.equal(replies.length, 2);
  assert.equal(silence.checkInCount, 2);
  assert.equal(silence.totalCheckInCount, 2);
  assert.notEqual(replies[0]!.instructions, replies[1]!.instructions);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.ev, 'silence_checkin');
  assert.equal(logs[1]!.data?.count, 2);
  assert.equal(logs[1]!.data?.total_count, 2);

  // Alice speaks check-in #2, then finishes -> waits quietly (NO 3rd prompt).
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  silence.onAgentStateChanged('listening');
  silence.onAssistantMessage('Take your time and holler when ready.');
  clock.advance(60_000);
  assert.equal(replies.length, 2, 'must never fire a third check-in before shopper speaks');
  assert.equal(clock.activeTimers(), 0);
});

test('only arms when Alice last finished line ended with a question mark (handles early, late, non-question, and interrupted lines)', () => {
  assert.equal(endsWithQuestionMark('What is your budget?'), true);
  assert.equal(endsWithQuestionMark('Want to try it on?" '), true);
  assert.equal(endsWithQuestionMark('Look 1 is crisp.'), false);
  assert.equal(endsWithQuestionMark('Obsessed with that jacket!'), false);
  assert.equal(endsWithQuestionMark(''), false);

  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];

  const silence = createSilenceCheckIn({
    room: 'silence-qmark',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Statement ending in period (early transcript) -> does NOT arm.
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('That jacket is fire.');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, false);
  clock.advance(30_000);
  assert.equal(replies.length, 0);

  // 2) Statement ending in exclamation (late transcript) -> does NOT arm.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, false);
  clock.advance(50);
  silence.onAssistantMessage('I am obsessed with Look 2!');
  assert.equal(silence.isArmed, false);
  clock.advance(30_000);
  assert.equal(replies.length, 0);

  // 3) No transcript ever delivered after speaking -> does NOT arm.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(30_000);
  assert.equal(replies.length, 0);

  // 4) Interrupted question -> NOT a finished line -> does NOT arm.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  silence.onAssistantMessage('Which look catches your eye?', { interrupted: true });
  assert.equal(silence.isArmed, false);
  clock.advance(30_000);
  assert.equal(replies.length, 0);

  // 5) Question followed by a non-question statement -> last finished line is NOT a question -> does NOT arm.
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Which look catches your eye?');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, true);
  clock.advance(3_000);
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Oh, the on-location shot just landed on screen.');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, false);
  clock.advance(30_000);
  assert.equal(replies.length, 0);

  // 6) Finished question with late transcript -> arms and fires after 9s.
  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(50);
  silence.onAssistantMessage('Want to see Look 1 on you?');
  assert.equal(silence.isArmed, true);
  clock.advance(DEFAULT_SILENCE_FIRST_MS - 1);
  assert.equal(replies.length, 0);
  clock.advance(1);
  assert.equal(replies.length, 1);
});

test('enforces 30s cooldown between cycles, resets cycle on shopper speech/activity, and caps at 4 check-ins per call', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const silence = createSilenceCheckIn({
    room: 'silence-reset-cap',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const askQuestion = (q: string) => {
    silence.onAgentStateChanged('speaking');
    silence.onAssistantMessage(q);
    silence.onAgentStateChanged('listening');
  };

  // 1) Shopper speaks at 5s -> cancels pending 9s check-in; never fires while shopper speaks.
  askQuestion('What is your budget?');
  clock.advance(5_000);
  silence.onUserStateChanged('speaking');
  clock.advance(15_000);
  assert.equal(replies.length, 0, 'must never fire while shopper is speaking');

  // 2) Cycle 1: fires check-in #1 at 9s and check-in #2 at +12s (total = 2).
  silence.onUserStateChanged('listening');
  askQuestion('What is your budget?');

  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 1);
  assert.equal(logs[0]!.data?.count, 1);

  clock.advance(DEFAULT_SILENCE_SECOND_MS);
  assert.equal(replies.length, 2);
  assert.equal(logs[1]!.data?.count, 2);
  assert.equal(silence.checkInCount, 2);
  assert.equal(silence.totalCheckInCount, 2);

  // Alice finishes speaking check-in #2 -> Cycle 1 ends here.
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  silence.onAgentStateChanged('listening');
  // Cycle 1 ended at t = now.

  // Quiet after 2 check-ins even if 40s pass without shopper speech.
  clock.advance(40_000);
  assert.equal(replies.length, 2);

  // 3) Shopper speaks and replies quickly; let's test the 30s cooldown on a fresh Cycle 2!
  silence.onUserStateChanged('speaking');
  assert.equal(silence.checkInCount, 0);
  silence.onUserStateChanged('listening');
  askQuestion('Which look catches your eye?');

  // Cooldown already elapsed (40s > 30s), so Cycle 2 check-in #1 fires after 9s (total = 3).
  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 3);
  assert.equal(logs[2]!.data?.count, 1);
  assert.equal(logs[2]!.data?.total_count, 3);
  assert.notEqual(replies[2]!.instructions, replies[0]!.instructions);

  // Alice finishes speaking Cycle 2 check-in #1 (2s), and shopper speaks 1s later -> Cycle 2 ends!
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  silence.onAgentStateChanged('listening');
  // Cycle 2 ended right here (t = T0).
  clock.advance(1_000);
  silence.onShopperActivity();
  assert.equal(silence.checkInCount, 0);
  assert.equal(silence.totalCheckInCount, 3);

  // Alice asks another question 2s after Cycle 2 ended -> must wait full 30s cooldown from T0!
  clock.advance(1_000); // T0 + 2s
  askQuestion('What sizes do you wear?');

  // 9s later (T0 + 11s): MUST NOT fire because 30s cooldown has not passed!
  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 3, 'must respect 30s cooldown between cycles');

  // At T0 + 29.999s: still MUST NOT fire!
  clock.advance(DEFAULT_SILENCE_COOLDOWN_MS - 11_000 - 1);
  assert.equal(replies.length, 3);

  // At T0 + 30.000s: Cycle 3 check-in #1 fires (4th check-in in whole call -> hits call cap!).
  clock.advance(1);
  assert.equal(replies.length, 4);
  assert.equal(silence.totalCheckInCount, 4);

  // 4) Call cap of 4 reached: NO 2nd check-in in Cycle 3 AND NO check-ins after shopper speaks again!
  silence.onAgentStateChanged('speaking');
  clock.advance(2_000);
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_SILENCE_SECOND_MS + 30_000);
  assert.equal(replies.length, 4, 'must cap at 4 check-ins in a whole call');

  silence.onUserStateChanged('speaking');
  silence.onUserStateChanged('listening');
  askQuestion('Ready to check out those links?');
  clock.advance(60_000);
  assert.equal(replies.length, 4, 'must never fire a 5th check-in in the same call');
  assert.equal(clock.activeTimers(), 0);
});

test('never fires while a tool is running, when suppressed, after a goodbye, or while an extra announcement is pending', () => {
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
  silence.onAssistantMessage('Want me to pull looks for that?');
  silence.onAgentStateChanged('listening');
  clock.advance(3_000);
  silence.onToolStart('call-build-1');
  clock.advance(30_000);
  assert.equal(replies.length, 0, 'must never fire while a tool is running');

  // Even right after tool ends, waits until Alice actually finishes presenting and asks a question.
  silence.onToolEnd('call-build-1');
  clock.advance(15_000);
  assert.equal(replies.length, 0);

  // 2) Respects external suppression (e.g. pending result nudge, filler bit, or extra announcement).
  suppressed = true;
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Which look do you love?');
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

  // 5) Shopper speaks again after goodbye -> re-enables check-in on next Alice question.
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

test('filler timer, result nudger, extra announcer, and silence check-in coordinate without overlapping', () => {
  const clock = createFakeClock();
  const workingNotes: string[] = [];
  const replies: Array<{ source: string; instructions: string }> = [];
  const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];

  let silenceRef: ReturnType<typeof createSilenceCheckIn> | null = null;

  const nudger = createToolResultNudger({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => {
      silenceRef?.onExternalReply();
      replies.push({ source: 'nudge', instructions: opts.instructions });
    },
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const extraAnnouncer = createExtraAnnouncer({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    generateReply: (opts) => {
      silenceRef?.onExternalReply();
      replies.push({ source: 'extra', instructions: opts.instructions });
    },
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
    generateReply: (opts) => {
      silenceRef?.onExternalReply();
      replies.push({ source: 'filler', instructions: opts.instructions });
    },
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  const silence = createSilenceCheckIn({
    room: 'coord-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => nudger.hasPending || filler.isRunning || extraAnnouncer.hasPending,
    generateReply: (opts) => replies.push({ source: 'silence', instructions: opts.instructions }),
    log: (_room, ev, data) => logs.push({ ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  silenceRef = silence;

  const setAgent = (state: 'speaking' | 'listening') => {
    nudger.onAgentStateChanged(state);
    extraAnnouncer.onAgentStateChanged(state);
    filler.onAgentStateChanged(state);
    silence.onAgentStateChanged(state);
  };

  // 1) Slow build_outfits starts -> silence is disabled, filler sends bit #1 at 2s.
  silence.onToolStart('b-coord');
  extraAnnouncer.onToolStart('b-coord');
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
  extraAnnouncer.onToolEnd('b-coord');
  silence.onToolEnd('b-coord');
  nudger.onToolResult({
    name: 'build_outfits',
    callId: 'b-coord',
    text: 'Built 3 looks and they are now on screen.',
  });

  // Alice finishes bit sentence -> nudger arms 3s window; filler does NOT fire; silence stays suppressed.
  setAgent('listening');
  nudger.onAssistantMessage('Kevin owns one outfit, a beige fleece vest.');
  silence.onAssistantMessage('Kevin owns one outfit, a beige fleece vest.');
  clock.advance(DEFAULT_RESULT_NUDGE_DELAY_MS);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.source, 'nudge');

  // 2) While Alice presents the looks (ending with a question), a try-on extra announcement queues.
  //    When Alice finishes, extraAnnouncer fires immediately; silence MUST NOT arm on that turn!
  setAgent('speaking');
  extraAnnouncer.announce({ outfit: 1, kind: 'scene', setting: 'SoHo rooftop bar' });
  assert.equal(extraAnnouncer.hasPending, true);
  clock.advance(4_000);
  silence.onAssistantMessage('Look 1 is crisp, Look 2 is relaxed—which catches your eye?');
  setAgent('listening');
  // extraAnnouncer immediately spoke via generateReply -> called silence.onExternalReply().
  assert.equal(replies.length, 2);
  assert.equal(replies[1]!.source, 'extra');
  assert.equal(silence.isArmed, false, 'silence must not arm when extra announcement just fired');

  // Even after 15s, no silence check-in fires while waiting on the extra announcement speech.
  clock.advance(15_000);
  assert.equal(replies.length, 2);

  // Alice speaks the extra announcement (no question mark) -> still does NOT arm.
  setAgent('speaking');
  silence.onAssistantMessage('The on-location shot at the SoHo rooftop bar just landed.');
  setAgent('listening');
  clock.advance(15_000);
  assert.equal(replies.length, 2);

  // 3) Finally Alice asks a fresh question with nothing pending -> 9s later silence check-in fires once.
  setAgent('speaking');
  clock.advance(2_000);
  setAgent('listening');
  nudger.onAssistantMessage('Look 1 is crisp, Look 2 is relaxed, Look 3 is sharp—which catches your eye?');
  silence.onAssistantMessage('Look 1 is crisp, Look 2 is relaxed, Look 3 is sharp—which catches your eye?');

  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 3);
  assert.equal(replies[2]!.source, 'silence');
  assert.equal(logs.filter((l) => l.ev === 'filler_bit').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'result_nudge').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'extra_announce').length, 1);
  assert.equal(logs.filter((l) => l.ev === 'silence_checkin').length, 1);
});
