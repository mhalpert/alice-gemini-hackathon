import fs from 'node:fs';
import path from 'node:path';
import type { Gender, Item, Outfit } from '../src/types.ts';
import { searchMixed } from '../src/store/index.ts';
import { savedStore } from '../src/store/saved.ts';
import { tryOn } from '../src/tryon.ts';
import { stopMedia } from '../src/media/client.ts';

if (!process.env.GOOGLE_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may not exist
  }
}

const QUERIES: Array<{ query: string; gender: Gender }> = [
  // Men's tops & shirts (rooftop birthday, brunch, interview, wedding, beach, business casual)
  { query: "men's linen shirt", gender: 'men' },
  { query: "men's white dress shirt", gender: 'men' },
  { query: "men's oxford button down shirt", gender: 'men' },
  { query: "men's knit polo shirt", gender: 'men' },
  { query: "men's black turtleneck", gender: 'men' },
  { query: "men's crewneck sweater", gender: 'men' },
  { query: "men's cashmere sweater", gender: 'men' },
  { query: "men's graphic t-shirt", gender: 'men' },
  { query: "men's camp collar shirt", gender: 'men' },
  { query: "men's flannel shirt", gender: 'men' },

  // Men's layers & outerwear (wedding, gala, cocktail bar, interview, tailgate, festival)
  { query: "men's navy blazer", gender: 'men' },
  { query: "men's black suit jacket", gender: 'men' },
  { query: "men's leather jacket", gender: 'men' },
  { query: "men's denim jacket", gender: 'men' },
  { query: "men's bomber jacket", gender: 'men' },
  { query: "men's wool overcoat", gender: 'men' },
  { query: "men's cardigan", gender: 'men' },
  { query: "men's hoodie", gender: 'men' },

  // Men's bottoms
  { query: "men's chino pants", gender: 'men' },
  { query: "men's dress trousers", gender: 'men' },
  { query: "men's slim jeans", gender: 'men' },
  { query: "men's linen trousers", gender: 'men' },
  { query: "men's tailored shorts", gender: 'men' },
  { query: "men's cargo pants", gender: 'men' },

  // Men's shoes & accessories
  { query: "men's leather loafers", gender: 'men' },
  { query: "men's dress oxford shoes", gender: 'men' },
  { query: "men's white leather sneakers", gender: 'men' },
  { query: "men's chelsea boots", gender: 'men' },
  { query: "men's leather belt", gender: 'men' },
  { query: "men's sunglasses", gender: 'men' },

  // Women's dresses (wedding, cocktail, gala, brunch, rooftop, club, beach, festival)
  { query: "women's midi dress", gender: 'women' },
  { query: "women's satin slip dress", gender: 'women' },
  { query: "women's black cocktail dress", gender: 'women' },
  { query: "women's floral maxi dress", gender: 'women' },
  { query: "women's evening gown", gender: 'women' },
  { query: "women's mini party dress", gender: 'women' },
  { query: "women's linen sundress", gender: 'women' },
  { query: "women's sweater dress", gender: 'women' },

  // Women's tops & knitwear
  { query: "women's silk blouse", gender: 'women' },
  { query: "women's white button down shirt", gender: 'women' },
  { query: "women's cashmere sweater", gender: 'women' },
  { query: "women's cropped cardigan", gender: 'women' },
  { query: "women's bodysuit", gender: 'women' },
  { query: "women's corset top", gender: 'women' },

  // Women's layers & outerwear
  { query: "women's tailored blazer", gender: 'women' },
  { query: "women's trench coat", gender: 'women' },
  { query: "women's leather jacket", gender: 'women' },
  { query: "women's denim jacket", gender: 'women' },

  // Women's bottoms
  { query: "women's wide leg trousers", gender: 'women' },
  { query: "women's high rise jeans", gender: 'women' },
  { query: "women's satin midi skirt", gender: 'women' },
  { query: "women's linen pants", gender: 'women' },

  // Women's shoes
  { query: "women's block heel sandals", gender: 'women' },
  { query: "women's pointed toe pumps", gender: 'women' },
  { query: "women's leather ankle boots", gender: 'women' },
  { query: "women's white sneakers", gender: 'women' },
  { query: "women's ballet flats", gender: 'women' },

  // Women's bags & accessories
  { query: "women's evening clutch", gender: 'women' },
  { query: "women's leather crossbody bag", gender: 'women' },
  { query: "women's gold hoop earrings", gender: 'women' },
  { query: "women's sunglasses", gender: 'women' },
  { query: "women's leather belt", gender: 'women' },
];

