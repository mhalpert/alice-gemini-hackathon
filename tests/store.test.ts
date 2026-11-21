import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createShopMcp, ShopMcpError } from '../src/store/shopmcp.ts';
import { createSavedStore, savedKey } from '../src/store/saved.ts';
import { toItem, wrongDepartment } from '../src/store/catalog.ts';
import { createStore } from '../src/store/factory.ts';
import { ALL_SITES, OTHER_SITES, storeNameForDomain } from '../src/store/stores.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-store-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function loadFixtureText(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/shopmcp/${name}`, import.meta.url), 'utf8');
}

function loadFixtureJson(name: string): any {
  return JSON.parse(loadFixtureText(name));
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

describe('shopmcp low-level client', () => {
  it('sends exact headers, namespaced _meta keys, and catalog wrapper for search', async () => {
    const searchFixture = loadFixtureText('search.json');
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(searchFixture);
    };

    const mcp = createShopMcp({ url: 'https://mcp.shop.com/', fetch: fakeFetch });
    const saved = createSavedStore({ dir: makeTempDir() });
    const store = createStore({ mcp, saved });

    const res = await store.search("men's leather loafers", 'men', {
      limit: 10,
      maxPrice: 200,
    });

    assert.equal(res.source, 'live');
    assert.equal(res.items.length, 3);
    assert.equal(capturedUrl, 'https://mcp.shop.com/');
    assert.equal(capturedInit?.method, 'POST');

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Accept'], 'application/json, text/event-stream');
    assert.equal(headers['MCP-Protocol-Version'], '2026-07-28');
    assert.equal(headers['Mcp-Method'], 'tools/call');
    assert.equal(headers['Mcp-Name'], 'search_catalog');

    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'search_catalog');

    const meta = body.params._meta;
    assert.deepEqual(Object.keys(meta).sort(), [
      'io.modelcontextprotocol/clientCapabilities',
      'io.modelcontextprotocol/clientInfo',
      'io.modelcontextprotocol/protocolVersion',
    ]);
    assert.equal(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    assert.deepEqual(meta['io.modelcontextprotocol/clientInfo'], {
      name: 'alice',
      version: '0.1.0',
    });
    assert.deepEqual(meta['io.modelcontextprotocol/clientCapabilities'], {});

    assert.ok(body.params.arguments.catalog);
    assert.equal(body.params.arguments.catalog.query, "men's leather loafers");
    assert.deepEqual(body.params.arguments.catalog.context, {
      currency: 'USD',
      address_country: 'US',
    });
    assert.deepEqual(body.params.arguments.catalog.filters.shops, ALL_SITES);
    assert.deepEqual(body.params.arguments.catalog.filters.attributes, [
      { name: 'Target gender', values: ['Male'] },
    ]);
    assert.equal(body.params.arguments.catalog.filters.available, true);
    assert.deepEqual(body.params.arguments.catalog.filters.price, { max: 20000 });
    assert.deepEqual(body.params.arguments.catalog.pagination, { limit: 10 });
  });

  it('denies dangerous and unlisted tools before calling fetch', async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({});
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const deniedTools = [
      'complete_checkout',
      'create_checkout',
      'complete_spend_request',
      'pay_now',
      'submit_payment',
      'place_order',
      'unknown_tool',
    ];

    for (const tool of deniedTools) {
      await assert.rejects(
        () => mcp.call(tool, {}),
        (err: unknown) => {
          assert.ok(err instanceof ShopMcpError);
          assert.equal(err.code, 'denied');
          return true;
        },
      );
    }

    assert.equal(fetchCalls, 0);
  });

  it('handles JSON-RPC error fixture bad_tool.json', async () => {
    const badToolText = loadFixtureText('bad_tool.json');
    const fakeFetch: typeof fetch = async () => jsonResponse(badToolText);
    const mcp = createShopMcp({ fetch: fakeFetch });

    await assert.rejects(
      () => mcp.call('search_catalog', {}),
      (err: unknown) => {
        assert.ok(err instanceof ShopMcpError);
        assert.equal(err.code, 'rpc');
        assert.match(err.message, /Unknown tool/i);
        return true;
      },
    );
  });

  it('parses text/event-stream responses using the last data line', async () => {
    const searchFixture = loadFixtureText('search.json');
    const sseBody = `event: progress\ndata: {"partial":true}\n\nevent: message\ndata: ${searchFixture}\n\n`;
    const fakeFetch: typeof fetch = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });

    const mcp = createShopMcp({ fetch: fakeFetch });
    const result = await mcp.call('search_catalog', { catalog: { query: 'loafers' } });
    assert.equal(result.products.length, 3);
  });
});

