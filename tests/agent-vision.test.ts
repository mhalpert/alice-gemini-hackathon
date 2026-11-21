import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import jpeg from 'jpeg-js';
import { RoomEvent, TrackKind, TrackSource, VideoBufferType } from '@livekit/rtc-node';
import { AppContextSender } from '../src/agent/context.ts';
import {
  FRAME_ERROR_LOG_INTERVAL_MS,
  createFrameSampler,
  createVisionController,
  downscaleRgba,
  encodeJpeg,
  findSubscribedCameraTrack,
  isCameraVideoTrackPublication,
  sendFrameToGemini,
} from '../src/agent/vision.ts';
import type {
  FrameInfo,
  RgbaImage,
  VideoFrameEventLike,
  VideoFrameLike,
} from '../src/agent/vision.ts';
import { attachCameraStatusWatcher } from '../src/agent/worker.ts';

function makeSolidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height };
}

function makePatternRgba(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) & 255;
      data[i + 1] = (x * 2 + y * 11) & 255;
      data[i + 2] = ((x ^ y) * 5) & 255;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

interface ControllableTrack {
  id: string;
  push(event: VideoFrameEventLike): void;
  error(err: unknown): void;
  end(): void;
  cancelled: boolean;
  createStream(): ReadableStream<VideoFrameEventLike>;
}

function makeFakeTrack(id: string): ControllableTrack {
  let controller: ReadableStreamDefaultController<VideoFrameEventLike> | null = null;
  const track: ControllableTrack = {
    id,
    cancelled: false,
    push(event) {
      controller?.enqueue(event);
    },
    error(err) {
      controller?.error(err);
    },
    end() {
      controller?.close();
    },
    createStream() {
      return new ReadableStream<VideoFrameEventLike>({
        start(ctrl) {
          controller = ctrl;
        },
        cancel() {
          track.cancelled = true;
          controller = null;
        },
      });
    },
  };
  return track;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// downscaleRgba
// ---------------------------------------------------------------------------

test('downscaleRgba preserves aspect ratio for landscape, portrait, and square frames', () => {
  const landscape = downscaleRgba(makeSolidRgba(1920, 1080, 10, 20, 30), 1024);
  assert.equal(landscape.width, 1024);
  assert.equal(landscape.height, 576);
  assert.equal(landscape.data.length, 1024 * 576 * 4);

  const portrait = downscaleRgba(makeSolidRgba(1080, 1920, 40, 50, 60), 1024);
  assert.equal(portrait.width, 576);
  assert.equal(portrait.height, 1024);
  assert.equal(portrait.data.length, 576 * 1024 * 4);

  const square = downscaleRgba(makeSolidRgba(2048, 2048, 70, 80, 90), 1024);
  assert.equal(square.width, 1024);
  assert.equal(square.height, 1024);

  const custom = downscaleRgba(makeSolidRgba(960, 720, 12, 34, 56), 480);
  assert.equal(custom.width, 480);
  assert.equal(custom.height, 360);
});

test('downscaleRgba never upscales frames within maxSide', () => {
  const src960 = makeSolidRgba(960, 720, 100, 150, 200);
  const out960 = downscaleRgba(src960);
  assert.equal(out960.width, 960);
  assert.equal(out960.height, 720);
  assert.equal(out960.data, src960.data);

  const small = makeSolidRgba(320, 240, 1, 2, 3);
  const outSmall = downscaleRgba(small, 1024);
  assert.equal(outSmall.width, 320);
  assert.equal(outSmall.height, 240);
  assert.equal(outSmall.data, small.data);
});

test('downscaleRgba preserves colors across quadrants', () => {
  const w = 100;
  const h = 100;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const right = x >= 50;
      const bottom = y >= 50;
      data[i] = right ? 200 : 20;
      data[i + 1] = bottom ? 180 : 40;
      data[i + 2] = 90;
      data[i + 3] = 255;
    }
  }
  const out = downscaleRgba({ data, width: w, height: h }, 50);
  assert.equal(out.width, 50);
  assert.equal(out.height, 50);
  // Top-left (0,0)
  assert.deepEqual([...out.data.slice(0, 4)], [20, 40, 90, 255]);
  // Bottom-right (49,49)
  const br = (49 * 50 + 49) * 4;
  assert.deepEqual([...out.data.slice(br, br + 4)], [200, 180, 90, 255]);
});

