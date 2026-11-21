import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { BagOut } from '../src/types.ts';
import { createShopMcp, ShopMcpError } from '../src/store/shopmcp.ts';
import { createAuthManager, isAllowedAuthTargetUrl, redactSecrets } from '../src/store/auth.ts';
import {
  _resetInvalidCapLogForTests,
  createPurchaseClient,
  deriveCheckoutIdempotencyUuid,
  parseMaxUsd,
  parseSessionMaxUsd,
} from '../src/store/purchase.ts';
import { setCallLogSink, setCallRoom } from '../src/store/log.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const VALID_ROOM = 'alice-a1b2c3d4e5';
const OTHER_VALID_ROOM = 'alice-0011223344';

function jsonRpcOk(structuredContent: any): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        structuredContent,
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeFakeAddress(overrides?: Record<string, unknown>) {
  return {
    id: 'addr-brooklyn-1',
    first_name: 'Sam',
    last_name: 'Lee',
    street_address: '742 Evergreen Terrace Apt 4B',
    address_locality: 'Brooklyn',
    address_region: 'NY',
    postal_code: '11201',
    address_country: 'US',
    ...overrides,
  };
}

function makeFakeAccount(overrides?: Record<string, unknown>) {
  return {
    buyer: { email: 'sam.secret@example.com' },
    addresses: [makeFakeAddress()],
    preferred_address_id: 'addr-brooklyn-1',
    selectable_instruments: [
      { id: 'card-4242', type: 'card', last4: '4242', brand: 'visa' },
    ],
    ...overrides,
  };
}

function makeShopPayInstrument(overrides?: Record<string, unknown>) {
  return {
    id: 'inst-shop-pay-1',
    handler_id: 'shop_pay',
    type: 'shop_pay',
    credential: { type: 'shop_token', token: 'secret_instrument_cred_999' },
    selected: true,
    ...overrides,
  };
}

function makeCheckoutDoc(opts?: {
  id?: string;
  status?: string;
  currency?: string;
  totals?: any[];
  line_items?: any[];
  totalCents?: number;
  variantId?: string;
  title?: string;
  qty?: number;
  withAddress?: boolean;
  address?: Record<string, unknown>;
  instruments?: any[];
  continueUrl?: string;
  order?: any;
  confirmation_number?: string;
}) {
  const id = opts?.id ?? 'chk_secret_key_123';
  const totalCents = opts?.totalCents ?? 6800;
  const variantId = opts?.variantId ?? 'gid://shopify/ProductVariant/111';
  const title = opts?.title ?? 'Linen Shirt';
  const qty = opts?.qty ?? 1;
  const addr = opts?.address ?? makeFakeAddress();
  return {
    id,
    status: opts?.status ?? 'ready_for_complete',
    currency: opts?.currency ?? 'USD',
    line_items:
      opts?.line_items ??
      [
        {
          id: 'line-1',
          item: {
            id: variantId,
            title,
            price: totalCents,
            image_url: 'https://cdn.example.com/1.jpg',
          },
          quantity: qty,
          totals: [{ type: 'total', amount: totalCents }],
        },
      ],
    totals:
      opts?.totals ??
      [
        { type: 'subtotal', amount: totalCents },
        { type: 'total', amount: totalCents },
      ],
    fulfillment: {
      methods: [
        {
          type: 'shipping',
          destinations: opts?.withAddress ? [addr] : [],
          ...(opts?.withAddress ? { selected_destination_id: String(addr.id) } : {}),
        },
      ],
    },
    payment: {
      instruments: opts?.instruments ?? [makeShopPayInstrument()],
    },
    messages: [],
    continue_url: opts?.continueUrl ?? 'https://store.example.com/checkouts/chk_secret_key_123',
    ...(opts?.order !== undefined ? { order: opts.order } : {}),
    ...(opts?.confirmation_number !== undefined
      ? { confirmation_number: opts.confirmation_number }
      : {}),
    next: [{ action: 'update' }],
    signals: { 'dev.ucp.buyer_ip': '1.2.3.4' },
    attribution: { source: 'shop' },
  };
}

function makeBag(
  stores?: Array<{
    store: string;
    domain: string;
    cartId: string | null;
    total: number;
    variantId?: string;
    itemId?: string;
    title?: string;
    url?: string;
  }>,
): BagOut {
  const list = stores ?? [
    {
      store: 'Everlane',
      domain: 'm34kzg-ke.myshopify.com',
      cartId: 'cart-ev-1',
      total: 68,
      variantId: 'gid://shopify/ProductVariant/111',
      itemId: 'prod-1',
      title: 'Linen Shirt',
      url: 'https://everlane.com/cart/c1',
    },
  ];
  return {
    carts: list.map((s) => ({
      store: s.store,
      store_domain: s.domain,
      cart_id: s.cartId,
      continue_url: s.url ?? `https://${s.domain}/cart/fallback`,
      total_usd: s.total,
      added: [
        {
          variant_id: s.variantId ?? 'gid://shopify/ProductVariant/111',
          title: s.title ?? 'Linen Shirt',
          size: 'M',
          slot: 'top',
          image: 'https://cdn.example.com/1.jpg',
          price: s.total,
          item_id: s.itemId ?? 'prod-1',
        } as any,
      ],
      not_added: [],
      ms: 10,
    })),
    summary: 'Bag ready',
    total_usd: list.reduce((sum, s) => sum + s.total, 0),
  };
}

