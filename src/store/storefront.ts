import type { Gender, Item, SearchResult } from '../types.ts';
import type { ProductDetail, SearchOpts } from './catalog.ts';
import { search as defaultSearch } from './index.ts';
import { ALL_SITES, OTHER_SITES, STORES, storeNameForDomain } from './stores.ts';

export interface StorefrontSection {
  id: string;
  title: string;
  items: Item[];
}

export interface StorefrontMeta {
  searches: number;
  shared: boolean;
}

export interface StorefrontResult {
  department: Gender;
  sections: StorefrontSection[];
  ms: number;
  storefront: StorefrontMeta;
  partial?: true;
}

export interface StorefrontDeps {
  search?: (query: string, gender: Gender, opts?: SearchOpts) => Promise<SearchResult>;
  budgetMs?: number;
  perSearchBudgetMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
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
  query: string;
  shop?: string;
}

const DEFAULT_STOREFRONT_BUDGET_MS = 4000;
const DEFAULT_PER_SEARCH_BUDGET_MS = 2500;
const RAIL_LIMIT = 8;
const THIN_RAIL_THRESHOLD = 4;
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

const CATEGORY_RAILS: Record<Gender, Array<{ id: string; title: string; query: string }>> = {
  men: [
    { id: 'shirts', title: 'Shirts', query: "men's shirt" },
    { id: 'trousers', title: 'Trousers', query: "men's trousers" },
    { id: 'shoes', title: 'Shoes', query: "men's shoes" },
    { id: 'outerwear', title: 'Outerwear', query: "men's jacket" },
    { id: 'bags', title: 'Bags', query: "men's bag" },
    { id: 'tailoring', title: 'Blazers & tailoring', query: "men's blazer" },
  ],
  women: [
    { id: 'dresses', title: 'Dresses', query: "women's dress" },
    { id: 'tops', title: 'Tops', query: "women's top" },
    { id: 'trousers', title: 'Trousers', query: "women's trousers" },
    { id: 'shoes', title: 'Shoes', query: "women's shoes" },
    { id: 'outerwear', title: 'Outerwear', query: "women's jacket" },
    { id: 'bags', title: 'Bags', query: "women's bag" },
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
    query: r.query,
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
    query: storeQuery,
    shop: s.site,
  }));

  return [...categorySpecs, ...storeSpecs];
}

// Default is 0 (reuse OFF) because today's Shopify challenge rule requires live
// data without caching results. ALICE_STOREFRONT_REUSE_S exists solely so the team
// can opt in to brief reuse (e.g. 15-30s) if the shared venue IP starts getting throttled.
export function getStorefrontReuseSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ALICE_STOREFRONT_REUSE_S;
  if (!raw || !raw.trim()) return 0;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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