// ---------------------------------------------------------------------------
// encodeJpeg
// ---------------------------------------------------------------------------

test('encodeJpeg produces a valid JPEG Buffer decodable by jpeg-js', () => {
  const src = makeSolidRgba(64, 48, 220, 60, 40);
  const buf = encodeJpeg(src, 75);

  assert.ok(Buffer.isBuffer(buf), 'encodeJpeg must return a Buffer');
  assert.ok(buf.length > 4);
  // JPEG SOI (FF D8) and EOI (FF D9) magic bytes
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  assert.equal(buf[buf.length - 2], 0xff);
  assert.equal(buf[buf.length - 1], 0xd9);

  const decoded = jpeg.decode(buf, { useTArray: true });
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 48);
  assert.equal(decoded.data.length, 64 * 48 * 4);
  // Center pixel should be close to (220, 60, 40) after lossy JPEG round-trip
  const center = (24 * 64 + 32) * 4;
  assert.ok(Math.abs(decoded.data[center]! - 220) < 10);
  assert.ok(Math.abs(decoded.data[center + 1]! - 60) < 10);
  assert.ok(Math.abs(decoded.data[center + 2]! - 40) < 10);
});

test('encodeJpeg respects quality parameter', () => {
  const img = makePatternRgba(160, 120);
  const low = encodeJpeg(img, 30);
  const high = encodeJpeg(img, 90);
  assert.ok(low.length < high.length, `expected q=30 (${low.length}) < q=90 (${high.length})`);
});

// ---------------------------------------------------------------------------
// createFrameSampler
// ---------------------------------------------------------------------------

test('createFrameSampler throttles frames, skips convert on dropped frames, and retains latest()', async () => {
  let clock = 1000;
  let convertCalls = 0;
  const received: { jpeg: Buffer; info: FrameInfo }[] = [];
  const errors: unknown[] = [];

  const track = makeFakeTrack('cam-1');
  const sampler = createFrameSampler<ControllableTrack>({
    intervalMs: 1000,
    maxSide: 32,
    quality: 75,
    now: () => clock,
    createStream: (t) => t.createStream(),
    onFrame: (jpegBuf, info) => {
      received.push({ jpeg: jpegBuf, info });
    },
    onError: (err) => {
      errors.push(err);
    },
  });

  assert.equal(sampler.latest(), null);

  function makeI420Frame(r: number): VideoFrameLike {
    return {
      data: new Uint8Array(0),
      width: 64,
      height: 32,
      type: VideoBufferType.I420,
      convert(dstType: number) {
        assert.equal(dstType, VideoBufferType.RGBA);
        convertCalls += 1;
        const rgba = makeSolidRgba(64, 32, r, 100, 150);
        return { ...rgba, type: VideoBufferType.RGBA };
      },
    };
  }

  sampler.setTrack(track);

  // t=1000: first frame should be sampled and downscaled 64x32 -> 32x16
  track.push({ frame: makeI420Frame(10) });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(convertCalls, 1);
  assert.equal(received[0]!.info.width, 32);
  assert.equal(received[0]!.info.height, 16);
  assert.ok(received[0]!.info.ms >= 0);

  const snap1 = sampler.latest();
  assert.ok(snap1 !== null);
  assert.equal(snap1.width, 32);
  assert.equal(snap1.height, 16);
  assert.equal(snap1.at, 1000);
  assert.deepEqual(snap1.jpeg, received[0]!.jpeg);

  // t=1200, 1500, 1999: intermediate frames dropped cheaply (no convert!)
  clock = 1200;
  track.push({ frame: makeI420Frame(50) });
  await tick();
  clock = 1500;
  track.push({ frame: makeI420Frame(80) });
  await tick();
  clock = 1999;
  track.push({ frame: makeI420Frame(110) });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(convertCalls, 1, 'dropped frames must not call convert()');

  // t=2000: interval elapsed -> sampled!
  clock = 2000;
  track.push({ frame: makeI420Frame(240) });
  await tick();
  assert.equal(received.length, 2);
  assert.equal(convertCalls, 2);
  const snap2 = sampler.latest();
  assert.ok(snap2 !== null);
  assert.equal(snap2.at, 2000);
  assert.notDeepEqual(snap2.jpeg, snap1.jpeg);

  // pause() stops sending & drops cheaply, while latest() retains snap2
  sampler.pause();
  clock = 5000;
  track.push({ frame: makeI420Frame(20) });
  await tick();
  assert.equal(received.length, 2);
  assert.equal(convertCalls, 2, 'paused frames must not call convert()');
  assert.equal(sampler.latest()?.at, 2000);

  // setTrack(null) stops track & cancels stream, while latest() still retains snap2
  sampler.setTrack(null);
  await tick();
  assert.equal(track.cancelled, true);
  assert.equal(sampler.latest()?.at, 2000);
  assert.deepEqual(sampler.latest()?.jpeg, snap2.jpeg);

  // resume() + new track starts sampling again
  const track2 = makeFakeTrack('cam-2');
  sampler.resume();
  sampler.setTrack(track2);
  clock = 6000;
  track2.push({ frame: makeI420Frame(180) });
  await tick();
  assert.equal(received.length, 3);
  assert.equal(sampler.latest()?.at, 6000);

  await sampler.close();
  assert.equal(track2.cancelled, true);
  assert.equal(errors.length, 0);
});

