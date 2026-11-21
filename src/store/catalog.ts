import type { Gender, Item, SearchResult } from '../types.ts';
import type { ShopMcpClient } from './shopmcp.ts';
import type { SavedStore } from './saved.ts';
import { shopMcp } from './shopmcp.ts';
import { savedStore, savedKey } from './saved.ts';
import { ALL_SITES, storeNameForDomain } from './stores.ts';
import { logEvent } from './log.ts';
import {
  detectShoeLabelSystem,
  matchSizeDetail,
  parseWaistInseam,
} from './sizing.ts';

export const CONTEXT = { currency: 'USD', address_country: 'US' } as const;

export interface ProductOptionValue {
  label: string;
  available: boolean;
  exists: boolean;
}

export interface ProductOption {
  name: string;
  values: ProductOptionValue[];
}

export interface ProductSelection {
  name: string;
  label: string;
}

export interface ProductDetailVariant {
  id: string;
  price: number;
  available: boolean;
  options: ProductSelection[];
  url: string;
}

export interface ProductDetail {
  id: string;
  title: string;
  description: string;
  description_html: string;
  images: string[];
  options: ProductOption[];
  selected: ProductSelection[];
  variant: ProductDetailVariant;
}

export interface SearchOpts {
  limit?: number;
  maxPrice?: number;
  shops?: string[];
}

export interface LookupEntry {
  item: Item | null;
  available: boolean;
  price: number | null;
}

export interface SizeVariantResult {
  ok: boolean;
  variant_id: string | null;
  size: string | null;
  length?: string | null;
  available: boolean;
  sizes_available: string[];
  nearest: string | null;
  reason?: string;
  note?: string;
}

export interface SizeVariantOpts {
  gender?: Gender;
  inseam?: string;
  slot?: string;
}

export interface CatalogClient {
  search(query: string, gender: Gender, opts?: SearchOpts): Promise<SearchResult>;
  lookup(ids: string[]): Promise<Map<string, LookupEntry>>;
  getProduct(id: string, selections?: ProductSelection[]): Promise<ProductDetail | null>;
  productImages(item: Item): Promise<string[]>;
  sizeVariant(variantId: string, size: string, opts?: SizeVariantOpts): Promise<SizeVariantResult>;
}

const FRESH_SAVED_MS = 60 * 60 * 1000;
const LOOKUP_BATCH_SIZE = 10;
const GET_PRODUCT_TIMEOUT_MS = 3000;

export type SavedMode = 'fallback' | 'fresh' | 'off';

export function getSavedMode(raw: string | undefined = process.env.ALICE_SAVED): SavedMode {
  const norm = (raw ?? '').trim().toLowerCase();
  if (norm === 'fresh' || norm === 'off' || norm === 'fallback') {
    return norm;
  }
  return 'fallback';
}

const WRONG_FOR_MEN_RE =
  /\bwomen'?s?\b|\bwomens[-\s]|\bladies\b|\bgirls?\b|\bmaternity\b|\bbralette\b|\bskirt\b/;
const WRONG_FOR_WOMEN_RE = /(^|[^a-z])men'?s\b|(^|[-/\s])mens[-\s]|\bboys?\b/;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
};

const LETTER_SIZE_RANK: Record<string, number> = {
  XXS: 0,
  '2XS': 0,
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
  '1X': 5.5,
  XXL: 6,
  '2XL': 6,
  '2X': 6,
  XXXL: 7,
  '3XL': 7,
  '3X': 7,
};

function stripHtmlAndDecode(raw: string, maxChars: number): string {
  if (!raw) return '';
  let text = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr|td|th|section|article)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|quot|#39|apos|nbsp|lt|gt);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    text = slice.slice(0, lastSpace).trimEnd();
  } else {
    text = slice.trimEnd();
  }
  return text;
}

function cleanImageUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(?:width|height)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function stripQuery(rawUrl: string): string {
  const idx = rawUrl.indexOf('?');
  return idx === -1 ? rawUrl : rawUrl.slice(0, idx);
}

function firstImageFromMedia(media: unknown): string {
  if (!Array.isArray(media)) return '';
  for (const m of media) {
    if (!m || typeof m !== 'object') continue;
    const type = (m as { type?: unknown }).type;
    const url = (m as { url?: unknown }).url;
    if ((!type || type === 'image') && typeof url === 'string' && url.length > 0) {
      return cleanImageUrl(url);
    }
  }
  return '';
}

