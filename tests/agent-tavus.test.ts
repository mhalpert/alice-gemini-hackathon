import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { initializeLogger } from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import { loadConfig, resolveTavusConfig } from '../src/agent/config.ts';
import {
  ALICE_TAVUS_CONVERSATION_PREFIX,
  buildTavusConversationName,
  createDefaultTavusAvatarSession,
  endStaleTavusConversations,
  endTavusConversation,
  sanitizeTavusReason,
  startTavusAvatar,
  type AvatarSessionLike,
  type CreateAvatarSessionParams,
  type FallbackAudioOutputLike,
  type SessionAudioOutputLike,
} from '../src/agent/tavus.ts';
import { startSessionWithNoiseCancel } from '../src/agent/worker.ts';

function makeLogCollector() {
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const log = (room: string, ev: string, data?: Record<string, unknown>) => {
    logs.push({ room, ev, data });
  };
  return { logs, log };
}

function makeFakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('config parsing: AVATAR and Tavus env vars normalize and default safely', () => {
  const empty = loadConfig({});
  assert.equal(empty.avatar, 'none');
  assert.equal(empty.tavusApiKey, undefined);
  assert.equal(empty.tavusFaceId, undefined);
  assert.equal(empty.tavusPersonaId, undefined);

  const valid = loadConfig({
    AVATAR: '  TAVUS  ',
    TAVUS_API_KEY: '  tk-secret-1  ',
    TAVUS_FACE_ID: '  r12345  ',
    TAVUS_PERSONA_ID: '  p67890  ',
  });
  assert.equal(valid.avatar, 'tavus');
  assert.equal(valid.tavusApiKey, 'tk-secret-1');
  assert.equal(valid.tavusFaceId, 'r12345');
  assert.equal(valid.tavusPersonaId, 'p67890');

  const invalidAvatar = loadConfig({
    AVATAR: 'hologram',
    TAVUS_API_KEY: '   ',
    TAVUS_FACE_ID: '',
    TAVUS_PERSONA_ID: '   ',
  });
  assert.equal(invalidAvatar.avatar, 'none');
  assert.equal(invalidAvatar.tavusApiKey, undefined);
  assert.equal(invalidAvatar.tavusFaceId, undefined);
  assert.equal(invalidAvatar.tavusPersonaId, undefined);
});

test('resolveTavusConfig enables avatar only when AVATAR=tavus, TAVUS_API_KEY, and TAVUS_FACE_ID are all present', () => {
  // AVATAR=none with credentials -> disabled, not requested
  assert.deepEqual(
    resolveTavusConfig(
      loadConfig({
        AVATAR: 'none',
        TAVUS_API_KEY: 'key-1',
        TAVUS_FACE_ID: 'face-1',
      }),
    ),
    { enabled: false, requested: false },
  );

  // AVATAR=tavus missing both key and face id
  const missingBoth = resolveTavusConfig(loadConfig({ AVATAR: 'tavus' }));
  assert.equal(missingBoth.enabled, false);
  assert.equal(missingBoth.requested, true);
  assert.match(missingBoth.missingReason ?? '', /TAVUS_API_KEY.*TAVUS_FACE_ID/);

  // AVATAR=tavus missing key only
  const missingKey = resolveTavusConfig(
    loadConfig({ AVATAR: 'tavus', TAVUS_FACE_ID: 'face-1' }),
  );
  assert.equal(missingKey.enabled, false);
  assert.equal(missingKey.requested, true);
  assert.match(missingKey.missingReason ?? '', /TAVUS_API_KEY/);

  // AVATAR=tavus missing face id only
  const missingFace = resolveTavusConfig(
    loadConfig({ AVATAR: 'tavus', TAVUS_API_KEY: 'key-1' }),
  );
  assert.equal(missingFace.enabled, false);
  assert.equal(missingFace.requested, true);
  assert.match(missingFace.missingReason ?? '', /TAVUS_FACE_ID/);

  // All three present without persona id -> enabled, personaId omitted
  const enabledNoPersona = resolveTavusConfig(
    loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'key-1',
      TAVUS_FACE_ID: 'face-1',
    }),
  );
  assert.deepEqual(enabledNoPersona, {
    enabled: true,
    requested: true,
    apiKey: 'key-1',
    faceId: 'face-1',
  });
  assert.equal('personaId' in enabledNoPersona, false);

  // All three present with optional persona id -> enabled with personaId
  const enabledWithPersona = resolveTavusConfig(
    loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'key-1',
      TAVUS_FACE_ID: 'face-1',
      TAVUS_PERSONA_ID: 'persona-9',
    }),
  );
  assert.deepEqual(enabledWithPersona, {
    enabled: true,
    requested: true,
    apiKey: 'key-1',
    faceId: 'face-1',
    personaId: 'persona-9',
  });
});

