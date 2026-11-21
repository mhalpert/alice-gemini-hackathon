import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { voice } from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import type {
  BagOut,
  BuildResult,
  Item,
  OrderReview,
  OrderStore,
  Outfit,
  PageActionName,
  PageActions,
} from '../src/types.ts';
import { DEFAULT_PURCHASE_MAX_USD, loadConfig } from '../src/agent/config.ts';
import {
  ORDER_ALREADY_SENT_NOTE,
  ORDER_NOT_AVAILABLE,
  ORDER_NOT_DONE_NO_BAG,
  ORDER_NOT_READY_SIGN_IN,
  ORDER_OUTCOME_ALL_PLACED,
  ORDER_OUTCOME_HANDOFF,
  ORDER_OUTCOME_PARTIAL,
  ORDER_OUTCOME_UNKNOWN,
  ORDER_OVER_LIMIT,
  ORDER_PAYMENT_PROCESSING_PREFIX,
  ORDER_PLACE_UNCONFIRMED_ERROR,
  ORDER_REVIEW_TTL_MS,
  classifyOrderPlacedOutcome,
  computeBagFingerprint,
  createInitialOrderMachineState,
  createOrderController,
  evaluatePlaceOrderGates,
  formatOrderPlacedResult,
  isPurchaseReady,
  reduceOrderState,
  type OrderController,
  type PlaceOrderFn,
  type PrepareOrderFn,
  type PrepareOrderResult,
} from '../src/agent/order.ts';
import { createPageSender, type PageSender, type PageSenderReply } from '../src/agent/page.ts';
import { ALICE_SYSTEM_PROMPT, buildSystemPrompt } from '../src/agent/prompt.ts';
import { createCallStateStore } from '../src/agent/state.ts';
import { createAgentTools } from '../src/agent/tools.ts';
import { attachEndCallCleanup, endStoreCall } from '../src/agent/worker.ts';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RecordedLog {
  room: string;
  ev: string;
  data?: Record<string, unknown>;
}

interface PageCall {
  action: PageActionName;
  payload: unknown;
}

const fakeToolOpts = (id = 'call-1') => ({
  toolCallId: id,
  ctx: {} as never,
  abortSignal: new AbortController().signal,
});

function createFakePage(
  responder: (
    action: PageActionName,
    payload: unknown,
  ) => PageSenderReply | Promise<PageSenderReply> = () => ({ ok: true }),
): { page: PageSender; calls: PageCall[] } {
  const calls: PageCall[] = [];
  const page: PageSender = {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageSenderReply> {
      calls.push({ action, payload });
      return await responder(action, payload);
    },
  };
  return { page, calls };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-top',
    variant_id: 'var-top-default',
    title: 'Merino Knit Polo',
    price: 60,
    url: 'https://everlane.example/polo',
    image: 'https://cdn.shopify.com/polo.jpg',
    store: 'Everlane',
    store_domain: 'everlane.myshopify.com',
    rating: 4.8,
    rating_count: 52,
    sizes: ['S', 'M', 'L'],
    variants_by_size: { S: 'var-top-s', M: 'var-top-m', L: 'var-top-l' },
    description: '100% merino wool knit polo.',
    department: 'men',
    ...overrides,
  };
}

function makeOutfit(overrides: Partial<Outfit> = {}): Outfit {
  const top = makeItem();
  const shoes = makeItem({
    id: 'item-shoes',
    variant_id: 'var-shoes-default',
    title: 'Leather Derby',
    price: 80,
    url: 'https://kith.example/derby',
    image: 'https://cdn.shopify.com/derby.jpg',
    store: 'Kith',
    store_domain: 'kith.myshopify.com',
    sizes: ['9', '10', '11'],
    variants_by_size: { '9': 'var-shoes-9', '10': 'var-shoes-10', '11': 'var-shoes-11' },
  });
  return {
    number: 1,
    name: 'SoHo Sharp',
    difference: 'Clean knit and leather derby.',
    story: 'Sharp dinner look.',
    pieces: [
      { slot: 'top', why: 'Soft structure.', item: top },
      { slot: 'shoes', why: 'Polished finish.', item: shoes },
    ],
    total: 140,
    ...overrides,
  };
}

function makeRealBagOut(overrides: Partial<BagOut> = {}): BagOut {
  return {
    carts: [
      {
        store: 'Everlane',
        store_domain: 'everlane.myshopify.com',
        cart_id: 'cart-everlane-1',
        continue_url: 'https://everlane.example/cart/1',
        total_usd: 60,
        added: [{ variant_id: 'var-top-m', title: 'Merino Knit Polo', size: 'M' }],
        not_added: [],
        ms: 40,
      },
      {
        store: 'Kith',
        store_domain: 'kith.myshopify.com',
        cart_id: 'cart-kith-1',
        continue_url: 'https://kith.example/cart/1',
        total_usd: 80,
        added: [{ variant_id: 'var-shoes-10', title: 'Leather Derby', size: '10' }],
        not_added: [],
        ms: 55,
      },
    ],
    summary: 'Added 2 pieces across 2 stores.',
    total_usd: 140,
    ...overrides,
  };
}

const CANARY_PAYMENT_LABEL = 'Shop Pay, Visa ending 9876';
const CANARY_ADDRESS_LABEL = '742 Evergreen Terrace, Apt 4B, NY';

function makeOrderReview(overrides: Partial<PrepareOrderResult> = {}): PrepareOrderResult {
  return {
    order_id: 'ord-abc-123',
    stores: [
      {
        store: 'Everlane',
        items: [
          {
            title: 'Merino Knit Polo',
            slot: 'top',
            image: 'https://cdn.shopify.com/polo.jpg',
            price: 60,
            size: 'M',
          },
        ],
        total: 60,
        payment_label: CANARY_PAYMENT_LABEL,
        ready: true,
      },
      {
        store: 'Kith',
        items: [
          {
            title: 'Leather Derby',
            slot: 'shoes',
            image: 'https://cdn.shopify.com/derby.jpg',
            price: 80,
            size: '10',
          },
        ],
        total: 80,
        payment_label: null,
        ready: false,
        continue_url: 'https://kith.example/cart/1',
        note: 'This store requires checkout on its site.',
      },
    ],
    total: 140,
    address_label: CANARY_ADDRESS_LABEL,
    ...overrides,
  };
}

function makePlacedStores(): OrderStore[] {
  return [
    {
      store: 'Everlane',
      items: [
        {
          title: 'Merino Knit Polo',
          slot: 'top',
          image: 'https://cdn.shopify.com/polo.jpg',
          price: 60,
          size: 'M',
        },
      ],
      total: 60,
      payment_label: CANARY_PAYMENT_LABEL,
      ready: true,
      status: 'placed',
      order_number: '#EV-4410',
    },
    {
      store: 'Kith',
      items: [
        {
          title: 'Leather Derby',
          slot: 'shoes',
          image: 'https://cdn.shopify.com/derby.jpg',
          price: 80,
          size: '10',
        },
      ],
      total: 80,
      payment_label: null,
      ready: false,
      status: 'handoff',
      continue_url: 'https://kith.example/cart/1',
    },
  ];
}

function makePlacedReview(orderId: string, stores: OrderStore[] = makePlacedStores()): OrderReview {
  return {
    order_id: orderId,
    stores,
    total: stores.reduce((sum, s) => sum + (s.total ?? 0), 0),
    address_label: CANARY_ADDRESS_LABEL,
  };
}

