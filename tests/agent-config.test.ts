import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent } from '@livekit/agents';
import { buildAutomaticActivityDetection, loadConfig } from '../src/agent/config.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import workerAgent, {
  bindStoreCallRoom,
  resolveNoiseCancellation,
  startSessionWithNoiseCancel,
  warmCallMedia,
} from '../src/agent/worker.ts';

test('loadConfig returns expected defaults when env is empty', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.googleApiKey, undefined);
  assert.equal(cfg.agentName, 'alice');
  assert.equal(cfg.modelLive, 'gemini-3.8-live');
  assert.equal(cfg.geminiVoice, 'Aoede');
  assert.equal(cfg.language, 'en-US');
  assert.equal(cfg.avatar, 'none');
  assert.equal(cfg.vision, true);
  assert.equal(cfg.visionFrameMs, 1000);
  assert.equal(cfg.noiseCancel, 'bvc');
  assert.equal(cfg.roomMode, 'noisy');
  assert.deepEqual(cfg.vad, {
    room: 'noisy',
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 1000,
    prefixPaddingMs: 150,
  });
  assert.deepEqual(buildAutomaticActivityDetection(cfg.vad), {
    disabled: false,
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 1000,
    prefixPaddingMs: 150,
  });
});

test('loadConfig reads and normalizes env overrides', () => {
  const cfg = loadConfig({
    GOOGLE_API_KEY: '  test-key-123  ',
    ALICE_AGENT_NAME: 'alice-dev',
    ALICE_MODEL_LIVE: 'gemini-3.1-flash-live-preview',
    GEMINI_VOICE: 'Achernar',
    AVATAR: 'NONE',
    VISION: 'off',
    VISION_FRAME_MS: '2500',
    ALICE_NOISE_CANCEL: ' NC ',
    ALICE_ROOM: ' QUIET ',
  });

  assert.equal(cfg.googleApiKey, 'test-key-123');
  assert.equal(cfg.agentName, 'alice-dev');
  assert.equal(cfg.modelLive, 'gemini-3.1-flash-live-preview');
  assert.equal(cfg.geminiVoice, 'Achernar');
  assert.equal(cfg.avatar, 'none');
  assert.equal(cfg.vision, false);
  assert.equal(cfg.visionFrameMs, 2500);
  assert.equal(cfg.noiseCancel, 'nc');
  assert.equal(cfg.roomMode, 'quiet');
  assert.deepEqual(cfg.vad, {
    room: 'quiet',
    startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 1000,
    prefixPaddingMs: undefined,
  });
  const aad = buildAutomaticActivityDetection(cfg.vad);
  assert.deepEqual(aad, {
    disabled: false,
    startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 1000,
  });
  assert.equal('prefixPaddingMs' in aad, false);
});

test('loadConfig parses explicit VAD overrides on top of room presets', () => {
  const fromNoisy = loadConfig({
    ALICE_ROOM: 'noisy',
    ALICE_VAD_START: 'high',
    ALICE_VAD_END: 'low',
    ALICE_VAD_SILENCE_MS: '750',
    ALICE_VAD_PREFIX_MS: '200',
  });
  assert.deepEqual(fromNoisy.vad, {
    room: 'noisy',
    startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
    endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
    silenceDurationMs: 750,
    prefixPaddingMs: 200,
  });

  const fullEnumsAndZeroPrefix = loadConfig({
    ALICE_ROOM: 'quiet',
    ALICE_VAD_START: 'START_SENSITIVITY_LOW',
    ALICE_VAD_END: 'END_SENSITIVITY_UNSPECIFIED',
    ALICE_VAD_SILENCE_MS: '350',
    ALICE_VAD_PREFIX_MS: '0',
  });
  assert.deepEqual(fullEnumsAndZeroPrefix.vad, {
    room: 'quiet',
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_UNSPECIFIED',
    silenceDurationMs: 350,
    prefixPaddingMs: 0,
  });
  assert.equal(buildAutomaticActivityDetection(fullEnumsAndZeroPrefix.vad).prefixPaddingMs, 0);

  const prefixOff = loadConfig({
    ALICE_ROOM: 'noisy',
    ALICE_VAD_PREFIX_MS: 'off',
  });
  assert.equal(prefixOff.vad.prefixPaddingMs, undefined);
  assert.equal('prefixPaddingMs' in buildAutomaticActivityDetection(prefixOff.vad), false);
});

