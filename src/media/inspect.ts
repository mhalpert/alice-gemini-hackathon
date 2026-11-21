import sharp from 'sharp';
import { recordCost } from '../ledger.ts';
import type { Piece } from '../types.ts';
import {
  parseInspectorReply,
  stripHtml,
  type TryOnGateScores,
  type TryOnInspectorResult,
} from './pure.ts';
import { getGenAI } from './shots.ts';

const DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_GATE_MODEL = 'gemini-decision-1';
const DEFAULT_INSPECTOR_MODEL = 'gemini-4-neon';
const GATE_TIMEOUT_MS = 2000;
const INSPECTOR_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function buildContactSheet(pieceBufs: Buffer[]): Promise<Buffer> {
  const valid = pieceBufs.filter((b) => Buffer.isBuffer(b) && b.length > 0);
  if (valid.length === 0) {
    return sharp({
      create: { width: 256, height: 256, channels: 3, background: '#ffffff' },
    })
      .jpeg({ quality: 82 })
      .toBuffer();
  }

  const tileSize = 256;
  const gap = 12;
  const cols = Math.min(valid.length, 4);
  const rows = Math.ceil(valid.length / cols);
  const canvasW = cols * tileSize + (cols + 1) * gap;
  const canvasH = rows * tileSize + (rows + 1) * gap;

  const tiles = await Promise.all(
    valid.map((buf) =>
      sharp(buf)
        .rotate()
        .resize(tileSize, tileSize, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 84 })
        .toBuffer(),
    ),
  );

  const overlays = tiles.map((input, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    return {
      input,
      left: gap + col * (tileSize + gap),
      top: gap + row * (tileSize + gap),
    };
  });

  return sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: '#ffffff' },
  })
    .composite(overlays)
    .jpeg({ quality: 84 })
    .toBuffer();
}

async function shrinkForVision(buf: Buffer, maxSide = 512): Promise<string> {
  const resized = await sharp(buf)
    .rotate()
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82 })
    .toBuffer();
  return resized.toString('base64');
}

export function formatPiecesForInspect(pieces: Piece[]): {
  listText: string;
  hasBottom: boolean;
  hasShoes: boolean;
} {
  let hasBottom = false;
  let hasShoes = false;
  const lines = pieces.map((p, idx) => {
    const slotKey = p.slot.trim().toLowerCase();
    if (slotKey === 'bottom' || slotKey === 'dress' || slotKey === 'suit') {
      hasBottom = true;
    }
    if (slotKey === 'shoes') {
      hasShoes = true;
    }
    const desc = stripHtml(p.item.description, 160);
    return `${idx + 1}. ${p.slot}: "${p.item.title}"${desc ? ` (${desc})` : ''}`;
  });
  return {
    listText: lines.join('\n'),
    hasBottom,
    hasShoes,
  };
}

export interface TryOnInspectInput {
  shopperJpeg: Buffer;
  tryonJpeg: Buffer;
  contactSheetJpeg: Buffer;
  pieces: Piece[];
}

