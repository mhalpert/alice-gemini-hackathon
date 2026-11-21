import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Item, Outfit } from '../src/types.ts';
import type { ProductDetail, SizeVariantResult } from '../src/store/catalog.ts';
import type { CartLineInput, StoreCartResponse } from '../src/store/cart.ts';
import type { BagLineAdded, BagLineNotAdded, BagStoreDeps } from '../src/store/bag.ts';
import { createBag, matchSizeLabel, isSizeConverted } from '../src/store/bag.ts';
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

  it('handles real store formats from live matrix: Everlane, Fashion Nova, Steve Madden, Kith, widths & prefixes', () => {
    // Everlane women's dress: letter -> US numeric (preferring US over UK)
    assert.equal(
      matchSizeLabel(
        'Medium',
        ['14 UK', '16 UK', '0 US', '00 US', '2 US', '4 US', '6 US', '8 US', '10 US', '12 US', '14 US', '16 US'],
        { slot: 'dress', gender: 'women' },
      ),
      '8 US',
    );

    // Everlane & Steve Madden women's denim: dress size 8 -> waist 29
    assert.equal(
      matchSizeLabel('8', ['23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35'], {
        slot: 'bottom',
        gender: 'women',
      }),
      '29',
    );
    assert.equal(
      matchSizeLabel('8', ['24 US', '25 US', '29 US', '30 US', '31 US', '32 US', '33 US'], {
        slot: 'bottom',
        gender: 'women',
      }),
      '29 US',
    );

    // Fashion Nova juniors odd denim: misses 8 -> 9, waist 28 -> 7
    const fnJuniors = ['0', '1', '3', '5', '7', '9', '11', '13', '15', '1X', '2X', '3X'];
    assert.equal(matchSizeLabel('8', fnJuniors, { slot: 'bottom', gender: 'women' }), '9');
    assert.equal(matchSizeLabel('28', fnJuniors, { slot: 'bottom', gender: 'women' }), '7');

    // Everlane men's letter-sized trousers: waist 34 -> L (but never for layer!)
    assert.equal(matchSizeLabel('34', ['XS', 'L'], { slot: 'bottom', gender: 'men' }), 'L');
    assert.equal(matchSizeLabel('34', ['XS', 'L'], { slot: 'layer', gender: 'men' }), null);

    // Additional real formats: W34 L32, 34/32, 11 M, US 11, M 11, M/L, 8 (M)
    assert.equal(
      matchSizeLabel('34', ['W32 L30', 'W34 L30', 'W34 L32'], { slot: 'bottom', gender: 'men' }),
      'W34 L32',
    );
    assert.equal(
      matchSizeLabel('34', ['32/30', '34/30', '34/32'], { slot: 'bottom', gender: 'men' }),
      '34/32',
    );
    assert.equal(matchSizeLabel('size 11', ['10 M', '11 W', '11 M'], { slot: 'shoes', gender: 'men' }), '11 M');
    assert.equal(matchSizeLabel('size 11', ['US 10', 'US 11', 'US 12'], { slot: 'shoes', gender: 'men' }), 'US 11');
    assert.equal(matchSizeLabel('size 11', ['M 7', 'M 11'], { slot: 'shoes', gender: 'men' }), 'M 11');
    assert.equal(matchSizeLabel('size 11', ['M 7'], { slot: 'shoes', gender: 'men' }), null);
    assert.equal(matchSizeLabel('Medium', ['XS/S', 'M/L', 'XL'], { slot: 'top', gender: 'women' }), 'M/L');
    assert.equal(matchSizeLabel('Medium', ['4 (S)', '8 (M)', '12 (L)'], { slot: 'dress', gender: 'women' }), '8 (M)');
    assert.equal(matchSizeLabel('8', ['4 (S)', '8 (M)', '12 (L)'], { slot: 'dress', gender: 'women' }), '8 (M)');
  });
});

