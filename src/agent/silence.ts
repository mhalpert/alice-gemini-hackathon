import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';
import type { CallState } from './state.ts';

export const DEFAULT_SILENCE_FIRST_MS = 9_000;
export const DEFAULT_SILENCE_SECOND_MS = 12_000;
export const DEFAULT_SILENCE_COOLDOWN_MS = 30_000;
export const DEFAULT_DEAD_AIR_MS = 15_000;
export const MAX_SILENCE_CHECKINS = 2;
export const MAX_SILENCE_CHECKINS_PER_CALL = 4;

export type DeadAirStage = 'looks' | 'picked' | 'revealed' | 'bagged';

export interface DeadAirPrompt {
  stage: DeadAirStage;
  line: string;
}

export type DeadAirCallStateSlice = Pick<CallState, 'looks' | 'pickedLook' | 'revealsDone' | 'bag'>;

export function pickDeadAirLine(
  state: DeadAirCallStateSlice | null | undefined,
): DeadAirPrompt | null {
  if (!state) return null;

  const hasBag =
    state.bag !== null &&
    ((Array.isArray(state.bag.stores) &&
      state.bag.stores.some((s) => Array.isArray(s.added) && s.added.length > 0)) ||
      (typeof state.bag.total === 'number' && state.bag.total > 0));
  if (hasBag) {
    return { stage: 'bagged', line: 'Want anything swapped or taken out?' };
  }

  if (state.pickedLook !== null) {
    if (Array.isArray(state.revealsDone) && state.revealsDone.includes(state.pickedLook)) {
      return { stage: 'revealed', line: "Give me your sizes and I'll bag it." };
    }
    return { stage: 'picked', line: 'Want to see it on you?' };
  }

  if (Array.isArray(state.looks) && state.looks.length > 0) {
    return { stage: 'looks', line: 'Which one are we trying?' };
  }

  return null;
}

export function buildDeadAirInstruction(line: string): string {
  return `The call went quiet. Say this one short next-step line in your voice as Alice, nothing else: "${line}"`;
}

export type SilenceLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export const FIRST_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'The shopper is taking a moment. Check in once with one calm, warm line such as "Take your time. Want me to pick for you?" Keep it relaxed and zero pressure.',
  'The shopper is taking a moment. Check in once with one calm, relaxed line—tell them there is no rush, and they can talk whenever or tap "Type instead" on the page.',
  'The shopper is taking a moment. Check in once with one calm, easygoing line—tell them to take their time and offer to pick a direction for them if they want.',
];

export const SECOND_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'Still quiet from the shopper. Give one last calm, zero-pressure line in different words—say you are right here whenever they are ready, or they can tap "Type instead".',
  'Still quiet from the shopper. Give one last calm, breezy line in different words—say take all the time they need and jump back in by voice or "Type instead" whenever they want.',
  'Still quiet from the shopper. Give one last calm, gentle line in different words—offer to pick a favourite for them or wait until they talk or tap "Type instead" when ready.',
];

export const EXPRESS_FIRST_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'Express mode is on and the shopper is quiet. Give ONE calm sentence (at most 10 words, no jokes): "Take your time. Want me to pick for you?"',
  'Express mode is on and the shopper is quiet. Give ONE calm sentence (at most 10 words, no jokes) letting them know they can talk or tap "Type instead".',
];

export const EXPRESS_SECOND_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'Express mode is on and the shopper is still quiet. Give ONE calm sentence (at most 10 words, no jokes): "I am right here—talk or tap Type instead whenever ready."',
  'Express mode is on and the shopper is still quiet. Give ONE calm sentence (at most 10 words, no jokes): "No rush—say the word or tap Type instead when ready."',
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
  deadAirMs?: number;
  cycleCooldownMs?: number;
  maxCheckIns?: number;
  maxCheckInsPerCall?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  isSuppressed?: () => boolean;
  isExpress?: () => boolean;
  getCallState?: () => DeadAirCallStateSlice | null | undefined;
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
  readonly isDeadAirArmed: boolean;
}

/**
 * Notices when the shopper has gone quiet after Alice finishes asking a question:
 * - Only arms when Alice's last finished line ended with a question mark.
 * - First check-in after ~9s, second ~12s later in different words, then quiet
 *   until the shopper speaks again.
 * - Also runs a separate 15s dead-air guard when neither side has spoken, no tool
 *   is running, and no reveal beat is pending, sending one short next-step line
 *   that fits the flow state and logging `dead_air_nudge`.
 * - Shares a 30s cooldown and per-call maximum (4) across both check-ins and
 *   dead-air nudges.
 * - Never fires while a tool is running, while the shopper or Alice is speaking,
 *   while a try-on extra announcement, filler bit, or result nudge is pending,
 *   or right after a goodbye.
 */