async function main(): Promise<void> {
  const t0 = Date.now();
  // Each searchMixed runs 2 searches in parallel; 4 concurrent workers = at most 8 in flight.
  const WORKER_COUNT = 4;
  let nextIdx = 0;

  const storeCounts = new Map<string, number>();
  const uniqueIds = new Set<string>();
  const sampleItemByDept: Partial<Record<Gender, Item>> = {};
  let totalItemsReturned = 0;
  let liveCount = 0;
  let savedCount = 0;
  let emptyCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= QUERIES.length) return;
      const { query, gender } = QUERIES[idx];
      const res = await searchMixed(query, gender, { limit: 12 });
      if (res.source === 'live') liveCount += 1;
      else if (res.source === 'saved' || res.source === 'saved-near') savedCount += 1;
      else emptyCount += 1;

      totalItemsReturned += res.items.length;
      for (const item of res.items) {
        if (!sampleItemByDept[gender]) {
          sampleItemByDept[gender] = item;
        }
        if (!uniqueIds.has(item.id)) {
          uniqueIds.add(item.id);
          storeCounts.set(item.store, (storeCounts.get(item.store) ?? 0) + 1);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: WORKER_COUNT }, () => worker()));
  await savedStore.flush();

  const elapsedMs = Date.now() - t0;
  const savedDir = process.env.ALICE_SAVED_DIR ?? 'data/store';
  const savedFile = path.resolve(savedDir, 'saved-searches.json');

  console.log('\n=== STORE WARM SUMMARY ===');
  console.log(
    `Queries: ${QUERIES.length} (live=${liveCount}, saved=${savedCount}, empty=${emptyCount}) in ${(elapsedMs / 1000).toFixed(2)}s`,
  );
  console.log(`Items returned: ${totalItemsReturned} (${uniqueIds.size} unique)`);
  console.log('Unique items per store:');
  for (const [store, count] of Array.from(storeCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${store}: ${count}`);
  }
  console.log(`Saved file: ${savedFile}`);

  if (elapsedMs > 30_000) {
    console.log(`WARNING: warm took ${(elapsedMs / 1000).toFixed(2)}s (> 30s target)`);
  }

  // Ensure both test-shopper images exist on disk so demos without a camera skip the ~12s cold start
  const tryonDir = process.env.ALICE_TRYON_DIR
    ? path.resolve(process.env.ALICE_TRYON_DIR)
    : path.resolve('data/tryon');
  let invokedTryOn = false;
  for (const dept of ['men', 'women'] as const) {
    const shopperFile = path.join(tryonDir, `test-shopper-${dept}.jpg`);
    let exists = false;
    try {
      const stat = fs.statSync(shopperFile);
      exists = stat.isFile() && stat.size > 0;
    } catch {
      exists = false;
    }
    if (exists) {
      console.log(`Test shopper (${dept}): ready (${shopperFile})`);
      continue;
    }
    const sample = sampleItemByDept[dept];
    if (!sample) {
      console.log(`Test shopper (${dept}): skipped (no warmed item available)`);
      continue;
    }
    try {
      invokedTryOn = true;
      const tShopper = Date.now();
      const onePieceOutfit: Outfit = {
        number: 1,
        name: `Warm ${dept}`,
        difference: 'Warm-up',
        story: 'Test shopper warm-up',
        total: sample.price,
        pieces: [{ slot: dept === 'women' ? 'dress' : 'top', why: 'warm-up', item: sample }],
      };
      await tryOn(null, onePieceOutfit, { label: `warm-${dept}` });
      console.log(`Test shopper (${dept}): generated in ${Date.now() - tShopper}ms (${shopperFile})`);
    } catch (err) {
      console.log(
        `Test shopper (${dept}): failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (invokedTryOn) {
    stopMedia();
  }
}

main().catch((err) => {
  console.error('[warm] fatal:', err);
  process.exitCode = 1;
});
