import type { Gender, Item, SearchResult } from '../types.ts';
import type { ProductDetail, SearchOpts } from './catalog.ts';
import { search as defaultSearch, searchMixed as defaultSearchMixed } from './index.ts';
import { STORES, storeNameForDomain } from './stores.ts';

export interface StorefrontSection {
  id: string;
  title: string;
  items: Item[];
}

export interface StorefrontResult {
  department: Gender;
  sections: StorefrontSection[];
  ms: number;
  partial?: true;
}

export interface StorefrontDeps {
  searchMixed?: (query: string, gender: Gender, opts?: SearchOpts) => Promise<SearchResult>;
  search?: (query: string, gender: Gender, opts?: SearchOpts) => Promise<SearchResult>;
  budgetMs?: number;
  perSearchBudgetMs?: number;
  now?: () => number;
}

export interface SizeDetail {
  label: string;
  available: boolean;
}

export interface ProductPayload {
  item: Item;
  images: string[];
  slot: string;
  why: string;
  sizes: string[];
  details: string[];
  description: string;
  sizes_detail: SizeDetail[];
}

interface RailSpec {
  id: string;
  title: string;
  kind: 'category' | 'store';
  queries: string[];
  shop?: string;
}

const DEFAULT_STOREFRONT_BUDGET_MS = 1400;
const DEFAULT_PER_SEARCH_BUDGET_MS = 2500;
const RAIL_LIMIT = 8;
const STOREFRONT_DESC_MAX = 160;
const PRODUCT_ITEM_DESC_MAX = 300;
const PRODUCT_FULL_DESC_MAX = 700;
const DETAIL_BULLET_MAX = 119;
const MAX_DETAIL_BULLETS = 5;

const SHOPIFY_GID_RE = /^gid:\/\/shopify\/[A-Za-z0-9_/-]+$/;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
};

const CATEGORY_RAILS: Record<Gender, Array<{ id: string; title: string; queries: string[] }>> = {
  men: [
    { id: 'shirts-knits', title: 'Shirts & knits', queries: ["men's shirt", "men's knit sweater"] },
    { id: 'trousers-denim', title: 'Trousers & denim', queries: ["men's trousers", "men's jeans"] },
    { id: 'shoes', title: 'Shoes', queries: ["men's leather shoes", "men's sneakers"] },
    { id: 'outerwear', title: 'Outerwear', queries: ["men's jacket"] },
    { id: 'bags-accessories', title: 'Bags & accessories', queries: ["men's bag"] },
    { id: 'tailoring', title: 'Blazers & tailoring', queries: ["men's blazer"] },
  ],
  women: [
    { id: 'dresses', title: 'Dresses', queries: ["women's dress"] },
    { id: 'tops', title: 'Tops & blouses', queries: ["women's top"] },
    { id: 'trousers-denim', title: 'Trousers & denim', queries: ["women's trousers", "women's jeans"] },
    { id: 'shoes', title: 'Heels & sandals', queries: ["women's heels", "women's sandals"] },
    { id: 'outerwear', title: 'Outerwear', queries: ["women's jacket"] },
    { id: 'bags-jewelry', title: 'Bags & jewelry', queries: ["women's bag", "women's jewelry"] },
  ],
};