async function setupHarness(opts?: {
  room?: string;
  purchaseEnabled?: boolean;
  purchaseMaxUsd?: number;
  bagOut?: BagOut;
  review?: PrepareOrderResult;
  prepareOrder?: PrepareOrderFn;
  placeOrder?: PlaceOrderFn;
  confirmResponder?: (payload: { order_id: string }) => PageSenderReply | Promise<PageSenderReply>;
  nowStart?: number;
  generateIdempotencyKey?: () => string;
}) {
  let now = opts?.nowStart ?? 1_000_000;
  const logs: RecordedLog[] = [];
  const prepareCalls: Array<{ bag: BagOut; argCount: number }> = [];
  const placeCalls: Array<{
    orderId: string;
    idempotencyKey: string;
    confirmedByTap: boolean;
    argCount: number;
  }> = [];
  const outfit = makeOutfit();
  let currentBagOut = opts?.bagOut ?? makeRealBagOut();

  const { page, calls: pageCalls } = createFakePage(async (action, payload) => {
    if (action === 'confirmOrder') {
      if (opts?.confirmResponder) {
        return await opts.confirmResponder(payload as { order_id: string });
      }
      const req = payload as { order_id: string };
      return { ok: true, confirmed: true, order_id: req.order_id };
    }
    return { ok: true };
  });

  const room = opts?.room ?? 'room-order-1';
  const stateStore = createCallStateStore({
    roomName: room,
    log: (r, ev, data) => logs.push({ room: r, ev, data }),
  });

  const defaultPrepare: PrepareOrderFn = async function (bag) {
    prepareCalls.push({ bag, argCount: arguments.length });
    return opts?.review ?? makeOrderReview();
  };
  const defaultPlace: PlaceOrderFn = async function (orderId, placeOpts) {
    placeCalls.push({
      orderId,
      idempotencyKey: placeOpts.idempotencyKey,
      confirmedByTap: placeOpts.confirmedByTap,
      argCount: arguments.length,
    });
    return makePlacedReview(orderId);
  };

  const orderController: OrderController = createOrderController({
    room,
    purchaseEnabled: opts?.purchaseEnabled ?? true,
    purchaseMaxUsd: opts?.purchaseMaxUsd,
    page,
    stateStore,
    log: (r, ev, data) => logs.push({ room: r, ev, data }),
    now: () => now,
    generateIdempotencyKey: opts?.generateIdempotencyKey,
    deps: {
      prepareOrder: opts && 'prepareOrder' in opts ? opts.prepareOrder : defaultPrepare,
      placeOrder: opts && 'placeOrder' in opts ? opts.placeOrder : defaultPlace,
    },
  });

  const tools = createAgentTools({
    room,
    log: (r, ev, data) => logs.push({ room: r, ev, data }),
    now: () => now,
    page,
    state: stateStore,
    orderController,
    deps: {
      buildOutfits: async (): Promise<BuildResult> => ({
        outfits: [outfit],
        source: 'live',
        timing: { first_outfit_ms: 10, total_ms: 20 },
        problems: [],
      }),
      swapPiece: async (orig) => {
        const swappedItem = makeItem({
          id: 'item-top-2',
          variant_id: 'var-top-2',
          title: 'Cashmere Crewneck',
          price: 70,
          variants_by_size: { M: 'var-top-2-m' },
        });
        const updated: Outfit = {
          ...orig,
          pieces: orig.pieces.map((p) => (p.slot === 'top' ? { ...p, item: swappedItem } : p)),
          total: 150,
        };
        return { outfit: updated, piece: updated.pieces[0]! };
      },
      outfitCollage: async () => null,
      tryOn: async () => ({ url: '/tryon/t1.jpg', path: '/tmp/t1.jpg', ms: 10, id: 't1' }),
      addToBag: async () => currentBagOut,
    },
  });

  async function bagLook(sizes: Record<string, string> = { top: 'M', shoes: '10' }) {
    await tools.set_department.execute({ department: 'men' }, fakeToolOpts('dept-1'));
    await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('build-1'));
    await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('pick-1'));
    return await tools.add_to_bag.execute({ outfit: 1, sizes }, fakeToolOpts('bag-1'));
  }

  return {
    tools,
    orderController,
    logs,
    pageCalls,
    stateStore,
    prepareCalls,
    placeCalls,
    bagLook,
    setBagOut: (next: BagOut) => {
      currentBagOut = next;
    },
    advanceMs: (ms: number) => {
      now += ms;
    },
    getNow: () => now,
  };
}

test('loadConfig defaults ALICE_PURCHASE to false and ALICE_PURCHASE_MAX_USD to 10,000', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.purchase, false);
  assert.equal(defaults.purchaseMaxUsd, DEFAULT_PURCHASE_MAX_USD);
  assert.equal(defaults.purchaseMaxUsd, 10_000);

  assert.equal(loadConfig({ ALICE_PURCHASE: 'on' }).purchase, true);
  assert.equal(loadConfig({ ALICE_PURCHASE: '  ON  ' }).purchase, true);
  assert.equal(loadConfig({ ALICE_PURCHASE: 'off' }).purchase, false);
  assert.equal(loadConfig({ ALICE_PURCHASE: 'true' }).purchase, false);
  assert.equal(loadConfig({ ALICE_PURCHASE: '1' }).purchase, false);

  assert.equal(loadConfig({ ALICE_PURCHASE_MAX_USD: '600' }).purchaseMaxUsd, 600);
  assert.equal(loadConfig({ ALICE_PURCHASE_MAX_USD: '249.50' }).purchaseMaxUsd, 249.5);
  assert.equal(loadConfig({ ALICE_PURCHASE_MAX_USD: '0' }).purchaseMaxUsd, 10_000);
  assert.equal(loadConfig({ ALICE_PURCHASE_MAX_USD: '-50' }).purchaseMaxUsd, 10_000);
  assert.equal(loadConfig({ ALICE_PURCHASE_MAX_USD: 'abc' }).purchaseMaxUsd, 10_000);
});

test('review_order and place_order are NOT registered when switch is off or store functions are missing', () => {
  const fakePrepare: PrepareOrderFn = async () => makeOrderReview();
  const fakePlace: PlaceOrderFn = async (orderId) => makePlacedReview(orderId, []);

  // 1) Switch off even when both functions are injected.
  const offTools = createAgentTools({
    room: 'r-off',
    log: () => {},
    purchaseEnabled: false,
    deps: { prepareOrder: fakePrepare, placeOrder: fakePlace },
  });
  assert.equal('review_order' in offTools, false);
  assert.equal('place_order' in offTools, false);
  assert.equal(
    isPurchaseReady({ purchaseEnabled: false, deps: { prepareOrder: fakePrepare, placeOrder: fakePlace } }),
    false,
  );

  // 2) Switch on, default store module (both functions are exported by the store): registered.
  const withDefault = createAgentTools({
    room: 'r-default-store',
    log: () => {},
    purchaseEnabled: true,
  });
  assert.equal('review_order' in withDefault, true);
  assert.equal('place_order' in withDefault, true);
  assert.equal(isPurchaseReady({ purchaseEnabled: true }), true);

  // 3) Switch on, only prepareOrder present.
  const onlyPrepare = createAgentTools({
    room: 'r-only-prepare',
    log: () => {},
    purchaseEnabled: true,
    deps: { prepareOrder: fakePrepare, placeOrder: undefined },
  });
  assert.equal('review_order' in onlyPrepare, false);
  assert.equal('place_order' in onlyPrepare, false);

  // 4) Switch on, only placeOrder present.
  const onlyPlace = createAgentTools({
    room: 'r-only-place',
    log: () => {},
    purchaseEnabled: true,
    deps: { prepareOrder: undefined, placeOrder: fakePlace },
  });
  assert.equal('review_order' in onlyPlace, false);
  assert.equal('place_order' in onlyPlace, false);

  // 5) Switch on, storeOrderModule without exports.
  const emptyMod = createAgentTools({
    room: 'r-empty-mod',
    log: () => {},
    purchaseEnabled: true,
    deps: { storeOrderModule: {} },
  });
  assert.equal('review_order' in emptyMod, false);
  assert.equal('place_order' in emptyMod, false);

  // 6) Switch on AND both functions present -> both tools registered.
  const onTools = createAgentTools({
    room: 'r-on',
    log: () => {},
    purchaseEnabled: true,
    deps: { prepareOrder: fakePrepare, placeOrder: fakePlace },
  });
  assert.equal('review_order' in onTools, true);
  assert.equal('place_order' in onTools, true);
  assert.equal(
    isPurchaseReady({ purchaseEnabled: true, deps: { prepareOrder: fakePrepare, placeOrder: fakePlace } }),
    true,
  );
});

