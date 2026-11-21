// Step 5 of the stylist brain: the Decisions API (gemini-decision-1) looks at a strip of the
// outfit's product photos and answers two questions: does it fit the occasion (probability)
// and how cohesive is it (0-4). It ranks well but rarely rejects, so it orders looks more than
// it filters them. It never throws: on any failure the look passes with a note.
import type { Brief, Outfit } from '../types.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const PASS_FITS = 0.5;
export const PASS_COHESION = 2;

export interface GateResult { fits: number; cohesion: number; pass: boolean; score: number; ms: number; error?: string }

// Shopify CDN resize: add width with ? or & depending on whether the URL already has a query.
export function sized(url: string, width: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}width=${width}`;
}

const thumbCache = new Map<string, Promise<string | null>>();

function thumb(url: string): Promise<string | null> {
  if (!thumbCache.has(url)) {
    thumbCache.set(url, fetch(sized(url, 256), { signal: AbortSignal.timeout(3000) })
      .then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()).toString('base64') : null))
      .catch(() => null));
  }
  return thumbCache.get(url)!;
}

// Warm the thumbnail cache for candidates while the stylist is still picking.
export function prefetchThumbs(urls: string[]): void {
  for (const u of urls) if (u) void thumb(u);
}

export async function gateOutfit(outfit: Outfit, brief: Brief): Promise<GateResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TRYON_API_KEY;
    if (!key) throw new Error('no key');
    const images = await Promise.all(outfit.pieces.map((p) => thumb(p.item.image)));
    const input: object[] = [{
      type: 'text',
      text: `A stylist's outfit for a ${brief.gender === 'women' ? "women's" : "men's"} client. Occasion: ${brief.occasion}. Budget $${brief.budget_usd}.` +
        (brief.weather ? ` Forecast: ${brief.weather}.` : '') + ` The pieces, one photo each:`,
    }];
    outfit.pieces.forEach((p, i) => {
      input.push({ type: 'text', text: `${p.slot}: ${p.item.title} ($${p.item.price})` });
      if (images[i]) input.push({ type: 'image', data: images[i], mime_type: 'image/jpeg' });
    });
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      signal: AbortSignal.timeout(Number(process.env.ALICE_GATE_TIMEOUT_MS ?? 6000)),
      body: JSON.stringify({
        model: process.env.ALICE_MODEL_GATE || 'gemini-decision-1',
        input,
        questions: {
          fits: {
            type: 'noul',
            instructions: 'Would a professional stylist send this client to this occasion in this outfit? Consider the dress code, dressiness, season and whether anything looks out of place.',
          },
          cohesion: {
            type: 'score',
            instructions: 'How well do these pieces work together as one outfit (colours, materials, formality, proportions)?',
            criteria: ['0: pieces clash or belong to different occasions', '1: weak, several pieces fight', '2: works, nothing wrong', '3: good, clearly put together', '4: excellent, stylist-grade'],
          },
        },
      }),
    });
    const body = await res.json().catch(() => ({})) as any;
    if (!res.ok) throw new Error(`${res.status}: ${body?.error?.message ?? 'decisions failed'}`.slice(0, 200));
    const fits = Number(body?.answers?.fits?.noul ?? 0.5);
    const cohesion = Number(body?.answers?.cohesion?.score ?? 2);
    return { fits, cohesion, pass: fits >= PASS_FITS && cohesion >= PASS_COHESION, score: fits * (cohesion / 4), ms: ms() };
  } catch (err) {
    return { fits: 0.5, cohesion: 2, pass: true, score: 0.25, ms: ms(), error: String((err as Error)?.message ?? err) };
  }
}
