import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppContextSender, type TimerHandle } from '../src/agent/context.ts';
import {
  type BitTheme,
  FILLER_BITS,
  LONG_BIT_WORD_LIMIT,
  MAX_BITS_PER_WAIT,
  SHORT_FILLER_BITS,
  countBitWords,
  createBitPicker,
  formatWorkingNoteWithBit,
} from '../src/agent/bits.ts';
import {
  BUILD_OUTFITS_FILLER_DELAY_MS,
  DEFAULT_FILLER_FOLLOWUP_DELAY_MS,
  DEFAULT_FILLER_INITIAL_DELAY_MS,
  type FillerWorkingNoteParams,
  createToolFiller,
} from '../src/agent/filler.ts';
import { createCallStateStore } from '../src/agent/state.ts';

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

test('FILLER_BITS repertoire has 10-12 clean, short, non-question bits across all four themes', () => {
  assert.ok(
    FILLER_BITS.length >= 10 && FILLER_BITS.length <= 12,
    `expected 10-12 bits, got ${FILLER_BITS.length}`,
  );

  const ids = new Set<string>();
  const themes = new Set<BitTheme>();

  for (const bit of FILLER_BITS) {
    assert.ok(bit.id.trim().length > 0);
    assert.ok(bit.title.trim().length > 0);
    assert.ok(bit.text.trim().length > 0);
    assert.equal(ids.has(bit.id), false, `duplicate bit id: ${bit.id}`);
    ids.add(bit.id);
    themes.add(bit.theme);

    // Each bit is 2 or 3 sentences, 6-12s spoken (~20-48 words), and never asks a question.
    const sentences = bit.text
      .split(/[.!]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    assert.ok(
      sentences.length >= 2 && sentences.length <= 3,
      `bit ${bit.id} should be 2-3 sentences, got ${sentences.length}`,
    );
    const words = bit.text.trim().split(/\s+/).filter(Boolean).length;
    assert.ok(
      words >= 20 && words <= 50,
      `bit ${bit.id} should be 20-50 words (~6-12s spoken), got ${words}`,
    );
    assert.equal(bit.text.includes('?'), false, `bit ${bit.id} must not ask a question`);

    // Never claims looks are ready, quotes prices, or roasts body/weight/age/skin.
    assert.doesNotMatch(bit.text, /\$\d|\bdollars?\b/i, `bit ${bit.id} must not mention prices`);
    assert.doesNotMatch(
      bit.text,
      /\blooks? (?:are|is) ready\b|\bthey're in\b/i,
      `bit ${bit.id} must not claim looks are ready`,
    );
    assert.doesNotMatch(
      bit.text,
      /\b(?:weight|fat|skinny|wrinkle|old|ugly|skin tone|body type)\b/i,
      `bit ${bit.id} must not roast body/weight/age/skin`,
    );
  }

  assert.deepEqual([...themes].sort(), ['ai_life', 'boyfriend', 'clients', 'new_york']);
});

test('createBitPicker never repeats a bit, rotates themes, enforces cap of 3 per wait, and remembers used ids in call state', () => {
  const sentContext: string[] = [];
  const appContext = new AppContextSender({
    send: (text) => sentContext.push(text),
    initialState: 'listening',
  });
  const callState = createCallStateStore({
    roomName: 'bits-room',
    appContext,
    log: () => {},
  });

  const picker = createBitPicker({
    getUsedIds: () => callState.get().usedBitIds,
    markUsed: (bitId) => callState.dispatch({ type: 'record_bit_used', bitId }),
  });

  // Cap of 3 per wait.
  const wait1Bits = [
    picker.pick('wait-1'),
    picker.pick('wait-1'),
    picker.pick('wait-1'),
    picker.pick('wait-1'),
  ];
  assert.equal(wait1Bits.slice(0, 3).every((b) => b !== null), true);
  assert.equal(wait1Bits[3], null, 'must cap at 3 bits per wait');
  assert.equal(picker.countForWait('wait-1'), MAX_BITS_PER_WAIT);

  // All 3 bits in wait-1 have distinct themes.
  const wait1Themes = new Set(wait1Bits.slice(0, 3).map((b) => b!.theme));
  assert.equal(wait1Themes.size, 3, 'first 3 bits must rotate themes');

  // Exhaust remaining bits across fresh waits — zero repeats, theme rotation maintained.
  const allPicked = wait1Bits.slice(0, 3).map((b) => b!);
  let waitIdx = 2;
  while (allPicked.length < FILLER_BITS.length) {
    const waitId = `wait-${waitIdx}`;
    for (let i = 0; i < MAX_BITS_PER_WAIT; i++) {
      const next = picker.pick(waitId);
      if (!next) break;
      allPicked.push(next);
    }
    picker.clearWait(waitId);
    waitIdx += 1;
  }

  // Every bit used exactly once; 13th pick returns null.
  assert.equal(allPicked.length, FILLER_BITS.length);
  assert.equal(new Set(allPicked.map((b) => b.id)).size, FILLER_BITS.length);
  assert.equal(picker.pick('wait-exhausted'), null);

  // No two consecutive picks share a theme across the full 12-bit run.
  for (let i = 1; i < allPicked.length; i++) {
    assert.notEqual(
      allPicked[i]!.theme,
      allPicked[i - 1]!.theme,
      `consecutive bits ${allPicked[i - 1]!.id} and ${allPicked[i]!.id} must not share theme ${allPicked[i]!.theme}`,
    );
  }

  // Call state remembers all used bit ids without spamming CALL STATE updates to Gemini.
  assert.deepEqual(
    callState.get().usedBitIds,
    allPicked.map((b) => b.id),
  );
  assert.equal(sentContext.length, 0, 'recording usedBitIds must not spam CALL STATE context');

  // Working note formatter includes the required phrasing.
  const note = formatWorkingNoteWithBit('Working on building three outfits now.', allPicked[0]!);
  assert.match(note, /While this runs, tell this in your own words:/);
  assert.ok(note.includes(allPicked[0]!.text));
});

test('createToolFiller skips fast build_outfits (< 4s), sends working note + up to 2 follow-up bits (cap 3), and stops on result', () => {
  assert.equal(BUILD_OUTFITS_FILLER_DELAY_MS, 4_000);
  const clock = createFakeClock();
  const workingNotes: FillerWorkingNoteParams[] = [];
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const picker = createBitPicker();

  const filler = createToolFiller({
    room: 'filler-room',
    bitPicker: picker,
    initialAgentState: 'listening',
    initialUserState: 'listening',
    sendWorkingNote: (params) => {
      workingNotes.push(params);
      return true;
    },
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Fast library build_outfits (< 4s, e.g. 3.9s): zero bits used, zero working notes, zero replies, zero logs.
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'fast-1',
    baseNote: 'Working on building three outfits now.',
  });
  clock.advance(BUILD_OUTFITS_FILLER_DELAY_MS - 100);
  filler.onToolResult({ callId: 'fast-1', name: 'build_outfits' });
  clock.advance(10_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(picker.usedIds().length, 0);
  assert.equal(clock.activeTimers(), 0);

  // 2) Slow build_outfits: bit #1 at 4s via working note, bit #2 at 4s after Alice finishes, bit #3 at 4s after bit #2, then capped at 3.
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'slow-1',
    baseNote: 'Working on building three outfits now.',
  });
  assert.equal(filler.isRunning, true);

  clock.advance(BUILD_OUTFITS_FILLER_DELAY_MS - 1);
  assert.equal(workingNotes.length, 0, 'build_outfits must not fire filler before 4s');

  clock.advance(1);
  assert.equal(workingNotes.length, 1);
  assert.match(workingNotes[0]!.note, /While this runs, tell this in your own words:/);
  assert.equal(replies.length, 0);

  // Alice speaks bit #1, then finishes.
  filler.onAgentStateChanged('speaking');
  clock.advance(6_000);
  assert.equal(replies.length, 0, 'must not fire while Alice is speaking');

  filler.onAgentStateChanged('listening');
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS - 1);
  assert.equal(replies.length, 0);

  // 4s after she stops talking -> bit #2 via generateReply.
  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.instructions, /While this runs, tell this in your own words:/);

  // Alice speaks bit #2, then finishes.
  filler.onAgentStateChanged('speaking');
  clock.advance(5_000);
  filler.onAgentStateChanged('listening');

  // 4s later -> bit #3 via generateReply.
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS);
  assert.equal(replies.length, 2);

  // Alice speaks bit #3, finishes; even 20s later NO 4th bit fires (cap of 3 per wait).
  filler.onAgentStateChanged('speaking');
  clock.advance(5_000);
  filler.onAgentStateChanged('listening');
  clock.advance(20_000);
  assert.equal(replies.length, 2, 'must enforce maximum of 3 bits per wait (1 working note + 2 replies)');

  const fillerLogs = logs.filter((l) => l.ev === 'filler_bit');
  assert.equal(fillerLogs.length, 3);
  assert.equal(new Set(fillerLogs.map((l) => l.data?.id)).size, 3);
  for (const entry of fillerLogs) {
    assert.equal(entry.data?.tool, 'build_outfits');
    assert.ok(typeof entry.data?.id === 'string' && entry.data.id.length > 0);
  }

  filler.onToolEnd('slow-1');
  assert.equal(filler.isRunning, false);

  // 3) Result arrives mid-bit -> stops immediately, never starts a new bit after result lands.
  filler.onToolStart({
    name: 'swap_piece',
    callId: 'slow-2',
    baseNote: 'Working on finding a replacement piece now.',
  });
  clock.advance(DEFAULT_FILLER_INITIAL_DELAY_MS);
  assert.equal(workingNotes.length, 2);
  filler.onAgentStateChanged('speaking');
  clock.advance(2_000);
  filler.onToolEnd('slow-2'); // Result lands while Alice is mid-sentence!
  filler.onAgentStateChanged('listening');
  clock.advance(15_000);
  assert.equal(replies.length, 2, 'must never start a new bit after result arrives');
  assert.equal(clock.activeTimers(), 0);
});

