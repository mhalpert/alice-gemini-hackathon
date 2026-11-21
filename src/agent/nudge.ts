import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';

export const DEFAULT_RESULT_NUDGE_DELAY_MS = 3_000;

export const NUDGE_TOOL_NAMES = new Set(['build_outfits', 'show_on_me', 'add_to_bag']);

export type NudgeLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface ToolResultNudgeEvent {
  name: string;
  callId: string;
  text: string;
}

export interface ToolResultNudgerOptions {
  room: string;
  generateReply: (opts: { instructions: string }) => unknown;
  delayMs?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  log?: NudgeLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface ToolResultNudger {
  onToolResult(ev: ToolResultNudgeEvent): void;
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  onAssistantMessage(text?: string): void;
  onSpeechCreated?(): void;
  dispose(): void;
  readonly hasPending: boolean;
}

interface PendingNudge {
  tool: string;
  callId: string;
  instruction: string;
  armedAt: number;
  waitingForAgentIdle: boolean;
  preResultSpeechActive: boolean;
  ignorePreResultMessages: number;
  awaitingBagConfirmation: boolean;
}

const BAG_CONFIRMATION_RE =
  /\$\d|\bdollars?\b|\btotal\b|\bcomes to\b|\bcheckout\b|\blinks?\b|\bon the page\b|\bon your screen\b|\b(?:is|are|it's|they're)\s+in\s+(?:your|the)\s+bag\b|\bi(?:'ve| have)\s+added\b|\ball\s+\w+\s+(?:pieces|items)\b|\bnot\s+added\b|\bsold\s+out\b|\bout\s+of\s+stock\b|\bcould(?:n't| not)\b|\bexceeds?\b|\bcap(?:ped)?\b|\bmissing\b|\?/i;

const PRE_RESULT_ADDING_RE =
  /\b(?:adding|putting|tossing|dropping|throwing|popping|grabbing)\b|\b(?:add|put)\s+(?:this|that|it|them|look|the\s+look)\b/i;

/**
 * Returns true when an assistant utterance is a short pre-result "adding it in <sizes>"
 * acknowledgment rather than an actual post-result bag confirmation or status report.
 */
export function isPreResultAddingLine(text: string): boolean {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 200) return false;
  if (BAG_CONFIRMATION_RE.test(clean)) return false;
  return PRE_RESULT_ADDING_RE.test(clean);
}

export function buildNudgeInstruction(toolName: string, resultText: string): string | null {
  if (!NUDGE_TOOL_NAMES.has(toolName)) return null;

  if (toolName === 'build_outfits') {
    const trimmed = resultText.trim();
    if (/^Looks are already on their way|^Previous build\b.*\bsuperseded/i.test(trimmed)) {
      return null;
    }
    if (/^Department is not set/i.test(trimmed)) {
      return 'Respond to the latest build_outfits tool result now.';
    }
    return 'The outfits from build_outfits have arrived. Present the looks now in one tight, opinionated sentence per look, call out your favourite, and ask which catches their eye.';
  }

  if (toolName === 'show_on_me') {
    if (/^No look selected/i.test(resultText.trim())) {
      return 'Respond to the latest show_on_me tool result now.';
    }
    return 'The try-on result from show_on_me has arrived. React to it with big New York energy now and follow up naturally.';
  }

  if (toolName === 'add_to_bag') {
    return 'The shopping bag result from add_to_bag has arrived. State plainly in your punchy New York voice what is in the bag and the total now (or what was not added and why).';
  }

  return null;
}

/**
 * Guarantees that finished background tool results (`build_outfits`, `show_on_me`,
 * `add_to_bag`) are presented even when another conversational turn occurred in
 * between and Gemini Live stays silent after ingesting the tool response.
 *
 * Never double-speaks when Alice already started speaking after the result arrived.
 */