function findSizeOption(options: unknown): { name: string; values?: unknown[] } | undefined {
  if (!Array.isArray(options)) return undefined;
  const preferred = options.find(
    (o) => o && typeof o === 'object' && typeof (o as { name?: unknown }).name === 'string' && /size/i.test((o as { name: string }).name),
  );
  if (preferred) return preferred as { name: string; values?: unknown[] };
  const fallback = options.find(
    (o) =>
      o &&
      typeof o === 'object' &&
      typeof (o as { name?: unknown }).name === 'string' &&
      /waist|length/i.test((o as { name: string }).name),
  );
  return fallback as { name: string; values?: unknown[] } | undefined;
}

function findVariantSizeOption(
  variantOptions: unknown,
  preferredName?: string,
): { name: string; label: string } | undefined {
  if (!Array.isArray(variantOptions)) return undefined;
  const list = variantOptions.filter(
    (o): o is { name: string; label: string } =>
      Boolean(o) &&
      typeof o === 'object' &&
      typeof (o as { name?: unknown }).name === 'string' &&
      typeof (o as { label?: unknown }).label === 'string' &&
      (o as { label: string }).label.trim().length > 0,
  );

  if (preferredName) {
    const exact = list.find((o) => o.name.toLowerCase() === preferredName.toLowerCase());
    if (exact) return exact;
  }
  return (
    list.find((o) => /size/i.test(o.name)) ??
    list.find((o) => /waist|length/i.test(o.name))
  );
}

function toFiniteNumberOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toItemFromVariant(product: any, variant: any, gender: Gender): Item | null {
  if (!product || typeof product !== 'object' || !variant || typeof variant !== 'object') {
    return null;
  }

  if (variant.availability?.available === false) {
    return null;
  }

  const currency = variant.price?.currency;
  const amountCents = Number(variant.price?.amount);
  if (currency !== 'USD' || !Number.isFinite(amountCents) || amountCents <= 0) {
    return null;
  }

  const id = typeof product.id === 'string' ? product.id : '';
  const variant_id = typeof variant.id === 'string' ? variant.id : '';
  if (!id || !variant_id) return null;

  const title = String(product.title ?? variant.title ?? '').trim();
  const price = amountCents / 100;
  const url = typeof variant.url === 'string' ? variant.url : String(variant.url ?? '');
  const image = firstImageFromMedia(variant.media) || firstImageFromMedia(product.media);
  const store_domain = String(variant.seller?.domain ?? '');
  const store = storeNameForDomain(store_domain, variant.seller?.name);
  const rating = toFiniteNumberOrNull(product.rating?.value);
  const rating_count = toFiniteNumberOrNull(product.rating?.count);

  const sizeOpt = findSizeOption(product.options);
  const sizes: string[] = Array.isArray(sizeOpt?.values)
    ? sizeOpt.values
        .map((val) =>
          val && typeof val === 'object' && typeof (val as { label?: unknown }).label === 'string'
            ? (val as { label: string }).label
            : '',
        )
        .filter(Boolean)
    : [];

  const variantSizeOpt = findVariantSizeOption(variant.options, sizeOpt?.name);
  const variants_by_size: Record<string, string> = variantSizeOpt
    ? { [variantSizeOpt.label]: variant_id }
    : {};

  const rawDesc = String(product.description?.plain ?? variant.description?.plain ?? '');
  const description = stripHtmlAndDecode(rawDesc, 300);

  return {
    id,
    variant_id,
    title,
    price,
    url,
    image,
    store,
    store_domain,
    rating,
    rating_count,
    sizes,
    variants_by_size,
    description,
    department: gender,
  };
}

export function toItem(product: any, gender: Gender): Item | null {
  const variant = Array.isArray(product?.variants) ? product.variants[0] : null;
  if (!variant) return null;
  return toItemFromVariant(product, variant, gender);
}

export function wrongDepartment(product: any, gender: Gender): boolean {
  const title = typeof product?.title === 'string' ? product.title : '';
  const handle = typeof product?.handle === 'string' ? product.handle : '';
  const rawUrl =
    typeof product?.variants?.[0]?.url === 'string'
      ? product.variants[0].url
      : typeof product?.url === 'string'
        ? product.url
        : '';

  let urlPath = rawUrl;
  if (rawUrl) {
    try {
      urlPath = new URL(rawUrl).pathname;
    } catch {
      urlPath = rawUrl;
    }
  }

  const haystack = `${title} ${handle} ${urlPath}`.toLowerCase();
  if (gender === 'men') {
    return WRONG_FOR_MEN_RE.test(haystack);
  }
  return WRONG_FOR_WOMEN_RE.test(haystack);
}

