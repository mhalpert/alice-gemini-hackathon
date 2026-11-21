import { voice } from '@livekit/agents';
import * as tavus from '@livekit/agents-plugin-tavus';
import {
  type RemoteParticipant,
  type Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { calllog } from '../calllog.ts';
import { type AgentConfig, resolveTavusConfig } from './config.ts';
import { installPlayoutWatchdog } from './playout.ts';

export const DEFAULT_TAVUS_API_URL = tavus.DEFAULT_API_URL || 'https://tavusapi.com/v2';
export const ALICE_TAVUS_CONVERSATION_PREFIX = 'alice-stylist-';
export const DEFAULT_TAVUS_START_TIMEOUT_MS = 8_000;
export const DEFAULT_TAVUS_CLEANUP_TIMEOUT_MS = 3_000;
export const DEFAULT_TAVUS_END_TIMEOUT_MS = 3_000;
export const DEFAULT_TAVUS_AVATAR_IDENTITY = 'tavus-avatar-agent';

const DEFAULT_FALLBACK_SAMPLE_RATE = 24_000;
const DEFAULT_FALLBACK_NUM_CHANNELS = 1;
const DEFAULT_FALLBACK_QUEUE_SIZE_MS = 200;

export type TavusLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface TavusConversationSummary {
  conversation_id?: unknown;
  conversation_name?: unknown;
  status?: unknown;
}

export interface AvatarSessionLike {
  readonly avatarIdentity: string;
  conversationId?: string | null;
  start(agentSession: unknown, room: unknown, options?: Record<string, unknown>): Promise<void>;
  waitForJoin?(opts?: { timeout?: number | null }): Promise<void>;
  aclose?(): Promise<void>;
}

export interface SessionAudioOutputLike {
  output: {
    audio: ({ clearBuffer?: () => void } & Record<string, unknown>) | null;
  };
}

export interface DisconnectRoomLike {
  on(event: RoomEvent, listener: (participant: { identity: string }) => void): unknown;
  off(event: RoomEvent, listener: (participant: { identity: string }) => void): unknown;
}

export interface FallbackAudioOutputLike {
  start(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  clearBuffer?: () => void;
}

export interface TavusAvatarHandle {
  active: boolean;
  readonly startedWithFace: boolean;
  readonly avatarIdentity: string;
  readonly conversationId: string | null;
  readonly roomOutputOptions: { audioEnabled: boolean };
  attachDisconnectFallback(params: {
    room: DisconnectRoomLike;
    session: SessionAudioOutputLike;
    createFallbackAudioOutput?: (room: DisconnectRoomLike) => FallbackAudioOutputLike;
  }): () => void;
  shutdown(): Promise<void>;
}

export interface CreateAvatarSessionParams {
  apiKey: string;
  faceId: string;
  personaId?: string;
  apiUrl: string;
  conversationName: string;
  timeoutMs: number;
  isTimedOut: () => boolean;
  onConversationId: (id: string) => void;
  onLateConversationId: (id: string) => void;
}

export function sanitizeTavusReason(err: unknown, apiKey?: string): string {
  let raw: string;
  if (err && typeof err === 'object') {
    const obj = err as { statusCode?: unknown; message?: unknown; name?: unknown };
    const status = typeof obj.statusCode === 'number' ? `HTTP ${obj.statusCode}` : '';
    const msg = typeof obj.message === 'string' && obj.message.trim() ? obj.message.trim() : '';
    if (status && msg && !msg.includes(String(obj.statusCode))) {
      raw = `${status}: ${msg}`;
    } else if (status) {
      raw = status;
    } else if (msg) {
      raw = msg;
    } else {
      raw = String(err);
    }
  } else {
    raw = String(err ?? 'unknown error');
  }

  let cleaned = raw.replace(/\s+/g, ' ').trim();
  if (apiKey && apiKey.length > 0) {
    cleaned = cleaned.split(apiKey).join('[REDACTED]');
  }
  if (cleaned.length > 200) {
    cleaned = `${cleaned.slice(0, 197)}...`;
  }
  return cleaned || 'unknown error';
}

export function buildTavusConversationName(
  roomName: string,
  prefix: string = ALICE_TAVUS_CONVERSATION_PREFIX,
): string {
  const cleanedRoom = String(roomName || 'call')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${prefix}${cleanedRoom || 'call'}`;
}

function normalizeApiUrl(apiUrl?: string): string {
  const base = (apiUrl || DEFAULT_TAVUS_API_URL).trim();
  return base.replace(/\/+$/, '');
}

function extractConversationList(body: unknown): TavusConversationSummary[] {
  if (Array.isArray(body)) {
    return body as TavusConversationSummary[];
  }
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: TavusConversationSummary[] }).data;
  }
  return [];
}

export async function endTavusConversation(params: {
  apiKey: string;
  conversationId: string;
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { apiKey, conversationId } = params;
  if (!apiKey || !conversationId) return false;

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TAVUS_END_TIMEOUT_MS;
  const url = `${normalizeApiUrl(params.apiUrl)}/conversations/${encodeURIComponent(conversationId)}/end`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function endStaleTavusConversations(params: {
  roomName: string;
  apiKey: string;
  apiUrl?: string;
  prefix?: string;
  excludeConversationId?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: TavusLogFn;
  now?: () => number;
}): Promise<{ ended: number; failed: number }> {
  const { roomName, apiKey } = params;
  const logFn = params.log ?? calllog;
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const prefix = params.prefix ?? ALICE_TAVUS_CONVERSATION_PREFIX;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TAVUS_CLEANUP_TIMEOUT_MS;
  const nowFn = params.now ?? Date.now;
  const baseUrl = normalizeApiUrl(params.apiUrl);

  if (!apiKey) {
    return { ended: 0, failed: 0 };
  }

  const deadline = nowFn() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    let res = await fetchFn(`${baseUrl}/conversations?status=active`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    });

    if (!res.ok && (res.status === 400 || res.status === 422) && !controller.signal.aborted) {
      res = await fetchFn(`${baseUrl}/conversations`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
        },
        signal: controller.signal,
      });
    }

    if (!res.ok) {
      logFn(roomName, 'tavus', {
        stage: 'stale_ended',
        count: 0,
        reason: `HTTP ${res.status}`,
      });
      return { ended: 0, failed: 1 };
    }

    const body = await res.json();
    const items = extractConversationList(body);
    const staleIds = items
      .filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const id = typeof item.conversation_id === 'string' ? item.conversation_id.trim() : '';
        const name = typeof item.conversation_name === 'string' ? item.conversation_name : '';
        const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
        if (!id) return false;
        if (params.excludeConversationId && id === params.excludeConversationId) return false;
        return status === 'active' && name.startsWith(prefix);
      })
      .map((item) => String(item.conversation_id).trim());

    if (staleIds.length === 0) {
      return { ended: 0, failed: 0 };
    }

    const results = await Promise.allSettled(
      staleIds.map(async (id) => {
        const remainingMs = Math.max(100, deadline - nowFn());
        if (controller.signal.aborted) return false;
        const endRes = await fetchFn(
          `${baseUrl}/conversations/${encodeURIComponent(id)}/end`,
          {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
            },
            signal: AbortSignal.any
              ? AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)])
              : controller.signal,
          },
        );
        return endRes.ok;
      }),
    );

    let ended = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        ended += 1;
      } else {
        failed += 1;
      }
    }

    logFn(roomName, 'tavus', {
      stage: 'stale_ended',
      count: ended,
      ...(failed > 0 ? { failed } : {}),
    });

    return { ended, failed };
  } catch (err) {
    logFn(roomName, 'tavus', {
      stage: 'stale_ended',
      count: 0,
      reason: sanitizeTavusReason(err, apiKey),
    });
    return { ended: 0, failed: 1 };
  } finally {
    clearTimeout(timer);
  }
}

export function createDefaultTavusAvatarSession(
  params: CreateAvatarSessionParams,
): AvatarSessionLike {
  const avatar = new tavus.AvatarSession({
    apiKey: params.apiKey,
    apiUrl: params.apiUrl,
    faceId: params.faceId,
    ...(params.personaId ? { palId: params.personaId } : {}),
    connOptions: {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: Math.min(params.timeoutMs, 6_000),
    },
  });

  // Tag every Tavus conversation with Alice's prefix so stale cleanup only touches
  // conversations created by this app, and guard against late responses after timeout.
  const apiHolder = avatar as unknown as {
    api?: {
      createConversation?: (opts?: Record<string, unknown>) => Promise<string>;
    };
  };
  if (apiHolder.api && typeof apiHolder.api.createConversation === 'function') {
    const origCreate = apiHolder.api.createConversation.bind(apiHolder.api);
    apiHolder.api.createConversation = async (opts: Record<string, unknown> = {}) => {
      const existingExtra =
        opts.extraPayload && typeof opts.extraPayload === 'object'
          ? (opts.extraPayload as Record<string, unknown>)
          : {};
      const convId = await origCreate({
        ...opts,
        extraPayload: {
          ...existingExtra,
          conversation_name: params.conversationName,
        },
      });
      if (params.isTimedOut()) {
        params.onLateConversationId(convId);
        throw new Error('tavus start timed out');
      }
      params.onConversationId(convId);
      return convId;
    };
  }

  return avatar as unknown as AvatarSessionLike;
}

function createDefaultFallbackAudioOutput(room: DisconnectRoomLike): FallbackAudioOutputLike {
  const audioOut = new voice.ParticipantAudioOutput(room as unknown as Room, {
    sampleRate: DEFAULT_FALLBACK_SAMPLE_RATE,
    numChannels: DEFAULT_FALLBACK_NUM_CHANNELS,
    trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    queueSizeMs: DEFAULT_FALLBACK_QUEUE_SIZE_MS,
  });
  return audioOut as unknown as FallbackAudioOutputLike;
}

function createInactiveHandle(
  avatarIdentity: string = DEFAULT_TAVUS_AVATAR_IDENTITY,
): TavusAvatarHandle {
  return {
    active: false,
    startedWithFace: false,
    avatarIdentity,
    conversationId: null,
    roomOutputOptions: { audioEnabled: true },
    attachDisconnectFallback: () => () => {},
    shutdown: async () => {},
  };
}

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function startTavusAvatar(params: {
  roomName: string;
  config: Pick<AgentConfig, 'avatar' | 'tavusApiKey' | 'tavusFaceId' | 'tavusPersonaId'>;
  session: SessionAudioOutputLike;
  room: unknown;
  staleCleanupPromise?: Promise<{ ended: number; failed: number }> | null;
  startTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  endTimeoutMs?: number;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  createAvatarSession?: (opts: CreateAvatarSessionParams) => AvatarSessionLike;
  log?: TavusLogFn;
  now?: () => number;
  warn?: (msg: string) => void;
}): Promise<TavusAvatarHandle> {
  const { roomName, config, session, room } = params;
  const logFn = params.log ?? calllog;
  const nowFn = params.now ?? Date.now;
  const warnFn = params.warn ?? ((msg: string) => console.warn(msg));
  const startTimeoutMs = params.startTimeoutMs ?? DEFAULT_TAVUS_START_TIMEOUT_MS;
  const cleanupTimeoutMs = params.cleanupTimeoutMs ?? DEFAULT_TAVUS_CLEANUP_TIMEOUT_MS;
  const endTimeoutMs = params.endTimeoutMs ?? DEFAULT_TAVUS_END_TIMEOUT_MS;
  const apiUrl = normalizeApiUrl(params.apiUrl);
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const createAvatar = params.createAvatarSession ?? createDefaultTavusAvatarSession;

  const resolved = resolveTavusConfig(config);
  if (!resolved.requested) {
    return createInactiveHandle();
  }
  if (!resolved.enabled || !resolved.apiKey || !resolved.faceId) {
    const reason = resolved.missingReason ?? 'incomplete tavus configuration';
    warnFn(`[alice] AVATAR=tavus skipped (${reason}); running voice-only.`);
    logFn(roomName, 'tavus', { stage: 'fallback', reason });
    return createInactiveHandle();
  }

  const apiKey = resolved.apiKey;
  const faceId = resolved.faceId;
  const personaId = resolved.personaId;

  // Best-effort stale cleanup before creating a new Tavus conversation.
  if (params.staleCleanupPromise) {
    await params.staleCleanupPromise.catch(() => ({ ended: 0, failed: 1 }));
  } else {
    await endStaleTavusConversations({
      roomName,
      apiKey,
      apiUrl,
      timeoutMs: cleanupTimeoutMs,
      fetchImpl: fetchFn,
      log: logFn,
      now: nowFn,
    });
  }

  const startedAt = nowFn();
  const deadline = startedAt + startTimeoutMs;
  const conversationName = buildTavusConversationName(roomName);
  let timedOut = false;
  let capturedConversationId: string | null = null;
  let endedConversation = false;

  const endConvOnce = async (id: string | null): Promise<boolean> => {
    if (!id || endedConversation) return false;
    endedConversation = true;
    return endTavusConversation({
      apiKey,
      conversationId: id,
      apiUrl,
      timeoutMs: endTimeoutMs,
      fetchImpl: fetchFn,
    });
  };

  logFn(roomName, 'tavus', {
    stage: 'start',
    face_id: faceId,
    has_persona: Boolean(personaId),
  });

  let avatar: AvatarSessionLike;
  try {
    avatar = createAvatar({
      apiKey,
      faceId,
      ...(personaId ? { personaId } : {}),
      apiUrl,
      conversationName,
      timeoutMs: startTimeoutMs,
      isTimedOut: () => timedOut,
      onConversationId: (id) => {
        capturedConversationId = id;
      },
      onLateConversationId: (id) => {
        capturedConversationId = id;
        void endConvOnce(id).catch(() => {});
      },
    });
  } catch (err) {
    const reason = sanitizeTavusReason(err, apiKey);
    const ms = Math.max(0, Math.round(nowFn() - startedAt));
    warnFn(`[alice] Tavus avatar init failed (${reason}); falling back to voice-only.`);
    logFn(roomName, 'tavus', { stage: 'failed', reason, ms });
    logFn(roomName, 'tavus', { stage: 'fallback', reason });
    return createInactiveHandle();
  }

  const avatarIdentity = avatar.avatarIdentity || DEFAULT_TAVUS_AVATAR_IDENTITY;

  const runStart = (async () => {
    await avatar.start(session, room);
    // The framework waits without limit for the avatar to say a line finished playing; when
    // that report is lost Alice goes silent for the rest of the call. See playout.ts.
    try {
      installPlayoutWatchdog((session as { output?: { audio?: unknown } }).output?.audio, {
        log: (fields) => logFn(roomName, 'playout_watchdog', fields),
      });
    } catch {
      // Never let the watchdog stop the face from starting.
    }
    if (timedOut) {
      throw new Error(`tavus start timed out after ${startTimeoutMs}ms`);
    }
    if (typeof avatar.waitForJoin === 'function') {
      const remaining = Math.max(1, deadline - nowFn());
      await avatar.waitForJoin({ timeout: remaining });
    }
  })();

  // Attach a catch handler so late rejection after timeout never triggers unhandledRejection.
  runStart.catch(() => {});

  try {
    await withHardTimeout(
      runStart,
      startTimeoutMs,
      `tavus start timed out after ${startTimeoutMs}ms`,
    );
  } catch (err) {
    timedOut = true;
    // Ensure agent audio output is restored for voice-only RoomIO startup.
    session.output.audio = null;

    const convId = avatar.conversationId ?? capturedConversationId;
    void Promise.resolve(avatar.aclose?.()).catch(() => {});
    if (convId) {
      void endConvOnce(convId).catch(() => {});
    }
    // If start resolved late with a conversationId, end it too.
    void runStart
      .then(() => {
        const lateId = avatar.conversationId ?? capturedConversationId;
        if (lateId) {
          return endConvOnce(lateId);
        }
        return false;
      })
      .catch(() => {});

    const reason = sanitizeTavusReason(err, apiKey);
    const ms = Math.max(0, Math.round(nowFn() - startedAt));
    warnFn(`[alice] Tavus avatar failed (${reason}); falling back to voice-only.`);
    logFn(roomName, 'tavus', { stage: 'failed', reason, ms });
    logFn(roomName, 'tavus', { stage: 'fallback', reason });
    return createInactiveHandle(avatarIdentity);
  }

  const conversationId = avatar.conversationId ?? capturedConversationId ?? null;
  const elapsedMs = Math.max(0, Math.round(nowFn() - startedAt));
  logFn(roomName, 'tavus', {
    stage: 'ready',
    ms: elapsedMs,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  });

  let shuttingDown = false;
  let shutdownDone = false;
  let fallbackTriggered = false;
  let fallbackAudio: FallbackAudioOutputLike | null = null;
  let fallbackAbort: AbortController | null = null;
  let detachDisconnect: (() => void) | null = null;

  const handle: TavusAvatarHandle = {
    active: true,
    startedWithFace: true,
    avatarIdentity,
    conversationId,
    roomOutputOptions: { audioEnabled: false },

    attachDisconnectFallback({
      room: watchRoom,
      session: liveSession,
      createFallbackAudioOutput = createDefaultFallbackAudioOutput,
    }) {
      detachDisconnect?.();

      const onParticipantDisconnected = (participant: RemoteParticipant | { identity: string }) => {
        if (participant.identity !== avatarIdentity) return;
        if (shuttingDown || fallbackTriggered) return;

        fallbackTriggered = true;
        handle.active = false;
        logFn(roomName, 'tavus', { stage: 'fallback', reason: 'avatar_disconnected' });

        const prevAudio = liveSession.output.audio;
        try {
          const nextAudio = createFallbackAudioOutput(watchRoom);
          fallbackAudio = nextAudio;
          fallbackAbort = new AbortController();

          // Swap immediately so subsequent turns route to agent audio; ParticipantAudioOutput
          // awaits its own startedFuture until the published track is subscribed.
          liveSession.output.audio = nextAudio as unknown as SessionAudioOutputLike['output']['audio'];
          try {
            prevAudio?.clearBuffer?.();
          } catch {
            // Best-effort clear of the detached avatar DataStreamAudioOutput.
          }

          void nextAudio.start(fallbackAbort.signal).catch((err) => {
            if (!shuttingDown) {
              logFn(roomName, 'tavus', {
                stage: 'failed',
                reason: sanitizeTavusReason(err, apiKey),
              });
            }
          });
        } catch (err) {
          logFn(roomName, 'tavus', {
            stage: 'failed',
            reason: sanitizeTavusReason(err, apiKey),
          });
        }

        if (conversationId) {
          void endConvOnce(conversationId).catch(() => {});
        }
      };

      watchRoom.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      detachDisconnect = () => {
        watchRoom.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      };
      return () => {
        detachDisconnect?.();
        detachDisconnect = null;
      };
    },

    async shutdown() {
      if (shutdownDone) return;
      shutdownDone = true;
      shuttingDown = true;
      handle.active = false;

      detachDisconnect?.();
      detachDisconnect = null;

      fallbackAbort?.abort();
      fallbackAbort = null;
      if (fallbackAudio) {
        await fallbackAudio.close().catch(() => {});
        fallbackAudio = null;
      }

      if (typeof avatar.aclose === 'function') {
        await withHardTimeout(
          Promise.resolve(avatar.aclose()),
          endTimeoutMs,
          'tavus aclose timed out',
        ).catch(() => {});
      }

      if (conversationId) {
        const ok = await endConvOnce(conversationId);
        logFn(roomName, 'tavus', {
          stage: 'ended',
          conversation_id: conversationId,
          ok,
        });
      }
    },
  };

  return handle;
}
