// Background stylist critic powered by Gemini 4 Argon.
// Judges a complete outfit from its product photos and titles against strict dress-code rules,
// scores it 1-10, and names the single weakest piece to swap. Never throws.
import type { Brief, Outfit } from '../types.ts';
import { recordCost } from '../ledger.ts';
import { calllog } from '../calllog.ts';
import { thumb } from './gate.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface Critique {
  score: number;            // 1-10 overall; 7 = good and usable, a stylist would present it
  presentable: boolean;     // would a professional stylist present this to the client
  occasion_fit: number;     // 1-10
  cohesion: number;         // 1-10
  completeness: number;     // 1-10 (top+bottom or dress, shoes, at least one visible accessory, a layer if the occasion needs one)
  issues: string[];         // short, specific: "black belt with brown shoes", "sandals at a bank interview"
  weak_piece: { slot: string; reason: string; ask: string } | null; // ask = a swap request in plain words, e.g. "brown leather belt"
  model: string;
  ms: number;
  error?: string;
}

export interface CritiqueOptions {
  timeoutMs?: number;
  room?: string;
}

let customFetch: typeof fetch | null = null;

export function _setFetch(fn: typeof fetch | null): void {
  customFetch = fn;
}

const SYSTEM_PROMPT = `You are a strict senior stylist reviewing a junior stylist's outfit before it is shown to a client.
Inspect EVERY product photo alongside its assigned slot and product title. Judge from both the photos AND the titles.

HARD DRESS-CODE RULES (breaking any of these makes the look not presentable):
- Match the exact dressiness the occasion calls for.
- Wedding guests: women never wear white, ivory, cream or anything bridal; men never wear a white or ivory suit or jacket, but a white dress shirt under a suit is classic and correct.
- Job interviews: closed-toe shoes only (no sandals, slides, mules, or open toes); nothing sheer, cropped, backless, or flashy.
- Black tie: a dark suit with its matching trousers and a solid tie (or an appropriately formal evening gown/outfit).
- Season-appropriate fabrics and layers for the occasion and forecast (no heavy wool/velvet in heat, no flimsy summer-only pieces in cold).
- Belt and shoes must be in the same colour family; never clash leather colours.
- Nothing that reads as lingerie (lace bralettes, sheer bodysuits, nightwear-like slip dresses).
- At least one accessory that is clearly visible in a full-body photo (belt, tie, watch, bag, jewelry, sunglasses, hat — never invisible basics like socks).

ADDITIONAL PENALTIES:
- Clashing colours, prints, or leathers.
- Pieces from mismatched formality levels (e.g. athletic wear mixed with formal tailoring).
- Photos that do not match the title OR do not match the assigned slot (e.g. a shirt photo in the shoes slot, or a broken/wrong product photo). Call this out explicitly in issues and penalise heavily.
- Incomplete outfits: an outfit needs top + bottom (or a dress/jumpsuit), shoes, at least one visible accessory, and a layer when the occasion or weather needs one.

SCORING RUBRIC (1-10 integers; be strict and consistent):
- 9-10: Editorial, cohesive, zero flaws.
- 7-8: Good and usable; a professional stylist would present it to the client.
- 5-6: Passable, but a stylist would fix at least one piece first.
- 3-4: Wrong for the occasion or noticeably mismatched.
- 1-2: Broken, missing core pieces, wrong slot/photo, or severe dress-code violation.

FIELDS:
- presentable: true ONLY if score >= 7 AND there is NO dress-code break.
- issues: short, specific, concrete problems (e.g. "black belt with brown shoes", "sandals at a bank interview", "shoes slot shows a shirt instead of footwear"). Empty array only if there are no real issues.
- weak_piece: the single piece whose replacement would raise the score most, using its exact slot name from the outfit, a brief reason, and an ask written as a plain-word swap request (e.g. "brown leather belt"). Set weak_piece to null when score >= 8.`;

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    presentable: { type: 'boolean' },
    occasion_fit: { type: 'integer' },
    cohesion: { type: 'integer' },
    completeness: { type: 'integer' },
    issues: { type: 'array', items: { type: 'string' } },
    weak_piece: {
      type: ['object', 'null'],
      properties: {
        slot: { type: 'string' },
        reason: { type: 'string' },
        ask: { type: 'string' },
      },
      required: ['slot', 'reason', 'ask'],
    },
  },
  required: ['score', 'presentable', 'occasion_fit', 'cohesion', 'completeness', 'issues', 'weak_piece'],
};

