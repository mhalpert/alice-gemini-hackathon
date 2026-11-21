import crypto from 'node:crypto';
import type {
  BagLine,
  BagLink,
  BagOut,
  BagStore,
  Gender,
  Item,
  Outfit,
  PageActions,
  Piece,
} from '../types.ts';
import type { BagLineAdded, BagLineNotAdded } from './bag.ts';
import type { ProductDetail } from './catalog.ts';
import { STORES } from './stores.ts';
import type { CuratedStore } from './stores.ts';

export const MAX_BAG_PIECES = 8;
export const MAX_BAG_SIZES = 8;
export const MAX_BAG_GID_LEN = 120;
export const MAX_BAG_FIELD_LEN = 40;

const BAG_SHOPIFY_GID_RE = /^gid:\/\/shopify\/[A-Za-z0-9_/-]+$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ValidatedBagPieceInput {
  index: number;
  slot: string;
  lookupId: string;
}

export interface ValidatedBagRequest {
  department: Gender;
  pieces: ValidatedBagPieceInput[];
  sizes: Record<string, string>;
}

export type ValidateBagRequestResult =
  | { ok: true; value: ValidatedBagRequest }
  | { ok: false; problems: string[] };

export function isValidBagShopifyGid(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= MAX_BAG_GID_LEN &&
    BAG_SHOPIFY_GID_RE.test(raw)
  );
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

/**
 * Validates and extracts ONLY safe identifiers (`department`, per-piece `slot` and Shopify GID,
 * and bounded `sizes` strings) from an untrusted POST /api/bag body.
 * Client prices, titles, links, images, and store domains are ignored completely.
 */
export function validateBagRequest(raw: unknown): ValidateBagRequestResult {
  const problems: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, problems: ['body must be a JSON object'] };
  }

  const departmentRaw = raw.department;
  const department: Gender | null =
    departmentRaw === 'men' || departmentRaw === 'women' ? departmentRaw : null;
  if (!department) {
    problems.push("department must be 'men' or 'women'");
  }

  const outfitRaw = raw.outfit;
  const validatedPieces: ValidatedBagPieceInput[] = [];
  if (!isPlainObject(outfitRaw) || !Array.isArray(outfitRaw.pieces)) {
    problems.push('outfit.pieces must be an array');
  } else {
    const piecesArr = outfitRaw.pieces;
    if (piecesArr.length === 0 || piecesArr.length > MAX_BAG_PIECES) {
      problems.push(`outfit.pieces must have between 1 and ${MAX_BAG_PIECES} pieces`);
    } else {
      for (let i = 0; i < piecesArr.length; i += 1) {
        const piece = piecesArr[i];
        if (!isPlainObject(piece)) {
          problems.push(`piece[${i}] must be an object`);
          continue;
        }
        const rawSlot = piece.slot;
        const slot = typeof rawSlot === 'string' ? rawSlot.trim() : '';
        if (!slot || slot.length > MAX_BAG_FIELD_LEN) {
          problems.push(`piece[${i}].slot must be a non-empty string of at most ${MAX_BAG_FIELD_LEN} characters`);
        }

        const item = piece.item;
        if (!isPlainObject(item)) {
          problems.push(`piece[${i}].item must be an object`);
          continue;
        }

        const hasVariantId = item.variant_id !== undefined && item.variant_id !== null && item.variant_id !== '';
        const hasProductId = item.id !== undefined && item.id !== null && item.id !== '';
        if (!hasVariantId && !hasProductId) {
          problems.push(`piece[${i}].item must include a Shopify gid in variant_id or id`);
          continue;
        }

        let idsOk = true;
        if (hasVariantId && !isValidBagShopifyGid(item.variant_id)) {
          problems.push(
            `piece[${i}].item.variant_id must be a valid Shopify gid of at most ${MAX_BAG_GID_LEN} characters`,
          );
          idsOk = false;
        }
        if (hasProductId && !isValidBagShopifyGid(item.id)) {
          problems.push(
            `piece[${i}].item.id must be a valid Shopify gid of at most ${MAX_BAG_GID_LEN} characters`,
          );
          idsOk = false;
        }

        if (idsOk && slot && slot.length <= MAX_BAG_FIELD_LEN) {
          const lookupId = hasVariantId ? (item.variant_id as string) : (item.id as string);
          validatedPieces.push({ index: i, slot, lookupId });
        }
      }
    }
  }

  const sizes: Record<string, string> = {};
  const rawSizes = raw.sizes;
  if (rawSizes !== undefined) {
    if (!isPlainObject(rawSizes)) {
      problems.push('sizes must be an object mapping slot to size string');
    } else {
      const entries = Object.entries(rawSizes);
      if (entries.length > MAX_BAG_SIZES) {
        problems.push(`sizes must have at most ${MAX_BAG_SIZES} entries`);
      } else {
        for (const [k, v] of entries) {
          const key = k.trim();
          if (!key || key.length > MAX_BAG_FIELD_LEN || FORBIDDEN_KEYS.has(key)) {
            problems.push(`sizes key "${k.slice(0, 20)}" is invalid`);
            continue;
          }
          if (typeof v !== 'string' || v.length > MAX_BAG_FIELD_LEN) {
            problems.push(`sizes["${key}"] must be a string of at most ${MAX_BAG_FIELD_LEN} characters`);
            continue;
          }
          const trimmedVal = v.trim();
          if (trimmedVal.length > 0) {
            sizes[key] = trimmedVal;
          }
        }
      }
    }
  }

  if (problems.length > 0 || !department) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    value: {
      department,
      pieces: validatedPieces,
      sizes,
    },
  };
}

