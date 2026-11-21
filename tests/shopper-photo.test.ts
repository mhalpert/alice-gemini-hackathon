import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { checkShopperPhotoUncached } from '../src/media/inspect.ts';
import {
  SHOPPER_PHOTO_FACE_ONLY_NOTE,
  createShopperPhotoCache,
  evaluateShopperPhoto,
  resolveShopperPhoto,
  runTryOnVerifyLoop,
  type ShopperPhotoCheckResult,
  type TryOnGateScores,
} from '../src/media/pure.ts';

const GOOD_GATE: TryOnGateScores = {
  same_person: 0.92,
  all_pieces: 0.91,
  no_extras: 0.9,
  colours_match: 0.93,
};

const BAD_PERSON_GATE: TryOnGateScores = {
  same_person: 0.18,
  all_pieces: 0.91,
  no_extras: 0.9,
  colours_match: 0.93,
};

describe('shopper photo evaluation and resolution', () => {
  it('uses test shopper on no-person photo and avoids same-person re-renders', async () => {
    const colorBars = Buffer.from('fake-color-bars-jpeg');
    let snapshotPrepared = 0;
    let testShopperLoaded = 0;
    let generateCalls = 0;

    const resolved = await resolveShopperPhoto<string>({
      personInput: colorBars,
      checkPhoto: async () => ({
        scores: { person_visible: 0.04, torso_visible: 0.02, usable: 0.1 },
        ms: 210,
      }),
      prepareSnapshot: async () => {
        snapshotPrepared += 1;
        return 'camera-shopper';
      },
      getTestShopper: async () => {
        testShopperLoaded += 1;
        return 'test-shopper-men';
      },
    });

    assert.equal(resolved.shopper, 'test-shopper-men');
    assert.equal(resolved.shopper_photo, 'none');
    assert.equal(resolved.shopper_notes, undefined);
    assert.equal(snapshotPrepared, 0);
    assert.equal(testShopperLoaded, 1);
    assert.equal(resolved.ms_shopper_photo, 210);

    // Gate compares generated try-on against resolved shopper (test shopper) -> passes in 1 attempt
    const verify = await runTryOnVerifyLoop<string>({
      generate: async () => {
        generateCalls += 1;
        return `tryon-of-${resolved.shopper}`;
      },
      gate: async (img) => ({
        scores: img.includes('test-shopper') ? GOOD_GATE : BAD_PERSON_GATE,
        ms: 350,
      }),
      inspect: async () => {
        throw new Error('inspector should not run when gate passes');
      },
    });

    assert.equal(generateCalls, 1);
    assert.equal(verify.check.attempts, 1);
    assert.equal(verify.check.passed, true);
    assert.equal(verify.check.path, 'pass');
  });

  it('uses camera snapshot as is when a real person and torso are visible', async () => {
    const personBytes = Buffer.from('fake-real-shopper-jpeg');
    let testShopperLoaded = 0;

    const resolved = await resolveShopperPhoto<string>({
      personInput: personBytes,
      checkPhoto: async () => ({
        scores: { person_visible: 0.97, torso_visible: 0.91, usable: 0.95 },
        ms: 195,
      }),
      prepareSnapshot: async () => 'camera-shopper',
      getTestShopper: async () => {
        testShopperLoaded += 1;
        return 'test-shopper-men';
      },
    });

    assert.equal(resolved.shopper, 'camera-shopper');
    assert.equal(resolved.shopper_photo, 'camera');
    assert.equal(resolved.shopper_notes, undefined);
    assert.equal(testShopperLoaded, 0);
  });

  it('keeps camera snapshot and adds shopper_notes when only the face is visible', async () => {
    const faceOnlyBytes = Buffer.from('fake-face-closeup-jpeg');

    const resolved = await resolveShopperPhoto<string>({
      personInput: faceOnlyBytes,
      checkPhoto: async () => ({
        scores: { person_visible: 0.92, torso_visible: 0.28, usable: 0.88 },
        ms: 180,
      }),
      prepareSnapshot: async () => 'camera-shopper',
      getTestShopper: async () => 'test-shopper-men',
    });

    assert.equal(resolved.shopper, 'camera-shopper');
    assert.equal(resolved.shopper_photo, 'camera');
    assert.equal(resolved.shopper_notes, SHOPPER_PHOTO_FACE_ONLY_NOTE);
    assert.equal(resolved.shopper_notes, 'only the face is visible');
  });

  it('returns shopper_photo=test without calling checkPhoto when personJpeg is null', async () => {
    let checks = 0;

    const resolved = await resolveShopperPhoto<string>({
      personInput: null,
      checkPhoto: async () => {
        checks += 1;
        return { scores: null, ms: 0 };
      },
      prepareSnapshot: async () => 'camera-shopper',
      getTestShopper: async () => 'test-shopper-women',
    });

    assert.equal(resolved.shopper, 'test-shopper-women');
    assert.equal(resolved.shopper_photo, 'test');
    assert.equal(resolved.shopper_notes, undefined);
    assert.equal(checks, 0);
  });

  it('treats snapshot as usable on Decisions API error or timeout', async () => {
    const personBytes = Buffer.from('fake-shopper-on-error');

    const onNullScores = await resolveShopperPhoto<string>({
      personInput: personBytes,
      checkPhoto: async () => ({ scores: null, ms: 1500, error: 'timeout' }),
      prepareSnapshot: async () => 'camera-shopper',
      getTestShopper: async () => 'test-shopper-men',
    });
    assert.equal(onNullScores.shopper, 'camera-shopper');
    assert.equal(onNullScores.shopper_photo, 'camera');
    assert.equal(onNullScores.shopper_notes, undefined);

    const onThrow = await resolveShopperPhoto<string>({
      personInput: personBytes,
      checkPhoto: async () => {
        throw new Error('network error');
      },
      prepareSnapshot: async () => 'camera-shopper',
      getTestShopper: async () => 'test-shopper-men',
    });
    assert.equal(onThrow.shopper, 'camera-shopper');
    assert.equal(onThrow.shopper_photo, 'camera');
  });

  it('caches by image hash: three try-ons with the same bytes make ONE photo check', async () => {
    let apiCalls = 0;
    const cache = createShopperPhotoCache(async (): Promise<ShopperPhotoCheckResult> => {
      apiCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        scores: { person_visible: 0.94, torso_visible: 0.85, usable: 0.92 },
        ms: 15,
      };
    });

    const sharedSnapshot = Buffer.from('identical-call-snapshot-bytes');

    // Parallel burst (3 looks kicked off together)
    const parallelResults = await Promise.all([
      resolveShopperPhoto<string>({
        personInput: sharedSnapshot,
        checkPhoto: (b) => cache.check(b),
        prepareSnapshot: async () => 'camera-1',
        getTestShopper: async () => 'test',
      }),
      resolveShopperPhoto<string>({
        personInput: Buffer.from(sharedSnapshot), // separate Buffer with identical bytes
        checkPhoto: (b) => cache.check(b),
        prepareSnapshot: async () => 'camera-2',
        getTestShopper: async () => 'test',
      }),
      resolveShopperPhoto<string>({
        personInput: new Uint8Array(sharedSnapshot),
        checkPhoto: (b) => cache.check(b),
        prepareSnapshot: async () => 'camera-3',
        getTestShopper: async () => 'test',
      }),
    ]);

    assert.equal(apiCalls, 1);
    assert.equal(cache.size(), 1);
    for (const r of parallelResults) {
      assert.equal(r.shopper_photo, 'camera');
    }

    // Subsequent sequential call with same bytes still uses cache
    const seq = await resolveShopperPhoto<string>({
      personInput: sharedSnapshot,
      checkPhoto: (b) => cache.check(b),
      prepareSnapshot: async () => 'camera-4',
      getTestShopper: async () => 'test',
    });
    assert.equal(apiCalls, 1);
    assert.equal(seq.shopper_photo, 'camera');
    assert.equal(seq.ms_shopper_photo, 0);

    // Different image bytes trigger a fresh check
    const otherSnapshot = Buffer.from('different-snapshot-bytes');
    await resolveShopperPhoto<string>({
      personInput: otherSnapshot,
      checkPhoto: (b) => cache.check(b),
      prepareSnapshot: async () => 'camera-5',
      getTestShopper: async () => 'test',
    });
    assert.equal(apiCalls, 2);
    assert.equal(cache.size(), 2);
  });

  it('evaluateShopperPhoto boundary conditions at 0.5 threshold', () => {
    const atThreshold = evaluateShopperPhoto(
      { person_visible: 0.5, torso_visible: 0.5, usable: 0.5 },
      100,
    );
    assert.equal(atThreshold.useSnapshot, true);
    assert.equal(atThreshold.shopper_photo, 'camera');
    assert.equal(atThreshold.shopper_notes, undefined);

    const belowPerson = evaluateShopperPhoto(
      { person_visible: 0.49, torso_visible: 0.1, usable: 0.9 },
      100,
    );
    assert.equal(belowPerson.useSnapshot, false);
    assert.equal(belowPerson.shopper_photo, 'none');
    assert.equal(belowPerson.shopper_notes, undefined);
  });
});