describe('isSizeConverted', () => {
  it('flags cross-system or different-value conversions as true', () => {
    assert.equal(isSizeConverted('8', '29'), true);
    assert.equal(isSizeConverted('8', '29 US'), true);
    assert.equal(isSizeConverted('8', '9'), true);
    assert.equal(isSizeConverted('28', '7'), true);
    assert.equal(isSizeConverted('Medium', '8 US'), true);
    assert.equal(isSizeConverted('8', 'M'), true);
    assert.equal(isSizeConverted('8', 'Medium (M)'), true);
    assert.equal(isSizeConverted('34', 'L'), true);
    assert.equal(isSizeConverted('32x30', '32x32'), true);
  });

  it('does NOT flag mere formatting differences as converted', () => {
    assert.equal(isSizeConverted('size 11', '11'), false);
    assert.equal(isSizeConverted('Large', 'L'), false);
    assert.equal(isSizeConverted('Large', 'Large (L)'), false);
    assert.equal(isSizeConverted('34', '34 US'), false);
    assert.equal(isSizeConverted('34', '34W'), false);
    assert.equal(isSizeConverted('size 11', '11 M'), false);
    assert.equal(isSizeConverted('size 11', 'US 11'), false);
    assert.equal(isSizeConverted('ten and a half', '10.5'), false);
    assert.equal(isSizeConverted('32', '32x32'), false);
    assert.equal(isSizeConverted('Medium', 'M/L'), false);
    assert.equal(isSizeConverted('8', '8 (M)'), false);
    assert.equal(isSizeConverted('Medium', '8 (M)'), false);
    assert.equal(isSizeConverted('XXL', '2X'), false);
    assert.equal(isSizeConverted(null, 'One Size'), false);
    assert.equal(isSizeConverted('8.5 wide', '8.5'), false);
    assert.equal(isSizeConverted('12', '46'), true);
    assert.equal(isSizeConverted('12', 'EU 46'), true);
    assert.equal(isSizeConverted('8.5 wide', '42'), true);
    assert.equal(isSizeConverted('44', '10'), true);
    assert.equal(isSizeConverted('11', 'UK 10'), true);
  });
});

