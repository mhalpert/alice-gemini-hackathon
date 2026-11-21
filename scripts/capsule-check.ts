import path from 'node:path';
import { packCapsule, repackCapsule, warmCapsule, type CapsuleBrief, type CapsuleResult } from '../src/capsule/index.ts';
import { getProduct, lookup } from '../src/store/index.ts';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '..', '.env.local'));
} catch {
  // .env.local optional
}

const LISBON_BRIEF: CapsuleBrief = {
  gender: 'men',
  plans:
    'four more days in Lisbon in late May after a wedding: two daytime city days, one beach day, one dinner',
  sizes: { top: 'M', bottom: '32', shoes: 'US 10' },
  budget_usd: 450,
  owned: ['navy linen suit', 'brown leather loafers', 'white dress shirt'],
  max_stores: 2,
};

function printResult(label: string, res: CapsuleResult): void {
  console.log(`\n==================== ${label} ====================`);
  console.log(
    `ok=${res.ok} model=${res.model} total_usd=$${res.total_usd.toFixed(2)} stores=[${res.stores.join(', ')}] pieces=${res.pieces.length} outfits=${res.outfits.length} mix=${res.mix_and_match_count} searched=${res.searched}`,
  );
  console.log(
    `timings: total=${(res.timings.total_ms / 1000).toFixed(2)}s (agent=${(res.timings.agent_ms / 1000).toFixed(2)}s, tools=${(res.timings.tools_ms / 1000).toFixed(2)}s) | cost=$${(res.cost_usd ?? 0).toFixed(4)}`,
  );
  if (res.usage) {
    console.log(
      `tokens: in=${res.usage.input_tokens} out=${res.usage.output_tokens} thought=${res.usage.thought_tokens} cached=${res.usage.cached_tokens}`,
    );
  }
  if (res.explanation) {
    console.log(`explanation: ${res.explanation}`);
  }
  if (res.problems.length > 0) {
    console.log(`problems: ${JSON.stringify(res.problems)}`);
  }
  console.log(
    `certificate: stock=${res.certificate.all_sizes_in_stock} budget=${res.certificate.within_budget} checks=${res.certificate.checks.filter((c) => c.ok).length}/${res.certificate.checks.length}`,
  );
  for (const c of res.certificate.checks) {
    const tag = c.advisory ? ' (advisory)' : '';
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${tag}`);
  }
  if (res.dress_code_notes && res.dress_code_notes.length > 0) {
    console.log('Dress-code notes:');
    for (const n of res.dress_code_notes) {
      console.log(`  ${n.day}: ${n.title} — ${n.reason}`);
    }
  }
  if (res.critic && res.critic.length > 0) {
    console.log('Critic:');
    for (const cr of res.critic) {
      console.log(
        `  ${cr.day}: ${cr.score}/10 presentable=${cr.presentable}${cr.issues.length ? ` issues=[${cr.issues.join('; ')}]` : ''}`,
      );
    }
  }
  console.log('Pieces:');
  for (const p of res.pieces) {
    console.log(
      `  [${p.slot.padEnd(9)}] ${p.item.title} | ${p.item.store} | $${p.item.price.toFixed(2)} | sizes=${p.item.sizes.slice(0, 4).join(',')} | img=${p.item.image ? 'yes' : 'no'}`,
    );
  }
  console.log('Outfits:');
  for (const o of res.outfits) {
    console.log(
      `  Look ${o.number}: ${o.name} (new=$${o.total.toFixed(2)}) -> ${o.pieces.map((p) => `${p.slot}:${p.item.title}`).join(' + ')}`,
    );
  }
}

async function liveValidateSample(res: CapsuleResult): Promise<void> {
  if (res.pieces.length === 0) {
    console.log('\nLive sample validation: no pieces to check');
    return;
  }
  const pool = [...res.pieces];
  const sample = [];
  while (sample.length < 3 && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    sample.push(pool.splice(idx, 1)[0]!);
  }

  console.log(`\n--- Live store-layer check (${sample.length} random pieces) ---`);
  const ids = sample.map((p) => p.item.variant_id).filter(Boolean);
  const lookupMap = await lookup(ids);
  let passed = 0;

  for (const p of sample) {
    const vid = p.item.variant_id;
    const entry = lookupMap.get(vid);
    const prod = vid ? await getProduct(vid) : null;
    const liveAvail = prod?.variant?.available ?? entry?.available ?? false;
    const livePrice = prod?.variant?.price ?? entry?.price ?? null;
    const priceMatch = livePrice !== null && Math.abs(livePrice - p.item.price) <= 0.05;
    const selected = prod?.selected?.map((s) => `${s.name}=${s.label}`).join(', ') ?? 'n/a';
    const ok = liveAvail && priceMatch;
    if (ok) passed += 1;
    console.log(
      `  [${ok ? 'OK' : 'FAIL'}] "${p.item.title}" (${p.item.store}, $${p.item.price.toFixed(2)}) -> avail=${liveAvail}, live=$${livePrice}, selected=[${selected}]`,
    );
  }
  console.log(`Live validation: ${passed}/${sample.length} passed`);
}

async function main(): Promise<void> {
  const modelArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const forceRebuild = process.argv.includes('--rebuild');
  const model = modelArg || process.env.ALICE_MODEL_CAPSULE || undefined;

  console.log(`Warming capsule environment${model ? ` (model=${model})` : ''}...`);
  const warmHandle = warmCapsule({ setupModel: model, forceRebuild });
  const warm = await warmHandle.ready;
  console.log(
    `Warm: ok=${warm.ok} env=${warm.environment_id} rebuilt=${warm.rebuilt} ms=${warm.ms}${warm.error ? ` err=${warm.error}` : ''}`,
  );
  if (!warm.ok) {
    process.exit(1);
  }

  console.log('\n--- Running packCapsule (Lisbon brief) ---');
  const packed = await packCapsule(LISBON_BRIEF, {
    model,
    force: true,
    onStep: (s) => console.log(`  [+${(s.t_ms / 1000).toFixed(2)}s] (${s.kind}) ${s.text}`),
  });
  printResult(`PACK (${packed.model})`, packed);

  if (packed.ok) {
    await liveValidateSample(packed);

    console.log('\n--- Running repackCapsule ("the dinner is now black tie optional") ---');
    const repacked = await repackCapsule(packed, 'the dinner is now black tie optional', {
      model,
      force: true,
      onStep: (s) => console.log(`  [+${(s.t_ms / 1000).toFixed(2)}s] (${s.kind}) ${s.text}`),
    });
    printResult(`REPACK (${repacked.model})`, repacked);
    if (repacked.ok) {
      await liveValidateSample(repacked);
    }
  }
}

await main();