test('startTavusAvatar skips avatar when AVATAR=none or settings are incomplete', async () => {
  const { logs, log } = makeLogCollector();
  const warnings: string[] = [];
  let createCalls = 0;

  const session: SessionAudioOutputLike = { output: { audio: null } };

  // 1) AVATAR=none -> silent no-op, audioEnabled stays true
  const noneHandle = await startTavusAvatar({
    roomName: 'room-none',
    config: loadConfig({
      AVATAR: 'none',
      TAVUS_API_KEY: 'secret-key',
      TAVUS_FACE_ID: 'face-1',
    }),
    session,
    room: {},
    createAvatarSession: () => {
      createCalls += 1;
      throw new Error('should not be called');
    },
    log,
    warn: (m) => warnings.push(m),
  });
  assert.equal(noneHandle.startedWithFace, false);
  assert.equal(noneHandle.active, false);
  assert.deepEqual(noneHandle.roomOutputOptions, { audioEnabled: true });
  assert.equal(createCalls, 0);
  assert.equal(logs.length, 0);
  assert.equal(warnings.length, 0);

  // 2) AVATAR=tavus missing TAVUS_FACE_ID -> logs fallback, never calls avatar factory, audioEnabled true
  const partialHandle = await startTavusAvatar({
    roomName: 'room-partial',
    config: loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'secret-key',
    }),
    session,
    room: {},
    createAvatarSession: () => {
      createCalls += 1;
      throw new Error('should not be called');
    },
    log,
    warn: (m) => warnings.push(m),
  });
  assert.equal(partialHandle.startedWithFace, false);
  assert.deepEqual(partialHandle.roomOutputOptions, { audioEnabled: true });
  assert.equal(createCalls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'tavus');
  assert.equal(logs[0]!.data?.stage, 'fallback');
  assert.match(String(logs[0]!.data?.reason), /TAVUS_FACE_ID/);
});