test('loadConfig handles invalid numeric, boolean, noise cancel, and VAD env values safely', () => {
  const cfg = loadConfig({
    VISION: 'maybe',
    VISION_FRAME_MS: '-50',
    ALICE_NOISE_CANCEL: 'turbo',
    ALICE_ROOM: 'stadium',
    ALICE_VAD_START: 'medium',
    ALICE_VAD_END: 'medium',
    ALICE_VAD_SILENCE_MS: '0',
    ALICE_VAD_PREFIX_MS: '-10',
  });
  assert.equal(cfg.vision, true);
  assert.equal(cfg.visionFrameMs, 1000);
  assert.equal(cfg.noiseCancel, 'bvc');
  assert.equal(cfg.roomMode, 'noisy');
  assert.deepEqual(cfg.vad, {
    room: 'noisy',
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 1000,
    prefixPaddingMs: 150,
  });
});

test('loadConfig supports ALICE_NOISE_CANCEL=off', () => {
  const cfg = loadConfig({ ALICE_NOISE_CANCEL: 'off' });
  assert.equal(cfg.noiseCancel, 'off');
});

test('persona prompt and greeting instructions contain key rules', () => {
  assert.match(ALICE_SYSTEM_PROMPT, /Alice/);
  assert.match(ALICE_SYSTEM_PROMPT, /AI/);
  assert.match(ALICE_SYSTEM_PROMPT, /card numbers|passwords|addresses/i);
  assert.ok(GREETING_INSTRUCTIONS.length > 0);
});

test('importing worker.ts exports a valid AgentDefinition without starting a worker', () => {
  assert.equal(isAgent(workerAgent), true);
  assert.equal(typeof workerAgent.entry, 'function');
});

test('resolveNoiseCancellation selects bvc, nc, or off and logs session_error on load or constructor failure', async () => {
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const log = (room: string, ev: string, data?: Record<string, unknown>) =>
    logs.push({ room, ev, data });

  // 1) off skips loading entirely.
  let loadCalls = 0;
  const offRes = await resolveNoiseCancellation('room-off', 'off', {
    loadModule: async () => {
      loadCalls += 1;
      return {};
    },
    log,
  });
  assert.deepEqual(offRes, { mode: 'off', requested: 'off' });
  assert.equal(loadCalls, 0);
  assert.equal(logs.length, 0);

  // 2) bvc invokes BackgroundVoiceCancellation().
  const bvcOpts = { moduleId: 'livekit.plugins.noise_cancellation', options: { modelPath: 'bvc.kef' } };
  const bvcRes = await resolveNoiseCancellation('room-bvc', 'bvc', {
    loadModule: async () => ({
      BackgroundVoiceCancellation: () => bvcOpts,
    }),
    log,
  });
  assert.deepEqual(bvcRes, { mode: 'bvc', requested: 'bvc', noiseCancellation: bvcOpts });
  assert.equal(logs.length, 0);

  // 3) nc invokes NoiseCancellation().
  const ncOpts = { moduleId: 'livekit.plugins.noise_cancellation', options: { modelPath: 'nc.kef' } };
  const ncRes = await resolveNoiseCancellation('room-nc', 'nc', {
    loadModule: async () => ({
      NoiseCancellation: () => ncOpts,
    }),
    log,
  });
  assert.deepEqual(ncRes, { mode: 'nc', requested: 'nc', noiseCancellation: ncOpts });
  assert.equal(logs.length, 0);

  // 4) Dynamic import failure logs session_error(noise_cancel) and falls back to off.
  const importFail = await resolveNoiseCancellation('room-import-fail', 'bvc', {
    loadModule: async () => {
      throw new Error('module not found');
    },
    log,
  });
  assert.deepEqual(importFail, { mode: 'off', requested: 'bvc' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'session_error');
  assert.equal(logs[0]!.data?.source, 'noise_cancel');
  assert.equal(logs[0]!.data?.mode, 'bvc');
  assert.match(String((logs[0]!.data?.error as Error)?.message), /module not found/);

  // 5) Filter constructor throwing logs session_error(noise_cancel) and falls back to off.
  const ctorFail = await resolveNoiseCancellation('room-ctor-fail', 'nc', {
    loadModule: async () => ({
      NoiseCancellation: () => {
        throw new Error('Resource not found: model.kef');
      },
    }),
    log,
  });
  assert.deepEqual(ctorFail, { mode: 'off', requested: 'nc' });
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.ev, 'session_error');
  assert.equal(logs[1]!.data?.source, 'noise_cancel');
  assert.equal(logs[1]!.data?.mode, 'nc');
  assert.match(String((logs[1]!.data?.error as Error)?.message), /Resource not found/);
});

