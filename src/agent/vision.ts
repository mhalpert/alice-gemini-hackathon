import {
  RoomEvent,
  TrackKind,
  TrackSource,
  VideoBufferType,
  VideoStream,
} from '@livekit/rtc-node';
import type { Track, TrackPublication } from '@livekit/rtc-node';
import jpeg from 'jpeg-js';
import { calllog } from '../calllog.ts';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_SIDE = 1024;
const DEFAULT_JPEG_QUALITY = 75;
const WS_READY_STATE_OPEN = 1;
export const FRAME_ERROR_LOG_INTERVAL_MS = 5_000;

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface VideoFrameLike {
  data: Uint8Array;
  width: number;
  height: number;
  type?: number;
  convert?(dstType: number, flipY?: boolean): VideoFrameLike;
}

export interface VideoFrameEventLike {
  frame: VideoFrameLike;
  timestampUs?: bigint;
  rotation?: number;
}

export type FrameSource =
  | ReadableStream<VideoFrameEventLike>
  | AsyncIterable<VideoFrameEventLike>;

export interface FrameInfo {
  width: number;
  height: number;
  ms: number;
}

export interface LatestFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  at: number;
}

export interface FrameSamplerOptions<TTrack = Track> {
  track?: TTrack | null;
  intervalMs?: number;
  maxSide?: number;
  quality?: number;
  onFrame: (jpeg: Buffer, info: FrameInfo) => void | Promise<void>;
  onError?: (err: unknown) => void;
  createStream?: (track: TTrack) => FrameSource;
  now?: () => number;
}

export interface FrameSampler<TTrack = Track> {
  setTrack(track: TTrack | null): void;
  pause(): void;
  resume(): void;
  latest(): LatestFrame | null;
  close(): Promise<void>;
}

interface GeminiLiveSessionInternals {
  sendRealtimeInput?: (params: {
    video: { data: string; mimeType: string };
  }) => void;
  conn?: {
    ws?: {
      readyState?: number;
    };
  };
}

interface GoogleRealtimeSessionInternals {
  activeSession?: GeminiLiveSessionInternals;
  sessionShouldClose?: { isSet?: boolean };
  shouldBlockRealtimeInputForPendingTools?: () => boolean;
}

function validateRgbaImage(img: RgbaImage): void {
  if (!Number.isInteger(img.width) || img.width <= 0) {
    throw new RangeError(`Invalid RGBA width: ${img.width}`);
  }
  if (!Number.isInteger(img.height) || img.height <= 0) {
    throw new RangeError(`Invalid RGBA height: ${img.height}`);
  }
  const required = img.width * img.height * 4;
  if (!img.data || img.data.length < required) {
    throw new RangeError(
      `RGBA buffer too small: got ${img.data?.length ?? 0}, need ${required}`,
    );
  }
}

/**
 * Downscale an RGBA image so its longer side is at most `maxSide`, preserving
 * aspect ratio and never upscaling. Uses fast integer box averaging.
 */
