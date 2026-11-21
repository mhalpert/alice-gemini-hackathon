// Small Gemini REST client for the stylist brain: one JSON-in, JSON-out call with a timeout.
// Plain fetch keeps the brain free of extra dependencies.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const MODELS = {
  stylist: () => process.env.ALICE_MODEL_STYLIST || 'gemini-4-hydrogen',
  fast: () => process.env.ALICE_MODEL_FAST || 'gemini-3.5-flash-lite',
};

export interface JsonCall {
  model: string;
  system: string;
  user: string;
  schema: object;               // JSON Schema for the reply
  temperature?: number;
  thinkingLevel?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JsonReply<T> { data: T; model: string; ms: number; tokens: { in: number; out: number } }

export class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function apiKey(): string {
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TRYON_API_KEY;
  if (!key) throw new GeminiError('GOOGLE_API_KEY is not set', 0);
  return key;
}

export async function generateJson<T>(call: JsonCall): Promise<JsonReply<T>> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(call.timeoutMs ?? 30000);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: call.schema,
    temperature: call.temperature ?? 0.7,
  };
  if (call.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: call.thinkingLevel };

  const res = await fetch(`${BASE}/models/${call.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: call.system }] },
      contents: [{ role: 'user', parts: [{ text: call.user }] }],
      generationConfig,
    }),
    signal,
  });

  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    throw new GeminiError(`${call.model} ${res.status}: ${body?.error?.message ?? res.statusText}`.slice(0, 300), res.status);
  }
  const text: string = (body?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p.text === 'string' && !p.thought)
    .map((p: any) => p.text)
    .join('');
  if (!text) throw new GeminiError(`${call.model}: empty reply (${body?.candidates?.[0]?.finishReason ?? 'no candidate'})`, 200);

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`${call.model}: reply was not JSON`, 200);
  }
  return {
    data,
    model: call.model,
    ms: Math.round(performance.now() - started),
    tokens: { in: body?.usageMetadata?.promptTokenCount ?? 0, out: (body?.usageMetadata?.candidatesTokenCount ?? 0) + (body?.usageMetadata?.thoughtsTokenCount ?? 0) },
  };
}