function clampScore(value: unknown, label: string, model: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${model}: invalid ${label}`);
  return Math.min(10, Math.max(1, Math.round(n)));
}

function logCritique(room: string | undefined, outfit: Outfit, critique: Critique): void {
  if (!room) return;
  try {
    calllog(room, 'critic', {
      number: outfit.number,
      name: outfit.name,
      score: critique.score,
      presentable: critique.presentable,
      issues: critique.issues,
      weak_piece: critique.weak_piece,
      ms: critique.ms,
      error: critique.error,
    });
  } catch {
    // Logging must never throw or break critiqueOutfit.
  }
}

export async function critiqueOutfit(outfit: Outfit, brief: Brief, opts: CritiqueOptions = {}): Promise<Critique> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const model = process.env.ALICE_MODEL_CRITIC || 'gemini-4-argon';
  const timeoutMs = opts.timeoutMs ?? 20000;

  try {
    const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TRYON_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY is not set');

    const signal = AbortSignal.timeout(timeoutMs);
    const images = await Promise.all(
      outfit.pieces.map((piece) => (piece.item?.image ? thumb(piece.item.image) : Promise.resolve(null))),
    );

    if (signal.aborted) {
      throw signal.reason ?? new Error('critic timed out');
    }

    const dept = brief.gender === 'women' ? "women's" : "men's";
    const briefLines = [
      `Department: ${dept}`,
      `Occasion: ${brief.occasion}`,
      `Budget: $${brief.budget_usd}`,
    ];
    if (brief.weather) briefLines.push(`Weather: ${brief.weather}`);
    if (brief.notes) briefLines.push(`Notes: ${brief.notes}`);
    if (brief.own_piece) briefLines.push(`Client's own piece: ${brief.own_piece}`);

    const parts: Record<string, unknown>[] = [{ text: briefLines.join('\n') }];
    outfit.pieces.forEach((piece, index) => {
      parts.push({ text: `${piece.slot}: ${piece.item.title} ($${piece.item.price}, ${piece.item.store})` });
      const data = images[index];
      if (data) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
      }
    });
    parts.push({ text: `Total: $${outfit.total}` });

    const fetchFn = customFetch ?? globalThis.fetch;
    const res = await fetchFn(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: SCHEMA,
          thinkingConfig: { thinkingLevel: 'low' },
          temperature: 0.2,
        },
      }),
      signal,
    });

    const body = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
      throw new Error(`${model} ${res.status}: ${body?.error?.message ?? res.statusText}`.slice(0, 300));
    }

    const text: string = (body?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => typeof p?.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('');
    if (!text) {
      throw new Error(`${model}: empty reply (${body?.candidates?.[0]?.finishReason ?? 'no candidate'})`);
    }

    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`${model}: reply was not JSON`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${model}: reply was not a JSON object`);
    }

    const score = clampScore(raw.score, 'score', model);
    const occasion_fit = clampScore(raw.occasion_fit, 'occasion_fit', model);
    const cohesion = clampScore(raw.cohesion, 'cohesion', model);
    const completeness = clampScore(raw.completeness, 'completeness', model);
    const presentable = score >= 7 && Boolean(raw.presentable);
    const issues = Array.isArray(raw.issues)
      ? raw.issues.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0).map((item: string) => item.trim())
      : [];

    const outfitSlots = new Set(outfit.pieces.map((p) => p.slot));
    let weak_piece: Critique['weak_piece'] = null;
    if (raw.weak_piece && typeof raw.weak_piece === 'object' && !Array.isArray(raw.weak_piece)) {
      const slot = typeof raw.weak_piece.slot === 'string' ? raw.weak_piece.slot.trim() : '';
      const reason = typeof raw.weak_piece.reason === 'string' ? raw.weak_piece.reason.trim() : '';
      const ask = typeof raw.weak_piece.ask === 'string' ? raw.weak_piece.ask.trim() : '';
      if (slot && outfitSlots.has(slot)) {
        weak_piece = { slot, reason, ask };
      }
    }

    const ms = elapsed();
    const input_tokens = Number(body?.usageMetadata?.promptTokenCount ?? 0);
    const output_tokens = Number(body?.usageMetadata?.candidatesTokenCount ?? 0) + Number(body?.usageMetadata?.thoughtsTokenCount ?? 0);
    recordCost({ model, job: 'brain_critic', input_tokens, output_tokens, ms }).catch(() => {});

    const critique: Critique = {
      score,
      presentable,
      occasion_fit,
      cohesion,
      completeness,
      issues,
      weak_piece,
      model,
      ms,
    };
    logCritique(opts.room, outfit, critique);
    return critique;
  } catch (err) {
    const ms = elapsed();
    const critique: Critique = {
      score: 0,
      presentable: false,
      occasion_fit: 0,
      cohesion: 0,
      completeness: 0,
      issues: [],
      weak_piece: null,
      model,
      ms,
      error: String((err as Error)?.message ?? err),
    };
    logCritique(opts.room, outfit, critique);
    return critique;
  }
}

export async function critiqueAll(outfits: Outfit[], brief: Brief, opts: CritiqueOptions = {}): Promise<Critique[]> {
  return Promise.all(outfits.map((outfit) => critiqueOutfit(outfit, brief, opts)));
}