export function downscaleRgba(
  src: RgbaImage,
  maxSide: number = DEFAULT_MAX_SIDE,
): RgbaImage {
  validateRgbaImage(src);
  if (!Number.isFinite(maxSide) || maxSide < 1) {
    throw new RangeError(`Invalid maxSide: ${maxSide}`);
  }

  const maxSideInt = Math.floor(maxSide);
  const srcW = src.width;
  const srcH = src.height;

  if (srcW <= maxSideInt && srcH <= maxSideInt) {
    return { data: src.data, width: srcW, height: srcH };
  }

  let dstW: number;
  let dstH: number;
  if (srcW >= srcH) {
    dstW = maxSideInt;
    dstH = Math.max(1, Math.round((srcH * maxSideInt) / srcW));
  } else {
    dstH = maxSideInt;
    dstW = Math.max(1, Math.round((srcW * maxSideInt) / srcH));
  }

  const srcData = src.data;
  const dstData = new Uint8Array(dstW * dstH * 4);

  const xStarts = new Int32Array(dstW);
  const xEnds = new Int32Array(dstW);
  for (let dx = 0; dx < dstW; dx++) {
    const x0 = Math.floor((dx * srcW) / dstW);
    const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor(((dx + 1) * srcW) / dstW)));
    xStarts[dx] = x0;
    xEnds[dx] = x1;
  }

  const srcRowStride = srcW * 4;
  let dstOffset = 0;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor((dy * srcH) / dstH);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor(((dy + 1) * srcH) / dstH)));
    const yCount = y1 - y0;

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = xStarts[dx]!;
      const x1 = xEnds[dx]!;
      const count = yCount * (x1 - x0);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = y0; sy < y1; sy++) {
        let idx = sy * srcRowStride + x0 * 4;
        const rowEnd = sy * srcRowStride + x1 * 4;
        while (idx < rowEnd) {
          r += srcData[idx]!;
          g += srcData[idx + 1]!;
          b += srcData[idx + 2]!;
          a += srcData[idx + 3]!;
          idx += 4;
        }
      }

      dstData[dstOffset] = Math.round(r / count);
      dstData[dstOffset + 1] = Math.round(g / count);
      dstData[dstOffset + 2] = Math.round(b / count);
      dstData[dstOffset + 3] = Math.round(a / count);
      dstOffset += 4;
    }
  }

  return { data: dstData, width: dstW, height: dstH };
}

/**
 * Encode an RGBA image buffer to a JPEG Buffer using pure-JS jpeg-js.
 */
export function encodeJpeg(
  rgba: RgbaImage,
  quality: number = DEFAULT_JPEG_QUALITY,
): Buffer {
  validateRgbaImage(rgba);
  const encoded = jpeg.encode(
    {
      data: rgba.data,
      width: rgba.width,
      height: rgba.height,
    },
    quality,
  );
  return Buffer.isBuffer(encoded.data) ? encoded.data : Buffer.from(encoded.data);
}

function resolveIntervalMs(explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit < 0) {
      throw new RangeError(`Invalid intervalMs: ${explicit}`);
    }
    return explicit;
  }
  const raw = process.env.VISION_FRAME_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_INTERVAL_MS;
}

function isReadableStream(source: FrameSource): source is ReadableStream<VideoFrameEventLike> {
  return (
    typeof source === 'object' &&
    source !== null &&
    'getReader' in source &&
    typeof source.getReader === 'function'
  );
}

/**
 * Sample frames from a LiveKit remote video track at most once every `intervalMs`,
 * dropping intermediate frames before any RGBA conversion or JPEG encoding.
 */
