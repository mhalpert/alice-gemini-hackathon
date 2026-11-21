import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';

export type TryOnExtraKind = 'scene' | 'video';

export const DEFAULT_EXTRA_ANNOUNCE_MAX_WAIT_MS = 10_000;
export const DEFAULT_EXTRA_ANNOUNCE_RETRY_MS = 500;

export type ExtraAnnounceLogFn = (
  room: string,
  ev: string,
  data?: Record<string, unknown>,
) => void;

export interface ExtraAnnounceEvent {
  outfit: number;
  kind: TryOnExtraKind;
  setting: string;
}

export interface ExtraAnnouncerOptions {
  room: string;
  generateReply: (opts: { instructions: string }) => unknown;
  maxWaitMs?: number;
  retryIntervalMs?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  log?: ExtraAnnounceLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface ExtraAnnouncer {
  announce(ev: ExtraAnnounceEvent): void;
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  onToolStart(callId: string): void;
  onToolEnd(callId: string): void;
  dispose(): void;
  readonly hasPending: boolean;
}

interface PendingExtraAnnounce extends ExtraAnnounceEvent {
  deadline: number;
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
 * Builds the one-line spoken instruction for Alice when a late-landing scene
 * still or short video arrives after the studio reveal already happened.
 */
export function buildExtraAnnounceInstruction(kind: TryOnExtraKind, setting: string): string {
  const label = kind === 'video' ? 'short video' : 'on-location shot';
  const shortSetting = shortenSettingPhrase(setting);
  const settingPart = shortSetting
    ? `naming the setting ("${shortSetting}") in three or four words`
    : 'naming the setting in three or four words';
  return `Give one short line in your voice as Alice saying the ${label} of them just landed on screen, ${settingPart}. Do not describe any details you cannot know and do not ask a question.`;
}

/**
 * Delivers a one-line spoken reaction when a scene still or short video lands
 * after the studio reveal, only when neither Alice nor the shopper is speaking
 * and no tool is running. Waits and retries for up to 10 s, then skips speech
 * while leaving the reveal on screen.
 */
export function createExtraAnnouncer(options: ExtraAnnouncerOptions): ExtraAnnouncer {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? DEFAULT_EXTRA_ANNOUNCE_MAX_WAIT_MS);
  const retryIntervalMs = Math.max(
    1,
    options.retryIntervalMs ?? DEFAULT_EXTRA_ANNOUNCE_RETRY_MS,
  );
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let timer: TimerHandle | null = null;
  let syntheticToolCounter = 0;

  const activeTools = new Set<string>();
  const queue: PendingExtraAnnounce[] = [];

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function isBusy(): boolean {
    return agentState === 'speaking' || userState === 'speaking' || activeTools.size > 0;
  }

  function speakItem(item: ExtraAnnounceEvent): void {
    const instructions = buildExtraAnnounceInstruction(item.kind, item.setting);
    try {
      options.generateReply({ instructions });
      logFn(options.room, 'extra_announce', {
        outfit: item.outfit,
        kind: item.kind,
        spoken: true,
      });
    } catch (err) {
      logFn(options.room, 'session_error', {
        source: 'extra_announce',
        outfit: item.outfit,
        kind: item.kind,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      logFn(options.room, 'extra_announce', {
        outfit: item.outfit,
        kind: item.kind,
        spoken: false,
      });
    }
  }

  function scheduleNextTick(): void {
    cancelTimer();
    if (disposed || queue.length === 0) return;

    const remaining = Math.max(0, queue[0]!.deadline - nowFn());
    const delay = Math.min(retryIntervalMs, remaining);
    timer = setTimeoutFn(() => {
      timer = null;
      processQueue();
    }, delay);
    timer.unref?.();
  }

  function processQueue(): void {
    cancelTimer();
    if (disposed || queue.length === 0) return;

    const now = nowFn();
    while (queue.length > 0 && now >= queue[0]!.deadline) {
      const expired = queue.shift()!;
      logFn(options.room, 'extra_announce', {
        outfit: expired.outfit,
        kind: expired.kind,
        spoken: false,
      });
    }

    if (queue.length === 0) return;

    if (!isBusy()) {
      const item = queue.shift()!;
      speakItem(item);
      if (queue.length > 0) {
        scheduleNextTick();
      }
      return;
    }

    scheduleNextTick();
  }

  return {
    get hasPending(): boolean {
      return queue.length > 0;
    },

    announce(ev: ExtraAnnounceEvent): void {
      if (disposed) return;

      if (!isBusy() && queue.length === 0) {
        speakItem(ev);
        return;
      }

      queue.push({
        outfit: ev.outfit,
        kind: ev.kind,
        setting: ev.setting,
        deadline: nowFn() + maxWaitMs,
      });
      scheduleNextTick();
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      agentState = nextState;
      if (queue.length > 0 && !isBusy()) {
        processQueue();
      }
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;
      if (queue.length > 0 && !isBusy()) {
        processQueue();
      }
    },

    onToolStart(callId: string): void {
      if (disposed) return;
      const key = callId || `__tool_${++syntheticToolCounter}`;
      activeTools.add(key);
    },

    onToolEnd(callId: string): void {
      if (disposed) return;
      if (callId) {
        activeTools.delete(callId);
      } else {
        activeTools.clear();
      }
      if (queue.length > 0 && !isBusy()) {
        processQueue();
      }
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      queue.length = 0;
      activeTools.clear();
    },
  };
}
