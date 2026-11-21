import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';

export const DEFAULT_SILENCE_FIRST_MS = 9_000;
export const DEFAULT_SILENCE_SECOND_MS = 12_000;
export const DEFAULT_SILENCE_COOLDOWN_MS = 30_000;
export const MAX_SILENCE_CHECKINS = 2;
export const MAX_SILENCE_CHECKINS_PER_CALL = 4;

export type SilenceLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export const FIRST_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'The shopper went quiet for a few seconds. Check in once with one short, punchy New York line—joke that you did not catch that and tell them to hit you with it a little louder. Keep it quick and playful.',
  'The shopper went quiet for a few seconds. Check in once with one short, sassy line—say it sounds wild in there and they can speak up or drop it in the chat. Keep it tight.',
  'The shopper went quiet for a few seconds. Check in once with one short, high-energy line—ask if you lost them and tell them to say it again or toss it in the chat.',
];

export const SECOND_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'Still no reply from the shopper. Give one last short, playful line in different words—say it must be loud on their end and remind them they can type in the chat whenever they are ready. Zero pressure, keep it quick.',
  'Still no reply from the shopper. Give one last short, breezy line in different words—tell them you are hanging right here whenever they want to jump back in, voice or chat.',
  'Still no reply from the shopper. Give one last short, witty line in different words—say take your time and holler or drop it in chat when ready.',
];

const GOODBYE_RE =
  /\b(?:goodbye|good bye|bye(?:-bye)?|see ya|see you(?: soon| later| next time)?|talk (?:to you )?soon|take care|catch you later|have a (?:great|good|lovely|wonderful|amazing) (?:night|evening|day|weekend|one)|enjoy (?:your|the) (?:night|evening|party|event|wedding|trip))\b/i;

/**
 * Returns true when an assistant utterance is a closing farewell rather than
 * an active question or prompt waiting on the shopper.
 */
export function isGoodbyeMessage(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (endsWithQuestionMark(clean)) return false;
  return GOODBYE_RE.test(clean);
}

/**
 * Returns true when Alice's finished utterance ends with a question mark
 * (ignoring trailing whitespace or closing quotes/brackets).
 */
