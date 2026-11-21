// Tests for curated occasion menu and offline word matching (no network).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Gender, Item, Outfit, Piece } from '../src/types.ts';
import {
  _setDeps,
  occasionMenu,
  matchOccasionWords,
  type LibraryFile,
  type LibrarySet,
} from '../src/library/index.ts';
import { OCCASIONS } from '../src/library/occasions.ts';
import { EXTRA_OCCASIONS } from '../src/library/occasions-extra.ts';

let seq = 0;
function makeItem(title: string, price: number, gender: Gender): Item {
  seq += 1;
  return {
    id: `prod-${seq}`,
    variant_id: `var-${seq}`,
    title,
    price,
    url: `https://example.com/p/${seq}`,
    image: `https://cdn.example.com/${seq}.jpg`,
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 15,
    sizes: ['S', 'M', 'L'],
    variants_by_size: {},
    description: title,
    department: gender,
  };
}

function makeOutfit(name: string, gender: Gender): Outfit {
  const pieces: Piece[] = [
    { slot: 'top', why: 'Clean top', item: makeItem(`${name} Shirt`, 40, gender) },
    { slot: 'bottom', why: 'Clean bottom', item: makeItem(`${name} Trousers`, 50, gender) },
    { slot: 'shoes', why: 'Clean shoes', item: makeItem(`${name} Loafers`, 60, gender) },
  ];
  return {
    name,
    difference: `Distinct ${name}`,
    story: `Look ${name}`,
    pieces,
    total: 150,
  };
}

const ALL_OCCASIONS = new Map([...OCCASIONS, ...EXTRA_OCCASIONS].map((o) => [o.key, o]));

function makeSet(key: string, gender: Gender, outfitCount = 2): LibrarySet {
  const def = ALL_OCCASIONS.get(key);
  const occasion = def?.occasion ?? key.replace(/-/g, ' ');
  const outfits = Array.from({ length: outfitCount }, (_, i) => makeOutfit(`${key}-${i + 1}`, gender));
  return {
    key,
    gender,
    occasion,
    budget_usd: 150,
    outfits,
    vectors: [[1, 0, 0]],
    built_ms: 100,
  };
}

const tempDirs: string[] = [];

function createTempLibrary(sets: LibrarySet[]): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'alice-menu-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'sets.json');
  const file: LibraryFile = {
    version: 1,
    built_at: new Date().toISOString(),
    sets,
  };
  writeFileSync(filePath, JSON.stringify(file), 'utf8');
  process.env.ALICE_LIBRARY_FILE = filePath;
  _setDeps({
    embed: async () => {
      throw new Error('embed must not be called by menu or offline word matching');
    },
    lookup: async () => {
      throw new Error('lookup must not be called by menu or offline word matching');
    },
    swap: async () => {
      throw new Error('swap must not be called by menu or offline word matching');
    },
  });
}