function makeSignedInAuth(
  fakeToken: string,
  nowFn: () => number,
  opts?: {
    mcpUrl?: () => string;
    expiresInS?: number;
    isPurchaseEnabled?: () => boolean;
    getRoom?: () => string | null;
    subscribeRoomChange?: boolean;
  },
) {
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let tokenPolls = 0;

  const fakeOAuthFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (url.includes('/oauth/device')) {
      return new Response(
        JSON.stringify({
          device_code: 'secret_device_code_XYZ987',
          user_code: 'ABCD-1234',
          verification_uri: 'https://accounts.shop.app/activate',
          verification_uri_complete: 'https://accounts.shop.app/activate?user_code=ABCD-1234',
          expires_in: 600,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/oauth/token')) {
      tokenPolls += 1;
      assert.equal(body.get('resource'), null, 'token poll must NOT resend resource');
      return new Response(
        JSON.stringify({
          access_token: fakeToken,
          token_type: 'Bearer',
          scope: 'openid email personal_agent',
          expires_in: opts?.expiresInS ?? 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected OAuth URL: ${url}`);
  };

  const auth = createAuthManager({
    fetch: fakeOAuthFetch,
    now: nowFn,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearSchedule: (h: any) => {
      if (h) h.cleared = true;
    },
    mcpUrl: opts?.mcpUrl ?? (() => 'https://mcp.shop.com/'),
    isPurchaseEnabled: opts?.isPurchaseEnabled ?? (() => true),
    getRoom: opts?.getRoom ?? (() => VALID_ROOM),
    subscribeRoomChange: opts?.subscribeRoomChange ?? false,
  });

  async function completeSignIn() {
    const before = scheduled.length;
    const start = await auth.startSignIn();
    assert.equal(auth.signInStatus(), 'pending');
    assert.equal(scheduled.length, before + 1);
    scheduled[scheduled.length - 1].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(auth.signInStatus(), 'signed_in');
    return start;
  }

  return { auth, completeSignIn, scheduled, getTokenPolls: () => tokenPolls };
}

describe('purchase switch, Shop MCP allowlist, and HTTP 401 behavior (M6, L5)', () => {
  it('switch off (default and non-"on" values) leaves allowlist unchanged and denies checkout/account tools with zero network calls', async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonRpcOk({});
    };

    for (const val of [undefined, '', 'off', 'true', '1', 'ON', ' on ']) {
      const mcp = createShopMcp({
        fetch: fakeFetch,
        isPurchaseEnabled: () => val === 'on',
        getAuthToken: () => 'tok_should_never_be_used',
      });

      for (const tool of [
        'get_account',
        'create_checkout',
        'update_checkout',
        'get_checkout',
        'complete_checkout',
        'complete_spend_request',
        'create_spend_request',
      ]) {
        await assert.rejects(
          () => mcp.call(tool, {}),
          (err: unknown) => err instanceof ShopMcpError && err.code === 'denied',
          `expected ${tool} to be denied when switch=${String(val)}`,
        );
      }
    }
    assert.equal(fetchCalls, 0);
  });

  it('switch on still denies complete_spend_request, unlisted tools, and direct complete_checkout calls outside placeOrder', async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonRpcOk({});
    };

    const mcp = createShopMcp({
      fetch: fakeFetch,
      isPurchaseEnabled: () => true,
      getAuthToken: () => 'tok_valid_123456',
    });

    for (const tool of [
      'complete_spend_request',
      'create_spend_request',
      'get_spend_request',
      'update_spend_request',
      'cancel_spend_request',
      'search_orders',
      'complete_checkout',
    ]) {
      await assert.rejects(
        () => mcp.call(tool, {}),
        (err: unknown) => err instanceof ShopMcpError && err.code === 'denied',
        `expected ${tool} to be denied`,
      );
    }
    assert.equal(fetchCalls, 0);
  });

  it('M6: startSignIn refuses with zero network calls when ALICE_PURCHASE is not on and leaves status "none"', async () => {
    let oauthCalls = 0;
    const auth = createAuthManager({
      fetch: async () => {
        oauthCalls += 1;
        return new Response('{}', { status: 200 });
      },
      isPurchaseEnabled: () => false,
      mcpUrl: () => 'https://mcp.shop.com/',
      getRoom: () => VALID_ROOM,
      subscribeRoomChange: false,
    });

    const res = await auth.startSignIn();
    assert.ok(res.error);
    assert.equal(res.url, '');
    assert.equal(auth.signInStatus(), 'none');
    assert.equal(oauthCalls, 0);
  });

  it('L5: HTTP 401 with NO Authorization header keeps throwing code "http" without invalidating token; authenticated 401 maps to "auth"', async () => {
    let invalidated = 0;
    const mcp = createShopMcp({
      url: 'https://mcp.shop.com/',
      fetch: async () => new Response('', { status: 401 }),
      isPurchaseEnabled: () => true,
      getAuthToken: () => 'tok_still_valid_123456',
      onInvalidToken: () => {
        invalidated += 1;
      },
    });

    // Unauthenticated catalog call -> no Authorization header -> must keep code 'http'
    await assert.rejects(
      () => mcp.call('search_catalog', { catalog: { query: 'shirt' } }),
      (err: unknown) => err instanceof ShopMcpError && err.code === 'http' && err.status === 401,
    );
    assert.equal(invalidated, 0);

    // Authenticated get_account call -> Authorization header present -> maps to 'auth' and invalidates token
    await assert.rejects(
      () => mcp.call('get_account', {}, { authenticated: true }),
      (err: unknown) => err instanceof ShopMcpError && err.code === 'auth' && err.status === 401,
    );
    assert.equal(invalidated, 1);
  });

  it('prepareOrder returns { disabled: true } and placeOrder returns handoff with cart link when switch is off', async () => {
    let switchOn = true;
    let clock = 1_000_000;
    let fetchCalls = 0;
    const { auth, completeSignIn } = makeSignedInAuth('tok_switch_off_test_123', () => clock, {
      isPurchaseEnabled: () => switchOn,
      getRoom: () => VALID_ROOM,
    });
    await completeSignIn();

    switchOn = false;
    const mcp = createShopMcp({
      fetch: async () => {
        fetchCalls += 1;
        return jsonRpcOk({});
      },
      isPurchaseEnabled: () => switchOn,
      getAuthToken: () => auth.getToken(),
    });
    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => switchOn,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const resOff = await purchase.prepareOrder(makeBag());
    assert.equal(resOff.disabled, true);
    assert.equal(fetchCalls, 0);

    // Prepare with switch on, then flip switch off before placeOrder
    switchOn = true;
    const mcp2 = createShopMcp({
      fetch: async (_u, init) => {
        fetchCalls += 1;
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        if (name === 'create_checkout') return jsonRpcOk(makeCheckoutDoc({ status: 'incomplete', withAddress: false }));
        if (name === 'update_checkout') return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
        throw new Error(`unexpected tool ${name}`);
      },
      isPurchaseEnabled: () => switchOn,
      getAuthToken: () => auth.getToken(),
    });
    const purchase2 = createPurchaseClient({
      mcp: mcp2,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => switchOn,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const reviewed = await purchase2.prepareOrder(makeBag());
    assert.equal(reviewed.stores[0].ready, true);
    const callsAfterPrepare = fetchCalls;

    switchOn = false;
    const placed = await purchase2.placeOrder(reviewed.order_id, {
      idempotencyKey: 'idem-1',
      confirmedByTap: true,
    });
    assert.equal(fetchCalls, callsAfterPrepare, 'ZERO network calls when switch turned off');
    assert.equal(placed.stores[0].status, 'handoff');
    assert.equal(placed.stores[0].continue_url, 'https://everlane.com/cart/c1');
  });
});

describe('OAuth device flow, room binding, host pinning, redirects, and secret redaction (M2)', () => {
  it('runs device flow with exact params, handles authorization_pending -> slow_down (+5s) -> signed_in, and clears on expiry & signOut', async () => {
    let clock = 5_000_000;
    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const seenDeviceParams: URLSearchParams[] = [];
    const seenTokenParams: URLSearchParams[] = [];
    let pollStep = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (url.includes('/oauth/device')) {
        seenDeviceParams.push(params);
        return new Response(
          JSON.stringify({
            device_code: 'dev_secret_999999',
            user_code: 'SHOP-4242',
            verification_uri: 'https://accounts.shop.app/activate',
            verification_uri_complete: 'https://accounts.shop.app/activate?user_code=SHOP-4242',
            expires_in: 300,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      seenTokenParams.push(params);
      pollStep += 1;
      if (pollStep === 1) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
      }
      if (pollStep === 2) {
        return new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: 'tok_live_secret_abcdef123456',
          token_type: 'Bearer',
          expires_in: 60,
        }),
        { status: 200 },
      );
    };

    const auth = createAuthManager({
      fetch: fakeFetch,
      now: () => clock,
      schedule: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        scheduled.push(entry);
        return entry;
      },
      clearSchedule: (h: any) => {
        if (h) h.cleared = true;
      },
      mcpUrl: () => 'https://mcp.shop.com/',
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      subscribeRoomChange: false,
    });

    assert.equal(auth.signInStatus(), 'none');
    const started = await auth.startSignIn();
    assert.equal(started.url, 'https://accounts.shop.app/activate?user_code=SHOP-4242');
    assert.equal(started.code, 'SHOP-4242');
    assert.equal(started.expires_in_s, 300);
    assert.equal(auth.signInStatus(), 'pending');
    assert.equal(auth.getSignedInRoom(), VALID_ROOM);

    assert.equal(seenDeviceParams[0].get('client_id'), '5c733ab2-1903-400a-891e-7ba20c09e2a3');
    assert.equal(seenDeviceParams[0].get('resource'), 'https://mcp.shop.com');
    assert.equal(seenDeviceParams[0].get('scope'), 'openid email personal_agent');
    assert.ok((seenDeviceParams[0].get('device_name') ?? '').length > 0);

    assert.equal(scheduled[0].ms, 5000);
    scheduled[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(auth.signInStatus(), 'pending');
    assert.equal(seenTokenParams[0].get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(seenTokenParams[0].get('resource'), null);

    assert.equal(scheduled[1].ms, 5000);
    scheduled[1].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(auth.signInStatus(), 'pending');
    assert.equal(scheduled[2].ms, 10000);

    scheduled[2].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(auth.signInStatus(), 'signed_in');
    assert.equal(auth.getToken(), 'tok_live_secret_abcdef123456');

    clock += 60_000;
    assert.equal(auth.getToken(), null);
    assert.equal(auth.signInStatus(), 'expired');

    auth.signOut();
    assert.equal(auth.signInStatus(), 'none');
  });

  it('handles access_denied and expired_token polling outcomes', async () => {
    for (const [oauthErr, expectedStatus] of [
      ['access_denied', 'denied'],
      ['expired_token', 'expired'],
    ] as const) {
      const scheduled: Array<() => void> = [];
      const auth = createAuthManager({
        fetch: async (input) => {
          if (String(input).includes('/oauth/device')) {
            return new Response(
              JSON.stringify({
                device_code: 'dev_code_123456',
                user_code: 'CODE-1',
                verification_uri_complete: 'https://accounts.shop.app/activate?user_code=CODE-1',
                expires_in: 600,
                interval: 5,
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: oauthErr }), { status: 400 });
        },
        schedule: (fn) => {
          scheduled.push(fn);
          return fn;
        },
        clearSchedule: () => {},
        mcpUrl: () => 'https://mcp.shop.com/',
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        subscribeRoomChange: false,
      });
      await auth.startSignIn();
      scheduled[0]();
      await new Promise((r) => setImmediate(r));
      assert.equal(auth.signInStatus(), expectedStatus);
      assert.equal(auth.getToken(), null);
    }
  });

  it('M2: changing call room via setCallRoom auto-signs out; prepareOrder/placeOrder refuse other rooms; signOut & endCall purge reviews while keeping sentCartIds', async () => {
    let clock = 6_000_000;
    setCallRoom(VALID_ROOM);
    try {
      const { auth, completeSignIn } = makeSignedInAuth('tok_room_bound_123', () => clock, {
        getRoom: () => undefined as any, // overridden below
      });
      void auth;
      void completeSignIn;

      // Test automatic sign-out on setCallRoom change
      const scheduled: Array<() => void> = [];
      const liveAuth = createAuthManager({
        fetch: async (input) => {
          if (String(input).includes('/oauth/device')) {
            return new Response(
              JSON.stringify({
                device_code: 'dev_room_123456',
                user_code: 'ROOM-1',
                verification_uri_complete: 'https://accounts.shop.app/activate?user_code=ROOM-1',
                expires_in: 300,
                interval: 5,
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({ access_token: 'tok_room_auto_123456', expires_in: 3600 }),
            { status: 200 },
          );
        },
        schedule: (fn) => {
          scheduled.push(fn);
          return fn;
        },
        clearSchedule: () => {},
        mcpUrl: () => 'https://mcp.shop.com/',
        isPurchaseEnabled: () => true,
        subscribeRoomChange: true,
      });

      await liveAuth.startSignIn();
      scheduled[0]();
      await new Promise((r) => setImmediate(r));
      assert.equal(liveAuth.signInStatus(), 'signed_in');
      assert.equal(liveAuth.getSignedInRoom(), VALID_ROOM);

      // Switching call room automatically signs out!
      setCallRoom(OTHER_VALID_ROOM);
      assert.equal(liveAuth.signInStatus(), 'none');
      assert.equal(liveAuth.getToken(), null);

      // Even without subscription firing, mismatched room refuses prepareOrder & placeOrder with 0 network calls
      let activeRoom: string | null = VALID_ROOM;
      let mcpCalls = 0;
      const { auth: manualAuth, completeSignIn: signInManual } = makeSignedInAuth(
        'tok_room_mismatch_123',
        () => clock,
        { getRoom: () => activeRoom, subscribeRoomChange: false },
      );
      await signInManual();

      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          mcpCalls += 1;
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
          }
          if (name === 'get_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
          }
          if (name === 'complete_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'completed', withAddress: true }));
          }
          throw new Error(`unexpected ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => manualAuth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth: manualAuth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => activeRoom,
        isHarnessEnv: () => false,
        reconcileDelaysMs: [0, 0, 0, 0, 0],
      });

      // Prepare in VALID_ROOM
      const review1 = await purchase.prepareOrder(makeBag());
      assert.equal(review1.stores[0].ready, true);
      assert.equal(purchase._debugStats().pendingReviews, 1);

      // Switch active room to OTHER_VALID_ROOM -> prepareOrder and placeOrder both refuse with 0 calls
      activeRoom = OTHER_VALID_ROOM;
      const callsBefore = mcpCalls;
      const crossPrep = await purchase.prepareOrder(makeBag());
      assert.equal(crossPrep.stores[0].ready, false);
      assert.equal(mcpCalls, callsBefore);

      const crossPlace = await purchase.placeOrder(review1.order_id, {
        idempotencyKey: 'k-cross',
        confirmedByTap: true,
      });
      assert.equal(crossPlace.stores[0].status, 'handoff');
      assert.equal(mcpCalls, callsBefore);

      // Place in VALID_ROOM, then call endCall() -> purges reviews & signs out, but sentCartIds survives!
      activeRoom = VALID_ROOM;
      const placed = await purchase.placeOrder(review1.order_id, {
        idempotencyKey: 'k-good',
        confirmedByTap: true,
      });
      assert.equal(placed.stores[0].status, 'placed');

      // Prepare a second distinct cart so there is a pending review, then call endCall()
      const review2 = await purchase.prepareOrder(
        makeBag([{ store: 'Kith', domain: 'kithnyc.myshopify.com', cartId: 'cart-kith-2', total: 50 }]),
      );
      assert.equal(purchase._debugStats().pendingReviews, 1);
      purchase.endCall();
      assert.equal(manualAuth.signInStatus(), 'none');
      assert.equal(purchase._debugStats().pendingReviews, 0);
      assert.equal(purchase._debugStats().rawInstrumentCount, 0);
      assert.equal(purchase._debugStats().sentCarts, 1, 'sentCartIds MUST outlive signOut/endCall');
      void review2;
    } finally {
      setCallRoom(null);
    }
  });

  it('attaches Authorization ONLY to https://mcp.shop.com with redirect: "error", and refuses sign-in or auth headers for any other host', async () => {
    assert.equal(isAllowedAuthTargetUrl('https://mcp.shop.com/'), true);
    assert.equal(isAllowedAuthTargetUrl('https://mcp.shop.com'), true);
    assert.equal(isAllowedAuthTargetUrl('http://mcp.shop.com/'), false);
    assert.equal(isAllowedAuthTargetUrl('https://evil.mcp.shop.com/'), false);
    assert.equal(isAllowedAuthTargetUrl('https://mcp.shop.com.evil.com/'), false);
    assert.equal(isAllowedAuthTargetUrl('https://localhost:3000/'), false);

    let oauthCalls = 0;
    const badHostAuth = createAuthManager({
      fetch: async () => {
        oauthCalls += 1;
        return new Response('{}', { status: 200 });
      },
      mcpUrl: () => 'https://evil.example.com/',
      isPurchaseEnabled: () => true,
      subscribeRoomChange: false,
    });
    const startRes = await badHostAuth.startSignIn();
    assert.ok(startRes.error);
    assert.equal(oauthCalls, 0);

    let mcpFetchCalls = 0;
    const seenHeaders: Record<string, string>[] = [];
    const badHostMcp = createShopMcp({
      url: 'https://evil.example.com/',
      fetch: async (_u, init) => {
        mcpFetchCalls += 1;
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return jsonRpcOk({ products: [] });
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => 'tok_must_never_go_to_evil_host',
    });

    await assert.rejects(
      () => badHostMcp.call('get_account', {}, { authenticated: true }),
      (err: unknown) => err instanceof ShopMcpError && err.code === 'denied',
    );
    assert.equal(mcpFetchCalls, 0);

    await badHostMcp.call('search_catalog', { catalog: { query: 'shirt' } });
    assert.equal(mcpFetchCalls, 1);
    assert.equal(seenHeaders[0].Authorization, undefined);

    const goodHeaders: Record<string, string>[] = [];
    const goodRedirects: Array<string | undefined> = [];
    const goodHostMcp = createShopMcp({
      url: 'https://mcp.shop.com/',
      fetch: async (_u, init) => {
        goodHeaders.push((init?.headers ?? {}) as Record<string, string>);
        goodRedirects.push(init?.redirect);
        return jsonRpcOk(makeFakeAccount());
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => 'tok_good_host_123456',
    });
    await goodHostMcp.call('get_account', {}, { authenticated: true });
    assert.equal(goodHeaders[0].Authorization, 'Bearer tok_good_host_123456');
    assert.equal(goodRedirects[0], 'error');

    const oauthRedirects: Array<{ url: string; redirect?: string }> = [];
    const scheduled: Array<() => void> = [];
    const authRedirectCheck = createAuthManager({
      fetch: async (input, init) => {
        const u = String(input);
        oauthRedirects.push({ url: u, redirect: init?.redirect });
        if (u.includes('/oauth/device')) {
          return new Response(
            JSON.stringify({
              device_code: 'dev_redir_123456',
              user_code: 'REDIR-1',
              verification_uri_complete: 'https://accounts.shop.app/activate?user_code=REDIR-1',
              expires_in: 300,
              interval: 5,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ access_token: 'tok_redir_123456', expires_in: 3600 }),
          { status: 200 },
        );
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return fn;
      },
      clearSchedule: () => {},
      mcpUrl: () => 'https://mcp.shop.com/',
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      subscribeRoomChange: false,
    });
    await authRedirectCheck.startSignIn();
    scheduled[0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(oauthRedirects.length, 2);
    assert.ok(oauthRedirects.every((r) => r.redirect === 'error'));
  });

  it('never leaks token, device_code, street address, email, or card digits in logs, stdout, errors, or return values', async () => {
    const FAKE_TOKEN = 'shpat_SUPER_SECRET_BEARER_TOKEN_987654321';
    let clock = 10_000_000;
    const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map(String).join(' '));
    };
    setCallRoom(VALID_ROOM);
    setCallLogSink((room, ev, data) => logs.push({ room, ev, data }));

    try {
      const { auth, completeSignIn } = makeSignedInAuth(FAKE_TOKEN, () => clock, {
        getRoom: () => VALID_ROOM,
      });
      const signInRes = await completeSignIn();

      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'incomplete', withAddress: false }));
          }
          if (name === 'update_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
          }
          if (name === 'get_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
          }
          if (name === 'complete_checkout') {
            return jsonRpcOk(
              makeCheckoutDoc({
                status: 'completed',
                withAddress: true,
                order: { id: 'ord_1', order_number: '#1042' },
              }),
            );
          }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { message: `Echoed Authorization: Bearer ${FAKE_TOKEN}` },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
        getSecretsForRedaction: () => auth.getSecretsForRedaction(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });

      const review = await purchase.prepareOrder(makeBag());
      const placed = await purchase.placeOrder(review.order_id, {
        idempotencyKey: 'idem-secret-test',
        confirmedByTap: true,
      });

      let caughtErrMsg = '';
      try {
        await mcp.call('search_catalog', { catalog: { query: 'fail' } });
      } catch (err) {
        caughtErrMsg = err instanceof Error ? err.message : String(err);
      }

      assert.equal(review.address_label, 'Brooklyn, NY');
      assert.equal(review.stores[0].payment_label, 'Shop Pay');
      assert.equal(placed.stores[0].status, 'placed');

      const everything = JSON.stringify({
        signInRes,
        review,
        placed,
        logs,
        stdoutLines,
        caughtErrMsg,
      });

      for (const forbidden of [
        FAKE_TOKEN,
        'secret_device_code_XYZ987',
        '742 Evergreen Terrace',
        '11201',
        'sam.secret@example.com',
        '4242',
        'secret_instrument_cred_999',
      ]) {
        assert.equal(
          everything.includes(forbidden),
          false,
          `Forbidden secret "${forbidden}" leaked into output/logs/errors`,
        );
      }
      assert.ok(caughtErrMsg.includes('[REDACTED]'));
      assert.equal(redactSecrets(`Bearer ${FAKE_TOKEN}`), 'Bearer [REDACTED]');
    } finally {
      console.log = origLog;
      setCallLogSink(null);
      setCallRoom(null);
    }
  });
});

