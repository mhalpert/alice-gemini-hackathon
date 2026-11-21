// Curated occasion dropdown menu and offline (zero-network) word matching for the storefront.
import type { Gender } from '../types.ts';
import { libraryOccasions } from './index.ts';
import { OCCASIONS, type LibraryOccasion } from './occasions.ts';
import { EXTRA_OCCASIONS } from './occasions-extra.ts';

export interface MenuEntry {
  key: string;
  keyword: string;
}

export interface WordMatch {
  key: string;
  label: string;
  score: number;
}

const MAX_MENU_ENTRIES = 15;
const MIN_MATCH_SCORE = 0.5;
const TIE_EPS = 1e-9;

const CURATED_MENU: Record<Gender, readonly MenuEntry[]> = {
  women: [
    { key: 'rooftop-birthday', keyword: 'Birthday Party' },
    { key: 'first-date', keyword: 'First Date' },
    { key: 'summer-wedding', keyword: 'Summer Wedding' },
    { key: 'black-tie-wedding', keyword: 'Black Tie Wedding' },
    { key: 'beach-wedding-guest', keyword: 'Beach Wedding' },
    { key: 'interview-creative', keyword: 'Job Interview' },
    { key: 'business-casual', keyword: 'New Job' },
    { key: 'brunch', keyword: 'Brunch' },
    { key: 'club', keyword: 'Night Out' },
    { key: 'festival', keyword: 'Festival' },
    { key: 'beach', keyword: 'Beach Vacation' },
    { key: 'gala', keyword: 'Gala' },
    { key: 'upscale-dinner-date', keyword: 'Dinner Date' },
    { key: 'office-holiday-party', keyword: 'Holiday Party' },
    { key: 'graduation-ceremony', keyword: 'Graduation' },
  ],
  men: [
    { key: 'rooftop-birthday', keyword: 'Birthday Party' },
    { key: 'first-date', keyword: 'First Date' },
    { key: 'summer-wedding', keyword: 'Summer Wedding' },
    { key: 'beach-wedding-guest', keyword: 'Beach Wedding' },
    { key: 'interview-creative', keyword: 'Job Interview' },
    { key: 'interview-bank', keyword: 'Finance Interview' },
    { key: 'business-casual', keyword: 'New Job' },
    { key: 'brunch', keyword: 'Brunch' },
    { key: 'club', keyword: 'Night Out' },
    { key: 'festival', keyword: 'Festival' },
    { key: 'beach', keyword: 'Beach Vacation' },
    { key: 'fall-weekend', keyword: 'Game Day' },
    { key: 'upscale-dinner-date', keyword: 'Dinner Date' },
    { key: 'office-holiday-party', keyword: 'Holiday Party' },
    { key: 'graduation-ceremony', keyword: 'Graduation' },
  ],
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'for', 'to', 'at', 'in', 'on', 'of', 'and', 'with',
  'i', 'im', "i'm", 'going', 'need', 'outfit', 'look', 'something', 'wear', 'wearing',
  'what', 'some',
]);

const GENERIC_TOKENS = new Set([
  'party', 'dinner', 'night', 'day', 'weekend', 'trip', 'event',
]);

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['wedding', 'marriage', 'reception'],
  ['interview', 'job'],
  ['date', 'dinner'],
  ['club', 'party', 'clubbing', 'nightclub'],
  ['gala', 'formal', 'black tie', 'tux', 'tuxedo'],
  ['beach', 'vacation', 'resort', 'miami'],
  ['brunch', 'lunch'],
  ['festival', 'coachella'],
  ['office', 'work'],
  ['goldman', 'jpmorgan', 'morgan', 'bank', 'banking', 'finance', 'financial', 'wall street', 'investment', 'hedge fund'],
];

const QUERY_PHRASES: readonly (readonly [string, string])[] = [
  ['wall', 'street'],
  ['hedge', 'fund'],
];

const ONE_WAY_SYNONYMS: Record<string, readonly string[]> = {
  bday: ['birthday'],
};

const SYNONYM_MAP: Map<string, readonly string[]> = (() => {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    let set = map.get(from);
    if (!set) {
      set = new Set([from]);
      map.set(from, set);
    }
    set.add(to);
  };
  for (const group of SYNONYM_GROUPS) {
    for (const a of group) {
      for (const b of group) {
        add(a, b);
      }
    }
  }
  for (const [from, targets] of Object.entries(ONE_WAY_SYNONYMS)) {
    for (const to of targets) {
      add(from, to);
    }
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [k, v] of map) {
    frozen.set(k, [...v]);
  }
  return frozen;
})();

const OCCASIONS_BY_KEY: Map<string, LibraryOccasion> = (() => {
  const map = new Map<string, LibraryOccasion>();
  for (const occ of [...OCCASIONS, ...EXTRA_OCCASIONS]) {
    if (occ?.key && !map.has(occ.key)) {
      map.set(occ.key, occ);
    }
  }
  return map;
})();

