// What Alice keeps about a signed-in shopper between calls, and the rules that bound it.
//
// Everything here is text the shopper said or the model wrote down, so it is treated as
// untrusted: trimmed, stripped of control characters, capped in length and count. Nothing
// in this file knows about photos, addresses or payment; those are never stored.
export type Department = 'men' | 'women';

export interface ShopperMemory {
  department: Department | null;
  sizes: Record<string, string>;
  facts: string[];
  updated_at: number | null;
}

export interface MemoryPatch {
  department?: unknown;
  sizes?: unknown;
  facts?: unknown;
}

export const MAX_FACTS = 40;
export const MAX_FACT_LENGTH = 200;
export const MAX_SIZES = 12;
export const MAX_SIZE_KEY_LENGTH = 24;
export const MAX_SIZE_VALUE_LENGTH = 16;
export const MAX_NAME_LENGTH = 60;

export function emptyMemory(): ShopperMemory {
  return { department: null, sizes: {}, facts: [], updated_at: null };
}

// C0 and C1 control characters, the Unicode line and paragraph separators, and the
// bidirectional override characters that can make stored text display misleadingly.
// Written as numbers so no invisible character ever sits in this source file.
export function isUnsafeCodePoint(c: number): boolean {
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  let safe = '';
  for (const ch of value) {
    safe += isUnsafeCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  }
  const flat = safe.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  // Cut on code points so a surrogate pair is never split.
  const points = [...flat];
  return points.length > maxLength ? points.slice(0, maxLength).join('').trim() : flat;
}

export function cleanDepartment(value: unknown): Department | null {
  return value === 'men' || value === 'women' ? value : null;
}

export function cleanName(value: unknown): string | null {
  const name = cleanText(value, MAX_NAME_LENGTH);
  return name || null;
}

export function cleanSizes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawKey, rawSize] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_SIZES) break;
    const key = cleanText(rawKey, MAX_SIZE_KEY_LENGTH)
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .trim();
    const size = cleanText(typeof rawSize === 'number' ? String(rawSize) : rawSize, MAX_SIZE_VALUE_LENGTH);
    // '__proto__' and friends are plain data here, but skip them anyway.
    if (!key || !size || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = size;
  }
  return out;
}

/** Cleans, drops blanks and case-insensitive repeats, and keeps the newest MAX_FACTS. */
export function cleanFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Walk from the end so that when two facts repeat, the newer position wins.
  for (let i = value.length - 1; i >= 0 && out.length < MAX_FACTS; i -= 1) {
    const fact = cleanText(value[i], MAX_FACT_LENGTH);
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out.reverse();
}

/**
 * Merges a patch into what is stored. A patch only adds or overrides: sizes are merged
 * key by key, facts are appended, a department replaces the old one. Fields the patch
 * leaves out (or sends as something unusable) are kept as they were.
 */
export function mergeMemory(current: ShopperMemory, patch: MemoryPatch): ShopperMemory {
  const department = cleanDepartment(patch.department) ?? current.department;
  const sizes = cleanSizes({ ...current.sizes, ...cleanSizes(patch.sizes) });
  const facts = cleanFacts([...current.facts, ...cleanFacts(patch.facts)]);
  return { department, sizes, facts, updated_at: current.updated_at };
}

export function parseStoredMemory(row: {
  department?: unknown;
  sizes_json?: unknown;
  facts_json?: unknown;
  updated_at?: unknown;
} | null | undefined): ShopperMemory {
  if (!row) return emptyMemory();
  let sizes: unknown = {};
  let facts: unknown = [];
  try {
    sizes = JSON.parse(typeof row.sizes_json === 'string' ? row.sizes_json : '{}');
  } catch {
    sizes = {};
  }
  try {
    facts = JSON.parse(typeof row.facts_json === 'string' ? row.facts_json : '[]');
  } catch {
    facts = [];
  }
  return {
    department: cleanDepartment(row.department),
    sizes: cleanSizes(sizes),
    facts: cleanFacts(facts),
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : null,
  };
}

export function isEmptyMemory(memory: ShopperMemory): boolean {
  return !memory.department && memory.facts.length === 0 && Object.keys(memory.sizes).length === 0;
}