describe('toItem and store mapping on real fixtures', () => {
  it('maps Steve Madden search fixture accurately', () => {
    const fixture = loadFixtureJson('search.json');
    const product = fixture.result.structuredContent.products[0];
    const item = toItem(product, 'men');

    assert.ok(item);
    assert.equal(item.id, 'gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC');
    assert.equal(item.variant_id, 'gid://shopify/ProductVariant/41356358090885');
    assert.equal(item.title, 'NAXOS BLACK LEATHER');
    assert.equal(item.price, 149.95);
    assert.equal(item.store, 'Steve Madden');
    assert.equal(item.store_domain, 'stevemadden.myshopify.com');
    assert.equal(item.url, product.variants[0].url);
    assert.equal(
      item.url,
      'https://www.stevemadden.com/products/naxos-black-leather?variant=41356358090885&_gsid=LnFMJbLQAbF9&utm_source=shopify&utm_medium=catalog',
    );
    assert.ok(!item.image.includes('width='));
    assert.ok(!item.image.includes('height='));
    assert.ok(!item.description.includes('<'));
    assert.ok(item.description.length > 0 && item.description.length <= 300);
    assert.equal(item.rating, 5);
    assert.equal(item.rating_count, 12);
    assert.deepEqual(item.sizes.slice(0, 4), ['7', '7.5', '8', '8.5']);
    assert.deepEqual(item.variants_by_size, {
      '7': 'gid://shopify/ProductVariant/41356358090885',
    });
    assert.equal(item.department, 'men');
  });

  it('maps Fashion Nova fixture, keeps product URL untouched, and strips image width/height', () => {
    const fixture = loadFixtureJson('search_fn.json');
    const product = structuredClone(fixture.result.structuredContent.products[0]);
    product.variants[0].media[0].url += '?width=800&height=1200&v=42';
    product.variants[0].price.amount = '1699';
    product.description.plain = '<p>Soft &amp; cozy &quot;knit&quot; &#39;midi&#39;&nbsp;dress</p>';

    const item = toItem(product, 'women');
    assert.ok(item);
    assert.equal(item.price, 16.99);
    assert.equal(item.store, 'Fashion Nova');
    assert.equal(item.store_domain, 'fnova.myshopify.com');
    assert.equal(item.url, product.variants[0].url);
    assert.equal(
      item.url,
      'https://www.fashionnova.com/products/taryn-sweater-midi-dress-fncolorname-black?_gsid=u3DTVEzMkSrw&utm_source=shopify&utm_medium=catalog',
    );
    assert.ok(!item.image.includes('width='));
    assert.ok(!item.image.includes('height='));
    assert.ok(item.image.includes('v=42'));
    assert.equal(item.description, 'Soft & cozy "knit" \'midi\' dress');
    assert.ok(!item.description.includes('<'));
    assert.deepEqual(item.variants_by_size, {
      S: 'gid://shopify/ProductVariant/12201627484284',
    });
  });

  it('drops non-USD, zero-price, and unavailable products', () => {
    const fixture = loadFixtureJson('search.json');
    const base = fixture.result.structuredContent.products[0];

    const eurProduct = structuredClone(base);
    eurProduct.variants[0].price.currency = 'EUR';
    assert.equal(toItem(eurProduct, 'men'), null);

    const zeroProduct = structuredClone(base);
    zeroProduct.variants[0].price.amount = 0;
    assert.equal(toItem(zeroProduct, 'men'), null);

    const oosProduct = structuredClone(base);
    oosProduct.variants[0].availability.available = false;
    assert.equal(toItem(oosProduct, 'men'), null);
  });

  it('maps curated store domains and fallback names', () => {
    assert.equal(storeNameForDomain('fnova.myshopify.com'), 'Fashion Nova');
    assert.equal(storeNameForDomain('m34kzg-ke.myshopify.com'), 'Everlane');
    assert.equal(storeNameForDomain('stevemadden.myshopify.com'), 'Steve Madden');
    assert.equal(storeNameForDomain('kithnyc.myshopify.com'), 'Kith');
    assert.equal(storeNameForDomain('unknown.myshopify.com', 'Custom Shop'), 'Custom Shop');
    assert.deepEqual(OTHER_SITES, ['everlane.com', 'stevemadden.com', 'kith.com']);
  });
});

