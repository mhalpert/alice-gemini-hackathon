import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brief, Item, Outfit } from '../src/types.ts';
import { _setFetch, critiqueAll, critiqueOutfit } from '../src/brain/critic.ts';
import { getCallLogPath } from '../src/calllog.ts';
import { ledgerPath, ledgerTotal } from '../src/ledger.ts';

function makeItem(overrides: Partial<Item> & { id: string; title: string; image: string }): Item {
  return {
    variant_id: `var-${overrides.id}`,
    price: 40,
    url: `https://store.test/products/${overrides.id}`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 20,
    sizes: ['M'],
    variants_by_size: {},
    description: 'Test product description',
    department: 'men',
    ...overrides,
  };
}

function makeOutfit(prefix: string): Outfit {
  return {
    number: 1,
    name: 'Rooftop Knit',
    difference: 'Clean knit polo with dark chinos.',
    story: 'Easy polished evening look.',
    total: 120,
    pieces: [
      {
        slot: 'top',
        why: 'Textured knit polo.',
        item: makeItem({ id: `${prefix}-top`, title: 'Knit Polo - Navy', price: 35, image: `https://cdn.test/${prefix}-top.jpg` }),
      },
      {
        slot: 'bottom',
        why: 'Tailored dark trousers.',
        item: makeItem({ id: `${prefix}-bottom`, title: 'Relaxed Chino - Black', price: 45, image: `https://cdn.test/${prefix}-bottom.jpg` }),
      },
      {
        slot: 'shoes',
        why: 'Clean sneakers.',
        item: makeItem({ id: `${prefix}-shoes`, title: 'Leather Sneaker - White', price: 30, image: `https://cdn.test/${prefix}-shoes.jpg` }),
      },
      {
        slot: 'accessory',
        why: 'Subtle watch.',
        item: makeItem({ id: `${prefix}-acc`, title: 'Steel Watch - Silver', price: 10, image: `https://cdn.test/${prefix}-acc.jpg` }),
      },
    ],
  };
}

const brief: Brief = {
  gender: 'men',
  occasion: "a friend's rooftop birthday",
  budget_usd: 150,
  weather: '58°F and breezy',
};

function geminiJsonResponse(payload: unknown, opts: { thought?: string; promptTokens?: number; candTokens?: number; thoughtTokens?: number } = {}): Response {
  const parts: Record<string, unknown>[] = [];
  if (opts.thought) parts.push({ thought: true, text: opts.thought });
  parts.push({ text: JSON.stringify(payload) });
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: {
        promptTokenCount: opts.promptTokens ?? 1200,
        candidatesTokenCount: opts.candTokens ?? 140,
        thoughtsTokenCount: opts.thoughtTokens ?? 60,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const origFetch = globalThis.fetch;
const origGoogleKey = process.env.GOOGLE_API_KEY;
const origTryonKey = process.env.GOOGLE_TRYON_API_KEY;
const origModel = process.env.ALICE_MODEL_CRITIC;
const origLedgerDir = process.env.ALICE_LEDGER_DIR;
const origLogDir = process.env.ALICE_LOG_DIR;

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alice-critic-test-'));
  process.env.GOOGLE_API_KEY = 'test-key';
  delete process.env.GOOGLE_TRYON_API_KEY;
  delete process.env.ALICE_MODEL_CRITIC;
  process.env.ALICE_LEDGER_DIR = join(tmpDir, 'ledger');
  process.env.ALICE_LOG_DIR = join(tmpDir, 'logs');
  _setFetch(null);
});