function parseNumericSize(label: string): number | null {
  const trimmed = label.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseLetterSizeRank(label: string): number | null {
  const upper = label.trim().toUpperCase();
  if (upper in LETTER_SIZE_RANK) return LETTER_SIZE_RANK[upper];
  const paren = upper.match(/\(([^)]+)\)\s*$/);
  if (paren && paren[1]) {
    const code = paren[1].trim();
    if (code in LETTER_SIZE_RANK) return LETTER_SIZE_RANK[code];
  }
  return null;
}

function matchSizeLabel(
  requested: string,
  values: ProductOptionValue[],
): ProductOptionValue | undefined {
  const reqNorm = requested.trim().toUpperCase();
  if (!reqNorm) return undefined;

  const exact = values.find((v) => v.label.trim().toUpperCase() === reqNorm);
  if (exact) return exact;

  const reqNum = parseNumericSize(requested);
  if (reqNum !== null) {
    const numMatch = values.find((v) => {
      const valNum = parseNumericSize(v.label);
      return valNum !== null && valNum === reqNum;
    });
    if (numMatch) return numMatch;
  }

  const parenMatch = values.find((v) => {
    const m = v.label.trim().match(/^(.+?)\s*\(([^)]+)\)$/);
    if (!m) return false;
    return m[1].trim().toUpperCase() === reqNorm || m[2].trim().toUpperCase() === reqNorm;
  });
  return parenMatch;
}

function findNearestAvailableSize(
  targetLabel: string,
  allValues: ProductOptionValue[],
): string | null {
  const available = allValues.filter((v) => v.available).map((v) => v.label);
  if (available.length === 0) return null;

  const targetNum = parseNumericSize(targetLabel);
  if (targetNum !== null) {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const label of available) {
      const n = parseNumericSize(label);
      if (n === null) continue;
      const dist = Math.abs(n - targetNum);
      if (dist < bestDist) {
        bestDist = dist;
        best = label;
      }
    }
    if (best !== null) return best;
  }

  const targetRank = parseLetterSizeRank(targetLabel);
  if (targetRank !== null) {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const label of available) {
      const r = parseLetterSizeRank(label);
      if (r === null) continue;
      const dist = Math.abs(r - targetRank);
      if (dist < bestDist) {
        bestDist = dist;
        best = label;
      }
    }
    if (best !== null) return best;
  }

  const targetIdx = allValues.findIndex(
    (v) => v.label.trim().toUpperCase() === targetLabel.trim().toUpperCase(),
  );
  if (targetIdx !== -1) {
    let best: string | null = null;
    let bestDist = Infinity;
    allValues.forEach((v, idx) => {
      if (!v.available) return;
      const dist = Math.abs(idx - targetIdx);
      if (dist < bestDist) {
        bestDist = dist;
        best = v.label;
      }
    });
    if (best !== null) return best;
  }

  return available[0] ?? null;
}