describe('wrongDepartment truth table', () => {
  const cases: Array<{
    label: string;
    product: { title?: string; handle?: string; variants?: Array<{ url?: string }> };
    men: boolean;
    women: boolean;
  }> = [
    {
      label: "Women's Midi Dress",
      product: { title: "Women's Midi Dress", handle: 'womens-midi-dress' },
      men: true,
      women: false,
    },
    {
      label: "Women's Loafer (title only)",
      product: { title: "Women's Leather Loafer", handle: 'leather-loafer' },
      men: true,
      women: false,
    },
    {
      label: "Men's Leather Loafer",
      product: { title: "Men's Leather Loafer", handle: 'mens-leather-loafer' },
      men: false,
      women: true,
    },
    {
      label: 'mens path in URL',
      product: {
        title: 'Classic Chino',
        handle: 'classic-chino',
        variants: [{ url: 'https://www.everlane.com/products/mens-chino-pant' }],
      },
      men: false,
      women: true,
    },
    {
      label: 'Boys Polo',
      product: { title: 'Boys Polo Shirt', handle: 'boys-polo' },
      men: false,
      women: true,
    },
    {
      label: 'Ladies Blazer',
      product: { title: 'Ladies Tailored Blazer', handle: 'tailored-blazer' },
      men: true,
      women: false,
    },
    {
      label: 'Maternity Jeans',
      product: { title: 'Maternity Skinny Jeans', handle: 'maternity-jeans' },
      men: true,
      women: false,
    },
    {
      label: 'Silk Bralette',
      product: { title: 'Silk Bralette', handle: 'silk-bralette' },
      men: true,
      women: false,
    },
    {
      label: 'Pleated Skirt',
      product: { title: 'Pleated Midi Skirt', handle: 'pleated-skirt' },
      men: true,
      women: false,
    },
    {
      label: 'Girls Cardigan',
      product: { title: 'Girls Knit Cardigan', handle: 'girls-cardigan' },
      men: true,
      women: false,
    },
    {
      label: 'Unisex neutral item',
      product: { title: 'NAXOS BLACK LEATHER', handle: 'naxos-black-leather' },
      men: false,
      women: false,
    },
  ];

  for (const tc of cases) {
    it(tc.label, () => {
      assert.equal(wrongDepartment(tc.product, 'men'), tc.men, `men check for ${tc.label}`);
      assert.equal(wrongDepartment(tc.product, 'women'), tc.women, `women check for ${tc.label}`);
    });
  }
});

