import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installPlayoutWatchdog, type PlayoutEvent } from '../src/agent/playout.ts';

function fakeOutput() {
  const events: PlayoutEvent[] = [];
  const out = {
    playbackSegmentsCount: 0,
    playbackFinishedCount: 0,
    pushedDuration: 0,
    streamWriter: undefined as { close(): Promise<unknown> } | undefined,
    flushed: 0,
    cleared: 0,
    capture(seconds: number) {
      this.playbackSegmentsCount += 1;
      this.pushedDuration = seconds;
    },
    flush() {
      this.flushed += 1;
    },
    clearBuffer() {
      this.cleared += 1;
    },
    onPlaybackFinished(ev: PlayoutEvent) {
      if (this.playbackFinishedCount >= this.playbackSegmentsCount) return;
      this.playbackFinishedCount += 1;
      events.push(ev);
    },
  };
  return { out, events };
}

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      pending.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as { live: boolean }).live = false;
    },
    fire() {
      for (const t of pending.splice(0)) if (t.live) t.fn();
    },
  };
}

test('playout watchdog: a line the avatar never reports finished is finished by the watchdog', () => {
  const { out, events } = fakeOutput();
  const timers = fakeTimers();
  const logs: Record<string, unknown>[] = [];
  installPlayoutWatchdog(out, { ...timers, log: (f) => logs.push(f), flushGraceMs: 2000 });
  out.capture(1.5);
  out.flush();
  assert.equal(out.flushed, 1);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0]!.ms, 3500);
  timers.fire();
  assert.equal(out.playbackFinishedCount, 1);
  assert.deepEqual(events, [{ playbackPosition: 1.5, interrupted: false }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.reason, 'flush');
});

test('playout watchdog: does nothing when the avatar reports in time', () => {
  const { out, events } = fakeOutput();
  const timers = fakeTimers();
  const logs: Record<string, unknown>[] = [];
  installPlayoutWatchdog(out, { ...timers, log: (f) => logs.push(f) });
  out.capture(1);
  out.flush();
  out.onPlaybackFinished({ playbackPosition: 1, interrupted: false });
  timers.fire();
  assert.equal(events.length, 1);
  assert.equal(logs.length, 0);
});

test('playout watchdog: an interrupted line is settled as interrupted and a dangling stream is closed', async () => {
  const { out, events } = fakeOutput();
  const timers = fakeTimers();
  let closed = 0;
  installPlayoutWatchdog(out, { ...timers, clearGraceMs: 900 });
  out.capture(0.2);
  out.streamWriter = { close: async () => void (closed += 1) };
  out.clearBuffer();
  assert.equal(out.cleared, 1);
  assert.equal(timers.pending[0]!.ms, 900);
  timers.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [{ playbackPosition: 0, interrupted: true }]);
  assert.equal(out.streamWriter, undefined);
  assert.equal(closed, 1);
});

test('playout watchdog: never finishes a line that started after the timer was armed', () => {
  const { out } = fakeOutput();
  const timers = fakeTimers();
  installPlayoutWatchdog(out, timers);
  out.capture(1);
  out.flush();
  out.capture(1);
  timers.fire();
  assert.equal(out.playbackFinishedCount, 1);
});

test('playout watchdog: flush with nothing pending arms no timer, and removal restores the output', () => {
  const { out } = fakeOutput();
  const timers = fakeTimers();
  const originalFlush = out.flush;
  const remove = installPlayoutWatchdog(out, timers);
  out.flush();
  assert.equal(timers.pending.length, 0);
  remove!();
  assert.equal(out.flush, originalFlush);
  assert.equal(installPlayoutWatchdog({}), null);
});
