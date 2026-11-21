import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logEvent } from '../store/log.ts';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChildReply {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUTS: Record<string, number> = {
  productShot: 12_000,
  collage: 15_000,
  tryOn: 120_000,
  tryOnScene: 50_000,
  tryOnVideo: 130_000,
  ping: 5_000,
};

const RESTART_MIN_INTERVAL_MS = 500;

let child: ChildProcess | null = null;
let nextId = 1;
let restarts = 0;
let hasSpawnedOnce = false;
let lastSpawnAt = 0;
let spawnPromise: Promise<ChildProcess> | null = null;
let exitHookRegistered = false;

const pending = new Map<number, PendingCall>();

function isChildAlive(c: ChildProcess | null): c is ChildProcess {
  return Boolean(c && c.connected && !c.killed && c.exitCode === null && c.signalCode === null);
}

function unrefChild(c: ChildProcess): void {
  try {
    c.unref();
    const ch = (c as unknown as { channel?: { unref?: () => void } }).channel;
    ch?.unref?.();
  } catch {
    // ignore
  }
}

function refChild(c: ChildProcess): void {
  try {
    c.ref();
    const ch = (c as unknown as { channel?: { ref?: () => void } }).channel;
    ch?.ref?.();
  } catch {
    // ignore
  }
}

function updateIdleRef(): void {
  if (!child) return;
  if (pending.size === 0) {
    unrefChild(child);
  } else {
    refChild(child);
  }
}

function rejectAllPending(reason: string): number {
  const count = pending.size;
  if (count === 0) return 0;
  const err = new Error(reason);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
  return count;
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  });
}

function childScriptPath(): string {
  return process.env.ALICE_MEDIA_CHILD || fileURLToPath(new URL('./process.ts', import.meta.url));
}

function spawnFreshChild(): ChildProcess {
  registerExitHook();

  if (hasSpawnedOnce) {
    restarts += 1;
  }
  hasSpawnedOnce = true;
  lastSpawnAt = Date.now();

  const c = fork(childScriptPath(), [], {
    serialization: 'advanced',
  });

  child = c;

  c.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as ChildReply;
    if (typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    updateIdleRef();
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new Error(msg.error || 'media child error'));
    }
  });

  let handledExit = false;
  const handleDown = (code: number | null, signal: NodeJS.Signals | null, err?: Error): void => {
    if (handledExit) return;
    handledExit = true;
    if (child === c) {
      child = null;
    }
    const pendingCount = rejectAllPending(
      err
        ? `media child error: ${err.message}`
        : `media child exited code=${code} signal=${signal}`,
    );
    logEvent('media_process_exit', {
      code,
      signal,
      pending: pendingCount,
      restarts,
    });
    console.error(
      `[media] child exited code=${code} signal=${signal} pending=${pendingCount}${err ? ` error=${err.message}` : ''}`,
    );
  };

  c.on('exit', (code, signal) => {
    handleDown(code, signal);
  });

  c.on('error', (err) => {
    handleDown(null, null, err);
  });

  updateIdleRef();
  return c;
}

async function ensureChild(): Promise<ChildProcess> {
  if (isChildAlive(child)) {
    return child;
  }

  if (spawnPromise) {
    const existing = await spawnPromise;
    if (isChildAlive(existing)) {
      return existing;
    }
  }

  const p = (async (): Promise<ChildProcess> => {
    if (isChildAlive(child)) {
      return child;
    }

    if (lastSpawnAt > 0) {
      const waitMs = RESTART_MIN_INTERVAL_MS - (Date.now() - lastSpawnAt);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, waitMs);
        });
      }
    }

    if (isChildAlive(child)) {
      return child;
    }

    return spawnFreshChild();
  })();

  spawnPromise = p;
  void p.finally(() => {
    if (spawnPromise === p) {
      spawnPromise = null;
    }
  });

  return p;
}

export async function mediaRequest<T = unknown>(
  op: string,
  args?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUTS[op] ?? 15_000;
  let c = await ensureChild();
  if (!isChildAlive(c)) {
    c = await ensureChild();
  }

  return new Promise<T>((resolve, reject) => {
    if (!isChildAlive(c)) {
      reject(new Error('media child is not connected'));
      return;
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      updateIdleRef();
      entry.reject(new Error(`media op "${op}" timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    updateIdleRef();

    try {
      c.send({ id, op, args }, (sendErr) => {
        if (sendErr) {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          updateIdleRef();
          entry.reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
        }
      });
    } catch (err) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
        updateIdleRef();
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function mediaStatus(): { pid: number | null; restarts: number; pending: number } {
  return {
    pid: isChildAlive(child) && typeof child.pid === 'number' ? child.pid : null,
    restarts,
    pending: pending.size,
  };
}

export function stopMedia(): void {
  const c = child;
  child = null;
  spawnPromise = null;
  rejectAllPending('media child stopped');
  if (c) {
    c.removeAllListeners('exit');
    c.removeAllListeners('error');
    c.removeAllListeners('message');
    try {
      if (c.connected) {
        c.disconnect();
      }
    } catch {
      // ignore
    }
    try {
      if (!c.killed) {
        c.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
    unrefChild(c);
  }
}