test('buildSystemPrompt keeps Carts only wording when off and encodes full purchase contract when on', () => {
  const defaultPrompt = buildSystemPrompt();
  assert.equal(defaultPrompt, ALICE_SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt({ purchaseEnabled: false }), ALICE_SYSTEM_PROMPT);
  assert.match(defaultPrompt, /Carts only—never check out, take payment/i);
  assert.doesNotMatch(defaultPrompt, /\breview_order\b/);
  assert.doesNotMatch(defaultPrompt, /\bplace_order\b/);
  assert.doesNotMatch(defaultPrompt, /Payment may still be processing/);

  const purchasePrompt = buildSystemPrompt({ purchaseEnabled: true });
  assert.doesNotMatch(purchasePrompt, /Carts only/i);
  assert.match(purchasePrompt, /offer once to place the order with their Shop Pay or hand over the store links/i);
  assert.match(purchasePrompt, /\breview_order\b/);
  assert.match(purchasePrompt, /from the review result \(not earlier bag numbers\)/i);
  assert.match(purchasePrompt, /two short sentences/i);
  assert.match(purchasePrompt, /tap Confirm on screen and say yes/i);
  assert.match(purchasePrompt, /\bplace_order\b/);
  assert.ok(purchasePrompt.includes(ORDER_ALREADY_SENT_NOTE));
  assert.match(purchasePrompt, /vague or overheard remark/i);
  assert.match(purchasePrompt, /never ask for or repeat card numbers, passwords, full addresses, or phone numbers/i);
  assert.match(purchasePrompt, /say exactly what the result says per store and nothing more/i);
  assert.ok(purchasePrompt.includes(ORDER_PAYMENT_PROCESSING_PREFIX));
  assert.match(purchasePrompt, /check their Shop app and never offer the store link or a retry/i);
});

test('createPageSender preserves confirmed boolean and order_id on confirmOrder reply', async () => {
  const sender = createPageSender({
    room: {
      name: 'room-confirm-rpc',
      localParticipant: {
        async performRpc() {
          return JSON.stringify({ ok: true, confirmed: true, order_id: 'ord-1' });
        },
      },
    },
    shopperIdentity: () => 'shopper-1',
    log: () => {},
  });

  const reply = await sender.send('confirmOrder', { order_id: 'ord-1' });
  assert.deepEqual(reply, { ok: true, confirmed: true, order_id: 'ord-1' });
});

test('review_order without a settled real bag returns NOT DONE and never calls prepareOrder', async () => {
  const h = await setupHarness();
  const res = await h.tools.review_order!.execute({}, fakeToolOpts('rev-1'));
  assert.equal(res, ORDER_NOT_DONE_NO_BAG);
  assert.equal(h.prepareCalls.length, 0);
  assert.equal(h.stateStore.get().orderReview, null);

  // Mocked bag (no cart_id / continue_url) is not a real cart.
  const mockHarness = await setupHarness({
    bagOut: {
      carts: [
        {
          store: 'Everlane',
          store_domain: 'everlane.myshopify.com',
          cart_id: null,
          continue_url: null,
          total_usd: 60,
          added: [{ variant_id: 'var-top-m', title: 'Merino Knit Polo', size: 'M' }],
          not_added: [],
          ms: 0,
        },
      ],
      summary: 'No cart created.',
      total_usd: 60,
    },
  });
  await mockHarness.bagLook();
  const resAfterNoRealCart = await mockHarness.tools.review_order!.execute({}, fakeToolOpts('rev-2'));
  assert.equal(resAfterNoRealCart, ORDER_NOT_DONE_NO_BAG);
  assert.equal(mockHarness.prepareCalls.length, 0);
});

test('review_order treats disabled: true from prepareOrder like tools-off and returns exact NOT AVAILABLE message', async () => {
  const h = await setupHarness({
    review: makeOrderReview({ disabled: true }),
  });
  await h.bagLook();

  const res = await h.tools.review_order!.execute({}, fakeToolOpts('rev-disabled'));
  assert.equal(res, ORDER_NOT_AVAILABLE);
  assert.equal(res, 'NOT AVAILABLE: hand over the store links as today.');
  assert.equal(h.stateStore.get().orderReview, null);
  assert.equal(h.orderController.getState().activeReview, null);
  assert.equal(h.pageCalls.filter((c) => c.action === 'showOrderReview').length, 0);
  assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'store_disabled'));

  // Subsequent place_order must remain blocked.
  const placeRes = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-after-disabled'),
  );
  assert.match(placeRes, /^NOT DONE:/);
  assert.equal(h.placeCalls.length, 0);
});

test('review_order handles needs_sign_in without storing a review and shows the sign-in step on screen', async () => {
  const signInOrder = {
    order_id: '',
    stores: [],
    total: null,
    needs_sign_in: true,
    sign_in: { url: 'https://shop.app/connect', code: 'AB12-CD34' },
  } as PrepareOrderResult;
  const h = await setupHarness({ review: signInOrder });
  await h.bagLook();

  const res = await h.tools.review_order!.execute({}, fakeToolOpts('rev-signin'));
  assert.equal(res, ORDER_NOT_READY_SIGN_IN);
  assert.equal(h.stateStore.get().orderReview, null);

  const showCalls = h.pageCalls.filter((c) => c.action === 'showOrderReview');
  assert.equal(showCalls.length, 1);
  assert.deepEqual(showCalls[0]!.payload, { order: signInOrder });

  const reviewLog = h.logs.find((l) => l.ev === 'order_review');
  assert.ok(reviewLog);
  assert.equal(reviewLog!.data?.needs_sign_in, true);

  // Attempting place_order afterwards must be blocked because nothing was stored as reviewed.
  const placeRes = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-after-signin'),
  );
  assert.match(placeRes, /^NOT DONE:/);
  assert.equal(h.placeCalls.length, 0);
});

