import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Gender, Item } from '../types.ts';

export interface SavedEntry {
  key: string;
  query: string;
  gender: Gender;
  t: number;
  items: Item[];
}

export interface SavedKeyOpts {
  shops?: string[];
  maxPrice?: number;
  limit?: number;
}

export interface SavedStoreOptions {
  dir?: string;
  now?: () => number;
  debounceMs?: number;
  writeIntervalMs?: number;
  maxEntries?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  writeFile?: (filePath: string, payload: string) => Promise<void>;
}

export interface SavedStore {
  getSaved(key: string): SavedEntry | undefined;
  putSaved(key: string, query: string, gender: Gender, items: Item[]): SavedEntry;
  nearestSaved(query: string, gender: Gender): SavedEntry | null;
  flush(): Promise<void>;
}

export const DEFAULT_SAVED_MAX = 400;
export const MAX_SAVED_KEY_LENGTH = 160;
const DEFAULT_WRITE_INTERVAL_MS = 2000;
const FILENAME = 'saved-searches.json';

function resolveMaxEntries(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const raw = process.env.ALICE_SAVED_MAX;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_SAVED_MAX;
}

export function savedKey(query: string, gender: Gender, opts?: SavedKeyOpts): string {
  const q = query.trim().toLowerCase();
  const shops = opts?.shops
    ? [...opts.shops].map((s) => s.trim().toLowerCase()).sort().join(',')
    : '';
  const maxPrice =
    opts?.maxPrice !== undefined && opts?.maxPrice !== null ? String(opts.maxPrice) : '';
  const limit = opts?.limit !== undefined && opts?.limit !== null ? String(opts.limit) : '';
  return `${q}|${gender}|${shops}|${maxPrice}|${limit}`;
}

function stemWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }
  if (/(?:ch|sh|x|z|s)es$/.test(word) && word.length > 4) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

function queryWords(query: string): Set<string> {
  const cleaned = query
    .toLowerCase()
    .replace(/\b(?:wo)?men'?s\b/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim();
  if (!cleaned) return new Set();
  return new Set(cleaned.split(/\s+/).filter(Boolean).map(stemWord));
}

export function createSavedStore(opts?: SavedStoreOptions): SavedStore {
  const dir = opts?.dir ?? process.env.ALICE_SAVED_DIR ?? 'data/store';
  const filePath = path.join(dir, FILENAME);
  const now = opts?.now ?? (() => Date.now());
  const writeIntervalMs = Math.max(
    0,
    opts?.writeIntervalMs ?? opts?.debounceMs ?? DEFAULT_WRITE_INTERVAL_MS,
  );
  const maxEntries = resolveMaxEntries(opts?.maxEntries);
  const scheduleFn =
    opts?.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
      return t;
    });
  const clearScheduleFn =
    opts?.clearSchedule ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const writeFileFn =
    opts?.writeFile ??
    (async (targetPath: string, payload: string) => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(targetPath, payload, 'utf8');
    });

  // Insertion-ordered LRU map: oldest (least recently used) first, newest last.
  const entries = new Map<string, SavedEntry>();
  let loaded = false;
  let timer: unknown = null;
  let dirty = false;
  let lastWriteAtMs = -Infinity;

  function touch(entry: SavedEntry): void {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
  }

  function evictOverflow(): void {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  }

  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
          ? parsed.entries
          : parsed && typeof parsed === 'object'
            ? Object.values(parsed)
            : [];

      const byKey = new Map<string, SavedEntry>();
      for (const item of list) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as SavedEntry).key === 'string' &&
          (item as SavedEntry).key.length <= MAX_SAVED_KEY_LENGTH &&
          typeof (item as SavedEntry).query === 'string' &&
          ((item as SavedEntry).gender === 'men' || (item as SavedEntry).gender === 'women') &&
          typeof (item as SavedEntry).t === 'number' &&
          Array.isArray((item as SavedEntry).items)
        ) {
          const entry = item as SavedEntry;
          const prev = byKey.get(entry.key);
          if (!prev || entry.t >= prev.t) {
            byKey.set(entry.key, entry);
          }
        }
      }

      // Keep only the newest maxEntries (oldest first in Map for LRU order).
      const ordered = Array.from(byKey.values()).sort((a, b) => a.t - b.t);
      const kept = ordered.length > maxEntries ? ordered.slice(-maxEntries) : ordered;
      for (const entry of kept) {
        entries.set(entry.key, entry);
      }
    } catch {
      // Swallow disk/parse errors (e.g. ENOENT on first run)
    }
  }

  async function writeDisk(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    lastWriteAtMs = now();
    try {
      const payload = JSON.stringify(Array.from(entries.values()), null, 2);
      await writeFileFn(filePath, payload);
    } catch {
      // Swallow every disk error
    }
  }

  function scheduleWrite(): void {
    dirty = true;
    // Coalesce: if a write timer is already scheduled, let it flush all pending saves together.
    if (timer !== null) {
      return;
    }
    const elapsedSinceLast = now() - lastWriteAtMs;
    const waitMs =
      lastWriteAtMs === -Infinity
        ? writeIntervalMs
        : Math.max(writeIntervalMs - Math.max(0, elapsedSinceLast), writeIntervalMs);
    timer = scheduleFn(() => {
      timer = null;
      void writeDisk();
    }, waitMs);
  }

  function getSaved(key: string): SavedEntry | undefined {
    ensureLoaded();
    const found = entries.get(key);
    if (found) {
      touch(found);
    }
    return found;
  }

  function putSaved(key: string, query: string, gender: Gender, items: Item[]): SavedEntry {
    ensureLoaded();
    const entry: SavedEntry = {
      key,
      query,
      gender,
      t: now(),
      items,
    };
    if (key.length > MAX_SAVED_KEY_LENGTH) {
      return entry;
    }
    touch(entry);
    evictOverflow();
    scheduleWrite();
    return entry;
  }

  function nearestSaved(query: string, gender: Gender): SavedEntry | null {
    ensureLoaded();
    const targetWords = queryWords(query);
    if (targetWords.size === 0) return null;

    let best: SavedEntry | null = null;
    let bestScore = 0;

    for (const entry of entries.values()) {
      if (entry.gender !== gender || entry.items.length === 0) continue;
      const candWords = queryWords(entry.query);
      if (candWords.size === 0) continue;

      let shared = 0;
      for (const w of targetWords) {
        if (candWords.has(w)) shared += 1;
      }
      const shorter = Math.min(targetWords.size, candWords.size);
      const score = shared / shorter;

      if (score >= 0.5) {
        if (!best || score > bestScore || (score === bestScore && entry.t > best.t)) {
          best = entry;
          bestScore = score;
        }
      }
    }

    if (best) {
      touch(best);
    }
    return best;
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearScheduleFn(timer);
      timer = null;
    }
    await writeDisk();
  }

  return {
    getSaved,
    putSaved,
    nearestSaved,
    flush,
  };
}

export const savedStore: SavedStore = createSavedStore();

export function getSaved(key: string): SavedEntry | undefined {
  return savedStore.getSaved(key);
}

export function putSaved(key: string, query: string, gender: Gender, items: Item[]): SavedEntry {
  return savedStore.putSaved(key, query, gender, items);
}

export function nearestSaved(query: string, gender: Gender): SavedEntry | null {
  return savedStore.nearestSaved(query, gender);
}