test('createFrameSampler routes conversion, onFrame, and stream errors to onError and keeps going', async () => {
  let clock = 0;
  const received: Buffer[] = [];
  const errors: unknown[] = [];

  const track = makeFakeTrack('cam-err');
  const sampler = createFrameSampler<ControllableTrack>({
    intervalMs: 500,
    now: () => clock,
    createStream: (t) => t.createStream(),
    onFrame: (jpegBuf) => {
      if (clock === 1000) {
        throw new Error('onFrame boom');
      }
      received.push(jpegBuf);
    },
    onError: (err) => {
      errors.push(err);
    },
  });

  sampler.setTrack(track);

  // 1. convert() throws -> routed to onError, loop keeps going
  clock = 100;
  track.push({
    frame: {
      data: new Uint8Array(0),
      width: 16,
      height: 16,
      type: VideoBufferType.I420,
      convert() {
        throw new Error('convert boom');
      },
    },
  });
  await tick();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /convert boom/);
  assert.equal(received.length, 0);

  // 2. Next valid frame succeeds right after a convert error
  clock = 200;
  const good = makeSolidRgba(16, 16, 10, 200, 30);
  track.push({ frame: { ...good, type: VideoBufferType.RGBA } });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(sampler.latest()?.at, 200);

  // 3. onFrame throws -> routed to onError, loop still keeps going
  clock = 1000;
  track.push({ frame: { ...good, type: VideoBufferType.RGBA } });
  await tick();
  assert.equal(errors.length, 2);
  assert.match(String(errors[1]), /onFrame boom/);

  // 4. Subsequent frame still delivered after onFrame error
  clock = 2000;
  track.push({ frame: { ...good, type: VideoBufferType.RGBA } });
  await tick();
  assert.equal(received.length, 2);
  assert.equal(sampler.latest()?.at, 2000);

  // 5. Stream error routed to onError without throwing
  track.error(new Error('stream broke'));
  await tick();
  assert.equal(errors.length, 3);
  assert.match(String(errors[2]), /stream broke/);

  await sampler.close();
});