describe('prepareOrder checks (M3, M4, M7, subtotal/USD, instruments)', () => {
  it('returns needs_sign_in and starts device flow when not signed in', async () => {
    let clock = 2_000_000;
    let mcpCalls = 0;
    const { auth } = makeSignedInAuth('tok_unused_123456', () => clock);

    const mcp = createShopMcp({
      fetch: async () => {
        mcpCalls += 1;
        return jsonRpcOk({});
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
    });
    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const res = await purchase.prepareOrder(makeBag());
    assert.equal(res.needs_sign_in, true);
    assert.equal(res.sign_in?.url, 'https://accounts.shop.app/activate?user_code=ABCD-1234');
    assert.equal(res.sign_in?.code, 'ABCD-1234');
    assert.equal(mcpCalls, 0);
  });

  it('copies saved address unchanged into update_checkout, strips next/signals/attribution, and never copies buyer.email', async () => {
    let clock = 2_000_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_addr_123456', () => clock);
    await completeSignIn();

    const capturedCalls: Array<{ name: string; args: any }> = [];
    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        const args = body.params?.arguments;
        capturedCalls.push({ name, args });

        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        if (name === 'create_checkout') {
          return jsonRpcOk(makeCheckoutDoc({ status: 'incomplete', withAddress: false }));
        }
        if (name === 'update_checkout') {
          return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
        }
        throw new Error(`Unexpected tool ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const res = await purchase.prepareOrder(makeBag());
    assert.equal(res.stores[0].ready, true);
    assert.equal(res.address_label, 'Brooklyn, NY');

    const createCall = capturedCalls.find((c) => c.name === 'create_checkout');
    assert.deepEqual(createCall?.args?.checkout, { cart_id: 'cart-ev-1', line_items: [] });

    const updateCall = capturedCalls.find((c) => c.name === 'update_checkout');
    assert.ok(updateCall);
    assert.equal(updateCall.args.checkout.next, undefined);
    assert.equal(updateCall.args.checkout.signals, undefined);
    assert.equal(updateCall.args.checkout.attribution, undefined);
    assert.equal(updateCall.args.checkout.buyer, undefined);
    assert.deepEqual(
      updateCall.args.checkout.fulfillment.methods[0].destinations[0],
      makeFakeAddress(),
    );
    assert.equal(
      updateCall.args.checkout.fulfillment.methods[0].selected_destination_id,
      'addr-brooklyn-1',
    );
  });

  it('marks store ready=false when offered instrument is not Shop Pay or when multiple instruments are unselected', async () => {
    let clock = 3_000_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_inst_123456', () => clock);
    await completeSignIn();

    for (const instruments of [
      [{ id: 'card-1', type: 'card', handler_id: 'stripe', selected: true }],
      [
        { id: 'card-1', type: 'card', handler_id: 'stripe' },
        { id: 'inst-sp', type: 'shop_pay', handler_id: 'shop_pay' },
      ],
      [],
    ]) {
      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            return jsonRpcOk(
              makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true, instruments }),
            );
          }
          throw new Error(`Unexpected tool ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });

      const review = await purchase.prepareOrder(makeBag());
      assert.equal(review.stores[0].ready, false);
      assert.equal(review.stores[0].status, 'handoff');
      assert.ok(review.stores[0].note && review.stores[0].note.length > 0);
    }
  });

  it('subtotal-only checkout and non-USD checkout are never ready in prepareOrder', async () => {
    let clock = 3_500_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_subtotal_123456', () => clock);
    await completeSignIn();

    const cases = [
      makeCheckoutDoc({
        status: 'ready_for_complete',
        withAddress: true,
        currency: 'USD',
        totals: [{ type: 'subtotal', amount: 6800 }],
      }),
      makeCheckoutDoc({
        status: 'ready_for_complete',
        withAddress: true,
        currency: 'CAD',
        totals: [
          { type: 'subtotal', amount: 6800 },
          { type: 'total', amount: 7480 },
        ],
      }),
      makeCheckoutDoc({
        status: 'ready_for_complete',
        withAddress: true,
        currency: 'USD',
        totals: [
          { type: 'subtotal', amount: 6800, currency: 'USD' },
          { type: 'total', amount: 7480, currency: 'EUR' },
        ],
      }),
    ];

    for (const checkoutDoc of cases) {
      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') return jsonRpcOk(checkoutDoc);
          throw new Error(`Unexpected tool ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });

      const review = await purchase.prepareOrder(makeBag());
      assert.equal(review.stores[0].ready, false);
      assert.equal(review.stores[0].status, 'handoff');
      assert.equal(review.stores[0].note, 'Total not final yet; finish on the store page.');
      assert.ok(review.stores[0].continue_url);
    }
  });

  it('M3: checkout with extra item builds review items & total from checkout, marks not ready, and hands off', async () => {
    let clock = 4_000_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_m3_123456', () => clock);
    await completeSignIn();

    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        if (name === 'create_checkout') {
          return jsonRpcOk(
            makeCheckoutDoc({
              status: 'ready_for_complete',
              withAddress: true,
              totalCents: 11800,
              line_items: [
                {
                  id: 'line-1',
                  item: { id: 'gid://shopify/ProductVariant/111', title: 'Linen Shirt', price: 6800 },
                  quantity: 1,
                },
                {
                  id: 'line-2',
                  item: { id: 'gid://shopify/ProductVariant/999', title: 'Surprise Extra Item', price: 5000 },
                  quantity: 1,
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected tool ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const review = await purchase.prepareOrder(makeBag());
    assert.equal(review.stores[0].ready, false);
    assert.equal(review.stores[0].status, 'handoff');
    assert.equal(review.stores[0].total, 118);
    assert.equal(review.stores[0].items.length, 2);
    assert.equal(review.stores[0].items[1].title, 'Surprise Extra Item');
    assert.ok(review.stores[0].continue_url);
  });

  it('M4: empty checkout line_items is never ready at prepare and refused at place', async () => {
    let clock = 4_100_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_m4_123456', () => clock);
    await completeSignIn();

    // Empty at prepare
    {
      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true, line_items: [] }));
          }
          throw new Error(`Unexpected tool ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });
      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });
      const review = await purchase.prepareOrder(makeBag());
      assert.equal(review.stores[0].ready, false);
      assert.equal(review.stores[0].status, 'handoff');
    }

    // Valid at prepare, empty on live get_checkout at place -> refused, 0 complete_checkout
    {
      let completeCalls = 0;
      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true }));
          }
          if (name === 'get_checkout') {
            return jsonRpcOk(makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true, line_items: [] }));
          }
          if (name === 'complete_checkout') {
            completeCalls += 1;
            return jsonRpcOk(makeCheckoutDoc({ status: 'completed', withAddress: true }));
          }
          throw new Error(`Unexpected tool ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });
      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });
      const review = await purchase.prepareOrder(makeBag());
      assert.equal(review.stores[0].ready, true);
      const placed = await purchase.placeOrder(review.order_id, {
        idempotencyKey: 'k-m4',
        confirmedByTap: true,
      });
      assert.equal(placed.stores[0].status, 'handoff');
      assert.equal(completeCalls, 0);
    }
  });

  it('M7: address_label comes from checkout selected destination, and non-default destination marks store not ready', async () => {
    let clock = 4_200_000;
    const { auth, completeSignIn } = makeSignedInAuth('tok_m7_123456', () => clock);
    await completeSignIn();

    const otherAddress = makeFakeAddress({
      id: 'addr-sf-other',
      street_address: '100 Market St',
      address_locality: 'San Francisco',
      address_region: 'CA',
      postal_code: '94105',
    });

    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        if (name === 'create_checkout') {
          return jsonRpcOk(
            makeCheckoutDoc({
              status: 'ready_for_complete',
              withAddress: true,
              address: otherAddress,
            }),
          );
        }
        throw new Error(`Unexpected tool ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      getRoom: () => VALID_ROOM,
      isHarnessEnv: () => false,
    });

    const review = await purchase.prepareOrder(makeBag());
    assert.equal(review.address_label, 'San Francisco, CA');
    assert.equal(review.stores[0].ready, false);
    assert.equal(review.stores[0].status, 'handoff');
    assert.ok(review.stores[0].continue_url);
  });
});

