import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';

export const DEFAULT_SILENCE_FIRST_MS = 7_000;
export const DEFAULT_SILENCE_SECOND_MS = 10_000;
export const MAX_SILENCE_CHECKINS = 2;

export type SilenceLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

const FIRST_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'The shopper has been quiet for several seconds. Check in once with one short, warm line—say you did not quite catch that and ask them to say it again a little louder. Keep it natural and brief.',
  'The shopper has been quiet for several seconds. Check in once with one short, light line—mention it sounds loud in there and they can speak up or type in the chat if that is easier. Keep it brief.',
  'The shopper has been quiet for several seconds. Check in once with one short, friendly line—ask if they are still with you and let them know they can repeat themselves or drop it in chat.',
];

const SECOND_CHECKIN_INSTRUCTIONS: readonly string[] = [
  'Still no reply from the shopper. Try one last short, easygoing line in different words—mention it might be loud where they are and remind them they can also type in the chat whenever they are ready. Keep it brief and zero pressure.',
  'Still no reply from the shopper. Try one last short, warm line in different words—let them know you are right here whenever they want to jump back in, by voice or by typing.',
  'Still no reply from the shopper. Try one last short, light line in different words—say no rush at all and invite them to speak up a bit or type when ready.',
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
  if (clean.endsWith('?')) return false;
  return GOODBYE_RE.test(clean);
}

export interface SilenceCheckInOptions {
  room: string;
  generateReply: (opts: { instructions: string }) => unknown;
  firstDelayMs?: number;
  secondDelayMs?: number;
  maxCheckIns?: number;
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
  onAssistantMessage(text?: string): void;
  onShopperActivity(): void;
  onToolStart(callId: string): void;
  onToolEnd(callId: string): void;
  dispose(): void;
  readonly checkInCount: number;
  readonly isArmed: boolean;
}

/**
 * Notices when the shopper has gone quiet after Alice finishes speaking:
 * checks in once after ~7s with a short natural line, once more after another
 * ~10s in different words, then waits quietly until the shopper speaks again.
 * Never fires while a tool is running, while the shopper or Alice is speaking,
 * when suppressed (e.g. a tool result nudge is pending), or right after a goodbye.
 */
export function createSilenceCheckIn(options: SilenceCheckInOptions): SilenceCheckIn {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const firstDelayMs = Math.max(0, options.firstDelayMs ?? DEFAULT_SILENCE_FIRST_MS);
  const secondDelayMs = Math.max(0, options.secondDelayMs ?? DEFAULT_SILENCE_SECOND_MS);
  const maxCheckIns = Math.max(0, options.maxCheckIns ?? MAX_SILENCE_CHECKINS);
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let timer: TimerHandle | null = null;
  let awaitingShopper = false;
  let suppressedAfterGoodbye = false;
  let checkInCount = 0;
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
    if (checkInCount >= maxCheckIns) return true;
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

  function scheduleIfReady(): void {
    cancelTimer();
    if (isBlocked()) return;

    const delayMs = checkInCount === 0 ? firstDelayMs : secondDelayMs;
    armedAt = nowFn();

    timer = setTimeoutFn(() => {
      timer = null;
      if (isBlocked()) return;

      checkInCount += 1;
      const count = checkInCount;
      const waitMs = Math.max(0, Math.round(nowFn() - armedAt));
      const instructions = pickInstruction(count);

      logFn(options.room, 'silence_checkin', {
        count,
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

      // If more check-ins remain and Alice hasn't already switched to speaking synchronously,
      // arm the next stage (which will be cleanly reset once she starts and finishes speaking).
      if (checkInCount < maxCheckIns && !isBlocked()) {
        scheduleIfReady();
      }
    }, delayMs);
    timer.unref?.();
  }

  function resetOnShopper(): void {
    cancelTimer();
    checkInCount = 0;
    suppressedAfterGoodbye = false;
  }

  return {
    get checkInCount(): number {
      return checkInCount;
    },

    get isArmed(): boolean {
      return timer !== null;
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (nextState === 'speaking' || nextState === 'thinking') {
        cancelTimer();
        return;
      }

      if (prevState === 'speaking' && (nextState === 'listening' || nextState === 'idle')) {
        if (!suppressedAfterGoodbye) {
          awaitingShopper = true;
        }
        scheduleIfReady();
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
        return;
      }

      if (awaitingShopper && timer === null) {
        scheduleIfReady();
      }
    },

    onAssistantMessage(text?: string): void {
      if (disposed || typeof text !== 'string') return;
      if (isGoodbyeMessage(text)) {
        suppressedAfterGoodbye = true;
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
      awaitingShopper = false;
      cancelTimer();
    },

    onToolEnd(callId: string): void {
      if (disposed) return;
      if (callId) {
        activeTools.delete(callId);
      } else {
        activeTools.clear();
      }
      // Do not arm immediately on tool end; wait until Alice speaks the result and finishes.
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      activeTools.clear();
      awaitingShopper = false;
    },
  };
}