describe('rate limiting, timeouts, and saved fallbacks', () => {
  it('429 with retry-after: 3 blocks further calls without fetching and search falls back to saved', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const searchFixture = loadFixtureText('search.json');

    let fetchCalls = 0;
    let shouldRateLimit = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      if (shouldRateLimit) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '3' },
        });
      }
      return jsonResponse(searchFixture);
    };

    const mcp = createShopMcp({ fetch: fakeFetch, now });
    const saved = createSavedStore({ dir: makeTempDir(), now });
    const store = createStore({ mcp, saved, now });

    // Initial live search populates saved cache
    const first = await store.search("men's loafers", 'men', { limit: 6 });
    assert.equal(first.source, 'live');
    assert.equal(first.items.length, 3);
    assert.equal(fetchCalls, 1);

    // Advance past 60 min freshness window so next search hits live and gets 429
    nowMs += 61 * 60 * 1000;
    shouldRateLimit = true;

    const second = await store.search("men's loafers", 'men', { limit: 6 });
    assert.equal(second.source, 'saved');
    assert.equal(second.items.length, 3);
    assert.equal(fetchCalls, 2);
    assert.equal(mcp.blockedUntil(), nowMs + 3000);

    // Subsequent direct mcp.call while blocked must throw rate_limited WITHOUT fetching
    nowMs += 1000;
    await assert.rejects(
      () => mcp.call('search_catalog', { catalog: { query: 'anything' } }),
      (err: unknown) => {
        assert.ok(err instanceof ShopMcpError);
        assert.equal(err.code, 'rate_limited');
        assert.equal(err.retryAfterMs, 2000);
        return true;
      },
    );
    assert.equal(fetchCalls, 2);
  });

  it('timeout falls back to saved-near', async () => {
    let nowMs = 5_000_000;
    const now = () => nowMs;
    const fixture = loadFixtureJson('search.json');
    const savedItems = fixture.result.structuredContent.products
      .map((p: any) => toItem(p, 'men'))
      .filter(Boolean);

    const saved = createSavedStore({ dir: makeTempDir(), now });
    const key = savedKey("men's black leather loafers", 'men', { shops: ALL_SITES, limit: 24 });
    saved.putSaved(key, "men's black leather loafers", 'men', savedItems);

    const fakeFetch: typeof fetch = async () => {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      throw err;
    };

    const mcp = createShopMcp({ fetch: fakeFetch, now, timeoutMs: 50 });
    const store = createStore({ mcp, saved, now });

    const res = await store.search("men's leather loafers", 'men');
    assert.equal(res.source, 'saved-near');
    assert.equal(res.items.length, 3);

    // Plural/singular word overlap: "men's navy chinos" matches saved "men's chino pants"
    const chinoKey = savedKey("men's chino pants", 'men', { shops: ALL_SITES, limit: 24 });
    saved.putSaved(chinoKey, "men's chino pants", 'men', savedItems);
    const nearChino = await store.search("men's navy chinos", 'men');
    assert.equal(nearChino.source, 'saved-near');
    assert.equal(nearChino.items.length, 3);
  });

  it('search never throws when fetch rejects with no saved entries', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNRESET');
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const saved = createSavedStore({ dir: makeTempDir() });
    const store = createStore({ mcp, saved });

    const res = await store.search('linen blazer', 'women');
    assert.equal(res.source, 'empty');
    assert.deepEqual(res.items, []);
    assert.equal(typeof res.ms, 'number');
  });
});

