// Shopper memory across calls, agent side.
//
// At the start of a call the web server tells the agent (in its job metadata) whether
// shopper accounts are on and, for a signed-in shopper, what Alice already knows: name,
// department, sizes and notes. Those seed the call state, so Alice starts the call
// knowing them.
//
// During the call, whenever one of those four things changes, the agent sends the page a
// `saveMemory` action. The page (the shopper's own browser, which holds their session)
// passes it to the server. The agent never talks to the database and never learns which
// account it is.
import {
  decodeCallMemory,
  isReturningShopper,
  type CallMemory,
  type CallShopper,
} from '../accounts/call-memory.ts';
import { cleanDepartment, cleanFacts, cleanName, cleanSizes } from '../accounts/memory.ts';
import type { PageActions } from '../types.ts';
import type { PageSender } from './page.ts';
import type { CallState, CallStateAction, CallStateStore } from './state.ts';

export const MEMORY_STATE_KEYS: readonly string[] = ['facts', 'sizes', 'department', 'shopperName'];
export const DEFAULT_MEMORY_SAVE_DEBOUNCE_MS = 1500;

export type MemoryLogFn = (ev: string, data?: Record<string, unknown>) => void;

/** Reads the job metadata. Null means the server said nothing: accounts are off. */
export function readCallMemory(metadata: unknown): CallMemory | null {
  return decodeCallMemory(metadata);
}

// The call state is shown to the model as one line: "shopper=Ana; sizes={top:M}; notes=[a | b]".
// Stored text is someone's typing, so the characters that give that line its structure are
// taken out before it goes in. Otherwise a saved note could pose as other fields.
const STATE_LINE_SYNTAX = /[[\]{}|;=]/g;

export function plainForStateLine(text: string): string {
  return text.replace(STATE_LINE_SYNTAX, ' ').replace(/\s+/g, ' ').trim();
}

/** The slice of call state a returning shopper starts with. Empty for everyone else. */
export function initialStateFromMemory(memory: CallMemory | null): Partial<CallState> {
  const shopper = memory?.shopper;
  if (!shopper || !isReturningShopper(shopper)) return {};
  const name = shopper.name ? plainForStateLine(shopper.name) : '';
  const sizes: Record<string, string> = {};
  for (const [slot, size] of Object.entries(shopper.sizes)) {
    const cleanSlot = plainForStateLine(slot);
    const cleanSize = plainForStateLine(size);
    if (cleanSlot && cleanSize) sizes[cleanSlot] = cleanSize;
  }
  const facts = shopper.facts.map(plainForStateLine).filter(Boolean);
  return {
    ...(name ? { shopperName: name } : {}),
    ...(shopper.department ? { department: shopper.department } : {}),
    ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    ...(facts.length > 0 ? { facts } : {}),
  };
}

export type MemorySnapshot = Omit<PageActions['saveMemory'], 'ticket'>;

export function memoryFromState(state: CallState): MemorySnapshot {
  return {
    name: cleanName(state.shopperName),
    department: cleanDepartment(state.department),
    sizes: cleanSizes(state.sizes),
    facts: cleanFacts(state.facts),
  };
}

export function isReturning(memory: CallMemory | null): boolean {
  return isReturningShopper(memory?.shopper);
}

export function returningShopper(memory: CallMemory | null): CallShopper | null {
  return memory?.shopper && isReturningShopper(memory.shopper) ? memory.shopper : null;
}

export interface MemorySyncOptions {
  /**
   * The server's proof of which account started this call. Without one (accounts off, or
   * nobody signed in when the call began) nothing can be saved, so the sync does nothing.
   */
  ticket: string | null | undefined;
  page: Pick<PageSender, 'send'>;
  debounceMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  log?: MemoryLogFn;
}

export interface MemorySync {
  /** Returns a store that behaves exactly like `store` and reports memory changes to the page. */
  wrap(store: CallStateStore): CallStateStore;
  /** Sends anything not yet sent. Safe to call at any time, including after stop(). */
  flush(): Promise<void>;
  stop(): void;
}

export function createMemorySync(options: MemorySyncOptions): MemorySync {
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_MEMORY_SAVE_DEBOUNCE_MS);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearSchedule =
    options.clearSchedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = options.log ?? (() => {});

  const ticket = typeof options.ticket === 'string' && options.ticket ? options.ticket : null;
  const enabled = ticket !== null;
  let wrapped: CallStateStore | null = null;
  let lastSent = '';
  let timer: unknown = null;
  let sending: Promise<void> | null = null;
  let stopped = false;

  function cancelTimer(): void {
    if (timer !== null) {
      clearSchedule(timer);
      timer = null;
    }
  }

  async function sendNow(): Promise<void> {
    if (!enabled || !wrapped) return;
    // One send at a time; a change that lands meanwhile is picked up by the loop below.
    if (sending) {
      await sending;
    }
    const payload = memoryFromState(wrapped.get());
    const encoded = JSON.stringify(payload);
    if (encoded === lastSent) return;
    const run = (async () => {
      try {
        const reply = await options.page.send('saveMemory', { ticket: ticket!, ...payload });
        if (reply.ok) {
          lastSent = encoded;
          log('memory_sent', { facts: payload.facts.length, sizes: Object.keys(payload.sizes).length });
        } else {
          // Leave lastSent alone so the next change (or the final flush) tries again.
          log('memory_send_failed', { error: reply.error ?? 'page said no' });
        }
      } catch (err) {
        log('memory_send_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    sending = run;
    try {
      await run;
    } finally {
      if (sending === run) sending = null;
    }
  }

  function queue(): void {
    if (!enabled || stopped) return;
    cancelTimer();
    timer = schedule(() => {
      timer = null;
      void sendNow();
    }, debounceMs);
  }

  return {
    wrap(store) {
      wrapped = store;
      // What the call started with is already on the server; only changes are sent.
      lastSent = JSON.stringify(memoryFromState(store.get()));
      return {
        get: () => store.get(),
        summarize: () => store.summarize(),
        pushSummary: () => store.pushSummary(),
        recordShopperTurn: (text, itemId) => store.recordShopperTurn(text, itemId),
        getRecentShopperTurns: () => store.getRecentShopperTurns(),
        dispatch(action: CallStateAction): string[] {
          const changed = store.dispatch(action);
          if (changed.some((key) => MEMORY_STATE_KEYS.includes(key))) queue();
          return changed;
        },
      };
    },
    async flush() {
      cancelTimer();
      await sendNow();
    },
    stop() {
      stopped = true;
      cancelTimer();
    },
  };
}
