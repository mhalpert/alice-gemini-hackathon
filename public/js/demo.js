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

  // ~4 s after reveal: return to all three looks side by side
  await wait(4000);
  if (cancelled()) return;
  handlers.showAll({});
}