function dedupeItems(primary: Item[], extra: Item[], maxItems: number): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const list of [primary, extra]) {
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(trimStorefrontItem(item));
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

export function isValidShopifyGid(id: string): boolean {
  return typeof id === 'string' && id.length <= 200 && SHOPIFY_GID_RE.test(id);
}

interface InFlightBuild {
  promise: Promise<StorefrontResult>;
  joiners: number;
}

interface ReuseEntry {
  t: number;
  result: StorefrontResult;
}

export interface StorefrontCallOpts {
  budgetMs?: number;
}

export function createStorefront(
  deps?: StorefrontDeps,
): (gender: Gender, callOpts?: StorefrontCallOpts) => Promise<StorefrontResult> {
  const inFlight = new Map<Gender, InFlightBuild>();
  const reuseCache = new Map<Gender, ReuseEntry>();

  async function buildDepartment(
    gender: Gender,
    flight: InFlightBuild,
    budgetMsOverride?: number,
  ): Promise<StorefrontResult> {
    const now = deps?.now ?? (() => Date.now());
    const t0 = now();
    const searchFn = deps?.search ?? defaultSearch;
    const budgetMs = budgetMsOverride ?? deps?.budgetMs ?? DEFAULT_STOREFRONT_BUDGET_MS;
    const perSearchBudgetMs = deps?.perSearchBudgetMs ?? DEFAULT_PER_SEARCH_BUDGET_MS;

    const rails = buildRailSpecs(gender);
    let searches = 0;
    let deadlinePassed = false;

    interface RailState {
      spec: RailSpec;
      items: Item[] | null;
      settled: boolean;
    }

    const states: RailState[] = rails.map((spec) => ({
      spec,
      items: null,
      settled: false,
    }));

    const runBoundedSearch = async (query: string, shops: string[]): Promise<Item[]> => {
      searches += 1;
      let perTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const callPromise = searchFn(query, gender, { shops, limit: RAIL_LIMIT });
        callPromise.catch(() => {});

        const timeoutPromise = new Promise<null>((resolve) => {
          perTimer = setTimeout(() => resolve(null), perSearchBudgetMs);
          if (typeof perTimer.unref === 'function') {
            perTimer.unref();
          }
        });

        const res = await Promise.race([callPromise, timeoutPromise]);
        return res && Array.isArray(res.items) ? res.items : [];
      } catch {
        return [];
      } finally {
        if (perTimer !== undefined) {
          clearTimeout(perTimer);
        }
      }
    };

    const allRailPromises = states.map(async (railState) => {
      const { spec } = railState;
      try {
        if (spec.kind === 'store' && spec.shop) {
          const rawItems = await runBoundedSearch(spec.query, [spec.shop]);
          railState.items = dedupeItems(rawItems, [], RAIL_LIMIT);
        } else {
          // One plain search restricted to OTHER_SITES (cleaner photos; Fashion Nova has its own rail).
          const primaryRaw = await runBoundedSearch(spec.query, OTHER_SITES);
          let merged = dedupeItems(primaryRaw, [], RAIL_LIMIT);
          // Only top up from ALL_SITES if this rail came back thin (< 4 items) and budget remains.
          if (merged.length < THIN_RAIL_THRESHOLD && !deadlinePassed) {
            const topUpRaw = await runBoundedSearch(spec.query, ALL_SITES);
            merged = dedupeItems(primaryRaw, topUpRaw, RAIL_LIMIT);
          }
          railState.items = merged;
        }
      } catch {
        railState.items = [];
      } finally {
        railState.settled = true;
      }
    });

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const allDone = Promise.all(allRailPromises).then(() => 'done' as const);
      const budgetPromise = new Promise<'timeout'>((resolve) => {
        budgetTimer = setTimeout(() => {
          deadlinePassed = true;
          resolve('timeout');
        }, budgetMs);
        if (typeof budgetTimer.unref === 'function') {
          budgetTimer.unref();
        }
      });

      const winner = await Promise.race([allDone, budgetPromise]);
      timedOut = winner === 'timeout';
      if (timedOut) {
        deadlinePassed = true;
      }
    } finally {
      if (budgetTimer !== undefined) {
        clearTimeout(budgetTimer);
      }
    }

    const sections: StorefrontSection[] = [];
    let anySectionDropped = false;

    for (const railState of states) {
      if (!railState.settled) {
        anySectionDropped = true;
      }
      if (railState.items && railState.items.length > 0) {
        sections.push({
          id: railState.spec.id,
          title: railState.spec.title,
          items: railState.items,
        });
      }
    }

    const ms = Math.max(0, now() - t0);
    const wasShared = flight.joiners > 0;
    console.log(
      `[store] storefront ${gender} searches=${searches} shared=${wasShared} ms=${ms}`,
    );

    const baseResult: StorefrontResult =
      timedOut && anySectionDropped
        ? {
            department: gender,
            sections,
            ms,
            storefront: { searches, shared: false },
            partial: true,
          }
        : {
            department: gender,
            sections,
            ms,
            storefront: { searches, shared: false },
          };

    return baseResult;
  }

  return async function loadStorefront(
    gender: Gender,
    callOpts?: StorefrontCallOpts,
  ): Promise<StorefrontResult> {
    const now = deps?.now ?? (() => Date.now());
    const env = deps?.env ?? process.env;
    const reuseS = getStorefrontReuseSeconds(env);

    // 1. Optional short reuse (OFF by default when ALICE_STOREFRONT_REUSE_S is 0/unset).
    if (reuseS > 0) {
      const cached = reuseCache.get(gender);
      if (cached && now() - cached.t < reuseS * 1000) {
        console.log(`[store] storefront ${gender} searches=0 shared=true ms=0`);
        return {
          ...cached.result,
          ms: 0,
          storefront: { searches: 0, shared: true },
        };
      }
      if (cached) {
        reuseCache.delete(gender);
      }
    } else if (reuseCache.size > 0) {
      reuseCache.clear();
    }

    // 2. In-flight sharing: await the active build for this department instead of starting another.
    const existing = inFlight.get(gender);
    if (existing) {
      existing.joiners += 1;
      const waitStart = now();
      const base = await existing.promise;
      const waitMs = Math.max(0, now() - waitStart);
      return {
        ...base,
        ms: waitMs,
        storefront: { searches: 0, shared: true },
      };
    }

    const flight: InFlightBuild = {
      promise: null as unknown as Promise<StorefrontResult>,
      joiners: 0,
    };

    const runPromise = buildDepartment(gender, flight, callOpts?.budgetMs).finally(() => {
      if (inFlight.get(gender) === flight) {
        inFlight.delete(gender);
      }
    });
    flight.promise = runPromise;
    inFlight.set(gender, flight);

    const result = await runPromise;

    // Only keep a finished result if optional reuse is explicitly enabled (> 0).
    if (getStorefrontReuseSeconds(deps?.env ?? process.env) > 0 && result.sections.length > 0) {
      reuseCache.set(gender, { t: now(), result });
    }

    return result;
  };
}

const defaultStorefrontLoader = createStorefront();
const loaderByDeps = new WeakMap<
  StorefrontDeps,
  (gender: Gender, callOpts?: StorefrontCallOpts) => Promise<StorefrontResult>
>();

export function storefront(
  gender: Gender,
  deps?: StorefrontDeps,
): Promise<StorefrontResult> {
  if (!deps) {
    return defaultStorefrontLoader(gender);
  }
  let loader = loaderByDeps.get(deps);
  if (!loader) {
    loader = createStorefront(deps);
    loaderByDeps.set(deps, loader);
  }
  return loader(gender);
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