test('startSessionWithNoiseCancel wires inputOptions.noiseCancellation, logs mode, and retries without it if start throws', async () => {
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const log = (room: string, ev: string, data?: Record<string, unknown>) =>
    logs.push({ room, ev, data });
  const fakeAgent = { id: 'agent' } as never;
  const fakeRoom = { name: 'room-1' } as never;
  const bvcOpts = { moduleId: 'livekit.plugins.noise_cancellation', options: { modelPath: 'bvc.kef' } };

  // 1) Happy path: starts with inputOptions.noiseCancellation and logs noise_cancel(bvc).
  const startCalls1: Array<Record<string, unknown>> = [];
  const res1 = await startSessionWithNoiseCancel({
    roomName: 'room-1',
    session: {
      start: async (opts) => {
        startCalls1.push(opts as Record<string, unknown>);
      },
    },
    agent: fakeAgent,
    room: fakeRoom,
    requestedMode: 'bvc',
    loadModule: async () => ({ BackgroundVoiceCancellation: () => bvcOpts }),
    log,
  });
  assert.deepEqual(res1, { mode: 'bvc', requested: 'bvc' });
  assert.equal(startCalls1.length, 1);
  assert.deepEqual(startCalls1[0]!.inputOptions, { noiseCancellation: bvcOpts });
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], { room: 'room-1', ev: 'noise_cancel', data: { mode: 'bvc' } });

  // 2) Filter throws inside session.start -> logs session_error(noise_cancel), retries without inputOptions, logs noise_cancel(off, fallback).
  const startCalls2: Array<Record<string, unknown>> = [];
  let attempt = 0;
  const res2 = await startSessionWithNoiseCancel({
    roomName: 'room-2',
    session: {
      start: async (opts) => {
        attempt += 1;
        startCalls2.push(opts as Record<string, unknown>);
        if (attempt === 1) {
          throw new Error('AudioFilter init failed');
        }
      },
    },
    agent: fakeAgent,
    room: fakeRoom,
    requestedMode: 'bvc',
    loadModule: async () => ({ BackgroundVoiceCancellation: () => bvcOpts }),
    log,
  });
  assert.deepEqual(res2, { mode: 'off', requested: 'bvc' });
  assert.equal(startCalls2.length, 2);
  assert.deepEqual(startCalls2[0]!.inputOptions, { noiseCancellation: bvcOpts });
  assert.equal('inputOptions' in startCalls2[1]!, false);
  assert.equal(logs.length, 3);
  assert.equal(logs[1]!.ev, 'session_error');
  assert.equal(logs[1]!.data?.source, 'noise_cancel');
  assert.match(String((logs[1]!.data?.error as Error)?.message), /AudioFilter init failed/);
  assert.deepEqual(logs[2], {
    room: 'room-2',
    ev: 'noise_cancel',
    data: { mode: 'off', requested: 'bvc', fallback: true },
  });
});