export function createCatalog(deps?: {
  mcp?: ShopMcpClient;
  saved?: SavedStore;
  now?: () => number;
}): CatalogClient {
  const mcp = deps?.mcp ?? shopMcp;
  const saved = deps?.saved ?? savedStore;
  const now = deps?.now ?? (() => Date.now());
  let modeLogged = false;

  async function search(
    query: string,
    gender: Gender,
    opts?: SearchOpts,
  ): Promise<SearchResult> {
    const t0 = now();
    const mode = getSavedMode();
    if (!modeLogged) {
      modeLogged = true;
      console.log(`[store] saved results mode: ${mode}`);
    }
    const shops = opts?.shops ?? ALL_SITES;
    const limit = Math.min(opts?.limit ?? 24, 50);
    const maxPrice = opts?.maxPrice;
    const key = savedKey(query, gender, { shops, maxPrice, limit });

    const existing = mode === 'fresh' ? saved.getSaved(key) : undefined;
    if (mode === 'fresh' && existing && now() - existing.t < FRESH_SAVED_MS) {
      const ms = Math.max(0, now() - t0);
      console.log(`[store] search "${query}" ${gender} saved ${existing.items.length} items ${ms}ms`);
      logEvent('store_search', { query, gender, source: 'saved', n: existing.items.length, ms });
      return { items: existing.items, source: 'saved', ms };
    }

    try {
      const filters: Record<string, unknown> = {
        shops,
        attributes: [{ name: 'Target gender', values: [gender === 'men' ? 'Male' : 'Female'] }],
        available: true,
        ...(maxPrice ? { price: { max: Math.round(maxPrice * 100) } } : {}),
      };

      const data = await mcp.call('search_catalog', {
        catalog: {
          query,
          filters,
          context: CONTEXT,
          pagination: { limit },
        },
      });

      const rawProducts = Array.isArray(data?.products) ? data.products : [];
      const items: Item[] = [];
      for (const product of rawProducts) {
        if (wrongDepartment(product, gender)) continue;
        const mapped = toItem(product, gender);
        if (!mapped) continue;
        if (maxPrice !== undefined && mapped.price > maxPrice) continue;
        items.push(mapped);
      }

      const ms = Math.max(0, now() - t0);
      if (items.length > 0) {
        if (mode !== 'off') {
          saved.putSaved(key, query, gender, items);
        }
        console.log(`[store] search "${query}" ${gender} live ${items.length} items ${ms}ms`);
        logEvent('store_search', { query, gender, source: 'live', n: items.length, ms });
        return { items, source: 'live', ms };
      }

      console.log(`[store] search "${query}" ${gender} empty 0 items ${ms}ms`);
      logEvent('store_search', { query, gender, source: 'empty', n: 0, ms });
      return { items: [], source: 'empty', ms };
    } catch {
      const ms = Math.max(0, now() - t0);
      if (mode !== 'off') {
        const fallbackExact = existing ?? saved.getSaved(key);
        if (fallbackExact) {
          console.log(
            `[store] search "${query}" ${gender} saved ${fallbackExact.items.length} items ${ms}ms`,
          );
          logEvent('store_search', {
            query,
            gender,
            source: 'saved',
            n: fallbackExact.items.length,
            ms,
          });
          return { items: fallbackExact.items, source: 'saved', ms };
        }
        const near = saved.nearestSaved(query, gender);
        if (near) {
          console.log(
            `[store] search "${query}" ${gender} saved-near ${near.items.length} items ${ms}ms`,
          );
          logEvent('store_search', { query, gender, source: 'saved-near', n: near.items.length, ms });
          return { items: near.items, source: 'saved-near', ms };
        }
      }
      console.log(`[store] search "${query}" ${gender} empty 0 items ${ms}ms`);
      logEvent('store_search', { query, gender, source: 'empty', n: 0, ms });
      return { items: [], source: 'empty', ms };
    }
  }

  async function lookup(ids: string[]): Promise<Map<string, LookupEntry>> {
    const t0 = now();
    const out = new Map<string, LookupEntry>();
    const uniqueIds = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim())));
    if (uniqueIds.length === 0) return out;

    const batches: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += LOOKUP_BATCH_SIZE) {
      batches.push(uniqueIds.slice(i, i + LOOKUP_BATCH_SIZE));
    }

    await Promise.all(
      batches.map(async (batch) => {
        try {
          const data = await mcp.call('lookup_catalog', {
            catalog: { ids: batch, context: CONTEXT },
          });
          const products = Array.isArray(data?.products) ? data.products : [];
          for (const product of products) {
            const gender: Gender = wrongDepartment(product, 'men') ? 'women' : 'men';
            const variants = Array.isArray(product?.variants) ? product.variants : [];

            let productEntry: LookupEntry | null = null;
            for (const variant of variants) {
              const available = Boolean(variant?.availability?.available);
              const amountCents = Number(variant?.price?.amount);
              const price =
                variant?.price?.currency === 'USD' &&
                Number.isFinite(amountCents) &&
                amountCents > 0
                  ? amountCents / 100
                  : null;
              const item = toItemFromVariant(product, variant, gender);
              const entry: LookupEntry = { item, available, price };
              if (!productEntry) productEntry = entry;
              if (typeof variant?.id === 'string' && variant.id) {
                out.set(variant.id, entry);
              }
            }

            if (typeof product?.id === 'string' && product.id && productEntry) {
              out.set(product.id, productEntry);
            }
          }
        } catch {
          // Never throw; missing ids are simply absent
        }
      }),
    );

    const ms = Math.max(0, now() - t0);
    console.log(`[store] lookup ${uniqueIds.length} ids -> ${out.size} keys ${ms}ms`);
    return out;
  }

  async function getProduct(
    id: string,
    selections?: ProductSelection[],
  ): Promise<ProductDetail | null> {
    try {
      const catalogArgs: Record<string, unknown> = {
        id,
        context: CONTEXT,
        ...(selections?.length ? { selected: selections } : {}),
      };
      const data = await mcp.call(
        'get_product',
        { catalog: catalogArgs },
        { timeoutMs: GET_PRODUCT_TIMEOUT_MS },
      );

      const product = data?.product;
      const variant = Array.isArray(product?.variants) ? product.variants[0] : null;
      if (!product?.id || !variant?.id) return null;

      const seen = new Set<string>();
      const images: string[] = [];
      const addMedia = (mediaList: unknown): void => {
        if (!Array.isArray(mediaList)) return;
        for (const m of mediaList) {
          if (!m || typeof m !== 'object') continue;
          const type = (m as { type?: unknown }).type;
          const url = (m as { url?: unknown }).url;
          if ((!type || type === 'image') && typeof url === 'string' && url.length > 0) {
            const cleaned = cleanImageUrl(url);
            const dedupKey = stripQuery(cleaned);
            if (!seen.has(dedupKey)) {
              seen.add(dedupKey);
              images.push(cleaned);
            }
          }
        }
      };

      addMedia(variant.media);
      addMedia(product.media);

      const options: ProductOption[] = Array.isArray(product.options)
        ? product.options.map((o: any) => ({
            name: String(o?.name ?? ''),
            values: Array.isArray(o?.values)
              ? o.values.map((val: any) => ({
                  label: String(val?.label ?? ''),
                  available: Boolean(val?.available),
                  exists: val?.exists !== undefined ? Boolean(val.exists) : true,
                }))
              : [],
          }))
        : [];

      const selected: ProductSelection[] = Array.isArray(product.selected)
        ? product.selected.map((s: any) => ({
            name: String(s?.name ?? ''),
            label: String(s?.label ?? ''),
          }))
        : [];

      const variantOptions: ProductSelection[] = Array.isArray(variant.options)
        ? variant.options.map((o: any) => ({
            name: String(o?.name ?? ''),
            label: String(o?.label ?? ''),
          }))
        : [];

      const rawPlain = String(product.description?.plain ?? variant.description?.plain ?? '');
      const rawHtml = String(
        product.description?.html ??
          product.description?.plain ??
          variant.description?.html ??
          variant.description?.plain ??
          '',
      );
      const amountCents = Number(variant.price?.amount);
      const price = Number.isFinite(amountCents) ? amountCents / 100 : 0;

      return {
        id: String(product.id),
        title: String(product.title ?? variant.title ?? ''),
        description: stripHtmlAndDecode(rawPlain, 700),
        description_html: rawHtml,
        images,
        options,
        selected,
        variant: {
          id: String(variant.id),
          price,
          available: Boolean(variant.availability?.available),
          options: variantOptions,
          url: typeof variant.url === 'string' ? variant.url : String(variant.url ?? ''),
        },
      };
    } catch {
      return null;
    }
  }

  async function productImages(item: Item): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const pushUrl = (raw: string): void => {
      if (!raw || out.length >= 8) return;
      const cleaned = cleanImageUrl(raw);
      const key = stripQuery(cleaned);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(cleaned);
      }
    };

    if (item.image) {
      pushUrl(item.image);
    }

    try {
      const detail = await getProduct(item.variant_id);
      if (detail) {
        for (const img of detail.images) {
          pushUrl(img);
        }
      }
    } catch {
      // ignore
    }

    return out;
  }