function matchAllowlistedHost(rawHost: string): CuratedStore | null {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const cleanHost = host.startsWith('www.') ? host.slice(4) : host;
  const matched = STORES.find(
    (s) =>
      s.shop.toLowerCase() === cleanHost ||
      s.site.toLowerCase() === cleanHost ||
      cleanHost.endsWith(`.${s.site.toLowerCase()}`),
  );
  return matched ?? null;
}

export function isAllowlistedStoreDomain(domain: string): boolean {
  return matchAllowlistedHost(domain) !== null;
}

export function computeBagBuildHash(req: ValidatedBagRequest): string {
  const canonicalPieces = req.pieces.map((p) => ({
    slot: p.slot.toLowerCase(),
    id: p.lookupId,
  }));
  const canonicalSizes = Object.entries(req.sizes)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ d: req.department, p: canonicalPieces, s: canonicalSizes }))
    .digest('hex');
}

/**
 * Resolves a store-returned ProductDetail strictly against the 4 allowlisted stores.
 * Returns null if the product does not belong to one of the allowlisted stores.
 */
export function findAllowlistedStoreForDetail(detail: ProductDetail): CuratedStore | null {
  const extra = detail as unknown as {
    store_domain?: unknown;
    seller?: { domain?: unknown };
  };

  if (typeof detail.variant?.url === 'string' && detail.variant.url.trim().length > 0) {
    try {
      const parsed = new URL(detail.variant.url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      const fromUrl = matchAllowlistedHost(parsed.hostname);
      if (fromUrl) return fromUrl;
      // URL explicitly points at a non-allowlisted domain -> reject even if extra fields exist
      return null;
    } catch {
      return null;
    }
  }

  if (typeof extra.store_domain === 'string' && extra.store_domain.trim().length > 0) {
    return matchAllowlistedHost(extra.store_domain);
  }
  if (typeof extra.seller?.domain === 'string' && extra.seller.domain.trim().length > 0) {
    return matchAllowlistedHost(extra.seller.domain);
  }

  return null;
}

/**
 * Builds a server-authoritative Piece strictly from a store ProductDetail + allowlisted CuratedStore.
 */
export function pieceFromStoreDetail(
  slot: string,
  detail: ProductDetail,
  store: CuratedStore,
  department: Gender,
): Piece {
  const images = Array.isArray(detail.images)
    ? detail.images.filter((img): img is string => typeof img === 'string' && img.length > 0)
    : [];
  const price =
    typeof detail.variant?.price === 'number' && Number.isFinite(detail.variant.price)
      ? detail.variant.price
      : 0;

  const item: Item = {
    id: detail.id,
    variant_id: detail.variant.id,
    title: detail.title,
    price,
    url: detail.variant.url,
    image: images[0] ?? '',
    store: store.name,
    store_domain: store.shop,
    rating: null,
    rating_count: null,
    sizes: [],
    variants_by_size: {},
    description: '',
    department,
  };

  return { slot, why: '', item };
}

/**
 * Placeholder piece for an unresolvable Shopify GID (no client data copied; never sent to createCart).
 */
export function placeholderPieceForUnknownId(
  slot: string,
  lookupId: string,
  department: Gender,
): Piece {
  return {
    slot,
    why: '',
    item: {
      id: lookupId,
      variant_id: lookupId,
      title: 'Item',
      price: 0,
      url: '',
      image: '',
      store: 'Unknown Store',
      store_domain: 'unknown',
      rating: null,
      rating_count: null,
      sizes: [],
      variants_by_size: {},
      description: '',
      department,
    },
  };
}

function normalizeSlotKey(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === 'shoe' || s === 'shoes' || s === 'footwear') return 'shoes';
  if (s === 'pants' || s === 'trousers' || s === 'jeans' || s === 'shorts' || s === 'skirt') {
    return 'bottom';
  }
  if (s === 'shirt' || s === 'blouse' || s === 'sweater' || s === 'tee') return 'top';
  if (s === 'jacket' || s === 'coat' || s === 'blazer' || s === 'outerwear') return 'layer';
  return s;
}