export function createFrameSampler<TTrack = Track>(
  opts: FrameSamplerOptions<TTrack>,
): FrameSampler<TTrack> {
  const intervalMs = resolveIntervalMs(opts.intervalMs);
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const quality = opts.quality ?? DEFAULT_JPEG_QUALITY;
  const now = opts.now ?? Date.now;
  const streamFactory: (track: TTrack) => FrameSource =
    opts.createStream ?? ((track) => new VideoStream(track as unknown as Track));

  let closed = false;
  let paused = false;
  let trackGen = 0;
  let currentTrack: TTrack | null = null;
  let lastSampleAt: number | null = null;
  let lastGood: LatestFrame | null = null;
  let activeStop: (() => void) | null = null;
  let activeLoop: Promise<void> = Promise.resolve();

  function safeOnError(err: unknown): void {
    if (!opts.onError) return;
    try {
      opts.onError(err);
    } catch {
      // Never allow an error callback failure to kill the sampling loop.
    }
  }

  function stopActiveStream(): void {
    const stop = activeStop;
    activeStop = null;
    if (stop) {
      try {
        stop();
      } catch {
        // Ignore cleanup errors on already-closed streams.
      }
    }
  }

  async function processEvent(event: VideoFrameEventLike, gen: number): Promise<void> {
    if (closed || paused || gen !== trackGen) {
      return;
    }
    const ts = now();
    if (lastSampleAt !== null && ts - lastSampleAt < intervalMs) {
      return;
    }

    try {
      const t0 = performance.now();
      const rawFrame = event?.frame;
      if (!rawFrame) {
        throw new Error('Video frame event is missing frame data');
      }

      let rgbaFrame: VideoFrameLike;
      if (rawFrame.type !== undefined && rawFrame.type !== VideoBufferType.RGBA) {
        if (typeof rawFrame.convert !== 'function') {
          throw new Error(`VideoFrame of buffer type ${rawFrame.type} cannot be converted to RGBA`);
        }
        rgbaFrame = rawFrame.convert(VideoBufferType.RGBA);
      } else {
        rgbaFrame = rawFrame;
      }

      const scaled = downscaleRgba(
        {
          data: rgbaFrame.data,
          width: rgbaFrame.width,
          height: rgbaFrame.height,
        },
        maxSide,
      );
      const jpegBuf = encodeJpeg(scaled, quality);
      const ms = Number((performance.now() - t0).toFixed(2));

      if (closed || paused || gen !== trackGen) {
        return;
      }

      lastSampleAt = ts;
      lastGood = {
        jpeg: jpegBuf,
        width: scaled.width,
        height: scaled.height,
        at: ts,
      };

      await opts.onFrame(jpegBuf, {
        width: scaled.width,
        height: scaled.height,
        ms,
      });
    } catch (err) {
      safeOnError(err);
    }
  }

  async function readLoop(track: TTrack, gen: number): Promise<void> {
    let source: FrameSource;
    try {
      source = streamFactory(track);
    } catch (err) {
      if (!closed && gen === trackGen) {
        safeOnError(err);
      }
      return;
    }

    if (isReadableStream(source)) {
      let reader: ReadableStreamDefaultReader<VideoFrameEventLike>;
      try {
        reader = source.getReader();
      } catch (err) {
        if (!closed && gen === trackGen) {
          safeOnError(err);
        }
        return;
      }

      let streamDone = false;
      const cancelReader = () => {
        if (!streamDone) {
          streamDone = true;
          reader.cancel().catch(() => {});
        }
      };

      if (closed || gen !== trackGen) {
        cancelReader();
        try {
          reader.releaseLock();
        } catch {
          // Ignore release errors.
        }
        return;
      }

      activeStop = cancelReader;
      try {
        while (!closed && gen === trackGen) {
          const result = await reader.read();
          if (result.done) {
            streamDone = true;
            break;
          }
          if (closed || gen !== trackGen) {
            break;
          }
          await processEvent(result.value, gen);
        }
      } catch (err) {
        if (!closed && gen === trackGen) {
          safeOnError(err);
        }
      } finally {
        if (gen === trackGen) {
          activeStop = null;
        }
        cancelReader();
        try {
          reader.releaseLock();
        } catch {
          // Ignore release errors.
        }
      }
      return;
    }

    let iter: AsyncIterator<VideoFrameEventLike>;
    try {
      iter = source[Symbol.asyncIterator]();
    } catch (err) {
      if (!closed && gen === trackGen) {
        safeOnError(err);
      }
      return;
    }

    let iterDone = false;
    const stopIter = () => {
      if (!iterDone && typeof iter.return === 'function') {
        iterDone = true;
        Promise.resolve(iter.return()).catch(() => {});
      }
    };

    if (closed || gen !== trackGen) {
      stopIter();
      return;
    }

    activeStop = stopIter;
    try {
      while (!closed && gen === trackGen) {
        const result = await iter.next();
        if (result.done) {
          iterDone = true;
          break;
        }
        if (closed || gen !== trackGen) {
          break;
        }
        await processEvent(result.value, gen);
      }
    } catch (err) {
      if (!closed && gen === trackGen) {
        safeOnError(err);
      }
    } finally {
      if (gen === trackGen) {
        activeStop = null;
      }
      stopIter();
    }
  }

  function setTrack(track: TTrack | null): void {
    if (closed) {
      return;
    }
    if (track === null && currentTrack === null) {
      return;
    }
    if (track !== null && track === currentTrack && activeStop !== null) {
      return;
    }

    trackGen += 1;
    const gen = trackGen;
    stopActiveStream();
    currentTrack = track;

    if (track !== null) {
      activeLoop = readLoop(track, gen);
    }
  }

  function pause(): void {
    paused = true;
  }

  function resume(): void {
    paused = false;
  }

  function latest(): LatestFrame | null {
    return lastGood;
  }

  async function close(): Promise<void> {
    if (closed) {
      await activeLoop;
      return;
    }
    closed = true;
    trackGen += 1;
    currentTrack = null;
    stopActiveStream();
    await activeLoop;
  }

  if (opts.track !== undefined && opts.track !== null) {
    setTrack(opts.track);
  }

  return {
    setTrack,
    pause,
    resume,
    latest,
    close,
  };
}

