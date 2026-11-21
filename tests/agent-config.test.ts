import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent } from '@livekit/agents';
import { loadConfig } from '../src/agent/config.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import workerAgent, { bindStoreCallRoom } from '../src/agent/worker.ts';

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