test('startTavusAvatar success turns agent room audio off, tags conversation name, and ends conversation on shutdown', async () => {
  const { logs, log } = makeLogCollector();
  const fakeDataStreamAudio = { kind: 'datastream', clearBuffer: () => {} };
  const session: SessionAudioOutputLike = { output: { audio: null } };
  const events: string[] = [];
  const endedUrls: string[] = [];
  let receivedCreateParams: CreateAvatarSessionParams | null = null;
  let acloseCalls = 0;

  let clock = 1000;
  const now = () => clock;

  const fakeFetch = makeFakeFetch(async (url, init) => {
    if (init?.method === 'GET' && url.includes('/conversations')) {
      events.push('stale_list');
      return jsonResponse({ data: [] });
    }
    if (init?.method === 'POST' && url.endsWith('/end')) {
      endedUrls.push(url);
      events.push(`end:${url}`);
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
  });

  const handle = await startTavusAvatar({
    roomName: 'alice-room-42',
    config: loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'super-secret-tavus-key',
      TAVUS_FACE_ID: 'r-face-42',
      TAVUS_PERSONA_ID: 'p-persona-7',
    }),
    session,
    room: { name: 'alice-room-42' },
    fetchImpl: fakeFetch,
    log,
    now,
    createAvatarSession: (opts): AvatarSessionLike => {
      receivedCreateParams = opts;
      return {
        avatarIdentity: 'tavus-avatar-agent',
        conversationId: null,
        async start(sess) {
          events.push('avatar_start');
          clock += 250;
          this.conversationId = 'conv-live-99';
          opts.onConversationId('conv-live-99');
          (sess as SessionAudioOutputLike).output.audio = fakeDataStreamAudio;
        },
        async waitForJoin() {
          events.push('avatar_join');
          clock += 350;
        },
        async aclose() {
          acloseCalls += 1;
          events.push('avatar_aclose');
        },
      };
    },
  });

  assert.equal(handle.startedWithFace, true);
  assert.equal(handle.active, true);
  assert.equal(handle.conversationId, 'conv-live-99');
  assert.equal(handle.avatarIdentity, 'tavus-avatar-agent');
  assert.deepEqual(handle.roomOutputOptions, { audioEnabled: false });
  assert.equal(session.output.audio, fakeDataStreamAudio);
  assert.ok(receivedCreateParams);
  assert.equal(receivedCreateParams!.faceId, 'r-face-42');
  assert.equal(receivedCreateParams!.personaId, 'p-persona-7');
  assert.equal(
    receivedCreateParams!.conversationName,
    buildTavusConversationName('alice-room-42'),
  );
  assert.ok(receivedCreateParams!.conversationName.startsWith(ALICE_TAVUS_CONVERSATION_PREFIX));

  // Wire into startSessionWithNoiseCancel: agent audio must be turned off (audioEnabled: false)
  const startCalls: Array<Record<string, unknown>> = [];
  await startSessionWithNoiseCancel({
    roomName: 'alice-room-42',
    session: {
      start: async (opts) => {
        events.push('session_start');
        startCalls.push(opts as Record<string, unknown>);
      },
    },
    agent: { id: 'alice' } as never,
    room: { name: 'alice-room-42' } as never,
    requestedMode: 'off',
    outputOptions: handle.roomOutputOptions,
    log,
  });

  assert.equal(startCalls.length, 1);
  assert.deepEqual(startCalls[0]!.outputOptions, { audioEnabled: false });
  assert.deepEqual(events.slice(0, 4), ['stale_list', 'avatar_start', 'avatar_join', 'session_start']);

  // Verify call logs: start -> ready (with ms) and never leaks API key
  const tavusLogs = logs.filter((l) => l.ev === 'tavus');
  assert.equal(tavusLogs[0]!.data?.stage, 'start');
  assert.equal(tavusLogs[1]!.data?.stage, 'ready');
  assert.equal(tavusLogs[1]!.data?.ms, 600);
  assert.equal(tavusLogs[1]!.data?.conversation_id, 'conv-live-99');
  assert.equal(JSON.stringify(logs).includes('super-secret-tavus-key'), false);

  // Shutdown ends the Tavus conversation and calls aclose() once (idempotent)
  await handle.shutdown();
  await handle.shutdown();
  assert.equal(acloseCalls, 1);
  assert.equal(endedUrls.length, 1);
  assert.match(endedUrls[0]!, /\/conversations\/conv-live-99\/end$/);
  const endedLog = logs.find((l) => l.ev === 'tavus' && l.data?.stage === 'ended');
  assert.ok(endedLog);
  assert.equal(endedLog!.data?.conversation_id, 'conv-live-99');
  assert.equal(endedLog!.data?.ok, true);
});

