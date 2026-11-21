import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ledgerTotal } from '../src/ledger.ts';
import { stopMedia } from '../src/media/client.ts';
import { warmMedia } from '../src/media/index.ts';
import { REPO_ROOT, tryonDir } from '../src/media/pure.ts';
import { search } from '../src/store/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { Outfit, Piece } from '../src/types.ts';

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

async function generateColorBarsJpeg(width = 640, height = 480): Promise<Buffer> {
  const barColors = [
    '#e5e5e5',
    '#e5e500',
    '#00e5e5',
    '#00e500',
    '#e500e5',
    '#e50000',
    '#0000e5',
  ];
  const barW = Math.ceil(width / barColors.length);
  const rects = barColors
    .map(
      (fill, idx) =>
        `<rect x="${idx * barW}" y="0" width="${barW}" height="${height}" fill="${fill}" />`,
    )
    .join('');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`,
  );
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

async function main(): Promise<void> {
  try {
    console.log('Warming media child and searching catalog...');
    const [, shirtRes, shoesRes] = await Promise.all([
      warmMedia(),
      search("men's oxford shirt", 'men', { limit: 3 }),
      search("men's leather loafers", 'men', { limit: 3 }),
    ]);

    const shirt = shirtRes.items[0];
    const shoes = shoesRes.items[0];
    if (!shirt || !shoes) {
      throw new Error(
        `Missing catalog items (shirt=${shirtRes.items.length}, shoes=${shoesRes.items.length})`,
      );
    }

    const pieces: Piece[] = [
      { slot: 'top', why: 'Crisp oxford shirt', item: shirt },
      { slot: 'shoes', why: 'Classic leather loafers', item: shoes },
    ];

    const outfit: Outfit = {
      number: 1,
      name: 'Shopper Photo Check Look',
      difference: 'Live shopper-photo check outfit',
      story: 'Oxford shirt paired with leather loafers.',
      pieces,
      total: Number(pieces.reduce((s, p) => s + p.item.price, 0).toFixed(2)),
    };

    // (a) Colour-bars JPEG -> expect shopper_photo: 'none', 1 attempt, ~20 s
    const barsJpeg = await generateColorBarsJpeg();
    console.log(`\n(a) Running tryOn with colour-bars JPEG (${barsJpeg.length} bytes)...`);
    const tBars = Date.now();
    const barsRes = await tryOn(barsJpeg, outfit, { label: 'bars' });
    const barsWallMs = Date.now() - tBars;
    console.log(
      `(a) colour-bars result: url=${barsRes.url} ms=${barsRes.ms} wall=${barsWallMs}ms`,
    );
    console.log('(a) check:', JSON.stringify(barsRes.check, null, 2));

    // (b) Test shopper file bytes -> expect shopper_photo: 'camera', 1 attempt
    const testShopperPath = path.join(tryonDir(), 'test-shopper-men.jpg');
    const personBytes = await fs.promises.readFile(testShopperPath);
    console.log(
      `\n(b) Running tryOn with test-shopper-men.jpg bytes (${personBytes.length} bytes)...`,
    );
    const tReal = Date.now();
    const realRes = await tryOn(personBytes, outfit, { label: 'real' });
    const realWallMs = Date.now() - tReal;
    console.log(
      `(b) real-person result: url=${realRes.url} ms=${realRes.ms} wall=${realWallMs}ms`,
    );
    console.log('(b) check:', JSON.stringify(realRes.check, null, 2));

    const total = await ledgerTotal();
    console.log('\nledgerTotal:', JSON.stringify(total));
  } finally {
    stopMedia();
  }
}

await main();