test('createToolFiller pauses while shopper or Alice speaks and disposes cleanly', () => {
  const clock = createFakeClock();
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const filler = createToolFiller({
    room: 'filler-pause',
    initialAgentState: 'listening',
    initialUserState: 'speaking',
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // Tool starts while shopper is speaking -> must not fire while shopper speaks.
  filler.onToolStart({
    name: 'show_on_me',
    callId: 'show-1',
    baseNote: 'Working on rendering your try-on now.',
  });
  clock.advance(10_000);
  assert.equal(replies.length, 0);

  // Shopper stops speaking; Alice answers, then stops -> 4s later bit #1 fires (via generateReply since no sendWorkingNote).
  filler.onUserStateChanged('listening');
  clock.advance(500);
  filler.onAgentStateChanged('speaking');
  clock.advance(3_000);
  assert.equal(replies.length, 0);

  filler.onAgentStateChanged('listening');
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS - 1);
  assert.equal(replies.length, 0);
  clock.advance(1);
  assert.equal(replies.length, 1);
  assert.equal(logs[0]!.ev, 'filler_bit');
  assert.equal(logs[0]!.data?.tool, 'show_on_me');

  // Shopper interrupts during bit #1 -> pauses until shopper & Alice finish, then delivers a fresh bit #2.
  filler.onAgentStateChanged('speaking');
  clock.advance(1_000);
  filler.onUserStateChanged('speaking');
  filler.onAgentStateChanged('listening');
  clock.advance(6_000);
  assert.equal(replies.length, 1, 'must not interrupt active shopper speech');

  filler.onUserStateChanged('listening');
  filler.onAgentStateChanged('speaking'); // Alice answers shopper
  clock.advance(2_000);
  filler.onAgentStateChanged('listening');
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS);
  assert.equal(replies.length, 2);
  assert.notEqual(logs[0]!.data?.id, logs[1]!.data?.id, 'must pick a fresh bit after interruption');

  // Dispose cancels pending timers and ignores subsequent events.
  filler.dispose();
  assert.equal(clock.activeTimers(), 0);
  assert.equal(filler.isRunning, false);
  clock.advance(20_000);
  assert.equal(replies.length, 2);
});

