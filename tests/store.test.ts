import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createShopMcp, ShopMcpError } from '../src/store/shopmcp.ts';
import { redactSecrets } from '../src/store/auth.ts';
import { setCallLogSink, setCallRoom } from '../src/store/log.ts';
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

  it('Everlane Transit Chino: returns sold out without 2nd get_product when exists/available is false, and preserves trailing whitespace on Color "Olive "', async () => {
    const baseFixture = loadFixtureJson('get_product.json');
    const calls: Array<{ id: string; selected?: Array<{ name: string; label: string }> }> = [];

    const transitOptions = [
      {
        name: 'Waist',
        values: [
          { label: '28', available: false, exists: false },
          { label: '29', available: false, exists: false },
          { label: '30', available: false, exists: false },
          { label: '31', available: false, exists: false },
          { label: '32', available: false, exists: false },
          { label: '33', available: false, exists: false },
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
    ];

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const cat = body.params.arguments.catalog;
      calls.push({ id: cat.id, selected: cat.selected });

      const cloned = structuredClone(baseFixture);
      cloned.result.structuredContent.product.id = 'gid://shopify/p/transit-chino';
      cloned.result.structuredContent.product.title = 'The Transit Chino | Olive  | Slim';
      cloned.result.structuredContent.product.options = transitOptions;
      cloned.result.structuredContent.product.selected = cat.selected ?? [
        { name: 'Color', label: 'Olive ' },
        { name: 'Waist', label: '36' },
        { name: 'Length', label: '30' },
      ];
      cloned.result.structuredContent.product.variants[0].id =
        cat.selected ? 'gid://shopify/ProductVariant/transit-38-32' : 'gid://shopify/ProductVariant/transit-38-30';
      cloned.result.structuredContent.product.variants[0].availability.available = true;
      return jsonResponse(cloned);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    // Asking for "32" (available: false, exists: false) must NOT make a 2nd get_product call
    const res32 = await store.sizeVariant('gid://shopify/ProductVariant/transit-38-30', '32', {
      gender: 'men',
    });
    assert.equal(calls.length, 1);
    assert.equal(res32.ok, false);
    assert.equal(res32.available, false);
    assert.deepEqual(res32.sizes_available, ['38']);
    assert.equal(res32.nearest, '38');
    assert.equal(res32.reason, '32 is sold out (sizes left: 38)');

    // Asking for "38" (when initial selected waist is different) makes 2nd call keeping Color "Olive " verbatim & Length "32" for men
    const res38 = await store.sizeVariant('gid://shopify/ProductVariant/transit-38-30', '38', {
      gender: 'men',
    });
    assert.equal(calls.length, 3);
    assert.equal(res38.ok, true);
    assert.equal(res38.variant_id, 'gid://shopify/ProductVariant/transit-38-32');
    assert.deepEqual(calls[2].selected, [
      { name: 'Color', label: 'Olive ' },
      { name: 'Waist', label: '38' },
      { name: 'Length', label: '32' },
    ]);
  });

  it('sizeVariant handles EU sneakers ("12" sold out -> nearest 45, "8.5 wide" -> 42 + width note) and separate Waist+Length ("30x34" -> note when 34 unavailable)', async () => {
    const baseFixture = loadFixtureJson('get_product.json');

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const cat = body.params.arguments.catalog;
      const cloned = structuredClone(baseFixture);

      if (cat.id === 'gid://shopify/ProductVariant/eu-sneaker' || cat.id === 'gid://shopify/p/eu-sneaker') {
        cloned.result.structuredContent.product.id = 'gid://shopify/p/eu-sneaker';
        cloned.result.structuredContent.product.title = 'Kith EU Sneaker';
        cloned.result.structuredContent.product.options = [
          {
            name: 'Size',
            values: ['39', '40', '41', '42', '43', '44', '45'].map((label) => ({
              label,
              available: true,
              exists: true,
            })),
          },
        ];
        cloned.result.structuredContent.product.selected = cat.selected ?? [{ name: 'Size', label: '41' }];
        cloned.result.structuredContent.product.variants[0].id = 'gid://shopify/ProductVariant/eu-42';
        cloned.result.structuredContent.product.variants[0].availability.available = true;
      } else {
        cloned.result.structuredContent.product.id = 'gid://shopify/p/perf-chino';
        cloned.result.structuredContent.product.title = 'The Performance Chino';
        cloned.result.structuredContent.product.options = [
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
              { label: '28', available: true, exists: true },
              { label: '30', available: true, exists: true },
              { label: '32', available: true, exists: true },
            ],
          },
        ];
        cloned.result.structuredContent.product.selected = cat.selected ?? [
          { name: 'Waist', label: '32' },
          { name: 'Length', label: '32' },
        ];
        cloned.result.structuredContent.product.variants[0].id = 'gid://shopify/ProductVariant/pc-30-32';
        cloned.result.structuredContent.product.variants[0].availability.available = true;
      }
      return jsonResponse(cloned);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    // EU sneaker: US 12 -> EU 46 not in 39..45 -> sold out with nearest 45
    const eu12 = await store.sizeVariant('gid://shopify/ProductVariant/eu-sneaker', '12', {
      gender: 'men',
    });
    assert.equal(eu12.ok, false);
    assert.equal(eu12.nearest, '45');
    assert.match(eu12.reason ?? '', /EU 46.*sold out.*nearest 45/i);

    // EU sneaker: US 8.5 wide -> EU 42 + width fallback note
    const eu85w = await store.sizeVariant('gid://shopify/ProductVariant/eu-sneaker', '8.5 wide', {
      gender: 'men',
    });
    assert.equal(eu85w.ok, true);
    assert.equal(eu85w.size, '42');
    assert.equal(eu85w.note, "wide width isn't offered; added regular 42");

    // Performance Chino: "30x34" when 34 inseam isn't offered -> selects 30 + Length 32 + note
    const ch3034 = await store.sizeVariant('gid://shopify/ProductVariant/pc-32-32', '30x34', {
      gender: 'men',
    });
    assert.equal(ch3034.ok, true);
    assert.equal(ch3034.size, '30');
    assert.equal(ch3034.length, '32');
    assert.equal(ch3034.note, "34 inseam isn't offered; used 32");
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

  it('createCart retries once after 300ms with a NEW idempotency key on tool or transport error and extracts UCP JSON error messages', async () => {
    const keys: string[] = [];
    const timestamps: number[] = [];
    let attempt = 0;

    const fakeFetch: typeof fetch = async (_url, init) => {
      attempt += 1;
      timestamps.push(Date.now());
      const body = JSON.parse(String(init?.body));
      keys.push(body.params.arguments.meta['idempotency-key']);

      if (attempt === 1) {
        // First call fails with a transient transport error
        throw new Error('ECONNRESET');
      }
      if (attempt === 2) {
        // Retry succeeds!
        return jsonResponse(loadFixtureText('create_cart.json'));
      }
      // Subsequent call fails both times with real UCP tool error JSON
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ucp: { version: '2026-08-25', status: 'error' },
                messages: [
                  {
                    type: 'error',
                    code: 'invalid',
                    content:
                      'The merchandise with id gid://shopify/ProductVariant/67966605459748 does not exist.',
                    path: '$.add_items[0].product_variant_id',
                  },
                ],
              }),
            },
          ],
        },
      });
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    // 1. Transient error -> retries once after ~300ms with a NEW idempotency key -> succeeds
    const okRes = await store.createCart('fnova.myshopify.com', [
      { variant_id: 'gid://shopify/ProductVariant/722039242769' },
    ]);
    assert.equal(okRes.error, undefined);
    assert.ok(okRes.cart_id);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.ok(timestamps[1] - timestamps[0] >= 250, `expected >=250ms retry delay, got ${timestamps[1] - timestamps[0]}ms`);

    // 2. Persistent tool error -> retries once with new key, returns extracted readable error + messages[]
    const errRes = await store.createCart('fnova.myshopify.com', [
      { variant_id: 'gid://shopify/ProductVariant/67966605459748' },
    ]);
    assert.equal(keys.length, 4);
    assert.notEqual(keys[2], keys[3]);
    assert.equal(errRes.cart_id, null);
    assert.match(errRes.error ?? '', /67966605459748 does not exist/);
    assert.equal(errRes.messages.length, 1);
    assert.equal(errRes.messages[0].path, '$.add_items[0].product_variant_id');
  });
});

