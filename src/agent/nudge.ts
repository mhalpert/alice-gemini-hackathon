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
  onAssistantMessage(): void;
  dispose(): void;
  readonly hasPending: boolean;
}

interface PendingNudge {
  tool: string;
  callId: string;
  instruction: string;
  armedAt: number;
  waitingForAgentIdle: boolean;
}

export function buildNudgeInstruction(toolName: string, resultText: string): string | null {
  if (!NUDGE_TOOL_NAMES.has(toolName)) return null;

  if (toolName === 'build_outfits') {
    if (/^Department is not set/i.test(resultText.trim())) {
      return 'Respond to the latest build_outfits tool result now.';
    }
    return 'The outfits from build_outfits have arrived. Present the looks now in one tight sentence per look and ask which catches their eye.';
  }

  if (toolName === 'show_on_me') {
    if (/^No look selected/i.test(resultText.trim())) {
      return 'Respond to the latest show_on_me tool result now.';
    }
    return 'The try-on result from show_on_me has arrived. React to it now and follow up naturally.';
  }

  if (toolName === 'add_to_bag') {
    return 'The shopping bag result from add_to_bag has arrived. Tell the shopper plainly what happened with the bag now.';
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

    onToolResult(ev: ToolResultNudgeEvent): void {
      if (disposed) return;
      const instruction = buildNudgeInstruction(ev.name, ev.text);
      if (!instruction) return;

      cancelTimer();
      pending = {
        tool: ev.name,
        callId: ev.callId,
        instruction,
        armedAt: nowFn(),
        waitingForAgentIdle: agentState === 'speaking',
      };

      scheduleIfReady();
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      agentState = nextState;

      if (!pending) return;

      if (nextState === 'speaking') {
        if (!pending.waitingForAgentIdle) {
          // Alice started speaking after the tool result arrived: no nudge needed.
          clearPending();
        }
        return;
      }

      if (pending.waitingForAgentIdle) {
        // Alice finished the speech that was already running when the tool finished.
        // Start counting from now so Gemini has a full window to auto-reply to the delivered result.
        pending.waitingForAgentIdle = false;
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

    onAssistantMessage(): void {
      if (disposed || !pending) return;
      if (!pending.waitingForAgentIdle) {
        clearPending();
      }
    },

    dispose(): void {
      disposed = true;
      clearPending();
    },
  };
}
