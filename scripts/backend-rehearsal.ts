import fs from 'node:fs';
import path from 'node:path';
import type { Brief, Gender, Outfit } from '../src/types.ts';
import { buildOutfits } from '../src/brain/index.ts';
import { addToBag, setCallRoom } from '../src/store/index.ts';
import { setCallLogSink } from '../src/store/log.ts';
import { warmMedia, productShot, outfitCollage } from '../src/media/index.ts';
import { mediaStatus, stopMedia } from '../src/media/client.ts';
import { tryOn } from '../src/tryon.ts';
import { ledgerTotal } from '../src/ledger.ts';
import type { LedgerTotal } from '../src/ledger.ts';

if (!process.env.GOOGLE_API_KEY) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may not exist
  }
}

process.env.ALICE_BRAIN = 'live';

interface LookMetrics {
  number: number;
  name: string;
  pieceCount: number;
  arrivalAt: number;
  arrivalFromStartMs: number;
  shotsDoneAt: number;
  shotsMs: number;
  shotCounts: { 'product-only': number; cropped: number; original: number };
  boardDoneAt: number;
  boardAfterShotsMs: number;
  boardTotalMs: number;
  boardUrl: string | null;
  tryOnDoneAt: number;
  tryOnMs: number;
  tryOnUrl: string | null;
  tryOnError: string | null;
}

interface DeptReport {
  gender: Gender;
  occasion: string;
  usedFallbackFixture: boolean;
  fallbackReason?: string;
  firstOutfitMs: number;
  allOutfitsMs: number;
  looks: LookMetrics[];
  allTryOnsAfterLastOutfitMs: number;
  bagMs: number;
  bagHasLinks: boolean;
  bagSummary: string;
  bagTotalUsd: number;
  http429Count: number;
  http503Count: number;
  storeErrors: string[];
  tryOnFails: string[];
  mediaRestarts: number;
  ledgerBefore: LedgerTotal;
  ledgerAfter: LedgerTotal;
}

const BRIEFS: Array<{ brief: Brief; sizes: Record<string, string> }> = [
  {
    brief: {
      gender: 'men',
      occasion: "a friend's rooftop birthday on Saturday",
      budget_usd: 150,
    },
    sizes: { top: 'Large', bottom: '34', shoes: 'size 11' },
  },
  {
    brief: {
      gender: 'women',
      occasion: 'outdoor summer wedding guest',
      budget_usd: 150,
    },
    sizes: { top: 'Medium', bottom: '8', shoes: '8', dress: 'Medium' },
  },
];

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function loadFixtureOutfits(): Outfit[] {
  const raw = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'public', 'fixture.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw) as { outfits: Outfit[] };
  return parsed.outfits.map((o, idx) => ({ ...structuredClone(o), number: idx + 1 }));
}