describe('searchByPhoto and searchLike', () => {
  it('sends like image base64 inside catalog with gender filter, department-filters results, logs kind:"photo" without bytes, and never writes to saved store', async () => {
    const searchFixture = loadFixtureJson('search.json');
    const capturedBodies: any[] = [];
    const fakeJpeg = Buffer.from('FAKE_JPEG_SHOPPER_SELFIE_BYTES_123456');
    const expectedB64 = fakeJpeg.toString('base64');

    // Add a wrong-department product to the fixture response to prove department filtering runs
    const responsePayload = structuredClone(searchFixture);
    const wrongDeptProduct = structuredClone(responsePayload.result.structuredContent.products[0]);
    wrongDeptProduct.id = 'gid://shopify/p/womens-skirt-wrong';
    wrongDeptProduct.title = "Women's Pleated Skirt";
    responsePayload.result.structuredContent.products.push(wrongDeptProduct);

    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responsePayload);
    };

    const savedDir = makeTempDir();
    const saved = createSavedStore({ dir: savedDir });
    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved });

    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(' '));
    try {
      const res = await store.searchByPhoto(fakeJpeg, 'men', { limit: 12 });
      assert.equal(res.source, 'live');
      assert.ok(res.items.length > 0);
      assert.equal(
        res.items.some((i) => i.id === 'gid://shopify/p/womens-skirt-wrong'),
        false,
        'wrong-department item must be filtered out',
      );
    } finally {
      console.log = origLog;
    }

    assert.equal(capturedBodies.length, 1);
    const cat = capturedBodies[0].params.arguments.catalog;
    assert.equal(cat.query, undefined);
    assert.deepEqual(cat.like, [
      { image: { content_type: 'image/jpeg', data: expectedB64 } },
    ]);
    assert.deepEqual(cat.filters.attributes, [{ name: 'Target gender', values: ['Male'] }]);
    assert.equal(cat.filters.available, true);
    assert.equal(cat.pagination.limit, 12);

    // Nothing written to saved store
    assert.deepEqual(fs.readdirSync(savedDir), []);

    // Privacy: image bytes / base64 must never appear in stdout logs
    const joinedOut = stdoutLines.join('\n');
    assert.equal(joinedOut.includes(expectedB64), false);
    assert.equal(joinedOut.includes('FAKE_JPEG_SHOPPER'), false);
    assert.match(joinedOut, /\[store\] photo search men \d+ items \d+ms/);
  });

  it('refuses oversize images (> 2.5 MB) with zero network requests and returns empty', async () => {
    let fetchCalls = 0;
    const mcp = createShopMcp({
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    const huge = new Uint8Array(2_500_001);
    const res = await store.searchByPhoto(huge, 'women', { query: "women's casual" });
    assert.equal(fetchCalls, 0);
    assert.equal(res.source, 'empty');
    assert.deepEqual(res.items, []);
  });

  it('falls back to text search(opts.query) on failure when query is given, else returns empty', async () => {
    const searchFixture = loadFixtureJson('search.json');
    const seenCalls: any[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seenCalls.push(body.params.arguments.catalog);
      if (body.params.arguments.catalog.like) {
        return new Response('boom', { status: 503 });
      }
      return jsonResponse(searchFixture);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    // With query -> falls back to text search
    const withQuery = await store.searchByPhoto(Buffer.from('abc'), 'men', {
      query: "men's leather loafers",
      limit: 6,
    });
    assert.equal(withQuery.source, 'live');
    assert.ok(withQuery.items.length > 0);
    assert.equal(seenCalls.length, 2);
    assert.ok(seenCalls[0].like);
    assert.equal(seenCalls[1].like, undefined);
    assert.equal(seenCalls[1].query, "men's leather loafers");

    // Without query -> returns empty without throwing
    const noQuery = await store.searchByPhoto(Buffer.from('abc'), 'men');
    assert.equal(noQuery.source, 'empty');
    assert.deepEqual(noQuery.items, []);
  });

  it('searchLike sends up to 2 product/variant IDs in catalog.like, maps results, and never writes to saved store', async () => {
    const searchFixture = loadFixtureJson('search.json');
    const seen: any[] = [];
    const savedDir = makeTempDir();
    const mcp = createShopMcp({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        seen.push(body.params.arguments.catalog);
        return jsonResponse(searchFixture);
      },
    });
    const store = createStore({ mcp, saved: createSavedStore({ dir: savedDir }) });

    const res = await store.searchLike(
      ['gid://shopify/p/1', 'gid://shopify/p/2', 'gid://shopify/p/3'],
      'men',
      { query: 'loafers', limit: 8 },
    );
    assert.equal(res.source, 'live');
    assert.ok(res.items.length > 0);
    assert.deepEqual(seen[0].like, [{ id: 'gid://shopify/p/1' }, { id: 'gid://shopify/p/2' }]);
    assert.equal(seen[0].query, 'loafers');
    assert.deepEqual(seen[0].filters.attributes, [{ name: 'Target gender', values: ['Male'] }]);
    assert.deepEqual(fs.readdirSync(savedDir), []);
  });

  it('on failure, store_error event and all console lines contain neither the base64 string nor raw image bytes', async () => {
    const rawMarker = 'PRIVATE_CAMERA_FRAME_BYTES_998877';
    const fakeJpeg = Buffer.from(rawMarker);
    const expectedB64 = fakeJpeg.toString('base64');

    const logEvents: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const consoleLines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => consoleLines.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => consoleLines.push(args.map(String).join(' '));
    setCallRoom('room-photo-err-test');
    setCallLogSink((room, ev, data) => logEvents.push({ room, ev, data }));

    try {
      // Case 1: RPC error echoing the base64 image data back from upstream
      const mcpRpcErr = createShopMcp({
        fetch: async () =>
          jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { message: `bad image payload: ${expectedB64}` },
          }),
      });
      const store1 = createStore({ mcp: mcpRpcErr, saved: createSavedStore({ dir: makeTempDir() }) });
      const res1 = await store1.searchByPhoto(fakeJpeg, 'men');
      assert.equal(res1.source, 'empty');

      // Case 2: network throw containing the base64 string
      const mcpNetErr = createShopMcp({
        fetch: async () => {
          throw new Error(`network failure while sending ${expectedB64}`);
        },
      });
      const store2 = createStore({ mcp: mcpNetErr, saved: createSavedStore({ dir: makeTempDir() }) });
      const res2 = await store2.searchByPhoto(fakeJpeg, 'women');
      assert.equal(res2.source, 'empty');

      const errorEvents = logEvents.filter((e) => e.ev === 'store_error');
      assert.equal(errorEvents.length, 2);

      const serialized = JSON.stringify({ logEvents, consoleLines });
      assert.equal(
        serialized.includes(expectedB64),
        false,
        'base64 image string must never appear in store_error or console output',
      );
      assert.equal(
        serialized.includes(rawMarker),
        false,
        'raw image bytes marker must never appear in store_error or console output',
      );
      // Confirm redaction actually ran on the echoed RPC error message
      assert.match(String(errorEvents[0].data?.message ?? ''), /\[REDACTED\]/);
      assert.match(String(errorEvents[1].data?.message ?? ''), /\[REDACTED\]/);
    } finally {
      console.log = origLog;
      console.error = origErr;
      setCallLogSink(null);
      setCallRoom(null);
    }
  });

  it('sets redirect:"error" on photo search calls while leaving plain text search unchanged', async () => {
    const searchFixture = loadFixtureJson('search.json');
    const seenInits: Array<{ hasImage: boolean; redirect?: string }> = [];

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const like = body?.params?.arguments?.catalog?.like;
      const hasImage = Array.isArray(like) && like.some((e: any) => Boolean(e?.image));
      seenInits.push({ hasImage, redirect: init?.redirect });
      return jsonResponse(searchFixture);
    };

    const mcp = createShopMcp({ fetch: fakeFetch });
    const store = createStore({ mcp, saved: createSavedStore({ dir: makeTempDir() }) });

    await store.searchByPhoto(Buffer.from('small-jpeg-bytes'), 'men', { limit: 5 });
    await store.search("men's loafers", 'men', { limit: 5 });

    assert.equal(seenInits.length, 2);
    assert.equal(seenInits[0].hasImage, true);
    assert.equal(seenInits[0].redirect, 'error');
    assert.equal(seenInits[1].hasImage, false);
    assert.equal(seenInits[1].redirect, undefined);
  });

  it('redactSecrets handles a 3 MB secret string quickly via literal split/join, skips strings under 6 chars, and masks >= 6 chars', () => {
    const bigSecret = 'B'.repeat(3_000_000);
    const input = `prefix ${bigSecret} suffix`;
    const t0 = Date.now();
    const out = redactSecrets(input, ['', null, undefined, bigSecret]);
    const elapsedMs = Date.now() - t0;

    assert.equal(out, 'prefix [REDACTED] suffix');
    assert.ok(elapsedMs < 1000, `expected fast redaction on 3 MB secret, took ${elapsedMs}ms`);

    // Minimum length 6: 3-char value is NOT masked; 6-char value IS masked
    assert.equal(redactSecrets('error abc and abcdef here', ['abc', 'abcdef']), 'error abc and [REDACTED] here');
    assert.equal(redactSecrets('error x here', ['x']), 'error x here');
  });
});

