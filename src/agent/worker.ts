import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import {
  type NoiseCancellationOptions,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  type TrackPublication,
} from '@livekit/rtc-node';
import { calllog, installCrashLogging, startCallLog } from '../calllog.ts';
import {
  buildAutomaticActivityDetection,
  loadConfig,
  type NoiseCancelMode,
  resolveTavusConfig,
} from './config.ts';
import {
  AppContextSender,
  type CameraStatusValue,
  hasActiveCameraTrack,
  isCameraTrackPublication,
  normalizeCameraAttr,
  readInitialCameraStatus,
  sendRealtimeContext,
} from './context.ts';
import { createBitPicker } from './bits.ts';
import { createToolFiller } from './filler.ts';
import { applyRealtimeSessionPatches, sendInterimToolNote } from './patches.ts';
import { createToolResultNudger } from './nudge.ts';
import { createPageSender } from './page.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from './prompt.ts';
import { createSilenceCheckIn } from './silence.ts';
import { createCallStateStore } from './state.ts';
import {
  endStaleTavusConversations,
  startTavusAvatar,
  type TavusAvatarHandle,
} from './tavus.ts';
import { createAgentTools } from './tools.ts';
import { createVisionController } from './vision.ts';

const { Behavior, FunctionResponseScheduling } = google.realtime;

export function attachCameraStatusWatcher(params: {
  roomName: string;
  room: JobContext['room'];
  shopper: RemoteParticipant;
  appContext: AppContextSender;
  onStatusChange?: (status: CameraStatusValue, source: string) => void;
  log?: (room: string, ev: string, data?: Record<string, unknown>) => void;
}): { initialStatus: CameraStatusValue; cleanup: () => void } {
  const { roomName, room, shopper, appContext, onStatusChange } = params;
  const logFn = params.log ?? calllog;
  let lastStatus: CameraStatusValue | null = null;

  const emitIfChanged = (next: CameraStatusValue, source: string) => {
    if (next === lastStatus) return;
    lastStatus = next;
    logFn(roomName, 'camera', { status: next, source });
    appContext.sendCameraStatus(next);
    onStatusChange?.(next, source);
  };

  const onAttributesChanged = (
    changedAttributes: Record<string, string>,
    participant: Participant,
  ) => {
    if (participant.identity !== shopper.identity) return;
    if (!('camera' in changedAttributes)) return;
    const next = normalizeCameraAttr(changedAttributes.camera) ?? 'off';
    emitIfChanged(next, 'attribute');
  };

  const onTrackSubscribed = (
    _track: RemoteTrack,
    pub: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (participant.identity !== shopper.identity) return;
    if (!isCameraTrackPublication(pub)) return;
    emitIfChanged(pub.muted ? 'off' : 'on', 'track_subscribed');
  };

  const onTrackMuted = (pub: TrackPublication, participant: Participant) => {
    if (participant.identity !== shopper.identity) return;
    if (!isCameraTrackPublication(pub)) return;
    emitIfChanged('off', 'track_muted');
  };

  const onTrackUnmuted = (pub: TrackPublication, participant: Participant) => {
    if (participant.identity !== shopper.identity) return;
    if (!isCameraTrackPublication(pub)) return;
    emitIfChanged('on', 'track_unmuted');
  };

  const onTrackUnpublished = (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (participant.identity !== shopper.identity) return;
    if (!isCameraTrackPublication(pub)) return;
    const next: CameraStatusValue = hasActiveCameraTrack(shopper) ? 'on' : 'off';
    emitIfChanged(next, 'track_unpublished');
  };

  const onTrackUnsubscribed = (
    _track: RemoteTrack,
    pub: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (participant.identity !== shopper.identity) return;
    if (!isCameraTrackPublication(pub)) return;
    const next: CameraStatusValue = hasActiveCameraTrack(shopper) ? 'on' : 'off';
    emitIfChanged(next, 'track_unsubscribed');
  };

  room.on(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.TrackMuted, onTrackMuted);
  room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
  room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
  room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);

  const initialStatus = readInitialCameraStatus(shopper);
  emitIfChanged(initialStatus, 'initial');

  return {
    initialStatus,
    cleanup: () => {
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    },
  };
}

export interface StoreRoomModuleLike {
  setCallRoom?: (room: string | null) => void;
}