async function runDepartment(
  brief: Brief,
  sizes: Record<string, string>,
): Promise<DeptReport> {
  const ledgerBefore = await ledgerTotal();
  const restartsBefore = mediaStatus().restarts;

  let http429Count = 0;
  let http503Count = 0;
  const storeErrors: string[] = [];
  const tryOnFails: string[] = [];

  setCallLogSink((_room, ev, data) => {
    if (ev === 'store_error') {
      const status = data?.status;
      const code = String(data?.code ?? '');
      const tool = String(data?.tool ?? '');
      if (status === 429 || code === 'rate_limited') http429Count += 1;
      if (status === 503) http503Count += 1;
      storeErrors.push(`${tool}:${code}${status ? `(${status})` : ''}`);
    } else if (ev === 'tryon_fail') {
      tryOnFails.push(`look ${data?.outfit ?? '?'}: ${String(data?.error ?? 'failed')}`);
    }
  });
  setCallRoom(`rehearsal-${brief.gender}`);

  const buildStart = Date.now();
  let firstOutfitMs = 0;
  let lastOutfitArrivalAt = buildStart;

  const lookPromises: Array<Promise<LookMetrics>> = [];
  const arrivedOutfits: Outfit[] = [];

  function handleOutfitArrival(outfit: Outfit, index: number): void {
    const arrivalAt = Date.now();
    const arrivalFromStartMs = arrivalAt - buildStart;
    if (lookPromises.length === 0) {
      firstOutfitMs = arrivalFromStartMs;
    }
    lastOutfitArrivalAt = arrivalAt;
    const numbered: Outfit = { ...outfit, number: outfit.number ?? index + 1 };
    arrivedOutfits.push(numbered);

    const shotCounts = { 'product-only': 0, cropped: 0, original: 0 };

    const shotsP = Promise.all(
      numbered.pieces.map(async (piece) => {
        const res = await productShot(piece.item, piece.slot);
        const src = res?.source ?? 'original';
        shotCounts[src] += 1;
        return res;
      }),
    ).then(() => Date.now());

    const boardP = outfitCollage(numbered).then((url) => ({
      url,
      doneAt: Date.now(),
    }));

    const tryOnP = tryOn(null, numbered)
      .then((res) => ({
        url: res.url,
        error: null as string | null,
        doneAt: Date.now(),
      }))
      .catch((err) => ({
        url: null as string | null,
        error: err instanceof Error ? err.message : String(err),
        doneAt: Date.now(),
      }));

    const combined = Promise.all([shotsP, boardP, tryOnP]).then(
      ([shotsDoneAt, boardRes, tryOnRes]): LookMetrics => ({
        number: numbered.number ?? index + 1,
        name: numbered.name,
        pieceCount: numbered.pieces.length,
        arrivalAt,
        arrivalFromStartMs,
        shotsDoneAt,
        shotsMs: shotsDoneAt - arrivalAt,
        shotCounts,
        boardDoneAt: boardRes.doneAt,
        boardAfterShotsMs: Math.max(0, boardRes.doneAt - shotsDoneAt),
        boardTotalMs: boardRes.doneAt - arrivalAt,
        boardUrl: boardRes.url,
        tryOnDoneAt: tryOnRes.doneAt,
        tryOnMs: tryOnRes.doneAt - arrivalAt,
        tryOnUrl: tryOnRes.url,
        tryOnError: tryOnRes.error,
      }),
    );

    lookPromises.push(combined);
  }

  let usedFallbackFixture = false;
  let fallbackReason: string | undefined;
  let outfits: Outfit[] = [];

  try {
    const buildRes = await buildOutfits(brief, {
      onOutfit: (outfit, index) => handleOutfitArrival(outfit, index),
    });
    outfits = buildRes.outfits ?? [];
    if (outfits.length === 0) {
      usedFallbackFixture = true;
      fallbackReason = `live buildOutfits returned 0 outfits (problems: ${buildRes.problems.join('; ')})`;
    }
  } catch (err) {
    usedFallbackFixture = true;
    fallbackReason = `live buildOutfits threw: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (usedFallbackFixture) {
    console.error(`[rehearsal] ${brief.gender}: FALLBACK to public/fixture.json — ${fallbackReason}`);
    outfits = loadFixtureOutfits();
    for (let i = 0; i < outfits.length; i += 1) {
      handleOutfitArrival(outfits[i], i);
    }
  } else if (arrivedOutfits.length === 0 && outfits.length > 0) {
    for (let i = 0; i < outfits.length; i += 1) {
      handleOutfitArrival(outfits[i], i);
    }
  }

  const allOutfitsMs = Date.now() - buildStart;
  const looks = await Promise.all(lookPromises);

  const maxTryOnDoneAt = looks.reduce((m, l) => Math.max(m, l.tryOnDoneAt), lastOutfitArrivalAt);
  const allTryOnsAfterLastOutfitMs = Math.max(0, maxTryOnDoneAt - lastOutfitArrivalAt);

  // Step 4: addToBag for look 2
  const look2 = outfits[1] ?? arrivedOutfits[1] ?? outfits[0] ?? arrivedOutfits[0];
  const tBag = Date.now();
  const bagRes = look2
    ? await addToBag(look2, sizes, brief.gender)
    : { carts: [], summary: 'No look 2 available', total_usd: 0 };
  const bagMs = Date.now() - tBag;
  const bagHasLinks = bagRes.carts.some((c) => Boolean(c.continue_url));

  const restartsAfter = mediaStatus().restarts;
  const ledgerAfter = await ledgerTotal();

  setCallRoom(null);
  setCallLogSink(null);

  return {
    gender: brief.gender,
    occasion: brief.occasion,
    usedFallbackFixture,
    fallbackReason,
    firstOutfitMs,
    allOutfitsMs,
    looks,
    allTryOnsAfterLastOutfitMs,
    bagMs,
    bagHasLinks,
    bagSummary: bagRes.summary,
    bagTotalUsd: bagRes.total_usd,
    http429Count,
    http503Count,
    storeErrors,
    tryOnFails,
    mediaRestarts: restartsAfter - restartsBefore,
    ledgerBefore,
    ledgerAfter,
  };
}

function printDeptReport(r: DeptReport): void {
  const maxShotsMs = Math.max(0, ...r.looks.map((l) => l.shotsMs));
  const maxBoardAfterShotsMs = Math.max(0, ...r.looks.map((l) => l.boardAfterShotsMs));
  const anyTryOnFailed = r.looks.some((l) => !l.tryOnUrl);

  const tableRows: Array<{ metric: string; measured: string; budget: string; status: string }> = [
    {
      metric: 'First outfit on screen',
      measured: fmtSec(r.firstOutfitMs),
      budget: '15.00s',
      status: r.firstOutfitMs <= 15_000 ? 'PASS' : 'OVER',
    },
    {
      metric: 'All three outfits',
      measured: fmtSec(r.allOutfitsMs),
      budget: '22.00s',
      status: r.allOutfitsMs <= 22_000 ? 'PASS' : 'OVER',
    },
    ...r.looks.map((l) => ({
      metric: `Clean shots (look ${l.number}, ${l.pieceCount} pcs)`,
      measured: fmtSec(l.shotsMs),
      budget: '3.00s',
      status: l.shotsMs <= 3_000 ? 'PASS' : 'OVER',
    })),
    {
      metric: 'Clean shots (max look)',
      measured: fmtSec(maxShotsMs),
      budget: '3.00s',
      status: maxShotsMs <= 3_000 ? 'PASS' : 'OVER',
    },
    ...r.looks.map((l) => ({
      metric: `Flat-lay board after shots (look ${l.number})`,
      measured: `${fmtSec(l.boardAfterShotsMs)} (total ${fmtSec(l.boardTotalMs)})`,
      budget: '1.00s',
      status: l.boardAfterShotsMs <= 1_000 && Boolean(l.boardUrl) ? 'PASS' : 'OVER',
    })),
    {
      metric: 'Flat-lay board after shots (max)',
      measured: fmtSec(maxBoardAfterShotsMs),
      budget: '1.00s',
      status: maxBoardAfterShotsMs <= 1_000 && r.looks.every((l) => Boolean(l.boardUrl)) ? 'PASS' : 'OVER',
    },
    ...r.looks.map((l) => ({
      metric: `Try-on (look ${l.number})`,
      measured: l.tryOnUrl ? fmtSec(l.tryOnMs) : `FAIL (${fmtSec(l.tryOnMs)})`,
      budget: 'info',
      status: l.tryOnUrl ? 'PASS' : 'FAIL',
    })),
    {
      metric: 'All 3 try-ons after LAST outfit',
      measured: fmtSec(r.allTryOnsAfterLastOutfitMs),
      budget: '25.00s',
      status: !anyTryOnFailed && r.allTryOnsAfterLastOutfitMs <= 25_000 ? 'PASS' : 'OVER',
    },
    {
      metric: 'Bag with checkout links (look 2)',
      measured: `${fmtSec(r.bagMs)} (links=${r.bagHasLinks})`,
      budget: '2.00s',
      status: r.bagMs <= 2_000 && r.bagHasLinks ? 'PASS' : 'OVER',
    },
  ];

  console.log(`\n================ REHEARSAL: ${r.gender.toUpperCase()} ("${r.occasion}") ================`);
  if (r.usedFallbackFixture) {
    console.log(`WARNING: Fell back to public/fixture.json (${r.fallbackReason})`);
  }
  console.log('STATUS | METRIC                                  | MEASURED                  | BUDGET');
  console.log('-------+-----------------------------------------+---------------------------+--------');
  for (const row of tableRows) {
    console.log(
      `${row.status.padEnd(6)} | ${row.metric.padEnd(39)} | ${row.measured.padEnd(25)} | ${row.budget}`,
    );
  }

  const totals = { 'product-only': 0, cropped: 0, original: 0 };
  for (const l of r.looks) {
    totals['product-only'] += l.shotCounts['product-only'];
    totals.cropped += l.shotCounts.cropped;
    totals.original += l.shotCounts.original;
  }
  console.log(
    `Shots: product-only=${totals['product-only']}, cropped=${totals.cropped}, original=${totals.original}`,
  );
  console.log(
    `Errors/Limits: 429=${r.http429Count}, 503=${r.http503Count}, media_restarts=${r.mediaRestarts}, store_errors=[${r.storeErrors.join(', ')}]`,
  );
  const tryOnErrs = r.looks.filter((l) => l.tryOnError).map((l) => `look ${l.number}: ${l.tryOnError}`);
  console.log(`Try-on failures: ${tryOnErrs.length === 0 ? 'none' : tryOnErrs.join(' | ')}`);
  console.log(`Bag summary (total $${r.bagTotalUsd.toFixed(2)}): ${r.bagSummary}`);

  const deltaUsd = r.ledgerAfter.usd - r.ledgerBefore.usd;
  const deltaCalls = r.ledgerAfter.calls - r.ledgerBefore.calls;
  console.log(
    `Ledger spend: before=$${r.ledgerBefore.usd.toFixed(4)} (${r.ledgerBefore.calls} calls) -> after=$${r.ledgerAfter.usd.toFixed(4)} (${r.ledgerAfter.calls} calls) | delta=$${deltaUsd.toFixed(4)} (${deltaCalls} calls)`,
  );
}

async function main(): Promise<void> {
  const deptArg = process.argv[2]?.trim().toLowerCase();
  const selectedBriefs =
    deptArg === 'men' || deptArg === 'women'
      ? BRIEFS.filter((b) => b.brief.gender === deptArg)
      : BRIEFS;

  const overallBefore = await ledgerTotal();

  console.log('[rehearsal] warming media child process...');
  const tWarm = Date.now();
  await warmMedia();
  console.log(`[rehearsal] media ready in ${Date.now() - tWarm}ms (pid=${mediaStatus().pid})`);

  const reports: DeptReport[] = [];
  for (const { brief, sizes } of selectedBriefs) {
    const report = await runDepartment(brief, sizes);
    printDeptReport(report);
    reports.push(report);
  }

  const overallAfter = await ledgerTotal();
  console.log('\n================ IMAGE URLS ================');
  for (const r of reports) {
    console.log(`\n${r.gender.toUpperCase()}:`);
    for (const l of r.looks) {
      console.log(`  Look ${l.number} ("${l.name}"):`);
      console.log(`    board: ${l.boardUrl ?? 'FAILED'}`);
      console.log(`    tryon: ${l.tryOnUrl ?? `FAILED (${l.tryOnError ?? 'unknown'})`}`);
    }
  }

  console.log('\n================ TOTAL MODEL SPEND ================');
  console.log(
    `Before: $${overallBefore.usd.toFixed(4)} (${overallBefore.calls} calls) | After: $${overallAfter.usd.toFixed(4)} (${overallAfter.calls} calls) | Run delta: $${(overallAfter.usd - overallBefore.usd).toFixed(4)} (${overallAfter.calls - overallBefore.calls} calls)`,
  );
  const models = new Set([
    ...Object.keys(overallBefore.by_model),
    ...Object.keys(overallAfter.by_model),
  ]);
  for (const model of models) {
    const beforeM = overallBefore.by_model[model] ?? { usd: 0, calls: 0 };
    const afterM = overallAfter.by_model[model] ?? { usd: 0, calls: 0 };
    const dCalls = afterM.calls - beforeM.calls;
    const dUsd = afterM.usd - beforeM.usd;
    if (dCalls > 0 || dUsd > 0) {
      console.log(`  - ${model}: +${dCalls} calls, +$${dUsd.toFixed(4)}`);
    }
  }

  stopMedia();
}

main().catch((err) => {
  console.error('[rehearsal] fatal:', err);
  stopMedia();
  process.exitCode = 1;
});
