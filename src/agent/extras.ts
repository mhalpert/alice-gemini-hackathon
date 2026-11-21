import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';

export type TryOnExtraKind = 'scene' | 'video';
export type RevealBeatKind = 'studio' | 'scene' | 'video';
export type ExtraAssetStatus = 'pending' | 'ready' | 'failed' | 'absent';

export const DEFAULT_STUDIO_HOLD_MS = 5_000;
export const DEFAULT_SCENE_HOLD_MS = 6_000;
export const DEFAULT_EXTRA_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_SIZES_FALLBACK_MS = 3_000;

export type RevealSequencerLogFn = (
  room: string,
  ev: string,
  data?: Record<string, unknown>,
) => void;

export interface StartRevealSequenceParams {
  outfit: number;
  version?: number;
  setting: string;
  scene: ExtraAssetStatus;
  video: ExtraAssetStatus;
  sizesAlreadyPrompted?: boolean;
  getSizesInstruction: () => string;
}

export interface RevealSequencerOptions {
  room: string;
  sendReveal: (payload: { outfit: number; kind: TryOnExtraKind }) => Promise<unknown> | unknown;
  generateReply: (opts: { instructions: string }) => unknown;
  studioHoldMs?: number;
  sceneHoldMs?: number;
  extraWaitTimeoutMs?: number;
  sizesFallbackMs?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  log?: RevealSequencerLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface RevealSequencer {
  startStudio(params: StartRevealSequenceParams): void;
  onExtraReady(
    outfit: number,
    kind: TryOnExtraKind,
    opts?: { version?: number; setting?: string },
  ): void;
  onExtraFailed(
    outfit: number,
    kind: TryOnExtraKind,
    opts?: { version?: number },
  ): void;
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  onShopperSpoke(): void;
  onAssistantMessage(): void;
  onToolStart(callId: string, toolName?: string): void;
  onToolEnd(callId: string): void;
  cancel(outfit?: number): void;
  dispose(): void;
  readonly isActive: boolean;
}

interface ActiveSequence {
  outfit: number;
  version?: number;
  setting: string;
  scene: ExtraAssetStatus;
  video: ExtraAssetStatus;
  sceneRevealed: boolean;
  videoRevealed: boolean;
  lastBeatKind: RevealBeatKind;
  lastBeatAt: number;
  beatSpeechStarted: boolean;
  beatSpeechDone: boolean;
  sizesReadySince: number | null;
  sizesSent: boolean;
  shopperSpoke: boolean;
  getSizesInstruction: () => string;
}

const TRAILING_STOPWORDS = new Set([
  'in',
  'at',
  'of',
  'on',
  'for',
  'with',
  'to',
  'by',
  'and',
  'or',
  'the',
  'a',
  'an',
]);

/**
 * Condenses a setting description to three or four clean words suitable for a
 * brief spoken reaction.
 */
export function shortenSettingPhrase(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[.!?,;:]+$/, '');
  if (!cleaned) return '';

  const words = cleaned.split(' ').filter(Boolean);
  const clipped = words.slice(0, 4);
  while (
    clipped.length > 2 &&
    TRAILING_STOPWORDS.has(clipped[clipped.length - 1]!.toLowerCase())
  ) {
    clipped.pop();
  }
  return clipped.join(' ').replace(/[,;:]+$/, '');
}

/**
 * Builds the one-line spoken instruction for Beat 2 (on-location scene still).
 */
export function buildSceneRevealInstruction(setting: string): string {
  const shortSetting = shortenSettingPhrase(setting);
  const settingPart = shortSetting
    ? `naming the setting ("${shortSetting}") in a few words (like "and this is you at the ${shortSetting}")`
    : 'naming the event setting in a few words from the occasion';
  return `The on-location shot of them in this look just came up on screen. Give ONE short line in your voice as Alice saying this is them at the event, ${settingPart}. Do not invent any visual details and do not ask a question.`;
}

/**
 * Builds the one-line spoken instruction for Beat 3 (short motion video).
 */
export function buildVideoRevealInstruction(setting?: string): string {
  const shortSetting = shortenSettingPhrase(setting);
  const eventPart = shortSetting ? ` at the ${shortSetting}` : ' at the event';
  return `The short video of them in this look just came up on screen. Give ONE short line in your voice as Alice saying this is them in motion${eventPart}. Do not invent any visual details and do not ask a question.`;
}