export async function runTryOnGate(
  input: TryOnInspectInput,
  opts?: { timeoutMs?: number; model?: string },
): Promise<{ scores: TryOnGateScores | null; ms: number; error?: string }> {
  const t0 = Date.now();
  const model = opts?.model || process.env.ALICE_MODEL_GATE || DEFAULT_GATE_MODEL;
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.ALICE_TRYON_GATE_TIMEOUT_MS ?? GATE_TIMEOUT_MS);

  try {
    const key = process.env.GOOGLE_TRYON_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('missing API key');

    const [shopperB64, tryonB64, sheetB64] = await Promise.all([
      shrinkForVision(input.shopperJpeg, 512),
      shrinkForVision(input.tryonJpeg, 512),
      shrinkForVision(input.contactSheetJpeg, 768),
    ]);

    const { listText, hasBottom, hasShoes } = formatPiecesForInspect(input.pieces);
    const allowanceNotes = [
      !hasBottom ? 'No bottom piece is listed, so keeping the bottoms from Image 1 is expected.' : '',
      !hasShoes ? 'No shoes piece is listed, so plain white minimalist sneakers are expected.' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const decisionInput: object[] = [
      {
        type: 'text',
        text: `Evaluate a virtual try-on image. Listed outfit pieces:\n${listText}${allowanceNotes ? `\n${allowanceNotes}` : ''}`,
      },
      { type: 'text', text: 'Image 1 — Shopper reference photo (the person):' },
      { type: 'image', data: shopperB64, mime_type: 'image/jpeg' },
      { type: 'text', text: 'Image 2 — Generated try-on photo to evaluate:' },
      { type: 'image', data: tryonB64, mime_type: 'image/jpeg' },
      { type: 'text', text: 'Image 3 — Contact sheet of the listed product shots:' },
      { type: 'image', data: sheetB64, mime_type: 'image/jpeg' },
    ];

    const res = await fetch(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        input: decisionInput,
        questions: {
          same_person: {
            type: 'noul',
            instructions:
              'Is the person in Image 2 (the try-on) clearly the exact same person as in Image 1 (the shopper photo): same face, hair, facial hair or lack thereof, skin tone, and body build? Answer no if a different person, face, beard, or build appears.',
          },
          all_pieces: {
            type: 'noul',
            instructions:
              'Does Image 2 show every single listed piece from the outfit list and Image 3 (such as the listed top, bottom, dress, layer, shoes, or accessories) clearly worn and in frame? Answer no if any listed piece is missing or replaced by something completely different.',
          },
          no_extras: {
            type: 'noul',
            instructions:
              'Is the person in Image 2 free of extra unlisted items that were not in the outfit list (such as an unlisted belt, baseball cap, hat, bag, sunglasses, scarf, jacket, or jewellery)? Keep in mind any stated allowance for unlisted bottoms or white sneakers. Answer no if any unlisted item was added.',
          },
          colours_match: {
            type: 'noul',
            instructions:
              'Do the colours of every worn garment and shoe in Image 2 match the colours described in the piece list and shown in Image 3? Answer no if any garment or shoe has the wrong colour.',
          },
        },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      usage?: { input_tokens?: number };
      usageMetadata?: { promptTokenCount?: number };
      answers?: Record<string, { noul?: number }>;
    };

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? 'decisions failed'}`.slice(0, 200));
    }

    const ms = Date.now() - t0;
    void recordCost({
      model,
      job: 'tryon-gate',
      input_tokens: body?.usage?.input_tokens ?? body?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: 0,
      ms,
    });

    const same_person = Number(body?.answers?.same_person?.noul);
    const all_pieces = Number(body?.answers?.all_pieces?.noul);
    const no_extras = Number(body?.answers?.no_extras?.noul);
    const colours_match = Number(body?.answers?.colours_match?.noul);

    if (
      !Number.isFinite(same_person) ||
      !Number.isFinite(all_pieces) ||
      !Number.isFinite(no_extras) ||
      !Number.isFinite(colours_match)
    ) {
      throw new Error('decisions API returned non-numeric probabilities');
    }

    return {
      scores: { same_person, all_pieces, no_extras, colours_match },
      ms,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = (err as Error)?.message ?? String(err);
    console.error(`[media] tryon-gate skipped (${ms}ms): ${message}`);
    return { scores: null, ms, error: message };
  }
}

export async function runTryOnInspector(
  input: TryOnInspectInput,
  opts?: { model?: string; timeoutMs?: number; gateScores?: TryOnGateScores | null },
): Promise<{ result: TryOnInspectorResult | null; ms: number; error?: string }> {
  const t0 = Date.now();
  const model = opts?.model || process.env.ALICE_MODEL_INSPECTOR || DEFAULT_INSPECTOR_MODEL;
  const timeoutMs =
    opts?.timeoutMs ?? Number(process.env.ALICE_TRYON_INSPECT_TIMEOUT_MS ?? INSPECTOR_TIMEOUT_MS);

  try {
    const [shopperB64, tryonB64, sheetB64] = await Promise.all([
      shrinkForVision(input.shopperJpeg, 384),
      shrinkForVision(input.tryonJpeg, 384),
      shrinkForVision(input.contactSheetJpeg, 512),
    ]);

    const { listText, hasBottom, hasShoes } = formatPiecesForInspect(input.pieces);
    const allowanceLines = [
      !hasBottom
        ? '- No bottom piece is in the list, so keeping the shopper photo bottoms is EXPECTED and NOT a problem.'
        : '',
      !hasShoes
        ? '- No shoes piece is in the list, so plain white minimalist sneakers are EXPECTED and NOT a problem.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const prompt = [
      'You are the quality inspector for a live virtual try-on stylist.',
      'Compare Image 2 (the generated try-on) against Image 1 (the shopper reference) and Image 3 (contact sheet of the listed product shots).',
      '',
      'Listed outfit pieces (titles & colours):',
      listText,
      allowanceLines ? `\nAllowed defaults:\n${allowanceLines}` : '',
      '',
      'Check strictly for these defects:',
      '- face: wrong person, different face/age/gender/hair/beard/skin tone than Image 1.',
      '- body: shopper build significantly slimmed or altered from Image 1.',
      '- missing_piece: any listed garment or shoe is missing, swapped for the wrong footwear/garment, or omitted.',
      '- extra_item: any unlisted belt, baseball cap, hat, bag, scarf, sunglasses, jacket, or jewellery was added.',
      '- colour: a worn item clearly has the wrong colour compared to the listed title/description and Image 3.',
      '- framing: head or shoes cut off.',
      '',
      'Verdict rules:',
      '- Return "redo" if ANY clear defect above is present.',
      '- Return "show" ONLY if it is the same person wearing all listed pieces in the right colours with no unlisted extras and full-body framing (ignore minor lighting or fabric drape differences).',
      '- When verdict is "redo", write `fix` as 1-2 direct imperative sentences for the image generator (e.g. "Remove the black belt and baseball cap: neither is in this look. Keep everything else.").',
      '- When verdict is "show", return `problems: []` and `fix: ""`.',
      '',
      'Return JSON only: {"verdict": "show" | "redo", "problems": [{"kind": "face" | "missing_piece" | "extra_item" | "colour" | "body" | "framing", "detail": "..."}], "fix": "..."}',
    ].join('\n');

    const parts = [
      { text: 'Image 1: Shopper reference photo (the ONLY source for the person):' },
      { inlineData: { mimeType: 'image/jpeg', data: shopperB64 } },
      { text: 'Image 2: Generated try-on photo to inspect:' },
      { inlineData: { mimeType: 'image/jpeg', data: tryonB64 } },
      { text: 'Image 3: Contact sheet of the listed product shots:' },
      { inlineData: { mimeType: 'image/jpeg', data: sheetB64 } },
      { text: prompt },
    ];

    const r = await withTimeout(
      getGenAI().models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'LOW' as never },
        },
      }),
      timeoutMs,
      'tryon-inspect',
    );

    const ms = Date.now() - t0;
    void recordCost({
      model,
      job: 'tryon-inspect',
      input_tokens: r.usageMetadata?.promptTokenCount,
      output_tokens: r.usageMetadata?.candidatesTokenCount,
      ms,
    });

    const parsed = parseInspectorReply(r.text, model);
    if (!parsed) {
      throw new Error(`unparseable inspector JSON: ${(r.text ?? '').slice(0, 120)}`);
    }

    return { result: parsed, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = (err as Error)?.message ?? String(err);
    console.error(`[media] tryon-inspect failed (${model}, ${ms}ms): ${message}`);
    return { result: null, ms, error: message };
  }
}
