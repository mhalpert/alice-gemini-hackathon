import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { BoardBoxes, Outfit, Piece } from '../types.ts';
import type { BoardCell, PlacedBoardPiece } from './pure.ts';
import {
  BOARD_GUTTER,
  BOARD_H,
  BOARD_W,
  boardFileName,
  computeBoardBoxes,
  layoutBoardCells,
  publicUrl,
  tryonDir,
  withWidth,
} from './pure.ts';
import { fetchImageBuffer, getProductShot, writeFileAtomic } from './shots.ts';

const BOARD_BG = { r: 244, g: 239, b: 232, alpha: 1 };
const BOARD_BG_HEX = '#f4efe8';

export interface BuiltCollage {
  url: string;
  path: string;
  boxes: BoardBoxes;
}

interface PreparedOverlay {
  slot: string;
  input: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
  blend: 'multiply';
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
  cell: BoardCell,
  slot: string,
): Promise<PreparedOverlay | null> {
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
      slot,
      input: data,
      left,
      top,
      width: info.width,
      height: info.height,
      blend: 'multiply',
    };
  } catch {
    return null;
  }
}

export async function buildCollage(outfit: Outfit, label?: string): Promise<BuiltCollage | null> {
  const t0 = Date.now();
  try {
    const pieces = Array.isArray(outfit?.pieces) ? outfit.pieces : [];
    if (pieces.length === 0) {
      return null;
    }

    const cells = layoutBoardCells(pieces.length, BOARD_W, BOARD_H, BOARD_GUTTER);
    const prepared = (
      await Promise.all(
        pieces.map(async (piece, idx) => {
          const buf = await loadPieceBuffer(piece);
          if (!buf) return null;
          return prepareCellOverlay(buf, cells[idx], piece.slot);
        }),
      )
    ).filter((o): o is PreparedOverlay => o !== null);

    if (prepared.length === 0) {
      return null;
    }

    const overlays = prepared.map((o) => ({
      input: o.input,
      left: o.left,
      top: o.top,
      blend: o.blend,
    }));

    const placements: PlacedBoardPiece[] = prepared.map((o) => ({
      slot: o.slot,
      left: o.left,
      top: o.top,
      width: o.width,
      height: o.height,
    }));
    const boxes = computeBoardBoxes(placements, BOARD_W, BOARD_H);

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
    return {
      url: publicUrl(name),
      path: filePath,
      boxes,
    };
  } catch (err) {
    console.error('[media] collage error:', (err as Error)?.message);
    return null;
  }
}
