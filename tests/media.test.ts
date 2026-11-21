import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { estimateCostUsd, ledgerTotal, recordCost } from '../src/ledger.ts';
import { mediaRequest, mediaStatus, stopMedia } from '../src/media/client.ts';
import { outfitCollage, productShot, setCallRoom, warmMedia } from '../src/media/index.ts';
import {
  TRYON_NAME_RE,
  boardFileName,
  collectImageUrls,
  decideCrop,
  newTryonId,
  parsePickReply,
  shotFileName,
  sortPiecesForTryOn,
  stripHtml,
  tryonFileName,
  whitenBackground,
  withWidth,
} from '../src/media/pure.ts';
import { setCallLogSink } from '../src/store/log.ts';
import type { Item, Outfit, Piece } from '../src/types.ts';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'prod-1',
    variant_id: 'var-1',
    title: 'Test Oxford Shirt',
    price: 58,
    url: 'https://example.com/products/oxford',
    image: 'https://cdn.shopify.com/s/files/1/0000/oxford.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 12,
    sizes: ['M', 'L'],
    variants_by_size: {},
    description: '<p>Crisp <b>cotton</b> oxford shirt.</p>',
    department: 'men',
    ...overrides,
  };
}

describe('withWidth', () => {
  it('appends with ? when URL has no query string', () => {
    assert.equal(
      withWidth('https://cdn.shopify.com/s/files/1/item.jpg', 384),
      'https://cdn.shopify.com/s/files/1/item.jpg?width=384',
    );
  });

  it('appends with & when URL already has a query string', () => {
    assert.equal(
      withWidth('https://cdn.shopify.com/s/files/1/item.jpg?v=1700000', 1000),
      'https://cdn.shopify.com/s/files/1/item.jpg?v=1700000&width=1000',
    );
  });

  it('replaces existing width parameter instead of duplicating it', () => {
    assert.equal(
      withWidth('https://cdn.shopify.com/s/files/1/item.jpg?v=1&width=200', 800),
      'https://cdn.shopify.com/s/files/1/item.jpg?v=1&width=800',
    );
  });
});

describe('collectImageUrls and file naming', () => {
  it('deduplicates ignoring query string, keeps Image 0 first, filters non-image hosts', () => {
    const urls = collectImageUrls(
      'https://cdn.shopify.com/s/files/1/a.jpg?v=1',
      [
        'https://cdn.shopify.com/s/files/1/a.jpg?v=2',
        'https://cdn.shopify.com/s/files/1/b.png',
        'https://example.com/not-an-image',
        'https://images.example.com/c.webp?q=80',
      ],
      8,
    );
    assert.deepEqual(urls, [
      'https://cdn.shopify.com/s/files/1/a.jpg?v=1',
      'https://cdn.shopify.com/s/files/1/b.png',
      'https://images.example.com/c.webp?q=80',
    ]);
  });

  it('generates server-safe filenames matching TRYON_NAME_RE', () => {
    assert.match(shotFileName(makeItem()), TRYON_NAME_RE);
    assert.match(boardFileName({ number: 1 }, 'Skyline Knit / Rooftop!'), TRYON_NAME_RE);
    assert.match(boardFileName({ number: 2 }), TRYON_NAME_RE);
    const id = newTryonId();
    assert.equal(id.length, 12);
    assert.match(tryonFileName(id), TRYON_NAME_RE);
  });

  it('strips HTML and caps description length', () => {
    assert.equal(
      stripHtml('<p>Short&nbsp;sleeve &amp; <b>relaxed</b> fit.</p>', 220),
      'Short sleeve & relaxed fit.',
    );
    assert.equal(stripHtml('a'.repeat(300), 220).length, 220);
  });
});