describe('checkShopperPhotoUncached Decisions API client', () => {
  it('sends person_visible, torso_visible, and usable to gemini-decision-1 and parses scores', async () => {
    const prevKey = process.env.GOOGLE_API_KEY;
    const prevLedger = process.env.ALICE_LEDGER_DIR;
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alice-shopper-photo-'));
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.ALICE_LEDGER_DIR = tmpDir;
    try {
      const tinyJpeg = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#808080' },
      })
        .jpeg()
        .toBuffer();

      let seenBody: Record<string, unknown> | null = null;
      const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            usage: { input_tokens: 120 },
            answers: {
              person_visible: { noul: 0.08 },
              torso_visible: { noul: 0.03 },
              usable: { noul: 0.12 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      const res = await checkShopperPhotoUncached(tinyJpeg, {
        fetchFn: fakeFetch,
        timeoutMs: 1500,
      });

      assert.deepEqual(res.scores, {
        person_visible: 0.08,
        torso_visible: 0.03,
        usable: 0.12,
      });
      assert.equal(seenBody?.model, 'gemini-decision-1');
      const questions = seenBody?.questions as Record<string, unknown>;
      assert.ok(questions.person_visible);
      assert.ok(questions.torso_visible);
      assert.ok(questions.usable);
    } finally {
      if (prevKey === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = prevKey;
      }
      if (prevLedger === undefined) {
        delete process.env.ALICE_LEDGER_DIR;
      } else {
        process.env.ALICE_LEDGER_DIR = prevLedger;
      }
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns scores=null on HTTP error or network failure so real shoppers are not blocked', async () => {
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key';
    try {
      const tinyJpeg = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#808080' },
      })
        .jpeg()
        .toBuffer();

      const errFetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      const res = await checkShopperPhotoUncached(tinyJpeg, {
        fetchFn: errFetch,
        timeoutMs: 1500,
      });
      assert.equal(res.scores, null);
      assert.ok(res.error);
    } finally {
      if (prevKey === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = prevKey;
      }
    }
  });
});
