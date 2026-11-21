import fs from 'node:fs';
import path from 'node:path';
import { ledgerPath, ledgerTotal } from '../src/ledger.ts';
import { stopMedia } from '../src/media/client.ts';
import { warmMedia } from '../src/media/index.ts';
import { REPO_ROOT } from '../src/media/pure.ts';
import { search } from '../src/store/index.ts';
import { prewarmScene, tryOn, tryOnExtras } from '../src/tryon.ts';
import type { Gender, Item, Outfit } from '../src/types.ts';

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

function inspectMp4(filePath: string): {
  sizeBytes: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
} {
  const b = fs.readFileSync(filePath);
  let durationS: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let hasAudio = false;

  const walk = (start: number, end: number): void => {
    let off = start;
    while (off + 8 <= end) {
      let size = b.readUInt32BE(off);
      const type = b.toString('ascii', off + 4, off + 8);
      if (size === 0) size = end - off;
      if (size < 8) break;
      if (type === 'mvhd') {
        const ver = b[off + 8];
        const ts = ver === 1 ? b.readUInt32BE(off + 28) : b.readUInt32BE(off + 20);
        const dur = ver === 1 ? Number(b.readBigUInt64BE(off + 32)) : b.readUInt32BE(off + 24);
        if (ts > 0) durationS = Number((dur / ts).toFixed(2));
      } else if (type === 'tkhd') {
        const ver = b[off + 8];
        const wOff = ver === 1 ? off + 96 : off + 84;
        const w = b.readUInt32BE(wOff) / 65536;
        const h = b.readUInt32BE(wOff + 4) / 65536;
        if (w > 0 || h > 0) {
          width = Math.round(w);
          height = Math.round(h);
        }
      } else if (type === 'hdlr') {
        if (b.toString('ascii', off + 16, off + 20) === 'soun') {
          hasAudio = true;
        }
      } else if (type === 'moov' || type === 'trak' || type === 'mdia') {
        walk(off + 8, off + size);
      }
      off += size;
    }
  };
  walk(0, b.length);
  return { sizeBytes: b.length, durationS, width, height, hasAudio };
}

async function pickFirst(query: string, gender: Gender): Promise<Item> {
  const res = await search(query, gender, { limit: 4 });
  const found = res.items.find((i) => i.image && i.image.length > 0);
  if (!found) throw new Error(`No item for "${query}" (${gender})`);
  return found;
}

