import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ledgerTotal } from '../src/ledger.ts';
import { stopMedia } from '../src/media/client.ts';
import { buildContactSheet, runTryOnGate, runTryOnInspector } from '../src/media/inspect.ts';
import {
  REPO_ROOT,
  gatePassed,
  needsInspector,
  sortPiecesForTryOn,
  stripHtml,
  tryonDir,
  type TryOnGateScores,
  type TryOnInspectorResult,
} from '../src/media/pure.ts';
import { writeFileAtomic } from '../src/media/shots.ts';
import {
  buildTryOnPrompt,
  generateImageWithRetry,
  getTestShopper,
  loadPieceForTryOn,
  prepareShopperJpeg,
} from '../src/media/tryon-render.ts';
import { search } from '../src/store/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { Gender, Item, Outfit, Piece } from '../src/types.ts';

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

function fmtProbs(g: TryOnGateScores | null): string {
  if (!g) return 'n/a';
  return `p=${g.same_person.toFixed(2)} pc=${g.all_pieces.toFixed(2)} ex=${g.no_extras.toFixed(2)} cl=${g.colours_match.toFixed(2)}`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function saveInspectorImg(name: string, buf: Buffer): Promise<string> {
  const filePath = path.join(tryonDir(), name);
  await writeFileAtomic(filePath, buf);
  return path.relative(REPO_ROOT, filePath);
}

async function pickFirst(query: string, gender: Gender, fallback?: Item): Promise<Item> {
  const res = await search(query, gender, { limit: 4 });
  const item = res.items.find((i) => i.image && i.image.length > 0);
  if (item) return item;
  if (fallback) return fallback;
  throw new Error(`No item found for "${query}" (${gender})`);
}

async function generateCustomTryOn(
  shopperBuf: Buffer,
  pieces: Piece[],
  opts?: { extraPrompt?: string; forceBarefoot?: boolean; overridePieceBufs?: Map<number, Buffer> },
): Promise<{ tryonBuf: Buffer; pieceBufs: Buffer[]; loadedPieces: Piece[]; contactSheet: Buffer }> {
  const sorted = sortPiecesForTryOn(pieces);
  const bufs = await Promise.all(
    sorted.map((p, idx) => opts?.overridePieceBufs?.get(idx) ?? loadPieceForTryOn(p)),
  );
  const loadedPieces: Piece[] = [];
  const pieceBufs: Buffer[] = [];
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: 'Image 0: the shopper (the ONLY source for the person)' },
    { inlineData: { mimeType: 'image/jpeg', data: shopperBuf.toString('base64') } },
  ];

  let hasShoes = false;
  let hasBottom = false;
  let n = 1;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const b = bufs[i];
    if (!b) continue;
    loadedPieces.push(p);
    pieceBufs.push(b);
    const sk = p.slot.toLowerCase();
    if (sk === 'shoes') hasShoes = true;
    if (sk === 'bottom' || sk === 'dress' || sk === 'suit') hasBottom = true;
    const desc = stripHtml(p.item.description, 220);
    parts.push({
      text: desc
        ? `Image ${n}: ${p.slot}: "${p.item.title}" (${desc})`
        : `Image ${n}: ${p.slot}: "${p.item.title}"`,
    });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: b.toString('base64') } });
    n += 1;
  }

  let prompt = buildTryOnPrompt(opts?.forceBarefoot ? true : hasShoes, hasBottom, opts?.extraPrompt);
  if (opts?.forceBarefoot) {
    prompt += '\nThe person is completely barefoot with no shoes and no socks.';
  }
  parts.push({ text: prompt });

  const [gen, contactSheet] = await Promise.all([
    generateImageWithRetry(parts, 'tryon'),
    buildContactSheet(pieceBufs),
  ]);
  const tryonBuf =
    gen.mimeType === 'image/jpeg'
      ? gen.data
      : await sharp(gen.data).jpeg({ quality: 90 }).toBuffer();

  return { tryonBuf, pieceBufs, loadedPieces, contactSheet };
}