function findPieceForCartEntry(
  outfit: Outfit | undefined,
  variantId: string,
  title: string | undefined,
  store: string,
  itemId?: string,
): Piece | undefined {
  if (!outfit || !Array.isArray(outfit.pieces)) return undefined;
  if (itemId) {
    const byId = outfit.pieces.find((p) => p.item.id === itemId);
    if (byId) return byId;
  }
  for (const p of outfit.pieces) {
    if (p.item.variant_id === variantId) return p;
    if (p.item.variants_by_size && Object.values(p.item.variants_by_size).includes(variantId)) {
      return p;
    }
  }
  if (title) {
    const lower = title.trim().toLowerCase();
    const byTitle = outfit.pieces.find(
      (p) => p.item.title.trim().toLowerCase() === lower && p.item.store === store,
    );
    if (byTitle) return byTitle;
    return outfit.pieces.find((p) => p.item.title.trim().toLowerCase() === lower);
  }
  return undefined;
}

function findStoreForCart(storeName: string, storeDomain: string): CuratedStore | null {
  const byDomain = matchAllowlistedHost(storeDomain);
  if (byDomain) return byDomain;
  const normName = storeName.trim().toLowerCase();
  return STORES.find((s) => s.name.toLowerCase() === normName) ?? null;
}

/**
 * Keeps a checkout link ONLY if it is https: and its host is the cart's own store domain
 * (or a subdomain of it), the store's myshopify host from our lookup, or shop.app.
 */
export function sanitizeCheckoutLink(
  raw: unknown,
  storeName: string,
  storeDomain: string,
): { url: string | null; dropped: boolean } {
  if (typeof raw !== 'string') return { url: null, dropped: false };
  const trimmed = raw.trim();
  if (!trimmed) return { url: null, dropped: false };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: null, dropped: true };
  }

  if (parsed.protocol !== 'https:') {
    return { url: null, dropped: true };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) {
    return { url: null, dropped: true };
  }

  if (host === 'shop.app') {
    return { url: trimmed, dropped: false };
  }

  const matchedStore = findStoreForCart(storeName, storeDomain);
  if (matchedStore) {
    const site = matchedStore.site.toLowerCase();
    const shop = matchedStore.shop.toLowerCase();
    if (host === site || host.endsWith(`.${site}`) || host === shop) {
      return { url: trimmed, dropped: false };
    }
  }

  return { url: null, dropped: true };
}

export interface BagToPageOptions {
  onLinkDropped?: (info: { store: string; store_domain: string }) => void;
}

/**
 * Pure field-for-field equivalent of `bagOutToPagePayload` in `src/agent/tools.ts`,
 * kept free of agent/model/purchase/auth dependencies so the server and agent can share it.
 */
export function bagToPagePayload(
  bagOut: BagOut,
  outfit?: Outfit,
  sizes?: Record<string, string>,
  opts?: BagToPageOptions,
): PageActions['bagReady'] {
  const stores: BagStore[] = [];
  const links: BagLink[] = [];
  const sizeMap = sizes ?? {};

  for (const cart of bagOut.carts ?? []) {
    const added: BagLine[] = (cart.added ?? []).map((entry) => {
      const ext = entry as Partial<BagLineAdded>;
      const piece = findPieceForCartEntry(
        outfit,
        entry.variant_id,
        entry.title,
        cart.store,
        ext.item_id,
      );
      const slot = ext.slot || piece?.slot || '';
      const fallbackSize = slot
        ? (sizeMap[slot.toLowerCase()] ?? sizeMap[normalizeSlotKey(slot)] ?? null)
        : null;
      return {
        title: entry.title || piece?.item.title || 'Item',
        slot,
        image: ext.image || piece?.item.image || '',
        price:
          typeof ext.price === 'number' && Number.isFinite(ext.price)
            ? ext.price
            : (piece?.item.price ?? 0),
        size: entry.size !== undefined ? entry.size : fallbackSize,
      };
    });

    const not_added: BagLine[] = (cart.not_added ?? []).map((entry) => {
      const ext = entry as Partial<BagLineNotAdded>;
      const piece = findPieceForCartEntry(
        outfit,
        entry.variant_id,
        entry.title,
        cart.store,
        ext.item_id,
      );
      return {
        title: entry.title || piece?.item.title || 'Item',
        slot: ext.slot || piece?.slot || '',
        image: ext.image || piece?.item.image || '',
        price:
          typeof ext.price === 'number' && Number.isFinite(ext.price)
            ? ext.price
            : (piece?.item.price ?? 0),
        ...(ext.size !== undefined ? { size: ext.size } : {}),
        reason: entry.reason,
      };
    });

    stores.push({
      store: cart.store,
      added,
      not_added,
      subtotal: cart.total_usd,
    });

    const linkCheck = sanitizeCheckoutLink(cart.continue_url, cart.store, cart.store_domain);
    if (linkCheck.url) {
      links.push({ store: cart.store, url: linkCheck.url });
    } else if (linkCheck.dropped) {
      opts?.onLinkDropped?.({ store: cart.store, store_domain: cart.store_domain });
    }
  }

  return {
    stores,
    links,
    total: typeof bagOut.total_usd === 'number' && Number.isFinite(bagOut.total_usd)
      ? bagOut.total_usd
      : 0,
  };
}