describe('ALICE_SAVED modes', () => {
  it('fallback (default) hits Shop MCP even with a fresh saved entry, writes live results, falls back on failure, and logs mode once', async () => {
    const prevMode = process.env.ALICE_SAVED;
    delete process.env.ALICE_SAVED;

    let nowMs = 10_000_000;
    const now = () => nowMs;
    const searchFixtureText = loadFixtureText('search.json');
    const searchFixture = JSON.parse(searchFixtureText);
    const savedItems = searchFixture.result.structuredContent.products
      .map((p: any) => toItem(p, 'men'))
      .filter(Boolean);

    let fetchCalls = 0;
    let shouldFail = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      if (shouldFail) {
        throw new Error('upstream down');
      }
      return jsonResponse(searchFixtureText);
    };

    const mcp = createShopMcp({ fetch: fakeFetch, now });
    const saved = createSavedStore({ dir: makeTempDir(), now });
    const key = savedKey("men's loafers", 'men', { shops: ALL_SITES, limit: 6 });
    saved.putSaved(key, "men's loafers", 'men', savedItems);

    const store = createStore({ mcp, saved, now });

    const loggedLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      loggedLines.push(args.map(String).join(' '));
      origLog(...args);
    };

    try {
      // Fresh saved entry exists (age 0ms), yet default fallback mode still calls Shop MCP
      const liveRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(liveRes.source, 'live');
      assert.equal(liveRes.items.length, 3);
      assert.equal(fetchCalls, 1);

      // Advance time and verify saved entry was refreshed on live success
      nowMs += 5000;
      shouldFail = true;
      const fallbackRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(fallbackRes.source, 'saved');
      assert.equal(fallbackRes.items.length, 3);
      assert.equal(fetchCalls, 2);

      // Mode banner logged exactly once at first use
      const modeLogs = loggedLines.filter((l) => l.includes('[store] saved results mode:'));
      assert.deepEqual(modeLogs, ['[store] saved results mode: fallback']);
    } finally {
      console.log = origLog;
      if (prevMode === undefined) delete process.env.ALICE_SAVED;
      else process.env.ALICE_SAVED = prevMode;
    }
  });

  it('fresh skips Shop MCP when saved entry is under 60 minutes old and fetches once stale', async () => {
    const prevMode = process.env.ALICE_SAVED;
    process.env.ALICE_SAVED = 'fresh';

    let nowMs = 20_000_000;
    const now = () => nowMs;
    const searchFixtureText = loadFixtureText('search.json');
    const searchFixture = JSON.parse(searchFixtureText);
    const savedItems = searchFixture.result.structuredContent.products
      .map((p: any) => toItem(p, 'men'))
      .filter(Boolean);

    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonResponse(searchFixtureText);
    };

    const mcp = createShopMcp({ fetch: fakeFetch, now });
    const saved = createSavedStore({ dir: makeTempDir(), now });
    const key = savedKey("men's loafers", 'men', { shops: ALL_SITES, limit: 6 });
    saved.putSaved(key, "men's loafers", 'men', savedItems);

    const store = createStore({ mcp, saved, now });

    try {
      const freshRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(freshRes.source, 'saved');
      assert.equal(freshRes.items.length, 3);
      assert.equal(fetchCalls, 0);

      // Advance past 60 min -> now fetches live
      nowMs += 61 * 60 * 1000;
      const liveRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(liveRes.source, 'live');
      assert.equal(liveRes.items.length, 3);
      assert.equal(fetchCalls, 1);
    } finally {
      if (prevMode === undefined) delete process.env.ALICE_SAVED;
      else process.env.ALICE_SAVED = prevMode;
    }
  });

  it('off never reads or writes saved results and returns empty on failure', async () => {
    const prevMode = process.env.ALICE_SAVED;
    process.env.ALICE_SAVED = 'off';

    const nowMs = 30_000_000;
    const now = () => nowMs;
    const searchFixtureText = loadFixtureText('search.json');
    const searchFixture = JSON.parse(searchFixtureText);
    const savedItems = searchFixture.result.structuredContent.products
      .map((p: any) => toItem(p, 'men'))
      .filter(Boolean);

    let fetchCalls = 0;
    let shouldFail = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      if (shouldFail) {
        throw new Error('upstream down');
      }
      return jsonResponse(searchFixtureText);
    };

    const rawSaved = createSavedStore({ dir: makeTempDir(), now });
    const key = savedKey("men's loafers", 'men', { shops: ALL_SITES, limit: 6 });
    rawSaved.putSaved(key, "men's loafers", 'men', savedItems);

    let getCalls = 0;
    let putCalls = 0;
    let nearCalls = 0;
    const trackedSaved = {
      getSaved: (k: string) => {
        getCalls += 1;
        return rawSaved.getSaved(k);
      },
      putSaved: (k: string, q: string, g: 'men' | 'women', items: any[]) => {
        putCalls += 1;
        return rawSaved.putSaved(k, q, g, items);
      },
      nearestSaved: (q: string, g: 'men' | 'women') => {
        nearCalls += 1;
        return rawSaved.nearestSaved(q, g);
      },
      flush: () => rawSaved.flush(),
    };

    const mcp = createShopMcp({ fetch: fakeFetch, now });
    const store = createStore({ mcp, saved: trackedSaved, now });

    try {
      const liveRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(liveRes.source, 'live');
      assert.equal(liveRes.items.length, 3);
      assert.equal(fetchCalls, 1);
      assert.equal(getCalls, 0);
      assert.equal(putCalls, 0);
      assert.equal(nearCalls, 0);

      shouldFail = true;
      const failRes = await store.search("men's loafers", 'men', { limit: 6 });
      assert.equal(failRes.source, 'empty');
      assert.deepEqual(failRes.items, []);
      assert.equal(fetchCalls, 2);
      assert.equal(getCalls, 0);
      assert.equal(putCalls, 0);
      assert.equal(nearCalls, 0);
    } finally {
      if (prevMode === undefined) delete process.env.ALICE_SAVED;
      else process.env.ALICE_SAVED = prevMode;
    }
  });
});

