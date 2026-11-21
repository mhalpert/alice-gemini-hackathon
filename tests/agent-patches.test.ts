import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as google from '@livekit/agents-plugin-google';
import {
  INTERRUPT_TOOL_NAMES,
  REQUIRED_PATCH_METHODS,
  applyRealtimeSessionPatches,
  sendInterimToolNote,
  type PatchableRealtimeSession,
} from '../src/agent/patches.ts';

const { FunctionResponseScheduling } = google.realtime;

test('patch (a) suppresses handleInputSpeechStarted during startNewGeneration and restores it even on throw', () => {
  let speechStartedCalls = 0;
  let shouldThrow = false;

  const fakeSession: PatchableRealtimeSession = {
    handleInputSpeechStarted() {
      speechStartedCalls++;
    },
    startNewGeneration() {
      this.handleInputSpeechStarted?.();
      if (shouldThrow) {
        throw new Error('boom');
      }
      return 'gen-ok';
    },
    getToolResultsForRealtime() {
      return undefined;
    },
  };

  const result = applyRealtimeSessionPatches(fakeSession, {
    room: 'patch-room',
    log: () => {},
    errorLog: () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);

  // Outside startNewGeneration: handleInputSpeechStarted works normally.
  fakeSession.handleInputSpeechStarted!();
  assert.equal(speechStartedCalls, 1);

  // Inside startNewGeneration: handleInputSpeechStarted is suppressed.
  const ret = fakeSession.startNewGeneration!();
  assert.equal(ret, 'gen-ok');
  assert.equal(speechStartedCalls, 1);

  // After startNewGeneration returns: restored.
  fakeSession.handleInputSpeechStarted!();
  assert.equal(speechStartedCalls, 2);

  // Even if startNewGeneration throws, handleInputSpeechStarted is restored via finally.
  shouldThrow = true;
  assert.throws(() => fakeSession.startNewGeneration!(), /boom/);
  fakeSession.handleInputSpeechStarted!();
  assert.equal(speechStartedCalls, 3);
});

test('patch (b) schedules final priority tool results INTERRUPT and leaves others WHEN_IDLE', () => {
  const fakeSession: PatchableRealtimeSession = {
    handleInputSpeechStarted() {},
    startNewGeneration() {},
    getToolResultsForRealtime(_ctx: unknown, _vertexai: boolean) {
      return {
        functionResponses: [
          { id: '1', name: 'build_outfits', response: { output: 'done' }, willContinue: false, scheduling: FunctionResponseScheduling.WHEN_IDLE },
          { id: '2', name: 'build_outfits', response: { output: 'working' }, willContinue: true, scheduling: FunctionResponseScheduling.WHEN_IDLE },
          { id: '3', name: 'add_to_bag', response: { output: 'added' }, scheduling: FunctionResponseScheduling.WHEN_IDLE },
          { id: '4', name: 'show_on_me', response: { output: 'ready' }, willContinue: false },
          { id: '5', name: 'swap_piece', response: { output: 'swapped' }, willContinue: false },
          { id: '6', name: 'pick_outfit', response: { output: 'picked' } },
          { id: '7', name: 'show_product', response: { output: 'shown' } },
          { id: '8', name: 'remember', response: { output: 'noted' }, scheduling: FunctionResponseScheduling.WHEN_IDLE },
          { id: '9', name: 'set_department', response: { output: 'men' } },
          { id: '10', name: 'hide_product', response: { output: 'closed' }, scheduling: FunctionResponseScheduling.SILENT },
        ],
      };
    },
  };

  applyRealtimeSessionPatches(fakeSession, { room: 'patch-room', log: () => {}, errorLog: () => {} });

  const out = fakeSession.getToolResultsForRealtime!({}, false);
  const byId = new Map(out!.functionResponses!.map((fr) => [fr.id, fr]));

  // All 6 priority tools (final results) become INTERRUPT.
  for (const id of ['1', '3', '4', '5', '6', '7']) {
    const fr = byId.get(id)!;
    assert.ok(INTERRUPT_TOOL_NAMES.has(fr.name!));
    assert.equal(fr.scheduling, FunctionResponseScheduling.INTERRUPT, `expected INTERRUPT for ${fr.name}`);
  }

  // Interim willContinue: true stays WHEN_IDLE even for a priority tool.
  assert.equal(byId.get('2')!.scheduling, FunctionResponseScheduling.WHEN_IDLE);

  // Non-priority tools stay WHEN_IDLE (and SILENT stays SILENT).
  assert.equal(byId.get('8')!.scheduling, FunctionResponseScheduling.WHEN_IDLE);
  assert.equal(byId.get('9')!.scheduling, FunctionResponseScheduling.WHEN_IDLE);
  assert.equal(byId.get('10')!.scheduling, FunctionResponseScheduling.SILENT);

  // On Vertex AI (vertexai=true), scheduling is left untouched.
  const vertexOut = fakeSession.getToolResultsForRealtime!({}, true);
  assert.equal(vertexOut!.functionResponses![0]!.scheduling, FunctionResponseScheduling.WHEN_IDLE);
});

test('missing-method startup check logs loud error and session_error with source patch_check without crashing', () => {
  const loggedEvents: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const consoleErrors: unknown[][] = [];

  const incompleteSession: PatchableRealtimeSession = {
    startNewGeneration() {},
    // missing handleInputSpeechStarted and getToolResultsForRealtime
  };

  const res = applyRealtimeSessionPatches(incompleteSession, {
    room: 'broken-room',
    log: (room, ev, data) => loggedEvents.push({ room, ev, data }),
    errorLog: (...args) => consoleErrors.push(args),
  });

  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['handleInputSpeechStarted', 'getToolResultsForRealtime']);
  assert.equal(consoleErrors.length, 1);
  assert.match(String(consoleErrors[0]![0]), /CRITICAL PATCH CHECK FAILED/);
  assert.equal(loggedEvents.length, 1);
  assert.equal(loggedEvents[0]!.room, 'broken-room');
  assert.equal(loggedEvents[0]!.ev, 'session_error');
  assert.equal(loggedEvents[0]!.data?.source, 'patch_check');
  assert.deepEqual(loggedEvents[0]!.data?.missing, [
    'handleInputSpeechStarted',
    'getToolResultsForRealtime',
  ]);
});