const MENU_KEYWORD_BY_GENDER: Record<Gender, Map<string, string>> = {
  women: new Map(CURATED_MENU.women.map((e) => [e.key, e.keyword])),
  men: new Map(CURATED_MENU.men.map((e) => [e.key, e.keyword])),
};

function singularize(word: string): string {
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function tokenizeWords(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 0);

  const tokens: string[] = [];
  for (const w of raw) {
    if (STOPWORDS.has(w)) continue;
    const clean = w.replace(/'/g, '');
    if (!clean || STOPWORDS.has(clean)) continue;
    const stem = singularize(clean);
    if (!stem || STOPWORDS.has(stem)) continue;
    tokens.push(stem);
  }
  return tokens;
}

function tokenizeQuery(text: string): string[] {
  const words = tokenizeWords(text);
  const merged: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const phrase = QUERY_PHRASES.find(([a, b]) => words[i] === a && words[i + 1] === b);
    if (phrase) {
      merged.push(`${phrase[0]} ${phrase[1]}`);
      i += 1;
    } else {
      merged.push(words[i]);
    }
  }
  return [...new Set(merged)];
}

function addTextToVocab(text: string | undefined, vocab: Set<string>): void {
  if (!text) return;
  const words = tokenizeWords(text);
  for (let i = 0; i < words.length; i++) {
    vocab.add(words[i]);
    if (words[i] === 'black' && words[i + 1] === 'tie') {
      vocab.add('black tie');
    }
  }
}

function buildSetVocab(gender: Gender, key: string, occasion: string): Set<string> {
  const vocab = new Set<string>();
  addTextToVocab(key, vocab);
  addTextToVocab(occasion, vocab);
  const def = OCCASIONS_BY_KEY.get(key);
  if (def) {
    addTextToVocab(def.occasion, vocab);
    for (const wording of def.wordings) {
      addTextToVocab(wording, vocab);
    }
  }
  addTextToVocab(MENU_KEYWORD_BY_GENDER[gender].get(key), vocab);
  return vocab;
}

function expandToken(token: string): readonly string[] {
  return SYNONYM_MAP.get(token) ?? [token];
}

export async function occasionMenu(gender: Gender): Promise<MenuEntry[]> {
  const servable = await libraryOccasions(gender);
  const servableKeys = new Set(servable.map((o) => o.key));
  const curated = CURATED_MENU[gender] ?? [];
  const menu: MenuEntry[] = [];
  for (const entry of curated) {
    if (menu.length >= MAX_MENU_ENTRIES) break;
    if (servableKeys.has(entry.key)) {
      menu.push({ key: entry.key, keyword: entry.keyword });
    }
  }
  return menu;
}

export async function matchOccasionWords(
  gender: Gender,
  text: string,
): Promise<WordMatch | null> {
  const queryTokens = tokenizeQuery(text);
  if (queryTokens.length === 0) return null;

  const servable = await libraryOccasions(gender);
  if (servable.length === 0) return null;

  const candidates = servable.map((entry) => ({
    key: entry.key,
    label: entry.label,
    vocab: buildSetVocab(gender, entry.key, entry.occasion),
  }));

  const setCount = candidates.length;
  const expanded = queryTokens.map((token) => {
    const terms = expandToken(token);
    let df = 0;
    for (const c of candidates) {
      if (terms.some((term) => c.vocab.has(term))) {
        df += 1;
      }
    }
    const idf = Math.log((setCount + 1) / (df + 1)) + 1;
    return {
      token,
      terms,
      idf,
      generic: GENERIC_TOKENS.has(token),
    };
  });

  const totalWeight = expanded.reduce((sum, item) => sum + item.idf, 0);
  if (totalWeight <= 0) return null;

  let best: { key: string; label: string; score: number; exactMatches: number; nonGenericMatches: number } | null = null;

  for (const candidate of candidates) {
    let matchedWeight = 0;
    let exactMatches = 0;
    let nonGenericMatches = 0;

    for (const q of expanded) {
      const isExact = candidate.vocab.has(q.token);
      const isMatched = isExact || q.terms.some((term) => candidate.vocab.has(term));
      if (!isMatched) continue;
      matchedWeight += q.idf;
      if (isExact) exactMatches += 1;
      if (!q.generic) nonGenericMatches += 1;
    }

    if (nonGenericMatches === 0) continue;
    const score = matchedWeight / totalWeight;
    if (score < MIN_MATCH_SCORE) continue;

    const better =
      !best ||
      score > best.score + TIE_EPS ||
      (Math.abs(score - best.score) <= TIE_EPS &&
        (exactMatches > best.exactMatches ||
          (exactMatches === best.exactMatches && nonGenericMatches > best.nonGenericMatches)));

    if (better) {
      best = {
        key: candidate.key,
        label: candidate.label,
        score,
        exactMatches,
        nonGenericMatches,
      };
    }
  }

  return best ? { key: best.key, label: best.label, score: best.score } : null;
}
