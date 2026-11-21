import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Gender, Item, SearchResult } from '../src/types.ts';
import type { ProductDetail } from '../src/store/catalog.ts';
import {
  buildProductPayload,
  extractDetailBullets,
  isValidShopifyGid,
  storefront,
} from '../src/store/storefront.ts';

function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    variant_id: `gid://shopify/ProductVariant/${id.replace(/\W+/g, '')}`,
    title: `Item ${id}`,
    price: 49.99,
    url: `https://www.everlane.com/products/${id}?variant=123&_gsid=abc123&utm_source=shopify&utm_medium=catalog`,
    image: `https://cdn.shopify.com/s/files/1/0001/files/${id}.jpg`,
    store: 'Everlane',
    store_domain: 'm34kzg-ke.myshopify.com',
    rating: 4.6,
    rating_count: 25,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'gid://shopify/ProductVariant/1' },
    description: 'Clean everyday staple crafted from organic cotton. '.repeat(6).trim(),
    department: 'women',
    ...overrides,
  };
}

describe('storefront() orchestration', () => {
  it('builds 6 category rails + 4 store rails, interleaves & deduplicates, trims description & clears variants_by_size, and preserves URLs', async () => {
    const sharedItem = makeItem('shared-1', {
      department: 'men',
      url: 'https://www.stevemadden.com/products/shared-1?variant=99&_gsid=keepme&utm_source=shopify&utm_medium=catalog',
    });

    const fakeSearchMixed = async (
      query: string,
      gender: Gender,
    ): Promise<SearchResult> => {
      if (query === "men's shirt") {
        return {
          items: [
            makeItem('shirt-1', { department: gender }),
            sharedItem,
            makeItem('shirt-2', { department: gender }),
          ],
          source: 'live',
          ms: 5,
        };
      }
      if (query === "men's knit sweater") {
        return {
          items: [
            makeItem('knit-1', { department: gender }),
            sharedItem,
            makeItem('knit-2', { department: gender }),
          ],
          source: 'live',
          ms: 5,
        };
      }
      return {
        items: [makeItem(`cat-${query.replace(/\W+/g, '-')}`, { department: gender })],
        source: 'live',
        ms: 5,
      };
    };

    const fakeSearch = async (
      query: string,
      gender: Gender,
      opts?: { shops?: string[] },
    ): Promise<SearchResult> => {
      const shop = opts?.shops?.[0] ?? 'unknown';
      assert.equal(query, "men's clothing");
      return {
        items: [makeItem(`store-${shop}`, { department: gender })],
        source: 'live',
        ms: 5,
      };
    };

    const res = await storefront('men', {
      searchMixed: fakeSearchMixed,
      search: fakeSearch,
    });

    assert.equal(res.department, 'men');
    assert.equal(res.partial, undefined);
    assert.equal(typeof res.ms, 'number');
    assert.equal(res.sections.length, 10);

    const titles = res.sections.map((s) => s.title);
    for (const title of titles) {
      assert.ok(!/new in|just in/i.test(title), `forbidden title: ${title}`);
    }
    assert.ok(titles.includes('From Everlane'));
    assert.ok(titles.includes('From Steve Madden'));
    assert.ok(titles.includes('From Kith'));
    assert.ok(titles.includes('From Fashion Nova'));

    const shirtsRail = res.sections.find((s) => s.id === 'shirts-knits');
    assert.ok(shirtsRail);
    // Interleaved [shirt-1, knit-1, shared-1, shirt-2, knit-2] with duplicate shared-1 removed
    assert.deepEqual(
      shirtsRail.items.map((it) => it.id),
      ['shirt-1', 'knit-1', 'shared-1', 'shirt-2', 'knit-2'],
    );

    const returnedShared = shirtsRail.items.find((it) => it.id === 'shared-1');
    assert.ok(returnedShared);
    assert.equal(returnedShared.url, sharedItem.url);
    assert.deepEqual(returnedShared.variants_by_size, {});
    assert.ok(returnedShared.description.length <= 160);
    assert.ok(returnedShared.description.length > 0);
  });

  it('drops empty sections without marking partial and returns empty sections when all fail', async () => {
    const partialEmpty = await storefront('women', {
      searchMixed: async (query) => {
        if (query === "women's dress") {
          return { items: [makeItem('dress-1')], source: 'live', ms: 3 };
        }
        return { items: [], source: 'empty', ms: 3 };
      },
      search: async () => ({ items: [], source: 'empty', ms: 3 }),
    });

    assert.equal(partialEmpty.department, 'women');
    assert.equal(partialEmpty.partial, undefined);
    assert.equal(partialEmpty.sections.length, 1);
    assert.equal(partialEmpty.sections[0].id, 'dresses');

    const allFailed = await storefront('women', {
      searchMixed: async () => {
        throw new Error('boom');
      },
      search: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(allFailed.department, 'women');
    assert.deepEqual(allFailed.sections, []);
    assert.equal(allFailed.partial, undefined);
  });

  it('returns ready sections at budget deadline and sets partial: true when slow sections are dropped', async () => {
    const t0 = Date.now();
    const res = await storefront('women', {
      budgetMs: 120,
      searchMixed: async (query) => {
        if (query === "women's dress") {
          return { items: [makeItem('fast-dress')], source: 'live', ms: 5 };
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { items: [makeItem('late')], source: 'live', ms: 5000 };
      },
      search: async (_q, _g, opts) => {
        if (opts?.shops?.[0] === 'everlane.com') {
          return { items: [makeItem('fast-everlane')], source: 'live', ms: 5 };
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { items: [makeItem('late-store')], source: 'live', ms: 5000 };
      },
    });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 400, `expected quick budget cutoff, took ${elapsed}ms`);
    assert.equal(res.partial, true);
    assert.deepEqual(
      res.sections.map((s) => s.id),
      ['dresses', 'from-everlane'],
    );
  });
});

describe('buildProductPayload and helpers', () => {
  it('validates Shopify GIDs', () => {
    assert.equal(isValidShopifyGid('gid://shopify/ProductVariant/41356358090885'), true);
    assert.equal(isValidShopifyGid('gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC'), true);
    assert.equal(isValidShopifyGid(''), false);
    assert.equal(isValidShopifyGid('https://example.com'), false);
    assert.equal(isValidShopifyGid('gid://other/Product/1'), false);
    assert.equal(isValidShopifyGid('gid://shopify/Product/1?foo=bar'), false);
  });

  it('builds exact showProduct + sizes_detail payload with untouched URL and bullet extraction', () => {
    const detail: ProductDetail = {
      id: 'gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC',
      title: 'NAXOS BLACK LEATHER',
      description: 'Timeless slip-on loafer crafted from leather. Features a lug sole for traction.',
      description_html:
        '<p>Intro</p><ul><li>1.5 inch heel height</li><li>Leather upper material</li><li>Textile &amp; synthetic lining</li><li>Synthetic sole</li><li>Imported</li><li>Sixth bullet ignored</li></ul>',
      images: [
        'https://cdn.shopify.com/s/files/1/2170/8465/files/img1.jpg',
        'https://cdn.shopify.com/s/files/1/2170/8465/files/img2.jpg',
      ],
      options: [
        {
          name: 'Numeric shoe size',
          values: [
            { label: '8', available: true, exists: true },
            { label: '9', available: false, exists: true },
            { label: '10', available: true, exists: true },
          ],
        },
      ],
      selected: [{ name: 'Numeric shoe size', label: '8' }],
      variant: {
        id: 'gid://shopify/ProductVariant/41356358090885',
        price: 149.95,
        available: true,
        options: [{ name: 'Numeric shoe size', label: '8' }],
        url: 'https://www.stevemadden.com/products/naxos-black-leather?variant=41356358090885&_gsid=wYMi6p9HHoRK&utm_source=shopify&utm_medium=catalog',
      },
    };

    const payload = buildProductPayload(detail, 'men');

    assert.deepEqual(Object.keys(payload).sort(), [
      'description',
      'details',
      'images',
      'item',
      'sizes',
      'sizes_detail',
      'slot',
      'why',
    ]);

    assert.equal(payload.slot, '');
    assert.equal(payload.why, '');
    assert.deepEqual(payload.images, detail.images);
    assert.deepEqual(payload.sizes, ['8', '10']);
    assert.deepEqual(payload.sizes_detail, [
      { label: '8', available: true },
      { label: '9', available: false },
      { label: '10', available: true },
    ]);
    assert.deepEqual(payload.details, [
      '1.5 inch heel height',
      'Leather upper material',
      'Textile & synthetic lining',
      'Synthetic sole',
      'Imported',
    ]);
    for (const b of payload.details) {
      assert.ok(b.length < 120);
    }

    assert.equal(payload.item.id, detail.id);
    assert.equal(payload.item.variant_id, detail.variant.id);
    assert.equal(payload.item.title, detail.title);
    assert.equal(payload.item.price, 149.95);
    assert.equal(payload.item.url, detail.variant.url);
    assert.equal(payload.item.image, detail.images[0]);
    assert.equal(payload.item.store, 'Steve Madden');
    assert.equal(payload.item.store_domain, 'stevemadden.myshopify.com');
    assert.equal(payload.item.rating, null);
    assert.equal(payload.item.rating_count, null);
    assert.deepEqual(payload.item.sizes, ['8', '10']);
    assert.deepEqual(payload.item.variants_by_size, {});
    assert.equal(payload.item.department, 'men');
  });

  it('splits plain text sentences into short bullets when no <li> tags exist', () => {
    const bullets = extractDetailBullets(
      'Plain text with no list items.',
      'First crisp sentence. Second crisp sentence! Third sentence? Fourth sentence. Fifth sentence. Sixth sentence.',
    );
    assert.equal(bullets.length, 5);
    assert.equal(bullets[0], 'First crisp sentence.');
    assert.equal(bullets[4], 'Fifth sentence.');
    for (const b of bullets) {
      assert.ok(b.length < 120);
    }
  });
});
