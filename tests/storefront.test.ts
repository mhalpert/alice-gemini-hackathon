import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Gender, Item, SearchResult } from '../src/types.ts';
import type { ProductDetail } from '../src/store/catalog.ts';
import { ALL_SITES, OTHER_SITES } from '../src/store/stores.ts';
import {
  buildProductPayload,
  createStorefront,
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

function makeItems(prefix: string, count: number, department: Gender): Item[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem(`${prefix}-${i + 1}`, { department }),
  );
}

describe('storefront() orchestration', () => {
  it('makes exactly 10 search calls for a full load (6 OTHER_SITES category rails + 4 store rails), trims descriptions, clears variants_by_size, and preserves URLs', async () => {
    const calls: Array<{ query: string; gender: Gender; shops?: string[]; limit?: number }> = [];

    const fakeSearch = async (
      query: string,
      gender: Gender,
      opts?: { shops?: string[]; limit?: number },
    ): Promise<SearchResult> => {
      calls.push({ query, gender, shops: opts?.shops, limit: opts?.limit });
      return {
        items: makeItems(`${query.replace(/\W+/g, '-')}-${opts?.shops?.length ?? 0}`, 5, gender),
        source: 'live',
        ms: 5,
      };
    };

    const res = await storefront('men', { search: fakeSearch, env: {} });

    assert.equal(calls.length, 10, `expected exactly 10 search calls, got ${calls.length}`);
    assert.equal(res.department, 'men');
    assert.equal(res.partial, undefined);
    assert.deepEqual(res.storefront, { searches: 10, shared: false });
    assert.equal(typeof res.ms, 'number');
    assert.equal(res.sections.length, 10);

    // First 6 calls are category rails restricted to OTHER_SITES
    const catCalls = calls.filter((c) => c.query !== "men's clothing");
    assert.equal(catCalls.length, 6);
    for (const c of catCalls) {
      assert.deepEqual(c.shops, OTHER_SITES);
      assert.equal(c.limit, 8);
    }

    // Remaining 4 calls are per-store rails
    const storeCalls = calls.filter((c) => c.query === "men's clothing");
    assert.equal(storeCalls.length, 4);
    assert.deepEqual(
      storeCalls.map((c) => c.shops?.[0]),
      ['everlane.com', 'stevemadden.com', 'kith.com', 'fashionnova.com'],
    );

    const titles = res.sections.map((s) => s.title);
    for (const title of titles) {
      assert.ok(!/new in|just in/i.test(title), `forbidden title: ${title}`);
    }
    assert.ok(titles.includes('From Everlane'));
    assert.ok(titles.includes('From Steve Madden'));
    assert.ok(titles.includes('From Kith'));
    assert.ok(titles.includes('From Fashion Nova'));

    const sample = res.sections[0].items[0];
    assert.ok(sample.url.includes('_gsid=abc123&utm_source=shopify&utm_medium=catalog'));
    assert.deepEqual(sample.variants_by_size, {});
    assert.ok(sample.description.length <= 160 && sample.description.length > 0);
  });

  it('tops up from ALL_SITES with exactly one extra call only for a thin category rail (< 4 items) and deduplicates', async () => {
    const calls: Array<{ query: string; shops?: string[] }> = [];

    const fakeSearch = async (
      query: string,
      gender: Gender,
      opts?: { shops?: string[] },
    ): Promise<SearchResult> => {
      calls.push({ query, shops: opts?.shops });
      if (query === "women's bag") {
        if (opts?.shops === OTHER_SITES) {
          // Thin rail: only 2 items from OTHER_SITES
          return {
            items: [
              makeItem('bag-shared', { department: gender }),
              makeItem('bag-2', { department: gender }),
            ],
            source: 'live',
            ms: 5,
          };
        }
        // Top-up call from ALL_SITES with 1 duplicate and 4 new items
        return {
          items: [
            makeItem('bag-shared', { department: gender }),
            makeItem('bag-3', { department: gender }),
            makeItem('bag-4', { department: gender }),
            makeItem('bag-5', { department: gender }),
            makeItem('bag-6', { department: gender }),
          ],
          source: 'live',
          ms: 5,
        };
      }
      // All other rails have >= 4 items so no top-up should happen
      return {
        items: makeItems(query.replace(/\W+/g, '-'), 4, gender),
        source: 'live',
        ms: 5,
      };
    };

    const res = await storefront('women', { search: fakeSearch, env: {} });

    assert.equal(calls.length, 11, `expected 10 base + 1 thin top-up = 11 calls, got ${calls.length}`);
    assert.deepEqual(res.storefront, { searches: 11, shared: false });

    const bagCalls = calls.filter((c) => c.query === "women's bag");
    assert.equal(bagCalls.length, 2);
    assert.deepEqual(bagCalls[0].shops, OTHER_SITES);
    assert.deepEqual(bagCalls[1].shops, ALL_SITES);

    const bagSection = res.sections.find((s) => s.id === 'bags');
    assert.ok(bagSection);
    assert.deepEqual(
      bagSection.items.map((i) => i.id),
      ['bag-shared', 'bag-2', 'bag-3', 'bag-4', 'bag-5', 'bag-6'],
    );
  });

  it('shares a single in-flight build across concurrent requests for the same department (10 calls, not 20)', async () => {
    let callCount = 0;

    const fakeSearch = async (query: string, gender: Gender): Promise<SearchResult> => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        items: makeItems(`${query.replace(/\W+/g, '-')}`, 4, gender),
        source: 'live',
        ms: 40,
      };
    };

    const loader = createStorefront({ search: fakeSearch, env: {} });
    const [first, second] = await Promise.all([loader('women'), loader('women')]);

    assert.equal(callCount, 10, `concurrent requests must share 10 calls, got ${callCount}`);
    assert.deepEqual(first.storefront, { searches: 10, shared: false });
    assert.deepEqual(second.storefront, { searches: 0, shared: true });
    assert.equal(first.sections.length, 10);
    assert.equal(second.sections.length, 10);

    // After settling, with ALICE_STOREFRONT_REUSE_S unset (default 0), a third request runs fresh
    const third = await loader('women');
    assert.equal(callCount, 20, `reuse off by default must run 10 fresh calls, got ${callCount}`);
    assert.deepEqual(third.storefront, { searches: 10, shared: false });
  });

  it('reuses a finished result only when ALICE_STOREFRONT_REUSE_S > 0 and expires on the injected clock', async () => {
    let nowMs = 1_000_000;
    let callCount = 0;
    const env: Record<string, string | undefined> = { ALICE_STOREFRONT_REUSE_S: '30' };

    const fakeSearch = async (query: string, gender: Gender): Promise<SearchResult> => {
      callCount += 1;
      return {
        items: makeItems(query.replace(/\W+/g, '-'), 4, gender),
        source: 'live',
        ms: 5,
      };
    };

    const loader = createStorefront({
      search: fakeSearch,
      now: () => nowMs,
      env,
    });

    const first = await loader('men');
    assert.equal(callCount, 10);
    assert.deepEqual(first.storefront, { searches: 10, shared: false });

    // Within 30s reuse window -> 0 new searches
    nowMs += 15_000;
    const reused = await loader('men');
    assert.equal(callCount, 10);
    assert.deepEqual(reused.storefront, { searches: 0, shared: true });
    assert.equal(reused.sections.length, 10);

    // Different department still fetches independently
    const womenRes = await loader('women');
    assert.equal(callCount, 20);
    assert.deepEqual(womenRes.storefront, { searches: 10, shared: false });

    // Past 30s window -> fetches men live again
    nowMs += 20_000;
    const refreshed = await loader('men');
    assert.equal(callCount, 30);
    assert.deepEqual(refreshed.storefront, { searches: 10, shared: false });

    // Switching env back to 0 disables reuse immediately
    env.ALICE_STOREFRONT_REUSE_S = '0';
    const noReuse = await loader('men');
    assert.equal(callCount, 40);
    assert.deepEqual(noReuse.storefront, { searches: 10, shared: false });
  });

  it('drops empty sections without marking partial and returns empty sections when all fail', async () => {
    const partialEmpty = await storefront('women', {
      env: {},
      search: async (query, gender, opts) => {
        if (query === "women's dress" && opts?.shops === OTHER_SITES) {
          return { items: makeItems('dress', 4, gender), source: 'live', ms: 3 };
        }
        return { items: [], source: 'empty', ms: 3 };
      },
    });

    assert.equal(partialEmpty.department, 'women');
    assert.equal(partialEmpty.partial, undefined);
    assert.equal(partialEmpty.sections.length, 1);
    assert.equal(partialEmpty.sections[0].id, 'dresses');

    const allFailed = await storefront('women', {
      env: {},
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
      env: {},
      search: async (query, gender, opts) => {
        if (query === "women's dress") {
          return { items: makeItems('fast-dress', 4, gender), source: 'live', ms: 5 };
        }
        if (opts?.shops?.length === 1 && opts.shops[0] === 'everlane.com') {
          return { items: makeItems('fast-everlane', 4, gender), source: 'live', ms: 5 };
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { items: [makeItem('late')], source: 'live', ms: 5000 };
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
