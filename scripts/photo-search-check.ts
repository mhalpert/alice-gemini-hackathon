import fs from 'node:fs';
import path from 'node:path';
import type { Gender, Item } from '../src/types.ts';
import { search, searchByPhoto, searchLike } from '../src/store/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MAX_BYTES = 2_500_000;

function printResults(label: string, ms: number, source: string, items: Item[]) {
  console.log(`\n=== ${label} (${source}, ${items.length} items, ${ms}ms) ===`);
  if (items.length === 0) {
    console.log('  (no results)');
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${it.title} | ${it.store} | $${it.price.toFixed(2)}`);
  }
}

const menFile = path.join(REPO_ROOT, 'data', 'tryon', 'test-shopper-men.jpg');
const womenFile = path.join(REPO_ROOT, 'data', 'tryon', 'test-shopper-women.jpg');

const targets: Array<{ gender: Gender; file: string; casualQuery: string }> = [
  { gender: 'men', file: menFile, casualQuery: "men's casual" },
  { gender: 'women', file: womenFile, casualQuery: "women's casual" },
];

const missing = targets.filter((t) => !fs.existsSync(t.file));
if (missing.length > 0) {
  for (const m of missing) {
    console.log(`Missing test shopper image: ${path.relative(REPO_ROOT, m.file)}`);
  }
  console.log('Generate them with: npm run warm');
  process.exit(1);
}

for (const t of targets) {
  const buf = fs.readFileSync(t.file);
  const rel = path.relative(REPO_ROOT, t.file);
  if (buf.byteLength > MAX_BYTES) {
    console.log(`Skipping ${rel}: ${buf.byteLength} bytes exceeds 2.5 MB limit (resize not available here).`);
    continue;
  }
  console.log(`\nLoaded ${rel} (${(buf.byteLength / 1024).toFixed(0)} KB)`);

  const r1 = await searchByPhoto(buf, t.gender, { limit: 12 });
  printResults(`photo-only (${t.gender})`, r1.ms, r1.source, r1.items);

  const r2 = await searchByPhoto(buf, t.gender, { query: t.casualQuery, limit: 12 });
  printResults(`photo + query "${t.casualQuery}" (${t.gender})`, r2.ms, r2.source, r2.items);
}

// One searchLike call using a loafer product id from a text search
const loaferText = await search("men's leather loafers", 'men', { limit: 5 });
const seed = loaferText.items[0];
if (seed) {
  console.log(`\nSeed loafer for searchLike: "${seed.title}" (${seed.store}, $${seed.price.toFixed(2)}, id=${seed.id})`);
  const likeRes = await searchLike([seed.id], 'men', { limit: 12 });
  printResults(`searchLike([${seed.id}], men)`, likeRes.ms, likeRes.source, likeRes.items);
} else {
  console.log('\nCould not find a seed loafer from text search.');
}