test('createFrameSampler reads VISION_FRAME_MS from env when intervalMs is omitted', async () => {
  const prev = process.env.VISION_FRAME_MS;
  process.env.VISION_FRAME_MS = '250';
  try {
    let clock = 0;
    let count = 0;
    const track = makeFakeTrack('env-cam');
    const sampler = createFrameSampler<ControllableTrack>({
      now: () => clock,
      createStream: (t) => t.createStream(),
      onFrame: () => {
        count += 1;
      },
    });
    sampler.setTrack(track);

    const frame: VideoFrameLike = { ...makeSolidRgba(8, 8, 1, 2, 3), type: VideoBufferType.RGBA };
    clock = 100;
    track.push({ frame });
    await tick();
    clock = 300; // +200ms < 250ms -> dropped
    track.push({ frame });
    await tick();
    clock = 350; // +250ms >= 250ms -> emitted
    track.push({ frame });
    await tick();

    assert.equal(count, 2);
    await sampler.close();
  } finally {
    if (prev === undefined) {
      delete process.env.VISION_FRAME_MS;
    } else {
      process.env.VISION_FRAME_MS = prev;
    }
  }
});

test('createFrameSampler also works with AsyncIterable fake frame sources', async () => {
  let clock = 0;
  const received: FrameInfo[] = [];

  async function* genFrames(): AsyncGenerator<VideoFrameEventLike> {
    const f: VideoFrameLike = { ...makeSolidRgba(16, 16, 255, 0, 0), type: VideoBufferType.RGBA };
    clock = 0;
    yield { frame: f };
    clock = 500;
    yield { frame: f };
    clock = 1000;
    yield { frame: f };
  }

  const sampler = createFrameSampler<string>({
    track: 'fake-iter-track',
    intervalMs: 1000,
    now: () => clock,
    createStream: () => genFrames(),
    onFrame: (_buf, info) => {
      received.push(info);
    },
  });

  await tick();
  await tick();
  assert.equal(received.length, 2);
  assert.equal(sampler.latest()?.at, 1000);
  await sampler.close();
});

// ---------------------------------------------------------------------------
// sendFrameToGemini
// ---------------------------------------------------------------------------

test('sendFrameToGemini sends realtime video input through activeSession', () => {
  const sent: unknown[] = [];
  const fakeRealtimeSession = {
    activeSession: {
      conn: { ws: { readyState: 1 } },
      sendRealtimeInput(params: unknown) {
        sent.push(params);
      },
    },
    sessionShouldClose: { isSet: false },
    shouldBlockRealtimeInputForPendingTools: () => false,
  };

  const jpegBuf = encodeJpeg(makeSolidRgba(8, 8, 12, 34, 56), 75);
  const ok = sendFrameToGemini(fakeRealtimeSession, jpegBuf);

  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    video: {
      data: jpegBuf.toString('base64'),
      mimeType: 'image/jpeg',
    },
  });
});

