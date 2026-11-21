import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackKind, TrackSource } from '@livekit/rtc-node';
import {
  AppContextSender,
  type TimerHandle,
  normalizeCameraAttr,
  readInitialCameraStatus,
  sendRealtimeContext,
} from '../src/agent/context.ts';

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
    const id = (handle as unknown as { id: number }).id;
    timers.delete(id);
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

  return { setTimeoutFn, clearTimeoutFn, advance, activeCount: () => timers.size };
}

test('AppContextSender sends immediately when listening and holds while speaking or thinking', () => {
  const sent: string[] = [];
  const clock = createFakeScheduler();
  const sender = new AppContextSender({
    send: (text) => sent.push(text),
    initialState: 'listening',
    flushDelayMs: 300,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  sender.sendCameraStatus('on');
  assert.deepEqual(sent, ['CAMERA STATUS: on']);

  // Enter speaking: messages are held and coalesced by kind.
  sender.setAgentState('speaking');
  sender.sendCameraStatus('off');
  sender.sendCameraStatus('on');
  sender.sendCallState('step 1');
  sender.sendCallState('step 2');
  assert.deepEqual(sent, ['CAMERA STATUS: on']);
  assert.equal(sender.pendingCount, 2);

  // Still held while thinking.
  sender.setAgentState('thinking');
  sender.sendCallState('step 3');
  clock.advance(1000);
  assert.deepEqual(sent, ['CAMERA STATUS: on']);

  // Returning to listening starts the 300ms flush timer.
  sender.setAgentState('listening');
  clock.advance(299);
  assert.deepEqual(sent, ['CAMERA STATUS: on']);

  clock.advance(1);
  assert.deepEqual(sent, [
    'CAMERA STATUS: on',
    'CAMERA STATUS: on',
    'CALL STATE: step 3',
  ]);
  assert.equal(sender.pendingCount, 0);
});

test('AppContextSender cancels flush timer if agent starts speaking again before 300ms', () => {
  const sent: string[] = [];
  const clock = createFakeScheduler();
  const sender = new AppContextSender({
    send: (text) => sent.push(text),
    initialState: 'speaking',
    flushDelayMs: 300,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  sender.sendCallState('first');
  sender.setAgentState('listening');
  clock.advance(150);
  assert.equal(sent.length, 0);

  // Agent starts speaking again -> timer cancelled.
  sender.setAgentState('speaking');
  assert.equal(clock.activeCount(), 0);
  clock.advance(500);
  assert.equal(sent.length, 0);

  // Returns to listening again -> flushes 300ms later.
  sender.setAgentState('listening');
  clock.advance(300);
  assert.deepEqual(sent, ['CALL STATE: first']);
});

test('sendRealtimeContext sends client content with turnComplete: false', () => {
  const events: unknown[] = [];
  const fakeRt = {
    sendClientEvent(ev: unknown) {
      events.push(ev);
    },
  };

  const ok = sendRealtimeContext(fakeRt, 'CAMERA STATUS: on');
  assert.equal(ok, true);
  assert.deepEqual(events, [
    {
      type: 'content',
      value: {
        turns: [{ role: 'user', parts: [{ text: 'CAMERA STATUS: on' }] }],
        turnComplete: false,
      },
    },
  ]);

  // Fallback to activeSession.sendClientContent when sendClientEvent is absent.
  const fallbackCalls: unknown[] = [];
  const ok2 = sendRealtimeContext(
    {
      activeSession: {
        sendClientContent(params: unknown) {
          fallbackCalls.push(params);
        },
      },
    },
    'CALL STATE: ready',
  );
  assert.equal(ok2, true);
  assert.deepEqual(fallbackCalls, [
    {
      turns: [{ role: 'user', parts: [{ text: 'CALL STATE: ready' }] }],
      turnComplete: false,
    },
  ]);
});

test('camera status helpers prefer explicit camera attribute and fall back to video track state', () => {
  assert.equal(normalizeCameraAttr('on'), 'on');
  assert.equal(normalizeCameraAttr('OFF'), 'off');
  assert.equal(normalizeCameraAttr(undefined), undefined);

  assert.equal(
    readInitialCameraStatus({
      attributes: { camera: 'on' },
      trackPublications: new Map(),
    }),
    'on',
  );

  assert.equal(
    readInitialCameraStatus({
      attributes: { camera: 'off' },
      trackPublications: new Map([
        ['t1', { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA, muted: false, subscribed: true } as never],
      ]),
    }),
    'off',
  );

  assert.equal(
    readInitialCameraStatus({
      attributes: {},
      trackPublications: new Map([
        ['t1', { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA, muted: false, subscribed: true } as never],
      ]),
    }),
    'on',
  );

  assert.equal(
    readInitialCameraStatus({
      attributes: {},
      trackPublications: new Map([
        ['t1', { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA, muted: true, subscribed: true } as never],
      ]),
    }),
    'off',
  );
});