const STORE_RAIL_ORDER = ['Everlane', 'Steve Madden', 'Kith', 'Fashion Nova'];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildRailSpecs(gender: Gender): RailSpec[] {
  const categorySpecs: RailSpec[] = CATEGORY_RAILS[gender].map((r) => ({
    id: r.id,
    title: r.title,
    kind: 'category',
    queries: r.queries,
  }));

  const orderedStores = [...STORES].sort((a, b) => {
    const ia = STORE_RAIL_ORDER.indexOf(a.name);
    const ib = STORE_RAIL_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const storeQuery = `${gender}'s clothing`;
  const storeSpecs: RailSpec[] = orderedStores.map((s) => ({
    id: `from-${slugify(s.name)}`,
    title: `From ${s.name}`,
    kind: 'store',
    queries: [storeQuery],
    shop: s.site,
  }));

  return [...categorySpecs, ...storeSpecs];
}

export function trimPlainText(raw: string, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice.trimEnd();
}

function stripTagsAndDecode(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|quot|#39|apos|nbsp|lt|gt);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function trimStorefrontItem(item: Item): Item {
  return {
    ...item,
    description: trimPlainText(item.description ?? '', STOREFRONT_DESC_MAX),
    variants_by_size: {},
  };
}

function mergeInterleavedItems(lists: Item[][], maxItems: number): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  const maxLen = lists.reduce((acc, list) => Math.max(acc, list.length), 0);

  for (let i = 0; i < maxLen && out.length < maxItems; i += 1) {
    for (const list of lists) {
      const item = list[i];
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(trimStorefrontItem(item));
      if (out.length >= maxItems) break;
    }
  }

  return out;
}

export function isValidShopifyGid(id: string): boolean {
  return typeof id === 'string' && id.length <= 200 && SHOPIFY_GID_RE.test(id);
}

export async function storefront(
  gender: Gender,
  deps?: StorefrontDeps,
): Promise<StorefrontResult> {
  const now = deps?.now ?? (() => Date.now());
  const t0 = now();
  const searchMixedFn = deps?.searchMixed ?? defaultSearchMixed;
  const searchFn = deps?.search ?? defaultSearch;
  const budgetMs = deps?.budgetMs ?? DEFAULT_STOREFRONT_BUDGET_MS;
  const perSearchBudgetMs = deps?.perSearchBudgetMs ?? DEFAULT_PER_SEARCH_BUDGET_MS;

  const rails = buildRailSpecs(gender);

  // Track every individual query so we can return any rail whose work completed by budgetMs.
  interface RailState {
    spec: RailSpec;
    results: Array<Item[] | null>;
    settledCount: number;
  }

  const states: RailState[] = rails.map((spec) => ({
    spec,
    results: spec.queries.map(() => null),
    settledCount: 0,
  }));

  const allQueryPromises: Promise<void>[] = [];

  for (const railState of states) {
    const { spec } = railState;
    spec.queries.forEach((query, qIdx) => {
      const runOne = async (): Promise<void> => {
        let perTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const callPromise =
            spec.kind === 'store' && spec.shop
              ? searchFn(query, gender, { shops: [spec.shop], limit: RAIL_LIMIT })
              : searchMixedFn(query, gender, { limit: RAIL_LIMIT });

          callPromise.catch(() => {});

          const timeoutPromise = new Promise<null>((resolve) => {
            perTimer = setTimeout(() => resolve(null), perSearchBudgetMs);
            if (typeof perTimer.unref === 'function') {
              perTimer.unref();
            }
          });

          const res = await Promise.race([callPromise, timeoutPromise]);
          railState.results[qIdx] = res && Array.isArray(res.items) ? res.items : [];
        } catch {
          railState.results[qIdx] = [];
        } finally {
          if (perTimer !== undefined) {
            clearTimeout(perTimer);
          }
          railState.settledCount += 1;
        }
      };

      allQueryPromises.push(runOne());
    });
  }

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const allDone = Promise.all(allQueryPromises).then(() => 'done' as const);
    const budgetPromise = new Promise<'timeout'>((resolve) => {
      budgetTimer = setTimeout(() => resolve('timeout'), budgetMs);
      if (typeof budgetTimer.unref === 'function') {
        budgetTimer.unref();
      }
    });

    const winner = await Promise.race([allDone, budgetPromise]);
    timedOut = winner === 'timeout';
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  }

  const sections: StorefrontSection[] = [];
  let anySectionDropped = false;

  for (const railState of states) {
    const readyLists = railState.results.filter((list): list is Item[] => list !== null);
    const fullySettled = railState.settledCount === railState.spec.queries.length;

    if (!fullySettled) {
      anySectionDropped = true;
    }

    if (readyLists.length === 0) {
      continue;
    }

    const items = mergeInterleavedItems(readyLists, RAIL_LIMIT);
    if (items.length > 0) {
      sections.push({
        id: railState.spec.id,
        title: railState.spec.title,
        items,
      });
    }
  }

  const ms = Math.max(0, now() - t0);
  if (timedOut && anySectionDropped) {
    return { department: gender, sections, ms, partial: true };
  }
  return { department: gender, sections, ms };
}

function resolveStoreFromDetail(detail: ProductDetail): { store: string; store_domain: string } {
  const extra = detail as unknown as {
    store?: unknown;
    store_domain?: unknown;
    seller?: { domain?: unknown; name?: unknown };
  };

  let host = '';
  if (typeof extra.store_domain === 'string' && extra.store_domain.trim()) {
    host = extra.store_domain.trim().toLowerCase();
  } else if (typeof extra.seller?.domain === 'string' && extra.seller.domain.trim()) {
    host = extra.seller.domain.trim().toLowerCase();
  } else if (detail.variant?.url) {
    try {
      host = new URL(detail.variant.url).hostname.toLowerCase();
    } catch {
      host = '';
    }
  }

  const cleanHost = host.startsWith('www.') ? host.slice(4) : host;
  const matched = STORES.find(
    (s) =>
      s.shop.toLowerCase() === cleanHost ||
      s.site.toLowerCase() === cleanHost ||
      cleanHost.endsWith(`.${s.site.toLowerCase()}`),
  );

  if (matched) {
    const explicitName =
      typeof extra.store === 'string' && extra.store.trim() ? extra.store.trim() : matched.name;
    return { store: explicitName, store_domain: matched.shop };
  }

  const fallbackName =
    typeof extra.store === 'string' && extra.store.trim()
      ? extra.store.trim()
      : typeof extra.seller?.name === 'string' && extra.seller.name.trim()
        ? extra.seller.name.trim()
        : undefined;

  return {
    store: storeNameForDomain(cleanHost || undefined, fallbackName),
    store_domain: cleanHost,
  };
}

