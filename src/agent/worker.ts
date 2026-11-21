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
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  type TrackPublication,
} from '@livekit/rtc-node';
import { calllog, installCrashLogging, startCallLog } from '../calllog.ts';
import { loadConfig } from './config.ts';
import {
  AppContextSender,
  type CameraStatusValue,
  hasActiveCameraTrack,
  isCameraTrackPublication,
  normalizeCameraAttr,
  readInitialCameraStatus,
  sendRealtimeContext,
} from './context.ts';
import { applyRealtimeSessionPatches, sendInterimToolNote } from './patches.ts';
import { createPageSender } from './page.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from './prompt.ts';
import { createCallStateStore } from './state.ts';
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

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const config = loadConfig();
    const roomName = ctx.room.name || ctx.job.room?.name || 'unknown';

    startCallLog(roomName);
    const uninstallCrashLogging = installCrashLogging(roomName);
    await bindStoreCallRoom(roomName);

    if (config.avatar !== 'none') {
      console.warn(`[alice] AVATAR="${config.avatar}" is not supported yet; running with avatar=none.`);
    }

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
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH' as never,
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH' as never,
          silenceDurationMs: 500,
        },
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

    const tools = createAgentTools({
      room: roomName,
      page,
      state: callState,
      signal: toolAbort.signal,
      sendWorkingNote: (params) => sendInterimToolNote(activeRealtimeSession, params),
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

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      appContext.setAgentState(ev.newState);
      calllog(roomName, 'agent_state', { old: ev.oldState, state: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      calllog(roomName, 'user_state', { old: ev.oldState, state: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal && ev.transcript) {
        calllog(roomName, 'user_said', { text: ev.transcript, item_id: ev.itemId });
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        const text = ev.item.textContent ?? '';
        calllog(roomName, 'alice_said', { text, interrupted: ev.item.interrupted });
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
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

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      calllog(roomName, 'session_close', {
        reason: ev.reason,
        ...(ev.error ? { error: ev.error } : {}),
      });
      toolAbort.abort();
      void vision?.close().catch(() => {});
      appContext.dispose();
    });

    let cleanupCameraWatcher: (() => void) | undefined;
    ctx.addShutdownCallback(async () => {
      toolAbort.abort();
      cleanupCameraWatcher?.();
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

    await session.start({
      agent,
      room: ctx.room,
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

    calllog(roomName, 'session_started', {
      face: false,
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