describe('saved store LRU bounds, key cap, and write coalescing', () => {
  const sampleItem = {
    id: 'gid://shopify/p/sample',
    variant_id: 'gid://shopify/ProductVariant/1',
    title: 'Sample Shirt',
    price: 29,
    url: 'https://www.everlane.com/products/sample',
    image: 'https://cdn.shopify.com/sample.jpg',
    store: 'Everlane',
    store_domain: 'm34kzg-ke.myshopify.com',
    rating: null,
    rating_count: null,
    sizes: ['M'],
    variants_by_size: { M: 'gid://shopify/ProductVariant/1' },
    description: 'Sample',
    department: 'men' as const,
  };

  it('evicts the least recently used entry on the 401st distinct key, and a read protects an entry from eviction', () => {
    let clock = 1_000;
    const store = createSavedStore({
      dir: makeTempDir(),
      now: () => (clock += 1),
      schedule: () => 1,
      clearSchedule: () => {},
    });

    for (let i = 1; i <= 400; i += 1) {
      store.putSaved(`key-${i}`, `query ${i}`, 'men', [sampleItem]);
    }
    assert.ok(store.getSaved('key-1')); // read promotes key-1 to MRU; key-2 is now oldest

    store.putSaved('key-401', 'query 401', 'men', [sampleItem]);

    assert.ok(store.getSaved('key-1'), 'recently read key-1 must survive eviction');
    assert.equal(store.getSaved('key-2'), undefined, 'oldest unread key-2 must be evicted');
    assert.ok(store.getSaved('key-401'));

    // Adding key-402 evicts key-3 (next oldest)
    store.putSaved('key-402', 'query 402', 'men', [sampleItem]);
    assert.equal(store.getSaved('key-3'), undefined);
    assert.ok(store.getSaved('key-402'));
  });

  it('keeps only the newest 400 entries when loading a larger existing file and respects ALICE_SAVED_MAX', () => {
    const dir = makeTempDir();
    const bulk = Array.from({ length: 420 }, (_, i) => ({
      key: `disk-key-${i + 1}`,
      query: `query ${i + 1}`,
      gender: 'men',
      t: 10_000 + i + 1,
      items: [sampleItem],
    }));
    fs.writeFileSync(path.join(dir, 'saved-searches.json'), JSON.stringify(bulk), 'utf8');

    const loaded = createSavedStore({ dir, schedule: () => 1, clearSchedule: () => {} });
    assert.equal(loaded.getSaved('disk-key-1'), undefined);
    assert.equal(loaded.getSaved('disk-key-20'), undefined);
    assert.ok(loaded.getSaved('disk-key-21'));
    assert.ok(loaded.getSaved('disk-key-420'));

    const origEnv = process.env.ALICE_SAVED_MAX;
    process.env.ALICE_SAVED_MAX = '5';
    try {
      const capped = createSavedStore({ dir, schedule: () => 1, clearSchedule: () => {} });
      assert.equal(capped.getSaved('disk-key-415'), undefined);
      assert.ok(capped.getSaved('disk-key-416'));
      assert.ok(capped.getSaved('disk-key-420'));
    } finally {
      if (origEnv === undefined) delete process.env.ALICE_SAVED_MAX;
      else process.env.ALICE_SAVED_MAX = origEnv;
    }
  });

  it('skips storing keys longer than 160 characters without writing or failing', async () => {
    let writes = 0;
    const store = createSavedStore({
      dir: makeTempDir(),
      schedule: (fn) => {
        fn();
        return 1;
      },
      clearSchedule: () => {},
      writeFile: async () => {
        writes += 1;
      },
    });

    const longKey = 'k'.repeat(161);
    const returned = store.putSaved(longKey, 'very long query', 'men', [sampleItem]);
    assert.equal(returned.key, longKey);
    assert.equal(store.getSaved(longKey), undefined);
    assert.equal(writes, 0);

    const okKey = 'k'.repeat(160);
    store.putSaved(okKey, 'exact 160', 'men', [sampleItem]);
    assert.ok(store.getSaved(okKey));
    assert.equal(writes, 1);
  });

  it('coalesces a burst of saves into a single disk write at the 2-second interval', async () => {
    let clock = 50_000;
    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const writtenPayloads: string[] = [];

    const store = createSavedStore({
      dir: makeTempDir(),
      now: () => clock,
      schedule: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        scheduled.push(entry);
        return entry;
      },
      clearSchedule: (h: any) => {
        if (h) h.cleared = true;
      },
      writeFile: async (_p, payload) => {
        writtenPayloads.push(payload);
      },
    });

    for (let i = 0; i < 25; i += 1) {
      clock += 10;
      store.putSaved(`burst-${i}`, `burst query ${i}`, 'men', [sampleItem]);
    }

    // All 25 saves in the burst scheduled exactly ONE 2000ms timer and 0 immediate writes
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 2000);
    assert.equal(writtenPayloads.length, 0);

    // Timer fires -> 1 write containing all 25 entries
    clock += 2000;
    scheduled[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(writtenPayloads.length, 1);
    assert.equal(JSON.parse(writtenPayloads[0]).length, 25);

    // Another burst schedules a second coalesced write
    store.putSaved('burst-25', 'burst query 25', 'men', [sampleItem]);
    store.putSaved('burst-26', 'burst query 26', 'men', [sampleItem]);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].ms, 2000);
    clock += 2000;
    scheduled[1].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(writtenPayloads.length, 2);
    assert.equal(JSON.parse(writtenPayloads[1]).length, 27);
  });
});