describe('placeOrder safety gates, cart locks, session cap, polling, and purging (H1-H3, M1, M5, L3, L4)', () => {
  async function setupPrepared(opts?: {
    stores?: Array<{
      store: string;
      domain: string;
      cartId: string | null;
      total: number;
      variantId?: string;
      title?: string;
    }>;
    maxUsd?: number | null;
    sessionMaxUsd?: number | null;
    harnessEnv?: boolean;
    room?: string | null;
    getCheckoutOverride?: (shop: string, callIndex: number) => any;
    completeOverride?: (shop: string, args: any, callIndex: number) => Response | Promise<Response> | Error;
  }) {
    let clock = 20_000_000;
    let activeRoom: string | null = opts?.room !== undefined ? opts.room : VALID_ROOM;
    const { auth, completeSignIn } = makeSignedInAuth('tok_place_test_123456', () => clock, {
      getRoom: () => activeRoom,
    });
    await completeSignIn();

    const calls: Array<{ name: string; shop?: string; args: any; at: number }> = [];
    let getCheckoutIdx = 0;
    let completeIdx = 0;
    let createIdx = 0;
    const storeList = opts?.stores ?? [
      { store: 'Everlane', domain: 'm34kzg-ke.myshopify.com', cartId: 'cart-ev-1', total: 68 },
    ];

    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        const shop = args.shop;
        calls.push({ name, shop, args, at: clock });

        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        const st = storeList.find((s) => s.domain === shop) ?? storeList[0];
        const totalCents = Math.round(st.total * 100);

        if (name === 'create_checkout') {
          createIdx += 1;
          return jsonRpcOk(
            makeCheckoutDoc({
              id: `chk_${st.store}_${createIdx}`,
              status: 'ready_for_complete',
              withAddress: true,
              totalCents,
              variantId: st.variantId,
              title: st.title,
              continueUrl: `https://${st.domain}/checkouts/chk_${st.store}_${createIdx}`,
            }),
          );
        }
        if (name === 'get_checkout') {
          getCheckoutIdx += 1;
          if (opts?.getCheckoutOverride) {
            const custom = opts.getCheckoutOverride(shop, getCheckoutIdx);
            if (custom instanceof Error) throw custom;
            return jsonRpcOk(custom);
          }
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id ?? `chk_${st.store}_1`,
              status: 'ready_for_complete',
              withAddress: true,
              totalCents,
              variantId: st.variantId,
              title: st.title,
              continueUrl: `https://${st.domain}/checkouts/${args.id ?? `chk_${st.store}_1`}`,
            }),
          );
        }
        if (name === 'complete_checkout') {
          completeIdx += 1;
          if (opts?.completeOverride) {
            const custom = await opts.completeOverride(shop, args, completeIdx);
            if (custom instanceof Error) throw custom;
            return custom;
          }
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id ?? `chk_${st.store}_1`,
              status: 'completed',
              withAddress: true,
              totalCents,
              variantId: st.variantId,
              title: st.title,
              order: { id: `ord_${st.store}`, order_number: `ORD-${completeIdx}` },
            }),
          );
        }
        throw new Error(`Unexpected tool ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
      now: () => clock,
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      maxUsd: () => (opts?.maxUsd !== undefined ? opts.maxUsd : null),
      sessionMaxUsd: () => (opts?.sessionMaxUsd !== undefined ? opts.sessionMaxUsd : null),
      isHarnessEnv: () => opts?.harnessEnv ?? false,
      getRoom: () => activeRoom,
      reconcileDelaysMs: [0, 0, 0, 0, 0],
    });

    const bag = makeBag(storeList);
    const reviewed = await purchase.prepareOrder(bag);
    const callsBeforePlace = calls.length;

    return {
      purchase,
      auth,
      bag,
      reviewed,
      calls,
      callsBeforePlace,
      setRoom: (r: string | null) => {
        activeRoom = r;
      },
      advanceClock: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('H1: same cart cannot be bought twice (supersedes earlier unplaced order, blocks re-prepare and re-place after send)', async () => {
    const { purchase, bag, reviewed: order1, calls, advanceClock } = await setupPrepared();

    // Advance past the 8s unchanged-bag reuse window so the second prepareOrder creates a fresh
    // review that supersedes order1 and purges its raw instrument (L3).
    advanceClock(8_001);
    const order2 = await purchase.prepareOrder(bag);
    assert.notEqual(order2.order_id, order1.order_id);
    assert.equal(purchase._debugStats().pendingReviews, 1);

    const callsBeforeOld = calls.length;
    const oldPlace = await purchase.placeOrder(order1.order_id, {
      idempotencyKey: 'k-old',
      confirmedByTap: true,
    });
    assert.equal(calls.length, callsBeforeOld, 'superseded order makes ZERO network calls');
    assert.equal(oldPlace.stores.length, 0);

    // Place order2 -> succeeds once
    const placed2 = await purchase.placeOrder(order2.order_id, {
      idempotencyKey: 'k-new',
      confirmedByTap: true,
    });
    assert.equal(placed2.stores[0].status, 'placed');
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

    // Third prepareOrder on the SAME bag -> not ready, NO continue_url, exact note, ZERO create_checkout calls
    const callsBeforePrep3 = calls.length;
    const order3 = await purchase.prepareOrder(bag);
    assert.equal(calls.length, callsBeforePrep3, 'ZERO network calls on already-sent cart');
    assert.equal(order3.stores[0].ready, false);
    assert.equal(order3.stores[0].continue_url, undefined);
    assert.equal(
      order3.stores[0].note,
      "This store's order was already sent. Check your Shop app or email.",
    );

    // Trying to place order3 also makes ZERO network calls
    const placed3 = await purchase.placeOrder(order3.order_id, {
      idempotencyKey: 'k-third',
      confirmedByTap: true,
    });
    assert.equal(calls.length, callsBeforePrep3);
    assert.equal(placed3.stores[0].status, 'handoff');
    assert.equal(placed3.stores[0].continue_url, undefined);
    assert.equal(
      placed3.stores[0].note,
      "This store's order was already sent. Check your Shop app or email.",
    );
  });

  it('H2: after an unclear completion (complete throws, get_checkout says in progress), second prepareOrder on same bag is not ready with no link and zero create_checkout calls', async () => {
    const { purchase, bag, reviewed, calls } = await setupPrepared({
      completeOverride: () => new Error('socket hang up'),
      getCheckoutOverride: (_shop, idx) => {
        if (idx === 1) return makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true });
        return makeCheckoutDoc({ status: 'complete_in_progress', withAddress: true });
      },
    });

    const first = await purchase.placeOrder(reviewed.order_id, {
      idempotencyKey: 'k-h2',
      confirmedByTap: true,
    });
    assert.equal(first.stores[0].status, 'failed');
    assert.equal(first.stores[0].continue_url, undefined);
    assert.equal(
      first.stores[0].note,
      'Payment may still be processing. Check your Shop app or email before trying again.',
    );

    const createCallsBefore = calls.filter((c) => c.name === 'create_checkout').length;
    const secondPrep = await purchase.prepareOrder(bag);
    assert.equal(calls.filter((c) => c.name === 'create_checkout').length, createCallsBefore);
    assert.equal(secondPrep.stores[0].ready, false);
    assert.equal(secondPrep.stores[0].continue_url, undefined);
    assert.equal(
      secondPrep.stores[0].note,
      "This store's order was already sent. Check your Shop app or email.",
    );
  });

  it('H3: status === "completed" alone means placed with optional order_number (omitted when absent)', async () => {
    // Completed with NO order object at all -> still placed, order_number omitted
    {
      const { purchase, reviewed, calls } = await setupPrepared({
        completeOverride: () =>
          jsonRpcOk(makeCheckoutDoc({ status: 'completed', withAddress: true, order: undefined })),
      });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k-h3-none',
        confirmedByTap: true,
      });
      assert.equal(res.stores[0].status, 'placed');
      assert.equal(res.stores[0].order_number, undefined);
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
      assert.equal(calls.filter((c) => c.name === 'get_checkout').length, 1); // no unnecessary reconcile poll
    }

    // Completed with top-level confirmation_number -> picked up as order_number
    {
      const { purchase, reviewed } = await setupPrepared({
        completeOverride: () =>
          jsonRpcOk(
            makeCheckoutDoc({
              status: 'completed',
              withAddress: true,
              order: undefined,
              confirmation_number: 'CONF-8899',
            }),
          ),
      });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k-h3-conf',
        confirmedByTap: true,
      });
      assert.equal(res.stores[0].status, 'placed');
      assert.equal(res.stores[0].order_number, 'CONF-8899');
    }
  });

  it('M1 + Rule 6: refuses EVERY pre-flight failure (including empty/invalid room and ignored opts.room override) with ZERO network calls', async () => {
    // 1. confirmedByTap !== true
    {
      const { purchase, reviewed, calls, callsBeforePlace } = await setupPrepared();
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k1',
        confirmedByTap: false,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores[0].status, 'handoff');
    }

    // 2. Order does not exist
    {
      const { purchase, calls, callsBeforePlace } = await setupPrepared();
      const res = await purchase.placeOrder('non-existent-order', {
        idempotencyKey: 'k2',
        confirmedByTap: true,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores.length, 0);
    }

    // 3. Order older than 2 minutes (also purges raw instrument per L3!)
    {
      const { purchase, reviewed, calls, callsBeforePlace, advanceClock } = await setupPrepared();
      advanceClock(2 * 60 * 1000);
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k3',
        confirmedByTap: true,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores[0].status, 'handoff');
      assert.match(res.stores[0].note ?? '', /expired/i);
      assert.equal(purchase._debugStats().pendingReviews, 0);
      assert.equal(purchase._debugStats().rawInstrumentCount, 0);
    }

    // 4. Signed out after prepare
    {
      const { purchase, auth, reviewed, calls, callsBeforePlace } = await setupPrepared();
      auth.signOut();
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k4',
        confirmedByTap: true,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores.length, 0); // purged on signOut (M2/L3)
    }

    // 5. Total exceeds configured ALICE_PURCHASE_MAX_USD cap -> refused with 0 calls
    {
      const { purchase, reviewed, calls, callsBeforePlace } = await setupPrepared({
        stores: [
          { store: 'Everlane', domain: 'm34kzg-ke.myshopify.com', cartId: 'c1', total: 80 },
          { store: 'Kith', domain: 'kithnyc.myshopify.com', cartId: 'c2', total: 75 },
        ],
        maxUsd: 150,
      });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k5',
        confirmedByTap: true,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores.every((s) => s.status === 'handoff'), true);
      assert.match(res.stores[0].note ?? '', /150/);
    }

    // 6. M1: Empty/null room refuses even if caller tries to override with valid opts.room
    {
      const { purchase, reviewed, calls, callsBeforePlace, setRoom } = await setupPrepared();
      setRoom(null);
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k6-empty',
        confirmedByTap: true,
        room: VALID_ROOM, // MUST BE IGNORED
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores[0].status, 'handoff');
    }

    // 7. M1: Non-token-server room shapes refuse even if opts.room is valid
    for (const badRoom of ['alice-e2e-run', 'harness-1', 'live-probe', 'TestRoom', 'alice-12345', 'alice-zzzzzzzzzz']) {
      const { purchase, reviewed, calls, callsBeforePlace, setRoom } = await setupPrepared();
      setRoom(badRoom);
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k7',
        confirmedByTap: true,
        room: VALID_ROOM, // MUST BE IGNORED
      });
      assert.equal(calls.length, callsBeforePlace, `expected 0 calls for room ${badRoom}`);
      assert.equal(res.stores[0].status, 'handoff');
    }

    // 8. ALICE_HARNESS set
    {
      const { purchase, reviewed, calls, callsBeforePlace } = await setupPrepared({ harnessEnv: true });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k8',
        confirmedByTap: true,
      });
      assert.equal(calls.length, callsBeforePlace);
      assert.equal(res.stores[0].status, 'handoff');
    }
  });

  it('optional spend caps: no cap by default (large order passes), each cap enforced when env is set without clamps, invalid values treated as unset and logged once', async () => {
    // Unset / empty -> null (no cap)
    assert.equal(parseMaxUsd(undefined), null);
    assert.equal(parseMaxUsd(''), null);
    assert.equal(parseMaxUsd('   '), null);
    assert.equal(parseSessionMaxUsd(undefined), null);
    assert.equal(parseSessionMaxUsd(''), null);

    // Positive numbers preserved without upper clamp
    assert.equal(parseMaxUsd('99999'), 99999);
    assert.equal(parseMaxUsd('200'), 200);
    assert.equal(parseSessionMaxUsd('99999'), 99999);
    assert.equal(parseSessionMaxUsd('400'), 400);

    // Invalid values (zero, negative, non-numeric) -> null and logged ONCE per env var
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    _resetInvalidCapLogForTests();
    try {
      assert.equal(parseMaxUsd('0'), null);
      assert.equal(parseMaxUsd('-50'), null);
      assert.equal(parseMaxUsd('abc'), null);
      assert.equal(parseSessionMaxUsd('0'), null);
      assert.equal(parseSessionMaxUsd('-10'), null);
      assert.equal(parseSessionMaxUsd('nope'), null);
    } finally {
      console.log = origLog;
      _resetInvalidCapLogForTests();
    }
    assert.deepEqual(
      logged.filter((l) => l.includes('ALICE_PURCHASE_MAX_USD')),
      ['[store] ignoring invalid ALICE_PURCHASE_MAX_USD'],
    );
    assert.deepEqual(
      logged.filter((l) => l.includes('ALICE_PURCHASE_SESSION_MAX_USD')),
      ['[store] ignoring invalid ALICE_PURCHASE_SESSION_MAX_USD'],
    );

    // No cap by default: a large $2,500 order passes the cap gate and places cleanly
    {
      const { purchase, reviewed } = await setupPrepared({
        stores: [{ store: 'Kith', domain: 'kithnyc.myshopify.com', cartId: 'cart-big', total: 2500 }],
      });
      const placed = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k-big',
        confirmedByTap: true,
      });
      assert.equal(placed.stores[0].status, 'placed');
    }

    // Per-order cap and cumulative session cap enforced via env vars with zero network calls
    const origMax = process.env.ALICE_PURCHASE_MAX_USD;
    const origSession = process.env.ALICE_PURCHASE_SESSION_MAX_USD;
    try {
      process.env.ALICE_PURCHASE_MAX_USD = '150';
      process.env.ALICE_PURCHASE_SESSION_MAX_USD = '300';

      let clock = 25_000_000;
      const { auth, completeSignIn } = makeSignedInAuth('tok_env_caps_123456', () => clock);
      await completeSignIn();
      const calls: Array<{ name: string }> = [];
      let idx = 0;

      const cartMetaByCheckout = new Map<string, string>();
      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          calls.push({ name });
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            idx += 1;
            const cartId = body.params?.arguments?.checkout?.cart_id;
            const cents = cartId === 'cart-over-order' ? 16000 : 14000;
            const variantId = `gid://shopify/ProductVariant/${cartId}`;
            const coId = `chk_cap_${idx}`;
            cartMetaByCheckout.set(coId, variantId);
            return jsonRpcOk(
              makeCheckoutDoc({
                id: coId,
                status: 'ready_for_complete',
                withAddress: true,
                totalCents: cents,
                variantId,
              }),
            );
          }
          if (name === 'get_checkout') {
            const coId = body.params?.arguments?.id;
            return jsonRpcOk(
              makeCheckoutDoc({
                id: coId,
                status: 'ready_for_complete',
                withAddress: true,
                totalCents: 14000,
                variantId: cartMetaByCheckout.get(coId),
              }),
            );
          }
          if (name === 'complete_checkout') {
            const coId = body.params?.arguments?.id;
            return jsonRpcOk(
              makeCheckoutDoc({
                id: coId,
                status: 'completed',
                withAddress: true,
                totalCents: 14000,
                variantId: cartMetaByCheckout.get(coId),
              }),
            );
          }
          throw new Error(`unexpected ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        isHarnessEnv: () => false,
        getRoom: () => VALID_ROOM,
      });

      // Exceeds per-order env cap ($160 > $150) -> refused with 0 network calls
      const rOver = await purchase.prepareOrder(
        makeBag([{
          store: 'Everlane',
          domain: 'm34kzg-ke.myshopify.com',
          cartId: 'cart-over-order',
          total: 160,
          variantId: 'gid://shopify/ProductVariant/cart-over-order',
          itemId: 'prod-over',
        }]),
      );
      const callsBeforeOver = calls.length;
      const pOver = await purchase.placeOrder(rOver.order_id, { idempotencyKey: 'o1', confirmedByTap: true });
      assert.equal(calls.length, callsBeforeOver);
      assert.equal(pOver.stores[0].status, 'handoff');
      assert.match(pOver.stores[0].note ?? '', /150/);

      // Order 1 ($140) + Order 2 ($140) = $280 <= $300 -> both placed (distinct items)
      const r1 = await purchase.prepareOrder(
        makeBag([{
          store: 'Everlane',
          domain: 'm34kzg-ke.myshopify.com',
          cartId: 'cart-s1',
          total: 140,
          variantId: 'gid://shopify/ProductVariant/cart-s1',
          itemId: 'prod-s1',
        }]),
      );
      const p1 = await purchase.placeOrder(r1.order_id, { idempotencyKey: 's1', confirmedByTap: true });
      assert.equal(p1.stores[0].status, 'placed');

      const r2 = await purchase.prepareOrder(
        makeBag([{
          store: 'Everlane',
          domain: 'm34kzg-ke.myshopify.com',
          cartId: 'cart-s2',
          total: 140,
          variantId: 'gid://shopify/ProductVariant/cart-s2',
          itemId: 'prod-s2',
        }]),
      );
      const p2 = await purchase.placeOrder(r2.order_id, { idempotencyKey: 's2', confirmedByTap: true });
      assert.equal(p2.stores[0].status, 'placed');

      // Order 3 ($140 -> $420 > $300 session cap) -> refused with 0 network calls
      const r3 = await purchase.prepareOrder(
        makeBag([{
          store: 'Everlane',
          domain: 'm34kzg-ke.myshopify.com',
          cartId: 'cart-s3',
          total: 140,
          variantId: 'gid://shopify/ProductVariant/cart-s3',
          itemId: 'prod-s3',
        }]),
      );
      const callsBefore3 = calls.length;
      const p3 = await purchase.placeOrder(r3.order_id, { idempotencyKey: 's3', confirmedByTap: true });
      assert.equal(calls.length, callsBefore3);
      assert.equal(p3.stores[0].status, 'handoff');
      assert.match(p3.stores[0].note ?? '', /300/);
    } finally {
      if (origMax === undefined) delete process.env.ALICE_PURCHASE_MAX_USD;
      else process.env.ALICE_PURCHASE_MAX_USD = origMax;
      if (origSession === undefined) delete process.env.ALICE_PURCHASE_SESSION_MAX_USD;
      else process.env.ALICE_PURCHASE_SESSION_MAX_USD = origSession;
    }
  });

  it('happy path places once with deterministic UUID, purges raw instrument (L3), and double call returns first result with ONE complete_checkout', async () => {
    const { purchase, reviewed, calls } = await setupPrepared();
    assert.equal(purchase._debugStats().rawInstrumentCount, 1);

    const [first, second] = await Promise.all([
      purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'tap-uuid-1',
        confirmedByTap: true,
      }),
      purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'tap-uuid-1',
        confirmedByTap: true,
      }),
    ]);
    const third = await purchase.placeOrder(reviewed.order_id, {
      idempotencyKey: 'tap-uuid-2',
      confirmedByTap: true,
    });

    assert.equal(first.stores[0].status, 'placed');
    assert.equal(first.stores[0].order_number, 'ORD-1');
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);

    // L3: reviewed order and raw instrument purged after placement
    assert.equal(purchase._debugStats().pendingReviews, 0);
    assert.equal(purchase._debugStats().rawInstrumentCount, 0);

    const completeCalls = calls.filter((c) => c.name === 'complete_checkout');
    assert.equal(completeCalls.length, 1);
    const expectedUuid = deriveCheckoutIdempotencyUuid(
      'tap-uuid-1',
      'm34kzg-ke.myshopify.com',
      'chk_Everlane_1',
    );
    assert.match(
      expectedUuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      deriveCheckoutIdempotencyUuid('tap-uuid-1', 'm34kzg-ke.myshopify.com', 'chk_Everlane_1'),
      expectedUuid,
    );
    assert.notEqual(
      deriveCheckoutIdempotencyUuid('tap-uuid-1', 'kithnyc.myshopify.com', 'chk_Everlane_1'),
      expectedUuid,
    );
    assert.equal(completeCalls[0].args.meta['idempotency-key'], expectedUuid);
    assert.equal(completeCalls[0].args.checkout.payment.instruments[0].selected, true);
    assert.equal(completeCalls[0].args.checkout.payment.instruments[0].id, 'inst-shop-pay-1');
  });

  it('refuses when total, items, final total entry, or USD currency changed between review and place (zero complete_checkout, keeps continue_url)', async () => {
    for (const [label, override] of [
      ['total +1c', () => makeCheckoutDoc({ totalCents: 6801, withAddress: true })],
      ['qty changed', () => makeCheckoutDoc({ totalCents: 6800, qty: 2, withAddress: true })],
      [
        'subtotal-only',
        () =>
          makeCheckoutDoc({
            withAddress: true,
            currency: 'USD',
            totals: [{ type: 'subtotal', amount: 6800 }],
          }),
      ],
      ['non-USD', () => makeCheckoutDoc({ totalCents: 6800, withAddress: true, currency: 'CAD' })],
    ] as const) {
      const { purchase, reviewed, calls } = await setupPrepared({
        getCheckoutOverride: override,
      });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: `k-${label}`,
        confirmedByTap: true,
      });
      assert.equal(res.stores[0].status, 'handoff', label);
      assert.ok(res.stores[0].continue_url, label);
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 0, label);
    }

    // Pre-check get_checkout read failed (completion never sent -> keeps store link)
    {
      const { purchase, reviewed, calls } = await setupPrepared({
        getCheckoutOverride: () => new Error('network boom'),
      });
      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k-read-fail',
        confirmedByTap: true,
      });
      assert.equal(res.stores[0].status, 'failed');
      assert.ok(res.stores[0].continue_url);
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 0);
    }
  });

  it('L4: on unclear completion, polls get_checkout up to 5 times, stops when completed, otherwise returns failed with no continue_url and logs "unknown"', async () => {
    // Case A: complete_checkout times out, poll #4 returns completed -> stops at 4 polls (5 total get_checkout), placed, 1 complete_checkout
    {
      const { purchase, reviewed, calls } = await setupPrepared({
        completeOverride: () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          return e;
        },
        getCheckoutOverride: (_shop, idx) => {
          if (idx === 1) return makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true });
          if (idx < 5) return makeCheckoutDoc({ status: 'complete_in_progress', withAddress: true });
          return makeCheckoutDoc({
            status: 'completed',
            withAddress: true,
            order: { id: 'ord_poll4', order_number: '#7777' },
          });
        },
      });

      const res = await purchase.placeOrder(reviewed.order_id, {
        idempotencyKey: 'k-l4-ok',
        confirmedByTap: true,
      });
      assert.equal(res.stores[0].status, 'placed');
      assert.equal(res.stores[0].order_number, '#7777');
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
      assert.equal(calls.filter((c) => c.name === 'get_checkout').length, 5); // 1 pre + 4 polls
    }

    // Case B: still complete_in_progress across all 5 polls -> 6 total get_checkout (1 pre + 5 polls), failed, NO continue_url, logs status 'unknown'
    {
      const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];
      setCallRoom(VALID_ROOM);
      setCallLogSink((_room, ev, data) => logs.push({ ev, data }));
      try {
        const { purchase, reviewed, calls } = await setupPrepared({
          completeOverride: () =>
            jsonRpcOk(makeCheckoutDoc({ status: 'complete_in_progress', withAddress: true })),
          getCheckoutOverride: (_shop, idx) => {
            if (idx === 1) return makeCheckoutDoc({ status: 'ready_for_complete', withAddress: true });
            return makeCheckoutDoc({
              status: 'complete_in_progress',
              withAddress: true,
              continueUrl: 'https://m34kzg-ke.myshopify.com/checkouts/finish-here',
            });
          },
        });

        const res = await purchase.placeOrder(reviewed.order_id, {
          idempotencyKey: 'k-l4-unknown',
          confirmedByTap: true,
        });
        assert.equal(res.stores[0].status, 'failed');
        assert.equal(res.stores[0].continue_url, undefined);
        assert.equal(
          res.stores[0].note,
          'Payment may still be processing. Check your Shop app or email before trying again.',
        );
        assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
        assert.equal(calls.filter((c) => c.name === 'get_checkout').length, 6); // 1 pre + 5 polls

        const placeLog = logs.find((l) => l.ev === 'order_place');
        assert.ok(placeLog);
        const loggedStores = placeLog.data?.stores as Array<{ store: string; status: string }>;
        assert.equal(loggedStores[0].status, 'unknown');
      } finally {
        setCallLogSink(null);
        setCallRoom(null);
      }
    }
  });

  it('processes multiple stores sequentially and still reports store 2 truthfully when store 1 fails', async () => {
    const events: string[] = [];
    const { purchase, reviewed } = await setupPrepared({
      stores: [
        { store: 'Everlane', domain: 'm34kzg-ke.myshopify.com', cartId: 'c1', total: 50 },
        { store: 'Kith', domain: 'kithnyc.myshopify.com', cartId: 'c2', total: 60 },
      ],
      completeOverride: async (shop) => {
        events.push(`start:${shop}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`end:${shop}`);
        if (shop === 'm34kzg-ke.myshopify.com') {
          return jsonRpcOk(makeCheckoutDoc({ status: 'requires_escalation', totalCents: 5000 }));
        }
        return jsonRpcOk(
          makeCheckoutDoc({
            status: 'completed',
            totalCents: 6000,
            order: { id: 'ord-kith', order_number: 'KITH-99' },
          }),
        );
      },
      getCheckoutOverride: (shop, idx) => {
        if (shop === 'm34kzg-ke.myshopify.com' && idx > 1 && idx <= 6) {
          return makeCheckoutDoc({
            status: 'requires_escalation',
            totalCents: 5000,
            withAddress: true,
          });
        }
        return makeCheckoutDoc({
          status: 'ready_for_complete',
          totalCents: shop === 'm34kzg-ke.myshopify.com' ? 5000 : 6000,
          withAddress: true,
        });
      },
    });

    const res = await purchase.placeOrder(reviewed.order_id, {
      idempotencyKey: 'k-seq',
      confirmedByTap: true,
    });

    assert.deepEqual(events, [
      'start:m34kzg-ke.myshopify.com',
      'end:m34kzg-ke.myshopify.com',
      'start:kithnyc.myshopify.com',
      'end:kithnyc.myshopify.com',
    ]);
    assert.equal(res.stores[0].store, 'Everlane');
    assert.equal(res.stores[0].status, 'failed');
    assert.equal(res.stores[1].store, 'Kith');
    assert.equal(res.stores[1].status, 'placed');
    assert.equal(res.stores[1].order_number, 'KITH-99');
  });
});