async function getAltMenShopper(): Promise<Buffer> {
  const filePath = path.join(tryonDir(), 'inspector-alt-shopper-men.jpg');
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && stat.size > 0) {
      return await fs.promises.readFile(filePath);
    }
  } catch {
    // generate
  }
  const prompt =
    'full-body studio photo of an adult older bald man in his 50s with a thick grey beard and glasses standing facing the camera, plain grey t-shirt, dark jeans, white sneakers, neutral expression, plain light grey background, head to toe in frame, photorealistic, 3:4';
  const gen = await generateImageWithRetry([{ text: prompt }], 'test-shopper');
  const buf =
    gen.mimeType === 'image/jpeg'
      ? gen.data
      : await sharp(gen.data).jpeg({ quality: 90 }).toBuffer();
  await writeFileAtomic(filePath, buf);
  return buf;
}

interface CaseRow {
  name: string;
  expected: 'GOOD' | 'BAD';
  gate: TryOnGateScores | null;
  inspector: TryOnInspectorResult | null;
  flagged: boolean;
  redoFixed: string;
  msGate: number;
  msInspect: number;
  savedPaths: string[];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildInspectorSheet(): Promise<string> {
  const dir = tryonDir();
  const pairs: Array<{
    beforeFile: string;
    afterFile: string;
    caption: string;
    missingAfterLabel: string;
  }> = [
    {
      beforeFile: 'inspector-bad-a-extra.jpg',
      afterFile: 'inspector-bad-a-extra-fixed.jpg',
      caption: 'added belt and cap -> removed',
      missingAfterLabel: 'FLAGGED (GATE)',
    },
    {
      beforeFile: 'inspector-bad-b-face.jpg',
      afterFile: 'inspector-bad-b-face-fixed.jpg',
      caption: 'wrong face -> shopper restored',
      missingAfterLabel: 'FLAGGED (GATE)',
    },
    {
      beforeFile: 'inspector-bad-c-missing.jpg',
      afterFile: 'inspector-bad-c-missing-fixed.jpg',
      caption: 'shoes missing -> restored',
      missingAfterLabel: 'FLAGGED (GATE)',
    },
    {
      beforeFile: 'inspector-bad-d-colour.jpg',
      afterFile: 'inspector-bad-d-colour-fixed.jpg',
      caption: 'wrong colour -> flagged',
      missingAfterLabel: 'FLAGGED (cl=0.12)',
    },
  ];

  const sheetW = 1600;
  const margin = 28;
  const colGap = 28;
  const rowGap = 28;
  const headerH = 60;
  const cardW = Math.floor((sheetW - margin * 2 - colGap) / 2); // 758
  const arrowGap = 46;
  const imgW = Math.floor((cardW - arrowGap) / 2); // 356
  const imgH = Math.round((imgW * 4) / 3); // 475
  const captionH = 54;
  const cardH = imgH + captionH;
  const sheetH = margin + headerH + cardH * 2 + rowGap + margin;

  const overlays: Array<{ input: Buffer; left: number; top: number }> = [];
  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">`,
    `<text x="${margin}" y="${margin + 36}" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="#1f1c18">Alice Try-On Inspector — Before / After Proof Sheet</text>`,
  ];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const row = Math.floor(i / 2);
    const col = i % 2;
    const cardX = margin + col * (cardW + colGap);
    const cardY = margin + headerH + row * (cardH + rowGap);

    const beforePath = path.join(dir, pair.beforeFile);
    const afterPath = path.join(dir, pair.afterFile);

    const hasBefore = fs.existsSync(beforePath);
    const hasAfter = fs.existsSync(afterPath);