test('sendFrameToGemini returns false without throwing when no live session is open', () => {
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  assert.equal(sendFrameToGemini(null, jpegBuf), false);
  assert.equal(sendFrameToGemini(undefined, jpegBuf), false);
  assert.equal(sendFrameToGemini({}, jpegBuf), false);
  assert.equal(sendFrameToGemini({ activeSession: undefined }, jpegBuf), false);
  assert.equal(
    sendFrameToGemini(
      {
        activeSession: { sendRealtimeInput() { throw new Error('should not be called'); } },
        sessionShouldClose: { isSet: true },
      },
      jpegBuf,
    ),
    false,
  );
  assert.equal(
    sendFrameToGemini(
      {
        activeSession: { sendRealtimeInput() { throw new Error('should not be called'); } },
        shouldBlockRealtimeInputForPendingTools: () => true,
      },
      jpegBuf,
    ),
    false,
  );
  assert.equal(
    sendFrameToGemini(
      {
        activeSession: {
          conn: { ws: { readyState: 3 } },
          sendRealtimeInput() { throw new Error('should not be called'); },
        },
      },
      jpegBuf,
    ),
    false,
  );
  assert.equal(
    sendFrameToGemini(
      {
        activeSession: {
          conn: { ws: undefined },
          sendRealtimeInput() { throw new Error('should not be called'); },
        },
      },
      jpegBuf,
    ),
    false,
  );
  assert.equal(
    sendFrameToGemini(
      {
        activeSession: { sendRealtimeInput() { throw new Error('should not be called'); } },
      },
      Buffer.alloc(0),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// Vision controller & worker camera wiring
// ---------------------------------------------------------------------------

test('isCameraVideoTrackPublication and findSubscribedCameraTrack accept camera video only', () => {
  assert.equal(
    isCameraVideoTrackPublication({
      kind: TrackKind.KIND_VIDEO,
      source: TrackSource.SOURCE_CAMERA,
    }),
    true,
  );
  assert.equal(
    isCameraVideoTrackPublication({
      kind: TrackKind.KIND_VIDEO,
      source: TrackSource.SOURCE_SCREENSHARE,
    }),
    false,
  );
  assert.equal(
    isCameraVideoTrackPublication({
      kind: TrackKind.KIND_VIDEO,
      source: TrackSource.SOURCE_UNKNOWN,
    }),
    false,
  );
  assert.equal(
    isCameraVideoTrackPublication({
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_MICROPHONE,
    }),
    false,
  );
  assert.equal(
    isCameraVideoTrackPublication({
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_CAMERA,
    }),
    false,
  );
  assert.equal(isCameraVideoTrackPublication(undefined), false);

  const screenTrack = makeFakeTrack('screen');
  const camTrack = makeFakeTrack('cam');
  const found = findSubscribedCameraTrack<ControllableTrack>({
    trackPublications: new Map([
      [
        'p-screen',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_SCREENSHARE,
          subscribed: true,
          track: screenTrack,
        },
      ],
      [
        'p-unsub',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_CAMERA,
          subscribed: false,
          track: makeFakeTrack('unsub'),
        },
      ],
      [
        'p-cam',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_CAMERA,
          subscribed: true,
          track: camTrack,
        },
      ],
    ]),
  });
  assert.equal(found, camTrack);
});

test('createVisionController attaches existing camera track, logs first_frame once, ignores screen share, and clears track on unpublish/unsubscribe', async () => {
  let clock = 1000;
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const sentFrames: unknown[] = [];
  let liveSession: unknown = undefined;

  const cam1 = makeFakeTrack('cam-1');
  const screen = makeFakeTrack('screen-1');
  const otherCam = makeFakeTrack('other-cam');
  const cam2 = makeFakeTrack('cam-2');

  const room = new EventEmitter();
  const shopper = {
    identity: 'shopper-1',
    trackPublications: new Map([
      [
        'pub-screen',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_SCREENSHARE,
          subscribed: true,
          track: screen,
        },
      ],
      [
        'pub-cam-1',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_CAMERA,
          subscribed: true,
          track: cam1,
        },
      ],
    ]),
  };

  const vision = createVisionController<ControllableTrack>({
    roomName: 'room-vision',
    intervalMs: 1000,
    maxSide: 32,
    getRealtimeSession: () => liveSession,
    now: () => clock,
    createStream: (t) => t.createStream(),
    log: (r, ev, data) => logs.push({ room: r, ev, data }),
  });

  vision.attach(room, shopper);

  const rgbaFrame = (r: number): VideoFrameLike => ({
    ...makeSolidRgba(64, 32, r, 100, 150),
    type: VideoBufferType.RGBA,
  });

  // 1. Live session not open yet: frame is captured into latest() but NOT logged as first_frame.
  cam1.push({ frame: rgbaFrame(10) });
  await tick();
  assert.equal(sentFrames.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(vision.latest()?.width, 32);
  assert.equal(vision.latest()?.height, 16);

  // 2. Live session opens -> next sampled frame sends and logs ONE first_frame camera event.
  liveSession = {
    activeSession: {
      conn: { ws: { readyState: 1 } },
      sendRealtimeInput(params: unknown) {
        sentFrames.push(params);
      },
    },
    sessionShouldClose: { isSet: false },
    shouldBlockRealtimeInputForPendingTools: () => false,
  };
  clock = 2000;
  cam1.push({ frame: rgbaFrame(40) });
  await tick();
  assert.equal(sentFrames.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'camera');
  assert.equal(logs[0]!.data?.source, 'first_frame');
  assert.equal(logs[0]!.data?.width, 32);
  assert.equal(logs[0]!.data?.height, 16);
  assert.equal(typeof logs[0]!.data?.encode_ms, 'number');

  // 3. Subsequent frame sends without logging again.
  clock = 3000;
  cam1.push({ frame: rgbaFrame(80) });
  await tick();
  assert.equal(sentFrames.length, 2);
  assert.equal(logs.length, 1);

  // 4. Screen-share subscribe/unsubscribe & another participant's camera track are ignored.
  room.emit(
    RoomEvent.TrackSubscribed,
    screen,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_SCREENSHARE },
    { identity: 'shopper-1' },
  );
  room.emit(
    RoomEvent.TrackSubscribed,
    otherCam,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    { identity: 'other-user' },
  );
  room.emit(
    RoomEvent.TrackUnsubscribed,
    screen,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_SCREENSHARE },
    { identity: 'shopper-1' },
  );
  assert.equal(cam1.cancelled, false);

  // 5. Unpublish shopper's camera track cancels stream (setTrack(null)) and retains latest().
  room.emit(
    RoomEvent.TrackUnpublished,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    { identity: 'shopper-1' },
  );
  await tick();
  assert.equal(cam1.cancelled, true);
  assert.equal(vision.latest()?.at, 3000);

  // 6. Subscribing a new camera track resumes sampling, then unsubscribe clears it again.
  room.emit(
    RoomEvent.TrackSubscribed,
    cam2,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    { identity: 'shopper-1' },
  );
  clock = 4000;
  cam2.push({ frame: rgbaFrame(160) });
  await tick();
  assert.equal(sentFrames.length, 3);
  assert.equal(logs.length, 1); // first_frame still logged only once for the call

  room.emit(
    RoomEvent.TrackUnsubscribed,
    cam2,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    { identity: 'shopper-1' },
  );
  await tick();
  assert.equal(cam2.cancelled, true);

  // 7. close() is idempotent and detaches listeners.
  await vision.close();
  await vision.close();
  assert.equal(room.listenerCount(RoomEvent.TrackSubscribed), 0);
  assert.equal(room.listenerCount(RoomEvent.TrackUnpublished), 0);
  assert.equal(room.listenerCount(RoomEvent.TrackUnsubscribed), 0);
});

