/**
 * Playout watchdog for an avatar audio output.
 *
 * With a video face, Alice's audio goes to the avatar over a byte stream and the call
 * framework then waits, with no time limit, for the avatar to report that the line finished
 * playing. When that report never comes (a very short line cut off by the shopper, a stream
 * that was never closed, a lost message), every later line queues behind the stuck one and
 * Alice goes silent for the rest of the call. This watchdog reports the line finished itself
 * once the audio must be over, so the queue always moves.
 */

export interface PlayoutEvent {
  playbackPosition: number;
  interrupted: boolean;
}

/** The parts of the framework's avatar audio output this watchdog reads and wraps. */
export interface WatchedAudioOutput {
  playbackSegmentsCount: number;
  playbackFinishedCount: number;
  pushedDuration?: number;
  streamWriter?: { close(): Promise<unknown> } | undefined;
  flush(): void;
  clearBuffer(): void;
  onPlaybackFinished(ev: PlayoutEvent): void;
  abandonOpenSegment?: () => void;
}

export interface PlayoutWatchdogOptions {
  /** Extra time after the pushed audio should have ended before the watchdog steps in. */
  flushGraceMs?: number;
  /** How long an interrupted line may take to be reported finished. */
  clearGraceMs?: number;
  log?: (fields: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_FLUSH_GRACE_MS = 2_500;
export const DEFAULT_CLEAR_GRACE_MS = 1_500;

function looksLikeAudioOutput(value: unknown): value is WatchedAudioOutput {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.flush === 'function' &&
    typeof o.clearBuffer === 'function' &&
    typeof o.onPlaybackFinished === 'function' &&
    typeof o.playbackSegmentsCount === 'number' &&
    typeof o.playbackFinishedCount === 'number'
  );
}

/**
 * Wraps `flush` and `clearBuffer` on the given output. Returns a function that removes the
 * watchdog, or null when the value is not an audio output this can watch.
 */
export function installPlayoutWatchdog(
  output: unknown,
  options: PlayoutWatchdogOptions = {},
): (() => void) | null {
  if (!looksLikeAudioOutput(output)) return null;
  const out = output;
  const flushGraceMs = Math.max(0, options.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS);
  const clearGraceMs = Math.max(0, options.clearGraceMs ?? DEFAULT_CLEAR_GRACE_MS);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timers = new Set<unknown>();
  let removed = false;

  const originalFlush = out.flush;
  const originalClear = out.clearBuffer;

  const settle = (target: number, reason: 'flush' | 'clear', position: number) => {
    if (removed) return;
    let forced = 0;
    while (out.playbackFinishedCount < target && out.playbackFinishedCount < out.playbackSegmentsCount) {
      const before = out.playbackFinishedCount;
      try {
        out.onPlaybackFinished({ playbackPosition: position, interrupted: reason === 'clear' });
      } catch {
        break;
      }
      if (out.playbackFinishedCount === before) break;
      forced += 1;
    }
    if (forced === 0) return;
    // A stream left open would swallow the next line: close it so the next line starts clean.
    const writer = out.streamWriter;
    if (writer) {
      out.streamWriter = undefined;
      void Promise.resolve()
        .then(() => writer.close())
        .catch(() => {});
    }
    try {
      out.abandonOpenSegment?.();
    } catch {
      // best effort
    }
    options.log?.({ reason, forced, position_s: Math.round(position * 100) / 100 });
  };

  const arm = (target: number, reason: 'flush' | 'clear', waitMs: number, position: number) => {
    if (out.playbackFinishedCount >= target) return;
    const handle = setTimer(() => {
      timers.delete(handle);
      settle(target, reason, position);
    }, waitMs);
    timers.add(handle);
  };

  out.flush = function watchedFlush(this: WatchedAudioOutput) {
    const pushed = Math.max(0, Number(out.pushedDuration) || 0);
    originalFlush.call(out);
    arm(out.playbackSegmentsCount, 'flush', Math.round(pushed * 1000) + flushGraceMs, pushed);
  };

  out.clearBuffer = function watchedClear(this: WatchedAudioOutput) {
    const target = out.playbackSegmentsCount;
    originalClear.call(out);
    arm(target, 'clear', clearGraceMs, 0);
  };

  return () => {
    removed = true;
    for (const handle of timers) clearTimer(handle);
    timers.clear();
    out.flush = originalFlush;
    out.clearBuffer = originalClear;
  };
}