test('startTavusAvatar timeout resets agent audio to null, ends partial conversation, and continues voice-only with audio on', async () => {
  const { logs, log } = makeLogCollector();
  const warnings: string[] = [];
  const fakeDataStreamAudio = { kind: 'datastream' };
  const session: SessionAudioOutputLike = { output: { audio: null } };
  const endedConvIds: string[] = [];
  let acloseCalls = 0;

  const fakeFetch = makeFakeFetch(async (url, init) => {
    if (init?.method === 'GET' && url.includes('/conversations')) {
      return jsonResponse({ data: [] });
    }
    if (init?.method === 'POST' && url.endsWith('/end')) {
      endedConvIds.push(url);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({}, 404);
  });

  const handle = await startTavusAvatar({
    roomName: 'room-timeout',
    config: loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'very-secret-key-xyz',
      TAVUS_FACE_ID: 'face-slow',
    }),
    session,
    room: { name: 'room-timeout' },
    startTimeoutMs: 40,
    fetchImpl: fakeFetch,
    log,
    warn: (m) => warnings.push(m),
    createAvatarSession: (opts): AvatarSessionLike => ({
      avatarIdentity: 'tavus-avatar-agent',
      conversationId: null,
      async start(sess) {
        this.conversationId = 'conv-stuck-1';
        opts.onConversationId('conv-stuck-1');
        // Simulates plugin setting DataStreamAudioOutput before join hangs
        (sess as SessionAudioOutputLike).output.audio = fakeDataStreamAudio;
      },
      async waitForJoin() {
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      async aclose() {
        acloseCalls += 1;
      },
    }),
  });

  // Allow best-effort cleanup microtasks to flush
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(handle.startedWithFace, false);
  assert.equal(handle.active, false);
  assert.deepEqual(handle.roomOutputOptions, { audioEnabled: true });
  assert.equal(session.output.audio, null, 'must reset session.output.audio to null so RoomIO publishes agent audio');
  assert.equal(acloseCalls, 1);
  assert.equal(endedConvIds.length, 1);
  assert.match(endedConvIds[0]!, /\/conversations\/conv-stuck-1\/end$/);
  assert.equal(warnings.length, 1);

  // Starting session after timeout turns agent audio ON
  const startCalls: Array<Record<string, unknown>> = [];
  await startSessionWithNoiseCancel({
    roomName: 'room-timeout',
    session: {
      start: async (opts) => {
        startCalls.push(opts as Record<string, unknown>);
      },
    },
    agent: { id: 'alice' } as never,
    room: { name: 'room-timeout' } as never,
    requestedMode: 'off',
    outputOptions: handle.roomOutputOptions,
    log,
  });
  assert.deepEqual(startCalls[0]!.outputOptions, { audioEnabled: true });

  const stages = logs.filter((l) => l.ev === 'tavus').map((l) => l.data?.stage);
  assert.deepEqual(stages, ['start', 'failed', 'fallback']);
  assert.equal(JSON.stringify(logs).includes('very-secret-key-xyz'), false);
});

test('startTavusAvatar failure redacts API key from call log and falls back to voice-only', async () => {
  const { logs, log } = makeLogCollector();
  const secretKey = 'tv-live-secret-99999';
  const session: SessionAudioOutputLike = { output: { audio: null } };

  const handle = await startTavusAvatar({
    roomName: 'room-err',
    config: loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: secretKey,
      TAVUS_FACE_ID: 'face-bad',
    }),
    session,
    room: {},
    staleCleanupPromise: Promise.resolve({ ended: 0, failed: 0 }),
    log,
    warn: () => {},
    createAvatarSession: (): AvatarSessionLike => ({
      avatarIdentity: 'tavus-avatar-agent',
      async start() {
        const err = new Error(`Unauthorized for key ${secretKey}`) as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      },
    }),
  });

  assert.equal(handle.startedWithFace, false);
  assert.deepEqual(handle.roomOutputOptions, { audioEnabled: true });
  assert.equal(session.output.audio, null);

  const failedLog = logs.find((l) => l.ev === 'tavus' && l.data?.stage === 'failed');
  const fallbackLog = logs.find((l) => l.ev === 'tavus' && l.data?.stage === 'fallback');
  assert.ok(failedLog);
  assert.ok(fallbackLog);
  assert.match(String(failedLog!.data?.reason), /HTTP 401/);
  assert.match(String(failedLog!.data?.reason), /\[REDACTED\]/);
  assert.equal(JSON.stringify(logs).includes(secretKey), false);
});

