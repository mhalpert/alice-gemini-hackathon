import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RenderCeilingError,
  createRenderLimiter,
  isAllowedImageUrl,
  safeFetchImageBuffer,
} from '../src/media/limits.ts';

function makeStreamResponse(
  chunks: Uint8Array[],
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: opts.headers ?? { 'content-type': 'image/jpeg' },
  });
}

describe('isAllowedImageUrl', () => {
  it('allows normal Shopify CDN, shopifycdn, and myshopify HTTPS URLs with queries', () => {
    assert.equal(
      isAllowedImageUrl('https://cdn.shopify.com/s/files/1/0293/9277/files/shirt.jpg?v=123&width=800'),
      true,
    );
    assert.equal(isAllowedImageUrl('https://store.shopifycdn.com/assets/shoe.webp?width=384'), true);
    assert.equal(isAllowedImageUrl('https://fnova.myshopify.com/cdn/shop/files/a.png'), true);
  });

  it('supports additional hosts via ALICE_IMAGE_HOSTS', () => {
    assert.equal(isAllowedImageUrl('https://img.everlane.com/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://img.everlane.com/a.jpg', 'img.everlane.com'), true);
    assert.equal(isAllowedImageUrl('https://a.cdn.example.com/x.jpg', '.cdn.example.com'), true);
  });

  it('refuses http, other hosts, IP literals, localhost, and userinfo tricks', () => {
    assert.equal(isAllowedImageUrl('http://cdn.shopify.com/s/files/1/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://evil.example/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://notcdn.shopify.com/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://127.0.0.1/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isAllowedImageUrl('https://[::1]/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://localhost/a.jpg'), false);
    assert.equal(isAllowedImageUrl('https://cdn.shopify.com@evil.example/x.jpg'), false);
    assert.equal(isAllowedImageUrl('https://user:pass@cdn.shopify.com/x.jpg'), false);
    assert.equal(isAllowedImageUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedImageUrl('not a url'), false);
  });
});

describe('safeFetchImageBuffer', () => {
  it('downloads a valid Shopify CDN image and follows allowed redirects up to 3 hops', async () => {
    const seen: string[] = [];
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const fakeFetch = (async (input: string | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.endsWith('/hop1.jpg')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://a.shopifycdn.com/hop2.jpg' },
        });
      }
      return makeStreamResponse([payload], {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(payload.length) },
      });
    }) as typeof fetch;

    const buf = await safeFetchImageBuffer('https://cdn.shopify.com/hop1.jpg', {
      fetchFn: fakeFetch,
    });
    assert.deepEqual(buf, payload);
    assert.deepEqual(seen, ['https://cdn.shopify.com/hop1.jpg', 'https://a.shopifycdn.com/hop2.jpg']);
  });

  it('refuses a redirect to a disallowed host', async () => {
    let evilFetched = false;
    const fakeFetch = (async (input: string | URL) => {
      const u = String(input);
      if (u.includes('evil.example')) {
        evilFetched = true;
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/secret.jpg' },
      });
    }) as typeof fetch;

    await assert.rejects(
      () => safeFetchImageBuffer('https://cdn.shopify.com/redir.jpg', { fetchFn: fakeFetch }),
      /Disallowed image URL/i,
    );
    assert.equal(evilFetched, false);
  });

  it('refuses more than 3 redirects', async () => {
    let hop = 0;
    const fakeFetch = (async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.shopify.com/hop-${hop}.jpg` },
      });
    }) as typeof fetch;

    await assert.rejects(
      () => safeFetchImageBuffer('https://cdn.shopify.com/start.jpg', { fetchFn: fakeFetch }),
      /Too many redirects/i,
    );
  });

  it('refuses non-image content types', async () => {
    const fakeFetch = (async () =>
      makeStreamResponse([Buffer.from('<html>hi</html>')], {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    await assert.rejects(
      () => safeFetchImageBuffer('https://cdn.shopify.com/page.jpg', { fetchFn: fakeFetch }),
      /Non-image content-type/i,
    );
  });

  it('refuses oversized Content-Length before reading body', async () => {
    const fakeFetch = (async () =>
      makeStreamResponse([Buffer.alloc(10)], {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(13 * 1024 * 1024) },
      })) as typeof fetch;

    await assert.rejects(
      () => safeFetchImageBuffer('https://cdn.shopify.com/huge.jpg', { fetchFn: fakeFetch }),
      /exceeds/i,
    );
  });

  it('stops streaming and fails when body bytes pass maxBytes without Content-Length', async () => {
    const chunk = new Uint8Array(64);
    const fakeFetch = (async () =>
      makeStreamResponse([chunk, chunk, chunk], {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        safeFetchImageBuffer('https://cdn.shopify.com/stream-big.png', {
          maxBytes: 100,
          fetchFn: fakeFetch,
        }),
      /exceeded 100 bytes/i,
    );
  });
});

describe('createRenderLimiter semaphore and lifetime ceiling', () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it('enforces maxInFlight and wakes queued callers in strict FIFO order', async () => {
    const limiter = createRenderLimiter({
      maxInFlight: 2,
      maxImagesTotal: 10,
      maxVideosTotal: 5,
    });

    const started: number[] = [];
    let peakActive = 0;
    let active = 0;

    const tasks = [1, 2, 3, 4, 5].map((id) =>
      limiter.run('image', async () => {
        started.push(id);
        active += 1;
        if (active > peakActive) peakActive = active;
        await delay(25);
        active -= 1;
        return id;
      }),
    );

    const results = await Promise.all(tasks);
    assert.deepEqual(results, [1, 2, 3, 4, 5]);
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    assert.equal(peakActive, 2);
    assert.equal(limiter.stats().inFlight, 0);
    assert.equal(limiter.stats().imagesTotal, 5);
  });

  it('enforces separate lifetime ceilings for images and videos and logs ceiling once', async () => {
    const ceilingEvents: Array<{ kind: string; count: number; limit: number }> = [];
    const limiter = createRenderLimiter({
      maxInFlight: 4,
      maxImagesTotal: 2,
      maxVideosTotal: 1,
      onCeilingReached: (kind, count, limit) => {
        ceilingEvents.push({ kind, count, limit });
      },
    });

    assert.equal(await limiter.run('image', async () => 'img-1'), 'img-1');
    assert.equal(await limiter.run('image', async () => 'img-2'), 'img-2');
    await assert.rejects(
      () => limiter.run('image', async () => 'img-3'),
      (err) => err instanceof RenderCeilingError && err.kind === 'image',
    );
    await assert.rejects(
      () => limiter.run('image', async () => 'img-4'),
      (err) => err instanceof RenderCeilingError && err.kind === 'image',
    );

    // Video ceiling is independent
    assert.equal(await limiter.run('video', async () => 'vid-1'), 'vid-1');
    await assert.rejects(
      () => limiter.run('video', async () => 'vid-2'),
      (err) => err instanceof RenderCeilingError && err.kind === 'video',
    );
    await assert.rejects(
      () => limiter.run('video', async () => 'vid-3'),
      (err) => err instanceof RenderCeilingError && err.kind === 'video',
    );

    // Logged once per kind
    assert.deepEqual(ceilingEvents, [
      { kind: 'image', count: 2, limit: 2 },
      { kind: 'video', count: 1, limit: 1 },
    ]);
  });
});
