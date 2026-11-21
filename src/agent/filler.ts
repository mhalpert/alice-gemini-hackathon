import { calllog } from '../calllog.ts';
import type { AgentStateValue, TimerHandle } from './context.ts';
import {
  type BitPicker,
  type FillerBit,
  LONG_BIT_WORD_LIMIT,
  MAX_BITS_PER_WAIT,
  SHORT_FILLER_BITS,
  countBitWords,
  createBitPicker,
  formatFillerBitInstruction,
  formatShortFillerBitInstruction,
  formatWorkingNoteWithBit,
  isLongBit,
} from './bits.ts';

export const DEFAULT_FILLER_INITIAL_DELAY_MS = 2_000;
export const BUILD_OUTFITS_FILLER_DELAY_MS = 4_000;
export const DEFAULT_FILLER_FOLLOWUP_DELAY_MS = 4_000;
export const MAX_LONG_BITS_PER_BUILD = 1;

export type FillerLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface FillerWorkingNoteParams {
  callId: string;
  name: string;
  note: string;
}

export interface SlowToolStartEvent {
  name: string;
  callId: string;
  baseNote: string;
  initialDelayMs?: number;
}

export interface ToolFillerOptions {
  room: string;
  generateReply: (opts: { instructions: string }) => unknown;
  sendWorkingNote?: (params: FillerWorkingNoteParams) => boolean | void;
  bitPicker?: BitPicker;
  initialDelayMs?: number;
  followUpDelayMs?: number;
  maxBitsPerWait?: number;
  initialAgentState?: AgentStateValue;
  initialUserState?: string;
  isSuppressed?: () => boolean;
  log?: FillerLogFn;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface ToolFiller {
  onToolStart(ev: SlowToolStartEvent): void;
  onToolEnd(callId: string, toolName?: string): void;
  onToolResult(ev: { callId: string; name?: string; text?: string }): void;
  onAgentStateChanged(nextState: AgentStateValue): void;
  onUserStateChanged(nextState: string): void;
  cancelAll(): void;
  dispose(): void;
  readonly isRunning: boolean;
  readonly activeCount: number;
}

interface ActiveWait {
  key: string;
  callId: string;
  tool: string;
  baseNote: string;
  startedAt: number;
  initialDelayMs: number;
  bitsSent: number;
  longBitsSent: number;
  workingNoteSent: boolean;
  sawSpeech: boolean;
}

/**
 * Keeps Alice talking naturally while a slow tool runs so the shopper never sits
 * in dead air. Skips fast results (< ~2s), sends the first bit via the working
 * note when available (or generateReply otherwise), follows up ~4s after Alice
 * stops talking if the tool is still running and nobody is speaking, caps at
 * three bits per wait (and at most one long bit > 12 words per build_outfits),
 * and stops immediately when the tool finishes so no bit starts after results land.
 */
export function createToolFiller(options: ToolFillerOptions): ToolFiller {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_FILLER_INITIAL_DELAY_MS);
  const followUpDelayMs = Math.max(0, options.followUpDelayMs ?? DEFAULT_FILLER_FOLLOWUP_DELAY_MS);
  const maxBitsPerWait = Math.max(0, options.maxBitsPerWait ?? MAX_BITS_PER_WAIT);
  const bitPicker = options.bitPicker ?? createBitPicker({ maxPerWait: maxBitsPerWait });
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let agentState: AgentStateValue = options.initialAgentState ?? 'initializing';
  let userState: string = options.initialUserState ?? 'listening';
  let disposed = false;
  let timer: TimerHandle | null = null;
  let syntheticIdCounter = 0;

  const activeWaits = new Map<string, ActiveWait>();
  const endedCallIds = new Set<string>();
  const usedShortBitIds = new Set<string>();

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function currentWait(): ActiveWait | null {
    let latest: ActiveWait | null = null;
    for (const wait of activeWaits.values()) {
      latest = wait;
    }
    return latest;
  }

  function isAnyoneBusy(): boolean {
    return agentState === 'speaking' || agentState === 'thinking' || userState === 'speaking';
  }

  function computeDelayMs(wait: ActiveWait): number {
    const remainingInitial = Math.max(0, wait.startedAt + wait.initialDelayMs - nowFn());
    if (wait.bitsSent === 0 && !wait.sawSpeech) {
      return remainingInitial;
    }
    return Math.max(followUpDelayMs, remainingInitial);
  }