export async function bindStoreCallRoom(
  roomName: string,
  opts?: {
    loadStoreModule?: () => Promise<StoreRoomModuleLike | null>;
    log?: (room: string, ev: string, data?: Record<string, unknown>) => void;
  },
): Promise<boolean> {
  const logFn = opts?.log ?? calllog;
  const loadStore =
    opts?.loadStoreModule ??
    (async () => {
      const modPath = '../store/index.ts';
      return (await import(modPath)) as StoreRoomModuleLike;
    });

  try {
    const storeMod = await loadStore();
    if (typeof storeMod?.setCallRoom === 'function') {
      storeMod.setCallRoom(roomName);
      return true;
    }
    logFn(roomName, 'session_error', {
      source: 'store_room',
      error: new Error('store module does not export setCallRoom'),
    });
    return false;
  } catch (err) {
    logFn(roomName, 'session_error', {
      source: 'store_room',
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

export interface MediaWarmModuleLike {
  warmMedia?: () => Promise<void>;
  setCallRoom?: (room: string | null) => void;
}

export async function warmCallMedia(
  roomName: string,
  opts?: {
    loadMediaModule?: () => Promise<MediaWarmModuleLike | null>;
    log?: (room: string, ev: string, data?: Record<string, unknown>) => void;
  },
): Promise<boolean> {
  const logFn = opts?.log ?? calllog;
  const loadMedia =
    opts?.loadMediaModule ??
    (async () => {
      const modPath = '../media/index.ts';
      return (await import(modPath)) as MediaWarmModuleLike;
    });

  try {
    const mediaMod = await loadMedia();
    if (typeof mediaMod?.warmMedia === 'function') {
      await mediaMod.warmMedia();
      return true;
    }
    logFn(roomName, 'session_error', {
      source: 'media_warm',
      error: new Error('media module does not export warmMedia'),
    });
    return false;
  } catch (err) {
    logFn(roomName, 'session_error', {
      source: 'media_warm',
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

export interface NoiseCancelModuleLike {
  BackgroundVoiceCancellation?: () => NoiseCancellationOptions;
  NoiseCancellation?: () => NoiseCancellationOptions;
}

export interface NoiseCancelResolution {
  mode: NoiseCancelMode;
  requested: NoiseCancelMode;
  noiseCancellation?: NoiseCancellationOptions;
}

export async function resolveNoiseCancellation(
  roomName: string,
  requestedMode: NoiseCancelMode,
  opts?: {
    loadModule?: () => Promise<NoiseCancelModuleLike | null>;
    log?: (room: string, ev: string, data?: Record<string, unknown>) => void;
  },
): Promise<NoiseCancelResolution> {
  if (requestedMode === 'off') {
    return { mode: 'off', requested: 'off' };
  }

  const logFn = opts?.log ?? calllog;
  const loadModule =
    opts?.loadModule ??
    (async () => {
      const modName = '@livekit/noise-cancellation-node';
      return (await import(modName)) as NoiseCancelModuleLike;
    });

  try {
    const mod = await loadModule();
    const factoryName =
      requestedMode === 'bvc' ? 'BackgroundVoiceCancellation' : 'NoiseCancellation';
    const factory = mod?.[factoryName];
    if (typeof factory !== 'function') {
      throw new Error(`noise cancellation module does not export ${factoryName}`);
    }
    const noiseCancellation = factory();
    if (!noiseCancellation || typeof noiseCancellation !== 'object') {
      throw new Error(`${factoryName}() returned an invalid noise cancellation config`);
    }
    return {
      mode: requestedMode,
      requested: requestedMode,
      noiseCancellation,
    };
  } catch (err) {
    logFn(roomName, 'session_error', {
      source: 'noise_cancel',
      mode: requestedMode,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { mode: 'off', requested: requestedMode };
  }
}

export interface StartableSessionLike {
  start: (opts: {
    agent: voice.Agent;
    room: JobContext['room'];
    inputOptions?: { noiseCancellation?: NoiseCancellationOptions };
    outputOptions?: { audioEnabled?: boolean };
  }) => Promise<void>;
}

export async function startSessionWithNoiseCancel(params: {
  roomName: string;
  session: StartableSessionLike;
  agent: voice.Agent;
  room: JobContext['room'];
  requestedMode: NoiseCancelMode;
  outputOptions?: { audioEnabled?: boolean };
  loadModule?: () => Promise<NoiseCancelModuleLike | null>;
  log?: (room: string, ev: string, data?: Record<string, unknown>) => void;
}): Promise<{ mode: NoiseCancelMode; requested: NoiseCancelMode }> {
  const { roomName, session, agent, room, requestedMode, outputOptions } = params;
  const logFn = params.log ?? calllog;
  const resolved = await resolveNoiseCancellation(roomName, requestedMode, {
    loadModule: params.loadModule,
    log: logFn,
  });

  const baseOutput = outputOptions ? { outputOptions } : {};

  let activeMode: NoiseCancelMode = resolved.mode;
  if (resolved.noiseCancellation) {
    try {
      await session.start({
        agent,
        room,
        inputOptions: {
          noiseCancellation: resolved.noiseCancellation,
        },
        ...baseOutput,
      });
    } catch (err) {
      logFn(roomName, 'session_error', {
        source: 'noise_cancel',
        mode: resolved.mode,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      activeMode = 'off';
      await session.start({
        agent,
        room,
        ...baseOutput,
      });
    }
  } else {
    await session.start({
      agent,
      room,
      ...baseOutput,
    });
  }

  logFn(roomName, 'noise_cancel', {
    mode: activeMode,
    ...(activeMode !== requestedMode ? { requested: requestedMode, fallback: true } : {}),
  });

  return { mode: activeMode, requested: requestedMode };
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const config = loadConfig();
    const roomName = ctx.room.name || ctx.job.room?.name || 'unknown';

    startCallLog(roomName);
    const uninstallCrashLogging = installCrashLogging(roomName);
    await bindStoreCallRoom(roomName);
    void warmCallMedia(roomName).catch((err) => {
      calllog(roomName, 'session_error', {
        source: 'media_warm',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });

    const tavusConfig = resolveTavusConfig(config);
    const staleTavusCleanup = tavusConfig.enabled
      ? endStaleTavusConversations({
          roomName,
          apiKey: tavusConfig.apiKey!,
          log: calllog,
        })
      : null;

    const onParticipantDisconnected = (participant: RemoteParticipant) => {
      calllog(roomName, 'participant_left', { identity: participant.identity });
    };
    const onRoomDisconnected = (reason: unknown) => {
      calllog(roomName, 'room_disconnected', { reason });
    };
    ctx.room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    ctx.room.on(RoomEvent.Disconnected, onRoomDisconnected);

    let activeRealtimeSession: unknown = undefined;

    const modelOptions: ConstructorParameters<typeof google.realtime.RealtimeModel>[0] = {
      apiKey: config.googleApiKey,
      model: config.modelLive,
      voice: config.geminiVoice,
      language: config.language,
      modalities: ['AUDIO' as never],
      outputAudioTranscription: {},
      inputAudioTranscription: {
        languageCodes: ['en-US'],
      },
      realtimeInputConfig: {
        automaticActivityDetection: buildAutomaticActivityDetection(config.vad) as never,
      },
      toolBehavior: Behavior.NON_BLOCKING,
      toolResponseScheduling: FunctionResponseScheduling.WHEN_IDLE,
    };

    const model = new google.realtime.RealtimeModel(modelOptions);

    // Patch every RealtimeSession as soon as the model creates it (before WebSocket traffic begins).
    const origCreateSession = model.session.bind(model);
    model.session = (sessionOpts) => {
      const rtSession = origCreateSession(sessionOpts);
      activeRealtimeSession = rtSession;
      applyRealtimeSessionPatches(rtSession, { room: roomName });
      return rtSession;
    };

    const appContext = new AppContextSender({
      send: (text) => {
        if (activeRealtimeSession) {
          sendRealtimeContext(activeRealtimeSession, text);
        }
      },
    });

    let shopperIdentity: string | null = null;
    const toolAbort = new AbortController();

    const page = createPageSender({
      room: ctx.room,
      roomName,
      shopperIdentity: () => shopperIdentity,
      log: calllog,
    });

    const callState = createCallStateStore({
      roomName,
      appContext,
      log: calllog,
    });

    const vision = config.vision
      ? createVisionController({
          roomName,
          intervalMs: config.visionFrameMs,
          getRealtimeSession: () => activeRealtimeSession,
        })
      : null;

    let sessionRef: voice.AgentSession | null = null;
    const bitPicker = createBitPicker({
      getUsedIds: () => callState.get().usedBitIds,
      markUsed: (bitId) => callState.dispatch({ type: 'record_bit_used', bitId }),
    });

    const resultNudger = createToolResultNudger({
      room: roomName,
      generateReply: (opts) => sessionRef?.generateReply(opts),
      log: calllog,
    });

    const toolFiller = createToolFiller({
      room: roomName,
      bitPicker,
      generateReply: (opts) => sessionRef?.generateReply(opts),
      sendWorkingNote: (params) => sendInterimToolNote(activeRealtimeSession, params),
      log: calllog,
    });

    const silenceCheckIn = createSilenceCheckIn({
      room: roomName,
      generateReply: (opts) => sessionRef?.generateReply(opts),
      isSuppressed: () => resultNudger.hasPending || toolFiller.isRunning,
      log: calllog,
    });

    const tools = createAgentTools({
      room: roomName,
      page,
      state: callState,
      bitPicker,
      signal: toolAbort.signal,
      sendWorkingNote: (params) => sendInterimToolNote(activeRealtimeSession, params),
      onToolStart: (ev) => silenceCheckIn.onToolStart(ev.callId),
      onToolEnd: (ev) => silenceCheckIn.onToolEnd(ev.callId),
      onSlowToolStart: (ev) => toolFiller.onToolStart(ev),
      onSlowToolEnd: (ev) => toolFiller.onToolEnd(ev.callId),
      onToolResult: (ev) => resultNudger.onToolResult(ev),
      getSnapshot: () => vision?.latest() ?? null,
    });

    const agent = new voice.Agent({
      instructions: ALICE_SYSTEM_PROMPT,
      tools,
    });

    const session = new voice.AgentSession({
      llm: model,
      vad: null,
      turnHandling: {
        turnDetection: 'realtime_llm',
      },
    });
    sessionRef = session;

    const loggedUserItemIds = new Set<string>();

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      appContext.setAgentState(ev.newState);
      resultNudger.onAgentStateChanged(ev.newState);
      toolFiller.onAgentStateChanged(ev.newState);
      silenceCheckIn.onAgentStateChanged(ev.newState);
      calllog(roomName, 'agent_state', { old: ev.oldState, state: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      resultNudger.onUserStateChanged(ev.newState);
      toolFiller.onUserStateChanged(ev.newState);
      silenceCheckIn.onUserStateChanged(ev.newState);
      calllog(roomName, 'user_state', { old: ev.oldState, state: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal && ev.transcript) {
        callState.recordShopperTurn(ev.transcript, ev.itemId);
        silenceCheckIn.onShopperActivity();
        if (ev.itemId) {
          loggedUserItemIds.add(ev.itemId);
        }
        calllog(roomName, 'user_said', { text: ev.transcript, item_id: ev.itemId });
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        const text = ev.item.textContent ?? '';
        resultNudger.onAssistantMessage(text);
        silenceCheckIn.onAssistantMessage(text);
        calllog(roomName, 'alice_said', { text, interrupted: ev.item.interrupted });
      } else if (ev.item.type === 'message' && ev.item.role === 'user') {
        const text = ev.item.textContent ?? '';
        if (text.trim().length > 0) {
          callState.recordShopperTurn(text, ev.item.id);
          silenceCheckIn.onShopperActivity();
          if (!ev.item.id || !loggedUserItemIds.has(ev.item.id)) {
            if (ev.item.id) {
              loggedUserItemIds.add(ev.item.id);
            }
            calllog(roomName, 'user_said', { text, item_id: ev.item.id, source: 'text' });
          }
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      resultNudger.onSpeechCreated?.();
      calllog(roomName, 'speech_created', {
        source: ev.source,
        user_initiated: ev.userInitiated,
      });
    });

    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
      calllog(roomName, 'false_interruption', { resumed: ev.resumed });
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      calllog(roomName, 'metrics', { metrics: ev.metrics });
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const inner = ev.error as { error?: unknown; type?: string; recoverable?: boolean } | undefined;
      calllog(roomName, 'session_error', {
        error: inner?.error ?? ev.error,
        type: inner?.type,
        recoverable: inner?.recoverable,
        source: ev.source?.constructor?.name,
      });
    });

    let sessionStarted = false;
    let activeTavusAvatar: TavusAvatarHandle | null = null;
    let cleanupTavusWatcher: (() => void) | undefined;

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      if (!sessionStarted) {
        return;
      }
      calllog(roomName, 'session_close', {
        reason: ev.reason,
        ...(ev.error ? { error: ev.error } : {}),
      });
      toolAbort.abort();
      resultNudger.dispose();
      toolFiller.dispose();
      silenceCheckIn.dispose();
      cleanupTavusWatcher?.();
      void activeTavusAvatar?.shutdown().catch(() => {});
      void vision?.close().catch(() => {});
      appContext.dispose();
    });

    let cleanupCameraWatcher: (() => void) | undefined;
    ctx.addShutdownCallback(async () => {
      toolAbort.abort();
      resultNudger.dispose();
      toolFiller.dispose();
      silenceCheckIn.dispose();
      cleanupCameraWatcher?.();
      cleanupTavusWatcher?.();
      await activeTavusAvatar?.shutdown();
      await vision?.close();
      appContext.dispose();
      ctx.room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      ctx.room.off(RoomEvent.Disconnected, onRoomDisconnected);
      uninstallCrashLogging();
    });

    await ctx.connect();

    const shopper = await ctx.waitForParticipant();
    shopperIdentity = shopper.identity;
    if (
      typeof shopper.name === 'string' &&
      shopper.name.trim().length > 0 &&
      !/^shopper$/i.test(shopper.name.trim()) &&
      shopper.name.trim() !== shopper.identity
    ) {
      callState.dispatch({ type: 'set_shopper_name', name: shopper.name.trim() });
    }
    calllog(roomName, 'shopper_joined', {
      identity: shopper.identity,
      attributes: shopper.attributes,
    });

    const tavusAvatar = await startTavusAvatar({
      roomName,
      config,
      session,
      room: ctx.room,
      staleCleanupPromise: staleTavusCleanup,
      log: calllog,
    });
    activeTavusAvatar = tavusAvatar;

    await startSessionWithNoiseCancel({
      roomName,
      session,
      agent,
      room: ctx.room,
      requestedMode: config.noiseCancel,
      outputOptions: tavusAvatar.roomOutputOptions,
    });
    sessionStarted = true;

    cleanupTavusWatcher = tavusAvatar.attachDisconnectFallback({
      room: ctx.room,
      session,
    });

    // Fallback check in case session creation bypassed model.session.
    const liveRtSession =
      activeRealtimeSession ??
      (session as unknown as { _activity?: { realtimeLLMSession?: unknown } })._activity
        ?.realtimeLLMSession;
    if (liveRtSession && liveRtSession !== activeRealtimeSession) {
      activeRealtimeSession = liveRtSession;
      applyRealtimeSessionPatches(liveRtSession, { room: roomName });
    } else if (!liveRtSession) {
      applyRealtimeSessionPatches(undefined, { room: roomName });
    }

    calllog(roomName, 'vad_config', {
      room: config.vad.room,
      start: config.vad.startOfSpeechSensitivity,
      end: config.vad.endOfSpeechSensitivity,
      silence_ms: config.vad.silenceDurationMs,
      ...(config.vad.prefixPaddingMs !== undefined
        ? { prefix_ms: config.vad.prefixPaddingMs }
        : {}),
    });

    calllog(roomName, 'session_started', {
      face: tavusAvatar.startedWithFace,
      ...(tavusAvatar.startedWithFace ? { avatar_identity: tavusAvatar.avatarIdentity } : {}),
      vision: config.vision,
      model: config.modelLive,
      voice: config.geminiVoice,
    });

    const watcher = attachCameraStatusWatcher({
      roomName,
      room: ctx.room,
      shopper,
      appContext,
      onStatusChange: (status) => {
        vision?.setCameraStatus(status);
        callState.dispatch({ type: 'set_camera', camera: status });
      },
    });
    cleanupCameraWatcher = watcher.cleanup;
    vision?.attach(ctx.room, shopper);

    callState.pushSummary();
    appContext.flushNow();

    session.generateReply({
      instructions: GREETING_INSTRUCTIONS,
    });
  },
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: config.agentName,
    }),
  );
}