describe('lookup, getProduct, and sizeVariant', () => {
  it('lookup keys by both product id and variant id', async () => {
    const lookupText = loadFixtureText('lookup.json');
    const fakeFetch: typeof fetch = async () => jsonResponse(lookupText);
    const mcp = createShopMcp({ fetch: fakeFetch });
    const saved = createSavedStore({ dir: makeTempDir() });
    const store = createStore({ mcp, saved });

    const prodId = 'gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC';
    const varId = 'gid://shopify/ProductVariant/41356358090885';
    const map = await store.lookup([prodId, varId]);

    assert.ok(map.has(prodId));
    assert.ok(map.has(varId));
    assert.equal(map.get(varId)?.available, true);
    assert.equal(map.get(varId)?.price, 149.95);
    assert.equal(map.get(prodId)?.item?.title, 'NAXOS BLACK LEATHER');
  });

  it('getProduct parses get_product.json and sizeVariant passes product id on step 3', async () => {
    const baseFixture = loadFixtureJson('get_product.json');
    const calls: any[] = [];

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.params.arguments);

      const reqSelected = body.params.arguments.catalog.selected as
        | Array<{ name: string; label: string }>
        | undefined;
      const cloned = structuredClone(baseFixture);

      if (reqSelected) {
        const sizeSel = reqSelected.find((s) => s.name === 'Numeric shoe size');
        if (sizeSel?.label === '11') {
          cloned.result.structuredContent.product.selected = reqSelected;
          cloned.result.structuredContent.product.variants[0].id =
            'gid://shopify/ProductVariant/99999911';
          cloned.result.structuredContent.product.variants[0].options = reqSelected;
        } else if (sizeSel?.label === '12') {
          cloned.result.structuredContent.product.selected = reqSelected;
          cloned.result.structuredContent.product.variants[0].id =
            'gid://shopify/ProductVariant/99999912';
          cloned.result.structuredContent.product.variants[0].availability.available = false;
          const sizeOpt = cloned.result.structuredContent.product.options[0];
          for (const val of sizeOpt.values) {
            if (val.label === '12' || val.label === '11.5') val.available = false;
          }
        }
      }

      return jsonResponse(cloned);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const saved = createSavedStore({ dir: makeTempDir() });
    const store = createStore({ mcp, saved });

    // ProductDetail.variant.url must keep every query parameter byte for byte
    const detail = await store.getProduct('gid://shopify/ProductVariant/41356358090885');
    assert.ok(detail);
    assert.equal(detail.variant.url, baseFixture.result.structuredContent.product.variants[0].url);
    assert.equal(
      detail.variant.url,
      'https://www.stevemadden.com/products/naxos-black-leather?variant=41356358090885&_gsid=wYMi6p9HHoRK&utm_source=shopify&utm_medium=catalog',
    );
    calls.length = 0;

    // Select size "11.0" -> matches "11" and calls step 3 with PRODUCT id
    const okRes = await store.sizeVariant('gid://shopify/ProductVariant/41356358090885', '11.0');
    assert.equal(okRes.ok, true);
    assert.equal(okRes.variant_id, 'gid://shopify/ProductVariant/99999911');
    assert.equal(okRes.size, '11');
    assert.equal(okRes.available, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].catalog.id, 'gid://shopify/ProductVariant/41356358090885');
    assert.equal(calls[1].catalog.id, 'gid://shopify/p/S43gSuq5Wp4NZUwVSrOqC');
    assert.deepEqual(calls[1].catalog.selected, [
      { name: 'Color', label: 'Black Leather' },
      { name: 'Numeric shoe size', label: '11' },
    ]);

    // Sold out size -> returns nearest available
    const oosRes = await store.sizeVariant('gid://shopify/ProductVariant/41356358090885', '12');
    assert.equal(oosRes.ok, false);
    assert.equal(oosRes.available, false);
    assert.equal(oosRes.nearest, '11');
    assert.match(oosRes.reason ?? '', /sold out; nearest 11/i);

    // Server silently drops requested selection (returns original size 7 instead of 10)
    const droppedRes = await store.sizeVariant('gid://shopify/ProductVariant/41356358090885', '10');
    assert.equal(droppedRes.ok, false);
    assert.equal(droppedRes.variant_id, null);
    assert.equal(droppedRes.reason, 'could not select size 10');

    // Non-existent size
    const missingRes = await store.sizeVariant('gid://shopify/ProductVariant/41356358090885', '99');
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.variant_id, null);
    assert.match(missingRes.reason ?? '', /99 is not offered/i);

    // productImages puts item.image first and deduplicates ignoring query strings (up to 8)
    const searchFixture = loadFixtureJson('search.json');
    const item = toItem(searchFixture.result.structuredContent.products[0], 'men');
    assert.ok(item);
    const imgs = await store.productImages(item);
    assert.equal(imgs.length, 7);
    assert.equal(imgs[0], item.image);
  });

  it('sizeVariant sets both options on products with separate Size/Waist + Inseam/Length or companion Shoe size', async () => {
    const baseFixture = loadFixtureJson('get_product.json');
    const sentSelected: Array<Array<{ name: string; label: string }> | undefined> = [];

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const reqSelected = body.params.arguments.catalog.selected as
        | Array<{ name: string; label: string }>
        | undefined;
      sentSelected.push(reqSelected);

      const cloned = structuredClone(baseFixture);
      const id = body.params.arguments.catalog.id;

      if (id === 'gid://shopify/ProductVariant/jean-1' || id === 'gid://shopify/p/jean') {
        cloned.result.structuredContent.product.id = 'gid://shopify/p/jean';
        cloned.result.structuredContent.product.options = [
          {
            name: 'Size',
            values: [
              { label: '28', available: true, exists: true },
              { label: '29', available: true, exists: true },
            ],
          },
          {
            name: 'Inseam',
            values: [
              { label: '27.5” Inseam', available: true, exists: true },
              { label: '29.5” Inseam', available: true, exists: true },
            ],
          },
        ];
        cloned.result.structuredContent.product.selected = reqSelected ?? [
          { name: 'Size', label: '28' },
          { name: 'Inseam', label: '27.5” Inseam' },
        ];
        cloned.result.structuredContent.product.variants[0].id = 'gid://shopify/ProductVariant/jean-29-295';
      } else {
        cloned.result.structuredContent.product.id = 'gid://shopify/p/heel';
        cloned.result.structuredContent.product.options = [
          {
            name: 'Size',
            values: [
              { label: '7', available: true, exists: true },
              { label: '8', available: true, exists: true },
            ],
          },
          {
            name: 'Shoe size',
            values: [
              { label: '7 US', available: false, exists: true },
              { label: '8 US', available: false, exists: true },
            ],
          },
        ];
        cloned.result.structuredContent.product.selected = reqSelected ?? [
          { name: 'Size', label: '7' },
        ];
        cloned.result.structuredContent.product.variants[0].id = 'gid://shopify/ProductVariant/heel-8';
      }
      return jsonResponse(cloned);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    const jeanRes = await store.sizeVariant('gid://shopify/ProductVariant/jean-1', '29', {
      gender: 'women',
    });
    assert.equal(jeanRes.ok, true);
    assert.deepEqual(sentSelected[1], [
      { name: 'Size', label: '29' },
      { name: 'Inseam', label: '29.5” Inseam' },
    ]);

    // Companion "Shoe size" with no available values must NOT be added to selected
    const heelRes = await store.sizeVariant('gid://shopify/ProductVariant/heel-7', '8', {
      gender: 'women',
    });
    assert.equal(heelRes.ok, true);
    assert.deepEqual(sentSelected[3], [{ name: 'Size', label: '8' }]);
  });
});

