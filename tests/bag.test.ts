import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Item, Outfit } from '../src/types.ts';
import type { ProductDetail, SizeVariantResult } from '../src/store/catalog.ts';
import type { CartLineInput, StoreCartResponse } from '../src/store/cart.ts';
import type { BagLineAdded, BagLineNotAdded, BagStoreDeps } from '../src/store/bag.ts';
import { createBag, matchSizeLabel } from '../src/store/bag.ts';
import { createShopMcp } from '../src/store/shopmcp.ts';
import { createStore } from '../src/store/factory.ts';
import { createSavedStore } from '../src/store/saved.ts';
import { setCallRoom, getCallRoom, setCallLogSink } from '../src/store/log.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeItem(overrides: Partial<Item> & { id: string; variant_id: string }): Item {
  return {
    title: 'Sample Item',
    price: 50,
    url: 'https://example.com/products/sample',
    image: 'https://cdn.shopify.com/sample.jpg',
    store: 'Everlane',
    store_domain: 'm34kzg-ke.myshopify.com',
    rating: 4.8,
    rating_count: 10,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description: 'Sample description',
    department: 'men',
    ...overrides,
  };
}

function makeDetail(
  item: Item,
  sizeOptionName: string | null,
  values: Array<{ label: string; available?: boolean }>,
  variantAvailable = true,
): ProductDetail {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    description_html: item.description,
    images: [item.image],
    options: sizeOptionName
      ? [
          {
            name: sizeOptionName,
            values: values.map((v) => ({
              label: v.label,
              available: v.available ?? true,
              exists: true,
            })),
          },
        ]
      : [],
    selected: sizeOptionName && values[0] ? [{ name: sizeOptionName, label: values[0].label }] : [],
    variant: {
      id: item.variant_id,
      price: item.price,
      available: variantAvailable,
      options: sizeOptionName && values[0] ? [{ name: sizeOptionName, label: values[0].label }] : [],
      url: item.url,
    },
  };
}

describe('matchSizeLabel', () => {
  it('maps words to letters and strips leading "size"', () => {
    assert.equal(matchSizeLabel('Large', ['XS', 'S', 'M', 'L', 'XL']), 'L');
    assert.equal(matchSizeLabel('extra small', ['XS', 'S', 'M', 'L']), 'XS');
    assert.equal(matchSizeLabel('x-large', ['S', 'M', 'L', 'XL']), 'XL');
    assert.equal(matchSizeLabel('double xl', ['S', 'M', 'L', 'XL', 'XXL']), 'XXL');
    assert.equal(matchSizeLabel('2xl', ['S', 'M', 'L', 'XL', '2X']), '2X');
    assert.equal(matchSizeLabel('size 11', ['9', '10', '11', '12']), '11');
    assert.equal(matchSizeLabel('size 11.0', ['9', '10', '11', '12']), '11');
  });

  it('handles spoken and fractional half sizes', () => {
    assert.equal(matchSizeLabel('ten and a half', ['9', '10', '10.5', '11']), '10.5');
    assert.equal(matchSizeLabel('10 and a half', ['9', '10', '10.5', '11']), '10.5');
    assert.equal(matchSizeLabel('10 1/2', ['9', '10', '10.5', '11']), '10.5');
  });

  it('prefers US over EU/UK on prefix match and never matches 34 to 134 or 3', () => {
    assert.equal(matchSizeLabel('34', ['38 EU', '34 US', '36 US']), '34 US');
    assert.equal(matchSizeLabel('34', ['34 EU', '34 UK', '34 US']), '34 US');
    assert.equal(matchSizeLabel('34', ['32W', '34W', '36W']), '34W');
    assert.equal(matchSizeLabel('34', ['134', '3', '340', '34.5']), null);
  });

  it('maps women numeric sizes to letter labels, never men or men layer chest sizes', () => {
    assert.equal(
      matchSizeLabel('8', ['XS', 'S', 'M', 'L', 'XL'], { slot: 'dress', gender: 'women' }),
      'M',
    );
    assert.equal(
      matchSizeLabel('2', ['XS', 'S', 'M', 'L', 'XL'], { slot: 'top', gender: 'women' }),
      'XS',
    );
    assert.equal(
      matchSizeLabel('14', ['XS', 'S', 'M', 'L', 'XL'], { slot: 'dress', gender: 'women' }),
      'L',
    );
    assert.equal(
      matchSizeLabel('16', ['XS', 'S', 'M', 'L', 'XL'], { slot: 'top', gender: 'women' }),
      'XL',
    );
    assert.equal(
      matchSizeLabel('8', ['XS', 'S', 'M', 'L', 'XL'], { slot: 'top', gender: 'men' }),
      null,
    );
    assert.equal(
      matchSizeLabel('40', ['S', 'M', 'L', 'XL'], { slot: 'layer', gender: 'men' }),
      null,
    );
  });

  it('picks closest available inseam for waist x inseam labels and exact match when specified', () => {
    const labels = ['30x30', '32x30', '32x32', '34x32'];
    assert.equal(matchSizeLabel('32', labels, { slot: 'bottom', gender: 'men' }), '32x32');
    assert.equal(matchSizeLabel('32', labels, { slot: 'bottom', gender: 'women' }), '32x30');
    assert.equal(matchSizeLabel('32x30', labels, { slot: 'bottom', gender: 'men' }), '32x30');
    assert.equal(
      matchSizeLabel('32', labels, {
        slot: 'bottom',
        gender: 'men',
        available: ['30x30', '32x30', '34x32'],
      }),
      '32x30',
    );
  });
});