test('sendInterimToolNote dispatches willContinue: true function response via sendClientEvent or activeSession', () => {
  const events: unknown[] = [];
  const ok1 = sendInterimToolNote(
    {
      sendClientEvent(ev: unknown) {
        events.push(ev);
      },
    },
    { callId: 'c1', name: 'build_outfits', note: 'Working on looks.' },
  );
  assert.equal(ok1, true);
  assert.deepEqual(events, [
    {
      type: 'tool_response',
      value: {
        functionResponses: [
          {
            id: 'c1',
            name: 'build_outfits',
            response: { output: 'Working on looks.' },
            willContinue: true,
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
          },
        ],
      },
    },
  ]);

  const directCalls: unknown[] = [];
  const ok2 = sendInterimToolNote(
    {
      activeSession: {
        sendToolResponse(params: unknown) {
          directCalls.push(params);
        },
      },
    },
    { callId: 'c2', name: 'show_on_me', note: 'Rendering try-on.' },
  );
  assert.equal(ok2, true);
  assert.equal(directCalls.length, 1);
});

test('installed @livekit/agents-plugin-google RealtimeSession exposes all patched target methods', async () => {
  const mod = await import(
    '../node_modules/@livekit/agents-plugin-google/dist/realtime/realtime_api.js'
  );
  const proto = mod.RealtimeSession.prototype as Record<string, unknown>;
  for (const method of REQUIRED_PATCH_METHODS) {
    assert.equal(typeof proto[method], 'function', `expected RealtimeSession.prototype.${method} to be a function`);
  }
  assert.equal(typeof proto.sendClientEvent, 'function');
});
