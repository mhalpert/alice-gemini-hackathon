import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { outfitCollage, productImages, productShot } from '../src/media/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { Outfit } from '../src/types.ts';

interface FixtureFile {
  outfits: Outfit[];
}

describe('media and try-on mocks', () => {
  let prevTryonMs: string | undefined;
  let outfit: Outfit;

  before(() => {
    prevTryonMs = process.env.ALICE_MOCK_TRYON_MS;
    process.env.ALICE_MOCK_TRYON_MS = '10';
    const raw = fs.readFileSync(new URL('../public/fixture.json', import.meta.url), 'utf8');
    const fixture = JSON.parse(raw) as FixtureFile;
    outfit = fixture.outfits[0];
    assert.ok(outfit && outfit.pieces.length > 0, 'fixture should contain at least one outfit');
  });

  after(() => {
    if (prevTryonMs === undefined) {
      delete process.env.ALICE_MOCK_TRYON_MS;
    } else {
      process.env.ALICE_MOCK_TRYON_MS = prevTryonMs;
    }
  });

  it('productShot resolves with original item image', async () => {
    const piece = outfit.pieces[0];
    const res = await productShot(piece.item, piece.slot);
    assert.deepEqual(res, {
      buf: null,
      url: piece.item.image,
      source: 'original',
    });
  });

  it('outfitCollage resolves with first piece image URL', async () => {
    const url = await outfitCollage(outfit, outfit.name);
    assert.equal(url, outfit.pieces[0].item.image);
  });

  it('productImages resolves with array containing item image', async () => {
    const item = outfit.pieces[0].item;
    const imgs = await productImages(item);
    assert.deepEqual(imgs, [item.image]);
  });

  it('tryOn resolves with documented shape', async () => {
    const res = await tryOn(null, outfit, { label: outfit.name });
    assert.equal(res.url, outfit.pieces[0].item.image);
    assert.equal(res.path, '');
    assert.equal(typeof res.ms, 'number');
    assert.ok(res.ms >= 0);
    assert.equal(typeof res.id, 'string');
    assert.ok(res.id.length > 0);
  });
});