function extractFirstNumber(label: string): number | null {
  const m = label.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pickBestLengthLabel(
  values: ProductOptionValue[],
  gender?: Gender,
  requestedInseam?: string,
): ProductOptionValue | undefined {
  if (values.length === 0) return undefined;
  const avail = values.filter((v) => v.available);
  const pool = avail.length > 0 ? avail : values;

  if (requestedInseam) {
    const reqNum = extractFirstNumber(requestedInseam);
    if (reqNum !== null) {
      const exact = pool.find((v) => extractFirstNumber(v.label) === reqNum);
      if (exact) return exact;
    }
    const reqNorm = requestedInseam.trim().toUpperCase();
    const exactText = pool.find((v) => v.label.trim().toUpperCase() === reqNorm);
    if (exactText) return exactText;
  }

  const target = gender === 'women' ? 30 : 32;
  let bestNum: ProductOptionValue | undefined;
  let bestDist = Infinity;
  for (const v of pool) {
    const n = extractFirstNumber(v.label);
    if (n === null) continue;
    const dist = Math.abs(n - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestNum = v;
    }
  }
  if (bestNum) return bestNum;

  const regular = pool.find((v) => /\b(?:regular|reg|standard|medium)\b/i.test(v.label));
  return regular ?? pool[0];
}

function matchCompanionSizeValue(
  primaryLabel: string,
  values: ProductOptionValue[],
): ProductOptionValue | undefined {
  const exact = matchSizeLabel(primaryLabel, values);
  if (exact) return exact;
  const num = extractFirstNumber(primaryLabel);
  if (num !== null) {
    const usMatch = values.find(
      (v) => extractFirstNumber(v.label) === num && /\bUS\b/i.test(v.label),
    );
    if (usMatch) return usMatch;
    const anyNum = values.find((v) => extractFirstNumber(v.label) === num);
    if (anyNum) return anyNum;
  }
  return undefined;
}

  async function sizeVariant(
    variantId: string,
    size: string,
    opts?: SizeVariantOpts,
  ): Promise<SizeVariantResult> {
    try {
      const initial = await getProduct(variantId);
      if (!initial) {
        return {
          ok: false,
          variant_id: null,
          size: null,
          available: false,
          sizes_available: [],
          nearest: null,
          reason: 'could not load product details',
        };
      }

      const sizeOption =
        initial.options.find((o) => /size/i.test(o.name)) ??
        initial.options.find((o) => /waist/i.test(o.name));

      if (!sizeOption) {
        return {
          ok: false,
          variant_id: initial.variant.id,
          size: null,
          available: initial.variant.available,
          sizes_available: [],
          nearest: null,
          reason: 'product has no size option',
        };
      }

      const initialAvailable = sizeOption.values.filter((v) => v.available).map((v) => v.label);
      const allOptionLabels = sizeOption.values.map((v) => v.label);

      // Parse waist+inseam if shopper passed combined input like "30x34" or "30 waist, 34 inseam"
      const parsedWxL = parseWaistInseam(size);
      const effectiveInseam = opts?.inseam ?? parsedWxL?.inseamStr;

      // Detect whether this product option represents shoes (by slot, option name, or EU shoe range)
      const inferredSlot =
        opts?.slot ??
        (/shoe/i.test(sizeOption.name) ||
        (detectShoeLabelSystem(allOptionLabels) === 'EU' && !/waist/i.test(sizeOption.name))
          ? 'shoes'
          : /waist/i.test(sizeOption.name)
            ? 'bottom'
            : undefined);

      let matched = matchSizeLabel(size, sizeOption.values);
      let matchNote: string | undefined;
      let matchSoldOutReason: string | undefined;
      let matchNearest: string | null = null;

      if (!matched) {
        const detailMatch = matchSizeDetail(size, allOptionLabels, {
          slot: inferredSlot,
          gender: opts?.gender,
          available: initialAvailable,
        });
        matchNote = detailMatch.note;
        matchSoldOutReason = detailMatch.soldOutReason;
        matchNearest = detailMatch.nearest ?? null;
        if (detailMatch.label) {
          matched = sizeOption.values.find((v) => v.label === detailMatch.label);
        }
      }

      if (!matched) {
        if (matchSoldOutReason) {
          return {
            ok: false,
            variant_id: null,
            size: null,
            available: false,
            sizes_available: initialAvailable,
            nearest: matchNearest,
            reason: matchSoldOutReason,
          };
        }
        const offered = sizeOption.values.map((v) => v.label.trim()).join(', ');
        return {
          ok: false,
          variant_id: null,
          size: null,
          available: false,
          sizes_available: initialAvailable,
          nearest: null,
          reason: `${size} is not offered (sizes: ${offered})`,
        };
      }

      if (!matched.available || !matched.exists) {
        const nearest = findNearestAvailableSize(matched.label, sizeOption.values);
        const availText = initialAvailable.map((l) => l.trim()).join(', ');
        const reason = availText
          ? `${matched.label.trim()} is sold out (sizes left: ${availText})`
          : `${matched.label.trim()} is sold out`;
        return {
          ok: false,
          variant_id: null,
          size: matched.label,
          available: false,
          sizes_available: initialAvailable,
          nearest,
          reason,
        };
      }

      // Detect secondary length/inseam option (e.g., separate "Length" or "Inseam")
      // or a companion size option only when it actually has available values and is part of selected.
      const baseSelections =
        initial.selected.length > 0 ? initial.selected : initial.variant.options;
      const selectedNames = new Set(baseSelections.map((s) => s.name.trim().toLowerCase()));

      const lengthOption = initial.options.find(
        (o) =>
          o.name.trim().toLowerCase() !== sizeOption.name.trim().toLowerCase() &&
          /length|inseam/i.test(o.name) &&
          o.values.some((v) => v.available),
      );
      const matchedLength = lengthOption
        ? pickBestLengthLabel(lengthOption.values, opts?.gender, effectiveInseam)
        : undefined;

      // Check if shopper wanted a specific inseam that isn't offered in lengthOption
      let inseamNote: string | undefined;
      if (effectiveInseam && lengthOption && matchedLength) {
        const reqLenNum = extractFirstNumber(effectiveInseam);
        const gotLenNum = extractFirstNumber(matchedLength.label);
        const exactText =
          matchedLength.label.trim().toUpperCase() === effectiveInseam.trim().toUpperCase();
        if (!exactText && (reqLenNum === null || gotLenNum === null || reqLenNum !== gotLenNum)) {
          inseamNote = `${effectiveInseam.trim()} inseam isn't offered; used ${matchedLength.label.trim()}`;
        }
      }

      // Fast path: if the requested size (and wanted inseam, if any) is already selected on an
      // available initial variant, return it directly without an extra round-trip.
      const initialSizeSel = baseSelections.find(
        (s) => s.name.trim().toLowerCase() === sizeOption.name.trim().toLowerCase(),
      );
      const initialLenSel = lengthOption
        ? baseSelections.find(
            (s) => s.name.trim().toLowerCase() === lengthOption.name.trim().toLowerCase(),
          )
        : undefined;
      const lengthAlreadyMatches =
        !effectiveInseam ||
        !lengthOption ||
        !matchedLength ||
        (initialLenSel &&
          initialLenSel.label.trim().toUpperCase() === matchedLength.label.trim().toUpperCase());

      if (
        lengthAlreadyMatches &&
        initial.variant.available &&
        initialSizeSel &&
        initialSizeSel.label.trim().toUpperCase() === matched.label.trim().toUpperCase()
      ) {
        const combinedNote = [matchNote, inseamNote].filter(Boolean).join('; ') || undefined;
        return {
          ok: true,
          variant_id: initial.variant.id,
          size: matched.label,
          ...(initialLenSel ? { length: initialLenSel.label } : {}),
          available: true,
          sizes_available: initialAvailable,
          nearest: null,
          ...(combinedNote ? { note: combinedNote } : {}),
        };
      }

      const canonicalOptionLabel = (optName: string, rawLabel: string): string => {
        const opt = initial.options.find(
          (o) => o.name.trim().toLowerCase() === optName.trim().toLowerCase(),
        );
        if (!opt) return rawLabel;
        const exact = opt.values.find((v) => v.label === rawLabel);
        if (exact) return exact.label;
        const trimmedMatch = opt.values.find(
          (v) => v.label.trim().toUpperCase() === rawLabel.trim().toUpperCase(),
        );
        return trimmedMatch ? trimmedMatch.label : rawLabel;
      };

      const companionSizeOption = initial.options.find(
        (o) =>
          o.name.trim().toLowerCase() !== sizeOption.name.trim().toLowerCase() &&
          (!lengthOption || o.name.trim().toLowerCase() !== lengthOption.name.trim().toLowerCase()) &&
          /size/i.test(o.name) &&
          selectedNames.has(o.name.trim().toLowerCase()) &&
          o.values.some((v) => v.available),
      );
      const matchedCompanion = companionSizeOption
        ? matchCompanionSizeValue(matched.label, companionSizeOption.values)
        : undefined;

      const buildNextSelections = (overrideLength?: ProductSelection): ProductSelection[] => {
        const desiredByName = new Map<string, ProductSelection>();
        desiredByName.set(sizeOption.name.trim().toLowerCase(), {
          name: sizeOption.name,
          label: matched!.label,
        });
        if (overrideLength) {
          desiredByName.set(overrideLength.name.trim().toLowerCase(), overrideLength);
        } else if (lengthOption && matchedLength) {
          desiredByName.set(lengthOption.name.trim().toLowerCase(), {
            name: lengthOption.name,
            label: matchedLength.label,
          });
        }
        if (companionSizeOption && matchedCompanion && matchedCompanion.available) {
          desiredByName.set(companionSizeOption.name.trim().toLowerCase(), {
            name: companionSizeOption.name,
            label: matchedCompanion.label,
          });
        }

        // Preserve non-size options (e.g. Color "Olive ") first so Shop MCP relaxes size/length before color
        const applied = new Set<string>();
        const nonSize: ProductSelection[] = [];
        const sizeLike: ProductSelection[] = [];
        for (const sel of baseSelections) {
          const key = sel.name.trim().toLowerCase();
          const desired = desiredByName.get(key);
          if (desired) {
            applied.add(key);
            sizeLike.push(desired);
          } else {
            nonSize.push({ name: sel.name, label: canonicalOptionLabel(sel.name, sel.label) });
          }
        }
        for (const [key, desired] of desiredByName.entries()) {
          if (!applied.has(key)) {
            sizeLike.push(desired);
          }
        }
        return [...nonSize, ...sizeLike];
      };

      const nextSelections = buildNextSelections();

      // Pass the PRODUCT id (initial.id), NOT variantId, so selected options take effect.
      let updated = await getProduct(initial.id, nextSelections);
      if (!updated) {
        return {
          ok: false,
          variant_id: null,
          size: matched.label,
          available: false,
          sizes_available: initialAvailable,
          nearest: null,
          reason: `could not select size ${size}`,
        };
      }

      const hasKeptSize = (detail: ProductDetail): boolean => {
        const kept = detail.selected.find(
          (s) => s.name.trim().toLowerCase() === sizeOption.name.trim().toLowerCase(),
        );
        return Boolean(
          kept && kept.label.trim().toUpperCase() === matched!.label.trim().toUpperCase(),
        );
      };

      // If switching to preferred/requested length caused the server to drop the size (or variant
      // unavailable in that length), retry once with the nearest alternative available length.
      if ((!hasKeptSize(updated) || !updated.variant.available) && lengthOption && matchedLength) {
        const altLengths = lengthOption.values
          .filter(
            (v) =>
              v.available &&
              v.label.trim().toUpperCase() !== matchedLength.label.trim().toUpperCase(),
          )
          .sort((a, b) => {
            const target = effectiveInseam
              ? (extractFirstNumber(effectiveInseam) ?? (opts?.gender === 'women' ? 30 : 32))
              : opts?.gender === 'women'
                ? 30
                : 32;
            const da = Math.abs((extractFirstNumber(a.label) ?? target) - target);
            const db = Math.abs((extractFirstNumber(b.label) ?? target) - target);
            return da - db;
          });
        const fallbackLen =
          altLengths[0] ??
          (initialLenSel &&
          initialLenSel.label.trim().toUpperCase() !== matchedLength.label.trim().toUpperCase()
            ? { label: canonicalOptionLabel(lengthOption.name, initialLenSel.label) }
            : undefined);

        if (fallbackLen) {
          const retry = await getProduct(
            initial.id,
            buildNextSelections({
              name: lengthOption.name,
              label: fallbackLen.label,
            }),
          );
          if (retry && hasKeptSize(retry) && retry.variant.available) {
            updated = retry;
            if (effectiveInseam) {
              inseamNote = `${effectiveInseam.trim()} inseam isn't offered; used ${fallbackLen.label.trim()}`;
            }
          }
        }
      }

      const updatedSizeOption =
        updated.options.find(
          (o) => o.name.trim().toLowerCase() === sizeOption.name.trim().toLowerCase(),
        ) ?? sizeOption;
      const sizesAvailable = updatedSizeOption.values
        .filter((v) => v.available)
        .map((v) => v.label);

      if (!hasKeptSize(updated)) {
        return {
          ok: false,
          variant_id: null,
          size: matched.label,
          available: false,
          sizes_available: sizesAvailable,
          nearest: null,
          reason: `could not select size ${size}`,
        };
      }

      if (!updated.variant.available) {
        const nearest = findNearestAvailableSize(matched.label, updatedSizeOption.values);
        const reason = nearest
          ? `${matched.label} is sold out; nearest ${nearest}`
          : `${matched.label} is sold out`;
        return {
          ok: false,
          variant_id: updated.variant.id,
          size: matched.label,
          available: false,
          sizes_available: sizesAvailable,
          nearest,
          reason,
        };
      }

      const finalLenSel = lengthOption
        ? updated.selected.find(
            (s) => s.name.trim().toLowerCase() === lengthOption.name.trim().toLowerCase(),
          )
        : undefined;
      if (effectiveInseam && finalLenSel && !inseamNote) {
        const reqLenNum = extractFirstNumber(effectiveInseam);
        const gotLenNum = extractFirstNumber(finalLenSel.label);
        if (reqLenNum !== null && gotLenNum !== null && reqLenNum !== gotLenNum) {
          inseamNote = `${effectiveInseam.trim()} inseam isn't offered; used ${finalLenSel.label.trim()}`;
        }
      }

      const combinedNote = [matchNote, inseamNote].filter(Boolean).join('; ') || undefined;
      return {
        ok: true,
        variant_id: updated.variant.id,
        size: matched.label,
        ...(finalLenSel ? { length: finalLenSel.label } : {}),
        available: true,
        sizes_available: sizesAvailable,
        nearest: null,
        ...(combinedNote ? { note: combinedNote } : {}),
      };
    } catch {
      return {
        ok: false,
        variant_id: null,
        size: null,
        available: false,
        sizes_available: [],
        nearest: null,
        reason: `could not select size ${size}`,
      };
    }
  }

  return {
    search,
    lookup,
    getProduct,
    productImages,
    sizeVariant,
  };
}

const defaultCatalog = createCatalog();

export const search = defaultCatalog.search;
export const lookup = defaultCatalog.lookup;
export const getProduct = defaultCatalog.getProduct;
export const productImages = defaultCatalog.productImages;
export const sizeVariant = defaultCatalog.sizeVariant;
