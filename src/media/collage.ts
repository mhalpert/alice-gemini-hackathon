import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Outfit, Piece } from '../types.ts';
import { boardFileName, publicUrl, tryonDir, withWidth } from './pure.ts';
import { fetchImageBuffer, getProductShot, writeFileAtomic } from './shots.ts';

const BOARD_W = 1200;
const BOARD_H = 900;
const GUTTER = 24;
const BOARD_BG = { r: 244, g: 239, b: 232, alpha: 1 };
const BOARD_BG_HEX = '#f4efe8';

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

function layoutCells(pieceCount: number): Cell[] {
  if (pieceCount <= 0) return [];
  if (pieceCount === 1) {
    return [
      {
        x: GUTTER,
        y: GUTTER,
        w: BOARD_W - 2 * GUTTER,
        h: BOARD_H - 2 * GUTTER,
      },
    ];
  }

  const halfW = Math.floor((BOARD_W - 3 * GUTTER) / 2);
  const innerH = BOARD_H - 2 * GUTTER;

  const cells: Cell[] = [
    {
      x: GUTTER,
      y: GUTTER,
      w: halfW,
      h: innerH,
    },
  ];

  const restCount = pieceCount - 1;
  const rightX = GUTTER + halfW + GUTTER;
  const rightW = BOARD_W - GUTTER - rightX;
  const cols = restCount <= 2 ? 1 : 2;
  const rows = Math.ceil(restCount / cols);
  const cellW = Math.floor((rightW - (cols - 1) * GUTTER) / cols);
  const cellH = Math.floor((innerH - (rows - 1) * GUTTER) / rows);

  for (let i = 0; i < restCount; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = row === rows - 1 ? restCount - row * cols : cols;
    const rowWidth = itemsInRow * cellW + (itemsInRow - 1) * GUTTER;
    const rowStartX = rightX + Math.floor((rightW - rowWidth) / 2);
    cells.push({
      x: rowStartX + col * (cellW + GUTTER),
      y: GUTTER + row * (cellH + GUTTER),
      w: cellW,
      h: cellH,
    });
  }

  return cells;
}

async function loadPieceBuffer(piece: Piece): Promise<Buffer | null> {
  try {
    if (process.env.ALICE_CLEAN_SHOTS !== 'off') {
      const shot = await getProductShot(piece.item, piece.slot);
      if (shot.filePath) {
        try {
          return await fs.promises.readFile(shot.filePath);
        } catch {
          // fall through to store image
        }
      }
    }
    if (typeof piece.item.image === 'string' && piece.item.image.length > 0) {
      return await fetchImageBuffer(withWidth(piece.item.image, 800), 5000);
    }
    return null;
  } catch {
    return null;
  }
}

async function prepareCellOverlay(
  buf: Buffer,
  cell: Cell,
): Promise<{ input: Buffer; left: number; top: number; blend: 'multiply' } | null> {
  try {
    const flatBuf = await sharp(buf).rotate().flatten({ background: '#ffffff' }).png().toBuffer();

    let trimmedBuf = flatBuf;
    try {
      const candidate = await sharp(flatBuf)
        .trim({ background: '#ffffff', threshold: 15 })
        .png()
        .toBuffer();
      const meta = await sharp(candidate).metadata();
      if ((meta.width ?? 0) >= 8 && (meta.height ?? 0) >= 8) {
        trimmedBuf = candidate;
      }
    } catch {
      // Trim can throw on uniform images; keep untrimmed
    }

    const targetW = Math.max(1, Math.floor(cell.w * 0.92));
    const targetH = Math.max(1, Math.floor(cell.h * 0.92));

    const { data, info } = await sharp(trimmedBuf)
      .resize(targetW, targetH, { fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer({ resolveWithObject: true });

    const left = cell.x + Math.floor((cell.w - info.width) / 2);
    const top = cell.y + Math.floor((cell.h - info.height) / 2);

    return {
      input: data,
      left,
      top,
      blend: 'multiply',
    };
  } catch {
    return null;
  }
}

export async function buildCollage(outfit: Outfit, label?: string): Promise<string | null> {
  const t0 = Date.now();
  try {
    const pieces = Array.isArray(outfit?.pieces) ? outfit.pieces : [];
    if (pieces.length === 0) {
      return null;
    }

    const cells = layoutCells(pieces.length);
    const overlays = (
      await Promise.all(
        pieces.map(async (piece, idx) => {
          const buf = await loadPieceBuffer(piece);
          if (!buf) return null;
          return prepareCellOverlay(buf, cells[idx]);
        }),
      )
    ).filter(
      (o): o is { input: Buffer; left: number; top: number; blend: 'multiply' } => o !== null,
    );

    if (overlays.length === 0) {
      return null;
    }

    const outBuf = await sharp({
      create: {
        width: BOARD_W,
        height: BOARD_H,
        channels: 4,
        background: BOARD_BG,
      },
    })
      .composite(overlays)
      .flatten({ background: BOARD_BG_HEX })
      .jpeg({ quality: 88 })
      .toBuffer();

    const name = boardFileName(outfit, label);
    const filePath = path.join(tryonDir(), name);
    await writeFileAtomic(filePath, outBuf);

    console.log(
      `[board] look ${outfit.number ?? label ?? '?'} ${overlays.length} pieces ${Date.now() - t0}ms`,
    );
    return publicUrl(name);
  } catch (err) {
    console.error('[media] collage error:', (err as Error)?.message);
    return null;
  }
}