test('bindStoreCallRoom calls store setCallRoom once and guards against import or export failures', async () => {
  const boundRooms: Array<string | null> = [];
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];

  const ok = await bindStoreCallRoom('room-alpha', {
    loadStoreModule: async () => ({
      setCallRoom: (room) => boundRooms.push(room),
    }),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(ok, true);
  assert.deepEqual(boundRooms, ['room-alpha']);
  assert.equal(logs.length, 0);

  // Import failure must never throw and must log session_error with source store_room.
  const failedImport = await bindStoreCallRoom('room-beta', {
    loadStoreModule: async () => {
      throw new Error('store import boom');
    },
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(failedImport, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.room, 'room-beta');
  assert.equal(logs[0]!.ev, 'session_error');
  assert.equal(logs[0]!.data?.source, 'store_room');
  assert.match(String((logs[0]!.data?.error as Error)?.message), /store import boom/);

  // Missing setCallRoom export must also log session_error with source store_room.
  const missingExport = await bindStoreCallRoom('room-gamma', {
    loadStoreModule: async () => ({}),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(missingExport, false);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.room, 'room-gamma');
  assert.equal(logs[1]!.ev, 'session_error');
  assert.equal(logs[1]!.data?.source, 'store_room');
});

test('warmCallMedia calls warmMedia without re-binding setCallRoom and logs session_error(media_warm) on failure', async () => {
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  let warmCalls = 0;
  let setCallRoomCalls = 0;
  let releaseWarm!: () => void;
  const warmGate = new Promise<void>((resolve) => {
    releaseWarm = resolve;
  });

  // 1) Fire-and-forget: starts warmMedia without blocking, resolves cleanly, never calls setCallRoom.
  const pending = warmCallMedia('room-warm', {
    loadMediaModule: async () => ({
      async warmMedia() {
        warmCalls += 1;
        await warmGate;
      },
      setCallRoom() {
        setCallRoomCalls += 1;
      },
    }),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  // Greeting / next work can proceed before warmMedia finishes.
  let greetingRanBeforeWarmSettled = false;
  await Promise.resolve();
  greetingRanBeforeWarmSettled = true;
  assert.equal(greetingRanBeforeWarmSettled, true);

  releaseWarm();
  const ok = await pending;
  assert.equal(ok, true);
  assert.equal(warmCalls, 1);
  assert.equal(setCallRoomCalls, 0, 'warmCallMedia must not call setCallRoom a second time');
  assert.equal(logs.length, 0);

  // 2) Dynamic import error -> never throws, logs session_error with source media_warm.
  const importFail = await warmCallMedia('room-import-err', {
    loadMediaModule: async () => {
      throw new Error('media import boom');
    },
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(importFail, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.room, 'room-import-err');
  assert.equal(logs[0]!.ev, 'session_error');
  assert.equal(logs[0]!.data?.source, 'media_warm');
  assert.match(String((logs[0]!.data?.error as Error)?.message), /media import boom/);

  // 3) warmMedia rejection -> never throws, logs session_error with source media_warm.
  const rejectFail = await warmCallMedia('room-warm-reject', {
    loadMediaModule: async () => ({
      async warmMedia() {
        throw new Error('child spawn failed');
      },
    }),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(rejectFail, false);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.room, 'room-warm-reject');
  assert.equal(logs[1]!.ev, 'session_error');
  assert.equal(logs[1]!.data?.source, 'media_warm');
  assert.match(String((logs[1]!.data?.error as Error)?.message), /child spawn failed/);

  // 4) Missing warmMedia export -> never throws, logs session_error with source media_warm.
  const missingExport = await warmCallMedia('room-no-warm', {
    loadMediaModule: async () => ({}),
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  assert.equal(missingExport, false);
  assert.equal(logs.length, 3);
  assert.equal(logs[2]!.room, 'room-no-warm');
  assert.equal(logs[2]!.ev, 'session_error');
  assert.equal(logs[2]!.data?.source, 'media_warm');
});
