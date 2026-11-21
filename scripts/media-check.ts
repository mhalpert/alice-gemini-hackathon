import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ledgerTotal } from '../src/ledger.ts';
import { mediaStatus, stopMedia } from '../src/media/client.ts';
import { outfitBoard, productShot, warmMedia } from '../src/media/index.ts';
import { REPO_ROOT, tryonDir } from '../src/media/pure.ts';
import { search } from '../src/store/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { BoardBoxes, Item, Outfit, Piece } from '../src/types.ts';

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

const BOX_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2'];

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeDebugBoxesImage(
  boardPath: string,
  boxes: BoardBoxes,
  outPath: string,
): Promise<void> {
  const meta = await sharp(boardPath).metadata();
  const width = meta.width ?? 1200;
  const height = meta.height ?? 900;

  const entries = Object.entries(boxes);
  const shapes: string[] = [];

  entries.forEach(([slot, [x, y, w, h]], idx) => {
    const color = BOX_COLORS[idx % BOX_COLORS.length];
    const px = Math.round(x * width);
    const py = Math.round(y * height);
    const pw = Math.max(1, Math.round(w * width));
    const ph = Math.max(1, Math.round(h * height));

    // 3 px stroke outline centered cleanly on the box edge
    shapes.push(
      `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="none" stroke="${color}" stroke-width="3" />`,
    );

    const labelText = escapeXml(slot);
    const labelW = Math.max(52, slot.length * 9 + 14);
    const labelH = 22;
    const labelY = py >= labelH ? py - labelH : py;
    shapes.push(
      `<rect x="${px}" y="${labelY}" width="${labelW}" height="${labelH}" fill="${color}" />`,
      `<text x="${px + 7}" y="${labelY + 15}" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="700">${labelText}</text>`,
    );
  });

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`,
  );

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(boardPath)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const runTryon = args.has('--tryon');
  const runKill = args.has('--kill');

  try {
    console.log('Warming media child and searching catalog...');
    const [, loafersRes, oxfordRes, chinoRes, bagRes] = await Promise.all([
      warmMedia(),
      search("men's leather loafers", 'men', { limit: 3 }),
      search("men's oxford shirt", 'men', { limit: 3 }),
      search("men's chino pants", 'men', { limit: 3 }),
      search("men's bag", 'men', { limit: 3 }),
    ]);

    const loafers = loafersRes.items[0];
    const oxford = oxfordRes.items[0];
    const chino = chinoRes.items[0];
    const bag = bagRes.items[0];
    if (!loafers || !oxford) {
      throw new Error(
        `Store search missing results (loafers=${loafersRes.items.length}, oxford=${oxfordRes.items.length})`,
      );
    }

    console.log(`Found top:   "${oxford.title}" ($${oxford.price}) [${oxford.store}]`);
    if (chino) console.log(`Found bottom:"${chino.title}" ($${chino.price}) [${chino.store}]`);
    console.log(`Found shoes: "${loafers.title}" ($${loafers.price}) [${loafers.store}]`);
    if (bag) console.log(`Found bag:   "${bag.title}" ($${bag.price}) [${bag.store}]`);

    const pieces: Piece[] = [
      { slot: 'top', why: 'Crisp oxford shirt', item: oxford },
      ...(chino ? [{ slot: 'bottom', why: 'Clean tailored chinos', item: chino }] : []),
      { slot: 'shoes', why: 'Classic leather loafers', item: loafers },
      ...(bag ? [{ slot: 'bag', why: 'Everyday carryall', item: bag }] : []),
    ];

    for (const { slot, item } of pieces) {
      const t0 = Date.now();
      const shot = await productShot(item, slot);
      const ms = Date.now() - t0;
      console.log(`productShot(${slot}): source=${shot?.source} url=${shot?.url} ms=${ms}`);
    }

    const outfit: Outfit = {
      number: 1,
      name: 'Media Check Look',
      difference: 'Live check outfit',
      story: 'Oxford shirt paired with tailored chinos and leather loafers.',
      pieces,
      total: Number(pieces.reduce((s, p) => s + p.item.price, 0).toFixed(2)),
    };

    const boardStart = Date.now();
    const board = await outfitBoard(outfit, 'check');
    console.log(`outfitBoard: url=${board?.url ?? null} ms=${Date.now() - boardStart}`);
    console.log('boxes:', JSON.stringify(board?.boxes ?? null, null, 2));

    if (board?.url) {
      const boardFile = path.join(tryonDir(), path.basename(board.url));
      const debugPath = path.join(tryonDir(), 'board-check-boxes.jpg');
      await writeDebugBoxesImage(boardFile, board.boxes, debugPath);
      console.log(`debug boxes image: ${debugPath}`);
    }

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
