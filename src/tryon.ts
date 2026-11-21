import { mediaRequest } from './media/client.ts';
import {
  buildSetting,
  createScenePrewarmCache,
  runTryOnExtrasLoop,
  scenePrewarmKey,
  type PrewarmSceneResult,
  type TryOnCheck,
  type TryOnExtraRender,
  type TryOnExtraRenderEvent,
  type TryOnExtrasResult,
} from './media/pure.ts';
import { logEvent } from './store/log.ts';
import type { Outfit } from './types.ts';

const scenePrewarmCache = createScenePrewarmCache();

function positiveCapMs(envName: string, fallback: number): number {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function tryOn(
  personJpeg: Buffer | null,
  outfit: Outfit,
  opts?: { label?: string },
): Promise<{ url: string; path: string; ms: number; id: string; check?: TryOnCheck }> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? opts?.label ?? null;
  const piecesCount = Array.isArray(outfit?.pieces) ? outfit.pieces.length : 0;

  logEvent('tryon_start', { outfit: outfitTag, pieces: piecesCount });

  try {
    const res = await mediaRequest<{
      url: string;
      path: string;
      ms: number;
      id: string;
      check?: TryOnCheck;
    }>('tryOn', { personJpeg, outfit, opts }, 120_000);
    if (res.check) {
      logEvent('tryon_check', {
        outfit: outfitTag,
        id: res.id,
        ...res.check,
      });
    }
    logEvent('tryon_ready', {
      outfit: outfitTag,
      id: res.id,
      url: res.url,
      ms: res.ms,
    });
    return res;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logEvent('tryon_fail', {
      outfit: outfitTag,
      error: error.message,
      ms: Date.now() - t0,
    });
    throw error;
  }
}

export async function tryOnScene(
  studio: { path: string },
  outfit: Outfit,
  opts: { setting: string; label?: string; prewarm?: boolean },
): Promise<TryOnExtraRender | null> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? opts?.label ?? null;

  try {
    if (process.env.ALICE_TRYON_SCENE === 'off') {
      return null;
    }
    if (!studio?.path) {
      return null;
    }

    logEvent('tryon_scene_start', {
      outfit: outfitTag,
      setting: opts.setting,
      ...(opts.prewarm ? { prewarm: true } : {}),
    });

    const capMs = positiveCapMs('ALICE_TRYON_SCENE_CAP_MS', 45_000);
    const res = await mediaRequest<TryOnExtraRender | null>(
      'tryOnScene',
      { studio, outfit, opts },
      capMs + 5_000,
    );

    if (res && typeof res.url === 'string' && res.url.length > 0) {
      logEvent('tryon_scene_ready', {
        outfit: outfitTag,
        url: res.url,
        ms: res.ms,
        ...(opts.prewarm ? { prewarm: true } : {}),
      });
      return res;
    }

    logEvent('tryon_scene_fail', {
      outfit: outfitTag,
      ms: Date.now() - t0,
      ...(opts.prewarm ? { prewarm: true } : {}),
    });
    return null;
  } catch (err) {
    logEvent('tryon_scene_fail', {
      outfit: outfitTag,
      error: (err as Error)?.message ?? String(err),
      ms: Date.now() - t0,
      ...(opts.prewarm ? { prewarm: true } : {}),
    });
    return null;
  }
}

export async function prewarmScene(
  studio: { path: string },
  outfit: Outfit,
  ctx: { occasion: string; where?: string; when?: string; weather?: string },
): Promise<PrewarmSceneResult> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? null;

  try {
    if (process.env.ALICE_TRYON_SCENE === 'off' || !studio?.path) {
      return { ok: false, duration_ms: 0 };
    }

    const setting = buildSetting({
      occasion: ctx?.occasion ?? '',
      where: ctx?.where,
      when: ctx?.when,
      weather: ctx?.weather,
    });
    const key = scenePrewarmKey(studio.path, setting);
    const alreadyKnown = scenePrewarmCache.hasFinished(key) || scenePrewarmCache.hasInFlight(key);

    if (!alreadyKnown) {
      logEvent('tryon_scene_prewarm_start', { outfit: outfitTag, setting });
    }

    const res = await scenePrewarmCache.prewarm(key, () =>
      tryOnScene(studio, outfit, { setting, prewarm: true }),
    );

    logEvent('tryon_scene_prewarm', {
      outfit: outfitTag,
      ok: res.ok,
      duration_ms: res.duration_ms,
      ...(res.reused ? { reused: true } : {}),
    });

    return res;
  } catch {
    const duration_ms = Math.max(0, Date.now() - t0);
    logEvent('tryon_scene_prewarm', {
      outfit: outfitTag,
      ok: false,
      duration_ms,
    });
    return { ok: false, duration_ms };
  }
}

export async function tryOnVideo(
  still: { path: string },
  outfit: Outfit,
  opts: { setting: string; label?: string; seconds?: number },
): Promise<TryOnExtraRender | null> {
  const t0 = Date.now();
  const outfitTag = outfit?.number ?? opts?.label ?? null;

  try {
    if (process.env.ALICE_TRYON_VIDEO === 'off') {
      return null;
    }
    if (!still?.path) {
      return null;
    }

    logEvent('tryon_video_start', { outfit: outfitTag, setting: opts.setting });

    const capMs = positiveCapMs('ALICE_TRYON_VIDEO_CAP_MS', 120_000);
    const res = await mediaRequest<TryOnExtraRender | null>(
      'tryOnVideo',
      { still, outfit, opts },
      capMs + 10_000,
    );

    if (res && typeof res.url === 'string' && res.url.length > 0) {
      logEvent('tryon_video_ready', { outfit: outfitTag, url: res.url, ms: res.ms });
      return res;
    }

    logEvent('tryon_video_fail', { outfit: outfitTag, ms: Date.now() - t0 });
    return null;
  } catch (err) {
    logEvent('tryon_video_fail', {
      outfit: outfitTag,
      error: (err as Error)?.message ?? String(err),
      ms: Date.now() - t0,
    });
    return null;
  }
}

export async function tryOnExtras(
  studio: { path: string },
  outfit: Outfit,
  opts: {
    occasion: string;
    where?: string;
    when?: string;
    weather?: string;
    onRender?: (r: TryOnExtraRenderEvent) => void;
  },
): Promise<TryOnExtrasResult> {
  const setting = buildSetting({
    occasion: opts?.occasion ?? '',
    where: opts?.where,
    when: opts?.when,
    weather: opts?.weather,
  });
  const outfitTag = outfit?.number ?? null;

  try {
    if (!studio?.path) {
      return { scene: null, video: null, setting };
    }

    const key = scenePrewarmKey(studio.path, setting);

    return await runTryOnExtrasLoop({
      setting,
      sceneEnabled: process.env.ALICE_TRYON_SCENE !== 'off',
      videoEnabled: process.env.ALICE_TRYON_VIDEO !== 'off',
      runScene: async () => {
        const res = await scenePrewarmCache.getOrRender(key, () =>
          tryOnScene(studio, outfit, { setting }),
        );
        if (res?.reused) {
          logEvent('tryon_scene_ready', {
            outfit: outfitTag,
            url: res.url,
            ms: res.ms,
            reused: true,
          });
        }
        return res;
      },
      runVideo: () => tryOnVideo(studio, outfit, { setting }),
      onRender: opts?.onRender,
    });
  } catch {
    return { scene: null, video: null, setting };
  }
}
