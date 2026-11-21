import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import type { Gender, Outfit, Piece } from '../types.ts';
import { buildContactSheet, checkShopperPhoto, runTryOnGate, runTryOnInspector } from './inspect.ts';
import { RenderCeilingError, getRenderLimiter } from './limits.ts';
import {
  newTryonId,
  publicUrl,
  resolveShopperPhoto,
  runTryOnVerifyLoop,
  sortPiecesForTryOn,
  stripHtml,
  tryonDir,
  tryonFileName,
  withWidth,
  type TryOnCheck,
} from './pure.ts';
import { fetchImageBuffer, getGenAI, getProductShot, writeFileAtomic } from './shots.ts';

export interface TryOnResult {
  url: string;
  path: string;
  ms: number;
  id: string;
  check: TryOnCheck;
}

const RATE_LIMIT_DELAYS_MS = [1500, 4000];
const NORMAL_RETRY_DELAY_MS = 500;
const ATTEMPT_TIMEOUT_MS = 45_000;
const testShopperInFlight = new Map<Gender, Promise<Buffer>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withAttemptTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isRateLimitOrUnavailable(err: unknown): boolean {
  const e = err as { status?: number; code?: number | string; message?: string } | null;
  if (e?.status === 429 || e?.status === 503 || e?.code === 429 || e?.code === 503) {
    return true;
  }
  const msg = String(e?.message ?? err ?? '');
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit/i.test(msg);
}

export async function generateImageWithRetry(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  job: 'tryon' | 'test-shopper',
  opts?: { retries?: number; timeoutMs?: number },
): Promise<{ data: Buffer; mimeType: string }> {
  const model = process.env.ALICE_MODEL_TRYON || 'gemini-nano-banana-2.1';
  let normalRetriesLeft = opts?.retries ?? 1;
  const attemptTimeoutMs = opts?.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  let rateLimitAttempt = 0;

  while (true) {
    const attemptStart = Date.now();
    try {
      const response = await getRenderLimiter().run('image', () =>
        withAttemptTimeout(
          getGenAI().models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio: '3:4' },
            },
          }),
          attemptTimeoutMs,
          job,
        ),
      );
      const attemptMs = Date.now() - attemptStart;

      const part = response.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data.length > 0,
      );

      if (!part?.inlineData?.data) {
        throw new Error(`${job} model returned no image`);
      }

      void recordCost({
        model,
        job,
        images: 1,
        ms: attemptMs,
      });

      return {
        data: Buffer.from(part.inlineData.data, 'base64'),
        mimeType: part.inlineData.mimeType || 'image/jpeg',
      };
    } catch (err) {
      if (err instanceof RenderCeilingError) {
        throw err;
      }

      if (isRateLimitOrUnavailable(err) && rateLimitAttempt < RATE_LIMIT_DELAYS_MS.length) {
        const delayMs = RATE_LIMIT_DELAYS_MS[rateLimitAttempt++];
        console.error(
          `[media] ${job} transient 429/503, retrying in ${delayMs}ms: ${(err as Error)?.message}`,
        );
        await sleep(delayMs);
        continue;
      }

      if (normalRetriesLeft > 0) {
        normalRetriesLeft -= 1;
        console.error(
          `[media] ${job} attempt failed, retrying once: ${(err as Error)?.message}`,
        );
        await sleep(NORMAL_RETRY_DELAY_MS);
        continue;
      }

      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

export async function getTestShopper(department: Gender): Promise<Buffer> {
  const dept: Gender = department === 'women' ? 'women' : 'men';
  const filePath = path.join(tryonDir(), `test-shopper-${dept}.jpg`);

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && stat.size > 0) {
      return await fs.promises.readFile(filePath);
    }
  } catch {
    // Generate below
  }

  const inflight = testShopperInFlight.get(dept);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    const subject = dept === 'women' ? 'woman' : 'man';
    const prompt = `full-body studio photo of an adult ${subject} standing facing the camera, plain grey t-shirt, dark jeans, white sneakers, neutral expression, plain light grey background, head to toe in frame, photorealistic, 3:4`;

    const generated = await generateImageWithRetry([{ text: prompt }], 'test-shopper');
    const jpegBuf =
      generated.mimeType === 'image/jpeg'
        ? generated.data
        : await sharp(generated.data).jpeg({ quality: 90 }).toBuffer();

    await writeFileAtomic(filePath, jpegBuf);
    console.log(`[media] generated test-shopper-${dept}.jpg`);
    return jpegBuf;
  })().finally(() => {
    testShopperInFlight.delete(dept);
  });

  testShopperInFlight.set(dept, promise);
  return promise;
}