export function createSilenceCheckIn(options: SilenceCheckInOptions): SilenceCheckIn {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const firstDelayMs = Math.max(0, options.firstDelayMs ?? DEFAULT_SILENCE_FIRST_MS);
  const secondDelayMs = Math.max(0, options.secondDelayMs ?? DEFAULT_SILENCE_SECOND_MS);
  const deadAirMs = Math.max(0, options.deadAirMs ?? DEFAULT_DEAD_AIR_MS);
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
  let deadAirTimer: TimerHandle | null = null;
  let awaitingShopper = false;
  let suppressedAfterGoodbye = false;
  let pendingExternalReply = false;
  let turnEndedWithQuestion: boolean | null = null;
  let waitingForTranscriptAfterSpeech = false;
  let activeCheckInSpeech = false;
  let activeDeadAirSpeech = false;
  let deadAirFiredSinceActivity = false;
  let checkInCount = 0;
  let totalCheckInCount = 0;
  let lastCycleEndedAt: number | null = null;
  let firstWordingIdx = 0;
  let secondWordingIdx = 0;
  let armedAt = 0;
  let deadAirArmedAt = 0;
  let syntheticToolCounter = 0;

  const activeTools = new Set<string>();

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function cancelDeadAirTimer(): void {
    if (deadAirTimer !== null) {
      clearTimeoutFn(deadAirTimer);
      deadAirTimer = null;
    }
  }

  function cancelAllTimers(): void {
    cancelTimer();
    cancelDeadAirTimer();
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

  function isDeadAirBlocked(): boolean {
    if (disposed) return true;
    if (!options.getCallState) return true;
    if (awaitingShopper || checkInCount > 0) return true;
    if (deadAirFiredSinceActivity) return true;
    if (suppressedAfterGoodbye) return true;
    if (pendingExternalReply) return true;
    if (totalCheckInCount >= maxCheckInsPerCall) return true;
    if (activeTools.size > 0) return true;
    if (agentState === 'speaking' || agentState === 'thinking') return true;
    if (userState === 'speaking') return true;
    if (options.isSuppressed?.()) return true;
    if (!pickDeadAirLine(options.getCallState())) return true;
    return false;
  }

  function pickInstruction(nextCount: number): string {
    const express = Boolean(options.isExpress?.());
    if (nextCount === 1) {
      const pool = express ? EXPRESS_FIRST_CHECKIN_INSTRUCTIONS : FIRST_CHECKIN_INSTRUCTIONS;
      const text = pool[firstWordingIdx % pool.length]!;
      firstWordingIdx += 1;
      return text;
    }
    const pool = express ? EXPRESS_SECOND_CHECKIN_INSTRUCTIONS : SECOND_CHECKIN_INSTRUCTIONS;
    const text = pool[secondWordingIdx % pool.length]!;
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

  function computeDeadAirDelayMs(now: number): number {
    let delay = deadAirMs;
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

    cancelDeadAirTimer();
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

  function scheduleDeadAirIfReady(): void {
    cancelDeadAirTimer();
    if (isDeadAirBlocked()) return;

    const now = nowFn();
    const delayMs = computeDeadAirDelayMs(now);
    deadAirArmedAt = now;

    deadAirTimer = setTimeoutFn(() => {
      deadAirTimer = null;
      if (isDeadAirBlocked()) return;

      const fireNow = nowFn();
      if (lastCycleEndedAt !== null) {
        const remaining = lastCycleEndedAt + cycleCooldownMs - fireNow;
        if (remaining > 0) {
          scheduleDeadAirIfReady();
          return;
        }
      }

      const prompt = pickDeadAirLine(options.getCallState?.());
      if (!prompt) return;

      totalCheckInCount += 1;
      activeDeadAirSpeech = true;
      deadAirFiredSinceActivity = true;
      lastCycleEndedAt = fireNow;

      const totalCount = totalCheckInCount;
      const waitMs = Math.max(0, Math.round(fireNow - deadAirArmedAt));

      logFn(options.room, 'dead_air_nudge', {
        stage: prompt.stage,
        line: prompt.line,
        total_count: totalCount,
        wait_ms: waitMs,
      });

      try {
        options.generateReply({ instructions: buildDeadAirInstruction(prompt.line) });
      } catch (err) {
        logFn(options.room, 'session_error', {
          source: 'dead_air_nudge',
          stage: prompt.stage,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }, delayMs);
    deadAirTimer.unref?.();
  }

  function resetOnShopper(): void {
    cancelAllTimers();
    if (activeCheckInSpeech || activeDeadAirSpeech) {
      lastCycleEndedAt = nowFn();
      activeCheckInSpeech = false;
      activeDeadAirSpeech = false;
    }
    checkInCount = 0;
    deadAirFiredSinceActivity = false;
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

    get isDeadAirArmed(): boolean {
      return deadAirTimer !== null;
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (nextState === 'speaking') {
        cancelAllTimers();
        pendingExternalReply = false;
        if (!activeCheckInSpeech && !activeDeadAirSpeech && checkInCount === 0) {
          turnEndedWithQuestion = null;
          waitingForTranscriptAfterSpeech = false;
          awaitingShopper = false;
          deadAirFiredSinceActivity = false;
        }
        return;
      }

      if (nextState === 'thinking') {
        cancelAllTimers();
        return;
      }

      if (prevState === 'speaking' && (nextState === 'listening' || nextState === 'idle')) {
        if (activeDeadAirSpeech) {
          activeDeadAirSpeech = false;
          lastCycleEndedAt = nowFn();
          return;
        }

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
          cancelAllTimers();
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
          scheduleDeadAirIfReady();
        } else {
          // Transcript has not arrived yet; wait for onAssistantMessage before arming question check-in,
          // while allowing dead-air guard to arm in case the turn has no question or transcript.
          awaitingShopper = false;
          waitingForTranscriptAfterSpeech = true;
          cancelTimer();
          scheduleDeadAirIfReady();
        }
        return;
      }

      if (nextState === 'listening' || nextState === 'idle') {
        if (awaitingShopper && timer === null) {
          scheduleIfReady();
        } else if (!awaitingShopper && deadAirTimer === null) {
          scheduleDeadAirIfReady();
        }
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
      } else if (!awaitingShopper && deadAirTimer === null) {
        scheduleDeadAirIfReady();
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
        cancelAllTimers();
        return;
      }

      // Transcript of a check-in or dead-air utterance itself must not re-arm another prompt.
      if (activeCheckInSpeech || activeDeadAirSpeech || checkInCount > 0) {
        return;
      }

      if (opts?.interrupted) {
        turnEndedWithQuestion = false;
        awaitingShopper = false;
        waitingForTranscriptAfterSpeech = false;
        cancelTimer();
        if (agentState === 'listening' || agentState === 'idle') {
          scheduleDeadAirIfReady();
        }
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
          if (agentState === 'listening' || agentState === 'idle') {
            scheduleDeadAirIfReady();
          }
        }
      } else if (!isQuestion) {
        awaitingShopper = false;
        cancelTimer();
        if (agentState === 'listening' || agentState === 'idle') {
          scheduleDeadAirIfReady();
        }
      }
    },

    onShopperActivity(): void {
      if (disposed) return;
      resetOnShopper();
      awaitingShopper = false;
      if (userState !== 'speaking' && (agentState === 'listening' || agentState === 'idle')) {
        scheduleDeadAirIfReady();
      }
    },

    onToolStart(callId: string): void {
      if (disposed) return;
      const key = callId || `__tool_${++syntheticToolCounter}`;
      activeTools.add(key);
      pendingExternalReply = false;
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      turnEndedWithQuestion = null;
      cancelAllTimers();
    },

    onToolEnd(callId: string): void {
      if (disposed) return;
      if (callId) {
        activeTools.delete(callId);
      } else {
        activeTools.clear();
      }
      // Do not arm question check-in on tool end; wait until Alice speaks and asks a question.
      // Arm dead-air guard if all tools finished while neither side is speaking.
      if (activeTools.size === 0 && !awaitingShopper) {
        scheduleDeadAirIfReady();
      }
    },

    onExternalReply(): void {
      if (disposed) return;
      pendingExternalReply = true;
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      turnEndedWithQuestion = null;
      cancelAllTimers();
    },

    dispose(): void {
      disposed = true;
      cancelAllTimers();
      activeTools.clear();
      awaitingShopper = false;
      waitingForTranscriptAfterSpeech = false;
      pendingExternalReply = false;
      activeCheckInSpeech = false;
      activeDeadAirSpeech = false;
    },
  };
}
