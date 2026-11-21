import type { Item, Outfit } from '../src/types.ts';
import {
  search,
  getProduct,
  sizeVariant,
  lookup,
  createCart,
  addToBag,
  OTHER_SITES,
  shopMcp,
  ShopMcpError,
} from '../src/store/index.ts';
import { savedStore } from '../src/store/saved.ts';

const runCart = process.argv.includes('--cart');
const runBag = process.argv.includes('--bag');

async function main(): Promise<void> {
  let menItems: Item[] = [];

  // (1) Search men's chino pants
  try {
    const t0 = Date.now();
    const res = await search("men's chino pants", 'men', { limit: 6 });
    const ms = Date.now() - t0;
    menItems = res.items;
    console.log(
      `[check 1] search "men's chino pants" (men): source=${res.source} count=${res.items.length} (${ms}ms)`,
    );
    for (const item of res.items) {
      console.log(
        `  - ${item.title} | $${item.price.toFixed(2)} | ${item.store} | sizes: ${item.sizes.join(', ') || 'none'}`,
      );
    }
  } catch (err) {
    console.log(`[check 1] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (2) Search women's midi dress over OTHER_SITES
  try {
    const t0 = Date.now();
    const res = await search("women's midi dress", 'women', { shops: OTHER_SITES });
    const ms = Date.now() - t0;
    const stores = Array.from(new Set(res.items.map((i) => i.store))).join(', ') || 'none';
    console.log(
      `[check 2] search "women's midi dress" (women, OTHER_SITES): source=${res.source} count=${res.items.length} stores=[${stores}] (${ms}ms)`,
    );
  } catch (err) {
    console.log(`[check 2] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  const firstMen = menItems[0];

  // (3) getProduct of the first men's result
  let thirdSizeLabel: string | null = null;
  try {
    if (!firstMen) {
      console.log('[check 3] getProduct skipped: no men results from step 1');
    } else {
      const t0 = Date.now();
      const detail = await getProduct(firstMen.variant_id);
      const ms = Date.now() - t0;
      if (!detail) {
        console.log(`[check 3] getProduct returned null for ${firstMen.variant_id} (${ms}ms)`);
      } else {
        const optSummary = detail.options
          .map((o) => {
            const avail = o.values.filter((v) => v.available).length;
            return `${o.name} (${avail}/${o.values.length} avail)`;
          })
          .join('; ');
        console.log(
          `[check 3] getProduct "${detail.title}": images=${detail.images.length} options=[${optSummary}] (${ms}ms)`,
        );
        const sizeOpt =
          detail.options.find((o) => /size/i.test(o.name)) ??
          detail.options.find((o) => /waist/i.test(o.name));
        if (sizeOpt && sizeOpt.values.length > 0) {
          thirdSizeLabel =
            sizeOpt.values[2]?.label ?? sizeOpt.values[sizeOpt.values.length - 1]?.label ?? null;
        }
      }
    }
  } catch (err) {
    console.log(`[check 3] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (4) sizeVariant for 3rd size label and for "99"
  try {
    if (!firstMen) {
      console.log('[check 4] sizeVariant skipped: no men results from step 1');
    } else {
      const targetSize = thirdSizeLabel ?? firstMen.sizes[2] ?? firstMen.sizes[0] ?? 'M';
      const t0 = Date.now();
      const [resValid, resInvalid] = await Promise.all([
        sizeVariant(firstMen.variant_id, targetSize),
        sizeVariant(firstMen.variant_id, '99'),
      ]);
      const ms = Date.now() - t0;
      console.log(
        `[check 4] sizeVariant("${targetSize}") => ok=${resValid.ok} variant=${resValid.variant_id} avail=${resValid.available}${resValid.reason ? ` reason="${resValid.reason}"` : ''} | sizeVariant("99") => ok=${resInvalid.ok} reason="${resInvalid.reason ?? ''}" (${ms}ms)`,
      );
    }
  } catch (err) {
    console.log(`[check 4] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (5) lookup of the first 3 ids
  try {
    const ids = menItems.slice(0, 3).map((i) => i.variant_id);
    if (ids.length === 0) {
      console.log('[check 5] lookup skipped: no ids from step 1');
    } else {
      const t0 = Date.now();
      const map = await lookup(ids);
      const ms = Date.now() - t0;
      const found = ids.filter((id) => map.has(id)).length;
      console.log(
        `[check 5] lookup ${ids.length} ids: matched=${found}/${ids.length} total_keys=${map.size} (${ms}ms)`,
      );
    }
  } catch (err) {
    console.log(`[check 5] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (6) createCart only when run with --cart
  if (runCart) {
    try {
      if (!firstMen) {
        console.log('[check 6] createCart skipped: no men results from step 1');
      } else {
        const t0 = Date.now();
        const cart = await createCart(firstMen.store_domain, [
          { variant_id: firstMen.variant_id, quantity: 1 },
        ]);
        const ms = Date.now() - t0;
        console.log(
          `[check 6] createCart (${firstMen.store_domain}): id=${cart.cart_id} total=$${cart.total_usd ?? 'n/a'} url=${cart.continue_url ?? 'n/a'}${cart.error ? ` err="${cart.error}"` : ''} (${ms}ms)`,
        );
      }
    } catch (err) {
      console.log(`[check 6] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('[check 6] createCart skipped (pass --cart to run)');
  }

  // (7) Confirm complete_checkout throws 'denied'
  try {
    const t0 = Date.now();
    try {
      await shopMcp.call('complete_checkout', {});
      console.log('[check 7] FAIL: complete_checkout did NOT throw!');
    } catch (err) {
      const ms = Date.now() - t0;
      const ok = err instanceof ShopMcpError && err.code === 'denied';
      console.log(
        `[check 7] safety check complete_checkout: ${ok ? 'PASS' : 'FAIL'} code=${err instanceof ShopMcpError ? err.code : 'non-ShopMcpError'} (${ms}ms)`,
      );
    }
  } catch (err) {
    console.log(`[check 7] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (8) --bag: build a 3-piece outfit and test addToBag with full sizes & with missing shoe size
  if (runBag) {
    try {
      const t0 = Date.now();
      const [topRes, shoeRes] = await Promise.all([
        search("men's shirt", 'men', { shops: ['everlane.com', 'kith.com'], limit: 6 }),
        search("men's loafers", 'men', { shops: ['stevemadden.com'], limit: 6 }),
      ]);
      const topItem =
        topRes.items[0] ?? (await search("men's shirt", 'men', { limit: 6 })).items[0];
      const bottomItem = menItems[0];
      const shoeItem = shoeRes.items[0];

      if (!topItem || !bottomItem || !shoeItem) {
        console.log(
          `[check 8] --bag skipped: missing search items (top=${Boolean(topItem)} bottom=${Boolean(bottomItem)} shoes=${Boolean(shoeItem)})`,
        );
      } else {
        const outfit: Outfit = {
          name: 'Live Bag Check Look',
          difference: 'Smart casual',
          story: 'Shirt, chinos, and loafers',
          total: Math.round((topItem.price + bottomItem.price + shoeItem.price) * 100) / 100,
          pieces: [
            { slot: 'top', why: 'clean shirt', item: topItem },
            { slot: 'bottom', why: 'chino pants', item: bottomItem },
            { slot: 'shoes', why: 'leather loafers', item: shoeItem },
          ],
        };

        const tBag1 = Date.now();
        const bag1 = await addToBag(
          outfit,
          { top: 'Large', bottom: '34', shoes: 'size 11' },
          'men',
        );
        const msBag1 = Date.now() - tBag1;
        console.log(`[check 8a] addToBag (full sizes, ${msBag1}ms): ${bag1.summary}`);
        for (const c of bag1.carts) {
          console.log(
            `  - ${c.store} (${c.store_domain}): added=${c.added.length} not_added=${c.not_added.length} total=$${c.total_usd ?? 'n/a'} url=${c.continue_url ?? 'none'}`,
          );
        }
        console.log(
          `[check 8a] total_usd=$${bag1.total_usd.toFixed(2)} total_wall=${Date.now() - t0}ms`,
        );

        const tBag2 = Date.now();
        const bag2 = await addToBag(outfit, { top: 'Large', bottom: '34' }, 'men');
        const msBag2 = Date.now() - tBag2;
        const noCarts = bag2.carts.every((c) => c.cart_id === null && c.continue_url === null);
        const startsNotDone = bag2.summary.startsWith('NOT DONE');
        console.log(
          `[check 8b] addToBag (no shoe size, ${msBag2}ms): startsNotDone=${startsNotDone} noCarts=${noCarts} | ${bag2.summary}`,
        );
      }
    } catch (err) {
      console.log(`[check 8] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('[check 8] addToBag skipped (pass --bag to run)');
  }

  await savedStore.flush();
}

main().catch((err) => {
  console.log(`[check] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