describe('addToBag', () => {
  it('resolves layer via top, dress via top, one-size accessory without size, groups one cart per store, and includes extra fields', async () => {
    const jacket = makeItem({
      id: 'gid://shopify/p/jacket',
      variant_id: 'gid://shopify/ProductVariant/j-s',
      title: 'Wool Overshirt',
      price: 120,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      image: 'https://cdn.shopify.com/jacket.jpg',
    });
    const dress = makeItem({
      id: 'gid://shopify/p/dress',
      variant_id: 'gid://shopify/ProductVariant/d-s',
      title: 'Silk Midi Dress',
      price: 90,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      image: 'https://cdn.shopify.com/dress.jpg',
      department: 'women',
    });
    const bag = makeItem({
      id: 'gid://shopify/p/bag',
      variant_id: 'gid://shopify/ProductVariant/b-os',
      title: 'Leather Tote',
      price: 150,
      store: 'Steve Madden',
      store_domain: 'stevemadden.myshopify.com',
      image: 'https://cdn.shopify.com/bag.jpg',
    });

    const details = new Map<string, ProductDetail>([
      [jacket.variant_id, makeDetail(jacket, 'Size', [{ label: 'S' }, { label: 'M' }, { label: 'L' }])],
      [dress.variant_id, makeDetail(dress, 'Size', [{ label: 'S' }, { label: 'M' }, { label: 'L' }])],
      [bag.variant_id, makeDetail(bag, 'Size', [{ label: 'One Size' }])],
    ]);

    const cartCalls: Array<{ domain: string; lines: CartLineInput[] }> = [];

    const deps: BagStoreDeps = {
      async getProduct(id) {
        return details.get(id) ?? null;
      },
      async sizeVariant(variantId, size): Promise<SizeVariantResult> {
        return {
          ok: true,
          variant_id: `${variantId}-${size}`,
          size,
          available: true,
          sizes_available: ['S', 'M', 'L'],
          nearest: null,
        };
      },
      async createCart(domain, lines): Promise<StoreCartResponse> {
        cartCalls.push({ domain, lines });
        const total = domain === 'm34kzg-ke.myshopify.com' ? 210 : 150;
        return {
          cart_id: `cart-${domain}`,
          continue_url: `https://${domain}/cart/c/123`,
          total_usd: total,
          line_items: [],
          messages: [],
          ms: 50,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look 1',
      difference: 'Classic',
      story: 'Clean look',
      total: 360,
      pieces: [
        { slot: 'layer', why: 'outer layer', item: jacket },
        { slot: 'dress', why: 'main piece', item: dress },
        { slot: 'accessory', why: 'carryall', item: bag },
      ],
    };

    const res = await addToBag(outfit, { top: 'Medium' }, 'women');

    assert.equal(cartCalls.length, 2);
    const everlaneCall = cartCalls.find((c) => c.domain === 'm34kzg-ke.myshopify.com');
    assert.ok(everlaneCall);
    assert.equal(everlaneCall.lines.length, 2);
    assert.deepEqual(
      everlaneCall.lines.map((l) => l.variant_id),
      ['gid://shopify/ProductVariant/j-s-M', 'gid://shopify/ProductVariant/d-s-M'],
    );

    const smCall = cartCalls.find((c) => c.domain === 'stevemadden.myshopify.com');
    assert.ok(smCall);
    assert.deepEqual(smCall.lines, [{ variant_id: 'gid://shopify/ProductVariant/b-os', quantity: 1 }]);

    assert.equal(res.total_usd, 360);
    assert.equal(res.carts.length, 2);

    const everlaneCart = res.carts.find((c) => c.store_domain === 'm34kzg-ke.myshopify.com')!;
    const added0 = everlaneCart.added[0] as BagLineAdded;
    assert.equal(added0.variant_id, 'gid://shopify/ProductVariant/j-s-M');
    assert.equal(added0.size, 'M');
    assert.equal(added0.slot, 'layer');
    assert.equal(added0.image, 'https://cdn.shopify.com/jacket.jpg');
    assert.equal(added0.price, 120);
    assert.equal(added0.item_id, 'gid://shopify/p/jacket');

    assert.match(res.summary, /Everlane: 2 added, \$210\.00/);
    assert.match(res.summary, /Steve Madden: 1 added, \$150\.00/);
    assert.match(res.summary, /2 checkout links ready/);
  });

  it('creates NO carts when a shoe size is missing and summary starts with NOT DONE', async () => {
    const shirt = makeItem({
      id: 'gid://shopify/p/shirt',
      variant_id: 'gid://shopify/ProductVariant/sh-1',
      title: 'Oxford Shirt',
      price: 68,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });
    const shoes = makeItem({
      id: 'gid://shopify/p/shoes',
      variant_id: 'gid://shopify/ProductVariant/lo-7',
      title: 'Naxos Loafer',
      price: 149.95,
      store: 'Steve Madden',
      store_domain: 'stevemadden.myshopify.com',
    });

    let cartCalls = 0;
    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === shirt.variant_id) {
          return makeDetail(shirt, 'Size', [{ label: 'S' }, { label: 'M' }, { label: 'L' }]);
        }
        return makeDetail(shoes, 'Numeric shoe size', [{ label: '9' }, { label: '10' }, { label: '11' }]);
      },
      async sizeVariant(variantId, size) {
        return {
          ok: true,
          variant_id: `${variantId}-${size}`,
          size,
          available: true,
          sizes_available: ['S', 'M', 'L'],
          nearest: null,
        };
      },
      async createCart() {
        cartCalls += 1;
        return {
          cart_id: 'should-not-happen',
          continue_url: 'https://example.com',
          total_usd: 68,
          line_items: [],
          messages: [],
          ms: 10,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look 2',
      difference: 'Smart',
      story: 'Clean',
      total: 217.95,
      pieces: [
        { slot: 'top', why: 'shirt', item: shirt },
        { slot: 'shoes', why: 'loafers', item: shoes },
      ],
    };

    const res = await addToBag(outfit, { top: 'L' }, 'men');

    assert.equal(cartCalls, 0);
    assert.ok(res.summary.startsWith('NOT DONE:'));
    assert.equal(res.total_usd, 0);
    assert.equal(res.carts.length, 2);

    const everlane = res.carts.find((c) => c.store_domain === 'm34kzg-ke.myshopify.com')!;
    assert.equal(everlane.cart_id, null);
    assert.equal(everlane.continue_url, null);
    assert.equal(everlane.added.length, 1);

    const sm = res.carts.find((c) => c.store_domain === 'stevemadden.myshopify.com')!;
    assert.equal(sm.cart_id, null);
    assert.equal(sm.not_added.length, 1);
    const notAdded = sm.not_added[0] as BagLineNotAdded;
    assert.match(notAdded.reason, /no shoes size given/i);
    assert.equal(notAdded.slot, 'shoes');
    assert.equal(notAdded.item_id, 'gid://shopify/p/shoes');
    assert.equal(notAdded.price, 149.95);
    assert.equal(notAdded.image, shoes.image);
  });

  it('reports sold-out size with nearest and still creates carts for remaining items', async () => {
    const shirt = makeItem({
      id: 'gid://shopify/p/shirt',
      variant_id: 'gid://shopify/ProductVariant/sh-1',
      title: 'Oxford Shirt',
      price: 68,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });
    const shoes = makeItem({
      id: 'gid://shopify/p/shoes',
      variant_id: 'gid://shopify/ProductVariant/lo-7',
      title: 'Naxos Loafer',
      price: 149.95,
      store: 'Steve Madden',
      store_domain: 'stevemadden.myshopify.com',
    });

    const createdFor: string[] = [];
    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === shirt.variant_id) {
          return makeDetail(shirt, 'Size', [{ label: 'S' }, { label: 'M' }, { label: 'L' }]);
        }
        return makeDetail(shoes, 'Numeric shoe size', [
          { label: '10', available: true },
          { label: '10.5', available: true },
          { label: '11', available: false },
        ]);
      },
      async sizeVariant(variantId, size) {
        if (variantId === shoes.variant_id) {
          return {
            ok: false,
            variant_id: 'gid://shopify/ProductVariant/lo-11',
            size: '11',
            available: false,
            sizes_available: ['10', '10.5'],
            nearest: '10.5',
            reason: '11 is sold out; nearest 10.5',
          };
        }
        return {
          ok: true,
          variant_id: `${variantId}-${size}`,
          size,
          available: true,
          sizes_available: ['S', 'M', 'L'],
          nearest: null,
        };
      },
      async createCart(domain) {
        createdFor.push(domain);
        return {
          cart_id: 'cart-everlane',
          continue_url: 'https://m34kzg-ke.myshopify.com/cart/c/1',
          total_usd: 68,
          line_items: [],
          messages: [],
          ms: 40,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look 3',
      difference: 'Casual',
      story: 'Easy',
      total: 217.95,
      pieces: [
        { slot: 'top', why: 'shirt', item: shirt },
        { slot: 'shoes', why: 'loafers', item: shoes },
      ],
    };

    const res = await addToBag(outfit, { top: 'L', shoe: 'size 11' }, 'men');

    assert.deepEqual(createdFor, ['m34kzg-ke.myshopify.com']);
    assert.equal(res.total_usd, 68);
    assert.match(res.summary, /11 is sold out; nearest 10\.5/);
    assert.match(res.summary, /1 checkout link ready/);

    const sm = res.carts.find((c) => c.store_domain === 'stevemadden.myshopify.com')!;
    assert.equal(sm.cart_id, null);
    assert.equal(sm.not_added[0].reason, '11 is sold out; nearest 10.5');
  });

  it('moves lines to not_added on createCart failure and on stock warning/error messages', async () => {
    const itemA = makeItem({
      id: 'gid://shopify/p/a',
      variant_id: 'gid://shopify/ProductVariant/a',
      title: 'Chino Pant',
      price: 80,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });
    const itemB = makeItem({
      id: 'gid://shopify/p/b',
      variant_id: 'gid://shopify/ProductVariant/b',
      title: 'Knit Polo',
      price: 60,
      store: 'Kith',
      store_domain: 'kithnyc.myshopify.com',
    });
    const itemC = makeItem({
      id: 'gid://shopify/p/c',
      variant_id: 'gid://shopify/ProductVariant/c',
      title: 'Cap',
      price: 45,
      store: 'Kith',
      store_domain: 'kithnyc.myshopify.com',
    });

    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === itemA.variant_id) return makeDetail(itemA, 'Size', [{ label: '32' }, { label: '34' }]);
        if (id === itemB.variant_id) return makeDetail(itemB, 'Size', [{ label: 'M' }, { label: 'L' }]);
        return makeDetail(itemC, 'Size', [{ label: 'OS' }]);
      },
      async sizeVariant(variantId, size) {
        return {
          ok: true,
          variant_id: `${variantId}-${size}`,
          size,
          available: true,
          sizes_available: [size],
          nearest: null,
        };
      },
      async createCart(domain) {
        if (domain === 'm34kzg-ke.myshopify.com') {
          return {
            cart_id: null,
            continue_url: null,
            total_usd: null,
            line_items: [],
            messages: [],
            ms: 2500,
            error: 'timeout',
          };
        }
        return {
          cart_id: 'cart-kith',
          continue_url: 'https://kithnyc.myshopify.com/cart/c/999',
          total_usd: 45,
          line_items: [{ item: { id: itemC.variant_id }, quantity: 1 }],
          messages: [
            {
              type: 'warning',
              path: '$.line_items[0]',
              content: 'Knit Polo is out of stock',
            },
          ],
          ms: 80,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look 4',
      difference: 'Street',
      story: 'Mixed',
      total: 185,
      pieces: [
        { slot: 'bottom', why: 'pants', item: itemA },
        { slot: 'top', why: 'polo', item: itemB },
        { slot: 'accessory', why: 'hat', item: itemC },
      ],
    };

    const res = await addToBag(outfit, { top: 'L', bottom: '34' }, 'men');

    const everlane = res.carts.find((c) => c.store_domain === 'm34kzg-ke.myshopify.com')!;
    assert.equal(everlane.cart_id, null);
    assert.equal(everlane.added.length, 0);
    assert.equal(everlane.not_added.length, 1);
    assert.equal(
      everlane.not_added[0].reason,
      'the store did not answer; try again in a moment',
    );

    const kith = res.carts.find((c) => c.store_domain === 'kithnyc.myshopify.com')!;
    assert.equal(kith.cart_id, 'cart-kith');
    assert.equal(kith.added.length, 1);
    assert.equal(kith.added[0].variant_id, itemC.variant_id);
    assert.equal(kith.not_added.length, 1);
    assert.equal(kith.not_added[0].reason, 'Knit Polo is out of stock');

    assert.equal(res.total_usd, 45);
  });

  it('uses stock wording when shopper size matches no label', async () => {
    const shirt = makeItem({
      id: 'gid://shopify/p/shirt',
      variant_id: 'gid://shopify/ProductVariant/sh-1',
      title: 'Oxford Shirt',
      price: 68,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });

    const deps: BagStoreDeps = {
      async getProduct() {
        return makeDetail(shirt, 'Size', [{ label: 'S' }, { label: 'M' }]);
      },
      async sizeVariant() {
        throw new Error('should not call sizeVariant');
      },
      async createCart() {
        throw new Error('should not call createCart');
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look',
      difference: 'Clean',
      story: 'Clean',
      total: 68,
      pieces: [{ slot: 'top', why: 'shirt', item: shirt }],
    };

    const res = await addToBag(outfit, { top: 'XXL' }, 'men');
    assert.equal(res.carts.length, 1);
    assert.equal(res.carts[0].added.length, 0);
    assert.equal(res.carts[0].not_added.length, 1);
    assert.equal(res.carts[0].not_added[0].reason, "XXL isn't in stock (sizes left: S, M)");
  });
});

