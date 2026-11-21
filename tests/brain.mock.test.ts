// Checks the Outfits mock against the buildOutfits / swapPiece contracts.
process.env.ALICE_MOCK_PACE = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutfits, swapPiece } from '../src/brain/index.ts';
import type { Brief, Outfit } from '../src/types.ts';

const brief: Brief = { gender: 'men', occasion: "a friend's rooftop birthday", budget_usd: 150 };
const total = (o: Outfit) => Math.round(o.pieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;

test('buildOutfits streams three numbered looks in order, then returns them', async () => {
  const seen: [number, number | undefined][] = [];
  const result = await buildOutfits(brief, { onOutfit: (o, i) => seen.push([i, o.number]) });
  assert.deepEqual(seen, [[0, 1], [1, 2], [2, 3]]);
  assert.equal(result.outfits.length, 3);
  assert.equal(result.source, 'library');
  assert.ok(result.timing.first_outfit_ms <= result.timing.total_ms);
  assert.ok(Array.isArray(result.problems));
});

test('buildOutfits survives a throwing onOutfit and reports it', async () => {
  const result = await buildOutfits(brief, { onOutfit: () => { throw new Error('page down'); } });
  assert.equal(result.outfits.length, 3);
  assert.ok(result.problems.some((p) => p.includes('page down')));
});

test('buildOutfits flags a department the fixture does not cover', async () => {
  const result = await buildOutfits({ ...brief, gender: 'women' });
  assert.ok(result.problems.some((p) => p.includes("men's looks")));
});

test('callers cannot corrupt the fixture by mutating a result', async () => {
  const a = await buildOutfits(brief);
  a.outfits[0].pieces.length = 0;
  const b = await buildOutfits(brief);
  assert.ok(b.outfits[0].pieces.length > 0);
});

test('a colour swap returns that colour: brown shoes', async () => {
  const { outfits } = await buildOutfits(brief);
  const { outfit, piece, note } = await swapPiece(outfits[0], 'shoes', 'swap the white sneakers for brown boots', brief);
  assert.equal(note, undefined);
  assert.equal(piece.slot, 'shoes');
  assert.match(piece.item.title.toLowerCase(), /brown|tan|cognac|chocolate|camel/);
  assert.equal(outfit.pieces.find((p) => p.slot === 'shoes')!.item.id, piece.item.id);
  assert.equal(outfit.total, total(outfit));
});

test('"something cheaper" lowers the total', async () => {
  const { outfits } = await buildOutfits(brief);
  const before = outfits[1];
  const { outfit, note } = await swapPiece(before, 'shoes', 'something cheaper', brief);
  assert.equal(note, undefined);
  assert.ok(outfit.total < before.total);
  assert.equal(outfit.total, total(outfit));
});

test('an impossible colour keeps the piece and says so honestly', async () => {
  const { outfits } = await buildOutfits(brief);
  const before = outfits[0];
  const { outfit, piece, note } = await swapPiece(before, 'shoes', 'pink shoes', brief);
  assert.ok(note && /no shoes in pink/i.test(note));
  assert.equal(piece.item.id, before.pieces.find((p) => p.slot === 'shoes')!.item.id);
  assert.equal(outfit.total, before.total);
});

test('a slot the look does not have changes nothing', async () => {
  const { outfits } = await buildOutfits(brief);
  const { outfit, note } = await swapPiece(outfits[0], 'dress', 'a red dress', brief);
  assert.ok(note && note.includes('no dress'));
  assert.deepEqual(outfit, outfits[0]);
});

test('swapPiece never mutates the outfit it was given', async () => {
  const { outfits } = await buildOutfits(brief);
  const snapshot = structuredClone(outfits[0]);
  await swapPiece(outfits[0], 'shoes', 'brown', brief);
  assert.deepEqual(outfits[0], snapshot);
});

test('with a room, build and swap events land in the shared call log', async () => {
  const { mkdtempSync, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getCallLogPath } = await import('../src/calllog.ts');
  process.env.ALICE_LOG_DIR = mkdtempSync(join(tmpdir(), 'alice-log-'));
  try {
    const room = 'test-brain-room';
    const { outfits } = await buildOutfits(brief, { room });
    await swapPiece(outfits[0], 'shoes', 'brown', brief, { room });
    const events = read(getCallLogPath(room), 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev);
    assert.deepEqual(events, ['build_start', 'build_outfit', 'build_outfit', 'build_outfit', 'build_done', 'swap_start', 'swap_done']);
  } finally {
    delete process.env.ALICE_LOG_DIR;
  }
});
