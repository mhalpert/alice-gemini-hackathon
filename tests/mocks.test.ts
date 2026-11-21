import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { outfitCollage, productImages, productShot, setCallRoom, warmMedia } from '../src/media/index.ts';
import { tryOn } from '../src/tryon.ts';
import type { Outfit } from '../src/types.ts';

interface FixtureFile {
  outfits: Outfit[];
}

describe('media and try-on exported contract', () => {
  let prevCleanShots: string | undefined;
  let outfit: Outfit;

  before(() => {
    prevCleanShots = process.env.ALICE_CLEAN_SHOTS;
    process.env.ALICE_CLEAN_SHOTS = 'off';
    const raw = fs.readFileSync(new URL('../public/fixture.json', import.meta.url), 'utf8');
    const fixture = JSON.parse(raw) as FixtureFile;
    outfit = fixture.outfits[0];
    assert.ok(outfit && outfit.pieces.length > 0, 'fixture should contain at least one outfit');
  });

  after(() => {
    if (prevCleanShots === undefined) {
      delete process.env.ALICE_CLEAN_SHOTS;
    } else {
      process.env.ALICE_CLEAN_SHOTS = prevCleanShots;
    }
  });

  it('exports the expected functions and honors ALICE_CLEAN_SHOTS=off', async () => {
    assert.equal(typeof productShot, 'function');
    assert.equal(typeof outfitCollage, 'function');
    assert.equal(typeof productImages, 'function');
    assert.equal(typeof warmMedia, 'function');
    assert.equal(typeof setCallRoom, 'function');
    assert.equal(typeof tryOn, 'function');

    const piece = outfit.pieces[0];
    const res = await productShot(piece.item, piece.slot);
    assert.deepEqual(res, {
      buf: null,
      url: piece.item.image,
      source: 'original',
    });
  });
});