test('mid-call avatar disconnect falls back to agent audio output without ending the call', async () => {
  const { logs, log } = makeLogCollector();
  const room = new EventEmitter();
  let clearBufferCalls = 0;
  const avatarAudio = {
    kind: 'datastream',
    clearBuffer: () => {
      clearBufferCalls += 1;
    },
  };
  const session: SessionAudioOutputLike = { output: { audio: null } };
  const endedUrls: string[] = [];

  const fakeFetch = makeFakeFetch(async (url, init) => {
    if (init?.method === 'POST' && url.endsWith('/end')) {
      endedUrls.push(url);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ data: [] });
  });

  const handle = await startTavusAvatar({
    roomName: 'room-drop',
    config: loadConfig({
      AVATAR: 'tavus',
      TAVUS_API_KEY: 'secret-drop-key',
      TAVUS_FACE_ID: 'face-1',
    }),
    session,
    room,
    staleCleanupPromise: Promise.resolve({ ended: 0, failed: 0 }),
    fetchImpl: fakeFetch,
    log,
    createAvatarSession: (opts): AvatarSessionLike => ({
      avatarIdentity: 'tavus-avatar-agent',
      conversationId: 'conv-drop-1',
      async start(sess) {
        opts.onConversationId('conv-drop-1');
        (sess as SessionAudioOutputLike).output.audio = avatarAudio;
      },
      async waitForJoin() {},
    }),
  });

  let fallbackStarted = 0;
  let fallbackClosed = 0;
  const fallbackAudio: FallbackAudioOutputLike = {
    async start() {
      fallbackStarted += 1;
    },
    async close() {
      fallbackClosed += 1;
    },
  };

  handle.attachDisconnectFallback({
    room: room as never,
    session,
    createFallbackAudioOutput: () => fallbackAudio,
  });

  // Unrelated participant leaving must NOT trigger fallback
  room.emit(RoomEvent.ParticipantDisconnected, { identity: 'some-other-participant' });
  assert.equal(handle.active, true);
  assert.equal(session.output.audio, avatarAudio);
  assert.equal(fallbackStarted, 0);

  // Avatar participant disconnecting mid-call triggers fallback to agent audio
  room.emit(RoomEvent.ParticipantDisconnected, { identity: 'tavus-avatar-agent' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(handle.active, false);
  assert.equal(session.output.audio, fallbackAudio as unknown);
  assert.equal(clearBufferCalls, 1);
  assert.equal(fallbackStarted, 1);
  assert.equal(endedUrls.length, 1);

  const fallbackLog = logs.find((l) => l.ev === 'tavus' && l.data?.stage === 'fallback');
  assert.ok(fallbackLog);
  assert.equal(fallbackLog!.data?.reason, 'avatar_disconnected');

  // Shutdown closes the fallback audio output cleanly
  await handle.shutdown();
  assert.equal(fallbackClosed, 1);
});

test('endStaleTavusConversations ends only active Alice-prefixed conversations and tolerates API/network errors', async () => {
  const { logs, log } = makeLogCollector();
  const endedIds: string[] = [];

  // 1) Mixed conversations: only active conversations with alice-stylist- prefix are ended;
  // partial failure on one /end call still succeeds for the others.
  const mixedFetch = makeFakeFetch(async (url, init) => {
    if (init?.method === 'GET' && url.includes('/conversations')) {
      return jsonResponse({
        data: [
          {
            conversation_id: 'c-alice-1',
            conversation_name: `${ALICE_TAVUS_CONVERSATION_PREFIX}old-room-1`,
            status: 'active',
          },
          {
            conversation_id: 'c-alice-2',
            conversation_name: `${ALICE_TAVUS_CONVERSATION_PREFIX}old-room-2`,
            status: 'active',
          },
          {
            conversation_id: 'c-alice-ended',
            conversation_name: `${ALICE_TAVUS_CONVERSATION_PREFIX}already-ended`,
            status: 'ended',
          },
          {
            conversation_id: 'c-other-app',
            conversation_name: 'some-other-app-call',
            status: 'active',
          },
          {
            conversation_id: 'c-alice-current',
            conversation_name: `${ALICE_TAVUS_CONVERSATION_PREFIX}current`,
            status: 'active',
          },
        ],
      });
    }
    if (init?.method === 'POST' && url.endsWith('/c-alice-1/end')) {
      endedIds.push('c-alice-1');
      return jsonResponse({ ok: true }, 200);
    }
    if (init?.method === 'POST' && url.endsWith('/c-alice-2/end')) {
      endedIds.push('c-alice-2');
      return jsonResponse({ error: 'server busy' }, 500);
    }
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  });

  const res1 = await endStaleTavusConversations({
    roomName: 'room-clean',
    apiKey: 'secret-key-clean',
    excludeConversationId: 'c-alice-current',
    fetchImpl: mixedFetch,
    log,
  });

  assert.deepEqual(endedIds.sort(), ['c-alice-1', 'c-alice-2']);
  assert.deepEqual(res1, { ended: 1, failed: 1 });
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    room: 'room-clean',
    ev: 'tavus',
    data: { stage: 'stale_ended', count: 1, failed: 1 },
  });

  // 2) List endpoint returns HTTP 500 -> never throws, returns gracefully
  const errStatusFetch = makeFakeFetch(async () => jsonResponse({ error: 'boom' }, 500));
  const res2 = await endStaleTavusConversations({
    roomName: 'room-http-err',
    apiKey: 'secret-key-clean',
    fetchImpl: errStatusFetch,
    log,
  });
  assert.deepEqual(res2, { ended: 0, failed: 1 });

  // 3) Network exception -> never throws, redacts key if echoed
  const throwFetch = makeFakeFetch(async () => {
    throw new TypeError('fetch failed for secret-key-clean');
  });
  const res3 = await endStaleTavusConversations({
    roomName: 'room-net-err',
    apiKey: 'secret-key-clean',
    fetchImpl: throwFetch,
    log,
  });
  assert.deepEqual(res3, { ended: 0, failed: 1 });
  assert.equal(JSON.stringify(logs).includes('secret-key-clean'), false);

  // 4) endTavusConversation also tolerates network errors without throwing
  const endOk = await endTavusConversation({
    apiKey: 'secret-key-clean',
    conversationId: 'c-xyz',
    fetchImpl: throwFetch,
  });
  assert.equal(endOk, false);
});