describe('call logging integration', () => {
  it('emits store_search, store_error, store_cart, and store_bag only when call room is set', async () => {
    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-log-test-'));

    try {
      setCallLogSink((room, ev, data) => {
        events.push({ room, ev, data });
      });
      setCallRoom(null);
      assert.equal(getCallRoom(), null);

      const searchFixture = fs.readFileSync(
        new URL('./fixtures/shopmcp/search.json', import.meta.url),
        'utf8',
      );
      const cartFixture = fs.readFileSync(
        new URL('./fixtures/shopmcp/create_cart.json', import.meta.url),
        'utf8',
      );

      let mode: 'search' | '429' | 'cart' = 'search';
      const fakeFetch: typeof fetch = async () => {
        if (mode === '429') {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '2' },
          });
        }
        return new Response(mode === 'cart' ? cartFixture : searchFixture, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const mcp = createShopMcp({ fetch: fakeFetch });
      const saved = createSavedStore({ dir: tmpDir });
      const store = createStore({ mcp, saved });

      // No room set -> nothing logged
      await store.search('loafers', 'men', { limit: 3 });
      assert.equal(events.length, 0);

      // Set room -> events emitted
      setCallRoom('room-abc');
      assert.equal(getCallRoom(), 'room-abc');

      await store.search('loafers', 'men', { limit: 3 });
      mode = 'cart';
      await store.createCart('fnova.myshopify.com', [
        { variant_id: 'gid://shopify/ProductVariant/722039242769', quantity: 1 },
      ]);
      mode = '429';
      await assert.rejects(() => mcp.call('search_catalog', { catalog: { query: 'x' } }));

      const item = makeItem({
        id: 'gid://shopify/p/one',
        variant_id: 'gid://shopify/ProductVariant/one',
        title: 'Tote',
        price: 50,
      });
      const { addToBag } = createBag({
        async getProduct() {
          return makeDetail(item, 'Size', [{ label: 'OS' }]);
        },
        async sizeVariant() {
          throw new Error('unused');
        },
        async createCart() {
          return {
            cart_id: 'c1',
            continue_url: 'https://example.com/cart/c1',
            total_usd: 50,
            line_items: [],
            messages: [],
            ms: 12,
          };
        },
      });
      await addToBag(
        {
          name: 'L',
          difference: 'd',
          story: 's',
          total: 50,
          pieces: [{ slot: 'bag', why: 'w', item }],
        },
        {},
        'women',
      );

      assert.ok(events.every((e) => e.room === 'room-abc'));
      const names = events.map((e) => e.ev);
      assert.ok(names.includes('store_search'));
      assert.ok(names.includes('store_cart'));
      assert.ok(names.includes('store_error'));
      assert.ok(names.includes('store_bag'));

      const errEv = events.find((e) => e.ev === 'store_error')!;
      assert.equal(errEv.data?.tool, 'search_catalog');
      assert.equal(errEv.data?.code, 'rate_limited');
      assert.equal(errEv.data?.status, 429);
      assert.equal(errEv.data?.retry_after_ms, 2000);

      const cartEv = events.find((e) => e.ev === 'store_cart')!;
      assert.equal(cartEv.data?.store, 'fnova.myshopify.com');
      assert.equal(cartEv.data?.ok, true);
      assert.equal(cartEv.data?.n_lines, 1);
      assert.equal(cartEv.data?.total_usd, 20);

      const bagEv = events.find((e) => e.ev === 'store_bag')!;
      assert.equal(bagEv.data?.added, 1);
      assert.equal(bagEv.data?.not_added, 0);
      assert.equal(bagEv.data?.missing_sizes, 0);
      assert.equal(bagEv.data?.carts, 1);
      assert.deepEqual(bagEv.data?.reasons, []);
    } finally {
      setCallRoom(null);
      setCallLogSink(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
