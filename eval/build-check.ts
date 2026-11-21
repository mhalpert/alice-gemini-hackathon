// Live build check: real plan + real store search + pick, printed as the looks stream in.
// Run: node --env-file=.env.local eval/build-check.ts [men|women] [budget] [occasion...]
// Default is the demo occasion. Costs about one plan call (~1 cent); store search is free.
import type { Brief, Outfit } from '../src/types.ts';
import { buildLive } from '../src/brain/build.ts';
import { readFileSync, rmSync } from 'node:fs';
import { getCallLogPath } from '../src/calllog.ts';

const [g, b, ...occ] = process.argv.slice(2);
const brief: Brief = {
  gender: g === 'women' ? 'women' : 'men',
  budget_usd: Number(b) || 150,
  occasion: occ.join(' ') || "a friend's rooftop birthday",
};

const t0 = performance.now();
const show = (o: Outfit) => {
  console.log(`\n[${Math.round(performance.now() - t0)} ms] Look ${o.number}: ${o.name}  $${o.total} / $${brief.budget_usd}`);
  console.log(`  ${o.story}`);
  for (const p of o.pieces) console.log(`   ${p.slot.padEnd(9)} $${String(p.item.price).padEnd(6)} ${p.item.store.padEnd(12)} ${p.item.title}`);
};

console.log(`Building: ${brief.gender} · ${brief.occasion} · $${brief.budget_usd}`);
const room = `build-check-${Date.now()}`;
const result = await buildLive(brief, { onOutfit: show, room });

const issues: string[] = [];
const ids = result.outfits.flatMap((o) => o.pieces.map((p) => p.item.id));
if (result.outfits.length !== 3) issues.push(`${result.outfits.length} outfits, wanted 3`);
if (new Set(ids).size !== ids.length) issues.push('a product appears in two looks');
for (const o of result.outfits) {
  const slots = o.pieces.map((p) => p.slot);
  if (!slots.includes('shoes')) issues.push(`look ${o.number}: no shoes`);
  if (!slots.includes('dress') && !slots.includes('bottom')) issues.push(`look ${o.number}: no bottom`);
  if (o.total > brief.budget_usd) issues.push(`look ${o.number}: over budget`);
  if (o.pieces.some((p) => p.item.department !== brief.gender)) issues.push(`look ${o.number}: wrong department`);
}

// Stage timings from the call log: when the plan, each pick and each gate finished.
try {
  const path = getCallLogPath(room);
  console.log('\nstages (ms since start):');
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    if (e.ev === 'build_plan') console.log(`  ${String(e.ms).padStart(6)}  plan   ${e.model} (${e.plan_ms} ms)`);
    if (e.ev === 'build_gate') console.log(`  ${String(e.ms).padStart(6)}  gated  ${e.name}: fits ${e.fits}, cohesion ${e.cohesion}, gate ${e.gate_ms} ms, pick ${e.picker}`);
  }
  rmSync(path, { force: true });
} catch { /* timings are a nice-to-have */ }
console.log(`\nfirst look ${result.timing.first_outfit_ms} ms, all ${result.timing.total_ms} ms, source ${result.source}`);
for (const p of result.problems) console.log(`  note: ${p}`);
for (const i of issues) console.log(`  !! ${i}`);
console.log(issues.length ? 'FAIL' : 'PASS');
process.exitCode = issues.length ? 1 : 0;
