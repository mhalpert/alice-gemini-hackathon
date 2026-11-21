import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent } from '@livekit/agents';
import { loadConfig } from '../src/agent/config.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import workerAgent from '../src/agent/worker.ts';

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