    if (hasBefore) {
      const beforeBuf = await sharp(beforePath)
        .resize(imgW, imgH, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toBuffer();
      overlays.push({ input: beforeBuf, left: cardX, top: cardY });
    }

    const afterX = cardX + imgW + arrowGap;
    if (hasAfter) {
      const afterBuf = await sharp(afterPath)
        .resize(imgW, imgH, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toBuffer();
      overlays.push({ input: afterBuf, left: afterX, top: cardY });
    } else {
      svgParts.push(
        `<rect x="${afterX}" y="${cardY}" width="${imgW}" height="${imgH}" rx="8" fill="#efe7dc" stroke="#c84b31" stroke-width="3" stroke-dasharray="10 6"/>`,
        `<text x="${afterX + imgW / 2}" y="${cardY + imgH / 2 - 8}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#b4321c">${xmlEscape(pair.missingAfterLabel)}</text>`,
        `<text x="${afterX + imgW / 2}" y="${cardY + imgH / 2 + 24}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="16" fill="#5b5247">Caught by gate (white vs red)</text>`,
      );
    }

    // Arrow between before & after
    const arrowCx = cardX + imgW + arrowGap / 2;
    const arrowCy = cardY + imgH / 2;
    svgParts.push(
      `<text x="${arrowCx}" y="${arrowCy + 10}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#3a332c">&#8594;</text>`,
    );

    // Small corner tags
    svgParts.push(
      `<rect x="${cardX + 10}" y="${cardY + 10}" width="84" height="26" rx="4" fill="rgba(180,50,28,0.88)"/>`,
      `<text x="${cardX + 52}" y="${cardY + 28}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">BEFORE</text>`,
    );
    if (hasAfter) {
      svgParts.push(
        `<rect x="${afterX + 10}" y="${cardY + 10}" width="74" height="26" rx="4" fill="rgba(34,122,68,0.9)"/>`,
        `<text x="${afterX + 47}" y="${cardY + 28}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">AFTER</text>`,
      );
    }

    // Caption bar below pair
    svgParts.push(
      `<rect x="${cardX}" y="${cardY + imgH + 8}" width="${cardW}" height="${captionH - 12}" rx="6" fill="#ffffff"/>`,
      `<text x="${cardX + cardW / 2}" y="${cardY + imgH + 35}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="19" font-weight="600" fill="#1f1c18">${xmlEscape(pair.caption)}</text>`,
    );
  }

  svgParts.push('</svg>');
  const svgOverlay = Buffer.from(svgParts.join(''));

  const outBuf = await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 244, g: 239, b: 232, alpha: 1 },
    },
  })
    .composite([...overlays, { input: svgOverlay, left: 0, top: 0 }])
    .flatten({ background: '#f4efe8' })
    .jpeg({ quality: 90 })
    .toBuffer();

  const outPath = path.join(dir, 'inspector-sheet.jpg');
  await writeFileAtomic(outPath, outBuf);
  return path.relative(REPO_ROOT, outPath);
}

