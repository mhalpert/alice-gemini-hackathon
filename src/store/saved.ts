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
}

export interface SavedStore {
  getSaved(key: string): SavedEntry | undefined;
  putSaved(key: string, query: string, gender: Gender, items: Item[]): SavedEntry;
  nearestSaved(query: string, gender: Gender): SavedEntry | null;
  flush(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 500;
const FILENAME = 'saved-searches.json';

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

function queryWords(query: string): Set<string> {
  const cleaned = query
    .toLowerCase()
    .replace(/\b(?:wo)?men'?s\b/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim();
  if (!cleaned) return new Set();
  return new Set(cleaned.split(/\s+/).filter(Boolean));
}

export function createSavedStore(opts?: SavedStoreOptions): SavedStore {
  const dir = opts?.dir ?? process.env.ALICE_SAVED_DIR ?? 'data/store';
  const filePath = path.join(dir, FILENAME);
  const now = opts?.now ?? (() => Date.now());
  const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const entries = new Map<string, SavedEntry>();
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

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

      for (const item of list) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as SavedEntry).key === 'string' &&
          typeof (item as SavedEntry).query === 'string' &&
          ((item as SavedEntry).gender === 'men' || (item as SavedEntry).gender === 'women') &&
          typeof (item as SavedEntry).t === 'number' &&
          Array.isArray((item as SavedEntry).items)
        ) {
          const entry = item as SavedEntry;
          entries.set(entry.key, entry);
        }
      }
    } catch {
      // Swallow disk/parse errors (e.g. ENOENT on first run)
    }
  }

  async function writeDisk(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const payload = JSON.stringify(Array.from(entries.values()), null, 2);
      await fsp.writeFile(filePath, payload, 'utf8');
    } catch {
      // Swallow every disk error
    }
  }

  function scheduleWrite(): void {
    dirty = true;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void writeDisk();
    }, debounceMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function getSaved(key: string): SavedEntry | undefined {
    ensureLoaded();
    return entries.get(key);
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
    entries.set(key, entry);
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

    return best;
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
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