export function endsWithQuestionMark(text: string): boolean {
  const clean = text.trim().replace(/["'”’)\]]+$/g, '').trim();
  return clean.endsWith('?');
}

export interface SilenceCheckInOptions {
  room: string;
  generateReply: (opts: { instructions: string }) => unknown;
  firstDelayMs?: number;
  secondDelayMs?: number;
  cycleCooldownMs?: number;
  maxCheckIns?: number;
  maxCheckInsPerCall?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  isSuppressed?: () => boolean;
  log?: SilenceLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface SilenceCheckIn {
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  onAssistantMessage(text?: string, opts?: { interrupted?: boolean }): void;
  onShopperActivity(): void;
  onToolStart(callId: string): void;
  onToolEnd(callId: string): void;
  onExternalReply(): void;
  dispose(): void;
  readonly checkInCount: number;
  readonly totalCheckInCount: number;
  readonly isArmed: boolean;
}

/**
 * Notices when the shopper has gone quiet after Alice finishes asking a question:
 * - Only arms when Alice's last finished line ended with a question mark.
 * - First check-in after ~9s, second ~12s later in different words, then quiet
 *   until the shopper speaks again.
 * - Enforces at least ~30s between the end of one check-in cycle and the start
 *   of another, and at most 4 check-ins across the entire call.
 * - Never fires while a tool is running, while the shopper or Alice is speaking,
 *   while a try-on extra announcement, filler bit, or result nudge is pending,
 *   or right after a goodbye.
 */
export function createSilenceCheckIn(options: SilenceCheckInOptions): SilenceCheckIn {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const firstDelayMs = Math.max(0, options.firstDelayMs ?? DEFAULT_SILENCE_FIRST_MS);
  const secondDelayMs = Math.max(0, options.secondDelayMs ?? DEFAULT_SILENCE_SECOND_MS);
  const cycleCooldownMs = Math.max(0, options.cycleCooldownMs ?? DEFAULT_SILENCE_COOLDOWN_MS);
  const maxCheckIns = Math.max(0, options.maxCheckIns ?? MAX_SILENCE_CHECKINS);
  const maxCheckInsPerCall = Math.max(
    0,
    options.maxCheckInsPerCall ?? MAX_SILENCE_CHECKINS_PER_CALL,
  );
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let timer: TimerHandle | null = null;
  let awaitingShopper = false;
  let suppressedAfterGoodbye = false;
  let pendingExternalReply = false;
  let turnEndedWithQuestion: boolean | null = null;
  let waitingForTranscriptAfterSpeech = false;
  let activeCheckInSpeech = false;
  let checkInCount = 0;
  let totalCheckInCount = 0;
  let lastCycleEndedAt: number | null = null;
  let firstWordingIdx = 0;
  let secondWordingIdx = 0;
  let armedAt = 0;
  let syntheticToolCounter = 0;

  const activeTools = new Set<string>();

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function isBlocked(): boolean {
    if (disposed) return true;
    if (!awaitingShopper) return true;
    if (suppressedAfterGoodbye) return true;
    if (pendingExternalReply) return true;
    if (checkInCount >= maxCheckIns) return true;
    if (totalCheckInCount >= maxCheckInsPerCall) return true;
    if (activeTools.size > 0) return true;
    if (agentState === 'speaking' || agentState === 'thinking') return true;
    if (userState === 'speaking') return true;
    if (options.isSuppressed?.()) return true;
    return false;
  }

  function pickInstruction(nextCount: number): string {
    if (nextCount === 1) {
      const text = FIRST_CHECKIN_INSTRUCTIONS[firstWordingIdx % FIRST_CHECKIN_INSTRUCTIONS.length]!;
      firstWordingIdx += 1;
      return text;
    }
    const text = SECOND_CHECKIN_INSTRUCTIONS[secondWordingIdx % SECOND_CHECKIN_INSTRUCTIONS.length]!;
    secondWordingIdx += 1;
    return text;
  }

  function computeNextDelayMs(now: number): number {
    if (checkInCount > 0) {
      return secondDelayMs;
    }
    let delay = firstDelayMs;
    if (lastCycleEndedAt !== null) {
      const remainingCooldown = lastCycleEndedAt + cycleCooldownMs - now;
      if (remainingCooldown > delay) {
        delay = remainingCooldown;
      }
    }
    return delay;
  }

  function scheduleIfReady(): void {
    cancelTimer();
    if (isBlocked()) return;

    const now = nowFn();
    const delayMs = computeNextDelayMs(now);
    armedAt = now;

    timer = setTimeoutFn(() => {
      timer = null;
      if (isBlocked()) return;

      const fireNow = nowFn();
      if (checkInCount === 0 && lastCycleEndedAt !== null) {
        const remaining = lastCycleEndedAt + cycleCooldownMs - fireNow;
        if (remaining > 0) {
          scheduleIfReady();
          return;
        }
      }

      checkInCount += 1;
      totalCheckInCount += 1;
      activeCheckInSpeech = true;
      lastCycleEndedAt = fireNow;

      const count = checkInCount;
      const totalCount = totalCheckInCount;
      const waitMs = Math.max(0, Math.round(fireNow - armedAt));
      const instructions = pickInstruction(count);

      logFn(options.room, 'silence_checkin', {
        count,
        total_count: totalCount,
        wait_ms: waitMs,
      });

      try {
        options.generateReply({ instructions });
      } catch (err) {
        logFn(options.room, 'session_error', {
          source: 'silence_checkin',
          count,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      // If more check-ins remain in this cycle and in the whole call, and Alice hasn't already
      // switched to speaking synchronously, arm the next stage (cleanly reset once she speaks).
      if (checkInCount < maxCheckIns && totalCheckInCount < maxCheckInsPerCall && !isBlocked()) {
        scheduleIfReady();
      }
    }, delayMs);
    timer.unref?.();
  }

  function resetOnShopper(): void {
    cancelTimer();
    if (activeCheckInSpeech) {
      lastCycleEndedAt = nowFn();
      activeCheckInSpeech = false;
    }
    checkInCount = 0;
    suppressedAfterGoodbye = false;
    pendingExternalReply = false;
    waitingForTranscriptAfterSpeech = false;
    turnEndedWithQuestion = null;
  }

  return {
    get checkInCount(): number {
      return checkInCount;
    },

    get totalCheckInCount(): number {
      return totalCheckInCount;
    },

    get isArmed(): boolean {
      return timer !== null;
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (nextState === 'speaking') {
        cancelTimer();
        pendingExternalReply = false;
        if (!activeCheckInSpeech && checkInCount === 0) {
          turnEndedWithQuestion = null;
          waitingForTranscriptAfterSpeech = false;
          awaitingShopper = false;
        }
        return;
      }

      if (nextState === 'thinking') {
        cancelTimer();
        return;
      }

      if (prevState === 'speaking' && (nextState === 'listening' || nextState === 'idle')) {
        if (activeCheckInSpeech) {
          activeCheckInSpeech = false;
          lastCycleEndedAt = nowFn();
          if (
            !suppressedAfterGoodbye &&
            checkInCount < maxCheckIns &&
            totalCheckInCount < maxCheckInsPerCall
          ) {
            scheduleIfReady();
          }
          return;
        }

        if (checkInCount > 0) {
          if (
            !suppressedAfterGoodbye &&
            checkInCount < maxCheckIns &&
            totalCheckInCount < maxCheckInsPerCall
          ) {
            scheduleIfReady();
          }
          return;
        }

        if (suppressedAfterGoodbye || pendingExternalReply || options.isSuppressed?.()) {
          awaitingShopper = false;
          waitingForTranscriptAfterSpeech = false;
          cancelTimer();
          return;
        }

        if (turnEndedWithQuestion === true) {
          awaitingShopper = true;
          waitingForTranscriptAfterSpeech = false;
          scheduleIfReady();
        } else if (turnEndedWithQuestion === false) {
          awaitingShopper = false;
          waitingForTranscriptAfterSpeech = false;
          cancelTimer();
        } else {
          // Transcript has not arrived yet; wait for onAssistantMessage before arming.
          awaitingShopper = false;
          waitingForTranscriptAfterSpeech = true;
          cancelTimer();
        }
        return;
      }

      if ((nextState === 'listening' || nextState === 'idle') && awaitingShopper && timer === null) {
        scheduleIfReady();
      }
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;

      if (nextState === 'speaking') {
        resetOnShopper();
        awaitingShopper = false;
        return;
      }

      if (awaitingShopper && timer === null) {
        scheduleIfReady();
      }
    },

    onAssistantMessage(text?: string, opts?: { interrupted?: boolean }): void {
      if (disposed || typeof text !== 'string') return;
      pendingExternalReply = false;

      if (isGoodbyeMessage(text)) {
        suppressedAfterGoodbye = true;
        awaitingShopper = false;
        waitingForTranscriptAfterSpeech = false;
        turnEndedWithQuestion = false;
        cancelTimer();
        return;
      }

      // Transcript of a check-in utterance itself must not cancel the second check-in.
      if (activeCheckInSpeech || checkInCount > 0) {
        return;
      }

      if (opts?.interrupted) {
        turnEndedWithQuestion = false;
        awaitingShopper = false;
        waitingForTranscriptAfterSpeech = false;
        cancelTimer();
        return;
      }

      const isQuestion = endsWithQuestionMark(text);
      turnEndedWithQuestion = isQuestion;

      if (waitingForTranscriptAfterSpeech) {
        waitingForTranscriptAfterSpeech = false;
        if (
          isQuestion &&
          !suppressedAfterGoodbye &&
          !options.isSuppressed?.() &&
          (agentState === 'listening' || agentState === 'idle')
        ) {
          awaitingShopper = true;
          scheduleIfReady();
        } else {
          awaitingShopper = false;
          cancelTimer();
        }
      } else if (!isQuestion) {
        awaitingShopper = false;
        cancelTimer();
      }
    },

    onShopperActivity(): void {
      if (disposed) return;
      resetOnShopper();
      awaitingShopper = false;
    },

    onToolStart(callId: string): void {
      if (disposed) return;
      const key = callId || `__tool_${++syntheticToolCounter}`;
      activeTools.add(key);
      pendingExternalReply = false;
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      turnEndedWithQuestion = null;
      cancelTimer();
    },

    onToolEnd(callId: string): void {
      if (disposed) return;
      if (callId) {
        activeTools.delete(callId);
      } else {
        activeTools.clear();
      }
      // Do not arm immediately on tool end; wait until Alice speaks the result and finishes a question.
    },

    onExternalReply(): void {
      if (disposed) return;
      pendingExternalReply = true;
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      turnEndedWithQuestion = null;
      cancelTimer();
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      activeTools.clear();
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      pendingExternalReply = false;
      activeCheckInSpeech = false;
    },
  };
}