/**
 * Orchestrates the three-beat try-on reveal (studio -> scene -> video) plus the
 * single end-of-sequence sizes/bag prompt:
 * - Holds studio at least 5 s and waits for Alice to finish her studio line
 *   before bringing up the scene still.
 * - Holds scene at least 6 s and waits for Alice to finish her scene line
 *   before bringing up the video.
 * - Waits up to 20 s after the previous beat for a pending render, then skips
 *   it silently; failed or missing renders are never mentioned.
 * - If the shopper speaks during the sequence, keeps sending page reveals on
 *   schedule but skips all remaining spoken lines.
 * - Logs `reveal_beat { outfit, kind, spoken, waited_ms }`.
 */
export function createRevealSequencer(options: RevealSequencerOptions): RevealSequencer {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const studioHoldMs = Math.max(0, options.studioHoldMs ?? DEFAULT_STUDIO_HOLD_MS);
  const sceneHoldMs = Math.max(0, options.sceneHoldMs ?? DEFAULT_SCENE_HOLD_MS);
  const extraWaitTimeoutMs = Math.max(
    0,
    options.extraWaitTimeoutMs ?? DEFAULT_EXTRA_WAIT_TIMEOUT_MS,
  );
  const sizesFallbackMs = Math.max(0, options.sizesFallbackMs ?? DEFAULT_SIZES_FALLBACK_MS);
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let timer: TimerHandle | null = null;
  let active: ActiveSequence | null = null;
  let syntheticToolCounter = 0;

  const activeTools = new Set<string>();

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function armTimer(delayMs: number): void {
    cancelTimer();
    if (disposed || !active) return;
    const ms = Math.max(0, Math.ceil(delayMs));
    timer = setTimeoutFn(() => {
      timer = null;
      evaluate();
    }, ms);
    timer.unref?.();
  }

  function isSpeechBlocked(): boolean {
    return agentState === 'speaking' || userState === 'speaking' || activeTools.size > 0;
  }

  function nextTargetBeat(seq: ActiveSequence): TryOnExtraKind | 'sizes' | null {
    if (!seq.sceneRevealed && (seq.scene === 'ready' || seq.scene === 'pending')) {
      return 'scene';
    }
    if (!seq.videoRevealed && (seq.video === 'ready' || seq.video === 'pending')) {
      return 'video';
    }
    if (!seq.sizesSent && !seq.shopperSpoke) {
      return 'sizes';
    }
    return null;
  }

  function evaluate(): void {
    cancelTimer();
    if (disposed || !active) return;

    while (active && !disposed) {
      const seq = active;
      const target = nextTargetBeat(seq);

      if (target === null) {
        active = null;
        return;
      }

      const now = nowFn();

      if (target === 'scene' || target === 'video') {
        const elapsed = now - seq.lastBeatAt;
        const minHoldMs = seq.lastBeatKind === 'scene' ? sceneHoldMs : studioHoldMs;
        const status = target === 'scene' ? seq.scene : seq.video;

        if (status === 'pending') {
          if (elapsed >= extraWaitTimeoutMs) {
            if (target === 'scene') {
              seq.scene = 'failed';
            } else {
              seq.video = 'failed';
            }
            continue;
          }
          armTimer(extraWaitTimeoutMs - elapsed);
          return;
        }

        // Asset is ready: always respect minimum on-screen hold for the previous beat.
        if (elapsed < minHoldMs) {
          armTimer(minHoldMs - elapsed);
          return;
        }

        // Wait until Alice finishes her current beat line (unless shopper already spoke and speech is skipped).
        if (!seq.shopperSpoke && isSpeechBlocked()) {
          return;
        }

        const waitedMs = Math.max(0, Math.round(elapsed));
        if (target === 'scene') {
          seq.sceneRevealed = true;
        } else {
          seq.videoRevealed = true;
        }
        seq.lastBeatKind = target;
        seq.lastBeatAt = now;
        seq.sizesReadySince = null;

        try {
          void Promise.resolve(options.sendReveal({ outfit: seq.outfit, kind: target })).catch(
            () => {},
          );
        } catch {
          // Ignore synchronous send errors so sequencing does not stall.
        }

        let spoken = false;
        if (!seq.shopperSpoke) {
          const instructions =
            target === 'scene'
              ? buildSceneRevealInstruction(seq.setting)
              : buildVideoRevealInstruction(seq.setting);
          try {
            options.generateReply({ instructions });
            spoken = true;
          } catch (err) {
            logFn(options.room, 'session_error', {
              source: 'reveal_beat',
              outfit: seq.outfit,
              kind: target,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }

        seq.beatSpeechStarted = false;
        seq.beatSpeechDone = !spoken;

        logFn(options.room, 'reveal_beat', {
          outfit: seq.outfit,
          kind: target,
          spoken,
          waited_ms: waitedMs,
        });

        continue;
      }

      // target === 'sizes'
      if (isSpeechBlocked()) {
        return;
      }

      if (seq.beatSpeechDone) {
        seq.sizesSent = true;
        active = null;
        try {
          const instructions = seq.getSizesInstruction();
          if (instructions && instructions.trim().length > 0) {
            options.generateReply({ instructions });
          }
        } catch (err) {
          logFn(options.room, 'session_error', {
            source: 'reveal_sizes',
            outfit: seq.outfit,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
        return;
      }

      // Waiting for Alice to start and finish the last beat's spoken line; fall back if silent.
      if (seq.sizesReadySince === null) {
        seq.sizesReadySince = now;
      }
      const waitElapsed = now - seq.sizesReadySince;
      if (waitElapsed >= sizesFallbackMs) {
        seq.beatSpeechDone = true;
        continue;
      }

      armTimer(sizesFallbackMs - waitElapsed);
      return;
    }
  }

  return {
    get isActive(): boolean {
      return active !== null;
    },

    startStudio(params: StartRevealSequenceParams): void {
      if (disposed) return;
      cancelTimer();

      const now = nowFn();
      const sizesAlreadyPrompted = Boolean(params.sizesAlreadyPrompted);

      active = {
        outfit: params.outfit,
        version: params.version,
        setting: params.setting,
        scene: params.scene,
        video: params.video,
        sceneRevealed: false,
        videoRevealed: false,
        lastBeatKind: 'studio',
        lastBeatAt: now,
        beatSpeechStarted: false,
        beatSpeechDone: false,
        sizesReadySince: null,
        sizesSent: sizesAlreadyPrompted,
        shopperSpoke: false,
        getSizesInstruction: params.getSizesInstruction,
      };

      logFn(options.room, 'reveal_beat', {
        outfit: params.outfit,
        kind: 'studio',
        spoken: true,
        waited_ms: 0,
      });

      evaluate();
    },

    onExtraReady(
      outfit: number,
      kind: TryOnExtraKind,
      opts?: { version?: number; setting?: string },
    ): void {
      if (disposed || !active) return;
      if (active.outfit !== outfit) return;
      if (
        active.version !== undefined &&
        opts?.version !== undefined &&
        active.version !== opts.version
      ) {
        return;
      }

      if (opts?.setting && opts.setting.trim().length > 0) {
        active.setting = opts.setting.trim();
      }

      if (kind === 'scene' && !active.sceneRevealed) {
        active.scene = 'ready';
      } else if (kind === 'video' && !active.videoRevealed) {
        active.video = 'ready';
      }

      evaluate();
    },

    onExtraFailed(
      outfit: number,
      kind: TryOnExtraKind,
      opts?: { version?: number },
    ): void {
      if (disposed || !active) return;
      if (active.outfit !== outfit) return;
      if (
        active.version !== undefined &&
        opts?.version !== undefined &&
        active.version !== opts.version
      ) {
        return;
      }

      if (kind === 'scene' && !active.sceneRevealed) {
        active.scene = 'failed';
      } else if (kind === 'video' && !active.videoRevealed) {
        active.video = 'failed';
      }

      evaluate();
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (!active) return;

      if (nextState === 'speaking') {
        active.beatSpeechStarted = true;
        active.sizesReadySince = null;
        return;
      }

      if (prevState === 'speaking' && active.beatSpeechStarted) {
        active.beatSpeechDone = true;
      }

      evaluate();
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;

      if (!active) return;

      if (nextState === 'speaking') {
        active.shopperSpoke = true;
      }

      evaluate();
    },

    onShopperSpoke(): void {
      if (disposed || !active) return;
      active.shopperSpoke = true;
      evaluate();
    },

    onAssistantMessage(): void {
      if (disposed || !active) return;
      if (active.beatSpeechStarted && agentState !== 'speaking') {
        active.beatSpeechDone = true;
        evaluate();
      }
    },

    onToolStart(callId: string, toolName?: string): void {
      if (disposed) return;
      const key = callId || `__tool_${++syntheticToolCounter}`;
      activeTools.add(key);
      if (active && toolName === 'add_to_bag') {
        active.shopperSpoke = true;
      }
    },

    onToolEnd(callId: string): void {
      if (disposed) return;
      if (callId) {
        activeTools.delete(callId);
      } else {
        activeTools.clear();
      }
      if (active) {
        evaluate();
      }
    },

    cancel(outfit?: number): void {
      if (!active) return;
      if (outfit !== undefined && active.outfit !== outfit) return;
      cancelTimer();
      active = null;
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      active = null;
      activeTools.clear();
    },
  };
}