test('review_order reads back checkout items/totals (not bag numbers) and handles ready:false note vs already-sent verbatim', async () => {
  // 1) Checkout items & totals differ from bag numbers (e.g. tax/shipping added by store checkout),
  //    plus a ready: false store with an explanatory note.
  {
    const checkoutReview = makeOrderReview({
      order_id: 'ord-checkout-nums',
      stores: [
        {
          store: 'Everlane',
          items: [
            {
              title: 'Merino Knit Polo - Navy',
              slot: 'top',
              image: 'https://cdn.shopify.com/polo.jpg',
              price: 65.25,
              size: 'M',
            },
          ],
          total: 65.25,
          payment_label: CANARY_PAYMENT_LABEL,
          ready: true,
        },
        {
          store: 'Kith',
          items: [
            {
              title: 'Leather Derby Shoe',
              slot: 'shoes',
              image: 'https://cdn.shopify.com/derby.jpg',
              price: 82.5,
              size: '10',
            },
          ],
          total: 82.5,
          payment_label: null,
          ready: false,
          continue_url: 'https://kith.example/cart/1',
          note: 'Kith requires shipping selection on its website.',
        },
      ],
      total: 147.75,
    });
    const h = await setupHarness({ review: checkoutReview });
    await h.bagLook(); // bag had $60 + $80 = $140

    const revRes = await h.tools.review_order!.execute({}, fakeToolOpts('rev-checkout'));
    assert.match(revRes, /Merino Knit Polo - Navy \(size M\) — \$65\.25/);
    assert.match(revRes, /Leather Derby Shoe \(size 10\) — \$82\.50/);
    assert.match(revRes, /Kith will be a hand-off link instead — Kith requires shipping selection on its website\./);
    assert.match(revRes, /Grand total: \$147\.75/);
    assert.equal(revRes.includes('$140'), false, 'must report checkout total, not bag total');
    assert.equal(revRes.includes('$60'), false, 'must report checkout store total, not bag total');
    assert.match(revRes, /not earlier bag numbers/i);
  }

  // 2) Store with exact already-sent note must say it verbatim and NOT offer another try or a link.
  {
    const alreadySentReview = makeOrderReview({
      order_id: 'ord-already-sent',
      stores: [
        {
          store: 'Everlane',
          items: [
            {
              title: 'Merino Knit Polo',
              slot: 'top',
              image: 'https://cdn.shopify.com/polo.jpg',
              price: 60,
              size: 'M',
            },
          ],
          total: 60,
          payment_label: null,
          ready: false,
          note: ORDER_ALREADY_SENT_NOTE,
        },
      ],
      total: 60,
    });
    const h = await setupHarness({ review: alreadySentReview });
    await h.bagLook();

    const revRes = await h.tools.review_order!.execute({}, fakeToolOpts('rev-already'));
    assert.ok(
      revRes.includes(ORDER_ALREADY_SENT_NOTE),
      'must include exact already-sent sentence verbatim',
    );
    assert.match(revRes, /Say verbatim: "This store's order was already sent\. Check your Shop app or email\."/);
    assert.match(revRes, /Do not offer another try or a link for Everlane/i);
    assert.equal(
      revRes.includes('hand-off link'),
      false,
      'must NOT treat already-sent store as a hand-off link',
    );
    assert.equal(
      revRes.includes('tap Confirm'),
      false,
      'must NOT ask to tap Confirm when every store was already sent',
    );
  }
});

test('happy path reviews bag, checks Confirm on page, calls placeOrder once with UUID idempotencyKey + confirmedByTap:true, and sends orderPlaced', async () => {
  const h = await setupHarness({ room: 'room-happy' });
  await h.bagLook();

  const revRes = await h.tools.review_order!.execute({}, fakeToolOpts('rev-1'));
  assert.equal(h.prepareCalls.length, 1);
  assert.equal(h.prepareCalls[0]!.argCount, 1, 'prepareOrder must receive only bag (never room)');
  assert.equal(h.prepareCalls[0]!.bag.total_usd, 140);

  // Result text includes items with sizes, store totals, grand total, verbatim masked labels, hand-off note, and closing prompt.
  assert.match(revRes, /Everlane: Merino Knit Polo \(size M\) — \$60/);
  assert.match(revRes, /Kith: Leather Derby \(size 10\) — \$80/);
  assert.match(revRes, /Kith will be a hand-off link instead — This store requires checkout on its site\./);
  assert.match(revRes, /Grand total: \$140/);
  assert.ok(revRes.includes(CANARY_PAYMENT_LABEL));
  assert.ok(revRes.includes(CANARY_ADDRESS_LABEL));
  assert.ok(revRes.includes('Ask them to check the order on screen, tap Confirm, and tell you yes.'));

  // State records order_id, bagFingerprint, reviewedAt, and a fresh random UUID idempotencyKey.
  const storedReview = h.stateStore.get().orderReview;
  assert.ok(storedReview);
  assert.equal(storedReview!.order_id, 'ord-abc-123');
  assert.equal(storedReview!.bagFingerprint, computeBagFingerprint(makeRealBagOut()));
  assert.equal(storedReview!.reviewedAt, 1_000_000);

  const activeReview = h.orderController.getState().activeReview;
  assert.ok(activeReview);
  assert.match(activeReview!.idempotencyKey, UUID_V4_RE);

  // Advance 119 s (still under 120 s TTL) -> allowed.
  h.advanceMs(119_000);

  const placeRes = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-1'),
  );

  // Confirm RPC called with exact order_id.
  const confirmCalls = h.pageCalls.filter((c) => c.action === 'confirmOrder');
  assert.equal(confirmCalls.length, 1);
  assert.deepEqual(confirmCalls[0]!.payload, { order_id: 'ord-abc-123' });

  // placeOrder called exactly once with stored UUID key and confirmedByTap: true (no room arg).
  assert.equal(h.placeCalls.length, 1);
  assert.equal(h.placeCalls[0]!.argCount, 2, 'placeOrder must take (orderId, opts) only — never room');
  assert.deepEqual(h.placeCalls[0], {
    orderId: 'ord-abc-123',
    idempotencyKey: activeReview!.idempotencyKey,
    confirmedByTap: true,
    argCount: 2,
  });

  // orderPlaced RPC sent with returned stores.
  const placedPageCalls = h.pageCalls.filter((c) => c.action === 'orderPlaced');
  assert.equal(placedPageCalls.length, 1);
  assert.deepEqual(placedPageCalls[0]!.payload, {
    order_id: 'ord-abc-123',
    stores: makePlacedStores(),
  });

  // Result text names per-store placed (with order number) and hand-off link.
  assert.match(placeRes, /Everlane: placed \(order #EV-4410\)/);
  assert.match(placeRes, /Kith: hand-off link on screen/);

  // Required logs emitted.
  const reviewLog = h.logs.find((l) => l.ev === 'order_review');
  assert.ok(reviewLog);
  assert.equal(reviewLog!.data?.order_id, 'ord-abc-123');
  assert.equal(reviewLog!.data?.total, 140);
  assert.equal(reviewLog!.data?.needs_sign_in, false);

  const attemptLog = h.logs.find((l) => l.ev === 'order_place_attempt');
  assert.ok(attemptLog);
  assert.equal(attemptLog!.data?.order_id, 'ord-abc-123');
  assert.equal(attemptLog!.data?.idempotency_key, activeReview!.idempotencyKey);

  const placedLog = h.logs.find((l) => l.ev === 'order_placed');
  assert.ok(placedLog);
  assert.deepEqual(placedLog!.data, {
    order_id: 'ord-abc-123',
    stores: [
      { store: 'Everlane', status: 'placed' },
      { store: 'Kith', status: 'handoff' },
    ],
  });

  // Second call for the same order_id returns first result and does NOT call confirmOrder or placeOrder again.
  const secondRes = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-2'),
  );
  assert.equal(secondRes, placeRes);
  assert.equal(h.placeCalls.length, 1);
  assert.equal(h.pageCalls.filter((c) => c.action === 'confirmOrder').length, 1);
  assert.ok(
    h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'already_attempted'),
  );
});

