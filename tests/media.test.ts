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
  buildGateCorrection,
  buildSetting,
  classifyShotSource,
  collectImageUrls,
  cropRawRgb,
  decideCrop,
  newTryonId,
  parseInspectorReply,
  parsePickReply,
  resolvePick,
  runTryOnExtrasLoop,
  runTryOnVerifyLoop,
  sceneFileName,
  shotFileName,
  sortPiecesForTryOn,
  stripHtml,
  tryonFileName,
  videoFileName,
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

describe('parsePickReply and resolvePick', () => {
  it('parses a plain JSON object with chin_y, product_only, and back_view', () => {
    const res = parsePickReply(
      '{"index":2,"has_person":true,"box_2d":[180,200,900,800],"chin_y":220,"product_only":[0,3],"back_view":[1]}',
    );
    assert.deepEqual(res, {
      index: 2,
      has_person: true,
      box_2d: [180, 200, 900, 800],
      chin_y: 220,
      product_only: [0, 3],
      back_view: [1],
    });
  });

  it('parses a one-element JSON array without chin_y, product_only, or back_view', () => {
    const res = parsePickReply('[{"index":0,"has_person":false,"box_2d":[689,95,929,901]}]');
    assert.deepEqual(res, {
      index: 0,
      has_person: false,
      box_2d: [689, 95, 929, 901],
      chin_y: null,
      product_only: [],
      back_view: [],
    });
  });

  it('handles fenced JSON, null chin_y, and missing box_2d', () => {
    const res = parsePickReply('```json\n{"index":1,"has_person":true,"chin_y":null}\n```');
    assert.deepEqual(res, {
      index: 1,
      has_person: true,
      box_2d: null,
      chin_y: null,
      product_only: [],
      back_view: [],
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

  it('resolvePick prefers Image 0 whenever Image 0 is product-only', () => {
    const chosen = resolvePick(
      {
        index: 3,
        has_person: false,
        box_2d: [100, 100, 500, 500],
        chin_y: null,
        product_only: [0, 3],
        back_view: [],
      },
      5,
    );
    assert.deepEqual(chosen, { index: 0, has_person: false, box_2d: null, chin_y: null });

    const chosenZeroDirect = resolvePick(
      {
        index: 0,
        has_person: false,
        box_2d: [200, 200, 600, 600],
        chin_y: null,
        product_only: [],
        back_view: [],
      },
      5,
    );
    assert.deepEqual(chosenZeroDirect, { index: 0, has_person: false, box_2d: null, chin_y: null });
  });

  it('resolvePick overrides a person pick when a non-back product_only index is reported', () => {
    const chosen = resolvePick(
      {
        index: 1,
        has_person: true,
        box_2d: [200, 100, 900, 900],
        chin_y: 180,
        product_only: [2, 4],
        back_view: [2],
      },
      5,
    );
    assert.deepEqual(chosen, { index: 4, has_person: false, box_2d: null, chin_y: null });
  });

  it('resolvePick rejects a back_view on-model pick and falls back to Image 0', () => {
    const chosen = resolvePick(
      {
        index: 2,
        has_person: true,
        box_2d: [150, 100, 900, 900],
        chin_y: 120,
        product_only: [],
        back_view: [2],
      },
      4,
    );
    assert.deepEqual(chosen, { index: 0, has_person: true, box_2d: null, chin_y: null });
  });

  it('resolvePick keeps on-model pick with box and chin when non-back and no product_only exists', () => {
    const chosen = resolvePick(
      {
        index: 0,
        has_person: true,
        box_2d: [220, 120, 880, 880],
        chin_y: 190,
        product_only: [],
        back_view: [2],
      },
      4,
    );
    assert.deepEqual(chosen, {
      index: 0,
      has_person: true,
      box_2d: [220, 120, 880, 880],
      chin_y: 190,
    });
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
      name: 'product-only (no person) + big box -> never cropped',
      w: 1000,
      h: 1000,
      hasPerson: false,
      box: [20, 20, 980, 980],
      expected: null,
    },
    {
      name: 'product-only (no person) + tight box -> never cropped (box ignored)',
      w: 1000,
      h: 1000,
      hasPerson: false,
      box: [200, 200, 700, 700],
      expected: null,
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
      name: 'person + detail box (< 25% area for top) -> fallback below chin, full width to bottom',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [250, 250, 650, 650], // 16% area < 25%
      opts: { chinY: 180, slot: 'top' },
      expected: { left: 0, top: 195, width: 1000, height: 805 },
    },
    {
      name: 'person + detail box (< 6% area for shoes) -> fallback lower 55%',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [700, 400, 900, 600], // 4% area < 6%
      opts: { slot: 'shoes' },
      expected: { left: 0, top: 450, width: 1000, height: 550 },
    },
    {
      name: 'person + usable small box (12% area >= 6% for shoes) -> uses padded box',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: [600, 300, 900, 700], // 12% area >= 6%
      opts: { slot: 'shoes' },
      expected: { left: 270, top: 570, width: 460, height: 360 },
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
      name: 'person + no box + shoes slot -> crop top 45% off (lower 55%)',
      w: 1000,
      h: 1000,
      hasPerson: true,
      box: null,
      opts: { slot: 'shoes' },
      expected: { left: 0, top: 450, width: 1000, height: 550 },
    },
    {
      name: 'person + tiny box + bottom slot -> crop top 45% off (lower 55%)',
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

  it('classifyShotSource reports product-only when hasPerson is false even if tightly cropped', () => {
    assert.equal(classifyShotSource(false), 'product-only');
    assert.equal(classifyShotSource(true), 'cropped');
  });

  it('cropRawRgb extracts exact pixel subregion without sharp PNG round-trip', () => {
    // 4x4 RGB image where pixel (x, y) has [x*10, y*10, 99]
    const w = 4;
    const h = 4;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        rgb[o] = x * 10;
        rgb[o + 1] = y * 10;
        rgb[o + 2] = 99;
      }
    }
    const sub = cropRawRgb(rgb, w, h, 3, { left: 1, top: 2, width: 2, height: 2 });
    assert.equal(sub.length, 2 * 2 * 3);
    // Top-left of crop is (1, 2) -> [10, 20, 99]
    assert.deepEqual(Array.from(sub.slice(0, 3)), [10, 20, 99]);
    // Top-right of crop is (2, 2) -> [20, 20, 99]
    assert.deepEqual(Array.from(sub.slice(3, 6)), [20, 20, 99]);
    // Bottom-right of crop is (2, 3) -> [20, 30, 99]
    assert.deepEqual(Array.from(sub.slice(9, 12)), [20, 30, 99]);
  });
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

  it('normalises a pale grey 238 border to 255 and keeps a white square at 255', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [238, 238, 238], [255, 255, 255]);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, true);

    assert.deepEqual([rgb[0], rgb[1], rgb[2]], [255, 255, 255]);
    const bgOff = (5 * w + 5) * 3;
    assert.deepEqual([rgb[bgOff], rgb[bgOff + 1], rgb[bgOff + 2]], [255, 255, 255]);
    const fgOff = (16 * w + 16) * 3;
    assert.deepEqual([rgb[fgOff], rgb[fgOff + 1], rgb[fgOff + 2]], [255, 255, 255]);
  });

  it('normalises a pale grey border while keeping a dark product within 15% of original', () => {
    const w = 32;
    const h = 32;
    const origFg: [number, number, number] = [40, 60, 80];
    const rgb = makeSyntheticRgb(w, h, [230, 232, 236], origFg);

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, true);

    assert.deepEqual([rgb[0], rgb[1], rgb[2]], [255, 255, 255]);
    const fgOff = (16 * w + 16) * 3;
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(rgb[fgOff + c] - origFg[c]);
      assert.ok(
        diff <= origFg[c] * 0.15 + 1,
        `channel ${c} changed from ${origFg[c]} to ${rgb[fgOff + c]} (> 15%)`,
      );
    }
  });

  it('flood-fills a mid-grey border and lifts near-background shades while keeping dark centre dark', () => {
    const w = 32;
    const h = 32;
    const rgb = makeSyntheticRgb(w, h, [200, 200, 200], [30, 40, 50]);
    // Add a near-background halo pixel just outside tolerance 14 (218 - 200 = 18 > 14)
    const haloOff = (9 * w + 16) * 3;
    rgb[haloOff] = 218;
    rgb[haloOff + 1] = 218;
    rgb[haloOff + 2] = 218;

    const ran = whitenBackground(rgb, w, h);
    assert.equal(ran, true);

    assert.deepEqual([rgb[0], rgb[1], rgb[2]], [255, 255, 255]);
    // Near-background halo lifted to pure white by post-fill gain
    assert.deepEqual([rgb[haloOff], rgb[haloOff + 1], rgb[haloOff + 2]], [255, 255, 255]);
    // Dark centre remains dark
    const fgOff = (16 * w + 16) * 3;
    assert.ok(rgb[fgOff] < 60 && rgb[fgOff + 1] < 70 && rgb[fgOff + 2] < 80);
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
    assert.ok(
      Math.abs(estimateCostUsd({ model: 'gemini-omni-1.2-flash', images: 1 }) - 0.6) < 1e-9,
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

describe('try-on verify loop, gate correction, and inspector parser', () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it('buildGateCorrection combines lines for every gate score below 0.6', () => {
    assert.equal(
      buildGateCorrection({ same_person: 0.9, all_pieces: 0.8, no_extras: 0.7, colours_match: 0.6 }),
      '',
    );
    const extrasOnly = buildGateCorrection({
      same_person: 0.9,
      all_pieces: 0.8,
      no_extras: 0.2,
      colours_match: 0.8,
    });
    assert.equal(
      extrasOnly,
      'Remove anything worn or carried that is not in the list (no belts, hats, bags or jewellery unless listed).',
    );
    const allFour = buildGateCorrection({
      same_person: 0.1,
      all_pieces: 0.2,
      no_extras: 0.3,
      colours_match: 0.4,
    });
    assert.match(allFour, /exactly the shopper in Image 0/);
    assert.match(allFour, /including the shoes/);
    assert.match(allFour, /Remove anything worn or carried/);
    assert.match(allFour, /Match each piece's colour/);
  });

  it('parseInspectorReply handles valid show/redo JSON, arrays, fences, and garbage', () => {
    const redo = parseInspectorReply(
      '{"verdict":"redo","problems":[{"kind":"extra_item","detail":"black belt"}],"fix":"Remove the black belt."}',
      'gemini-4-neon',
    );
    assert.deepEqual(redo, {
      model: 'gemini-4-neon',
      verdict: 'redo',
      problems: [{ kind: 'extra_item', detail: 'black belt' }],
      fix: 'Remove the black belt.',
    });

    const show = parseInspectorReply(
      '```json\n[{"verdict":"show","problems":[],"fix":""}]\n```',
      'gemini-4-carbon',
    );
    assert.deepEqual(show, {
      model: 'gemini-4-carbon',
      verdict: 'show',
      problems: [],
      fix: '',
    });

    assert.equal(parseInspectorReply('not json', 'gemini-4-neon'), null);
    assert.equal(parseInspectorReply('{"verdict":"maybe"}', 'gemini-4-neon'), null);
  });

  it('pass path adds only gate time and never calls inspector (>= 0.70 on all)', async () => {
    let inspectCalls = 0;
    let genCalls = 0;
    const out = await runTryOnVerifyLoop<string>({
      generate: async () => {
        genCalls += 1;
        return 'img1';
      },
      gate: async () => ({
        scores: { same_person: 0.9, all_pieces: 0.72, no_extras: 0.7, colours_match: 0.92 },
        ms: 420,
      }),
      inspect: async () => {
        inspectCalls += 1;
        return { result: null, ms: 0 };
      },
    });
    assert.equal(out.image, 'img1');
    assert.equal(genCalls, 1);
    assert.equal(inspectCalls, 0);
    assert.equal(out.check.path, 'pass');
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.passed, true);
    assert.equal(out.check.inspector, null);
    assert.equal(out.check.ms_gate, 420);
    assert.equal(typeof out.check.ms_total, 'number');
  });

  it('borderline (0.60..0.70) returns immediately and runs inspector in background for logging only', async () => {
    let bgVerdict: string | null = null;
    const t0 = Date.now();
    const out = await runTryOnVerifyLoop<string>({
      generate: async () => 'img1',
      gate: async () => ({
        scores: { same_person: 0.9, all_pieces: 0.65, no_extras: 0.85, colours_match: 0.9 },
        ms: 20,
      }),
      inspect: async () => {
        await delay(80);
        return {
          result: { model: 'gemini-4-neon', verdict: 'show', problems: [], fix: '' },
          ms: 80,
        };
      },
      onBackgroundInspect: (res) => {
        bgVerdict = res?.verdict ?? null;
      },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 60, `borderline should not wait for inspector, took ${elapsed}ms`);
    assert.equal(out.image, 'img1');
    assert.equal(out.check.path, 'pass');
    assert.equal(out.check.passed, true);
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.inspector, null);
    assert.equal(out.check.inspector_pending, true);
    await delay(100);
    assert.equal(bgVerdict, 'show');
  });

  it('gate fail starts redo immediately in parallel without waiting for inspector, and returns without inspector if still pending', async () => {
    const events: string[] = [];
    const corrections: Array<string | null> = [];
    const out = await runTryOnVerifyLoop<string>({
      generate: async (fix) => {
        corrections.push(fix);
        if (fix) {
          events.push('redo_started');
          await delay(40);
          events.push('redo_done');
          return 'img2';
        }
        return 'img1';
      },
      gate: async (img) =>
        img === 'img1'
          ? {
              scores: { same_person: 0.9, all_pieces: 0.85, no_extras: 0.2, colours_match: 0.9 },
              ms: 15,
            }
          : {
              scores: { same_person: 0.92, all_pieces: 0.88, no_extras: 0.91, colours_match: 0.9 },
              ms: 15,
            },
      inspect: async () => {
        events.push('inspect_started');
        await delay(120);
        events.push('inspect_done');
        return {
          result: {
            model: 'gemini-4-neon',
            verdict: 'redo',
            problems: [{ kind: 'extra_item', detail: 'belt' }],
            fix: 'Remove belt.',
          },
          ms: 120,
        };
      },
    });

    assert.equal(out.image, 'img2');
    assert.equal(out.check.path, 'redo');
    assert.equal(out.check.attempts, 2);
    assert.equal(out.check.passed, true);
    assert.equal(out.check.inspector, null);
    assert.equal(out.check.inspector_pending, true);
    assert.match(out.check.correction ?? '', /Remove anything worn or carried/);
    assert.equal(corrections[1], out.check.correction);
    // Redo finished BEFORE the slow inspector finished -> proves redo did not wait!
    assert.ok(events.includes('redo_done'));
    assert.equal(events.includes('inspect_done'), false);
    await delay(100);
  });

  it('inspector "show" overrules gate fail and returns first image early without waiting for slow redo', async () => {
    const t0 = Date.now();
    const out = await runTryOnVerifyLoop<string>({
      generate: async (fix) => {
        if (fix) {
          await delay(150);
          return 'img2';
        }
        return 'img1';
      },
      gate: async () => ({
        scores: { same_person: 0.9, all_pieces: 0.55, no_extras: 0.9, colours_match: 0.9 },
        ms: 10,
      }),
      inspect: async () => {
        await delay(25);
        return {
          result: { model: 'gemini-4-neon', verdict: 'show', problems: [], fix: '' },
          ms: 25,
        };
      },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `expected early overrule return, took ${elapsed}ms`);
    assert.equal(out.image, 'img1');
    assert.equal(out.check.path, 'inspector_overruled');
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.passed, true);
    assert.equal(out.check.inspector?.verdict, 'show');
    await delay(150);
  });

  it('skips redo when first image took longer than 26 s (redo_skipped: late)', async () => {
    let clock = 0;
    let genCalls = 0;
    let inspectCalls = 0;
    const out = await runTryOnVerifyLoop<string>({
      now: () => clock,
      startedAt: 0,
      capMs: 40_000,
      lateFirstMs: 26_000,
      generate: async () => {
        genCalls += 1;
        clock += 27_000;
        return 'img1';
      },
      gate: async () => {
        clock += 1_000;
        return {
          scores: { same_person: 0.9, all_pieces: 0.9, no_extras: 0.2, colours_match: 0.9 },
          ms: 1000,
        };
      },
      inspect: async () => {
        inspectCalls += 1;
        return { result: null, ms: 0 };
      },
    });
    assert.equal(out.image, 'img1');
    assert.equal(genCalls, 1);
    assert.equal(inspectCalls, 0);
    assert.equal(out.check.path, 'redo_skipped');
    assert.equal(out.check.redo_skipped, 'late');
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.passed, false);
  });

  it('hard cap returns best image so far when redo exceeds remaining cap', async () => {
    const t0 = Date.now();
    const out = await runTryOnVerifyLoop<string>({
      capMs: 90,
      lateFirstMs: 50,
      minGateBudgetMs: 5,
      generate: async (fix) => {
        if (fix) {
          await delay(250);
          return 'img2';
        }
        await delay(20);
        return 'img1';
      },
      gate: async () => ({
        scores: { same_person: 0.9, all_pieces: 0.9, no_extras: 0.2, colours_match: 0.9 },
        ms: 10,
      }),
      inspect: async () => {
        await delay(250);
        return { result: null, ms: 250 };
      },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 180, `expected cap return near 90ms, took ${elapsed}ms`);
    assert.equal(out.image, 'img1');
    assert.equal(out.check.path, 'redo_skipped');
    assert.equal(out.check.redo_skipped, 'cap');
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.passed, false);
    assert.equal(out.check.inspector_pending, true);
    await delay(250);
  });

  it('skips gate and inspector completely when verifyOff is true', async () => {
    let gateCalls = 0;
    let inspectCalls = 0;
    const out = await runTryOnVerifyLoop<string>({
      verifyOff: true,
      generate: async () => 'img1',
      gate: async () => {
        gateCalls += 1;
        return { scores: null, ms: 0 };
      },
      inspect: async () => {
        inspectCalls += 1;
        return { result: null, ms: 0 };
      },
    });
    assert.equal(out.image, 'img1');
    assert.equal(gateCalls, 0);
    assert.equal(inspectCalls, 0);
    assert.equal(out.check.path, 'pass');
    assert.equal(out.check.attempts, 1);
    assert.equal(out.check.passed, true);
  });
});

describe('try-on extras: buildSetting, filenames, and parallel orchestrator', () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it('buildSetting formats occasion, where, when, and weather naturally', () => {
    assert.equal(
      buildSetting({
        occasion: "a friend's rooftop birthday",
        where: 'New York',
        when: 'Saturday evening',
        weather: 'cool, overcast',
      }),
      "a friend's rooftop birthday in New York on a cool, overcast Saturday evening, city lights behind",
    );
    assert.equal(
      buildSetting({
        occasion: 'a beach wedding',
        where: 'Malibu',
        when: 'Sunday afternoon',
        weather: 'overcast, breezy',
      }),
      'a beach wedding in Malibu on an overcast, breezy Sunday afternoon, soft ocean light and shoreline behind',
    );
    assert.equal(
      buildSetting({ occasion: 'a gallery opening', where: 'Chelsea' }),
      'a gallery opening in Chelsea',
    );
    assert.equal(buildSetting({ occasion: 'date night' }), 'date night');
  });

  it('generates server-safe scene and video filenames matching TRYON_NAME_RE', () => {
    const id = newTryonId();
    assert.match(sceneFileName(id), TRYON_NAME_RE);
    assert.match(videoFileName(id), TRYON_NAME_RE);
    assert.ok(videoFileName(id).endsWith('.mp4'));
  });

  it('starts scene and video in parallel and invokes onRender in arrival order', async () => {
    const events: string[] = [];
    const arrivals: Array<{ kind: 'scene' | 'video'; ok: boolean; url?: string }> = [];

    const out = await runTryOnExtrasLoop({
      setting: 'rooftop dinner in New York',
      sceneEnabled: true,
      videoEnabled: true,
      runScene: async () => {
        events.push('scene_start');
        await delay(25);
        events.push('scene_end');
        return { url: '/tryon/scene-1.jpg', path: '/tmp/scene-1.jpg', ms: 25 };
      },
      runVideo: async () => {
        events.push('video_start');
        await delay(70);
        events.push('video_end');
        return { url: '/tryon/video-1.mp4', path: '/tmp/video-1.mp4', ms: 70 };
      },
      onRender: (r) => {
        arrivals.push({ kind: r.kind, ok: r.ok, url: r.url });
      },
    });

    // Both started before either finished
    assert.deepEqual(events.slice(0, 2), ['scene_start', 'video_start']);
    // Scene arrived first, then video
    assert.deepEqual(arrivals, [
      { kind: 'scene', ok: true, url: '/tryon/scene-1.jpg' },
      { kind: 'video', ok: true, url: '/tryon/video-1.mp4' },
    ]);
    assert.equal(out.scene?.url, '/tryon/scene-1.jpg');
    assert.equal(out.video?.url, '/tryon/video-1.mp4');
    assert.equal(out.setting, 'rooftop dinner in New York');
  });

  it('degrades a failed part to null while returning the other part without throwing', async () => {
    const arrivals: Array<{ kind: 'scene' | 'video'; ok: boolean }> = [];
    const out = await runTryOnExtrasLoop({
      setting: 'dinner in SoHo',
      sceneEnabled: true,
      videoEnabled: true,
      runScene: async () => {
        throw new Error('scene boom');
      },
      runVideo: async () => {
        await delay(20);
        return { url: '/tryon/video-2.mp4', path: '/tmp/video-2.mp4', ms: 20 };
      },
      onRender: (r) => {
        arrivals.push({ kind: r.kind, ok: r.ok });
      },
    });

    assert.equal(out.scene, null);
    assert.equal(out.video?.url, '/tryon/video-2.mp4');
    assert.deepEqual(arrivals, [
      { kind: 'scene', ok: false },
      { kind: 'video', ok: true },
    ]);
  });

  it('honors sceneEnabled / videoEnabled switches without calling disabled renders', async () => {
    let sceneCalls = 0;
    let videoCalls = 0;
    const out = await runTryOnExtrasLoop({
      setting: 'coffee walk',
      sceneEnabled: false,
      videoEnabled: false,
      runScene: async () => {
        sceneCalls += 1;
        return { url: '/tryon/scene-x.jpg', path: '/tmp/x.jpg', ms: 10 };
      },
      runVideo: async () => {
        videoCalls += 1;
        return { url: '/tryon/video-x.mp4', path: '/tmp/x.mp4', ms: 10 };
      },
    });

    assert.equal(sceneCalls, 0);
    assert.equal(videoCalls, 0);
    assert.equal(out.scene, null);
    assert.equal(out.video, null);
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