test('createVisionController rate-limits frame_error logs to at most once per 5 seconds', async () => {
  let clock = 1000;
  const logs: Array<{ room: string; ev: string; data?: Record<string, unknown> }> = [];
  const cam = makeFakeTrack('cam-err');
  const room = new EventEmitter();

  const vision = createVisionController<ControllableTrack>({
    roomName: 'room-err',
    intervalMs: 100,
    getRealtimeSession: () => null,
    now: () => clock,
    createStream: (t) => t.createStream(),
    log: (r, ev, data) => logs.push({ room: r, ev, data }),
  });

  vision.attach(room, { identity: 'shopper-1', trackPublications: new Map() });
  room.emit(
    RoomEvent.TrackSubscribed,
    cam,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    { identity: 'shopper-1' },
  );

  const badFrame = (msg: string): VideoFrameLike => ({
    data: new Uint8Array(0),
    width: 16,
    height: 16,
    type: VideoBufferType.I420,
    convert() {
      throw new Error(msg);
    },
  });

  // t=1000: logged
  cam.push({ frame: badFrame('err-1') });
  await tick();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.ev, 'frame_error');

  // t=2000 & t=5999: suppressed (< 5000ms since last log)
  clock = 2000;
  cam.push({ frame: badFrame('err-2') });
  await tick();
  clock = 1000 + FRAME_ERROR_LOG_INTERVAL_MS - 1;
  cam.push({ frame: badFrame('err-3') });
  await tick();
  assert.equal(logs.length, 1);

  // t=6000: allowed (>= 5000ms since last log)
  clock = 1000 + FRAME_ERROR_LOG_INTERVAL_MS;
  cam.push({ frame: badFrame('err-4') });
  await tick();
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.ev, 'frame_error');
  assert.match(String(logs[1]!.data?.error), /err-4/);

  await vision.close();
});

