// Plays public/fixture.json through the same page-action handlers on a timer,
// so the storefront can be checked end-to-end without a live video call.

let activeRunId = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDemoSubtitle(brief) {
  if (!brief || typeof brief !== 'object') return undefined;
  const parts = [];
  if (typeof brief.occasion === 'string' && brief.occasion.trim()) {
    parts.push(brief.occasion.trim());
  }
  if (Number.isFinite(Number(brief.budget_usd))) {
    parts.push(`$${Number(brief.budget_usd)} budget`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function storeHomeUrl(productUrl) {
  if (typeof productUrl !== 'string') return '';
  try {
    return new URL(productUrl).origin;
  } catch {
    return '';
  }
}

function demoSizeForPiece(piece) {
  const slot = typeof piece?.slot === 'string' ? piece.slot.toLowerCase() : '';
  const sizes = Array.isArray(piece?.item?.sizes) ? piece.item.sizes : [];
  if (slot === 'shoes') return '10';
  if (slot === 'accessory' || slot === 'bag' || slot === 'jewelry') {
    return sizes.includes('OS') ? 'OS' : null;
  }
  return 'M';
}

function roundUsd(amount) {
  return Math.round(amount * 100) / 100;
}

// Group a look's pieces by store, moving one line to not_added to demo the amber note
function buildDemoBag(look) {
  const pieces = Array.isArray(look?.pieces) ? look.pieces.filter((p) => p?.item) : [];
  const unavailablePiece =
    pieces.find((p) => p.slot === 'shoes') || pieces[pieces.length - 1] || null;

  const byStore = new Map();
  const linkByStore = new Map();

  for (const piece of pieces) {
    const item = piece.item;
    const storeName = item.store || 'Store';
    if (!byStore.has(storeName)) {
      byStore.set(storeName, { store: storeName, added: [], not_added: [], subtotal: 0 });
    }
    if (!linkByStore.has(storeName)) {
      const home = storeHomeUrl(item.url);
      if (home) linkByStore.set(storeName, { store: storeName, url: home });
    }

    const bucket = byStore.get(storeName);
    const price = Number(item.price) || 0;
    const line = {
      title: item.title || '',
      slot: piece.slot || '',
      image: item.image || '',
      price,
    };

    if (piece === unavailablePiece) {
      bucket.not_added.push({
        ...line,
        reason: '11 is sold out; nearest is 10.5',
      });
    } else {
      const size = demoSizeForPiece(piece);
      if (size) line.size = size;
      bucket.added.push(line);
      bucket.subtotal = roundUsd(bucket.subtotal + price);
    }
  }

  let total = 0;
  const stores = Array.from(byStore.values()).map((bucket) => {
    total = roundUsd(total + bucket.subtotal);
    return {
      ...bucket,
      subtotal: bucket.added.length > 0 ? bucket.subtotal : null,
    };
  });

  return {
    stores,
    links: Array.from(linkByStore.values()),
    total,
  };
}

export async function playDemo(handlers) {
  if (!handlers || typeof handlers.showOutfits !== 'function') {
    throw new Error('playDemo requires the store handlers object');
  }

  const runId = ++activeRunId;
  const cancelled = () => runId !== activeRunId;

  const response = await fetch('fixture.json');
  if (!response.ok) {
    throw new Error(`Could not load fixture.json (${response.status})`);
  }
  const fixture = await response.json();
  if (cancelled()) return;

  const outfits = Array.isArray(fixture.outfits) ? fixture.outfits : [];
  if (outfits.length === 0) return;

  const subtitle = buildDemoSubtitle(fixture.brief);
  handlers.showOutfits({ outfits, replace: true, subtitle });

  // ~1.5 s later: kick off try-on rendering for looks 1-3
  await wait(1500);
  if (cancelled()) return;
  for (const look of outfits) {
    const num = typeof look.number === 'number' ? look.number : outfits.indexOf(look) + 1;
    handlers.tryOnStatus({ outfit: num, status: 'rendering' });
  }

  // ~3 s later: pick look 2 and populate its flat-lay board
  await wait(3000);
  if (cancelled()) return;

  const look2 = outfits.find((o) => o.number === 2) || outfits[1] || outfits[0];
  const look2Num = typeof look2.number === 'number' ? look2.number : 2;
  const fallbackImage = look2.pieces?.[0]?.item?.image || '';

  handlers.highlight({ outfit: look2Num, piece: null });

  await wait(700);
  if (cancelled()) return;
  if (fallbackImage) {
    handlers.collageReady({ outfit: look2Num, url: fallbackImage });
  }

  // Walk Alice's pointer through each slot of look 2 (~2.2 s per piece)
  await wait(1200);
  if (cancelled()) return;
  for (const piece of look2.pieces || []) {
    if (!piece || !piece.slot) continue;
    handlers.highlight({ outfit: look2Num, piece: piece.slot });
    await wait(2200);
    if (cancelled()) return;
  }

  // Clear pointer, mark try-on ready, then fade it in with reveal
  handlers.highlight({ outfit: look2Num, piece: null });
  if (fallbackImage) {
    handlers.tryOnReady({ outfit: look2Num, url: fallbackImage });
  }

  await wait(1500);
  if (cancelled()) return;
  if (fallbackImage) {
    handlers.reveal({ outfit: look2Num });
  }

  // ~2.5 s after reveal: open the product page for look 2's shoes for ~3 s
  await wait(2500);
  if (cancelled()) return;
  const shoesPiece =
    (look2.pieces || []).find((p) => p?.slot === 'shoes') || look2.pieces?.[0];
  if (shoesPiece?.item && typeof handlers.showProduct === 'function') {
    handlers.showProduct({
      item: shoesPiece.item,
      images: shoesPiece.item.image ? [shoesPiece.item.image] : [],
      slot: shoesPiece.slot || 'shoes',
      why: shoesPiece.why || '',
      sizes: Array.isArray(shoesPiece.item.sizes) ? shoesPiece.item.sizes : [],
      details: [
        'Sleek finish with elastic side panels',
        'Durable sole with reliable traction',
        'Pull-on Chelsea silhouette',
      ],
      description: shoesPiece.item.description || '',
    });

    await wait(3000);
    if (cancelled()) return;
    if (typeof handlers.hideProduct === 'function') {
      handlers.hideProduct({});
    }
  }

  // Open the bag drawer built from look 2 grouped by store for ~4 s, then close it
  await wait(450);
  if (cancelled()) return;
  if (typeof handlers.bagReady === 'function') {
    handlers.bagReady(buildDemoBag(look2));
    await wait(4000);
    if (cancelled()) return;
    const closeBagBtn = document.querySelector('#store-bag-slot [data-close-bag]');
    if (closeBagBtn) closeBagBtn.click();
  }

  // Return to all three looks side by side
  await wait(450);
  if (cancelled()) return;
  handlers.showAll({});
}