test('idempotencyKey is a fresh random UUID per review and the SAME key is reused across repeated place_order attempts for that review', async () => {
  let tapConfirmed = false;
  let reviewSeq = 0;
  const h = await setupHarness({
    prepareOrder: async () => {
      reviewSeq += 1;
      return makeOrderReview({ order_id: `ord-idem-${reviewSeq}` });
    },
    confirmResponder: ({ order_id }) => ({
      ok: true,
      confirmed: tapConfirmed,
      order_id,
    }),
  });
  await h.bagLook();

  // Review #1 gets a fresh UUID.
  await h.tools.review_order!.execute({}, fakeToolOpts('rev-1'));
  const key1 = h.orderController.getState().activeReview!.idempotencyKey;
  assert.match(key1, UUID_V4_RE);

  // First place_order attempt fails gate (page not confirmed yet) -> key stays attached to review.
  const blocked = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-blocked'));
  assert.match(blocked, /^NOT DONE:/);
  assert.equal(h.placeCalls.length, 0);
  assert.equal(h.orderController.getState().activeReview!.idempotencyKey, key1);

  // Pure gate evaluation on the same review also yields the exact same key repeatedly.
  const g1 = evaluatePlaceOrderGates({
    state: h.orderController.getState(),
    purchaseEnabled: true,
    hasStoreFns: true,
    spokenConfirmation: true,
    nowMs: h.getNow() + 1000,
  });
  const g2 = evaluatePlaceOrderGates({
    state: h.orderController.getState(),
    purchaseEnabled: true,
    hasStoreFns: true,
    spokenConfirmation: true,
    nowMs: h.getNow() + 2000,
  });
  assert.equal(g1.ok, true);
  assert.equal(g2.ok, true);
  if (g1.ok && g2.ok) {
    assert.equal(g1.idempotencyKey, key1);
    assert.equal(g2.idempotencyKey, key1);
  }

  // Shopper taps Confirm -> second place_order uses the EXACT SAME key1.
  tapConfirmed = true;
  const placed = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-ok'));
  assert.match(placed, /Order ord-idem-1:/);
  assert.equal(h.placeCalls.length, 1);
  assert.equal(h.placeCalls[0]!.idempotencyKey, key1);

  // Third place_order for the same review still calls placeOrder at most once and returns first result.
  const repeat = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-repeat'));
  assert.equal(repeat, placed);
  assert.equal(h.placeCalls.length, 1);

  // A new review_order generates a DIFFERENT fresh UUID.
  await h.tools.review_order!.execute({}, fakeToolOpts('rev-2'));
  const key2 = h.orderController.getState().activeReview!.idempotencyKey;
  assert.match(key2, UUID_V4_RE);
  assert.notEqual(key2, key1);
});

