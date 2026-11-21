import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import type { Outfit } from '../types.ts';
import { runSceneSafetyGate } from './inspect.ts';
import {
  GATE_PASS_THRESHOLD,
  newTryonId,
  publicUrl,
  sceneFileName,
  tryonDir,
  videoFileName,
  type TryOnExtraRender,
} from './pure.ts';
import { getGenAI, writeFileAtomic } from './shots.ts';

const DEFAULT_SCENE_CAP_MS = 45_000;
const DEFAULT_VIDEO_CAP_MS = 120_000;
const VIDEO_POLL_INTERVAL_MS = 2000;
const DEFAULT_VIDEO_MODEL = 'gemini-omni-1.2-flash';

let betaAiClient: GoogleGenAI | null = null;

function getBetaGenAI(): GoogleGenAI {
  if (!betaAiClient) {
    betaAiClient = new GoogleGenAI({
      apiKey: process.env.GOOGLE_TRYON_API_KEY || process.env.GOOGLE_API_KEY,
      apiVersion: 'v1beta',
    });
  }
  return betaAiClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function positiveEnvMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function renderTryOnScene(
  studio: { path: string },
  outfit: Outfit,
  opts: { setting: string; label?: string },
): Promise<TryOnExtraRender | null> {
  const t0 = Date.now();
  const capMs = positiveEnvMs('ALICE_TRYON_SCENE_CAP_MS', DEFAULT_SCENE_CAP_MS);
  const lookTag = outfit?.number ?? opts?.label ?? '?';

  try {
    if (!studio?.path) return null;
    const rawStudio = await fs.promises.readFile(studio.path);
    const studioBuf = await sharp(rawStudio)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const model = process.env.ALICE_MODEL_TRYON || 'gemini-nano-banana-2.1';
    const setting = (opts?.setting || 'a stylish evening setting').trim();
    const prompt = [
      `Place this exact person, wearing exactly this outfit, in this setting: ${setting}.`,
      'Keep the face, hair, skin tone, build and every garment identical: same colours, same pieces, nothing added or removed.',
      'Full body in frame, natural relaxed pose, photorealistic editorial photo, portrait 3:4.',
    ].join(' ');

    const genStart = Date.now();
    const remMs = Math.max(5_000, capMs - (Date.now() - t0) - 2500);
    const response = await withTimeout(
      getGenAI().models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: studioBuf.toString('base64') } },
              { text: prompt },
            ],
          },
        ],
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '3:4' },
        },
      }),
      remMs,
      'tryon-scene',
    );
    const genMs = Date.now() - genStart;

    const part = response.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data.length > 0,
    );
    if (!part?.inlineData?.data) {
      throw new Error('scene model returned no image');
    }

    void recordCost({
      model,
      job: 'tryon-scene',
      images: 1,
      ms: genMs,
    });

    const rawScene = Buffer.from(part.inlineData.data, 'base64');
    const sceneBuf =
      part.inlineData.mimeType === 'image/jpeg'
        ? rawScene
        : await sharp(rawScene).jpeg({ quality: 90 }).toBuffer();

    // Safety check against studio still using Decisions gate (same_person, all_pieces)
    const gateBudget = Math.min(2000, Math.max(0, capMs - (Date.now() - t0)));
    if (gateBudget >= 500) {
      const gate = await runSceneSafetyGate(studioBuf, sceneBuf, outfit?.pieces ?? [], {
        timeoutMs: gateBudget,
      });
      if (gate && gate.same_person < GATE_PASS_THRESHOLD) {
        console.log(
          `[media] scene look ${lookTag} rejected by gate (same_person=${gate.same_person.toFixed(2)} all_pieces=${gate.all_pieces.toFixed(2)})`,
        );
        return null;
      }
    }

    const id = newTryonId();
    const name = sceneFileName(id);
    const filePath = path.join(tryonDir(), name);
    await writeFileAtomic(filePath, sceneBuf);

    const ms = Date.now() - t0;
    console.log(`tryon-scene ${id} look ${lookTag} ready in ${ms} ms`);
    return {
      url: publicUrl(name),
      path: filePath,
      ms,
      id,
    };
  } catch (err) {
    console.error(`[media] scene look ${lookTag} failed:`, (err as Error)?.message ?? err);
    return null;
  }
}

interface VideoOutputBlock {
  type?: string;
  mime_type?: string;
  data?: string;
  uri?: string;
}

