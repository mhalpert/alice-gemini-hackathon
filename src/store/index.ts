import type { Gender, Item, SearchResult } from '../types.ts';
import type { SearchOpts } from './catalog.ts';
import { search } from './catalog.ts';
import { ALL_SITES, OTHER_SITES } from './stores.ts';

export {
  search,
  searchByPhoto,
  searchLike,
  lookup,
  getProduct,
  sizeVariant,
  productImages,
} from './catalog.ts';
export type { ProductDetail, PhotoSearchOpts } from './catalog.ts';

export { createCart, getCart, updateCart } from './cart.ts';

export { addToBag, matchSizeLabel, isSizeConverted } from './bag.ts';
export type { BagLineAdded, BagLineNotAdded } from './bag.ts';

export { STORES, ALL_SITES, OTHER_SITES } from './stores.ts';

export { shopMcp, ShopMcpError } from './shopmcp.ts';
export { setCallRoom } from './log.ts';

export { startSignIn, signInStatus, signOut } from './auth.ts';
export type { SignInState, StartSignInResult } from './auth.ts';

export { prepareOrder, placeOrder, endCall } from './purchase.ts';
export type {
  OrderStore,
  OrderStoreStatus,
  OrderReview,
  PrepareOrderResult,
  PlaceOrderOptions,
} from './purchase.ts';

export async function searchMixed(
  query: string,
  gender: Gender,
  opts?: SearchOpts,
): Promise<SearchResult> {
  if (process.env.ALICE_MIXED_SEARCH === 'off') {
    return search(query, gender, opts);
  }

  const t0 = Date.now();
  const limit = Math.min(opts?.limit ?? 24, 50);

  const [first, other] = await Promise.all([
    search(query, gender, { ...opts, shops: ALL_SITES, limit }),
    search(query, gender, { ...opts, shops: OTHER_SITES, limit }),
  ]);

  const seen = new Set<string>();
  const items: Item[] = [];
  const maxLen = Math.max(first.items.length, other.items.length);

  for (let i = 0; i < maxLen && items.length < limit; i += 1) {
    const a = first.items[i];
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      items.push(a);
      if (items.length >= limit) break;
    }
    const b = other.items[i];
    if (b && !seen.has(b.id)) {
      seen.add(b.id);
      items.push(b);
    }
  }

  const source: SearchResult['source'] =
    first.source === 'live' || other.source === 'live' ? 'live' : first.source;
  const ms = Math.max(0, Date.now() - t0);

  return { items, source, ms };
}