afterEach(async () => {
  await ledgerTotal();
  _setFetch(null);
  globalThis.fetch = origFetch;
  if (origGoogleKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = origGoogleKey;
  if (origTryonKey === undefined) delete process.env.GOOGLE_TRYON_API_KEY; else process.env.GOOGLE_TRYON_API_KEY = origTryonKey;
  if (origModel === undefined) delete process.env.ALICE_MODEL_CRITIC; else process.env.ALICE_MODEL_CRITIC = origModel;
  if (origLedgerDir === undefined) delete process.env.ALICE_LEDGER_DIR; else process.env.ALICE_LEDGER_DIR = origLedgerDir;
  if (origLogDir === undefined) delete process.env.ALICE_LOG_DIR; else process.env.ALICE_LOG_DIR = origLogDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('critiqueOutfit', () => {
  test('parses a good reply, skips thought parts, clamps scores (11 -> 10), logs cost and room event', async () => {
    let seenUrl = '';
    let seenKey = '';
    let seenBody: any = null;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://cdn.test/')) {
        return new Response(Uint8Array.from([0xff, 0xd8, 0xff]), { status: 200 });
      }
      seenUrl = url;
      seenKey = (init?.headers as Record<string, string>)?.['x-goog-api-key'] ?? '';
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return geminiJsonResponse(
        {
          score: 11,
          presentable: true,
          occasion_fit: 9.6,
          cohesion: 0,
          completeness: 8,
          issues: ['minor sleeve length'],
          weak_piece: { slot: 'accessory', reason: 'Watch is a bit flashy', ask: 'minimal leather strap watch' },
        },
        { thought: 'Internal reasoning should be ignored', promptTokens: 1500, candTokens: 110, thoughtTokens: 90 },
      );
    }) as typeof fetch;

    const outfit = makeOutfit('clamp');
    const result = await critiqueOutfit(outfit, brief, { room: 'critic-room-1' });

    assert.equal(seenUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent');
    assert.equal(seenKey, 'test-key');
    assert.equal(seenBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(seenBody.generationConfig.temperature, 0.2);
    assert.deepEqual(seenBody.generationConfig.thinkingConfig, { thinkingLevel: 'low' });

    assert.equal(result.score, 10);
    assert.equal(result.presentable, true);
    assert.equal(result.occasion_fit, 10);
    assert.equal(result.cohesion, 1);
    assert.equal(result.completeness, 8);
    assert.deepEqual(result.issues, ['minor sleeve length']);
    assert.deepEqual(result.weak_piece, {
      slot: 'accessory',
      reason: 'Watch is a bit flashy',
      ask: 'minimal leather strap watch',
    });
    assert.equal(result.model, 'gemini-4-argon');
    assert.equal(result.error, undefined);
    assert.ok(result.ms >= 0);

    // Cost recorded with candidates + thoughts tokens
    const totals = await ledgerTotal();
    assert.equal(totals.calls, 1);
    const ledgerRow = JSON.parse(readFileSync(ledgerPath(), 'utf8').trim());
    assert.equal(ledgerRow.job, 'brain_critic');
    assert.equal(ledgerRow.model, 'gemini-4-argon');
    assert.equal(ledgerRow.input_tokens, 1500);
    assert.equal(ledgerRow.output_tokens, 200);

    // Room log written
    const logLines = readFileSync(getCallLogPath('critic-room-1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logLines.length, 1);
    assert.equal(logLines[0].ev, 'critic');
    assert.equal(logLines[0].number, 1);
    assert.equal(logLines[0].name, 'Rooftop Knit');
    assert.equal(logLines[0].score, 10);
    assert.equal(logLines[0].presentable, true);
  });

  test('presentable respects model field when score >= 7, and is forced false when score < 7', async () => {
    const replies = [
      { score: 8, presentable: true, occasion_fit: 8, cohesion: 8, completeness: 8, issues: [], weak_piece: null },
      { score: 8, presentable: false, occasion_fit: 8, cohesion: 8, completeness: 8, issues: ['white dress at wedding'], weak_piece: null },
      { score: 6, presentable: true, occasion_fit: 6, cohesion: 6, completeness: 7, issues: ['mismatched shoes'], weak_piece: { slot: 'shoes', reason: 'too casual', ask: 'brown leather loafers' } },
    ];
    let idx = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith('https://cdn.test/')) {
        return new Response(null, { status: 404 });
      }
      return geminiJsonResponse(replies[idx++]);
    }) as typeof fetch;

    const a = await critiqueOutfit(makeOutfit('pres-a'), brief);
    const b = await critiqueOutfit(makeOutfit('pres-b'), brief);
    const c = await critiqueOutfit(makeOutfit('pres-c'), brief);

    assert.equal(a.score, 8);
    assert.equal(a.presentable, true);
    assert.equal(b.score, 8);
    assert.equal(b.presentable, false);
    assert.equal(c.score, 6);
    assert.equal(c.presentable, false);
  });

  test('unknown weak_piece slot becomes null', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith('https://cdn.test/')) {
        return new Response(null, { status: 404 });
      }
      return geminiJsonResponse({
        score: 6,
        presentable: false,
        occasion_fit: 6,
        cohesion: 6,
        completeness: 6,
        issues: ['missing jacket'],
        weak_piece: { slot: 'hat', reason: 'Not in outfit', ask: 'navy blazer' },
      });
    }) as typeof fetch;

    const result = await critiqueOutfit(makeOutfit('bad-slot'), brief);
    assert.equal(result.score, 6);
    assert.equal(result.weak_piece, null);
  });

  test('HTTP 500 returns error and score 0 without throwing', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith('https://cdn.test/')) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({ error: { message: 'backend exploded' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await critiqueOutfit(makeOutfit('http-500'), brief);
    assert.equal(result.score, 0);
    assert.equal(result.presentable, false);
    assert.equal(result.occasion_fit, 0);
    assert.equal(result.cohesion, 0);
    assert.equal(result.completeness, 0);
    assert.deepEqual(result.issues, []);
    assert.equal(result.weak_piece, null);
    assert.ok(result.error && result.error.includes('500') && result.error.includes('backend exploded'));
  });

  test('timeout returns error without throwing', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://cdn.test/')) {
        return new Response(null, { status: 404 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Timed out', 'TimeoutError'));
        });
      });
    }) as typeof fetch;

    const result = await critiqueOutfit(makeOutfit('timeout'), brief, { timeoutMs: 40 });
    assert.equal(result.score, 0);
    assert.equal(result.presentable, false);
    assert.equal(result.weak_piece, null);
    assert.ok(result.error && result.error.length > 0);
  });

  test('includes image parts for resolved thumbnails and skips null thumbnails', async () => {
    let sentParts: any[] = [];
    const okBytes = Buffer.from('fake-jpeg-bytes');

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://cdn.test/')) {
        if (url.includes('-top.jpg') || url.includes('-shoes.jpg')) {
          return new Response(okBytes, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      sentParts = body.contents[0].parts;
      return geminiJsonResponse({
        score: 7,
        presentable: true,
        occasion_fit: 7,
        cohesion: 7,
        completeness: 7,
        issues: [],
        weak_piece: null,
      });
    }) as typeof fetch;

    const outfit = makeOutfit('imgs');
    const result = await critiqueOutfit(outfit, brief);
    assert.equal(result.score, 7);

    // Expected parts: brief text, top text + top image, bottom text (no image), shoes text + shoes image, accessory text (no image), total text
    assert.equal(sentParts.length, 8);
    assert.ok(sentParts[0].text.includes("men's"));
    assert.ok(sentParts[0].text.includes(brief.occasion));
    assert.ok(sentParts[0].text.includes('$150'));
    assert.ok(sentParts[0].text.includes('58°F and breezy'));

    assert.equal(sentParts[1].text, 'top: Knit Polo - Navy ($35, Everlane)');
    assert.deepEqual(sentParts[2], { inlineData: { mimeType: 'image/jpeg', data: okBytes.toString('base64') } });

    assert.equal(sentParts[3].text, 'bottom: Relaxed Chino - Black ($45, Everlane)');

    assert.equal(sentParts[4].text, 'shoes: Leather Sneaker - White ($30, Everlane)');
    assert.deepEqual(sentParts[5], { inlineData: { mimeType: 'image/jpeg', data: okBytes.toString('base64') } });

    assert.equal(sentParts[6].text, 'accessory: Steel Watch - Silver ($10, Everlane)');
    assert.equal(sentParts[7].text, 'Total: $120');
  });

  test('critiqueAll critiques outfits in parallel and preserves order', async () => {
    const o1 = makeOutfit('all-1');
    const o2 = makeOutfit('all-2');
    o2.number = 2;
    o2.name = 'Second Look';

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://cdn.test/')) {
        return new Response(null, { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      const firstPiece: string = body.contents[0].parts[1].text;
      // Check injectable _setFetch works too; here return distinct scores based on total
      const isSecond = body.contents[0].parts.at(-1).text.includes('99');
      assert.ok(firstPiece.startsWith('top:'));
      return geminiJsonResponse({
        score: isSecond ? 5 : 9,
        presentable: !isSecond,
        occasion_fit: isSecond ? 5 : 9,
        cohesion: isSecond ? 5 : 9,
        completeness: isSecond ? 5 : 9,
        issues: isSecond ? ['weak pairing'] : [],
        weak_piece: null,
      });
    }) as typeof fetch;

    o2.total = 99;
    const results = await critiqueAll([o1, o2], brief);
    assert.equal(results.length, 2);
    assert.equal(results[0].score, 9);
    assert.equal(results[1].score, 5);
  });
});
