import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAGE_RPC_TIMEOUT_MS,
  MAX_PAGE_PAYLOAD_BYTES,
  createPageSender,
  trimPayloadToLimit,
} from '../src/agent/page.ts';
import type { Item, Outfit } from '../src/types.ts';

interface LoggedEvent {
  room: string;
  ev: string;
  data?: Record<string, unknown>;
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    variant_id: 'var-1',
    title: 'Relaxed Cotton Shirt',
    price: 48,
    url: 'https://example.com/shirt',
    image: 'https://cdn.shopify.com/shirt.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.5,
    rating_count: 12,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'v-s', M: 'v-m', L: 'v-l' },
    description: 'Clean organic cotton shirt.',
    department: 'men',
    ...overrides,
  };
}

function makeOutfit(overrides: Partial<Outfit> = {}): Outfit {
  return {
    number: 1,
    name: 'Rooftop Clean',
    difference: 'Crisp shirt and dark trousers.',
    story: 'Easy, sharp evening silhouette.',
    pieces: [{ slot: 'top', why: 'Holds structure.', item: makeItem() }],
    total: 48,
    ...overrides,
  };
}

test('createPageSender sends RPC with 5s timeout, returns ok reply, and logs page event', async () => {
  const logs: LoggedEvent[] = [];
  const rpcCalls: Array<{
    destinationIdentity: string;
    method: string;
    payload: string;
    responseTimeout?: number;
  }> = [];
  let now = 1_000;

  const sender = createPageSender({
    room: {
      name: 'room-ok',
      localParticipant: {
        async performRpc(params) {
          rpcCalls.push(params);
          now += 42;
          return JSON.stringify({ ok: true });
        },
      },
    },
    shopperIdentity: () => 'shopper-abc',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => now,
  });

  const reply = await sender.send('highlight', { outfit: 2, piece: 'shoes' });
  assert.deepEqual(reply, { ok: true });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]!.destinationIdentity, 'shopper-abc');
  assert.equal(rpcCalls[0]!.method, 'highlight');
  assert.equal(rpcCalls[0]!.responseTimeout, DEFAULT_PAGE_RPC_TIMEOUT_MS);
  assert.deepEqual(JSON.parse(rpcCalls[0]!.payload), { outfit: 2, piece: 'shoes' });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.room, 'room-ok');
  assert.equal(logs[0]!.ev, 'page');
  assert.equal(logs[0]!.data?.action, 'highlight');
  assert.equal(logs[0]!.data?.ms, 42);
  assert.equal(typeof logs[0]!.data?.bytes, 'number');
  assert.deepEqual(logs[0]!.data?.reply, { ok: true });
});

test('createPageSender handles error reply {ok:false, error} and logs page_error', async () => {
  const logs: LoggedEvent[] = [];
  const sender = createPageSender({
    room: {
      name: 'room-err-reply',
      localParticipant: {
        async performRpc() {
          return JSON.stringify({ ok: false, error: 'Unknown outfit: 3' });
        },
      },
    },
    shopperIdentity: () => 'shopper-1',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const reply = await sender.send('reveal', { outfit: 3, url: 'https://img/3.jpg' });
  assert.deepEqual(reply, { ok: false, error: 'Unknown outfit: 3' });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'page_error');
  assert.equal(logs[0]!.data?.action, 'reveal');
  assert.equal(logs[0]!.data?.error, 'Unknown outfit: 3');
});

test('createPageSender never throws when performRpc rejects and logs page_error', async () => {
  const logs: LoggedEvent[] = [];
  const sender = createPageSender({
    room: {
      name: 'room-throw',
      localParticipant: {
        async performRpc() {
          throw new Error('RESPONSE_TIMEOUT');
        },
      },
    },
    shopperIdentity: () => 'shopper-1',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const reply = await sender.send('showAll', {});
  assert.deepEqual(reply, { ok: false, error: 'RESPONSE_TIMEOUT' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'page_error');
  assert.equal(logs[0]!.data?.action, 'showAll');
  assert.equal(logs[0]!.data?.error, 'RESPONSE_TIMEOUT');
});

test('createPageSender fails safely when shopper identity or localParticipant is missing', async () => {
  const logs: LoggedEvent[] = [];
  const noShopper = createPageSender({
    room: {
      name: 'room-missing',
      localParticipant: {
        async performRpc() {
          return JSON.stringify({ ok: true });
        },
      },
    },
    shopperIdentity: () => null,
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const r1 = await noShopper.send('hideProduct', {});
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? '', /shopper identity/i);

  const noParticipant = createPageSender({
    room: { name: 'room-missing', localParticipant: null },
    shopperIdentity: () => 'shopper-1',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const r2 = await noParticipant.send('hideProduct', {});
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? '', /localParticipant/i);

  assert.equal(logs.filter((l) => l.ev === 'page_error').length, 2);
});

test('createPageSender trims oversize payloads (>15 KiB) without mutating input and logs trim', async () => {
  const logs: LoggedEvent[] = [];
  let sentPayload = '';

  const hugeDesc = 'Organic heavyweight cotton twill with double-stitched seams. '.repeat(400);
  const outfit = makeOutfit({
    pieces: [
      { slot: 'top', why: 'Great drape.', item: makeItem({ id: 'i1', description: hugeDesc }) },
      { slot: 'bottom', why: 'Clean taper.', item: makeItem({ id: 'i2', description: hugeDesc }) },
    ],
  });
  const payload = { outfits: [outfit], replace: true, subtitle: 'Dinner · $200 budget' };
  const rawBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(rawBytes > MAX_PAGE_PAYLOAD_BYTES, `test fixture should exceed 15 KiB (got ${rawBytes})`);

  const sender = createPageSender({
    room: {
      name: 'room-big',
      localParticipant: {
        async performRpc(params) {
          sentPayload = params.payload;
          return JSON.stringify({ ok: true });
        },
      },
    },
    shopperIdentity: () => 'shopper-big',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const reply = await sender.send('showOutfits', payload);
  assert.deepEqual(reply, { ok: true });

  const sentBytes = Buffer.byteLength(sentPayload, 'utf8');
  assert.ok(sentBytes < MAX_PAGE_PAYLOAD_BYTES, `expected < 15 KiB, got ${sentBytes}`);
  assert.equal(outfit.pieces[0]!.item.description, hugeDesc, 'must not mutate caller payload');

  const trimLog = logs.find((l) => l.ev === 'page_trim');
  assert.ok(trimLog, 'must log page_trim when trimming oversize payload');
  assert.equal(trimLog!.data?.action, 'showOutfits');
  assert.equal(trimLog!.data?.original_bytes, rawBytes);
  assert.equal(trimLog!.data?.bytes, sentBytes);

  const pageLog = logs.find((l) => l.ev === 'page');
  assert.ok(pageLog, 'must still log page event after sending trimmed payload');
  assert.equal(pageLog!.data?.bytes, sentBytes);
});

test('trimPayloadToLimit leaves under-limit payloads untouched', () => {
  const res = trimPayloadToLimit({ outfit: 1, piece: 'top' });
  assert.equal(res.trimmed, false);
  assert.equal(res.bytes, res.originalBytes);
  assert.ok(res.bytes < MAX_PAGE_PAYLOAD_BYTES);
});