async function main(): Promise<void> {
  if (process.argv.includes('--sheet-only')) {
    const sheetPath = await buildInspectorSheet();
    console.log(`Built inspector sheet: ${sheetPath}`);
    return;
  }

  const ledgerBefore = await ledgerTotal();
  const savedImages: string[] = [];

  try {
    console.log('1. Loading real items for 4 looks (2 men, 2 women)...');
    const fixtureRaw = fs.readFileSync(path.join(REPO_ROOT, 'public/fixture.json'), 'utf8');
    const fixture = JSON.parse(fixtureRaw) as { outfits: Outfit[] };
    const fxPieces = fixture.outfits[0].pieces;

    const [
      menShirt,
      menChino,
      menLoafers,
      menPolo,
      menSneakers,
      womenDress,
      womenHeels,
      womenSweater,
      womenTrousers,
      womenBoots,
    ] = await Promise.all([
      pickFirst("men's oxford shirt", 'men', fxPieces[0].item),
      pickFirst("men's chino pants", 'men', fxPieces[1].item),
      pickFirst("men's leather loafers", 'men', fxPieces[2].item),
      pickFirst("men's knit polo", 'men', fxPieces[0].item),
      pickFirst("men's white sneakers", 'men', fxPieces[2].item),
      pickFirst("women's midi dress", 'women'),
      pickFirst("women's heeled sandals", 'women'),
      pickFirst("women's knit sweater", 'women'),
      pickFirst("women's wide leg pants", 'women'),
      pickFirst("women's leather boots", 'women'),
    ]);

    const looks: Array<{ id: string; outfit: Outfit }> = [
      {
        id: 'good-1-men-oxford',
        outfit: {
          number: 1,
          name: 'Men Oxford + Chino + Loafers',
          difference: '',
          story: '',
          pieces: [
            { slot: 'top', why: '', item: menShirt },
            { slot: 'bottom', why: '', item: menChino },
            { slot: 'shoes', why: '', item: menLoafers },
          ],
          total: menShirt.price + menChino.price + menLoafers.price,
        },
      },
      {
        id: 'good-2-men-polo',
        outfit: {
          number: 2,
          name: 'Men Polo + Chino + Sneakers',
          difference: '',
          story: '',
          pieces: [
            { slot: 'top', why: '', item: menPolo },
            { slot: 'bottom', why: '', item: menChino },
            { slot: 'shoes', why: '', item: menSneakers },
          ],
          total: menPolo.price + menChino.price + menSneakers.price,
        },
      },
      {
        id: 'good-3-women-dress',
        outfit: {
          number: 3,
          name: 'Women Midi Dress + Sandals',
          difference: '',
          story: '',
          pieces: [
            { slot: 'dress', why: '', item: womenDress },
            { slot: 'shoes', why: '', item: womenHeels },
          ],
          total: womenDress.price + womenHeels.price,
        },
      },
      {
        id: 'good-4-women-sweater',
        outfit: {
          number: 4,
          name: 'Women Sweater + Trousers + Boots',
          difference: '',
          story: '',
          pieces: [
            { slot: 'top', why: '', item: womenSweater },
            { slot: 'bottom', why: '', item: womenTrousers },
            { slot: 'shoes', why: '', item: womenBoots },
          ],
          total: womenSweater.price + womenTrousers.price + womenBoots.price,
        },
      },
    ];

    // Ensure test shoppers exist before running parallel try-ons
    const [menShopperRaw, womenShopperRaw] = await Promise.all([
      getTestShopper('men'),
      getTestShopper('women'),
    ]);
    const [menShopper, womenShopper] = await Promise.all([
      prepareShopperJpeg(menShopperRaw, 'men'),
      prepareShopperJpeg(womenShopperRaw, 'women'),
    ]);

    console.log('2. Running 4 GOOD try-ons via full tryOn() pipeline...');
    const goodResults = await Promise.all(
      looks.map(async ({ id, outfit }) => {
        const res = await tryOn(null, outfit, { label: id });
        const buf = await fs.promises.readFile(res.path);
        const saved = await saveInspectorImg(`inspector-${id}.jpg`, buf);
        savedImages.push(saved);
        return { id, outfit, res, buf, saved };
      }),
    );

    const rows: CaseRow[] = [];
    const goodAddedMs: number[] = [];

    for (const g of goodResults) {
      const check = g.res.check;
      const flagged = Boolean(
        (check && !check.passed) ||
          check?.inspector?.verdict === 'redo' ||
          (check?.attempts ?? 1) > 1,
      );
      goodAddedMs.push((check?.ms_gate ?? 0) + (check?.ms_inspector ?? 0));
      rows.push({
        name: g.id,
        expected: 'GOOD',
        gate: check?.gate ?? null,
        inspector: check?.inspector ?? null,
        flagged,
        redoFixed: check?.attempts === 2 ? (check.passed ? 'yes' : 'no') : '-',
        msGate: check?.ms_gate ?? 0,
        msInspect: check?.ms_inspector ?? 0,
        savedPaths: [g.saved],
      });
    }

    // Prepare Look 1 clean pieces & contact sheet for BAD cases
    const look1 = looks[0].outfit;
    const look1Sorted = sortPiecesForTryOn(look1.pieces);
    const look1Bufs = (await Promise.all(look1Sorted.map((p) => loadPieceForTryOn(p)))).filter(
      (b): b is Buffer => b !== null,
    );
    const look1Sheet = await buildContactSheet(look1Bufs);

    console.log('3. Generating 4 synthetic BAD cases (extra, wrong face, missing piece, colour mismatch)...');
    const altShopper = await prepareShopperJpeg(await getAltMenShopper(), 'men');

    const [badA, badB, badC] = await Promise.all([
      // (a) extra belt + baseball cap
      generateCustomTryOn(menShopper, look1.pieces, {
        extraPrompt:
          'Also wearing a wide black leather belt with a prominent silver buckle and a dark baseball cap on the head.',
      }),
      // (b) wrong person (alt shopper)
      generateCustomTryOn(altShopper, look1.pieces),
      // (c) drop shoes piece (barefoot)
      generateCustomTryOn(
        menShopper,
        look1.pieces.filter((p) => p.slot !== 'shoes'),
        { forceBarefoot: true },
      ),
    ]);

    // (d) colour mismatch: take good-1 try-on (white oxford) and swap the top in the list + sheet to bright crimson red
    const redShirtItem: Item = {
      ...menShirt,
      title: menShirt.title.replace(/white|bone|cream|ivory|light/gi, 'Bright Red') || 'Bright Crimson Red Oxford Shirt',
      description: 'Vibrant bright crimson red cotton oxford button-down shirt.',
    };
    if (!/red/i.test(redShirtItem.title)) {
      redShirtItem.title = `Bright Red ${redShirtItem.title}`;
    }
    const redTopBuf = await sharp(look1Bufs[0])
      .tint({ r: 215, g: 35, b: 35 })
      .jpeg({ quality: 88 })
      .toBuffer();
    const badDPieces: Piece[] = [
      { slot: 'top', why: '', item: redShirtItem },
      ...look1Sorted.slice(1),
    ];
    const badDSheet = await buildContactSheet([redTopBuf, ...look1Bufs.slice(1)]);

    const [pathBadA, pathBadB, pathBadC, pathBadD] = await Promise.all([
      saveInspectorImg('inspector-bad-a-extra.jpg', badA.tryonBuf),
      saveInspectorImg('inspector-bad-b-face.jpg', badB.tryonBuf),
      saveInspectorImg('inspector-bad-c-missing.jpg', badC.tryonBuf),
      saveInspectorImg('inspector-bad-d-colour.jpg', goodResults[0].buf),
    ]);
    savedImages.push(pathBadA, pathBadB, pathBadC, pathBadD);

    const badCases = [
      {
        name: 'bad-a-extra',
        tryonBuf: badA.tryonBuf,
        shopperBuf: menShopper,
        pieces: look1Sorted,
        sheet: look1Sheet,
        savedPath: pathBadA,
        redoShopper: menShopper,
        redoPieces: look1.pieces,
        redoSheet: look1Sheet,
      },
      {
        name: 'bad-b-face',
        tryonBuf: badB.tryonBuf,
        shopperBuf: menShopper, // inspected against ORIGINAL shopper!
        pieces: look1Sorted,
        sheet: look1Sheet,
        savedPath: pathBadB,
        redoShopper: menShopper,
        redoPieces: look1.pieces,
        redoSheet: look1Sheet,
      },
      {
        name: 'bad-c-missing',
        tryonBuf: badC.tryonBuf,
        shopperBuf: menShopper,
        pieces: look1Sorted, // full list INCLUDING shoes!
        sheet: look1Sheet,
        savedPath: pathBadC,
        redoShopper: menShopper,
        redoPieces: look1.pieces,
        redoSheet: look1Sheet,
      },
      {
        name: 'bad-d-colour',
        tryonBuf: goodResults[0].buf, // white shirt try-on
        shopperBuf: menShopper,
        pieces: badDPieces, // bright red shirt in list!
        sheet: badDSheet,
        savedPath: pathBadD,
        redoShopper: menShopper,
        redoPieces: badDPieces,
        redoSheet: badDSheet,
        overridePieceBufs: new Map<number, Buffer>([[0, redTopBuf]]),
      },
    ];

    // 4. Benchmark gemini-4-argon vs gemini-4-carbon on the same real cases (2 good + 4 bad)
    console.log('4. Benchmarking gemini-4-argon vs gemini-4-carbon (thinkingLevel=LOW)...');
    const look3Sorted = sortPiecesForTryOn(looks[2].outfit.pieces);
    const look3Bufs = (await Promise.all(look3Sorted.map((p) => loadPieceForTryOn(p)))).filter(
      (b): b is Buffer => b !== null,
    );
    const look3Sheet = await buildContactSheet(look3Bufs);

    const benchInputs = [
      {
        name: 'good-1-men-oxford',
        expected: 'show' as const,
        input: {
          shopperJpeg: menShopper,
          tryonJpeg: goodResults[0].buf,
          contactSheetJpeg: look1Sheet,
          pieces: look1Sorted,
        },
      },
      {
        name: 'good-3-women-dress',
        expected: 'show' as const,
        input: {
          shopperJpeg: womenShopper,
          tryonJpeg: goodResults[2].buf,
          contactSheetJpeg: look3Sheet,
          pieces: look3Sorted,
        },
      },
      ...badCases.map((bc) => ({
        name: bc.name,
        expected: 'redo' as const,
        input: {
          shopperJpeg: bc.shopperBuf,
          tryonJpeg: bc.tryonBuf,
          contactSheetJpeg: bc.sheet,
          pieces: bc.pieces,
        },
      })),
    ];

    const benchModels = ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-argon'];
    const benchStats: Record<string, { ms: number[]; right: number; total: number; errors: number }> =
      {};

    console.log('\n--- MODEL BENCHMARK (gemini-4-carbon vs gemini-4-neon vs gemini-4-argon) ---');
    console.log(
      `${'Model'.padEnd(18)} ${'Case'.padEnd(20)} ${'Exp'.padEnd(5)} ${'Got'.padEnd(5)} ${'ms'.padStart(6)}  Problems`,
    );

    for (const model of benchModels) {
      benchStats[model] = { ms: [], right: 0, total: benchInputs.length, errors: 0 };
      const results = await Promise.all(
        benchInputs.map(async (b) => {
          const r = await runTryOnInspector(b.input, { model, timeoutMs: 25_000 });
          return { b, r };
        }),
      );
      for (const { b, r } of results) {
        benchStats[model].ms.push(r.ms);
        const got = r.result?.verdict ?? 'ERR';
        if (!r.result) benchStats[model].errors += 1;
        if (got === b.expected) benchStats[model].right += 1;
        const probs = r.result
          ? r.result.problems.map((p) => `${p.kind}: ${p.detail}`).join('; ') || '(none)'
          : r.error || 'error';
        console.log(
          `${model.padEnd(18)} ${b.name.padEnd(20)} ${b.expected.padEnd(5)} ${got.padEnd(5)} ${String(r.ms).padStart(6)}  ${probs.slice(0, 90)}`,
        );
      }
    }

    console.log('\nBenchmark summary:');
    for (const model of benchModels) {
      const s = benchStats[model];
      console.log(
        `  ${model}: ${s.right}/${s.total} correct, median=${median(s.ms)}ms, min=${Math.min(...s.ms)}ms, max=${Math.max(...s.ms)}ms, errors=${s.errors}`,
      );
    }

    // 5. Run full gate + inspector + redo loop on each BAD case in parallel
    const activeInspector = process.env.ALICE_MODEL_INSPECTOR || 'gemini-4-neon';
    console.log(`\n5. Evaluating 4 BAD cases through gate + ${activeInspector} + redo loop...`);

    const badCaseRows = await Promise.all(
      badCases.map(async (bc): Promise<CaseRow> => {
        const inspectInput = {
          shopperJpeg: bc.shopperBuf,
          tryonJpeg: bc.tryonBuf,
          contactSheetJpeg: bc.sheet,
          pieces: bc.pieces,
        };

        const gRes = await runTryOnGate(inspectInput);
        const shouldInspect = !gRes.scores || needsInspector(gRes.scores);
        let inspRes: { result: TryOnInspectorResult | null; ms: number } = { result: null, ms: 0 };
        if (shouldInspect) {
          inspRes = await runTryOnInspector(inspectInput, { model: activeInspector });
        }

        const caught = Boolean(
          (gRes.scores && !gatePassed(gRes.scores)) || inspRes.result?.verdict === 'redo',
        );

        let redoFixed = '-';
        const casePaths = [bc.savedPath];

        if (inspRes.result?.verdict === 'redo') {
          const correction = `Correction from the inspector: ${inspRes.result.fix}`;
          const redo = await generateCustomTryOn(bc.redoShopper, bc.redoPieces, {
            extraPrompt: correction,
            overridePieceBufs: (bc as { overridePieceBufs?: Map<number, Buffer> }).overridePieceBufs,
          });
          const fixedPath = await saveInspectorImg(`inspector-${bc.name}-fixed.jpg`, redo.tryonBuf);
          savedImages.push(fixedPath);
          casePaths.push(fixedPath);

          const g2 = await runTryOnGate({
            shopperJpeg: bc.redoShopper,
            tryonJpeg: redo.tryonBuf,
            contactSheetJpeg: bc.redoSheet,
            pieces: bc.pieces,
          });
          const fixedOk = g2.scores ? gatePassed(g2.scores) : false;
          redoFixed = `${fixedOk ? 'yes' : 'no'} (${fmtProbs(g2.scores)})`;
        }

        return {
          name: bc.name,
          expected: 'BAD',
          gate: gRes.scores,
          inspector: inspRes.result,
          flagged: caught,
          redoFixed,
          msGate: gRes.ms,
          msInspect: inspRes.ms,
          savedPaths: casePaths,
        };
      }),
    );
    rows.push(...badCaseRows);

    // 6. Print confusion table & summary
    console.log('\n--- CONFUSION TABLE ---');
    console.log(
      `${'Case'.padEnd(22)} ${'Exp'.padEnd(4)} ${'Gate Probabilities'.padEnd(32)} ${'Insp'.padEnd(5)} ${'GateMs'.padStart(6)} ${'InspMs'.padStart(6)}  Redo Fixed`,
    );
    console.log('-'.repeat(108));
    for (const r of rows) {
      const verdict = r.inspector ? r.inspector.verdict : 'skip';
      console.log(
        `${r.name.padEnd(22)} ${r.expected.padEnd(4)} ${fmtProbs(r.gate).padEnd(32)} ${verdict.padEnd(5)} ${String(r.msGate).padStart(6)} ${String(r.msInspect).padStart(6)}  ${r.redoFixed}`,
      );
    }

    const badRows = rows.filter((r) => r.expected === 'BAD');
    const goodRows = rows.filter((r) => r.expected === 'GOOD');
    const caughtBad = badRows.filter((r) => r.flagged).length;
    const wronglyFlaggedGood = goodRows.filter((r) => r.flagged).length;
    const ledgerAfter = await ledgerTotal();
    const runCost = Math.max(0, ledgerAfter.usd - ledgerBefore.usd);

    console.log('\n--- SUMMARY ---');
    console.log(`Caught: ${caughtBad} of ${badRows.length} bad`);
    console.log(`Wrongly flagged: ${wronglyFlaggedGood} of ${goodRows.length} good`);
    console.log(`Median added time on good cases: ${median(goodAddedMs)} ms`);
    console.log(`Cost of this run: $${runCost.toFixed(4)} (total ledger: $${ledgerAfter.usd.toFixed(4)})`);
    const sheetPath = await buildInspectorSheet();
    savedImages.push(sheetPath);

    console.log('\nSaved images:');
    for (const p of savedImages) {
      console.log(`  ${p}`);
    }
  } finally {
    stopMedia();
  }
}

await main();
