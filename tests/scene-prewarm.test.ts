import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRenderLimiter } from '../src/media/limits.ts';
import {
  buildSetting,
  createScenePrewarmCache,
  runTryOnExtrasLoop,
  scenePrewarmKey,
  type SceneRenderOutput,
  type TryOnExtraRenderEvent,
} from '../src/media/pure.ts';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('scene prewarm cache and tryOnExtras integration', () => {
  it('prewarm then extras: one still render total, scene onRender fires immediately with reused=true, video still renders', async () => {
    const cache = createScenePrewarmCache();
    const setting = buildSetting({
      occasion: "a friend's rooftop birthday",
      where: 'New York',
      when: 'Saturday evening',
      weather: 'cool, clear',
    });
    const key = scenePrewarmKey('/tmp/tryon-1.jpg', setting);

    let sceneRenders = 0;
    let videoRenders = 0;

    const prewarmRes = await cache.prewarm(key, async (): Promise<SceneRenderOutput> => {
      sceneRenders += 1;
      await delay(25);
      return { url: '/tryon/scene-a.jpg', path: '/tmp/scene-a.jpg', ms: 25 };
    });

    assert.equal(prewarmRes.ok, true);
    assert.equal(prewarmRes.url, '/tryon/scene-a.jpg');
    assert.equal(prewarmRes.reused, undefined);
    assert.equal(sceneRenders, 1);

    const arrivals: Array<{ ev: TryOnExtraRenderEvent; wallMs: number }> = [];
    const tExtras = Date.now();
    const extras = await runTryOnExtrasLoop({
      setting,
      sceneEnabled: true,
      videoEnabled: true,
      runScene: () =>
        cache.getOrRender(key, async () => {
          sceneRenders += 1;
          await delay(50);
          return { url: '/tryon/scene-b.jpg', path: '/tmp/scene-b.jpg', ms: 50 };
        }),
      runVideo: async () => {
        videoRenders += 1;
        await delay(40);
        return { url: '/tryon/video-a.mp4', path: '/tmp/video-a.mp4', ms: 40 };
      },
      onRender: (ev) => {
        arrivals.push({ ev, wallMs: Date.now() - tExtras });
      },
    });

    assert.equal(sceneRenders, 1, 'prewarmed still must not render a second time');
    assert.equal(videoRenders, 1, 'video must still render at pick time');
    assert.equal(arrivals.length, 2);
    assert.equal(arrivals[0].ev.kind, 'scene');
    assert.equal(arrivals[0].ev.ok, true);
    assert.equal(arrivals[0].ev.reused, true);
    assert.equal(arrivals[0].ev.url, '/tryon/scene-a.jpg');
    assert.ok(arrivals[0].wallMs < 20, `expected immediate scene onRender, got ${arrivals[0].wallMs}ms`);
    assert.equal(arrivals[1].ev.kind, 'video');
    assert.equal(arrivals[1].ev.ok, true);
    assert.equal(extras.scene?.url, '/tryon/scene-a.jpg');
    assert.equal(extras.scene?.reused, true);
    assert.equal(extras.video?.url, '/tryon/video-a.mp4');
  });

  it('extras while prewarm is in flight: waits for the same promise, only one still render', async () => {
    const cache = createScenePrewarmCache();
    const setting = 'dinner in SoHo';
    const key = scenePrewarmKey('/tmp/tryon-2.jpg', setting);

    let sceneRenders = 0;
    let releaseScene!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseScene = resolve;
    });

    const prewarmPromise = cache.prewarm(key, async () => {
      sceneRenders += 1;
      await gate;
      return { url: '/tryon/scene-inflight.jpg', path: '/tmp/scene-inflight.jpg', ms: 60 };
    });

    assert.equal(cache.hasInFlight(key), true);

    const events: TryOnExtraRenderEvent[] = [];
    const extrasPromise = runTryOnExtrasLoop({
      setting,
      sceneEnabled: true,
      videoEnabled: true,
      runScene: () =>
        cache.getOrRender(key, async () => {
          sceneRenders += 1;
          return { url: '/tryon/scene-dup.jpg', path: '/tmp/scene-dup.jpg', ms: 10 };
        }),
      runVideo: async () => {
        await delay(10);
        return { url: '/tryon/video-2.mp4', path: '/tmp/video-2.mp4', ms: 10 };
      },
      onRender: (ev) => {
        events.push(ev);
      },
    });

    await delay(20);
    releaseScene();

    const [prewarmRes, extras] = await Promise.all([prewarmPromise, extrasPromise]);
    assert.equal(sceneRenders, 1);
    assert.equal(prewarmRes.ok, true);
    assert.equal(extras.scene?.url, '/tryon/scene-inflight.jpg');
    assert.equal(extras.scene?.reused, true);
    const sceneEv = events.find((e) => e.kind === 'scene');
    assert.equal(sceneEv?.ok, true);
    assert.equal(sceneEv?.reused, true);
  });

  it('prewarm failed: extras renders fresh as today', async () => {
    const cache = createScenePrewarmCache();
    const setting = 'cocktail bar';
    const key = scenePrewarmKey('/tmp/tryon-3.jpg', setting);

    let attempts = 0;
    const prewarmRes = await cache.prewarm(key, async () => {
      attempts += 1;
      return null;
    });

    assert.equal(prewarmRes.ok, false);
    assert.equal(cache.hasFinished(key), false);
    assert.equal(attempts, 1);

    const events: TryOnExtraRenderEvent[] = [];
    const extras = await runTryOnExtrasLoop({
      setting,
      sceneEnabled: true,
      videoEnabled: false,
      runScene: () =>
        cache.getOrRender(key, async () => {
          attempts += 1;
          return { url: '/tryon/scene-retry.jpg', path: '/tmp/scene-retry.jpg', ms: 15 };
        }),
      runVideo: async () => null,
      onRender: (ev) => {
        events.push(ev);
      },
    });

    assert.equal(attempts, 2);
    assert.equal(extras.scene?.url, '/tryon/scene-retry.jpg');
    assert.equal(extras.scene?.reused, undefined);
    assert.equal(events[0]?.ok, true);
    assert.equal(events[0]?.reused, undefined);
  });

  it('different studio path (after a swap) triggers a new still render', async () => {
    const cache = createScenePrewarmCache();
    const setting = 'rooftop birthday in New York';
    const keyBeforeSwap = scenePrewarmKey('/tmp/tryon-v1.jpg', setting);
    const keyAfterSwap = scenePrewarmKey('/tmp/tryon-v2.jpg', setting);

    let renders = 0;
    await cache.prewarm(keyBeforeSwap, async () => {
      renders += 1;
      return { url: '/tryon/scene-v1.jpg', path: '/tmp/scene-v1.jpg', ms: 10 };
    });

    const swapped = await cache.getOrRender(keyAfterSwap, async () => {
      renders += 1;
      return { url: '/tryon/scene-v2.jpg', path: '/tmp/scene-v2.jpg', ms: 10 };
    });

    assert.equal(renders, 2);
    assert.equal(swapped?.url, '/tryon/scene-v2.jpg');
    assert.equal(swapped?.reused, undefined);
  });

  it('double prewarm for the same key starts only one render', async () => {
    const cache = createScenePrewarmCache();
    const key = scenePrewarmKey('/tmp/tryon-dup.jpg', 'gallery opening');

    let renders = 0;
    const [r1, r2] = await Promise.all([
      cache.prewarm(key, async () => {
        renders += 1;
        await delay(20);
        return { url: '/tryon/scene-only.jpg', path: '/tmp/scene-only.jpg', ms: 20 };
      }),
      cache.prewarm(key, async () => {
        renders += 1;
        return { url: '/tryon/scene-second.jpg', path: '/tmp/scene-second.jpg', ms: 20 };
      }),
    ]);

    assert.equal(renders, 1);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.url, '/tryon/scene-only.jpg');
    assert.equal(r2.url, '/tryon/scene-only.jpg');
    assert.equal(r2.reused, true);

    // Third call after completion also reuses with zero extra renders
    const r3 = await cache.prewarm(key, async () => {
      renders += 1;
      return { url: '/tryon/scene-third.jpg', path: '/tmp/scene-third.jpg', ms: 20 };
    });
    assert.equal(renders, 1);
    assert.equal(r3.ok, true);
    assert.equal(r3.reused, true);
    assert.equal(r3.duration_ms, 0);
  });

  it('cap reached: prewarm returns ok=false without invoking the image model', async () => {
    const cache = createScenePrewarmCache();
    const limiter = createRenderLimiter({
      maxInFlight: 6,
      maxImagesTotal: 2,
      maxVideosTotal: 12,
      onCeilingReached: () => {},
    });

    let modelCalls = 0;
    const renderThroughCap = async (name: string): Promise<SceneRenderOutput | null> => {
      try {
        return await limiter.run('image', async () => {
          modelCalls += 1;
          return { url: `/tryon/${name}.jpg`, path: `/tmp/${name}.jpg`, ms: 5 };
        });
      } catch {
        return null;
      }
    };

    const a = await cache.prewarm(scenePrewarmKey('/tmp/s1.jpg', 'a'), () =>
      renderThroughCap('scene-1'),
    );
    const b = await cache.prewarm(scenePrewarmKey('/tmp/s2.jpg', 'b'), () =>
      renderThroughCap('scene-2'),
    );
    const c = await cache.prewarm(scenePrewarmKey('/tmp/s3.jpg', 'c'), () =>
      renderThroughCap('scene-3'),
    );

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, false);
    assert.equal(modelCalls, 2, 'third render past ceiling must not call image model');
  });

  it('evicts the oldest entry when exceeding 12 cached scenes', async () => {
    const cache = createScenePrewarmCache({ maxEntries: 12 });
    for (let i = 1; i <= 14; i += 1) {
      await cache.prewarm(scenePrewarmKey(`/tmp/s-${i}.jpg`, 'evening'), async () => ({
        url: `/tryon/scene-${i}.jpg`,
        path: `/tmp/scene-${i}.jpg`,
        ms: 1,
      }));
    }

    assert.equal(cache.size(), 12);
    assert.equal(cache.hasFinished(scenePrewarmKey('/tmp/s-1.jpg', 'evening')), false);
    assert.equal(cache.hasFinished(scenePrewarmKey('/tmp/s-2.jpg', 'evening')), false);
    assert.equal(cache.hasFinished(scenePrewarmKey('/tmp/s-3.jpg', 'evening')), true);
    assert.equal(cache.hasFinished(scenePrewarmKey('/tmp/s-14.jpg', 'evening')), true);
  });
});