/**
 * Send a JPEG frame directly to Gemini Live as realtime `video` input.
 *
 * Relies on `@livekit/agents-plugin-google@1.10.1` RealtimeSession internals:
 * - `realtimeSession.activeSession` (the open `@google/genai` live `Session`)
 * - `realtimeSession.sessionShouldClose?.isSet`
 * - `realtimeSession.shouldBlockRealtimeInputForPendingTools?.()`
 * - optional WebSocket readyState check on `activeSession.conn?.ws?.readyState`
 *
 * Returns `false` (never throws) when no open live session is ready to send.
 */
export function sendFrameToGemini(
  realtimeSession: unknown,
  jpegBuf: Buffer | Uint8Array,
): boolean {
  if (!realtimeSession || typeof realtimeSession !== 'object') {
    return false;
  }
  if (!jpegBuf || jpegBuf.length === 0) {
    return false;
  }

  const session = realtimeSession as GoogleRealtimeSessionInternals;
  if (session.sessionShouldClose?.isSet) {
    return false;
  }
  if (
    typeof session.shouldBlockRealtimeInputForPendingTools === 'function' &&
    session.shouldBlockRealtimeInputForPendingTools()
  ) {
    return false;
  }

  const live = session.activeSession;
  if (!live || typeof live.sendRealtimeInput !== 'function') {
    return false;
  }

  if (live.conn) {
    const ws = live.conn.ws;
    if (!ws || (typeof ws.readyState === 'number' && ws.readyState !== WS_READY_STATE_OPEN)) {
      return false;
    }
  }

  const base64 = Buffer.isBuffer(jpegBuf)
    ? jpegBuf.toString('base64')
    : Buffer.from(jpegBuf.buffer, jpegBuf.byteOffset, jpegBuf.byteLength).toString('base64');

  live.sendRealtimeInput({
    video: {
      data: base64,
      mimeType: 'image/jpeg',
    },
  });
  return true;
}

export type VisionLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface CameraPublicationLike<TTrack = Track> {
  kind?: TrackKind;
  source?: TrackSource;
  subscribed?: boolean;
  track?: TTrack;
}

export interface ShopperLike<TTrack = Track> {
  identity: string;
  trackPublications: {
    values(): Iterable<CameraPublicationLike<TTrack>>;
  };
}

export interface VisionRoomLike {
  on(event: RoomEvent, listener: (...args: any[]) => void): unknown;
  off(event: RoomEvent, listener: (...args: any[]) => void): unknown;
}

/**
 * Returns true only for camera-sourced video publications (screen-share and
 * non-camera tracks are ignored).
 */
export function isCameraVideoTrackPublication(
  pub: Pick<TrackPublication, 'kind' | 'source'> | undefined,
): boolean {
  if (!pub) return false;
  return pub.kind === TrackKind.KIND_VIDEO && pub.source === TrackSource.SOURCE_CAMERA;
}

/**
 * Find an already-subscribed camera video track on a participant, if any.
 */
export function findSubscribedCameraTrack<TTrack = Track>(
  participant: Pick<ShopperLike<TTrack>, 'trackPublications'>,
): TTrack | null {
  for (const pub of participant.trackPublications.values()) {
    if (!isCameraVideoTrackPublication(pub)) continue;
    if (pub.subscribed !== false && pub.track) {
      return pub.track;
    }
  }
  return null;
}

export interface VisionControllerOptions<TTrack = Track> {
  roomName: string;
  intervalMs: number;
  getRealtimeSession: () => unknown;
  log?: VisionLogFn;
  now?: () => number;
  errorLogIntervalMs?: number;
  sendFrame?: (realtimeSession: unknown, jpeg: Buffer) => boolean;
  createStream?: (track: TTrack) => FrameSource;
  maxSide?: number;
  quality?: number;
}