test('payment-processing failure tells shopper to check Shop app and gives no link or retry offer', async () => {
  const h = await setupHarness({
    placeOrder: async (orderId) =>
      makePlacedReview(orderId, [
        {
          store: 'Everlane',
          items: [
            {
              title: 'Merino Knit Polo',
              slot: 'top',
              image: 'https://cdn.shopify.com/polo.jpg',
              price: 60,
              size: 'M',
            },
          ],
          total: 60,
          payment_label: CANARY_PAYMENT_LABEL,
          ready: true,
          status: 'failed',
          continue_url: 'https://everlane.example/cart/1',
          note: 'Payment may still be processing with your bank.',
        },
        {
          store: 'Kith',
          items: [
            {
              title: 'Leather Derby',
              slot: 'shoes',
              image: 'https://cdn.shopify.com/derby.jpg',
              price: 80,
              size: '10',
            },
          ],
          total: 80,
          payment_label: null,
          ready: true,
          status: 'placed',
          order_number: '#KT-882',
        },
      ]),
  });
  await h.bagLook();
  await h.tools.review_order!.execute({}, fakeToolOpts('rev-proc'));

  const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('place-proc'));
  assert.match(res, /Everlane: failed — Payment may still be processing with your bank\./);
  assert.match(res, /Tell the shopper to check their Shop app; do not offer the store link or a retry for Everlane/);
  assert.equal(res.includes('hand-off link on screen'), false);
  assert.equal(res.includes('everlane.example'), false);
  assert.match(res, /Kith: placed \(order #KT-882\)/);
});

test('confirmedByTap is true ONLY from page confirmOrder for that exact order_id, never from speech', async () => {
  // 1) Spoken confirmation true, page ok:false + confirmed:true -> blocked.
  {
    const h = await setupHarness({
      confirmResponder: () => ({ ok: false, confirmed: true, order_id: 'ord-abc-123' }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-1'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
  }

  // 2) Spoken confirmation true, page confirmed:false -> blocked.
  {
    const h = await setupHarness({
      confirmResponder: () => ({ ok: true, confirmed: false, order_id: 'ord-abc-123' }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-2'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
  }

  // 3) Spoken confirmation true, page confirmed:true for a DIFFERENT order_id -> blocked.
  {
    const h = await setupHarness({
      confirmResponder: () => ({ ok: true, confirmed: true, order_id: 'ord-older-999' }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-3'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
  }

  // 4) Spoken confirmation true, page confirmed:true for exact order_id -> confirmedByTap: true passed.
  {
    const h = await setupHarness({
      confirmResponder: ({ order_id }) => ({ ok: true, confirmed: true, order_id }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('p-4'));
    assert.equal(res.startsWith(ORDER_OUTCOME_PARTIAL), true);
    assert.match(res, /Order ord-abc-123:/);
    assert.equal(h.placeCalls.length, 1);
    assert.equal(h.placeCalls[0]!.confirmedByTap, true);
  }
});

test('a newer review_order supersedes an older one and blocks place_order for the older order_id', async () => {
  // 1) Explicit older order_id passed after newer review_order is blocked; latest review can still be placed.
  {
    let seq = 0;
    const h = await setupHarness({
      prepareOrder: async () => {
        seq += 1;
        return makeOrderReview({ order_id: `ord-v${seq}` });
      },
    });
    await h.bagLook();

    await h.tools.review_order!.execute({}, fakeToolOpts('rev-1'));
    assert.equal(h.orderController.getState().activeReview?.order_id, 'ord-v1');
    assert.equal(h.stateStore.get().orderReview?.order_id, 'ord-v1');
    const key1 = h.orderController.getState().activeReview!.idempotencyKey;

    await h.tools.review_order!.execute({}, fakeToolOpts('rev-2'));
    assert.equal(h.orderController.getState().activeReview?.order_id, 'ord-v2');
    assert.equal(h.stateStore.get().orderReview?.order_id, 'ord-v2');
    const key2 = h.orderController.getState().activeReview!.idempotencyKey;
    assert.notEqual(key2, key1);

    // Attempting to place the superseded order_id must be blocked without calling confirmOrder or placeOrder.
    const blockedOld = await h.tools.place_order!.execute(
      { spoken_confirmation: true, order_id: 'ord-v1' },
      fakeToolOpts('place-old'),
    );
    assert.match(blockedOld, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.equal(h.pageCalls.filter((c) => c.action === 'confirmOrder').length, 0);
    assert.ok(
      h.logs.some(
        (l) =>
          l.ev === 'order_blocked' &&
          l.data?.reason === 'review_superseded' &&
          l.data?.order_id === 'ord-v1',
      ),
    );

    // Placing without order_id (or with ord-v2) places ONLY the latest review ord-v2.
    const placedNew = await h.tools.place_order!.execute(
      { spoken_confirmation: true },
      fakeToolOpts('place-new'),
    );
    assert.equal(placedNew.startsWith(ORDER_OUTCOME_PARTIAL), true);
    assert.match(placedNew, /Order ord-v2:/);
    assert.equal(h.placeCalls.length, 1);
    assert.equal(h.placeCalls[0]!.orderId, 'ord-v2');
    assert.equal(h.placeCalls[0]!.idempotencyKey, key2);
  }

  // 2) Mid-RPC superseding: newer review_order finishes while confirmOrder for older review is in flight.
  {
    let seq = 0;
    let resolveConfirm!: (reply: PageSenderReply) => void;
    const h = await setupHarness({
      prepareOrder: async () => {
        seq += 1;
        return makeOrderReview({ order_id: `ord-race-${seq}` });
      },
      confirmResponder: () =>
        new Promise<PageSenderReply>((resolve) => {
          resolveConfirm = resolve;
        }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-r1'));

    const placingOlder = h.tools.place_order!.execute(
      { spoken_confirmation: true },
      fakeToolOpts('place-r1'),
    );
    // While confirmOrder is awaiting page tap for ord-race-1, a newer review arrives.
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-r2'));
    assert.equal(h.orderController.getState().activeReview?.order_id, 'ord-race-2');

    resolveConfirm({ ok: true, confirmed: true, order_id: 'ord-race-1' });
    const res = await placingOlder;
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.ok(
      h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'review_superseded'),
    );
  }
});

test('each place_order gate blocks on its own and calls nothing, including a set cap and 10,000 ceiling', async () => {
  // 1) No review.
  {
    const h = await setupHarness();
    await h.bagLook();
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-1'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.equal(h.pageCalls.filter((c) => c.action === 'confirmOrder').length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'no_review'));
  }

  // 2) Stale review at 121 s.
  {
    const h = await setupHarness();
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    h.advanceMs(121_000);
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-2'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.equal(h.pageCalls.filter((c) => c.action === 'confirmOrder').length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'review_stale'));
  }

  // 3a) Bag changed after review via add_to_bag.
  {
    const h = await setupHarness();
    await h.bagLook({ top: 'M', shoes: '10' });
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    h.setBagOut(
      makeRealBagOut({
        carts: [
          {
            ...makeRealBagOut().carts[0]!,
            cart_id: 'cart-everlane-2',
            added: [{ variant_id: 'var-top-l', title: 'Merino Knit Polo', size: 'L' }],
          },
          makeRealBagOut().carts[1]!,
        ],
      }),
    );
    await h.tools.add_to_bag.execute({ outfit: 1, sizes: { top: 'L', shoes: '10' } }, fakeToolOpts('bag-2'));
    assert.equal(h.stateStore.get().orderReview, null);

    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-3a'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked'));
  }

  // 3b) Swap after review invalidates review.
  {
    const h = await setupHarness();
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    await h.tools.swap_piece.execute(
      { outfit: 1, slot: 'top', request: 'cashmere crewneck' },
      fakeToolOpts('swap-1'),
    );
    assert.equal(h.stateStore.get().orderReview, null);

    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-3b'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
  }

  // 3c) Pure state machine fingerprint mismatch gate.
  {
    const bagA = makeRealBagOut();
    const bagB = makeRealBagOut({ total_usd: 145 });
    assert.notEqual(computeBagFingerprint(bagA), computeBagFingerprint(bagB));

    let st = createInitialOrderMachineState();
    st = reduceOrderState(st, { type: 'bag_settled', bag: bagA });
    st = reduceOrderState(st, {
      type: 'review_recorded',
      review: {
        order_id: 'ord-fp',
        bagFingerprint: computeBagFingerprint(bagA),
        reviewedAt: 1000,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        order: makeOrderReview({ order_id: 'ord-fp' }),
      },
    });
    const mutated = {
      ...st,
      settledBag: bagB,
      settledBagFingerprint: computeBagFingerprint(bagB),
    };
    const gate = evaluatePlaceOrderGates({
      state: mutated,
      purchaseEnabled: true,
      hasStoreFns: true,
      spokenConfirmation: true,
      nowMs: 2000,
      ttlMs: ORDER_REVIEW_TTL_MS,
    });
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.equal(gate.reason, 'bag_changed');
    }
  }

  // 4) spoken_confirmation === false.
  {
    const h = await setupHarness();
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: false }, fakeToolOpts('g-4'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.equal(h.pageCalls.filter((c) => c.action === 'confirmOrder').length, 0);
    assert.ok(
      h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'no_spoken_confirmation'),
    );
  }

  // 5) Page confirmOrder throws.
  {
    const h = await setupHarness({
      confirmResponder: async () => {
        throw new Error('RESPONSE_TIMEOUT');
      },
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-5'));
    assert.match(res, /^NOT DONE:/);
    assert.equal(h.placeCalls.length, 0);
    assert.ok(
      h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'page_not_confirmed'),
    );
  }

  // 6a) Over default ALICE_PURCHASE_MAX_USD (150) — even when bag total was $140, checkout $150.01 blocks!
  {
    const h = await setupHarness({
      purchaseMaxUsd: 150,
      review: makeOrderReview({ total: 150.01 }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-6a'));
    assert.equal(res, ORDER_OVER_LIMIT);
    assert.equal(
      res,
      'NOT DONE: this order is over the in-call purchase limit; hand over the store links.',
    );
    assert.equal(h.placeCalls.length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'over_max_usd'));
  }

  // 6b) Exactly at default cap ($150) is allowed.
  {
    const h = await setupHarness({
      purchaseMaxUsd: 150,
      review: makeOrderReview({ total: 150 }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-6b'));
    assert.equal(res.startsWith(ORDER_OUTCOME_PARTIAL), true);
    assert.match(res, /Order ord-abc-123:/);
    assert.equal(h.placeCalls.length, 1);
  }

  // 6c) Over custom ALICE_PURCHASE_MAX_USD.
  {
    const h = await setupHarness({
      purchaseMaxUsd: 200,
      review: makeOrderReview({ total: 250 }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-6c'));
    assert.equal(res, ORDER_OVER_LIMIT);
    assert.equal(h.placeCalls.length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'over_max_usd'));
  }

  // 6d) Over $10,000 ceiling even when purchaseMaxUsd is configured higher.
  {
    const h = await setupHarness({
      purchaseMaxUsd: 20_000,
      review: makeOrderReview({ total: 10_001 }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('g-6d'));
    assert.equal(res, ORDER_OVER_LIMIT);
    assert.equal(h.placeCalls.length, 0);
    assert.ok(h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'over_max_usd'));
  }
});

test('placeOrder throwing returns unknown-outcome wording without link/retry, does not retry, and blocks a second call', async () => {
  let placeAttempts = 0;
  const h = await setupHarness({
    placeOrder: async () => {
      placeAttempts += 1;
      throw new Error('upstream gateway timeout');
    },
  });
  await h.bagLook();
  await h.tools.review_order!.execute({}, fakeToolOpts('rev-throw'));

  const first = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-throw-1'),
  );
  assert.equal(first, ORDER_PLACE_UNCONFIRMED_ERROR);
  assert.equal(first.startsWith(ORDER_OUTCOME_UNKNOWN), true);
  assert.match(first, /Say that exact sentence first, word for word, before anything else\./);
  assert.match(first, /Do not retry and do not offer any store link\./);
  assert.equal(placeAttempts, 1);
  assert.equal(h.pageCalls.filter((c) => c.action === 'orderPlaced').length, 0);

  // Second call for the same order_id must NOT retry placeOrder and must return the first result.
  const second = await h.tools.place_order!.execute(
    { spoken_confirmation: true },
    fakeToolOpts('place-throw-2'),
  );
  assert.equal(second, ORDER_PLACE_UNCONFIRMED_ERROR);
  assert.equal(placeAttempts, 1);
  assert.ok(
    h.logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'already_attempted'),
  );
});

test('concurrent place_order calls for the same order_id invoke placeOrder only once', async () => {
  let releasePlace!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePlace = resolve;
  });
  let placeAttempts = 0;

  const h = await setupHarness({
    placeOrder: async (orderId) => {
      placeAttempts += 1;
      await gate;
      return makePlacedReview(orderId, [
        {
          store: 'Everlane',
          items: [],
          total: 60,
          payment_label: CANARY_PAYMENT_LABEL,
          ready: true,
          status: 'placed',
          order_number: '#EV-9999',
        },
        {
          store: 'Kith',
          items: [],
          total: 80,
          payment_label: null,
          ready: true,
          status: 'failed',
          note: 'card declined',
        },
      ]);
    },
  });
  await h.bagLook();
  await h.tools.review_order!.execute({}, fakeToolOpts('rev-race'));

  const p1 = h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('race-1'));
  const p2 = h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('race-2'));
  releasePlace();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(placeAttempts, 1);
  assert.equal(r1, r2);
  assert.match(r1, /Everlane: placed \(order #EV-9999\)/);
  assert.match(r1, /Kith: failed — card declined/);
});

test('endCall is called on shopper disconnect and session close, clears review state, logs store_end_call, and is tolerated when absent or throwing', async () => {
  // 1) Shopper disconnect triggers endCall + clears agent review state + logs store_end_call;
  //    non-shopper participant disconnect (e.g. avatar) is ignored.
  {
    const h = await setupHarness({ room: 'room-end-disc' });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-disc'));
    assert.ok(h.orderController.getState().activeReview);
    assert.ok(h.stateStore.get().orderReview);

    const fakeRoom = new EventEmitter();
    const fakeSession = new EventEmitter();
    let endCallCount = 0;
    let endCallArgCount = -1;
    const logs: RecordedLog[] = [];

    const handle = attachEndCallCleanup({
      roomName: 'room-end-disc',
      room: fakeRoom as never,
      session: fakeSession as never,
      getShopperIdentity: () => 'shopper-42',
      isSessionStarted: () => true,
      clearReviewState: () => h.orderController.invalidateReview(),
      endCall: async function () {
        endCallCount += 1;
        endCallArgCount = arguments.length;
      },
      log: (r, ev, data) => logs.push({ room: r, ev, data }),
    });

    // Non-shopper leaves -> must NOT call endCall or clear review state.
    fakeRoom.emit(RoomEvent.ParticipantDisconnected, { identity: 'tavus-avatar' });
    await new Promise((r) => setImmediate(r));
    assert.equal(endCallCount, 0);
    assert.ok(h.orderController.getState().activeReview);
    assert.ok(h.stateStore.get().orderReview);

    // Shopper leaves -> calls endCall() with 0 args, clears review state, logs store_end_call.
    fakeRoom.emit(RoomEvent.ParticipantDisconnected, { identity: 'shopper-42' });
    await new Promise((r) => setImmediate(r));
    assert.equal(endCallCount, 1);
    assert.equal(endCallArgCount, 0, 'endCall must be called with no arguments (room via setCallRoom)');
    assert.equal(h.orderController.getState().activeReview, null);
    assert.equal(h.stateStore.get().orderReview, null);
    assert.ok(
      logs.some(
        (l) =>
          l.ev === 'store_end_call' &&
          l.data?.reason === 'participant_disconnected' &&
          l.data?.called === true &&
          l.data?.ok === true,
      ),
    );

    handle.cleanup();
  }

  // 2) Session close triggers endCall + clears review state + logs store_end_call.
  {
    const h = await setupHarness({ room: 'room-end-close' });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-close'));
    assert.ok(h.orderController.getState().activeReview);

    const fakeRoom = new EventEmitter();
    const fakeSession = new EventEmitter();
    let endCallCount = 0;
    const logs: RecordedLog[] = [];

    const handle = attachEndCallCleanup({
      roomName: 'room-end-close',
      room: fakeRoom as never,
      session: fakeSession as never,
      getShopperIdentity: () => 'shopper-99',
      isSessionStarted: () => true,
      clearReviewState: () => h.orderController.invalidateReview(),
      loadStoreModule: async () => ({
        endCall: async () => {
          endCallCount += 1;
        },
      }),
      log: (r, ev, data) => logs.push({ room: r, ev, data }),
    });

    fakeSession.emit(voice.AgentSessionEventTypes.Close, { reason: 'user_initiated' });
    await new Promise((r) => setImmediate(r));

    assert.equal(endCallCount, 1);
    assert.equal(h.orderController.getState().activeReview, null);
    assert.equal(h.stateStore.get().orderReview, null);
    assert.ok(
      logs.some(
        (l) =>
          l.ev === 'store_end_call' &&
          l.data?.reason === 'session_close' &&
          l.data?.called === true &&
          l.data?.ok === true,
      ),
    );

    handle.cleanup();
  }

  // 3) Default store endCall is tolerated, never throws, still clears review state.
  {
    const h = await setupHarness({ room: 'room-end-absent' });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-absent'));
    assert.ok(h.orderController.getState().activeReview);

    const logs: RecordedLog[] = [];
    const ok = await endStoreCall('room-end-absent', {
      reason: 'session_close',
      clearReviewState: () => h.orderController.invalidateReview(),
      log: (r, ev, data) => logs.push({ room: r, ev, data }),
    });
    assert.equal(typeof ok, 'boolean');
    assert.equal(h.orderController.getState().activeReview, null);
    assert.equal(h.stateStore.get().orderReview, null);
    assert.ok(
      logs.some((l) => l.ev === 'store_end_call' && l.data?.reason === 'session_close'),
    );
  }

  // 4) Throwing endCall never throws and logs store_end_call with ok: false.
  {
    const logs: RecordedLog[] = [];
    let cleared = false;
    const ok = await endStoreCall('room-end-throw', {
      reason: 'participant_disconnected',
      clearReviewState: () => {
        cleared = true;
      },
      endCall: async () => {
        throw new Error('signout network error');
      },
      log: (r, ev, data) => logs.push({ room: r, ev, data }),
    });
    assert.equal(ok, false);
    assert.equal(cleared, true);
    assert.ok(
      logs.some(
        (l) =>
          l.ev === 'store_end_call' &&
          l.data?.called === true &&
          l.data?.ok === false,
      ),
    );
  }
});

test('no log line ever carries payment labels or address labels across review, blocked, happy, error, or endCall paths', async () => {
  const h = await setupHarness({ room: 'room-privacy' });
  await h.bagLook();

  // Review + blocked attempt + happy placement + duplicate attempt + endCall.
  await h.tools.review_order!.execute({}, fakeToolOpts('priv-rev'));
  await h.tools.place_order!.execute({ spoken_confirmation: false }, fakeToolOpts('priv-block'));
  await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('priv-place-1'));
  await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('priv-place-2'));
  await endStoreCall('room-privacy', {
    reason: 'session_close',
    clearReviewState: () => h.orderController.invalidateReview(),
    endCall: async () => {},
    log: (r, ev, data) => h.logs.push({ room: r, ev, data }),
  });

  const serializedLogs = JSON.stringify(h.logs);
  assert.equal(
    serializedLogs.includes(CANARY_PAYMENT_LABEL),
    false,
    'logs must never include payment_label',
  );
  assert.equal(
    serializedLogs.includes('9876'),
    false,
    'logs must never include card digits from payment_label',
  );
  assert.equal(
    serializedLogs.includes(CANARY_ADDRESS_LABEL),
    false,
    'logs must never include address_label',
  );
  assert.equal(
    serializedLogs.includes('Evergreen'),
    false,
    'logs must never include street address from address_label',
  );
  assert.equal(
    serializedLogs.includes('payment_label'),
    false,
    'logs must not include payment_label key',
  );
  assert.equal(
    serializedLogs.includes('address_label'),
    false,
    'logs must not include address_label key',
  );
});

test('createAgentTools respects ALICE_PURCHASE and ALICE_PURCHASE_MAX_USD from process.env when not overridden', async () => {
  const prevSwitch = process.env.ALICE_PURCHASE;
  const prevMax = process.env.ALICE_PURCHASE_MAX_USD;
  try {
    process.env.ALICE_PURCHASE = 'on';
    process.env.ALICE_PURCHASE_MAX_USD = '150';
    const fakePrepare: PrepareOrderFn = async () => makeOrderReview({ total: 151 });
    const fakePlace: PlaceOrderFn = async (orderId) => makePlacedReview(orderId, []);
    const logs: RecordedLog[] = [];
    const { page } = createFakePage(() => ({ ok: true, confirmed: true }));
    const outfit = makeOutfit();

    const tools = createAgentTools({
      room: 'room-env',
      log: (r, ev, data) => logs.push({ room: r, ev, data }),
      page,
      deps: {
        buildOutfits: async (): Promise<BuildResult> => ({
          outfits: [outfit],
          source: 'live',
          timing: { first_outfit_ms: 10, total_ms: 20 },
          problems: [],
        }),
        outfitCollage: async () => null,
        tryOn: async () => ({ url: '/tryon/t1.jpg', path: '/tmp/t1.jpg', ms: 10, id: 't1' }),
        addToBag: async () => makeRealBagOut(),
        prepareOrder: fakePrepare,
        placeOrder: fakePlace,
      },
    });

    assert.equal('review_order' in tools, true);
    assert.equal('place_order' in tools, true);

    await tools.set_department.execute({ department: 'men' }, fakeToolOpts('e1'));
    await tools.build_outfits.execute({ occasion: 'dinner', budget_usd: 200 }, fakeToolOpts('e2'));
    await tools.pick_outfit.execute({ outfit: 1 }, fakeToolOpts('e3'));
    await tools.add_to_bag.execute({ outfit: 1, sizes: { top: 'M', shoes: '10' } }, fakeToolOpts('e4'));
    await tools.review_order!.execute({}, fakeToolOpts('e5'));

    const res = await tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('e6'));
    assert.equal(res, ORDER_OVER_LIMIT);
    assert.ok(logs.some((l) => l.ev === 'order_blocked' && l.data?.reason === 'over_max_usd'));
  } finally {
    if (prevSwitch === undefined) delete process.env.ALICE_PURCHASE;
    else process.env.ALICE_PURCHASE = prevSwitch;
    if (prevMax === undefined) delete process.env.ALICE_PURCHASE_MAX_USD;
    else process.env.ALICE_PURCHASE_MAX_USD = prevMax;
  }
});

test('place_order starts with the exact fixed outcome sentence for all four outcomes and keeps NOT DONE when blocked', async () => {
  // Exact exported constant strings.
  assert.equal(
    ORDER_OUTCOME_ALL_PLACED,
    'Your order is placed. The confirmation is on screen and in your Shop app.',
  );
  assert.equal(
    ORDER_OUTCOME_PARTIAL,
    'Part of your order is placed. For the rest, finish on the store page using the links on screen.',
  );
  assert.equal(
    ORDER_OUTCOME_HANDOFF,
    'I could not place this one in the call. Finish on the store page using the link on screen. You have not been charged by me.',
  );
  assert.equal(
    ORDER_OUTCOME_UNKNOWN,
    'The payment may still be processing. Check your Shop app or email before trying again. Do not order again yet.',
  );

  const verbatimRe = /Say that exact sentence first, word for word, before anything else\./;

  // 1) Every store placed -> ORDER_OUTCOME_ALL_PLACED.
  {
    const h = await setupHarness({
      placeOrder: async (orderId) =>
        makePlacedReview(orderId, [
          {
            store: 'Everlane',
            items: [],
            total: 60,
            payment_label: CANARY_PAYMENT_LABEL,
            ready: true,
            status: 'placed',
            order_number: '#EV-100',
          },
          {
            store: 'Kith',
            items: [],
            total: 80,
            payment_label: CANARY_PAYMENT_LABEL,
            ready: true,
            status: 'placed',
            order_number: '#KT-200',
          },
        ]),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-all'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('pl-all'));
    assert.equal(res.startsWith(ORDER_OUTCOME_ALL_PLACED), true);
    assert.match(res, verbatimRe);
    assert.match(res, /Everlane: placed \(order #EV-100\)/);
    assert.match(res, /Kith: placed \(order #KT-200\)/);
  }

  // 2) Some placed, some handed off -> ORDER_OUTCOME_PARTIAL.
  {
    const h = await setupHarness();
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-part'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('pl-part'));
    assert.equal(res.startsWith(ORDER_OUTCOME_PARTIAL), true);
    assert.match(res, verbatimRe);
  }

  // 3) Nothing placed, hand-off -> ORDER_OUTCOME_HANDOFF.
  {
    const h = await setupHarness({
      placeOrder: async (orderId) =>
        makePlacedReview(orderId, [
          {
            store: 'Everlane',
            items: [],
            total: 60,
            payment_label: null,
            ready: false,
            status: 'handoff',
            continue_url: 'https://everlane.example/cart/1',
          },
          {
            store: 'Kith',
            items: [],
            total: 80,
            payment_label: null,
            ready: false,
            status: 'handoff',
            continue_url: 'https://kith.example/cart/1',
          },
        ]),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-ho'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('pl-ho'));
    assert.equal(res.startsWith(ORDER_OUTCOME_HANDOFF), true);
    assert.match(res, verbatimRe);
  }

  // 4) Unknown / payment may still be processing -> ORDER_OUTCOME_UNKNOWN, no retry and no link offered.
  {
    const h = await setupHarness({
      placeOrder: async (orderId) =>
        makePlacedReview(orderId, [
          {
            store: 'Everlane',
            items: [],
            total: 60,
            payment_label: CANARY_PAYMENT_LABEL,
            ready: false,
            status: 'failed',
            note: 'Payment may still be processing. Check your Shop app or email before trying again.',
          },
        ]),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-unk'));
    const res = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('pl-unk'));
    assert.equal(res.startsWith(ORDER_OUTCOME_UNKNOWN), true);
    assert.match(res, verbatimRe);
    assert.match(res, /Do not offer a retry or a store link\./);
    assert.equal(res.includes('hand-off link on screen'), false);
    assert.equal(res.includes('You have not been charged'), false);
  }

  // 4b) Pure classification checks: empty stores, already-sent, and processing-plus-placed all resolve to unknown.
  assert.equal(classifyOrderPlacedOutcome([]), 'unknown');
  assert.equal(
    formatOrderPlacedResult('ord-empty', []).startsWith(ORDER_OUTCOME_UNKNOWN),
    true,
  );
  assert.equal(
    classifyOrderPlacedOutcome([
      {
        store: 'Everlane',
        items: [],
        total: 60,
        payment_label: null,
        ready: false,
        status: 'failed',
        note: ORDER_ALREADY_SENT_NOTE,
      },
    ]),
    'unknown',
  );

  // 5) Blocked before sending (no tap, over limit, stale review) still returns existing NOT DONE messages.
  {
    const h = await setupHarness({
      confirmResponder: () => ({ ok: true, confirmed: false, order_id: 'ord-abc-123' }),
    });
    await h.bagLook();
    await h.tools.review_order!.execute({}, fakeToolOpts('rev-block'));
    const noTap = await h.tools.place_order!.execute({ spoken_confirmation: true }, fakeToolOpts('pl-notap'));
    assert.match(noTap, /^NOT DONE:/);
    assert.equal(noTap.startsWith(ORDER_OUTCOME_HANDOFF), false);
    assert.equal(noTap.startsWith(ORDER_OUTCOME_UNKNOWN), false);
  }
});