test('sanitizeTavusReason never leaks API key and keeps reason short', () => {
  const key = 'tv_key_1234567890';
  const msg = sanitizeTavusReason(new Error(`failed with header ${key}\n${'x'.repeat(300)}`), key);
  assert.equal(msg.includes(key), false);
  assert.match(msg, /\[REDACTED\]/);
  assert.ok(msg.length <= 200);
});

test('createDefaultTavusAvatarSession integrates with @livekit/agents-plugin-tavus and injects Alice conversation_name prefix', async () => {
  initializeLogger({ pretty: false, level: 'silent' });
  const postedPayloads: Array<Record<string, unknown>> = [];
  const origFetch = globalThis.fetch;
  const savedEnv = {
    TAVUS_FACE_ID: process.env.TAVUS_FACE_ID,
    TAVUS_PAL_ID: process.env.TAVUS_PAL_ID,
    TAVUS_PERSONA_ID: process.env.TAVUS_PERSONA_ID,
    TAVUS_REPLICA_ID: process.env.TAVUS_REPLICA_ID,
  };
  delete process.env.TAVUS_FACE_ID;
  delete process.env.TAVUS_PAL_ID;
  delete process.env.TAVUS_PERSONA_ID;
  delete process.env.TAVUS_REPLICA_ID;

  globalThis.fetch = makeFakeFetch(async (_url, init) => {
    postedPayloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return jsonResponse({ conversation_id: 'conv-real-plugin-1' });
  });

  try {
    let captured = '';
    const avatar = createDefaultTavusAvatarSession({
      apiKey: 'fake-api-key',
      faceId: 'r-face-real',
      apiUrl: 'https://tavus.example.test/v2',
      conversationName: buildTavusConversationName('demo-room-1'),
      timeoutMs: 8000,
      isTimedOut: () => false,
      onConversationId: (id) => {
        captured = id;
      },
      onLateConversationId: () => {},
    });

    assert.equal(avatar.avatarIdentity, 'tavus-avatar-agent');
    const api = (
      avatar as unknown as {
        api: { createConversation: (opts?: Record<string, unknown>) => Promise<string> };
      }
    ).api;
    const convId = await api.createConversation({
      faceId: 'r-face-real',
      properties: { livekit_ws_url: 'wss://lk.example', livekit_room_token: 'jwt' },
    });

    assert.equal(convId, 'conv-real-plugin-1');
    assert.equal(captured, 'conv-real-plugin-1');
    assert.equal(postedPayloads.length, 1);
    assert.equal(postedPayloads[0]!.face_id, 'r-face-real');
    assert.equal(postedPayloads[0]!.conversation_name, 'alice-stylist-demo-room-1');
    // Without personaId, plugin supplies its default echo-mode LiveKit PAL id
    assert.equal(typeof postedPayloads[0]!.pal_id, 'string');
    assert.ok(String(postedPayloads[0]!.pal_id).length > 0);
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
