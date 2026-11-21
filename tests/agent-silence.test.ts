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
  DEFAULT_DEAD_AIR_MS,
  DEFAULT_SILENCE_COOLDOWN_MS,
  DEFAULT_SILENCE_FIRST_MS,
  DEFAULT_SILENCE_SECOND_MS,
  EXPRESS_FIRST_CHECKIN_INSTRUCTIONS,
  EXPRESS_SECOND_CHECKIN_INSTRUCTIONS,
  FIRST_CHECKIN_INSTRUCTIONS,
  MAX_SILENCE_CHECKINS_PER_CALL,
  SECOND_CHECKIN_INSTRUCTIONS,
  createSilenceCheckIn,
  endsWithQuestionMark,
  isGoodbyeMessage,
  pickDeadAirLine,
  type DeadAirCallStateSlice,
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

test('silence check-in wording never blames the shopper, names "Type instead" (never "the chat"), and uses joke-free express lines when express is on', () => {
  const allLines = [
    ...FIRST_CHECKIN_INSTRUCTIONS,
    ...SECOND_CHECKIN_INSTRUCTIONS,
    ...EXPRESS_FIRST_CHECKIN_INSTRUCTIONS,
    ...EXPRESS_SECOND_CHECKIN_INSTRUCTIONS,
  ];

  for (const line of allLines) {
    assert.doesNotMatch(line, /did i lose you|lost (?:you|them)/i, `must not blame shopper: ${line}`);
    assert.doesNotMatch(line, /\bchat\b/i, `must call typing "Type instead", never "chat": ${line}`);
    assert.doesNotMatch(line, /a little louder|must be loud on their end/i, `must not blame shopper volume: ${line}`);
  }

  assert.ok(
    FIRST_CHECKIN_INSTRUCTIONS.some((line) => line.includes('Take your time. Want me to pick for you?')),
    'first check-in instructions should include calm "Take your time. Want me to pick for you?"',
  );
  assert.ok(
    allLines.some((line) => line.includes('Type instead')),
    'typing guidance must name the control "Type instead"',
  );

  // Express mode keeps check-ins active with calm, joke-free lines while timing constants stay unchanged.
  assert.equal(DEFAULT_SILENCE_FIRST_MS, 9_000);
  assert.equal(DEFAULT_SILENCE_SECOND_MS, 12_000);
  assert.equal(DEFAULT_SILENCE_COOLDOWN_MS, 30_000);

  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const silence = createSilenceCheckIn({
    room: 'silence-express',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isExpress: () => true,
    generateReply: (opts) => replies.push(opts),
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Occasion and budget?');
  silence.onAgentStateChanged('listening');

  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 1);
  assert.ok(EXPRESS_FIRST_CHECKIN_INSTRUCTIONS.includes(replies[0]!.instructions));
  assert.match(replies[0]!.instructions, /no jokes/i);

  silence.onAgentStateChanged('speaking');
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_SILENCE_SECOND_MS);
  assert.equal(replies.length, 2);
  assert.ok(EXPRESS_SECOND_CHECKIN_INSTRUCTIONS.includes(replies[1]!.instructions));
  assert.match(replies[1]!.instructions, /no jokes/i);
  assert.match(replies[1]!.instructions, /Type instead/);
});