export async function normalizeShopperJpeg(rawBuf: Uint8Array | Buffer): Promise<Buffer> {
  return sharp(Buffer.from(rawBuf))
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function prepareShopperJpeg(
  personInput: Uint8Array | Buffer | null,
  department: Gender,
): Promise<Buffer> {
  const rawBuf = personInput ? Buffer.from(personInput) : await getTestShopper(department);
  return normalizeShopperJpeg(rawBuf);
}

export async function loadPieceForTryOn(piece: Piece): Promise<Buffer | null> {
  try {
    let rawBuf: Buffer | null = null;
    if (process.env.ALICE_CLEAN_SHOTS !== 'off') {
      const shot = await getProductShot(piece.item, piece.slot);
      if (shot.filePath) {
        try {
          rawBuf = await fs.promises.readFile(shot.filePath);
        } catch {
          rawBuf = null;
        }
      }
    }
    if (!rawBuf && typeof piece.item.image === 'string' && piece.item.image.length > 0) {
      rawBuf = await fetchImageBuffer(withWidth(piece.item.image, 800), 5000);
    }
    if (!rawBuf) return null;

    return await sharp(rawBuf)
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
}

export function buildTryOnPrompt(
  hasShoes: boolean,
  hasBottom: boolean,
  extraLine?: string | null,
): string {
  const lines = [
    'Generate a single photorealistic full-body studio try-on photograph of the shopper from Image 0 dressed in ONLY the listed items.',
    'The product images are cut-outs of single items (some may still show part of a model). Use each product image ONLY for the specific item named in its label.',
    'Ignore any model in the product images completely (face, hair, beard, skin tone, tattoos, body, pose). Every visible part of the person MUST come from Image 0.',
    "Keep the shopper's face, hair, skin tone, and build from Image 0 exactly; do not slim or change proportions.",
    'The label text wins over the product photo for sleeve length, fit, and length.',
    'Whole body head to toe, shoes fully in frame, standing facing the camera, on a clean white studio set with soft light, portrait 3:4.',
    'Dress the person in ONLY the listed items. Do not add belts, bags, jewellery, hats, or any item that is not listed. If a product image shows other garments or props, ignore them.',
  ];
  if (!hasBottom) {
    lines.push('If the outfit has no bottom piece, keep the bottoms from Image 0 (the shopper photo).');
  }
  if (!hasShoes) {
    lines.push('Wear plain white minimalist sneakers.');
  }
  if (extraLine && extraLine.trim().length > 0) {
    lines.push(extraLine.trim());
  }
  return lines.join('\n');
}

export async function renderTryOn(
  personJpeg: Uint8Array | Buffer | null,
  outfit: Outfit,
  opts?: { label?: string },
): Promise<TryOnResult> {
  const t0 = Date.now();
  const rawPieces = Array.isArray(outfit?.pieces) ? outfit.pieces : [];
  if (rawPieces.length === 0) {
    throw new Error('outfit has no pieces');
  }

  const sortedPieces = sortPiecesForTryOn(rawPieces);
  const department: Gender = rawPieces[0]?.item?.department === 'women' ? 'women' : 'men';
  const lookTag = outfit.number ?? opts?.label ?? '?';

  const [resolvedShopper, pieceBufs] = await Promise.all([
    resolveShopperPhoto<Buffer>({
      personInput: personJpeg,
      checkPhoto: (bytes) => checkShopperPhoto(bytes),
      prepareSnapshot: (bytes) => normalizeShopperJpeg(bytes),
      getTestShopper: async () => normalizeShopperJpeg(await getTestShopper(department)),
    }),
    Promise.all(sortedPieces.map((piece) => loadPieceForTryOn(piece))),
  ]);
  const shopperBuf = resolvedShopper.shopper;

  if (resolvedShopper.shopper_photo === 'none') {
    console.log(
      `[media] shopper-photo look ${lookTag}: no person visible (person_visible=${resolvedShopper.shopper_photo_scores?.person_visible.toFixed(2) ?? '?'}); using test shopper (${department})`,
    );
  }

  const baseParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: 'Image 0: the shopper (the ONLY source for the person)' },
    { inlineData: { mimeType: 'image/jpeg', data: shopperBuf.toString('base64') } },
  ];

  const loadedPiecesList: Piece[] = [];
  const loadedPieceBufs: Buffer[] = [];
  let imageNumber = 1;
  let hasShoes = false;
  let hasBottom = false;

  for (let i = 0; i < sortedPieces.length; i++) {
    const piece = sortedPieces[i];
    const buf = pieceBufs[i];
    if (!buf) continue;
    loadedPiecesList.push(piece);
    loadedPieceBufs.push(buf);
    const slotKey = piece.slot.trim().toLowerCase();
    if (slotKey === 'shoes') {
      hasShoes = true;
    }
    if (slotKey === 'bottom' || slotKey === 'dress' || slotKey === 'suit') {
      hasBottom = true;
    }
    const desc = stripHtml(piece.item.description, 220);
    const label = desc
      ? `Image ${imageNumber}: ${piece.slot}: "${piece.item.title}" (${desc})`
      : `Image ${imageNumber}: ${piece.slot}: "${piece.item.title}"`;
    baseParts.push({ text: label });
    baseParts.push({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } });
    imageNumber += 1;
  }

  if (loadedPiecesList.length === 0) {
    throw new Error('no product images could be loaded for try-on');
  }

  const verifyOff = process.env.ALICE_TRYON_VERIFY === 'off';
  const rawCap = Number(process.env.ALICE_TRYON_CAP_MS);
  const capMs = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 40_000;
  const contactSheetPromise: Promise<Buffer> | null = verifyOff
    ? null
    : buildContactSheet(loadedPieceBufs);

  const generateOnce = async (correction: string | null): Promise<Buffer> => {
    const extraLine = correction ? `Correction from the inspector: ${correction}` : null;
    const parts = [...baseParts, { text: buildTryOnPrompt(hasShoes, hasBottom, extraLine) }];
    const isRedo = correction !== null;
    const remMs = Math.max(5_000, capMs - (Date.now() - t0));
    const generated = await generateImageWithRetry(
      parts,
      'tryon',
      isRedo ? { retries: 0, timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remMs + 1000) } : undefined,
    );
    return generated.mimeType === 'image/jpeg'
      ? generated.data
      : await sharp(generated.data).jpeg({ quality: 90 }).toBuffer();
  };

  const { image: outBuf, check } = await runTryOnVerifyLoop<Buffer>({
    generate: generateOnce,
    gate: async (tryonJpeg) => {
      const contactSheetJpeg = await (contactSheetPromise ?? buildContactSheet(loadedPieceBufs));
      return runTryOnGate({
        shopperJpeg: shopperBuf,
        tryonJpeg,
        contactSheetJpeg,
        pieces: loadedPiecesList,
      });
    },
    inspect: async (tryonJpeg, gateScores) => {
      const contactSheetJpeg = await (contactSheetPromise ?? buildContactSheet(loadedPieceBufs));
      return runTryOnInspector(
        {
          shopperJpeg: shopperBuf,
          tryonJpeg,
          contactSheetJpeg,
          pieces: loadedPiecesList,
        },
        { gateScores },
      );
    },
    onBackgroundInspect: (res, ms) => {
      console.log(
        `[media] bg-inspect look=${lookTag} verdict=${res?.verdict ?? 'err'} ms=${ms}`,
      );
    },
    verifyOff,
    startedAt: t0,
    capMs,
  });

  const fullCheck: TryOnCheck = {
    ...check,
    shopper_photo: resolvedShopper.shopper_photo,
    ...(resolvedShopper.shopper_notes ? { shopper_notes: resolvedShopper.shopper_notes } : {}),
    ...(resolvedShopper.shopper_photo_scores !== undefined
      ? { shopper_photo_scores: resolvedShopper.shopper_photo_scores }
      : {}),
    ...(resolvedShopper.shopper_photo !== 'test'
      ? { ms_shopper_photo: resolvedShopper.ms_shopper_photo }
      : {}),
  };

  const id = newTryonId();
  const name = tryonFileName(id);
  const filePath = path.join(tryonDir(), name);
  await writeFileAtomic(filePath, outBuf);

  const ms = Date.now() - t0;
  console.log(
    `tryon ${id} look ${lookTag} ready in ${ms} ms (shopper=${fullCheck.shopper_photo} path=${fullCheck.path} attempts=${fullCheck.attempts} passed=${fullCheck.passed} gate=${fullCheck.ms_gate}ms inspect=${fullCheck.ms_inspector}ms)`,
  );

  return {
    url: publicUrl(name),
    path: filePath,
    ms,
    id,
    check: fullCheck,
  };
}
