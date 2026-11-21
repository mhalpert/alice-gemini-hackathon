// One-call baseline for the Outfits eval: one Flash Lite call with a plain prompt,
// then one store search per piece taking the first in-stock item in the right department.
// Deliberately simple: no dress-code rules, no planner, no piece ceiling, no picker, no gate.
import type { Brief, Gender, Item, Outfit, Piece, SearchResult } from '../src/types.ts';
import { generateJson as defaultGenerateJson, MODELS, type JsonCall, type JsonReply } from '../src/brain/gemini.ts';
import { search as defaultSearch } from '../src/store/index.ts';
import { estimateCostUsd } from '../src/ledger.ts';

export interface BaselinePieceSpec {
  slot: string;
  query: string;
}

export interface BaselineOutfitSpec {
  name: string;
  pieces: BaselinePieceSpec[];
}

export interface BaselineReply {
  outfits: BaselineOutfitSpec[];
}

export interface BaselineResult {
  outfits: Outfit[];
  ms: number;
  first_ms: number;
  usd: number;
}

export interface BaselineDeps {
  generateJson?: <T>(call: JsonCall) => Promise<JsonReply<T>>;
  search?: (query: string, gender: Gender, opts?: { limit?: number }) => Promise<SearchResult>;
  model?: string;
}

const BASELINE_SCHEMA = {
  type: 'object',
  properties: {
    outfits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          pieces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slot: { type: 'string' },
                query: { type: 'string' },
              },
              required: ['slot', 'query'],
            },
          },
        },
        required: ['name', 'pieces'],
      },
    },
  },
  required: ['outfits'],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function pickFirstMatching(items: Item[], gender: Gender): Item | null {
  return items.find((item) => item.department === gender && item.price > 0) ?? null;
}

function baselineCostUsd(model: string, tokens: { in: number; out: number }): number {
  const fromLedger = estimateCostUsd({
    model,
    input_tokens: tokens.in,
    output_tokens: tokens.out,
  });
  if (fromLedger > 0) return fromLedger;
  return (tokens.in * 0.3 + tokens.out * 2.5) / 1_000_000;
}

export async function baselineBuild(brief: Brief, deps: BaselineDeps = {}): Promise<BaselineResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const gen = deps.generateJson ?? defaultGenerateJson;
  const searchFn = deps.search ?? defaultSearch;
  const model = deps.model ?? MODELS.fast();
  const dept = brief.gender === 'women' ? "women's" : "men's";

  const prompt =
    `You are a stylist. For a ${dept} client going to ${brief.occasion} with a $${brief.budget_usd} budget, ` +
    `give 3 complete outfits; for each, a name and one store search query per piece ` +
    `(top, bottom or dress, shoes, one accessory).`;

  const reply = await gen<BaselineReply>({
    model,
    system: 'You are a stylist.',
    user: prompt,
    schema: BASELINE_SCHEMA,
    temperature: 0.7,
    job: 'eval_baseline',
  });

  const usd = baselineCostUsd(reply.model || model, reply.tokens ?? { in: 0, out: 0 });
  const specs = Array.isArray(reply.data?.outfits) ? reply.data.outfits.slice(0, 3) : [];

  let firstMs = 0;

  const built = await Promise.all(
    specs.map(async (spec, idx): Promise<Outfit> => {
      const rawPieces = Array.isArray(spec?.pieces) ? spec.pieces : [];
      const found = await Promise.all(
        rawPieces.map(async (pieceSpec): Promise<Piece | null> => {
          const query = typeof pieceSpec?.query === 'string' ? pieceSpec.query.trim() : '';
          const slot = typeof pieceSpec?.slot === 'string' ? pieceSpec.slot.trim().toLowerCase() : '';
          if (!query || !slot) return null;
          try {
            const res = await searchFn(query, brief.gender, { limit: 5 });
            const item = pickFirstMatching(res.items ?? [], brief.gender);
            if (!item) return null;
            return { slot, why: '', item };
          } catch {
            return null;
          }
        }),
      );

      const pieces = found.filter((p): p is Piece => p !== null);
      const total = round2(pieces.reduce((sum, p) => sum + p.item.price, 0));
      const outfit: Outfit = {
        number: idx + 1,
        name: typeof spec?.name === 'string' && spec.name.trim() ? spec.name.trim() : `Look ${idx + 1}`,
        difference: '',
        story: '',
        pieces,
        total,
      };
      if (firstMs === 0) firstMs = elapsed();
      return outfit;
    }),
  );

  const ms = elapsed();
  return {
    outfits: built,
    ms,
    first_ms: built.length > 0 ? firstMs || ms : 0,
    usd,
  };
}
