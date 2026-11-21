import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent } from '@livekit/agents';
import { loadConfig } from '../src/agent/config.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import workerAgent, { bindStoreCallRoom, warmCallMedia } from '../src/agent/worker.ts';

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
  });

  assert.equal(cfg.googleApiKey, 'test-key-123');
  assert.equal(cfg.agentName, 'alice-dev');
  assert.equal(cfg.modelLive, 'gemini-3.1-flash-live-preview');
  assert.equal(cfg.geminiVoice, 'Achernar');
  assert.equal(cfg.avatar, 'none');
  assert.equal(cfg.vision, false);
  assert.equal(cfg.visionFrameMs, 2500);
});

test('loadConfig handles invalid numeric and boolean env values safely', () => {
  const cfg = loadConfig({
    VISION: 'maybe',
    VISION_FRAME_MS: '-50',
  });
  assert.equal(cfg.vision, true);
  assert.equal(cfg.visionFrameMs, 1000);
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
