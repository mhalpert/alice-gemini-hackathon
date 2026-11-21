import path from 'node:path';
import type { Item, Outfit } from '../types.ts';
import { buildCollage } from './collage.ts';
import { renderTryOnScene, renderTryOnVideo } from './extras.ts';
import { REPO_ROOT } from './pure.ts';
import { getProductShot } from './shots.ts';
import { renderTryOn } from './tryon-render.ts';

if (!process.env.GOOGLE_API_KEY) {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // .env.local may not exist
    }
  }
}

interface ChildRequest {
  id: number;
  op: string;
  args?: unknown;
}

function sendReply(payload: { id: number; ok: boolean; result?: unknown; error?: string }): void {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send(payload);
  } catch (err) {
    console.error('[media] failed to send IPC reply:', (err as Error)?.message);
  }
}

async function handleOp(op: string, args: unknown): Promise<unknown> {
  switch (op) {
    case 'ping':
      return { pong: true, pid: process.pid };

    case 'productShot': {
      const { item, slot } = (args ?? {}) as { item: Item; slot: string };
      return getProductShot(item, slot);
    }

    case 'collage': {
      const { outfit, label } = (args ?? {}) as { outfit: Outfit; label?: string };
      return buildCollage(outfit, label);
    }

    case 'tryOn': {
      const { personJpeg, outfit, opts } = (args ?? {}) as {
        personJpeg: Uint8Array | Buffer | null;
        outfit: Outfit;
        opts?: { label?: string };
      };
      return renderTryOn(personJpeg ?? null, outfit, opts);
    }

    case 'tryOnScene': {
      const { studio, outfit, opts } = (args ?? {}) as {
        studio: { path: string };
        outfit: Outfit;
        opts: { setting: string; label?: string };
      };
      return renderTryOnScene(studio, outfit, opts);
    }

    case 'tryOnVideo': {
      const { still, outfit, opts } = (args ?? {}) as {
        still: { path: string };
        outfit: Outfit;
        opts: { setting: string; label?: string; seconds?: number };
      };
      return renderTryOnVideo(still, outfit, opts);
    }

    default:
      throw new Error(`unknown media op: ${op}`);
  }
}

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const req = raw as Partial<ChildRequest>;
  if (typeof req.id !== 'number' || typeof req.op !== 'string') return;
  const id = req.id;
  const op = req.op;

  void (async () => {
    try {
      const result = await handleOp(op, req.args);
      sendReply({ id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[media] op=${op} id=${id} error: ${message}`);
      sendReply({ id, ok: false, error: message });
    }
  })();
});

process.on('disconnect', () => {
  console.log(`[media] parent disconnected, exiting pid=${process.pid}`);
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[media] uncaughtException:', err?.stack || err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[media] unhandledRejection:', (reason as Error)?.stack || reason);
});

console.log(`[media] child ready pid=${process.pid}`);