afterEach(() => {
  _setDeps(null);
  delete process.env.ALICE_LIBRARY_FILE;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test('matchOccasionWords matches expected occasions offline without calling network deps', async () => {
  const keys = [
    'rooftop-birthday',
    'first-date',
    'summer-wedding',
    'beach-wedding-guest',
    'interview-creative',
    'interview-bank',
    'business-casual',
    'brunch',
    'club',
    'festival',
    'beach',
    'gala',
    'backyard-barbecue',
    'karaoke-night',
  ];
  createTempLibrary([
    ...keys.map((k) => makeSet(k, 'women')),
    ...keys.map((k) => makeSet(k, 'men')),
  ]);

  const rooftop = await matchOccasionWords('women', "my buddy's bday on a roof");
  assert.ok(rooftop);
  assert.equal(rooftop.key, 'rooftop-birthday');
  assert.ok(rooftop.score >= 0.5);
  assert.ok(rooftop.label.length > 0);

  const beachWedding = await matchOccasionWords('women', "cousin's wedding on the beach");
  assert.ok(beachWedding);
  assert.equal(beachWedding.key, 'beach-wedding-guest');
  assert.ok(beachWedding.score >= 0.5);

  const bankInterview = await matchOccasionWords('men', 'interview at a bank');
  assert.ok(bankInterview);
  assert.equal(bankInterview.key, 'interview-bank');
  assert.ok(bankInterview.score >= 0.5);

  const goldmanInterview = await matchOccasionWords('men', 'job interview at Goldman');
  assert.ok(goldmanInterview);
  assert.equal(goldmanInterview.key, 'interview-bank');
  assert.ok(goldmanInterview.score >= 0.5);

  const wallStreet = await matchOccasionWords('men', 'wall street interview');
  assert.ok(wallStreet);
  assert.equal(wallStreet.key, 'interview-bank');

  const hedgeFund = await matchOccasionWords('men', 'interview at a hedge fund');
  assert.ok(hedgeFund);
  assert.equal(hedgeFund.key, 'interview-bank');

  const coachella = await matchOccasionWords('women', 'coachella');
  assert.ok(coachella);
  assert.equal(coachella.key, 'festival');
  assert.ok(coachella.score >= 0.5);

  const iceFishing = await matchOccasionWords('men', 'ice fishing');
  assert.equal(iceFishing, null);

  const partyOnly = await matchOccasionWords('women', 'party');
  assert.equal(partyOnly, null);
});

test('matchOccasionWords handles synonyms, generic-only queries, and stopwords', async () => {
  createTempLibrary([
    makeSet('gala', 'women'),
    makeSet('black-tie-wedding', 'women'),
    makeSet('club', 'women'),
    makeSet('brunch', 'women'),
    makeSet('office-holiday-party', 'women'),
  ]);

  const tux = await matchOccasionWords('women', 'I need something to wear for a tuxedo event');
  assert.ok(tux);
  assert.ok(tux.key === 'gala' || tux.key === 'black-tie-wedding');

  const gala = await matchOccasionWords('women', 'black tie gala');
  assert.ok(gala);
  assert.equal(gala.key, 'gala');

  const lunch = await matchOccasionWords('women', 'Sunday lunch with friends');
  assert.ok(lunch);
  assert.equal(lunch.key, 'brunch');

  const stopwordsOnly = await matchOccasionWords('women', "I'm going and need an outfit to wear");
  assert.equal(stopwordsOnly, null);

  const genericOnly = await matchOccasionWords('women', 'weekend dinner party');
  assert.equal(genericOnly, null);
});

test('black tie gala does not false-match interview-bank when gala is not servable', async () => {
  createTempLibrary([
    makeSet('interview-bank', 'men'),
    makeSet('opera-or-ballet-night', 'men'),
    makeSet('funeral-or-memorial', 'men'),
  ]);

  const res = await matchOccasionWords('men', 'black tie gala');
  assert.equal(res, null);
});

test('occasionMenu returns at most 15 entries in curated order and only servable keys', async () => {
  const womenKeys = [
    'graduation-ceremony',
    'rooftop-birthday',
    'club',
    'beach-wedding-guest',
    'coffee-date', // servable but not in curated menu
    'first-date',
  ];
  // Give 'brunch' only 1 outfit so it is NOT servable (< 2 outfits).
  createTempLibrary([
    ...womenKeys.map((k) => makeSet(k, 'women')),
    makeSet('brunch', 'women', 1),
    makeSet('fall-weekend', 'men'),
    makeSet('interview-bank', 'men'),
    makeSet('rooftop-birthday', 'men'),
    makeSet('gala', 'men'), // servable for men, but not in men's curated menu
  ]);

  const womenMenu = await occasionMenu('women');
  assert.ok(womenMenu.length <= 15);
  assert.deepEqual(womenMenu, [
    { key: 'rooftop-birthday', keyword: 'Birthday Party' },
    { key: 'first-date', keyword: 'First Date' },
    { key: 'beach-wedding-guest', keyword: 'Beach Wedding' },
    { key: 'club', keyword: 'Night Out' },
    { key: 'graduation-ceremony', keyword: 'Graduation' },
  ]);

  const menMenu = await occasionMenu('men');
  assert.ok(menMenu.length <= 15);
  assert.deepEqual(menMenu, [
    { key: 'rooftop-birthday', keyword: 'Birthday Party' },
    { key: 'interview-bank', keyword: 'Finance Interview' },
    { key: 'fall-weekend', keyword: 'Game Day' },
  ]);
});

test('occasionMenu caps at 15 entries when all curated keys and extra keys are servable', async () => {
  const allWomenCurated = [
    'rooftop-birthday',
    'first-date',
    'summer-wedding',
    'black-tie-wedding',
    'beach-wedding-guest',
    'interview-creative',
    'business-casual',
    'brunch',
    'club',
    'festival',
    'beach',
    'gala',
    'upscale-dinner-date',
    'office-holiday-party',
    'graduation-ceremony',
    'coffee-date',
    'movie-night',
  ];
  const allMenCurated = [
    'rooftop-birthday',
    'first-date',
    'summer-wedding',
    'beach-wedding-guest',
    'interview-creative',
    'interview-bank',
    'business-casual',
    'brunch',
    'club',
    'festival',
    'beach',
    'fall-weekend',
    'upscale-dinner-date',
    'office-holiday-party',
    'graduation-ceremony',
    'coffee-date',
    'movie-night',
  ];
  createTempLibrary([
    ...allWomenCurated.map((k) => makeSet(k, 'women')),
    ...allMenCurated.map((k) => makeSet(k, 'men')),
  ]);

  const womenMenu = await occasionMenu('women');
  assert.equal(womenMenu.length, 15);
  assert.deepEqual(
    womenMenu.map((e) => e.key),
    allWomenCurated.slice(0, 15),
  );

  const menMenu = await occasionMenu('men');
  assert.equal(menMenu.length, 15);
  assert.deepEqual(
    menMenu.map((e) => e.key),
    allMenCurated.slice(0, 15),
  );
});