function extractRating(detail: ProductDetail): { rating: number | null; rating_count: number | null } {
  const extra = detail as unknown as {
    rating?: unknown;
    rating_count?: unknown;
  };

  let rating: number | null = null;
  let rating_count: number | null = null;

  if (typeof extra.rating === 'number' && Number.isFinite(extra.rating)) {
    rating = extra.rating;
  } else if (extra.rating && typeof extra.rating === 'object') {
    const rObj = extra.rating as { value?: unknown; count?: unknown };
    const val = Number(rObj.value);
    if (rObj.value !== null && rObj.value !== undefined && rObj.value !== '' && Number.isFinite(val)) {
      rating = val;
    }
    const cnt = Number(rObj.count);
    if (rObj.count !== null && rObj.count !== undefined && rObj.count !== '' && Number.isFinite(cnt)) {
      rating_count = cnt;
    }
  }

  if (rating_count === null && extra.rating_count !== null && extra.rating_count !== undefined && extra.rating_count !== '') {
    const cnt = Number(extra.rating_count);
    if (Number.isFinite(cnt)) {
      rating_count = cnt;
    }
  }

  return { rating, rating_count };
}

export function extractDetailBullets(descriptionHtml: string, plainDescription: string): string[] {
  const seen = new Set<string>();
  const bullets: string[] = [];

  const pushBullet = (raw: string): void => {
    if (bullets.length >= MAX_DETAIL_BULLETS) return;
    const cleaned = trimPlainText(stripTagsAndDecode(raw), DETAIL_BULLET_MAX);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    bullets.push(cleaned);
  };

  if (typeof descriptionHtml === 'string' && /<li\b/i.test(descriptionHtml)) {
    const liMatches = descriptionHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi);
    for (const match of liMatches) {
      if (match[1]) pushBullet(match[1]);
      if (bullets.length >= MAX_DETAIL_BULLETS) return bullets;
    }
  }

  if (bullets.length > 0) {
    return bullets;
  }

  const plain = typeof plainDescription === 'string' ? plainDescription.trim() : '';
  if (!plain) return bullets;

  const segments = plain
    .split(/(?:\r?\n+|\s*[•·]\s*|(?<=[.!?])\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    pushBullet(seg);
    if (bullets.length >= MAX_DETAIL_BULLETS) break;
  }

  return bullets;
}

export function buildProductPayload(
  detail: ProductDetail,
  department: Gender = 'women',
): ProductPayload {
  const images = Array.isArray(detail.images)
    ? detail.images.filter((img): img is string => typeof img === 'string' && img.length > 0)
    : [];

  const sizeOption = Array.isArray(detail.options)
    ? detail.options.find((o) => /size/i.test(o.name)) ??
      detail.options.find((o) => /waist|length/i.test(o.name))
    : undefined;

  const sizes_detail: SizeDetail[] = Array.isArray(sizeOption?.values)
    ? sizeOption.values
        .filter((v) => v && typeof v.label === 'string' && v.label.trim().length > 0)
        .map((v) => ({ label: v.label, available: Boolean(v.available) }))
    : [];

  const sizes = sizes_detail.filter((s) => s.available).map((s) => s.label);
  const description = trimPlainText(detail.description ?? '', PRODUCT_FULL_DESC_MAX);
  const details = extractDetailBullets(detail.description_html ?? '', description);
  const { store, store_domain } = resolveStoreFromDetail(detail);
  const { rating, rating_count } = extractRating(detail);

  const item: Item = {
    id: detail.id,
    variant_id: detail.variant.id,
    title: detail.title,
    price: detail.variant.price,
    url: detail.variant.url,
    image: images[0] ?? '',
    store,
    store_domain,
    rating,
    rating_count,
    sizes,
    variants_by_size: {},
    description: trimPlainText(description, PRODUCT_ITEM_DESC_MAX),
    department,
  };

  return {
    item,
    images,
    slot: '',
    why: '',
    sizes,
    details,
    description,
    sizes_detail,
  };
}