describe('parsePickReply', () => {
  it('parses a plain JSON object with chin_y', () => {
    const res = parsePickReply('{"index":2,"has_person":true,"box_2d":[180,200,900,800],"chin_y":220}');
    assert.deepEqual(res, {
      index: 2,
      has_person: true,
      box_2d: [180, 200, 900, 800],
      chin_y: 220,
    });
  });

  it('parses a one-element JSON array without chin_y', () => {
    const res = parsePickReply('[{"index":0,"has_person":false,"box_2d":[689,95,929,901]}]');
    assert.deepEqual(res, {
      index: 0,
      has_person: false,
      box_2d: [689, 95, 929, 901],
      chin_y: null,
    });
  });

  it('handles fenced JSON, null chin_y, and missing box_2d', () => {
    const res = parsePickReply('```json\n{"index":1,"has_person":true,"chin_y":null}\n```');
    assert.deepEqual(res, {
      index: 1,
      has_person: true,
      box_2d: null,
      chin_y: null,
    });
  });

  it('returns null on garbage or invalid index', () => {
    assert.equal(parsePickReply('not json at all'), null);
    assert.equal(parsePickReply('[]'), null);
    assert.equal(parsePickReply('{"index":-1,"has_person":false}'), null);
    assert.equal(parsePickReply('{"has_person":false}'), null);
    assert.equal(parsePickReply(''), null);
    assert.equal(parsePickReply(undefined), null);
  });
});

describe('decideCrop', () => {
  const cases: Array<{
    name: string;
    w: number;
    h: number;
    hasPerson: boolean;
    box: [number, number, number, number] | null;
    opts?: { chinY?: number | null; slot?: string };
    expected: { left: number; top: number; width: number; height: number } | null;
  }> = [
    {
      name: 'no person + big box (>= 80% area) -> no crop',
      w: 1000,
      h: 1000,
      hasPerson: false,
      box: [20, 20, 980, 980],
      expected: null,
    },
    {
      name: 'no person + tight box (< 80% area) -> crop with 3% pad',
      w: 1000,
      h: 1000,
      hasPerson: false,
      box: [200, 200, 700, 700],
      expected: { left: 170, top: 170, width: 560, height: 560 },
    },
    {
      name: 'person + box near edges (no chin_y) -> crop with 3% pad clamped to image bounds',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [200, 10, 990, 990],
      expected: { left: 0, top: 170, width: 1000, height: 830 },
    },
    {
      name: 'person + box overlapping chin -> top clamped to chin_y + 15, no upward pad',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [150, 100, 900, 900],
      opts: { chinY: 200, slot: 'top' },
      expected: { left: 70, top: 215, width: 860, height: 715 },
    },
    {
      name: 'person + box below chin -> keeps box top without padding upward past chin',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [300, 100, 900, 900],
      opts: { chinY: 200, slot: 'top' },
      expected: { left: 70, top: 300, width: 860, height: 630 },
    },
    {
      name: 'person + no box -> crop top 20% off',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: null,
      expected: { left: 0, top: 200, width: 1000, height: 800 },
    },
    {
      name: 'person + no box + shoes slot -> crop top 45% off',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: null,
      opts: { slot: 'shoes' },
      expected: { left: 0, top: 450, width: 1000, height: 550 },
    },
    {
      name: 'person + tiny box + bottom slot -> crop top 45% off',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [100, 100, 130, 500],
      opts: { slot: 'bottom' },
      expected: { left: 0, top: 450, width: 1000, height: 550 },
    },
    {
      name: 'person + tiny box (< 40px on a side) -> crop top 20% off',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [100, 100, 130, 500],
      expected: { left: 0, top: 200, width: 1000, height: 800 },
    },
    {
      name: 'no person + no box -> no crop',
      w: 1000,
      h: 1000,
      hasPerson: false,
      box: null,
      expected: null,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      assert.deepEqual(decideCrop(tc.w, tc.h, tc.hasPerson, tc.box, tc.opts), tc.expected);
    });
  }
});