describe('shoe size systems, widths, and waist+inseam (brief-rehearsal-4)', () => {
  it('converts US <-> EU and US <-> UK shoe sizes and handles nearest-above within 1.0', () => {
    const euFull = ['39', '40', '41', '42', '43', '44', '45', '46'];
    const euNo46 = ['39', '40', '41', '42', '43', '44', '45'];

    // Men US -> EU
    assert.equal(matchSizeLabel('12', euFull, { slot: 'shoes', gender: 'men' }), '46');
    assert.equal(matchSizeLabel('8.5', euFull, { slot: 'shoes', gender: 'men' }), '42');
    // 9 -> EU 42.5 -> nearest at or above within 1.0 is 43
    assert.equal(matchSizeLabel('9', euFull, { slot: 'shoes', gender: 'men' }), '43');
    // 12 -> EU 46 not in 39..45 -> null (sold out)
    assert.equal(matchSizeLabel('12', euNo46, { slot: 'shoes', gender: 'men' }), null);

    // Women US -> EU
    const womenEu = ['36', '37', '38', '39', '40', '41'];
    assert.equal(matchSizeLabel('7.5', womenEu, { slot: 'shoes', gender: 'women' }), '38');
    assert.equal(matchSizeLabel('8', womenEu, { slot: 'shoes', gender: 'women' }), '39'); // 38.5 -> 39
    assert.equal(matchSizeLabel('8.5', womenEu, { slot: 'shoes', gender: 'women' }), '39');

    // Reverse: EU -> US
    const usMen = ['7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '12'];
    assert.equal(matchSizeLabel('44', usMen, { slot: 'shoes', gender: 'men' }), '10');
    assert.equal(matchSizeLabel('EU 45', usMen, { slot: 'shoes', gender: 'men' }), '11');

    // UK <-> US (men US = UK + 1, women US = UK + 2)
    assert.equal(matchSizeLabel('11', ['UK 9', 'UK 10', 'UK 11'], { slot: 'shoes', gender: 'men' }), 'UK 10');
    assert.equal(matchSizeLabel('8', ['UK 5', 'UK 6', 'UK 7'], { slot: 'shoes', gender: 'women' }), 'UK 6');
    assert.equal(matchSizeLabel('UK 10', usMen, { slot: 'shoes', gender: 'men' }), '11');
  });

  it('handles shoe widths (wide/W/E/narrow/medium/regular/D) and adds width note only when fallback occurs', async () => {
    const shoePlain = makeItem({
      id: 'gid://shopify/p/shoe-plain',
      variant_id: 'gid://shopify/ProductVariant/sp-85',
      title: 'Classic Sneaker',
      price: 120,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });
    const shoeWide = makeItem({
      id: 'gid://shopify/p/shoe-wide',
      variant_id: 'gid://shopify/ProductVariant/sw-85',
      title: 'Wide Runner',
      price: 130,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });

    assert.equal(matchSizeLabel('8.5 wide', ['8', '8.5', '9'], { slot: 'shoes', gender: 'men' }), '8.5');
    assert.equal(matchSizeLabel('8.5 W', ['8.5 M', '8.5 W'], { slot: 'shoes', gender: 'men' }), '8.5 W');
    assert.equal(matchSizeLabel('8.5 E', ['8.5', '8.5 Wide'], { slot: 'shoes', gender: 'men' }), '8.5 Wide');
    assert.equal(matchSizeLabel('10 narrow', ['9', '10', '11'], { slot: 'shoes', gender: 'men' }), '10');
    assert.equal(matchSizeLabel('11 D', ['10', '11', '12'], { slot: 'shoes', gender: 'men' }), '11');
    assert.equal(matchSizeLabel('11 regular', ['10', '11 M', '12'], { slot: 'shoes', gender: 'men' }), '11 M');

    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === shoePlain.variant_id) {
          return makeDetail(shoePlain, 'Numeric shoe size', [{ label: '8' }, { label: '8.5' }, { label: '9' }]);
        }
        return makeDetail(shoeWide, 'Numeric shoe size', [{ label: '8.5 M' }, { label: '8.5 W' }]);
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
      async createCart() {
        return {
          cart_id: 'c-w',
          continue_url: 'https://m34kzg-ke.myshopify.com/cart/c/w',
          total_usd: 120,
          line_items: [],
          messages: [],
          ms: 20,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const resFallback = await addToBag(
      { name: 'L', difference: 'd', story: 's', total: 120, pieces: [{ slot: 'shoes', why: 'w', item: shoePlain }] },
      { shoes: '8.5 wide' },
      'men',
    );
    const line1 = resFallback.carts[0].added[0] as BagLineAdded;
    assert.equal(line1.size, '8.5');
    assert.equal(line1.note, "wide width isn't offered; added regular 8.5");
    assert.ok(resFallback.summary.includes("wide width isn't offered; added regular 8.5"));

    const resMatchedWide = await addToBag(
      { name: 'L', difference: 'd', story: 's', total: 130, pieces: [{ slot: 'shoes', why: 'w', item: shoeWide }] },
      { shoes: '8.5 wide' },
      'men',
    );
    const line2 = resMatchedWide.carts[0].added[0] as BagLineAdded;
    assert.equal(line2.size, '8.5 W');
    assert.equal(line2.note, undefined);
  });

  it('adds EU shoe conversion note in summary ("went in as EU 46 (you said 12)") and handles waist+inseam formats and missing inseam note', async () => {
    const kithShoe = makeItem({
      id: 'gid://shopify/p/kith-shoe',
      variant_id: 'gid://shopify/ProductVariant/ks-42',
      title: 'Kith Sneaker',
      price: 180,
      store: 'Kith',
      store_domain: 'kithnyc.myshopify.com',
    });
    const chino = makeItem({
      id: 'gid://shopify/p/chino',
      variant_id: 'gid://shopify/ProductVariant/ch-30-30',
      title: 'Performance Chino',
      price: 98,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });

    // Check all waist+inseam input formats against combined labels
    const comboLabels = ['30x30', '30x32', '32x30', '32x32'];
    for (const fmt of ['30x32', '30 x 32', '30/32', 'W30 L32', '30 waist, 32 inseam', '30 by 32']) {
      assert.equal(matchSizeLabel(fmt, comboLabels, { slot: 'bottom', gender: 'men' }), '30x32', fmt);
    }

    const receivedInseams: Array<string | undefined> = [];
    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === kithShoe.variant_id) {
          return makeDetail(kithShoe, 'Size', [
            { label: '41' },
            { label: '42' },
            { label: '45' },
            { label: '46' },
          ]);
        }
        return {
          ...makeDetail(chino, 'Waist', [{ label: '30' }, { label: '32' }]),
          options: [
            {
              name: 'Waist',
              values: [
                { label: '30', available: true, exists: true },
                { label: '32', available: true, exists: true },
              ],
            },
            {
              name: 'Length',
              values: [
                { label: '30', available: true, exists: true },
                { label: '32', available: true, exists: true },
              ],
            },
          ],
        };
      },
      async sizeVariant(variantId, size, opts) {
        receivedInseams.push(opts?.inseam);
        return {
          ok: true,
          variant_id: `${variantId}-${size}`,
          size,
          available: true,
          sizes_available: [size],
          nearest: null,
          ...(opts?.inseam === '34' ? { note: "34 inseam isn't offered; used 32" } : {}),
        };
      },
      async createCart(domain) {
        return {
          cart_id: `cart-${domain}`,
          continue_url: `https://${domain}/cart/c/1`,
          total_usd: domain.includes('kith') ? 180 : 98,
          line_items: [],
          messages: [],
          ms: 20,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const res = await addToBag(
      {
        name: 'Look',
        difference: 'd',
        story: 's',
        total: 278,
        pieces: [
          { slot: 'shoes', why: 'shoes', item: kithShoe },
          { slot: 'bottom', why: 'pants', item: chino },
        ],
      },
      { shoes: '12', bottom: '30', inseam: '34' },
      'men',
    );

    assert.ok(receivedInseams.includes('34'));
    const kithLine = res.carts.find((c) => c.store === 'Kith')!.added[0] as BagLineAdded;
    assert.equal(kithLine.size, '46');
    assert.equal(kithLine.size_converted, true);
    assert.ok(res.summary.includes('Kith Sneaker went in as EU 46 (you said 12).'));

    const chinoLine = res.carts.find((c) => c.store === 'Everlane')!.added[0] as BagLineAdded;
    assert.equal(chinoLine.note, "34 inseam isn't offered; used 32");
    assert.ok(res.summary.includes("34 inseam isn't offered; used 32"));
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

  it('does NOT treat a single remaining shoe/clothing size (e.g. "M 7") as one-size', async () => {
    const sneaker = makeItem({
      id: 'gid://shopify/p/sneaker',
      variant_id: 'gid://shopify/ProductVariant/sn-7',
      title: 'The Court Sneaker',
      price: 118,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });

    let cartCalls = 0;
    const deps: BagStoreDeps = {
      async getProduct() {
        return makeDetail(sneaker, 'Numeric shoe size', [{ label: 'M 7' }]);
      },
      async sizeVariant() {
        throw new Error('should not call sizeVariant');
      },
      async createCart() {
        cartCalls += 1;
        throw new Error('should not create cart');
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Look',
      difference: 'Clean',
      story: 'Clean',
      total: 118,
      pieces: [{ slot: 'shoes', why: 'sneakers', item: sneaker }],
    };

    const res = await addToBag(outfit, { shoes: 'size 11' }, 'men');
    assert.equal(cartCalls, 0);
    assert.equal(res.carts[0].added.length, 0);
    assert.equal(res.carts[0].not_added.length, 1);
    const na = res.carts[0].not_added[0] as BagLineNotAdded;
    assert.equal(na.reason, "size 11 isn't in stock (sizes left: M 7)");
    assert.equal(na.asked_size, 'size 11');
    assert.equal(na.size_converted, undefined);
  });

  it('sets asked_size and size_converted on converted lines and reports each converted piece once in summary', async () => {
    const jean = makeItem({
      id: 'gid://shopify/p/jean',
      variant_id: 'gid://shopify/ProductVariant/jean-28',
      title: 'Way-High Jean',
      price: 118,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      department: 'women',
    });
    const tee = makeItem({
      id: 'gid://shopify/p/tee',
      variant_id: 'gid://shopify/ProductVariant/tee-s',
      title: 'Organic Tee',
      price: 38,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
      department: 'women',
    });

    const deps: BagStoreDeps = {
      async getProduct(id) {
        if (id === jean.variant_id) {
          return makeDetail(jean, 'Size', [
            { label: '27' },
            { label: '28' },
            { label: '29' },
            { label: '30' },
          ]);
        }
        return makeDetail(tee, 'Size', [{ label: 'S' }, { label: 'M' }, { label: 'L' }]);
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
      async createCart() {
        return {
          cart_id: 'cart-ev',
          continue_url: 'https://m34kzg-ke.myshopify.com/cart/c/1',
          total_usd: 156,
          line_items: [],
          messages: [],
          ms: 25,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const outfit: Outfit = {
      name: 'Casual',
      difference: 'Clean',
      story: 'Clean',
      total: 156,
      pieces: [
        { slot: 'bottom', why: 'jeans', item: jean },
        { slot: 'top', why: 'tee', item: tee },
      ],
    };

    const res = await addToBag(outfit, { bottom: '8', top: 'Medium' }, 'women');
    const added = res.carts[0].added as BagLineAdded[];
    assert.equal(added.length, 2);

    const jeanLine = added.find((l) => l.slot === 'bottom')!;
    assert.equal(jeanLine.size, '29');
    assert.equal(jeanLine.asked_size, '8');
    assert.equal(jeanLine.size_converted, true);

    const teeLine = added.find((l) => l.slot === 'top')!;
    assert.equal(teeLine.size, 'M');
    assert.equal(teeLine.asked_size, 'Medium');
    assert.equal(teeLine.size_converted, undefined);

    assert.ok(res.summary.includes('Way-High Jean went in as 29 (you said 8).'));
    assert.equal(res.summary.split('Way-High Jean went in as 29').length - 1, 1);
    assert.ok(!res.summary.includes('Organic Tee went in as'));
  });

  it('treats Steve Madden "ONESZ" (and "NO SIZE") on bags/accessories as one-size needing no shopper size', async () => {
    const bag = makeItem({
      id: 'gid://shopify/p/tanzie',
      variant_id: 'gid://shopify/ProductVariant/41482850140293',
      title: 'TANZIE WOVEN BAG TOBACCO',
      price: 88,
      store: 'Steve Madden',
      store_domain: 'stevemadden.myshopify.com',
      department: 'women',
    });

    const deps: BagStoreDeps = {
      async getProduct() {
        return makeDetail(bag, 'Size', [{ label: 'ONESZ', available: true }]);
      },
      async sizeVariant() {
        throw new Error('should not call sizeVariant for ONESZ');
      },
      async createCart(_domain, lines) {
        assert.equal(lines.length, 1);
        assert.equal(lines[0].variant_id, bag.variant_id);
        return {
          cart_id: 'cart-sm',
          continue_url: 'https://stevemadden.myshopify.com/cart/c/1',
          total_usd: 88,
          line_items: [],
          messages: [],
          ms: 20,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const res = await addToBag(
      {
        name: 'Wedding Guest',
        difference: 'Woven',
        story: 'Summer',
        total: 88,
        pieces: [{ slot: 'bag', why: 'bag', item: bag }],
      },
      { dress: 'Medium', shoes: '8' },
      'women',
    );
    assert.ok(!res.summary.startsWith('NOT DONE'));
    assert.equal(res.carts[0].added.length, 1);
    assert.equal(res.carts[0].added[0].size, 'ONESZ');
    assert.equal(res.carts[0].continue_url, 'https://stevemadden.myshopify.com/cart/c/1');
  });

  it('drops the exact bad line named in a store tool error and still returns a cart for the rest', async () => {
    const jacket = makeItem({
      id: 'gid://shopify/p/j',
      variant_id: 'gid://shopify/ProductVariant/67966605459748',
      title: 'Duke Textured Bomber Jacket',
      price: 39.99,
      store: 'Fashion Nova',
      store_domain: 'fnova.myshopify.com',
    });
    const sweater = makeItem({
      id: 'gid://shopify/p/s',
      variant_id: 'gid://shopify/ProductVariant/39249259888764',
      title: 'Heavy Ribbed Pullover Sweater',
      price: 24.99,
      store: 'Fashion Nova',
      store_domain: 'fnova.myshopify.com',
    });
    const pants = makeItem({
      id: 'gid://shopify/p/p',
      variant_id: 'gid://shopify/ProductVariant/39296832438396',
      title: 'Mac Chino Pants',
      price: 29.99,
      store: 'Fashion Nova',
      store_domain: 'fnova.myshopify.com',
    });

    const calls: string[][] = [];
    const deps: BagStoreDeps = {
      async getProduct(id) {
        const it = [jacket, sweater, pants].find((x) => x.variant_id === id)!;
        return makeDetail(it, 'Size', [{ label: 'L' }, { label: '34' }]);
      },
      async sizeVariant(variantId, size) {
        return {
          ok: true,
          variant_id: variantId,
          size,
          available: true,
          sizes_available: [size],
          nearest: null,
        };
      },
      async createCart(_domain, lines) {
        const ids = lines.map((l) => l.variant_id);
        calls.push(ids);
        if (ids.includes(jacket.variant_id)) {
          return {
            cart_id: null,
            continue_url: null,
            total_usd: null,
            line_items: [],
            messages: [
              {
                type: 'error',
                code: 'invalid',
                content:
                  'The merchandise with id gid://shopify/ProductVariant/67966605459748 does not exist.',
                path: '$.add_items[0].product_variant_id',
              },
            ],
            ms: 100,
            error:
              'The merchandise with id gid://shopify/ProductVariant/67966605459748 does not exist.',
          };
        }
        return {
          cart_id: 'cart-fn-recovered',
          continue_url: 'https://fnova.myshopify.com/cart/c/recovered',
          total_usd: 54.98,
          line_items: [],
          messages: [],
          ms: 100,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const res = await addToBag(
      {
        name: 'Look',
        difference: 'd',
        story: 's',
        total: 94.97,
        pieces: [
          { slot: 'layer', why: 'w', item: jacket },
          { slot: 'top', why: 'w', item: sweater },
          { slot: 'bottom', why: 'w', item: pants },
        ],
      },
      { top: 'Large', bottom: '34' },
      'men',
    );

    assert.equal(calls.length, 2);
    assert.equal(res.carts[0].cart_id, 'cart-fn-recovered');
    assert.equal(res.carts[0].continue_url, 'https://fnova.myshopify.com/cart/c/recovered');
    assert.equal(res.carts[0].added.length, 2);
    assert.equal(res.carts[0].not_added.length, 1);
    assert.equal(res.carts[0].not_added[0].variant_id, jacket.variant_id);
    assert.equal(res.carts[0].not_added[0].reason, 'sold out');
    assert.equal(res.total_usd, 54.98);
    assert.match(res.summary, /1 checkout link ready/);
    assert.match(res.summary, /Duke Textured Bomber Jacket: sold out/);
  });

  it('bisects a multi-line cart when error names no line, isolates the bad item, and creates a combined cart for good items', async () => {
    const items = ['A', 'B', 'C', 'D'].map((k) =>
      makeItem({
        id: `gid://shopify/p/${k}`,
        variant_id: `gid://shopify/ProductVariant/100000${k.charCodeAt(0)}`,
        title: `Item ${k}`,
        price: 25,
        store: 'Fashion Nova',
        store_domain: 'fnova.myshopify.com',
      }),
    );
    const badId = items[2].variant_id; // Item C fails with generic quantity error

    const deps: BagStoreDeps = {
      async getProduct(id) {
        const it = items.find((x) => x.variant_id === id)!;
        return makeDetail(it, 'Size', [{ label: 'One Size' }]);
      },
      async sizeVariant(variantId, size) {
        return { ok: true, variant_id: variantId, size, available: true, sizes_available: [size], nearest: null };
      },
      async createCart(_domain, lines) {
        const ids = lines.map((l) => l.variant_id);
        if (ids.includes(badId)) {
          return {
            cart_id: null,
            continue_url: null,
            total_usd: null,
            line_items: [],
            messages: [],
            ms: 50,
            error: 'requested quantity not available',
          };
        }
        return {
          cart_id: `cart-${ids.length}`,
          continue_url: `https://fnova.myshopify.com/cart/c/${ids.length}`,
          total_usd: ids.length * 25,
          line_items: [],
          messages: [],
          ms: 50,
        };
      },
    };

    const { addToBag } = createBag(deps);
    const res = await addToBag(
      {
        name: 'Look',
        difference: 'd',
        story: 's',
        total: 100,
        pieces: items.map((item, i) => ({ slot: i === 0 ? 'top' : i === 1 ? 'bottom' : 'accessory', why: 'w', item })),
      },
      {},
      'men',
    );

    assert.equal(res.carts[0].cart_id, 'cart-3');
    assert.equal(res.carts[0].added.length, 3);
    assert.equal(res.carts[0].not_added.length, 1);
    assert.equal(res.carts[0].not_added[0].variant_id, badId);
    assert.equal(res.carts[0].not_added[0].reason, 'quantity not available');
    assert.equal(res.total_usd, 75);
    assert.match(res.summary, /Item C: quantity not available/);
    assert.match(res.summary, /1 checkout link ready/);
  });

  it('caps recovery at 4s and mentions the limit in summary only when capped', async () => {
    let fakeNow = 10_000;
    const items = ['A', 'B', 'C', 'D'].map((k) =>
      makeItem({
        id: `gid://shopify/p/${k}`,
        variant_id: `gid://shopify/ProductVariant/200000${k.charCodeAt(0)}`,
        title: `Item ${k}`,
        price: 30,
        store: 'Fashion Nova',
        store_domain: 'fnova.myshopify.com',
      }),
    );

    const deps: BagStoreDeps = {
      now: () => fakeNow,
      recoveryCapMs: 4000,
      async getProduct(id) {
        const it = items.find((x) => x.variant_id === id)!;
        return makeDetail(it, 'Size', [{ label: 'One Size' }]);
      },
      async sizeVariant(variantId, size) {
        return { ok: true, variant_id: variantId, size, available: true, sizes_available: [size], nearest: null };
      },
      async createCart(_domain, lines) {
        // First 4-item call fails; first bisection half [A,B] passes but advances clock past 4s cap!
        if (lines.length === 4) {
          return {
            cart_id: null,
            continue_url: null,
            total_usd: null,
            line_items: [],
            messages: [],
            ms: 500,
            error: 'custom checkout rule rejected cart',
          };
        }
        fakeNow += 2500; // two parallel halves advance clock by 5000ms > 4000ms cap
        if (lines.some((l) => l.variant_id === items[0].variant_id)) {
          return {
            cart_id: 'cart-ab',
            continue_url: 'https://fnova.myshopify.com/cart/c/ab',
            total_usd: 60,
            line_items: [],
            messages: [],
            ms: 2500,
          };
        }
        return {
          cart_id: null,
          continue_url: null,
          total_usd: null,
          line_items: [],
          messages: [],
          ms: 2500,
          error: 'custom checkout rule rejected cart',
        };
      },
    };

    const { addToBag } = createBag(deps);
    const res = await addToBag(
      {
        name: 'Look',
        difference: 'd',
        story: 's',
        total: 120,
        pieces: items.map((item) => ({ slot: 'accessory', why: 'w', item })),
      },
      {},
      'men',
    );

    assert.equal(res.carts[0].cart_id, 'cart-ab');
    assert.equal(res.carts[0].added.length, 2);
    assert.equal(res.carts[0].not_added.length, 2);
    assert.match(res.carts[0].not_added[0].reason, /the store refused this item: custom checkout rule rejected cart/);
    assert.match(res.summary, /4s time limit/);
    assert.match(res.summary, /1 checkout link ready/);
  });

  it('formats Transit Chino sold-out size honestly in BagOut.summary as "The Transit Chino: 32 is sold out (sizes left: 38)"', async () => {
    const chino = makeItem({
      id: 'gid://shopify/p/transit-chino',
      variant_id: 'gid://shopify/ProductVariant/transit-38-30',
      title: 'The Transit Chino',
      price: 98,
      store: 'Everlane',
      store_domain: 'm34kzg-ke.myshopify.com',
    });

    const detail: ProductDetail = {
      id: chino.id,
      title: chino.title,
      description: chino.description,
      description_html: chino.description,
      images: [chino.image],
      options: [
        {
          name: 'Waist',
          values: [
            { label: '28', available: false, exists: false },
            { label: '30', available: false, exists: false },
            { label: '32', available: false, exists: false },
            { label: '34', available: false, exists: false },
            { label: '36', available: false, exists: false },
            { label: '38', available: true, exists: true },
          ],
        },
        {
          name: 'Length',
          values: [
            { label: '28', available: false, exists: false },
            { label: '30', available: true, exists: true },
            { label: '32', available: true, exists: true },
            { label: '34', available: false, exists: false },
          ],
        },
        {
          name: 'Color',
          values: [{ label: 'Olive ', available: true, exists: true }],
        },
      ],
      selected: [
        { name: 'Color', label: 'Olive ' },
        { name: 'Waist', label: '38' },
        { name: 'Length', label: '30' },
      ],
      variant: {
        id: chino.variant_id,
        price: 98,
        available: true,
        options: [
          { name: 'Color', label: 'Olive ' },
          { name: 'Waist', label: '38' },
          { name: 'Length', label: '30' },
        ],
        url: chino.url,
      },
    };

    const mcp = createShopMcp({
      fetch: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              structuredContent: {
                product: {
                  id: detail.id,
                  title: detail.title,
                  description: { plain: detail.description },
                  options: detail.options,
                  selected: detail.selected,
                  media: [{ type: 'image', url: chino.image }],
                  variants: [
                    {
                      id: chino.variant_id,
                      price: { amount: 9800, currency: 'USD' },
                      availability: { available: true },
                      options: detail.variant.options,
                      url: chino.url,
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-transit-test-'));
    try {
      const store = createStore({ mcp, saved: createSavedStore({ dir: tmpDir }) });
      const { addToBag } = createBag({
        getProduct: store.getProduct,
        sizeVariant: store.sizeVariant,
        createCart: store.createCart,
      });

      const res = await addToBag(
        {
          name: 'Smart Casual',
          difference: 'Chino',
          story: 'Clean',
          total: 98,
          pieces: [{ slot: 'bottom', why: 'pants', item: chino }],
        },
        { bottom: '32' },
        'men',
      );
      assert.equal(res.carts[0].added.length, 0);
      assert.equal(res.carts[0].not_added.length, 1);
      assert.equal(res.carts[0].not_added[0].reason, '32 is sold out (sizes left: 38)');
      assert.ok(res.summary.includes('The Transit Chino: 32 is sold out (sizes left: 38).'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
