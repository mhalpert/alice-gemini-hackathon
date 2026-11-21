// Live swap check: real stores, the fixture's looks, the swaps a shopper actually asks for.
// Run: node --env-file-if-exists=.env.local eval/swap-check.ts
import { readFileSync } from 'node:fs';
import { swapLive } from '../src/brain/swap.ts';
import type { Brief, Outfit } from '../src/types.ts';

const fx = JSON.parse(readFileSync(new URL('../public/fixture.json', import.meta.url), 'utf8')) as { brief: Brief; outfits: Outfit[] };
const cases: [number, string, string][] = [
  [0, 'shoes', 'swap the shoes for brown boots'],
  [0, 'shoes', 'something cheaper'],
  [1, 'top', 'same shirt in white'],
  [1, 'shoes', 'different shoes'],
  [2, 'bottom', 'black jeans instead'],
  [2, 'shoes', 'purple loafers'],
];
for (const [i, slot, request] of cases) {
  const look = fx.outfits[i];
  const before = look.pieces.find((p) => p.slot === slot)?.item;
  const t = performance.now();
  const out = await swapLive(look, slot, request, fx.brief);
  const ms = Math.round(performance.now() - t);
  console.log(`\n"${request}" (${slot}) ${ms} ms  query: ${out.query}`);
  console.log(`  was: ${before?.title} $${before?.price}`);
  console.log(`  now: ${out.piece.item.title} $${out.piece.item.price} ${out.piece.item.store}`);
  console.log(`  total $${look.total} -> $${out.outfit.total}  name: ${out.outfit.name}${out.note ? `  note: ${out.note}` : ''}`);
  console.log(`  why: ${out.piece.why}`);
}
