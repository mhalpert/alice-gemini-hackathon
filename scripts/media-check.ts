import path from 'node:path';
import { ledgerTotal } from '../src/ledger.ts';
import { mediaStatus, stopMedia } from '../src/media/client.ts';
import { outfitCollage, productShot, warmMedia } from '../src/media/index.ts';
import { REPO_ROOT } from '../src/media/pure.ts';
import { search } from '../src/store/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { Item, Outfit } from '../src/types.ts';

if (!process.env.GOOGLE_API_KEY) {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // .env.local may not exist
    }
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const runTryon = args.has('--tryon');
  const runKill = args.has('--kill');

  try {
    console.log('Warming media child and searching catalog...');
    const [, loafersRes, oxfordRes] = await Promise.all([
      warmMedia(),
      search("men's leather loafers", 'men', { limit: 3 }),
      search("men's oxford shirt", 'men', { limit: 3 }),
    ]);

    const loafers = loafersRes.items[0];
    const oxford = oxfordRes.items[0];
    if (!loafers || !oxford) {
      throw new Error(
        `Store search missing results (loafers=${loafersRes.items.length}, oxford=${oxfordRes.items.length})`,
      );
    }

    console.log(`Found top:   "${oxford.title}" ($${oxford.price}) [${oxford.store}]`);
    console.log(`Found shoes: "${loafers.title}" ($${loafers.price}) [${loafers.store}]`);

    const items: Array<{ slot: string; item: Item }> = [
      { slot: 'top', item: oxford },
      { slot: 'shoes', item: loafers },
    ];

    for (const { slot, item } of items) {
      const t0 = Date.now();
      const shot = await productShot(item, slot);
      const ms = Date.now() - t0;
      console.log(`productShot(${slot}): source=${shot?.source} url=${shot?.url} ms=${ms}`);
    }

    const outfit: Outfit = {
      number: 1,
      name: 'Media Check Look',
      difference: 'Live check outfit',
      story: 'Oxford shirt paired with leather loafers.',
      pieces: [
        { slot: 'top', why: 'Crisp oxford shirt', item: oxford },
        { slot: 'shoes', why: 'Classic leather loafers', item: loafers },
      ],
      total: Number((oxford.price + loafers.price).toFixed(2)),
    };

    const boardStart = Date.now();
    const boardUrl = await outfitCollage(outfit, 'check');
    console.log(`outfitCollage: url=${boardUrl} ms=${Date.now() - boardStart}`);

    if (runTryon) {
      const tryStart = Date.now();
      const res = await tryOn(null, outfit, { label: 'check' });
      console.log(`tryOn: url=${res.url} ms=${res.ms} (wall=${Date.now() - tryStart}ms)`);
    }

    if (runKill) {
      const pidBefore = mediaStatus().pid;
      console.log(`--kill: starting uncached shot and killing child pid=${pidBefore}...`);
      const uncachedA: Item = { ...oxford, id: `${oxford.id}-kill-a-${Date.now()}` };
      const pendingShot = productShot(uncachedA, 'top');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const livePid = mediaStatus().pid ?? pidBefore;
      if (livePid) {
        process.kill(livePid, 'SIGKILL');
      }
      const killedResult = await pendingShot;
      console.log(
        `--kill mid-request shot degraded to: source=${killedResult?.source} url=${killedResult?.url}`,
      );

      const uncachedB: Item = { ...loafers, id: `${loafers.id}-kill-b-${Date.now()}` };
      const tRecover = Date.now();
      const recovered = await productShot(uncachedB, 'shoes');
      const statusAfter = mediaStatus();
      console.log(
        `--kill recovery shot: source=${recovered?.source} url=${recovered?.url} ms=${Date.now() - tRecover} newPid=${statusAfter.pid} restarts=${statusAfter.restarts}`,
      );
    }

    const total = await ledgerTotal();
    console.log('ledgerTotal:', JSON.stringify(total));
  } finally {
    stopMedia();
  }
}

await main();