test('createToolFiller cancels any queued filler the moment onToolResult arrives and suppresses all fillers when isSuppressed is true', () => {
  const clock = createFakeClock();
  const workingNotes: FillerWorkingNoteParams[] = [];
  const replies: Array<{ instructions: string }> = [];
  let suppressed = false;

  const filler = createToolFiller({
    room: 'filler-cancel',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    isSuppressed: () => suppressed,
    sendWorkingNote: (params) => {
      workingNotes.push(params);
      return true;
    },
    generateReply: (opts) => replies.push(opts),
    log: () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Queued filler for search_products cancelled right before 2s when result arrives.
  filler.onToolStart({
    name: 'search_products',
    callId: 'sp-1',
    baseNote: 'Digging through the racks for pieces now.',
  });
  clock.advance(DEFAULT_FILLER_INITIAL_DELAY_MS - 1);
  filler.onToolResult({ callId: 'sp-1', name: 'search_products' });
  clock.advance(10_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(clock.activeTimers(), 0);

  // 2) Queued filler with empty callId cancelled by tool name on result arrival.
  filler.onToolStart({
    name: 'swap_piece',
    callId: '',
    baseNote: 'Hunting down a sharper replacement piece now.',
  });
  clock.advance(DEFAULT_FILLER_INITIAL_DELAY_MS - 50);
  filler.onToolResult({ callId: '', name: 'swap_piece' });
  clock.advance(10_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(clock.activeTimers(), 0);

  // 3) Suppressed mode (express): zero fillers even after long waits.
  suppressed = true;
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'b-sup',
    baseNote: 'Pulling three killer outfits together now.',
  });
  clock.advance(20_000);
  assert.equal(workingNotes.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(filler.isRunning, false);
});

test('build_outfits allows at most ONE long bit (>12 words) per build and starts zero bits once the tool result arrives', () => {
  assert.equal(LONG_BIT_WORD_LIMIT, 12);
  for (const shortBit of SHORT_FILLER_BITS) {
    assert.ok(
      countBitWords(shortBit.text) <= LONG_BIT_WORD_LIMIT,
      `short bit ${shortBit.id} must be <= ${LONG_BIT_WORD_LIMIT} words`,
    );
    assert.equal(shortBit.text.includes('?'), false);
  }

  const clock = createFakeClock();
  const workingNotes: FillerWorkingNoteParams[] = [];
  const replies: Array<{ instructions: string }> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const filler = createToolFiller({
    room: 'filler-one-long',
    initialAgentState: 'listening',
    initialUserState: 'listening',
    sendWorkingNote: (params) => {
      workingNotes.push(params);
      return true;
    },
    generateReply: (opts) => replies.push(opts),
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // 1) Long build_outfits (90s): at most ONE long bit (>12 words), follow-ups are <= 12 words.
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'b-long-1',
    baseNote: 'Pulling three killer outfits together now.',
  });

  // 4s -> bit #1 (the ONE long bit).
  clock.advance(BUILD_OUTFITS_FILLER_DELAY_MS);
  assert.equal(workingNotes.length, 1);

  // Alice speaks bit #1, finishes, waits 4s -> bit #2 MUST be short (<= 12 words).
  filler.onAgentStateChanged('speaking');
  clock.advance(10_000);
  filler.onAgentStateChanged('listening');
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS);
  assert.equal(replies.length, 1);

  // Alice speaks bit #2, finishes, waits 4s -> bit #3 MUST also be short (<= 12 words).
  filler.onAgentStateChanged('speaking');
  clock.advance(4_000);
  filler.onAgentStateChanged('listening');
  clock.advance(DEFAULT_FILLER_FOLLOWUP_DELAY_MS);
  assert.equal(replies.length, 2);

  const bitLogs = logs.filter((l) => l.ev === 'filler_bit');
  assert.equal(bitLogs.length, 3);
  const longLogs = bitLogs.filter((l) => l.data?.long === true);
  assert.equal(longLogs.length, 1, 'build_outfits must allow at most ONE long bit (>12 words) per build');
  for (const followUp of bitLogs.slice(1)) {
    assert.equal(followUp.data?.long, false);
    assert.ok(
      typeof followUp.data?.words === 'number' && followUp.data.words <= LONG_BIT_WORD_LIMIT,
      `follow-up bit must be <= ${LONG_BIT_WORD_LIMIT} words, got ${String(followUp.data?.words)}`,
    );
  }

  // Tool result arrives while Alice is speaking bit #3 -> let sentence finish, queue NOTHING else!
  filler.onAgentStateChanged('speaking');
  clock.advance(1_000);
  filler.onToolResult({ callId: 'b-long-1', name: 'build_outfits', text: 'Built 3 looks and they are now on screen.' });
  filler.onAgentStateChanged('listening');
  clock.advance(30_000);
  assert.equal(workingNotes.length, 1);
  assert.equal(replies.length, 2, 'no filler bit may start after tool result arrives');
  assert.equal(clock.activeTimers(), 0);

  // 2) Also verify no bit starts while agentState === 'thinking' or after onToolResult arrives right before timer fires.
  filler.onToolStart({
    name: 'build_outfits',
    callId: 'b-think-2',
    baseNote: 'Pulling three killer outfits together now.',
  });
  filler.onAgentStateChanged('thinking');
  clock.advance(10_000);
  assert.equal(workingNotes.length, 1, 'must never queue a filler bit while agent is thinking');
  filler.onToolResult({ callId: 'b-think-2', name: 'build_outfits', text: 'Built 3 looks.' });
  filler.onAgentStateChanged('listening');
  clock.advance(20_000);
  assert.equal(workingNotes.length, 1, 'must never start a filler bit once tool result has arrived');
  assert.equal(replies.length, 2);
});