  function pickShortBit(): FillerBit | null {
    for (const candidate of SHORT_FILLER_BITS) {
      if (usedShortBitIds.has(candidate.id)) continue;
      if (countBitWords(candidate.text) > LONG_BIT_WORD_LIMIT) continue;
      usedShortBitIds.add(candidate.id);
      return candidate;
    }
    return null;
  }

  function pickBitForWait(wait: ActiveWait): { bit: FillerBit; shortOnly: boolean } | null {
    const mustUseShort =
      wait.tool === 'build_outfits' && wait.longBitsSent >= MAX_LONG_BITS_PER_BUILD;

    if (mustUseShort) {
      const shortBit = pickShortBit();
      return shortBit ? { bit: shortBit, shortOnly: true } : null;
    }

    const picked = bitPicker.pick(wait.key);
    if (!picked) return null;
    return { bit: picked, shortOnly: !isLongBit(picked) };
  }

  function deliverBit(wait: ActiveWait): void {
    if (disposed || !activeWaits.has(wait.key)) return;
    if (wait.callId && endedCallIds.has(wait.callId)) return;
    if (options.isSuppressed?.()) return;
    if (isAnyoneBusy()) return;
    if (wait.bitsSent >= maxBitsPerWait) return;

    const selection = pickBitForWait(wait);
    if (!selection) return;
    const { bit, shortOnly } = selection;
    const bitWords = countBitWords(bit.text);
    const bitIsLong = bitWords > LONG_BIT_WORD_LIMIT;

    wait.bitsSent += 1;
    if (bitIsLong) {
      wait.longBitsSent += 1;
    }

    const formatReply = (tool: string, chosen: FillerBit): string =>
      shortOnly
        ? formatShortFillerBitInstruction(tool, chosen)
        : formatFillerBitInstruction(tool, chosen);

    // First bit uses the working note when available; subsequent bits (or fallback) use generateReply.
    if (!wait.workingNoteSent && options.sendWorkingNote) {
      wait.workingNoteSent = true;
      const note = formatWorkingNoteWithBit(wait.baseNote, bit);
      const sent = Boolean(
        options.sendWorkingNote({
          callId: wait.callId,
          name: wait.tool,
          note,
        }),
      );
      logFn(options.room, 'tool_note', {
        name: wait.tool,
        call_id: wait.callId,
        note,
        bit_id: bit.id,
        sent,
      });
      logFn(options.room, 'filler_bit', {
        id: bit.id,
        theme: bit.theme,
        tool: wait.tool,
        call_id: wait.callId,
        count: wait.bitsSent,
        words: bitWords,
        long: bitIsLong,
        via: sent ? 'working_note' : 'reply_fallback',
      });
      if (!sent) {
        triggerReply(wait, bit.id, formatReply(wait.tool, bit));
      }
    } else {
      logFn(options.room, 'filler_bit', {
        id: bit.id,
        theme: bit.theme,
        tool: wait.tool,
        call_id: wait.callId,
        count: wait.bitsSent,
        words: bitWords,
        long: bitIsLong,
        via: 'reply',
      });
      triggerReply(wait, bit.id, formatReply(wait.tool, bit));
    }

    // Re-arm follow-up timer in case the model remains idle; cancelled as soon as Alice speaks.
    scheduleNext();
  }