export async function renderTryOnVideo(
  still: { path: string },
  outfit: Outfit,
  opts: { setting: string; label?: string; seconds?: number },
): Promise<TryOnExtraRender | null> {
  const t0 = Date.now();
  const capMs = positiveEnvMs('ALICE_TRYON_VIDEO_CAP_MS', DEFAULT_VIDEO_CAP_MS);
  const deadline = t0 + capMs;
  const lookTag = outfit?.number ?? opts?.label ?? '?';

  try {
    if (!still?.path) return null;
    const rawStill = await fs.promises.readFile(still.path);
    const stillBuf = await sharp(rawStill)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const model = process.env.ALICE_MODEL_VIDEO || DEFAULT_VIDEO_MODEL;
    const setting = (opts?.setting || 'a stylish evening setting').trim();
    const seconds = Math.max(3, Math.min(15, Math.round(opts?.seconds ?? 5)));
    const prompt = [
      `Create a ${seconds} second portrait video of this exact person wearing this exact outfit in ${setting}.`,
      'Keep the face, hair, skin tone, build, and every garment identical with nothing added or removed.',
      'A slow natural turn and a few relaxed steps, camera steady, full body in frame, photorealistic editorial video with subtle natural ambient audio.',
    ].join(' ');

    const aiBeta = getBetaGenAI();
    const createTimeout = Math.min(15_000, Math.max(3_000, deadline - Date.now()));
    let inter = await withTimeout(
      aiBeta.interactions.create({
        model,
        background: true,
        input: [
          { type: 'image', data: stillBuf.toString('base64'), mime_type: 'image/jpeg' },
          { type: 'text', text: prompt },
        ],
        response_modalities: ['video'],
        generation_config: {
          video_config: { task: 'image_to_video' },
        },
      }),
      createTimeout,
      'tryon-video create',
    );

    while (inter.status === 'in_progress' || inter.status === 'queued') {
      const rem = deadline - Date.now();
      if (rem <= 1000) {
        void aiBeta.interactions.cancel(inter.id).catch(() => {});
        throw new Error(`tryon-video timed out after ${capMs}ms`);
      }
      await sleep(Math.min(VIDEO_POLL_INTERVAL_MS, rem - 500));
      const pollRem = Math.min(10_000, Math.max(1000, deadline - Date.now()));
      inter = await withTimeout(aiBeta.interactions.get(inter.id), pollRem, 'tryon-video poll');
    }

    if (inter.status !== 'completed') {
      const errDetail = inter.errors?.map((e) => e.message).join('; ') || inter.status;
      throw new Error(`tryon-video interaction status=${inter.status}: ${errDetail}`);
    }

    const stepOutputs = Array.isArray(inter.steps)
      ? inter.steps.flatMap((s) =>
          Array.isArray((s as { outputs?: unknown[] }).outputs)
            ? ((s as { outputs: VideoOutputBlock[] }).outputs)
            : [],
        )
      : [];
    const videoBlock: VideoOutputBlock | undefined =
      (inter.output_video as VideoOutputBlock | undefined) ??
      stepOutputs.find((o) => o?.type === 'video' && (o.data || o.uri));

    if (!videoBlock || (!videoBlock.data && !videoBlock.uri)) {
      throw new Error('tryon-video completed without video output');
    }

    let mp4Buf: Buffer;
    if (videoBlock.data) {
      mp4Buf = Buffer.from(videoBlock.data, 'base64');
    } else {
      const key = process.env.GOOGLE_TRYON_API_KEY || process.env.GOOGLE_API_KEY || '';
      const dlTimeout = Math.min(20_000, Math.max(3_000, deadline - Date.now()));
      const res = await fetch(videoBlock.uri!, {
        headers: key ? { 'x-goog-api-key': key } : undefined,
        signal: AbortSignal.timeout(dlTimeout),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} downloading video URI`);
      }
      mp4Buf = Buffer.from(await res.arrayBuffer());
    }

    if (mp4Buf.length === 0) {
      throw new Error('tryon-video produced empty buffer');
    }

    const ms = Date.now() - t0;
    void recordCost({
      model,
      job: 'tryon-video',
      images: 1,
      input_tokens: inter.usage?.total_input_tokens,
      output_tokens: inter.usage?.total_output_tokens,
      ms,
    });

    const id = newTryonId();
    const name = videoFileName(id);
    const filePath = path.join(tryonDir(), name);
    await writeFileAtomic(filePath, mp4Buf);

    console.log(`tryon-video ${id} look ${lookTag} ready in ${ms} ms (${mp4Buf.length} bytes)`);
    return {
      url: publicUrl(name),
      path: filePath,
      ms,
      id,
    };
  } catch (err) {
    console.error(`[media] video look ${lookTag} failed:`, (err as Error)?.message ?? err);
    return null;
  }
}
