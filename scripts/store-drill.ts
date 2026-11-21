import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Gender, Item, Outfit } from '../src/types.ts';
import { createShopMcp } from '../src/store/shopmcp.ts';
import { createSavedStore } from '../src/store/saved.ts';
import { createStore } from '../src/store/factory.ts';
import { createBag } from '../src/store/bag.ts';

type FaultMode = 'ok' | 'rate_limit' | 'slow' | 'down' | 'garbage' | 'drop';

interface DrillRow {
  name: string;
  pass: boolean;
  ms: number;
  detail: string;
}

const UPSTREAM_URL = process.env.SHOP_MCP_URL || 'https://mcp.shop.com/';

const WARM_QUERIES: Array<{ query: string; gender: Gender }> = [
  { query: "men's chino pants", gender: 'men' },
  { query: "men's leather loafers", gender: 'men' },
  { query: "men's linen shirt", gender: 'men' },
  { query: "women's midi dress", gender: 'women' },
  { query: "women's leather boots", gender: 'women' },
  { query: "women's blouse", gender: 'women' },
];

const REWORDED_QUERIES: Array<{ query: string; gender: Gender }> = [
  { query: "men's navy chinos", gender: 'men' },
  { query: "women's black midi dress", gender: 'women' },
];

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let mode: FaultMode = 'ok';
  const counts: Record<FaultMode, number> = {
    ok: 0,
    rate_limit: 0,
    slow: 0,
    down: 0,
    garbage: 0,
    drop: 0,
  };
  const slowTimers = new Set<ReturnType<typeof setTimeout>>();

  const server = http.createServer(async (req, res) => {
    const activeMode = mode;
    counts[activeMode] += 1;

    if (activeMode === 'drop') {
      req.socket.destroy();
      return;
    }

    const body = await readBody(req);

    if (activeMode === 'rate_limit') {
      res.writeHead(429, {
        'content-type': 'text/plain',
        'retry-after': '3',
      });
      res.end('Too Many Requests');
      return;
    }

    if (activeMode === 'down') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    }

    if (activeMode === 'garbage') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>');
      return;
    }

    if (activeMode === 'slow') {
      const timer = setTimeout(() => {
        slowTimers.delete(timer);
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { products: [] } } }));
        }
      }, 4000);
      if (typeof timer.unref === 'function') timer.unref();
      slowTimers.add(timer);
      req.on('close', () => {
        clearTimeout(timer);
        slowTimers.delete(timer);
      });
      return;
    }

    // mode === 'ok': forward to real Shop MCP
    try {
      const headers: Record<string, string> = {};
      for (const key of [
        'content-type',
        'accept',
        'mcp-protocol-version',
        'mcp-method',
        'mcp-name',
      ]) {
        const val = req.headers[key];
        if (typeof val === 'string') headers[key] = val;
      }

      const upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers,
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind local drill server');
  }
  const localUrl = `http://127.0.0.1:${addr.port}/`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-drill-'));

  let clockOffsetMs = 0;
  const now = () => Date.now() + clockOffsetMs;

  const mcp = createShopMcp({ url: localUrl, now });
  const saved = createSavedStore({ dir: tmpDir, now });
  const store = createStore({ mcp, saved, now });
  const bag = createBag({
    getProduct: store.getProduct,
    sizeVariant: store.sizeVariant,
    createCart: store.createCart,
    now,
  });

  const rows: DrillRow[] = [];
  const warmedItems = new Map<string, Item[]>();

  try {
    // 1. Warm: 6 real searches -> all live
    mode = 'ok';
    const tWarm = Date.now();
    const warmResults = await Promise.all(
      WARM_QUERIES.map(async (q) => {
        const res = await store.search(q.query, q.gender, { limit: 6 });
        warmedItems.set(`${q.gender}:${q.query}`, res.items);
        return { q, res };
      }),
    );
    const warmMs = Date.now() - tWarm;
    const warmAllLive = warmResults.every((r) => r.res.source === 'live' && r.res.items.length > 0);
    rows.push({
      name: 'warm (6 real searches)',
      pass: warmAllLive,
      ms: warmMs,
      detail: warmResults
        .map((r) => `${r.q.query}:${r.res.source}(${r.res.items.length})`)
        .join(', '),
    });

    // 2. Each failure mode
    const faultModes: FaultMode[] = ['rate_limit', 'slow', 'down', 'garbage', 'drop'];
    for (const fm of faultModes) {
      mode = fm;
      // Advance injected clock 2 hours so 60-min freshness is expired
      clockOffsetMs += 2 * 60 * 60 * 1000;
      const beforeCount = counts[fm];
      const tMode = Date.now();

      if (fm === 'rate_limit') {
        // Sequential for rate_limit so 1st request triggers 429 and next 5 hit the block
        const perQueryMs: number[] = [];
        const sources: string[] = [];
        let allItems = true;
        for (const q of WARM_QUERIES) {
          const tq = Date.now();
          const res = await store.search(q.query, q.gender, { limit: 6 });
          perQueryMs.push(Date.now() - tq);
          sources.push(res.source);
          if (res.source !== 'saved' || res.items.length === 0) allItems = false;
        }
        const blockedTimings = perQueryMs.slice(1);
        const maxBlockedMs = Math.max(...blockedTimings);
        const reqsDuringWindow = counts[fm] - beforeCount;

        // Reworded queries during block -> saved-near, zero extra requests
        const nearResults = await Promise.all(
          REWORDED_QUERIES.map((q) => store.search(q.query, q.gender, { limit: 6 })),
        );
        const nearOk = nearResults.every((r) => r.source === 'saved-near' && r.items.length > 0);

        // Unrelated query -> empty, no throw
        const unrelated = await store.search('scuba wetsuit flippers', 'men', { limit: 6 });
        const unrelatedOk = unrelated.source === 'empty' && unrelated.items.length === 0;
        const reqsStillOne = counts[fm] - beforeCount === 1;

        // Advance past retry-after window (3s) -> one request goes out again
        clockOffsetMs += 3500;
        await store.search(WARM_QUERIES[0].query, WARM_QUERIES[0].gender, { limit: 6 });
        const reqAfterWindow = counts[fm] - beforeCount === 2;

        const pass =
          allItems &&
          maxBlockedMs < 50 &&
          perQueryMs[0] < 2600 &&
          reqsDuringWindow === 1 &&
          reqsStillOne &&
          nearOk &&
          unrelatedOk &&
          reqAfterWindow;

        rows.push({
          name: `fault:${fm}`,
          pass,
          ms: Date.now() - tMode,
          detail: `saved=${sources.filter((s) => s === 'saved').length}/6 reqs_in_win=${reqsDuringWindow} max_blocked=${maxBlockedMs}ms near=${nearOk} empty=${unrelatedOk} after_win_req=${reqAfterWindow}`,
        });
      } else {
        // Run the 6 queries in parallel (each must complete < 2.6s and return saved)
        const results = await Promise.all(
          WARM_QUERIES.map(async (q) => {
            const tq = Date.now();
            const res = await store.search(q.query, q.gender, { limit: 6 });
            return { res, ms: Date.now() - tq };
          }),
        );
        const allSaved = results.every((r) => r.res.source === 'saved' && r.res.items.length > 0);
        const maxQueryMs = Math.max(...results.map((r) => r.ms));
        const timingOk = maxQueryMs < 2600;

        // Reworded queries -> saved-near
        const nearResults = await Promise.all(
          REWORDED_QUERIES.map(async (q) => {
            const tq = Date.now();
            const res = await store.search(q.query, q.gender, { limit: 6 });
            return { res, ms: Date.now() - tq };
          }),
        );
        const nearOk = nearResults.every(
          (r) => r.res.source === 'saved-near' && r.res.items.length > 0 && r.ms < 2600,
        );

        // Unrelated query -> empty, no throw
        const tUnrel = Date.now();
        const unrelated = await store.search('scuba wetsuit flippers', 'men', { limit: 6 });
        const unrelatedMs = Date.now() - tUnrel;
        const unrelatedOk =
          unrelated.source === 'empty' && unrelated.items.length === 0 && unrelatedMs < 2600;

        const pass = allSaved && timingOk && nearOk && unrelatedOk;
        rows.push({
          name: `fault:${fm}`,
          pass,
          ms: Date.now() - tMode,
          detail: `saved=${results.filter((r) => r.res.source === 'saved').length}/6 max_ms=${maxQueryMs}ms near=${nearOk} empty=${unrelatedOk} reqs=${counts[fm] - beforeCount}`,
        });
      }
    }

    // 3. addToBag while down
    mode = 'down';
    const topItem = warmedItems.get("men:men's linen shirt")?.[0];
    const bottomItem = warmedItems.get("men:men's chino pants")?.[0];
    if (!topItem || !bottomItem) {
      rows.push({
        name: 'bag while down',
        pass: false,
        ms: 0,
        detail: 'missing warmed items to build outfit',
      });
    } else {
      const outfit: Outfit = {
        name: 'Drill Look',
        difference: 'Simple',
        story: 'Drill outfit',
        total: Math.round((topItem.price + bottomItem.price) * 100) / 100,
        pieces: [
          { slot: 'top', why: 'shirt', item: topItem },
          { slot: 'bottom', why: 'chinos', item: bottomItem },
        ],
      };
      const tBag = Date.now();
      const bagRes = await bag.addToBag(outfit, { top: 'Large', bottom: '34' }, 'men');
      const bagMs = Date.now() - tBag;
      const noCarts = bagRes.carts.every((c) => c.cart_id === null && c.continue_url === null);
      const totalAdded = bagRes.carts.reduce((n, c) => n + c.added.length, 0);
      const totalNotAdded = bagRes.carts.reduce((n, c) => n + c.not_added.length, 0);
      const reasonsOk = bagRes.carts.every((c) =>
        c.not_added.every((x) => typeof x.reason === 'string' && x.reason.length > 5),
      );
      const honestSummary =
        bagRes.summary.includes('0 checkout links ready') && bagRes.total_usd === 0;
      const pass =
        bagMs < 5000 && noCarts && totalAdded === 0 && totalNotAdded === 2 && reasonsOk && honestSummary;
      rows.push({
        name: 'bag while down',
        pass,
        ms: bagMs,
        detail: `noCarts=${noCarts} not_added=${totalNotAdded}/2 summary="${bagRes.summary.slice(0, 90)}"`,
      });
    }

    // 4. Recovery: back to ok -> live again
    mode = 'ok';
    clockOffsetMs += 2 * 60 * 60 * 1000;
    const tRec = Date.now();
    const recRes = await store.search(WARM_QUERIES[0].query, WARM_QUERIES[0].gender, { limit: 6 });
    const recMs = Date.now() - tRec;
    rows.push({
      name: 'recovery (ok -> live)',
      pass: recRes.source === 'live' && recRes.items.length > 0,
      ms: recMs,
      detail: `source=${recRes.source} items=${recRes.items.length}`,
    });
  } finally {
    for (const t of slowTimers) clearTimeout(t);
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Print PASS/FAIL table
  console.log('\n=== STORE FAILURE DRILL RESULTS ===');
  console.log('STATUS | STEP                      | TIME     | DETAIL');
  console.log('-------+---------------------------+----------+----------------------------------------');
  let failures = 0;
  for (const r of rows) {
    if (!r.pass) failures += 1;
    const status = r.pass ? 'PASS  ' : 'FAIL  ';
    const name = r.name.padEnd(25);
    const time = `${r.ms}ms`.padStart(8);
    console.log(`${status} | ${name} | ${time} | ${r.detail}`);
  }
  console.log('---------------------------------------------------------------------------------------');
  console.log(`Requests per mode: ${JSON.stringify(counts)}`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[drill] fatal:', err);
  process.exitCode = 1;
});