describe('re-made bag double-charge protection (R1 unclear store, R2 already ordered, definite refusals)', () => {
  function makeRebagHarness(opts: {
    completeFn: (shop: string, args: any, callIdx: number) => Response | Promise<Response> | Error;
    afterCompleteGetFn?: (shop: string, args: any) => any;
    getRoom?: () => string | null;
  }) {
    let clock = 40_000_000;
    const activeRoom = opts.getRoom ?? (() => VALID_ROOM);
    const { auth, completeSignIn } = makeSignedInAuth('tok_rebag_secret_999', () => clock, {
      getRoom: activeRoom,
    });

    const calls: Array<{ name: string; shop?: string; args: any }> = [];
    const checkoutById = new Map<string, { variantId: string; title: string; totalCents: number; shop: string }>();
    const sentCheckout = new Set<string>();
    let checkoutSeq = 0;
    let completeSeq = 0;

    // Cart catalog for mapping cart_id -> item details in create_checkout
    const cartMeta = new Map<string, { variantId: string; title: string; totalCents: number }>();

    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name as string;
        const args = body.params?.arguments ?? {};
        const shop = args.shop as string | undefined;
        calls.push({ name, shop, args });

        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());

        if (name === 'create_checkout') {
          checkoutSeq += 1;
          const id = `co_${checkoutSeq}`;
          const cartId = String(args.checkout?.cart_id ?? '');
          const meta = cartMeta.get(cartId) ?? {
            variantId: 'gid://shopify/ProductVariant/111',
            title: 'Linen Shirt',
            totalCents: 10000,
          };
          checkoutById.set(id, { ...meta, shop: shop ?? 'everlane.com' });
          return jsonRpcOk(
            makeCheckoutDoc({
              id,
              status: 'ready_for_complete',
              withAddress: true,
              totalCents: meta.totalCents,
              variantId: meta.variantId,
              title: meta.title,
              continueUrl: `https://${shop ?? 'everlane.com'}/checkouts/${id}`,
            }),
          );
        }

        if (name === 'get_checkout') {
          const id = String(args.id ?? '');
          const meta = checkoutById.get(id) ?? {
            variantId: 'gid://shopify/ProductVariant/111',
            title: 'Linen Shirt',
            totalCents: 10000,
            shop: shop ?? 'everlane.com',
          };
          if (sentCheckout.has(id) && opts.afterCompleteGetFn) {
            const custom = opts.afterCompleteGetFn(shop ?? meta.shop, args);
            if (custom instanceof Error) throw custom;
            return jsonRpcOk(custom);
          }
          return jsonRpcOk(
            makeCheckoutDoc({
              id,
              status: 'ready_for_complete',
              withAddress: true,
              totalCents: meta.totalCents,
              variantId: meta.variantId,
              title: meta.title,
              continueUrl: `https://${shop ?? meta.shop}/checkouts/${id}`,
            }),
          );
        }

        if (name === 'complete_checkout') {
          completeSeq += 1;
          sentCheckout.add(String(args.id ?? ''));
          const out = await opts.completeFn(shop ?? '', args, completeSeq);
          if (out instanceof Error) throw out;
          return out;
        }

        throw new Error(`Unexpected MCP tool: ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
      now: () => clock,
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      maxUsd: () => null,
      sessionMaxUsd: () => null,
      getRoom: activeRoom,
      isHarnessEnv: () => false,
      reconcileDelaysMs: [0, 0],
    });

    const registerCart = (
      cartId: string,
      opts2: {
        store?: string;
        domain?: string;
        variantId?: string;
        itemId?: string;
        title?: string;
        total?: number;
        url?: string;
      } = {},
    ) => {
      const store = opts2.store ?? 'Everlane';
      const domain = opts2.domain ?? 'everlane.com';
      const variantId = opts2.variantId ?? 'gid://shopify/ProductVariant/111';
      const itemId = opts2.itemId ?? 'prod-shirt-1';
      const title = opts2.title ?? 'Linen Shirt';
      const total = opts2.total ?? 100;
      cartMeta.set(cartId, { variantId, title, totalCents: Math.round(total * 100) });
      return {
        store,
        domain,
        cartId,
        total,
        variantId,
        itemId,
        title,
        url: opts2.url ?? `https://${domain}/cart/${cartId}`,
      };
    };

    return { purchase, auth, completeSignIn, calls, registerCart };
  }

  it('R1: after an UNKNOWN outcome on cart c1, a re-made cart c2 for the same store (same or different item) is NOT ready with NO link and refused with reason store_unclear before any store call', async () => {
    const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];
    setCallRoom(VALID_ROOM);
    setCallLogSink((_room, ev, data) => logs.push({ ev, data }));
    try {
      const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
        completeFn: (_shop, _args, idx) => {
          if (idx === 1) return new Error('timeout');
          return jsonRpcOk(makeCheckoutDoc({ status: 'completed', totalCents: 10000, order: { order_number: '2' } }));
        },
        afterCompleteGetFn: (_shop, args) =>
          makeCheckoutDoc({ id: args.id, status: 'complete_in_progress', totalCents: 10000, withAddress: true }),
      });
      await completeSignIn();

      const c1 = registerCart('c1');
      const rev1 = await purchase.prepareOrder(makeBag([c1]));
      assert.equal(rev1.stores[0].ready, true);
      const res1 = await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k1', confirmedByTap: true });
      assert.equal(res1.stores[0].status, 'failed');
      assert.equal(res1.stores[0].continue_url, undefined);
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

      // Re-made cart c2 (same store, same item) -> NOT ready, NO link, ZERO store calls
      const callsBeforeC2 = calls.length;
      const c2 = registerCart('c2');
      const rev2 = await purchase.prepareOrder(makeBag([c2]));
      assert.equal(calls.length, callsBeforeC2, 'prepareOrder on unclear store must make ZERO MCP calls');
      assert.equal(rev2.stores[0].ready, false);
      assert.equal(rev2.stores[0].continue_url, undefined);
      assert.equal(
        rev2.stores[0].note,
        'A payment for this store may still be processing. Check your Shop app or email before ordering from Everlane again.',
      );

      const res2 = await purchase.placeOrder(rev2.order_id, { idempotencyKey: 'k2', confirmedByTap: true });
      assert.equal(calls.length, callsBeforeC2, 'placeOrder on unclear store must make ZERO MCP calls');
      assert.equal(res2.stores[0].ready, false);
      assert.equal(res2.stores[0].continue_url, undefined);
      assert.equal(
        res2.stores[0].note,
        'A payment for this store may still be processing. Check your Shop app or email before ordering from Everlane again.',
      );
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
      assert.ok(
        logs.some((l) => l.ev === 'order_refused' && l.data?.reason === 'store_unclear'),
        'must log order_refused with reason store_unclear',
      );

      // R1 with a DIFFERENT item in re-made cart c3 for the same unclear store -> STILL refused, NO link
      const c3 = registerCart('c3', {
        variantId: 'gid://shopify/ProductVariant/999',
        itemId: 'prod-jeans-999',
        title: 'Selvedge Jeans',
        total: 120,
      });
      const rev3 = await purchase.prepareOrder(makeBag([c3]));
      assert.equal(calls.length, callsBeforeC2);
      assert.equal(rev3.stores[0].ready, false);
      assert.equal(rev3.stores[0].continue_url, undefined);
      assert.equal(
        rev3.stores[0].note,
        'A payment for this store may still be processing. Check your Shop app or email before ordering from Everlane again.',
      );
      const res3 = await purchase.placeOrder(rev3.order_id, { idempotencyKey: 'k3', confirmedByTap: true });
      assert.equal(calls.length, callsBeforeC2);
      assert.equal(res3.stores[0].continue_url, undefined);
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
      assert.equal(JSON.stringify(logs).includes('tok_rebag_secret_999'), false);
    } finally {
      setCallLogSink(null);
      setCallRoom(null);
    }
  });

  it('R2: after PLACED on cart c1, re-made cart c2 with same variant OR same product id is NOT ready with store checkout link and refused (already_ordered); different item from same store IS allowed', async () => {
    const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];
    setCallRoom(VALID_ROOM);
    setCallLogSink((_room, ev, data) => logs.push({ ev, data }));
    try {
      const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
        completeFn: (_shop, args, idx) =>
          jsonRpcOk(
            makeCheckoutDoc({
              id: args.id,
              status: 'completed',
              totalCents: 10000,
              order: { order_number: `ORD-${idx}` },
            }),
          ),
      });
      await completeSignIn();

      const c1 = registerCart('c1', {
        variantId: 'gid://shopify/ProductVariant/v1',
        itemId: 'gid://shopify/Product/p1',
        title: 'Linen Shirt',
      });
      const rev1 = await purchase.prepareOrder(makeBag([c1]));
      const res1 = await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k1', confirmedByTap: true });
      assert.equal(res1.stores[0].status, 'placed');
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

      // Re-made cart c2 with SAME variant -> NOT ready, hands off WITH store link, refused with already_ordered
      const callsBeforeC2 = calls.length;
      const c2 = registerCart('c2', {
        variantId: 'gid://shopify/ProductVariant/v1',
        itemId: 'gid://shopify/Product/p1',
        title: 'Linen Shirt',
        url: 'https://everlane.com/cart/c2',
      });
      const rev2 = await purchase.prepareOrder(makeBag([c2]));
      assert.equal(calls.length, callsBeforeC2, 'prepareOrder on already-ordered item makes ZERO MCP calls');
      assert.equal(rev2.stores[0].ready, false);
      assert.equal(rev2.stores[0].continue_url, 'https://everlane.com/cart/c2');
      assert.equal(rev2.stores[0].note, 'You already ordered Linen Shirt in this call.');

      const res2 = await purchase.placeOrder(rev2.order_id, { idempotencyKey: 'k2', confirmedByTap: true });
      assert.equal(calls.length, callsBeforeC2, 'placeOrder on already-ordered item makes ZERO MCP calls');
      assert.equal(res2.stores[0].ready, false);
      assert.equal(res2.stores[0].status, 'handoff');
      assert.equal(res2.stores[0].continue_url, 'https://everlane.com/cart/c2');
      assert.equal(res2.stores[0].note, 'You already ordered Linen Shirt in this call.');
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);
      assert.ok(
        logs.some((l) => l.ev === 'order_refused' && l.data?.reason === 'already_ordered'),
        'must log order_refused with reason already_ordered',
      );

      // Re-made cart c2b with DIFFERENT variant of the SAME product id -> also refused (already_ordered)
      const c2b = registerCart('c2b', {
        variantId: 'gid://shopify/ProductVariant/v1-large',
        itemId: 'gid://shopify/Product/p1',
        title: 'Linen Shirt',
        url: 'https://everlane.com/cart/c2b',
      });
      const rev2b = await purchase.prepareOrder(makeBag([c2b]));
      assert.equal(rev2b.stores[0].ready, false);
      assert.equal(rev2b.stores[0].continue_url, 'https://everlane.com/cart/c2b');
      assert.equal(rev2b.stores[0].note, 'You already ordered Linen Shirt in this call.');

      // Re-made cart c3 with ENTIRELY DIFFERENT item from the SAME store -> ALLOWED and placed!
      const c3 = registerCart('c3', {
        variantId: 'gid://shopify/ProductVariant/v2',
        itemId: 'gid://shopify/Product/p2',
        title: 'Chino Pant',
        total: 100,
      });
      const rev3 = await purchase.prepareOrder(makeBag([c3]));
      assert.equal(rev3.stores[0].ready, true);
      const res3 = await purchase.placeOrder(rev3.order_id, { idempotencyKey: 'k3', confirmedByTap: true });
      assert.equal(res3.stores[0].status, 'placed');
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 2);
    } finally {
      setCallLogSink(null);
      setCallRoom(null);
    }
  });

  it('two-store bag where store A is unclear and store B is fine: B can still be ordered while A is refused with no link', async () => {
    const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
      completeFn: (shop, args, idx) => {
        if (shop === 'everlane.com') {
          return jsonRpcOk(makeCheckoutDoc({ id: args.id, status: 'processing', totalCents: 10000 }));
        }
        return jsonRpcOk(
          makeCheckoutDoc({
            id: args.id,
            status: 'completed',
            totalCents: 8000,
            order: { order_number: `KITH-${idx}` },
          }),
        );
      },
      afterCompleteGetFn: (_shop, args) =>
        makeCheckoutDoc({ id: args.id, status: 'processing', totalCents: 10000, withAddress: true }),
    });
    await completeSignIn();

    // First attempt on Everlane -> UNKNOWN ("processing") -> Everlane marked unclear
    const ev1 = registerCart('ev-1', { store: 'Everlane', domain: 'everlane.com', total: 100 });
    const rev1 = await purchase.prepareOrder(makeBag([ev1]));
    const res1 = await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k-ev1', confirmedByTap: true });
    assert.equal(res1.stores[0].status, 'failed');
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

    // Two-store bag: Everlane (new cart ev-2) + Kith (kith-1)
    const ev2 = registerCart('ev-2', {
      store: 'Everlane',
      domain: 'everlane.com',
      variantId: 'gid://shopify/ProductVariant/ev-diff',
      itemId: 'prod-ev-diff',
      title: 'Cashmere Crew',
      total: 100,
    });
    const kith1 = registerCart('kith-1', {
      store: 'Kith',
      domain: 'kithnyc.myshopify.com',
      variantId: 'gid://shopify/ProductVariant/kith-1',
      itemId: 'prod-kith-1',
      title: 'Kith Hoodie',
      total: 80,
    });

    const rev2 = await purchase.prepareOrder(makeBag([ev2, kith1]));
    assert.equal(rev2.stores[0].store, 'Everlane');
    assert.equal(rev2.stores[0].ready, false);
    assert.equal(rev2.stores[0].continue_url, undefined);
    assert.equal(
      rev2.stores[0].note,
      'A payment for this store may still be processing. Check your Shop app or email before ordering from Everlane again.',
    );
    assert.equal(rev2.stores[1].store, 'Kith');
    assert.equal(rev2.stores[1].ready, true);

    const res2 = await purchase.placeOrder(rev2.order_id, { idempotencyKey: 'k-two', confirmedByTap: true });
    assert.equal(res2.stores[0].store, 'Everlane');
    assert.equal(res2.stores[0].ready, false);
    assert.equal(res2.stores[0].continue_url, undefined);
    assert.equal(res2.stores[1].store, 'Kith');
    assert.equal(res2.stores[1].status, 'placed');

    // Only 1 complete_checkout to Everlane (from attempt 1) and 1 to Kith
    assert.equal(
      calls.filter((c) => c.name === 'complete_checkout' && c.shop === 'everlane.com').length,
      1,
    );
    assert.equal(
      calls.filter((c) => c.name === 'complete_checkout' && c.shop === 'kithnyc.myshopify.com').length,
      1,
    );
  });

  it('unclearStores and placed items survive endCall() followed by a new sign-in in the same process', async () => {
    const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
      completeFn: (shop, args) => {
        if (shop === 'everlane.com') return new Error('network error');
        return jsonRpcOk(
          makeCheckoutDoc({
            id: args.id,
            status: 'completed',
            totalCents: 9000,
            order: { order_number: 'KITH-1' },
          }),
        );
      },
      afterCompleteGetFn: (_shop, args) =>
        makeCheckoutDoc({ id: args.id, status: 'complete_in_progress', totalCents: 10000, withAddress: true }),
    });
    await completeSignIn();

    const ev1 = registerCart('ev-1', { store: 'Everlane', domain: 'everlane.com', total: 100 });
    const k1 = registerCart('k-1', {
      store: 'Kith',
      domain: 'kithnyc.myshopify.com',
      variantId: 'gid://shopify/ProductVariant/k1',
      itemId: 'prod-k1',
      title: 'Kith Tee',
      total: 90,
    });
    const rev1 = await purchase.prepareOrder(makeBag([ev1, k1]));
    const res1 = await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k-before', confirmedByTap: true });
    assert.equal(res1.stores[0].status, 'failed');
    assert.equal(res1.stores[1].status, 'placed');
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 2);

    // End call (signs out) and sign in again in the same process
    purchase.endCall();
    await completeSignIn();

    const callsAfterSignIn = calls.length;
    const ev2 = registerCart('ev-2', {
      store: 'Everlane',
      domain: 'everlane.com',
      variantId: 'gid://shopify/ProductVariant/ev2',
      itemId: 'prod-ev2',
      title: 'New Shirt',
      total: 100,
    });
    const k2 = registerCart('k-2', {
      store: 'Kith',
      domain: 'kithnyc.myshopify.com',
      variantId: 'gid://shopify/ProductVariant/k1',
      itemId: 'prod-k1',
      title: 'Kith Tee',
      total: 90,
      url: 'https://kithnyc.myshopify.com/cart/k-2',
    });

    const rev2 = await purchase.prepareOrder(makeBag([ev2, k2]));
    assert.equal(calls.length, callsAfterSignIn, 'neither blocked store should make MCP calls after endCall+re-signin');
    assert.equal(rev2.stores[0].ready, false);
    assert.equal(rev2.stores[0].continue_url, undefined);
    assert.equal(rev2.stores[1].ready, false);
    assert.equal(rev2.stores[1].continue_url, 'https://kithnyc.myshopify.com/cart/k-2');
    assert.equal(rev2.stores[1].note, 'You already ordered Kith Tee in this call.');

    await purchase.placeOrder(rev2.order_id, { idempotencyKey: 'k-after', confirmedByTap: true });
    assert.equal(calls.length, callsAfterSignIn);
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 2);
  });

  it('six concurrent placeOrder calls on a re-made cart produce ZERO additional completions', async () => {
    // Both R1 (unclear store) and R2 (already placed item)
    for (const mode of ['unclear', 'placed'] as const) {
      const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
        completeFn: (_shop, args, idx) => {
          if (mode === 'unclear' && idx === 1) return new Error('timeout');
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id,
              status: 'completed',
              totalCents: 10000,
              order: { order_number: `ORD-${idx}` },
            }),
          );
        },
        afterCompleteGetFn: (_shop, args) =>
          makeCheckoutDoc({ id: args.id, status: 'complete_in_progress', totalCents: 10000, withAddress: true }),
      });
      await completeSignIn();

      const c1 = registerCart('c1');
      const rev1 = await purchase.prepareOrder(makeBag([c1]));
      await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k1', confirmedByTap: true });
      assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

      const c2 = registerCart('c2');
      const rev2 = await purchase.prepareOrder(makeBag([c2]));
      assert.equal(rev2.stores[0].ready, false, mode);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          purchase.placeOrder(rev2.order_id, {
            idempotencyKey: `k-conc-${i}`,
            confirmedByTap: true,
          }),
        ),
      );
      for (const r of results) {
        assert.equal(r.stores[0].ready, false, mode);
        if (mode === 'unclear') {
          assert.equal(r.stores[0].continue_url, undefined);
        } else {
          assert.ok(r.stores[0].continue_url);
        }
      }
      assert.equal(
        calls.filter((c) => c.name === 'complete_checkout').length,
        1,
        `expected 0 additional completions for 6 concurrent calls (${mode})`,
      );
    }
  });

  it('definite refusals from the store (declined, sold out, validation error with failed status and no order) stay retryable on a new cart', async () => {
    const { purchase, completeSignIn, calls, registerCart } = makeRebagHarness({
      completeFn: (_shop, args, idx) => {
        if (idx === 1) {
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id,
              status: 'failed',
              totalCents: 10000,
              order: undefined,
            }),
          );
        }
        return jsonRpcOk(
          makeCheckoutDoc({
            id: args.id,
            status: 'completed',
            totalCents: 10000,
            order: { order_number: 'ORD-RETRY-OK' },
          }),
        );
      },
    });
    await completeSignIn();

    const c1 = registerCart('c1');
    const rev1 = await purchase.prepareOrder(makeBag([c1]));
    const res1 = await purchase.placeOrder(rev1.order_id, { idempotencyKey: 'k1', confirmedByTap: true });
    assert.equal(res1.stores[0].status, 'failed');
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 1);

    // Same cart c1 is STILL locked by sentCartIds (layer 2)
    const revSameCart = await purchase.prepareOrder(makeBag([c1]));
    assert.equal(revSameCart.stores[0].ready, false);

    // New cart c2 for the same store & item IS retryable after a definite refusal
    const c2 = registerCart('c2');
    const rev2 = await purchase.prepareOrder(makeBag([c2]));
    assert.equal(rev2.stores[0].ready, true);
    const res2 = await purchase.placeOrder(rev2.order_id, { idempotencyKey: 'k2', confirmedByTap: true });
    assert.equal(res2.stores[0].status, 'placed');
    assert.equal(res2.stores[0].order_number, 'ORD-RETRY-OK');
    assert.equal(calls.filter((c) => c.name === 'complete_checkout').length, 2);
  });
});

