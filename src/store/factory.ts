import type { ShopMcpClient } from './shopmcp.ts';
import type { SavedStore } from './saved.ts';
import type { CatalogClient } from './catalog.ts';
import type { CartClient } from './cart.ts';
import { shopMcp } from './shopmcp.ts';
import { savedStore } from './saved.ts';
import { createCatalog } from './catalog.ts';
import { createCartClient } from './cart.ts';

export interface StoreDeps {
  mcp?: ShopMcpClient;
  saved?: SavedStore;
  now?: () => number;
}

export interface StoreInstance extends CatalogClient, CartClient {
  mcp: ShopMcpClient;
  saved: SavedStore;
}

export function createStore(deps?: StoreDeps): StoreInstance {
  const mcp = deps?.mcp ?? shopMcp;
  const saved = deps?.saved ?? savedStore;
  const now = deps?.now ?? (() => Date.now());

  const catalog = createCatalog({ mcp, saved, now });
  const cart = createCartClient({ mcp, now });

  return {
    mcp,
    saved,
    search: catalog.search,
    lookup: catalog.lookup,
    getProduct: catalog.getProduct,
    productImages: catalog.productImages,
    sizeVariant: catalog.sizeVariant,
    createCart: cart.createCart,
    getCart: cart.getCart,
    updateCart: cart.updateCart,
  };
}
