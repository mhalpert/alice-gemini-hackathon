import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import type { Gender, Outfit, Piece } from '../types.ts';
import {
  newTryonId,
  publicUrl,
  sortPiecesForTryOn,
  stripHtml,
  tryonDir,
  tryonFileName,
  withWidth,
} from './pure.ts';
import { fetchImageBuffer, getGenAI, getProductShot, writeFileAtomic } from './shots.ts';

export interface TryOnResult {
  url: string;
  path: string;
  ms: number;
  id: string;
}

const RATE_LIMIT_DELAYS_MS = [1500, 4000];
const NORMAL_RETRY_DELAY_MS = 500;
const testShopperInFlight = new Map<Gender, Promise<Buffer>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

async function generateImageWithRetry(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  job: 'tryon' | 'test-shopper',
): Promise<{ data: Buffer; mimeType: string }> {
  const model = process.env.ALICE_MODEL_TRYON || 'gemini-nano-banana-2.1';
  let normalRetriesLeft = 1;
  let rateLimitAttempt = 0;

  while (true) {
    const attemptStart = Date.now();
    try {
      const response = await getGenAI().models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '3:4' },
        },
      });
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

async function getTestShopper(department: Gender): Promise<Buffer> {
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

async function prepareShopperJpeg(
  personInput: Uint8Array | Buffer | null,
  department: Gender,
): Promise<Buffer> {
  const rawBuf = personInput ? Buffer.from(personInput) : await getTestShopper(department);
  return sharp(rawBuf)
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function loadPieceForTryOn(piece: Piece): Promise<Buffer | null> {
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

function buildTryOnPrompt(hasShoes: boolean): string {
  const lines = [
    'Generate a single photorealistic full-body studio try-on photograph of the shopper from Image 0 dressed in ONLY the listed items.',
    'The product images are cut-outs of single items (some may still show part of a model). Use each product image ONLY for the specific item named in its label.',
    'Ignore any model in the product images completely (face, hair, beard, skin tone, tattoos, body, pose). Every visible part of the person MUST come from Image 0.',
    "Keep the shopper's face, hair, skin tone, and build from Image 0 exactly; do not slim or change proportions.",
    'The label text wins over the product photo for sleeve length, fit, and length.',
    'Whole body head to toe, shoes fully in frame, standing facing the camera, on a clean white studio set with soft light, portrait 3:4.',
    'Dress the person in ONLY the listed items. Do not invent or add unlisted garments or accessories.',
  ];
  if (!hasShoes) {
    lines.push('Wear plain white minimalist sneakers.');
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

  const [shopperBuf, pieceBufs] = await Promise.all([
    prepareShopperJpeg(personJpeg, department),
    Promise.all(sortedPieces.map((piece) => loadPieceForTryOn(piece))),
  ]);

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: 'Image 0: the shopper (the ONLY source for the person)' },
    { inlineData: { mimeType: 'image/jpeg', data: shopperBuf.toString('base64') } },
  ];

  let imageNumber = 1;
  let loadedPieces = 0;
  let hasShoes = false;

  for (let i = 0; i < sortedPieces.length; i++) {
    const piece = sortedPieces[i];
    const buf = pieceBufs[i];
    if (!buf) continue;
    loadedPieces += 1;
    if (piece.slot.trim().toLowerCase() === 'shoes') {
      hasShoes = true;
    }
    const desc = stripHtml(piece.item.description, 220);
    const label = desc
      ? `Image ${imageNumber}: ${piece.slot}: "${piece.item.title}" (${desc})`
      : `Image ${imageNumber}: ${piece.slot}: "${piece.item.title}"`;
    parts.push({ text: label });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } });
    imageNumber += 1;
  }

  if (loadedPieces === 0) {
    throw new Error('no product images could be loaded for try-on');
  }

  parts.push({ text: buildTryOnPrompt(hasShoes) });

  const generated = await generateImageWithRetry(parts, 'tryon');
  const outBuf =
    generated.mimeType === 'image/jpeg'
      ? generated.data
      : await sharp(generated.data).jpeg({ quality: 90 }).toBuffer();

  const id = newTryonId();
  const name = tryonFileName(id);
  const filePath = path.join(tryonDir(), name);
  await writeFileAtomic(filePath, outBuf);

  const ms = Date.now() - t0;
  console.log(`tryon ${id} look ${outfit.number ?? opts?.label ?? '?'} ready in ${ms} ms`);

  return {
    url: publicUrl(name),
    path: filePath,
    ms,
    id,
  };
}