describe('whitenBackground (raw RGB Uint8Array, no sharp)', () => {
  function makeSyntheticRgb(
    width: number,
    height: number,
    bg: [number, number, number],
    fg: [number, number, number],
  ): Uint8Array {
    const buf = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inCenter = x >= 10 && x < width - 10 && y >= 10 && y < height - 10;
        const [r, g, b] = inCenter ? fg : bg;
        const o = (y * width + x) * 3;
        buf[o] = r;
        buf[o + 1] = g;
        buf[o + 2] = b;
      }
    }
    return buf;
  }

  it('turns a light grey border pure white while leaving a dark centre square untouched', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [220, 222, 225], [30, 40, 50]);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, true);

    assert.deepEqual([rgb[0], rgb[1], rgb[2]], [255, 255, 255]);
    const bgOff = (5 * w + 5) * 3;
    assert.deepEqual([rgb[bgOff], rgb[bgOff + 1], rgb[bgOff + 2]], [255, 255, 255]);
    const fgOff = (16 * w + 16) * 3;
    assert.deepEqual([rgb[fgOff], rgb[fgOff + 1], rgb[fgOff + 2]], [30, 40, 50]);
  });

  it('leaves a white square on a near-white border completely untouched', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [242, 242, 244], [250, 249, 248]);
    const before = new Uint8Array(rgb);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, false);
    assert.deepEqual(rgb, before);
  });

  it('keeps a white square interior untouched on a mid-grey border', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [200, 200, 200], [248, 246, 244]);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, true);

    assert.deepEqual([rgb[0], rgb[1], rgb[2]], [255, 255, 255]);
    const fgOff = (16 * w + 16) * 3;
    assert.deepEqual([rgb[fgOff], rgb[fgOff + 1], rgb[fgOff + 2]], [248, 246, 244]);
  });

  it('skips dark-border images without modifying pixels', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [40, 45, 50], [220, 220, 220]);
    const before = new Uint8Array(rgb);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, false);
    assert.deepEqual(rgb, before);
  });
});

describe('sortPiecesForTryOn', () => {
  it('orders slots as dress, top, layer, bottom, shoes, bag, accessory, jewelry', () => {
    const slots = ['jewelry', 'shoes', 'accessory', 'bottom', 'bag', 'layer', 'top', 'dress'];
    const pieces: Piece[] = slots.map((slot, i) => ({
      slot,
      why: `why-${i}`,
      item: makeItem({ id: `p-${i}`, variant_id: `v-${i}` }),
    }));
    const sorted = sortPiecesForTryOn(pieces).map((p) => p.slot);
    assert.deepEqual(sorted, ['dress', 'top', 'layer', 'bottom', 'shoes', 'bag', 'accessory', 'jewelry']);
  });
});

