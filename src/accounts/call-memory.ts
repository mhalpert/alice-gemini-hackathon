// The note the web server hands the voice agent when a call starts.
//
// The server writes it into the agent dispatch inside the call token (signed by LiveKit's
// API secret, so the browser cannot change it). The agent reads it as its job metadata.
// It carries what Alice already knows about a signed-in shopper, and nothing that
// identifies the account: no id, no email.
//
// This file must stay free of database imports: the agent process loads it.
import {
  cleanDepartment,
  cleanFacts,
  cleanName,
  cleanSizes,
  type Department,
  type ShopperMemory,
} from './memory.ts';

export const CALL_MEMORY_VERSION = 1;
/** The agent keeps at most this many notes per call (MAX_FACTS in src/agent/state.ts). */
export const CALL_MEMORY_MAX_FACTS = 20;
/** Generous bound on the encoded note; real ones are a few hundred bytes. */
export const CALL_MEMORY_MAX_BYTES = 8 * 1024;

export interface CallShopper {
  name: string | null;
  department: Department | null;
  sizes: Record<string, string>;
  facts: string[];
}

export interface CallMemory {
  v: typeof CALL_MEMORY_VERSION;
  /** True when the server has shopper accounts switched on. */
  accounts: boolean;
  /** The signed-in shopper's memory, or null when nobody is signed in. */
  shopper: CallShopper | null;
}

export function toCallShopper(name: unknown, memory: ShopperMemory | null | undefined): CallShopper {
  return {
    name: cleanName(name),
    department: cleanDepartment(memory?.department),
    sizes: cleanSizes(memory?.sizes),
    facts: cleanFacts(memory?.facts).slice(-CALL_MEMORY_MAX_FACTS),
  };
}

export function encodeCallMemory(input: { accounts: boolean; shopper: CallShopper | null }): string {
  const note: CallMemory = {
    v: CALL_MEMORY_VERSION,
    accounts: input.accounts === true,
    shopper: input.shopper ? toCallShopper(input.shopper.name, { ...input.shopper, updated_at: null }) : null,
  };
  let text = JSON.stringify(note);
  // Should never trigger with the caps in memory.ts; if it somehow does, drop notes
  // (oldest first) rather than send a token that is too large to use.
  while (Buffer.byteLength(text) > CALL_MEMORY_MAX_BYTES && note.shopper && note.shopper.facts.length > 0) {
    note.shopper.facts = note.shopper.facts.slice(1);
    text = JSON.stringify(note);
  }
  return text;
}

/** Reads a note defensively. Anything unexpected gives null (treated as "no accounts"). */
export function decodeCallMemory(raw: unknown): CallMemory | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > CALL_MEMORY_MAX_BYTES * 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const note = parsed as Record<string, unknown>;
  if (note.v !== CALL_MEMORY_VERSION) return null;
  const shopperRaw = note.shopper;
  let shopper: CallShopper | null = null;
  if (shopperRaw && typeof shopperRaw === 'object' && !Array.isArray(shopperRaw)) {
    const s = shopperRaw as Record<string, unknown>;
    shopper = toCallShopper(s.name, {
      department: cleanDepartment(s.department),
      sizes: cleanSizes(s.sizes),
      facts: cleanFacts(s.facts),
      updated_at: null,
    });
  }
  return { v: CALL_MEMORY_VERSION, accounts: note.accounts === true, shopper };
}

export function isReturningShopper(shopper: CallShopper | null | undefined): boolean {
  if (!shopper) return false;
  return Boolean(
    shopper.name || shopper.department || shopper.facts.length > 0 || Object.keys(shopper.sizes).length > 0,
  );
}