test('attachCameraStatusWatcher pauses/resumes vision on camera attribute and mute transitions while retaining latest snapshot', async () => {
  let clock = 1000;
  const sentFrames: Buffer[] = [];
  const room = new EventEmitter();
  const cam = makeFakeTrack('cam-status');
  const shopper = {
    identity: 'shopper-1',
    attributes: { camera: 'off' } as Record<string, string>,
    trackPublications: new Map([
      [
        'pub-cam',
        {
          kind: TrackKind.KIND_VIDEO,
          source: TrackSource.SOURCE_CAMERA,
          subscribed: true,
          muted: false,
          track: cam,
        },
      ],
    ]),
  };

  const vision = createVisionController<ControllableTrack>({
    roomName: 'room-status',
    intervalMs: 500,
    getRealtimeSession: () => ({}),
    now: () => clock,
    createStream: (t) => t.createStream(),
    sendFrame: (_rt, buf) => {
      sentFrames.push(buf);
      return true;
    },
    log: () => {},
  });

  const appContext = new AppContextSender({ send: () => {}, initialState: 'listening' });
  const watcher = attachCameraStatusWatcher({
    roomName: 'room-status',
    room: room as never,
    shopper: shopper as never,
    appContext,
    log: () => {},
    onStatusChange: (status) => vision.setCameraStatus(status),
  });
  vision.attach(room, shopper);

  const frame = (r: number): VideoFrameLike => ({
    ...makeSolidRgba(16, 16, r, 50, 50),
    type: VideoBufferType.RGBA,
  });

  // Initial camera status is 'off' (from attribute) -> paused before attach, no frames sent.
  assert.equal(watcher.initialStatus, 'off');
  cam.push({ frame: frame(10) });
  await tick();
  assert.equal(sentFrames.length, 0);
  assert.equal(vision.latest(), null);

  // Attribute turns camera 'on' -> resumed, frame sent and stored.
  room.emit(RoomEvent.ParticipantAttributesChanged, { camera: 'on' }, shopper);
  clock = 2000;
  cam.push({ frame: frame(100) });
  await tick();
  assert.equal(sentFrames.length, 1);
  const savedSnap = vision.latest();
  assert.ok(savedSnap !== null);
  assert.equal(savedSnap.at, 2000);

  // Track muted -> paused, no frames sent, latest() kept.
  room.emit(
    RoomEvent.TrackMuted,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    shopper,
  );
  clock = 3000;
  cam.push({ frame: frame(150) });
  await tick();
  assert.equal(sentFrames.length, 1);
  assert.equal(vision.latest()?.at, 2000);

  // Track unmuted -> resumed, new frame sent.
  room.emit(
    RoomEvent.TrackUnmuted,
    { kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_CAMERA },
    shopper,
  );
  clock = 4000;
  cam.push({ frame: frame(200) });
  await tick();
  assert.equal(sentFrames.length, 2);
  assert.equal(vision.latest()?.at, 4000);

  // Attribute turns camera 'off' -> paused again, latest() still kept.
  room.emit(RoomEvent.ParticipantAttributesChanged, { camera: 'off' }, shopper);
  clock = 5000;
  cam.push({ frame: frame(250) });
  await tick();
  assert.equal(sentFrames.length, 2);
  assert.equal(vision.latest()?.at, 4000);

  watcher.cleanup();
  await vision.close();
  appContext.dispose();
  assert.equal(cam.cancelled, true);
});