  function triggerReply(wait: ActiveWait, bitId: string, instructions: string): void {
    try {
      options.generateReply({ instructions });
    } catch (err) {
      logFn(options.room, 'session_error', {
        source: 'filler_bit',
        tool: wait.tool,
        call_id: wait.callId,
        bit_id: bitId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  function scheduleNext(): void {
    cancelTimer();
    if (disposed) return;
    if (options.isSuppressed?.()) return;

    const wait = currentWait();
    if (!wait) return;
    if (wait.callId && endedCallIds.has(wait.callId)) return;
    if (wait.bitsSent >= maxBitsPerWait) return;
    if (isAnyoneBusy()) return;

    const delay = computeDelayMs(wait);
    timer = setTimeoutFn(() => {
      timer = null;
      if (disposed || !activeWaits.has(wait.key)) return;
      if (wait.callId && endedCallIds.has(wait.callId)) return;
      if (options.isSuppressed?.()) return;
      if (isAnyoneBusy()) return;
      deliverBit(wait);
    }, delay);
    timer.unref?.();
  }

  function resolveInitialDelayMs(ev: SlowToolStartEvent): number {
    if (ev.initialDelayMs !== undefined) {
      return Math.max(0, ev.initialDelayMs);
    }
    if (options.initialDelayMs !== undefined) {
      return initialDelayMs;
    }
    if (ev.name === 'build_outfits') {
      return BUILD_OUTFITS_FILLER_DELAY_MS;
    }
    return initialDelayMs;
  }

  function cancelWaitByIdOrTool(callId: string, toolName?: string): void {
    if (callId) {
      endedCallIds.add(callId);
    }
    if (callId && activeWaits.has(callId)) {
      activeWaits.delete(callId);
      bitPicker.clearWait(callId);
    } else if (toolName) {
      let removed = false;
      for (const [key, wait] of activeWaits.entries()) {
        if (wait.tool === toolName) {
          activeWaits.delete(key);
          bitPicker.clearWait(key);
          removed = true;
        }
      }
      if (!removed && !callId && activeWaits.size > 0) {
        const latest = currentWait();
        if (latest) {
          activeWaits.delete(latest.key);
          bitPicker.clearWait(latest.key);
        }
      }
    } else if (!callId && activeWaits.size > 0) {
      const latest = currentWait();
      if (latest) {
        activeWaits.delete(latest.key);
        bitPicker.clearWait(latest.key);
      }
    }

    if (activeWaits.size === 0) {
      cancelTimer();
    } else {
      scheduleNext();
    }
  }

  return {
    get isRunning(): boolean {
      return activeWaits.size > 0;
    },

    get activeCount(): number {
      return activeWaits.size;
    },

    onToolStart(ev: SlowToolStartEvent): void {
      if (disposed) return;
      if (options.isSuppressed?.()) return;
      if (ev.callId && endedCallIds.has(ev.callId)) return;
      const key = ev.callId || `__slow_${++syntheticIdCounter}`;
      const wait: ActiveWait = {
        key,
        callId: ev.callId,
        tool: ev.name,
        baseNote: ev.baseNote,
        startedAt: nowFn(),
        initialDelayMs: resolveInitialDelayMs(ev),
        bitsSent: 0,
        longBitsSent: 0,
        workingNoteSent: false,
        sawSpeech: isAnyoneBusy(),
      };
      activeWaits.set(key, wait);
      scheduleNext();
    },

    onToolEnd(callId: string, toolName?: string): void {
      if (disposed) return;
      cancelWaitByIdOrTool(callId, toolName);
    },

    onToolResult(ev: { callId: string; name?: string; text?: string }): void {
      if (disposed) return;
      if (ev.callId) {
        endedCallIds.add(ev.callId);
      }
      // Do not cancel an unrelated active build_outfits wait when a duplicate build_outfits call is skipped.
      if (
        ev.name === 'build_outfits' &&
        typeof ev.text === 'string' &&
        /^Looks are already on their way/i.test(ev.text.trim()) &&
        (!ev.callId || !activeWaits.has(ev.callId))
      ) {
        return;
      }
      cancelWaitByIdOrTool(ev.callId, ev.name);
    },

    cancelAll(): void {
      cancelTimer();
      for (const [key, wait] of activeWaits.entries()) {
        if (wait.callId) endedCallIds.add(wait.callId);
        bitPicker.clearWait(key);
      }
      activeWaits.clear();
    },

    onAgentStateChanged(nextState: AgentStateValue): void {
      if (disposed) return;
      agentState = nextState;

      if (activeWaits.size === 0) return;

      if (nextState === 'speaking' || nextState === 'thinking') {
        if (nextState === 'speaking') {
          for (const wait of activeWaits.values()) {
            wait.sawSpeech = true;
          }
        }
        cancelTimer();
        return;
      }

      if (!isAnyoneBusy()) {
        scheduleNext();
      }
    },

    onUserStateChanged(nextState: string): void {
      if (disposed) return;
      userState = nextState;

      if (activeWaits.size === 0) return;

      if (nextState === 'speaking') {
        for (const wait of activeWaits.values()) {
          wait.sawSpeech = true;
        }
        cancelTimer();
        return;
      }

      if (!isAnyoneBusy()) {
        scheduleNext();
      }
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      for (const key of activeWaits.keys()) {
        bitPicker.clearWait(key);
      }
      activeWaits.clear();
    },
  };
}