describe('cart client', () => {
  it('createCart sends top-level shop, no catalog wrapper, and idempotency key', async () => {
    let capturedBody: any;
    let capturedTool = '';

    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedTool = (init?.headers as Record<string, string>)['Mcp-Name'];
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            cart: {
              id: 'gid://shopify/Cart/abc123',
              continue_url: 'https://www.stevemadden.com/cart/c/abc123',
              totals: [
                { type: 'subtotal', amount: 14995 },
                { type: 'total', amount: 16195 },
              ],
              line_items: [
                {
                  id: 'line-1',
                  item: { id: 'gid://shopify/ProductVariant/41356358090885' },
                  quantity: 1,
                },
              ],
              messages: [],
            },
          },
          isError: false,
        },
      });
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const saved = createSavedStore({ dir: makeTempDir() });
    const store = createStore({ mcp, saved });

    const res = await store.createCart('stevemadden.myshopify.com', [
      { variant_id: 'gid://shopify/ProductVariant/41356358090885' },
    ]);

    assert.equal(capturedTool, 'create_cart');
    const args = capturedBody.params.arguments;
    assert.equal(args.catalog, undefined);
    assert.equal(args.shop, 'stevemadden.myshopify.com');
    assert.deepEqual(args.cart, {
      line_items: [{ item: { id: 'gid://shopify/ProductVariant/41356358090885' }, quantity: 1 }],
    });
    assert.equal(typeof args.meta['idempotency-key'], 'string');
    assert.ok(args.meta['idempotency-key'].length > 10);

    assert.equal(res.cart_id, 'gid://shopify/Cart/abc123');
    assert.equal(res.continue_url, 'https://www.stevemadden.com/cart/c/abc123');
    assert.equal(res.total_usd, 161.95);
    assert.equal(res.line_items.length, 1);
    assert.equal(res.error, undefined);
  });

  it('createCart parses real create_cart.json fixture (top-level structuredContent cart) and subtotal-only carts', async () => {
    const fixtureText = loadFixtureText('create_cart.json');
    let callNum = 0;

    const fakeFetch: typeof fetch = async () => {
      callNum += 1;
      if (callNum === 1) {
        return jsonResponse(fixtureText);
      }
      // Fresh cart with only subtotal in totals[]
      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: {
          structuredContent: {
            id: 'gid://shopify/Cart/FRESH123',
            continue_url: 'https://fnova.myshopify.com/cart/c/FRESH123',
            currency: 'USD',
            totals: [{ type: 'subtotal', amount: 3450, display_text: 'Subtotal' }],
            line_items: [],
            messages: [],
          },
          isError: false,
        },
      });
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    const res = await store.createCart('fnova.myshopify.com', [
      { variant_id: 'gid://shopify/ProductVariant/722039242769', quantity: 1 },
    ]);
    assert.equal(res.error, undefined);
    assert.equal(res.cart_id, 'gid://shopify/Cart/EXAMPLECARTTOKEN000000000?key=EXAMPLEKEY');
    assert.equal(
      res.continue_url,
      'https://fnova.myshopify.com/cart/c/EXAMPLECARTTOKEN000000000?key=EXAMPLEKEY',
    );
    assert.equal(res.total_usd, 20);
    assert.equal(res.line_items.length, 1);
    assert.equal(res.line_items[0].item.id, 'gid://shopify/ProductVariant/722039242769');

    const subtotalOnly = await store.createCart('fnova.myshopify.com', [
      { variant_id: 'gid://shopify/ProductVariant/722039242769', quantity: 1 },
    ]);
    assert.equal(subtotalOnly.error, undefined);
    assert.equal(subtotalOnly.cart_id, 'gid://shopify/Cart/FRESH123');
    assert.equal(subtotalOnly.total_usd, 34.5);
  });

  it('getCart and updateCart send expected shapes, parse top-level cart, and never throw on errors', async () => {
    const seen: Array<{ tool: string; args: any }> = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ tool: body.params.name, args: body.params.arguments });
      if (body.params.name === 'update_cart') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            structuredContent: {
              id: 'gid://shopify/Cart/abc123',
              continue_url: 'https://www.stevemadden.com/cart/c/abc123-v2',
              totals: [{ type: 'subtotal', amount: 29990 }],
              line_items: [],
              messages: [],
            },
          },
        });
      }
      throw new Error('network down');
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    const getRes = await store.getCart('stevemadden.myshopify.com', 'gid://shopify/Cart/abc123');
    assert.equal(getRes.cart_id, null);
    assert.ok(getRes.error);
    assert.deepEqual(seen[0], {
      tool: 'get_cart',
      args: { shop: 'stevemadden.myshopify.com', id: 'gid://shopify/Cart/abc123' },
    });

    const updRes = await store.updateCart(
      'stevemadden.myshopify.com',
      'gid://shopify/Cart/abc123',
      [{ variant_id: 'gid://shopify/ProductVariant/41356358090885', quantity: 2 }],
    );
    assert.equal(updRes.continue_url, 'https://www.stevemadden.com/cart/c/abc123-v2');
    assert.equal(updRes.total_usd, 299.9);
    assert.deepEqual(seen[1], {
      tool: 'update_cart',
      args: {
        shop: 'stevemadden.myshopify.com',
        id: 'gid://shopify/Cart/abc123',
        cart: {
          line_items: [
            { item: { id: 'gid://shopify/ProductVariant/41356358090885' }, quantity: 2 },
          ],
        },
      },
    });
  });
});