describe('ledger', () => {
  it('estimates USD correctly across known and unknown models', () => {
    assert.ok(
      Math.abs(
        estimateCostUsd({
          model: 'gemini-3.5-flash-lite',
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        }) - 2.8,
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        estimateCostUsd({
          model: 'gemini-4-hydrogen',
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        }) - 9.0,
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        estimateCostUsd({
          model: 'gemini-4-argon',
          input_tokens: 500_000,
          output_tokens: 500_000,
        }) - 4.5,
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        estimateCostUsd({
          model: 'gemini-decision-1',
          input_tokens: 1_000_000,
          output_tokens: 500_000,
        }) - 0.1,
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(estimateCostUsd({ model: 'gemini-nano-banana-2.1', images: 3 }) - 0.15) < 1e-9,
    );
    assert.equal(estimateCostUsd({ model: 'some-unknown-model', input_tokens: 1000 }), 0);
    assert.equal(estimateCostUsd({ model: 'some-unknown-model', usd: 0.42 }), 0.42);
  });

  it('records entries and computes ledgerTotal in a temp ALICE_LEDGER_DIR', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alice-ledger-test-'));
    const prev = process.env.ALICE_LEDGER_DIR;
    process.env.ALICE_LEDGER_DIR = tmpDir;
    try {
      recordCost({
        model: 'gemini-3.5-flash-lite',
        job: 'shot-pick',
        input_tokens: 100_000,
        output_tokens: 10_000,
        ms: 1200,
      });
      recordCost({
        model: 'gemini-nano-banana-2.1',
        job: 'tryon',
        images: 1,
        ms: 15000,
      });

      const total = await ledgerTotal();
      assert.equal(total.calls, 2);
      const expectedFlash = (100_000 * 0.3 + 10_000 * 2.5) / 1_000_000;
      const expectedTotal = expectedFlash + 0.05;
      assert.ok(Math.abs(total.usd - expectedTotal) < 1e-9);
      assert.equal(total.by_model['gemini-3.5-flash-lite'].calls, 1);
      assert.equal(total.by_model['gemini-nano-banana-2.1'].calls, 1);
    } finally {
      if (prev === undefined) {
        delete process.env.ALICE_LEDGER_DIR;
      } else {
        process.env.ALICE_LEDGER_DIR = prev;
      }
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('media IPC client, warmMedia, call-log events, and fallback behavior', () => {
  let tmpDir: string;
  let echoChildPath: string;
  let crashChildPath: string;
  const prevChildEnv = process.env.ALICE_MEDIA_CHILD;
  const prevCleanEnv = process.env.ALICE_CLEAN_SHOTS;

  after(async () => {
    stopMedia();
    setCallRoom(null);
    setCallLogSink(null);
    if (prevChildEnv === undefined) {
      delete process.env.ALICE_MEDIA_CHILD;
    } else {
      process.env.ALICE_MEDIA_CHILD = prevChildEnv;
    }
    if (prevCleanEnv === undefined) {
      delete process.env.ALICE_CLEAN_SHOTS;
    } else {
      process.env.ALICE_CLEAN_SHOTS = prevCleanEnv;
    }
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles warmMedia, request/response, timeout, crash recovery, call-log events, and productShot fallback', async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alice-media-client-test-'));
    echoChildPath = path.join(tmpDir, 'echo-child.mjs');
    crashChildPath = path.join(tmpDir, 'crash-child.mjs');

    await fs.promises.writeFile(
      echoChildPath,
      [
        "process.on('message', (msg) => {",
        "  if (!msg || typeof msg !== 'object') return;",
        '  const { id, op, args } = msg;',
        "  if (op === 'ping') {",
        '    process.send({ id, ok: true, result: { pong: true, pid: process.pid } });',
        "  } else if (op === 'echo') {",
        '    process.send({ id, ok: true, result: { args, pid: process.pid } });',
        "  } else if (op === 'slow') {",
        '    setTimeout(() => {',
        "      if (process.connected) process.send({ id, ok: true, result: 'late' });",
        '    }, 2000);',
        "  } else if (op === 'crash') {",
        '    setTimeout(() => process.exit(1), 20);',
        '  } else {',
        "    process.send({ id, ok: false, error: 'unknown op ' + op });",
        '  }',
        '});',
        "process.on('disconnect', () => process.exit(0));",
      ].join('\n'),
      'utf8',
    );

    await fs.promises.writeFile(crashChildPath, 'process.exit(1);\n', 'utf8');

    const events: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    setCallLogSink((room, ev, data) => {
      events.push({ room, ev, data });
    });
    setCallRoom('test-room');

    // 1. warmMedia + Request / response
    stopMedia();
    process.env.ALICE_MEDIA_CHILD = echoChildPath;
    await warmMedia();
    const res1 = await mediaRequest<{ args: { n: number }; pid: number }>('echo', { n: 42 }, 5000);
    assert.deepEqual(res1.args, { n: 42 });
    assert.equal(typeof res1.pid, 'number');
    assert.equal(mediaStatus().pid, res1.pid);
    assert.equal(mediaStatus().pending, 0);

    // 2. Timeout -> rejection
    await assert.rejects(() => mediaRequest('slow', {}, 80), /timed out/i);
    assert.equal(mediaStatus().pending, 0);

    // 3. Child crash -> pending rejected -> next request works on a fresh child
    const prevRestarts = mediaStatus().restarts;
    await assert.rejects(() => mediaRequest('crash', {}, 5000), /exited|error|closed/i);
    assert.equal(mediaStatus().pending, 0);
    assert.ok(events.some((e) => e.ev === 'media_process_exit'));

    const res2 = await mediaRequest<{ args: { ok: boolean }; pid: number }>(
      'echo',
      { ok: true },
      5000,
    );
    assert.deepEqual(res2.args, { ok: true });
    assert.notEqual(res2.pid, res1.pid);
    assert.ok(mediaStatus().restarts > prevRestarts);

    // 4. productShot with a crashing child returns the store-image fallback and emits media_shot
    stopMedia();
    process.env.ALICE_MEDIA_CHILD = crashChildPath;
    delete process.env.ALICE_CLEAN_SHOTS;
    const item = makeItem({ id: 'crash-item', variant_id: 'crash-var' });
    const shot = await productShot(item, 'top');
    assert.deepEqual(shot, {
      buf: null,
      url: item.image,
      source: 'original',
    });
    assert.ok(events.some((e) => e.ev === 'media_shot' && e.data?.source === 'original'));

    // 5. outfitCollage with crashing child degrades to null and emits media_board
    const outfit: Outfit = {
      number: 1,
      name: 'Test Look',
      difference: 'd',
      story: 's',
      pieces: [{ slot: 'top', why: 'w', item }],
      total: 58,
    };
    const board = await outfitCollage(outfit);
    assert.equal(board, null);
    assert.ok(events.some((e) => e.ev === 'media_board' && e.data?.ok === false));

    // 6. ALICE_CLEAN_SHOTS=off returns original without spawning child
    stopMedia();
    process.env.ALICE_CLEAN_SHOTS = 'off';
    const itemOff = makeItem({ id: 'off-item', variant_id: 'off-var' });
    const shotOff = await productShot(itemOff, 'top');
    assert.deepEqual(shotOff, {
      buf: null,
      url: itemOff.image,
      source: 'original',
    });
    assert.equal(mediaStatus().pid, null);

    stopMedia();
  });
});

describe('sharp isolation guard', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const sharpImportRe =
    /(?:import\s+[^'"]*['"]sharp['"]|from\s+['"]sharp['"]|require\(\s*['"]sharp['"]\s*\)|import\(\s*['"]sharp['"]\s*\))/;

  function collectLocalImports(absFile: string, visited = new Set<string>()): Set<string> {
    if (visited.has(absFile)) return visited;
    visited.add(absFile);
    let src: string;
    try {
      src = fs.readFileSync(absFile, 'utf8');
    } catch {
      return visited;
    }
    const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
    for (const match of src.matchAll(importRe)) {
      const target = path.resolve(path.dirname(absFile), match[1]);
      collectLocalImports(target, visited);
    }
    return visited;
  }

  it('forbids sharp imports in parent-facing modules', () => {
    const parentFiles = [
      'src/media/index.ts',
      'src/media/client.ts',
      'src/tryon.ts',
      'src/ledger.ts',
    ];
    for (const rel of parentFiles) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.equal(sharpImportRe.test(text), false, `${rel} must not import sharp`);
    }
  });

  it('allows sharp imports only in files reachable from src/media/process.ts', () => {
    const processGraph = collectLocalImports(path.join(repoRoot, 'src/media/process.ts'));
    const parentGraph = new Set<string>([
      ...collectLocalImports(path.join(repoRoot, 'src/media/index.ts')),
      ...collectLocalImports(path.join(repoRoot, 'src/tryon.ts')),
      ...collectLocalImports(path.join(repoRoot, 'src/ledger.ts')),
    ]);

    const srcMediaDir = path.join(repoRoot, 'src/media');
    const allFiles = [
      ...fs.readdirSync(srcMediaDir).map((f) => path.join(srcMediaDir, f)),
      path.join(repoRoot, 'src/tryon.ts'),
      path.join(repoRoot, 'src/ledger.ts'),
    ].filter((f) => f.endsWith('.ts'));

    for (const absFile of allFiles) {
      const text = fs.readFileSync(absFile, 'utf8');
      if (sharpImportRe.test(text)) {
        const rel = path.relative(repoRoot, absFile);
        assert.ok(processGraph.has(absFile), `${rel} imports sharp but is not imported by process.ts`);
        assert.equal(
          parentGraph.has(absFile),
          false,
          `${rel} imports sharp and is reachable from parent modules`,
        );
      }
    }
  });
});