function readLedgerLines(): string[] {
  try {
    return fs
      .readFileSync(ledgerPath(), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function runPrewarmCheck(): Promise<void> {
  try {
    console.log('Warming media child and loading one men’s look for --prewarm check...');
    const [, menShirt, menChino, menLoafers] = await Promise.all([
      warmMedia(),
      pickFirst("men's oxford shirt", 'men'),
      pickFirst("men's chino pants", 'men'),
      pickFirst("men's leather loafers", 'men'),
    ]);

    const outfit: Outfit = {
      number: 1,
      name: 'Rooftop Classic',
      difference: '',
      story: '',
      pieces: [
        { slot: 'top', why: '', item: menShirt },
        { slot: 'bottom', why: '', item: menChino },
        { slot: 'shoes', why: '', item: menLoafers },
      ],
      total: menShirt.price + menChino.price + menLoafers.price,
    };

    const brief = {
      occasion: "a friend's rooftop birthday",
      where: 'New York',
      when: 'Saturday evening',
      weather: 'cool, clear',
    };

    const studio = await tryOn(null, outfit, { label: 'prewarm-check' });
    console.log(
      `Studio ready in ${(studio.ms / 1000).toFixed(2)}s -> ${path.relative(REPO_ROOT, studio.path)}`,
    );

    const ledgerCountBefore = readLedgerLines().length;

    const tPrewarm = Date.now();
    const prewarmRes = await prewarmScene({ path: studio.path }, outfit, brief);
    const prewarmWallMs = Date.now() - tPrewarm;
    console.log(
      `prewarmScene finished in ${(prewarmWallMs / 1000).toFixed(2)}s: ${JSON.stringify(prewarmRes)}`,
    );

    let sceneOnRenderWallMs: number | null = null;
    let sceneReused: boolean | undefined;
    let videoOnRenderWallMs: number | null = null;

    const tExtras = Date.now();
    const extras = await tryOnExtras({ path: studio.path }, outfit, {
      ...brief,
      onRender: (ev) => {
        const wall = Date.now() - tExtras;
        if (ev.kind === 'scene') {
          sceneOnRenderWallMs = wall;
          sceneReused = ev.reused;
        } else if (ev.kind === 'video') {
          videoOnRenderWallMs = wall;
        }
        console.log(
          `[extras-check --prewarm] onRender: kind=${ev.kind} ok=${ev.ok} reused=${Boolean(ev.reused)} wall=${wall}ms ev.ms=${ev.ms} url=${ev.url ?? 'null'}`,
        );
      },
    });
    const extrasWallMs = Date.now() - tExtras;
    const mp4Info = extras.video?.path ? inspectMp4(extras.video.path) : null;

    // Wait briefly so async ledger writes from child process flush
    await new Promise((resolve) => setTimeout(resolve, 250));
    const newLedgerLines = readLedgerLines().slice(ledgerCountBefore);

    console.log('\n--- SCENE PREWARM CHECK RESULTS ---');
    console.log(`setting: "${extras.setting}"`);
    console.log(`prewarm: ${(prewarmWallMs / 1000).toFixed(2)} s (ok=${prewarmRes.ok})`);
    console.log(
      `tryOnExtras -> scene onRender: ${sceneOnRenderWallMs !== null ? `${(sceneOnRenderWallMs / 1000).toFixed(3)} s` : 'n/a'} (reused=${Boolean(sceneReused)})`,
    );
    console.log(
      `video: ${videoOnRenderWallMs !== null ? `${(videoOnRenderWallMs / 1000).toFixed(2)} s` : 'FAILED'} (extras wall=${(extrasWallMs / 1000).toFixed(2)} s)${mp4Info ? ` [${mp4Info.durationS}s, ${mp4Info.width}x${mp4Info.height}, ${(mp4Info.sizeBytes / 1024 / 1024).toFixed(2)} MiB, audio=${mp4Info.hasAudio}]` : ''}`,
    );
    console.log(`still file path: ${extras.scene?.path ?? 'null'}`);
    console.log(`ledger lines written (${newLedgerLines.length}):`);
    for (const line of newLedgerLines) {
      console.log(`  ${line}`);
    }
  } finally {
    stopMedia();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--prewarm')) {
    await runPrewarmCheck();
    return;
  }

  const ledgerBefore = await ledgerTotal();

  try {
    console.log('Warming media child and loading one men’s look + one women’s look...');
    const [, menShirt, menChino, menLoafers, womenDress, womenHeels] = await Promise.all([
      warmMedia(),
      pickFirst("men's oxford shirt", 'men'),
      pickFirst("men's chino pants", 'men'),
      pickFirst("men's leather loafers", 'men'),
      pickFirst("women's midi dress", 'women'),
      pickFirst("women's heeled sandals", 'women'),
    ]);

    const cases: Array<{
      label: string;
      outfit: Outfit;
      brief: { occasion: string; where: string; when: string; weather: string };
    }> = [
      {
        label: 'men-rooftop',
        outfit: {
          number: 1,
          name: 'Rooftop Classic',
          difference: '',
          story: '',
          pieces: [
            { slot: 'top', why: '', item: menShirt },
            { slot: 'bottom', why: '', item: menChino },
            { slot: 'shoes', why: '', item: menLoafers },
          ],
          total: menShirt.price + menChino.price + menLoafers.price,
        },
        brief: {
          occasion: "a friend's rooftop birthday",
          where: 'New York',
          when: 'Saturday evening',
          weather: 'cool, clear',
        },
      },
      {
        label: 'women-dinner',
        outfit: {
          number: 2,
          name: 'SoHo Dinner',
          difference: '',
          story: '',
          pieces: [
            { slot: 'dress', why: '', item: womenDress },
            { slot: 'shoes', why: '', item: womenHeels },
          ],
          total: womenDress.price + womenHeels.price,
        },
        brief: {
          occasion: 'a candlelit Italian dinner',
          where: 'SoHo, New York',
          when: 'Friday evening',
          weather: 'mild, crisp',
        },
      },
    ];

    const outputs = await Promise.all(
      cases.map(async (c) => {
        const studio = await tryOn(null, c.outfit, { label: c.label });
        const arrivals: string[] = [];
        const extrasStart = Date.now();
        const extras = await tryOnExtras({ path: studio.path }, c.outfit, {
          ...c.brief,
          onRender: (ev) => {
            arrivals.push(`${ev.kind}(ok=${ev.ok}, ${ev.ms}ms)`);
            console.log(`[extras-check] ${c.label} onRender: ${ev.kind} ok=${ev.ok} ms=${ev.ms} url=${ev.url ?? 'null'}`);
          },
        });
        const extrasWallMs = Date.now() - extrasStart;
        const mp4Info = extras.video?.path ? inspectMp4(extras.video.path) : null;
        return { c, studio, extras, extrasWallMs, arrivals, mp4Info };
      }),
    );

    console.log('\n--- EXTRAS CHECK RESULTS ---');
    for (const o of outputs) {
      console.log(`\nLook: ${o.c.label} ("${o.extras.setting}")`);
      console.log(`  studio: ${o.studio.ms} ms -> ${path.relative(REPO_ROOT, o.studio.path)} (${o.studio.url})`);
      console.log(
        `  scene:  ${o.extras.scene ? `${o.extras.scene.ms} ms -> ${path.relative(REPO_ROOT, o.extras.scene.path)} (${o.extras.scene.url})` : 'FAILED (null)'}`,
      );
      if (o.extras.video && o.mp4Info) {
        console.log(
          `  video:  ${o.extras.video.ms} ms -> ${path.relative(REPO_ROOT, o.extras.video.path)} (${o.extras.video.url}) [${o.mp4Info.durationS}s, ${o.mp4Info.width}x${o.mp4Info.height}, ${(o.mp4Info.sizeBytes / 1024 / 1024).toFixed(2)} MiB, audio=${o.mp4Info.hasAudio}]`,
        );
      } else {
        console.log('  video:  FAILED (null)');
      }
      console.log(`  extras wall: ${o.extrasWallMs} ms | arrival order: ${o.arrivals.join(' -> ')}`);
    }

    const ledgerAfter = await ledgerTotal();
    const runCost = Math.max(0, ledgerAfter.usd - ledgerBefore.usd);
    console.log(
      `\nCost of this run: $${runCost.toFixed(4)} (total ledger: $${ledgerAfter.usd.toFixed(4)})`,
    );
  } finally {
    stopMedia();
  }
}

await main();
