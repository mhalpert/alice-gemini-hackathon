// Gemini text embedding helper for matching shopper occasions against the outfit library.
// Plain fetch matching src/brain/gemini.ts; every call lands in the cost ledger.
import type { Gender } from '../types.ts';
import { recordCost } from '../ledger.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-001';
const OUTPUT_DIM = 768;
const TIMEOUT_MS = 5000;

function apiKey(): string {
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TRYON_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY is not set');
  return key;
}

function normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return vec.slice();
  return vec.map((v) => v / norm);
}

export function occasionText(gender: Gender, occasion: string): string {
  const prefix = gender === 'women' ? "Women's" : "Men's";
  return `${prefix} outfit for: ${occasion.trim()}`;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const started = performance.now();
  const res = await fetch(`${BASE}/models/${MODEL}:batchEmbedContents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey(),
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: OUTPUT_DIM,
      })),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => ({}))) as {
    embeddings?: { values?: number[] }[];
    error?: { message?: string };
    usageMetadata?: { promptTokenCount?: number };
  };

  if (!res.ok) {
    throw new Error(`${MODEL} ${res.status}: ${body?.error?.message ?? res.statusText}`.slice(0, 300));
  }

  const embeddings = body?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(`${MODEL}: unexpected embeddings count (${embeddings?.length ?? 0} vs ${texts.length})`);
  }

  const vectors = embeddings.map((e, idx) => {
    if (!Array.isArray(e?.values) || e.values.length === 0) {
      throw new Error(`${MODEL}: empty embedding at index ${idx}`);
    }
    return normalize(e.values);
  });

  const ms = Math.round(performance.now() - started);
  const approxTokens = Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / 4);
  const inputTokens = body?.usageMetadata?.promptTokenCount ?? approxTokens;
  recordCost({
    model: MODEL,
    job: 'library_embed',
    input_tokens: inputTokens,
    output_tokens: 0,
    ms,
  }).catch(() => {});

  return vectors;
}
