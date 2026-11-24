// A small in-memory attempt counter for the account routes: so many tries per key per
// window. Keys are things like "signin:ip:203.0.113.7" or "signin:email:a@b.co".
// It lives in the server process; a restart clears it, which is fine for this purpose.
export interface AttemptLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
  /** Upper bound on tracked keys, so a flood of made-up keys cannot grow memory forever. */
  maxKeys?: number;
}

export interface AttemptLimiter {
  /** True when the key has used up its tries for the current window. */
  blocked(key: string): boolean;
  /** Counts one try. Returns true when this try is still within the limit. */
  hit(key: string): boolean;
  /** Seconds until the key may try again (0 when it is not blocked). */
  retryAfterS(key: string): number;
  reset(key: string): void;
  size(): number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function createAttemptLimiter(opts: AttemptLimiterOptions): AttemptLimiter {
  const max = Math.max(1, Math.floor(opts.max));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const now = opts.now ?? (() => Date.now());
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 20_000));
  const buckets = new Map<string, Bucket>();

  function live(key: string): Bucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    if (bucket.resetAt <= now()) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  function sweep(): void {
    const t = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
    }
    // Still full of live keys: drop the oldest entries (Map keeps insertion order).
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    blocked(key) {
      const bucket = live(key);
      return Boolean(bucket && bucket.count >= max);
    },
    hit(key) {
      let bucket = live(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) sweep();
        bucket = { count: 0, resetAt: now() + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
    retryAfterS(key) {
      const bucket = live(key);
      if (!bucket || bucket.count < max) return 0;
      return Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}