export interface VisionController<TTrack = Track> {
  attach(room: VisionRoomLike, shopper: ShopperLike<TTrack>): void;
  setCameraStatus(status: 'on' | 'off'): void;
  latest(): LatestFrame | null;
  close(): Promise<void>;
}

/**
 * Per-call camera vision controller: creates one FrameSampler, attaches to the
 * shopper's camera video track (ignoring screen shares), forwards sampled JPEGs
 * to Gemini Live, logs the first successfully sent frame once, rate-limits
 * `frame_error` logs, pauses/resumes with camera status while keeping the last
 * good snapshot, and cleans up on close.
 */
export function createVisionController<TTrack = Track>(
  opts: VisionControllerOptions<TTrack>,
): VisionController<TTrack> {
  const now = opts.now ?? Date.now;
  const logFn = opts.log ?? calllog;
  const errorLogIntervalMs = opts.errorLogIntervalMs ?? FRAME_ERROR_LOG_INTERVAL_MS;
  const sendFrame = opts.sendFrame ?? sendFrameToGemini;

  let firstFrameLogged = false;
  let lastErrorLogAt: number | null = null;
  let activeTrack: TTrack | null = null;
  let detachRoom: (() => void) | null = null;
  let closed = false;

  const sampler = createFrameSampler<TTrack>({
    intervalMs: opts.intervalMs,
    maxSide: opts.maxSide,
    quality: opts.quality,
    now,
    createStream: opts.createStream,
    onFrame: (jpegBuf, info) => {
      const sent = sendFrame(opts.getRealtimeSession(), jpegBuf);
      if (sent && !firstFrameLogged) {
        firstFrameLogged = true;
        logFn(opts.roomName, 'camera', {
          source: 'first_frame',
          width: info.width,
          height: info.height,
          encode_ms: info.ms,
        });
      }
    },
    onError: (err) => {
      const ts = now();
      if (lastErrorLogAt === null || ts - lastErrorLogAt >= errorLogIntervalMs) {
        lastErrorLogAt = ts;
        logFn(opts.roomName, 'frame_error', {
          error: err instanceof Error ? err : String(err),
        });
      }
    },
  });

  function setCameraStatus(status: 'on' | 'off'): void {
    if (status === 'off') {
      sampler.pause();
    } else {
      sampler.resume();
    }
  }

  function attach(room: VisionRoomLike, shopper: ShopperLike<TTrack>): void {
    if (closed) return;
    detachRoom?.();

    const onTrackSubscribed = (
      track: TTrack,
      pub: CameraPublicationLike<TTrack>,
      participant: { identity: string },
    ) => {
      if (participant.identity !== shopper.identity) return;
      if (!isCameraVideoTrackPublication(pub)) return;
      activeTrack = track;
      sampler.setTrack(track);
    };

    const onTrackUnpublished = (
      pub: CameraPublicationLike<TTrack>,
      participant: { identity: string },
    ) => {
      if (participant.identity !== shopper.identity) return;
      if (!isCameraVideoTrackPublication(pub)) return;
      if (activeTrack !== null && pub.track && pub.track !== activeTrack) return;
      activeTrack = null;
      sampler.setTrack(null);
    };

    const onTrackUnsubscribed = (
      track: TTrack,
      pub: CameraPublicationLike<TTrack>,
      participant: { identity: string },
    ) => {
      if (participant.identity !== shopper.identity) return;
      if (!isCameraVideoTrackPublication(pub)) return;
      if (activeTrack !== null && track && track !== activeTrack) return;
      activeTrack = null;
      sampler.setTrack(null);
    };

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);

    detachRoom = () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    };

    const existingTrack = findSubscribedCameraTrack(shopper);
    if (existingTrack) {
      activeTrack = existingTrack;
      sampler.setTrack(existingTrack);
    }
  }

  function latest(): LatestFrame | null {
    return sampler.latest();
  }

  function close(): Promise<void> {
    closed = true;
    detachRoom?.();
    detachRoom = null;
    activeTrack = null;
    return sampler.close();
  }

  return {
    attach,
    setCameraStatus,
    latest,
    close,
  };
}
