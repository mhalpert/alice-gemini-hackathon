import { readFileSync } from 'node:fs';
import { llm } from '@livekit/agents';
import { z } from 'zod';
import { calllog } from '../calllog.ts';
import type { Brief, Outfit } from '../types.ts';

export const DUPLICATE_WINDOW_MS = 15_000;
export const DEFAULT_SLOW_STUB_DELAY_MS = 2_000;

export const SLOW_TOOL_NOTES: Readonly<Record<string, string>> = {
  build_outfits: 'Working on building three outfits now.',
  show_on_me: 'Working on rendering your try-on now.',
  swap_piece: 'Working on finding a replacement piece now.',
};

export const TOOL_ERROR_FALLBACK =
  'That step could not be completed right now. Carry on smoothly without mentioning any error or technical issue.';

export type ToolLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface WorkingNoteParams {
  callId: string;
  name: string;
  note: string;
}

export interface CameraSnapshot {
  jpeg: Buffer;
  width: number;
  height: number;
  at: number;
}

export interface ToolRuntimeOptions {
  room: string;
  log?: ToolLogFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  slowDelayMs?: number;
  duplicateWindowMs?: number;
  sendWorkingNote?: (params: WorkingNoteParams) => boolean | void;
  getSnapshot?: () => CameraSnapshot | null;
  fixtureUrl?: URL | string;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${stableStringify(val)}`);
  }
  return `{${entries.join(',')}}`;
}

export function formatFixtureSummary(outfits: Outfit[]): string {
  const lines = outfits.map((outfit, idx) => {
    const num = outfit.number ?? idx + 1;
    const pieces = outfit.pieces
      .map((p) => `${p.slot}: ${p.item.title} ($${p.item.price}, ${p.item.store})`)
      .join('; ');
    return `Look ${num} — ${outfit.name} ($${outfit.total.toFixed(2)}): ${pieces}`;
  });
  return `Built ${outfits.length} looks:\n${lines.join('\n')}`;
}

export function loadFixtureSummary(
  fixtureUrl: URL | string = new URL('../../public/fixture.json', import.meta.url),
): string {
  const raw = readFileSync(fixtureUrl, 'utf8');
  const parsed = JSON.parse(raw) as { brief?: Brief; outfits: Outfit[] };
  return formatFixtureSummary(parsed.outfits);
}

interface DuplicateEntry {
  startedAt: number;
  callId: string;
  promise: Promise<string>;
}

export interface ToolWrapperContext {
  wrap<TArgs extends Record<string, unknown>>(
    name: string,
    handler: (args: TArgs, opts: { toolCallId: string }) => Promise<string> | string,
  ): (args: TArgs, opts?: { toolCallId?: string }) => Promise<string>;
}

export function createToolWrapper(options: ToolRuntimeOptions): ToolWrapperContext {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const windowMs = options.duplicateWindowMs ?? DUPLICATE_WINDOW_MS;
  const recentCalls = new Map<string, DuplicateEntry>();

  function pruneExpired(now: number): void {
    for (const [key, entry] of recentCalls.entries()) {
      if (now - entry.startedAt >= windowMs) {
        recentCalls.delete(key);
      }
    }
  }

  return {
    wrap<TArgs extends Record<string, unknown>>(
      name: string,
      handler: (args: TArgs, opts: { toolCallId: string }) => Promise<string> | string,
    ) {
      return (args: TArgs, opts?: { toolCallId?: string }): Promise<string> => {
        const callId = opts?.toolCallId ?? '';
        const startedAt = nowFn();
        pruneExpired(startedAt);

        const dedupKey = `${name}:${stableStringify(args ?? {})}`;
        const existing = recentCalls.get(dedupKey);
        if (existing && startedAt - existing.startedAt < windowMs) {
          logFn(options.room, 'tool_duplicate', {
            name,
            args,
            call_id: callId,
            original_call_id: existing.callId,
          });
          return existing.promise;
        }

        logFn(options.room, 'tool_call', {
          name,
          args,
          call_id: callId,
        });

        const promise = (async (): Promise<string> => {
          try {
            const note = SLOW_TOOL_NOTES[name];
            if (note) {
              const sent = options.sendWorkingNote?.({ callId, name, note }) ?? false;
              logFn(options.room, 'tool_note', {
                name,
                call_id: callId,
                note,
                sent: Boolean(sent),
              });
            }

            const result = await handler(args, { toolCallId: callId });
            const text = typeof result === 'string' ? result : String(result);
            const durationMs = Math.max(0, nowFn() - startedAt);
            logFn(options.room, 'tool_result', {
              name,
              call_id: callId,
              text,
              duration_ms: durationMs,
            });
            return text;
          } catch (err) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            logFn(options.room, 'tool_error', {
              name,
              call_id: callId,
              error: errorObj,
              stack: errorObj.stack,
            });
            return TOOL_ERROR_FALLBACK;
          }
        })();

        recentCalls.set(dedupKey, { startedAt, callId, promise });
        return promise;
      };
    },
  };
}

const outfitNumberSchema = z.number().int().min(1).max(3).describe('Look number: 1, 2, or 3');
const slotSchema = z
  .string()
  .describe('Piece slot name (top, bottom, dress, layer, shoes, accessory, bag, or jewelry)');

/**
 * Returns an object map of anonymous function tools keyed by tool name.
 * IMPORTANT: Do NOT set `name` on any entry; @livekit/agents 1.10 rejects named entries in object maps.
 */
export function createAgentTools(options: ToolRuntimeOptions) {
  const wrapper = createToolWrapper(options);
  const nowFn = options.now ?? (() => Date.now());
  const sleepFn =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const slowDelayMs = options.slowDelayMs ?? DEFAULT_SLOW_STUB_DELAY_MS;
  const waitSlow = async () => {
    if (slowDelayMs > 0) {
      await sleepFn(slowDelayMs);
    }
  };

  return {
    remember: llm.tool({
      description: 'Remember a concise preference, size, name, or detail about the shopper.',
      parameters: z.object({
        fact: z.string().describe('Short fact to remember about the shopper'),
      }),
      execute: wrapper.wrap('remember', async ({ fact }) => `Noted: ${fact}.`),
    }),

    set_department: llm.tool({
      description: "Set the shopper's department (men or women).",
      parameters: z.object({
        department: z.enum(['men', 'women']).describe('Shopper department'),
      }),
      execute: wrapper.wrap('set_department', async ({ department }) => `Department set to ${department}.`),
    }),

    build_outfits: llm.tool({
      description: 'Build three complete outfit looks for the shopper based on occasion and budget.',
      parameters: z.object({
        occasion: z.string().describe('The event or occasion the shopper is dressing for'),
        budget_usd: z.number().describe('Total budget in US dollars'),
        notes: z.string().optional().describe('Optional style, color, or fit notes'),
        own_piece: z.string().optional().describe('Optional piece the shopper already owns'),
      }),
      execute: wrapper.wrap('build_outfits', async () => {
        await waitSlow();
        return loadFixtureSummary(options.fixtureUrl);
      }),
    }),

    pick_outfit: llm.tool({
      description: 'Focus or highlight one of the three looks (1, 2, or 3) on screen.',
      parameters: z.object({
        outfit: outfitNumberSchema,
      }),
      execute: wrapper.wrap('pick_outfit', async ({ outfit }) => `Highlighted look ${outfit} on screen.`),
    }),

    show_on_me: llm.tool({
      description: 'Generate a virtual try-on of the chosen look (1, 2, or 3) on the shopper.',
      parameters: z.object({
        outfit: outfitNumberSchema,
      }),
      execute: wrapper.wrap('show_on_me', async ({ outfit }) => {
        await waitSlow();
        const snap = options.getSnapshot?.() ?? null;
        if (snap) {
          const ageSec = Math.max(0, Math.round((nowFn() - snap.at) / 1000));
          return `Try-on for look ${outfit} is ready and shown on screen (snapshot: yes, ${ageSec} s old).`;
        }
        return `Try-on for look ${outfit} is ready and shown on screen (snapshot: no).`;
      }),
    }),

    swap_piece: llm.tool({
      description: 'Swap a single piece in one of the three looks for something matching the request.',
      parameters: z.object({
        outfit: outfitNumberSchema,
        slot: slotSchema,
        request: z.string().describe('What the shopper wants instead for this piece'),
      }),
      execute: wrapper.wrap('swap_piece', async ({ outfit, slot, request }) => {
        await waitSlow();
        return `Swapped the ${slot} in look ${outfit} to match "${request}".`;
      }),
    }),

    add_to_bag: llm.tool({
      description: 'Add a look to the shopping bag using a map of piece slot to size label.',
      parameters: z.object({
        outfit: outfitNumberSchema,
        sizes: z
          .record(z.string(), z.string())
          .describe('Map of piece slot to size label, e.g. {"top": "M", "shoes": "10"}'),
      }),
      execute: wrapper.wrap('add_to_bag', async ({ outfit, sizes }) => {
        const sizeSummary = Object.entries(sizes)
          .map(([slot, size]) => `${slot}:${size}`)
          .join(', ');
        return `Added look ${outfit} to the bag (${sizeSummary || 'default sizes'}).`;
      }),
    }),

    show_product: llm.tool({
      description: 'Open product details for a single piece in one of the looks.',
      parameters: z.object({
        outfit: outfitNumberSchema,
        slot: slotSchema,
      }),
      execute: wrapper.wrap(
        'show_product',
        async ({ outfit, slot }) => `Showing product details for look ${outfit} ${slot}.`,
      ),
    }),

    hide_product: llm.tool({
      description: 'Close the currently open product detail drawer.',
      execute: wrapper.wrap('hide_product', async () => 'Closed the product view.'),
    }),

    show_all_looks: llm.tool({
      description: 'Return the screen to showing all three looks side by side.',
      execute: wrapper.wrap('show_all_looks', async () => 'Showing all three looks on screen.'),
    }),

    search_products: llm.tool({
      description: 'Search the store catalog for standalone products.',
      parameters: z.object({
        query: z.string().describe('Product search query'),
        max_price: z.number().optional().describe('Optional maximum price in US dollars'),
      }),
      execute: wrapper.wrap('search_products', async ({ query, max_price }) => {
        const cap = max_price !== undefined ? ` under $${max_price}` : '';
        return `Found matching products for "${query}"${cap} and displayed the results.`;
      }),
    }),
  };
}