test('dead-air guard fires after 15s of silence with flow-state next-step lines, respects tools/suppression, and shares 30s cooldown and 4/call cap', () => {
  assert.equal(DEFAULT_DEAD_AIR_MS, 15_000);

  // Pure flow-state mapping for all 4 stages + empty state.
  assert.equal(
    pickDeadAirLine({ looks: [], pickedLook: null, revealsDone: [], bag: null }),
    null,
  );
  assert.deepEqual(
    pickDeadAirLine({
      looks: [{ number: 1, name: 'SoHo Sharp', total: 200, slots: ['top'] }],
      pickedLook: null,
      revealsDone: [],
      bag: null,
    }),
    { stage: 'looks', line: 'Which one are we trying?' },
  );
  assert.deepEqual(
    pickDeadAirLine({
      looks: [{ number: 1, name: 'SoHo Sharp', total: 200, slots: ['top'] }],
      pickedLook: 1,
      revealsDone: [],
      bag: null,
    }),
    { stage: 'picked', line: 'Want to see it on you?' },
  );
  assert.deepEqual(
    pickDeadAirLine({
      looks: [{ number: 1, name: 'SoHo Sharp', total: 200, slots: ['top'] }],
      pickedLook: 1,
      revealsDone: [1],
      bag: null,
    }),
    { stage: 'revealed', line: "Give me your sizes and I'll bag it." },
  );
  assert.deepEqual(
    pickDeadAirLine({
      looks: [{ number: 1, name: 'SoHo Sharp', total: 200, slots: ['top'] }],
      pickedLook: 1,
      revealsDone: [1],
      bag: {
        stores: [{ store: 'Everlane', added: [{ title: 'Polo', slot: 'top', image: '', price: 60, size: 'M' }], not_added: [], subtotal: 60 }],
        total: 60,
        links: [],
        notAdded: [],
      },
    }),
    { stage: 'bagged', line: 'Want anything swapped or taken out?' },
  );

  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  let suppressed = false;
  let state: DeadAirCallStateSlice = {
    looks: [{ number: 1, name: 'SoHo Sharp', total: 200, slots: ['top'] }],
    pickedLook: 1,
    revealsDone: [],
    bag: null,
  };

  const silence = createSilenceCheckIn({
    room: 'dead-air-room',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => suppressed,
    getCallState: () => state,
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) After pick_outfit, Alice describes the look without asking a question -> dead-air fires at 15s!
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('That wool coat has razor-sharp lapels and clean structure.');
  silence.onAgentStateChanged('listening');
  assert.equal(silence.isArmed, false, 'question check-in must not arm without question mark');
  assert.equal(silence.isDeadAirArmed, true, 'dead-air guard must arm on non-question silence');

  clock.advance(DEFAULT_DEAD_AIR_MS - 1);
  assert.equal(replies.length, 0);

  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.ok(replies[0]!.instructions.includes('Want to see it on you?'));
  assert.equal(silence.totalCheckInCount, 1);
  assert.equal(logs[0]!.ev, 'dead_air_nudge');
  assert.equal(logs[0]!.data?.stage, 'picked');
  assert.equal(logs[0]!.data?.line, 'Want to see it on you?');

  // Alice speaks the dead-air line and finishes -> does not re-fire without shopper activity.
  silence.onAgentStateChanged('speaking');
  clock.advance(1_500);
  silence.onAgentStateChanged('listening');
  silence.onAssistantMessage('Want to see it on you?');
  clock.advance(60_000);
  assert.equal(replies.length, 1);

  // 2) Tool running or reveal beat pending (suppressed) blocks dead-air guard.
  silence.onShopperActivity();
  silence.onToolStart('call-tryon');
  clock.advance(30_000);
  assert.equal(replies.length, 1, 'must not fire dead-air while tool is running');

  suppressed = true; // reveal beat pending
  silence.onToolEnd('call-tryon');
  clock.advance(30_000);
  assert.equal(replies.length, 1, 'must not fire dead-air while reveal beat is pending');
  suppressed = false;

  // 3) Advance to revealed state -> dead-air shares 30s cooldown with question check-in!
  state = { ...state, revealsDone: [1] };
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Oh I cannot, that silhouette is unreal.');
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_DEAD_AIR_MS);
  assert.equal(replies.length, 2);
  assert.ok(replies[1]!.instructions.includes("Give me your sizes and I'll bag it."));
  assert.equal(logs[1]!.ev, 'dead_air_nudge');
  assert.equal(logs[1]!.data?.stage, 'revealed');
  assert.equal(silence.totalCheckInCount, 2);

  // Immediately after dead-air #2 ends, shopper speaks and Alice asks a question -> MUST respect shared 30s cooldown!
  silence.onAgentStateChanged('speaking');
  clock.advance(1_000);
  silence.onAgentStateChanged('listening');
  // Cooldown starts here (T0).
  clock.advance(1_000);
  silence.onShopperActivity();
  clock.advance(1_000);
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('What size jacket do you wear?');
  silence.onAgentStateChanged('listening');

  // At T0 + 2s + 9s = T0 + 11s: question check-in must wait for the 30s shared cooldown!
  clock.advance(DEFAULT_SILENCE_FIRST_MS);
  assert.equal(replies.length, 2, 'question check-in must share 30s cooldown with dead-air nudge');

  // At T0 + 30s: question check-in fires (total = 3).
  clock.advance(DEFAULT_SILENCE_COOLDOWN_MS - 11_000);
  assert.equal(replies.length, 3);
  assert.equal(logs[2]!.ev, 'silence_checkin');
  assert.equal(silence.totalCheckInCount, 3);

  // 4) Shopper replies, then after 30s cooldown, bagged dead-air fires (total = 4 -> hits shared per-call cap of 4!).
  silence.onAgentStateChanged('speaking');
  clock.advance(1_000);
  silence.onAgentStateChanged('listening');
  // Shopper replies right away (cancelling the 2nd check-in of Cycle 2).
  silence.onUserStateChanged('speaking');
  clock.advance(1_000);
  silence.onUserStateChanged('listening');
  state = {
    ...state,
    bag: {
      stores: [{ store: 'Everlane', added: [{ title: 'Polo', slot: 'top', image: '', price: 60, size: 'M' }], not_added: [], subtotal: 60 }],
      total: 60,
      links: [],
      notAdded: [],
    },
  };
  clock.advance(DEFAULT_SILENCE_COOLDOWN_MS);
  silence.onShopperActivity();
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('Your pieces are in the bag for $60.');
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_DEAD_AIR_MS);
  assert.equal(replies.length, 4);
  assert.ok(replies[3]!.instructions.includes('Want anything swapped or taken out?'));
  assert.equal(logs[3]!.ev, 'dead_air_nudge');
  assert.equal(logs[3]!.data?.stage, 'bagged');
  assert.equal(silence.totalCheckInCount, MAX_SILENCE_CHECKINS_PER_CALL);

  // 5) Shared cap of 4 reached: neither dead-air nor question check-in can fire a 5th time.
  silence.onAgentStateChanged('speaking');
  clock.advance(1_000);
  silence.onAgentStateChanged('listening');
  clock.advance(DEFAULT_SILENCE_COOLDOWN_MS + 5_000);
  silence.onShopperActivity();
  silence.onAgentStateChanged('speaking');
  silence.onAssistantMessage('All set.');
  silence.onAgentStateChanged('listening');
  clock.advance(60_000);
  assert.equal(replies.length, 4, 'shared cap of 4 must block a 5th nudge');
});