export function createToolResultNudger(options: ToolResultNudgerOptions): ToolResultNudger {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const delayMs = options.delayMs ?? DEFAULT_RESULT_NUDGE_DELAY_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let pending: PendingNudge | null = null;
  let timer: TimerHandle | null = null;
  let disposed = false;
  let speechCreatedUnfinished = false;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function clearPending(): void {
    cancelTimer();
    pending = null;
  }

  function scheduleIfReady(): void {
    cancelTimer();
    if (disposed || !pending) return;
    if (pending.waitingForAgentIdle) return;
    if (agentState === 'speaking') return;
    if (userState === 'speaking') return;

    const current = pending;
    timer = setTimeoutFn(() => {
      timer = null;
      if (disposed || pending !== current) return;
      if (agentState === 'speaking' || userState === 'speaking') return;

      pending = null;
      const waitMs = Math.max(0, Math.round(nowFn() - current.armedAt));
      logFn(options.room, 'result_nudge', {
        tool: current.tool,
        call_id: current.callId,
        wait_ms: waitMs,
      });

      try {
        options.generateReply({ instructions: current.instruction });
      } catch (err) {
        logFn(options.room, 'session_error', {
          source: 'result_nudge',
          tool: current.tool,
          call_id: current.callId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }, delayMs);
    timer.unref?.();
  }

  return {
    get hasPending(): boolean {
      return pending !== null;
    },

    onSpeechCreated(): void {
      if (disposed) return;
      speechCreatedUnfinished = true;
    },

    onToolResult(ev: ToolResultNudgeEvent): void {
      if (disposed) return;
      const instruction = buildNudgeInstruction(ev.name, ev.text);
      if (!instruction) return;

      cancelTimer();
      const isAddToBag = ev.name === 'add_to_bag';
      const speechAlreadyStarted =
        agentState === 'speaking' || (isAddToBag && speechCreatedUnfinished);

      pending = {
        tool: ev.name,
        callId: ev.callId,
        instruction,
        armedAt: nowFn(),
        waitingForAgentIdle: agentState === 'speaking',
        preResultSpeechActive: isAddToBag && speechAlreadyStarted,
        ignorePreResultMessages: speechAlreadyStarted ? 1 : 0,
        awaitingBagConfirmation: false,
      };

      scheduleIfReady();
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      const prevState = agentState;
      agentState = nextState;

      if (prevState === 'speaking' && nextState !== 'speaking') {
        speechCreatedUnfinished = false;
      }

      if (!pending) return;

      if (nextState === 'speaking') {
        if (pending.waitingForAgentIdle) {
          return;
        }
        if (pending.preResultSpeechActive) {
          // Speech created before the add_to_bag result arrived just began playing.
          pending.waitingForAgentIdle = true;
          cancelTimer();
          return;
        }
        if (pending.tool === 'add_to_bag') {
          // Pause the nudge while Alice speaks, and wait for the transcript to confirm
          // it wasn't just a short pre-result "adding it" line.
          pending.ignorePreResultMessages = 0;
          pending.awaitingBagConfirmation = true;
          cancelTimer();
          return;
        }
        // Alice started speaking after the tool result arrived: no nudge needed.
        clearPending();
        return;
      }

      if (pending.waitingForAgentIdle) {
        // Alice finished the speech that was already running when the tool finished.
        // Start counting from now so Gemini has a full window to auto-reply to the delivered result.
        pending.waitingForAgentIdle = false;
        pending.preResultSpeechActive = false;
        pending.armedAt = nowFn();
        scheduleIfReady();
        return;
      }

      if (pending.awaitingBagConfirmation) {
        // Alice finished an utterance after add_to_bag returned; re-arm so if the upcoming
        // transcript is only a pre-result "adding it" line, the nudge still fires.
        pending.armedAt = nowFn();
        scheduleIfReady();
      }
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;

      if (!pending) return;

      if (nextState === 'speaking') {
        // Pause while shopper is actively speaking so we never talk over them.
        cancelTimer();
      } else if (!pending.waitingForAgentIdle && agentState !== 'speaking' && timer === null) {
        scheduleIfReady();
      }
    },

    onAssistantMessage(text?: string): void {
      speechCreatedUnfinished = false;
      if (disposed || !pending) return;

      if (pending.waitingForAgentIdle || pending.preResultSpeechActive) {
        if (pending.ignorePreResultMessages > 0) {
          pending.ignorePreResultMessages -= 1;
        }
        return;
      }

      if (pending.ignorePreResultMessages > 0) {
        // This assistant message belongs to speech that started before the result arrived.
        pending.ignorePreResultMessages -= 1;
        return;
      }

      if (pending.tool === 'add_to_bag' && typeof text === 'string' && isPreResultAddingLine(text)) {
        // A short pre-result "adding it" line is not a bag confirmation; keep the nudge armed.
        pending.awaitingBagConfirmation = false;
        if (agentState === 'speaking') {
          pending.waitingForAgentIdle = true;
          cancelTimer();
        } else {
          pending.armedAt = nowFn();
          scheduleIfReady();
        }
        return;
      }

      clearPending();
    },

    dispose(): void {
      disposed = true;
      speechCreatedUnfinished = false;
      clearPending();
    },
  };
}