describe('checkout fulfillment line_item_ids (FIX 1, Addendum A & B) and repeat prepareOrder reuse (FIX 2, Addendum C)', () => {
  function jsonRpcError(message: string): Response {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  function validateUpdateMethods(args: any): string | null {
    const methods = args?.checkout?.fulfillment?.methods;
    if (!Array.isArray(methods)) return null;
    for (let i = 0; i < methods.length; i += 1) {
      const ids = methods[i]?.line_item_ids;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((x: unknown) => typeof x === 'string' && x.trim().length > 0)
      ) {
        return `$.checkout.fulfillment.methods[${i}].line_item_ids: required property missing`;
      }
    }
    return null;
  }

  const twoItemBag: BagOut = {
    carts: [
      {
        store: 'Fashion Nova',
        store_domain: 'fnova.myshopify.com',
        cart_id: 'cart-fn-1',
        continue_url: 'https://fnova.myshopify.com/cart/fn-1',
        total_usd: 47.96,
        added: [
          {
            variant_id: 'gid://shopify/ProductVariant/fn-1',
            title: 'Straight Jeans',
            size: '34',
            slot: 'bottom',
            image: 'https://cdn.example.com/fn1.jpg',
            price: 27.96,
            item_id: 'prod-fn-1',
          } as any,
          {
            variant_id: 'gid://shopify/ProductVariant/fn-2',
            title: 'Crew Tee',
            size: 'L',
            slot: 'top',
            image: 'https://cdn.example.com/fn2.jpg',
            price: 20.0,
            item_id: 'prod-fn-2',
          } as any,
        ],
        not_added: [],
        ms: 10,
      },
    ],
    summary: 'Bag ready',
    total_usd: 47.96,
  };

  function twoLineItems() {
    return [
      {
        id: 'line-a',
        item: { id: 'gid://shopify/ProductVariant/fn-1', title: 'Straight Jeans', price: 2796 },
        quantity: 1,
        totals: [{ type: 'total', amount: 2796 }],
      },
      {
        id: 'line-b',
        item: { id: 'gid://shopify/ProductVariant/fn-2', title: 'Crew Tee', price: 2000 },
        quantity: 1,
        totals: [{ type: 'total', amount: 2000 }],
      },
    ];
  }

  it('store checkout with no methods: constructs method with all line_item_ids, logs order_checkout_update, and is ready ONLY when store returns default destination selected (Addendum B)', async () => {
    const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];
    setCallRoom(VALID_ROOM);
    setCallLogSink((_room, ev, data) => logs.push({ ev, data }));
    try {
      // Sub-case 1: store returns default destination selected after update -> ready=true
      {
        let clock = 50_000_000;
        const { auth, completeSignIn } = makeSignedInAuth('tok_fn_nomethods_1', () => clock);
        await completeSignIn();
        const updates: any[] = [];

        const mcp = createShopMcp({
          fetch: async (_u, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const name = body.params?.name;
            const args = body.params?.arguments ?? {};
            if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
            if (name === 'create_checkout') {
              const doc = makeCheckoutDoc({
                id: 'chk_fn_1',
                status: 'incomplete',
                totalCents: 4796,
                line_items: twoLineItems(),
              });
              doc.fulfillment = { methods: [] };
              return jsonRpcOk(doc);
            }
            if (name === 'update_checkout') {
              const errMsg = validateUpdateMethods(args);
              if (errMsg) return jsonRpcError(errMsg);
              updates.push(args.checkout);
              return jsonRpcOk(
                makeCheckoutDoc({
                  id: 'chk_fn_1',
                  status: 'ready_for_complete',
                  totalCents: 4796,
                  line_items: twoLineItems(),
                  withAddress: true,
                }),
              );
            }
            throw new Error(`Unexpected ${name}`);
          },
          isPurchaseEnabled: () => true,
          getAuthToken: () => auth.getToken(),
        });

        const purchase = createPurchaseClient({
          mcp,
          auth,
          now: () => clock,
          isPurchaseEnabled: () => true,
          getRoom: () => VALID_ROOM,
          isHarnessEnv: () => false,
        });

        const review = await purchase.prepareOrder(twoItemBag);
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].fulfillment.methods[0].line_item_ids, ['line-a', 'line-b']);
        assert.equal(updates[0].fulfillment.methods[0].type, 'shipping');
        assert.equal(updates[0].fulfillment.methods[0].selected_destination_id, 'addr-brooklyn-1');
        assert.equal(review.stores[0].ready, true);
        assert.equal(review.address_label, 'Brooklyn, NY');

        const updLog = logs.find((l) => l.ev === 'order_checkout_update');
        assert.ok(updLog);
        assert.deepEqual(updLog.data, {
          store: 'Fashion Nova',
          had_methods: false,
          filled_line_item_ids: true,
        });
      }

      // Sub-case 2 (Addendum B): store ignores our address and returns a different destination -> NOT ready, label from store
      {
        let clock = 50_100_000;
        const { auth, completeSignIn } = makeSignedInAuth('tok_fn_nomethods_2', () => clock);
        await completeSignIn();
        const otherDest = makeFakeAddress({
          id: 'addr-other',
          address_locality: 'Austin',
          address_region: 'TX',
        });

        const mcp = createShopMcp({
          fetch: async (_u, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const name = body.params?.name;
            const args = body.params?.arguments ?? {};
            if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
            if (name === 'create_checkout') {
              const doc = makeCheckoutDoc({
                id: 'chk_fn_2',
                status: 'incomplete',
                totalCents: 4796,
                line_items: twoLineItems(),
              });
              delete (doc as any).fulfillment;
              return jsonRpcOk(doc);
            }
            if (name === 'update_checkout') {
              const errMsg = validateUpdateMethods(args);
              if (errMsg) return jsonRpcError(errMsg);
              return jsonRpcOk(
                makeCheckoutDoc({
                  id: 'chk_fn_2',
                  status: 'ready_for_complete',
                  totalCents: 4796,
                  line_items: twoLineItems(),
                  withAddress: true,
                  address: otherDest,
                }),
              );
            }
            throw new Error(`Unexpected ${name}`);
          },
          isPurchaseEnabled: () => true,
          getAuthToken: () => auth.getToken(),
        });

        const purchase = createPurchaseClient({
          mcp,
          auth,
          now: () => clock,
          isPurchaseEnabled: () => true,
          getRoom: () => VALID_ROOM,
          isHarnessEnv: () => false,
        });

        const review = await purchase.prepareOrder(twoItemBag);
        assert.equal(review.stores[0].ready, false);
        assert.equal(review.address_label, 'Austin, TX');
        assert.ok(review.stores[0].continue_url);
      }
    } finally {
      setCallLogSink(null);
      setCallRoom(null);
    }
  });

  it('store method missing line_item_ids is filled while preserving other method fields; partial store line_item_ids is sent back UNCHANGED (Addendum A)', async () => {
    const logs: Array<{ ev: string; data?: Record<string, unknown> }> = [];
    setCallRoom(VALID_ROOM);
    setCallLogSink((_room, ev, data) => logs.push({ ev, data }));
    try {
      // Missing line_item_ids -> filled with all line item ids, other method fields preserved
      {
        let clock = 51_000_000;
        const { auth, completeSignIn } = makeSignedInAuth('tok_fn_missing_ids', () => clock);
        await completeSignIn();
        const updates: any[] = [];

        const mcp = createShopMcp({
          fetch: async (_u, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const name = body.params?.name;
            const args = body.params?.arguments ?? {};
            if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
            if (name === 'create_checkout') {
              const doc = makeCheckoutDoc({
                id: 'chk_missing',
                status: 'incomplete',
                totalCents: 4796,
                line_items: twoLineItems(),
              });
              doc.fulfillment = {
                methods: [
                  {
                    id: 'meth-store-1',
                    type: 'shipping',
                    destinations: [],
                    custom_store_flag: 'keep-me',
                  },
                ],
              };
              return jsonRpcOk(doc);
            }
            if (name === 'update_checkout') {
              const errMsg = validateUpdateMethods(args);
              if (errMsg) return jsonRpcError(errMsg);
              updates.push(args.checkout);
              return jsonRpcOk(
                makeCheckoutDoc({
                  id: 'chk_missing',
                  status: 'ready_for_complete',
                  totalCents: 4796,
                  line_items: twoLineItems(),
                  withAddress: true,
                }),
              );
            }
            throw new Error(`Unexpected ${name}`);
          },
          isPurchaseEnabled: () => true,
          getAuthToken: () => auth.getToken(),
        });

        const purchase = createPurchaseClient({
          mcp,
          auth,
          now: () => clock,
          isPurchaseEnabled: () => true,
          getRoom: () => VALID_ROOM,
          isHarnessEnv: () => false,
        });

        const review = await purchase.prepareOrder(twoItemBag);
        assert.equal(review.stores[0].ready, true);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].fulfillment.methods[0].id, 'meth-store-1');
        assert.equal(updates[0].fulfillment.methods[0].custom_store_flag, 'keep-me');
        assert.deepEqual(updates[0].fulfillment.methods[0].line_item_ids, ['line-a', 'line-b']);
        const updLog1 = logs.find((l) => l.ev === 'order_checkout_update');
        assert.ok(updLog1);
        assert.deepEqual(updLog1.data, {
          store: 'Fashion Nova',
          had_methods: true,
          filled_line_item_ids: true,
        });
      }

      // Addendum A: store method ALREADY has partial line_item_ids: ['line-a'] -> sent back UNCHANGED, never widened
      {
        logs.length = 0;
        let clock = 51_100_000;
        const { auth, completeSignIn } = makeSignedInAuth('tok_fn_partial_ids', () => clock);
        await completeSignIn();
        const updates: any[] = [];

        const mcp = createShopMcp({
          fetch: async (_u, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const name = body.params?.name;
            const args = body.params?.arguments ?? {};
            if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
            if (name === 'create_checkout') {
              const doc = makeCheckoutDoc({
                id: 'chk_partial',
                status: 'incomplete',
                totalCents: 4796,
                line_items: twoLineItems(),
              });
              doc.fulfillment = {
                methods: [
                  {
                    id: 'meth-partial',
                    type: 'shipping',
                    line_item_ids: ['line-a'],
                    destinations: [],
                  },
                ],
              };
              return jsonRpcOk(doc);
            }
            if (name === 'update_checkout') {
              const errMsg = validateUpdateMethods(args);
              if (errMsg) return jsonRpcError(errMsg);
              updates.push(args.checkout);
              return jsonRpcOk(
                makeCheckoutDoc({
                  id: 'chk_partial',
                  status: 'ready_for_complete',
                  totalCents: 4796,
                  line_items: twoLineItems(),
                  withAddress: true,
                }),
              );
            }
            throw new Error(`Unexpected ${name}`);
          },
          isPurchaseEnabled: () => true,
          getAuthToken: () => auth.getToken(),
        });

        const purchase = createPurchaseClient({
          mcp,
          auth,
          now: () => clock,
          isPurchaseEnabled: () => true,
          getRoom: () => VALID_ROOM,
          isHarnessEnv: () => false,
        });

        const review = await purchase.prepareOrder(twoItemBag);
        assert.equal(review.stores[0].ready, true);
        assert.equal(updates.length, 1);
        assert.deepEqual(
          updates[0].fulfillment.methods[0].line_item_ids,
          ['line-a'],
          'partial line_item_ids from store must be sent back unchanged and never widened',
        );
        const updLog2 = logs.find((l) => l.ev === 'order_checkout_update');
        assert.ok(updLog2);
        assert.deepEqual(updLog2.data, {
          store: 'Fashion Nova',
          had_methods: true,
          filled_line_item_ids: false,
        });
      }
    } finally {
      setCallLogSink(null);
      setCallRoom(null);
    }
  });

  it('delivery-option update also carries line_item_ids; checkout with no line item string ids sends zero update_checkout and hands off with link', async () => {
    // Sub-case 1: delivery-option update carries line_item_ids
    {
      let clock = 52_000_000;
      const { auth, completeSignIn } = makeSignedInAuth('tok_fn_delivery', () => clock);
      await completeSignIn();
      const updates: any[] = [];
      let updateCount = 0;

      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          const args = body.params?.arguments ?? {};
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            const doc = makeCheckoutDoc({
              id: 'chk_deliv',
              status: 'incomplete',
              totalCents: 4796,
              line_items: twoLineItems(),
            });
            doc.fulfillment = { methods: [] };
            return jsonRpcOk(doc);
          }
          if (name === 'update_checkout') {
            const errMsg = validateUpdateMethods(args);
            if (errMsg) return jsonRpcError(errMsg);
            updates.push(args.checkout);
            updateCount += 1;
            if (updateCount === 1) {
              // Store returns address applied, still incomplete with 1 delivery option and missing line_item_ids
              const doc = makeCheckoutDoc({
                id: 'chk_deliv',
                status: 'incomplete',
                totalCents: 4796,
                line_items: twoLineItems(),
                withAddress: true,
              });
              (doc.fulfillment.methods[0] as any).groups = [
                { id: 'grp-1', options: [{ id: 'ship-std', title: 'Standard' }] },
              ];
              return jsonRpcOk(doc);
            }
            return jsonRpcOk(
              makeCheckoutDoc({
                id: 'chk_deliv',
                status: 'ready_for_complete',
                totalCents: 4796,
                line_items: twoLineItems(),
                withAddress: true,
              }),
            );
          }
          throw new Error(`Unexpected ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });

      const review = await purchase.prepareOrder(twoItemBag);
      assert.equal(review.stores[0].ready, true);
      assert.equal(updates.length, 2);
      assert.deepEqual(updates[1].fulfillment.methods[0].line_item_ids, ['line-a', 'line-b']);
      assert.equal(updates[1].fulfillment.methods[0].groups[0].selected_option_id, 'ship-std');
    }

    // Sub-case 2: checkout line_items lack string ids -> NO update_checkout sent, hand-off with link
    {
      let clock = 52_100_000;
      const { auth, completeSignIn } = makeSignedInAuth('tok_fn_noids', () => clock);
      await completeSignIn();
      let updateCalls = 0;

      const mcp = createShopMcp({
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const name = body.params?.name;
          if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
          if (name === 'create_checkout') {
            const doc = makeCheckoutDoc({
              id: 'chk_noids',
              status: 'incomplete',
              totalCents: 4796,
              line_items: [
                {
                  item: { id: 'gid://shopify/ProductVariant/fn-1', title: 'Straight Jeans', price: 2796 },
                  quantity: 1,
                },
                {
                  item: { id: 'gid://shopify/ProductVariant/fn-2', title: 'Crew Tee', price: 2000 },
                  quantity: 1,
                },
              ],
            });
            doc.fulfillment = { methods: [] };
            return jsonRpcOk(doc);
          }
          if (name === 'update_checkout') {
            updateCalls += 1;
            throw new Error('update_checkout must NOT be called when checkout has no line item string ids');
          }
          throw new Error(`Unexpected ${name}`);
        },
        isPurchaseEnabled: () => true,
        getAuthToken: () => auth.getToken(),
      });

      const purchase = createPurchaseClient({
        mcp,
        auth,
        now: () => clock,
        isPurchaseEnabled: () => true,
        getRoom: () => VALID_ROOM,
        isHarnessEnv: () => false,
      });

      const review = await purchase.prepareOrder(twoItemBag);
      assert.equal(updateCalls, 0);
      assert.equal(review.stores[0].ready, false);
      assert.equal(review.stores[0].status, 'handoff');
      assert.ok(review.stores[0].continue_url);
    }
  });

  it('FIX 2 + Addendum C: 3 prepareOrder calls for same bag -> 1 create_checkout & same order_id; original 2m expiry kept; changed bag, placeOrder, or sign-out ends reuse', async () => {
    let clock = 60_000_000;
    let activeRoom: string | null = VALID_ROOM;
    const { auth, completeSignIn } = makeSignedInAuth('tok_fix2_reuse_1', () => clock, {
      getRoom: () => activeRoom,
    });
    await completeSignIn();

    let createCalls = 0;
    let completeCalls = 0;
    const checkoutById = new Map<string, string>();
    const mcp = createShopMcp({
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        if (name === 'get_account') return jsonRpcOk(makeFakeAccount());
        if (name === 'create_checkout') {
          createCalls += 1;
          await new Promise((r) => setTimeout(r, 15));
          const id = `chk_reuse_${createCalls}`;
          const cid = String(args.checkout?.cart_id ?? '');
          const variantId =
            cid === 'cart-ev-changed'
              ? 'gid://shopify/ProductVariant/222'
              : 'gid://shopify/ProductVariant/111';
          checkoutById.set(id, variantId);
          return jsonRpcOk(
            makeCheckoutDoc({
              id,
              status: 'ready_for_complete',
              withAddress: true,
              variantId,
            }),
          );
        }
        if (name === 'get_checkout') {
          const variantId = checkoutById.get(String(args.id ?? '')) ?? 'gid://shopify/ProductVariant/111';
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id,
              status: 'ready_for_complete',
              withAddress: true,
              variantId,
            }),
          );
        }
        if (name === 'complete_checkout') {
          completeCalls += 1;
          return jsonRpcOk(
            makeCheckoutDoc({
              id: args.id,
              status: 'completed',
              withAddress: true,
              order: { order_number: `ORD-${completeCalls}` },
            }),
          );
        }
        throw new Error(`Unexpected ${name}`);
      },
      isPurchaseEnabled: () => true,
      getAuthToken: () => auth.getToken(),
      now: () => clock,
    });

    const purchase = createPurchaseClient({
      mcp,
      auth,
      now: () => clock,
      isPurchaseEnabled: () => true,
      getRoom: () => activeRoom,
      isHarnessEnv: () => false,
    });

    const bag1 = makeBag();
    // 2 concurrent in-flight + 1 sequential within 8s -> 1 create_checkout, exact same order_id & object
    const [r1, r2] = await Promise.all([purchase.prepareOrder(bag1), purchase.prepareOrder(bag1)]);
    clock += 5_000;
    const r3 = await purchase.prepareOrder(bag1);
    assert.equal(createCalls, 1);
    assert.equal(r1.order_id, r2.order_id);
    assert.equal(r1.order_id, r3.order_id);
    assert.equal(r3, r1);

    // Addendum C: original 2-minute age limit is NOT extended by the reuse at +5s!
    // At t = +120_000ms from original creation (only 115s since reuse), placeOrder must expire.
    clock += 115_000;
    const expPlace = await purchase.placeOrder(r1.order_id, {
      idempotencyKey: 'k-exp',
      confirmedByTap: true,
    });
    assert.equal(completeCalls, 0);
    assert.match(expPlace.stores[0].note ?? '', /expired/i);

    // After placeOrder / expiry, reuse ended -> fresh prepareOrder creates a new order_id
    const r4 = await purchase.prepareOrder(bag1);
    assert.equal(createCalls, 2);
    assert.notEqual(r4.order_id, r1.order_id);

    // Changed bag -> new order_id and ends reuse for old bag
    const bag2 = makeBag([
      {
        store: 'Everlane',
        domain: 'm34kzg-ke.myshopify.com',
        cartId: 'cart-ev-changed',
        total: 68,
        variantId: 'gid://shopify/ProductVariant/222',
        itemId: 'prod-2',
        title: 'Oxford Shirt',
      },
    ]);
    const rChanged = await purchase.prepareOrder(bag2);
    assert.equal(createCalls, 3);
    assert.notEqual(rChanged.order_id, r4.order_id);

    // Returning to bag1 immediately does NOT return stale r4 (changed bag ended reuse)
    const rBackTo1 = await purchase.prepareOrder(bag1);
    assert.equal(createCalls, 4);
    assert.notEqual(rBackTo1.order_id, r4.order_id);

    // placeOrder started on rBackTo1 ends reuse even if refused pre-flight
    await purchase.placeOrder(rBackTo1.order_id, {
      idempotencyKey: 'k-notap',
      confirmedByTap: false,
    });
    const rAfterPlace = await purchase.prepareOrder(bag1);
    assert.equal(createCalls, 5);
    assert.notEqual(rAfterPlace.order_id, rBackTo1.order_id);

    // sign-out / endCall ends reuse
    purchase.endCall();
    await completeSignIn();
    const rAfterSignOut = await purchase.prepareOrder(bag1);
    assert.equal(createCalls, 6);
    assert.notEqual(rAfterSignOut.order_id, rAfterPlace.order_id);
  });
});

describe('repo-wide real-checkout and guard-symbol safety checks (Rule 8, L1)', () => {
  function listSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (/\.(?:ts|mts|js|mjs)$/i.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('forbids any script or test in scripts/ and tests/ from calling complete_checkout against the real service', () => {
    const scriptFiles = listSourceFiles(path.join(REPO_ROOT, 'scripts'));
    const testFiles = listSourceFiles(path.join(REPO_ROOT, 'tests'));
    const guardSymbolName = ['COMPLETE', 'CHECKOUT', 'GUARD'].join('_');

    for (const file of scriptFiles) {
      const rel = path.relative(REPO_ROOT, file);
      const text = fs.readFileSync(file, 'utf8');

      assert.equal(
        new RegExp(`\\bplaceOrder\\b|\\bprepareOrder\\b|\\bcreatePurchaseClient\\b|\\b${guardSymbolName}\\b`).test(
          text,
        ),
        false,
        `${rel} must never invoke purchase/completion paths`,
      );

      assert.equal(
        /ALICE_PURCHASE\s*=\s*['"]on['"]/.test(text),
        false,
        `${rel} must never enable ALICE_PURCHASE='on'`,
      );

      if (rel === 'scripts/purchase-check.ts') {
        assert.equal(
          /create_checkout|update_checkout|complete_checkout|get_checkout/.test(text),
          false,
          'scripts/purchase-check.ts must never create or touch checkouts',
        );
      } else if (rel !== 'scripts/store-check.ts') {
        assert.equal(
          /complete_checkout/.test(text),
          false,
          `${rel} must never reference complete_checkout`,
        );
      }
    }

    for (const file of testFiles) {
      const rel = path.relative(REPO_ROOT, file);
      const text = fs.readFileSync(file, 'utf8');

      assert.equal(
        /import\s*\{[^}]*\b(?:placeOrder|prepareOrder)\b[^}]*\}\s*from\s*['"][^'"]*src\/store\/(?:index|purchase)\.ts['"]/.test(
          text,
        ),
        false,
        `${rel} must use createPurchaseClient with an injected fake MCP client, never the default real-service singleton`,
      );

      if (/complete_checkout/.test(text)) {
        assert.ok(
          /createShopMcp\s*\(\s*\{[^}]*fetch\s*:/.test(text) || /fakeFetch/.test(text),
          `${rel} references complete_checkout without an injected fake fetch`,
        );
      }
    }
  });

  it('L1: only src/store/shopmcp.ts, src/store/purchase.ts, and src/store/purchase-guard.ts may reference the guard symbol', () => {
    const guardSymbolName = ['COMPLETE', 'CHECKOUT', 'GUARD'].join('_');
    const allowed = new Set([
      'src/store/shopmcp.ts',
      'src/store/purchase.ts',
      'src/store/purchase-guard.ts',
    ]);

    const roots = ['src', 'scripts', 'tests', 'public'];
    const found: string[] = [];
    for (const r of roots) {
      for (const file of listSourceFiles(path.join(REPO_ROOT, r))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(guardSymbolName)) {
          found.push(rel);
        }
      }
    }

    const unexpected = found.filter((f) => !allowed.has(f));
    assert.deepEqual(
      unexpected,
      [],
      `Unexpected references to guard symbol outside allowed files: ${unexpected.join(', ')}`,
    );
    assert.deepEqual(found.sort(), [...allowed].sort());
  });
});
