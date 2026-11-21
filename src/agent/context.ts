import { TrackKind, TrackSource } from '@livekit/rtc-node';
import type { RemoteParticipant, TrackPublication } from '@livekit/rtc-node';
import type { voice } from '@livekit/agents';
import type { PatchableRealtimeSession } from './patches.ts';

export type AgentStateValue = voice.AgentState;
export type CameraStatusValue = 'on' | 'off';

export interface TimerHandle {
  unref?: () => unknown;
}

export interface AppContextSenderOptions {
  send: (text: string) => void;
  flushDelayMs?: number;
  initialState?: AgentStateValue;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Injects a text turn into Gemini Live with `turnComplete: false` so it provides
 * app state without ending the user's turn or triggering an unwanted reply.
 */
export function sendRealtimeContext(rtSession: unknown, text: string): boolean {
  if (!rtSession || typeof rtSession !== 'object') return false;
  const target = rtSession as PatchableRealtimeSession;
  const content = {
    turns: [{ role: 'user', parts: [{ text }] }],
    turnComplete: false,
  };

  try {
    if (typeof target.sendClientEvent === 'function') {
      target.sendClientEvent({
        type: 'content',
        value: content,
      });
      return true;
    }
    if (typeof target.activeSession?.sendClientContent === 'function') {
      void Promise.resolve(target.activeSession.sendClientContent(content)).catch(() => {});
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isHeldState(state: AgentStateValue): boolean {
  return state === 'speaking' || state === 'thinking';
}

export class AppContextSender {
  private readonly sendFn: (text: string) => void;
  private readonly flushDelayMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  private state: AgentStateValue;
  private pending: Map<string, string> = new Map();
  private flushTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: AppContextSenderOptions) {
    this.sendFn = options.send;
    this.flushDelayMs = options.flushDelayMs ?? 300;
    this.state = options.initialState ?? 'initializing';
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get agentState(): AgentStateValue {
    return this.state;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  setAgentState(nextState: AgentStateValue): void {
    if (this.disposed) return;
    this.state = nextState;

    if (isHeldState(nextState)) {
      this.cancelFlushTimer();
      return;
    }

    if (nextState === 'listening' && this.pending.size > 0 && this.flushTimer === null) {
      this.scheduleFlush();
    }
  }

  send(kind: string, text: string): void {
    if (this.disposed) return;

    if (isHeldState(this.state) || this.flushTimer !== null) {
      this.pending.set(kind, text);
      return;
    }

    this.sendFn(text);
  }

  sendCallState(summary: string): void {
    this.send('call_state', `CALL STATE: ${summary}`);
  }

  sendCameraStatus(status: CameraStatusValue): void {
    this.send('camera_status', `CAMERA STATUS: ${status}`);
  }

  flushNow(): void {
    if (this.disposed) return;
    this.cancelFlushTimer();
    if (this.pending.size === 0) return;

    const batch = Array.from(this.pending.values());
    this.pending.clear();
    for (const msg of batch) {
      this.sendFn(msg);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFlushTimer();
    this.pending.clear();
  }

  private scheduleFlush(): void {
    this.cancelFlushTimer();
    this.flushTimer = this.setTimeoutFn(() => {
      this.flushTimer = null;
      if (this.disposed || isHeldState(this.state)) {
        return;
      }
      this.flushNow();
    }, this.flushDelayMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export function isCameraTrackPublication(pub: Pick<TrackPublication, 'kind' | 'source'>): boolean {
  if (pub.source === TrackSource.SOURCE_CAMERA) return true;
  if (pub.kind === TrackKind.KIND_VIDEO && pub.source !== TrackSource.SOURCE_SCREENSHARE) {
    return true;
  }
  return false;
}

export function normalizeCameraAttr(value: string | undefined): CameraStatusValue | undefined {
  if (value === undefined) return undefined;
  const norm = value.trim().toLowerCase();
  if (norm === 'on' || norm === 'true' || norm === '1') return 'on';
  if (norm === 'off' || norm === 'false' || norm === '0') return 'off';
  return undefined;
}

export function hasActiveCameraTrack(
  participant: Pick<RemoteParticipant, 'trackPublications'>,
): boolean {
  for (const pub of participant.trackPublications.values()) {
    if (!isCameraTrackPublication(pub)) continue;
    if (pub.muted === true) continue;
    if (pub.subscribed || pub.track !== undefined) {
      return true;
    }
  }
  return false;
}

export function readInitialCameraStatus(
  participant: Pick<RemoteParticipant, 'attributes' | 'trackPublications'>,
): CameraStatusValue {
  const fromAttr = normalizeCameraAttr(participant.attributes?.camera);
  if (fromAttr !== undefined) return fromAttr;
  return hasActiveCameraTrack(participant) ? 'on' : 'off';
}
